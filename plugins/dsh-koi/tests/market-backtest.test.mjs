/**
 * 第二波 T7 —— lib/backtest.js 引擎 + lib/factors.js 内置六件（docs/19 §5；AC-012/023 市场版适配）。
 * §5.4 四金样本逐条：已知规律 / 纯随机（固定种子断言实际 verdict）/ 前视偏差（spy + 未来翻转对照）/
 * 二项检验数值（BigInt 精确有理数参考）；六因子结论入档（含 no-advantage 如实）；minRounds 拒跑；
 * 串行域回写（锁占用 → useLock:false 照常、默认 → 409）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { binomTailAtLeast, createBacktestWithBuiltins, caliberLines, multiTestDisclosure } from '../lib/backtest.js'
import { buildBuiltinFactors, numsOf, numberSpace } from '../lib/factors.js'
import { createCardsStore } from '../lib/cards.js'
import { createJobLock } from '../lib/joblock.js'

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'koi-bt-'))
const NOW = () => new Date('2026-10-25T12:00:00')

// ── 数据生成 ─────────────────────────────────────────────────────────────────
function mulberry32(a) {
  return function () {
    let t = (a += 0x6D2B79F5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const mkSsq = (issue, red, i) => ({ issue: String(issue), date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`, red, blue: (i % 16) + 1 })
const mkDlt = (issue, front, i) => ({ issue: String(issue), date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`, front, back: [(i % 12) + 1, ((i + 5) % 12) + 1] })
const mkP3 = (issue, digits, i) => ({ issue: String(issue), date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`, digits })

/** 随机但值域合规的 ssq 序列（升序；固定种子 → 可复现） */
function randomSsqAsc(n, seed = 42) {
  const rnd = mulberry32(seed)
  const pick6 = () => {
    const s = new Set()
    while (s.size < 6) s.add(1 + Math.floor(rnd() * 33))
    return [...s].sort((a, b) => a - b)
  }
  return Array.from({ length: n }, (_, i) => mkSsq(2026001 + i, pick6(), i))
}
/** 植入规律的序列：奇数位和值≈60、偶数位和值≈105（90–130 带内），交替出现 */
function plantedSsqAsc(n) {
  const low = [1, 2, 3, 4, 5, 45]          // 和值 60（带外）
  const high = [5, 10, 15, 20, 25, 30]     // 和值 105（带内）
  return Array.from({ length: n }, (_, i) => mkSsq(2026001 + i, i % 2 === 0 ? high : low, i))
}
const sumOf = (e) => e.red.reduce((a, b) => a + b, 0)

const fakeStore = (asc) => ({ getRecent: (g, n) => [...asc].reverse().slice(0, n === Infinity ? undefined : n) })

// ── 金样本④：二项检验数值（BigInt 精确有理数参考）──────────────────────────────
function binomExactRef(hits, n, pNum, pDen) {   // p = pNum/pDen 有理数，BigInt 精确
  const fact = (x) => { let r = 1n; for (let i = 2n; i <= x; i++) r *= i; return r }
  const comb = (a, b) => fact(a) / (fact(b) * fact(a - b))
  const P = BigInt(pNum)
  const Q = BigInt(pDen - pNum)
  const D = BigInt(pDen)
  let num = 0n
  for (let i = hits; i <= n; i++) num += comb(BigInt(n), BigInt(i)) * P ** BigInt(i) * Q ** BigInt(n - i)
  return Number(num / D ** BigInt(n)) + Number((num % D ** BigInt(n)) * 1000000000n / D ** BigInt(n)) / 1e9
}

test('金样本④ 二项检验数值：与手算有理数值误差 < 1e-9（n=20/10/5/100）', () => {
  // n=20, hits=15, p=0.5：21700/1048576
  assert.ok(Math.abs(binomTailAtLeast(15, 20, 0.5) - 21700 / 1048576) < 1e-9)
  // n=10, hits=8, p=0.5：56/1024
  assert.ok(Math.abs(binomTailAtLeast(8, 10, 0.5) - 56 / 1024) < 1e-9)
  // n=5, hits=4, p=0.3：5×0.3⁴×0.7 + 0.3⁵ = 0.03078
  assert.ok(Math.abs(binomTailAtLeast(4, 5, 0.3) - 0.03078) < 1e-9)
  // n=100, hits=65, p=0.5：BigInt 精确参考
  const ref = binomExactRef(65, 100, 1, 2)
  assert.ok(Math.abs(binomTailAtLeast(65, 100, 0.5) - ref) < 1e-9, `${binomTailAtLeast(65, 100, 0.5)} vs ${ref}`)
  // 边界
  assert.equal(binomTailAtLeast(0, 10, 0.5), 1)
  assert.equal(binomTailAtLeast(11, 10, 0.5), 0)
  assert.equal(binomTailAtLeast(3, 3, 0), 0)
  assert.equal(binomTailAtLeast(0, 3, 0), 1)
  assert.equal(binomTailAtLeast(3, 3, 1), 1)
})

// ── 金样本①：已知规律（预注册非对称判据：带外期后回带内）────────────────────────
test('金样本① 已知规律：植入交替规律 + 「带外期后回带内」因子 → hitRate=1.0、pValue≈0、better-in-sample', async () => {
  const data = plantedSsqAsc(200)
  const factor = {
    id: 'test-return-to-band', source: 'builtin', game: 'ssq', name: '带外期后回带内（测试植入因子）',
    predict(h) {
      const last = h[h.length - 1]
      if (sumOf(last) >= 90 && sumOf(last) <= 130) return null   // 形成期在带内 → 本期无观点（跳过）
      return {
        claim: '下一期和值回到 90–130 带内',
        judge(next) { const s = sumOf(next); return { hit: s >= 90 && s <= 130, detail: `和值=${s}` } },
      }
    },
  }
  const bt = createBacktestWithBuiltins({ dataDir: tmpdir(), drawStore: fakeStore(data), now: NOW })
  bt.register(factor)
  const r = await bt.runFactor(factor.id)
  assert.equal(r.ok, true)
  assert.equal(r.hitRate, 1.0, '规律被完整命中')
  assert.equal(r.baselineRate, 0, '形成期（带外）回判全不中 → 基线 0')
  assert.equal(r.pValue, 0, 'P(X≥rounds | p=0) = 0')
  assert.equal(r.verdict, 'better-in-sample')
  assert.ok(r.skips > 0, '带内形成期跳过不计分母（如实分开计）')
})

test('金样本① 附注：恒定序列 × 内置 sum-band → hitRate=1.0 但基线同为 1.0 → 诚实判 no-advantage（W2B 决策：docs/19 §5.4 行1 原构造与 §5.2 基线定义不相容）', async () => {
  const constant = Array.from({ length: 200 }, (_, i) => mkSsq(2026001 + i, [5, 10, 15, 20, 25, 30], i))
  const bt = createBacktestWithBuiltins({ dataDir: tmpdir(), drawStore: fakeStore(constant), now: NOW })
  const r = await bt.runFactor('builtin-sum-band-ssq')
  assert.equal(r.ok, true)
  assert.equal(r.hitRate, 1.0)
  assert.equal(r.baselineRate, 1.0)
  assert.equal(r.verdict, 'no-advantage', '完美命中但与其自身基线无差异——不美化（BC-001）')
})

// ── 金样本②：纯随机（固定种子断言实际 verdict）────────────────────────────────
test('金样本② 纯随机：mulberry32(42) 的 ssq 序列上六内置因子全部 no-advantage（固定种子实际值）', async () => {
  const data = randomSsqAsc(200, 42)
  const dir = tmpdir()
  const bt = createBacktestWithBuiltins({ dataDir: dir, drawStore: fakeStore(data), now: NOW })
  const r = await bt.runBuiltin({ game: 'ssq' })
  assert.equal(r.ok, true)
  assert.equal(r.results.length, 6)
  for (const x of r.results) {
    assert.equal(x.verdict, 'no-advantage', `${x.factorId} 在固定随机种子下应为与随机无异（实际 p=${x.pValue}）`)
  }
  // 结论档落盘 + 口径披露（AC-023 适配：六类全部有结论入档，含 no-advantage 如实）
  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'backtest', 'builtin-ssq.json'), 'utf8'))
  assert.equal(doc.factors.length, 6)
  assert.ok(doc.disclosure.some((l) => l.includes('期望约 0.3 个因子纯因偶然过关')), '多重检验披露（K=6）')
  assert.ok(doc.disclosure.some((l) => l.includes('判据滞后自评满足率')))
  assert.ok(doc.disclosure.some((l) => l.includes('不改变中奖概率，也不驱动任何自动行为')))
})

// ── 金样本③：前视偏差（spy 切片 + 未来段翻转对照；TC-014/AC-012 口径）────────────
test('金样本③ 前视偏差：每轮切片长度 = t+1 且内容与「未来被改写」无关', async () => {
  const base = randomSsqAsc(160, 7)
  const seen = []
  const spy = {
    id: 'test-spy', source: 'builtin', game: 'ssq', name: 'spy',
    predict(slice) {
      seen.push({ len: slice.length, last: slice[slice.length - 1].issue, fp: slice.map((e) => sumOf(e)).join(',') })
      return { claim: 'x', judge: () => ({ hit: false, detail: '' }) }
    },
  }
  const bt = createBacktestWithBuiltins({ dataDir: tmpdir(), drawStore: fakeStore(base), now: NOW })
  bt.register(spy)
  const r = await bt.runFactor(spy.id, { warmup: 30 })
  assert.equal(r.ok, true)
  const wu = 30
  assert.equal(seen.length, base.length - 1 - wu)
  seen.forEach((s, i) => {
    const t = wu + i
    assert.equal(s.len, t + 1, `第 ${i} 轮切片长度必须 = t+1（防前视结构保证）`)
    assert.equal(s.last, base[t].issue, '切片末元素 = 形成期本身')
  })
  // 未来翻转对照：改写 t=100 之后的所有数据 → t<100 的各轮 predict 输入完全一致
  const mutated = base.map((e, i) => (i > 100 ? mkSsq(2026001 + i, [1, 2, 3, 4, 5, 33], i) : e))
  const seen2 = []
  const spy2 = {
    ...spy,
    predict(slice) {
      seen2.push({ len: slice.length, last: slice[slice.length - 1].issue, fp: slice.map((e) => sumOf(e)).join(',') })
      return { claim: 'x', judge: () => ({ hit: false, detail: '' }) }
    },
  }
  const bt2 = createBacktestWithBuiltins({ dataDir: tmpdir(), drawStore: fakeStore(mutated), now: NOW })
  bt2.register(spy2)
  await bt2.runFactor(spy2.id, { warmup: 30 })
  const upto = 100 - wu   // t < 100 的轮次
  for (let i = 0; i < upto; i++) assert.equal(seen[i].fp, seen2[i].fp, `第 ${i} 轮判据输入不受未来改写影响（AC-012）`)
})

// ── 引擎约束：minRounds 拒跑 / 作业锁 / 串行域回写 ────────────────────────────────
test('minRounds 拒跑：历史不足明示「先全量回拉」，样本不足不出结论', async () => {
  const bt = createBacktestWithBuiltins({ dataDir: tmpdir(), drawStore: fakeStore(randomSsqAsc(50, 1)), now: NOW })
  const r = await bt.runFactor('builtin-sum-band-ssq')
  assert.equal(r.ok, false)
  assert.ok(r.error.includes('先全量回拉'), r.error)
})

test('作业锁：默认 runFactor/runAll acquire（被占 → 409）；useLock:false 供持锁串行域链式触发（W2A-20/23）', async () => {
  const dir = tmpdir()
  const lock = createJobLock({ file: path.join(dir, 'job-lock.json'), now: NOW })
  const bt = createBacktestWithBuiltins({ dataDir: dir, drawStore: fakeStore(randomSsqAsc(200, 3)), now: NOW, lock })
  assert.equal(lock.acquire('ingest', 'ing-9').ok, true, '前置：ingest 持锁')
  const blocked = await bt.runFactor('builtin-sum-band-ssq')
  assert.equal(blocked.ok, false)
  assert.equal(blocked.code, 409)
  const inDomain = await bt.runFactor('builtin-sum-band-ssq', { useLock: false })
  assert.equal(inDomain.ok, true, '锁域内（ingest 链式触发）不重复 acquire')
  lock.release()
  const free = await bt.runFactor('builtin-sum-band-ssq')
  assert.equal(free.ok, true)
  assert.equal(fs.existsSync(path.join(dir, 'job-lock.json')), false, '跑完释放')
})

test('卡片因子结论回写 cards[].backtest + 全家归档 runs/<runId>.json（串行域断言）', async () => {
  const dir = tmpdir()
  const cards = createCardsStore({ dataDir: dir, now: NOW })
  const created = cards.addCards([{ name: '蓝球追热法', games: ['ssq'], rule: '近 30 期出现 ≥3 次的号中至少 2 个再出现', computable: true }], { source: '技巧.md', sourceJob: 'ing-1' })
  const card = created[0]
  // 卡片因子（模拟因子化产物）：source = card:<cardId>
  const cardFactor = {
    id: `card-${card.id}`, source: `card:${card.id}`, game: 'ssq', name: card.name,
    predict(h) {
      const tail = h.slice(-30)
      const freq = new Map()
      for (const e of tail) { const n = Number(e.blue); freq.set(n, (freq.get(n) ?? 0) + 1) }
      const hot = [...freq.entries()].filter(([, c]) => c >= 3).map(([n]) => n)
      if (!hot.length) return null
      return { claim: `近 30 期蓝球热号（${hot.join('/')}）至少一个再出`, judge: (next) => ({ hit: hot.includes(Number(next.blue)), detail: `蓝=${next.blue}` }) }
    },
  }
  const bt = createBacktestWithBuiltins({ dataDir: dir, drawStore: fakeStore(randomSsqAsc(200, 11)), now: NOW, cardsStore: cards })
  bt.register(cardFactor)
  const r = await bt.runAll({ game: 'ssq' })
  assert.equal(r.ok, true)
  assert.equal(r.results.length, 7, '六内置 + 1 卡片因子')
  const after = cards.get(card.id)
  assert.ok(after.backtest, '结论回写卡片')
  assert.equal(after.backtest.runRef, r.runId)
  assert.ok(['better-in-sample', 'no-advantage'].includes(after.backtest.verdict))
  const runDoc = JSON.parse(fs.readFileSync(r.file, 'utf8'))
  assert.equal(runDoc.factors.length, 7)
  assert.ok(runDoc.disclosure.some((l) => l.includes('共检验 7 个因子')), '多重检验披露 K=7')
  // verdicts 视图（面板因子结论区数据源）
  const v = bt.verdicts('ssq')
  assert.equal(v.filter((x) => x.kind === 'builtin').length, 6)
  assert.equal(v.filter((x) => x.kind === 'card').length, 1)
})

test('p3/dlt 六件全部适用（判据按位解释）：随机序列上结论入档', async () => {
  const rnd = mulberry32(99)
  const p3 = Array.from({ length: 200 }, (_, i) => mkP3(26001 + i, [Math.floor(rnd() * 10), Math.floor(rnd() * 10), Math.floor(rnd() * 10)], i))
  const dir = tmpdir()
  const bt = createBacktestWithBuiltins({ dataDir: dir, drawStore: fakeStore(p3), now: NOW })
  const r = await bt.runBuiltin({ game: 'p3' })
  assert.equal(r.results.length, 6, '六件对 p3 全部适用')
  for (const x of r.results) assert.ok(x.rounds > 0)
  const rnd2 = mulberry32(123)
  const dlt = Array.from({ length: 200 }, (_, i) => {
    const s = new Set()
    while (s.size < 5) s.add(1 + Math.floor(rnd2() * 35))
    return mkDlt(26001 + i, [...s].sort((a, b) => a - b), i)
  })
  const bt2 = createBacktestWithBuiltins({ dataDir: tmpdir(), drawStore: fakeStore(dlt), now: NOW })
  const r2 = await bt2.runBuiltin({ game: 'dlt' })
  assert.equal(r2.results.length, 6)
})

test('口径文案与禁用词：披露行零概率宣称（hasProbabilityClaim）', async () => {
  const { hasProbabilityClaim } = await import('../lib/render.js')
  const lines = [...multiTestDisclosure(6), ...caliberLines({ n: 200 })]
  for (const l of lines) assert.equal(hasProbabilityClaim(l), false, l)
})

test('numsOf/numberSpace：三彩种取数域正确（ssq 红 1–33 / dlt 前 1–35 / p3 位 0–9）', () => {
  assert.deepEqual(numsOf('ssq', mkSsq(1, [1, 2, 3, 4, 5, 6], 0)), [1, 2, 3, 4, 5, 6])
  assert.deepEqual(numsOf('p3', mkP3(1, [9, 8, 7], 0)), [9, 8, 7])
  assert.deepEqual(numberSpace('ssq'), { min: 1, max: 33 })
  assert.deepEqual(numberSpace('dlt'), { min: 1, max: 35 })
  assert.deepEqual(numberSpace('p3'), { min: 0, max: 9 })
})
