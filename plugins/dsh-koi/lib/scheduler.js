/**
 * dsh-koi 调度器 —— 插件宿主每 30 秒 tick 一次，推进每一天的状态机：
 *
 *   17:30  本地库优先取数（不足按需抓）→ 唤醒「锦鲤」研究出号 → 档位硬校验 → 事件层通知
 *          （失败自动重试，最多 3 次；18:10 之后还成功的算「晚到」；19:50 放弃并致歉）
 *   22:00  轮询官方开奖 → 拆单元按官方奖级判定 → 记模拟账本 → 战果事件 → 增量入库
 *          （开奖一般 21:30–22:15 间公布，15 分钟一轮，23:30 前放弃；没对完的顺延到第二天）
 *   任意时刻  面板「现在来一注」→ 走同一条出号流水线，标「加餐/手动推荐」（不记账，任何模式可用）
 *   22:30  自动模式对账日心跳判定（全部启用渠道静默 = 异常 → 告警 + 面板红标）
 *
 * 市场版改造（docs/16 §2.1.2 八点，FZ-5 相位机逐字不动——三态只是相位机外的门）：
 *   ① 5 处推送调用点改 events.emit（FR-005 语义下沉事件层）
 *   ② games.enabled → modes.<k>.mode 三态 + 门控四项
 *   ③ runPredictFlow 数据源改 drawstore（本地优先/按需抓取/二次零网络，FR-1024）
 *   ④ settleOne 对账成功后增量入库（BC-105 抓过即入库）
 *   ⑤ 每彩种 predictAt（modes.<g>.predictAt，校验 < drawAt）
 *   ⑥ 预测条目 stamp：tier/effortTier/baselinePicks/summary/configStamp（FZ-3 只加字段）
 *   ⑦ settleText 改读条目自带 spec/bets/cost（非默认档战果文案正确，MB-26）
 *   ⑧ 无模型错误分类短路 classifyHostError（FR-1022/S-117）
 *
 * 设计上抄了鲸鱼插件踩过的坑：
 *   · prompt() 用 mode:'queue' + AbortController，await 它返回 = 这一轮干完 ✓
 *   · 她的产出走【文件契约】而不是解析自由文本 ✓
 *   · 状态全部落盘（state.json / predictions.json / ledger.json），进程重启状态机不丢 ✓
 *   · 配置每次 tick 现读，改配置立刻生效 ✓
 *   · agent 运行全局串行（inFlight），正式预测和加餐不撞车 ✓
 */
import fs from 'node:fs'
import path from 'node:path'
import { GAMES, GAME_ORDER, gamesForDate, stakesOf, validatePicks, randomPicks, picksLine,
         nextIssue, judge, gradeSummaryText, ledgerTotals, ledgerTotalsText, appendLedgerEntry } from './draws.js'
import { fetchHistory, fetchLatestDraw, fetchHistoryPage } from './fetch-draws.mjs'
import { buildPredictPrompt, fallbackMessage } from './prompt.js'
import { readJson, writeJsonAtomic, ensureSchemaVersion } from './io.js'
import { tierById, tierStakes, tiersForGame, validateTierPicks, randomTierPicks, judgeTier } from './tiers.js'
import { createDrawStore } from './drawstore.js'
import { createBackfill } from './backfill.js'
import { createJobLock } from './joblock.js'
import { createCardsStore } from './cards.js'
import { createBacktestWithBuiltins } from './backtest.js'
import { createIngest } from './ingest.js'
import { createEventBus } from './events.js'
import { createAdvisory } from './advisory.js'
import { createUsageTracker, demotionFor, leversFor, leverActive, costEstimate, estTokens } from './usage.js'
import { readConfig, buildConfigDefaults, modeOf, tierOf, validateConfig, checkGates, buildConfigStamp } from './config.js'
import { dataPack } from './stats.js'
import { loadAdapters, channelsStatus, resolveChannelCfg, maskValue } from './channels/index.js'

const TICK_MS = 30_000
const ATTEMPT_GAP_MS = 2 * 60_000        // 两次出号尝试至少隔 2 分钟
const SETTLE_GAP_MS = 15 * 60_000        // 开奖未公布 → 15 分钟后再问
const SETTLE_MAX_TRIES = 8               // 22:00 起最多问 8 轮（到 23:30 前后）
const FILE_WAIT_MS = 4 * 60_000          // 等她写结果文件的上限
const FILE_POLL_MS = 3_000
const MAX_ATTEMPTS = 3
const REPUSH_QUEUE_MAX = 20              // C10：补发队列上限（不过期、跨天携带）——事件层队列同参
const VOID_HISTORY_COUNT = 50            // C1：期号跳跃时翻历史核实目标期的回看期数

// ── v1.1 纯逻辑（C-06：新逻辑以可导出纯函数落地，tests/v11-fixes.test.mjs 直连）────

/** C2/FR-002：日期是否命中休市日历（YYYY-MM-DD 精确字符串匹配） */
export function isHoliday(dateStr, holidays) {
  return Array.isArray(holidays) && holidays.some((d) => String(d) === String(dateStr))
}

/**
 * C1/FR-001 三态对账决策（纯函数，settleOne 的决策核）：
 *   'done'     条目已终态（settled / voided）→ 幂等直接了结，绝不重复记账
 *   'settle'   目标期已公布（最新期号相等，或期号跳跃但历史里翻得到目标期）→ 判奖记账
 *   'void'     官方期号已跳过目标期且历史无此期（§4.5 数值比较，证实休市/取消）→ 作废冲销
 *   'give-up'  过放弃线仍未公布 → 记「放弃待补」（首次；重复给-up 由 settleState 守卫挡下）
 *   'wait'     未公布且未到放弃线 → 下一轮再问
 */
export function settleOutcome(entry, latestIssue, historyFound, nowHHMM, giveUpHHMM = '23:30') {
  if (entry?.settleState === 'settled' || entry?.settleState === 'voided') return 'done'
  if (latestIssue == null || latestIssue === '') return 'wait'
  const after = Number(latestIssue) > Number(entry.issue)   // 两套期号格式均以年份为前缀，跨年单调
  if (String(latestIssue) === String(entry.issue) || (after && historyFound)) return 'settle'
  if (after) return 'void'
  return String(nowHHMM) > String(giveUpHHMM) ? 'give-up' : 'wait'
}

/** C1：放弃待补的账本 main 条目（投入照记、奖金挂空、pending 标记） */
export function buildMainPendingEntry(entry, at = new Date().toISOString()) {
  return {
    at, kind: 'daily', game: entry.game, issue: entry.issue, date: entry.date,
    cost: entry.cost, prize: null, bets: entry.bets ?? null, grades: null,
    entryType: 'main', pending: true, note: '放弃待补',
  }
}

/** C1：补判 supplement 条目（cost:0 + 判奖结果 + 指向主条目的 ref 指针） */
export function buildSupplementEntry(entry, judged, at = new Date().toISOString(), note) {
  return {
    at, kind: 'daily', game: entry.game, issue: entry.issue, date: entry.date,
    cost: 0, prize: judged.money, bets: judged.bets, grades: judged.grades,
    entryType: 'supplement', ref: { game: entry.game, issue: entry.issue, date: entry.date },
    ...(note ? { note } : {}),
  }
}

/** C1：休市作废 reversal 冲销条目（ref 指针；该期投入经 ledgerTotals 的 voided 集排除出口径） */
export function buildReversalEntry(entry, at = new Date().toISOString(), note = '休市作废') {
  return {
    at, kind: 'daily', game: entry.game, issue: entry.issue, date: entry.date,
    cost: 0, prize: 0, bets: 0, grades: null,
    entryType: 'reversal', ref: { game: entry.game, issue: entry.issue, date: entry.date }, note,
  }
}

/** C8/FR-006：跨天顺延扫描 —— 全部未结清条目（!settled 或 given-up；排除 voided 与加餐），按日期+彩种去重 */
export function carryJobsFromEntries(entries) {
  const seen = new Set()
  const out = []
  for (const e of (Array.isArray(entries) ? entries : [])) {
    if (e.kind !== 'daily') continue
    if (e.settleState === 'voided') continue
    if (e.settled && e.settleState !== 'given-up') continue
    const key = `${e.date}|${e.game}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ date: e.date, gameKey: e.game })
  }
  return out
}

/** C10/FR-005：推送重试间隔（毫秒），来自 push.retryMinutes（默认 5，非法值回退 5） */
export function retryIntervalMs(cfg) {
  const m = Number(cfg?.push?.retryMinutes ?? 5)
  return (Number.isFinite(m) && m > 0 ? m : 5) * 60_000
}

/** C10/FR-005：分类终止线 —— 预测至 catchUpEnd，战果/致歉至 settleGiveUp */
export function deadlineForKind(kind, time = {}) {
  return kind === 'predict' ? (time.catchUpEnd ?? '19:50') : (time.settleGiveUp ?? '23:30')
}

/**
 * C10：一条补发消息此刻送达是否已过自己的终止线（过了线 → 加【补发】前缀）。
 * 同日按 HH:MM 比较；失败发生在更早的日期（跨天滞留）→ 必然已过线。
 */
export function isPastDeadline(now, deadlineHHMM, failedAtISO) {
  if (!failedAtISO) return false
  const f = new Date(failedAtISO)
  if (Number.isNaN(f.getTime())) return false
  const sameDay = now.toLocaleDateString('sv-SE') === f.toLocaleDateString('sv-SE')
  return sameDay ? hhmm(now) > String(deadlineHHMM) : true
}

/**
 * C10/B-31：入补发队列（纯函数）。同类合并（kind+game+issue 相同只留最新、累计合并次数）；
 * 队列满且无同类可合并 → 溢出丢弃最早条目并在返回值 dropped 里报告（调用方推告警，不静默丢弃）。
 */
export function enqueueRepush(queue, item, max = REPUSH_QUEUE_MAX) {
  const q = [...(Array.isArray(queue) ? queue : [])]
  const key = (x) => `${x.kind}|${x.game}|${x.issue ?? ''}`
  const i = q.findIndex((x) => key(x) === key(item))
  if (i >= 0) {
    const prev = q[i]
    q[i] = { ...item, mergedCount: (prev.mergedCount ?? 0) + 1 }
    return { queue: q, merged: true, dropped: [] }
  }
  const dropped = []
  while (q.length >= max) dropped.push(q.shift())
  q.push(item)
  return { queue: q, merged: false, dropped }
}

/** C6/FR-008：数据新鲜度判定 —— 最新开奖日期距今超过 maxDays 天 → 该源数据陈旧 */
export function isStaleDraw(latestDate, today, maxDays = 7) {
  if (!latestDate || !today) return true
  const a = Date.parse(String(latestDate).slice(0, 10))
  const b = Date.parse(String(today).slice(0, 10))
  if (Number.isNaN(a) || Number.isNaN(b)) return true
  return Math.floor((b - a) / 86_400_000) > maxDays
}

// ── 市场版：无模型错误分类（FR-1022/S-117；模式表可配置，MD-09 保守种子 + 实测校准）──

export const DEFAULT_NO_MODEL_PATTERNS = [
  'no model', 'model not configured', 'model not found', 'no available model',
  '未配置模型', '没有配置模型', '未配置可用的模型',
]

/**
 * 宿主异常分类：命中 no-model 模式 → {kind:'no-model', hint:配置指引}（quickpick 直接返回指引、
 * 跳过打回重写与随机兜底——手动模式无「必须出号」承诺，清晰失败优于静默兜底）；
 * 未命中 → {kind:'other', hint:原语义}（不劣于现状）。
 */
export function classifyHostError(err, patterns = DEFAULT_NO_MODEL_PATTERNS) {
  const msg = String(err?.message ?? err ?? '')
  const list = Array.isArray(patterns) && patterns.length ? patterns : DEFAULT_NO_MODEL_PATTERNS
  const lower = msg.toLowerCase()
  const hit = list.some((p) => p && lower.includes(String(p).toLowerCase()))
  if (hit) {
    return { kind: 'no-model', hint: '宿主未配置模型，请先在 DSH 设置中配置模型（入口：设置→模型），配置后重试' }
  }
  return { kind: 'other', hint: msg.slice(0, 200) }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const hhmm = (d = new Date()) => d.toLocaleTimeString('sv-SE', { hour12: false }).slice(0, 5)
const todayStr = (d = new Date()) => d.toLocaleDateString('sv-SE')

export function readConfigFile(configPath, defaults) {
  let user = {}
  try { user = JSON.parse(fs.readFileSync(configPath, 'utf8')) } catch { /* 没配用默认 */ }
  return { ...structuredClone(defaults), ...user }
}

export function startKoiScheduler(ctx, opts) {
  const {
    dshHome,
    configPath,          // $DSH_HOME/koi.config.json
    dataDir,             // $DSH_HOME/koi/
    workDir,             // $DSH_HOME/koi-work
    sessionId = 'koi-lottery',
    log = () => {},
    now: nowFn = () => new Date(),          // 测试注入时钟（加法，默认真实时钟）
    fetch: fetchInj,                        // 测试注入官方抓取 { fetchHistory, fetchLatestDraw }（默认真实源）
  } = opts

  const hhmm = (d = nowFn()) => d.toLocaleTimeString('sv-SE', { hour12: false }).slice(0, 5)
  const todayStr = (d = nowFn()) => d.toLocaleDateString('sv-SE')
  const fetchers = {
    fetchHistory: fetchInj?.fetchHistory ?? ((g, c) => fetchHistory(g, c)),
    fetchLatestDraw: fetchInj?.fetchLatestDraw ?? ((g) => fetchLatestDraw(g)),
    fetchHistoryPage: fetchInj?.fetchHistoryPage ?? ((g, p) => fetchHistoryPage(g, p)),
  }

  const STATE_FILE = path.join(dataDir, 'state.json')
  const PRED_FILE = path.join(dataDir, 'predictions.json')
  const LEDGER_FILE = path.join(dataDir, 'ledger.json')
  const USER_CHANNELS_DIR = path.join(dshHome, 'koi', 'channels')

  // v2 默认（零 QQ，docs/16 §5.3；BC-103）
  const DEFAULTS = buildConfigDefaults()

  const ensureDirs = () => { fs.mkdirSync(dataDir, { recursive: true }); fs.mkdirSync(workDir, { recursive: true }) }

  let state = readJson(STATE_FILE) ?? null
  const saveState = () => writeJsonAtomic(STATE_FILE, state ?? {})

  const readPreds = () => readJson(PRED_FILE) ?? { entries: [] }
  const readLedger = () => readJson(LEDGER_FILE) ?? { entries: [] }

  // 市场版：v1 games.enabled 读兼容换算在 readConfig 内（MD-01）
  const cfgNow = () => readConfig(configPath, DEFAULTS)
  const modeOfGame = (cfg, k) => modeOf(cfg, k)
  const predictAtOf = (cfg, k) => cfg?.modes?.[k]?.predictAt ?? cfg?.time?.predictAt ?? '17:30'

  // ── 基座：本地开奖库 / 事件层 / 建议层 / 用量层（改造点③④①与 BC-107/BC-109 的载体）────
  const store = createDrawStore({ dataDir, fetch: { fetchHistory: fetchers.fetchHistory }, now: nowFn })
  // 第二波（W2A-20）：后台作业锁（backfill/ingest/backtest 三类互斥）+ 全量回拉引擎（docs/19 §2）。
  // 红线：调度器/tick 不自动触发 backfill.run——全量回拉仅面板确认框 / CLI 手动（§2.5）。
  const jobLock = createJobLock({ file: path.join(dataDir, 'job-lock.json'), now: nowFn, log })
  const backfill = createBackfill({
    dataDir, store, lock: jobLock, now: nowFn,
    fetchPage: fetchers.fetchHistoryPage,
    fetchLatest: fetchers.fetchLatestDraw,
    readCfg: () => cfgNow(), log,
  })
  let adaptersCache = null
  const bus = createEventBus({
    dataDir,
    userChannelsDir: USER_CHANNELS_DIR,
    readCfg: () => cfgNow(),
    adapters: null,
    now: nowFn,
    log,
    onRepushDelivered: () => {   // 补发送达 → 清心跳红标（§2.2.1-6①）
      try { if (state?.heartbeatRed) { state.heartbeatRed = false; saveState() } } catch {}
    },
  })
  const usage = createUsageTracker({ dataDir, now: nowFn })
  // 第二波 ②学习入库半环 + ③回测引擎（docs/19 §4/§5）：
  // cards 单写者 = 持锁串行域（W2A-23）；backtest 与 backfill/ingest 共用 jobLock（W2A-20）；
  // ingest 的 LLM 调用经本调度器 promptAgent（activity=learning，BC-107 计量面）。
  const cardsStore = createCardsStore({ dataDir, now: nowFn })
  const backtest = createBacktestWithBuiltins({ dataDir, cardsStore, drawStore: store, now: nowFn, lock: jobLock, readCfg: () => cfgNow(), log })
  const ingest = createIngest({
    dshHome, cardsStore, usage, lock: jobLock,
    promptAgent: (text) => promptAgent(text, { activity: 'learning' }),
    now: nowFn, readCfg: () => cfgNow(), log,
    backtest,
    budgetState: (cfg) => budgetState(cfg ?? cfgNow()),
  })
  const advisory = createAdvisory({
    dataDir, workDir,
    promptAgent: (text) => promptAgent(text),
    now: nowFn,
    log,
  })

  // ── 会话（她的专用会话，跨天保留记忆 → 越聊越有「日子」味）──────────────────
  let sessionReady = false
  async function ensureSession() {
    if (sessionReady) return
    try { await ctx.sessionController.create({ sessionId, cwd: workDir }) }
    catch { log('[koi] 未创建新会话（可能已有同名会话），沿用已有会话') }
    sessionReady = true
  }

  // ⑧ 无模型错误分类短路：promptAgent 抛错先过 classifyHostError
  async function promptAgent(text, { activity = 'predict' } = {}) {
    await ensureSession()
    try {
      await ctx.sessionController.prompt(
        { requestId: 'koi-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6), sessionId, mode: 'queue', content: [{ type: 'text', text }] },
        new AbortController().signal,
      )
    } catch (e) {
      const c = classifyHostError(e, cfgNow().classify?.noModelPatterns)
      if (c.kind === 'no-model') throw new Error(c.hint)
      throw e
    }
    usage.record(activity, estTokens(text))   // 轻量计量（chars/4 保守估算，est 恒标）
  }

  // ── 预算与降档链（BC-013 市场版链 + BC-107）──────────────────────────────────
  function budgetState(cfg) {
    const totals = usage.weekTotals()
    const demo = demotionFor({
      used: totals.total,
      cap: Number(cfg?.budget?.weeklyCap) > 0 ? Number(cfg.budget.weeklyCap) : 1_500_000,
      warn1: cfg?.budget?.warn1 ?? 0.7, warn2: cfg?.budget?.warn2 ?? 0.9,
      effortTier: cfg?.effort?.tier ?? 'follow-host',
    })
    return { totals, demo }
  }

  // ── 出号流水线（正式预测与加餐共用；返回 { picks, message, via, issue, summary }）──────
  let inFlight = false
  async function runPredictFlow(gameKey, { quick = false, late = false } = {}) {
    if (inFlight) throw new Error('她正在出别的号，稍等')
    inFlight = true
    const stamp = Date.now()
    const outPath = path.join(workDir, `predict-${gameKey}-${quick ? 'qp-' + stamp : todayStr()}.json`)
    try {
      ensureDirs()
      const cfg = cfgNow()
      const tier = tierOf(cfg, gameKey)                     // ⑥ stamp：当刻档位（换档下期生效，BC-113）
      const t = tierById(tier)
      const { demo } = budgetState(cfg)
      const effortTier = demo.effectiveEffort               // 降档后的实际生效档（stamp 记实际）
      // 1) 本地库优先取数（③：库足且新鲜 → 零网络；不足 → 按需抓取 → 校验 → 入库，FR-1024）
      const { history } = await store.ensureRecent(gameKey, Number(cfg.historyCount ?? 30))
      if (!Array.isArray(history) || !history.length) throw new Error('官方历史数据为空')
      const issue = nextIssue(history[0].issue, history[0].date, todayStr())
      // 预算触顶：兜底档出号零 LLM（BC-013 收口；仅正式预测走兜底，手动清晰报错）
      if (!demo.allowLLM) {
        if (quick) throw new Error('本周 token 预算已触顶（估算），暂不出号：可在面板调高预算或等自然周重置')
        const picks = randomTierPicks(t ?? gameKey)
        const message = fallbackMessage(gameKey, picks)
        appendPrediction({ cfg, gameKey, issue, picks, message, via: 'fallback', quick, tier, effortTier, summary: null, note: '预算触顶 · 兜底档零 LLM' })
        return { picks, message, via: 'fallback', issue, summary: null }
      }
      // 2) 叫醒她（先清掉旧结果文件）；力度杠杆随 effectiveEffort（MC-10）
      const cfgEff = { ...cfg, effort: { tier: effortTier } }
      try { fs.rmSync(outPath, { force: true }) } catch {}
      await promptAgent(buildPredictPrompt({ gameKey, cfg: cfgEff, tier, history, issue, outPath, late }))
      // 3) 等结果文件 → 档位硬校验；不合法给一次重写机会；再不行随机兜底（FZ-2 平行函数）
      let raw = await waitJsonFile(outPath)
      let v = raw ? validateTierPicks(t ?? tierOf(cfg, gameKey), raw.picks ?? raw) : { ok: false, error: '没有等到结果文件' }
      if (!v.ok) {
        log(`[koi] ${gameKey} 第一次产出不合格（${v.error}），给她一次重写机会`)
        await promptAgent([
          '【打回重写】你刚写的文件系统校验没过：' + v.error,
          `请立刻重写 ${outPath}（还是那个 JSON 契约，号码必须合规），写完就停。`,
        ].join('\n'))
        raw = await waitJsonFile(outPath, 60_000)
        v = raw ? validateTierPicks(t ?? tierOf(cfg, gameKey), raw.picks ?? raw) : { ok: false, error: '重写也没等到' }
      }
      let picks, message, via, summary = null
      if (v.ok) {
        picks = v.picks
        message = String(raw.message ?? '').trim() || '（她忘了写正文，但号码在这里：' + picksLine(gameKey, picks) + '）'
        summary = String(raw.summary ?? '').trim() || null
        via = 'ai'
      } else {
        log(`[koi] ${gameKey} AI 产出两次不合格，走随机兜底`)
        picks = randomTierPicks(t ?? gameKey)
        message = fallbackMessage(gameKey, picks)
        via = 'fallback'
      }
      appendPrediction({ cfg, gameKey, issue, picks, message, via, quick, tier, effortTier, summary })
      return { picks, message, via, issue, summary }
    } finally {
      inFlight = false
      try { fs.rmSync(outPath, { force: true }) } catch {}
    }
  }

  // ⑥ 落 predictions + stamp（tier/effortTier/baselinePicks/summary/manual/configStamp——FZ-3 只加字段）
  function appendPrediction({ cfg, gameKey, issue, picks, message, via, quick, tier, effortTier, summary, note }) {
    const preds = readPreds()
    const s = tierStakes(tier) ?? stakesOf(gameKey)
    const isManualPick = quick && modeOfGame(cfg, gameKey) === 'manual'
    preds.entries.push({
      at: new Date().toISOString(), kind: quick ? 'quickpick' : 'daily',
      game: gameKey, issue, date: todayStr(), picks, via,
      bets: s.bets, cost: s.cost, spec: s.spec,          // ⑦ 出号时随条目写规格（settleText 改读这组）
      tier, effortTier, configStamp: buildConfigStamp(cfg),
      ...(quick ? {} : { baselinePicks: randomTierPicks(tier) }),   // 随机基线同构（DC-002，仅正式预测）
      ...(summary ? { summary } : {}),
      ...(isManualPick ? { manual: true } : {}),          // 手动号留痕（MA-26）
      ...(note ? { note } : {}),
    })
    writeJsonAtomic(PRED_FILE, ensureSchemaVersion(preds))   // C4：顶层 schemaVersion
  }

  async function waitJsonFile(p, timeoutMs = FILE_WAIT_MS) {
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs) {
      if (stopped) return null
      try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { /* 还没写好 */ }
      await sleep(FILE_POLL_MS)
    }
    return null
  }

  // ── 战果文案（⑦：改读条目自带 spec/bets/cost——非默认档战果文案正确，MB-26）──────────
  function resultLine(gameKey, r) {
    if (gameKey === 'ssq') return r.red.map((n) => String(n).padStart(2, '0')).join(' ') + ' + ' + String(r.blue).padStart(2, '0')
    if (gameKey === 'dlt') return r.front.map((n) => String(n).padStart(2, '0')).join(' ') + ' + ' + r.back.map((n) => String(n).padStart(2, '0')).join(' ')
    return r.digits.join(' ')
  }

  function settleText(gameKey, entry, result, judged, totals) {
    const g = GAMES[gameKey]
    const s = { spec: entry.spec ?? stakesOf(gameKey).spec, bets: entry.bets ?? stakesOf(gameKey).bets, cost: entry.cost ?? stakesOf(gameKey).cost }
    const lines = [
      `🎰【锦鲤战果 · ${g.name} · 第 ${entry.issue} 期】`,
      `开奖：${resultLine(gameKey, result)}`,
      `我们的号：${picksLine(gameKey, entry.picks)}`,
      `（${s.spec} · ${s.bets} 注 / ${s.cost} 元）`,
      `结果：${gradeSummaryText(gameKey, judged)}${judged.floating ? '（含浮动奖，金额以官方公布为准）' : ''}`,
      `本回合计：中 ${judged.money} 元`,
    ]
    if (entry.baselinePrize != null) {
      lines.push(`随机基线同刻对照：${entry.baselineGrades && Object.keys(entry.baselineGrades).length ? gradeSummaryText(gameKey, { grades: entry.baselineGrades }) : '未中奖'} · 中 ${entry.baselinePrize} 元（纯观测）`)
    }
    lines.push(ledgerTotalsText(totals))
    lines.push('开奖是随机的，图个乐～ 明天继续攒运气！')
    return lines.join('\n')
  }

  // ① emit 封装（事件层统一重试/补发；emit 返回事件快照回填 pushedAt/pushErr——MD-10）
  async function emitNotify(partial) {
    try {
      return await bus.emit(partial)
    } catch (e) {
      log(`[koi] 事件层 emit 异常：${String(e?.message ?? e).slice(0, 120)}`)
      return null
    }
  }

  // 对一个「未结清」条目做一次对账尝试；返回 true = 这条今日了结（结清/放弃/作废都算）
  async function settleOne({ date, gameKey }) {
    const preds = readPreds()
    const idx = preds.entries.findIndex((e) => e.kind === 'daily' && e.game === gameKey && e.date === date
      && (!e.settled || e.settleState === 'given-up'))   // C8：未结清 = !settled || given-up（voided 排除）
    if (idx < 0) return true   // 没这条账（或已结清）→ 视为了结
    const entry = preds.entries[idx]
    const cfg = cfgNow()
    const giveUp = cfg.time?.settleGiveUp ?? '23:30'
    try {
      const latest = await fetchers.fetchLatestDraw(gameKey)
      if (!latest || !latest.issue) throw new Error('开奖数据为空')
      // 期号跳跃时先翻历史核实：目标期可能已公布（宕机/晚公布错过），翻得到按公布结清，
      // 翻不到才证实「目标期号缺席」转作废（docs/12 FR-001 作废条件原文）
      let result = null
      if (String(latest.issue) === String(entry.issue)) result = latest
      else if (Number(latest.issue) > Number(entry.issue)) {
        const hist = await fetchers.fetchHistory(gameKey, VOID_HISTORY_COUNT).catch(() => [])
        result = (Array.isArray(hist) ? hist : []).find((d) => String(d.issue) === String(entry.issue)) ?? null
        if (Array.isArray(hist) && hist.length) store.upsertBatch(gameKey, hist)   // ④ 抓过即入库
      }
      const outcome = settleOutcome(entry, latest.issue, Boolean(result), hhmm(), giveUp)
      if (outcome === 'done') return true
      if (outcome === 'wait') return false
      if (outcome === 'give-up') {
        if (entry.settleState !== 'given-up') {   // 幂等守卫：已放弃的条目不重复追加账
          const ledger = readLedger()
          appendLedgerEntry(ledger, buildMainPendingEntry(entry))
          writeJsonAtomic(LEDGER_FILE, ensureSchemaVersion(ledger))
          entry.settled = true
          entry.settleState = 'given-up'
          entry.settleNote = '当晚未等到开奖公布，放弃待补'
          writeJsonAtomic(PRED_FILE, ensureSchemaVersion(preds))
          log(`[koi] ${gameKey} ${date} 对账放弃（${giveUp} 前没等到第 ${entry.issue} 期），已记放弃待补`)
        }
        return true
      }
      if (outcome === 'void') {
        const ledger = readLedger()
        appendLedgerEntry(ledger, buildReversalEntry(entry))
        writeJsonAtomic(LEDGER_FILE, ensureSchemaVersion(ledger))
        entry.settled = true
        entry.settleState = 'voided'
        entry.settleNote = `官方已到第 ${latest.issue} 期且历史无第 ${entry.issue} 期，作废冲销`
        writeJsonAtomic(PRED_FILE, ensureSchemaVersion(preds))
        log(`[koi] ${gameKey} ${entry.issue} 期证实不存在（官方已到第 ${latest.issue} 期），作废冲销`)
        return true
      }
      // settle：判奖（档位感知拆单元，FZ-1 judge 零修改消费）、记账、推送（补判走 supplement，正常走 main）
      const tierObj = tierById(entry.tier)
      const judged = tierObj && tierObj.game === gameKey
        ? judgeTier(tierObj, entry.picks, result, result.prizeGrades ?? null)
        : judge(gameKey, entry.picks, result, result.prizeGrades ?? null)
      const wasGivenUp = entry.settleState === 'given-up'
      const ledger = readLedger()
      if (wasGivenUp) {
        appendLedgerEntry(ledger, buildSupplementEntry(entry, judged))
      } else {
        appendLedgerEntry(ledger, {
          at: new Date().toISOString(), kind: 'daily', game: gameKey, issue: entry.issue, date,
          cost: entry.cost, prize: judged.money, bets: judged.bets, grades: judged.grades,
          entryType: 'main',
        })
      }
      writeJsonAtomic(LEDGER_FILE, ensureSchemaVersion(ledger))
      const totals = ledgerTotals(ledger)
      // ④ 增量挂对账：同一抓取双消费入本地库（BC-105 零独立抓取）
      store.upsert(gameKey, result)
      // 基线判奖回填（DC-002 市场版落点，纯观测）
      if (entry.baselinePicks && tierObj) {
        const bj = judgeTier(tierObj, entry.baselinePicks, result, result.prizeGrades ?? null)
        entry.baselinePrize = bj.money
        entry.baselineGrades = bj.grades
      }
      const text = settleText(gameKey, entry, result, judged, totals)
      const ev = await emitNotify({
        kind: 'result', game: gameKey, issue: entry.issue, gameName: GAMES[gameKey].name, date,
        picksLine: picksLine(gameKey, entry.picks),
        message: null, summary: entry.summary ?? null, via: entry.via, fullRef: `${gameKey}|${entry.issue}`,
        flags: { fallback: entry.via === 'fallback' },
        won: judged.money > 0,   // 中奖标记（DC-102 增量）：桌宠/面板未读与冒泡只认中奖战果（主人 2026-10-25 拍板）
      })
      entry.settled = true
      entry.settleState = 'settled'
      entry.result = result
      entry.prize = judged.money
      entry.grades = judged.grades
      entry.pushedResult = ev ? ev.status === 'sent' : false
      writeJsonAtomic(PRED_FILE, ensureSchemaVersion(preds))
      // ③ advisory 对照观测（纯观测：当期实际档 vs 建议档，BC-109）
      try {
        const advice = advisory.readAdvice(gameKey, entry.date)
        if (advice?.recommendedTier) {
          advisory.recordOutcome(gameKey, entry.issue, {
            actualTier: entry.tier, actualPicks: entry.picks, actualJudged: judged,
            advisedTier: advice.recommendedTier, result,
          })
        }
      } catch (e) { log(`[koi] advisory 对照观测失败（不影响对账）：${String(e?.message ?? e)}`) }
      log(`[koi] ${gameKey} ${entry.issue} 期对账完成${wasGivenUp ? '（补判）' : ''}：${gradeSummaryText(gameKey, judged)}，中 ${judged.money} 元${entry.pushedResult ? '，战果事件已送达' : '，战果送达见事件面板'}`)
      return true
    } catch (e) {
      log(`[koi] ${gameKey} 对账失败（下一轮再试）：${e.message}`)
      return false
    }
  }

  // ── advisory：预注册 → 单 agent 生成 → 建议事件（MC-12：仅 auto 彩种；永不写 modes.tier）──
  async function maybeAdvisory(gameKey, issue) {
    const cfg = cfgNow()
    if (cfg.advisory?.enabled === false) return
    if (modeOfGame(cfg, gameKey) !== 'auto') return
    const { demo, totals } = budgetState(cfg)
    if (demo.pauseAdvisory) return
    const date = todayStr()
    try {
      const prereg = advisory.preregister(gameKey, date, {
        predictions: readPreds(),
        budgetLeft: Math.max(0, (Number(cfg.budget?.weeklyCap) > 0 ? Number(cfg.budget.weeklyCap) : 1_500_000) - totals.total),
      })
      const gen = await advisory.generate(gameKey, date, prereg, { budgetLeft: prereg.criteria.budgetLeft })
      if (!gen.ok) { log(`[koi] advisory 本轮未产出（${gen.error}）`); return }
      const s = tierStakes(gen.recommendedTier)
      await emitNotify({
        kind: 'advice', game: gameKey, issue, gameName: GAMES[gameKey].name, date,
        message: `建议档位：${gen.recommendedTier}（${s.spec}，${s.bets} 注 / ${s.cost} 元）。理由（预注册判据）：${gen.reasonFull.slice(0, 80)}${gen.reasonFull.length > 80 ? '…' : ''}（全文见面板与档案）`,
        fullRef: `advisory|${gameKey}|${date}`,
      })
      log(`[koi] ${gameKey} 今日策略建议已产出：${gen.recommendedTier}（建议不记账，永不自动生效）`)
    } catch (e) {
      log(`[koi] advisory 失败（不影响正式预测）：${String(e?.message ?? e).slice(0, 120)}`)
    }
  }

  // ── 主 tick ──────────────────────────────────────────────────────────────
  let stopped = false
  let ticking = false
  async function tick() {
    if (stopped || ticking || !ctx.sessionController) return
    ticking = true
    try {
      ensureDirs()
      const cfg = cfgNow()
      const today = todayStr()
      // 跨天：把全部未结清的顺延（carry，C8 全量扫描），今天的重新开始
      // （市场版：repushQueue 已迁事件存储不再写 state；heartbeatRed 跨天携带直到补发清除）
      if (!state || state.date !== today) {
        const carry = carryJobsFromEntries(readPreds().entries)
        state = { date: today, games: {}, carry, heartbeatRed: state?.heartbeatRed ?? false, lastError: null }
        saveState()
      }
      state.games = state.games ?? {}
      const catchUpEnd = cfg.time?.catchUpEnd ?? '19:50'
      const settleAt = cfg.time?.settleAt ?? '22:00'
      const now = hhmm()
      const holiday = isHoliday(today, cfg.holidays)   // C2/FR-002：休市日不出号、不对账、不致歉，静默顺延
      const drawToday = gamesForDate(today)
      const autos = drawToday.filter((k) => modeOfGame(cfg, k) === 'auto')   // ② 三态门：off/manual 跳流水线

      if (!holiday) {
      // ── 出号段（auto 彩种；每彩种 predictAt，⑤）──
      for (const gameKey of autos) {
        const predictAt = predictAtOf(cfg, gameKey)
        const g = state.games[gameKey] ?? (state.games[gameKey] = { phase: 'idle', attempts: 0 })
        if (g.phase === 'idle' && now >= predictAt && now <= catchUpEnd) {
          if (inFlight) continue
          if (g.lastAttemptAt && Date.now() - g.lastAttemptAt < ATTEMPT_GAP_MS) continue
          g.lastAttemptAt = Date.now()
          saveState()
          // 异步跑，不占 tick（完成/失败都会改 state）
          ;(async () => {
            try {
              const late = hhmm() > '18:10'
              const { picks, message, via, issue, summary } = await runPredictFlow(gameKey, { late })
              const st = state.games[gameKey]
              st.phase = 'predicted'
              st.attempts += 1
              st.issue = issue
              st.via = via
              st.message = message
              st.picksLine = picksLine(gameKey, picks)
              saveState()
              log(`[koi] ${gameKey} 第 ${issue} 期出号完成（${via}${late ? ' · 晚到' : ''}）：${st.picksLine}`)
              // ① 推送调用点 → 事件层（重试/补发/终止线语义由事件层承担）
              const ev = await emitNotify({
                kind: 'predict', game: gameKey, issue, gameName: GAMES[gameKey].name, date: today,
                picksLine: st.picksLine, summary, via, fullRef: `${gameKey}|${issue}`,
                flags: { fallback: via === 'fallback', baselineMissing: !picks },
              })
              st.pushedAt = ev && ev.status === 'sent' ? ev.at : null   // 事件层送达状态回填（面板兼容读）
              st.pushErr = ev && ev.status !== 'sent' ? (ev.lastErr ?? '送达中（事件层续试）') : null
              saveState()
              // advisory（auto 彩种出号完成后：预注册→生成→建议事件）
              maybeAdvisory(gameKey, issue).catch(() => {})
            } catch (e) {
              const st = state.games[gameKey]
              st.attempts += 1
              const cls = classifyHostError(e, cfg.classify?.noModelPatterns)
              st.lastError = (cls.kind === 'no-model' ? cls.hint + ' [no-model]' : String(e?.message ?? e).slice(0, 200))
              if (st.attempts >= MAX_ATTEMPTS) {
                st.phase = 'failed'
                log(`[koi] ${gameKey} 出号 ${MAX_ATTEMPTS} 次都失败，今天放弃：${st.lastError}`)
              } else {
                log(`[koi] ${gameKey} 出号失败（第 ${st.attempts} 次）：${st.lastError}`)
              }
              saveState()
            }
          })()
        }
        // 过了窗口还没出号 → 放弃 + 致歉一次（① 致歉同走事件层统一重试）
        if (g.phase === 'idle' && now > catchUpEnd) {
          g.phase = 'skipped'
          saveState()
          emitNotify({ kind: 'apology', game: gameKey, gameName: GAMES[gameKey].name, message: `🐟 锦鲤今天没赶上 ${GAMES[gameKey].name} 的预测（服务当时不在线或多次失败），抱歉，明天继续！` })
        }
        // failed 致歉一次（同上）
        if (g.phase === 'failed' && !g.apologyPushed) {
          g.apologyPushed = true
          saveState()
          emitNotify({ kind: 'apology', game: gameKey, gameName: GAMES[gameKey].name, message: `🐟 锦鲤今天研究 ${GAMES[gameKey].name} 时反复卡壳，预测没出来，抱歉！明天继续攒运气。` })
        }
      }
      // 今天不开的彩种，把残留状态清掉（比如用户新开了某个彩种）
      for (const k of GAME_ORDER) if (!drawToday.includes(k) && state.games[k]?.phase === 'idle') delete state.games[k]

      // ── 对账段（今天的 + 顺延的；账本诚实优先于模式门——已出的号必对账，BC-006）──
      if (now >= settleAt) {
        const jobs = [...drawToday.filter((k) => ['predicted', 'pushed'].includes(state.games[k]?.phase ?? 'idle'))
          .map((k) => ({ date: today, gameKey: k })),
          ...(state.carry ?? [])]
        for (const job of jobs) {
          const g = state.games[job.gameKey]
          if (job.date === today) {
            if (!g || g.settled) continue
            if (g.nextSettleAt && Date.now() < g.nextSettleAt) continue
            g.settleTries = (g.settleTries ?? 0) + 1
            g.nextSettleAt = Date.now() + SETTLE_GAP_MS
            saveState()
            if (g.settleTries > SETTLE_MAX_TRIES) { g.settled = true; saveState(); continue }
          }
          const done = await settleOne(job)
          if (done) {
            if (job.date === today) { state.games[job.gameKey].settled = true; state.games[job.gameKey].phase = 'settled' }
            else state.carry = (state.carry ?? []).filter((c) => !(c.date === job.date && c.gameKey === job.gameKey))
            saveState()
          }
        }
      }

      // ── 心跳判定（FR-1001/MA-19：22:30 对账日、当日幂等、仅 harness 运行中实时判定）──
      const heartbeatAt = cfg.time?.heartbeatAt ?? '22:30'
      if (!holiday && now >= heartbeatAt && state.heartbeatCheckedOn !== today) {
        state.heartbeatCheckedOn = today
        state.heartbeatCheckedAt = new Date().toISOString()
        for (const k of drawToday) {
          const r = await bus.heartbeatForGame(k, modeOfGame(cfg, k), today)
          if (r.red) state.heartbeatRed = true   // 面板常驻红标（可见性兜底不依赖渠道）
        }
        saveState()
      }
      }   // ← !holiday（休市日静默顺延：出号段/对账段/致歉/心跳全部跳过）

      // ── 事件层 pump（①：重试/补发/清理由事件层统一承担，MD-03）──
      await bus.pump().catch((e) => log('[koi] 事件层 pump 异常：' + String(e?.message ?? e)))

      // ── 学习半环驱动（第二波 §4.4 触发节奏）：inbox 扫描建 job + pending-llm/queued 处理（每 tick 至多 1 个；
      //    处理受错峰/预算/作业锁守卫约束——这里不自动触发任何 backfill/backtest，红线不动）──
      try {
        const scan = ingest.scanInbox()
        if (scan.created) log(`[koi] inbox 发现 ${scan.created} 个新文件，已建学习任务`)
        await ingest.pumpJobs()
      } catch (e) { log('[koi] 学习半环 pump 异常：' + String(e?.message ?? e)) }
    } catch (e) {
      log('[koi] tick 异常：' + String(e?.message ?? e))
      try { state.lastError = String(e?.message ?? e).slice(0, 200); saveState() } catch {}
    } finally {
      ticking = false
    }
  }

  // ── 面板「现在来一注」（永久基础层：三态任一均放行，FR-1023 显式行为增量）─────────
  const qpJobs = new Map()
  let qpSeq = 0
  function quickpick(gameKey) {
    if (!GAMES[gameKey]) return { ok: false, error: '没有这个彩种' }
    const cfg = cfgNow()
    const mode = modeOfGame(cfg, gameKey)
    // v1 此处以 gameEnabled 拒绝已关彩种——市场版改为三态任一放行（off = 不自动出号，来一注仍可用）
    if (inFlight) return { ok: false, error: '她正在出别的号，一分钟后再试' }
    const id = 'qp' + (++qpSeq) + '-' + Date.now().toString(36)
    const job = { id, game: gameKey, status: 'running', startedAt: new Date().toISOString(), message: null, picksLine: null, error: null }
    qpJobs.set(id, job)
    if (qpJobs.size > 20) { const first = qpJobs.keys().next().value; qpJobs.delete(first) }
    ;(async () => {
      try {
        const { picks, message, via, issue, summary } = await runPredictFlow(gameKey, { quick: true })
        const isManual = mode === 'manual'
        const ev = await emitNotify({
          kind: 'quickpick', game: gameKey, issue, gameName: GAMES[gameKey].name, date: todayStr(),
          picksLine: picksLine(gameKey, picks), summary, via, fullRef: `${gameKey}|${issue}|qp`,
          flags: isManual ? { manual: true } : { quickpick: true },   // 手动「手动推荐 · 不记账」/自动「加餐 · 不记账」
        })
        job.status = ev && ev.status === 'sent' ? 'done' : 'push-failed'
        job.message = message
        job.picksLine = picksLine(gameKey, picks)
        job.via = via
        job.error = ev && ev.status === 'sent' ? null : '号已出（在下面）；送达状态见事件面板（加餐不重试，号永在面板可见）'
      } catch (e) {
        job.status = 'error'
        job.error = String(e?.message ?? e).slice(0, 200)
      } finally { job.doneAt = new Date().toISOString() }
    })()
    return { ok: true, id }
  }

  // FR-023 展示面（只读，不引入任何 mind 行为，docs/13 §6.2-4）：
  // enabled 读 koi.config（默认 false）；handshake 读 koi-mind/handshake.json 的 status，文件缺失报 'absent'
  function mindStatus(cfg) {
    const hs = readJson(path.join(dshHome, 'koi-mind', 'handshake.json'), null)
    return {
      enabled: cfg?.mind?.enabled === true,
      handshake: hs && typeof hs === 'object' ? String(hs.status ?? 'unknown') : 'absent',
    }
  }

  // ── 配置写路径（三入口共用：/api/mode、CLI mode、面板 config POST 都走这里）────────
  function writeConfigPatch(patch) {
    let raw = {}
    try { raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) } catch { /* 文件缺失从模板起 */ }
    const merged = { ...buildConfigDefaults(), ...raw, ...patch }
    const v = validateConfig(merged)
    if (!v.ok) return { ok: false, errors: v.errors }
    writeJsonAtomic(configPath, merged)
    return { ok: true, config: merged }
  }

  async function channelsOverview() {
    if (!adaptersCache) {
      adaptersCache = await loadAdapters(USER_CHANNELS_DIR)
      if (adaptersCache.problems.length) log(`[koi] 渠道适配器加载问题：${adaptersCache.problems.map((p) => `${p.file}(${p.error})`).join('；')}`)
    }
    return adaptersCache
  }

  // ── 三态切换（/api/mode 后端；S-116 四项门控，MC-11 实时校验）──────────────────
  async function setMode({ game, mode, tier, predictAt, gates } = {}) {
    if (!GAMES[game]) return { ok: false, errors: ['没有这个彩种'] }
    const cfg = cfgNow()
    const current = cfg.modes?.[game] ?? {}
    const patchModes = {
      ...current,
      ...(mode !== undefined ? { mode } : {}),
      ...(tier !== undefined ? { tier } : {}),
      ...(predictAt !== undefined ? { predictAt } : {}),
      ...(gates !== undefined ? { gates: { ...(current.gates ?? {}), ...gates } } : {}),
    }
    if (mode === 'auto') {
      const { adapters } = await channelsOverview()
      const enabled = (cfg.channels ?? []).filter((c) => c && c.enabled !== false && adapters.has(c.type))
      const g = checkGates(game, { modes: { [game]: patchModes } }, { channelsOk: enabled.length })
      if (!g.ok) return { ok: false, missing: g.missing, errors: g.missing.map((m) => `${m.label}：${m.hint}`) }
      patchModes.wizardDone = true
    }
    const r = writeConfigPatch({ modes: { ...cfg.modes, [game]: patchModes } })
    if (!r.ok) return r
    return { ok: true }
  }

  const timer = setInterval(() => { tick().catch(() => {}) }, TICK_MS)
  const boot = setTimeout(() => { tick().catch(() => {}) }, 10_000)
  log(`[koi] 锦鲤生物钟已启动（每 ${TICK_MS / 1000}s tick · 会话 ${sessionId} · 出号 per-game predictAt · 对账 ${DEFAULTS.time.settleAt} 起 · 心跳 ${DEFAULTS.time.heartbeatAt}）`)

  return {
    stop() { stopped = true; clearTimeout(boot); clearInterval(timer) },
    tick,
    quickpick,
    qpJob: (id) => qpJobs.get(id) ?? null,
    setMode,
    bus,
    drawstore: store,
    backfill,       // 第二波：全量回拉引擎（手动触发面专用；调度器不自动调 run，docs/19 §2.5）
    jobLock,        // 第二波：后台作业锁（backfill/ingest/backtest 互斥）
    ingest,         // 第二波：学习摄入流水线（上传/inbox/CLI 三通道；tick 只做发现与守卫内处理）
    cardsStore,     // 第二波：卡片库（cards 单写者 = 持锁串行域，W2A-23）
    backtest,       // 第二波：回测引擎（内置六件已注册；手动/链式触发）
    channelsOverview,
    status() {
      const cfg = cfgNow()
      const today = todayStr()
      const g = (state?.games) ?? {}
      const lever = leversFor(cfg)
      const out = {}
      const drawTodaySet = new Set(gamesForDate(today))
      for (const k of GAME_ORDER) {
        const st = g[k]
        const mode = modeOfGame(cfg, k)
        const enabled = mode !== 'off' && drawTodaySet.has(k)   // FZ-6 降级语义（MB-25）：三态取值
        const s = tierStakes(tierOf(cfg, k)) ?? stakesOf(k)
        out[k] = {
          enabledToday: enabled,
          mode,
          phase: enabled || mode !== 'off' ? (st?.phase ?? 'idle') : 'off',
          issue: st?.issue ?? null,
          picksLine: st?.picksLine ?? null,
          via: st?.via ?? null,
          pushedAt: st?.pushedAt ?? null,
          pushErr: st?.pushErr ?? null,
          settled: st?.settled ?? false,
          lastError: st?.lastError ?? null,
          spec: s.spec,
          bets: s.bets,
          cost: s.cost,
        }
      }
      // FZ-6 降级语义（MB-25）：push/pushTargetMasked 字段保留、值域与 v1 连续
      const enabledChannels = (cfg.channels ?? []).filter((c) => c && c.enabled !== false)
      const qqChannel = enabledChannels.find((c) => c.type === 'qq')
      let pushTargetMasked = ''
      if (qqChannel) {
        const sidecar = resolveChannelCfg(qqChannel, USER_CHANNELS_DIR)
        pushTargetMasked = String(sidecar.target ?? '').replace(/^(\d{3})\d+(\d{2})$/, '$1****$2') || maskValue(sidecar.target ?? '')
      }
      const eventsCounts = bus.pendingCounts()
      // 成本估算（BC-107 双显示；本地库 ≥10 期实测 dataPack 长度，MD-17）
      const packChars = {}
      for (const k of GAME_ORDER) {
        const st = store.status(k)
        if (st.count >= 10) {
          try { packChars[k] = dataPack(k, store.getRecent(k, lever.tail), { tailCount: lever.tail }).length } catch {}
        }
      }
      return {
        ok: true, today, time: hhmm(),
        schedulerOk: true,
        games: out,
        modes: Object.fromEntries(GAME_ORDER.map((k) => [k, cfg.modes?.[k] ?? { mode: modeOfGame(cfg, k) }])),
        carry: (state?.carry ?? []).length,
        holiday: isHoliday(today, cfg.holidays),          // C2/FR-002：今天是否休市
        repushQueue: (eventsCounts.queued ?? 0) + (eventsCounts.retrying ?? 0),   // FZ-6 字段：事件层队列口径
        events: { ...eventsCounts, heartbeatRed: state?.heartbeatRed ?? false },
        heartbeatCheckedAt: state?.heartbeatCheckedAt ?? null,   // 关机缺席如实展示（§2.2.1-6④）
        mind: mindStatus(cfg),                            // FR-023：认知层总开关与握手状态（只读）
        ledger: ledgerTotals(readLedger()),
        ledgerText: ledgerTotalsText(ledgerTotals(readLedger())),
        push: { ok: enabledChannels.length > 0, detail: '推送已迁移至渠道层，见 channels' },
        pushTargetMasked,
        tiers: Object.fromEntries(GAME_ORDER.map((k) => {
          const s = tierStakes(tierOf(cfg, k))
          return [k, s ? { id: tierOf(cfg, k), ...s } : null]
        })),
        tierTable: Object.fromEntries(GAME_ORDER.map((k) => [k, tiersForGame(k).map((t) => ({ id: t.id, label: t.label, bets: t.bets, cost: t.cost }))])),
        verbosity: cfg.verbosity ?? 'concise',
        effort: { tier: lever.tier, leverActive: leverActive(cfg) },
        backbone: Object.fromEntries(GAME_ORDER.map((k) => [k, store.status(k)])),
        costEstimate: costEstimate(cfg, { packChars }),
        lastError: state?.lastError ?? null,
      }
    },
  }
}
