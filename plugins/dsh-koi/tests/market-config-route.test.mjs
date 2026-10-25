/**
 * v0.2-B3 T-11 —— /api/config 单源化（ADR-0006）回归测试。
 *
 * 覆盖两件只发生在 v1 遗留配置上的行为变化：
 *   ① GET 返回换算后的 modes（auto/off/manual 与调度器实际运行态一致；FZ-6 只增字段）
 *   ② POST 校验通过后把合并结果写回（首次保存就地完成 v1→v2 迁移，schemaVersion 升到 2）
 * 以及 v2 配置的零差异（GET 不写盘、POST 只 patch 目标字段）。
 *
 * index.js 的路径在模块加载时绑定（DSH_HOME/KOI_CONFIG），故本文件在 import 前设环境变量，
 * 与 market-index.test.mjs 同款夹具，各文件独立进程互不影响。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildConfigTemplate, SCHEMA_VERSION } from '../lib/config.js'
import { defaultTierFor } from '../lib/tiers.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koi-cfgroute-'))
const configPath = path.join(dir, 'koi.config.json')
fs.mkdirSync(path.join(dir, 'koi', 'draws'), { recursive: true })

const V1 = {
  schemaVersion: 1,
  games: { ssq: { enabled: true, tier: 'red8blue1' }, dlt: { enabled: false }, p3: { enabled: true } },
  time: { predictAt: '17:30' },
  historyCount: 30,
  push: { target: '10000000000' },   // v1 遗留字段：写回时必须保留（保数据不丢）
}
fs.writeFileSync(configPath, JSON.stringify(V1, null, 2))
process.env.DSH_HOME = dir
process.env.KOI_CONFIG = configPath

const mod = await import('../lib/index.js')
const routes = new Map()
const disposers = []
const conn = { requestRejection: () => false }
mod.default.apply({
  sessionController: { create: async () => {}, prompt: async () => {} },
  webServer: { register: ({ path: p, handler }) => { routes.set(p, handler); return () => routes.delete(p) } },
  connection: conn,
  get: (k) => (k === 'connection' ? conn : undefined),
  effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d) },
})
after(() => { for (const d of disposers) try { d() } catch {} })

const call = (method = 'GET', body) => {
  const res = { code: 0, body: '' }
  res.writeHead = (c) => { res.code = c }
  res.end = (s) => { res.body = String(s ?? '') }
  const req = {
    method, url: '/dsh-koi/api/config', headers: { host: '127.0.0.1' },
    on(evt, cb) { if (evt === 'data' && body != null) cb(Buffer.from(body)); if (evt === 'end') cb() },
    destroy() {},
  }
  return Promise.resolve(routes.get('/dsh-koi/api/config')(req, res)).then(
    () => ({ code: res.code || 200, json: (() => { try { return JSON.parse(res.body) } catch { return null } })() }),
  )
}
const readFile = () => JSON.parse(fs.readFileSync(configPath, 'utf8'))
const writeFile = (o) => fs.writeFileSync(configPath, JSON.stringify(o, null, 2))

test('T-11 v1 遗留配置 GET：返回换算 modes（auto/off/auto），与调度器运行态一致', async () => {
  const r = await call()
  assert.equal(r.code, 200)
  const c = r.json.config
  assert.equal(c.modes.ssq.mode, 'auto', 'games.ssq.enabled=true → auto')
  assert.equal(c.modes.dlt.mode, 'off', 'games.dlt.enabled=false → off')
  assert.equal(c.modes.p3.mode, 'auto', 'games.p3.enabled=true → auto')
  assert.equal(c.modes.ssq.tier, defaultTierFor('ssq'), '缺省档位取该彩种默认档')
  assert.equal(r.json.configPath, configPath)
  assert.equal(readFile().modes, undefined, 'GET 不得写盘（迁移只发生在 POST）')
})

test('T-11 v1 遗留配置 POST：校验通过并就地迁移为 v2（schemaVersion 2、unknown 字段保留）', async () => {
  const r = await call('POST', JSON.stringify({ patch: { 'modes.p3.tier': 'p3-x5' } }))
  assert.equal(r.code, 200)
  assert.equal(r.json.ok, true)
  const f = readFile()
  assert.equal(f.schemaVersion, SCHEMA_VERSION, '写回时版本号升级到当前 schema')
  assert.equal(f.modes.p3.tier, 'p3-x5', 'patch 生效')
  assert.equal(f.modes.ssq.mode, 'auto', '换算结果随写回落盘')
  assert.equal(f.modes.dlt.mode, 'off')
  assert.deepEqual(f.push, V1.push, 'v1 遗留未知字段必须保留（保数据不丢）')
  assert.equal(f._说明, undefined, '运行时不引入首写模板的说明字段')
})

test('T-11 迁移后 GET：读的就是落盘 v2（不再走换算分支）', async () => {
  const r = await call()
  assert.equal(r.code, 200)
  assert.equal(r.json.config.schemaVersion, SCHEMA_VERSION)
  assert.equal(r.json.config.modes.p3.tier, 'p3-x5')
  assert.equal(r.json.config.modes.ssq.mode, 'auto')
})

test('T-11 v2 配置零差异：GET 不写盘、POST 只改 patch 目标字段', async () => {
  writeFile({ ...buildConfigTemplate(), verbosity: 'chatty' })
  const before = fs.readFileSync(configPath, 'utf8')
  const g = await call()
  assert.equal(g.code, 200)
  assert.equal(g.json.config.verbosity, 'chatty')
  assert.equal(g.json.config.modes.ssq.mode, 'manual')
  assert.equal(fs.readFileSync(configPath, 'utf8'), before, 'v2 下 GET 不得改写文件')

  const p = await call('POST', JSON.stringify({ patch: { 'budget.weeklyCap': 2_000_000 } }))
  assert.equal(p.code, 200)
  const f = readFile()
  assert.equal(f.budget.weeklyCap, 2_000_000)
  assert.equal(f.modes.ssq.tier, defaultTierFor('ssq'), '未 patch 的 modes 不受影响')
  assert.equal(f.verbosity, 'chatty', '未 patch 的顶层字段不受影响')
})

test('T-11 非法 patch 仍 400 且不落盘（v1/v2 同口径）', async () => {
  writeFile(JSON.parse(JSON.stringify(V1)))
  const before = fs.readFileSync(configPath, 'utf8')
  const r = await call('POST', JSON.stringify({ patch: { 'budget.weeklyCap': 0 } }))
  assert.equal(r.code, 400)
  assert.ok(r.json.errors.some((e) => e.includes('weeklyCap')))
  assert.equal(fs.readFileSync(configPath, 'utf8'), before, '校验失败不得写盘')
})
