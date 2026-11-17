/**
 * M4 T1 review.db 存储层测试（docs/28 §2.2 / §6 AC-009 存储子集）——
 * 触发器①②③④ 全路径 + 播种 + 归因/报告表幂等 + BC-006 periodLedgerSlice 口径锚。
 * BC-001 诚实条款：所有断言数字均来自本测试内的手算与构造数据，不虚构基线。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createReviewStore } from '../lib/review/store.js'
import { periodLedgerSlice } from '../lib/review/period.js'
import { ledgerTotals, appendLedgerEntry, emptyLedger } from '../lib/draws.js'

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'koi-review-store-'))
const mkStore = (overrides = {}) => createReviewStore({ dataDir: tmpdir(), ...overrides })

// ── schema 迁移与播种 ─────────────────────────────────────────────────────────

test('T1 migrate：schema_version=1 幂等（二次 migrate 零抛错、版本不变）', () => {
  const s = mkStore()
  const m1 = s.migrate()
  const m2 = s.migrate()
  assert.equal(m1.schemaVersion, 1)
  assert.equal(m2.schemaVersion, 1)
  const row = s.db.prepare(`SELECT value FROM schema_info WHERE key='schema_version'`).get()
  assert.equal(Number(row.value), 1)
  assert.ok(s.fileOf().endsWith('review.db'))
})

test('T1 播种：内置六件 ×3 彩种 = 18 因子，status 全 observing、source=builtin', () => {
  const s = mkStore()
  const fsx = s.listFactors()
  assert.equal(fsx.length, 18)
  assert.ok(fsx.every((f) => f.status === 'observing'), '播种即观察中（回测引擎持续观察，monthly 从 observing 晋升）')
  assert.ok(fsx.every((f) => f.source === 'builtin' && f.version === 1))
  for (const g of ['ssq', 'dlt', 'p3']) {
    assert.equal(fsx.filter((f) => f.game === g).length, 6, `${g} 六件`)
  }
  // 播种幂等：重开一个 store 指向同一 dataDir 不重复插入
  const dir = path.dirname(s.fileOf())
  const s2 = createReviewStore({ dataDir: dir })
  assert.equal(s2.listFactors().length, 18)
})

// ── predictions_archive：预注册列 + outcome 单次 ─────────────────────────────

const ENTRY = {
  game: 'ssq', issue: '2026121', date: '2026-10-22', kind: 'daily',
  at: '2026-10-22T11:50:00.000Z',
  picks: { red: [2, 7, 20, 24, 26, 30], blue: 2 },
  via: 'ai', tier: 'double', effortTier: 'standard', configStamp: 'cs-1',
  baselinePicks: { red: [1, 2, 3, 4, 5, 6], blue: 7 },
  cost: 56,
}

test('T1 upsertArchive：首插带结果即填 outcome；重插同业务键零 diff（幂等）', () => {
  const s = mkStore()
  const a = s.upsertArchive({ ...ENTRY, result: { red: [2, 7, 20, 24, 26, 30], blue: 2 }, prize: 10, grades: { 5: 1 }, pushedResult: true, baselinePrize: 5, baselineGrades: { 6: 1 } })
  assert.equal(a.created, true)
  assert.equal(a.outcomeFilled, true)
  const b = s.upsertArchive({ ...ENTRY })
  assert.equal(b.created, false)
  const n = s.db.prepare(`SELECT COUNT(*) AS n FROM predictions_archive`).get()
  assert.equal(Number(n.n), 1, '业务键去重，不产生第二行')
})

test('T1 触发器①：UPDATE 预注册列（picks/at/via/game/issue/date/kind）被 ABORT（BC-002）', () => {
  const s = mkStore()
  const { id } = s.upsertArchive({ ...ENTRY })
  for (const [col, val] of [
    ['picks', `'[{"tampered":1}]'`], ['at', "'2099-01-01'"], ['via', "'rewrite'"],
    ['game', "'dlt'"], ['issue', "'9999'"], ['date', "'2000-01-01'"], ['kind', "'quickpick'"],
  ]) {
    assert.throws(() => s.db.prepare(`UPDATE predictions_archive SET ${col}=${val} WHERE id=${id}`).run(),
      /预注册列不可改写（BC-002）/, `${col} 改写必须 ABORT`)
  }
})

test('T1 触发器②：outcome 二次写（result 已落定再改）被 ABORT；NULL→值 单次回填放行（B-07）', () => {
  const s = mkStore()
  const { id } = s.upsertArchive({ ...ENTRY, result: { red: [2, 7, 20, 24, 26, 30], blue: 2 }, prize: 10 })
  assert.throws(() => s.db.prepare(`UPDATE predictions_archive SET result='{"x":1}' WHERE id=${id}`).run(),
    /outcome 已落定，更正走 correction 追加行（corrected_by 指针）/)
  // 未带结果的入档，稍后带结果单次回填放行
  const e2 = { ...ENTRY, issue: '2026122', date: '2026-10-24' }
  const a2 = s.upsertArchive({ ...e2 })
  assert.equal(a2.outcomeFilled, false)
  const a3 = s.upsertArchive({ ...e2, result: { red: [1, 3, 5, 7, 9, 11], blue: 3 }, prize: 0, grades: {} })
  assert.equal(a3.outcomeFilled, true)
  assert.equal(s.upsertArchive({ ...e2 }).id, a3.id)
})

// ── factors 状态机：触发器③④ + applyFactorTransition（BC-008/DC-004）─────────

test('T1 触发器③：非法边（observing→candidate / demoted→observing / promoted→demoted）被 ABORT', () => {
  const s = mkStore()
  const t = '2030-01-01T00:00:00.000Z'
  // 每条非法边一个独立因子：先走合法边摆到 from（带注记满足触发器④），再试非法 to
  const reach = (factorId, path) => {
    s.db.prepare(`INSERT INTO factors(id, game, name, source, status, version) VALUES(?,?,?,?,?,1)`)
      .run(factorId, 'ssq', '边测试', 'builtin', 'candidate')
    let cur = 'candidate'
    for (const [from, to] of path) {
      assert.equal(from, cur, `测试构造自检：${from} 应为当前状态`)
      s.db.prepare(`INSERT INTO factor_state_log(factor_id, from_status, to_status, at, actor, note) VALUES(?,?,?,?,?,?)`)
        .run(factorId, from, to, t, 'test', '构造到达 from 状态')
      s.db.prepare(`UPDATE factors SET status=?, state_changed_at=? WHERE id=?`).run(to, t, factorId)
      cur = to
    }
    return factorId
  }
  const cases = [
    ['it-edge-obs-cand', [['candidate', 'observing']], 'candidate', 'observing'],   // observing→candidate
    ['it-edge-dem-obs', [['candidate', 'observing'], ['observing', 'demoted']], 'demoted', 'observing'],
    ['it-edge-pro-dem', [['candidate', 'observing'], ['observing', 'promoted']], 'promoted', 'demoted'],
  ]
  for (const [factorId, path, from, to] of cases) {
    reach(factorId, path)
    assert.throws(() => s.db.prepare(`UPDATE factors SET status=? WHERE id=?`).run(to, factorId),
      /非法状态边（DC-004/, `${from}→${to} 必须被触发器③ ABORT`)
  }
})

test('T1 触发器④：无审计注记的 status UPDATE 被 ABORT（BC-008）', () => {
  const s = mkStore()
  const factorId = 'builtin-parity-ratio-ssq'   // 播种 observing
  assert.throws(() => s.db.prepare(`UPDATE factors SET status='retired' WHERE id=?`).run(factorId),
    /状态变更必须同事务写审计注记（BC-008\/AC-024）/)
})

test('T1 applyFactorTransition：合法边全路径 + 审计注记落行；promoted→observing 回退边（唯一合法回退）', () => {
  const s = mkStore()
  const factorId = 'builtin-sum-band-ssq'
  s.applyFactorTransition(factorId, 'observing', 'promoted', 'monthly-pipeline', '月检达标晋升')
  const f1 = s.listFactors().find((x) => x.id === factorId)
  assert.equal(f1.status, 'promoted')
  assert.equal(f1.version, 2)
  // promoted→observing（veto 唯一回退边）+ actor='owner' + 非空 note
  s.applyFactorTransition(factorId, 'promoted', 'observing', 'owner', '主人否决')
  const log = s.stateLogOf(factorId)
  assert.equal(log.length, 2)
  const veto = log[0]
  assert.equal(veto.fromStatus, 'promoted')
  assert.equal(veto.toStatus, 'observing')
  assert.equal(veto.actor, 'owner')
  assert.ok(veto.note && veto.note.trim(), '回退边审计注记非空')
  // 注记 at 与 state_changed_at 同刻（触发器④依赖）
  assert.equal(veto.at, s.listFactors().find((x) => x.id === factorId).stateChangedAt)
})

test('T1 applyFactorTransition：拒绝项——非法边/缺 actor/缺 note/from 不符/无此因子/no-op', () => {
  const s = mkStore()
  const factorId = 'builtin-mod3-road-ssq'
  assert.throws(() => s.applyFactorTransition(factorId, 'observing', 'candidate', 'x', 'n'), /非法状态边/)
  assert.throws(() => s.applyFactorTransition(factorId, 'observing', 'demoted', '', 'n'), /缺 actor/)
  assert.throws(() => s.applyFactorTransition(factorId, 'observing', 'demoted', 'x', '  '), /缺 note/)
  assert.throws(() => s.applyFactorTransition(factorId, 'promoted', 'observing', 'x', 'n'), /与申报 from 不符|现状态为/)
  assert.throws(() => s.applyFactorTransition('ghost-factor', 'observing', 'demoted', 'x', 'n'), /没有这个因子/)
})

// ── resolvePendingPromotions（§9-R6 lazy 生效门）──────────────────────────────

test('T1 resolvePendingPromotions：24h 窗内 pending（hoursLeft 递减）、窗外 effective', () => {
  const t0 = Date.parse('2026-11-01T15:59:00.000Z')
  let nowMs = t0
  const s = mkStore({ now: () => new Date(nowMs) })
  s.applyFactorTransition('builtin-consecutive-ssq', 'observing', 'promoted', 'monthly-pipeline', '晋升')
  const p2h = s.resolvePendingPromotions(new Date(t0 + 2 * 3600_000))
  assert.equal(p2h.pending.length, 1)
  assert.equal(p2h.effective.length, 0)
  assert.ok(Math.abs(p2h.pending[0].hoursLeft - 22) < 1e-6)
  const p25h = s.resolvePendingPromotions(new Date(t0 + 25 * 3600_000))
  assert.equal(p25h.pending.length, 0)
  assert.equal(p25h.effective.length, 1)
  // 无参默认用注入 now
  nowMs = t0 + 26 * 3600_000
  assert.equal(s.resolvePendingPromotions().effective.length, 1)
})

// ── attribution / reports 表 ─────────────────────────────────────────────────

test('T1 recordAttribution：hit 三值（true→1/false→0/null→NULL）+ UNIQUE 幂等重记零 diff', () => {
  const s = mkStore()
  const { id } = s.upsertArchive({ ...ENTRY })
  s.recordAttribution(id, [
    { factorId: 'builtin-parity-ratio-ssq', hit: true, detail: '奇数个数=1' },
    { factorId: 'builtin-sum-band-ssq', hit: false, detail: '和值=109' },
    { factorId: 'builtin-hot-cold-ssq', hit: null, detail: '本期无观点' },
  ])
  const rows = s.db.prepare(`SELECT factor_id, hit, detail FROM attribution WHERE archive_id=${id} ORDER BY factor_id`).all()
  assert.equal(rows.length, 3)
  const hits = Object.fromEntries(rows.map((r) => [r.factor_id, r.hit]))
  assert.equal(hits['builtin-parity-ratio-ssq'], 1)
  assert.equal(hits['builtin-sum-band-ssq'], 0)
  assert.equal(hits['builtin-hot-cold-ssq'], null)
  // 幂等重记
  s.recordAttribution(id, [{ factorId: 'builtin-parity-ratio-ssq', hit: false, detail: '改写企图' }])
  const again = s.db.prepare(`SELECT COUNT(*) AS n FROM attribution WHERE archive_id=${id}`).get()
  assert.equal(Number(again.n), 3, 'UNIQUE(archive_id, factor_id) 幂等，不产生第二行、不覆盖首判')
})

test('T1 reports：recordReport + UNIQUE(kind,period) 幂等守卫 + getReport/listReports', () => {
  const s = mkStore()
  const r1 = s.recordReport('weekly', '2026-W46', '周报全文', 'ev-1')
  assert.equal(r1.ok, true)
  const r2 = s.recordReport('weekly', '2026-W46', '第二次生成', 'ev-2')
  assert.equal(r2.ok, false, '同 kind+period 二次记录 → duplicate（周报幂等守卫）')
  assert.equal(r2.duplicate, true)
  assert.equal(r2.id, r1.id)
  const got = s.getReport('weekly', '2026-W46')
  assert.equal(got.content, '周报全文', '取首份不覆盖（period 幂等语义）')
  s.recordReport('weekly', '2026-W47', '下周')
  s.recordReport('monthly', '2026-11', '月报')
  assert.equal(s.listReports('weekly').length, 2)
  assert.equal(s.listReports().length, 3)
})

test('T1 attributionAgg：hit=1 计命中、hit=0 计未中、NULL 不进分母；窗口过滤', () => {
  const s = mkStore()
  const a = s.upsertArchive({ ...ENTRY, date: '2026-10-22' })
  const b = s.upsertArchive({ ...ENTRY, issue: '2026122', date: '2026-10-24' })
  s.recordAttribution(a.id, [
    { factorId: 'f-x', hit: true }, { factorId: 'f-x', hit: false }, { factorId: 'f-y', hit: null },
  ])
  s.recordAttribution(b.id, [{ factorId: 'f-x', hit: true }])
  const all = s.attributionAgg()
  const fx = all.find((r) => r.factorId === 'f-x')
  assert.deepEqual({ hits: fx.hits, judged: fx.judged, recorded: fx.recorded }, { hits: 2, judged: 2, recorded: 2 })
  const fy = all.find((r) => r.factorId === 'f-y')
  assert.equal(fy.hits, 0)
  assert.equal(fy.judged, 0, 'NULL（无观点）不进分母')
  const win = s.attributionAgg({ from: '2026-10-24', to: '2026-10-24' })
  assert.equal(win.find((r) => r.factorId === 'f-x').hits, 1, '窗口过滤后只算 b 期')
})

// ── BC-006：periodLedgerSlice 周期口径切片 ────────────────────────────────────

const LEDGER = (() => {
  let l = emptyLedger()
  const e = (o) => (l = appendLedgerEntry(l, o))
  e({ at: 'a1', kind: 'daily', game: 'ssq', issue: '2026119', date: '2026-11-05', cost: 56, prize: 5, bets: 28, grades: { 6: 2 } })
  e({ at: 'a2', kind: 'daily', game: 'p3', issue: '26290', date: '2026-11-06', cost: 2, prize: 0, bets: 1, grades: {} })
  e({ at: 'a3', kind: 'daily', game: 'dlt', issue: '26123', date: '2026-11-07', cost: 42, prize: null, bets: 21, grades: null })
  e({ at: 'a4', kind: 'daily', game: 'ssq', issue: '2026120', date: '2026-11-08', cost: 56, prize: null, bets: 28, grades: null })
  e({ at: 'a5', kind: 'daily', game: 'ssq', issue: '2026121', date: '2026-11-12', cost: 56, prize: 3000, bets: 28, grades: { 3: 1 } })
  e({ at: 's1', kind: 'daily', game: 'dlt', issue: '26122', date: '2026-11-10', cost: 0, prize: 15, bets: 21, grades: { 8: 1 }, entryType: 'supplement', ref: { game: 'dlt', issue: '26122', date: '2026-11-10' } })
  e({ at: 'r1', kind: 'daily', game: 'p3', issue: '26291', date: '2026-11-11', cost: 0, prize: 0, bets: 0, grades: null, entryType: 'reversal', ref: { game: 'p3', issue: '26292', date: '2026-11-11' } })
  e({ at: 'q1', kind: 'quickpick', game: 'p3', issue: '26292', date: '2026-11-11', cost: 2, prize: 0, bets: 1, grades: {} })
  return l
})()

test('T1 periodLedgerSlice：全区间输出逐字段等于 ledgerTotals（BC-006 断言锚）', () => {
  const full = periodLedgerSlice(LEDGER.entries)
  const ref = ledgerTotals(LEDGER)
  assert.deepEqual(full, ref)
  // 手算交叉验证（诚实条款：全区间 cost=56+2+42+56+56=212；prize=5+15+3000=3020）
  assert.equal(full.cost, 212)
  assert.equal(full.prize, 3020)
  assert.equal(full.net, 3020 - 212)
  assert.equal(full.draws, 5, 'quickpick 不计期数（BC-006 加餐永不进正式口径）')
})

test('T1 periodLedgerSlice：时间窗过滤（闭区间按开奖日 date）+ 窗内聚合继承同源公式', () => {
  const w1 = periodLedgerSlice(LEDGER.entries, '2026-11-05', '2026-11-08')   // 前 4 期 main
  assert.equal(w1.draws, 4)
  assert.equal(w1.cost, 56 + 2 + 42 + 56)
  assert.equal(w1.prize, 5, '窗内 supplement(11-10) 不入窗')
  const w2 = periodLedgerSlice(LEDGER.entries, '2026-11-09')
  assert.equal(w2.draws, 1)
  assert.equal(w2.prize, 15 + 3000, '窗内 supplement/reversal/main 口径照 ledgerTotals')
  const w0 = periodLedgerSlice(LEDGER.entries, '2099-01-01', '2099-12-31')
  assert.deepEqual({ cost: 0, prize: 0, net: 0, draws: 0, best: null }, { cost: w0.cost, prize: w0.prize, net: w0.net, draws: w0.draws, best: w0.best })
})

test('T1 periodLedgerSlice：窗内 reversal 冲销其 main（voided 排除同源）', () => {
  let l = emptyLedger()
  l = appendLedgerEntry(l, { at: 'm1', kind: 'daily', game: 'ssq', issue: '2026130', date: '2026-11-19', cost: 56, prize: null, bets: 28, grades: null })
  l = appendLedgerEntry(l, { at: 'r1', kind: 'daily', game: 'ssq', issue: '2026130', date: '2026-11-19', cost: 0, prize: 0, bets: 0, entryType: 'reversal', ref: { game: 'ssq', issue: '2026130', date: '2026-11-19' }, note: '休市作废' })
  const w = periodLedgerSlice(l.entries, '2026-11-01', '2026-11-30')
  assert.equal(w.draws, 0, 'main 被 voided 集排除')
  assert.equal(w.cost, 0)
})
