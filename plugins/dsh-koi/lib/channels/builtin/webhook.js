/**
 * dsh-koi 内置通用 webhook 渠道适配器（F6，主人 2026-11-18 凌晨解禁待办池第一项：告警类事件可送达手机）。
 *
 * 形态（契约 IF-N02 同款，deploy/koi-channels/qq.js 侧车先例）：ESM default export
 *   { type, configSchema, send(event, cfg) -> {ok, word}, test(cfg) -> {ok, word} }；
 * 随 builtin/ 进市场包（面板渠道行开箱可见，channelsStatus 通用机制零特判），启用须两步：
 * 配置模板 channels 段条目 enabled:false → true（零行为出厂，petBridge 同款回退①纪律）
 * + 侧车 $DSH_HOME/koi/channels/webhook.config.json 填 url/凭证——主配置条目只存 {type,enabled}（IF-N03）。
 *
 * 投递（通用语义）：POST JSON——payload = 事件对象序列化（事件层 deliver 传入 {...ev, body} 整体
 * stringify）；响应 2xx = ok（通用接收端响应体各异，不做 JSON 语义解析）；超时 10s（回环推送通道
 * 同口径，docs/10 §5.4）。失败/不可达返回 {ok:false, word} 由事件层统一承接——FR-005 重试/终止线/
 * 补发队列/心跳恢复全部在 events.js 实现一次（D-001 事件层唯一），本适配器零自研重试。
 *
 * 鉴权（可选）：secretHeader（自定义头名）+ secret（值）成对配置 → 追加自定义请求头；走侧车
 * （凭证不进主配置，NFR-106）+ configSchema.mask 掩码回显 + secretsOf 日志/错误串擦除（自动生效）。
 * secret 只进请求头，不进 url 查询串、不进 payload——FZ-4「凭证不外泄」纪律。
 *
 * 围栏（FZ-4 语义映射，诚实声明差异）：FZ-4「端口绝不出回环」（docs/10:186）约束的是无鉴权
 * 回环推送通道（QQ 侧车适配器 / dsh-pet 桥接）——webhook 的功能本意即用户自配地址（如推送服务
 * 推手机，多为外网），回环强制反而使功能失效，故不适用 isLoopbackUrl。映射落地为：①协议限定 http(s)
 * （ftp/file 等拒发）②url 缺失/不合法/不完整鉴权对 → 返回清晰 {ok:false, word}，不抛错不崩溃
 * ③凭证只走侧车+掩码+擦除 ④10s 超时。缺配置降级：channelsStatus 探针层 no-credentials（跳过
 * test 零 HTTP）；事件层 send 失败记 delivery.lastErr 走统一重试——均不刷屏（零告警事件轰炸）。
 *
 * 红线（ADR-0007 §7 同款纪律）：①不改变心跳判定语义——webhook 启用即进 enabledChannels，自然
 * 参与 channelsAllRecovered 口径（渠道层正常语义，heartbeatJudge 判定函数零改动）；alert 类事件
 * 渠道语义按 docs/28 §9-R13 窄口径不动——本适配器零 kind 过滤，alert 照常全渠道投递（这正是
 * 「告警送达手机」的目标）。②不随市场包分发示例 url——configSchema required 无默认值，模板条目
 * 无 url 键。③桥接（dsh-pet）不走本适配器——ADR-0007 §7：桥接不进渠道目录，lib/pet-bridge.js
 * 独立旁路（本文件与 pet-bridge 无 import 关系）。
 */

const WEBHOOK_TIMEOUT_MS = 10_000

/** url 校验与归一：非空 + 可解析 + http(s)。错误词不回显 url 原文（url 常内嵌 token，面板行不泄漏）。 */
function urlOf(cfg) {
  const u = String(cfg?.url ?? '').trim()
  if (!u) return { err: 'url 未配置（请在 koi/channels/webhook.config.json 侧车填写目标地址）' }
  let parsed
  try { parsed = new URL(u) } catch { return { err: 'url 不合法（须为完整 http(s) 地址）' } }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { err: 'url 协议必须是 http(s)' }
  return { url: u }
}

/** 鉴权对组装：secretHeader/secret 成对配置 → 自定义头；成对留空 → 无头；单边配置 → 拒绝（清晰报错不静默）。 */
function authHeaders(cfg) {
  const header = String(cfg?.secretHeader ?? '').trim()
  const secret = String(cfg?.secret ?? '')
  if (!header && !secret.trim()) return {}
  if (!header || !secret.trim()) return { err: 'secretHeader 与 secret 必须成对配置（自定义鉴权头名/值），或两者都留空' }
  return { headers: { [header]: secret } }
}

/**
 * 创建适配器。opts.fetch 注入 = 测试桩（pet-bridge 同款姿势，零外联）；缺省 = 全局 fetch。
 * default export 无参实例 = loadAdapters builtin 目录发现的生产形态。
 */
export function createWebhookAdapter({ fetch: fetchInj } = {}) {
  const doFetch = fetchInj ?? ((url, init) => fetch(url, init))

  async function post(cfg, payload) {
    const u = urlOf(cfg)
    if (u.err) return { ok: false, word: u.err }
    const auth = authHeaders(cfg)
    if (auth.err) return { ok: false, word: auth.err }
    let res
    try {
      res = await doFetch(u.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(auth.headers ?? {}) },
        body: JSON.stringify(payload ?? {}),
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      })
    } catch (e) {
      const detail = e?.name === 'TimeoutError' ? `${WEBHOOK_TIMEOUT_MS}ms 超时` : String(e?.cause?.code ?? e?.message ?? e)
      return { ok: false, word: `webhook 请求失败：${detail.slice(0, 100)}` }
    }
    const ok = res.status >= 200 && res.status < 300
    return { ok, word: ok ? `webhook 已收件（HTTP ${res.status}）` : `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}` }
  }

  return {
    type: 'webhook',
    configSchema: {
      url: { type: 'string', required: true, mask: 'head3tail2' },
      secretHeader: { type: 'string', required: false, mask: false },
      secret: { type: 'string', required: false, mask: true },
    },

    /** 单事件投递：payload = 事件对象序列化（含 kind/game/issue/at/body 等全量结构化字段） */
    async send(event, cfg) {
      return post(cfg, event)
    },

    /** 渠道探针（status 渠道行 / deps / 面板「测试」按钮）：POST 轻量探针体，2xx = 可达 */
    async test(cfg) {
      return post(cfg, { probe: 'dsh-koi', kind: 'test' })
    },
  }
}

export default createWebhookAdapter()
