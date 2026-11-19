/**
 * docs/32 §6.2② 极值/分位数档案测试（lib/insight.js percentile 族）——
 * percentile 线性插值数值与单调性/边界、profile 档案手算数值、三彩种形状、空库零崩溃。
 * 「现算不落表」由模块纯函数性质保证（零 IO 可导入面）；数值断言全部手算。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { percentile, percentileRank, profile, omissionSeriesByCell } from '../lib/insight.js'

const P3_HISTORY = [
  { issue: '26281', date: '2026-10-22', digits: [1, 2, 3] },
  { issue: '26282', date: '2026-10-23', digits: [4, 5, 6] },
  { issue: '26283', date: '2026-10-24', digits: [7, 8, 9] },
  { issue: '26284', date: '2026-10-25', digits: [0, 2, 4] },
  { issue: '26285', date: '2026-10-26', digits: [3, 3, 3] },
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

test('percentile：线性插值数值（[1..100] p50=50.5）；单调性（p 增大值不减）；已知点手算', () => {
  const hundred = Array.from({ length: 100 }, (_, i) => i + 1)
  assert.equal(percentile(hundred, 50), 50.5, 'rank=49.5 → 50+0.5×1')
  assert.equal(percentile(hundred, 0), 1)
  assert.equal(percentile(hundred, 100), 100)
  const tri = [10, 20, 30]
  assert.equal(percentile(tri, 25), 15, 'rank=0.5 → 10+0.5×10')
  assert.equal(percentile(tri, 50), 20)
  const mixed = [5, 1, 9, 3, 7, 3, 8, 2]
  let prev = -Infinity
  for (let p = 0; p <= 100; p += 5) {
    const v = percentile(mixed, p)
    assert.ok(v >= prev, `p=${p} 单调不减（${v} ≥ ${prev}）`)
    assert.ok(v >= 1 && v <= 9, `p=${p} 在极值区间内（${v} ∈ [1,9]）`)
    prev = v
  }
})

test('percentile 边界：空数组 → null；单元素恒自身；p=0/100=极值；p 越界/非有限抛错；percentileRank ≤ 口径手算', () => {
  assert.equal(percentile([], 50), null)
  assert.equal(percentile([7], 37), 7)
  assert.equal(percentile([4, 2, 8], 0), 2, 'min')
  assert.equal(percentile([4, 2, 8], 100), 8, 'max（极值区间端点）')
  assert.throws(() => percentile([1, 2, 3], -1), /\[0,100\]/, 'p 负数')
  assert.throws(() => percentile([1, 2, 3], 101), /\[0,100\]/, 'p 超上界')
  assert.throws(() => percentile([1, 2, 3], NaN), /\[0,100\]/, 'p 非有限数')
  assert.equal(percentileRank([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5), 50, '≤5 占 5/10')
  assert.equal(percentileRank([1, 2, 3], 0), 0, '低于全部 → 0 分位')
  assert.equal(percentileRank([1, 2, 3], 3), 100, '「≤ v」口径：等于最大值 → 100')
  assert.ok(Math.abs(percentileRank([1, 2, 3], 2.5) - 200 / 3) < 1e-9, '≤2.5 占 2/3')
  assert.equal(percentileRank([], 1), null)
})

test('profile 手算数值：p3 夹具 sum/span/ac/odd/consec/maxRun 分位数与极值区间；cell 逐期遗漏序列分布', () => {
  const p = profile('p3', P3_HISTORY)
  assert.equal(p.count, 5)
  assert.ok(p.note.includes('无预测力'), 'BC-001 注记常驻')
  // 逐期特征手算：sum [6,15,24,6,9] / span [2,2,2,4,0] / ac [0,0,0,0,−2] / odd [1,1,2,0,3] / consec [2,2,2,0,0] / maxRun [3,3,3,1,1]
  assert.deepEqual(
    { min: p.summary.sum.min, p50: p.summary.sum.p50, p75: p.summary.sum.p75, p90: p.summary.sum.p90, max: p.summary.sum.max },
    { min: 6, p50: 9, p75: 15, p90: 20.4, max: 24 },
    '和值分位（sorted [6,6,9,15,24]；p90=15+0.6×9）',
  )
  assert.equal(p.summary.span.p50, 2)
  assert.equal(p.summary.span.max, 4)
  assert.equal(p.summary.ac.min, -2, '全同号 [3,3,3] → AC=−2（可为负的边界）')
  assert.equal(p.summary.ac.p50, 0)
  assert.equal(p.summary.odd.max, 3)
  assert.equal(p.summary.consec.p50, 2)
  assert.equal(p.summary.maxRun.max, 3, '最长连号 [1,2,3] 型 → 3')
  // cell 序列：p0d1 各期「开奖前」遗漏 [0,1,2,3]；p0d3 [1,2,3,4]；p2d3 [0,1,2,3]
  const s = omissionSeriesByCell('p3', P3_HISTORY)
  assert.deepEqual(s.p0d1, [0, 1, 2, 3])
  assert.deepEqual(s.p0d3, [1, 2, 3, 4])
  assert.deepEqual(s.p2d3, [0, 1, 2, 3])
  assert.equal(p.cells.p0d1.p50, 1.5)
  assert.equal(p.cells.p0d3.max, 4)
  // §6.2② 注入语义演示：「当前百位 3 已 4 期未开 = 历史 100 分位」
  assert.equal(percentileRank(s.p0d3, 4), 100)
  assert.equal(percentileRank(s.p2d3, 3), 100)
})

test('profile 三彩种形状（cells 30/49/47）+ 空库零崩溃（count 0 全 null 注记在位）', () => {
  const p3 = profile('p3', P3_HISTORY)
  assert.equal(Object.keys(p3.cells).length, 30)
  const ssq = profile('ssq', SSQ_HISTORY)
  assert.equal(Object.keys(ssq.cells).length, 49)
  assert.equal(ssq.summary.sum.p50, 109, '红球和值 [96,112,109] 中位 109')
  assert.equal(ssq.cells.b7.n, 2, '蓝区 cell 在位（首期不产出 → n=2）')
  const dlt = profile('dlt', DLT_HISTORY)
  assert.equal(Object.keys(dlt.cells).length, 47)
  assert.ok(dlt.cells.b12, '后区 cell 在位')
  const empty = profile('p3', [])
  assert.equal(empty.count, 0)
  assert.equal(empty.summary.sum, null)
  assert.equal(empty.cells.p0d0, null)
  assert.ok(empty.note.includes('无预测力'), '空库注记仍常驻')
})
