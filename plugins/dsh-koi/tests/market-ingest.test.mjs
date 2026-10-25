/**
 * 第二波 T6 + T8 —— 学习摄入流水线（lib/ingest.js）与因子化（lib/factorize.js）单测
 * （docs/19 §4/§5.7；FR-1013/1014、S-107/118/119、BC-012/107、W2A-12/20/22/23）。
 * 全离线：mock promptAgent 按提示词里的文件契约路径写交卷；上传三通道/守卫/预算预检/
 * 拆卡三路（合格/打回/超时待补）/去重三态/pending-llm 重试与回滚幂等/错峰 queued/
 * job-lock 排队/因子化链式触发（拆卡 done → 逐卡因子化 → 回测 → 回写）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createIngest, estimateTokensFromBytes } from '../lib/ingest.js'
import { createCardsStore, nameKey, ruleTokens, jaccard, findRuleDup } from '../lib/cards.js'
import { createBacktestWithBuiltins } from '../lib/backtest.js'
import { createJobLock } from '../lib/joblock.js'
import { createUsageTracker, demotionFor } from '../lib/usage.js'
import { validateFactorSpec, factorizeCard, METRICS } from '../lib/factorize.js'

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'koi-ing-'))
const NOON = () => new Date('2026-10-25T12:00:00')
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms))

/** 随机 ssq 数据（回测链用；≥131 期满足 minRounds） */
function randSsq(n, seed = 5) {
  let a = seed >>> 0
  const rnd = () => { let t = (a += 0x6D2B79F5); t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
  return Array.from({ length: n }, (_, i) => {
    const s = new Set()
    while (s.size < 6) s.add(1 + Math.floor(rnd() * 33))
    return { issue: String(2026001 + i), date: '2026-01-01', red: [...s].sort((x, y) => x - y), blue: 1 + Math.floor(rnd() * 16) }
  })
}

const CARDS_OK = {
  schemaVersion: 1,
  cards: [
    { name: '和值区间法', games: ['ssq'], rule: '红球六码和值长期落在 90 至 130 区间。', computable: true, dupOf: null, similarTo: null },
    { name: '心态平稳论', games: ['ssq'], rule: '保持心态平稳，贵在坚持。', computable: false, dupOf: null, similarTo: null },
  ],
}

/** mock promptAgent：按提示词内的契约路径写交卷（splitPrompt / factorizePrompt 各自可配） */
function mkAgent({ split = () => CARDS_OK, factorize, calls = [] } = {}) {
  return {
    calls,
    agent: async (text) => {
      calls.push(text)
      const m = String(text).match(/(\S+\.cards\.p?\d*\.json)/)
      if (m) { const payload = split(text); if (payload) fs.writeFileSync(m[1], JSON.stringify(payload)); return }
      const f = String(text).match(/(\S+factorize-\S+\.json)/)
      if (f) { const payload = factorize ? factorize(text) : { schemaVersion: 1, conditions: [{ metric: 'sum', op: 'in', range: [60, 240] }], claimHuman: '和值带宽泛', unparseable: false }; if (payload) fs.writeFileSync(f[1], JSON.stringify(payload)) }
    },
  }
}

function mkIngest({ dir, agent, readCfg = () => ({}), now = NOON, lockHeld = false, drawData } = {}) {
  const cardsStore = createCardsStore({ dataDir: dir, now })
  const usage = createUsageTracker({ dataDir: dir, now })
  const lock = createJobLock({ file: path.join(dir, 'job-lock.json'), now })
  if (lockHeld) lock.acquire('backfill', 'ssq')
  const backtest = createBacktestWithBuiltins({
    dataDir: dir, cardsStore, now, lock,
    drawStore: { getRecent: (g) => [...(drawData ?? randSsq(200))].reverse() },
    readCfg, log: () => {},
  })
  const ingest = createIngest({
    dshHome: dir, cardsStore, usage, lock,
    promptAgent: agent, now, readCfg, log: () => {}, backtest,
    budgetState: () => ({ totals: usage.weekTotals(), demo: demotionFor({ used: usage.weekTotals().total, cap: Number(readCfg()?.budget?.weeklyCap) > 0 ? Number(readCfg().budget.weeklyCap) : 1_500_000 }) }),
    waitMs: 400,
  })
  return { ingest, cardsStore, usage, lock, backtest }
}

test('上传面 token 估算口径：字节/12（BC-107 补位）；415 格式拒收文案 / 413 超限', () => {
  assert.equal(estimateTokensFromBytes(1200), 100)
  assert.equal(estimateTokensFromBytes(0), 0)
  const { ingest } = mkIngest({ dir: tmpdir() })
  const bad = ingest.acceptBuffer({ name: '书.pdf', buffer: Buffer.from('%PDF-1.4'), process: false })
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 415)
  assert.ok(bad.error.includes('支持 .txt / .md') && bad.error.includes('暂不支持直接解析'), 'S-118 拒收并说明')
  const big = ingest.acceptBuffer({ name: '大书.txt', buffer: Buffer.alloc(1024 * 1024 + 1), process: false, readCfg: {} }, )
  // 默认 20MB 不触发；用小上限配置验证
  const { ingest: ing2 } = mkIngest({ dir: tmpdir(), readCfg: () => ({ ingest: { maxFileMB: 1 } }) })
  const over = ing2.acceptBuffer({ name: '大书.txt', buffer: Buffer.alloc(1024 * 1024 + 1), process: false })
  assert.equal(over.ok, false)
  assert.equal(over.code, 413)
  assert.ok(big.ok === true, '默认 20MB 内放行')
  const ok = ing2.acceptBuffer({ name: '书.md', buffer: Buffer.from('# 技巧\n和值 90-130。'), process: false })
  assert.equal(ok.ok, true)
  assert.equal(ok.estimate, Math.ceil(Buffer.from('# 技巧\n和值 90-130。').length / 12))
})

test('清洗守卫：清洗后为空 rejected；maxCleanChars 超限 rejected（分卷提示，W2A-22）', async () => {
  const empty = mkIngest({ dir: tmpdir(), agent: mkAgent().agent })
  const r1 = await empty.ingest.processJob(empty.ingest.acceptBuffer({ name: '图.txt', buffer: Buffer.from('![x](y)\n42\n。。。'), process: false }).job.id)
  assert.equal(r1.job.status, 'rejected')
  assert.ok(r1.job.error.includes('清洗后无可读文本'))
  const small = mkIngest({ dir: tmpdir(), agent: mkAgent().agent, readCfg: () => ({ ingest: { maxCleanChars: 10 } }) })
  const r2 = await small.ingest.processJob(small.ingest.acceptBuffer({ name: '书.txt', buffer: Buffer.from('这是一段超过十个字符的正文内容，显然超过上限。'), process: false }).job.id)
  assert.equal(r2.job.status, 'rejected')
  assert.ok(r2.job.error.includes('超上限') && r2.job.error.includes('分卷'), r2.job.error)
})

test('预算预检（W2A-22）：估算超本周剩余 → rejected（拆卡之前、零 LLM 成本）；预算触顶 → queued 等待', async () => {
  const dir = tmpdir()
  const { ingest, usage } = mkIngest({ dir, agent: mkAgent().agent, readCfg: () => ({ budget: { weeklyCap: 10 } }) })   // 周预算 10 tokens
  usage.record('predict', 8)   // 已用 8 → 剩 2；清洗文本 >8 字符 → est ≥ 3 > 2
  const r = await ingest.processJob(ingest.acceptBuffer({ name: '书.txt', buffer: Buffer.from('和值区间：红球六码和值长期落在 90 至 130 区间，超出后回归。'), process: false }).job.id)
  assert.equal(r.job.status, 'rejected')
  assert.ok(r.job.error.includes('超本周剩余额度'), r.job.error)
  // 预算触顶（pauseLearning=true——M3 满配投影等口径下的独立降档面）：job 停 queued 等自然周重置
  const dir2 = tmpdir()
  const cardsStore = createCardsStore({ dataDir: dir2, now: NOON })
  const ing2 = createIngest({
    dshHome: dir2, cardsStore, usage: createUsageTracker({ dataDir: dir2, now: NOON }),
    lock: createJobLock({ file: path.join(dir2, 'job-lock.json'), now: NOON }),
    promptAgent: mkAgent().agent, now: NOON, readCfg: () => ({}), log: () => {}, backtest: null, waitMs: 400,
    budgetState: () => ({ totals: { total: 500 }, demo: { pauseLearning: true, ratio: 1 } }),
  })
  const r2 = await ing2.processJob(ing2.acceptBuffer({ name: '书.txt', buffer: Buffer.from('和值区间技巧正文。'), process: false }).job.id)
  assert.equal(r2.job.status, 'queued')
  assert.ok(r2.job.waitingNote.includes('预算触顶'))
})

test('拆卡合格路：清洗落盘 → 卡片入库（信任级 mid/DC-003 必填）→ 链式因子化 → 回测结论回写卡片（W2A-23）', async () => {
  const dir = tmpdir()
  const { calls } = { calls: [] }
  const { agent } = mkAgent({ calls })
  const { ingest, cardsStore } = mkIngest({ dir, agent })
  const up = ingest.acceptBuffer({ name: '技巧大全.md', buffer: Buffer.from('# 技巧\n和值区间：红球六码和值落在 90-130。\n\n心态：稳住。\n'), process: false })
  const r = await ingest.processJob(up.job.id)
  assert.equal(r.job.status, 'done', r.job.error)
  assert.equal(r.job.cards.length, 2)
  assert.ok(r.job.cards.some((c) => c.verdict === 'new' && c.name === '和值区间法'))
  const cards = cardsStore.list()
  assert.equal(cards.length, 2)
  assert.equal(cards.every((c) => c.trustLevel === 'mid'), true, '用户上传默认信任级「中」')
  assert.equal(cards.every((c) => c.status === 'active'), true)
  // 清洗文本与原件落盘（审计面）
  assert.ok(fs.existsSync(path.join(ingest.FILES_DIR, `${up.job.id}.md`)))
  assert.ok(fs.existsSync(path.join(ingest.FILES_DIR, `${up.job.id}.clean.md`)))
  // 链式：computable 卡 → 因子化（DSL sum）→ 注册 → 回测 → factorId + backtest 回写
  const factored = cards.find((c) => c.name === '和值区间法')
  const after = cardsStore.get(factored.id)
  assert.equal(after.factorId, `card-${after.id}`)
  assert.ok(after.backtest, '回测结论回写')
  assert.ok(['better-in-sample', 'no-advantage'].includes(after.backtest.verdict))
  // 非计算卡（computable=false）不因子化、无结论
  const mind = cardsStore.list().find((c) => c.name === '心态平稳论')
  assert.equal(mind.factorId, null)
  assert.equal(mind.backtest, null)
  // 拆卡与因子化都经同一会话（activity=learning 由注入方包装——此处仅断言调用面）
  assert.ok(calls.length >= 2, '拆卡 1 次 + 因子化 ≥1 次')
})

test('拆卡打回路：第一次交卷不合格 → 打回重写 → 合格入库', async () => {
  const dir = tmpdir()
  let n = 0
  const { agent } = mkAgent({ split: () => { n += 1; return n === 1 ? { schemaVersion: 1, cards: [{ name: '缺规则', games: ['ssq'] }] } : CARDS_OK } })
  const { ingest, cardsStore } = mkIngest({ dir, agent })
  const up = ingest.acceptBuffer({ name: '书.txt', buffer: Buffer.from('和值技巧正文若干。'), process: false })
  const r = await ingest.processJob(up.job.id)
  assert.equal(r.job.status, 'done')
  assert.equal(cardsStore.list().length, 2, '打回重写后入库')
})

test('拆卡超时 → pending-llm（S-119）；pumpJobs 恢复后自动重试成功；重跑回滚幂等（sourceJob 索引）', async () => {
  const dir = tmpdir()
  const { agent: silent } = mkAgent({ split: () => null })
  const { ingest, cardsStore, usage } = mkIngest({ dir, agent: silent })
  const up = ingest.acceptBuffer({ name: '书.txt', buffer: Buffer.from('和值技巧正文。'), process: false })
  const r1 = await ingest.processJob(up.job.id)
  assert.equal(r1.job.status, 'pending-llm')
  assert.ok(r1.job.error.includes('暂不可用') || r1.job.error.includes('交卷'))
  // 手动模拟「上一轮已写入部分卡片」（双写间隙）——重试前应按 sourceJob 回滚，不重复入库
  cardsStore.addCards([{ name: '旧卡', games: ['ssq'], rule: '旧', computable: false }], { sourceJob: up.job.id })
  // 恢复：换可用 agent 重试
  const good = mkAgent({ split: () => ({ ...CARDS_OK, cards: CARDS_OK.cards.slice(0, 1) }) })
  ingest2: {
    // 同目录新建 ingest（真实场景由宿主 tick 驱动；此处直接调用 pumpJobs 等价）
  }
  const ing = createIngest({
    dshHome: dir, cardsStore, usage,
    lock: createJobLock({ file: path.join(dir, 'job-lock.json'), now: NOON }),
    promptAgent: good.agent, now: NOON, readCfg: () => ({}), log: () => {},
    backtest: null, waitMs: 400,
  })
  const pump = await ing.pumpJobs()
  assert.equal(pump.retried, up.job.id, 'pending-llm 被 tick 驱动重试')
  const job = ing.getJob(up.job.id)
  assert.equal(job.status, 'done', job.error)
  const names = cardsStore.list().map((c) => c.name)
  assert.ok(!names.includes('旧卡'), '重跑前按 sourceJob 回滚（绝不静默重复入库）')
  assert.equal(names.length, 1, '只保留重试成功后的卡片')
})

test('no-model → 直接 rejected（配置指引文案，不进 pending-llm；FR-1022/S-117）', async () => {
  const dir = tmpdir()
  const noModel = async () => { throw new Error('宿主未配置模型，请先在 DSH 设置中配置模型（入口：设置→模型），配置后重试') }
  const { ingest } = mkIngest({ dir, agent: noModel })
  const up = ingest.acceptBuffer({ name: '书.txt', buffer: Buffer.from('和值技巧正文。'), process: false })
  const r = await ingest.processJob(up.job.id)
  assert.equal(r.job.status, 'rejected')
  assert.ok(r.job.error.includes('配置模型'), r.job.error)
})

test('去重三态（W2A-12）：duplicate-of 不入库 / similar-to 入库带指针 / rule-dup 保守拒入；rule-only 模式跳过 LLM 判重', async () => {
  const dir = tmpdir()
  const { agent } = mkAgent()
  const { ingest, cardsStore } = mkIngest({ dir, agent })
  // 既有卡
  cardsStore.addCards([{ name: '蓝球追热法', games: ['ssq'], rule: '近 30 期出现 3 次以上的蓝球至少一个再出。', computable: true }], { source: '旧.md' })
  const existingId = cardsStore.list()[0].id
  const DUP = {
    schemaVersion: 1,
    cards: [
      { name: '蓝球追热法（完全同义）', games: ['ssq'], rule: '近 30 期出现 3 次以上的蓝球至少一个再出。', computable: true, dupOf: existingId, similarTo: null },
      { name: '蓝球追热法变体', games: ['ssq'], rule: '近 30 期出现 3 次以上的蓝球中两个再出（区间不同）。', computable: true, dupOf: null, similarTo: existingId },
      { name: '和值区间法', games: ['ssq'], rule: '红球六码和值长期落在 90 至 130 区间。', computable: true, dupOf: 'card-不存在的id', similarTo: null },
    ],
  }
  const custom = mkAgent({ split: () => DUP })
  const ing = createIngest({
    dshHome: dir, cardsStore, usage: createUsageTracker({ dataDir: dir, now: NOON }),
    lock: createJobLock({ file: path.join(dir, 'job-lock.json'), now: NOON }),
    promptAgent: custom.agent, now: NOON, readCfg: () => ({}), log: () => {}, backtest: null, waitMs: 400,
  })
  // 第三张：dupOf 白名单外的 id → 按 null 处理；但名称/规则与既有卡不同 → new
  const up = ing.acceptBuffer({ name: '新.md', buffer: Buffer.from('三张卡的正文。'), process: false })
  const r = await ing.processJob(up.job.id)
  assert.equal(r.job.status, 'done')
  const verdicts = Object.fromEntries(r.job.cards.map((c) => [c.name, c]))
  assert.ok(verdicts['蓝球追热法（完全同义）'].verdict.startsWith('duplicate-of:'), 'LLM 判同 → 不入库')
  assert.equal(verdicts['蓝球追热法（完全同义）'].cardId, null)
  assert.ok(verdicts['蓝球追热法变体'].verdict.startsWith('similar-to:'), '相近不同条件 → 入库带 similarOf')
  assert.equal(verdicts['和值区间法'].verdict, 'new', 'dupOf 白名单外按 null → 正常入库')
  assert.equal(cardsStore.list().length, 3, '1 既有 + 变体 + 新卡（duplicate 不入库）')
  // rule-dup：LLM 判 none 但规则词法 ≥0.8 → 保守拒入
  const dupText = {
    schemaVersion: 1,
    cards: [{ name: '另一个名字', games: ['ssq'], rule: '近 30 期出现 3 次以上的蓝球至少一个再出', computable: true, dupOf: null, similarTo: null }],
  }
  const c2 = mkAgent({ split: () => dupText })
  const ing2 = createIngest({
    dshHome: dir, cardsStore, usage: createUsageTracker({ dataDir: dir, now: NOON }),
    lock: createJobLock({ file: path.join(dir, 'job-lock.json'), now: NOON }),
    promptAgent: c2.agent, now: NOON, readCfg: () => ({}), log: () => {}, backtest: null, waitMs: 400,
  })
  const up2 = ing2.acceptBuffer({ name: '又.md', buffer: Buffer.from('正文。'), process: false })
  const r2 = await ing2.processJob(up2.job.id)
  const v2 = r2.job.cards[0]
  assert.ok(v2.verdict.startsWith('rule-dup:'), '规则级疑似而 LLM 判 none → 保守拒入（宁可少入）')
  assert.ok(v2.ruleDupName === '蓝球追热法', '面板提示文案带既有卡名')
  assert.equal(cardsStore.list().length, 3, 'rule-dup 不入库')
  // rule-only 模式：dupOf 被忽略，只走规则级
  const c3 = mkAgent({ split: () => DUP })
  const ing3 = createIngest({
    dshHome: dir, cardsStore, usage: createUsageTracker({ dataDir: dir, now: NOON }),
    lock: createJobLock({ file: path.join(dir, 'job-lock.json'), now: NOON }),
    promptAgent: c3.agent, now: NOON, readCfg: () => ({ ingest: { dedup: 'rule-only' } }), log: () => {}, backtest: null, waitMs: 400,
  })
  const up3 = ing3.acceptBuffer({ name: '再.md', buffer: Buffer.from('正文。'), process: false })
  const r3 = await ing3.processJob(up3.job.id)
  assert.ok(r3.job.cards[0].verdict.startsWith('rule-dup:'), 'rule-only：规则级命中即拒入（LLM dupOf 不采信）')
})

test('错峰守卫：17:00–22:30 job 停 queued（面板可见「错峰等待中」），22:30 后 pumpJobs 自动继续', async () => {
  const dir = tmpdir()
  const evening = () => new Date('2026-10-25T18:00:00')
  const { agent } = mkAgent()
  const { ingest } = mkIngest({ dir, agent, now: evening })
  const up = ingest.acceptBuffer({ name: '书.txt', buffer: Buffer.from('和值技巧正文。'), process: false })
  const r = await ingest.processJob(up.job.id)
  assert.equal(r.job.status, 'queued')
  assert.ok(r.job.waitingNote.includes('错峰等待中'))
  // 22:30 后（换 now）
  const night = mkIngest({ dir, agent, now: () => new Date('2026-10-25T22:31:00') })
  const pump = await night.ingest.pumpJobs()
  assert.equal(pump.ran, 1)
  assert.equal(night.ingest.getJob(up.job.id).status, 'done')
})

test('job-lock 互斥（W2A-20）：锁被 backfill 占用 → job 停 queued「等待另一后台作业」；释放后继续', async () => {
  const dir = tmpdir()
  const { agent } = mkAgent()
  const held = mkIngest({ dir, agent, lockHeld: true })
  const up = held.ingest.acceptBuffer({ name: '书.txt', buffer: Buffer.from('和值技巧正文。'), process: false })
  const r = await held.ingest.processJob(up.job.id)
  assert.equal(r.job.status, 'queued')
  assert.ok(r.job.waitingNote.includes('等待另一后台作业（backfill'), r.job.waitingNote)
  held.lock.release()   // backfill 作业结束
  const free = mkIngest({ dir, agent })
  const pump = await free.ingest.pumpJobs()
  assert.equal(pump.ran, 1)
  assert.equal(free.ingest.getJob(up.job.id).status, 'done')
})

test('目录投喂（W2A-21）：inbox 新文件建 job 并移走（移动即防重复投喂）；不支持格式留在原处', async () => {
  const dir = tmpdir()
  const { agent } = mkAgent()
  const { ingest } = mkIngest({ dir, agent })
  fs.mkdirSync(ingest.INBOX_DIR, { recursive: true })
  fs.writeFileSync(path.join(ingest.INBOX_DIR, '投喂.md'), '# 技巧\n和值区间正文。')
  fs.writeFileSync(path.join(ingest.INBOX_DIR, '图.pdf'), '%PDF')
  const scan = ingest.scanInbox()
  assert.equal(scan.created, 1)
  assert.equal(fs.existsSync(path.join(ingest.INBOX_DIR, '投喂.md')), false, '消费即移走')
  assert.equal(fs.existsSync(path.join(ingest.INBOX_DIR, '图.pdf')), true, '不支持格式留在 inbox 待主人处理')
  const job = ingest.list().jobs.find((j) => j.name === '投喂.md')
  assert.ok(job && job.sourceType === 'inbox')
  // 空目录幂等
  const again = ingest.scanInbox()
  assert.equal(again.created, 0)
})

// ── T8：DSL 校验 + 因子化会话提取 ───────────────────────────────────────────────

test('validateFactorSpec：白名单/算子/值域/game 一致性/claim 生成；越界反例（acValue）拒收', () => {
  const card = { id: 'card-x', name: '和值卡', games: ['ssq'] }
  const ok = validateFactorSpec({
    game: 'ssq',
    conditions: [
      { metric: 'sum', op: 'in', range: [90, 130] },
      { metric: 'parityOdd', op: 'eq', value: 3 },
      { metric: 'omissionBack', op: 'gte', value: 1, n: 20 },
    ],
  }, { card })
  assert.equal(ok.ok, true)
  assert.equal(ok.factor.id, 'card-card-x', 'factorId 由代码派生（card-<cardId>）')
  assert.equal(ok.factor.game, 'ssq')
  assert.ok(ok.claim.includes('和值在 90–130') && ok.claim.includes('奇数个数 = 3') && ok.claim.includes('冷号回补'), ok.claim)
  // 白名单外
  const bad1 = validateFactorSpec({ game: 'ssq', conditions: [{ metric: 'acValue', op: 'gte', value: 8 }] }, { card })
  assert.equal(bad1.ok, false)
  assert.ok(bad1.errors.some((e) => e.includes('不在白名单')), '越界反例（acValue）拒收——W2-D06')
  // 空条件 / 非法 op / 反转区间 / game 不一致 / blueIn 值域 / blueIn 非 ssq
  assert.equal(validateFactorSpec({ game: 'ssq', conditions: [] }, { card }).ok, false)
  assert.equal(validateFactorSpec({ game: 'ssq', conditions: [{ metric: 'sum', op: 'approx', value: 1 }] }, { card }).ok, false)
  assert.equal(validateFactorSpec({ game: 'ssq', conditions: [{ metric: 'sum', op: 'in', range: [130, 90] }] }, { card }).ok, false)
  assert.equal(validateFactorSpec({ game: 'dlt', conditions: [{ metric: 'sum', op: 'gte', value: 1 }] }, { card }).ok, false, 'game 与卡片不一致')
  assert.equal(validateFactorSpec({ game: 'ssq', conditions: [{ metric: 'blueIn', op: 'in', set: [0, 99] }] }, { card }).ok, false, '蓝球值域 1–16')
  assert.equal(validateFactorSpec({ game: 'p3', conditions: [{ metric: 'blueIn', op: 'in', set: [1] }] }, { card: { ...card, games: ['p3'] } }).ok, false, 'blueIn 仅 ssq')
  // blueIn 合法
  const okBlue = validateFactorSpec({ game: 'ssq', conditions: [{ metric: 'blueIn', op: 'in', set: [1, 2, 3] }] }, { card })
  assert.equal(okBlue.ok, true)
  assert.ok(okBlue.claim.includes('蓝球 ∈ {1/2/3}'))
})

test('factorizeCard：一次打回后合格；unparseable → factorize-failed 语义；超时 → 失败如实返回', async () => {
  const dir = tmpdir()
  fs.mkdirSync(dir, { recursive: true })
  const card = { id: 'card-y', name: '区间卡', games: ['ssq'], rule: '和值 90-130 且奇数 3 个' }
  // 第一次交卷越界（acValue）→ 打回 → 第二次合格
  let n = 0
  const a1 = async (text) => {
    const f = String(text).match(/(\S+factorize-\S+\.json)/)
    n += 1
    fs.writeFileSync(f[1], JSON.stringify(n === 1
      ? { schemaVersion: 1, conditions: [{ metric: 'acValue', op: 'gte', value: 8 }], claimHuman: 'x', unparseable: false }
      : { schemaVersion: 1, conditions: [{ metric: 'sum', op: 'in', range: [90, 130] }], claimHuman: '和值区间', unparseable: false }))
  }
  const r1 = await factorizeCard({ card, promptAgent: a1, filesDir: dir, waitMs: 300 })
  assert.equal(r1.ok, true)
  assert.equal(n, 2, '一次打回后合格')
  // unparseable → 如实承认拆不出
  const a2 = async (text) => {
    const f = String(text).match(/(\S+factorize-\S+\.json)/)
    fs.writeFileSync(f[1], JSON.stringify({ schemaVersion: 1, conditions: [], claimHuman: '', unparseable: true }))
  }
  const r2 = await factorizeCard({ card, promptAgent: a2, filesDir: dir, waitMs: 300 })
  assert.equal(r2.ok, false)
  assert.ok(r2.reason.includes('无法因子化'))
  // 两次都不合格 → 失败
  const a3 = async (text) => {
    const f = String(text).match(/(\S+factorize-\S+\.json)/)
    fs.writeFileSync(f[1], JSON.stringify({ schemaVersion: 1, conditions: [{ metric: 'nope', op: 'eq', value: 1 }], unparseable: false }))
  }
  const r3 = await factorizeCard({ card, promptAgent: a3, filesDir: dir, waitMs: 300 })
  assert.equal(r3.ok, false)
  assert.ok(r3.reason.includes('两次不过'))
  // 交卷超时
  const r4 = await factorizeCard({ card, promptAgent: async () => {}, filesDir: dir, waitMs: 200 })
  assert.equal(r4.ok, false)
})

test('DSL 因子注册后经引擎跑出结论（因子化产物与内置引擎同构）；claim 为代码生成', async () => {
  const dir = tmpdir()
  const data = randSsq(200, 9)
  const { factor } = validateFactorSpec({
    game: 'ssq',
    conditions: [
      { metric: 'sum', op: 'in', range: [60, 240] },
      { metric: 'consecutivePairs', op: 'gte', value: 0 },
    ],
  }, { card: { id: 'card-z', name: '宽域卡', games: ['ssq'] } })
  const bt = createBacktestWithBuiltins({ dataDir: dir, drawStore: { getRecent: () => [...data].reverse() }, now: NOON, log: () => {} })
  bt.register(factor)
  const r = await bt.runFactor(factor.id)
  assert.equal(r.ok, true)
  assert.ok(r.rounds > 100)
  assert.ok(['better-in-sample', 'no-advantage'].includes(r.verdict))
})

test('cards 纯函数：nameKey 全半角归一；ruleTokens/jaccard 阈值行为；findRuleDup 名称/词法两路', () => {
  assert.equal(nameKey('蓝球 追热法'), nameKey('蓝球追热法'))
  assert.equal(nameKey('ＡＢＣ'), nameKey('abc'), 'NFKC 全半角归一')
  const rule = '红球六码和值长期落在 90 至 130 区间。'
  const near = '红球六码和值长期落在 90 至 130 区间'
  const far = '蓝球连续三期未开则下一期重点关注该号回补。'
  assert.ok(jaccard(ruleTokens(rule), ruleTokens(near)) >= 0.8, '近似规则 ≥0.8')
  assert.ok(jaccard(ruleTokens(rule), ruleTokens(far)) < 0.3, '不同规则远低于阈值')
  const cards = [{ id: 'c1', name: '和值区间法', rule }]
  assert.equal(findRuleDup({ name: '别的名字', rule: near }, cards)?.card.id, 'c1', '词法命中')
  assert.equal(findRuleDup({ name: '和值区间法', rule: '完全另一回事' }, cards)?.type, 'name', '名称命中')
  assert.equal(findRuleDup({ name: '新卡', rule: far }, cards), null)
  assert.ok(Object.keys(METRICS).length >= 10, '白名单指标齐备')
})
