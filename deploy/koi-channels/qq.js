/**
 * dsh-koi 私有渠道适配器：QQ（NapCat HTTP 私聊）
 *
 * 为什么单独放这里：市场版（v0.2 / 0.4.x）按 BC-103 把 push.mjs 从插件包里物理删除，
 * QQ 推送下沉为「作者私有适配器」，走渠道层双目录发现（docs/16 §8.6 / D-002 / D-005）。
 * 本文件不随市场包分发，部署时单独放到 $DSH_HOME/koi/channels/qq.js。
 *
 * 契约（lib/channels/index.js）：ESM default export
 *   { type, configSchema, send(event, cfg) -> {ok, word}, test(cfg) -> {ok, word} }
 *
 * 契约语义来源：v1.1 的 lib/push.mjs（commit cd8beca 之前），assertLoopback 的
 * FZ-4 安全不变量逐字保留 —— NapCat 3000 端口无鉴权，地址必须是本机回环。
 *
 * 凭证（不进主配置）：
 *   $DSH_HOME/koi/channels/qq.config.json
 *   { "target": "1017099872", "napcatHttp": "http://127.0.0.1:3000" }
 */
const TIMEOUT = 10_000

function assertLoopback(base) {
  let host = ''
  try { host = new URL(base).hostname } catch { throw new Error(`NapCat 地址不合法：${base}`) }
  const ok = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
  if (!ok) throw new Error(`NapCat 地址必须是本机回环（现在是 ${host}）—— 3000 端口的 API 没有鉴权，绝不能发往别处`)
}

async function post(base, path, body) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), TIMEOUT)
  try {
    const res = await fetch(String(base).replace(/\/$/, '') + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: ctrl.signal,
    })
    return await res.json().catch(() => ({}))
  } catch (e) {
    throw new Error(`NapCat 请求失败：${e?.name === 'AbortError' ? `${TIMEOUT}ms 超时` : String(e?.message ?? e)}`)
  } finally { clearTimeout(t) }
}

function targetOf(cfg) {
  const id = Number(cfg?.target)
  if (!Number.isFinite(id) || id <= 0) throw new Error(`推送目标 QQ 号不合法：${cfg?.target ?? '(未配置)'}`)
  return id
}

export default {
  type: 'qq',
  configSchema: {
    target: { type: 'string', required: true, mask: 'head3tail2' },
    napcatHttp: { type: 'string', required: true, mask: false },
  },

  /** 单事件投递：event.body 为已渲染正文（详略两档由 renderer 决定，渠道只做传输） */
  async send(event, cfg) {
    const base = cfg?.napcatHttp
    assertLoopback(base)
    const j = await post(base, '/send_private_msg', { user_id: targetOf(cfg), message: String(event?.body ?? '') })
    const ok = j?.retcode === 0 || j?.status === 'ok'
    return { ok, word: ok ? 'NapCat 已收件' : (j?.wording ?? j?.message ?? `retcode=${j?.retcode}`) }
  },

  /** 渠道探针（status / deps / 面板渠道行）：登录态在不在 */
  async test(cfg) {
    const base = cfg?.napcatHttp
    assertLoopback(base)
    const j = await post(base, '/get_login_info', {})
    if (j?.retcode === 0 && j?.data?.user_id) {
      return { ok: true, word: `在线：${j.data.nickname ?? ''}(${j.data.user_id})`.replace('()', '') }
    }
    return { ok: false, word: j?.wording ?? j?.message ?? `retcode=${j?.retcode}` }
  },
}
