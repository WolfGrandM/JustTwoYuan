/**
 * 市场版 T2 —— 投注档位层（FR-1011/DC-106/BC-113）单测。
 * 金样本沿 tests/judge-golden.test.mjs 同一套真实开奖夹具（judge-golden 先例）；
 * r9b2 拆单元聚合 19550 元 = docs/16 §8.2 A2.1 V3b 回归值（独立重推：红池 5 中 + 双蓝一中一不中）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { GAMES, stakesOf } from '../lib/draws.js'
import {
  TIERS, tierById, tiersForGame, defaultTierFor, v1EquivTier,
  tierStakes, specText, unitsOf, judgeTier, validateTierPicks, randomTierPicks, tierTableSelfCheck,
} from '../lib/tiers.js'

const SSQ = { issue: '2026121', date: '2026-10-22', red: [2, 7, 20, 24, 26, 30], blue: 2, prizeGrades: { 3: 3000 } }
const DLT = { issue: '26120', date: '2026-10-21', front: [1, 6, 10, 15, 32], back: [3, 4] }
const P3 = { issue: '26282', date: '2026-10-23', digits: [6, 4, 7] }

test('档表 11 档注数/价格与 §2.2.4-1 表逐档一致（含 2 元单式基础档，主人 2026-10-25 拍板）；档表自检（units×单价=价格）', () => {
  const expect = {
    'p3-x1': [1, 2], 'p3-x3': [3, 6], 'p3-x5': [5, 10],
    'ssq-d6b1': [1, 2], 'ssq-r7b1': [7, 14], 'ssq-r8b1': [28, 56], 'ssq-r9b2': [168, 336],
    'dlt-f5b2': [1, 2], 'dlt-f6b2': [6, 12], 'dlt-f7b2': [21, 42], 'dlt-f8b3': [168, 336],
  }
  assert.equal(Object.keys(TIERS).length, 11)
  for (const [id, [bets, cost]] of Object.entries(expect)) {
    const s = tierStakes(id)
    assert.deepEqual([s.bets, s.cost], [bets, cost], `${id} 应为 ${bets} 注 / ${cost} 元`)
  }
  assert.deepEqual(tierTableSelfCheck(), { ok: true, problems: [] })
})

test('默认档=2 元单式基础档（主人 2026-10-25 拍板：所有彩种默认推荐 2 元档）；v1 等价档=作者迁移值；v1 复式结构与等价档 stakes 逐位一致', () => {
  assert.equal(defaultTierFor('ssq'), 'ssq-d6b1')
  assert.equal(defaultTierFor('dlt'), 'dlt-f5b2')
  assert.equal(defaultTierFor('p3'), 'p3-x1')
  assert.equal(v1EquivTier('ssq'), 'ssq-r8b1')
  assert.equal(v1EquivTier('dlt'), 'dlt-f7b2')
  assert.equal(v1EquivTier('p3'), 'p3-x1')
  assert.equal(tierStakes('ssq-r8b1').cost, stakesOf('ssq').cost)
  assert.equal(tierStakes('dlt-f7b2').cost, stakesOf('dlt').cost)
  assert.equal(tierStakes('p3-x1').cost, stakesOf('p3').cost)
})

test('judge-golden 先例金样本逐档判奖：p3 ×1/×3/×5 与官方规则一致', () => {
  // ×1 直选中
  let j = judgeTier('p3-x1', { digits: [6, 4, 7] }, P3)
  assert.equal(j.money, 1040); assert.equal(j.bets, 1); assert.deepEqual(j.grades, { 1: 1 })
  // ×3：一组中两组不中 → 1040；三组全不中 → 0；重复组被校验拒绝（走 validateTierPicks，不进判奖）
  j = judgeTier('p3-x3', { digits: [[6, 4, 7], [6, 4, 8], [1, 2, 3]] }, P3)
  assert.equal(j.money, 1040); assert.equal(j.bets, 3); assert.deepEqual(j.grades, { 1: 1 })
  j = judgeTier('p3-x5', { digits: [[0, 0, 1], [1, 1, 1], [2, 2, 2], [3, 3, 3], [6, 4, 8]] }, P3)
  assert.equal(j.money, 0); assert.deepEqual(j.grades, {})
})

test('judge-golden 先例金样本逐档判奖：ssq r7b1/r8b1（复用 judge-golden 6红全含样例）', () => {
  // r8b1 与 v1 复式同构：judge 结果与 FZ-1 直判逐位一致（一等×1 三等×12 四等×15）
  const picks8 = { red: [2, 7, 20, 24, 26, 30, 31, 33], blue: 2 }
  const j8 = judgeTier('ssq-r8b1', picks8, SSQ)
  assert.equal(j8.bets, 28)
  assert.deepEqual(j8.grades, { 1: 1, 3: 12, 4: 15 })
  assert.equal(j8.money, 12 * 3000 + 15 * 200)
  assert.equal(j8.floating, true)
  // r7b1：7 红池含 6 开奖红 → C(7,6)=7 注：一等×1 三等×6
  const j7 = judgeTier('ssq-r7b1', { red: [2, 7, 20, 24, 26, 30, 31], blue: 2 }, SSQ)
  assert.equal(j7.bets, 7)
  assert.deepEqual(j7.grades, { 1: 1, 3: 6 })
})

test('r9b2 拆单元聚合 = 19550 元（A2.1 V3b 回归值；红池 5 中 + 蓝一中一不中）', () => {
  // 红池 9 = 5 个开奖红（2,7,20,24,26）+ 4 个非开奖号；蓝 [2(中), 3(不中)]
  const picks = { red: [2, 7, 20, 24, 26, 5, 9, 13, 17], blue: [2, 3] }
  const units = unitsOf('ssq-r9b2', picks)
  assert.equal(units.length, 2, '蓝双选拆 2 单元（红池共享）')
  const j = judgeTier('ssq-r9b2', picks, SSQ)
  assert.equal(j.bets, 168, '2×C(9,6)=168 注')
  assert.equal(j.money, 19550, 'A2.1 V3b 聚合值：单元A(蓝中)18450 + 单元B(蓝不中)1100')
  assert.deepEqual(j.grades, { 3: 4, 4: 34, 5: 70, 6: 10 })
  assert.equal(j.floating, false)
})

test('dlt 长池单单元：f6b2/f7b2/f8b3 判奖（f8b3=168 注，enumerateBets 组合天然展开）', () => {
  // f7b2 与 v1 复式同构（judge-golden DLT 一等样例）
  const j7 = judgeTier('dlt-f7b2', { front: [1, 6, 10, 15, 32, 7, 14], back: [3, 4] }, DLT)
  assert.equal(j7.bets, 21)
  assert.deepEqual(j7.grades, { 1: 1, 4: 10, 6: 10 })
  assert.equal(j7.floating, true)
  // f8b3：前 8 含全部 5 开奖前区 + 后 3 含 2 开奖后区 → C(8,5)×C(3,2)=168 注
  const j8 = judgeTier('dlt-f8b3', { front: [1, 6, 10, 15, 32, 7, 14, 20], back: [3, 4, 9] }, DLT)
  assert.equal(j8.bets, 168)
  // 一等 = 前5全中后2全中：C(5,5)C(3,0)×C(2,2)C(1,0) = 1
  assert.equal(j8.grades[1], 1)
  // f6b2：前 6 池含 5 开奖前区
  const j6 = judgeTier('dlt-f6b2', { front: [1, 6, 10, 15, 32, 7], back: [3, 4] }, DLT)
  assert.equal(j6.bets, 6)
  assert.deepEqual(j6.grades, { 1: 1, 4: 5 })
})

test('validateTierPicks：档位结构感知（个数随档、值域、去重、排序规范化、蓝双选标量/数组双形态）', () => {
  // r7b1 拒绝 8 红（v1 validatePicks 只认 8 红 —— 档位感知的必要性，A2.1 V4）
  assert.equal(validateTierPicks('ssq-r7b1', { red: [2, 7, 20, 24, 26, 30, 31, 33], blue: 2 }).ok, false)
  let v = validateTierPicks('ssq-r7b1', { red: [31, 2, 7, 20, 24, 26, 30], blue: 2 })
  assert.equal(v.ok, true); assert.deepEqual(v.picks.red, [2, 7, 20, 24, 26, 30, 31])
  // r9b2：蓝必须 2 个、不重复、可传标量数组两种形态
  assert.equal(validateTierPicks('ssq-r9b2', { red: [1, 2, 3, 4, 5, 6, 7, 8, 9], blue: [2] }).ok, false)
  assert.equal(validateTierPicks('ssq-r9b2', { red: [1, 2, 3, 4, 5, 6, 7, 8, 9], blue: [2, 2] }).ok, false)
  v = validateTierPicks('ssq-r9b2', { red: [9, 8, 7, 6, 5, 4, 3, 2, 1], blue: [9, 2] })
  assert.equal(v.ok, true); assert.deepEqual(v.picks.blue, [2, 9])
  // dlt f8b3：前 8 后 3
  assert.equal(validateTierPicks('dlt-f8b3', { front: [1, 2, 3, 4, 5, 6, 7], back: [1, 2] }).ok, false)
  v = validateTierPicks('dlt-f8b3', { front: [35, 34, 33, 32, 31, 30, 29, 1], back: [12, 11, 10] })
  assert.equal(v.ok, true); assert.deepEqual(v.picks.front[0], 1); assert.deepEqual(v.picks.back, [10, 11, 12])
  assert.equal(validateTierPicks('dlt-f8b3', { front: [1, 2, 3, 4, 5, 6, 7, 36], back: [1, 2, 3] }).ok, false, '越界拒绝')
  // p3 多注：3 组、重复组拒绝（MD-15）；单注形态 = v1 同构
  assert.equal(validateTierPicks('p3-x3', { digits: [[1, 2, 3], [1, 2, 3], [4, 5, 6]] }).ok, false)
  assert.equal(validateTierPicks('p3-x3', { digits: [[1, 2, 3], [4, 5]] }).ok, false)
  v = validateTierPicks('p3-x1', { digits: [6, 4, 7] })
  assert.equal(v.ok, true); assert.deepEqual(v.picks, { digits: [6, 4, 7] })
  // 坏结构
  assert.equal(validateTierPicks('p3-x1', 'bad').ok, false)
  assert.equal(validateTierPicks('no-such-tier', {}).ok, false)
})

test('randomTierPicks：档位感知随机（形状/个数/值域全过 validateTierPicks；p3 多注不重复）', () => {
  for (const id of Object.keys(TIERS)) {
    const picks = randomTierPicks(id)
    const v = validateTierPicks(id, picks)
    assert.equal(v.ok, true, `${id} 随机号必须自校验合法（得到 ${JSON.stringify(picks)}）`)
    const s = tierStakes(id)
    assert.equal(unitsOf(id, v.picks).length * (id.startsWith('p3-') ? 1 : 1) >= 1, true)
    assert.equal(judgeTier(id, v.picks, id.startsWith('ssq') ? SSQ : id.startsWith('dlt') ? DLT : P3).bets, s.bets, `${id} 随机号判奖注数=档位注数`)
  }
})

test('specText：档位一行可读（含注数/价格；p3 与 v1 直选口径衔接）', () => {
  assert.ok(specText('ssq-r7b1').includes('7 注'))
  assert.ok(specText('ssq-r7b1').includes('14 元'))
  assert.ok(specText('p3-x1').includes('直选一注'))
  assert.ok(specText('p3-x3').includes('×3'))
  assert.ok(specText('dlt-f8b3').includes('168 注'))
  assert.equal(tiersForGame('ssq').length, 4)
  assert.equal(tierById('ssq-r8b1').game, 'ssq')
})
