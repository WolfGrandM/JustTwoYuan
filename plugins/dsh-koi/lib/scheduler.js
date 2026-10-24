/**
 * dsh-koi 调度器 —— 插件宿主每 30 秒 tick 一次，推进每一天的状态机：
 *
 *   17:30  抓官方历史 → 唤醒「锦鲤」研究出号 → 硬校验 → NapCat 私聊推送
 *          （失败自动重试，最多 3 次；18:10 之后还成功的算「晚到」；19:50 放弃并致歉）
 *   22:00  轮询官方开奖 → 复式拆注按官方奖级判定 → 记模拟账本 → 推送战果
 *          （开奖一般 21:30–22:15 间公布，15 分钟一轮，23:30 前放弃；没对完的顺延到第二天）
 *   任意时刻  面板「现在来一注」→ 走同一条出号流水线，标「加餐」（不记账）
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
import { fetchHistory, fetchLatestDraw } from './fetch-draws.mjs'
import { pushPrivate } from './push.mjs'
import { buildPredictPrompt, fallbackMessage } from './prompt.js'
import { readJson, writeJsonAtomic, ensureSchemaVersion } from './io.js'

const TICK_MS = 30_000
const ATTEMPT_GAP_MS = 2 * 60_000        // 两次出号尝试至少隔 2 分钟
const SETTLE_GAP_MS = 15 * 60_000        // 开奖未公布 → 15 分钟后再问
const SETTLE_MAX_TRIES = 8               // 22:00 起最多问 8 轮（到 23:30 前后）
const FILE_WAIT_MS = 4 * 60_000          // 等她写结果文件的上限
const FILE_POLL_MS = 3_000
const MAX_ATTEMPTS = 3
const REPUSH_QUEUE_MAX = 20              // C10：补发队列上限（不过期、跨天携带）
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
  } = opts

  const STATE_FILE = path.join(dataDir, 'state.json')
  const PRED_FILE = path.join(dataDir, 'predictions.json')
  const LEDGER_FILE = path.join(dataDir, 'ledger.json')

  const DEFAULTS = {
    push: { target: '1017099872', napcatHttp: 'http://127.0.0.1:3000', retryMinutes: 5 },
    time: { predictAt: '17:30', catchUpEnd: '19:50', settleAt: '22:00', settleGiveUp: '23:30' },
    games: { ssq: { enabled: true }, dlt: { enabled: true }, p3: { enabled: true } },
    historyCount: 30,
    historyTail: 10,
    persona: '',
    holidays: [],
  }

  const ensureDirs = () => { fs.mkdirSync(dataDir, { recursive: true }); fs.mkdirSync(workDir, { recursive: true }) }

  let state = readJson(STATE_FILE) ?? null
  const saveState = () => writeJsonAtomic(STATE_FILE, state ?? {})

  const readPreds = () => readJson(PRED_FILE) ?? { entries: [] }
  const readLedger = () => readJson(LEDGER_FILE) ?? { entries: [] }

  const cfgNow = () => readConfigFile(configPath, DEFAULTS)
  const gameEnabled = (cfg, k) => cfg.games?.[k]?.enabled !== false

  // ── 会话（她的专用会话，跨天保留记忆 → 越聊越有「日子」味）──────────────────
  let sessionReady = false
  async function ensureSession() {
    if (sessionReady) return
    try { await ctx.sessionController.create({ sessionId, cwd: workDir }) }
    catch { log('[koi] 未创建新会话（可能已有同名会话），沿用已有会话') }
    sessionReady = true
  }

  async function promptAgent(text) {
    await ensureSession()
    await ctx.sessionController.prompt(
      { requestId: 'koi-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6), sessionId, mode: 'queue', content: [{ type: 'text', text }] },
      new AbortController().signal,
    )
  }

  // ── 出号流水线（正式预测与加餐共用；返回 { picks, message, via, issue }）──────
  let inFlight = false
  async function runPredictFlow(gameKey, { quick = false, late = false } = {}) {
    if (inFlight) throw new Error('她正在出别的号，稍等')
    inFlight = true
    const stamp = Date.now()
    const outPath = path.join(workDir, `predict-${gameKey}-${quick ? 'qp-' + stamp : todayStr()}.json`)
    try {
      ensureDirs()
      const cfg = cfgNow()
      // 1) 抓官方历史，推算今晚期号
      const history = await fetchHistory(gameKey, Number(cfg.historyCount ?? 30))
      if (!Array.isArray(history) || !history.length) throw new Error('官方历史数据为空')
      const issue = nextIssue(history[0].issue, history[0].date, todayStr())
      // 2) 叫醒她（先清掉旧结果文件）
      try { fs.rmSync(outPath, { force: true }) } catch {}
      await promptAgent(buildPredictPrompt({ gameKey, cfg, history, issue, outPath, late }))
      // 3) 等结果文件 → 硬校验；不合法给一次重写机会；再不行随机兜底
      let raw = await waitJsonFile(outPath)
      let v = raw ? validatePicks(gameKey, raw.picks ?? raw) : { ok: false, error: '没有等到结果文件' }
      if (!v.ok) {
        log(`[koi] ${gameKey} 第一次产出不合格（${v.error}），给她一次重写机会`)
        await promptAgent([
          '【打回重写】你刚写的文件系统校验没过：' + v.error,
          `请立刻重写 ${outPath}（还是那个 JSON 契约，号码必须合规），写完就停。`,
        ].join('\n'))
        raw = await waitJsonFile(outPath, 60_000)
        v = raw ? validatePicks(gameKey, raw.picks ?? raw) : { ok: false, error: '重写也没等到' }
      }
      let picks, message, via
      if (v.ok) {
        picks = v.picks
        message = String(raw.message ?? '').trim() || '（她忘了写正文，但号码在这里：' + picksLine(gameKey, picks) + '）'
        via = 'ai'
      } else {
        log(`[koi] ${gameKey} AI 产出两次不合格，走随机兜底`)
        picks = randomPicks(gameKey)
        message = fallbackMessage(gameKey, picks)
        via = 'fallback'
      }
      // 4) 落 predictions 账（加餐也记号，但 kind 区分，账本只算 daily）
      const preds = readPreds()
      preds.entries.push({
        at: new Date().toISOString(), kind: quick ? 'quickpick' : 'daily',
        game: gameKey, issue, date: todayStr(), picks, via,
        ...stakesOf(gameKey),   // { bets, cost, spec }
      })
      writeJsonAtomic(PRED_FILE, ensureSchemaVersion(preds))   // C4：顶层 schemaVersion
      return { picks, message, via, issue }
    } finally {
      inFlight = false
      try { fs.rmSync(outPath, { force: true }) } catch {}
    }
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

  const header = (quick, gameKey, issue) => quick
    ? `🐟【锦鲤加餐 · ${GAMES[gameKey].name} · 第 ${issue} 期】（面板加餐，不记账）\n\n`
    : `🐟【锦鲤 · ${GAMES[gameKey].name} · 第 ${issue} 期 · ${todayStr()}】\n\n`

  async function pushText(text) {
    const cfg = cfgNow()
    return pushPrivate(cfg.push?.napcatHttp ?? DEFAULTS.push.napcatHttp, cfg.push?.target ?? DEFAULTS.push.target, text)
  }

  // ── C10/FR-005 推送统一重试：失败即入补发队列（队列按 retryMinutes 续试、不过期、跨天携带）──
  function queueRepush(kind, gameKey, issue, text, deadline, lastErr) {
    const item = {
      kind, game: gameKey, issue: issue ?? null, text,
      deadline, failedAt: new Date().toISOString(),
      lastErr: String(lastErr ?? 'unknown').slice(0, 120), attempts: 1,
    }
    const { queue, dropped } = enqueueRepush(state.repushQueue, item)
    state.repushQueue = queue
    saveState()
    if (dropped.length) {
      // B-31：溢出不静默丢弃 —— 推告警（告警本身走同一通道、尽最大努力，不入队防自激）
      log(`[koi] 补发队列已满（${REPUSH_QUEUE_MAX}），最早 ${dropped.length} 条将放弃：${dropped.map((d) => `${d.kind}/${d.game}/${d.issue ?? '-'}`).join('、')}`)
      pushText(`⚠️ 锦鲤补发队列已满（上限 ${REPUSH_QUEUE_MAX}），最早 ${dropped.length} 条将放弃（${dropped.map((d) => `${d.kind}/${d.game}`).join('、')}）。通道恢复后请看面板确认。`).catch(() => {})
    }
  }

  /** 战果/致歉类推送：直接试一次，失败入队续试（预测类走 tick 里的既有重试游标，超线才入队） */
  async function pushOrQueue(kind, gameKey, issue, text, deadline) {
    try {
      const r = await pushText(text)
      if (r.ok) return true
      queueRepush(kind, gameKey, issue, text, deadline, r.word || r.retcode)
    } catch (e) {
      queueRepush(kind, gameKey, issue, text, deadline, e?.message ?? e)
    }
    return false
  }

  // ── 战果文案（对账推送用）───────────────────────────────────────────────
  function resultLine(gameKey, r) {
    if (gameKey === 'ssq') return r.red.map((n) => String(n).padStart(2, '0')).join(' ') + ' + ' + String(r.blue).padStart(2, '0')
    if (gameKey === 'dlt') return r.front.map((n) => String(n).padStart(2, '0')).join(' ') + ' + ' + r.back.map((n) => String(n).padStart(2, '0')).join(' ')
    return r.digits.join(' ')
  }

  function settleText(gameKey, entry, result, judged, totals) {
    const g = GAMES[gameKey]
    const s = stakesOf(gameKey)
    return [
      `🎰【锦鲤战果 · ${g.name} · 第 ${entry.issue} 期】`,
      `开奖：${resultLine(gameKey, result)}`,
      `我们的号：${picksLine(gameKey, entry.picks)}`,
      `（${s.spec} · ${s.bets} 注 / ${s.cost} 元）`,
      `结果：${gradeSummaryText(gameKey, judged)}${judged.floating ? '（含浮动奖，金额以官方公布为准）' : ''}`,
      `本回合计：中 ${judged.money} 元`,
      ledgerTotalsText(totals),
      '开奖是随机的，图个乐～ 明天继续攒运气！',
    ].join('\n')
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
      const latest = await fetchLatestDraw(gameKey)
      if (!latest || !latest.issue) throw new Error('开奖数据为空')
      // 期号跳跃时先翻历史核实：目标期可能已公布（宕机/晚公布错过），翻得到按公布结清，
      // 翻不到才证实「目标期号缺席」转作废（docs/12 FR-001 作废条件原文）
      let result = null
      if (String(latest.issue) === String(entry.issue)) result = latest
      else if (Number(latest.issue) > Number(entry.issue)) {
        const hist = await fetchHistory(gameKey, VOID_HISTORY_COUNT).catch(() => [])
        result = (Array.isArray(hist) ? hist : []).find((d) => String(d.issue) === String(entry.issue)) ?? null
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
      // settle：判奖、记账、推送（补判走 supplement，正常走 main）
      const judged = judge(gameKey, entry.picks, result, result.prizeGrades ?? null)
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
      const text = settleText(gameKey, entry, result, judged, totals)
      const pushOk = await pushOrQueue('result', gameKey, entry.issue, text, deadlineForKind('result', cfg.time))
      entry.settled = true
      entry.settleState = 'settled'
      entry.result = result
      entry.prize = judged.money
      entry.grades = judged.grades
      entry.pushedResult = pushOk
      writeJsonAtomic(PRED_FILE, ensureSchemaVersion(preds))
      log(`[koi] ${gameKey} ${entry.issue} 期对账完成${wasGivenUp ? '（补判）' : ''}：${gradeSummaryText(gameKey, judged)}，中 ${judged.money} 元${pushOk ? '，战果已推送' : '，战果推送失败已入补发队列'}`)
      return true
    } catch (e) {
      log(`[koi] ${gameKey} 对账失败（下一轮再试）：${e.message}`)
      return false
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
      if (!state || state.date !== today) {
        const carry = carryJobsFromEntries(readPreds().entries)
        const repushQueue = Array.isArray(state?.repushQueue) ? state.repushQueue : []   // C10：跨天显式携带（原重建丢弃未知顶层字段）
        state = { date: today, games: {}, carry, repushQueue, lastError: null }
        saveState()
      }
      state.games = state.games ?? {}
      const predictAt = cfg.time?.predictAt ?? '17:30'
      const catchUpEnd = cfg.time?.catchUpEnd ?? '19:50'
      const settleAt = cfg.time?.settleAt ?? '22:00'
      const now = hhmm()
      const holiday = isHoliday(today, cfg.holidays)   // C2/FR-002：休市日不出号、不对账、不致歉，静默顺延
      const todays = gamesForDate(today).filter((k) => gameEnabled(cfg, k))

      if (!holiday) {
      // ── 出号段 ──
      for (const gameKey of todays) {
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
              const { picks, message, via, issue } = await runPredictFlow(gameKey, { late })
              const st = state.games[gameKey]
              st.phase = 'predicted'
              st.attempts += 1
              st.issue = issue
              st.via = via
              st.message = message
              st.picksLine = picksLine(gameKey, picks)
              st.pushErr = null
              saveState()
              log(`[koi] ${gameKey} 第 ${issue} 期出号完成（${via}${late ? ' · 晚到' : ''}）：${st.picksLine}`)
            } catch (e) {
              const st = state.games[gameKey]
              st.attempts += 1
              st.lastError = String(e?.message ?? e).slice(0, 200)
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
        // 过了窗口还没出号 → 放弃 + 致歉一次（C10：致歉同走统一重试通道）
        if (g.phase === 'idle' && now > catchUpEnd) {
          g.phase = 'skipped'
          saveState()
          pushOrQueue('apology', gameKey, null, `🐟 锦鲤今天没赶上 ${GAMES[gameKey].name} 的预测（服务当时不在线或多次失败），抱歉，明天继续！`, deadlineForKind('apology', cfg.time))
        }
        // 已出号未推送 / 推送失败 → 按 push.retryMinutes 重试（C10）；超 catchUpEnd 终止线转补发队列
        if (g.phase === 'predicted' && !g.pushedAt) {
          if (now > catchUpEnd) {
            if (!g.repushQueued) {
              g.repushQueued = true
              saveState()
              queueRepush('predict', gameKey, g.issue, header(false, gameKey, g.issue) + (g.message ?? ''), deadlineForKind('predict', cfg.time), g.pushErr ?? '超终止线未送达')
              log(`[koi] ${gameKey} 预测推送超 ${catchUpEnd} 终止线，转入补发队列`)
            }
          } else if (!g.pushTryAt || Date.now() - g.pushTryAt > retryIntervalMs(cfg)) {
            g.pushTryAt = Date.now()
            saveState()
            pushText(header(false, gameKey, g.issue) + g.message).then((r) => {
              const st = state.games[gameKey]
              if (r.ok) { st.pushedAt = new Date().toISOString(); st.pushErr = null }
              else { st.pushErr = String(r.word || r.retcode || 'unknown').slice(0, 120) }
              saveState()
              log(`[koi] ${gameKey} 推送${r.ok ? '成功' : '失败：' + st.pushErr}`)
            }).catch((e) => {
              const st = state.games[gameKey]
              st.pushErr = String(e?.message ?? e).slice(0, 120)
              saveState()
              log(`[koi] ${gameKey} 推送异常：${st.pushErr}`)
            })
          }
        }
        // failed / skipped 各自只推一次致歉（failed 的致歉在这里补；C10 同走统一重试通道）
        if (g.phase === 'failed' && !g.apologyPushed) {
          g.apologyPushed = true
          saveState()
          pushOrQueue('apology', gameKey, null, `🐟 锦鲤今天研究 ${GAMES[gameKey].name} 时反复卡壳，预测没出来，抱歉！明天继续攒运气。`, deadlineForKind('apology', cfg.time))
        }
      }
      // 今天不开的彩种，把残留状态清掉（比如用户新开了某个彩种）
      for (const k of GAME_ORDER) if (!todays.includes(k) && state.games[k]?.phase === 'idle') delete state.games[k]

      // ── 对账段（今天的 + 顺延的）──
      if (now >= settleAt) {
        const jobs = [...todays.filter((k) => ['predicted', 'pushed'].includes(state.games[k]?.phase ?? 'idle'))
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
      }   // ← !holiday（休市日静默顺延：出号段/对账段/致歉全部跳过）

      // ── 补发队列（C10/FR-005）：按 push.retryMinutes 续试，不过期、跨天携带；休市日照常补发 ──
      const rq = state.repushQueue ?? []
      if (rq.length) {
        const interval = retryIntervalMs(cfg)
        for (const item of rq) {
          if (item.lastTryAt && Date.now() - item.lastTryAt < interval) continue
          item.lastTryAt = Date.now()
          item.attempts = (item.attempts ?? 1) + 1
          saveState()
          const late = isPastDeadline(new Date(), item.deadline, item.failedAt)
          pushText((late ? '【补发】' : '') + item.text).then((r) => {
            if (r.ok) {
              state.repushQueue = (state.repushQueue ?? []).filter((x) => x !== item)
              log(`[koi] 补发送达（${item.kind} ${item.game}${item.issue ? ' 第 ' + item.issue + ' 期' : ''}，尝试 ${item.attempts} 次${late ? ' · 已加【补发】标注' : ''}）`)
            } else {
              item.lastErr = String(r.word || r.retcode || 'unknown').slice(0, 120)
            }
            saveState()
          }).catch((e) => {
            item.lastErr = String(e?.message ?? e).slice(0, 120)
            saveState()
          })
        }
      }
    } catch (e) {
      log('[koi] tick 异常：' + String(e?.message ?? e))
      try { state.lastError = String(e?.message ?? e).slice(0, 200); saveState() } catch {}
    } finally {
      ticking = false
    }
  }

  // ── 面板「现在来一注」─────────────────────────────────────────────────────
  const qpJobs = new Map()
  let qpSeq = 0
  function quickpick(gameKey) {
    if (!GAMES[gameKey]) return { ok: false, error: '没有这个彩种' }
    const cfg = cfgNow()
    if (!gameEnabled(cfg, gameKey)) return { ok: false, error: `${GAMES[gameKey].name} 在配置里是关掉的` }
    if (inFlight) return { ok: false, error: '她正在出别的号，一分钟后再试' }
    const id = 'qp' + (++qpSeq) + '-' + Date.now().toString(36)
    const job = { id, game: gameKey, status: 'running', startedAt: new Date().toISOString(), message: null, picksLine: null, error: null }
    qpJobs.set(id, job)
    if (qpJobs.size > 20) { const first = qpJobs.keys().next().value; qpJobs.delete(first) }
    ;(async () => {
      try {
        const { picks, message, via, issue } = await runPredictFlow(gameKey, { quick: true })
        const r = await pushText(header(true, gameKey, issue) + message)
        job.status = r.ok ? 'done' : 'push-failed'
        job.message = message
        job.picksLine = picksLine(gameKey, picks)
        job.via = via
        job.error = r.ok ? null : `推送失败：${r.word || r.retcode}（号已出，在下面）`
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

  const timer = setInterval(() => { tick().catch(() => {}) }, TICK_MS)
  const boot = setTimeout(() => { tick().catch(() => {}) }, 10_000)
  log(`[koi] 锦鲤生物钟已启动（每 ${TICK_MS / 1000}s tick · 会话 ${sessionId} · 出号 ${DEFAULTS.time.predictAt} 起 · 对账 ${DEFAULTS.time.settleAt} 起）`)

  return {
    stop() { stopped = true; clearTimeout(boot); clearInterval(timer) },
    tick,
    quickpick,
    qpJob: (id) => qpJobs.get(id) ?? null,
    status() {
      const cfg = cfgNow()
      const today = todayStr()
      const g = (state?.games) ?? {}
      const out = {}
      for (const k of GAME_ORDER) {
        const st = g[k]
        const enabled = gameEnabled(cfg, k) && gamesForDate(today).includes(k)
        out[k] = {
          enabledToday: enabled,
          phase: enabled ? (st?.phase ?? 'idle') : 'off',
          issue: st?.issue ?? null,
          picksLine: st?.picksLine ?? null,
          via: st?.via ?? null,
          pushedAt: st?.pushedAt ?? null,
          pushErr: st?.pushErr ?? null,
          settled: st?.settled ?? false,
          lastError: st?.lastError ?? null,
          spec: stakesOf(k)?.spec ?? '',
        }
      }
      return {
        ok: true, today, time: hhmm(),
        schedulerOk: true,
        games: out,
        carry: (state?.carry ?? []).length,
        holiday: isHoliday(today, cfg.holidays),          // C2/FR-002：今天是否休市
        repushQueue: (state?.repushQueue ?? []).length,   // C10/FR-005：补发队列长度
        mind: mindStatus(cfg),                            // FR-023：认知层总开关与握手状态（只读）
        ledger: ledgerTotals(readLedger()),
        ledgerText: ledgerTotalsText(ledgerTotals(readLedger())),
        pushTargetMasked: String(cfg.push?.target ?? '').replace(/^(\d{3})\d+(\d{2})$/, '$1****$2'),
        lastError: state?.lastError ?? null,
      }
    },
  }
}
