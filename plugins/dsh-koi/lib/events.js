/**
 * dsh-koi 通知事件层（市场版 FR-1001/BC-102/DC-102）—— 所有出站通知先成为结构化事件；
 * FR-005 统一重试/补发/心跳语义在此实现一次（docs/16 §2.2.1）。
 *
 * 复用纪律（D-001/IF-R01）：retryIntervalMs / deadlineForKind / isPastDeadline / enqueueRepush
 * 直接 import lib/settle-core.js 既有纯函数（零拷贝；v0.2 T-05 前自 scheduler.js import，
 * 现随纯函数层搬迁改道——循环①消除）；retryIntervalMs 以形参 shim
 * {push:{retryMinutes:cfg.time?.retryMinutes}} 适配 v2 的 time.retryMinutes（等价性实测：
 * 7→420000ms、缺省→300000ms）。kind 扩展映射（advice/heartbeat → 12:00）在本层包装，不改原函数。
 *
 * 驱动（MD-03）：emit() 即首试；pump() 由调度器每 30s tick 驱动续试（间隔语义仍由 retryMinutes 控制）。
 * 持久化 koi/events.json（io.js 原子写，调度器单写者约定）；90 天滚动清理（MA-24）。
 */
import path from 'node:path'
import { readJson, writeJsonAtomic } from './io.js'
import { renderEvent } from './render.js'
import { loadAdapters, resolveChannelCfg, secretsOf, maskString } from './channels/index.js'
import { retryIntervalMs, deadlineForKind, isPastDeadline, enqueueRepush, REPUSH_QUEUE_MAX } from './settle-core.js'

export const EVENT_KINDS = ['predict', 'quickpick', 'result', 'apology', 'alert', 'advice', 'heartbeat', 'test']
const SEND_TIMEOUT_MS = 15_000
// T-05：本行原 REPUSH_MAX = 20 手动镜像已删除——补发上限归一 settle-core.REPUSH_QUEUE_MAX（enqueueRepush 默认同参，FR-005 上限 20）

/** 分类终止线的 kind 扩展映射（§2.2.1-2：advice/heartbeat → 次日 12:00；MD-08 包装不改原函数） */
export function kindDeadline(kind, time = {}) {
  if (kind === 'advice' || kind === 'heartbeat') return '12:00'
  return deadlineForKind(kind, time)
}

/**
 * 心跳判定（§4.3，A2.1 V8 四断言；纯函数）：
 *   mode ≠ auto → 'skip'（手动无定时承诺，MA-19）
 *   当日应有事件为空 → 'no-events'（出号/对账环节异常，走面板 lastError，不是心跳语义）
 *   有事件且全部启用渠道（含桌宠送达状态）均无「已送达」→ 'heartbeat'
 *   任一启用渠道（含桌宠）有送达 → 'ok'
 * events = 当日该彩种应有事件（predict/result/apology/alert——quickpick 显式排除，§2.2.1-3）。
 */
export function heartbeatJudge(events, enabledChannels, mode) {
  if (mode !== 'auto') return 'skip'
  if (!Array.isArray(events) || events.length === 0) return 'no-events'
  for (const ch of enabledChannels) {
    const delivered = events.some((e) => Array.isArray(e?.delivery) && e.delivery.some((d) => d?.channel === ch && d?.ok === true))
    if (delivered) return 'ok'
  }
  return 'heartbeat'
}

const withTimeout = (p, ms = SEND_TIMEOUT_MS) => Promise.race([
  p, new Promise((_, rej) => setTimeout(() => rej(new Error(`渠道响应超时（${ms / 1000}s）`)), ms)),
])
const isoOf = (d) => d.toISOString()

export function createEventBus({
  dataDir,
  userChannelsDir,
  readCfg = () => ({}),
  adapters: injectedAdapters,     // 测试注入 {adapters: Map, problems: []}
  now = () => new Date(),
  log = () => {},
  onRepushDelivered = () => {},   // 补发送达回调（调度器清心跳红标）
} = {}) {
  const EVENTS_FILE = path.join(dataDir ?? '.', 'events.json')
  let adapters = injectedAdapters ?? null

  const readStore = () => readJson(EVENTS_FILE, { schemaVersion: 1, entries: [] })
  const saveStore = (store) => writeJsonAtomic(EVENTS_FILE, store)

  async function ensureAdapters() {
    if (!adapters) adapters = await loadAdapters(userChannelsDir)
    // 归一：接受 loadAdapters 返回形状 {adapters:Map,problems} 或直接 Map（测试注入）
    return adapters instanceof Map ? { adapters, problems: [] } : adapters
  }

  /** 当前启用渠道（含缺适配器者——送达面记失败但事件层不崩） */
  function enabledChannels(cfg) {
    return (Array.isArray(cfg?.channels) ? cfg.channels : []).filter((c) => c && c.enabled !== false)
  }

  /** 单事件一轮投递：逐启用渠道 adapter.send（15s 超时 + 单渠道异常隔离 + 凭证擦除） */
  async function deliver(ev, cfg, { repush = false } = {}) {
    const list = enabledChannels(cfg)
    const { adapters: map } = await ensureAdapters()
    const secrets = []
    ev.delivery = []
    ev.attempts = (ev.attempts ?? 0) + 1
    ev.lastTryAt = isoOf(now())
    const body = repush && isPastDeadline(now(), ev.deadline, ev.failedAt ?? ev.at) ? `【补发】${ev.body}` : ev.body
    for (const ch of list) {
      const found = map.get(ch.type)
      if (!found) {
        ev.delivery.push({ channel: ch.type, ok: false, at: isoOf(now()), attempts: ev.attempts, lastErr: `适配器缺失：${ch.type}.js（请在渠道目录补入或停用）` })
        continue
      }
      const chCfg = resolveChannelCfg(ch, userChannelsDir)
      secrets.push(...secretsOf(chCfg, found.adapter))
      try {
        const r = await withTimeout(found.adapter.send({ ...ev, body }, chCfg))
        ev.delivery.push({ channel: ch.type, ok: r?.ok === true, at: isoOf(now()), attempts: ev.attempts, lastErr: r?.ok === true ? null : maskString(String(r?.word ?? 'unknown').slice(0, 120), secrets) })
      } catch (e) {
        ev.delivery.push({ channel: ch.type, ok: false, at: isoOf(now()), attempts: ev.attempts, lastErr: maskString(String(e?.message ?? e).slice(0, 120), secrets) })
      }
    }
    const allOk = list.length > 0 && ev.delivery.every((d) => d.ok)
    ev.status = allOk ? 'sent' : (ev.noRetry ? 'failed' : 'retrying')
    if (allOk) {
      ev.repushDelivered = repush
      // 迟到送达（过终止线才送达）= 渠道恢复 → 清红标回调（含 queued 补发与 retrying 晚到两种路径）
      if (repush || isPastDeadline(now(), ev.deadline, ev.failedAt ?? ev.at)) onRepushDelivered(ev)
    }
    if (!allOk) ev.lastErr = maskString((ev.delivery.find((d) => !d.ok)?.lastErr ?? 'unknown'), secrets)
    else ev.lastErr = null
    if (list.length === 0) ev.lastErr = '无启用渠道（事件在面板可见，渠道恢复后补发）'
    return ev
  }

  /**
   * emit（§3.1 主循环）：schema 化 → render.body → 落盘 pending → 逐启用渠道 send → 状态更新。
   * partial = { kind, level?, game?, issue?, gameName?, date?, picksLine?, summary?, message?, via?,
   *            flags?, noRetry?, fullRef? }
   * 返回落盘后的事件（快照）。
   */
  async function emit(partial) {
    const cfg = readCfg()
    if (!EVENT_KINDS.includes(partial?.kind)) throw new Error(`事件 kind 非法：${partial?.kind}`)
    const verbosity = cfg?.verbosity === 'chatty' ? 'chatty' : 'concise'
    const rendered = renderEvent(partial, { verbosity })
    const ev = {
      id: `evt-${now().getTime()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: partial.kind,
      level: partial.level ?? (partial.kind === 'heartbeat' || partial.kind === 'alert' ? 'warn' : 'info'),
      game: partial.game ?? null,
      issue: partial.issue ?? null,
      at: isoOf(now()),
      deadline: kindDeadline(partial.kind, cfg?.time ?? {}),
      body: rendered.body,
      fullRef: partial.fullRef ?? null,
      status: 'pending',
      delivery: [],
      attempts: 0,
      noRetry: partial.noRetry ?? partial.kind === 'quickpick',   // 加餐例外：一次即止（FR-005 例外原文）
      won: partial.won ?? null,   // 中奖标记（仅 result 事件携带；未读/冒泡过滤用）
    }
    const store = readStore()
    store.entries.push(ev)
    store.schemaVersion = 1
    saveStore(store)
    await deliver(ev, cfg)
    if (rendered.summaryRejected) {
      await emit({ kind: 'alert', level: 'warn', game: partial.game, message: `上一条事件的 AI 摘要超长（>100 字），已拒发并保留「（超长已拒发）」标注——不静默截断（BC-108）`, noRetry: true })
    }
    const s2 = readStore()
    const i = s2.entries.findIndex((e) => e.id === ev.id)
    if (i >= 0) s2.entries[i] = ev
    saveStore(s2)
    return ev
  }

  /**
   * 超线转补发队列（enqueueRepush 语义复用：上限 20 / 同类合并 / 溢出丢弃最早并告警不静默）。
   * 队列即事件存储内 status='queued' 的条目（跨重启携带；不再写 state.repushQueue，§2.2.1-8）。
   * 溢出告警经 alerts 出参返回（由调用方在落盘后 emit，防嵌套 emit 的丢失更新）。
   */
  function toQueue(entries, ev, alerts) {
    const queued = entries.filter((e) => e.status === 'queued')
    const shadow = queued.map((e) => ({ kind: e.kind, game: e.game, issue: e.issue, text: e.body, deadline: e.deadline, failedAt: e.at, lastErr: e.lastErr ?? '', attempts: e.attempts ?? 1 }))
    const { queue, merged, dropped } = enqueueRepush(shadow, {
      kind: ev.kind, game: ev.game, issue: ev.issue ?? null, text: ev.body,
      deadline: ev.deadline, failedAt: ev.at, lastErr: ev.lastErr ?? '', attempts: ev.attempts ?? 1,
    }, REPUSH_QUEUE_MAX)
    const key = (x) => `${x.kind}|${x.game}|${x.issue ?? ''}`
    const byKey = new Map(queue.map((x) => [key(x), x]))
    for (const e of entries) {
      if (e.status !== 'queued') continue
      if (!byKey.has(key(e))) {
        e.status = 'dropped'
        e.dropNote = '补发队列溢出，最早条目让位（B-31 不静默：见告警事件）'
      } else if (merged && key(e) === key(ev)) {
        e.mergedCount = (e.mergedCount ?? 0) + 1
        e.body = ev.body
        e.attempts = Math.max(e.attempts ?? 1, ev.attempts ?? 1)
      }
    }
    if (merged) {
      // 同类合并：新事件并入既有 queued 条目，本体移除
      const i = entries.indexOf(ev)
      if (i >= 0) entries.splice(i, 1)
    } else {
      ev.status = 'queued'
    }
    if (dropped.length) {
      log(`[koi] 补发队列已满（${REPUSH_QUEUE_MAX}），最早 ${dropped.length} 条将放弃：${dropped.map((d) => `${d.kind}/${d.game}/${d.issue ?? '-'}`).join('、')}`)
      // B-31 溢出告警（尽最大努力，不入队防自激；由 pump 落盘后 emit）
      alerts.push({ game: ev.game, dropped: dropped.map((d) => `${d.kind}/${d.game}`).join('、'), n: dropped.length })
    }
    return entries
  }

  /**
   * pump（MD-03：调度器 tick 驱动）：
   * ① retrying/queued 且过间隔 → 续试（queued 过线带【补发】前缀；迟到送达回调清红标）
   * ② 续试后仍失败且超终止线 → 转补发队列（统一走 toQueue：上限 20/同类合并/溢出告警）
   * ③ 90 天滚动清理（MA-24，常量级：单次过滤）
   */
  async function pump() {
    const cfg = readCfg()
    // 形参 shim（D-001）：time.retryMinutes → push.retryMinutes（函数本体零改写）
    const interval = retryIntervalMs({ push: { retryMinutes: cfg?.time?.retryMinutes } })
    const store = readStore()
    const entries = store.entries ?? []
    const retentionMs = (Number(cfg?.events?.retentionDays) > 0 ? Number(cfg.events.retentionDays) : 90) * 86_400_000
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]
      if (now().getTime() - Date.parse(e.at) > retentionMs) { entries.splice(i, 1); continue }
      if (e.status !== 'retrying' && e.status !== 'queued') continue
      if (e.lastTryAt && now().getTime() - Date.parse(e.lastTryAt) < interval) continue
      const wasQueued = e.status === 'queued'
      await deliver(e, cfg, { repush: wasQueued })
      if (e.status === 'retrying' && wasQueued) e.status = 'queued'   // 补发队列条目续败仍留队列（不过期、跨天携带）
    }
    // 二次扫描：仍 retrying 且超终止线 → 统一入队（enqueueRepush 语义：上限/合并/溢出告警）
    const alerts = []
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]
      if (e.status === 'retrying' && isPastDeadline(now(), e.deadline, e.failedAt ?? e.at)) toQueue(entries, e, alerts)
    }
    store.entries = entries
    saveStore(store)
    for (const a of alerts) {
      await emit({ kind: 'alert', level: 'warn', game: a.game, noRetry: true, message: `补发队列已满（上限 ${REPUSH_QUEUE_MAX}），最早 ${a.n} 条将放弃（${a.dropped}）。通道恢复后请在面板确认。` })
    }
    return { pumped: true }
  }

  /** 事件列表（/api/events：窗口过滤 + 游标） */
  function listEvents({ since, limit = 200 } = {}) {
    const entries = readStore().entries ?? []
    const win = Number(limit) > 0 ? Number(limit) : 200
    let start = 0
    if (since) {
      const i = entries.findIndex((e) => e.id === since)
      start = i >= 0 ? i + 1 : Math.max(0, entries.length - win)   // 游标不在窗口 → 回最新窗口
    }
    const list = entries.slice(start)
    const tail = list.slice(-win)
    return { events: tail, lastId: tail.length ? tail[tail.length - 1].id : (since ?? null) }
  }

  /** 事件面状态计数（status API 附加字段） */
  function pendingCounts() {
    const entries = readStore().entries ?? []
    const c = { pending: 0, retrying: 0, queued: 0, failed: 0, sent: 0 }
    for (const e of entries) if (c[e.status] != null) c[e.status]++
    return c
  }

  /**
   * 心跳判定入口（调度器在 22:30 对账日对每个 auto 彩种调用）。
   * 返回 { verdict: 'ok'|'heartbeat'|'no-events'|'skip', red }——red=心跳红标（面板常驻兜底）。
   */
  async function heartbeatForGame(gameKey, mode, todayStr) {
    const cfg = readCfg()
    const entries = readStore().entries ?? []
    const expected = entries.filter((e) => e.game === gameKey
      && ['predict', 'result', 'apology', 'alert'].includes(e.kind)   // quickpick 显式排除（§2.2.1-3）
      && e.at.slice(0, 10) === todayStr)
    const verdict = heartbeatJudge(expected, enabledChannels(cfg).map((c) => c.type), mode)
    if (verdict === 'heartbeat') {
      await emit({
        kind: 'heartbeat', level: 'warn', game: gameKey, gameName: gameKey,
        message: `今日应有通知在全部启用渠道均无送达记录（渠道层异常）。事件队列与失败原因见面板；渠道恢复后自动补发并标注。`,
      })
      return { verdict, red: true }
    }
    return { verdict, red: false }
  }

  /** 测试事件（/api/test-push 语义：经事件层发测试事件至启用渠道，形状不变 FZ-6；kind=test 独立类别——测试不得伪装成告警，主人 2026-10-25 反馈） */
  async function testEvent() {
    const r = await emit({
      kind: 'test', level: 'info',
      message: '🐟 锦鲤测试消息：链路通了！以后开奖日的预测与战果就从这条通道发给你。',
      noRetry: true,
    })
    return { ok: r.status === 'sent', detail: r.status === 'sent' ? '已发出（全部启用渠道）✓' : `送达不完整：${r.lastErr ?? ''}（事件在面板可见）` }
  }

  return {
    emit, pump, listEvents, pendingCounts, heartbeatForGame, testEvent, deliver,
    kindDeadline_: kindDeadline,
    adaptersOf: () => adapters,
    ensureAdapters,
    enabledChannelsOf: () => enabledChannels(readCfg()).map((c) => c.type),
    fileOf: () => EVENTS_FILE,
  }
}
