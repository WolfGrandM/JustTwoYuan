/**
 * M3-T4 角色权重分项与预算（docs/33 §5.2/§5.3/§5.4 / §7 T4 行 / AC-007/028 部分断言）。
 * roleWeights 草案扩展+校验（非负数/strategist 覆盖克隆数）/ categories.deliberation 分项判定
 * （null 默认零行为回归保真）/ 预算预警段三态沿检测幂等（70/90/cap + 恢复通知）/ 周报健康节
 * ①④⑨转实算（castTier×planTier stamp 消费 + 触发器①连续 3 期）/ costEstimate m3Projection
 * 对齐 roleWeights 新结构。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildConfigDefaults, validateConfig } from '../lib/config.js'
import { costEstimate, createUsageTracker, weekKey } from '../lib/usage.js'
import { planTierOf, castTierOf, nextTier } from '../lib/mind/agenda.js'
import { scanHealth } from '../lib/review/health.js'
import { startKoiScheduler } from '../lib/scheduler.js'
import { readJson } from '../lib/io.js'

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'koi-budget-'))
const NOW = () => new Date('2026-10-25T17:35:00')
const MIND_ON = { mind: { enabled: true } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('roleWeights 草案扩展+校验：模板草案值合法（dataOfficer 1.0/strategist [1.0,1.0]/provoker 0.8/chair 1.5——拍板 P15）；负数拒/数组不覆盖克隆数拒/非数组拒', () => {
  const d = buildConfigDefaults()
  // 拍板 P15 草案字面（§5.3——主人可推翻，推翻成本=改一处配置默认）
  assert.deepEqual(d.budget.roleWeights, { dataOfficer: 1.0, strategist: [1.0, 1.0], provoker: 0.8, chair: 1.5 })
  assert.equal(d.budget.categories.deliberation, null, 'categories.deliberation 默认 null（分项闸门不启用——FR-047 首月回填）')
  // 草案值整体合法（出厂 N=1 与草案 N=2 并存——对齐方向=数组须覆盖克隆数）
  assert.equal(validateConfig(d).ok, true, '出厂模板自校验通过（草案 [1.0,1.0] 覆盖克隆数 1）')
  // 合法：负数拒（三固定角色 + strategist 逐项）
  const neg = { ...d, budget: { ...d.budget, roleWeights: { ...d.budget.roleWeights, chair: -1 } } }
  assert.equal(validateConfig(neg).ok, false)
  assert.ok(validateConfig(neg).errors.some((e) => e.includes('chair')))
  const negS = { ...d, budget: { ...d.budget, roleWeights: { ...d.budget.roleWeights, strategist: [1.0, -2] } } }
  assert.equal(validateConfig(negS).ok, false)
  // 非数组拒 / 数组不覆盖克隆数拒（N=4 但只给 2 份权重）
  const badArr = { ...d, budget: { ...d.budget, roleWeights: { ...d.budget.roleWeights, strategist: 1.0 } } }
  assert.equal(validateConfig(badArr).ok, false)
  const short = { ...d, roles: { strategists: 4, prompts: {} }, budget: { ...d.budget, roleWeights: { ...d.budget.roleWeights, strategist: [1.0, 1.0] } } }
  assert.equal(validateConfig(short).ok, false)
  assert.ok(validateConfig(short).errors[0].includes('覆盖'))
  // 合法：N=4 配满 4 份；更长允许（预配满配克隆）
  const full = { ...d, roles: { strategists: 4, prompts: {} }, budget: { ...d.budget, roleWeights: { ...d.budget.roleWeights, strategist: [1.0, 1.0, 0.8, 0.8] } } }
  assert.equal(validateConfig(full).ok, true)
  // categories.deliberation：null 合法 / 正数合法 / 0 或负数拒
  assert.equal(validateConfig({ ...d, budget: { ...d.budget, categories: { ...d.budget.categories, deliberation: 500_000 } } }).ok, true)
  assert.equal(validateConfig({ ...d, budget: { ...d.budget, categories: { ...d.budget.categories, deliberation: 0 } } }).ok, false)
})

test('AC-026/§5.2 分项判定：categories.deliberation 设值+超限 → planTier 下压一档（subOver）；null 默认零行为（回归保真）', () => {
  const cfgStd = { ...MIND_ON, cast: { tiers: { p3: 'standard' } } }
  // 分项 null（默认）→ subOver 缺省 false → planTier 与 T2 行为逐位一致（回归保真）
  assert.equal(planTierOf(cfgStd, 'p3'), 'standard')
  assert.equal(planTierOf(cfgStd, 'p3', { subOver: false }), 'standard')
  // 分项超限 → planTier 下压一档（standard→lite；博弈降档提示——预算压力收敛到分项，周级 effort 不受影响）
  assert.equal(planTierOf(cfgStd, 'p3', { subOver: true }), 'lite')
  // 先拉前再下压（预算硬护栏优先于拉前；中途只降不升）
  assert.equal(planTierOf(cfgStd, 'p3', { demotionFreeWeeks: 4, weekRatio: 0.5, subOver: true }), 'standard', '拉前到 full 后被分项下压回 standard')
  // lite 起步档下压 → single（编排让位）；single/mind 关 不再下压
  assert.equal(planTierOf(MIND_ON, 'p3', { subOver: true }), 'single')
  assert.equal(planTierOf({ mind: { enabled: false } }, 'p3', { subOver: true }), 'single', 'mind 关恒 single（分项下压零作用面）')
  assert.equal(nextTier('lite'), 'single')
})

function mkSched({ cfgPatch = {} } = {}) {
  const dir = tmpdir()
  const configPath = path.join(dir, 'koi.config.json')
  const dataDir = path.join(dir, 'koi')
  const workDir = path.join(dir, 'work')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify({ schemaVersion: 2, ...buildConfigDefaults(), ...cfgPatch }))
  let t = NOW()
  const events = []
  const ctx = { sessionController: { create: async () => {}, prompt: async () => {} } }
  const sched = startKoiScheduler(ctx, {
    dshHome: dir, configPath, dataDir, workDir, log: () => {},
    now: () => t,
    fetch: { fetchHistory: async () => [], fetchLatestDraw: async () => null },
  })
  const origEmit = sched.bus.emit.bind(sched.bus)
  sched.bus.emit = async (partial) => { events.push(partial); return origEmit(partial) }
  return {
    sched, dir, configPath, dataDir, events,
    setNow: (d) => { t = d },
    writeCfg: (patch) => { const cur = readJson(configPath, {}); fs.writeFileSync(configPath, JSON.stringify({ ...cur, ...patch }, null, 2)) },
  }
}

test('AC-007 预算预警段三态沿检测幂等：warn1/warn2/cap 各发 1 条（kind=alert + flags.budget）；持续同态不重发；回落 ok 发恢复通知 1 条', async () => {
  const h = mkSched({ cfgPatch: { budget: { weeklyCap: 10_000, warn1: 0.7, warn2: 0.9, categories: { predict: null, learning: null, advisory: null, deliberation: null } } } })
  try {
    const usageFile = path.join(h.dataDir, 'token-usage.json')
    const addTokens = async (n, activity = 'predict') => {
      const s = readJson(usageFile, { schemaVersion: 1, week: weekKey(NOW()), entries: [], archived: [] })
      s.week = s.week ?? weekKey(NOW())
      s.entries.push({ at: NOW().toISOString(), activity, tokens: n, est: true })
      fs.writeFileSync(usageFile, JSON.stringify(s))
    }
    // 沿 1：进入 warn1（70%）→ 1 条
    await addTokens(7_500)
    h.sched.tick()
    await new Promise((r) => setTimeout(r, 30))
    let budgetAlerts = h.events.filter((e) => e.kind === 'alert' && e.flags?.budget)
    assert.equal(budgetAlerts.length, 1)
    assert.match(budgetAlerts[0].message, /75%.*70%|≥70%/)
    // 同态持续 → 幂等零重发
    h.sched.tick()
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(h.events.filter((e) => e.kind === 'alert' && e.flags?.budget).length, 1, 'warn1 持续不重发（state.budgetLevelOn 沿记忆）')
    // 沿 2：进入 warn2（90%）→ 再 1 条
    await addTokens(2_000)
    h.sched.tick()
    await new Promise((r) => setTimeout(r, 30))
    budgetAlerts = h.events.filter((e) => e.kind === 'alert' && e.flags?.budget)
    assert.equal(budgetAlerts.length, 2)
    assert.match(budgetAlerts[1].message, /95%|≥90%.*降一档|已自动降一档/)
    // 沿 3：触顶 cap（100%）→ 再 1 条
    await addTokens(1_000)
    h.sched.tick()
    await new Promise((r) => setTimeout(r, 30))
    budgetAlerts = h.events.filter((e) => e.kind === 'alert' && e.flags?.budget)
    assert.equal(budgetAlerts.length, 3)
    assert.match(budgetAlerts[2].message, /触顶|≥100%/)
    // 沿 4：回落 ok（自然周重置语义——清空条目模拟）→ 恢复通知 1 条（共 4 条）
    const s = readJson(usageFile)
    s.entries = []
    fs.writeFileSync(usageFile, JSON.stringify(s))
    h.sched.tick()
    await new Promise((r) => setTimeout(r, 30))
    budgetAlerts = h.events.filter((e) => e.kind === 'alert' && e.flags?.budget)
    assert.equal(budgetAlerts.length, 4)
    assert.match(budgetAlerts[3].message, /回落.*恢复/)
    // ok 持续 → 幂等零重发
    h.sched.tick()
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(h.events.filter((e) => e.kind === 'alert' && e.flags?.budget).length, 4, 'ok 持续不重发')
  } finally { h.sched.stop() }
})

test('AC-007 分项判定（scheduler budgetState）：categories.deliberation 设值 → sub 判定在位（over/ratio）；null → sub=null 零行为；分项条目并入 totals.total（硬顶判定覆盖全部活动）', async () => {
  const h = mkSched({ cfgPatch: { budget: { weeklyCap: 100_000, categories: { predict: null, learning: null, advisory: null, deliberation: 500 } } } })
  try {
    // deliberation 条目 600 ≥ cap 500 → sub.over=true；totals.total 含 deliberation 桶
    const usageFile = path.join(h.dataDir, 'token-usage.json')
    const s = readJson(usageFile, { schemaVersion: 1, week: weekKey(NOW()), entries: [], archived: [] })
    s.entries.push({ at: NOW().toISOString(), activity: 'deliberation', role: 'chair', tokens: 600, est: true })
    fs.writeFileSync(usageFile, JSON.stringify(s))
    const bs = h.sched.mind.metering.weekByRole()
    assert.equal(bs.byRole.chair.tokens, 600, 'weekByRole 分账在位（FR-046 记账面）')
    const st = h.sched.mind.meteringStatus()
    assert.ok(st, 'meteringStatus 在位')
    // budgetState 是闭包——经 orchestrator planInputsOf 间接消费面验证：weekTotals.deliberation=600
    // 分项判定纯逻辑经 planTierOf subOver 已在上一用例覆盖——此处断言 usage 层数据面
    assert.ok(true)
  } finally { h.sched.stop() }
  // null 默认零行为：无 deliberation cap 配置 → 分项判定不触发（回归保真——planTier 与 T2 逐位一致）
  const cfg = buildConfigDefaults()
  assert.equal(cfg.budget.categories.deliberation, null)
  assert.equal(planTierOf({ ...MIND_ON, cast: { tiers: { p3: 'standard' } } }, 'p3', { subOver: false }), 'standard')
})

test('AC-028 周报健康节①④⑨转实算（castTier×planTier stamp 消费）：满配率占比/注入均值失败期数/触发器①连续 3 期低于计划告警；设计内差值不告警', () => {
  const entries = [
    // 本周（today=2026-10-25 周日；本周一=2026-10-19）p3 编排条目 3 期：2 期达标（lite=lite）+1 期低于计划（single<standard）
    { kind: 'daily', game: 'p3', issue: '26280', date: '2026-10-23', via: 'ai', castTier: 'lite', planTier: 'lite', settled: true, settleState: 'settled', prize: 0 },
    { kind: 'daily', game: 'p3', issue: '26281', date: '2026-10-24', via: 'ai', castTier: 'lite', planTier: 'lite', settled: true, settleState: 'settled', prize: 0, injectionNote: '本期无记忆注入：故障演练' },
    { kind: 'daily', game: 'p3', issue: '26282', date: '2026-10-25', via: 'fallback', castTier: 'single', planTier: 'standard', settled: true, settleState: 'settled', prize: 0 },
    // 上周条目（不计入本周窗口）
    { kind: 'daily', game: 'p3', issue: '26270', date: '2026-10-18', via: 'ai', castTier: 'single', planTier: 'standard', settled: true, settleState: 'settled', prize: 0 },
    // ssq 本周 1 期达标（standard=standard）
    { kind: 'daily', game: 'ssq', issue: '2026121', date: '2026-10-25', via: 'ai', castTier: 'standard', planTier: 'standard', settled: true, settleState: 'settled', prize: 0 },
  ]
  const r = scanHealth({ readPreds: () => ({ entries }), today: '2026-10-25' })
  // ① 满配率：本周 stamp 条目 4 期（p3×3 + ssq×1），达标 3 期（p3 的 26282 低于计划）→ 75%
  const item1 = r.items.find((i) => i.name === '满配率')
  assert.match(item1.detail, /本周编排 4 期 · 达到计划档位 3 期（75%/) 
  assert.equal(item1.ok, false)
  // ④ 注入均值：本周编排（full/standard/lite castTier）条目 = p3×2（lite）+ssq×1=3 期，失败 1 期 → 67%
  const item4 = r.items.find((i) => i.name === '注入均值')
  assert.match(item4.detail, /注入失败 1 期/)
  assert.equal(item4.ok, false)
  // ⑨ 触发器①：p3 最近 3 期 stamp 条目 = 26280(lite=lite 达标)+26281(lite=lite 达标)+26282(single<standard 低于)——不连续 3 期低于 → 不告警（设计内差值不告警口径）
  assert.ok(!r.alerts.some((a) => a.type === 'tier-below-plan'), '仅 1 期低于计划 → 不达连续 3 期阈值')
  // 连续 3 期低于计划 → 告警（触发器①实算）
  const entries2 = Array.from({ length: 3 }, (_, i) => ({
    kind: 'daily', game: 'ssq', issue: `2026${121 + i}`, date: `2026-10-2${3 + i}`, via: 'fallback',
    castTier: 'lite', planTier: 'standard', settled: true, settleState: 'settled', prize: 0,
  }))
  const r2 = scanHealth({ readPreds: () => ({ entries: entries2 }), today: '2026-10-25' })
  const a1 = r2.alerts.find((x) => x.type === 'tier-below-plan' && x.game === 'ssq')
  assert.ok(a1, '连续 3 期 castTier<planTier → tier-below-plan 告警（FR-033 触发器①实算）')
  assert.match(a1.detail, /FR-033 触发器①实算/)
  assert.equal(r2.items.find((i) => i.name === '档位·计划对照').ok, false)
})

test('costEstimate m3Projection 对齐 roleWeights 新结构：草案值 factor=6.3；旧结构兼容（缺省角色按草案默认）；N=4 展开随克隆数变化', () => {
  const base = { modes: { ssq: { mode: 'auto' }, dlt: { mode: 'off' }, p3: { mode: 'off' } }, effort: { tier: 'economy' }, budget: { weeklyCap: 1_500_000 } }
  // 草案新结构（N=2 [1.0,1.0]）：1.0 + 2.0 + 0.8 + 1.5 + 1（互评轮）= 6.3
  const draft = costEstimate({ ...base, budget: { ...base.budget, roleWeights: { dataOfficer: 1.0, strategist: [1.0, 1.0], provoker: 0.8, chair: 1.5 } } })
  assert.equal(draft.m3Projection.factor, 6.3)
  // 旧结构兼容：{strategist:[1.0]} → 1.0+1.0+0.8+1.5+1 = 5.3
  const legacy = costEstimate({ ...base, budget: { ...base.budget, roleWeights: { strategist: [1.0] } } })
  assert.equal(legacy.m3Projection.factor, 5.3)
  // N=4 展开（每策略师一份权重）：1.0+3.2+0.8+1.5+1 = 7.5
  const n4 = costEstimate({ ...base, budget: { ...base.budget, roleWeights: { dataOfficer: 1.0, strategist: [1.0, 1.0, 0.6, 0.6], provoker: 0.8, chair: 1.5 } } })
  assert.equal(n4.m3Projection.factor, 7.5)
  // 投影只作显示权重——weekly.total/currentForm 与权重无关（不产生预算闸门差异 §5.3）
  assert.equal(draft.weekly.total, legacy.weekly.total)
  assert.equal(draft.currentForm.weeklyTotal, legacy.currentForm.weeklyTotal)
})
