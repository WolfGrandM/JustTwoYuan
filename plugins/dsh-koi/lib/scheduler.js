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

const TICK_MS = 30_000
const ATTEMPT_GAP_MS = 2 * 60_000        // 两次出号尝试至少隔 2 分钟
const PUSH_RETRY_MS = 60_000             // 推送失败重试间隔
const SETTLE_GAP_MS = 15 * 60_000        // 开奖未公布 → 15 分钟后再问
const SETTLE_MAX_TRIES = 8               // 22:00 起最多问 8 轮（到 23:30 前后）
const FILE_WAIT_MS = 4 * 60_000          // 等她写结果文件的上限
const FILE_POLL_MS = 3_000
const MAX_ATTEMPTS = 3

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
    push: { target: '1017099872', napcatHttp: 'http://127.0.0.1:3000' },
    time: { predictAt: '17:30', catchUpEnd: '19:50', settleAt: '22:00', settleGiveUp: '23:30' },
    games: { ssq: { enabled: true }, dlt: { enabled: true }, p3: { enabled: true } },
    historyCount: 30,
    historyTail: 10,
    persona: '',
  }

  const ensureDirs = () => { fs.mkdirSync(dataDir, { recursive: true }); fs.mkdirSync(workDir, { recursive: true }) }
  const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null } }
  const writeJson = (p, o) => {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    const tmp = p + '.' + process.pid + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(o, null, 2) + '\n')
    fs.renameSync(tmp, p)
  }

  let state = readJson(STATE_FILE) ?? null
  const saveState = () => writeJson(STATE_FILE, state ?? {})

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
      writeJson(PRED_FILE, preds)
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

  // 对一个「已推送未对账」的条目做一次对账尝试；返回 true = 这条了结（成功或放弃）
  async function settleOne({ date, gameKey }) {
    const preds = readPreds()
    const idx = preds.entries.findIndex((e) => e.kind === 'daily' && e.game === gameKey && e.date === date && !e.settled)
    if (idx < 0) return true   // 没这条账 → 视为了结
    const entry = preds.entries[idx]
    const cfg = cfgNow()
    const giveUp = cfg.time?.settleGiveUp ?? '23:30'
    try {
      const latest = await fetchLatestDraw(gameKey)
      if (!latest || !latest.issue) throw new Error('开奖数据为空')
      if (String(latest.issue) !== String(entry.issue)) {
        // 还不是这一期 → 未公布（除非已经过了放弃线）
        if (hhmm() > giveUp) {
          entry.settled = true; entry.settleNote = '当晚未等到开奖公布，放弃对账'
          writeJson(PRED_FILE, preds)
          log(`[koi] ${gameKey} ${date} 对账放弃（${giveUp} 前没等到第 ${entry.issue} 期）`)
          return true
        }
        return false
      }
      // 对上了 → 判奖、记账、推送
      const judged = judge(gameKey, entry.picks, latest, latest.prizeGrades ?? null)
      const ledger = readLedger()
      appendLedgerEntry(ledger, {
        at: new Date().toISOString(), kind: 'daily', game: gameKey, issue: entry.issue, date,
        cost: entry.cost, prize: judged.money, bets: judged.bets, grades: judged.grades,
      })
      writeJson(LEDGER_FILE, ledger)
      const totals = ledgerTotals(ledger)
      const text = settleText(gameKey, entry, latest, judged, totals)
      const r = await pushText(text)
      entry.settled = true
      entry.result = latest
      entry.prize = judged.money
      entry.grades = judged.grades
      entry.pushedResult = r.ok
      writeJson(PRED_FILE, preds)
      log(`[koi] ${gameKey} ${entry.issue} 期对账完成：${gradeSummaryText(gameKey, judged)}，中 ${judged.money} 元${r.ok ? '，战果已推送' : '，但战果推送失败（' + (r.word || r.retcode) + '）'}`)
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
      // 跨天：把没对完账的顺延（carry），今天的重新开始
      if (!state || state.date !== today) {
        const carry = []
        const prevDate = state?.date
        if (prevDate) {
          for (const e of (readPreds().entries ?? [])) {
            if (e.kind === 'daily' && e.date === prevDate && !e.settled) carry.push({ date: e.date, gameKey: e.game })
          }
        }
        state = { date: today, games: {}, carry, lastError: null }
        saveState()
      }
      state.games = state.games ?? {}
      const predictAt = cfg.time?.predictAt ?? '17:30'
      const catchUpEnd = cfg.time?.catchUpEnd ?? '19:50'
      const settleAt = cfg.time?.settleAt ?? '22:00'
      const now = hhmm()
      const todays = gamesForDate(today).filter((k) => gameEnabled(cfg, k))

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
        // 过了窗口还没出号 → 放弃 + 致歉一次
        if (g.phase === 'idle' && now > catchUpEnd) {
          g.phase = 'skipped'
          saveState()
          pushText(`🐟 锦鲤今天没赶上 ${GAMES[gameKey].name} 的预测（服务当时不在线或多次失败），抱歉，明天继续！`).catch(() => {})
        }
        // 已出号未推送 / 推送失败 → 重试推送
        if (g.phase === 'predicted' && !g.pushedAt) {
          if (!g.pushTryAt || Date.now() - g.pushTryAt > PUSH_RETRY_MS) {
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
        // failed / skipped 各自只推一次致歉（failed 的致歉在这里补）
        if (g.phase === 'failed' && !g.apologyPushed) {
          g.apologyPushed = true
          saveState()
          pushText(`🐟 锦鲤今天研究 ${GAMES[gameKey].name} 时反复卡壳，预测没出来，抱歉！明天继续攒运气。`).catch(() => {})
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
        ledger: ledgerTotals(readLedger()),
        ledgerText: ledgerTotalsText(ledgerTotals(readLedger())),
        pushTargetMasked: String(cfg.push?.target ?? '').replace(/^(\d{3})\d+(\d{2})$/, '$1****$2'),
        lastError: state?.lastError ?? null,
      }
    },
  }
}
