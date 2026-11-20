/**
 * 市场版 T6 —— 调度器八点改造集成测试（注入时钟/注入抓取/假会话，全离线）。
 * 覆盖：三态分派（off/manual 跳流水线 / auto 全流程）、quickpick 三态放行不入账本（AC-110）、
 * stamps（tier/effortTier/baselinePicks/configStamp，FZ-3 只加字段）、换档下期生效（AC-106）、
 * no-model 短路配置指引（AC-113 机制面）、门控四项（S-116）、本地库增量入库（BC-105）、
 * status 降级语义（MB-25/FZ-6）、心跳接线。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startKoiScheduler, classifyHostError, DEFAULT_NO_MODEL_PATTERNS } from '../lib/scheduler.js'
import { buildConfigDefaults, buildConfigStamp } from '../lib/config.js'
import { winUnreadCount } from '../lib/ui-logic.js'
import { readJson } from '../lib/io.js'

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'koi-sched-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const P3_RESULT_26283 = { issue: '26283', date: '2026-10-25', digits: [6, 4, 7], prizeGrades: { 1: 1040 } }
// 福彩3D 夹具（docs/31 §5 第二批）：福彩 7 位期号 2026322（2026-10-25 开奖 21:15，公布后 22:00 统一窗对账）
const D3_RESULT_2026322 = { issue: '2026322', date: '2026-10-25', digits: [6, 0, 7], prizeGrades: { 1: 1040 } }
function default3dFetch() {
  const base = defaultFetch()
  return {
    ...base,
    async fetchHistory(game, count) {
      if (game === '3d') {
        const n = Math.min(count, 30)
        return Array.from({ length: n }, (_, i) => ({
          issue: String(2026321 - i),
          date: new Date(Date.parse('2026-10-24') - i * 86_400_000).toLocaleDateString('sv-SE'),
          digits: [(i + 3) % 10, 0, 7],
        }))
      }
      return base.fetchHistory(game, count)
    },
    async fetchLatestDraw(game) {
      return game === '3d' ? D3_RESULT_2026322 : base.fetchLatestDraw(game)
    },
  }
}

// ── 测试台：可编程假会话（按提示词内容写交卷文件）+ 可编程抓取 + 可注入时钟 ─────────
function mkHarness({ cfgPatch = {}, now = new Date('2026-10-25T17:35:00'), fetch, prompt, picks: picksOverride = null } = {}) {
  const dir = tmpdir()
  const configPath = path.join(dir, 'koi.config.json')
  const dataDir = path.join(dir, 'koi')
  const workDir = path.join(dir, 'koi-work')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify({ schemaVersion: 2, ...buildConfigDefaults(), ...cfgPatch }))
  let t = now
  const prompts = []   // 唤醒提示词留档（3D 提示词契约等断言用；加法字段，既有用例不受影响）
  const ctx = {
    sessionController: {
      create: async () => {},
      prompt: async (req) => {
        const text = req.content[0].text
        prompts.push(text)
        if (prompt === 'no-model') throw new Error('DSH runtime: no model configured for agent')
        // advisory 交卷
        const adv = text.match(/advisory-[\w.-]+\.json/)
        if (adv) {
          fs.writeFileSync(path.join(workDir, adv[0]), JSON.stringify({
            schemaVersion: 1, game: 'p3', date: t.toLocaleDateString('sv-SE'),
            recommendedTier: 'p3-x1', reasonFull: '成本权衡：本周预算偏紧，最小档控制试错成本。',
          }))
          return
        }
        // 出号交卷（从提示词解析档位结构：红球个数/蓝球个数/前区个数/位数）
        const m = text.match(/predict-[\w.-]+\.json/)
        if (!m || prompt === 'silent') return
        const out = path.join(workDir, m[0])
        if (picksOverride) {   // 测试注入固定 picks（NM 判定等需要确定性号码的场景）
          fs.writeFileSync(out, JSON.stringify({
            schemaVersion: 1, issue: '0', picks: picksOverride,
            message: '本锦鲤今天研究心得：冷号在攒劲，就选这组！开奖见真章～',
            summary: '冷号回补思路，蓝球盯小号。',
          }))
          return
        }
        const reds = Number(text.match(/选 (\d+) 个红球/)?.[1] ?? 8)
        const blues = Number(text.match(/选 (\d+) 个(不同的)?蓝球/)?.[1] ?? 1)
        const fronts = Number(text.match(/选 (\d+) 个前区号/)?.[1] ?? 7)
        const backs = Number(text.match(/选 (\d+) 个后区号/)?.[1] ?? 2)
        const p3units = Number(text.match(/写 (\d+) 组三位数/)?.[1] ?? 0)
        const picks = p3units
          ? { digits: Array.from({ length: p3units }, (_, i) => [i % 10, 4, 7]) }
          : text.includes('红球')
            ? { red: Array.from({ length: reds }, (_, i) => i + 1), ...(blues === 1 ? { blue: 4 } : { blue: [4, 5] }) }
            : { front: Array.from({ length: fronts }, (_, i) => i + 1), back: Array.from({ length: backs }, (_, i) => i + 3) }
        fs.writeFileSync(out, JSON.stringify({
          schemaVersion: 1, issue: '0', picks,
          message: '本锦鲤今天研究心得：冷号在攒劲，就选这组！开奖见真章～',
          summary: '冷号回补思路，蓝球盯小号。',
        }))
      },
    },
  }
  const sched = startKoiScheduler(ctx, {
    dshHome: dir, configPath, dataDir, workDir, log: () => {},
    now: () => t,
    fetch: fetch ?? defaultFetch(),
  })
  return {
    sched, dir, configPath, dataDir, workDir, prompts,
    setNow: (d) => { t = d },
    get now() { return t },
    writeCfg: (patch) => {
      const cur = readJson(configPath, {})
      fs.writeFileSync(configPath, JSON.stringify({ ...cur, ...patch }, null, 2))
    },
  }
}

function defaultFetch() {
  return {
    async fetchHistory(game, count) {
      // 30 期 p3/ssq 历史（最新 26282 / 2026121），日期相对 2026-10-25 新鲜
      const n = Math.min(count, 30)
      return Array.from({ length: n }, (_, i) => game === 'p3'
        ? { issue: String(26282 - i), date: new Date(Date.parse('2026-10-23') - i * 86_400_000).toLocaleDateString('sv-SE'), digits: [(i + 1) % 10, 4, 7] }
        : { issue: String(2026121 - i), date: new Date(Date.parse('2026-10-22') - i * 86_400_000).toLocaleDateString('sv-SE'), red: [2, 7, 20, 24, 26, 30], blue: 2 })
    },
    async fetchLatestDraw(game) {
      return game === 'p3' ? P3_RESULT_26283
        : { issue: '2026122', date: '2026-10-25', red: [1, 2, 3, 4, 5, 6], blue: 4, prizeGrades: {} }
    },
  }
}

const waitJob = async (sched, id, ms = 8000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const j = sched.qpJob(id)
    if (j && j.status !== 'running') return j
    await sleep(100)
  }
  throw new Error('quickpick 任务超时')
}

const waitPreds = async (harness, n, ms = 8000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const p = readJson(path.join(harness.dataDir, 'predictions.json'), { entries: [] })
    if ((p.entries ?? []).length >= n) return p
    await sleep(100)
  }
  throw new Error('predictions 超时')
}

// ───────────────────────────── 三态分派与永久基础层 ─────────────────────────────

test('②三态分派：off/manual 跳过出号流水线（无 predictions 无 state 门）；auto 全流程跑通', async () => {
  for (const mode of ['off', 'manual']) {
    const h = mkHarness({ cfgPatch: { modes: { ssq: { mode: 'off' }, dlt: { mode: 'manual' }, p3: { mode, tier: 'p3-x1', predictAt: '17:30' } } } })
    try {
      await h.sched.tick()
      await sleep(400)
      const preds = readJson(path.join(h.dataDir, 'predictions.json'), { entries: [] })
      assert.equal((preds.entries ?? []).length, 0, `${mode} 模式不出号`)
      const st = h.sched.status()
      assert.equal(st.games.p3.mode, mode)
      assert.equal(st.games.p3.enabledToday, mode !== 'off', 'manual 今天开·手动待命中 / off 不开（MB-25 三态取值）')
    } finally { h.sched.stop() }
  }
  // auto：2026-10-25（周日）p3 开奖，17:35 tick → 出号（stamps 断言）
  const h = mkHarness({
    cfgPatch: {
      advisory: { enabled: false },
      modes: { ssq: { mode: 'off' }, dlt: { mode: 'off' }, p3: { mode: 'auto', tier: 'p3-x3', predictAt: '17:30', gates: { honestyAck: true } } },
    },
  })
  try {
    await h.sched.tick()
    const preds = await waitPreds(h, 1)
    const e = preds.entries[0]
    assert.equal(e.kind, 'daily')
    assert.equal(e.tier, 'p3-x3', '⑥ stamp tier（当刻档位）')
    assert.equal(e.effortTier, 'follow-host', '⑥ stamp effortTier（实际生效档）')
    assert.equal(e.configStamp, buildConfigStamp(readJson(h.configPath)), '⑥ stamp configStamp（MC-17）')
    assert.ok(e.baselinePicks, '⑥ 随机基线同刻生成（DC-002，仅正式预测）')
    assert.equal(e.baselinePicks.digits.length, 3, '基线与正式预测同结构同注数（AC-106）')
    assert.equal(e.bets, 3); assert.equal(e.cost, 6)
    assert.ok(e.spec.includes('×3'), '规格文案随档')
    assert.ok(e.summary, 'summary 结构化字段入档')
    // FZ-5 相位：idle → predicted
    const stt = readJson(path.join(h.dataDir, 'state.json'))
    assert.equal(stt.games.p3.phase, 'predicted')
    // ① 推送调用点 → 事件层：predict 事件落盘且 body 合规
    const evs = readJson(path.join(h.dataDir, 'events.json'), { entries: [] }).entries
    assert.ok(evs.some((e2) => e2.kind === 'predict'), 'predict 事件已产生')
    const pe = evs.find((e2) => e2.kind === 'predict')
    assert.ok(pe.body.includes('不改变中奖概率'), '诚实基调句')
    assert.ok(!pe.body.includes('研究心得'), 'concise 推送不含全文（FR-1010）')
    assert.ok(!pe.body.includes('摘要：'), 'concise 不带 summary 行')
  } finally { h.sched.stop() }
})

test('quickpick 永久基础层：三态任一放行（off 也放行，显式行为增量）；kind=quickpick 不入账本；manual 留痕', async () => {
  const h = mkHarness({ cfgPatch: { modes: { ssq: { mode: 'off' }, dlt: { mode: 'off' }, p3: { mode: 'off', tier: 'p3-x1' } } } })
  try {
    const r = h.sched.quickpick('p3')
    assert.equal(r.ok, true, 'off 模式下来一注仍可用（FR-1023 永久基础层，v1 此处拒绝）')
    const job = await waitJob(h.sched, r.id)
    assert.equal(job.status, 'done', 'panel 渠道送达')
    const preds = await waitPreds(h, 1)
    const e = preds.entries[0]
    assert.equal(e.kind, 'quickpick')
    assert.notEqual(e.manual, true, 'off 模式 = 加餐语义（非手动推荐）')
    assert.ok(e.configStamp, 'quickpick 条目同样带 configStamp')
    const ledger = readJson(path.join(h.dataDir, 'ledger.json'), { entries: [] })
    assert.equal((ledger.entries ?? []).length, 0, '加餐不入账本（账本条目数不变，AC-110）')
    const evs = readJson(path.join(h.dataDir, 'events.json'), { entries: [] }).entries
    const qe = evs.find((x) => x.kind === 'quickpick')
    assert.ok(qe, 'quickpick 事件 noRetry')
    assert.equal(qe.noRetry, true)
    assert.ok(qe.body.includes('加餐 · 不计入账本'))
  } finally { h.sched.stop() }
  // manual 模式 → 手动推荐留痕（MA-26）
  const h2 = mkHarness({ cfgPatch: { modes: { ssq: { mode: 'off' }, dlt: { mode: 'off' }, p3: { mode: 'manual', tier: 'p3-x1' } } } })
  try {
    const r = h2.sched.quickpick('p3')
    await waitJob(h2.sched, r.id)
    const preds = await waitPreds(h2, 1)
    assert.equal(preds.entries[0].manual, true, '手动号入档留痕（继承 FR-052 加餐类别）')
    const evs = readJson(path.join(h2.dataDir, 'events.json'), { entries: [] }).entries
    assert.ok(evs.find((x) => x.kind === 'quickpick').body.includes('手动推荐 · 不计入账本'))
  } finally { h2.sched.stop() }
})

// ───────────────────────────── 对账 · 增量入库 · 基线回填 ─────────────────────────────

test('auto 全流程对账：judgeTier 判奖记账 + ④增量入库（同一抓取双消费）+ 基线判奖回填 + 事件 result', async () => {
  const h = mkHarness({
    cfgPatch: {
      advisory: { enabled: false },
      modes: { ssq: { mode: 'off' }, dlt: { mode: 'off' }, p3: { mode: 'auto', tier: 'p3-x3', predictAt: '17:30', gates: { honestyAck: true } } },
    },
  })
  try {
    await h.sched.tick()
    await waitPreds(h, 1)
    // 22:05 对账（26283 开奖 6-4-7；prompt 写的 3 组：[0,4,7]/[1,4,7]/[2,4,7] —— 均未中 → prize 0）
    h.setNow(new Date('2026-10-25T22:05:00'))
    await h.sched.tick()
    await sleep(600)
    const preds = readJson(path.join(h.dataDir, 'predictions.json'))
    const e = preds.entries.find((x) => x.kind === 'daily')
    assert.equal(e.settled, true)
    assert.equal(e.settleState, 'settled')
    assert.equal(e.prize, 0, '三组均未中')
    assert.ok(e.baselinePrize != null && e.baselineGrades != null, '基线判奖回填（纯观测）')
    const ledger = readJson(path.join(h.dataDir, 'ledger.json'), { entries: [] })
    const main = (ledger.entries ?? []).find((x) => x.entryType === 'main')
    assert.equal(main.cost, 6, '账本按当期实际结构记（BC-113）')
    // ④ 增量挂对账：本地库新增 26283
    const draws = readJson(path.join(h.dataDir, 'draws', 'p3.json'), { entries: [] })
    assert.ok((draws.entries ?? []).some((d) => d.issue === '26283'), '对账抓取双消费入库（BC-105）')
    // FZ-5 相位：predicted → settled
    assert.equal(readJson(path.join(h.dataDir, 'state.json')).games.p3.phase, 'settled')
    const evs = readJson(path.join(h.dataDir, 'events.json'), { entries: [] }).entries
    assert.ok(evs.some((x) => x.kind === 'result'), 'result 事件')
  } finally { h.sched.stop() }
})

test('AC-106 换档下期生效：当期旧档下期新档；对账按条目自带规格（⑦settleText 口径）', async () => {
  // day1（2026-10-25 周日）：ssq auto · ssq-r7b1 → 出号 7 注/14 元
  const h = mkHarness({
    cfgPatch: {
      advisory: { enabled: false },
      modes: { ssq: { mode: 'auto', tier: 'ssq-r7b1', predictAt: '17:30', gates: { honestyAck: true } }, dlt: { mode: 'off' }, p3: { mode: 'off' } },
    },
  })
  try {
    await h.sched.tick()
    const preds1 = await waitPreds(h, 1)
    assert.equal(preds1.entries[0].tier, 'ssq-r7b1')
    assert.equal(preds1.entries[0].cost, 14, '当期按旧档')
    // 盘中换档（tier 只写 config，不触碰当日 state/相位）
    h.writeCfg({ modes: { ssq: { mode: 'auto', tier: 'ssq-r8b1', predictAt: '17:30', gates: { honestyAck: true } }, dlt: { mode: 'off' }, p3: { mode: 'off' } } })
    // day1 对账：账目仍按旧档 14 元
    h.setNow(new Date('2026-10-25T22:05:00'))
    await h.sched.tick()
    await sleep(600)
    const ledger = readJson(path.join(h.dataDir, 'ledger.json'), { entries: [] })
    const main = (ledger.entries ?? []).find((x) => x.entryType === 'main')
    assert.equal(main.cost, 14, '换档当期账目按旧档（BC-113）')
    // day2（2026-10-27 周二 ssq 开奖）：出号按新档 28 注/56 元
    h.setNow(new Date('2026-10-27T17:35:00'))
    await h.sched.tick()
    const preds2 = await waitPreds(h, 2)
    const e2 = preds2.entries.find((x) => x.date === '2026-10-27')
    assert.equal(e2.tier, 'ssq-r8b1', '下期按新档')
    assert.equal(e2.cost, 56)
  } finally { h.sched.stop() }
})

// ───────────────────────────── near-miss 入档（docs/31 §4.1/§6 第一批②）─────────────────────────────

const P3_NM_CFG = {
  advisory: { enabled: false },
  modes: { ssq: { mode: 'off' }, dlt: { mode: 'off' }, p3: { mode: 'auto', tier: 'p3-x1', predictAt: '17:30', gates: { honestyAck: true } } },
}

test('nearMiss 入档（FZ-3 只加字段）：NM-2 对账写入条目与 result 事件；账本口径零变化（BC-006 永不进 ledger）', async () => {
  // picks [0,4,7] vs 开奖 [0,6,7]：两位同第三位不同 → NM-2（预注册判据 judgeNearMiss 代码产出）
  const h = mkHarness({
    picks: { digits: [0, 4, 7] },
    fetch: { ...defaultFetch(), fetchLatestDraw: async () => ({ issue: '26283', date: '2026-10-25', digits: [0, 6, 7], prizeGrades: { 1: 1040 } }) },
    cfgPatch: P3_NM_CFG,
  })
  try {
    await h.sched.tick()
    await waitPreds(h, 1)
    h.setNow(new Date('2026-10-25T22:05:00'))
    await h.sched.tick()
    await sleep(400)
    const preds = readJson(path.join(h.dataDir, 'predictions.json'))
    const e = preds.entries.find((x) => x.kind === 'daily')
    assert.equal(e.prize, 0, '直选没奖前置成立')
    assert.equal(e.nearMiss, 'NM-2', '对账判定结果写入条目（字段形态 = 预注册档位代号字符串）')
    const ledger = readJson(path.join(h.dataDir, 'ledger.json'), { entries: [] })
    const main = ledger.entries.find((x) => x.entryType === 'main')
    assert.equal(main.prize, 0, '账本口径零变化：NM 永不进 ledger，直选没奖记 0（BC-006）')
    assert.equal('nearMiss' in main, false, 'ledger 条目零 nearMiss 字段')
    const evs = readJson(path.join(h.dataDir, 'events.json'), { entries: [] }).entries
    const result = evs.find((x) => x.kind === 'result')
    assert.equal(result.nearMiss, 'NM-2', 'result 事件携带 nearMiss（emitNotify 实参 → 事件层透传）')
    assert.equal(result.won, false, 'NM 未中奖：won 口径不变（红点/未读只认 won）')
  } finally { h.sched.stop() }
})

test('nearMiss 入档·NM-1 组选命中（数字集合相同排列不同）；非 NM 轮条目零新字段（FZ-3 纯加法）', async () => {
  // ① NM-1：picks [6,0,7] vs 开奖 [0,6,7]（docs/31 需求起源样本 607/067 形态）
  const h1 = mkHarness({
    picks: { digits: [6, 0, 7] },
    fetch: { ...defaultFetch(), fetchLatestDraw: async () => ({ issue: '26283', date: '2026-10-25', digits: [0, 6, 7], prizeGrades: { 1: 1040 } }) },
    cfgPatch: P3_NM_CFG,
  })
  try {
    await h1.sched.tick()
    await waitPreds(h1, 1)
    h1.setNow(new Date('2026-10-25T22:05:00'))
    await h1.sched.tick()
    await sleep(400)
    const e1 = readJson(path.join(h1.dataDir, 'predictions.json')).entries.find((x) => x.kind === 'daily')
    assert.equal(e1.nearMiss, 'NM-1')
    assert.equal(e1.prize, 0)
    const r1 = readJson(path.join(h1.dataDir, 'events.json'), { entries: [] }).entries.find((x) => x.kind === 'result')
    assert.equal(r1.nearMiss, 'NM-1')
    assert.equal(r1.won, false)
  } finally { h1.sched.stop() }
  // ② 非 NM 轮：picks [0,4,7] vs 开奖 [9,9,9]（零位对）—— 条目零 nearMiss 字段、事件字段 null
  const h2 = mkHarness({
    picks: { digits: [0, 4, 7] },
    fetch: { ...defaultFetch(), fetchLatestDraw: async () => ({ issue: '26283', date: '2026-10-25', digits: [9, 9, 9], prizeGrades: { 1: 1040 } }) },
    cfgPatch: P3_NM_CFG,
  })
  try {
    await h2.sched.tick()
    await waitPreds(h2, 1)
    h2.setNow(new Date('2026-10-25T22:05:00'))
    await h2.sched.tick()
    await sleep(400)
    const e2 = readJson(path.join(h2.dataDir, 'predictions.json')).entries.find((x) => x.kind === 'daily')
    assert.equal('nearMiss' in e2, false, '无 NM 条目零新字段（只有 NM 才写，与既有输出逐位一致）')
    const r2 = readJson(path.join(h2.dataDir, 'events.json'), { entries: [] }).entries.find((x) => x.kind === 'result')
    assert.equal(r2.nearMiss, null, '事件层字段恒在、无 NM 时为 null')
  } finally { h2.sched.stop() }
})

// ───────────────────────────── settleText NM 叙事段（docs/31 §4.3 原文；第一批③）─────────────────────────────
// QQ result 链路：正文经 TF-17 body 直传（改的是 settleText 本体）——断言读 result 事件 body。

test('settleText NM 叙事·NM-1：§4.3 占位文案原文整行入正文，插在「本回合计」后、常驻诚实句前；禁止框架零命中', async () => {
  const h = mkHarness({
    picks: { digits: [6, 0, 7] },
    fetch: { ...defaultFetch(), fetchLatestDraw: async () => ({ issue: '26283', date: '2026-10-25', digits: [0, 6, 7], prizeGrades: { 1: 1040 } }) },
    cfgPatch: P3_NM_CFG,
  })
  try {
    await h.sched.tick()
    await waitPreds(h, 1)
    h.setNow(new Date('2026-10-25T22:05:00'))
    await h.sched.tick()
    await sleep(400)
    const result = readJson(path.join(h.dataDir, 'events.json'), { entries: [] }).entries.find((x) => x.kind === 'result')
    const ls = result.body.split('\n')
    assert.equal(ls.length, 10, '经典 9 行 + NM 叙事 1 行')
    assert.equal(ls[6], '气死气死！我们押的 607，开奖 067——三个数字一个不差，顺序全拧了！直选没奖，账本老老实实记 0 元。', '§4.3 NM-1 占位文案原文（数字代入）')
    assert.ok(ls[5].startsWith('本回合计：'), '叙事段紧跟本回合计')
    assert.ok(ls[7].startsWith('同刻随机对照'), '叙事段在对照行之前')
    assert.equal(ls[9], '开奖是随机的，图个乐～ 明天继续攒运气！', '常驻诚实句仍是末行')
    for (const banned of ['差一点就是', '好运在积累', '下次稳了', '大概率', '快中了', '快中']) {
      assert.ok(!result.body.includes(banned), `禁止诱导框架零命中：${banned}`)
    }
  } finally { h.sched.stop() }
})

test('settleText NM 叙事·NM-2：两位对原文行；无 NM 轮正文与既有格式逐位一致（零变化）', async () => {
  // ① NM-2：picks [0,4,7] vs 开奖 [0,6,7]
  const h1 = mkHarness({
    picks: { digits: [0, 4, 7] },
    fetch: { ...defaultFetch(), fetchLatestDraw: async () => ({ issue: '26283', date: '2026-10-25', digits: [0, 6, 7], prizeGrades: { 1: 1040 } }) },
    cfgPatch: P3_NM_CFG,
  })
  try {
    await h1.sched.tick()
    await waitPreds(h1, 1)
    h1.setNow(new Date('2026-10-25T22:05:00'))
    await h1.sched.tick()
    await sleep(400)
    const result1 = readJson(path.join(h1.dataDir, 'events.json'), { entries: [] }).entries.find((x) => x.kind === 'result')
    assert.ok(result1.body.includes('047 对 067，两位都对就差一位……气人！不过直选就是直选，账本记 0，锦鲤不找借口。'), '§4.3 NM-2 占位文案原文（数字代入）')
    const ls1 = result1.body.split('\n')
    assert.equal(ls1.length, 10)
    assert.ok(ls1[6].includes('两位都对就差一位'), '叙事段仍在本回合计后')
  } finally { h1.sched.stop() }
  // ② 非 NM 轮：正文与既有格式逐位一致（NM 叙事段零出现——③「无 NM 时零变化」）
  const h2 = mkHarness({
    picks: { digits: [0, 4, 7] },
    fetch: { ...defaultFetch(), fetchLatestDraw: async () => ({ issue: '26283', date: '2026-10-25', digits: [9, 9, 9], prizeGrades: { 1: 1040 } }) },
    cfgPatch: P3_NM_CFG,
  })
  try {
    await h2.sched.tick()
    await waitPreds(h2, 1)
    h2.setNow(new Date('2026-10-25T22:05:00'))
    await h2.sched.tick()
    await sleep(400)
    const result2 = readJson(path.join(h2.dataDir, 'events.json'), { entries: [] }).entries.find((x) => x.kind === 'result')
    const ls2 = result2.body.split('\n')
    assert.equal(ls2.length, 9, '无 NM：行数与既有格式一致')
    assert.deepEqual(ls2.slice(0, 6), [
      '🎰【锦鲤战果 · 排列三 · 第 26283 期】',
      '开奖：9 9 9',
      '我们的号：直选 0-4-7',
      '（直选一注 · 1 注 / 2 元）',
      '结果：未中奖',
      '本回合计：中 0 元',
    ], '前六行逐位一致（TF-17 完整文案格式不动）')
    assert.ok(ls2[6].startsWith('同刻随机对照（纯观测）：'), '对照行（内容随基线随机号而变，仅断言前缀）')
    assert.equal(ls2[7], '模拟账本（若每期都买）：投入 2 元 · 中 0 元 · 净 -2 元 · 共 1 期 · 还没开过胡')
    assert.equal(ls2[8], '开奖是随机的，图个乐～ 明天继续攒运气！')
    assert.ok(!result2.body.includes('顺序全拧') && !result2.body.includes('就差一位') && !result2.body.includes('气死'), '零 NM 叙事词')
  } finally { h2.sched.stop() }
})

test('settleText NM 叙事·多注档位本注近失他注中奖：省略「账本记 0」子句（BC-001 诚实优先于文案逐字），账本照常记 1040', async () => {
  const h = mkHarness({
    picks: { digits: [[6, 0, 7], [0, 6, 7], [1, 2, 3]] },   // p3-x3：第 1 注 NM-1、第 2 注直选命中、第 3 注无关
    fetch: { ...defaultFetch(), fetchLatestDraw: async () => ({ issue: '26283', date: '2026-10-25', digits: [0, 6, 7], prizeGrades: { 1: 1040 } }) },
    cfgPatch: { ...P3_NM_CFG, modes: { ...P3_NM_CFG.modes, p3: { mode: 'auto', tier: 'p3-x3', predictAt: '17:30', gates: { honestyAck: true } } } },
  })
  try {
    await h.sched.tick()
    await waitPreds(h, 1)
    h.setNow(new Date('2026-10-25T22:05:00'))
    await h.sched.tick()
    await sleep(400)
    const preds = readJson(path.join(h.dataDir, 'predictions.json'))
    const e = preds.entries.find((x) => x.kind === 'daily')
    assert.equal(e.prize, 1040, '第 2 注直选命中（won=true 前置成立）')
    assert.equal(e.nearMiss, 'NM-1', '第 1 注组选命中仍入档（记录它）')
    const main = readJson(path.join(h.dataDir, 'ledger.json'), { entries: [] }).entries.find((x) => x.entryType === 'main')
    assert.equal(main.prize, 1040, '账本按官方规则照常记（BC-006 口径零变化）')
    const result = readJson(path.join(h.dataDir, 'events.json'), { entries: [] }).entries.find((x) => x.kind === 'result')
    assert.ok(result.body.includes('气死气死！我们押的 607，开奖 067——三个数字一个不差，顺序全拧了！'), 'NM-1 事实+情绪保留')
    assert.ok(!result.body.includes('账本老老实实记 0 元') && !result.body.includes('账本记 0'), '「账本记 0」为假 → 子句省略（诚实条款 BC-001）')
    assert.ok(result.body.includes('本回合计：中 1040 元'))
    assert.equal(result.won, true)
  } finally { h.sched.stop() }
})

// ───────────────────────────── 福彩3D 链路（docs/31 §5/§6 第二批：第四彩种全链路同构复用）─────────────────────────────
// 出号（predictAt 17:30 缺省）→ 对账（22:00 统一窗，drawAt 21:15）→ NM 判定 → 战果文案（gameName=福彩3D）→ 事件层。

const D3_CFG = {
  advisory: { enabled: false },
  modes: { ssq: { mode: 'off' }, dlt: { mode: 'off' }, p3: { mode: 'off' }, '3d': { mode: 'auto', tier: '3d-x1', predictAt: '17:30', gates: { honestyAck: true } } },
}
const settle3d = async (h, { picks, result } = {}) => {
  await h.sched.tick()
  await waitPreds(h, 1)
  h.setNow(new Date('2026-10-25T22:05:00'))
  await h.sched.tick()
  await sleep(400)
  return {
    entry: readJson(path.join(h.dataDir, 'predictions.json')).entries.find((x) => x.kind === 'daily'),
    result: readJson(path.join(h.dataDir, 'events.json'), { entries: [] }).entries.find((x) => x.kind === 'result'),
    main: readJson(path.join(h.dataDir, 'ledger.json'), { entries: [] }).entries.find((x) => x.entryType === 'main'),
  }
}

test('3D 出号流水线 smoke（auto 全流程）：7 位期号顺延 · 直选一注规格 stamps · predict 事件 gameName=福彩3D · 唤醒提示词契约', async () => {
  const h = mkHarness({ fetch: default3dFetch(), picks: { digits: [6, 0, 7] }, cfgPatch: D3_CFG })
  try {
    await h.sched.tick()
    const preds = await waitPreds(h, 1)
    const e = preds.entries[0]
    assert.equal(e.kind, 'daily')
    assert.equal(e.game, '3d')
    assert.equal(e.issue, '2026322', '福彩 7 位期号顺延（2026321 → 2026322，与 ssq 同款四位年）')
    assert.equal(e.tier, '3d-x1', '⑥ stamp tier = 3D 轻量档')
    assert.deepEqual([e.bets, e.cost], [1, 2], '直选一注 2 元（与排列三完全对齐，拍板 #6）')
    assert.equal(e.spec, '直选一注')
    assert.ok(e.baselinePicks && e.baselinePicks.digits.length === 3, '随机基线同构（三位）')
    const stt = readJson(path.join(h.dataDir, 'state.json'))
    assert.equal(stt.games['3d'].phase, 'predicted', 'FZ-5 相位：idle → predicted')
    assert.equal(stt.games['3d'].picksLine, '直选 6-0-7')
    const pe = readJson(path.join(h.dataDir, 'events.json'), { entries: [] }).entries.find((x) => x.kind === 'predict')
    assert.ok(pe, 'predict 事件已产生')
    assert.ok(pe.body.startsWith('🐟【锦鲤 · 福彩3D · 第 2026322 期'), 'gameName=福彩3D（事件层落库为固定字段集，gameName 经渲染标题入 body）')
    // 唤醒提示词契约（prompt.js 通用分支对 3d 的产出面）
    const p = h.prompts.find((t) => t.includes('predict-3d-'))
    assert.ok(p, '3D 唤醒提示词已发出')
    assert.ok(p.includes('福彩3D今晚开奖（21:15 开奖 · 20:00 停售）'), '彩种名与开奖时刻（docs/31 §5 21:15）')
    assert.ok(p.includes('直选一注：三位数 0–9（百位-十位-个位，如 3-7-1）'), '玩法规格（通用分支）')
    assert.ok(p.includes('百位-十位-个位（比如「6-4-7」）'), '号码写法提示')
    assert.ok(p.includes('"picks":{"digits":[3个整数]}'), 'JSON 交卷契约（档位感知单注形态）')
    assert.ok(p.includes('不改变中奖概率') || p.includes('不得宣称'), '诚实基调句在场')
  } finally { h.sched.stop() }
})

test('3D 对账：直选三位全对中 1040 入账本（judge 通用分支零改本体）+ 战果文案 gameName/开奖/合计 + 增量入库 + settled 相位', async () => {
  const h = mkHarness({ fetch: default3dFetch(), picks: { digits: [6, 0, 7] }, cfgPatch: D3_CFG })
  try {
    const { entry, result, main } = await settle3d(h)
    assert.equal(entry.settled, true)
    assert.equal(entry.settleState, 'settled')
    assert.equal(entry.prize, 1040, '直选 1040（与 P3_ZHIXUAN 同通用奖级，judge 本体零改动）')
    assert.equal('nearMiss' in entry, false, '全对直选不是 near-miss')
    assert.equal(main.cost, 2, '账本按 3d-x1 记 2 元（BC-006 正式口径，docs/31 3D 同构 p3 进 ledger）')
    assert.equal(main.prize, 1040)
    assert.equal(main.game, '3d')
    assert.ok(result.body.startsWith('🎰【锦鲤战果 · 福彩3D · 第 2026322 期】'), 'gameName=福彩3D（TF-17 战果正文直传，settleText g.name）')
    assert.equal(result.won, true, '中奖标记（红点/未读口径仍只认 won）')
    const ls = result.body.split('\n')
    assert.equal(ls[0], '🎰【锦鲤战果 · 福彩3D · 第 2026322 期】')
    assert.equal(ls[1], '开奖：6 0 7')
    assert.equal(ls[2], '我们的号：直选 6-0-7')
    assert.equal(ls[3], '（直选一注 · 1 注 / 2 元）')
    assert.equal(ls[4], '结果：直选×1')
    assert.equal(ls[5], '本回合计：中 1040 元')
    assert.ok(ls.some((l) => l.includes('模拟账本')), '账本累计行在场')
    const draws = readJson(path.join(h.dataDir, 'draws', '3d.json'), { entries: [] })
    assert.ok((draws.entries ?? []).some((d) => d.issue === '2026322'), '④ 对账抓取双消费入库（BC-105）')
    assert.equal(readJson(path.join(h.dataDir, 'state.json')).games['3d'].phase, 'settled')
  } finally { h.sched.stop() }
})

test('3D 对账期号跳跃：官方已到下一期 → 翻历史核实目标期公布即按公布结清（C1 FR-001 路径对 3d 生效）', async () => {
  // fetchLatestDraw 返回 2026323（官方已到下一期）；两阶段夹具按回看窗口宽度区分时点：
  //   count≥100 = predict 铺底（17:35 官方最新 2026321，2026322 当晚 21:15 才开）；
  //   count=50（VOID_HISTORY_COUNT）= 对账跳跃回看（22:05+ 官方历史已含已公布的目标期 2026322）
  const base = default3dFetch()
  const h = mkHarness({
    picks: { digits: [6, 0, 7] },
    fetch: {
      ...base,
      fetchHistory: async (game, count) => {
        if (game === '3d') {
          const preDraw = count >= 100   // 铺底窗口（predict 时点）：官方最新 2026321；回看窗口：已含公布的目标期 2026322
          const latest = preDraw ? 2026321 : 2026322
          return Array.from({ length: 30 }, (_, i) => ({
            issue: String(latest - i),
            date: new Date(Date.parse(preDraw ? '2026-10-24' : '2026-10-25') - i * 86_400_000).toLocaleDateString('sv-SE'),
            digits: !preDraw && i === 0 ? [6, 0, 7] : [(i + 2) % 10, 0, 7],   // 目标期 2026322 = 6-0-7（与我们押的号一致）
          }))
        }
        return base.fetchHistory(game, count)
      },
      fetchLatestDraw: async (game) => game === '3d'
        ? { issue: '2026323', date: '2026-10-26', digits: [1, 2, 3], prizeGrades: { 1: 1040 } }
        : base.fetchLatestDraw(game),
    },
    cfgPatch: D3_CFG,
  })
  try {
    const { entry, result } = await settle3d(h)
    assert.equal(entry.issue, '2026322', 'predict 目标期 = 2026322（铺底窗口官方最新 2026321）')
    assert.equal(entry.settled, true, '目标期 2026322 翻历史核实已公布 → 结清（不作废不放弃）')
    assert.equal(entry.settleState, 'settled')
    assert.equal(entry.prize, 1040, '按目标期官方号码判奖（6-0-7 直选）')
    assert.ok(result && result.body.startsWith('🎰【锦鲤战果 · 福彩3D · 第 2026322 期】'))
    const draws = readJson(path.join(h.dataDir, 'draws', '3d.json'), { entries: [] })
    assert.ok((draws.entries ?? []).some((d) => d.issue === '2026322'), '④ 抓过即入库（跳跃回看历史批次双消费 BC-105）')
  } finally { h.sched.stop() }
})

test('3D near-miss NM-2：两位对入档 + result 事件携带 + §4.3 文案原文 + 账本诚实记 0（BC-006）', async () => {
  const h = mkHarness({
    picks: { digits: [0, 4, 7] },
    fetch: { ...default3dFetch(), fetchLatestDraw: async (g) => g === '3d' ? { issue: '2026322', date: '2026-10-25', digits: [0, 6, 7], prizeGrades: { 1: 1040 } } : null },
    cfgPatch: D3_CFG,
  })
  try {
    const { entry, result, main } = await settle3d(h)
    assert.equal(entry.prize, 0, '直选没奖前置成立（顺序错）')
    assert.equal(entry.nearMiss, 'NM-2', 'judgeNearMiss 3d 生效门：两位对入档（FZ-3 只加字段）')
    assert.equal(main.prize, 0, 'NM 永不进 ledger（直选没奖账本记 0）')
    assert.equal('nearMiss' in main, false, 'ledger 条目零 nearMiss 字段')
    assert.equal(result.nearMiss, 'NM-2', 'result 事件携带 nearMiss（桥接谓词 3d 自动覆盖）')
    assert.equal(result.won, false)
    assert.ok(result.body.includes('047 对 067，两位都对就差一位……气人！不过直选就是直选，账本记 0，锦鲤不找借口。'), '§4.3 NM-2 占位文案原文（数字代入）')
    for (const banned of ['差一点就是', '好运在积累', '下次稳了', '大概率']) assert.ok(!result.body.includes(banned), `禁止诱导框架零命中：${banned}`)
  } finally { h.sched.stop() }
})

test('3D near-miss NM-1：组选命中（607 vs 067 需求起源形态）§4.3 文案整行 + 行序（本回合计后/诚实句前）', async () => {
  const h = mkHarness({
    picks: { digits: [6, 0, 7] },
    fetch: { ...default3dFetch(), fetchLatestDraw: async (g) => g === '3d' ? { issue: '2026322', date: '2026-10-25', digits: [0, 6, 7], prizeGrades: { 1: 1040 } } : null },
    cfgPatch: D3_CFG,
  })
  try {
    const { entry, result } = await settle3d(h)
    assert.equal(entry.nearMiss, 'NM-1')
    assert.equal(entry.prize, 0)
    const ls = result.body.split('\n')
    assert.equal(ls.length, 10, '经典 9 行 + NM 叙事 1 行')
    assert.equal(ls[6], '气死气死！我们押的 607，开奖 067——三个数字一个不差，顺序全拧了！直选没奖，账本老老实实记 0 元。', '§4.3 NM-1 占位文案原文（3D 同文案面）')
    assert.ok(ls[5].startsWith('本回合计：'), '叙事段紧跟本回合计')
    assert.ok(ls[7].startsWith('同刻随机对照'), '叙事段在对照行之前')
    assert.equal(ls[9], '开奖是随机的，图个乐～ 明天继续攒运气！', '常驻诚实句仍是末行')
  } finally { h.sched.stop() }
})

test('3D 无 NM 轮正文与既有格式逐位一致（9 行零变化）；开奖 9-9-9 三位流水展示', async () => {
  const h = mkHarness({
    picks: { digits: [0, 4, 7] },
    fetch: { ...default3dFetch(), fetchLatestDraw: async (g) => g === '3d' ? { issue: '2026322', date: '2026-10-25', digits: [9, 9, 9], prizeGrades: { 1: 1040 } } : null },
    cfgPatch: D3_CFG,
  })
  try {
    const { entry, result } = await settle3d(h)
    assert.equal('nearMiss' in entry, false, '零位对条目零新字段（与既有输出逐位一致）')
    const ls = result.body.split('\n')
    assert.equal(ls.length, 9)
    assert.deepEqual(ls.slice(0, 6), [
      '🎰【锦鲤战果 · 福彩3D · 第 2026322 期】',
      '开奖：9 9 9',
      '我们的号：直选 0-4-7',
      '（直选一注 · 1 注 / 2 元）',
      '结果：未中奖',
      '本回合计：中 0 元',
    ], '前六行逐位一致（TF-17 完整文案格式不动；gameName=福彩3D）')
    assert.equal(ls[8], '开奖是随机的，图个乐～ 明天继续攒运气！')
  } finally { h.sched.stop() }
})

test('3D 三态与永久基础层：off 不出号；manual 来一注放行并留痕（FR-1023 第四彩种同权）', async () => {
  const h1 = mkHarness({ fetch: default3dFetch(), cfgPatch: { modes: { ssq: { mode: 'off' }, dlt: { mode: 'off' }, p3: { mode: 'off' }, '3d': { mode: 'off', tier: '3d-x1' } } } })
  try {
    await h1.sched.tick()
    await sleep(400)
    assert.equal((readJson(path.join(h1.dataDir, 'predictions.json'), { entries: [] }).entries ?? []).length, 0, 'off 不出号')
    assert.equal(h1.sched.status().games['3d'].enabledToday, false, 'off 今天不开（MB-25 三态取值）')
  } finally { h1.sched.stop() }
  const h2 = mkHarness({ fetch: default3dFetch(), picks: { digits: [6, 0, 7] }, cfgPatch: { modes: { ssq: { mode: 'off' }, dlt: { mode: 'off' }, p3: { mode: 'off' }, '3d': { mode: 'manual', tier: '3d-x1' } } } })
  try {
    const r = h2.sched.quickpick('3d')
    assert.equal(r.ok, true, '三态任一放行（永久基础层）')
    const job = await waitJob(h2.sched, r.id)
    assert.equal(job.status, 'done')
    const preds = await waitPreds(h2, 1)
    assert.equal(preds.entries[0].kind, 'quickpick')
    assert.equal(preds.entries[0].game, '3d')
    assert.equal(preds.entries[0].manual, true, '手动号留痕（MA-26）')
    assert.equal(preds.entries[0].cost, 2, '3d-x1 2 元')
    assert.equal((readJson(path.join(h2.dataDir, 'ledger.json'), { entries: [] }).entries ?? []).length, 0, '加餐不入账本（AC-110）')
  } finally { h2.sched.stop() }
})

// ───────────────────────────── ⑧ no-model 短路 · 门控 · status 降级 ────────────────────

test('⑧ classifyHostError：no-model 命中返回配置指引；未命中走 other 原语义；quickpick 短路不兜底（AC-113）', async () => {
  assert.equal(classifyHostError(new Error('no model configured')).kind, 'no-model')
  assert.ok(classifyHostError(new Error('no model')).hint.includes('设置→模型'))
  assert.equal(classifyHostError(new Error('网络超时')).kind, 'other')
  assert.ok(Array.isArray(DEFAULT_NO_MODEL_PATTERNS) && DEFAULT_NO_MODEL_PATTERNS.length > 0, 'MD-09 保守种子表')
  // 集成：quickpick 路径直接返回指引、跳过打回重写与随机兜底
  const h = mkHarness({
    prompt: 'no-model',
    cfgPatch: { modes: { ssq: { mode: 'off' }, dlt: { mode: 'off' }, p3: { mode: 'manual', tier: 'p3-x1' } } },
  })
  try {
    const r = h.sched.quickpick('p3')
    const job = await waitJob(h.sched, r.id)
    assert.equal(job.status, 'error')
    assert.ok(job.error.includes('设置→模型'), '错误信息含模型配置指引（AC-113）')
    const preds = readJson(path.join(h.dataDir, 'predictions.json'), { entries: [] })
    assert.equal((preds.entries ?? []).length, 0, '不落兜底号（清晰失败优于静默兜底）')
  } finally { h.sched.stop() }
})

test('门控四项（S-116）：缺渠道/缺诚实条款逐项阻止；全满足开启成功并落 wizardDone', async () => {
  const h = mkHarness({ cfgPatch: { channels: [] } })   // 无渠道
  try {
    let r = await h.sched.setMode({ game: 'ssq', mode: 'auto' })
    assert.equal(r.ok, false)
    assert.ok(r.missing.some((m) => m.key === 'channel'), '缺渠道指明')
    h.writeCfg({ channels: [{ type: 'panel', enabled: true }] })
    r = await h.sched.setMode({ game: 'ssq', mode: 'auto' })
    assert.equal(r.ok, false)
    assert.ok(r.missing.some((m) => m.key === 'honestyAck'), '缺诚实条款指明（模板默认未勾选）')
    r = await h.sched.setMode({ game: 'ssq', mode: 'auto', gates: { honestyAck: true }, predictAt: '17:30' })
    assert.equal(r.ok, true, '渠道（panel 内置在位）+档位+时间+条款 → 放行')
    const cfg = readJson(h.configPath)
    assert.equal(cfg.modes.ssq.mode, 'auto')
    assert.equal(cfg.modes.ssq.wizardDone, true)
    assert.equal(cfg.modes.ssq.gates.honestyAck, true)
    // 时间晚于开奖被校验拒绝（predictAt ≥ drawAt 21:15）
    r = await h.sched.setMode({ game: 'ssq', mode: 'auto', predictAt: '21:30' })
    assert.equal(r.ok, false)
    assert.ok(r.errors.some((e) => e.includes('早于开奖')))
  } finally { h.sched.stop() }
})

test('status 降级语义（MB-25/FZ-6）：push 降级文案 + pushTargetMasked 空串值域连续 + modes/events/backbone/costEstimate 加法字段', async () => {
  const h = mkHarness({
    cfgPatch: {
      advisory: { enabled: false },
      modes: { ssq: { mode: 'off' }, dlt: { mode: 'off' }, p3: { mode: 'auto', tier: 'p3-x1', predictAt: '17:30', gates: { honestyAck: true } } },
    },
  })
  try {
    await h.sched.tick()
    await waitPreds(h, 1)
    const st = h.sched.status()
    // FZ-6 既有字段形状不变
    assert.equal(typeof st.push.ok, 'boolean')
    assert.equal(st.push.detail, '推送已迁移至渠道层，见 channels')
    assert.equal(st.pushTargetMasked, '', '无 qq 型渠道 → 空串（与 v1 空配置逐位一致）')
    assert.equal(st.repushQueue, 0)
    // 加法字段
    assert.equal(st.games.p3.mode, 'auto')
    assert.equal(st.modes.p3.tier, 'p3-x1')
    assert.ok(st.events && typeof st.events.heartbeatRed === 'boolean')
    assert.ok(st.backbone.p3.count >= 30, '本地库计数（backbone 透出）')
    assert.ok(st.costEstimate.currentForm && st.costEstimate.m3Projection, '成本估算双显示（MB-22）')
    assert.equal(st.tiers.p3.id, 'p3-x1')
    assert.equal(st.verbosity, 'concise')
    assert.equal(st.effort.tier, 'follow-host')
    assert.equal(st.effort.leverActive, true)
  } finally { h.sched.stop() }
})

test('心跳接线：22:35 对账日 tick → heartbeatCheckedAt 记录（幂等守卫）', async () => {
  const h = mkHarness({
    cfgPatch: {
      advisory: { enabled: false },
      modes: { ssq: { mode: 'off' }, dlt: { mode: 'off' }, p3: { mode: 'auto', tier: 'p3-x1', predictAt: '17:30', gates: { honestyAck: true } } },
    },
  })
  try {
    await h.sched.tick()
    await waitPreds(h, 1)
    h.setNow(new Date('2026-10-25T22:35:00'))
    await h.sched.tick()
    const stt = readJson(path.join(h.dataDir, 'state.json'))
    assert.equal(stt.heartbeatCheckedOn, '2026-10-25', '当日判定过')
    assert.ok(stt.heartbeatCheckedAt)
    await h.sched.tick()   // 同日第二次 tick 不重复判定
    assert.equal(readJson(path.join(h.dataDir, 'state.json')).heartbeatCheckedOn, '2026-10-25')
  } finally { h.sched.stop() }
})

test('advisory 接线（auto 出号后）：预注册→生成→advice 事件恒带不记账标注（MC-12 auto-only）', async () => {
  const h = mkHarness({
    cfgPatch: {
      modes: { ssq: { mode: 'off' }, dlt: { mode: 'off' }, p3: { mode: 'auto', tier: 'p3-x1', predictAt: '17:30', gates: { honestyAck: true } } },
    },
  })
  try {
    await h.sched.tick()
    await waitPreds(h, 1)
    const t0 = Date.now()
    while (Date.now() - t0 < 8000) {
      const adv = readJson(path.join(h.dataDir, 'advisory', 'p3-2026-10-25.json'), null)
      if (adv?.generatedAt) break
      await sleep(100)
    }
    const adv = readJson(path.join(h.dataDir, 'advisory', 'p3-2026-10-25.json'))
    assert.ok(adv.preregisteredAt <= adv.generatedAt, 'AC-111：判据落盘早于建议产出')
    assert.equal(adv.recommendedTier, 'p3-x1')
    assert.ok(adv.criteria.tierCosts.length === 3, 'p3 三档成本入判据')
    assert.ok(adv.criteria.factorNote.includes('M3'), '因子战绩随 M3 如实标注')
    assert.equal(adv.criteria.ledgerPerTier['p3-x1']?.draws, 1, '判据含当期账本按档聚合（刚出号 1 条）')
    const evs = readJson(path.join(h.dataDir, 'events.json'), { entries: [] }).entries
    const ae = evs.find((x) => x.kind === 'advice')
    assert.ok(ae, 'advice 事件产生')
    assert.ok(ae.body.includes('不计入账本统计'), '恒标注')
    assert.ok(ae.body.includes('不会自动改变你的投注档位'), '固定句恒拼（TF-18 白话化）')
    // 配置隔离断言：advisory 输出永不写 modes.tier（FZ-7——modes.tier 仍是用户配置值）
    assert.equal(readJson(h.configPath).modes.p3.tier, 'p3-x1', '建议不自动改正式档位')
  } finally { h.sched.stop() }
})

// ───────────────────────────── 停购倒计时（docs/31 §6 第三批：P12 内容源拍板 #7 = A 停购倒计时，TF-6 第三次豁免 v1.4）─────────────────────────────
// 全局每日 19:30 一条（当日有开奖彩种才播）；panelOnly 载体 + 桌宠气泡白名单 ③；不入账本不入红点。

const CD_CFG = { advisory: { enabled: false }, modes: { ssq: { mode: 'off' }, dlt: { mode: 'off' }, p3: { mode: 'off' }, '3d': { mode: 'off' } } }

test('停购倒计时·19:30 触发：全局恰一条（幂等守卫）· §4.3 占位原文+倒计时数字+今晚开奖行 · panelOnly/noRetry 事件形状', async () => {
  const h = mkHarness({ cfgPatch: CD_CFG })   // 默认 now=2026-10-25T17:35（周日：ssq+p3+3d 三彩种开奖）
  try {
    await h.sched.tick()   // 17:35：早于 19:30 不触发
    let evs = readJson(path.join(h.dataDir, 'events.json'), { entries: [] }).entries
    assert.equal(evs.filter((e) => e.kind === 'countdown').length, 0, '19:30 前不触发')
    h.setNow(new Date('2026-10-25T19:30:00'))
    await h.sched.tick()
    evs = readJson(path.join(h.dataDir, 'events.json'), { entries: [] }).entries
    const cds = evs.filter((e) => e.kind === 'countdown')
    assert.equal(cds.length, 1, '19:30 恰触发一条（全局每日 1 条，非每彩种 1 条）')
    const cd = cds[0]
    // 正文（docs/31 §4.3 占位原文逐字 + 自拟行【主人可改】）
    const ls = cd.body.split('\n')
    assert.equal(ls[0], '⏰【锦鲤 · 停购倒计时】')
    assert.equal(ls[1], '离今晚停售还有 30 分钟——要买要趁早，锦鲤的号已经在路上啦！', '§4.3 占位文案原文逐字（倒计时数字 30 = 20:00−19:30 现算）')
    assert.equal(ls[2], '今晚开奖：双色球（21:15 开奖）、排列三（21:25 开奖）、福彩3D（21:15 开奖）', '下一期开奖彩种与时刻（gamesForDate+drawAt 开奖日历现算，周日=ssq+p3+3d）')
    assert.equal(ls[3], '（20:00 停售，各省或有分钟级差异，以当地公告为准）', '停售差异行（docs/31 拍板 #7 注记）')
    // 事件形状（panelOnly 载体 + 红点口径不变）
    assert.equal(cd.panelOnly, true, 'TF-6 收敛口径：QQ 等用户渠道不投（review 同款载体）')
    assert.deepEqual(cd.delivery.map((d) => d.channel), ['panel'], 'delivery 仅 panel 渠道')
    assert.equal(cd.status, 'sent', 'panel 出厂启用 → 送达')
    assert.equal(cd.noRetry, true, '时效性内容一次即止（FR-005 例外口径同 quickpick/test——补发的倒计时无意义）')
    assert.equal(cd.won, null, 'won 恒 null（红点/未读只认 won——倒计时绝不触发 winUnreadCount）')
    assert.equal(cd.nearMiss, null, 'nearMiss 恒 null（非战果事件）')
    assert.equal(cd.game, null, '全局事件（非 per-game）')
    // 幂等：同日再 tick 不重复
    await h.sched.tick()
    evs = readJson(path.join(h.dataDir, 'events.json'), { entries: [] }).entries
    assert.equal(evs.filter((e) => e.kind === 'countdown').length, 1, '同日第二次 tick 不重复（state.countdownOn 当日守卫，同心跳模式）')
    assert.equal(readJson(path.join(h.dataDir, 'state.json')).countdownOn, '2026-10-25')
  } finally { h.sched.stop() }
})

test('停购倒计时·当日无开奖（休市日）不播：holidays 命中 → 19:30 零播；次日非休市恢复且日历随日期走（P13「当日有开奖彩种才播」）', async () => {
  const h = mkHarness({ cfgPatch: { ...CD_CFG, holidays: ['2026-10-25'] } })
  try {
    h.setNow(new Date('2026-10-25T19:30:00'))
    await h.sched.tick()
    let evs = readJson(path.join(h.dataDir, 'events.json'), { entries: [] }).entries
    assert.equal(evs.filter((e) => e.kind === 'countdown' && e.at.slice(0, 10) === '2026-10-25').length, 0, '休市日零播（休市无开奖无停售——整段在 !holiday 外跳过）')
    assert.equal(readJson(path.join(h.dataDir, 'state.json')).countdownOn ?? null, null, '未标记当日已播')
    // 次日（2026-10-26 周一：dlt+p3+3d 开奖，非休市）恢复播报——每日重置
    h.setNow(new Date('2026-10-26T19:30:00'))
    await h.sched.tick()
    evs = readJson(path.join(h.dataDir, 'events.json'), { entries: [] }).entries
    const cds = evs.filter((e) => e.kind === 'countdown' && e.at.slice(0, 10) === '2026-10-26')
    assert.equal(cds.length, 1, '非休市日恢复：恰一条')
    assert.ok(cds[0].body.includes('大乐透'), '开奖面随日历现算（周一=dlt+p3+3d，周日=ssq+p3+3d）')
  } finally { h.sched.stop() }
})

test('停购倒计时·不入账本不入红点：ledger 零变化 · 出号流水线零触碰 · winUnreadCount 恒 0 · 过停售线不播', async () => {
  const h = mkHarness({ cfgPatch: CD_CFG })
  try {
    h.setNow(new Date('2026-10-25T19:30:00'))
    await h.sched.tick()
    assert.equal(fs.existsSync(path.join(h.dataDir, 'ledger.json')), false, 'ledger 零生成（BC-006 账本口径零变化——倒计时不是投注）')
    const preds = readJson(path.join(h.dataDir, 'predictions.json'), { entries: [] })
    assert.equal((preds.entries ?? []).length, 0, '不走预测流水线（零 daily 条目）')
    const cd = readJson(path.join(h.dataDir, 'events.json'), { entries: [] }).entries.find((e) => e.kind === 'countdown')
    assert.ok(cd, 'countdown 事件在场')
    assert.equal(cd.won, null, 'won=null 前置')
    assert.equal(winUnreadCount([{ id: 'c1', kind: 'countdown', won: null }, { id: 'c2', kind: 'predict', won: null }, cd], null), 0, '红点恒 0（winUnreadCount 只认 won===true，主人 2026-10-25 拍板口径零变化）')
    // 过停售线（20:00）不播：进程缺席整个 19:30–20:00 窗口 → 当日静默（「还有 N 分钟」为假宁缺毋假）
    h.setNow(new Date('2026-10-27T20:05:00'))   // 周二 ssq+p3+3d 开奖、非休市
    await h.sched.tick()
    const evs = readJson(path.join(h.dataDir, 'events.json'), { entries: [] }).entries
    assert.equal(evs.filter((e) => e.kind === 'countdown' && e.at.slice(0, 10) === '2026-10-27').length, 0, '过停售线静默（时效性内容补发无意义）')
  } finally { h.sched.stop() }
})
