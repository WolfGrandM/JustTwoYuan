/**
 * dsh-koi 桌宠桥接（ADR-0007 §2 定论 D 路线 + §6 集成深度 + §7 TF-6 红线；实施归 docs/29）。
 *
 * 形态（ADR-0007 §7 ADR 级红线）：桥接 = emit 后旁路钩子，**不注册为事件渠道适配器**——
 * 不进渠道目录、不参与送达记录与心跳判定（只认 won 的渠道进渠道目录会污染心跳语义）；
 * 渲染增强，不是通知义务承担者：事件层（events.json）与渠道适配器仍是唯一事实源与送达语义承担者。
 *
 * 通路（ADR-0007 §2 决策 2）：同实例回环 HTTP——桌宠装 koi 所在实例（服务器 web profile），
 * koi 宿主进程 `POST <base>/lock?pet=&surface=`（携带空 JSON body）取锁 → `POST <base>/broadcast?pet=&surface=&lock=` 投喂文本 →
 * `POST <base>/lock/release?pet=`（lockId 在 JSON body）短窗口释放。基址 `http://127.0.0.1:<port>/dsh-pet-7340`
 * （dsh-pet 只监听 127.0.0.1，API.md:3-8）。
 *
 * 围栏（FZ-4 语义，「端口绝不出回环」，docs/10:186）：isLoopbackUrl 仅放行 127.0.0.1/localhost/[::1]
 * 的 http(s) 基址；非回环基址调用期拒绝 + validateConfig 配置期拒绝（双层）。
 *
 * 触发（TF-6 + ADR-0007 TF-6 豁免白名单修订 v1.2 ②，主人 2026-11-18 拍板 #4，docs/31 §4.2）：
 * `kind==='result'` 且（`won===true` 或 `nearMiss` 存在）。won 仅 result 携带（lib/events.js:156；
 * emit 点 lib/scheduler.js 对账入账处）；nearMiss 仅 result 携带（'NM-1'组选命中/'NM-2'两位对，
 * judgeNearMiss 预注册判据代码产出、LLM 不可标注——生效面 p3/3d 数字型两彩种，3d 随 docs/31 §6
 * 第二批实装同构生效）。
 * ssq/dlt 及其余七类事件维持不上气泡（nearMiss 对非数字型恒不产出——judgeNearMiss 仅 p3/3d 生效，
 * docs/31 §4.1「双色球/大乐透不定义、不豁免」）；BRIDGE_FEED_KINDS 白名单常量不动（仍仅 ['result']），
 * 本次扩面 = won 判定处的显式豁免（ADR-0007 §TF-6 白名单 ②行，不得静默恢复、不得静默扩面；
 * 后续扩面仍须主人拍板改 ADR-0007 该节）。
 * 红点/未读统计口径不变：winUnreadCount 仍只认 won===true（NM 上气泡但不计未读，叙事非待办）。
 *
 * 降级（ADR-0007 §1-3）：dsh-pet 未装/未启用/端口不在/取锁失败/投喂失败——一律静默跳过并记一行日志，
 * 不重试、不抛错、不 emit 事件、不触碰事件状态机/补发队列/心跳判定；koi 简易气泡
 * （client.js koi-pet + panel 渠道）原样保留为未装时的降级显示（ADR-0007 §1-4）。
 *
 * 装件实测回填（2026-11-18，docs/29 §3.8）：dsh-pet 0.4.9 实测 API 形态（与本地 API.md 副本有差——副本滞后于上游）
 * ——①lock/broadcast 的 pet 与 surface 均在 query，surface 必填（枚举 web/desktop/both/any，API.md 副本未载）；
 * ②lock 必须携带 JSON body（空 {} 即可，缺 body 回 invalid-json）；③release 的 lockId 在 JSON body（query 不认）；
 * ④lockId 响应为顶层字段（data.lockId 两级兼容保留）。测试桩与实机同形。
 */

export const PET_BRIDGE_DEFAULTS = Object.freeze({
  enabled: false,                                        // 桥接开关默认 off（ADR-0007 §8 回退①：装件前 koi 零行为变化）
  baseUrl: 'http://127.0.0.1:3080/dsh-pet-7340',         // D 路线回环基址（端口实查回填 docs/29 §3.8；装件实测 ≠3080 只改这里一处）
  petId: 'main',                                         // pet id 缺省 main（docs/29 步骤 5；实际值装件时 /config 实查）
  surface: 'web',                                        // 渲染面（0.4.9 实测必填 query 枚举 web/desktop/both/any；服务器 headless=web）
})

/** 集成深度白名单（ADR-0007 §6：仅战果播报；扩展须主人拍板后改本常量——单点改一处） */
export const BRIDGE_FEED_KINDS = Object.freeze(['result'])

const PET_BRIDGE_TIMEOUT_MS = 10_000   // 单请求超时（10s，与既有回环推送通道超时口径一致，docs/10 §5.4）

/** FZ-4 回环判定：http(s) 且主机为 127.0.0.1 / localhost / ::1（桥接调用期与配置校验共用单点） */
export function isLoopbackUrl(u) {
  let url
  try { url = new URL(String(u ?? '')) } catch { return false }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

/** 桥接段配置读取（缺省段 = PET_BRIDGE_DEFAULTS；与 config.js 模板同源） */
export function petBridgeCfg(cfg) {
  return { ...PET_BRIDGE_DEFAULTS, ...(cfg?.petBridge && typeof cfg.petBridge === 'object' ? cfg.petBridge : {}) }
}

/** 回环 URL + 查询参数拼接（petId/lockId 均 encodeURIComponent） */
function q(base, params) {
  const qs = new URLSearchParams(params).toString()
  return `${String(base).replace(/\/+$/, '')}?${qs}`
}

/**
 * 一次 POST：2xx 视为成功；响应体尽力 JSON 解析（解不动存 text）；detail 供日志（截 120 字）。
 */
async function postJson(doFetch, url, payload) {
  let res, bodyText = ''
  try {
    res = await doFetch(url, {
      method: 'POST',
      ...(payload !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) } : {}),
      signal: AbortSignal.timeout(PET_BRIDGE_TIMEOUT_MS),
    })
  } catch (e) {
    return { ok: false, detail: String(e?.cause?.code ?? e?.message ?? e).slice(0, 120) }
  }
  try { bodyText = await res.text() } catch { /* 空响应容忍 */ }
  let json = null
  try { json = bodyText ? JSON.parse(bodyText) : null } catch { json = null }
  const ok = res.status >= 200 && res.status < 300
  return {
    ok, status: res.status, json,
    detail: ok ? '' : String(json?.error ?? json?.message ?? `HTTP ${res.status} ${bodyText.slice(0, 80)}`).slice(0, 120),
  }
}

/**
 * 创建桥接。opts = { readCfg, log, fetch }（fetch 注入=测试桩，默认全局 fetch；readCfg 同调度器现读口径——改配置即刻生效）。
 * onEvent(ev) 永不抛错、永不重试；返回 { fed, skipped? }（fed=true = 广播 2xx）。
 */
export function createPetBridge({ readCfg = () => ({}), log = () => {}, fetch: fetchInj } = {}) {
  const doFetch = fetchInj ?? ((url, init) => fetch(url, init))

  async function onEvent(ev) {
    try {
      const bc = petBridgeCfg(readCfg())
      if (bc.enabled !== true) return { fed: false, skipped: 'disabled' }                       // 三态①开关关闭：零日志零 HTTP
      if (!BRIDGE_FEED_KINDS.includes(ev?.kind) || (ev?.won !== true && ev?.nearMiss == null)) {  // TF-6 + 白名单 v1.2 ②：won 战果 或 near-miss 战果（nearMiss 仅 result 携带；红点/未读口径不变仍只认 won）
        return { fed: false, skipped: 'not-winning' }
      }
      if (!isLoopbackUrl(bc.baseUrl)) {                                                          // FZ-4：端口绝不出回环
        log('[koi] 桌宠桥接：baseUrl 非本机回环地址，拒绝投喂（FZ-4 端口围栏）——静默降级走简易气泡')
        return { fed: false, skipped: 'non-loopback' }
      }
      const base = String(bc.baseUrl).replace(/\/+$/, '')
      const pet = String(bc.petId || PET_BRIDGE_DEFAULTS.petId)
      const surface = String(bc.surface || PET_BRIDGE_DEFAULTS.surface)
      // ① 取锁（占用期桌宠全静止让路——锁纪律：取锁→投喂→释放尽量短，不注册常驻长锁，ADR-0007 §2-3；0.4.9 实测：surface 必填 query + 空 JSON body）
      const lockRes = await postJson(doFetch, q(`${base}/lock`, { pet, surface }), {})
      if (!lockRes.ok) {
        log(`[koi] 桌宠桥接：取锁失败（${lockRes.detail}；dsh-pet 未装/未启用/端口不在？）——静默降级，事件层与简易气泡不受影响`)
        return { fed: false, skipped: 'lock-failed' }
      }
      const lockId = lockRes.json?.lockId ?? lockRes.json?.data?.lockId   // 包裹层级两级兼容（docs/29 步骤 5：装件实查后如有第三级再补一条适配）
      if (!lockId) {
        log(`[koi] 桌宠桥接：取锁响应无 lockId（${JSON.stringify(lockRes.json)?.slice(0, 100)}）——静默降级`)
        return { fed: false, skipped: 'no-lock-id' }
      }
      // ② 投喂战果正文（文本 = 事件 body 渲染全文，ADR-0007 §6-1「文本=事件 body 或其摘录」）
      const bcRes = await postJson(doFetch, q(`${base}/broadcast`, { pet, surface, lock: String(lockId) }), { text: String(ev.body ?? '') })
      let bcFailed = null
      if (!bcRes.ok) {
        const cause = bcRes.json?.cause ? `/${bcRes.json.cause}` : ''
        log(`[koi] 桌宠桥接：投喂失败（${bcRes.json?.error ? `${bcRes.json.error}${cause}` : bcRes.detail}）——不重试抢占，静默降级`)
        // lock-lost（锁已被撤：过期/已释放/用户接管）→ 无锁可放，按 cause 处理不重试（API.md:33-41）；
        // 其余失败锁仍在手 → 仍走 ③ 释放，不让桌宠静止到 expiresAt
        if (bcRes.json?.error === 'lock-lost') return { fed: false, skipped: 'lock-lost' }
        bcFailed = 'broadcast-failed'
      }
      // ③ 短窗口释放锁（尽力而为：释放失败锁按 expiresAt 自然过期，无碍；0.4.9 实测：lockId 在 JSON body，query 不认）
      const relRes = await postJson(doFetch, q(`${base}/lock/release`, { pet }), { lockId: String(lockId) })
      if (!relRes.ok) log(`[koi] 桌宠桥接：释放锁失败（${relRes.detail}）——锁将按 expiresAt 自然过期`)
      if (bcFailed) return { fed: false, skipped: bcFailed }
      log(`[koi] 桌宠桥接：战果已投喂 dsh-pet（${ev.game ?? '?'} 第 ${ev.issue ?? '?'} 期）`)
      return { fed: true }
    } catch (e) {
      try { log(`[koi] 桌宠桥接：异常静默降级（${String(e?.message ?? e).slice(0, 120)}）——事件层不受影响`) } catch {}
      return { fed: false, skipped: 'error' }
    }
  }

  return {
    onEvent,
    defaultsOf: () => ({ ...PET_BRIDGE_DEFAULTS }),
    kindsOf: () => [...BRIDGE_FEED_KINDS],
  }
}
