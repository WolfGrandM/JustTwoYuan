/**
 * 市场版 T4 —— 通知事件层 + 渠道适配器（FR-1001/1003/1005、BC-102、NFR-106）单测。
 * mock 适配器注入：故障→5 分钟间隔重试→超线转队列（上限 20/同类合并/溢出告警）→恢复补发带【补发】
 * —— 与 FR-005 参数集逐项等价断言；quickpick noRetry；心跳四断言（heartbeatJudge + 集成）；
 * 缺适配器清晰报错不崩溃；凭证零明文（日志/错误/正文扫描）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createEventBus, heartbeatJudge, kindDeadline } from '../lib/events.js'
import { loadAdapters, resolveChannelCfg, maskChannelCfg, maskString, channelsStatus } from '../lib/channels/index.js'
import { retryIntervalMs } from '../lib/scheduler.js'
import { readJson } from '../lib/io.js'

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'koi-evt-'))

// ── mock 适配器：可编程故障 ───────────────────────────────────────────────────
function mockAdapters({ fail = false } = {}) {
  const calls = []
  const adapter = {
    type: 'mock',
    configSchema: { token: { type: 'string', required: false, mask: true }, target: { type: 'string', required: true, mask: 'head3tail2' } },
    async send(event, cfg) {
      calls.push({ at: event.at, body: event.body })
      if (adapter.failing) return { ok: false, word: `模拟故障（token=${cfg?.token ?? '-'}）` }
      return { ok: true, word: 'ok' }
    },
    async test(cfg) { return adapter.failing ? { ok: false, word: 'mock fail' } : { ok: true, word: 'mock ok' } },
    failing: fail,
    calls,
  }
  const panel = {
    type: 'panel', configSchema: {},
    async send() { calls.push({ panel: true }); return { ok: true, word: '面板可见' } },
    async test() { return { ok: true, word: '桌宠在位' } },
  }
  return { adapters: new Map([['mock', { adapter, source: 'test' }], ['panel', { adapter: panel, source: 'builtin' }]]), mock: adapter, calls }
}

const mkBus = (opts = {}) => {
  const dir = tmpdir()
  const adapters = opts.adapters ?? mockAdapters().adapters
  const cfg = opts.cfg ?? { channels: [{ type: 'panel', enabled: true }, { type: 'mock', enabled: true }], time: { retryMinutes: 5 }, verbosity: 'concise' }
  let t = opts.t0 ?? new Date('2026-10-25T17:35:00')
  const bus = createEventBus({
    dataDir: dir,
    userChannelsDir: path.join(dir, 'channels'),
    readCfg: () => cfg,
    adapters,
    now: () => t,
    log: () => {},
    onRepushDelivered: opts.onRepushDelivered ?? (() => {}),
  })
  return { bus, dir, adapters, cfg, adaptersMock: adapters, advance: (ms) => { t = new Date(t.getTime() + ms) }, setNow: (d) => { t = d }, get now() { return t } }
}

test('FR-005 等价①：间隔语义 = retryIntervalMs 形参 shim（time.retryMinutes→push.retryMinutes，D-001）', () => {
  assert.equal(retryIntervalMs({ push: { retryMinutes: cfg_time(7) } }), 420_000)
  assert.equal(retryIntervalMs({ push: { retryMinutes: cfg_time() } }), 300_000)
  assert.equal(kindDeadline('predict', { catchUpEnd: '19:50' }), '19:50')
  assert.equal(kindDeadline('result', { settleGiveUp: '23:30' }), '23:30')
  assert.equal(kindDeadline('advice'), '12:00', 'advice → 次日 12:00 线')
  assert.equal(kindDeadline('heartbeat'), '12:00')
})
const cfg_time = (m) => m

test('FR-005 等价②：故障→按 5 分钟间隔重试→超线转补发队列→恢复补发带【补发】（逐项断言）', async () => {
  const { mock } = { mock: null }
  const dir = tmpdir()
  const ma = mockAdapters({ fail: true })
  let t = new Date('2026-10-25T17:35:00')
  const bus = createEventBus({
    dataDir: dir, readCfg: () => ({ channels: [{ type: 'mock', enabled: true }], time: { retryMinutes: 5 } }),
    adapters: ma.adapters, now: () => t, log: () => {},
  })
  // 首试失败 → retrying
  let ev = await bus.emit({ kind: 'predict', game: 'ssq', issue: '2026122', gameName: '双色球', picksLine: '红 01 02 + 蓝 03' })
  assert.equal(ev.status, 'retrying')
  assert.equal(ev.attempts, 1)
  assert.equal(ev.deadline, '19:50', '预测类终止线 catchUpEnd')
  // 间隔未到（+3 分钟）→ pump 不重试
  t = new Date(t.getTime() + 3 * 60_000)
  await bus.pump()
  assert.equal(readJson(bus.fileOf()).entries[0].attempts, 1, '间隔未到不重试')
  // 间隔到（+5 分钟）→ 重试一次仍失败
  t = new Date(t.getTime() + 2 * 60_000)
  await bus.pump()
  assert.equal(readJson(bus.fileOf()).entries[0].attempts, 2, '按 retryMinutes 间隔续试')
  // 超终止线（19:51）→ 转补发队列
  t = new Date('2026-10-25T19:51:00')
  await bus.pump()
  let entries = readJson(bus.fileOf()).entries
  assert.equal(entries[0].status, 'queued', '超 catchUpEnd 终止线转补发队列')
  // 恢复 → 补发送达，带【补发】前缀（跨过终止线的补发）
  ma.mock.failing = false
  t = new Date('2026-10-25T20:10:00')
  await bus.pump()
  entries = readJson(bus.fileOf()).entries
  assert.equal(entries[0].status, 'sent')
  assert.ok(!entries[0].body.startsWith('【补发】'), '存储的 body 本体不加前缀（前缀仅出现在补发投递正文）')
  const sentBody = ma.mock.calls[ma.mock.calls.length - 1].body
  assert.ok(sentBody.includes('【补发】'), '补发送达正文带【补发】前缀')
})

test('FR-005 等价③：补发队列上限 20 / 同类合并 / 溢出告警不静默', async () => {
  const dir = tmpdir()
  const ma = mockAdapters({ fail: true })
  let t = new Date('2026-10-25T17:35:00')
  const bus = createEventBus({
    dataDir: dir, readCfg: () => ({ channels: [{ type: 'mock', enabled: true }], time: { retryMinutes: 5 } }),
    adapters: ma.adapters, now: () => t, log: () => {},
  })
  // 直接造 21 条不同 issue 的超线 retrying 事件 → pump 转队列触发溢出
  const store = { schemaVersion: 1, entries: [] }
  for (let i = 0; i < 21; i++) {
    store.entries.push({
      id: `evt-x-${i}`, kind: 'result', game: 'p3', issue: String(26300 + i), level: 'info',
      at: '2026-10-25T22:05:00', deadline: '23:30', body: `战果 ${i}`, fullRef: null,
      status: 'retrying', delivery: [], attempts: 1, lastTryAt: '2026-10-25T22:05:00', lastErr: 'x',
    })
  }
  fs.writeFileSync(bus.fileOf(), JSON.stringify(store))
  t = new Date('2026-10-25T23:40:00')   // 过 settleGiveUp 终止线（同日）
  await bus.pump()
  const after = readJson(bus.fileOf()).entries
  const queued = after.filter((e) => e.status === 'queued')
  const dropped = after.filter((e) => e.status === 'dropped')
  const alerts = after.filter((e) => e.kind === 'alert')
  assert.equal(queued.length, 20, '上限 20')
  assert.equal(dropped.length, 1, '溢出丢最早 1 条')
  assert.equal(alerts.length, 1, '溢出告警事件不静默（B-31）')
  assert.ok(alerts[0].body.includes('补发队列已满'))
  // 同类合并：同 kind+game+issue 的新超线事件并入既有 queued 条目
  const qBefore = readJson(bus.fileOf()).entries.filter((e) => e.status === 'queued').length
  store.entries.push({ ...store.entries[5], id: 'evt-merge', body: '新战果', status: 'retrying', lastTryAt: '2026-10-26T00:05:00' })
  fs.writeFileSync(bus.fileOf(), JSON.stringify({ schemaVersion: 1, entries: store.entries.filter((e) => e.status !== 'dropped' && e.kind !== 'alert') }))
  t = new Date('2026-10-26T00:20:00')
  await bus.pump()
  const merged = readJson(bus.fileOf()).entries
  assert.equal(merged.filter((e) => e.status === 'queued').length, qBefore, '同 kind|game|issue 合并不加长')
})

test('quickpick noRetry：一次即止，失败可见于面板（FR-005 加餐例外继承）', async () => {
  const dir = tmpdir()
  const ma = mockAdapters({ fail: true })
  const bus = createEventBus({
    dataDir: dir, readCfg: () => ({ channels: [{ type: 'mock', enabled: true }], time: { retryMinutes: 5 } }),
    adapters: ma.adapters, now: () => new Date('2026-10-25T12:00:00'), log: () => {},
  })
  const ev = await bus.emit({ kind: 'quickpick', game: 'ssq', issue: '2026122', gameName: '双色球', picksLine: '红 01 + 蓝 02', flags: { quickpick: true } })
  assert.equal(ev.noRetry, true, 'quickpick noRetry 恒 true')
  assert.equal(ev.status, 'failed', '发送一次即止')
  assert.equal(ev.attempts, 1)
  await bus.pump()
  assert.equal(readJson(bus.fileOf()).entries[0].attempts, 1, 'pump 不再重试加餐')
  assert.ok(ev.body.includes('加餐 · 不记账'), '合规字段恒拼（BC-108）')
})

test('心跳四断言（heartbeatJudge 纯函数，MA-19 口径）：全败→heartbeat / manual→skip / 无事件→no-events / 桌宠送达→ok', () => {
  const ev = (delivery) => ({ delivery })
  const events = [ev([{ channel: 'panel', ok: false }, { channel: 'mock', ok: false }])]
  assert.equal(heartbeatJudge(events, ['panel', 'mock'], 'auto'), 'heartbeat', '① 有事件全渠道无送达')
  assert.equal(heartbeatJudge(events, ['panel', 'mock'], 'manual'), 'skip', '③ 手动不判定')
  assert.equal(heartbeatJudge(events, ['panel', 'mock'], 'off'), 'skip')
  assert.equal(heartbeatJudge([], ['panel'], 'auto'), 'no-events', '② 无事件不判定')
  assert.equal(heartbeatJudge([ev([{ channel: 'panel', ok: true }])], ['panel', 'mock'], 'auto'), 'ok', '④ 桌宠送达即 ok')
  assert.equal(heartbeatJudge([ev([{ channel: 'mock', ok: true }])], ['panel', 'mock'], 'auto'), 'ok', '任一渠道送达即 ok')
})

test('心跳集成：auto 对账日全渠道静默 → heartbeat 事件产生；送达后恢复补发清红标（onRepushDelivered）', async () => {
  const dir = tmpdir()
  const ma = mockAdapters({ fail: true })
  let cleared = 0
  let t = new Date('2026-10-25T17:35:00')
  const bus = createEventBus({
    dataDir: dir, readCfg: () => ({ channels: [{ type: 'mock', enabled: true }], time: { retryMinutes: 5 } }),
    adapters: ma.adapters, now: () => t, log: () => {}, onRepushDelivered: () => { cleared++ },
  })
  await bus.emit({ kind: 'predict', game: 'ssq', issue: '2026122', gameName: '双色球', picksLine: 'x' })  // 失败 → retrying
  const r = await bus.heartbeatForGame('ssq', 'auto', '2026-10-25')
  assert.deepEqual(r, { verdict: 'heartbeat', red: true }, '全渠道静默 → 心跳告警 + 红标')
  const hb = readJson(bus.fileOf()).entries.find((e) => e.kind === 'heartbeat')
  assert.ok(hb, 'heartbeat 事件已落盘')
  // 渠道恢复 → 补发送达 → 回调触发（调度器据此清 state.heartbeatRed；心跳事件本体迟到送达同样触发，
  // 调度器侧清红标幂等——此处断言至少一次恢复回调）
  t = new Date('2026-10-25T20:10:00')
  ma.mock.failing = false
  await bus.pump()
  assert.ok(cleared >= 1, `补发送达回调清红标（实际 ${cleared} 次）`)
  const r2 = await bus.heartbeatForGame('ssq', 'auto', '2026-10-25')
  assert.equal(r2.verdict, 'ok', '送达后不再判 heartbeat（当日幂等由调度器守卫）')
  // 手动模式 skip
  assert.equal((await bus.heartbeatForGame('dlt', 'manual', '2026-10-25')).verdict, 'skip')
})

test('缺适配器：清晰报错不崩溃（S-112/AC-102），其余渠道照常送达', async () => {
  const dir = tmpdir()
  const ma = mockAdapters()
  const bus = createEventBus({
    dataDir: dir,
    readCfg: () => ({ channels: [{ type: 'panel', enabled: true }, { type: 'nonexistent', enabled: true }], time: {} }),
    adapters: ma.adapters, now: () => new Date('2026-10-25T12:00:00'), log: () => {},
  })
  const ev = await bus.emit({ kind: 'predict', game: 'ssq', issue: '1', gameName: '双色球', picksLine: 'x' })
  const miss = ev.delivery.find((d) => d.channel === 'nonexistent')
  assert.equal(miss.ok, false)
  assert.match(miss.lastErr, /适配器缺失/)
  const panel = ev.delivery.find((d) => d.channel === 'panel')
  assert.equal(panel.ok, true, '其余渠道照常')
  assert.equal(ev.status, 'retrying', '部分失败进入重试')
})

test('凭证零明文：send 失败的 word 含凭证 → lastErr 擦除；maskChannelCfg/maskString 全出口（NFR-106）', async () => {
  const dir = tmpdir()
  // 侧车凭证
  const chDir = path.join(dir, 'channels')
  fs.mkdirSync(chDir, { recursive: true })
  fs.writeFileSync(path.join(chDir, 'mock.config.json'), JSON.stringify({ token: 'SECRET-TOKEN-1234', target: '1017099872' }))
  const ma = mockAdapters({ fail: true })
  let t = new Date('2026-10-25T17:35:00')
  const bus = createEventBus({
    dataDir: dir, userChannelsDir: chDir,
    readCfg: () => ({ channels: [{ type: 'mock', enabled: true }], time: { retryMinutes: 5 } }),
    adapters: ma.adapters, now: () => t, log: () => {},
  })
  const ev = await bus.emit({ kind: 'predict', game: 'ssq', issue: '1', gameName: '双色球', picksLine: 'x' })
  assert.ok(!JSON.stringify(ev).includes('SECRET-TOKEN-1234'), '事件对象零明文')
  assert.ok(!JSON.stringify(ev).includes('1017099872'), '凭证值零出现')
  assert.ok(ev.lastErr.includes('****'), '错误串已掩码：' + ev.lastErr)
  // maskChannelCfg / maskString
  const masked = maskChannelCfg({ token: 'SECRET-TOKEN-1234', target: '12345678', name: 'x' }, ma.adapters.get('mock').adapter)
  assert.equal(masked.token, 'SEC****34')
  assert.equal(masked.name, 'x')
  assert.equal(maskString('failed with SECRET-TOKEN-1234 at /send', ['SECRET-TOKEN-1234']), 'failed with SEC****34 at /send')
})

test('channelsStatus：panel ok / 缺凭证 no-credentials / 缺适配器 missing（S-112 指引文案）', async () => {
  const dir = tmpdir()
  const ma = mockAdapters()
  const st = await channelsStatus(
    [{ type: 'panel', enabled: true }, { type: 'mock', enabled: true }, { type: 'ghost', enabled: true }],
    { adapters: ma.adapters, userDir: path.join(dir, 'channels') },
  )
  assert.equal(st[0].status, 'ok')
  assert.equal(st[1].status, 'no-credentials', '侧车缺失 + target 必填 → 凭证缺失状态（不崩溃）')
  assert.match(st[1].error, /凭证缺失/)
  assert.equal(st[2].status, 'missing')
  assert.match(st[2].error, /适配器缺失/)
  assert.match(st[2].error, /停用|补入/)
  // 配上侧车后 → ok
  fs.mkdirSync(path.join(dir, 'channels'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'channels', 'mock.config.json'), JSON.stringify({ target: '12345678' }))
  const st2 = await channelsStatus([{ type: 'mock', enabled: true }], { adapters: ma.adapters, userDir: path.join(dir, 'channels') })
  assert.equal(st2[0].status, 'ok')
  assert.equal(st2[0].masked.target, '123****78', '回显掩码')
})

test('loadAdapters 双目录发现：builtin panel 加载；用户目录适配器发现；坏契约拒绝并报清晰错误（AC-102 mock 面）', async () => {
  const userDir = path.join(tmpdir(), 'channels')
  fs.mkdirSync(userDir, { recursive: true })
  // mock 私有适配器（模拟作者 qq.js 形态）
  fs.writeFileSync(path.join(userDir, 'mock-qq.js'), [
    'export default {',
    '  type: "mock-qq",',
    '  configSchema: { target: { type: "string", required: true, mask: "head3tail2" } },',
    '  async send(event, cfg) { return { ok: true, word: "sent to " + cfg.target } },',
    '  async test(cfg) { return { ok: true, word: "alive" } },',
    '}',
  ].join('\n'))
  // 坏契约（缺 send）
  fs.writeFileSync(path.join(userDir, 'broken.js'), 'export default { type: "broken" }\n')
  const { adapters, problems } = await loadAdapters(userDir)
  assert.ok(adapters.has('panel'), '内置 panel 被发现')
  assert.ok(adapters.has('mock-qq'), '用户目录适配器被发现（双目录 ∪）')
  assert.equal(problems.length, 1)
  assert.match(problems[0].error, /send/)
  // 侧车组装（IF-N03）：侧车优先、凭证只存侧车
  fs.writeFileSync(path.join(userDir, 'mock-qq.config.json'), JSON.stringify({ target: '12345678' }))
  const cfg = resolveChannelCfg({ type: 'mock-qq', enabled: true }, userDir)
  assert.equal(cfg.target, '12345678')
  assert.equal(cfg.enabled, true, '非凭证字段并入')
})

test('事件持久化与 90 天滚动清理（MA-24）：旧事件清出、队列跨重启携带（pump 从盘上读）', async () => {
  const dir = tmpdir()
  const ma = mockAdapters({ fail: true })
  let t = new Date('2026-10-25T17:35:00')
  const bus = createEventBus({
    dataDir: dir, readCfg: () => ({ channels: [{ type: 'mock', enabled: true }], time: { retryMinutes: 5 }, events: { retentionDays: 90 } }),
    adapters: ma.adapters, now: () => t, log: () => {},
  })
  await bus.emit({ kind: 'predict', game: 'ssq', issue: '1', gameName: '双色球', picksLine: 'x' })
  // 新 bus（模拟重启）：队列仍在盘上，pump 续试
  const bus2 = createEventBus({
    dataDir: dir, readCfg: () => ({ channels: [{ type: 'mock', enabled: true }], time: { retryMinutes: 5 } }),
    adapters: mockAdapters().adapters, now: () => new Date('2026-10-25T18:00:00'), log: () => {},
  })
  await bus2.pump()
  const entries = readJson(bus2.fileOf()).entries
  assert.equal(entries.length, 1)
  assert.equal(entries[0].status, 'sent', '重启后补发队列续试成功（跨重启携带）')
  // 90 天清理
  const store = readJson(bus2.fileOf())
  store.entries.push({ ...store.entries[0], id: 'evt-old', at: '2026-01-01T00:00:00.000Z', status: 'sent' })
  fs.writeFileSync(bus2.fileOf(), JSON.stringify(store))
  const bus3 = createEventBus({
    dataDir: dir, readCfg: () => ({ channels: [], time: {} }), adapters: mockAdapters().adapters,
    now: () => new Date('2026-10-25T18:05:00'), log: () => {},
  })
  await bus3.pump()
  assert.ok(!readJson(bus3.fileOf()).entries.some((e) => e.id === 'evt-old'), '90 天前事件被清理')
})

test('listEvents 游标 + 窗口；pendingCounts 状态计数（/api/events 面）', async () => {
  const { bus } = mkBus()
  await bus.emit({ kind: 'alert', message: 'a', noRetry: true })
  await bus.emit({ kind: 'alert', message: 'b', noRetry: true })
  const all = bus.listEvents({ limit: 200 })
  assert.equal(all.events.length, 2)
  await bus.emit({ kind: 'alert', message: 'c', noRetry: true })
  const rest = bus.listEvents({ since: all.lastId, limit: 200 })
  assert.equal(rest.events.length, 1, '游标之后仅新增 1 条')
  assert.ok(rest.events[0].body.includes('c'))
  const win = bus.listEvents({ limit: 1 })
  assert.equal(win.events.length, 1)
  assert.ok(win.events[0].body.includes('c'), '窗口取最新')
  const c = bus.pendingCounts()
  assert.equal(c.sent, 3)
})
