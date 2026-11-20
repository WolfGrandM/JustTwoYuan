/**
 * dsh-koi 月报 + 晋升流水线（M4 T3 / docs/28 §2.1 monthly.js + §3.2 + §9-R3/R6）。
 *
 * 时刻表（§3.2）：当月最后一天 23:45（对账放弃线 23:30 后 15 分钟——当日对账段必然收口，
 * 月报读全量终态）。守卫同周报：!holiday && mind.enabled && reports UNIQUE(kind,period) 幂等 +
 * joblock acquire('review', monthly-<yyyy-mm>)。
 *
 * 晋升流水线（BC-008 唯一状态变更时点；DC-004 单向边；§9-R3 市场版口径）：
 *   · 受检 = observing 因子逐个 evaluateFactor（默认实现 = backtest.runFactor(useLock:false)，
 *     判据滞后自评满足率为基线 p0——市场版先例，与 docs/11 §4.3 闭式展开差异如实写入口径行）
 *   · 晋升 = 方向为正（hitRate > baselineRate）且 pValue < α/Bonferroni×受检因子数，月度上限
 *     monthlyPromotionCap（默认 2，超限拒入——log 无该边）；按 pValue 升序取前 cap 名
 *   · 降级 = 方向为负（hitRate < baselineRate）且 pLower < α_adj（pLower = P(X ≤ hits)）
 *   · 淘汰 = 90 天零观点（attribution 表 hit 非空行最近时刻距今 >90 天；无归因行 → 数据不足
 *     不判定，如实报告不虚构）
 *   · 全部变更走 store.applyFactorTransition（同事务审计注记，触发器③④钉死）；promoted 的
 *     log note 含 effectiveAt（R6 lazy 生效门：消费端以 state_changed_at+24h 为生效时刻）
 *
 * 否决（R6/FR-035）：promoted 落状态后 24h 内 vetoFactor → 唯一合法回退边 promoted→observing
 * + actor='owner' + 非空 note；过期 veto 拒绝。可发现性：流水线 emit review 事件列晋升因子与
 * 剩余窗口小时数（panelOnly，DC-102 不破——晋升非战果，不冒泡）。
 *
 * BC-001：晋升叙述只读代码裁决结果——本模块零 LLM 判定（§5 禁止清单 4）；叙述输入 JSON 无
 * 「建议买入/提高概率」类字段；月报口径行恒拼市场版差异声明。
 */
import fs from 'node:fs'
import path from 'node:path'
import { GAMES } from '../draws.js'
import { isHoliday } from '../settle-core.js'
import { binomTailAtLeast } from '../backtest.js'
import { DISCLAIMER } from '../insight.js'
import { periodLedgerSlice } from './period.js'
import { scanHealth } from './health.js'
import { weekInfoOfPeriod } from './weekly.js'

export const MONTHLY_AT = '23:45'    // 月末生成时刻
const RETIRE_IDLE_DAYS = 90          // 90 天零观点 → retired（docs/12 DC-004/§5.3）
const ALPHA = 0.05                   // §9-R3：α=0.05

/** 月末判定（纯函数）：today 的下一天跨月 → true */
export function isMonthEnd(todayStr) {
  const d = new Date(`${todayStr}T12:00:00`)
  if (Number.isNaN(d.getTime())) return false
  const next = new Date(d.getTime())
  next.setDate(next.getDate() + 1)
  return next.getDate() === 1
}

export function createMonthlyReview({
  store,
  backtest = null,
  readLedger = () => ({ entries: [] }),
  readPreds = () => ({ entries: [] }),
  usage = null,
  narrator = null,
  emit = async () => null,
  now = () => new Date(),
  readCfg = () => ({}),
  log = () => {},
  lock = null,
  reportsDir = null,
  evaluateFactor = null,   // 注入面（测试确定性）；缺省 = backtest.runFactor(useLock:false)
  proposals = null,        // 环 A 探索性提案引擎（收尾批 T2，lib/review/proposal.js；null → 月报如实注明缺席）
} = {}) {
  const cfgReview = () => ({
    vetoWindowHours: Number(readCfg()?.review?.vetoWindowHours) > 0 ? Number(readCfg().review.vetoWindowHours) : 24,
    monthlyPromotionCap: Number.isInteger(Number(readCfg()?.review?.monthlyPromotionCap)) && Number(readCfg().review.monthlyPromotionCap) >= 1
      ? Number(readCfg().review.monthlyPromotionCap) : 2,
  })

  /** 单因子评估（市场版口径：判据滞后自评满足率为基线 p0，§9-R3 差异如实披露） */
  async function evaluate(factor) {
    if (evaluateFactor) return evaluateFactor(factor)
    if (!backtest) return { ok: false, error: '缺回测引擎注入（样本不足不出结论的诚实形态）' }
    const r = await backtest.runFactor(factor.id, { useLock: false })
    if (!r.ok) return { ok: false, error: r.error ?? '评估失败' }
    return { ok: true, rounds: r.rounds, hits: r.hits, hitRate: r.hitRate, baselineRate: r.baselineRate, pValue: r.pValue }
  }

  /** 90 天零观点判定：attribution 表 hit 非空行最近时刻（无任何归因行 → null = 数据不足不判定） */
  function lastOpinionAt(factorId) {
    const r = store.db.prepare(`SELECT MAX(at) AS latest, COUNT(*) AS n FROM attribution WHERE factor_id=? AND hit IS NOT NULL`).get(factorId)
    return Number(r.n) === 0 ? null : (r.latest ?? null)
  }

  /**
   * 晋升流水线（BC-008 唯一状态变更时点）。返回裁决汇总（供月报叙述输入——纯代码结果）。
   */
  async function runPipeline({ period }) {
    const { vetoWindowHours, monthlyPromotionCap } = cfgReview()
    // ⓪ 提案因子入观察（环 A 零特权入口，收尾批 T2）：观察期起点已到的 accepted 提案 candidate→observing
    //    （LEGAL_EDGES 保留边）——与全部因子同一条月报检验流水线（样本外+Bonferroni+上限+否决窗），无任何加权旁路。
    const activated = []
    for (const p of store.listProposals().filter((r) => r.status === 'accepted' && r.factorId && r.observeFrom && r.observeFrom <= String(period))) {
      const f = store.listFactors().find((x) => x.id === p.factorId)
      if (!f || f.status !== 'candidate') continue
      store.applyFactorTransition(f.id, 'candidate', 'observing', 'monthly-pipeline',
        `观察期起点 ${p.observeFrom} 已到（提案 ${p.period}）：入观察，与全部因子同一条月报检验流水线（零特权，无加权旁路）`)
      activated.push({ id: f.id, name: f.name, observeFrom: p.observeFrom })
    }
    const factors = store.listFactors().filter((f) => f.status === 'observing')
    const evaluated = []
    const insufficient = []
    for (const f of factors) {
      const r = await evaluate(f)
      if (r.ok) evaluated.push({ ...f, ...r })
      else insufficient.push({ id: f.id, name: f.name, reason: String(r.error ?? '').slice(0, 80) })
    }
    const k = evaluated.length
    const alphaAdj = k > 0 ? ALPHA / k : ALPHA   // Bonferroni ×受检因子数
    const promoted = []
    const demoted = []
    const retired = []
    const capDenied = []
    const unchanged = []

    // ① 淘汰：90 天零观点（先于晋升/降级——零观点因子无 hitRate 可言）
    const t = now().getTime()
    for (const f of factors) {
      const last = lastOpinionAt(f.id)
      if (last == null) continue   // 无归因行 → 数据不足不判定（不虚构）
      const idleDays = (t - Date.parse(last)) / 86_400_000
      if (idleDays > RETIRE_IDLE_DAYS && f.status === 'observing') {
        store.applyFactorTransition(f.id, 'observing', 'retired', 'monthly-pipeline',
          `月检淘汰：${Math.floor(idleDays)} 天零观点（最近非空归因 ${last.slice(0, 10)}）`)
        retired.push({ id: f.id, name: f.name, idleDays: Math.floor(idleDays) })
      }
    }
    const stillObserving = () => store.listFactors().filter((x) => x.status === 'observing')

    // ② 降级：方向为负显著（pLower = P(X ≤ hits | rounds, baselineRate)）
    for (const f of stillObserving()) {
      const e = evaluated.find((x) => x.id === f.id)
      if (!e) continue
      const pLower = 1 - binomTailAtLeast(e.hits + 1, e.rounds, e.baselineRate || 0.5)
      if (e.hitRate < e.baselineRate && pLower < alphaAdj) {
        store.applyFactorTransition(f.id, 'observing', 'demoted', 'monthly-pipeline',
          `月检降级：命中 ${e.hits}/${e.rounds}（${(e.hitRate * 100).toFixed(1)}%）显著低于基线 ${(e.baselineRate * 100).toFixed(1)}%（pLower=${pLower.toExponential(2)} < α_adj=${alphaAdj.toExponential(2)}）`)
        demoted.push({ id: f.id, name: f.name, hitRate: e.hitRate, baselineRate: e.baselineRate, pLower })
      }
    }

    // ③ 晋升：方向为正显著（Bonferroni）→ 按 pValue 升序取前 cap 名；超限拒入（log 无该边）
    const qualified = evaluated
      .filter((e) => stillObserving().some((x) => x.id === e.id))
      .filter((e) => e.hitRate > e.baselineRate && e.pValue < alphaAdj)
      .sort((a, b) => a.pValue - b.pValue)
    for (const e of qualified) {
      if (promoted.length >= monthlyPromotionCap) {
        capDenied.push({ id: e.id, name: e.name, pValue: e.pValue, reason: `月度晋升上限 ${monthlyPromotionCap} 已满（本轮已晋升 ${promoted.length} 个），不执行状态变更` })
        continue
      }
      const effectiveAt = new Date(t + vetoWindowHours * 3600_000).toISOString()
      store.applyFactorTransition(e.id, 'observing', 'promoted', 'monthly-pipeline',
        `月检晋升：命中 ${e.hits}/${e.rounds}（${(e.hitRate * 100).toFixed(1)}%）显著优于基线 ${(e.baselineRate * 100).toFixed(1)}%（p=${e.pValue.toExponential(2)} < α_adj=${alphaAdj.toExponential(2)}）；effectiveAt=${effectiveAt}（否决窗口 ${vetoWindowHours}h，R6 lazy 生效门）`)
      promoted.push({ id: e.id, name: e.name, hitRate: e.hitRate, baselineRate: e.baselineRate, pValue: e.pValue, effectiveAt })
    }
    for (const e of evaluated) {
      if ([...promoted, ...demoted, ...retired].some((x) => x.id === e.id) || capDenied.some((x) => x.id === e.id)) continue
      if (stillObserving().some((x) => x.id === e.id)) unchanged.push({ id: e.id, name: e.name, hitRate: e.hitRate, baselineRate: e.baselineRate, pValue: e.pValue })
    }
    return { evaluatedCount: k, alphaAdj, promoted, demoted, retired, capDenied, unchanged, insufficient, activated, vetoWindowHours, monthlyPromotionCap }
  }

  /** 否决（FR-035/R6）：窗口内 promoted → observing（唯一合法回退边）；过期拒绝 */
  function vetoFactor(factorId, note) {
    const { vetoWindowHours } = cfgReview()
    if (!factorId) return { ok: false, error: '缺 factorId' }
    if (!note || !String(note).trim()) return { ok: false, error: '否决必须附 note（BC-008 审计必填；CLI 用 --note <…>）' }
    const f = store.listFactors().find((x) => x.id === factorId)
    if (!f) return { ok: false, error: `没有这个因子：${factorId}` }
    if (f.status !== 'promoted') return { ok: false, error: `因子 ${factorId} 现状态为 ${f.status}，仅 promoted 可否决` }
    const changedAt = Date.parse(f.stateChangedAt ?? '')
    if (Number.isNaN(changedAt)) return { ok: false, error: `因子 ${factorId} 缺 state_changed_at，无法判定否决窗口` }
    const windowEnd = changedAt + vetoWindowHours * 3600_000
    const t = now().getTime()
    if (t > windowEnd) {
      return { ok: false, error: `否决窗口已过（${f.stateChangedAt} + ${vetoWindowHours}h = ${new Date(windowEnd).toISOString()}）；生效晋升不可回退（DC-004 单向边，promoted→demoted 非法）` }
    }
    store.applyFactorTransition(factorId, 'promoted', 'observing', 'owner', String(note))
    log(`[koi] 晋升否决：${factorId} promoted→observing（actor=owner，窗口内）`)
    return { ok: true, factorId, note: String(note), windowEnd, at: new Date(t).toISOString() }
  }

  /** 探索性提案段渲染（环 A，收尾批 T2）：缺席/跳过如实注明；BC-001 声明常驻 */
  function proposalLines(proposals) {
    if (!proposals) return ['（探索性提案段未运行：提案引擎未注入）']
    if (proposals.ok === false) return [`（探索性提案段未运行：${proposals.reason ?? proposals.skipped ?? '原因不明'}）`]
    const out = []
    if (proposals.note) {
      out.push(`（${proposals.note}）`, `> ${DISCLAIMER}`)
      return out
    }
    const acc = proposals.accepted ?? []
    const rej = proposals.rejected ?? []
    out.push(`本轮提案 ${acc.length + rej.length} 个候选（K=3）：落库 candidate ${acc.length} · DSL 拒收 ${rej.length}${proposals.observeFrom ? ` · 观察期起点 ${proposals.observeFrom}（下月报流水线入观察）` : ''}`)
    for (const a of acc) {
      out.push(`✓ ${a.factorId}（${a.game}）${a.name}${a.claim ? `——${a.claim}` : ''}${a.duplicate ? '（重跑幂等：因子已在库）' : '（candidate 态；零特权：与全部因子同一条月报检验流水线）'}`)
    }
    for (const r of rej) {
      out.push(`✗ DSL 拒收（${r.game || '?'}）${r.name}：${(r.errors ?? []).join('；')}（如实记录不静默）`)
    }
    out.push(`> ${DISCLAIMER}`)
    return out
  }

  /** 组装月报全文（战绩 + token 视图 AC-033 + 流水线叙述 + 探索性提案段 + 健康摘要；LLM 只叙述一段） */
  async function buildReport({ period, pipeline, proposals = null }) {
    const from = `${period}-01`
    const lastDay = new Date(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0).getDate()
    const to = `${period}-${String(lastDay).padStart(2, '0')}`
    const ledgerEntries = readLedger()?.entries ?? []
    const slice = periodLedgerSlice(ledgerEntries, from, to)
    const preds = readPreds()?.entries ?? []
    const monthEntries = preds.filter((e) => e?.kind === 'daily' && e.date >= from && e.date <= to)
    // AC-033：月度 token 报告视图（读 usage archived——DC-011 周度汇总唯一来源）
    let tokenView = '（无用量数据）'
    let monthTokenTotal = null
    if (usage?.fileOf) {
      const f = readJsonUsage(usage.fileOf())
      const weeks = []
      for (const a of f?.archived ?? []) weeks.push({ week: a.week, total: (a.entries ?? []).reduce((s, e) => s + Number(e.tokens ?? 0), 0) })
      if (f?.week) weeks.push({ week: f.week, total: (f.entries ?? []).reduce((s, e) => s + Number(e.tokens ?? 0), 0) })
      weeks.sort((a, b) => String(a.week).localeCompare(String(b.week)))
      const inMonth = weeks.filter((w) => {
        const m = /^(\d{4})-W(\d{1,2})$/.exec(w.week)
        if (!m) return false
        return weekInfoOfPeriod(w.week).from.slice(0, 7) === period || weekInfoOfPeriod(w.week).to.slice(0, 7) === period
      })
      monthTokenTotal = inMonth.reduce((s, w) => s + w.total, 0)
      tokenView = weeks.map((w) => `${w.week}:${w.total}`).join(' · ') + (inMonth.length ? `\n  ${period} 月内合计（跨月周按整周计）：${monthTokenTotal}` : '')
    }
    const caliber = [
      '口径：晋升检验采市场版先例（基线=判据滞后自评满足率）+ Bonferroni×受检因子数 + α=0.05 + 月度上限 + 方向为正；',
      `与 docs/11 §4.3 的 DC-002 闭式组合概率口径存在差异，如实披露（§9-R3）。开奖是独立随机事件，任何裁决不改变中奖概率。`,
    ].join(' ')
    let narr = null
    if (narrator) {
      // BC-001：叙述输入 = 代码裁决结果 JSON——无「建议买入/提高概率」类字段（纯数字/清单）
      narr = await narrator.narrate({
        section: '月报总览',
        data: { period, ledger: { cost: slice.cost, prize: slice.prize, net: slice.net, draws: slice.draws },
          monthTokenTotal, pipeline: {
            promoted: pipeline.promoted.map((p) => ({ id: p.id, name: p.name, hitRate: p.hitRate, baselineRate: p.baselineRate, pValue: p.pValue, effectiveAt: p.effectiveAt })),
            demoted: pipeline.demoted.map((p) => ({ id: p.id, name: p.name })),
            retired: pipeline.retired.map((p) => ({ id: p.id, name: p.name })),
            capDenied: pipeline.capDenied.map((p) => ({ id: p.id, reason: p.reason })),
            evaluatedCount: pipeline.evaluatedCount, alphaAdj: pipeline.alphaAdj,
          } },
        knownFactorIds: store.listFactors().map((f) => f.id),
      })
    }
    const health = scanHealth({ readPreds, readCfg, store, today: to })
    const dayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
    const lines = [
      `📋 锦鲤月报 ${period}`,
      '',
      '【战绩总览（账本口径 BC-006）】',
      ...(narr ? [narr.text, ...(narr.source === 'code-only' && narr.reason ? [`（LLM 叙述缺席：${narr.reason}）`] : [])] : []),
      `投入 ${slice.cost} 元 · 中 ${slice.prize} 元 · 净 ${slice.net >= 0 ? '+' : ''}${slice.net} 元 · 共 ${slice.draws} 期（${from} ~ ${to}，quickpick 永不入账）`,
      '',
      '【月度 token 报告视图（AC-033，usage archived 单一来源）】',
      tokenView,
      '',
      '【因子流水线裁决（代码判定，零 LLM）】',
      `受检 ${pipeline.evaluatedCount} 个 observing 因子 · α_adj = α/${pipeline.evaluatedCount} = ${pipeline.alphaAdj.toExponential(2)}（Bonferroni）`,
      ...(pipeline.promoted.length ? pipeline.promoted.map((p) => `↑ 晋升 ${p.id}（${p.name}）：命中 ${(p.hitRate * 100).toFixed(1)}% vs 基线 ${(p.baselineRate * 100).toFixed(1)}%，p=${p.pValue.toExponential(2)}；生效 ${p.effectiveAt}（否决窗口 ${pipeline.vetoWindowHours}h 内可 veto）`) : ['（本轮无晋升）']),
      ...(pipeline.capDenied.length ? pipeline.capDenied.map((p) => `⊘ 上限拒入 ${p.id}：${p.reason}`) : []),
      ...(pipeline.demoted.length ? pipeline.demoted.map((p) => `↓ 降级 ${p.id}（${p.name}）`) : []),
      ...(pipeline.retired.length ? pipeline.retired.map((p) => `× 淘汰 ${p.id}（${p.name}，零观点超 90 天）`) : []),
      ...(pipeline.insufficient.length ? pipeline.insufficient.map((p) => `— 样本不足跳过 ${p.id}：${p.reason}`) : []),
      ...(pipeline.unchanged.length ? [`（维持 observing：${pipeline.unchanged.map((p) => p.id).join('、')}）`] : []),
      ...(pipeline.activated?.length ? [`（环 A 提案入观察：${pipeline.activated.map((p) => `${p.id}（观察期起点 ${p.observeFrom}）`).join('、')}——零特权，同流水线受检）`] : []),
      '',
      '【探索性提案（环 A · mind 门控 · K=3）】',
      ...proposalLines(proposals),
      '',
      '【口径行】',
      caliber,
      '',
      '【健康摘要】',
      ...health.items.map((i) => `${i.ok === false ? '✗' : i.ok === true ? '·' : '—'} ${i.name}：${i.detail}`),
      '',
      '【下月开奖节奏（与 draws.js drawDays 同源）】',
      Object.entries(GAMES).map(([k, g]) => `${g.name} ${g.drawDays.map((x) => dayNames[x]).join('/')}`).join(' · '),
    ]
    return { content: lines.join('\n'), slice, health, pipeline, monthTokenTotal }
  }

  const readJsonUsage = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null } }

  /**
   * 时刻表入口（tick 复盘段调用）：月末 && hh ≥ 23:45 && !holiday && mind.enabled；period 幂等。
   * 生成失败 → 下轮 tick 重试（月末 23:45 之后到午夜都是窗口）。
   */
  async function maybeRunMonthly({ today, nowHHMM } = {}) {
    const cfg = readCfg()
    if (cfg?.mind?.enabled !== true) return { ok: false, skipped: 'mind-disabled' }
    const d = today ?? now().toLocaleDateString('sv-SE')
    const hh = nowHHMM ?? now().toLocaleTimeString('sv-SE', { hour12: false }).slice(0, 5)
    if (isHoliday(d, cfg.holidays)) return { ok: false, skipped: 'holiday', today: d }
    if (!isMonthEnd(d)) return { ok: false, skipped: 'not-month-end', today: d }
    if (hh < MONTHLY_AT) return { ok: false, skipped: 'window', today: d, hh }
    try {
      return await generateNow({ today: d })
    } catch (e) {
      log(`[koi] 月报生成失败（下轮 tick 重试）：${String(e?.message ?? e).slice(0, 160)}`)
      return { ok: false, error: String(e?.message ?? e).slice(0, 160) }
    }
  }

  /** 生成（CLI 手动路径 B-21 旁路 mind 闸；幂等 reports UNIQUE；流水线在报告事务面内执行） */
  async function generateNow({ today } = {}) {
    const d = today ?? now().toLocaleDateString('sv-SE')
    const period = d.slice(0, 7)
    if (store.getReport('monthly', period)) return { ok: false, skipped: 'duplicate', period }
    const acq = lock?.acquire?.('review', `monthly-${period}`)
    if (lock && acq && !acq.ok) {
      log(`[koi] 复盘作业锁被占（${acq.held?.kind}/${acq.held?.key ?? '-'}），本轮跳过，下轮补跑`)
      return { ok: false, skipped: 'lock', held: acq.held ?? null, period }
    }
    try {
      const pipeline = await runPipeline({ period })
      // 环 A 探索性提案段（收尾批 T2；mind.enabled 门控在引擎内——CLI 手动月报旁路 mind 闸，不旁路本段）。
      // 失败/缺席不阻塞月报（narrate 同款：缺席如实报告，不静默不虚构）。
      let propResult = null
      if (proposals) {
        try {
          propResult = await proposals.run({ period })
        } catch (e) {
          propResult = { ok: false, skipped: 'error', reason: `提案段异常：${String(e?.message ?? e).slice(0, 140)}` }
          log(`[koi] 探索性提案段异常（月报继续）：${propResult.reason}`)
        }
      }
      const built = await buildReport({ period, pipeline, proposals: propResult })
      const ev = await emit({
        kind: 'review', level: 'info', title: `月报 ${period}`, date: d,
        message: built.content.split('\n').slice(0, 8).join('\n') + '\n…（全文见复盘卡片与 CLI report）',
        fullRef: `review|monthly|${period}`,
        panelOnly: true,   // TF-6：月报静默进面板事件列表，不推 QQ
      })
      // R6 可发现性①：晋升发生 → 事件正文列晋升因子与剩余窗口小时数（panelOnly，不冒泡）
      if (pipeline.promoted.length) {
        const { vetoWindowHours } = cfgReview()
        try {
          await emit({
            kind: 'review', level: 'warn', title: `待否决晋升 · ${period}`, date: d,
            message: `本轮晋升 ${pipeline.promoted.length} 个因子：${pipeline.promoted.map((p) => `${p.id}（剩余否决窗口 ${vetoWindowHours}h，生效 ${p.effectiveAt}）`).join('；')}。CLI \`koi.mjs veto\` 可列出清单；过期不可回退。`,
            fullRef: `review|promotion|${period}`,
            panelOnly: true,
          })
        } catch (e) { log(`[koi] 晋升可发现性事件发射失败：${String(e?.message ?? e).slice(0, 120)}`) }
      }
      const rec = store.recordReport('monthly', period, built.content, ev?.id ?? null)
      if (!rec.ok) return { ok: false, skipped: 'duplicate', period }
      if (reportsDir) {
        try {
          fs.mkdirSync(reportsDir, { recursive: true })
          fs.writeFileSync(path.join(reportsDir, `monthly-${period}.md`), built.content + '\n')
        } catch (e) { log(`[koi] 月报文件写盘失败（报告仍在 review.db）：${String(e?.message ?? e).slice(0, 120)}`) }
      }
      log(`[koi] 月报 ${period} 已生成（晋升 ${pipeline.promoted.length} · 降级 ${pipeline.demoted.length} · 淘汰 ${pipeline.retired.length}${propResult?.ok ? ` · 提案落库 ${(propResult.accepted ?? []).length}/DSL 拒收 ${(propResult.rejected ?? []).length}` : ' · 提案段缺席如实报告'}）`)
      return { ok: true, period, content: built.content, pipeline, proposals: propResult, eventId: ev?.id ?? null }
    } finally {
      if (lock && acq && acq.ok) { try { lock.release() } catch { /* 尽力释放 */ } }
    }
  }

  return { maybeRunMonthly, generateNow, vetoFactor, runPipeline, isMonthEnd, MONTHLY_AT }
}
