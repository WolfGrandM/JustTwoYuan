/**
 * M3-T5 面板与事件（docs/33 §2.5 index/client 行 / §6.5 FZ-6 加法断言）。
 * GET /api/mind 只读路由形状 + fail-closed 栅栏继承 + orchestration_log 消费（archiveKey 过滤）+
 * client 博弈卡/提示词编辑器（FZ-7 围栏文案常驻——字符串结构断言）+ 既有路由形状逐位不动（market-index
 * 既有套件覆盖，此处零 diff 通过为合入前提）。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildConfigTemplate } from '../lib/config.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koi-mindpanel-'))
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
  const pathname = String(p).split('?')[0]   // 路由键=pathname（query 作参数面）
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
  return { promise: Promise.resolve(routes.get(pathname)(req, res)).then(done, done) }
}

test('GET /api/mind 只读路由：形状（metering/weekByRole/orchestration/agendaVersions/injection/memoryGuard）+ 零写路径语义 note', async () => {
  const r = await call('/dsh-koi/api/mind').promise
  assert.equal(r.code, 200)
  assert.equal(r.json.ok, true)
  // 形状键集（加法通道——FZ-6 既有 13 路由形状逐位不动由 market-index 既有套件零 diff 保证）
  assert.deepEqual(Object.keys(r.json).sort(), ['agendaVersions', 'injection', 'memoryGuard', 'metering', 'note', 'ok', 'orchestration', 'weekByRole'])
  assert.equal(typeof r.json.metering.mode, 'string')
  assert.ok(['path-a', 'path-b'].includes(r.json.metering.mode), '计量口径诚实披露（§2.4）')
  assert.deepEqual(r.json.orchestration, [], '空库零编排行如实')
  assert.deepEqual(r.json.agendaVersions, [])
  assert.match(r.json.note, /append-only|零写路径/)
  // memoryGuard 条件实装件如实披露（§2.2 裁决 c）
  assert.equal(r.json.memoryGuard.skipped, 'not-implemented')
})

test('GET /api/mind：orchestration_log 消费（写入后 archiveKey 过滤读回）；405/非回环 403（fail-closed 继承既有 route helper——FZ-4）', async () => {
  // 经 scheduler review.store 直写一条编排行（模拟一期编排落档）
  const store = null
  // store 经 ctx 侧 sched 取——index.js 不暴露 sched 实例；用 review.db 直开（同 DSH_HOME/koi/review.db）
  const { createReviewStore } = await import('../lib/review/store.js')
  const s = createReviewStore({ dataDir: path.join(dir, 'koi'), now: () => new Date('2026-10-25T17:31:00'), log: () => {} })
  s.recordOrchestration({ archiveKey: 'p3|26283', role: 'chair', round: 2, content: '{"picks":{"digits":[6,4,7]}}', agendaVersion: 'm3:v1:aaaaaaaa', callRef: 'p3|26283#chair-2' })
  const rAll = await call('/dsh-koi/api/mind?limit=50').promise
  assert.equal(rAll.json.orchestration.length, 1)
  assert.equal(rAll.json.orchestration[0].role, 'chair')
  assert.equal(rAll.json.orchestration[0].archiveKey, 'p3|26283')
  const rFiltered = await call('/dsh-koi/api/mind?archiveKey=p3%7C26283').promise
  assert.equal(rFiltered.json.orchestration.length, 1, 'archiveKey 过滤命中（单期全文消费面）')
  const rNone = await call('/dsh-koi/api/mind?archiveKey=ssq%7C1').promise
  assert.equal(rNone.json.orchestration.length, 0)
  // fail-closed 继承：非回环 403 / 405（FZ-4 语义不变）
  const evil = await call('/dsh-koi/api/mind', { host: 'evil.example.com' }).promise
  assert.equal(evil.code, 403)
  const post = await call('/dsh-koi/api/mind', { method: 'POST' }).promise
  assert.equal(post.code, 405, '只读路由零写方法')
})

test('client 博弈卡与提示词编辑器：MindArea 挂载 settings 卡区 + FZ-7 围栏文案常驻（字符串结构断言——client.js 为浏览器工厂，结构即行为锚）', () => {
  const src = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  // 博弈卡挂载：复盘卡旁增博弈卡（M3-T5）
  assert.ok(src.includes('function MindArea()'), 'MindArea 组件在位')
  assert.ok(src.includes('h(MindArea)'), 'settings 卡区挂载 MindArea（复盘卡旁）')
  assert.ok(src.includes('/mind`, { headers'), '数据源 GET /api/mind')
  // FZ-7 围栏文案常驻（编辑器旁——「可改角色怎么想，改不动纪律怎么算」语义）
  assert.ok(src.includes('可改角色怎么想') && src.includes('硬校验 / 随机基线 / 代码归因 / 推送契约 / 兜底标注为代码围栏锁定'), 'FZ-7 围栏声明常驻')
  // 编辑器：四个角色 textarea（只读→可编辑——client.js:482-489 接缝实施）
  assert.ok(src.includes('["dataOfficer", "strategist", "provoker", "chair"].map'), '四角色编辑框在位')
  assert.ok(!src.includes('任务提示词编辑随 M3 编排器开放'), '旧只读占位文案已退役（接缝已实施）')
  // 编辑走既有 POST /api/config 通道（patch 点路径 roles.prompts.<role>）
  assert.ok(src.includes('`roles.prompts.${rk}`'), 'patch 点路径承载（validateConfig 已放行对象——MC-17）')
  // ui-logic 行格式化导出经生成块同步（T-12 同源守卫既有套件零 diff）
  assert.ok(src.includes('mindRoleLine') && src.includes('mindOrchestrationLine') && src.includes('mindAgendaLine') && src.includes('mindInjectionLine') && src.includes('MIND_HONESTY_NOTE'), '博弈卡行格式化经生成块同步在位')
})
