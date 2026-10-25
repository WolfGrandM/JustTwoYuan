/**
 * 判奖金样本回归（C5 / FR-007 / AC-002）—— 固定夹具零网络；夹具单一源 lib/golden-fixtures.js
 * （v0.2-B1 T-04 自本文件与 tools/koi.mjs 的双份手工镜像下沉；tools/koi.mjs selftest 同源消费）。
 *
 * 夹具来源（2026-10-24 核实，全文见 lib/golden-fixtures.js 头注）：
 *   · SSQ 2026121（2026-10-22 开奖）红 02 07 20 24 26 30 + 蓝 02 —— 本仓库开发期自福彩官网实测数据
 *     （tests/stats.test.mjs 同源夹具，issue/日期映射与 tests/draws.test.mjs nextIssue 用例互证）；
 *   · DLT 26120（2026-10-21 开奖）前区 01 06 10 15 32 + 后区 03 04 —— 体彩开奖公告核实（新浪体育
 *     26120 期数据复盘文 + 上海体彩开奖公告页两源一致；期号/日期与本仓库 nextIssue 夹具互证）；
 *   · P3 26282（2026-10-23 开奖）6-4-7 —— 本仓库开发期自体彩官网实测数据（排列五前三位）。
 * 投注为假想构造（AC-002 口径：以历史真实开奖构造覆盖全部奖级的假想投注），
 * 期望值按官方固定奖级表手算：SSQ 三~六等 3000/200/10/5、DLT 三~九等 10000/3000/300/200/100/15/5、
 * P3 直选 1040；一/二等奖浮动当晚按 0 计、给了 gradeMoney 才计入（docs/08 FR-5.3 语义）。
 * 覆盖：SSQ 一~六等、DLT 一~九等、P3 直选+未中 —— 三彩种全部奖级各至少一例。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { judge, enumerateBets, gradeSummaryText } from '../lib/draws.js'
import { GOLDEN_SSQ as SSQ, GOLDEN_DLT as DLT, GOLDEN_P3 as P3 } from '../lib/golden-fixtures.js'

test('夹具自检：真实开奖号本身合法（个数/范围），投注展开注数与规格一致', () => {
  assert.equal(SSQ.red.length, 6); assert.ok(SSQ.blue >= 1 && SSQ.blue <= 16)
  assert.equal(DLT.front.length, 5); assert.equal(DLT.back.length, 2)
  assert.equal(P3.digits.length, 3)
  assert.equal(enumerateBets('ssq', { red: [2, 7, 20, 24, 26, 30, 31, 33], blue: 2 }).length, 28)
  assert.equal(enumerateBets('dlt', { front: [1, 6, 10, 15, 32, 7, 14], back: [3, 4] }).length, 21)
  assert.equal(enumerateBets('p3', { digits: [6, 4, 7] }).length, 1)
})

test('SSQ 一等（6红+蓝）：一等×1 三等×12 四等×15；浮动未给金额按 0 计', () => {
  const j = judge('ssq', { red: [2, 7, 20, 24, 26, 30, 31, 33], blue: 2 }, SSQ)
  assert.deepEqual(j.grades, { 1: 1, 3: 12, 4: 15 })
  assert.equal(j.bets, 28)
  assert.equal(j.money, 12 * 3000 + 15 * 200)   // 39,000（一等浮动不计）
  assert.equal(j.floating, true)
})

test('SSQ 一等给了官方金额 → 计入', () => {
  const j = judge('ssq', { red: [2, 7, 20, 24, 26, 30, 31, 33], blue: 2 }, SSQ, { 1: 10_000_000 })
  assert.equal(j.floating, false)
  assert.equal(j.money, 10_000_000 + 12 * 3000 + 15 * 200)
})

test('SSQ 二等（6红0蓝）：二等×1 四等×12 五等×15 = 2,550（二等浮动）', () => {
  const j = judge('ssq', { red: [2, 7, 20, 24, 26, 30, 31, 33], blue: 3 }, SSQ)
  assert.deepEqual(j.grades, { 2: 1, 4: 12, 5: 15 })
  assert.equal(j.money, 12 * 200 + 15 * 10)
  assert.equal(j.floating, true)
})

test('SSQ 三等单列核（5红+蓝，4红+蓝归四等）已在「6红全含」样例覆盖；本例补 4红+蓝 的四/五/六等分布', () => {
  // 池内恰 4 个开奖红号（2,7,20,24）+ 4 个非开奖号，蓝中：
  //   4红+蓝 → 四等×C(4,4)C(4,2)=6；3红+蓝 → 五等×C(4,3)C(4,3)=16；≤2红+蓝 → 六等×6
  const j = judge('ssq', { red: [2, 7, 20, 24, 5, 9, 13, 17], blue: 2 }, SSQ)
  assert.deepEqual(j.grades, { 4: 6, 5: 16, 6: 6 })
  assert.equal(j.money, 6 * 200 + 16 * 10 + 6 * 5)   // 1,390
  assert.equal(j.floating, false)
  assert.equal(gradeSummaryText('ssq', j), '四等奖×6、五等奖×16、六等奖×6')
})

test('DLT 一等（前5后2）：一等×1 四等×10 六等×10；一等浮动按 0 计', () => {
  const j = judge('dlt', { front: [1, 6, 10, 15, 32, 7, 14], back: [3, 4] }, DLT)
  assert.deepEqual(j.grades, { 1: 1, 4: 10, 6: 10 })
  assert.equal(j.bets, 21)
  assert.equal(j.money, 10 * 3000 + 10 * 200)   // 32,000
  assert.equal(j.floating, true)
})

test('DLT 二等（前5后1）：二等×1 五等×10 八等×10 = 3,150（二等浮动）', () => {
  const j = judge('dlt', { front: [1, 6, 10, 15, 32, 7, 14], back: [3, 9] }, DLT)
  assert.deepEqual(j.grades, { 2: 1, 5: 10, 8: 10 })
  assert.equal(j.money, 10 * 300 + 10 * 15)
  assert.equal(j.floating, true)
})

test('DLT 二等给了官方金额 → 计入', () => {
  const j = judge('dlt', { front: [1, 6, 10, 15, 32, 7, 14], back: [3, 9] }, DLT, { 2: 250_000 })
  assert.equal(j.floating, false)
  assert.equal(j.money, 250_000 + 3_150)
})

test('DLT 三等（前5后0）：三等×1 七等×10 九等×10 = 11,050（全固定）', () => {
  const j = judge('dlt', { front: [1, 6, 10, 15, 32, 7, 14], back: [8, 9] }, DLT)
  assert.deepEqual(j.grades, { 3: 1, 7: 10, 9: 10 })
  assert.equal(j.money, 10_000 + 10 * 100 + 10 * 5)
  assert.equal(j.floating, false)
})

test('P3：直选中 1040，错一位未中 0', () => {
  assert.equal(judge('p3', { digits: [6, 4, 7] }, P3).money, 1040)
  const miss = judge('p3', { digits: [6, 4, 8] }, P3)
  assert.equal(miss.money, 0)
  assert.deepEqual(miss.grades, {})
  assert.equal(gradeSummaryText('p3', miss), '未中奖')
})

test('全奖级覆盖清单：SSQ 一~六等、DLT 一~九等逐级至少一例（汇总断言）', () => {
  const seen = new Set()
  for (const picks of [
    { red: [2, 7, 20, 24, 26, 30, 31, 33], blue: 2 },   // 一三四
    { red: [2, 7, 20, 24, 26, 30, 31, 33], blue: 3 },   // 二四五
    { red: [2, 7, 20, 24, 5, 9, 13, 17], blue: 2 },     // 四五六
  ]) for (const g of Object.keys(judge('ssq', picks, SSQ).grades)) seen.add(`ssq-${g}`)
  for (const back of [[3, 4], [3, 9], [8, 9]]) {
    for (const g of Object.keys(judge('dlt', { front: [1, 6, 10, 15, 32, 7, 14], back }, DLT).grades)) seen.add(`dlt-${g}`)
  }
  for (let g = 1; g <= 6; g++) assert.ok(seen.has(`ssq-${g}`), `SSQ ${g} 等未覆盖`)
  for (let g = 1; g <= 9; g++) assert.ok(seen.has(`dlt-${g}`), `DLT ${g} 等未覆盖`)
})
