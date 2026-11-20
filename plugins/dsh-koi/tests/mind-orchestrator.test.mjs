/**
 * M3-T2 编排器（docs/33 §2.2 orchestrator.js 行 / §6.4 降档链全路径 / AC-019/020/021/026/036）。
 * 标准档一期 mock 全流程 / orchestration_log 全记录与议程版本 / 条目五 stamp（scheduler 分流）/
 * 硬校验侵蚀（FZ-2 复用零重实现）/ 降档链（剔除继续、主持人不可剔除全败降档、产出复用）/
 * 17:55 硬停 / cap 短路 / mind.enabled=false 双向闸（单 Agent 路径逐位不变 + B-35 每期新会话）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createOrchestrator } from '../lib/mind/orchestrator.js'
import { createMetering } from '../lib/mind/metering.js'
import { createReviewStore } from '../lib/review/store.js'
import { createUsageTracker } from '../lib/usage.js'
import { validateTierPicks, randomTierPicks } from '../lib/tiers.js'
import { hasProbabilityClaim } from '../lib/render.js'
import { startKoiScheduler } from '../lib/scheduler.js'
import { buildConfigDefaults } from '../lib/config.js'
import { readJson } from '../lib/io.js'

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'koi-orch-'))
const NOW = () => new Date('2026-10-25T17:30:00')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const P3_HISTORY = Array.from({ length: 30 }, (_, i) => ({
  issue: String(26282 - i), date: new Date(Date.parse('2026-10-23') - i * 86_400_000).toLocaleDateString('sv-SE'), digits: [(i + 1) % 10, 4, 7],
}))
const CFG_ON = { mind: { enabled: true }, roles: { strategists: 1, prompts: {} } }
const TIER_SPEC = { text: '直选一注：三位数 0–9（百位-十位-个位），投注额 2 元', picksShape: '{"digits":[3个整数]}' }

/** 角色默认产出（mock 她按契约交卷） */
function defaultPayload(role, game = 'p3', issue = '26283') {
  if (role === 'dataOfficer') return { schemaVersion: 1, game, issue, snapshot: { 遗漏: { 5: 3 }, 冷暖: { 热: [4, 7] }, 和值带: '中', 分位行引用: ['L3'] }, note: '当期局势快照（零结论零选号）' }
  if (role === 'strategist') return { schemaVersion: 1, game, issue, proposal: { picks: { digits: [6, 4, 7] } }, reason: '冷号回补（引用 L3）', cites: ['L3'] }
  if (role === 'chair') return { schemaVersion: 1, issue, picks: { digits: [6, 4, 7] }, message: '今天研究心得：冷号在攒劲，就选这组！开奖是随机的，图个乐～', summary: '冷号回补思路。', confidenceTier: 'mid', cites: ['L3'] }
  if (role === 'provoker') return { schemaVersion: 1, questions: [{ target: 'strategist-1', q: '引用 L3 是否成立？', citeCheck: '在材料内' }] }
  return { schemaVersion: 1 }
}

/** 编排器测试台：mock promptAgent（按 callRef 交卷）+ 真 store/metering */
function mkOrch({ rolePlan = {}, nowFn = NOW, hhmmNow = () => '17:30', budget = null, cfg = CFG_ON, callLog = null } = {}) {
  const dir = tmpdir()
  const workDir = path.join(dir, 'work')
  fs.mkdirSync(workDir, { recursive: true })
  const usage = createUsageTracker({ dataDir: dir, now: nowFn })
  const reviewStore = createReviewStore({ dataDir: dir, now: nowFn, log: () => {} })
  const metering = createMetering({ ctx: null, usage, now: nowFn, log: () => {} })
  const calls = []
  const promptAgent = async (text, o = {}) => {
    calls.push({ role: o.role, callRef: o.callRef, sessionId: o.sessionId, activity: o.activity })
    callLog?.push(o)
    // 计量打标（模拟 scheduler.promptAgent 的打标行为——T1 装配已在 mind-metering 测过）
    if (o.role != null || o.callRef != null) metering.recordStep({ activity: o.activity ?? 'deliberation', role: o.role, callRef: o.callRef, promptText: text })
    const plan = rolePlan[o.role]
    const out = typeof plan === 'function' ? plan(text, o, calls.length) : plan   // 函数返回 'silent' 同样视为不交卷
    if (out === 'silent' || out === false) return   // 不交卷 → 切片超时剔除
    const m = /（(?:交卷)?文件：(.+?)）/.exec(text)
    if (!m) return
    const payload = out == null ? defaultPayload(o.role) : out
    if (payload != null) fs.writeFileSync(m[1], JSON.stringify(payload))
  }
  const orch = createOrchestrator({
    promptAgent,
    validatePicks: (tier, picks) => validateTierPicks(tier, picks),
    probabilityClaim: (text) => hasProbabilityClaim(text),
    budgetState: budget ? () => budget : null,
    reviewStore,
    metering,
    injector: null, trimmer: null,   // T3 渐进装配（T2 注入段跳过——§7 注记）
    now: nowFn, hhmm: hhmmNow, workDir, log: () => {},
    pollMs: 10, sliceMsOverride: { dataOfficer: 200, strategist: 200, provoker: 200, chair: 200 },
  })
  return { orch, calls, reviewStore, usage, metering, dir, workDir }
}

const runStd = (o, cfg = CFG_ON) => o.runPredict({
  gameKey: 'p3', issue: '26283', tier: 'p3-x1', history: P3_HISTORY, cfg,
  dataPackText: 'L1 近10期流水\nL2 遗漏表\nL3 相似局势 top-3（探索性素材 · 无预测力声明）', tierSpec: TIER_SPEC,
})

test('AC-019 store 两新表：orchestration_log append-only 全记录 + agenda_versions 幂等登记；schema_version 保持 1（factor_proposals 先例）', () => {
  const { reviewStore } = mkOrch()
  // schema_version 保持 1（只加不改不删通道——docs/33 §2.5 store.js 行）
  const sv = reviewStore.db.prepare(`SELECT value FROM schema_info WHERE key='schema_version'`).get()
  assert.equal(Number(sv.value), 1)
  // 编排记录：INSERT-only 落行 + listOrchestration 按 archiveKey 关联（AC-019）
  const r1 = reviewStore.recordOrchestration({ archiveKey: 'p3|26283', role: 'dataOfficer', round: 1, content: '{"snapshot":{}}', agendaVersion: 'm3:v1:aaaaaaaa', callRef: 'p3|26283#dataOfficer-1', at: '2026-10-25T17:31:00.000Z' })
  assert.equal(r1.ok, true)
  reviewStore.recordOrchestration({ archiveKey: 'p3|26283', role: 'strategist', round: 1, content: '{"proposal":{}}', agendaVersion: 'm3:v1:aaaaaaaa', callRef: 'p3|26283#strategist-1-1', at: '2026-10-25T17:35:00.000Z' })
  const rows = reviewStore.listOrchestration('p3|26283')
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map((x) => x.role), ['dataOfficer', 'strategist'])
  assert.equal(rows[0].agendaVersion, 'm3:v1:aaaaaaaa')
  assert.equal(rows[0].callRef, 'p3|26283#dataOfficer-1')
  assert.equal(reviewStore.listOrchestration('ssq|1').length, 0)
  // 缺 archiveKey 拒绝（关联键必填）
  assert.throws(() => reviewStore.recordOrchestration({ role: 'chair' }), /archiveKey/)
  // 议程版本幂等登记：同版本重跑零 diff（INSERT OR IGNORE）
  reviewStore.registerAgendaVersion('m3:v1:aaaaaaaa', 'aaaaaaaa', { at: '2026-10-25T17:30:00.000Z' })
  reviewStore.registerAgendaVersion('m3:v1:aaaaaaaa', 'aaaaaaaa', { at: '2026-10-26T17:30:00.000Z' })
  const vs = reviewStore.listAgendaVersions()
  assert.equal(vs.length, 1, '同版本幂等（重跑登记不重复）')
  assert.equal(vs[0].activatedAt, '2026-10-25T17:30:00.000Z', '首次登记时刻不被覆盖（只加不改）')
  reviewStore.registerAgendaVersion('m3:v1:bbbbbbbb', 'bbbbbbbb')
  assert.equal(reviewStore.listAgendaVersions().length, 2, '改 prompts → 新版本行（AC-019 第二期新版本登记面）')
  assert.throws(() => reviewStore.registerAgendaVersion(''), /版本号/)
})

test('标准档一期 mock 全流程：via=ai 定稿过闸 + orchestration_log 逐角色行 + agenda_versions 登记 + deliberation 计量条目（role/callRef 打标）+ rounds 记录', async () => {
  const { orch, calls, reviewStore, dir } = mkOrch()
  const r = await runStd(orch)
  assert.equal(r.via, 'ai')
  assert.deepEqual(r.picks, { digits: [6, 4, 7] }, '定稿号来自主持人产出且已过 validateTierPicks（FZ-2 复用）')
  assert.equal(r.castTier, 'lite', 'p3 默认 lite 档（P15）')
  assert.equal(r.planTier, 'lite')
  assert.match(r.agendaVersion, /^m3:v\d+:[0-9a-f]{8}$/)
  assert.deepEqual(r.roles, ['dataOfficer', 'strategist', 'chair'])
  assert.deepEqual(r.strippedRoles, [])
  assert.equal(r.confidenceTier, 'mid')
  assert.equal(r.injectionNote ?? null, null, 'T2 无 injector → 注入段跳过零 note（渐进装配）')
  // 调用面：3 角色 × activity=deliberation + 每角色独立会话（拍板 P15：koi-daily-<game>-<issue>-<id>）
  assert.deepEqual(calls.map((c) => c.role), ['dataOfficer', 'strategist', 'chair'])
  assert.ok(calls.every((c) => c.activity === 'deliberation'), '博弈编排全部角色调用 = deliberation 新桶（docs/33 §5.1）')
  assert.deepEqual(calls.map((c) => c.sessionId), ['koi-daily-p3-26283-dataOfficer', 'koi-daily-p3-26283-strategist-1', 'koi-daily-p3-26283-chair'], 'P15 每角色每期独立会话')
  assert.ok(calls.every((c) => c.callRef?.startsWith('p3|26283#')), 'callRef=<archiveKey>#<id>-<round>（计量打标口径）')
  // orchestration_log 全记录（BC-002：append-only 落盘先于开奖核对）
  const rows = reviewStore.listOrchestration('p3|26283')
  assert.equal(rows.length, 3)
  assert.deepEqual(rows.map((x) => x.role), ['dataOfficer', 'strategist', 'chair'])
  assert.ok(rows.every((x) => x.agendaVersion === r.agendaVersion))
  assert.ok(JSON.parse(rows[2].content).picks, '主持人产出全文入档')
  // agenda_versions 登记在位（FR-021）
  assert.equal(reviewStore.listAgendaVersions().length, 1)
  // 计量：deliberation 条目带 role/callRef（T1 weekByRole 分账数据面）
  const entries = readJson(path.join(dir, 'token-usage.json'), null)?.entries ?? []
  assert.equal(entries.length, 3)
  assert.ok(entries.every((e) => e.activity === 'deliberation' && e.role && e.callRef && e.est === true), 'mock 宿主无直采 → path-b est 兜底（诚实标注）')
  // rounds 记录（面板/测试消费面）
  assert.deepEqual(r.rounds.map((x) => x.outcome), ['ok', 'ok', 'ok'])
})

test('AC-021 置信度规格：confidenceTier 非法值钳位 low（BC-007 禁数值置信度）；message 概率宣称 → 打回一次 → 翻案成功（BC-001③ 闸）', async () => {
  const { orch, calls } = mkOrch({
    rolePlan: {
      // PROB_CLAIM_RE（render.js:62）命中结构：「提高…中奖概率」——坏稿 message 触发 BC-001③ 打回
      chair: (text, o, n) => n <= 3
        ? { schemaVersion: 1, issue: '26283', picks: { digits: [6, 4, 7] }, message: '选这组能提高你的中奖概率！', summary: 'x', confidenceTier: 95, cites: [] }   // 概率宣称+数值置信度
        : { schemaVersion: 1, issue: '26283', picks: { digits: [6, 4, 7] }, message: '冷号回补，开奖是随机的图个乐～', summary: 'x', confidenceTier: 'high', cites: [] },
    },
  })
  const r = await runStd(orch)
  assert.equal(r.via, 'ai')
  assert.equal(r.confidenceTier, 'high', '翻案稿合法值在位')
  assert.ok(!hasProbabilityClaim(r.message), '送达 message 零概率宣称（BC-001③）')
  assert.equal(calls.filter((c) => c.role === 'chair').length, 2, '定稿 + 打回重写各一次')
  assert.ok(calls.some((c) => c.callRef?.includes('chair-revise')), '打回调用打标 chair-revise')
})

test('AC-020 硬校验侵蚀：主持人越界号 → 打回 → 仍越界 → via=fallback（不合规号永不送达）；orchestration_log 全程在案', async () => {
  const { orch, reviewStore } = mkOrch({
    rolePlan: {
      chair: () => ({ schemaVersion: 1, issue: '26283', picks: { digits: [99, 4, 7] }, message: 'x', summary: null, confidenceTier: 'low', cites: [] }),
    },
  })
  const r = await runStd(orch)
  assert.equal(r.via, 'fallback')
  assert.equal(r.castTier, 'fallback')
  assert.match(r.skip.reason, /硬校验|概率闸/)
  assert.equal(r.picks, undefined, 'orchestrator 不产出号——兜底号由 scheduler randomTierPicks 单点生成（FZ-2）')
  const rows = reviewStore.listOrchestration('p3|26283')
  assert.ok(rows.length >= 3, '产出+打回重写全程入档（档案如实记录打回）')
  // 越界号永不过闸的直接验证（FZ-2 平行函数零修改的复用面）
  assert.equal(validateTierPicks('p3-x1', { digits: [99, 4, 7] }).ok, false)
})

test('AC-006 降档链：standard 起步档主持人切片超时 → 剔除标记 → 全败降档 lite 重跑 → castTier=lite + strippedRoles=[chair] + 已成功角色产出复用（数据官只调一次）；lite 档全败 → 让位 single（链语义）', async () => {
  // 强制 p3=standard 起步（cfg.cast.tiers 覆盖——AC-026 覆盖面）；chair 第一次 silent（standard 全败）、降 lite 后交卷
  const CFG_STD = { mind: { enabled: true }, roles: { strategists: 1, prompts: {} }, cast: { tiers: { p3: 'standard' } } }
  let chairRuns = 0
  const o2 = mkOrch({ rolePlan: { chair: () => { chairRuns += 1; return chairRuns === 1 ? 'silent' : defaultPayload('chair') } } })
  const r = await o2.orch.runPredict({ gameKey: 'p3', issue: '26283', tier: 'p3-x1', history: P3_HISTORY, cfg: CFG_STD, dataPackText: 'L1\nL2\nL3', tierSpec: TIER_SPEC })
  assert.equal(r.via, 'ai')
  assert.equal(r.castTier, 'lite', 'standard 主持人全败 → 降档 lite 重跑成功（FR-019 主持人不可剔除，其位置由降档承担）')
  assert.equal(r.planTier, 'standard', '计划档=配置档（降档后 castTier 记实际，两 stamp 各记其面——DC-010）')
  assert.deepEqual(r.strippedRoles, ['chair'], 'standard 轮 chair 剔除标记（AC-006 归因分段要求）')
  assert.deepEqual(r.roles, ['dataOfficer', 'strategist', 'chair'])
  // 产出复用：数据官/策略师只调一次（降档重跑不重复烧切片）
  assert.equal(o2.calls.filter((c) => c.role === 'dataOfficer').length, 1, '降档复用已成功产出（standard/lite 的 round1 角色同键）')
  assert.equal(o2.calls.filter((c) => c.role === 'strategist').length, 1)
  assert.equal(o2.calls.filter((c) => c.role === 'chair').length, 2, 'chair 重跑一次（standard 超时 + lite 成功）')
  // orchestration_log 含剔除行（FR-019 如实不静默）
  const rows = o2.reviewStore.listOrchestration('p3|26283')
  assert.ok(rows.some((x) => x.role === 'chair' && String(x.content).includes('超时剔除')), '剔除行如实入档')
  // lite 档（p3 默认）chair 全败 → nextTier('lite')='single' → 编排让位现状 single 路径（§3.1 链语义）
  const o3 = mkOrch({ rolePlan: { chair: 'silent' } })
  const r0 = await runStd(o3.orch)
  assert.equal(r0.via, 'skip')
  assert.equal(r0.skip.code, 'tier-exhausted')
  assert.equal(r0.castTier, 'single')
})

test('AC-006 17:55 硬停：hhmm 注入 17:56 → resolveTier hard-stop → 兜底档零 LLM（角色零调用）；predictAt 晚开彩种同红线', async () => {
  const { orch, calls } = mkOrch({ hhmmNow: () => '17:56' })
  const r = await runStd(orch)
  assert.equal(r.via, 'fallback')
  assert.equal(r.castTier, 'fallback')
  assert.equal(r.skip.code, 'hard-stop')
  assert.equal(calls.length, 0, '硬停线已过 → 立即兜底，零 LLM 调用（17:56 前交付 BC-011）')
})

test('§3.3 cap 短路：allowLLM=false → skip-cap 编排不起跑零 LLM（周级 cap 短路优先于一切会话级编排）', async () => {
  const { orch, calls } = mkOrch({ budget: { totals: { total: 2_000_000 }, demo: { allowLLM: false, level: 'cap' } } })
  const r = await runStd(orch)
  assert.equal(r.via, 'skip')
  assert.equal(r.skip.code, 'cap')
  assert.equal(calls.length, 0, 'cap 态编排零 LLM（scheduler 既有兜底路径零改动——§3.3 矩阵）')
})

// ── scheduler 分流面（条目五 stamp + 双向闸 + B-35 会话）───────────────────────
function mkSched({ cfgPatch = {}, now = new Date('2026-10-25T17:35:00'), mindPrompt } = {}) {
  const dir = tmpdir()
  const configPath = path.join(dir, 'koi.config.json')
  const dataDir = path.join(dir, 'koi')
  const workDir = path.join(dir, 'koi-work')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify({ schemaVersion: 2, ...buildConfigDefaults(), ...cfgPatch }))
  const created = []
  const prompts = []
  let t = now
  const ctx = {
    sessionController: {
      create: async ({ sessionId } = {}) => { created.push(sessionId) },
      prompt: async (req) => {
        const text = req.content[0].text
        prompts.push(text)
        const adv = text.match(/advisory-[\w.-]+\.json/)
        if (adv) { fs.writeFileSync(path.join(workDir, adv[0]), JSON.stringify({ schemaVersion: 1, game: 'p3', date: '2026-10-25', recommendedTier: 'p3-x1', reasonFull: 'x' })); return }
        // 编排交卷（mind prompt 含「交卷文件」+ callRef 角色打标由 promptAgent opts 不经 req——按 prompt 内角色名判定）
        const mindFile = /（交卷文件：(.+?)）/.exec(text)
        if (mindFile && mindPrompt) { mindPrompt(text, mindFile[1]); return }
        const m = text.match(/predict-[\w.-]+\.json/)
        if (m) fs.writeFileSync(path.join(workDir, m[0]), JSON.stringify({ schemaVersion: 1, issue: '0', picks: { digits: [6, 4, 7] }, message: '本锦鲤今天研究心得：冷号在攒劲！开奖是随机的图个乐～', summary: '冷号回补。' }))
      },
    },
  }
  const sched = startKoiScheduler(ctx, {
    dshHome: dir, configPath, dataDir, workDir, log: () => {},
    now: () => t,
    fetch: {
      async fetchHistory(game) {
        return game === 'p3' ? P3_HISTORY : Array.from({ length: 30 }, (_, i) => ({ issue: String(2026121 - i), date: new Date(Date.parse('2026-10-22') - i * 86_400_000).toLocaleDateString('sv-SE'), red: [2, 7, 20, 24, 26, 30], blue: 2 }))
      },
      async fetchLatestDraw() { return { issue: '26283', date: '2026-10-25', digits: [6, 4, 7], prizeGrades: {} } },
    },
  })
  return { sched, dir, dataDir, workDir, created, prompts, setNow: (d) => { t = d } }
}

const waitPreds = async (h, n, ms = 9000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const p = readJson(path.join(h.dataDir, 'predictions.json'), { entries: [] })
    if ((p.entries ?? []).length >= n) return p
    await sleep(100)
  }
  throw new Error('predictions 超时')
}

test('AC-019/021 分流 stamp：mind.enabled=true 定时出号 → 条目五 stamp（castTier/planTier/agendaVersion/confidenceTier/roles）+ 编排角色会话独立（AC-036）', async () => {
  const mindRoleFile = (text, file) => {
    // 按 renderRolePrompt 的【角色】label 精确判定（chair 材料含「数据官/策略师」字样，不能用 includes 泛配）；
    // 打回重写文本（chair-revise）无【角色】行 → 交翻案稿
    const role = text.includes('【角色】数据官') ? 'dataOfficer'
      : text.includes('【角色】策略师') ? 'strategist'
      : text.includes('【角色】主持人') ? 'chair'
      : 'chair'   // 打回重写 → 翻案稿
    fs.writeFileSync(file, JSON.stringify(defaultPayload(role)))
  }
  const h = mkSched({
    cfgPatch: { mind: { enabled: true }, modes: { ssq: { mode: 'off' }, dlt: { mode: 'off' }, p3: { mode: 'auto', tier: 'p3-x1', predictAt: '17:30', gates: { honestyAck: true } } } },
    mindPrompt: mindRoleFile,
  })
  try {
    await h.sched.tick()
    const preds = await waitPreds(h, 1)
    const e = preds.entries[0]
    const issue = String(e.issue)
    assert.equal(e.via, 'ai')
    assert.equal(e.castTier, 'lite', 'p3 默认 lite（stamp 记实际档位）')
    assert.equal(e.planTier, 'lite')
    assert.match(e.agendaVersion, /^m3:v\d+:[0-9a-f]{8}$/)
    assert.ok(['low', 'mid', 'high'].includes(e.confidenceTier), 'confidenceTier ∈ {low,mid,high}（BC-007）')
    assert.deepEqual(e.roles, ['dataOfficer', 'strategist', 'chair'])
    assert.equal(e.strippedRoles, undefined)
    // AC-036：编排角色会话独立（koi-daily-p3-<issue>-<id>）；koi-lottery 闲聊通道调用面不变（advisory/narrate 仍用它）
    assert.ok(h.created.includes(`koi-daily-p3-${issue}-dataOfficer`), 'P15 角色会话（id 含期号）')
    assert.ok(h.created.includes(`koi-daily-p3-${issue}-chair`), 'P15 角色会话（chair 独立）')
    // 计量：编排调用入 deliberation 桶（weekByRole 分账数据面）
    const totals = h.sched.mind.metering.weekByRole()
    assert.ok(totals.total > 0, '编排计量落账')
    assert.ok(totals.byRole.chair?.tokens > 0, 'chair 角色分账在位')
  } finally { h.sched.stop() }
})

test('mind.enabled=false 双向闸：定时出号走 single 现状路径（条目零编排新字段逐位）+ 每期新会话 koi-daily-<game>-<issue>（B-35）；quickpick 留 koi-lottery（FR-054）', async () => {
  const h = mkSched({
    cfgPatch: { mind: { enabled: false }, modes: { ssq: { mode: 'off' }, dlt: { mode: 'off' }, p3: { mode: 'auto', tier: 'p3-x1', predictAt: '17:30', gates: { honestyAck: true } } } },
  })
  try {
    await h.sched.tick()
    const preds = await waitPreds(h, 1)
    const e = preds.entries[0]
    assert.equal(e.via, 'ai')
    // 双向闸：单 Agent 路径条目零编排新字段（与现状逐位一致——AC-008）
    assert.equal(e.castTier, undefined)
    assert.equal(e.planTier, undefined)
    assert.equal(e.agendaVersion, undefined)
    assert.equal(e.confidenceTier, undefined)
    assert.equal(e.roles, undefined)
    // B-35：无论 mind.enabled，定时出号每期新开会话 koi-daily-<game>-<issue>（无 role 后缀）
    const issue = String(e.issue)
    assert.ok(h.created.includes(`koi-daily-p3-${issue}`), 'single 档定时出号新会话（B-35）')
    // quickpick（加餐）留 koi-lottery 常驻（FR-054）
    const r = h.sched.quickpick('p3')
    for (let i = 0; i < 50; i++) { await sleep(100); const j = h.sched.qpJob(r.id); if (j.status !== 'running') break }
    assert.ok(!h.created.some((s) => s?.startsWith('koi-daily-') && h.created.indexOf(s) > h.created.indexOf('koi-daily-p3-26283')), 'quickpick 零新编排会话')
    assert.equal(readJson(path.join(h.dataDir, 'predictions.json')).entries.filter((x) => x.kind === 'quickpick').length, 1, '加餐条目照常（现状路径）')
  } finally { h.sched.stop() }
})

test('AC-036 连续两期：定时出号会话 id 相互独立（第二期新会话——上下文结构性隔离）', async () => {
  const h = mkSched({
    cfgPatch: { mind: { enabled: false }, modes: { ssq: { mode: 'off' }, dlt: { mode: 'off' }, p3: { mode: 'auto', tier: 'p3-x1', predictAt: '17:30', gates: { honestyAck: true } } } },
  })
  try {
    await h.sched.tick()
    const p1 = await waitPreds(h, 1)
    const issue1 = String(p1.entries[0].issue)
    // 第二期前置：对账段（22:00）生产中会把当期开奖 upsert 进本地库——测试直接补一笔
    // （模拟 BC-105 抓过即入库后的最新期在位），nextIssue 纯 +1（draws.js:155）→ 期号递增
    h.sched.drawstore.upsert('p3', { issue: String(Number(issue1) + 1), date: '2026-10-25', digits: [1, 2, 3] })
    h.setNow(new Date('2026-10-26T17:35:00'))
    await h.sched.tick()
    const p2 = await waitPreds(h, 2)
    const issue2 = String(p2.entries.map((x) => x.issue).sort().slice(-1)[0])
    assert.notEqual(issue1, issue2, '两期期号递增（p3 每日开奖）')
    assert.ok(h.created.includes(`koi-daily-p3-${issue1}`), '第一期会话（id 含期号）')
    assert.ok(h.created.includes(`koi-daily-p3-${issue2}`), '第二期会话（id 含期号）')
    assert.notEqual(h.created.indexOf(`koi-daily-p3-${issue1}`), h.created.indexOf(`koi-daily-p3-${issue2}`), '第二期会话 ≠ 第一期（新会话结构性保证——上下文隔离）')
  } finally { h.sched.stop() }
})
