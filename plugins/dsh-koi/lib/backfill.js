/**
 * dsh-koi 全量回拉引擎（第二波 docs/19 §2，FR-1016 全量回拉部分 / BC-104/105 / BC-012）。
 *
 * 职责（W2-D01：独立模块，不塞 drawstore——drawstore 保持「本地库」单一职责）：
 *   · 分批（福彩期号窗口 / 体彩 pageSize=100+pageNo，分页协议按阶段A冒烟实测定型 W2-D02）
 *   · 限速（批间 batchGapMs 秒级礼貌间隔）、断点续传（checkpoint koi/databackbone.json 每批原子写）
 *   · 退避（单批失败重试 3 次 2s/8s/30s；福彩窗口减半再试一轮，最小 10；体彩直接中止保断点）
 *   · 错峰（启动拒绝 + 运行中跨入 17:00–22:30 暂停待续，22:30 后自动续拉——W2A-07）
 *   · 作业锁互斥（backfill/ingest/backtest 三类后台作业，koi/job-lock.json，W2A-20）
 *   · done 判据 = 空页（体彩）/ 连续 3 空窗（福彩跨年步进防御）；done 后全库审计 + 同源抽样核验
 *   · 拒用留痕（draws-rejected.log 追加只增；checkpoint.rejectedTotal 累计）
 *
 * 红线：真实全量回拉不自动执行——调度器/tick/向导均不调用 run（docs/19 §2.5）；
 * 测试注入面 = fetchPage / now / sleep / store / lock（全部可 mock，网络计数可断言，AC-108 口径）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { readJson, writeJsonAtomic } from './io.js'
import { validateDraws, auditContinuity, crossCheckLatest } from './validate-draws.js'
import { fetchHistoryPage, fetchLatestDraw } from './fetch-draws.mjs'
import { hhmm as hhmmOf, todayStr } from './timeutil.js'   // T-07：时间工具单点（sv-SE 逐字保持）

const BACKOFF_MS = [2_000, 8_000, 30_000]   // 单批失败重试间隔（指数 + 抖动上限，docs/19 §2.3-5）
const PAUSE_POLL_MS = 30_000                // 错峰暂停中的复检间隔
const EMPTY_STREAK_DONE = 3                 // 福彩连续 3 空窗 → done（跨年步进可能先遇空年段，§2.4 防御）
const MIN_SSQ_WINDOW = 10                   // 福彩窗口减半下限
const DEFAULT_BATCH_GAP_MS = 2_000

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms))
// T-07：hhmmOf 已下沉 lib/timeutil.js（import 别名保持本文件既有名字）
/** 错峰窗口 [17:00, 22:30)（BC-012；与第一波语义同源） */
export const inOffpeakWindow = (now) => {
  const t = hhmmOf(now)
  return t >= '17:00' && t < '22:30'
}

/** 福彩 7 位期号跨年步进：windowEnd 落入本年不存在区（末三位 000）→ 跳到上一年年中探针值（§2.3-3） */
function stepWindowEnd(w) {
  if (w % 1000 === 0) return (Math.floor(w / 1000) - 1) * 1000 + 400
  return w
}

/**
 * createBackfill({ dataDir, store, fetchPage, lock, now, sleep, readCfg, log, fetchLatest })
 *   store = createDrawStore(...)（upsertBatch/status/oldest/getRecent/ensureRecent 复用）
 *   fetchPage 注入 fetchHistoryPage（测试 mock 计请求次数，AC-108 口径）
 *   lock 作业互斥锁（lib/joblock.js；测试注入假锁）
 * → { run, runAll, status, stop, CHECKPOINT_FILE }
 */
export function createBackfill({
  dataDir,
  store,
  fetchPage = (g, p) => fetchHistoryPage(g, p),
  lock,
  now = () => new Date(),
  sleep = defaultSleep,
  readCfg = () => ({}),
  log = () => {},
  fetchLatest = (g) => fetchLatestDraw(g),
} = {}) {
  const CHECKPOINT_FILE = path.join(dataDir ?? '.', 'databackbone.json')
  const REJECTED_LOG = path.join(dataDir ?? '.', 'draws-rejected.log')
  const STOP_FLAG_FILE = path.join(dataDir ?? '.', 'backfill-stop.flag')

  const running = new Set()
  let stopRequested = false

  /** 跨进程停止旗标（CLI stop → 宿主运行中的回拉）：批首消费；>120s 视为过期清除（防误停后续任务） */
  const consumeStopFlag = () => {
    try {
      const flag = readJson(STOP_FLAG_FILE, null)
      if (!flag) return false
      fs.rmSync(STOP_FLAG_FILE, { force: true })
      const at = Date.parse(flag.at ?? '')
      if (!Number.isNaN(at) && now().getTime() - at > 120_000) return false   // 过期旗标：清掉不生效
      log('[koi] 检出跨进程停止旗标（backbone stop），当前批完成后退出（断点保留）')
      return true
    } catch { return false }
  }

  const readCp = () => readJson(CHECKPOINT_FILE, { schemaVersion: 1, perGame: {} })
  const writeCp = (cp) => writeJsonAtomic(CHECKPOINT_FILE, cp)
  const appendRejected = (game, rejected) => {
    if (!Array.isArray(rejected) || !rejected.length) return
    try {
      fs.mkdirSync(path.dirname(REJECTED_LOG), { recursive: true })
      const lines = rejected.map((r) => `${now().toISOString()}\t${game}\t${r.issue}\t${r.reason}`)
      fs.appendFileSync(REJECTED_LOG, lines.join('\n') + '\n')
    } catch (e) { log(`[koi] 拒用留痕写入失败（不中断回拉）：${String(e?.message ?? e)}`) }
  }

  /**
   * run(game, { smoke, noOffpeak })：单彩种全量回拉（smoke=true 最多 2 页，管线自验专用）。
   * 预期失败不抛错，返回 { ok:false, error }（409/4xx 语义由调用面映射）。
   */
  async function run(game, { smoke = false, noOffpeak = false } = {}) {
    if (running.has(game)) return { ok: false, error: '正在拉取中', code: 409 }
    const acq = typeof lock?.acquire === 'function' ? lock.acquire('backfill', game) : { ok: true }
    if (!acq.ok) {
      return { ok: false, code: 409, error: `另一后台作业进行中（${acq.held?.kind ?? '?'}/${acq.held?.key ?? '-'}），完成后重试` }
    }
    try {
      const cfg = readCfg() ?? {}
      const bf = cfg.backfill ?? {}
      const offpeak = !noOffpeak && bf.offpeakOnly !== false
      if (offpeak && inOffpeakWindow(now())) {
        return { ok: false, code: 400, error: '错峰窗口（17:00–22:30）内不执行全量回拉，22:30 后再试或用 --no-offpeak 显式越过' }
      }
      running.add(game)
      return await runLoop(game, { smoke, offpeak, cfg })
    } finally {
      running.delete(game)
      try { lock?.release?.() } catch {}
    }
  }

  /** 三彩种顺序跑（CLI/面板入口；单彩种失败不断链，逐项如实汇报） */
  async function runAll({ smoke = false, noOffpeak = false, games } = {}) {
    const list = Array.isArray(games) && games.length ? games : ['ssq', 'dlt', 'p3']
    const out = {}
    for (const g of list) out[g] = await run(g, { smoke, noOffpeak })
    return { ok: Object.values(out).every((r) => r.ok), perGame: out }
  }

  async function runLoop(game, { smoke, offpeak }) {
    const cfg = readCfg() ?? {}
    const bf = cfg.backfill ?? {}
    let batchSize = Number(bf.batchSize) > 0 ? Math.floor(Number(bf.batchSize)) : 100
    const batchGapMs = Number(bf.batchGapMs) > 0 ? Number(bf.batchGapMs) : DEFAULT_BATCH_GAP_MS
    const retryMax = Number.isInteger(Number(bf.retryMax)) && Number(bf.retryMax) >= 0 ? Number(bf.retryMax) : 3
    const targetIssues = Number(bf.targetIssues) > 0 ? Number(bf.targetIssues) : null
    const today = todayStr(now())   // T-07：内联 toLocaleDateString 改引用单点（v0.2B2-D1）

    const cp = readCp()
    cp.perGame = cp.perGame ?? {}
    const mode = game === 'ssq' ? 'window' : 'pageNo'
    const pg = cp.perGame[game] ?? {
      done: false, mode, windowEnd: null, nextPageNo: 1, fetchedIssues: 0, targetIssues,
      pages: 0, requests: 0, rejectedTotal: 0, lastBatchAt: null, lastErr: null, progress: null, audit: null,
    }
    cp.perGame[game] = pg
    pg.mode = mode
    pg.targetIssues = targetIssues
    pg.lastErr = null

    // 续拉起点（断点续传，§2.3-3）
    let windowEnd = null
    if (game === 'ssq') {
      let oldest = store.oldest(game)
      if (oldest == null) {
        try {
          await store.ensureRecent(game, 30)   // 铺底：复用第一波近期窗口机制（30 期内含最新）
          oldest = store.oldest(game)
        } catch (e) {
          pg.lastErr = `铺底失败：${String(e?.message ?? e).slice(0, 160)}`
          pg.status = 'error'
          writeCp(cp)
          return { ok: false, error: pg.lastErr }
        }
      }
      if (oldest == null) {
        pg.lastErr = '官方近期数据为空（铺底失败）'
        pg.status = 'error'
        writeCp(cp)
        return { ok: false, error: pg.lastErr }
      }
      windowEnd = stepWindowEnd(Number(oldest) - 1)
    }
    let nextPageNo = game === 'ssq' ? null : (Number(pg.nextPageNo) > 0 ? Number(pg.nextPageNo) : 1)

    let pagesThisRun = 0
    let emptyStreak = 0
    let lastErr = null
    pg.status = 'running'
    writeCp(cp)

    const finish = async (status, extra = {}) => {
      pg.status = status
      if (status === 'done') pg.done = true
      writeCp(cp)
      return { ok: status !== 'error', game, status, requests: pg.requests, fetchedIssues: pg.fetchedIssues, rejectedTotal: pg.rejectedTotal, progress: pg.progress, ...extra }
    }

    // ── 主循环（§2.3-4）──────────────────────────────────────────────────────
    for (;;) {
      // 批首三查：stop（进程内旗标 + 跨进程旗标）/ 错峰复检（运行中跨入 17:00–22:30 → 暂停待续）/ 锁心跳
      if (!stopRequested) stopRequested = consumeStopFlag()
      if (stopRequested) {
        stopRequested = false
        log(`[koi] backfill ${game} 收到停止请求，当前批完成后退出（断点保留）`)
        return await finish('stopped', { stopped: true })
      }
      while (offpeak && inOffpeakWindow(now()) && !stopRequested) {
        pg.status = 'paused-offpeak'
        writeCp(cp)
        log(`[koi] backfill ${game} 运行中跨入错峰窗口（17:00–22:30），暂停保断点，22:30 后自动续拉`)
        await sleep(PAUSE_POLL_MS)
        if (!stopRequested) stopRequested = consumeStopFlag()
      }
      if (stopRequested) { stopRequested = false; return await finish('stopped', { stopped: true }) }
      pg.status = 'running'
      try { lock?.heartbeat?.() } catch {}

      // 组参数 → 1 次请求
      let page
      if (game === 'ssq') {
        page = { window: { issueStart: String(windowEnd - batchSize + 1), issueEnd: String(windowEnd) } }
      } else {
        page = { pageNo: nextPageNo }
      }

      // 单批失败退避（§2.3-5）：重试 3 次 2s/8s/30s
      let data = null
      let batchErr = null
      for (let attempt = 0; attempt <= retryMax; attempt++) {
        if (attempt > 0) await sleep(BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)])
        try {
          data = await fetchPage(game, page)
          batchErr = null
          break
        } catch (e) { batchErr = e }
      }
      pg.requests += 1
      pg.pages += 1
      pagesThisRun += 1
      if (batchErr != null) {
        lastErr = `单批 ${retryMax + 1} 次尝试均失败：${String(batchErr?.message ?? batchErr).slice(0, 160)}`
        if (game === 'ssq' && batchSize > MIN_SSQ_WINDOW) {
          const narrowed = Math.max(MIN_SSQ_WINDOW, Math.floor(batchSize / 2))
          log(`[koi] backfill ${game} ${lastErr}；窗口减半（${batchSize} → ${narrowed}）再试一轮`)
          batchSize = narrowed
          continue
        }
        pg.lastErr = lastErr
        log(`[koi] backfill ${game} 中止（checkpoint 保留，重启续拉）：${lastErr}`)
        return await finish('error', { error: lastErr })
      }

      const items = Array.isArray(data) ? data : []
      // 空页 → done 判据（§2.4）；福彩跨年步进可能先遇空年段 → 连续 3 空窗才判 done
      if (!items.length) {
        if (game === 'ssq') {
          emptyStreak += 1
          if (emptyStreak >= EMPTY_STREAK_DONE) {
            const audit = await auditAndCrossCheck(game, { stoppedAtEmptyStreak: true })
            pg.audit = audit
            log(`[koi] backfill ${game} 连续 ${EMPTY_STREAK_DONE} 个空窗 → 判 done（已早于上市期号）`)
            return await finish('done', { done: true, stoppedAtEmptyStreak: true })
          }
          // smoke：空窗探测也计入请求预算（每彩种 ≤2 请求；跨年空段探测不破红线总量）
          if (smoke && pagesThisRun >= 2) {
            const audit = await auditAndCrossCheck(game, { smoke: true })
            pg.audit = audit
            return await finish('smoke-done', { smoke: true })
          }
          windowEnd = stepWindowEnd(Number(page.window.issueStart) - 1)
          pg.lastBatchAt = now().toISOString()
          writeCp(cp)
          await sleep(batchGapMs)
          continue
        }
        const audit = await auditAndCrossCheck(game, {})
        pg.audit = audit
        log(`[koi] backfill ${game} 空页（pageNo=${nextPageNo}）→ done`)
        return await finish('done', { done: true })
      }
      emptyStreak = 0

      // 四项校验（BC-104）→ 入库（upsert 幂等去重）；拒用累计 + 追加留痕
      // 入库/落盘异常 = 批失败 → 中止保断点（S-111 语义：拒用并留痕，不静默）
      let newOldest = null
      try {
        const v = validateDraws(game, items, { today })
        if (v.rejected.length) {
          pg.rejectedTotal += v.rejected.length
          appendRejected(game, v.rejected)
        }
        const prevOldest = store.oldest(game)
        store.upsertBatch(game, v.valid)
        newOldest = store.oldest(game)
        // 页界连续性防御（跨批，§2.3-6）：按期号比较（升序库下新页应把最早界往前推）
        if (prevOldest != null && Number(newOldest) >= Number(prevOldest)) {
          pg.gapNote = `页界重叠/倒挂：上批入库后最早期号 ${prevOldest}，本批后 ${newOldest}（upsert 幂等去重兜底；完整审计由全库扫描收口）`
          log(`[koi] backfill ${game} ${pg.gapNote}`)
        }
      } catch (e) {
        lastErr = `入库/校验异常（checkpoint 保留，重启续拉；upsert 幂等保证重访不重复入库）：${String(e?.message ?? e).slice(0, 160)}`
        pg.lastErr = lastErr
        log(`[koi] backfill ${game} 中止：${lastErr}`)
        return await finish('error', { error: lastErr })
      }
      pg.fetchedIssues += items.length
      pg.lastBatchAt = now().toISOString()
      pg.progress = { note: `已拉至 ${newOldest}`, oldestInStore: String(newOldest) }

      if (game === 'ssq') {
        const minIssue = Math.min(...items.map((e) => Number(e.issue)))
        windowEnd = stepWindowEnd(minIssue - 1)
        pg.windowEnd = windowEnd
      } else {
        nextPageNo += 1
        pg.nextPageNo = nextPageNo
      }
      writeCp(cp)

      // targetIssues 提前收口（§2.4）
      if (targetIssues != null && pg.fetchedIssues >= targetIssues) {
        const audit = await auditAndCrossCheck(game, { earlyStop: true })
        pg.audit = audit
        log(`[koi] backfill ${game} 达成 targetIssues=${targetIssues} → 提前收口 done`)
        return await finish('done', { done: true, earlyStop: true })
      }
      // smoke：每彩种最多 2 页（B 阶段与管线唯一允许的真实触达规模）
      if (smoke && pagesThisRun >= 2) {
        const audit = await auditAndCrossCheck(game, { smoke: true })
        pg.audit = audit
        return await finish('smoke-done', { smoke: true })
      }
      await sleep(batchGapMs)
    }
  }

  /** done 后全库审计 + 同源抽样核验（§2.4 / §3） */
  async function auditAndCrossCheck(game, flags = {}) {
    const entries = store.getRecent(game, Infinity)
    const audit = { at: now().toISOString(), ...flags, continuity: auditContinuity(entries) }
    try {
      audit.crossCheck = await crossCheckLatest(store, { fetchLatestDraw: fetchLatest }, game)
    } catch (e) {
      audit.crossCheck = { ok: false, crossCheck: 'fetch-error', error: String(e?.message ?? e).slice(0, 160) }
    }
    return audit
  }

  return {
    run,
    runAll,
    CHECKPOINT_FILE,
    STOP_FLAG_FILE,
    /**
     * 启动前预检（同步；路由面把 409/4xx 在响应里如实透出，长任务随后异步开跑）。
     * 与 run() 自身的守卫同语义（幂等复检，双保险）。
     */
    preflight(game, { noOffpeak = false } = {}) {
      if (running.has(game)) return { ok: false, code: 409, error: '正在拉取中' }
      const cur = typeof lock?.current === 'function' ? lock.current() : null
      if (cur && cur.kind) return { ok: false, code: 409, error: `另一后台作业进行中（${cur.kind}/${cur.key ?? '-'}），完成后重试` }
      const bf = readCfg()?.backfill ?? {}
      if (!noOffpeak && bf.offpeakOnly !== false && inOffpeakWindow(now())) {
        return { ok: false, code: 400, error: '错峰窗口（17:00–22:30）内不执行全量回拉，22:30 后再试或用 --no-offpeak 显式越过' }
      }
      return { ok: true }
    },
    /** 底座状态（backbone status / GET /api/backbone 附加字段；DC-109） */
    status() {
      const cp = readCp()
      return { file: CHECKPOINT_FILE, running: [...running], perGame: cp.perGame ?? {} }
    },
    /** 停止当前回拉：当前批完成后退出，断点保留（§2.5）。进程内旗标 + 跨进程旗标文件（CLI stop 用） */
    stop() {
      if (running.size) {
        stopRequested = true
        return { ok: true, note: '已请求停止：当前批完成后退出，断点保留' }
      }
      // 本进程没有在跑：写跨进程旗标（宿主进程内的回拉会在下一批首消费；过期 120s 自动失效）
      try { writeJsonAtomic(STOP_FLAG_FILE, { at: now().toISOString() }) } catch {}
      return { ok: true, note: '已写入停止旗标（若宿主内有进行中的回拉，将在当前批完成后退出、断点保留）' }
    },
  }
}
