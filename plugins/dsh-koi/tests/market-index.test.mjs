/**
 * 市场版 T7 —— lib/index.js 路由 5+2 + 首写模板 v2 + 信任栅栏测试（假 webServer/connection，全离线）。
 * D 期路由终集（MC-18）：新 5 条 events/config/channels-test/mode/backbone；改 2 条 status/test-push；
 * 不含 /api/ingest。FZ-6：status/test-push 形状不变；非回环 403；栅栏 fail-closed。
 * 注意：index.js 的路径在模块加载时绑定（DSH_HOME/KOI_CONFIG），故全文件共用一次 setup（单一实例，
 * 各测试以直接写配置文件的方式准备前置状态——与宿主「每 tick 现读」语义一致）。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildConfigTemplate, buildConfigDefaults } from '../lib/config.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function freshConfig(overrides = {}) {
  return JSON.parse(JSON.stringify({ ...buildConfigTemplate(), ...overrides }))
}

// ── 共享 setup（模块路径绑定的唯一实例）────────────────────────────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koi-idx-'))
const configPath = path.join(dir, 'koi.config.json')
const dataDir = path.join(dir, 'koi')
fs.mkdirSync(path.join(dataDir, 'draws'), { recursive: true })
// 本地库预置 30 期新鲜数据（backbone POST 走本地零网络路径）
// ⚠ 日期必须相对当天生成（TF-14）：硬编码日期会在 7 天后被 isStaleDraw 判过期，
//   ensureRecent 转走真实网络路径 → fetched≠0 → 断言失败（2026-10-29 时间炸弹实录）
const dayStr = (offset) => new Date(Date.now() - offset * 86_400_000).toLocaleDateString('sv-SE')
for (const g of ['ssq', 'dlt', 'p3']) {
  const entries = Array.from({ length: 30 }, (_, i) => g === 'ssq'
    ? { issue: String(2026121 - i), date: dayStr(i), red: [2, 7, 20, 24, 26, 30], blue: 2 }
    : g === 'dlt'
      ? { issue: String(26120 - i), date: dayStr(i), front: [1, 6, 10, 15, 32], back: [3, 4] }
      : { issue: String(26282 - i), date: dayStr(i), digits: [6, 4, 7] })
  fs.writeFileSync(path.join(dataDir, 'draws', `${g}.json`), JSON.stringify({ schemaVersion: 1, entries }))
}
process.env.DSH_HOME = dir
process.env.KOI_CONFIG = configPath

const mod = await import('../lib/index.js')
const routes = new Map()
const disposeFns = []
const conn = { requestRejection: () => false }
const ctx = {
  sessionController: { create: async () => {}, prompt: async () => {} },
  webServer: { register: ({ path: p, handler }) => { routes.set(p, handler); return () => routes.delete(p) } },
  connection: conn,
  get: (k) => (k === 'connection' ? conn : undefined),
  effect: (fn) => { const dispose = fn(); if (typeof dispose === 'function') disposeFns.push(dispose) },
}
mod.default.apply(ctx)
after(() => { for (const d of disposeFns) try { d() } catch {} })

const call = (p, { method = 'GET', body, host = '127.0.0.1', search = '' } = {}) => {
  const res = { code: 0, statusCode: 0, body: '' }
  res.writeHead = (c) => { res.code = c; res.statusCode = c }
  res.end = (s) => { res.body = String(s ?? '') }
  const req = {
    method, url: p + search, headers: { host },
    on(evt, cb) {
      if (evt === 'data' && body != null) cb(Buffer.from(body))
      if (evt === 'end') cb()
    },
    destroy() {},
  }
  const done = () => ({ code: res.code || res.statusCode || 200, json: (() => { try { return JSON.parse(res.body) } catch { return null } })() })
  return { promise: Promise.resolve(routes.get(p)(req, res)).then(done, done), res }
}
const writeCfg = (o) => fs.writeFileSync(configPath, JSON.stringify(o, null, 2))
const readCfg = () => JSON.parse(fs.readFileSync(configPath, 'utf8'))

test('首写模板 v2：apply 时落盘、零 QQ 字段（grep 断言）、schemaVersion 2', () => {
  assert.ok(fs.existsSync(configPath), '首写模板已落盘')
  const raw = fs.readFileSync(configPath, 'utf8')
  for (const banned of ['1017099872', 'napcatHttp', 'push.target', 'NapCat', '私聊']) {
    assert.ok(!raw.includes(banned), `模板不得含 ${banned}（BC-103/NFR-102）`)
  }
  const j = JSON.parse(raw)
  assert.equal(j.schemaVersion, 2)
  assert.deepEqual(j.channels, [{ type: 'panel', enabled: true }])
  assert.equal(j.modes.p3.mode, 'manual')
})

test('status：200 + FZ-6 既有字段形状 + 降级语义 + channels 加法；非回环 403', async () => {
  const r = await call('/dsh-koi/api/status').promise
  assert.equal(r.code, 200)
  const j = r.json
  assert.equal(j.ok, true)
  assert.ok(j.today && j.calendar && Array.isArray(j.allGames))
  assert.ok(j.games && j.games.p3 && typeof j.games.p3.enabledToday === 'boolean')
  assert.equal(typeof j.push.ok, 'boolean')
  assert.equal(j.push.detail, '推送已迁移至渠道层，见 channels')
  assert.equal(j.pushTargetMasked, '')
  assert.ok(j.ledgerText)
  assert.ok(Array.isArray(j.channels) && j.channels.some((c) => c.type === 'panel' && c.status === 'ok'))
  assert.ok(j.modes && j.backbone && j.costEstimate && j.tiers && j.verbosity && j.effort)
  assert.ok(j.donation && j.donation.text === '老实赚钱，很枯燥吧.jpg' && j.donation.enabled === true, 'TF-15#4：donation 展示配置透出（默认文案/启用）')
  assert.ok(j.allGames[0].drawAt, 'GAMES.drawAt 透出（向导时间校验用）')
  const r2 = await call('/dsh-koi/api/status', { host: 'evil.example.com' }).promise
  assert.equal(r2.code, 403)
  assert.ok(r2.json.error.includes('回环'))
})

test('config：GET 掩码 / POST 点路径 patch 合法写入 / 非法值 400 逐项拒绝（S-113）', async () => {
  const g = await call('/dsh-koi/api/config').promise
  assert.equal(g.code, 200)
  assert.ok(g.json.config.modes.p3.mode)
  const p = await call('/dsh-koi/api/config', { method: 'POST', body: JSON.stringify({ patch: { 'modes.p3.tier': 'p3-x5', verbosity: 'chatty' } }) }).promise
  assert.equal(p.code, 200)
  assert.equal(p.json.ok, true)
  const after = readCfg()
  assert.equal(after.modes.p3.tier, 'p3-x5', '点路径深合并不动其余 modes')
  assert.equal(after.modes.ssq.tier, 'ssq-d6b1', '兄弟键不受影响（出厂 2 元基础档）')
  assert.equal(after.verbosity, 'chatty')
  const bad = await call('/dsh-koi/api/config', { method: 'POST', body: JSON.stringify({ patch: { 'budget.weeklyCap': 0 } }) }).promise
  assert.equal(bad.code, 400)
  assert.equal(bad.json.ok, false)
  assert.ok(bad.json.errors.some((e) => e.includes('weeklyCap')))
  writeCfg(freshConfig())   // 还原默认态
})

test('events：GET 空列表 ok；test-push 形状不变语义改事件层（kind=test 独立类别，不伪装告警）', async () => {
  fs.rmSync(path.join(dataDir, 'events.json'), { force: true })
  const e = await call('/dsh-koi/api/events').promise
  assert.equal(e.code, 200)
  assert.deepEqual(e.json.events, [])
  const t = await call('/dsh-koi/api/test-push', { method: 'POST' }).promise
  assert.equal(t.code, 200)
  assert.ok(typeof t.json.ok === 'boolean' && typeof t.json.detail === 'string', 'FZ-6：{ok, detail} 形状不变')
  const e2 = await call('/dsh-koi/api/events').promise
  assert.equal(e2.json.events.length, 1, '测试事件经事件层落盘')
  assert.equal(e2.json.events[0].kind, 'test')
  assert.ok(e2.json.lastId)
})

test('channels/test：POST {index} 逐渠道测试（panel ok；越界 404）', async () => {
  const r = await call('/dsh-koi/api/channels/test', { method: 'POST', body: JSON.stringify({ index: 0 }) }).promise
  assert.equal(r.code, 200)
  assert.equal(r.json.ok, true, 'panel 内置渠道 test 恒 ok')
  const r2 = await call('/dsh-koi/api/channels/test', { method: 'POST', body: JSON.stringify({ index: 99 }) }).promise
  assert.equal(r2.code, 404)
})

test('mode：POST 门控缺失 400 + missing 数组；全满足 200 落 wizardDone（S-116）', async () => {
  writeCfg(freshConfig({ channels: [] }))   // 无渠道前置
  await sleep(50)
  const r = await call('/dsh-koi/api/mode', { method: 'POST', body: JSON.stringify({ game: 'ssq', mode: 'auto' }) }).promise
  assert.equal(r.code, 400)
  assert.ok(Array.isArray(r.json.missing) && r.json.missing.some((m) => m.key === 'channel'))
  const c = readCfg()
  c.channels = [{ type: 'panel', enabled: true }]
  writeCfg(c)
  const r2 = await call('/dsh-koi/api/mode', { method: 'POST', body: JSON.stringify({ game: 'ssq', mode: 'auto', gates: { honestyAck: true } }) }).promise
  assert.equal(r2.code, 200, JSON.stringify(r2.json))
  assert.equal(readCfg().modes.ssq.wizardDone, true)
})

test('backbone：GET 状态透出；POST 近期窗口按需拉取（本地已足 → fetched:0 零网络）；/api/ingest 已随第二波存在', async () => {
  writeCfg(freshConfig())
  const g = await call('/dsh-koi/api/backbone').promise
  assert.equal(g.code, 200)
  assert.equal(g.json.backbone.p3.count, 30)
  const p = await call('/dsh-koi/api/backbone', { method: 'POST' }).promise
  assert.equal(p.code, 200)
  assert.equal(p.json.ok, true)
  assert.deepEqual([p.json.perGame.ssq.fetched, p.json.perGame.dlt.fetched, p.json.perGame.p3.fetched], [0, 0, 0], '库足零网络（AC-115 口径）')
  // 第二波翻转（docs/19 §0.2/§8）：/api/ingest 从「不存在」→「存在且守卫」（学习半环已落地）
  assert.equal(routes.has('/dsh-koi/api/ingest'), true, '第二波：/api/ingest 存在（上传 raw body + ?name=）')
})

test('ingest 路由：415 格式拒收（?name=PDF）/ GET jobs+cards 状态面 / 非回环 403 / 405 语义', async () => {
  writeCfg(freshConfig())
  const bad = await call('/dsh-koi/api/ingest', { method: 'POST', body: '%PDF-1.4', search: '?name=book.pdf' }).promise
  assert.equal(bad.code, 415)
  assert.ok(bad.json.error.includes('支持 .txt / .md') && bad.json.error.includes('暂不支持直接解析'))
  const g = await call('/dsh-koi/api/ingest').promise
  assert.equal(g.code, 200)
  assert.equal(g.json.ok, true)
  assert.ok(Array.isArray(g.json.jobs) && Array.isArray(g.json.cards), 'jobs + cards 状态面')
  const evil = await call('/dsh-koi/api/ingest', { method: 'POST', host: 'evil.example.com', body: 'x', search: '?name=x.txt' }).promise
  assert.equal(evil.code, 403)
  const m = await call('/dsh-koi/api/ingest', { method: 'PUT' }).promise
  assert.equal(m.code, 405)
})

test('backtest 路由：GET 因子结论视图（第二波 §8；未跑 → 空结论如实）', async () => {
  const r = await call('/dsh-koi/api/backtest').promise
  assert.equal(r.code, 200)
  assert.equal(r.json.ok, true)
  assert.ok(r.json.verdicts && Array.isArray(r.json.verdicts.p3))
  assert.ok(r.json.note.includes('不改变任何自动行为'))
})

test('栅栏 fail-closed：requestRejection 返回 403 → 拒绝码透传；栅栏异常 → 503（姿势与 v1 一致）', async () => {
  conn.requestRejection = () => 403
  const r = await call('/dsh-koi/api/status').promise
  assert.equal(r.code, 403)
  assert.equal(r.json, null, '拒绝路径不产生 JSON 体（v1 姿势：statusCode + end()）')
  conn.requestRejection = () => { throw new Error('boom') }
  const r2 = await call('/dsh-koi/api/status').promise
  assert.equal(r2.code, 503)
  assert.ok(r2.json.error.includes('fail-closed'))
  conn.requestRejection = () => false
})

test('T-10 method 守卫：GET-only 收 POST → 405；POST-only 收 GET → 405；体严格 {ok:false}', async () => {
  const getOnly = ['/dsh-koi/api/events', '/dsh-koi/api/backtest']
  const postOnly = ['/dsh-koi/api/test-push', '/dsh-koi/api/channels/test', '/dsh-koi/api/mode',
    '/dsh-koi/api/backbone/full', '/dsh-koi/api/backbone/stop']
  for (const p of getOnly) {
    const r = await call(p, { method: 'POST' }).promise
    assert.equal(r.code, 405, `${p} 收到 POST 应 405`)
    assert.deepEqual(r.json, { ok: false }, `${p} 的 405 响应体形状必须与抽取前一致`)
  }
  for (const p of postOnly) {
    const r = await call(p, { method: 'GET' }).promise
    assert.equal(r.code, 405, `${p} 收到 GET 应 405`)
    assert.deepEqual(r.json, { ok: false }, `${p} 的 405 响应体形状必须与抽取前一致`)
  }
})
