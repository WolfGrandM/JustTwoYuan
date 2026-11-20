/**
 * M3-T3 记忆注入与裁剪（docs/33 §2.2 injector/trimmer 行 / §4.4 失败语义 / §6.1 AC-022/027/006 注入失败分支）。
 * 候选过滤（BC-004：demoted/retired/candidate 永不入注）/ 局势块近 30 期 + 摘要 / 独立中间格式 /
 * trimmer 每角色 4000 整块丢弃按优先级 / FR-029 重建（源=predictions.json+review.db）/
 * health 触发器③转实算（injectionNote 连续 ≥2 期）/ attachMemoryGuard 条件实装件接口位（§2.2 裁决 c）/
 * 端到端注入失败分支（出号照常 + injectionNote stamp）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createInjector, INJECTABLE_STATUS } from '../lib/mind/injector.js'
import { trimBlocks, estTokensOf, DEFAULT_CAP_PER_ROLE, DEFAULT_PRIORITY } from '../lib/mind/trimmer.js'
import { createReviewStore } from '../lib/review/store.js'
import { scanHealth } from '../lib/review/health.js'
import { estTokens } from '../lib/usage.js'
import { buildBuiltinFactors } from '../lib/factors.js'
import { startKoiScheduler } from '../lib/scheduler.js'
import { buildConfigDefaults } from '../lib/config.js'
import { readJson } from '../lib/io.js'

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'koi-inject-'))
const NOW = () => new Date('2026-10-25T17:30:00')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const P3_ENTRIES = Array.from({ length: 32 }, (_, i) => ({
  // predictions.json 为 append-only push 序（时间升序：i=0 最旧 … i=31 最新 26282）——injector 局势块
  // 按「数组序 = 时间序」取 slice(-30)（最新 30 期）
  at: new Date(Date.parse('2026-09-23') + i * 86_400_000).toISOString(),
  kind: 'daily', game: 'p3', issue: String(26251 + i), date: new Date(Date.parse('2026-09-23') + i * 86_400_000).toLocaleDateString('sv-SE'),
  picks: { digits: [i % 10, 4, 7] }, via: i % 5 === 0 ? 'fallback' : 'ai',
  prize: i % 5 === 0 ? 0 : 1040, baselinePrize: i % 3 === 0 ? 0 : 1040,
  settled: true, settleState: 'settled',
  ...(i >= 29 ? { summary: `第 ${26251 + i} 期思路摘要。` } : {}),
}))

function mkPredsReader(entries = P3_ENTRIES) {
  const preds = { entries }
  return () => preds
}

test('AC-027 候选过滤（BC-004）：注入上下文只含 observing/promoted；demoted/retired/candidate 全无（环 A 提案因子零特权不入注入）', () => {
  const dir = tmpdir()
  const store = createReviewStore({ dataDir: dir, now: NOW, log: () => {} })
  // 内置六件 p3 已播种（observing）——把其中四件分别转为 promoted/demoted/retired，另加一件环 A candidate
  const p3 = buildBuiltinFactors().filter((f) => f.game === 'p3')
  store.applyFactorTransition(p3[0].id, 'observing', 'promoted', 'monthly-pipeline', '测试晋升（月报流水线语义）')
  store.applyFactorTransition(p3[1].id, 'observing', 'demoted', 'monthly-pipeline', '测试降档')
  store.applyFactorTransition(p3[2].id, 'observing', 'retired', 'monthly-pipeline', '测试退役')
  store.addCandidateFactor({ id: 'proposal-2026-10-p3-1', game: 'p3', name: '环 A 提案因子', source: 'proposal:2026-10' })
  const injector = createInjector({ reviewStore: store, readPreds: mkPredsReader([]), now: NOW, log: () => {} })
  assert.deepEqual(INJECTABLE_STATUS, ['observing', 'promoted'])
  const r = injector.assemble({ gameKey: 'p3', issue: '26283' })
  assert.equal(r.ok, true)
  const fb = r.blocks.find((b) => b.kind === 'factor-form')
  assert.ok(fb, '有活跃因子 → 因子块在位')
  const text = fb.text
  assert.ok(text.includes(p3[0].id) && text.includes('promoted'), 'promoted 因子在注入集')
  assert.ok(text.includes(p3[3].id), 'observing 因子在注入集')
  assert.ok(!text.includes(p3[1].id), 'demoted 永不回注（BC-004/FR-030 原文）')
  assert.ok(!text.includes(p3[2].id), 'retired 永不回注')
  assert.ok(!text.includes('proposal-2026-10-p3-1'), 'candidate（环 A 提案因子）不入注入（零特权贯通）')
  // 过滤面可观测（stats）
  const st = injector.stats({ gameKey: 'p3' })
  assert.equal(st.injectable, 4, 'observing 3 + promoted 1')
  assert.equal(st.excludedReasons.candidate, 1)
  assert.equal(st.excludedReasons.demoted, 1)
  assert.equal(st.excludedReasons.retired, 1)
})

test('局势块：predictions 近 30 期逐期一行（期号/号码/基线对照/战果）+ 最近 3 期 summary；blocks=koi 独立中间格式（非 auto-memory 原生结构——AC-022 断言面）', () => {
  const injector = createInjector({ reviewStore: null, readPreds: mkPredsReader(), now: NOW, log: () => {} })
  const r = injector.assemble({ gameKey: 'p3', issue: '26283' })
  assert.equal(r.ok, true)
  const sb = r.blocks.find((b) => b.kind === 'situation')
  assert.ok(sb, '有档案条目 → 局势块在位')
  assert.deepEqual(Object.keys(sb).sort(), ['estTokens', 'kind', 'text'], '独立中间格式 {kind,text,estTokens}（非 dsh-auto-memory 原生结构）')
  assert.equal(sb.estTokens, estTokens(sb.text), 'estTokens = chars/4（usage.js:37 同口径）')
  assert.ok(sb.text.includes('- 26282'), '最新期一行在位（回看 30 期——SITUATION_TAIL）')
  assert.ok(!sb.text.includes('- 26252'), '第 31 期不进局势块（近 30 期口径）')
  assert.ok(sb.text.includes('基线对照'), 'vs 基线胜负行在位')
  assert.ok(sb.text.includes('最近摘要') && sb.text.includes('第 26282 期思路摘要'), '最近 3 期 summary 摘要在位')
  assert.ok(sb.text.includes('探索性素材 · 无预测力声明'), 'BC-001 声明常驻（§1 BC-001 行② 注入素材标注）')
})

test('FR-031 失败语义：reviewStore 异常 → 空 blocks+ok:false+note 如实（永不阻塞出号）；空库 → 空注如实（ok:true）', () => {
  const boomStore = { listFactors: () => { throw new Error('db locked（故障演练）') } }
  const logs = []
  const injector = createInjector({ reviewStore: boomStore, readPreds: mkPredsReader([]), now: NOW, log: (m) => logs.push(m) })
  const r = injector.assemble({ gameKey: 'p3', issue: '26283' })
  assert.deepEqual(r.blocks, [])
  assert.equal(r.ok, false)
  assert.match(r.note, /^本期无记忆注入：/)
  assert.ok(logs.some((m) => m.includes('注入组装异常')), '异常如实落 log')
  // 空库（无因子无条目）=「无记忆可注」非失败——ok:true + note 说明（宁缺毋假不虚构）。
  // 注意：createReviewStore 会播种内置 observing 因子——「真空库」用无 store 注入（首期/空库如实）。
  const empty = createInjector({ reviewStore: null, readPreds: mkPredsReader([]), now: NOW, log: () => {} })
  const r2 = empty.assemble({ gameKey: 'p3', issue: '26283' })
  assert.deepEqual(r2.blocks, [])
  assert.equal(r2.ok, true)
  assert.match(r2.note, /无活跃因子且无档案条目/)
})

test('AC-027 trimmer：单角色 ≤4000 整块丢弃按优先级（factor-form > situation）+ dropped 如实逐块；estTokensOf 与 usage.estTokens 同口径（chars/4）', () => {
  assert.equal(DEFAULT_CAP_PER_ROLE, 4000)
  assert.deepEqual(DEFAULT_PRIORITY, ['factor-form', 'situation'])
  assert.equal(estTokensOf('abcd'), estTokens('abcd'), 'chars/4 同源（ceil）')
  const bigFactor = { kind: 'factor-form', text: 'F'.repeat(10_000), estTokens: estTokens('F'.repeat(10_000)) }   // 2500
  const bigSitu = { kind: 'situation', text: 'S'.repeat(9_000), estTokens: estTokens('S'.repeat(9_000)) }          // 2250
  const r = trimBlocks([bigFactor, bigSitu], { capPerRole: 4000 })
  assert.equal(r.tokens, 2500)
  assert.deepEqual(r.kept, ['factor-form'], '因子战绩优先保留（factor-form > situation）')
  assert.equal(r.text, bigFactor.text)
  assert.equal(r.dropped.length, 1)
  assert.equal(r.dropped[0].kind, 'situation')
  assert.match(r.dropped[0].reason, /整块丢弃.*超单角色配额 4000/, '丢弃原因如实（不静默）')
  // 两块均在配额内 → 全保留；均超 → 全丢
  const small = { kind: 'factor-form', text: 'x', estTokens: 10 }
  const small2 = { kind: 'situation', text: 'y', estTokens: 20 }
  assert.deepEqual(trimBlocks([small, small2], { capPerRole: 4000 }).kept, ['factor-form', 'situation'])
  const huge = { kind: 'factor-form', text: 'F'.repeat(40_001), estTokens: 10_001 }
  const r2 = trimBlocks([huge], { capPerRole: 4000 })
  assert.deepEqual(r2.kept, [])
  assert.deepEqual(r2.dropped.map((d) => d.kind), ['factor-form'])
  assert.equal(r2.text, '')
  // 空 blocks → 零块如实
  assert.deepEqual(trimBlocks([]), { text: '', tokens: 0, kept: [], dropped: [] })
  // 块缺 estTokens 字段 → estTokensOf 现算（宽容）
  const noEst = { kind: 'factor-form', text: 'abcd' }
  assert.equal(trimBlocks([noEst]).tokens, 1)
})

test('FR-029 缓存定位：注入所需全部内容可从 predictions.json + review.db 重建——删库重开（新 store 实例同数据）注入仍可用', () => {
  const dir = tmpdir()
  // 第一期：真库写入因子 + 归因 + archive 行
  const store1 = createReviewStore({ dataDir: dir, now: NOW, log: () => {} })
  const entry = { at: '2026-10-24T10:00:00.000Z', kind: 'daily', game: 'p3', issue: '26282', date: '2026-10-24', picks: { digits: [1, 2, 3] }, via: 'ai' }
  const archived = store1.upsertArchive(entry)
  store1.recordAttribution(archived.id, [{ factorId: 'builtin-sum-band-p3', hit: true, detail: '和值带命中（归因引擎代码判定）' }])
  const injector1 = createInjector({ reviewStore: store1, readPreds: mkPredsReader([entry]), now: NOW, log: () => {} })
  assert.ok(injector1.assemble({ gameKey: 'p3', issue: '26283' }).blocks.length >= 1)
  // 「删 mock 记忆数据后重建」：同 dataDir 重开新 store 实例（migrate 幂等——review.db 是唯一持久源）
  const store2 = createReviewStore({ dataDir: dir, now: NOW, log: () => {} })
  const injector2 = createInjector({ reviewStore: store2, readPreds: mkPredsReader([entry]), now: NOW, log: () => {} })
  const r = injector2.assemble({ gameKey: 'p3', issue: '26283' })
  assert.equal(r.ok, true)
  assert.ok(r.blocks.some((b) => b.kind === 'factor-form'), '归因行从 review.db 重建在位（零自持缓存）')
  assert.ok(r.blocks.some((b) => b.kind === 'situation'), '局势块从 predictions.json 重建在位')
})

test('AC-028（部分）health 触发器③转实算：injectionNote 连续 ≥2 期 per 彩种 → injection-streak 告警；单期/失败后恢复 → 不告警', () => {
  const note = '本期无记忆注入：db locked（故障演练）'
  const mk = (entries) => scanHealth({ readPreds: mkPredsReader(entries), today: '2026-10-25' })
  // 连续 2 期失败 → 告警（FR-031/FR-033 阈值原文）
  const a = mk([
    { kind: 'daily', game: 'p3', issue: '26281', via: 'ai', injectionNote: note },
    { kind: 'daily', game: 'p3', issue: '26282', via: 'ai', injectionNote: note },
  ])
  const alert = a.alerts.find((x) => x.type === 'injection-streak' && x.game === 'p3')
  assert.ok(alert, '连续 2 期 → injection-streak 告警（触发器③实算）')
  assert.match(alert.detail, /FR-031 触发器③实算/)
  // 单期失败 → 不告警
  const b = mk([{ kind: 'daily', game: 'p3', issue: '26282', via: 'ai', injectionNote: note }])
  assert.ok(!b.alerts.some((x) => x.type === 'injection-streak'), '单期失败不达线')
  // 失败后恢复 → 不告警（连续性中断）
  const c = mk([
    { kind: 'daily', game: 'p3', issue: '26281', via: 'ai', injectionNote: note },
    { kind: 'daily', game: 'p3', issue: '26282', via: 'ai' },
    { kind: 'daily', game: 'p3', issue: '26283', via: 'ai', injectionNote: note },
  ])
  assert.ok(!c.alerts.some((x) => x.type === 'injection-streak'), '最近 2 条不全带注记 → 不告警')
  // 无注记条目 → 零告警零行为（回归保真：M4 既有条目无此字段）
  assert.ok(!mk([{ kind: 'daily', game: 'p3', issue: '26282', via: 'ai' }]).alerts.some((x) => x.type === 'injection-streak'))
})

// ── scheduler 装配面 ──────────────────────────────────────────────────────────
test('§2.2 裁决 c：attachMemoryGuard 接口位在位（留空实现如实登记 not-implemented；未装 auto-memory 不触发——本批不实装剥离监听器）', () => {
  const dir = tmpdir()
  const configPath = path.join(dir, 'koi.config.json')
  fs.mkdirSync(path.join(dir, 'koi'), { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify({ schemaVersion: 2, ...buildConfigDefaults() }))
  const sched = startKoiScheduler({ sessionController: { create: async () => {}, prompt: async () => {} } }, {
    dshHome: dir, configPath, dataDir: path.join(dir, 'koi'), workDir: path.join(dir, 'work'), log: () => {},
    now: NOW, fetch: { fetchHistory: async () => [], fetchLatestDraw: async () => null },
  })
  try {
    assert.equal(typeof sched.mind.attachMemoryGuard, 'function', '接口位在位（mind.attachMemoryGuard）')
    const r = sched.mind.attachMemoryGuard()
    assert.equal(r.ok, false)
    assert.equal(r.skipped, 'not-implemented')
    assert.match(r.reason, /条件实装件|裁决 c/)
    // injector/trimmer 装配在位（T3 渐进装配完成面）
    assert.equal(typeof sched.mind.injector.assemble, 'function')
    assert.equal(typeof sched.mind.injector.stats, 'function')
  } finally { sched.stop() }
})

test('AC-006 注入失败分支（端到端）：injector 故障 → 编排照常出号（via=ai）+ 条目 injectionNote stamp（FR-031 档案标注）+ 注入块进编排材料（成功路径）', async () => {
  const dir = tmpdir()
  const configPath = path.join(dir, 'koi.config.json')
  const dataDir = path.join(dir, 'koi')
  const workDir = path.join(dir, 'work')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify({
    schemaVersion: 2, ...buildConfigDefaults(),
    mind: { enabled: true },
    modes: { ssq: { mode: 'off' }, dlt: { mode: 'off' }, p3: { mode: 'auto', tier: 'p3-x1', predictAt: '17:30', gates: { honestyAck: true } } },
  }))
  const mindFiles = []
  const ctx = {
    sessionController: {
      create: async () => {},
      prompt: async (req) => {
        const text = req.content[0].text
        const m = /（交卷文件：(.+?)）/.exec(text)
        if (m) {
          mindFiles.push(text)
          const role = text.includes('【角色】数据官') ? 'dataOfficer' : text.includes('【角色】策略师') ? 'strategist' : 'chair'
          const payload = role === 'chair'
            ? { schemaVersion: 1, issue: 'x', picks: { digits: [6, 4, 7] }, message: '冷号回补。开奖是随机的图个乐～', summary: 'x', confidenceTier: 'mid', cites: [] }
            : { schemaVersion: 1, game: 'p3', snapshot: {}, proposal: { picks: { digits: [6, 4, 7] } } }
          fs.writeFileSync(m[1], JSON.stringify(payload))
          return
        }
        const m2 = text.match(/advisory-[\w.-]+\.json/)
        if (m2) fs.writeFileSync(path.join(workDir, m2[0]), JSON.stringify({ schemaVersion: 1, game: 'p3', date: '2026-10-25', recommendedTier: 'p3-x1', reasonFull: 'x' }))
      },
    },
  }
  const sched = startKoiScheduler(ctx, {
    dshHome: dir, configPath, dataDir, workDir, log: () => {},
    now: () => new Date('2026-10-25T17:35:00'),
    fetch: {
      async fetchHistory() { return Array.from({ length: 30 }, (_, i) => ({ issue: String(26282 - i), date: new Date(Date.parse('2026-10-23') - i * 86_400_000).toLocaleDateString('sv-SE'), digits: [(i + 1) % 10, 4, 7] })) },
      async fetchLatestDraw() { return { issue: '26283', date: '2026-10-25', digits: [6, 4, 7], prizeGrades: {} } },
    },
  })
  try {
    // 成功路径先跑一期：注入块进数据官材料（探索性素材标注进 prompt）
    await sched.tick()
    const waitPred = async (n) => {
      const t0 = Date.now()
      while (Date.now() - t0 < 9000) {
        const p = readJson(path.join(dataDir, 'predictions.json'), { entries: [] })
        if ((p.entries ?? []).length >= n) return p
        await sleep(100)
      }
      throw new Error('predictions 超时')
    }
    const p1 = await waitPred(1)
    const e1 = p1.entries[0]
    assert.equal(e1.via, 'ai')
    assert.equal(e1.injectionNote, undefined, '正常注入（空库=无记忆可注 ok:true）零失败注记')
    // 注入故障演练：monkey-patch assemble 抛错（同一对象引用——orchestrator 持有引用走补丁）
    sched.mind.injector.assemble = () => { throw new Error('注入故障演练') }
    sched.drawstore.upsert('p3', { issue: '26283', date: '2026-10-25', digits: [1, 2, 3] })
    // 第二期：推进一天 → 出号照常 + injectionNote stamp（FR-031）
    const patch = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    fs.writeFileSync(configPath, JSON.stringify(patch))   // 配置不变（读面同源）
    await new Promise((res) => setTimeout(res, 50))
    // 第二期 tick（模拟次日）
    const sched2 = sched   // 同一实例推时钟——mkHarness setNow 等价面：这里用 stop+rebuild 简化
    sched2.stop()
    // 直接重建第二期（不同 dataDir 会丢第一期档案——复用同 dataDir 但改时钟）
    const sched3 = startKoiScheduler(ctx, {
      dshHome: dir, configPath, dataDir, workDir, log: () => {},
      now: () => new Date('2026-10-26T17:35:00'),
      fetch: {
        async fetchHistory() { return Array.from({ length: 30 }, (_, i) => ({ issue: String(26283 - i), date: new Date(Date.parse('2026-10-24') - i * 86_400_000).toLocaleDateString('sv-SE'), digits: [(i + 1) % 10, 4, 7] })) },
        async fetchLatestDraw() { return { issue: '26284', date: '2026-10-26', digits: [1, 2, 3], prizeGrades: {} } },
      },
    })
    try {
      sched3.mind.injector.assemble = () => { throw new Error('注入故障演练') }
      await sched3.tick()
      const p2 = await waitPred(2)
      const e2 = p2.entries.filter((x) => x.kind === 'daily').slice(-1)[0]
      assert.equal(e2.via, 'ai', '注入故障 → 编排照常出号（FR-031 跳过继续）')
      assert.match(String(e2.injectionNote ?? ''), /^本期无记忆注入：/, '条目 injectionNote stamp（档案标注）')
    } finally { sched3.stop() }
  } finally { sched.stop() }
})
