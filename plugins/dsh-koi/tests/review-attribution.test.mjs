/**
 * M4 T1 归因引擎测试（docs/28 §6 归因金样本，AC-009）——
 * 金样本手算一致 + 防前视切片契约 + 幻觉因子白名单闸 + 归因入档回放。
 *
 * ⚠诚实更正（BC-001）：docs/28 §6 原文记「GOLDEN_SSQ 实际奇数个数=4」——按 fixture 手算
 * （GOLDEN_SSQ red=[2,7,20,24,26,30]，oddCountOf 只计红球，factors.js:23）：仅 7 为奇数 →
 * 实际奇数个数 = 1，非 4。本测试以手算事实为准：构造历史众数 = 2 时断言 {hit:false,
 * detail:'奇数个数=1'}；构造众数 = 1 时断言 hit:true。断言与手算逐位一致。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { computeForIssue, whitelistFactorIds, attachAttribution } from '../lib/review/attribution.js'
import { buildBuiltinFactors } from '../lib/factors.js'
import { GOLDEN_SSQ } from '../lib/golden-fixtures.js'
import { createReviewStore } from '../lib/review/store.js'

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'koi-review-attr-'))
const allFactors = buildBuiltinFactors()
const paritySsq = allFactors.find((f) => f.id === 'builtin-parity-ratio-ssq')

/** 构造 n 期 ssq 历史（每期 red 恰 kOdd 个奇数），期号 2026001 递增 */
function histSsq(n, kOdd) {
  const even = [2, 4, 6, 8, 10, 12].slice(0, 6 - kOdd)          // 偶数位
  const odd = [1, 3, 5, 7, 9].slice(0, kOdd)                    // 奇数位
  const red = [...even, ...odd].sort((a, b) => a - b)
  return Array.from({ length: n }, (_, i) => ({
    issue: `2026${String(i + 1).padStart(3, '0')}`,
    date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
    red,
    blue: 1,
  }))
}

test('T1 金样本：129 期历史（众数=2）→ claim 奇数个数=2，GOLDEN_SSQ 实际=1 → {hit:false, detail:奇数个数=1}', () => {
  const asc = histSsq(129, 2)
  const opinion = paritySsq.predict(asc)   // 防前视契约：asc = 截至上一期（含）
  assert.ok(opinion, '众数判定确定（129 期同构，tail 100 期全为 2 奇）')
  assert.match(opinion.claim, /奇数个数 = 2/)
  // 手算：GOLDEN_SSQ red=[2,7,20,24,26,30] → 奇数仅 {7} → 个数=1
  const goldenOdd = GOLDEN_SSQ.red.filter((x) => x % 2 === 1).length
  assert.equal(goldenOdd, 1)
  const { items, unknownFactorIds } = computeForIssue({ game: 'ssq', asc, draw: GOLDEN_SSQ, factors: [paritySsq] })
  assert.equal(unknownFactorIds.length, 0)
  assert.deepEqual(items, [{ factorId: 'builtin-parity-ratio-ssq', hit: false, detail: '奇数个数=1' }])
})

test('T1 金样本反向：129 期历史（众数=1）→ GOLDEN_SSQ 实际=1 → hit:true', () => {
  const asc = histSsq(129, 1)
  const opinion = paritySsq.predict(asc)
  assert.match(opinion.claim, /奇数个数 = 1/)
  const { items } = computeForIssue({ game: 'ssq', asc, draw: GOLDEN_SSQ, factors: [paritySsq] })
  assert.deepEqual(items, [{ factorId: 'builtin-parity-ratio-ssq', hit: true, detail: '奇数个数=1' }])
})

test('T1 防前视 spy：逐期归因循环中 predict 收到的切片长度恒 t+1 且不含待判期（koi.mjs:687-692 backtest gold 同款）', () => {
  const data = histSsq(30, 2)
  const seen = []
  const spy = {
    id: 'review-spy', source: 'builtin', game: 'ssq', name: 'spy',
    predict(slice) {
      seen.push({ len: slice.length, lastIssue: slice[slice.length - 1]?.issue })
      return { claim: 'x', judge: () => ({ hit: false, detail: '' }) }
    },
  }
  for (let t = 0; t + 1 < data.length; t++) {
    const asc = data.slice(0, t + 1)          // 调用方切片：截至第 t 期（含）——backtest.js:130-138 同款契约
    const draw = data[t + 1]
    computeForIssue({ game: 'ssq', asc, draw, factors: [spy] })
  }
  assert.equal(seen.length, data.length - 1)
  for (let i = 0; i < seen.length; i++) {
    assert.equal(seen[i].len, i + 1, `切片长度恒 t+1（第 ${i} 轮）`)
    assert.notEqual(seen[i].lastIssue, data[i + 1].issue, '切片永不含待判期（防前视）')
  }
})

test('T1 无观点因子如实入档 hit=null；unknownFactorIds 收录点名但不存在的因子；非本彩种跳过不算未知', () => {
  const noOp = { id: 'stub-no-op', source: 'builtin', game: 'ssq', predict: () => null }
  const dltFactor = allFactors.find((f) => f.id === 'builtin-parity-ratio-dlt')
  const asc = histSsq(10, 2)
  const draw = { red: [2, 7, 20, 24, 26, 30], blue: 2 }
  const r = computeForIssue({ game: 'ssq', asc, draw, factors: [paritySsq, noOp, dltFactor], factorIds: ['builtin-parity-ratio-ssq', 'stub-no-op', 'ghost-x', 'builtin-parity-ratio-dlt'] })
  assert.equal(r.unknownFactorIds.length, 1)
  assert.equal(r.unknownFactorIds[0], 'ghost-x')
  assert.deepEqual(r.skipped, ['builtin-parity-ratio-dlt'], '存在但非本彩种 → skipped 不算未知')
  const noOpItem = r.items.find((x) => x.factorId === 'stub-no-op')
  assert.equal(noOpItem.hit, null)
  assert.equal(noOpItem.detail, '本期无观点')
  assert.equal(r.items.find((x) => x.factorId === 'builtin-parity-ratio-ssq').hit, false)
})

test('T1 幻觉因子闸（AC-009）：builtin-ac-value-ssq 不在 registry → whitelistFactorIds 拒用', () => {
  const knownIds = allFactors.map((f) => f.id)   // registry 导出面（backtest.listFactors 同源口径）
  const { allowed, rejected } = whitelistFactorIds(
    ['builtin-parity-ratio-ssq', 'builtin-ac-value-ssq', 'made-up-factor'], knownIds)
  assert.deepEqual(allowed, ['builtin-parity-ratio-ssq'])
  assert.deepEqual(rejected, ['builtin-ac-value-ssq', 'made-up-factor'],
    '叙述输出引用不在库因子 → 整段拒用（T2 narrate 三闸消费，本文件测闸本体）')
})

test('T1 归因回放入档：GOLDEN 全六件 ssq 内置逐期判定 → attribution 表回读逐位一致（含 hit=null）', () => {
  const s = createReviewStore({ dataDir: tmpdir() })
  const ssqFactors = allFactors.filter((f) => f.game === 'ssq')
  const asc = histSsq(129, 2)
  const { id } = s.upsertArchive({
    game: 'ssq', issue: GOLDEN_SSQ.issue, date: GOLDEN_SSQ.date, kind: 'daily',
    at: '2026-10-22T11:50:00.000Z', picks: { red: GOLDEN_SSQ.red, blue: GOLDEN_SSQ.blue },
    via: 'ai', cost: 56, result: { red: GOLDEN_SSQ.red, blue: GOLDEN_SSQ.blue }, prize: 5, grades: { 6: 2 },
  })
  const { items } = computeForIssue({ game: 'ssq', asc, draw: GOLDEN_SSQ, factors: ssqFactors })
  assert.equal(items.length, 6)
  attachAttribution(s, { archiveId: id, items })
  const rows = s.db.prepare(`SELECT factor_id, hit, detail FROM attribution WHERE archive_id=? ORDER BY factor_id`).all(id)
  assert.equal(rows.length, 6)
  const byId = Object.fromEntries(rows.map((r) => [r.factor_id, r]))
  const parity = byId['builtin-parity-ratio-ssq']
  assert.equal(parity.hit, 0, '众数=2 vs 实际=1 → 未中')
  assert.equal(parity.detail, '奇数个数=1')
  // 聚合口径：六件中至少 parity 未中；NULL 不进分母（attributionAgg 与 T2 周报共享口径）
  const agg = s.attributionAgg().find((r) => r.factorId === 'builtin-parity-ratio-ssq')
  assert.equal(agg.judged, 1)
  assert.equal(agg.hits, 0)
})
