/**
 * docs/32 §6.2① 局势指纹与相似检索测试（lib/insight.js）——
 * 指纹确定性/防前视（截断等价 + 篡改免疫，硬约束显式断言）/边界/跨彩种/距离函数。
 * 夹具内联、手算数值断言（口径与 lib/stats.js 遗漏、lib/factors.js 特征一致）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { fingerprint, fingerprintSeries, fingerprintDistance, similar, cellsOf, drawFeatures, DISCLAIMER } from '../lib/insight.js'

const P3_HISTORY = [   // 故意乱序传入（模块内部须按期号升序整理）——确定性/鲁棒性同测
  { issue: '26283', date: '2026-10-24', digits: [7, 8, 9] },
  { issue: '26281', date: '2026-10-22', digits: [1, 2, 3] },
  { issue: '26284', date: '2026-10-25', digits: [0, 2, 4] },
  { issue: '26282', date: '2026-10-23', digits: [4, 5, 6] },
]
const SSQ_HISTORY = [
  { issue: '2026119', date: '2026-10-18', red: [2, 5, 11, 19, 26, 33], blue: 7 },
  { issue: '2026120', date: '2026-10-20', red: [13, 14, 16, 18, 20, 31], blue: 3 },
  { issue: '2026121', date: '2026-10-22', red: [2, 7, 20, 24, 26, 30], blue: 2 },
]
const DLT_HISTORY = [
  { issue: '26118', date: '2026-10-19', front: [3, 7, 14, 21, 29], back: [1, 5] },
  { issue: '26119', date: '2026-10-21', front: [2, 9, 18, 27, 33], back: [4, 6] },
  { issue: '26120', date: '2026-10-23', front: [1, 11, 20, 25, 34], back: [2, 8] },
]

test('指纹确定性：同输入两次 deepEqual；乱序输入 ≡ 升序输入；不改调用方数组；三彩种 cell 数 49/47/30', () => {
  const a = fingerprint('p3', P3_HISTORY, '26284')
  const b = fingerprint('p3', P3_HISTORY, '26284')
  assert.deepEqual(a, b)
  const sorted = [...P3_HISTORY].sort((x, y) => Number(x.issue) - Number(y.issue))
  assert.deepEqual(fingerprint('p3', sorted, '26284'), a)
  assert.equal(P3_HISTORY[0].issue, '26283', '输入数组顺序未被改动（防御性拷贝）')
  assert.equal(Object.keys(a.omissions).length, 30, 'p3 按位：3 位 × 0–9 = 30 cell')
  assert.equal(Object.keys(fingerprint('ssq', SSQ_HISTORY, '2026122').omissions).length, 49, 'ssq 红33+蓝16')
  assert.equal(Object.keys(fingerprint('dlt', DLT_HISTORY, '26121').omissions).length, 47, 'dlt 前35+后12')
})

test('指纹数值手算（p3）：遗漏口径与 stats.js 一致（0=上期刚开/从未=m）；last 特征=和24 奇2 路[1,1,1] AC0 连2', () => {
  const f = fingerprint('p3', P3_HISTORY, '26284')   // 前期 = 26281 [1,2,3] / 26282 [4,5,6] / 26283 [7,8,9]
  assert.equal(f.priorCount, 3)
  assert.equal(f.omissions.p0d7, 0, '百位 7 上期刚开 → 遗漏 0')
  assert.equal(f.omissions.p0d1, 2, '百位 1 距今 2 期')
  assert.equal(f.omissions.p0d4, 1)
  assert.equal(f.omissions.p1d8, 0)
  assert.equal(f.omissions.p2d9, 0)
  assert.equal(f.omissions.p0d0, 3, '从未开出 → 遗漏 = 前期期数 3（stats.js 同口径）')
  assert.equal(f.omissions.p2d5, 3)
  assert.equal(f.last.sum, 24, '7+8+9')
  assert.equal(f.last.odd, 2, '7、9 为奇')
  assert.deepEqual(f.last.road, [1, 1, 1], '7%3=1, 8%3=2, 9%3=0')
  assert.equal(f.last.ac, 0, '差值去重 {1,2} − (3−1)')
  assert.equal(f.last.consec, 2, 'p3 相邻位差 1（factors.js 口径）：|8−7|、|9−8|')
})

test('防前视·截断等价（硬约束①）：含自身与未来期的全库指纹 ≡ 严格早于该期的截断指纹（三彩种）；库内首期/空库 → null', () => {
  for (const [game, history, target] of [['p3', P3_HISTORY, '26284'], ['ssq', SSQ_HISTORY, '2026121'], ['dlt', DLT_HISTORY, '26120']]) {
    const full = fingerprint(game, history, target)
    const cut = fingerprint(game, history.filter((e) => Number(e.issue) < Number(target)), target)
    assert.deepEqual(full, cut, `${game}：指纹只吃 < ${target} 的历史`)
  }
  assert.equal(fingerprint('p3', P3_HISTORY, '26281'), null, '库内首期：无前期历史 → null')
  assert.equal(fingerprint('p3', [], '26285'), null, '空库 → null')
})

test('防前视·篡改免疫（硬约束②）：目标期及其之后全部改极端号 → similar 输出零变化；hits 严格早于目标期；next=候选自身开奖', () => {
  const original = similar('p3', P3_HISTORY, '26283', 2)
  const tampered = P3_HISTORY.map((e) => Number(e.issue) >= 26283
    ? { ...e, digits: [9, 9, 9], date: '2099-01-01' }
    : e)
  const after = similar('p3', tampered, '26283', 2)
  assert.deepEqual(after, original, '≥26283 的条目（含目标期自身开奖）完全不进指纹与检索')
  assert.equal(original.target.priorCount, 2)
  assert.equal(original.scanned, 1, '候选=有前期历史且 <26283：仅 26282')
  assert.ok(original.hits.every((h) => Number(h.issue) < 26283), '检索范围严格早于给定 issue')
  assert.deepEqual(original.hits[0].next.digits, [4, 5, 6], 'next = 候选期自身开奖（后续开奖如实给表）')
})

test('距离函数：同况距离恰 0；对称；异况更大；手算值 43/300（遗漏 0.6 + 特征 0.4 加权）', () => {
  const a = fingerprint('p3', P3_HISTORY, '26284')
  assert.equal(fingerprintDistance(a, { ...a }), 0, '完全同况 → 0')
  const c = fingerprint('p3', P3_HISTORY, '26283')
  const d1 = fingerprintDistance(a, c)
  assert.equal(fingerprintDistance(c, a), d1, '对称')
  assert.ok(d1 > 0)
  assert.ok(Math.abs(d1 - 43 / 300) < 1e-9, `手算：omitDist=0.15 featDist=2/15 → 0.6×0.15+0.4×2/15=43/300（实得 ${d1}）`)
  const far = {
    game: 'p3', issue: 'X', priorCount: 10,
    omissions: Object.fromEntries(cellsOf('p3').map((k) => [k, 10])),
    last: { sum: 0, odd: 0, road: [3, 0, 0], ac: -2, consec: 0 },
  }
  assert.ok(fingerprintDistance(a, far) > d1, '异况（全冷+极值特征）距离更大')
  assert.throws(() => fingerprintDistance(a, { ...far, game: 'ssq' }), /跨彩种/, '跨彩种指纹不可比')
})

test('similar：top-K 距离升序/截断/scanned/结构/BC-001 注记常驻；跨彩种零崩溃', () => {
  const r = similar('p3', P3_HISTORY, '26284', 2)
  assert.equal(r.k, 2)
  assert.equal(r.scanned, 2, '候选 = 26282、26283（26281 无前期历史不产出）')
  assert.deepEqual(r.hits.map((h) => h.issue), ['26283', '26282'], '26283 局势更近（手算 0.1433 < 0.22），距离升序')
  assert.ok(r.hits[0].distance <= r.hits[1].distance)
  assert.ok(Math.abs(r.hits[0].distance - 43 / 300) < 1e-9)
  assert.equal(r.target.priorCount, 3)
  assert.equal(r.target.fingerprint.issue, '26284')
  assert.deepEqual(r.hits[0].next.digits, [7, 8, 9], '命中期 26283 的后续开奖=其自身开奖')
  assert.ok(r.note.includes('无预测力'), 'BC-001 注记常驻')
  assert.ok(DISCLAIMER.includes('不构成预测'))
  for (const [game, history, target] of [['ssq', SSQ_HISTORY, '2026122'], ['dlt', DLT_HISTORY, '26121']]) {
    const s = similar(game, history, target, 5)
    assert.equal(s.scanned, 2)
    assert.equal(s.hits.length, 2, 'k > 可用候选数 → 全部返回')
    assert.ok(s.hits.every((h) => Number(h.issue) < Number(target)), `${game} 检索严格早于目标期`)
  }
})

test('similar 边界：目标期无前期历史 → target=null/hits 空不崩；k 非法抛错；彩种非法抛错；指纹序列首期不产出', () => {
  const r = similar('p3', P3_HISTORY, '26281', 5)
  assert.equal(r.target, null)
  assert.deepEqual(r.hits, [])
  assert.equal(r.scanned, 0)
  assert.ok(r.note.includes('无预测力'), '边界形态注记仍在')
  const empty = similar('p3', [], '26285')
  assert.equal(empty.target, null)
  assert.deepEqual(empty.hits, [])
  assert.throws(() => similar('p3', P3_HISTORY, '26284', 0), /k 要是/, 'k=0')
  assert.throws(() => similar('p3', P3_HISTORY, '26284', 1.5), /k 要是/, 'k 非整数')
  assert.throws(() => similar('p3', P3_HISTORY, '26284', -1), /k 要是/, 'k 负数')
  assert.throws(() => fingerprint('pks', P3_HISTORY, '26284'), /彩种/, '彩种非法')
  assert.throws(() => fingerprint('p3', 'not-array', '26284'), /history/, 'history 非数组')
  const series = fingerprintSeries('p3', P3_HISTORY)
  assert.deepEqual(series.map((s) => s.issue), ['26282', '26283', '26284'], '首期（26281）无前期局势不产出；其余升序')
  assert.deepEqual(drawFeatures('ssq', SSQ_HISTORY[2]).blue, 2, 'ssq 特征附蓝球')
  assert.equal(drawFeatures('dlt', DLT_HISTORY[2]).backSum, 10, 'dlt 特征附后区和（2+8）')
  assert.equal(drawFeatures('dlt', DLT_HISTORY[2]).ac, 4, 'dlt AC 手算：差值去重 {5,9,10,14,19,23,24,33} − 4')
})
