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
import { readJson } from '../lib/io.js'

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'koi-sched-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const P3_RESULT_26283 = { issue: '26283', date: '2026-10-25', digits: [6, 4, 7], prizeGrades: { 1: 1040 } }

// ── 测试台：可编程假会话（按提示词内容写交卷文件）+ 可编程抓取 + 可注入时钟 ─────────
function mkHarness({ cfgPatch = {}, now = new Date('2026-10-25T17:35:00'), fetch, prompt, picks: picksOverride = null } = {}) {
  const dir = tmpdir()
  const configPath = path.join(dir, 'koi.config.json')
  const dataDir = path.join(dir, 'koi')
  const workDir = path.join(dir, 'koi-work')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify({ schemaVersion: 2, ...buildConfigDefaults(), ...cfgPatch }))
  let t = now
  const ctx = {
    sessionController: {
      create: async () => {},
      prompt: async (req) => {
        const text = req.content[0].text
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
    sched, dir, configPath, dataDir, workDir,
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
