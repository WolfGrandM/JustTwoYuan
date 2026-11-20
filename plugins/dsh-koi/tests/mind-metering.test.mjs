/**
 * M3-T1 计量路径 A（docs/33 §6.2 四组断言 + §7 T1 验收）。
 *
 * ① mock usage 直采分账与手算一致（TokenUsage 互斥口径样本 → promptTokens=三者和、
 *    completionTokens、cache 分项原样、est:false）；
 * ② 三通道 feature-detect 矩阵（stream×turnReplay×tokenMeter 8 组合）→ modeOf 与记账来源
 *    断言（全败 → path-b + est:true）；
 * ③ 角色分账：四角色 mock 各 N step → weekByRole() 逐角色合计与手算一致、deliberation 桶
 *    并入 totals.total（categories.deliberation 分项判定触发面随 T4 budgetState 扩展交付——
 *    docs/33 §7 T4 行，本文件只测 usage/weekByRole 记账层）；
 * ④ deriveTurnTokenUsage 返回 undefined（模拟 cancelled turn）→ 已记条目改标 est:true 重估
 *    （路径 B 兜底覆盖率计数器 +1）。
 *
 * 附：path-b 定额记账、tokenMeter 闸门（H3 只预判不记账）、scheduler 装配面（探测结论落
 * log + 未打标调用面 est 恒标现状回归）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMetering, normalizeTokenUsage, pathBQuota, PATH_B_QUOTA, KOI_SESSION_PREFIX } from '../lib/mind/metering.js'
import { createUsageTracker, estTokens } from '../lib/usage.js'
import { startKoiScheduler } from '../lib/scheduler.js'
import { buildConfigDefaults } from '../lib/config.js'
import { readJson } from '../lib/io.js'

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'koi-metering-'))
const NOW = () => new Date('2026-11-21T12:00:00')

/** 互斥口径样本（Spike §1.5：uncachedInputTokens/outputTokens/cacheReadTokens/cacheWriteTokens） */
const SAMPLE = { uncachedInputTokens: 100, outputTokens: 50, cacheReadTokens: 200, cacheWriteTokens: 30 }

function mk({ ctx = null, deriveTurn = null } = {}) {
  const dir = tmpdir()
  const usage = createUsageTracker({ dataDir: dir, now: NOW })
  const logs = []
  const metering = createMetering({ ctx, usage, now: NOW, log: (m) => logs.push(m), deriveTurn })
  return { dir, usage, metering, logs }
}

const readEntries = (dir) => readJson(path.join(dir, 'token-usage.json'), null)?.entries ?? []

// ── ① path-a 直采分账与手算一致 ─────────────────────────────────────────────────
test('① path-a 直采分账：互斥口径样本 → promptTokens=三者和/completionTokens/cache 分项原样/est:false，与手算一致', () => {
  const { dir, usage, metering } = mk({ ctx: { on: () => {} } })
  metering.attachHostListeners()
  const r = metering.recordStep({
    activity: 'deliberation', role: 'dataOfficer', callRef: 'ssq|2026132#dataOfficer-1',
    usage: SAMPLE, promptText: 'x',
  })
  // 手算（Spike §3-4 口径）：promptTokens = uncached 100 + cacheRead 200 + cacheWrite 30 = 330
  assert.equal(r.mode, 'path-a')
  assert.equal(r.est, false)
  assert.equal(r.promptTokens, 330)
  assert.equal(r.completionTokens, 50)
  assert.equal(r.tokens, 380)
  const e = readEntries(dir)[0]
  assert.equal(e.activity, 'deliberation')
  assert.equal(e.role, 'dataOfficer')
  assert.equal(e.callRef, 'ssq|2026132#dataOfficer-1')
  assert.equal(e.est, false)
  assert.equal(e.promptTokens, 330)
  assert.equal(e.completionTokens, 50)
  assert.equal(e.cacheReadTokens, 200, 'cache 分项原样（互斥口径）')
  assert.equal(e.cacheWriteTokens, 30, 'cache 分项原样（互斥口径）')
  assert.equal(e.tokens, 380)
  assert.equal(usage.weekTotals().deliberation, 380)
})

test('①b 流通道（H1）帧命中：attachHostListeners 后 recordStep 按 sessionId 消费终帧直采（scope 过滤 koi-daily- 前缀）', () => {
  const handlers = {}
  const ctx = { on: (ev, fn) => { (handlers[ev] ??= []).push(fn) } }
  const { dir, metering } = mk({ ctx })
  metering.attachHostListeners()
  // 模拟宿主流终帧：koi 编排会话（前缀命中）携带内嵌 usage；其他会话帧不消费
  const frame = (sid, usage) => ({ session: { id: sid }, message: { usage } })
  for (const fn of handlers['agent/assistant-stream'] ?? []) {
    fn(frame('koi-daily-ssq-2026132', SAMPLE))
    fn(frame('koi-lottery', { uncachedInputTokens: 9999, outputTokens: 9999 }))
  }
  const r = metering.recordStep({ activity: 'deliberation', role: 'chair', sessionId: 'koi-daily-ssq-2026132', promptText: 'x' })
  assert.equal(r.mode, 'path-a', 'scope 命中 → path-a 直采')
  assert.equal(r.promptTokens, 330)
  assert.equal(r.completionTokens, 50)
  assert.equal(readEntries(dir).length, 1, 'koi-lottery 帧不入账（scope 过滤）')
  // 取走即清：再次消费无帧 → path-b
  const r2 = metering.recordStep({ activity: 'deliberation', role: 'chair', sessionId: 'koi-daily-ssq-2026132', promptText: 'abcd' })
  assert.equal(r2.mode, 'path-b')
})

// ── ② feature-detect 降级矩阵 ──────────────────────────────────────────────────
test('② feature-detect 8 组合矩阵：stream/turnReplay 任一在位 → path-a；全败 → path-b + est:true 记账', () => {
  // 8 组合：stream × turnReplay × tokenMeter
  const mkCtx = (stream, tokenMeter) => {
    if (!stream && !tokenMeter) return null
    const ctx = {}
    if (stream) ctx.on = () => {}
    if (tokenMeter) ctx.tokenMeter = { measure: () => ({ pressure: 0.1 }) }
    return ctx
  }
  const mkDerive = (turnReplay) => (turnReplay ? () => SAMPLE : null)
  for (const stream of [true, false]) {
    for (const turnReplay of [true, false]) {
      for (const tokenMeter of [true, false]) {
        const { metering } = mk({ ctx: mkCtx(stream, tokenMeter), deriveTurn: mkDerive(turnReplay) })
        const probe = metering.attachHostListeners()
        assert.equal(probe.channels.stream, stream)
        assert.equal(probe.channels.turnReplay, turnReplay)
        assert.equal(probe.channels.tokenMeter, tokenMeter)
        const wantMode = (stream || turnReplay) ? 'path-a' : 'path-b'
        assert.equal(probe.mode, wantMode, `stream=${stream} turnReplay=${turnReplay} → ${wantMode}`)
        assert.equal(metering.modeOf(), wantMode)
        // 记账来源：无直采帧/无 stepUsage 的裸 step → 实时记账一律 path-b est 兜底
        // （通道在位 ≠ 帧命中：path-a 实时记账以帧命中为准——①b 覆盖；turnReplay 仅作收口对账不作实时源）
        const r = metering.recordStep({ activity: 'deliberation', role: 'strategist', promptText: 'x' })
        assert.equal(r.mode, 'path-b', `stream=${stream} turnReplay=${turnReplay} 无帧裸 step → path-b 兜底`)
        assert.equal(r.est, true)
      }
    }
  }
})

test('②b 全败降级：ctx=null（无宿主）→ path-b + est:true + promptTokens=chars/4 + completionTokens=定额表', () => {
  const { dir, metering } = mk({ ctx: null })
  const probe = metering.attachHostListeners()
  assert.equal(probe.mode, 'path-b')
  const text = 'abcdefgh'   // 8 chars → estTokens = 2
  const r = metering.recordStep({ activity: 'deliberation', role: 'provoker', promptText: text })
  const q = pathBQuota({ activity: 'deliberation' })
  assert.equal(r.mode, 'path-b')
  assert.equal(r.est, true)
  assert.equal(r.promptTokens, 2)
  assert.equal(r.completionTokens, q.out)
  const e = readEntries(dir)[0]
  assert.equal(e.est, true, 'path-b 条目 est:true 如实标注（BC-013③）')
  assert.equal(e.tokens, 2 + q.out)
  assert.equal(metering.pathBSteps(), 1, '覆盖率计数器 +1')
})

test('②c 定额表：activity 桶定额 > default；pathBQuota basis 断言（FR-047 首月回填位 byModel 覆盖）', () => {
  assert.deepEqual(PATH_B_QUOTA.byModel, {}, 'byModel 留空（FR-047 首月与账单对账后回填——诚实起步不拍脑袋）')
  const cases = [
    ['predict', PATH_B_QUOTA.byActivity.predict],
    ['deliberation', PATH_B_QUOTA.byActivity.deliberation],
    ['advisory', PATH_B_QUOTA.byActivity.advisory],
    ['unknown-act', PATH_B_QUOTA.defaultOut],
  ]
  for (const [act, want] of cases) assert.equal(pathBQuota({ activity: act }).out, want)
  assert.equal(pathBQuota({ activity: 'unknown-act' }).basis, 'default')
  assert.equal(pathBQuota({ activity: 'advisory' }).basis, 'activity')
  assert.equal(pathBQuota({ activity: 'deliberation', model: 'deepseek-chat' }).basis, 'activity', 'byModel 留空（FR-047 首月回填）→ activity 桶生效')
})

// ── ③ 角色分账 ────────────────────────────────────────────────────────────────
test('③ 角色分账：四角色 mock 各 N step → weekByRole 逐角色合计与手算一致；deliberation 桶并入 totals.total', () => {
  const { dir, usage, metering } = mk({ ctx: { on: () => {} } })
  metering.attachHostListeners()
  // dataOfficer 2 step / strategist 3 step / provoker 1 step / chair 2 step（部分 path-a、部分 path-b）
  metering.recordStep({ activity: 'deliberation', role: 'dataOfficer', callRef: 'a#dataOfficer-1', usage: SAMPLE })
  metering.recordStep({ activity: 'deliberation', role: 'dataOfficer', callRef: 'a#dataOfficer-2', promptText: '12345678' })   // 2+600 path-b
  for (let i = 1; i <= 3; i++) metering.recordStep({ activity: 'deliberation', role: 'strategist', callRef: `a#strategist-${i}`, usage: SAMPLE })
  metering.recordStep({ activity: 'deliberation', role: 'provoker', callRef: 'a#provoker-1', promptText: 'x' })   // 1+200? 定额 deliberation=600 → 1+600
  metering.recordStep({ activity: 'deliberation', role: 'chair', callRef: 'a#chair-1', usage: SAMPLE })
  metering.recordStep({ activity: 'deliberation', role: 'chair', callRef: 'a#chair-2', promptText: 'x' })
  const byRole = metering.weekByRole()
  // 手算：path-a step = 380；path-b dataOfficer = estTokens('12345678')=2 + 600 = 602；provoker = 1+600 = 601；chair path-b = 1+600 = 601
  assert.equal(byRole.byRole.dataOfficer.tokens, 380 + 602)
  assert.equal(byRole.byRole.dataOfficer.steps, 2)
  assert.equal(byRole.byRole.dataOfficer.estSteps, 1, 'est 条目计数（诚实披露 est 占比）')
  assert.equal(byRole.byRole.strategist.tokens, 380 * 3)
  assert.equal(byRole.byRole.strategist.steps, 3)
  assert.equal(byRole.byRole.provoker.tokens, 601)
  assert.equal(byRole.byRole.chair.tokens, 380 + 601)
  // deliberation 桶并入 totals.total（budgetState 硬顶判定覆盖全部活动——BC-013 口径）
  const totals = usage.weekTotals()
  assert.equal(totals.deliberation, 380 + 602 + 380 * 3 + 601 + 380 + 601)
  assert.equal(totals.total, totals.deliberation, '本周只有 deliberation 条目 → total=deliberation')
  // weekByRole.total 与 weekTotals.total 同源一致
  assert.equal(byRole.total, totals.total)
})

// ── ④ turn 收口对账（cancelled turn 兜底）─────────────────────────────────────
test('④ cancelled turn：deriveTurnTokenUsage 返回 undefined → 已记 path-a 条目改标 est:true 重估 + 覆盖率计数器 +1', () => {
  const { dir, usage, metering } = mk({ ctx: null, deriveTurn: () => undefined })   // H2 在位但 turn 缺 usage
  metering.attachHostListeners()
  const r = metering.recordStep({
    activity: 'deliberation', role: 'strategist', callRef: 'ssq|2026132#strategist-1',
    usage: SAMPLE, promptText: 'seed',   // stream 缺失 → 实际上这条会走 path-b？不对：usage 显式传入 → path-a
  })
  assert.equal(r.mode, 'path-a', '显式直采在位 → path-a 落账')
  const before = readEntries(dir).find((e) => e.callRef === 'ssq|2026132#strategist-1')
  assert.equal(before.est, false)
  const pathB0 = metering.pathBSteps()
  const rec = metering.reconcileTurn({ callRef: 'ssq|2026132#strategist-1', events: null, promptText: 'seed', role: 'strategist' })
  assert.equal(rec.ok, true)
  assert.equal(rec.mode, 'path-b')
  assert.equal(rec.revised, true, '条目改标发生')
  assert.equal(metering.pathBSteps(), pathB0 + 1, '路径 B 兜底覆盖率计数器 +1（FR-047 统计输入）')
  const after = readEntries(dir).find((e) => e.callRef === 'ssq|2026132#strategist-1')
  assert.equal(after.est, true, '改标 est:true（宁缺毋假——cancelled turn 不留假实测账）')
  assert.equal(after.completionTokens, pathBQuota({ activity: 'deliberation' }).out, '按定额重估输出')
  assert.equal(after.promptTokens, 330, 'prompt 分项保留（直采的输入侧可信部分不抹）')
  assert.equal(after.tokens, 330 + pathBQuota({ activity: 'deliberation' }).out, 'tokens 重算')
})

test('④b turn 收口对账：H2 在位且 usage 在 → path-a 记账为准；H2 通道不可达 → 如实跳过不改标', () => {
  const { metering, usage } = mk({ ctx: null, deriveTurn: () => SAMPLE })
  metering.attachHostListeners()
  metering.recordStep({ activity: 'deliberation', role: 'chair', callRef: 'x#chair-1', usage: SAMPLE })
  const rec = metering.reconcileTurn({ callRef: 'x#chair-1' })
  assert.equal(rec.ok, true)
  assert.equal(rec.mode, 'path-a')
  assert.equal(rec.usage.promptTokens, 330)
  const { metering: m2 } = mk({ ctx: null })   // deriveTurn 缺省 null = H2 不可达
  m2.attachHostListeners()
  const rec2 = m2.reconcileTurn({ callRef: 'x#chair-1' })
  assert.deepEqual(rec2, { ok: false, reason: 'turn-replay-unavailable' })
})

// ── H3 tokenMeter 闸门 ────────────────────────────────────────────────────────
test('H3 闸门：tokenMeter.measure 在位 → 透传（只预判不记账）；缺席/抛错 → null 静默跳过', () => {
  const seen = []
  const { metering } = mk({ ctx: { tokenMeter: { measure: (s) => { seen.push(s); return { pressure: 0.42 } } } } })
  metering.attachHostListeners()
  assert.equal(metering.gate('koi-daily-ssq-2026132').pressure, 0.42)
  assert.deepEqual(seen, ['koi-daily-ssq-2026132'])
  assert.equal(metering.gate(null) != null, true, 'measure 仍被调用（透传语义），闸门判定归调用方')
  const { metering: m2 } = mk({ ctx: { tokenMeter: { measure: () => { throw new Error('boom') } } } })
  m2.attachHostListeners()
  assert.equal(m2.gate('s'), null, 'measure 抛错 → null（闸门静默跳过，记账不受影响）')
  const { metering: m3 } = mk({ ctx: null })
  m3.attachHostListeners()
  assert.equal(m3.gate('s'), null, 'H3 缺席 → 恒 null')
})

// ── normalizeTokenUsage 边界 ──────────────────────────────────────────────────
test('normalizeTokenUsage 边界：全零/缺字段/非对象 → null（宁缺毋假不虚构记账）；别名键容忍', () => {
  assert.equal(normalizeTokenUsage(null), null)
  assert.equal(normalizeTokenUsage('x'), null)
  assert.equal(normalizeTokenUsage({}), null)
  assert.equal(normalizeTokenUsage({ uncachedInputTokens: 0, outputTokens: 0 }), null, '全零 → null')
  assert.equal(normalizeTokenUsage({ outputTokens: 50 }), null, '缺输入口径 → null')
  const n = normalizeTokenUsage({ inputTokens: 100, outputTokens: 50 })   // 别名键容忍
  assert.equal(n.promptTokens, 100)
  assert.equal(n.completionTokens, 50)
})

// ── scheduler 装配面 ──────────────────────────────────────────────────────────
test('scheduler 装配：mind.metering 在位 + meteringStatus 披露 + 探测结论落 log + 未打标调用面 est 恒标现状回归', async () => {
  const dir = tmpdir()
  const configPath = path.join(dir, 'koi.config.json')
  const dataDir = path.join(dir, 'koi')
  const workDir = path.join(dir, 'koi-work')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify({ schemaVersion: 2, ...buildConfigDefaults() }))
  const logs = []
  const created = []
  const ctx = {
    sessionController: {
      create: async ({ sessionId }) => { created.push(sessionId) },
      prompt: async (req) => {   // 单 agent 交卷契约：写 predict 文件（模拟她写结果文件）
        const m = req.content[0].text.match(/predict-[\w.-]+\.json/)
        if (!m) return
        fs.writeFileSync(path.join(workDir, m[0]), JSON.stringify({
          schemaVersion: 1, picks: { digits: [6, 4, 7] }, message: 'x', summary: '冷号回补。',
        }))
      },
    },
  }
  const sched = startKoiScheduler(ctx, {
    dshHome: dir, configPath, dataDir, workDir,
    log: (m) => logs.push(m),
    now: NOW,
    fetch: {
      fetchHistory: async () => Array.from({ length: 30 }, (_, i) => ({
        issue: String(26282 - i), date: '2026-10-2' + (3 - Math.floor(i / 10)), digits: [i % 10, 4, 7],
      })),
      fetchLatestDraw: async () => ({ issue: '26283', date: '2026-10-25', digits: [6, 4, 7] }),
    },
  })
  try {
    // 装配面：mind.metering 在位；meteringStatus 诚实披露（mock ctx 无 on → path-b）
    assert.ok(sched.mind?.metering, 'mind.metering 装配在位')
    assert.equal(sched.mind.sessionPrefix, KOI_SESSION_PREFIX)
    const ms = sched.mind.meteringStatus()
    assert.deepEqual(ms.channels, { stream: false, turnReplay: false, tokenMeter: false })
    assert.equal(ms.mode, 'path-b')
    // 探测结论如实落 log（T1 验收）
    assert.ok(logs.some((m) => m.includes('M3 计量探测') && m.includes('stream=false') && m.includes('path-b')), '探测结论如实落 log')
    // 未打标调用面（现状单 agent predict 桶）：est 恒标现状口径逐位不变——
    // quickpick 走 runPredictFlow→promptAgent（无 role/callRef）→ predict 条目 est:true 无 role
    const r = sched.quickpick('p3')
    let job = sched.qpJob(r.id)
    for (let i = 0; i < 50 && job.status === 'running'; i++) { await new Promise((res) => setTimeout(res, 100)); job = sched.qpJob(r.id) }
    assert.equal(job.status, 'done')
    const entries = readJson(path.join(dataDir, 'token-usage.json'), null)?.entries ?? []
    assert.ok(entries.length >= 1)
    assert.equal(entries[0].activity, 'predict')
    assert.equal(entries[0].est, true, '未打标调用面 est 恒标（现状口径逐位不变）')
    assert.equal(entries[0].role, undefined, '未打标条目零 role 字段（旧条目缺字段容忍口径）')
    assert.equal(entries[0].callRef, undefined, '未打标条目零 callRef 字段')
  } finally { sched.stop() }
})
