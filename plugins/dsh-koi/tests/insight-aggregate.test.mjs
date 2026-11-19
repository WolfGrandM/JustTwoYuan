/**
 * docs/32 §6.2③ 聚合视图生成器测试（lib/insight.js aggregate）——
 * 形状/转移频次表与条件分位数手算/BC-001 注记在位（头尾常驻）/因子覆盖盲区清单/三彩种零崩溃/期数不足不虚构。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { aggregate, DISCLAIMER } from '../lib/insight.js'

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

test('aggregate 转移频次表/条件分位数手算（p3）：档界=自身三分位；矩阵计数与行百分比；条件分位数数值', () => {
  const r = aggregate('p3', P3_HISTORY)
  assert.equal(r.game, 'p3')
  assert.equal(r.count, 5)
  assert.deepEqual(r.latest, { issue: '26285', date: '2026-10-26' })
  // 和值序列 [6,15,24,6,9] → 档界 q33≈7 / q66≈13 → 档 [low, high, high, low, mid]
  const t = r.json.transitions
  assert.equal(t.pairs, 4)
  assert.deepEqual(t.matrix.low, { low: 0, mid: 1, high: 1 }, '6→15(low→high)、6→9(low→mid)')
  assert.deepEqual(t.matrix.high, { low: 1, mid: 0, high: 1 }, '15→24(high→high)、24→6(high→low)')
  assert.deepEqual(t.matrix.mid, { low: 0, mid: 0, high: 0 })
  assert.deepEqual(t.rowPct.low, { low: 0, mid: 50, high: 50 })
  assert.deepEqual(t.rowPct.high, { low: 50, mid: 0, high: 50 })
  assert.deepEqual(t.rowPct.mid, { low: null, mid: null, high: null }, '空行百分比 null 不虚构 0%')
  // 条件分位数：low 组下期和值 [15,9] → p50=12；high 组 [24,6] → p90=22.2
  const c = r.json.conditional.bands
  assert.equal(c.low.count, 2)
  assert.equal(c.low.min, 9)
  assert.equal(c.low.p50, 12)
  assert.ok(Math.abs(c.low.p90 - 14.4) < 1e-9)
  assert.equal(c.low.max, 15)
  assert.equal(c.high.count, 2)
  assert.ok(Math.abs(c.high.p90 - 22.2) < 1e-9)
  assert.equal(c.mid, null, '无中档上期 → 条件行 null（不虚构）')
  // markdown 三段标题在位
  assert.ok(r.markdown.startsWith('# 排列三 聚合视图（探索性素材 · 无预测力声明）'))
  assert.ok(r.markdown.includes('## 转移频次表'))
  assert.ok(r.markdown.includes('## 条件分位数'))
  assert.ok(r.markdown.includes('## 因子覆盖盲区清单'))
  assert.ok(r.markdown.includes('不产表、不虚构') === false, '期数充足时无「不产表」段')
})

test('aggregate BC-001 注记在位：markdown 头尾常驻（≥2 处）+ json.disclaimer 同源常量', () => {
  const r = aggregate('p3', P3_HISTORY)
  const hits = r.markdown.split(DISCLAIMER).length - 1
  assert.ok(hits >= 2, `注记出现 ${hits} 次（头部引用 + 尾部 footer）`)
  assert.equal(r.json.disclaimer, DISCLAIMER)
  assert.ok(DISCLAIMER.includes('不构成预测') && DISCLAIMER.includes('不改变任何概率'))
})

test('aggregate 因子覆盖盲区清单：盲区=AC 值/跨度（factors.js:10 移交项如实引用）；已覆盖五维；json/markdown 同构', () => {
  const r = aggregate('p3', P3_HISTORY)
  const b = r.json.blindSpots
  assert.deepEqual(b.uncovered.map((d) => d.dimension), ['ac', 'span'])
  assert.deepEqual(b.covered.map((d) => d.dimension), ['omission', 'sum', 'parity', 'road', 'consec'])
  assert.deepEqual(b.covered.find((d) => d.dimension === 'omission').coveredBy, ['builtin-omission', 'builtin-hot-cold'])
  assert.ok(b.uncovered.find((d) => d.dimension === 'ac').hint.includes('factors.js:10'), '盲区 hint 引用移交出处')
  assert.ok(r.markdown.includes('**AC 值**') && r.markdown.includes('**跨度**'))
  assert.ok(r.markdown.includes('builtin-omission'), '已覆盖维度带因子家族 id')
})

test('aggregate 三彩种零崩溃 + 期数不足边界（空库/2 期 → transitions=null 不产表不虚构；latest=null）', () => {
  for (const [game, history] of [['p3', P3_HISTORY], ['ssq', SSQ_HISTORY], ['dlt', DLT_HISTORY]]) {
    const r = aggregate(game, history)
    assert.equal(r.count, history.length)
    assert.ok(r.markdown.length > 200)
    assert.equal(r.json.game, game)
    assert.ok(r.json.blindSpots.uncovered.length >= 2)
  }
  const two = aggregate('p3', P3_HISTORY.slice(0, 2))
  assert.equal(two.count, 2)
  assert.equal(two.json.transitions, null, '<3 期不可分带')
  assert.equal(two.json.conditional, null)
  assert.ok(two.markdown.includes('不产表、不虚构'), '期数不足显式注明，不虚构表格')
  const empty = aggregate('ssq', [])
  assert.equal(empty.count, 0)
  assert.equal(empty.latest, null)
  assert.equal(empty.json.transitions, null)
  assert.ok(empty.markdown.includes('（空库）'))
  assert.throws(() => aggregate('pks', P3_HISTORY), /彩种/, '彩种非法抛错')
})
