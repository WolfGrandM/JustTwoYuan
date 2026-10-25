/**
 * 第二波 T2 —— /api/backbone/full + /api/backbone/stop 路由测试（docs/19 §2.5；FR-1016）。
 * confirm 缺失 400 / 锁占用 409 / 错峰 4xx（mock.timers 定时钟）/ stop 语义 / GET 进度透出。
 * 独立 DSH_HOME 实例（index.js 模块路径在加载期绑定）；全部离线，不触发真实回拉。
 */
import test, { after, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildConfigTemplate } from '../lib/config.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koi-bbapi-'))
const configPath = path.join(dir, 'koi.config.json')
const dataDir = path.join(dir, 'koi')
fs.mkdirSync(path.join(dataDir, 'draws'), { recursive: true })
for (const g of ['ssq', 'dlt', 'p3']) {
  fs.writeFileSync(path.join(dataDir, 'draws', `${g}.json`), JSON.stringify({ schemaVersion: 1, entries: [] }))
}
fs.writeFileSync(configPath, JSON.stringify(buildConfigTemplate(), null, 2))
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

const call = (p, { method = 'GET', body, host = '127.0.0.1' } = {}) => {
  const res = { code: 0, statusCode: 0, body: '' }
  res.writeHead = (c) => { res.code = c; res.statusCode = c }
  res.end = (s) => { res.body = String(s ?? '') }
  const req = {
    method, url: p, headers: { host },
    on(evt, cb) {
      if (evt === 'data' && body != null) cb(Buffer.from(body))
      if (evt === 'end') cb()
    },
    destroy() {},
  }
  const done = () => ({ code: res.code || res.statusCode || 200, json: (() => { try { return JSON.parse(res.body) } catch { return null } })() })
  return { promise: Promise.resolve(routes.get(p)(req, res)).then(done, done) }
}

test('backbone/full：confirm 缺失 → 400 拒绝（确认框契约）；非回环 403；405 语义', async () => {
  const r = await call('/dsh-koi/api/backbone/full', { method: 'POST', body: JSON.stringify({ game: 'ssq' }) }).promise
  assert.equal(r.code, 400)
  assert.ok(r.json.error.includes('confirm'), '缺 confirm:true 拒绝')
  const r0 = await call('/dsh-koi/api/backbone/full', { method: 'POST', body: JSON.stringify({ confirm: 'yes' }) }).promise
  assert.equal(r0.code, 400, 'confirm 必须严格为 true')
  const evil = await call('/dsh-koi/api/backbone/full', { method: 'POST', host: 'evil.example.com', body: JSON.stringify({ confirm: true }) }).promise
  assert.equal(evil.code, 403)
  const m = await call('/dsh-koi/api/backbone/full').promise
  assert.equal(m.code, 405)
})

test('backbone/full：作业锁被 ingest 占用 → 409 排队语义；未知彩种 400', async () => {
  fs.writeFileSync(path.join(dataDir, 'job-lock.json'), JSON.stringify({
    kind: 'ingest', key: 'ing-1', at: new Date().toISOString(), heartbeatAt: new Date().toISOString(),
  }))
  const r = await call('/dsh-koi/api/backbone/full', { method: 'POST', body: JSON.stringify({ confirm: true, game: 'ssq' }) }).promise
  assert.equal(r.code, 409)
  assert.ok(r.json.error.includes('另一后台作业进行中（ingest/ing-1）'), r.json.error)
  fs.rmSync(path.join(dataDir, 'job-lock.json'))
  const bad = await call('/dsh-koi/api/backbone/full', { method: 'POST', body: JSON.stringify({ confirm: true, game: 'ssq-x' }) }).promise
  assert.equal(bad.code, 400)
})

test('backbone/full：错峰窗口内（mock 时钟 18:00）→ 400 拒绝（零请求启动）', async () => {
  mock.timers.enable({ now: new Date('2026-10-25T18:00:00') })
  try {
    const r = await call('/dsh-koi/api/backbone/full', { method: 'POST', body: JSON.stringify({ confirm: true }) }).promise
    assert.equal(r.code, 400)
    assert.ok(r.json.error.includes('错峰窗口（17:00–22:30）'), r.json.error)
    // databackbone.json 不产生（未启动）
    assert.equal(fs.existsSync(path.join(dataDir, 'databackbone.json')), false)
  } finally {
    mock.timers.reset()
  }
})

test('backbone/stop：200 + 断点保留语义（幂等，无运行也不报错）', async () => {
  const r = await call('/dsh-koi/api/backbone/stop', { method: 'POST' }).promise
  assert.equal(r.code, 200)
  assert.equal(r.json.ok, true)
  assert.ok(r.json.note.includes('断点') || r.json.note.includes('旗标'), r.json.note)
  const r2 = await call('/dsh-koi/api/backbone/stop', { method: 'POST' }).promise
  assert.equal(r2.code, 200, '幂等')
})

test('backbone GET：第二波附加 backfill 进度字段（形状只加不改，FZ-6）', async () => {
  const r = await call('/dsh-koi/api/backbone').promise
  assert.equal(r.code, 200)
  assert.ok(r.json.backbone && typeof r.json.backbone.p3.count === 'number', '既有字段仍在')
  assert.ok(r.json.backfill && Array.isArray(r.json.backfill.running), '新增 backfill 进度')
})

test('backfill 路由集合：full/stop 注册且互不重叠（全增量，FZ-6）', () => {
  assert.equal(routes.has('/dsh-koi/api/backbone/full'), true)
  assert.equal(routes.has('/dsh-koi/api/backbone/stop'), true)
  assert.equal(routes.has('/dsh-koi/api/backbone'), true)
})
