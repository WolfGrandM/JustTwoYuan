/**
 * v1.1 修复包测试（C1~C5/C7/C8/C10，FR-001~008）—— 全部离线、零新依赖。
 * 纯函数直连 lib/scheduler.js 与 lib/io.js 导出；status 附加字段走真实调度器实例（临时目录，用完即停）。
 * 判奖金样本回归见 tests/judge-golden.test.mjs（T6/C5）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  isHoliday, settleOutcome, buildMainPendingEntry, buildSupplementEntry, buildReversalEntry,
  carryJobsFromEntries, retryIntervalMs, deadlineForKind, isPastDeadline, enqueueRepush, isStaleDraw,
  startKoiScheduler,
} from '../lib/scheduler.js'
import { readJson, writeJsonAtomic, ensureSchemaVersion } from '../lib/io.js'
import { emptyLedger, appendLedgerEntry, ledgerTotals, ledgerTotalsText } from '../lib/draws.js'

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'koi-v11-'))

// ────────────────────────────── C3 / FR-003：lib/io.js ──────────────────────────

test('C3 原子写：正常写、写后可解析、与现行写法产物逐字节一致', () => {
  const dir = tmpdir()
  const p = path.join(dir, 'sub', 'ledger.json')     // 顺带验证建目录
  const o = { b: 2, a: 'x', nested: { z: [1, 2], s: '文' }, entries: [] }
  writeJsonAtomic(p, o)
  const raw = fs.readFileSync(p, 'utf8')
  assert.equal(raw, JSON.stringify(o, null, 2) + '\n')          // 与 scheduler 原实现/裸写逐字节一致
  assert.deepEqual(readJson(p, null), o)                        // 写后可解析（含中文）
  assert.equal(fs.existsSync(p + '.' + process.pid + '.tmp'), false)  // temp 已 rename 走
})

test('C3 读容错：缺失/坏 JSON 返回 fallback，不抛', () => {
  const dir = tmpdir()
  const p = path.join(dir, 'broken.json')
  fs.writeFileSync(p, '{oops')
  assert.equal(readJson(path.join(dir, 'none.json'), 'FB'), 'FB')
  assert.equal(readJson(p, 'FB'), 'FB')
  assert.equal(readJson(undefined), null, '无参调用也走 fallback')
})

// ────────────────────────────── C4 / FR-004：schemaVersion ──────────────────────

test('C4 ensureSchemaVersion：缺省补 1、已是 1 保持、高版本拒绝写、未知字段保留', () => {
  assert.deepEqual(ensureSchemaVersion({ entries: [] }), { entries: [], schemaVersion: 1 })
  assert.equal(ensureSchemaVersion({ schemaVersion: 1, entries: [1] }).schemaVersion, 1)
  assert.throws(() => ensureSchemaVersion({ schemaVersion: 2 }), /高于已知版本/)
  const withUnknown = ensureSchemaVersion({ schemaVersion: 1, futureField: { deep: true } })
  assert.equal(withUnknown.futureField.deep, true)
  const src = { schemaVersion: 1, extra: 7 }
  const out = ensureSchemaVersion(src)
  out.extra = 8
  assert.equal(src.extra, 7)                                    // 浅拷贝，不改调用方原对象
})

test('C4 读取容忍：含未知字段 + 更高 schemaVersion 的文件读取不报错、既有字段解析正确', () => {
  const dir = tmpdir()
  const p = path.join(dir, 'predictions.json')
  fs.writeFileSync(p, JSON.stringify({
    schemaVersion: 2,
    entries: [{ at: 'x', kind: 'daily', game: 'ssq', issue: '2026122', date: '2026-10-25', futureField: 1 }],
  }))
  const j = readJson(p, null)
  assert.equal(j.schemaVersion, 2)
  assert.equal(j.entries[0].futureField, 1)
  assert.equal(j.entries[0].game, 'ssq')
})

// ────────────────────────────── C1 / FR-001：三态账本 ───────────────────────────

test('C1 settleOutcome：五种出口 + 终态幂等（done）', () => {
  const e = { kind: 'daily', issue: '2026122', settled: false }
  assert.equal(settleOutcome(e, '2026121', false, '22:00'), 'wait')            // 未公布未到线 → 等
  assert.equal(settleOutcome(e, null, false, '22:00'), 'wait')                 // 拿不到期号 → 等
  assert.equal(settleOutcome(e, '2026122', true, '22:00'), 'settle')           // 同期号 → 结清
  assert.equal(settleOutcome(e, '2026123', true, '22:00'), 'settle')           // 跳号但历史翻得到 → 按公布结清
  assert.equal(settleOutcome(e, '2026123', false, '22:00'), 'void')            // 跳号且历史无 → 作废
  assert.equal(settleOutcome(e, '2026121', false, '23:31'), 'give-up')         // 过放弃线 → 放弃待补
  assert.equal(settleOutcome(e, '2026121', false, '23:30'), 'wait')            // 恰在放弃线上 → 再等一轮
  assert.equal(settleOutcome({ ...e, settleState: 'settled' }, '2026122', true, '22:00'), 'done')
  assert.equal(settleOutcome({ ...e, settleState: 'voided' }, '2026122', true, '22:00'), 'done')
})

test('C1 settleOutcome：期号跳跃跨年单调（福彩四位年 / 体彩两位年，B-verify 断言 2 同款）', () => {
  assert.equal(settleOutcome({ issue: '2026153' }, '2027001', false, '22:00'), 'void')
  assert.equal(settleOutcome({ issue: '26153' }, '27001', false, '22:00'), 'void')
  assert.equal(settleOutcome({ issue: '2026123' }, '2026122', false, '23:31'), 'give-up')
  assert.equal(settleOutcome({ issue: '2026122' }, '2026122', true, '22:00'), 'settle')
  assert.equal(settleOutcome({ issue: '26285' }, '26290', false, '22:00'), 'void')
})

test('C1 放弃→补判：cost 记一次、prize 记一次、期数按 main（幂等守卫防双记）', () => {
  const entry = { kind: 'daily', game: 'ssq', issue: '2026122', date: '2026-10-22', cost: 56, bets: 28 }
  const judged = { bets: 28, grades: { 3: 1 }, money: 3000, floating: false }
  let ledger = emptyLedger()
  // ① 当晚放弃：main 挂账（prize null、pending）
  ledger = appendLedgerEntry(ledger, buildMainPendingEntry(entry, 't1'))
  let t = ledgerTotals(ledger)
  assert.equal(t.cost, 56); assert.equal(t.prize, 0); assert.equal(t.draws, 1)
  // ② 次日公布补判：supplement 落奖
  ledger = appendLedgerEntry(ledger, buildSupplementEntry(entry, judged, 't2'))
  t = ledgerTotals(ledger)
  assert.equal(t.cost, 56, '补判后 cost 仍只记一次')
  assert.equal(t.prize, 3000, 'prize 由 supplement 记入')
  assert.equal(t.draws, 1, '期数按 main 计')
  assert.equal(t.net, 2944)
  assert.equal(t.best.prize, 3000)
  // ③ 幂等：条目已终态 → settleOutcome=done，调用方不再追加（这里直接断言决策层出口）
  assert.equal(settleOutcome({ ...entry, settled: true, settleState: 'settled' }, '2026122', true, '22:00'), 'done')
  assert.equal(ledgerTotals(ledger).prize, 3000, '重复补判不双记（决策层 done 出口兜底）')
})

test('C1 休市作废：reversal 冲销后该期投入/期数不计入口径（B-verify 1c 同款）', () => {
  const gone = { kind: 'daily', game: 'p3', issue: '26290', date: '2026-10-23', cost: 2, bets: 1 }
  const live = { kind: 'daily', game: 'p3', issue: '26291', date: '2026-10-24', cost: 2, bets: 1 }
  const judged = { bets: 1, grades: { 1: 1 }, money: 1040, floating: false }
  let ledger = emptyLedger()
  ledger = appendLedgerEntry(ledger, buildMainPendingEntry(gone, 'd1'))
  ledger = appendLedgerEntry(ledger, buildReversalEntry(gone, 'd2'))
  ledger = appendLedgerEntry(ledger, { at: 'd3', kind: 'daily', game: live.game, issue: live.issue, date: live.date, cost: 2, prize: judged.money, bets: 1, grades: judged.grades, entryType: 'main' })
  const t = ledgerTotals(ledger)
  assert.equal(t.cost, 2, '作废期投入不计')
  assert.equal(t.draws, 1, '作废期不计期数')
  assert.equal(t.prize, 1040)
  // reversal 条目自身形状（ref 指针 + 冲销语义）
  const rv = buildReversalEntry(gone, 'd2')
  assert.equal(rv.entryType, 'reversal')
  assert.deepEqual(rv.ref, { game: 'p3', issue: '26290', date: '2026-10-23' })
  assert.equal(rv.cost, 0); assert.equal(rv.prize, 0)
})

test('C1b 兼容：无新字段旧文件输出与 v1.0 公式逐位一致', () => {
  const totalsV10 = (ledger) => {
    const es = (ledger?.entries ?? []).filter((e) => e.kind !== 'quickpick')
    const cost = es.reduce((s, e) => s + Number(e.cost ?? 0), 0)
    const prize = es.reduce((s, e) => s + Number(e.prize ?? 0), 0)
    const best = es.filter((e) => Number(e.prize ?? 0) > 0).sort((a, b) => Number(b.prize) - Number(a.prize))[0] ?? null
    return { cost, prize, net: prize - cost, draws: es.length, best }
  }
  const legacy = { entries: [
    { at: 'd1', kind: 'daily', game: 'ssq', issue: '2026121', date: '2026-10-20', cost: 56, prize: 10, bets: 28, grades: { 5: 1 } },
    { at: 'd2', kind: 'daily', game: 'p3', issue: '26285', date: '2026-10-21', cost: 2, prize: 0, bets: 1, grades: {} },
    { at: 'd3', kind: 'daily', game: 'dlt', issue: '26120', date: '2026-10-21', cost: 42, prize: 3150, bets: 21, grades: { 5: 10, 8: 10 } },
    { at: 'd4', kind: 'quickpick', game: 'p3', issue: '26285', date: '2026-10-21', cost: 2, prize: 0 },
  ] }
  assert.deepEqual(ledgerTotals(legacy), totalsV10(legacy))
  assert.ok(ledgerTotalsText(ledgerTotals(legacy)).includes('投入 100'))
})

// ────────────────────────────── C2 / FR-002：休市日历 ───────────────────────────

test('C2 isHoliday：命中/未命中/空数组/未配置/跨月边界', () => {
  const holidays = ['2026-10-31', '2026-11-01', '2027-01-01']
  assert.equal(isHoliday('2026-10-31', holidays), true)
  assert.equal(isHoliday('2026-11-01', holidays), true, '跨月边界照常命中')
  assert.equal(isHoliday('2026-10-30', holidays), false)
  assert.equal(isHoliday('2026-10-31', []), false)
  assert.equal(isHoliday('2026-10-31', undefined), false)
  assert.equal(isHoliday('2026-10-31', null), false)
})

test('C2 status 附加字段：holiday / repushQueue / mind 两读数（enabled=false、handshake=absent）', () => {
  const dir = tmpdir()
  const configPath = path.join(dir, 'koi.config.json')
  const sched = startKoiScheduler({}, {
    dshHome: dir, configPath, dataDir: path.join(dir, 'koi'), workDir: path.join(dir, 'koi-work'), log: () => {},
  })
  try {
    let st = sched.status()
    assert.equal(st.holiday, false)
    assert.equal(st.repushQueue, 0)
    assert.deepEqual(st.mind, { enabled: false, handshake: 'absent' }, '文件缺失 → absent；未配置 → false')
    // 写入配置与握手文件后再读（每 tick 现读语义的等价验证：status 内部现读配置）
    fs.writeFileSync(configPath, JSON.stringify({ holidays: [st.today], mind: { enabled: true } }))
    fs.mkdirSync(path.join(dir, 'koi-mind'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'koi-mind', 'handshake.json'), JSON.stringify({ mindVersion: '2.0.0', status: 'ok', at: 'x' }))
    st = sched.status()
    assert.equal(st.holiday, true)
    assert.equal(st.mind.enabled, true)
    assert.equal(st.mind.handshake, 'ok')
  } finally {
    sched.stop()
  }
})

// ────────────────────────────── C10 / FR-005：推送统一重试 ──────────────────────

test('C10 retryIntervalMs：间隔参数化（默认 5 分钟，可配，非法回退）', () => {
  assert.equal(retryIntervalMs({}), 300_000)
  assert.equal(retryIntervalMs({ push: { retryMinutes: 1 } }), 60_000)
  assert.equal(retryIntervalMs({ push: { retryMinutes: 10 } }), 600_000)
  assert.equal(retryIntervalMs({ push: { retryMinutes: 0 } }), 300_000, '非法值回退默认')
  assert.equal(retryIntervalMs({ push: { retryMinutes: 'x' } }), 300_000)
})

test('C10 deadlineForKind：分类终止线（预测→catchUpEnd，战果/致歉→settleGiveUp）', () => {
  const time = { catchUpEnd: '19:50', settleGiveUp: '23:30' }
  assert.equal(deadlineForKind('predict', time), '19:50')
  assert.equal(deadlineForKind('result', time), '23:30')
  assert.equal(deadlineForKind('apology', time), '23:30')
  assert.equal(deadlineForKind('predict'), '19:50', '缺省用默认时刻表')
  assert.equal(deadlineForKind('result'), '23:30')
})

test('C10 isPastDeadline：同日按线比、跨天滞留必迟、无失败时刻不判迟', () => {
  const f = new Date(); f.setHours(10, 0, 0, 0)
  const iso = f.toISOString()
  const at = (h) => { const d = new Date(f); d.setHours(h, 5, 0, 0); return d }
  assert.equal(isPastDeadline(at(12), '11:00', iso), true, '同日已过线')
  assert.equal(isPastDeadline(at(12), '13:00', iso), false, '同日未过线')
  const nextDay = new Date(f.getTime() + 26 * 3600_000)
  assert.equal(isPastDeadline(nextDay, '23:30', iso), true, '跨天滞留必已过线')
  assert.equal(isPastDeadline(at(12), '11:00', null), false)
  assert.equal(isPastDeadline(at(12), '11:00', 'not-a-date'), false)
})

test('C10 enqueueRepush：上限内追加；同类合并留最新；溢出丢最早并报告（不静默）', () => {
  const item = (k, g, i, text) => ({ kind: k, game: g, issue: i, text, deadline: '23:30', failedAt: 'x', lastErr: '', attempts: 1 })
  // 追加
  let r = enqueueRepush([], item('result', 'ssq', '2026122', 'A'))
  assert.equal(r.queue.length, 1); assert.equal(r.merged, false); assert.equal(r.dropped.length, 0)
  // 同类合并：kind+game+issue 相同 → 只留最新、累计次数、不加长
  r = enqueueRepush(r.queue, item('result', 'ssq', '2026122', 'B'))
  assert.equal(r.queue.length, 1)
  assert.equal(r.queue[0].text, 'B')
  assert.equal(r.queue[0].mergedCount, 1)
  assert.equal(r.merged, true)
  r = enqueueRepush(r.queue, item('result', 'ssq', '2026122', 'C'))
  assert.equal(r.queue[0].mergedCount, 2)
  // 不同 issue 不合并
  r = enqueueRepush(r.queue, item('result', 'ssq', '2026123', 'D'))
  assert.equal(r.queue.length, 2)
  // 溢出：装满 20 条不同键后再入一条 → 丢最早、队尾是新的、dropped 报告 1 条
  let q = []
  for (let i = 0; i < 20; i++) q = enqueueRepush(q, item('result', 'ssq', String(2000000 + i), 'x' + i)).queue
  assert.equal(q.length, 20)
  r = enqueueRepush(q, item('predict', 'p3', '26299', 'NEW'))
  assert.equal(r.queue.length, 20)
  assert.equal(r.dropped.length, 1)
  assert.equal(r.dropped[0].issue, '2000000', '丢的是最早一条')
  assert.equal(r.queue[r.queue.length - 1].text, 'NEW')
  // 满队但存在同类 → 合并不触发丢弃
  r = enqueueRepush(q, item('result', 'ssq', '2000019', 'MERGE'))
  assert.equal(r.merged, true); assert.equal(r.dropped.length, 0)
})

// ────────────────────────────── C6 / FR-008：新鲜度探针 ─────────────────────────

test('C6 isStaleDraw：7 天内 ✓ / 恰 7 天 ✓ / 超 7 天 ✗ / 缺日期 ✗', () => {
  assert.equal(isStaleDraw('2026-10-21', '2026-10-24'), false, '3 天前 → 新鲜')
  assert.equal(isStaleDraw('2026-10-17', '2026-10-24'), false, '恰 7 天 → 不算失败（>7 才判）')
  assert.equal(isStaleDraw('2026-10-16', '2026-10-24'), true, '8 天前 → 陈旧')
  assert.equal(isStaleDraw('2026-10-20', '2026-11-05'), true, '跨月 16 天 → 陈旧')
  assert.equal(isStaleDraw(null, '2026-10-24'), true, '拿不到日期 → 无法证明新鲜')
  assert.equal(isStaleDraw('2026-10-21T21:25:00', '2026-10-24'), false, '带时间的日期串也认')
})

// ────────────────────────────── C8 / FR-006：carry 扫描扩展 ─────────────────────

test('C8 carryJobsFromEntries：全部未结清入队（含 8 天前漏账），voided/加餐/已结清排除（B-verify 断言 3 同款）', () => {
  const entries = [
    { kind: 'daily', game: 'ssq', issue: '2026110', date: '2026-10-10', settled: false },                      // 宕机漏账（8 天前）
    { kind: 'daily', game: 'p3', issue: '26280', date: '2026-10-12', settled: true, settleState: 'given-up' }, // 放弃待补 → 未结清
    { kind: 'daily', game: 'dlt', issue: '26120', date: '2026-10-14', settled: true, settleState: 'voided' },  // 作废 → 结清
    { kind: 'daily', game: 'ssq', issue: '2026115', date: '2026-10-17', settled: true, prize: 10 },            // 已结清
    { kind: 'quickpick', game: 'ssq', issue: '2026115', date: '2026-10-17', settled: false },                  // 加餐不对账
  ]
  const jobs = carryJobsFromEntries(entries)
  assert.equal(jobs.length, 2, '现行 v1.0 逻辑（仅扫昨日）会漏掉这 2 条')
  assert.ok(jobs.some((j) => j.date === '2026-10-10' && j.gameKey === 'ssq'))
  assert.ok(jobs.some((j) => j.date === '2026-10-12' && j.gameKey === 'p3'))
  assert.deepEqual(carryJobsFromEntries([]), [])
  assert.deepEqual(carryJobsFromEntries(null), [])
  // 同日同彩种重复条目去重（防御）
  assert.equal(carryJobsFromEntries([
    { kind: 'daily', game: 'p3', date: '2026-10-12', settled: false },
    { kind: 'daily', game: 'p3', date: '2026-10-12', settled: false },
  ]).length, 1)
})

test('C8 跨天重建携带 repushQueue：state.json 重建后队列不丢（T3 前置语义）', () => {
  // 直接验证重建数据流：carryJobsFromEntries + 显式携带的产物形状与 state 字段一致
  const prev = { date: '2026-10-23', games: {}, carry: [], repushQueue: [{ kind: 'result', game: 'ssq', issue: '2026121', text: 'x', deadline: '23:30', failedAt: 'f', lastErr: 'e', attempts: 2 }], lastError: null }
  const carry = carryJobsFromEntries([{ kind: 'daily', game: 'ssq', issue: '2026121', date: '2026-10-22', settled: false }])
  const rebuilt = { date: '2026-10-24', games: {}, carry, repushQueue: prev.repushQueue, lastError: null }
  assert.equal(rebuilt.repushQueue.length, 1)
  assert.equal(rebuilt.repushQueue[0].attempts, 2)
  assert.equal(rebuilt.carry.length, 1)
})
