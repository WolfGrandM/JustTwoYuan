/**
 * M4 T6 面板测试（docs/28 §2.3 + §9-R6②，AC-034 面板面）——
 * GET /dsh-koi/api/review 只读路由（报告列表/全文 + 因子库 + 健康节 + pendingPromotions）；
 * 既有 12 路由形状逐位不变（13 = 12 + review）；fail-closed 继承（403/405）；
 * ui-logic 复盘纯函数（promoUrgency <6h 标红边界）+ client.js 复盘卡片数据源断言。
 * 独立 DSH_HOME 实例（index.js 模块路径在加载期绑定）；全部离线。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildConfigTemplate } from '../lib/config.js'
import { createReviewStore } from '../lib/review/store.js'
import { promoUrgency, promoLine, factorLine, healthLine, PROMO_RED_HOURS } from '../lib/ui-logic.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koi-review-panel-'))
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

const EXISTING_12 = [
  '/dsh-koi/api/status', '/dsh-koi/api/quickpick', '/dsh-koi/api/test-push', '/dsh-koi/api/events',
  '/dsh-koi/api/config', '/dsh-koi/api/channels/test', '/dsh-koi/api/mode', '/dsh-koi/api/backbone',
  '/dsh-koi/api/backbone/full', '/dsh-koi/api/backbone/stop', '/dsh-koi/api/ingest', '/dsh-koi/api/backtest',
]

test('T6 路由面：既有 12 路由逐位在位 + GET /api/review（M4）+ GET /api/mind（M3-T5）= 14 条；其余零新增', () => {
  for (const p of EXISTING_12) assert.ok(routes.has(p), `既有路由缺失：${p}`)
  assert.ok(routes.has('/dsh-koi/api/review'), 'M4 复盘路由在位')
  assert.ok(routes.has('/dsh-koi/api/mind'), 'M3 博弈只读路由在位（FZ-6 加法通道）')
  assert.equal(routes.size, 14, `既有 12 + review + mind = 14（实际 ${routes.size}）`)
})

test('T6 GET /api/review：只读面（报告/因子库/健康节/pendingPromotions/usageWeeks）；非回环 403；POST 405', async () => {
  const r = await call('/dsh-koi/api/review').promise
  assert.equal(r.code, 200)
  assert.equal(r.json.ok, true)
  for (const k of ['reports', 'factors', 'pendingPromotions', 'health', 'usageWeeks']) assert.ok(k in r.json, `缺字段：${k}`)
  assert.equal(r.json.factors.length, 18, '播种内置 18 件可见')
  assert.deepEqual(r.json.pendingPromotions, { pending: [], effective: [] })
  assert.ok(Array.isArray(r.json.health.items), '健康节 items（只读 scan，零事件发射）')
  const evil = await call('/dsh-koi/api/review', { host: 'evil.example.com' }).promise
  assert.equal(evil.code, 403, 'fail-closed 栅栏继承（回环限定）')
  const m = await call('/dsh-koi/api/review', { method: 'POST' }).promise
  assert.equal(m.code, 405)
})

test('T6 数据面：周报全文 + promoted 因子 → pendingPromotions pending（>6h 常档）；<6h → red（§9-R6②）', async () => {
  const store = createReviewStore({ dataDir, now: () => new Date() })
  store.recordReport('weekly', '2026-W47', '【节 1 · 战绩对照】测试周报全文', 'evt-1')
  store.applyFactorTransition('builtin-parity-ratio-ssq', 'observing', 'promoted', 'monthly-pipeline', '月检晋升（测试态）')
  store.db.close()
  let r = await call('/dsh-koi/api/review').promise
  assert.equal(r.code, 200)
  const rep = r.json.reports.find((x) => x.period === '2026-W47')
  assert.ok(rep && rep.content.includes('测试周报全文'), '报告全文透出')
  assert.equal(r.json.pendingPromotions.pending.length, 1)
  const p = r.json.pendingPromotions.pending[0]
  assert.equal(p.id, 'builtin-parity-ratio-ssq')
  assert.ok(p.hoursLeft > PROMO_RED_HOURS, `刚晋升剩余窗口 ≈24h（实际 ${p.hoursLeft.toFixed(1)}h）`)
  assert.equal(promoUrgency(r.json.pendingPromotions.pending), 'normal', '>6h → 常驻条不标红')
  // <6h：state_changed_at 回拨 20h（裸 UPDATE state_changed_at 不触发状态机触发器——status 不在 SET）
  const store2 = createReviewStore({ dataDir, now: () => new Date() })
  store2.db.prepare(`UPDATE factors SET state_changed_at=? WHERE id='builtin-parity-ratio-ssq'`)
    .run(new Date(Date.now() - 20 * 3600_000).toISOString())
  store2.db.close()
  r = await call('/dsh-koi/api/review').promise
  const p2 = r.json.pendingPromotions.pending[0]
  assert.ok(p2.hoursLeft < PROMO_RED_HOURS, `剩余 <6h（实际 ${p2.hoursLeft.toFixed(1)}h）`)
  assert.equal(promoUrgency(r.json.pendingPromotions.pending), 'red', '剩余 <6h 标红（§9-R6②）')
})

test('T6 ui-logic 复盘纯函数：promoUrgency hidden/red/normal 边界（恰 6h → normal）+ 行文案', () => {
  assert.equal(promoUrgency([]), 'hidden')
  assert.equal(promoUrgency(undefined), 'hidden')
  assert.equal(promoUrgency([{ hoursLeft: 6 }]), 'normal', '恰 6h → normal（<6h 才标红）')
  assert.equal(promoUrgency([{ hoursLeft: 5.9 }]), 'red')
  assert.equal(promoUrgency([{ hoursLeft: 24 }, { hoursLeft: 3 }]), 'red', '取最小剩余窗口')
  assert.equal(promoUrgency([{ hoursLeft: 24 }]), 'normal')
  assert.match(promoLine({ id: 'f-x', name: '奇偶比', hoursLeft: 12.34, effectiveAt: '2026-11-19T00:00:00.000Z' }), /f-x（奇偶比）· 剩余 12\.3h 否决窗口 · 生效 2026-11-19T00:00:00\.000Z/)
  assert.match(factorLine({ id: 'f-y', status: 'promoted', version: 2 }), /^↑ f-y：promoted（v2）$/)
  assert.match(healthLine({ name: '满配率', ok: null, detail: 'N/A' }), /^— 满配率：N\/A$/)
  assert.match(healthLine({ name: '未结清', ok: false, detail: '红：1 期' }), /^✗ 未结清：红：1 期$/)
})

test('T6 client.js 复盘卡片：数据源 /api/review + 待否决常驻条 + 标红 class + settings tab 挂载', () => {
  const src = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.ok(src.includes('`${API}/review`'), '卡片数据源 = GET /dsh-koi/api/review')
  assert.ok(src.includes('待否决晋升'), '顶部常驻条文案在位')
  assert.ok(src.includes('koi-promo-red'), '<6h 标红 class 在位')
  assert.ok(src.includes('ui.promoUrgency(pending)'), '档位判定走 ui-logic 权威实现（MD-21 同源）')
  assert.ok(src.includes('h(ReviewArea)'), 'settings tab 挂载复盘卡片')
  assert.ok(/展开全文|收起全文/.test(src), '报告全文展开交互在位')
  // 生成块同步守卫（gen-ui-logic）：内联副本含新导出
  assert.ok(src.includes('function promoUrgency'), '内联副本已同步 promoUrgency（勿手改块由生成器维护）')
})
