/**
 * dsh-koi —— 宿主侧插件入口
 *
 * 职责：
 *   1. 启动调度器（lib/scheduler.js）：出号 / 推送 / 对账 状态机
 *   2. 面板 API（设置 → 彩票 的「现在来一注」按钮背后）：
 *        GET  /dsh-koi/api/status            今天开什么、各彩种状态、账本摘要
 *        POST /dsh-koi/api/quickpick         加餐：立刻出一注并私聊推送
 *        GET  /dsh-koi/api/quickpick?id=…    轮询加餐任务结果
 *        POST /dsh-koi/api/test-push         发条测试私聊（装完先点这个 ✓）
 *   3. 与鲸鱼插件同款的信任栅栏：所有路由 fail-closed（回环 + connection.requestRejection）
 *
 * 只跑在服务器（真实 Node 进程）上 —— 桌面 Electron 版没适配（抓数/推送都在进程内）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startKoiScheduler } from './scheduler.js'
import { napcatAlive } from './push.mjs'
import { GAME_ORDER, GAMES, gamesForDate } from './draws.js'

// 与鲸鱼插件一致的路径约定：DSH_HOME 优先，兜底 ~/.dsh
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const CONFIG_FILE = process.env.KOI_CONFIG || path.join(DSH_HOME, 'koi.config.json')
const DATA_DIR = path.join(DSH_HOME, 'koi')
const WORK_DIR = path.join(DSH_HOME, 'koi-work')

// 首次跑把默认配置落盘（用户后面直接 nano 改：人设、时间、开关都在这一份里）
try {
  if (!fs.existsSync(CONFIG_FILE)) {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true })
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({
      _说明: '锦鲤配置。games.*.enabled 开关彩种；time.predictAt/catchUpEnd/settleAt 是 HH:MM；push.target 是接收私聊的 QQ 号；persona 留空用内置「元气小财迷」人设，想改就整段写进来',
      push: { target: '1017099872', napcatHttp: 'http://127.0.0.1:3000' },
      time: { predictAt: '17:30', catchUpEnd: '19:50', settleAt: '22:00', settleGiveUp: '23:30' },
      games: { ssq: { enabled: true }, dlt: { enabled: true }, p3: { enabled: true } },
      historyCount: 30,
      historyTail: 10,
      persona: '',
    }, null, 2) + '\n')
  }
} catch { /* 只读环境就算了，调度器里有默认值兜底 */ }

let SCHED_STATUS = { ok: false, reason: '未初始化', at: null }

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(obj))
}

function readBody(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export default {
  name: 'dsh-koi',
  inject: ['sessionController', 'webServer', 'connection'],
  apply(ctx) {

    // ── 信任栅栏（照抄鲸鱼插件的 fail-closed 姿势）──────────────────────────
    function isLoopbackReq(req) {
      const host = String(req.headers?.host ?? '').toLowerCase().split(':')[0]
      return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1'
    }
    function rejected(req, res) {
      if (!isLoopbackReq(req)) { json(res, 403, { ok: false, error: '只接受本机回环访问' }); return true }
      try {
        const conn = ctx.get('connection') || ctx.connection
        if (!conn || typeof conn.requestRejection !== 'function') {
          json(res, 503, { ok: false, error: '信任栅栏不可用，拒绝访问（fail-closed）' }); return true
        }
        const code = conn.requestRejection(req)
        if (code === undefined || code === null || code === false) return false
        res.statusCode = typeof code === 'number' ? code : 403
        res.end()
        return true
      } catch {
        json(res, 503, { ok: false, error: '信任栅栏异常，拒绝访问（fail-closed）' }); return true
      }
    }

    const disposers = []
    function route(kind, pathname, handler) {
      disposers.push(ctx.webServer.register({
        kind,
        path: pathname,
        handler: async (req, res) => {
          if (rejected(req, res)) return
          try { await handler(req, res) } catch (err) {
            try { json(res, 500, { ok: false, error: String(err?.message ?? err) }) } catch {}
          }
        },
      }))
    }

    // ── 状态（面板轮询）────────────────────────────────────────────────────
    route('exact', '/dsh-koi/api/status', async (req, res) => {
      const base = { ok: true, configPath: CONFIG_FILE, scheduler: SCHED_STATUS, calendar: gamesForDate(new Date().toLocaleDateString('sv-SE')), allGames: GAME_ORDER.map((k) => ({ key: k, name: GAMES[k].name, emoji: GAMES[k].emoji, drawTimeText: GAMES[k].drawTimeText })) }
      if (!sched) { json(res, 200, { ...base, ok: false, error: '调度器未启动' }); return }
      const st = sched.status()
      // 顺带探一下 NapCat 通道（本机请求，很轻；挂了就如实显示 ✗）
      try {
        const alive = await napcatAlive(st.configNapcat ?? 'http://127.0.0.1:3000')
        st.push = { ok: alive.ok, detail: alive.ok ? `在线：${alive.nickname}（QQ ${alive.qq}）` : `不通：${alive.word}` }
      } catch (e) { st.push = { ok: false, detail: '不通：' + String(e?.message ?? e).slice(0, 100) } }
      json(res, 200, { ...base, ...st })
    })

    // ── 加餐：现在来一注 ───────────────────────────────────────────────────
    route('exact', '/dsh-koi/api/quickpick', async (req, res) => {
      if (req.method === 'GET') {
        const u = new URL(req.url, 'http://x')
        const job = sched?.qpJob(u.searchParams.get('id') ?? '')
        if (!job) { json(res, 404, { ok: false, error: '没有这个任务' }); return }
        json(res, 200, { ok: true, job }); return
      }
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      if (!sched) { json(res, 503, { ok: false, error: '调度器未启动' }); return }
      const b = JSON.parse(await readBody(req) || '{}')
      const r = sched.quickpick(String(b.game ?? ''))
      json(res, r.ok ? 200 : 400, r)
    })

    // ── 测试推送（装完先点这个，手机收到 = 整条链路通）──────────────────────
    route('exact', '/dsh-koi/api/test-push', async (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      try {
        const { pushPrivate } = await import('./push.mjs')
        let cfg = {}
        try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) } catch {}
        const base = cfg.push?.napcatHttp || 'http://127.0.0.1:3000'
        const target = cfg.push?.target
        const r = await pushPrivate(base, target, '🐟 锦鲤测试消息：链路通了！以后开奖日 17:30 左右，预测就从这条通道发给你。')
        json(res, 200, { ok: r.ok, detail: r.ok ? '已发出，看手机 ✓' : `发送失败：retcode=${r.retcode} ${r.word}` })
      } catch (e) { json(res, 200, { ok: false, detail: String(e?.message ?? e) }) }
    })

    // ── 启动调度器 ─────────────────────────────────────────────────────────
    let sched = null
    try {
      sched = startKoiScheduler(ctx, {
        dshHome: DSH_HOME,
        configPath: CONFIG_FILE,
        dataDir: DATA_DIR,
        workDir: WORK_DIR,
        sessionId: 'koi-lottery',
        log: (m) => { try { console.log(m) } catch {} },
      })
      SCHED_STATUS = { ok: true, reason: '已启动（每 30s tick）', at: new Date().toISOString() }
    } catch (e) {
      SCHED_STATUS = { ok: false, reason: String(e?.message ?? e).slice(0, 300), at: new Date().toISOString() }
      try { console.warn('[koi] 调度器启动失败：' + e.message) } catch {}
    }

    ctx.effect(() => () => {
      try { sched?.stop() } catch {}
      for (const d of disposers) { try { d() } catch {} }
    })

    try { console.log(`[koi] 锦鲤已挂载：设置 → 彩票 · 配置 ${CONFIG_FILE} · 数据 ${DATA_DIR}`) } catch {}
  },
}
