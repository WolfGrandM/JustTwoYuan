/**
 * F6 通用 webhook 渠道适配器（主人 2026-11-18 待办池第一项：告警类事件可送达手机）三态单测 + 事件层集成：
 *   ①投递成功（2xx → ok，POST JSON，payload=事件对象序列化，可选自定义鉴权头）
 *   ②失败重试（500/网络异常 → ok:false → 事件层统一承接：retryMinutes 间隔续试 → 超终止线转补发队列
 *     → 恢复送达——FR-005 参数集零自研重试，全部在 events.js 实现一次）
 *   ③缺配置跳过（url 缺失 send 零 HTTP + channelsStatus no-credentials 探针零 HTTP + enabled:false
 *     事件层零投递——静默降级不刷屏）
 * 红线断言：心跳判定语义零改动（ADR-0007 §7 同款纪律——webhook 启用即参与 heartbeatJudge 渠道口径，
 * 判定函数零改动）；alert 类事件渠道语义按 docs/28 §9-R13 窄口径不动（零 kind 过滤，webhook 照常收
 * alert）；不随市场包分发示例 url（模板 webhook 条目无 url 键）；桥接 dsh-pet 不走本适配器
 * （ADR-0007 §7：桥接不进渠道目录——pet-bridge.js 与本适配器无 import 关系）。
 * 全部 HTTP 为注入桩（createWebhookAdapter({fetch: stub})），零外联。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createWebhookAdapter, default as webhookAdapter } from '../lib/channels/builtin/webhook.js'
import { loadAdapters, channelsStatus, maskChannelCfg, secretsOf, maskString, resolveChannelCfg } from '../lib/channels/index.js'
import { createEventBus, heartbeatJudge } from '../lib/events.js'
import { buildConfigTemplate, buildConfigDefaults, validateConfig } from '../lib/config.js'
import { readJson } from '../lib/io.js'

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'koi-webhook-'))

// ── webhook HTTP 桩（可编程可变；记录全部调用——零外联）──────────────────────────
function webhookStub({ status = 200, statusText = 'OK', error } = {}) {
  const calls = []
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ?? null })
    if (fn.error) throw fn.error
    return new Response(fn.status === 204 ? null : '{}', { status: fn.status, statusText: fn.statusText })
  }
  fn.calls = calls
  fn.status = status
  fn.statusText = statusText
  fn.error = error
  return fn
}

// ── 配置面与市场包红线 ──────────────────────────────────────────────────────────────
test('模板 channels 段新增 webhook 类型：出厂停用零行为 + 模板不分发示例 url（F6 红线）+ 默认配置合法', () => {
  const t = buildConfigTemplate()
  assert.deepEqual(t.channels, [{ type: 'panel', enabled: true }, { type: 'webhook', enabled: false }],
    'panel 出厂启用 + webhook 内置出厂停用（enabled:false = enabledChannels 过滤、探针 disabled 面、门控不计数）')
  const wh = t.channels.find((c) => c.type === 'webhook')
  assert.equal(wh.url, undefined, '模板 webhook 条目无 url 键（不随市场包分发示例 url 红线）')
  assert.ok(!JSON.stringify(t).includes('sctapi'), '模板全文无示例 url 服务痕迹')
  assert.deepEqual(buildConfigDefaults().channels, t.channels, '运行时默认与模板同源')
  const v = validateConfig({ ...buildConfigDefaults() })
  assert.equal(v.ok, true, '默认配置（含 webhook 停用条目）合法')
})

test('validateConfig：webhook 条目走 channels 通用校验（enabled 非布尔拒绝、缺 enabled 合法）', () => {
  const base = { ...buildConfigDefaults() }
  let v = validateConfig({ ...base, channels: [{ type: 'webhook', enabled: 'yes' }] })
  assert.equal(v.ok, false)
  assert.ok(v.errors.some((e) => e.includes('channels[0].enabled')), v.errors.join('；'))
  v = validateConfig({ ...base, channels: [{ type: 'webhook' }] })
  assert.equal(v.ok, true, '缺 enabled 视为启用口径合法（与 qq 等用户渠道同语义）')
  v = validateConfig({ ...base, channels: [{ type: 'webhook', enabled: false }] })
  assert.equal(v.ok, true)
})

test('loadAdapters：builtin 目录发现 webhook（source=builtin，契约三件套在位；发现零 HTTP）', async () => {
  const { adapters, problems } = await loadAdapters(undefined)   // 不传 userDir → 只扫 builtin
  assert.equal(problems.length, 0, problems.map((p) => `${p.file}: ${p.error}`).join('；'))
  const found = adapters.get('webhook')
  assert.ok(found, 'webhook 适配器被发现')
  assert.equal(found.source, 'builtin')
  assert.equal(found.adapter.type, 'webhook')
  assert.equal(typeof found.adapter.send, 'function')
  assert.equal(typeof found.adapter.test, 'function')
  assert.deepEqual(Object.keys(found.adapter.configSchema).sort(), ['secret', 'secretHeader', 'url'])
  assert.equal(found.adapter.configSchema.url.required, true, 'url 为必填凭证（no-credentials 探针依据）')
})

// ── 三态② 投递成功 ────────────────────────────────────────────────────────────────
test('三态②投递成功：POST JSON + payload=事件对象序列化 + 2xx=ok + word 带 HTTP 状态（fetch 桩）', async () => {
  const stub = webhookStub({ status: 204, statusText: 'No Content' })
  const ad = createWebhookAdapter({ fetch: stub })
  const ev = { id: 'evt-1', kind: 'alert', level: 'warn', game: 'ssq', issue: null, at: '2026-11-18T01:00:00.000Z', deadline: '23:30', body: '⚠️ 锦鲤告警：补发队列已满', status: 'pending', delivery: [], attempts: 1 }
  const r = await ad.send(ev, { url: 'https://example.local/hook' })
  assert.deepEqual(r, { ok: true, word: 'webhook 已收件（HTTP 204）' })
  assert.equal(stub.calls.length, 1)
  const c = stub.calls[0]
  assert.equal(c.method, 'POST')
  assert.equal(c.url, 'https://example.local/hook')
  assert.equal(c.headers['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(c.body), ev, 'payload = 事件对象整体序列化（含 kind/game/at/body 等全量结构化字段）')
})

test('鉴权头：secretHeader+secret 成对 → 自定义请求头注入（secret 只进头，不进 url/payload）', async () => {
  const stub = webhookStub()
  const ad = createWebhookAdapter({ fetch: stub })
  const r = await ad.send({ kind: 'test', body: 'x' }, { url: 'https://example.local/hook', secretHeader: 'X-Koi-Secret', secret: 's3cr3t-value' })
  assert.equal(r.ok, true)
  assert.equal(stub.calls[0].headers['X-Koi-Secret'], 's3cr3t-value')
  assert.ok(!String(stub.calls[0].url).includes('s3cr3t'), 'secret 不进 url')
  assert.ok(!String(stub.calls[0].body).includes('s3cr3t'), 'secret 不进 payload')
})

// ── 三态③ 失败与不可达 ────────────────────────────────────────────────────────────
test('三态③失败：HTTP 500 → ok:false word 带状态码（不抛错；失败承接归事件层统一重试）', async () => {
  const stub = webhookStub({ status: 500, statusText: 'Internal Server Error' })
  const ad = createWebhookAdapter({ fetch: stub })
  const r = await ad.send({ kind: 'alert', body: 'x' }, { url: 'https://example.local/hook' })
  assert.deepEqual(r, { ok: false, word: 'HTTP 500 Internal Server Error' })
})

test('三态③不可达：网络异常（ECONNREFUSED 形）→ ok:false word 带 cause code，零抛错', async () => {
  const stub = webhookStub({ error: Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }) })
  const ad = createWebhookAdapter({ fetch: stub })
  const r = await ad.send({ kind: 'alert', body: 'x' }, { url: 'https://example.local/hook' })
  assert.equal(r.ok, false)
  assert.ok(r.word.includes('ECONNREFUSED'), r.word)
})

test('围栏：协议限定 http(s)（ftp/file 拒发零 HTTP）+ url 不合法清晰报错（错误词不回显原文防 token 泄漏）', async () => {
  const stub = webhookStub()
  const ad = createWebhookAdapter({ fetch: stub })
  for (const bad of ['ftp://example.local/hook', 'file:///tmp/x', 'not a url', '']) {
    const r = await ad.send({ kind: 'alert', body: 'x' }, { url: bad })
    assert.equal(r.ok, false, String(bad))
    assert.equal(stub.calls.length, 0, `「${bad}」零 HTTP`)
    if (bad === 'not a url') assert.ok(!r.word.includes('not a url'), '错误词不内嵌 url 原文（url 常内嵌 token）')
  }
})

test('鉴权对校验：secretHeader/secret 单边配置 → ok:false 清晰报错且零 HTTP（不静默半配置）', async () => {
  const stub = webhookStub()
  const ad = createWebhookAdapter({ fetch: stub })
  const onlyHeader = await ad.send({ kind: 'alert', body: 'x' }, { url: 'https://example.local/hook', secretHeader: 'X-Koi-Secret' })
  const onlySecret = await ad.send({ kind: 'alert', body: 'x' }, { url: 'https://example.local/hook', secret: 'v' })
  for (const r of [onlyHeader, onlySecret]) {
    assert.equal(r.ok, false)
    assert.ok(r.word.includes('成对配置'), r.word)
  }
  assert.equal(stub.calls.length, 0, '半配置零 HTTP')
})

// ── 三态① 缺配置跳过 ──────────────────────────────────────────────────────────────
test('三态①缺配置跳过·send 面：url 缺失 → ok:false 指引文案 + 桩零调用（不抛错不崩溃）', async () => {
  const stub = webhookStub()
  const ad = createWebhookAdapter({ fetch: stub })
  for (const cfg of [{}, { url: '' }, undefined]) {
    const r = await ad.send({ kind: 'alert', body: 'x' }, cfg)
    assert.equal(r.ok, false)
    assert.ok(r.word.includes('url 未配置') && r.word.includes('webhook.config.json'), r.word)
  }
  assert.equal(stub.calls.length, 0, '缺配置零 HTTP')
})

test('三态①缺配置跳过·探针面：channelsStatus no-credentials（required url 缺失 → 跳过 test 零 HTTP）；有 url 停用 → disabled；启用 → 探针 2xx ok', async () => {
  const stub = webhookStub()
  const ad = createWebhookAdapter({ fetch: stub })
  const adapters = new Map([['webhook', { adapter: ad, source: 'builtin' }]])
  const rows = await channelsStatus([
    { type: 'webhook', enabled: true },                                  // 无侧车 url → no-credentials，探针零 HTTP
    { type: 'webhook', enabled: false, url: 'https://example.local/hook' },   // 有 url 停用 → disabled，零 HTTP
    { type: 'webhook', enabled: true, url: 'https://example.local/hook' },    // 启用 → 探针（POST）→ ok
  ], { adapters, userDir: tmpdir() })
  assert.equal(rows[0].status, 'no-credentials')
  assert.ok(rows[0].error.includes('url'), rows[0].error)
  assert.equal(rows[1].status, 'disabled')
  assert.equal(rows[2].status, 'ok')
  assert.equal(rows[2].detail.includes('HTTP 200'), true, rows[2].detail)
  assert.equal(stub.calls.length, 1, '仅启用渠道跑一次探针（缺配置/停用均跳过）')
  assert.equal(stub.calls[0].method, 'POST')
  assert.deepEqual(JSON.parse(stub.calls[0].body), { probe: 'dsh-koi', kind: 'test' }, '探针为轻量 probe 体')
})

test('渠道行掩码：masked 回显 url head3tail2 + secret 全掩；secretsOf 收集 url/secret 供事件层擦除（NFR-106）', async () => {
  const ad = webhookAdapter
  const cfg = resolveChannelCfg({ type: 'webhook', enabled: true, url: 'https://hooksvc.local/abc123def456', secret: 's3cr3t-value' }, tmpdir())
  const masked = maskChannelCfg(cfg, ad)
  assert.ok(masked.url.includes('****'), 'url 掩码（url 常内嵌 token）')
  assert.ok(masked.secret.includes('****'))
  assert.ok(!JSON.stringify(masked).includes('s3cr3t-value'), '掩码副本零明文 secret')
  const secrets = secretsOf(cfg, ad)
  assert.ok(secrets.includes('s3cr3t-value'))
  assert.ok(secrets.includes('https://hooksvc.local/abc123def456'), 'url 在擦除集合（错误串出现性擦除）')
  const wiped = maskString('webhook 请求失败（s3cr3t-value）', secrets)
  assert.ok(!wiped.includes('s3cr3t-value'), '错误串擦除生效')
})

// ── 事件层集成：统一重试（FR-005 零自研）+ 红线 ────────────────────────────────────
function mkBus(stub, { channels } = {}) {
  const dir = tmpdir()
  const chanDir = path.join(dir, 'channels')
  fs.mkdirSync(chanDir, { recursive: true })
  fs.writeFileSync(path.join(chanDir, 'webhook.config.json'), JSON.stringify({ url: 'https://example.local/hook' }))   // 凭证走侧车（IF-N03：resolveChannelCfg 合并）
  const ad = createWebhookAdapter({ fetch: stub })
  const panel = { type: 'panel', configSchema: {}, async send() { return { ok: true, word: '面板可见' } }, async test() { return { ok: true, word: '桌宠在位' } } }
  const adapters = new Map([['webhook', { adapter: ad, source: 'builtin' }], ['panel', { adapter: panel, source: 'builtin' }]])
  const cfg = { channels: channels ?? [{ type: 'panel', enabled: true }, { type: 'webhook', enabled: true }], time: { retryMinutes: 5, settleGiveUp: '23:30' }, verbosity: 'concise' }
  let t = new Date('2026-11-18T01:00:00')
  const bus = createEventBus({
    dataDir: dir, userChannelsDir: chanDir,
    readCfg: () => cfg, adapters, now: () => t, log: () => {},
  })
  return { bus, dir, stub, advance: (ms) => { t = new Date(t.getTime() + ms) }, setNow: (d) => { t = d } }
}

test('事件层集成·统一重试：webhook 失败 → retrying（panel sent 不受牵连单渠道隔离）→ 间隔续试 → 恢复 sent；alert 类零 kind 过滤（§9-R13 窄口径不动）', async () => {
  const stub = webhookStub({ status: 500, statusText: 'Internal Server Error' })
  const { bus, stub: st, advance } = mkBus(stub)
  // alert 类事件全渠道投递（零 kind 过滤——webhook 照常收 alert，这正是「告警送达手机」目标）
  const ev = await bus.emit({ kind: 'alert', level: 'warn', game: 'ssq', message: '补发队列已满' })
  assert.equal(ev.attempts, 1)
  assert.equal(ev.status, 'retrying', 'webhook 失败 → 统一重试语义（FR-005）')
  const d1 = ev.delivery.find((d) => d.channel === 'webhook')
  assert.equal(d1.ok, false)
  assert.ok(d1.lastErr.includes('HTTP 500'), d1.lastErr)
  const dp = ev.delivery.find((d) => d.channel === 'panel')
  assert.equal(dp.ok, true, 'panel 送达不受单渠道失败牵连（单渠道隔离）')
  assert.ok(st.calls.every((c) => JSON.parse(c.body).kind === 'alert'), 'webhook 收到的就是 alert 事件本体')
  // 间隔未到 → pump 不续试
  advance(3 * 60_000)
  await bus.pump()
  assert.equal(readJson(bus.fileOf()).entries[0].attempts, 1, 'retryMinutes 间隔未到不重试')
  // 间隔到 → 续试仍失败
  advance(2 * 60_000)
  await bus.pump()
  assert.equal(readJson(bus.fileOf()).entries[0].attempts, 2, '按 retryMinutes 间隔续试（统一语义）')
  // 恢复（桩切 2xx）→ 下一轮续试 sent
  st.status = 200
  st.statusText = 'OK'
  advance(5 * 60_000)
  await bus.pump()
  const e2 = readJson(bus.fileOf()).entries[0]
  assert.equal(e2.status, 'sent')
  assert.equal(e2.delivery.find((d) => d.channel === 'webhook').ok, true)
})

test('事件层集成·超线转补发队列：持续失败过 settleGiveUp 终止线 → queued（enqueueRepush 统一语义）→ 恢复补发', async () => {
  const stub = webhookStub({ status: 503, statusText: 'Service Unavailable' })
  const { bus, stub: st, setNow } = mkBus(stub)
  await bus.emit({ kind: 'alert', level: 'warn', game: 'p3', message: '健康告警：卡片库新鲜度超限' })
  setNow(new Date('2026-11-18T23:31:00'))
  await bus.pump()
  let entries = readJson(bus.fileOf()).entries
  assert.equal(entries[0].status, 'queued', '超 settleGiveUp 终止线转补发队列（alert 线 = settleGiveUp）')
  st.status = 200
  setNow(new Date('2026-11-19T00:10:00'))
  await bus.pump()
  entries = readJson(bus.fileOf()).entries
  assert.equal(entries[0].status, 'sent', '渠道恢复后补发送达')
  assert.ok(st.calls[st.calls.length - 1].body.includes('【补发】'), '补发正文带【补发】前缀（isPastDeadline 复用）')
})

test('红线·心跳判定语义零改动：webhook 启用即参与渠道口径（判定函数零改动，仅渠道列表扩大）', () => {
  // 渠道列表含 webhook：任一启用渠道送达 → ok；全部无送达 → heartbeat（heartbeatJudge 本体未动）
  const evs = [{ kind: 'predict', delivery: [{ channel: 'webhook', ok: true }] }]
  assert.equal(heartbeatJudge(evs, ['panel', 'webhook'], 'auto'), 'ok', 'webhook 送达 → 渠道恢复口径 ok')
  const evs2 = [{ kind: 'predict', delivery: [{ channel: 'panel', ok: true }, { channel: 'webhook', ok: false }] }]
  assert.equal(heartbeatJudge(evs2, ['panel', 'webhook'], 'auto'), 'ok', 'panel 送达仍 ok（语义与 v0.2 一致）')
  const evs3 = [{ kind: 'predict', delivery: [{ channel: 'panel', ok: false }, { channel: 'webhook', ok: false }] }]
  assert.equal(heartbeatJudge(evs3, ['panel', 'webhook'], 'auto'), 'heartbeat', '全部启用渠道（含 webhook）无送达 → 心跳告警')
  assert.equal(heartbeatJudge(evs, ['panel', 'webhook'], 'manual'), 'skip', 'manual 模式 skip 不变')
  assert.equal(heartbeatJudge([], ['panel', 'webhook'], 'auto'), 'no-events', '无事件 no-events 不变')
})

test('三态①事件层面·停用零投递：enabled:false 的 webhook 不进 enabledChannels → 零 HTTP 零失败记录（静默降级不刷屏）', async () => {
  const stub = webhookStub()
  const { bus, stub: st } = mkBus(stub, { channels: [{ type: 'panel', enabled: true }, { type: 'webhook', enabled: false }] })
  const ev = await bus.emit({ kind: 'alert', level: 'warn', game: 'ssq', message: '测试告警' })
  assert.equal(ev.status, 'sent', 'panel 送达即全量送达（webhook 停用不在投递面）')
  assert.equal(st.calls.length, 0, '停用渠道零 HTTP')
  assert.ok(!ev.delivery.some((d) => d.channel === 'webhook'), '停用渠道无投递记录（不产生失败刷屏）')
})

test('桥接红线：dsh-pet 桥接不走本适配器（pet-bridge 独立旁路，与本模块无 import 关系）', async () => {
  const src = fs.readFileSync(new URL('../lib/pet-bridge.js', import.meta.url), 'utf8')
  assert.ok(!src.includes('builtin/webhook'), 'pet-bridge 不引用 webhook 适配器（ADR-0007 §7 桥接不进渠道目录）')
  const wh = fs.readFileSync(new URL('../lib/channels/builtin/webhook.js', import.meta.url), 'utf8')
  assert.ok(!wh.includes('pet-bridge') || wh.includes('不走本适配器'), 'webhook 适配器不接桥（仅注释声明）')
  assert.ok(!wh.includes('BRIDGE_FEED_KINDS'), 'webhook 无桥接触发白名单依赖')
})
