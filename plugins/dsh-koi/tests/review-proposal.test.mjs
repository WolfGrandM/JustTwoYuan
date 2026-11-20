/**
 * 环 A 探索性提案引擎测试（收尾批 T2 / docs/32 §6.2③ LLM 面）——
 * mock 提案一轮全流程（DSL 校验落库/拒收如实记录）/ DSL 拒绝面（白名单 metric/3d game/set-op 违规）/
 * cap 态跳过（narrate 三闸同款护栏）/ mind 关与错峰跳过 / 提案表字段与观察期起点（含跨年）/
 * 零特权断言（提案因子 candidate 态、下月报才入观察、与全部因子同一条流水线受检、晋升走同一 Bonferroni 边）/
 * unparseable 空轮如实记录 / 月报缺席如实渲染。
 * BC-001 诚实条款：所有断言数字均来自本测试内构造数据，探索性声明常驻断言。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createProposalEngine, nextPeriodOf, PROPOSAL_K } from '../lib/review/proposal.js'
import { createReviewStore } from '../lib/review/store.js'
import { createMonthlyReview } from '../lib/review/monthly.js'
import { DISCLAIMER } from '../lib/insight.js'
import { binomTailAtLeast } from '../lib/backtest.js'

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'koi-proposal-'))

/** 合成在库历史（最新在前，drawstore.getRecent 同构）——aggregate ≥3 期可产转移表 */
const mkHist = (game, n = 12, start = 26200) => {
  const out = []
  for (let i = 0; i < n; i++) {
    const date = new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10)
    const issue = String(start + i)
    out.push(game === 'ssq'
      ? { issue, date, red: [(i + 1) % 33 + 1, (i + 7) % 33 + 1, (i + 13) % 33 + 1, (i + 19) % 33 + 1, (i + 25) % 33 + 1, (i + 31) % 33 + 1], blue: (i % 16) + 1 }
      : { issue, date, digits: [i % 10, (i * 3 + 1) % 10, (i * 7 + 2) % 10] })
  }
  return out.reverse()
}
const P3_HIST = mkHist('p3')
const SSQ_HIST = mkHist('ssq', 12, 2026100)

const VALID_SSQ = { game: 'ssq', name: '高和值区假设', rationale: '转移表 mid→high 60%', claimHuman: '上一期和值中档时下一期落在高区', spec: { game: 'ssq', conditions: [{ metric: 'sum', op: 'in', range: [90, 130] }] } }
const VALID_P3 = { game: 'p3', name: '偶数两枚假设', rationale: '条件分位 p50 偏移', claimHuman: '奇数个数=2', spec: { game: 'p3', conditions: [{ metric: 'parityOdd', op: 'eq', value: 2 }] } }
const BAD_METRIC = { game: 'ssq', name: 'AC 值越界', spec: { game: 'ssq', conditions: [{ metric: 'acValue', op: 'gte', value: 8 }] } }
const BAD_GAME_3D = { game: '3d', name: '3d 越界', spec: { game: '3d', conditions: [{ metric: 'sum', op: 'gte', value: 5 }] } }
const BAD_SET_OP = { game: 'ssq', name: 'blueIn op 违规', spec: { game: 'ssq', conditions: [{ metric: 'blueIn', op: 'gte', value: 3 }] } }

/** 引擎夹具：promptAgent 桩解析提示词中的交卷路径并落 payload 文件 */
function mkFixture({ payload = null, cfg = {}, budget = null, agentError = null, now = () => new Date('2026-11-30T23:45:00') } = {}) {
  const dir = tmpdir()
  const store = createReviewStore({ dataDir: dir, now })
  const prompts = []
  const agent = async (text) => {
    prompts.push(text)
    if (agentError) throw new Error(agentError)
    const outPath = /（合法 JSON）：\s*(\S+)/.exec(text)[1]
    if (payload !== null) fs.writeFileSync(outPath, typeof payload === 'string' ? payload : JSON.stringify(payload))
  }
  const usageCalls = []
  const usage = { record: (a, t) => usageCalls.push({ activity: a, tokens: t }) }
  const engine = createProposalEngine({
    store, promptAgent: agent, usage,
    readCfg: () => ({ mind: { enabled: true }, holidays: [], ...cfg }),
    budgetState: budget ? () => budget : () => ({ demo: { allowLLM: true } }),
    now, workDir: path.join(dir, 'work'), log: () => {},
    historyOf: (g) => (g === 'p3' ? P3_HIST : g === 'ssq' ? SSQ_HIST : []),
    waitMs: 500, pollMs: 5,
  })
  return { dir, store, engine, prompts, usageCalls, agent }
}

test('T2 mock 提案一轮全流程：K=3 内 2 合法落库 candidate + 1 DSL 拒收如实记录，提案表字段齐全，review 桶计量', async () => {
  const fx = mkFixture({ payload: { schemaVersion: 1, proposals: [VALID_SSQ, VALID_P3, BAD_METRIC] } })
  const r = await fx.engine.run({ period: '2026-11' })
  assert.equal(r.ok, true, `运行成功：${JSON.stringify(r).slice(0, 300)}`)
  assert.equal(r.accepted.length, 2)
  assert.equal(r.rejected.length, 1)
  assert.equal(r.observeFrom, '2026-12', '观察期起点=下一月报期')
  // 落库因子：candidate 态 + source 血统 + specRef 可追溯
  const fsx = fx.store.listFactors().filter((f) => f.source === 'proposal:2026-11')
  assert.equal(fsx.length, 2)
  assert.ok(fsx.every((f) => f.status === 'candidate' && f.version === 1), '提案因子一律 candidate 态（零特权）')
  assert.deepEqual(fsx.map((f) => f.id).sort(), ['proposal-2026-11-p3-2', 'proposal-2026-11-ssq-1'])
  assert.ok(fsx.find((f) => f.id === 'proposal-2026-11-ssq-1').specRef.includes('"sum"'), 'specRef 存原始 DSL spec')
  // 提案表：3 行（2 accepted + 1 rejected-dsl），字段齐全
  const rows = fx.store.listProposals('2026-11')
  assert.equal(rows.length, 3)
  assert.deepEqual(rows.map((x) => x.status).sort(), ['accepted', 'accepted', 'rejected-dsl'])
  for (const row of rows.filter((x) => x.status === 'accepted')) {
    assert.ok(!Number.isNaN(Date.parse(row.at)), `提案时刻 ISO：${row.at}`)
    assert.equal(row.observeFrom, '2026-12')
    assert.equal(row.lineage.games.ssq.count, 12, '血统含聚合视图在库期数')
    assert.ok(Array.isArray(row.lineage.games.ssq.blindSpots), '血统含盲区清单维度')
    assert.ok(row.spec.conditions.length >= 1)
  }
  const bad = rows.find((x) => x.status === 'rejected-dsl')
  assert.equal(bad.factorId, null, 'DSL 拒收不进因子库')
  assert.ok(bad.errors.join('；').includes('acValue'), `拒收原因如实记录：${bad.errors.join('；')}`)
  // 输入提示词：聚合视图 + K=3 + 零特权纪律 + BC-001 声明常驻
  assert.equal(fx.prompts.length, 1)
  assert.ok(fx.prompts[0].includes('转移频次表'), '提示词含 insight.aggregate 聚合视图')
  assert.ok(fx.prompts[0].includes('因子覆盖盲区清单'), '提示词含盲区清单（候选假设目标区）')
  assert.ok(fx.prompts[0].includes('至多 3 个候选'))
  assert.ok(fx.prompts[0].includes('零特权'))
  assert.ok(fx.prompts[0].includes(DISCLAIMER), 'BC-001 声明常驻提示词')
  // 计量：输出侧 review 桶一笔（est 恒标；输入侧由注入的 promptAgent 记——调度器装配面）
  assert.equal(fx.usageCalls.length, 1)
  assert.equal(fx.usageCalls[0].activity, 'review')
  assert.ok(fx.usageCalls[0].tokens > 0)
})

test('T2 DSL 校验拒绝面：白名单外 metric / 3d game（无 DSL 表达面）/ set 指标 op 违规全部拒收，零因子入库', async () => {
  const fx = mkFixture({ payload: { schemaVersion: 1, proposals: [BAD_METRIC, BAD_GAME_3D, BAD_SET_OP] } })
  const r = await fx.engine.run({ period: '2026-11' })
  assert.equal(r.ok, true)
  assert.equal(r.accepted.length, 0, '全部拒收')
  assert.equal(r.rejected.length, 3)
  assert.equal(fx.store.listFactors().filter((f) => f.source?.startsWith('proposal:')).length, 0, '零提案因子入库')
  const rows = fx.store.listProposals('2026-11')
  assert.equal(rows.length, 3)
  assert.ok(rows.every((x) => x.status === 'rejected-dsl' && x.factorId === null && x.observeFrom === null))
  const errs = rows.map((x) => x.errors.join('；')).join(' | ')
  assert.ok(errs.includes('acValue'), 'metric 不在白名单如实记录')
  assert.ok(errs.includes('game 非法'), '3d game 白名单外如实记录（validateFactorSpec :101 权威）')
  assert.ok(errs.includes('blueIn 只支持 op=in'), 'set 指标 op 违规如实记录')
})

test('T2 cap 态跳过（narrate 三闸同款①）：预算触顶 → 提案段整体跳过零 LLM，零落库零提案行', async () => {
  const fx = mkFixture({ payload: [VALID_SSQ], budget: { demo: { allowLLM: false } } })
  const r = await fx.engine.run({ period: '2026-11' })
  assert.equal(r.ok, false)
  assert.equal(r.skipped, 'cap')
  assert.match(r.reason, /预算触顶/)
  assert.equal(fx.prompts.length, 0, '零 LLM 调用')
  assert.equal(fx.usageCalls.length, 0)
  assert.equal(fx.store.listProposals('2026-11').length, 0, '零提案行')
  assert.equal(fx.store.listFactors().filter((f) => f.source?.startsWith('proposal:')).length, 0, '零因子入库')
})

test('T2 mind 关与错峰跳过（narrate 三闸同款②③ + 任务书 mind 门控）：均零 LLM', async () => {
  const fxMind = mkFixture({ payload: [VALID_SSQ], cfg: { mind: { enabled: false } } })
  const rMind = await fxMind.engine.run({ period: '2026-11' })
  assert.equal(rMind.skipped, 'mind-disabled', 'mind 未启用 → 提案段不运行（CLI 手动月报旁路 mind 闸不旁路本段）')
  assert.equal(fxMind.prompts.length, 0)
  const fxPeak = mkFixture({ payload: [VALID_SSQ], now: () => new Date('2026-11-30T20:00:00') })
  const rPeak = await fxPeak.engine.run({ period: '2026-11' })
  assert.equal(rPeak.skipped, 'offpeak')
  assert.match(rPeak.reason, /BC-012/)
  assert.equal(fxPeak.prompts.length, 0)
})

test('T2 提案表字段与观察期起点：at=提案时刻、observe_from=下一月报期（跨年 2026-12→2027-01）、lineage 血统', async () => {
  const fx = mkFixture({ payload: { schemaVersion: 1, proposals: [VALID_SSQ] } })
  const r = await fx.engine.run({ period: '2026-12' })
  assert.equal(r.observeFrom, '2027-01', '跨年观察期起点正确')
  assert.equal(nextPeriodOf('2026-12'), '2027-01')
  assert.equal(nextPeriodOf('2026-11'), '2026-12')
  const row = fx.store.listProposals('2026-12')[0]
  assert.equal(row.period, '2026-12')
  assert.ok(!Number.isNaN(Date.parse(row.at)))
  assert.equal(row.status, 'accepted')
  assert.equal(row.factorId, 'proposal-2026-12-ssq-1')
})

test('T2 零特权断言：提案当月不参与流水线评估（保持 candidate）；下月报按观察期起点入观察，走同一条晋升边（Bonferroni+否决窗）', async () => {
  const dir = tmpdir()
  const store = createReviewStore({ dataDir: dir, now: () => new Date('2026-11-30T23:45:00') })
  const prompts = []
  const payload = { schemaVersion: 1, proposals: [VALID_SSQ, VALID_P3] }
  const engine = createProposalEngine({
    store, usage: null,
    promptAgent: async (text) => {
      prompts.push(text)
      fs.writeFileSync(/（合法 JSON）：\s*(\S+)/.exec(text)[1], JSON.stringify(payload))
    },
    readCfg: () => ({ mind: { enabled: true }, holidays: [] }),
    budgetState: () => ({ demo: { allowLLM: true } }),
    now: () => new Date('2026-11-30T23:45:00'),
    workDir: path.join(dir, 'work'), log: () => {},
    historyOf: (g) => (g === 'p3' ? P3_HIST : g === 'ssq' ? SSQ_HIST : []),
    waitMs: 500, pollMs: 5,
  })
  const evalCalls = []
  const evalOf = (hits) => ({ ok: true, rounds: 100, hits, hitRate: hits / 100, baselineRate: 0.5, pValue: binomTailAtLeast(hits, 100, 0.5) })
  const monthly = createMonthlyReview({
    store,
    readLedger: () => ({ entries: [] }), readPreds: () => ({ entries: [] }),
    narrator: null, emit: async () => ({ id: 'e' }),
    now: () => new Date('2026-11-30T23:45:00'),
    readCfg: () => ({ mind: { enabled: true }, holidays: [] }), log: () => {}, lock: null,
    reportsDir: path.join(dir, 'review', 'reports'),
    proposals: engine,
    evaluateFactor: async (f) => { evalCalls.push(f.id); return f.id === 'proposal-2026-11-ssq-1' ? evalOf(100) : { ok: false, error: '样本不足（夹具未给战绩）' } },
  })
  // 当月（2026-11）：提案落库 candidate；流水线不评估提案因子（观察期起点未到）
  const r1 = await monthly.generateNow({ today: '2026-11-30' })
  assert.equal(r1.ok, true)
  const f1 = store.listFactors().find((x) => x.id === 'proposal-2026-11-ssq-1')
  assert.equal(f1.status, 'candidate', '提案因子保持 candidate 态（零特权：当月不受检不晋升）')
  assert.equal(evalCalls.includes('proposal-2026-11-ssq-1'), false, '当月流水线未评估提案因子')
  assert.match(r1.content, /【探索性提案（环 A · mind 门控 · K=3）】/)
  assert.match(r1.content, /✓ proposal-2026-11-ssq-1（ssq）/)
  assert.match(r1.content, /candidate 态；零特权：与全部因子同一条月报检验流水线/)
  assert.match(r1.content, new RegExp(DISCLAIMER.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'BC-001 声明常驻月报段')
  assert.equal(r1.pipeline.activated.length, 0)
  // 下月报（2026-12）：观察期起点已到 → candidate→observing → 同一条流水线受检 → 达标晋升（无任何加权旁路）
  evalCalls.length = 0
  const r2 = await monthly.generateNow({ today: '2026-12-31' })
  assert.equal(r2.ok, true)
  assert.ok(r2.pipeline.activated.some((x) => x.id === 'proposal-2026-11-ssq-1'), '入观察清单含提案因子')
  const f2 = store.listFactors().find((x) => x.id === 'proposal-2026-11-ssq-1')
  assert.equal(f2.status, 'promoted', '提案因子经同一条流水线达标晋升（样本外+Bonferroni+上限+否决窗）')
  const logRows = store.stateLogOf('proposal-2026-11-ssq-1')
  assert.equal(logRows.length, 2)
  assert.equal(logRows[1].fromStatus, 'candidate', '保留边 candidate→observing')
  assert.equal(logRows[1].actor, 'monthly-pipeline')
  assert.match(logRows[1].note, /观察期起点 2026-12 已到/)
  assert.equal(logRows[0].toStatus, 'promoted')
  assert.match(logRows[0].note, /α_adj=/, '同一 Bonferroni 检验边（无加权旁路）')
  assert.match(logRows[0].note, /否决窗口 24h/, '同一否决窗')
  assert.ok(evalCalls.includes('proposal-2026-11-ssq-1'), '入观察后受检（与全部因子同池）')
})

test('T2 unparseable 空轮如实记录 + 月报缺席渲染（引擎未注入/LLM 失败不阻塞月报）', async () => {
  const fx = mkFixture({ payload: { schemaVersion: 1, proposals: [], unparseable: true } })
  const r = await fx.engine.run({ period: '2026-11' })
  assert.equal(r.ok, true)
  assert.match(r.note, /零候选/)
  assert.equal(r.accepted.length, 0)
  const rows = fx.store.listProposals('2026-11')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].status, 'rejected-dsl', '空轮如实记录（诚实不虚构）')
  assert.match(rows[0].errors.join('；'), /unparseable/)
  assert.equal(fx.store.listFactors().filter((f) => f.source?.startsWith('proposal:')).length, 0)
  // 月报缺席渲染：引擎未注入 → 如实注明，月报继续
  const dir = tmpdir()
  const store2 = createReviewStore({ dataDir: dir, now: () => new Date('2026-11-30T23:45:00') })
  const monthly = createMonthlyReview({
    store: store2, readLedger: () => ({ entries: [] }), readPreds: () => ({ entries: [] }),
    narrator: null, emit: async () => ({ id: 'e' }), now: () => new Date('2026-11-30T23:45:00'),
    readCfg: () => ({ mind: { enabled: true }, holidays: [] }), log: () => {}, lock: null,
    reportsDir: null, evaluateFactor: async () => ({ ok: false, error: '样本不足' }),
  })
  const r2 = await monthly.generateNow({ today: '2026-11-30' })
  assert.equal(r2.ok, true)
  assert.match(r2.content, /（探索性提案段未运行：提案引擎未注入）/, '缺席如实报告不静默')
  // cap 态在月报段的渲染：skip 原因逐字进报告
  const fx2 = mkFixture({ budget: { demo: { allowLLM: false } } })
  const monthly3 = createMonthlyReview({
    store: fx2.store, readLedger: () => ({ entries: [] }), readPreds: () => ({ entries: [] }),
    narrator: null, emit: async () => ({ id: 'e' }), now: () => new Date('2026-11-30T23:45:00'),
    readCfg: () => ({ mind: { enabled: true }, holidays: [] }), log: () => {}, lock: null,
    reportsDir: null, evaluateFactor: async () => ({ ok: false, error: '样本不足' }),
    proposals: fx2.engine,
  })
  const r3 = await monthly3.generateNow({ today: '2026-11-30' })
  assert.equal(r3.ok, true)
  assert.match(r3.content, /探索性提案段未运行：预算触顶 · 探索性提案暂停（BC-013）/, 'cap 跳过原因进月报')
  assert.equal(PROPOSAL_K, 3, '拍板 K=3 常量锚')
})
