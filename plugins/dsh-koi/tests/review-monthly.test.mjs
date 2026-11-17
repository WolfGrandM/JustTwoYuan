/**
 * M4 T3 月报 + 晋升流水线测试（docs/28 §6 review-monthly，AC-024/AC-033 + §9-R3/R6）——
 * 状态机全路径（晋升×2 达上限 / 第 3 达标拒入 log 无该边 / 降级 / 淘汰 / 维持）+ 否决回退边
 * （actor=owner + 非空 note）+ 过期 veto 拒绝 + 非法边 ABORT + 审计注记 + 月末 23:45 fixture +
 * period 幂等 + AC-033 token 视图 + BC-001 叙述输入无概率字段。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createReviewStore } from '../lib/review/store.js'
import { createMonthlyReview, isMonthEnd } from '../lib/review/monthly.js'
import { binomTailAtLeast } from '../lib/backtest.js'
import { writeJsonAtomic, readJson } from '../lib/io.js'

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'koi-review-monthly-'))

/** 评估桩：rounds=100、基线 0.5（判据滞后自评满足率），pValue 用引擎同源 binomTailAtLeast 手算 */
const evalOf = (hits) => ({
  ok: true, rounds: 100, hits, hitRate: hits / 100, baselineRate: 0.5,
  pValue: binomTailAtLeast(hits, 100, 0.5),
})

function mkFixture({ hitsById = {}, now = () => new Date('2026-11-30T23:45:00'), narratorCapture = null, cfg = {} } = {}) {
  const dir = tmpdir()
  const store = createReviewStore({ dataDir: dir, now })
  const addFactor = (id, name = id) => store.db.prepare(
    `INSERT INTO factors(id, game, name, source, spec_ref, p0, status, version) VALUES(?,?,?,'test','fixture',NULL,'observing',1)`)
    .run(id, 'ssq', name)
  const emit = []
  const monthly = createMonthlyReview({
    store,
    readLedger: () => ({ entries: [] }),
    readPreds: () => ({ entries: [] }),
    narrator: narratorCapture ? { narrate: async ({ section, data }) => { narratorCapture.push({ section, data }); return { ok: true, text: `${section} 叙述占位。`, source: 'llm' } } } : null,
    emit: async (p) => { emit.push(p); return { id: `evt-${emit.length}` } },
    now,
    readCfg: () => ({ mind: { enabled: true }, holidays: [], ...cfg }),
    log: () => {},
    lock: null,
    reportsDir: path.join(dir, 'review', 'reports'),
    evaluateFactor: async (f) => (f.id in hitsById ? hitsById[f.id] : { ok: false, error: '样本不足（夹具未给战绩）' }),
  })
  return { dir, store, monthly, emit, addFactor }
}

test('AC-024 状态机全路径：晋升×2 达上限、第 3 达标拒入（log 无该边）、降级、淘汰、维持', async () => {
  const fx = mkFixture({
    hitsById: {
      'f-prom-a': evalOf(100),    // 完美正（p≈7.9e-31）
      'f-prom-b': evalOf(80),     // 强正（p≈2e-10，< α_adj=0.01）
      'f-cap-c': evalOf(75),      // 达标但超月度上限 2
      'f-neg-d': evalOf(10),      // 强负（pLower 显著）
      'f-neutral-f': evalOf(50),  // 中性（p≈0.54）
      'f-silent-e': { ok: false, error: '样本不足（夹具未给战绩）' },
    },
  })
  for (const id of ['f-prom-a', 'f-prom-b', 'f-cap-c', 'f-neg-d', 'f-neutral-f', 'f-silent-e']) fx.addFactor(id)
  // f-silent-e：100 天前的非空归因行 → 90 天零观点淘汰（无最近观点）
  const archive = fx.store.upsertArchive({ game: 'ssq', issue: '2026001', date: '2026-08-01', kind: 'daily', at: '2026-08-01T10:00:00.000Z', picks: { red: [1, 2, 3, 4, 5, 6], blue: 7 } })
  fx.store.recordAttribution(archive.id, [{ factorId: 'f-silent-e', hit: true, detail: '旧观点' }], { at: '2026-08-20T10:00:00.000Z' })   // 距 2026-11-30 约 102 天

  const r = await fx.monthly.generateNow({ today: '2026-11-30' })
  assert.equal(r.ok, true, `生成成功：${JSON.stringify(r).slice(0, 300)}`)
  const status = (id) => fx.store.listFactors().find((x) => x.id === id)?.status
  const logRows = (id) => fx.store.stateLogOf(id)
  // 晋升 2（pValue 升序：a 7.9e-31 < b 2e-10 < c）
  assert.equal(status('f-prom-a'), 'promoted')
  assert.equal(status('f-prom-b'), 'promoted')
  assert.equal(status('f-cap-c'), 'observing', '第 3 个达标因子被月度上限拒入——不执行状态变更')
  assert.equal(logRows('f-cap-c').length, 0, '上限拒入：log 无该边')
  assert.ok(r.pipeline.capDenied.some((x) => x.id === 'f-cap-c'))
  // 降级 / 淘汰 / 维持
  assert.equal(status('f-neg-d'), 'demoted')
  assert.equal(status('f-silent-e'), 'retired', '90 天零观点淘汰')
  assert.equal(status('f-neutral-f'), 'observing', '中性维持')
  // 审计注记：actor / note（含 effectiveAt）/ from-to
  const pa = logRows('f-prom-a')[0]
  assert.equal(pa.actor, 'monthly-pipeline')
  assert.equal(pa.fromStatus, 'observing')
  assert.equal(pa.toStatus, 'promoted')
  assert.ok(/effectiveAt=\d{4}-\d{2}-\d{2}T/.test(pa.note), 'promoted 注记含 effectiveAt（R6 lazy 生效门）')
  const vetoHours = 24
  const promotedAt = Date.parse(pa.at)
  assert.equal(pa.at, fx.store.listFactors().find((x) => x.id === 'f-prom-a').stateChangedAt, '注记 at 与 state_changed_at 同刻（触发器④）')
  void vetoHours; void promotedAt
  // 月报内容：口径行 + Bonferroni + 晋升行
  const row = fx.store.getReport('monthly', '2026-11')
  assert.ok(row, '月报落 reports 表')
  assert.match(row.content, /Bonferroni/)
  assert.match(row.content, /受检 5 个 observing 因子/)
  assert.match(row.content, /与 docs\/11 §4\.3 的 DC-002 闭式组合概率口径存在差异/)
  // R6 可发现性①：月报事件 + 待否决晋升事件，均 panelOnly
  assert.equal(fx.emit.length, 2)
  assert.ok(fx.emit.every((e) => e.kind === 'review' && e.panelOnly === true))
  assert.equal(fx.emit[1].level, 'warn')
  assert.match(fx.emit[1].message, /f-prom-a/)
})

test('AC-024 否决回退边：窗口内 veto → promoted→observing + actor=owner + 非空 note（唯一合法回退边）', async () => {
  const fx = mkFixture({ hitsById: { 'f-prom-a': evalOf(100) } })
  fx.addFactor('f-prom-a')
  await fx.monthly.generateNow({ today: '2026-11-30' })
  assert.equal(fx.store.listFactors().find((x) => x.id === 'f-prom-a').status, 'promoted')
  const r = fx.monthly.vetoFactor('f-prom-a', '主人否决：不想让这个因子参与出号')
  assert.equal(r.ok, true, `否决成功：${JSON.stringify(r)}`)
  const f = fx.store.listFactors().find((x) => x.id === 'f-prom-a')
  assert.equal(f.status, 'observing')
  const veto = fx.store.stateLogOf('f-prom-a')[0]
  assert.equal(veto.fromStatus, 'promoted')
  assert.equal(veto.toStatus, 'observing')
  assert.equal(veto.actor, 'owner')
  assert.equal(veto.note, '主人否决：不想让这个因子参与出号')
  // 已回退后再 veto → 拒绝（非 promoted）
  const r2 = fx.monthly.vetoFactor('f-prom-a', '重复否决')
  assert.equal(r2.ok, false)
  assert.match(r2.error, /仅 promoted 可否决/)
})

test('AC-024 过期 veto 拒绝：promoted 落状态 25h 后否决窗口已过（DC-004：promoted→demoted 非法）', async () => {
  const t0 = Date.parse('2026-11-30T23:45:00')
  let t = t0
  const fx = mkFixture({ hitsById: { 'f-prom-x': evalOf(100) }, now: () => new Date(t) })
  fx.addFactor('f-prom-x')
  await fx.monthly.generateNow({ today: '2026-11-30' })
  assert.equal(fx.store.listFactors().find((x) => x.id === 'f-prom-x').status, 'promoted')
  t = t0 + 25 * 3600_000
  const r = fx.monthly.vetoFactor('f-prom-x', '迟到的否决')
  assert.equal(r.ok, false)
  assert.match(r.error, /否决窗口已过/)
  assert.equal(fx.store.listFactors().find((x) => x.id === 'f-prom-x').status, 'promoted', '过期 veto 不改状态')
  const pend = fx.store.resolvePendingPromotions(new Date(t))
  assert.equal(pend.pending.length, 0)
  assert.equal(pend.effective.length, 1, '已过生效门 → effective（消费端 lazy 判生效）')
})

test('DC-004/BC-008 非法边与无注记 ABORT：candidate→promoted / demoted→observing / promoted→demoted 拒；裸 UPDATE 拒', () => {
  const fx = mkFixture({})
  fx.addFactor('f-edge')
  const v0 = fx.monthly.vetoFactor('f-edge', 'n')
  assert.equal(v0.ok, false)
  assert.match(v0.error, /仅 promoted 可否决|现状态为/)
  // 应用层非法边拒绝：observing→demoted（合法）后再试 demoted→observing（非法回退）
  fx.store.applyFactorTransition('f-edge', 'observing', 'demoted', 'monthly-pipeline', '降级测试')
  assert.throws(() => fx.store.applyFactorTransition('f-edge', 'demoted', 'observing', 'monthly-pipeline', '非法回退'), /非法状态边/)
  // candidate→promoted：独立 candidate 因子
  fx.store.db.prepare(`INSERT INTO factors(id, game, name, source, status, version) VALUES('f-edge-c','ssq','候','test','candidate',1)`).run()
  assert.throws(() => fx.store.applyFactorTransition('f-edge-c', 'candidate', 'promoted', 'monthly-pipeline', '非法晋升'), /非法状态边/)
  // DB 层触发器③：promoted→demoted ABORT（独立 observing 因子先合法晋升）
  fx.store.db.prepare(`INSERT INTO factors(id, game, name, source, status, version) VALUES('f-edge-p','ssq','晋','test','observing',1)`).run()
  fx.store.applyFactorTransition('f-edge-p', 'observing', 'promoted', 'monthly-pipeline', '晋升测试')
  assert.throws(() => fx.store.db.prepare(`UPDATE factors SET status='demoted' WHERE id='f-edge-p'`).run(),
    /非法状态边（DC-004/)
  // DB 层触发器④：裸 UPDATE（无注记）ABORT
  fx.store.db.prepare(`INSERT INTO factors(id, game, name, source, status, version) VALUES('f-edge2','ssq','裸','test','observing',1)`).run()
  assert.throws(() => fx.store.db.prepare(`UPDATE factors SET status='retired' WHERE id='f-edge2'`).run(),
    /状态变更必须同事务写审计注记（BC-008\/AC-024）/)
})

test('§3.2 月末 23:45 fixture：月末放行、非月末/23:44/mind 关/holiday 全拒；period 幂等不重跑流水线（AC-029）', async () => {
  const fx = mkFixture({ hitsById: { 'f-prom-a': evalOf(100) } })
  fx.addFactor('f-prom-a')
  assert.equal(isMonthEnd('2026-11-30'), true)
  assert.equal(isMonthEnd('2026-11-29'), false)
  // 非月末
  let r = await fx.monthly.maybeRunMonthly({ today: '2026-11-29', nowHHMM: '23:45' })
  assert.equal(r.skipped, 'not-month-end')
  // 未到 23:45
  r = await fx.monthly.maybeRunMonthly({ today: '2026-11-30', nowHHMM: '23:44' })
  assert.equal(r.skipped, 'window')
  // mind 关
  const fx2 = mkFixture({ cfg: { mind: { enabled: false } } })
  r = await fx2.monthly.maybeRunMonthly({ today: '2026-11-30', nowHHMM: '23:45' })
  assert.equal(r.skipped, 'mind-disabled')
  // holiday
  const fx3 = mkFixture({ cfg: { holidays: ['2026-11-30'] } })
  r = await fx3.monthly.maybeRunMonthly({ today: '2026-11-30', nowHHMM: '23:45' })
  assert.equal(r.skipped, 'holiday')
  // 正式生成 + 幂等（流水线不重跑：factor_state_log 行数不变）
  r = await fx.monthly.maybeRunMonthly({ today: '2026-11-30', nowHHMM: '23:45' })
  assert.equal(r.ok, true)
  assert.equal(r.period, '2026-11')
  const logCount = () => Number(fx.store.db.prepare(`SELECT COUNT(*) AS n FROM factor_state_log`).get().n)
  const before = logCount()
  const r2 = await fx.monthly.maybeRunMonthly({ today: '2026-11-30', nowHHMM: '23:50' })
  assert.equal(r2.skipped, 'duplicate', 'period 幂等')
  assert.equal(logCount(), before, '流水线不在重复生成时重跑（BC-008 唯一时点）')
  assert.equal(fx.store.listReports('monthly').length, 1)
})

test('AC-033 月报含月度 token 报告视图：读 usage archived，数字来源唯一', async () => {
  const dir = tmpdir()
  const store = createReviewStore({ dataDir: dir, now: () => new Date('2026-11-30T23:45:00') })
  const usageFile = path.join(dir, 'token-usage.json')
  writeJsonAtomic(usageFile, {
    schemaVersion: 1, week: '2026-W48',
    entries: [{ at: '2026-11-26T10:00:00.000Z', activity: 'predict', tokens: 3200, est: true }],
    archived: [
      { week: '2026-W45', entries: [{ at: 'x', activity: 'predict', tokens: 1000, est: true }] },
      { week: '2026-W46', entries: [{ at: 'x', activity: 'review', tokens: 2200, est: true }] },
      { week: '2026-W47', entries: [{ at: 'x', activity: 'predict', tokens: 1500, est: true }] },
    ],
  })
  const usage = { fileOf: () => usageFile }
  const monthly = createMonthlyReview({
    store, readLedger: () => ({ entries: [] }), readPreds: () => ({ entries: [] }),
    usage, emit: async () => ({ id: 'e' }), now: () => new Date('2026-11-30T23:45:00'),
    readCfg: () => ({ mind: { enabled: true }, holidays: [] }), log: () => {}, lock: null,
    reportsDir: null, evaluateFactor: async () => ({ ok: false, error: '样本不足' }),
  })
  const r = await monthly.generateNow({ today: '2026-11-30' })
  assert.equal(r.ok, true)
  // 手算（诚实条款）：2026-11 的 ISO 周全月覆盖 W45(11-02~08)/W46(11-09~15)/W47(11-16~22)/W48(11-23~29)
  // → 月内合计 = 1000 + 2200 + 1500 + 3200 = 7900
  assert.match(r.content, /月度 token 报告视图/)
  assert.match(r.content, /2026-W47:1500/)
  assert.match(r.content, /月内合计（跨月周按整周计）：7900/)
})

test('BC-001 月报叙述输入：代码裁决结果 JSON 中无「建议买入/提高概率」类字段', async () => {
  const capture = []
  const fx = mkFixture({ hitsById: { 'f-prom-a': evalOf(100) }, narratorCapture: capture })
  fx.addFactor('f-prom-a')
  await fx.monthly.generateNow({ today: '2026-11-30' })
  assert.equal(capture.length, 1)
  const json = JSON.stringify(capture[0].data)
  assert.equal(/建议买入|提高概率|提高中奖|加大投注/.test(json), false, '叙述输入零概率宣称字段')
  assert.ok(json.includes('"promoted"'), '输入含代码裁决清单')
})
