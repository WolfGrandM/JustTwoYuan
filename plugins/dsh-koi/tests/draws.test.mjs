/**
 * dsh-koi 纯逻辑层测试 —— node --test tests/
 * 重点钉死：开奖日历、复式拆注注数、官方奖级判定的手算样例、兜底号合规、期号跨年。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  GAMES, gamesForDate, stakesOf, comb, validatePicks, randomPicks, picksLine,
  enumerateBets, judge, gradeSummaryText, nextIssue,
  emptyLedger, appendLedgerEntry, ledgerTotals, ledgerTotalsText,
} from '../lib/draws.js'

test('开奖日历：2026-10-23（周五）只开排列三', () => {
  assert.deepEqual(gamesForDate('2026-10-23'), ['p3'])
})
test('开奖日历：周六=大乐透+排列三，周日=双色球+排列三', () => {
  assert.deepEqual(gamesForDate('2026-10-24'), ['dlt', 'p3'])
  assert.deepEqual(gamesForDate('2026-10-25'), ['ssq', 'p3'])
})
test('开奖日历：周一=大乐透，周二=双色球', () => {
  assert.deepEqual(gamesForDate('2026-10-26'), ['dlt', 'p3'])
  assert.deepEqual(gamesForDate('2026-10-27'), ['ssq', 'p3'])
})
test('开奖日历：非法日期不炸', () => {
  assert.deepEqual(gamesForDate('not-a-date'), [])
})

test('复式注数与投注额：红8+蓝1=28注56元；前7+后2=21注42元；排列三直选2元', () => {
  assert.equal(comb(8, 6), 28)
  assert.deepEqual(stakesOf('ssq'), { bets: 28, cost: 56, spec: '红8+蓝1 复式' })
  assert.deepEqual(stakesOf('dlt'), { bets: 21, cost: 42, spec: '前7+后2 复式' })
  assert.deepEqual(stakesOf('p3'), { bets: 1, cost: 2, spec: '直选一注' })
})

test('校验：双色球合法号通过并排序', () => {
  const v = validatePicks('ssq', { red: [33, 1, 7, 15, 22, 8, 29, 3], blue: 16 })
  assert.equal(v.ok, true)
  assert.deepEqual(v.picks.red, [1, 3, 7, 8, 15, 22, 29, 33])
})
test('校验：双色球各种坏号都拦下', () => {
  assert.equal(validatePicks('ssq', { red: [1, 1, 2, 3, 4, 5, 6, 7], blue: 9 }).ok, false)  // 重复
  assert.equal(validatePicks('ssq', { red: [1, 2, 3, 4, 5, 6, 7, 34], blue: 9 }).ok, false) // 越界
  assert.equal(validatePicks('ssq', { red: [1, 2, 3, 4, 5, 6, 7], blue: 9 }).ok, false)     // 少一个
  assert.equal(validatePicks('ssq', { red: [1, 2, 3, 4, 5, 6, 7, 8], blue: 17 }).ok, false) // 蓝越界
  assert.equal(validatePicks('ssq', { red: 'bad', blue: 9 }).ok, false)
})
test('校验：大乐透 7+2 与排列三三位', () => {
  assert.equal(validatePicks('dlt', { front: [1, 5, 9, 20, 28, 33, 35], back: [1, 12] }).ok, true)
  assert.equal(validatePicks('dlt', { front: [1, 5, 9, 20, 28, 33], back: [1, 12] }).ok, false)   // 前6
  assert.equal(validatePicks('dlt', { front: [1, 5, 9, 20, 28, 33, 36], back: [1, 12] }).ok, false)
  assert.equal(validatePicks('dlt', { front: [1, 5, 9, 20, 28, 33, 35], back: [1] }).ok, false)   // 后1
  assert.equal(validatePicks('p3', { digits: [6, 4, 7] }).ok, true)
  assert.equal(validatePicks('p3', { digits: [6, 4] }).ok, false)
  assert.equal(validatePicks('p3', { digits: [6, 4, 10] }).ok, false)
})

test('兜底随机号：200 轮全部合规', () => {
  for (let i = 0; i < 200; i++) {
    for (const k of Object.keys(GAMES)) {
      const v = validatePicks(k, randomPicks(k))
      assert.equal(v.ok, true, `${k} 兜底号不合规：${JSON.stringify(v)}`)
    }
  }
})

test('picksLine 三种可读格式', () => {
  assert.equal(picksLine('ssq', { red: [1, 12], blue: 9 }).includes('蓝 09'), true)
  assert.equal(picksLine('dlt', { front: [1], back: [2, 12] }).includes('后 02 12'), true)
  assert.equal(picksLine('p3', { digits: [6, 4, 7] }), '直选 6-4-7')
})

test('拆注：双色球 28 注、大乐透 21 注、排列三 1 注', () => {
  assert.equal(enumerateBets('ssq', { red: [1, 2, 3, 4, 5, 6, 7, 8], blue: 9 }).length, 28)
  assert.equal(enumerateBets('dlt', { front: [1, 2, 3, 4, 5, 6, 7], back: [3, 4] }).length, 21)
  assert.equal(enumerateBets('p3', { digits: [6, 4, 7] }).length, 1)
})

test('奖级判定·双色球：红5+蓝中 → 三等×3 四等×15 五等×10，共 12100 元', () => {
  // 池 [1..8] 蓝 9；开奖红 [1,2,3,4,5,16] 蓝 9
  const j = judge('ssq', { red: [1, 2, 3, 4, 5, 6, 7, 8], blue: 9 },
    { red: [1, 2, 3, 4, 5, 16], blue: 9 }, { 3: 3000 })
  assert.deepEqual(j.grades, { 3: 3, 4: 15, 5: 10 })
  assert.equal(j.money, 3 * 3000 + 15 * 200 + 10 * 10)
  assert.equal(j.floating, false)
})
test('奖级判定·双色球：蓝不中 → 四等×3 五等×15 = 750 元', () => {
  const j = judge('ssq', { red: [1, 2, 3, 4, 5, 6, 7, 8], blue: 9 },
    { red: [1, 2, 3, 4, 5, 16], blue: 10 })
  assert.deepEqual(j.grades, { 4: 3, 5: 15 })
  assert.equal(j.money, 3 * 200 + 15 * 10)
})
test('奖级判定·双色球：只中蓝 → 六等×28 = 140 元', () => {
  const j = judge('ssq', { red: [1, 2, 3, 4, 5, 6, 7, 8], blue: 9 },
    { red: [10, 11, 12, 13, 14, 15], blue: 9 })
  assert.deepEqual(j.grades, { 6: 28 })
  assert.equal(j.money, 140)
})
test('奖级判定·双色球：6红全中+蓝中 → 一等×1（浮动）三等×12 四等×15', () => {
  // 池 8 个号：C(6,6)=1 注全中；C(6,5)×C(2,1)=12 注中 5 红；C(6,4)×C(2,2)=15 注中 4 红
  const j = judge('ssq', { red: [1, 2, 3, 4, 5, 6, 7, 8], blue: 9 },
    { red: [1, 2, 3, 4, 5, 6], blue: 9 })
  assert.deepEqual(j.grades, { 1: 1, 3: 12, 4: 15 })
  assert.equal(j.floating, true)   // 一等奖没有给 gradeMoney → 标浮动
  assert.equal(j.money, 12 * 3000 + 15 * 200)
})
test('奖级判定·双色球：浮动奖给了金额就计入', () => {
  const j = judge('ssq', { red: [1, 2, 3, 4, 5, 6, 7, 8], blue: 9 },
    { red: [1, 2, 3, 4, 5, 6], blue: 9 }, { 1: 8000000, 2: 300000 })
  assert.equal(j.floating, false)
  assert.equal(j.money, 8000000 + 12 * 3000 + 15 * 200)
})
test('奖级判定·大乐透：前5+后1 → 二等×1（浮动）五等×10 八等×10 = 3150 元', () => {
  const j = judge('dlt', { front: [1, 2, 3, 4, 5, 6, 7], back: [3, 4] },
    { front: [1, 2, 3, 4, 5, 20], back: [3, 9] })
  assert.deepEqual(j.grades, { 2: 1, 5: 10, 8: 10 })
  assert.equal(j.money, 10 * 300 + 10 * 15)
  assert.equal(j.floating, true)
})
test('奖级判定·大乐透：浮动奖给了金额就计入', () => {
  const j = judge('dlt', { front: [1, 2, 3, 4, 5, 6, 7], back: [3, 4] },
    { front: [1, 2, 3, 4, 5, 20], back: [3, 9] }, { 2: 100000 })
  assert.equal(j.floating, false)
  assert.equal(j.money, 100000 + 10 * 300 + 10 * 15)
})
test('奖级判定·排列三：直选中 1040，不中 0', () => {
  assert.equal(judge('p3', { digits: [6, 4, 7] }, { digits: [6, 4, 7] }).money, 1040)
  assert.equal(judge('p3', { digits: [6, 4, 7] }, { digits: [6, 4, 8] }).money, 0)
})
test('奖级中文摘要', () => {
  const j = judge('ssq', { red: [1, 2, 3, 4, 5, 6, 7, 8], blue: 9 }, { red: [1, 2, 3, 4, 5, 16], blue: 9 })
  assert.equal(gradeSummaryText('ssq', j), '三等奖×3、四等奖×15、五等奖×10')
  const j0 = judge('p3', { digits: [1, 2, 3] }, { digits: [4, 5, 6] })
  assert.equal(gradeSummaryText('p3', j0), '未中奖')
})

test('期号顺延与跨年（福彩四位年 / 体彩两位年）', () => {
  assert.equal(nextIssue('2026121', '2026-10-22', '2026-10-25'), '2026122')
  assert.equal(nextIssue('26120', '2026-10-21', '2026-10-24'), '26121')
  assert.equal(nextIssue('2026153', '2026-12-30', '2027-01-02'), '2027001')
  assert.equal(nextIssue('26152', '2026-12-31', '2027-01-01'), '27001')
})

test('模拟账本：累计投入/中奖/净额，加餐不计', () => {
  let l = emptyLedger()
  l = appendLedgerEntry(l, { kind: 'daily', game: 'ssq', issue: '2026121', date: '2026-10-22', cost: 56, prize: 0 })
  l = appendLedgerEntry(l, { kind: 'daily', game: 'p3', issue: '26282', date: '2026-10-23', cost: 2, prize: 1040 })
  l = appendLedgerEntry(l, { kind: 'quickpick', game: 'p3', issue: '26282', date: '2026-10-23', cost: 2, prize: 0 })
  const t = ledgerTotals(l)
  assert.equal(t.cost, 58)
  assert.equal(t.prize, 1040)
  assert.equal(t.net, 982)
  assert.equal(t.draws, 2)
  assert.equal(t.best.issue, '26282')
  assert.ok(ledgerTotalsText(t).includes('投入 58'))
})
