/**
 * M4 T2 周报测试（docs/28 §3.1/§3.4，AC-010/AC-029）——
 * 周日 22:40 生成四节齐全 + 诚实句 + BC-006 账本口径断言 + period 幂等 + 23:30 放弃线 +
 * 次日 04:00 补生成 + mind 闸/holiday/作业锁守卫（AC-034 review 侧跳过语义）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createReviewStore } from '../lib/review/store.js'
import { createWeeklyReview, weekInfoOf } from '../lib/review/weekly.js'
import { periodLedgerSlice } from '../lib/review/period.js'
import { createJobLock } from '../lib/joblock.js'
import { readJson, writeJsonAtomic } from '../lib/io.js'

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'koi-review-weekly-'))

/** 周日 2026-11-22 = ISO 2026-W47（11-16 ~ 11-22，与 2026-11-17 实历核对） */
const SUNDAY = '2026-11-22'
const NEXT_MONDAY = '2026-11-23'

function mkFixture({ preds = [], ledger = [], cfg = {}, narratorBehavior = 'ok' } = {}) {
  const dir = tmpdir()
  const PRED_FILE = path.join(dir, 'predictions.json')
  const LEDGER_FILE = path.join(dir, 'ledger.json')
  writeJsonAtomic(PRED_FILE, { schemaVersion: 1, entries: preds })
  writeJsonAtomic(LEDGER_FILE, { schemaVersion: 1, entries: ledger })
  const calls = { narrate: [], emit: [] }
  const narrator = {
    narrate: async ({ section, data }) => {
      calls.narrate.push({ section, data })
      if (narratorBehavior === 'throw') throw new Error('narrator boom')
      if (narratorBehavior === 'degraded') return { ok: true, text: `【${section} · 代码口径汇总】{}`, source: 'code-only', reason: '测试降级' }
      return { ok: true, text: `${section} 叙述：一切数字如代码所示。`, source: 'llm' }
    },
  }
  const store = createReviewStore({ dataDir: dir })
  let t = new Date('2026-11-22T22:45:00')
  const weekly = createWeeklyReview({
    store,
    readLedger: () => readJson(LEDGER_FILE, { entries: [] }),
    readPreds: () => readJson(PRED_FILE, { entries: [] }),
    narrator,
    emit: async (partial) => { calls.emit.push(partial); return { id: `evt-${calls.emit.length}`, status: 'failed', panelOnly: true } },
    now: () => t,
    readCfg: () => ({ mind: { enabled: true }, holidays: [], effort: { tier: 'standard' }, ...cfg }),
    lock: createJobLock({ file: path.join(dir, 'job-lock.json') }),
    reportsDir: path.join(dir, 'review', 'reports'),
  })
  return { dir, store, weekly, calls, PRED_FILE, LEDGER_FILE, setNow: (d) => { t = d } }
}

const PRED_SSQ = {
  at: '2026-11-19T09:50:00.000Z', kind: 'daily', game: 'ssq', issue: '2026123', date: '2026-11-19',
  picks: { red: [2, 7, 20, 24, 26, 30], blue: 2 }, via: 'ai', bets: 28, cost: 56, spec: '红8+蓝1 复式',
  tier: 'double', effortTier: 'standard', configStamp: 'cs-1', baselinePicks: { red: [1, 2, 3, 4, 5, 6], blue: 7 },
  settled: true, settleState: 'settled', result: { red: [2, 7, 20, 24, 26, 30], blue: 2 }, prize: 10, grades: { 5: 1 },
  baselinePrize: 5, baselineGrades: { 6: 1 }, pushedResult: true,
}
const LEDGER_SSQ = { at: '2026-11-19T14:30:00.000Z', kind: 'daily', game: 'ssq', issue: '2026123', date: '2026-11-19', cost: 56, prize: 10, bets: 28, grades: { 5: 1 }, entryType: 'main' }
const PRED_DLT_FALLBACK = {
  at: '2026-11-18T09:50:00.000Z', kind: 'daily', game: 'dlt', issue: '26122', date: '2026-11-18',
  picks: { front: [1, 6, 10, 15, 32, 9, 11], back: [3, 4] }, via: 'fallback', bets: 21, cost: 42, spec: '前7+后2 复式',
  tier: 'double', effortTier: 'economy', configStamp: 'cs-1', baselinePicks: { front: [1, 2, 3, 4, 5, 6, 7], back: [1, 2] },
  settled: true, settleState: 'settled', result: { front: [1, 6, 10, 15, 32], back: [3, 4] }, prize: 0, grades: {},
  baselinePrize: 0, baselineGrades: {}, pushedResult: true,
}
const LEDGER_DLT = { at: '2026-11-18T14:30:00.000Z', kind: 'daily', game: 'dlt', issue: '26122', date: '2026-11-18', cost: 42, prize: 0, bets: 21, grades: {}, entryType: 'main' }
const PRED_P3_GIVENUP = {
  at: '2026-11-17T09:50:00.000Z', kind: 'daily', game: 'p3', issue: '26295', date: '2026-11-17',
  picks: { digits: [6, 4, 7] }, via: 'ai', bets: 1, cost: 2, spec: '直选一注', tier: 'p3-x1', effortTier: 'standard',
  configStamp: 'cs-1', baselinePicks: { digits: [1, 2, 3] }, settled: true, settleState: 'given-up', prize: null, grades: null,
}
const LEDGER_P3_PENDING = { at: '2026-11-17T15:40:00.000Z', kind: 'daily', game: 'p3', issue: '26295', date: '2026-11-17', cost: 2, prize: null, bets: 1, grades: null, entryType: 'main', pending: true, note: '放弃待补' }
const LEDGER_QP = { at: '2026-11-20T10:00:00.000Z', kind: 'quickpick', game: 'p3', issue: '26296', date: '2026-11-20', cost: 2, prize: 0, bets: 1, grades: {} }

test('T2 周日 22:40 fixture 生成周报：四节齐全 + 诚实句头 + BC-006 账本口径与独立切片一致 + panelOnly 事件（AC-010）', async () => {
  const fx = mkFixture({ preds: [PRED_SSQ, PRED_DLT_FALLBACK, PRED_P3_GIVENUP], ledger: [LEDGER_SSQ, LEDGER_DLT, LEDGER_P3_PENDING, LEDGER_QP] })
  const r = await fx.weekly.maybeRunWeekly({ today: SUNDAY, nowHHMM: '22:40' })
  assert.equal(r.ok, true, `生成成功：${JSON.stringify(r).slice(0, 200)}`)
  assert.equal(r.period, '2026-W47')
  // 四节标题齐全（§3.4 逐节规格——实施者不得自行发明目录）
  for (const sec of ['【节 1 · 战绩对照】', '【节 2 · 纪律自评', '【节 3 · 健康节】', '【节 4 · 下周计划】']) {
    assert.ok(r.content.includes(sec), `缺节：${sec}`)
  }
  assert.ok(r.content.includes('命中率只作与随机基线对照的观测值'), 'BC-001 诚实句头恒拼')
  // BC-006：报告账本行 = periodLedgerSlice 独立复算（含 quickpick 排除、given-up pending 口径）
  const entries = readJson(fx.LEDGER_FILE, { entries: [] }).entries
  const slice = periodLedgerSlice(entries, '2026-11-16', '2026-11-22')
  assert.equal(slice.cost, 100)          // 56+42+2（quickpick 2 元不入账）
  assert.equal(slice.prize, 10)          // pending prize null 不计
  assert.ok(r.content.includes(`投入 ${slice.cost} 元 · 中 ${slice.prize} 元`))
  // 落盘三载体：review.db 行 + reports 目录文件 + review 事件（panelOnly=true，TF-6）
  const row = fx.store.getReport('weekly', '2026-W47')
  assert.ok(row && row.content === r.content)
  assert.ok(fs.existsSync(path.join(fx.dir, 'review', 'reports', 'weekly-2026-W47.md')))
  assert.equal(fx.calls.emit.length, 1)
  assert.equal(fx.calls.emit[0].kind, 'review')
  assert.equal(fx.calls.emit[0].panelOnly, true)
  assert.equal(fx.calls.emit[0].fullRef, 'review|weekly|2026-W47')
  // 叙述：节 1 + 节 3 各一次
  assert.deepEqual(fx.calls.narrate.map((n) => n.section), ['战绩对照', '健康节'])
})

test('T2 period 幂等：同周二次生成 → skipped=duplicate，不重发事件、不覆盖首份（AC-029）', async () => {
  const fx = mkFixture({ preds: [PRED_SSQ], ledger: [LEDGER_SSQ] })
  const r1 = await fx.weekly.maybeRunWeekly({ today: SUNDAY, nowHHMM: '22:40' })
  assert.equal(r1.ok, true)
  const r2 = await fx.weekly.maybeRunWeekly({ today: SUNDAY, nowHHMM: '22:42' })
  assert.equal(r2.ok, false)
  assert.equal(r2.skipped, 'duplicate')
  assert.equal(fx.calls.emit.length, 1, '不重发（TF-6 面板不重复冒泡）')
  assert.equal(fx.store.listReports('weekly').length, 1)
})

test('T2 守卫链：非周日 / 周日未到 22:40 / 23:30 放弃线后停 / mind 关 / holiday（22:40 安全距离行为断言）', async () => {
  const fx = mkFixture()
  // 周六 22:40 → window（窗口 B 不补当周——周未结束）
  let r = await fx.weekly.maybeRunWeekly({ today: '2026-11-21', nowHHMM: '22:40' })
  assert.equal(r.skipped, 'window')
  // 周日 22:00 → window
  r = await fx.weekly.maybeRunWeekly({ today: SUNDAY, nowHHMM: '22:00' })
  assert.equal(r.skipped, 'window')
  // 周日 23:31 → retry-giveup（重试至 23:30 停）
  r = await fx.weekly.maybeRunWeekly({ today: SUNDAY, nowHHMM: '23:31' })
  assert.equal(r.skipped, 'retry-giveup')
  assert.ok(r.detail.includes('23:30'))
  // mind 关 → mind-disabled（双向闸）
  const fx2 = mkFixture({ cfg: { mind: { enabled: false } } })
  r = await fx2.weekly.maybeRunWeekly({ today: SUNDAY, nowHHMM: '22:40' })
  assert.equal(r.skipped, 'mind-disabled')
  assert.equal(fx2.calls.emit.length, 0)
  // holiday → holiday
  const fx3 = mkFixture({ cfg: { holidays: [SUNDAY] } })
  r = await fx3.weekly.maybeRunWeekly({ today: SUNDAY, nowHHMM: '22:40' })
  assert.equal(r.skipped, 'holiday')
})

test('T2 次日 04:00 补生成：周一 04:05 补上周缺失周报；周日白天不补当周（§3.1-4 重试边界）', async () => {
  const fx = mkFixture({ preds: [PRED_SSQ], ledger: [LEDGER_SSQ] })
  // 周日 04:05 → 不补（当周未结束）
  let r = await fx.weekly.maybeRunWeekly({ today: SUNDAY, nowHHMM: '04:05' })
  assert.equal(r.skipped, 'window')
  assert.equal(fx.store.listReports('weekly').length, 0)
  // 周一 04:05 → 补上周 W47
  r = await fx.weekly.maybeRunWeekly({ today: NEXT_MONDAY, nowHHMM: '04:05' })
  assert.equal(r.ok, true)
  assert.equal(r.period, '2026-W47')
  assert.ok(r.content.includes('周报 2026-W47（2026-11-16 ~ 2026-11-22）'))
  // 已补过 → 不重复
  const r2 = await fx.weekly.maybeRunWeekly({ today: NEXT_MONDAY, nowHHMM: '05:00' })
  assert.equal(r2.skipped, 'window', '已生成的周不再补（ended 周报告缺才补）')
})

test('T2 生成失败重试：失败后 5 分钟节流；窗口内恢复后补跑成功（AC-029 不漏发）', async () => {
  const fx = mkFixture({ preds: [PRED_SSQ], ledger: [LEDGER_SSQ] })
  // 让 emit 抛错模拟生成失败
  fx.calls.emit.push = () => { throw new Error('emit boom') }
  const r1 = await fx.weekly.maybeRunWeekly({ today: SUNDAY, nowHHMM: '22:45' })
  assert.equal(r1.ok, false)
  assert.ok(r1.error.includes('emit boom'))
  const r2 = await fx.weekly.maybeRunWeekly({ today: SUNDAY, nowHHMM: '22:46' })
  assert.equal(r2.skipped, 'throttled', '失败后 5 分钟内节流')
  // 6 分钟后恢复（仍在 23:30 窗口内）→ 补跑成功
  fx.setNow(new Date('2026-11-22T22:52:00'))
  delete fx.calls.emit.push   // 恢复正常 emit
  const r3 = await fx.weekly.maybeRunWeekly({ today: SUNDAY, nowHHMM: '22:52' })
  assert.equal(r3.ok, true, '窗口内恢复后补跑')
  assert.equal(fx.store.getReport('weekly', '2026-W47') != null, true)
})

test('T2 作业锁冲突：backtest 持锁时 review 跳过本轮（不产事件不写报告），释放后下轮补跑（AC-034 §3.3）', async () => {
  const dir = tmpdir()
  const lock = createJobLock({ file: path.join(dir, 'job-lock.json') })
  const store = createReviewStore({ dataDir: dir })
  const calls = { emit: [] }
  const weekly = createWeeklyReview({
    store,
    readLedger: () => ({ entries: [] }),
    readPreds: () => ({ entries: [] }),
    emit: async (p) => { calls.emit.push(p); return { id: 'e1' } },
    readCfg: () => ({ mind: { enabled: true }, holidays: [] }),
    lock,
    reportsDir: path.join(dir, 'review', 'reports'),
  })
  const held = lock.acquire('backtest', 'builtin-ssq')
  assert.equal(held.ok, true)
  const r = await weekly.maybeRunWeekly({ today: SUNDAY, nowHHMM: '22:40' })
  assert.equal(r.skipped, 'lock', '锁被占 → 本轮跳过')
  assert.equal(r.held.kind, 'backtest')
  assert.equal(calls.emit.length, 0, '不产事件')
  assert.equal(store.listReports('weekly').length, 0, '不写报告')
  lock.release()
  const r2 = await weekly.maybeRunWeekly({ today: SUNDAY, nowHHMM: '22:45' })
  assert.equal(r2.ok, true, '下轮补跑')
  assert.equal(store.listReports('weekly').length, 1)
})

test('T2 闸关时 generateNow 仍可跑（B-21 CLI 手动命令不受限）；叙述降级 code-only 照发并标注原因', async () => {
  // mind 关（可能 CLI 场景无 mind 配置）→ generateNow 直跑
  const fx = mkFixture({ preds: [PRED_SSQ], ledger: [LEDGER_SSQ], cfg: { mind: { enabled: false } }, narratorBehavior: 'degraded' })
  const r = await fx.weekly.generateNow({ period: '2026-W47' })
  assert.equal(r.ok, true, 'CLI 手动路径不受 mind 闸限制（B-21）')
  assert.ok(r.content.includes('（LLM 叙述缺席：测试降级）'), 'code-only 降级标注不静默')
  assert.ok(r.content.includes('【节 1 · 战绩对照】'))
})
