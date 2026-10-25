/**
 * dsh-koi 回测引擎（第二波 docs/19 §5，FR-039/FR-040 市场版落点、AC-012/023 适配）。
 *
 * 因子 = 注册制纯函数对象（W2-D04）：{ id, source, game, name, predict(historyAscending), judge(next) }。
 * 引擎保证防前视：predict 收到的 history 恒为「截至 asOf 期（含）」的升序切片——因子不可能
 * 读到未来（AC-012 的结构性保证，非提示词约束）。null = 本期无观点（跳过该轮，不计入分母）。
 *
 * 统计裁决（W2-D05）：verdict ∈ better-in-sample / no-advantage——单侧精确二项检验（α=0.05）
 * + 基线 = 判据滞后自评满足率 + 多重检验披露（不做 Bonferroni 强校正：样本内结论不用于决策，
 * 披露优先）。「与随机无异」为预期默认结论，如实入档、不美化（BC-001/BC-112）。
 *
 * 运行约束（W2A-20）：与 backfill/ingest 共用作业锁（kind='backtest'）；CLI 直跑同样 acquire；
 * 持锁串行域内的链式触发（ingest job done → 逐卡因子化→回测→回写，W2A-23）用 useLock:false
 * （调用方保证已在锁域内——cards 单写者纪律）。样本不足拒跑并明示（advisory「样本不足」同款诚实姿势）。
 */
import path from 'node:path'
import fs from 'node:fs'
import { readJson, writeJsonAtomic } from './io.js'
import { buildBuiltinFactors } from './factors.js'
import { inOffpeakWindow } from './backfill.js'

/**
 * 单侧精确二项检验 P(X ≥ hits | n, p)——对数乘积防溢出（n ≤ 数千 O(n) 循环，零依赖）。
 * 边界：p=0 → 仅 hits=0 时为 1；p=1 → hits ≤ n 时为 1；hits > n → 0。
 */
export function binomTailAtLeast(hits, n, p) {
  const k = Math.max(0, Math.floor(Number(hits)))
  const N = Math.floor(Number(n))
  if (!Number.isFinite(N) || N < 0) return 0
  if (k <= 0) return 1
  if (k > N) return 0
  const P = Number(p)
  if (P <= 0) return 0
  if (P >= 1) return 1
  // 逐项累加：term_i = C(N,i) p^i q^(N-i)，logC 增量递推
  const lp = Math.log(P)
  const lq = Math.log(1 - P)
  let logC = 0   // log C(N,0) = 0
  let sum = 0
  for (let i = 0; i <= N; i++) {
    if (i > 0) logC += Math.log(N - i + 1) - Math.log(i)
    if (i >= k) sum += Math.exp(logC + i * lp + (N - i) * lq)
  }
  return Math.min(1, Math.max(0, sum))
}

/** 口径披露（每份结论恒附；§5.3/§6——文案与 ui-logic 结论页常量同源同义） */
export function caliberLines({ n, alpha = 0.05 } = {}) {
  return [
    `口径：本地全量历史 ${n != null ? n + ' 期' : 'N 期'}滚动回测 · 命中判据回测前预注册 · 基线=判据滞后自评满足率 · 单侧精确二项检验（α=${alpha}）。`,
    '「与随机无异」= 命中率与随机基线无统计学差异。',
    '开奖是独立随机事件，回测结论不改变中奖概率，也不驱动任何自动行为。',
  ]
}

/** 多重检验披露（一次 run 全家跑完，报告头恒拼；不做 Bonferroni，披露优先） */
export function multiTestDisclosure(k, alpha = 0.05) {
  return `本轮共检验 ${k} 个因子，α=${alpha} 下期望约 ${(k * alpha).toFixed(1)} 个因子纯因偶然过关；单因子「样本内优于随机」不构成采用建议。`
}

export function verdictText(verdict) {
  return verdict === 'better-in-sample' ? '样本内优于随机基线（附 p 值与样本量）' : '与随机无异（预期默认，如实入档）'
}

export function createBacktest({
  dataDir,
  cardsStore = null,
  drawStore,
  factors: initialFactors = [],
  now = () => new Date(),
  log = () => {},
  lock = null,
  readCfg = () => ({}),
} = {}) {
  const registry = new Map()
  for (const f of initialFactors) registry.set(f.id, f)
  const RUNS_DIR = path.join(dataDir ?? '.', 'backtest', 'runs')
  const builtinFileOf = (game) => path.join(dataDir ?? '.', 'backtest', `builtin-${game}.json`)

  const cfgOf = () => {
    const bt = readCfg()?.backtest ?? {}
    return {
      warmup: Number(bt.warmup) > 0 ? Math.floor(Number(bt.warmup)) : 30,
      minRounds: Number(bt.minRounds) > 0 ? Math.floor(Number(bt.minRounds)) : 100,
      alpha: Number(bt.alpha) > 0 && Number(bt.alpha) < 1 ? Number(bt.alpha) : 0.05,
      offpeakOnly: bt.offpeakOnly !== false,
    }
  }

  function register(factor) {
    if (!factor || typeof factor.id !== 'string' || !factor.id.trim()) throw new Error('因子缺 id')
    if (typeof factor.predict !== 'function') {
      throw new Error(`因子 ${factor.id} 必须有 predict(historyAscending) → { claim, judge(next) } | null`)
    }
    if (!['ssq', 'dlt', 'p3'].includes(factor.game)) throw new Error(`因子 ${factor.game} 非法`)
    registry.set(factor.id, factor)
    return factor
  }

  /**
   * 单因子滚动回测（§5.2）。useLock=false 供持锁串行域内链式触发（W2A-23）。
   * 错峰守卫（BC-012，纪律优先）：独立运行（useLock=true）时 17:00–22:30 拒跑，--no-offpeak 显式越过。
   * 返回结论对象；样本不足 → { ok:false, error }（拒跑不出结论）。
   */
  async function runFactor(factorIn, { warmup, minRounds, alpha, useLock = true, noOffpeak = false } = {}) {
    const factor = typeof factorIn === 'string' ? registry.get(factorIn) : factorIn
    if (!factor) return { ok: false, error: `没有这个因子：${factorIn}` }
    const c = cfgOf()
    const wu = Number(warmup) > 0 ? Math.floor(Number(warmup)) : c.warmup
    const mr = Number(minRounds) > 0 ? Math.floor(Number(minRounds)) : c.minRounds
    const al = Number(alpha) > 0 && Number(alpha) < 1 ? Number(alpha) : c.alpha
    if (useLock && c.offpeakOnly && !noOffpeak && inOffpeakWindow(now())) {
      return { ok: false, code: 400, error: '错峰窗口（17:00–22:30）内不执行回测，22:30 后再试或用 --no-offpeak 显式越过' }
    }
    if (useLock && lock) {
      const acq = lock.acquire('backtest', factor.id)
      if (!acq.ok) return { ok: false, code: 409, error: `另一后台作业进行中（${acq.held?.kind}/${acq.held?.key ?? '-'}），完成后重试` }
    }
    try {
      // 全库升序切片（drawstore.getRecent 最新在前 → 反转升序；防前视由引擎切片保证）
      const desc = drawStore.getRecent(factor.game, Infinity)
      const asc = [...desc].reverse()
      if (asc.length - wu < mr) {
        return { ok: false, error: `本地历史不足 ${mr + wu} 期（现 ${asc.length} 期，先全量回拉）——样本不足不出结论` }
      }
      let rounds = 0
      let skips = 0
      let hits = 0
      let baselineHits = 0
      for (let t = wu; t <= asc.length - 2; t++) {
        const slice = asc.slice(0, t + 1)          // 截至第 t 期（含）——因子读不到 t+1 之后
        const p = factor.predict(slice)
        if (p == null) { skips += 1; continue }
        const r = p.judge(asc[t + 1])
        rounds += 1
        if (r?.hit === true) hits += 1
        const b = p.judge(asc[t])                   // 判据回判其形成期（滞后自评基线）
        if (b?.hit === true) baselineHits += 1
      }
      const hitRate = rounds ? hits / rounds : 0
      const baselineRate = rounds ? baselineHits / rounds : 0
      const pValue = binomTailAtLeast(hits, rounds, baselineRate)
      const verdict = pValue < al ? 'better-in-sample' : 'no-advantage'
      return {
        ok: true,
        factorId: factor.id, source: factor.source ?? 'builtin', game: factor.game, name: factor.name,
        rounds, skips, hits, hitRate, baselineRate, pValue, verdict,
        alpha: al, warmup: wu, sampleSize: asc.length,
        ranAt: now().toISOString(),
      }
    } finally {
      if (useLock && lock) { try { lock.release() } catch {} }
    }
  }

  /** 归档：全家结论 + 口径披露 + 因子清单快照（§5.5；runs/<runId>.json 永久） */
  function archiveRun(results, { game, label }) {
    const runId = `bt-${now().getTime()}-${Math.random().toString(36).slice(2, 6)}`
    const alpha = results[0]?.alpha ?? cfgOf().alpha
    const doc = {
      schemaVersion: 1, runId, game, label, ranAt: now().toISOString(),
      disclosure: [multiTestDisclosure(results.length, alpha), ...caliberLines({ n: results[0]?.sampleSize, alpha })],
      factorSnapshot: results.map((r) => ({ factorId: r.factorId, name: r.name, source: r.source })),
      factors: results,
    }
    fs.mkdirSync(RUNS_DIR, { recursive: true })
    writeJsonAtomic(path.join(RUNS_DIR, `${runId}.json`), doc)
    // 卡片因子结论回写 cards[].backtest（持锁串行域内由调用方保证；W2A-23 单写者）
    if (cardsStore) {
      for (const r of results) {
        if (String(r.source).startsWith('card:')) {
          cardsStore.setBacktest(String(r.source).slice(5), {
            at: r.ranAt, runRef: runId, rounds: r.rounds, hits: r.hits, hitRate: r.hitRate,
            baselineRate: r.baselineRate, pValue: r.pValue, verdict: r.verdict,
          })
        }
      }
    }
    return { runId, file: path.join(RUNS_DIR, `${runId}.json`) }
  }

  /**
   * 内置六件全家跑（§5.5）：结论档 backtest/builtin-<game>.json（同结构，含口径披露）。
   * 单因子失败不断链（如实记 error 汇报）。
   */
  async function runBuiltin({ game, useLock = true, noOffpeak = false } = {}) {
    if (useLock && cfgOf().offpeakOnly && !noOffpeak && inOffpeakWindow(now())) {
      return { ok: false, code: 400, error: '错峰窗口（17:00–22:30）内不执行回测，22:30 后再试或用 --no-offpeak 显式越过' }
    }
    if (useLock && lock) {
      const acq = lock.acquire('backtest', `builtin-${game}`)
      if (!acq.ok) return { ok: false, code: 409, error: `另一后台作业进行中（${acq.held?.kind}/${acq.held?.key ?? '-'}），完成后重试` }
    }
    try {
      const results = []
      const errors = []
      for (const f of registry.values()) {
        if (f.game !== game || f.source !== 'builtin') continue
        const r = await runFactor(f, { useLock: false })
        if (r.ok) results.push(r)
        else if (!/本地历史不足/.test(r.error ?? '')) errors.push({ factorId: f.id, error: r.error })
        else errors.push({ factorId: f.id, error: r.error, insufficient: true })
      }
      if (!results.length && errors.length) return { ok: false, errors }
      const alpha = results[0]?.alpha ?? cfgOf().alpha
      const doc = {
        schemaVersion: 1, game, ranAt: now().toISOString(),
        disclosure: [multiTestDisclosure(results.length, alpha), ...caliberLines({ n: results[0]?.sampleSize, alpha })],
        factorSnapshot: results.map((r) => ({ factorId: r.factorId, name: r.name })),
        factors: results, errors,
      }
      writeJsonAtomic(builtinFileOf(game), doc)
      return { ok: true, game, results, errors, file: builtinFileOf(game) }
    } finally {
      if (useLock && lock) { try { lock.release() } catch {} }
    }
  }

  /** 全家跑（六内置 + 全部已注册卡片因子；一次 run 一份归档 + 卡片回写，§5.3 多重检验口径 K=全家） */
  async function runAll({ game, useLock = true, noOffpeak = false } = {}) {
    if (useLock && cfgOf().offpeakOnly && !noOffpeak && inOffpeakWindow(now())) {
      return { ok: false, code: 400, error: '错峰窗口（17:00–22:30）内不执行回测，22:30 后再试或用 --no-offpeak 显式越过' }
    }
    if (useLock && lock) {
      const acq = lock.acquire('backtest', `all-${game}`)
      if (!acq.ok) return { ok: false, code: 409, error: `另一后台作业进行中（${acq.held?.kind}/${acq.held?.key ?? '-'}），完成后重试` }
    }
    try {
      const results = []
      const errors = []
      for (const f of registry.values()) {
        if (f.game !== game) continue
        const r = await runFactor(f, { useLock: false })
        if (r.ok) results.push(r)
        else errors.push({ factorId: f.id, error: r.error })
      }
      if (!results.length) return { ok: false, errors }
      const { runId, file } = archiveRun(results, { game, label: 'full-family' })
      // 内置子集另存 builtin-<game>.json（面板「因子结论」区直接读）
      const builtins = results.filter((r) => r.source === 'builtin')
      if (builtins.length) {
        const alpha = builtins[0].alpha
        writeJsonAtomic(builtinFileOf(game), {
          schemaVersion: 1, game, ranAt: now().toISOString(),
          disclosure: [multiTestDisclosure(builtins.length, alpha), ...caliberLines({ n: builtins[0].sampleSize, alpha })],
          factorSnapshot: builtins.map((r) => ({ factorId: r.factorId, name: r.name })),
          factors: builtins,
          errors: errors.filter((e) => String(e.factorId).startsWith('builtin-')),
        })
      }
      return { ok: true, game, results, errors, runId, file }
    } finally {
      if (useLock && lock) { try { lock.release() } catch {} }
    }
  }

  /** 结论视图（面板「因子结论」区）：内置档案 + 卡片回写结论 */
  function verdicts(game) {
    const out = []
    const builtin = readJson(builtinFileOf(game), null)
    for (const r of builtin?.factors ?? []) {
      out.push({ kind: 'builtin', factorId: r.factorId, name: r.name, game, rounds: r.rounds, hitRate: r.hitRate, baselineRate: r.baselineRate, pValue: r.pValue, verdict: r.verdict, ranAt: r.ranAt })
    }
    if (cardsStore) {
      for (const c of cardsStore.list()) {
        if ((c.games ?? []).includes(game) && c.backtest) {
          out.push({ kind: 'card', factorId: c.factorId, cardId: c.id, name: c.name, game, rounds: c.backtest.rounds, hitRate: c.backtest.hitRate, baselineRate: c.backtest.baselineRate, pValue: c.backtest.pValue, verdict: c.backtest.verdict, ranAt: c.backtest.at })
        }
      }
    }
    return out
  }

  return {
    register,
    factorOf: (id) => registry.get(id) ?? null,
    listFactors: () => [...registry.values()].map((f) => ({ id: f.id, source: f.source ?? 'builtin', game: f.game, name: f.name })),
    runFactor,
    runBuiltin,
    runAll,
    verdicts,
    archiveRun,
    builtinFileOf,
    RUNS_DIR,
  }
}

/** 便捷工厂：注册全部内置六件 × 三彩种（§5.6） */
export function createBacktestWithBuiltins(opts) {
  const bt = createBacktest(opts)
  for (const f of buildBuiltinFactors()) bt.register(f)
  return bt
}
