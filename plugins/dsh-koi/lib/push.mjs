/**
 * dsh-koi 推送层 —— 通过 NapCat 的 HTTP API 私聊主人。
 *
 * 为什么走 NapCat HTTP 而不是 dsh-onebot 插件：onebot 插件负责「收消息 → 起会话」，
 * 不提供主动发送；而 NapCat 本来就在本机 127.0.0.1:3000 开着 OneBot 11 HTTP API，
 * 直接 POST /send_private_msg 就行 —— 不动现有 QQ 插件一行代码 ✓
 *
 * 安全：端口只绑 127.0.0.1（容器映射时锁死了回环），且 3000 的 API 没有 token ——
 * 所以这里同样只接受回环地址，配置里写公网地址直接拒绝。
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
    const res = await fetch(base.replace(/\/$/, '') + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: ctrl.signal,
    })
    const j = await res.json().catch(() => ({}))
    return j
  } finally { clearTimeout(t) }
}

/** 私聊发一条文本。返回 {ok, retcode, status, word} */
export async function pushPrivate(base, userId, text) {
  assertLoopback(base)
  const id = Number(userId)
  if (!Number.isFinite(id) || id <= 0) throw new Error(`推送目标 QQ 号不合法：${userId}`)
  const j = await post(base, '/send_private_msg', { user_id: id, message: String(text) })
  const ok = j?.retcode === 0 || j?.status === 'ok'
  return { ok, retcode: j?.retcode, status: j?.status, word: j?.wording ?? j?.message ?? '' }
}

/** NapCat 活着吗 + 登录态是谁（deps 体检用） */
export async function napcatAlive(base) {
  assertLoopback(base)
  const j = await post(base, '/get_login_info', {})
  if (j?.retcode === 0 && j?.data?.user_id) {
    return { ok: true, qq: String(j.data.user_id), nickname: String(j.data.nickname ?? '') }
  }
  return { ok: false, word: j?.wording ?? j?.message ?? `retcode=${j?.retcode}` }
}
