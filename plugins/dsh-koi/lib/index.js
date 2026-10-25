/**
 * dsh-koi —— 宿主侧插件入口（市场版 v2）
 *
 * 职责：
 *   1. 启动调度器（lib/scheduler.js）：出号 / 事件通知 / 对账 状态机
 *   2. 面板 API（设置 → 彩票 的「现在来一注」按钮背后；FZ-6 既有 4 条形状只加不改）：
 *        GET  /dsh-koi/api/status            今天开什么、各彩种状态、账本摘要（status 附加市场版字段）
 *        POST /dsh-koi/api/quickpick         加餐/手动推荐：立刻出一注（事件层通知，不重试）
 *        GET  /dsh-koi/api/quickpick?id=…    轮询加餐任务结果
 *        POST /dsh-koi/api/test-push         发条测试事件（经事件层至启用渠道；形状不变，语义改事件层）
 *   3. 市场版新路由（docs/16 §6.1；MC-18 终集 5 新 + 第二波增量 docs/19 §8）：
 *        GET  /dsh-koi/api/events            事件列表（桌宠/面板共用，since/limit）
 *        GET/POST /dsh-koi/api/config        读（掩码）/写（校验+原子写）配置
 *        POST /dsh-koi/api/channels/test     单渠道测试（掩码回显）
 *        POST /dsh-koi/api/mode              三态切换/门控（S-116）
 *        GET/POST /dsh-koi/api/backbone      本地库状态 / 触发近期窗口按需拉取（MC-03/MC-18）
 *        POST /dsh-koi/api/backbone/full     全量回拉（confirm:true 契约；第二波 §2.5）
 *        POST /dsh-koi/api/backbone/stop     停止回拉（断点保留）
 *        GET/POST /dsh-koi/api/ingest        学习上传（raw body + ?name=）/ jobs+卡片状态（第二波 §4）
 *   4. 与鲸鱼插件同款的信任栅栏：所有路由 fail-closed（回环 + connection.requestRejection）
 *
 * 双 profile 同构（FR-1019/NFR-101）：web 与 desktop 均跑本入口（进程内 tick、数据落本地
 * $DSH_HOME/koi*、模型用用户 DSH 配置）；DSH_HOME 优先、兜底 ~/.dsh（Windows 桌面自然落用户目录）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startKoiScheduler } from './scheduler.js'
import { GAME_ORDER, GAMES, gamesForDate } from './draws.js'
import { buildConfigTemplate, buildConfigDefaults, readConfig, validateConfig, maskConfig } from './config.js'
import { readJson, writeJsonAtomic } from './io.js'
import { channelsStatus, resolveChannelCfg, maskChannelCfg } from './channels/index.js'

// 与鲸鱼插件一致的路径约定：DSH_HOME 优先，兜底 ~/.dsh
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const CONFIG_FILE = process.env.KOI_CONFIG || path.join(DSH_HOME, 'koi.config.json')
const DATA_DIR = path.join(DSH_HOME, 'koi')
const WORK_DIR = path.join(DSH_HOME, 'koi-work')
const USER_CHANNELS_DIR = path.join(DSH_HOME, 'koi', 'channels')

// 首次跑把默认配置落盘（市场版模板 v2：零 QQ —— channels/modes 默认 manual+最小档/budget/effort/verbosity；
// 模板与校验同源 lib/config.js，BC-103/MB-16；用户升级覆盖安装不触碰本文件之外的用户数据，S-115）
try {
  if (!fs.existsSync(CONFIG_FILE)) {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true })
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(buildConfigTemplate(), null, 2) + '\n')
  }
} catch { /* 只读环境就算了，调度器里有默认值兜底 */ }

let SCHED_STATUS = { ok: false, reason: '未初始化', at: null }

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(obj))
}

/** 读请求体（T-10 单实现）：默认文本 16KB；二进制路由传 { limit, binary:true }，超限抛 body too large */
function readBody(req, { limit = 16 * 1024, binary = false } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      const buf = Buffer.concat(chunks)
      resolve(binary ? buf : buf.toString('utf8'))
    })
    req.on('error', reject)
  })
}

/** 点路径扁平 patch → 深合并（数组整替；MD-26） */
function applyPatch(target, flat) {
  const out = structuredClone(target)
  for (const [key, val] of Object.entries(flat ?? {})) {
    const parts = String(key).split('.')
    let cur = out
    for (let i = 0; i < parts.length - 1; i++) {
      const k = parts[i]
      if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = {}
      cur = cur[k]
    }
    cur[parts[parts.length - 1]] = val
  }
  return out
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

    // ── 路由守卫（T-10 样板抽取；响应体与状态码与抽取前逐位一致）──────────────
    function requireMethod(req, res, method) {
      if (req.method === method) return true
      json(res, 405, { ok: false })
      return false
    }
    function requireSched(res) {
      if (sched) return true
      json(res, 503, { ok: false, error: '调度器未启动' })
      return false
    }

    // ── 渠道探测（30s TTL 缓存，MD-11；status 轮询开销与 v1 同量级）────────────
    let channelsProbe = { at: 0, data: [] }
    async function channelsNow() {
      if (!sched || Date.now() - channelsProbe.at < 30_000) return channelsProbe.data
      try {
        const cfg = readJson(CONFIG_FILE, {}) ?? {}
        const { adapters } = await sched.channelsOverview()
        channelsProbe = { at: Date.now(), data: await channelsStatus(cfg.channels ?? [], { adapters, userDir: USER_CHANNELS_DIR }) }
      } catch (e) {
        channelsProbe = { at: Date.now(), data: [{ index: -1, type: '?', enabled: true, status: 'error', error: String(e?.message ?? e).slice(0, 120) }] }
      }
      return channelsProbe.data
    }

    // ── 状态（面板轮询；FZ-6 形状不变 + 市场版加法字段）───────────────────────
    route('exact', '/dsh-koi/api/status', async (req, res) => {
      const base = { ok: true, configPath: CONFIG_FILE, scheduler: SCHED_STATUS, calendar: gamesForDate(new Date().toLocaleDateString('sv-SE')), allGames: GAME_ORDER.map((k) => ({ key: k, name: GAMES[k].name, emoji: GAMES[k].emoji, drawTimeText: GAMES[k].drawTimeText, drawAt: GAMES[k].drawAt })) }
      if (!sched) { json(res, 200, { ...base, ok: false, error: '调度器未启动' }); return }
      const st = sched.status()
      const channels = await channelsNow()
      st.channels = channels   // 渠道层探针（含掩码回显；v1 的单渠道探测语义已随渠道层重构）
      st.pet = readJson(CONFIG_FILE, {})?.pet ?? { enabled: true, corner: 'br' }   // 桌宠开关（关闭则前端不挂载）
      json(res, 200, { ...base, ...st })
    })

    // ── 加餐/手动推荐：现在来一注（永久基础层，三态任一可用）──────────────────
    route('exact', '/dsh-koi/api/quickpick', async (req, res) => {
      if (req.method === 'GET') {
        const u = new URL(req.url, 'http://x')
        const job = sched?.qpJob(u.searchParams.get('id') ?? '')
        if (!job) { json(res, 404, { ok: false, error: '没有这个任务' }); return }
        json(res, 200, { ok: true, job }); return
      }
      if (!requireMethod(req, res, 'POST')) return
      if (!requireSched(res)) return
      const b = JSON.parse(await readBody(req) || '{}')
      const r = sched.quickpick(String(b.game ?? ''))
      json(res, r.ok ? 200 : 400, r)
    })

    // ── 测试事件（形状不变 FZ-6；语义 = 经事件层发测试事件至启用渠道）──────────
    route('exact', '/dsh-koi/api/test-push', async (req, res) => {
      if (!requireMethod(req, res, 'POST')) return
      try {
        const r = await sched.bus.testEvent()
        json(res, 200, r)
      } catch (e) { json(res, 200, { ok: false, detail: String(e?.message ?? e) }) }
    })

    // ── 事件列表（桌宠/面板共用；DC-102 窗口 + since 游标）────────────────────
    route('exact', '/dsh-koi/api/events', async (req, res) => {
      if (!requireMethod(req, res, 'GET')) return
      if (!requireSched(res)) return
      const u = new URL(req.url, 'http://x')
      const limit = Math.min(Number(u.searchParams.get('limit') ?? 200) || 200, 200)
      const r = sched.bus.listEvents({ since: u.searchParams.get('since') ?? undefined, limit })
      json(res, 200, { ok: true, ...r })
    })

    // T-11 / ADR-0006：GET 与 POST 均走 config.readConfig，与 scheduler / CLI 同源——
    // v2 配置行为逐位不变；v1 遗留配置 GET 多出换算 modes（读面与运行态一致），
    // POST 写回换算结果但**不升 schemaVersion**：完整迁移（push 侧车/v1 等价档/gates）仍归
    // `koi.mjs migrate-v2`，面板保存不是迁移通道（D5：升级版本号会让 migrate-v2 幂等短路）。
    route('exact', '/dsh-koi/api/config', async (req, res) => {
      if (req.method === 'GET') {
        const cfg = readConfig(CONFIG_FILE)
        json(res, 200, { ok: true, configPath: CONFIG_FILE, config: maskConfig(cfg) })
        return
      }
      if (!requireMethod(req, res, 'POST')) return
      const b = JSON.parse(await readBody(req) || '{}')
      const merged = applyPatch(readConfig(CONFIG_FILE), b.patch ?? {})
      const v = validateConfig(merged)
      if (!v.ok) { json(res, 400, { ok: false, errors: v.errors }); return }
      writeJsonAtomic(CONFIG_FILE, merged)
      json(res, 200, { ok: true })
    })

    // ── 单渠道测试（AC-103：逐渠道独立测试，掩码回显）─────────────────────────
    route('exact', '/dsh-koi/api/channels/test', async (req, res) => {
      if (!requireMethod(req, res, 'POST')) return
      const b = JSON.parse(await readBody(req) || '{}')
      const cfg = readJson(CONFIG_FILE, {}) ?? {}
      const entry = (cfg.channels ?? [])[Number(b.index)]
      if (!entry) { json(res, 404, { ok: false, error: '没有这个渠道' }); return }
      try {
        const { adapters } = await sched.channelsOverview()
        const found = adapters.get(entry.type)
        if (!found) { json(res, 200, { ok: false, detail: `渠道 ${entry.type} 的适配器缺失，请在渠道目录补入 ${entry.type}.js 或停用该渠道` }); return }
        const chCfg = resolveChannelCfg(entry, USER_CHANNELS_DIR)
        const r = await found.adapter.test(chCfg)
        json(res, 200, { ok: r?.ok === true, detail: r?.ok ? String(r?.word ?? 'ok') : `不通：${String(r?.word ?? '').slice(0, 120)}`, masked: maskChannelCfg(chCfg, found.adapter) })
      } catch (e) {
        json(res, 200, { ok: false, detail: '不通：' + String(e?.message ?? e).slice(0, 120) })
      }
    })

    // ── 三态切换/门控（S-116：任一缺失即阻止并逐项指明）───────────────────────
    route('exact', '/dsh-koi/api/mode', async (req, res) => {
      if (!requireMethod(req, res, 'POST')) return
      if (!requireSched(res)) return
      const b = JSON.parse(await readBody(req) || '{}')
      const r = await sched.setMode(b)
      json(res, r.ok ? 200 : 400, r)
    })

    // ── 本地库（MC-03/MC-18：GET 状态 / POST 触发近期窗口按需拉取；第二波增 backfill 进度）──
    let pullingBackbone = false
    route('exact', '/dsh-koi/api/backbone', async (req, res) => {
      if (req.method === 'GET') {
        if (!requireSched(res)) return
        const st = sched.status()
        json(res, 200, {
          ok: true, backbone: st.backbone,
          backfill: sched.backfill?.status() ?? null,
          note: '近期窗口按需拉取（秒—分钟级）；全量历史回拉见「数据」区（确认框触发，进度可轮询本接口）',
        })
        return
      }
      if (!requireMethod(req, res, 'POST')) return
      if (!requireSched(res)) return
      if (pullingBackbone) { json(res, 409, { ok: false, error: '正在拉取中' }); return }
      pullingBackbone = true
      const out = {}
      try {
        const cfg = { ...buildConfigDefaults(), ...(readJson(CONFIG_FILE, {}) ?? {}) }
        const n = Number(cfg.historyCount ?? 30)
        for (const g of GAME_ORDER) {
          try {
            const r = await sched.drawstore.ensureRecent(g, n)
            out[g] = { ok: true, fetched: r.fetched, count: sched.drawstore.status(g).count }
          } catch (e) { out[g] = { ok: false, error: String(e?.message ?? e).slice(0, 120) } }
        }
        json(res, 200, { ok: Object.values(out).every((x) => x.ok), perGame: out })
      } finally { pullingBackbone = false }
    })

    // ── 全量回拉（第二波 docs/19 §2.5：确认框触发；真实全量不自动执行——红线）──────────
    route('exact', '/dsh-koi/api/backbone/full', async (req, res) => {
      if (!requireMethod(req, res, 'POST')) return
      if (!requireSched(res)) return
      let b = {}
      try { b = JSON.parse(await readBody(req) || '{}') } catch { b = {} }
      if (b.confirm !== true) { json(res, 400, { ok: false, error: '缺少 confirm:true（全量回拉需经确认框显式确认）' }); return }
      const game = b.game ?? null
      if (game != null && !GAME_ORDER.includes(game)) { json(res, 400, { ok: false, error: '没有这个彩种' }); return }
      const pf = sched.backfill.preflight(game ?? GAME_ORDER[0])
      if (!pf.ok) { json(res, pf.code ?? 409, { ok: false, error: pf.error }); return }
      // 异步开跑（每彩种分批/限速/错峰/断点由引擎负责）；进度经 GET /api/backbone 轮询，可随时 stop
      sched.backfill.runAll({ games: game ? [game] : [...GAME_ORDER] }).catch(() => {})
      json(res, 200, { ok: true, started: true, game: game ?? 'all' })
    })

    route('exact', '/dsh-koi/api/backbone/stop', async (req, res) => {
      if (!requireMethod(req, res, 'POST')) return
      if (!requireSched(res)) return
      json(res, 200, sched.backfill.stop())
    })

    // ── 学习半环（第二波 docs/19 §4.1/§8）：raw body 上传（非 multipart，W2A-11）+ jobs/卡片状态 ──
    // 二进制读体走 readBody 的 { limit, binary:true }（T-10 单实现）：Buffer 累积 + 20MB 上限（超限 413）。
    route('exact', '/dsh-koi/api/ingest', async (req, res) => {
      if (req.method === 'GET') {
        if (!requireSched(res)) return
        const st = sched.ingest.list()
        json(res, 200, {
          ok: true,
          jobs: st.jobs.slice(-50).reverse(),
          cards: st.cards.map((c) => ({ id: c.id, name: c.name, games: c.games, trustLevel: c.trustLevel, status: c.status, factorId: c.factorId, backtest: c.backtest, similarOf: c.similarOf })),
          usage: sched.status().costEstimate?.weekly ?? null,
        })
        return
      }
      if (!requireMethod(req, res, 'POST')) return
      if (!requireSched(res)) return
      const u = new URL(req.url, 'http://x')
      const name = u.searchParams.get('name') ?? 'upload.txt'
      let buf
      try { buf = await readBody(req, { limit: 20 * 1024 * 1024, binary: true }) } catch {
        json(res, 413, { ok: false, error: '文件超过 20MB 上限（该路由二进制上限 20MB）' })
        return
      }
      const r = sched.ingest.acceptBuffer({ name, buffer: buf, sourceType: 'panel-upload' })
      if (!r.ok) { json(res, r.code ?? 400, { ok: false, error: r.error }); return }
      json(res, 200, { ok: true, job: r.job, estimateTokens: r.estimate })
    })

    // ── 因子结论（第二波 §8「因子结论」区数据源：内置档案 + 卡片回写结论；口径行前端恒拼）──
    route('exact', '/dsh-koi/api/backtest', async (req, res) => {
      if (!requireMethod(req, res, 'GET')) return
      if (!requireSched(res)) return
      json(res, 200, {
        ok: true,
        verdicts: Object.fromEntries(GAME_ORDER.map((g) => [g, sched.backtest.verdicts(g)])),
        note: '回测结论仅供你参考，不改变任何自动行为（§5.8）',
      })
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

    try { console.log(`[koi] 锦鲤已挂载：设置 → 彩票 · 配置 ${CONFIG_FILE} · 数据 ${DATA_DIR} · 渠道目录 ${USER_CHANNELS_DIR}`) } catch {}
  },
}
