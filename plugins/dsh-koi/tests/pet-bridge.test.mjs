/**
 * F5 桌宠桥接（ADR-0007 D 路线 + §6 集成深度 + §7 TF-6 红线；docs/29 执行单）三态单测 + 调度器接线：
 *   ①开关关闭（默认 off 零 HTTP 零日志）②桥接投喂（lock→broadcast→release 全序，lockId 两级包裹兼容）
 *   ③降级（未装 404 / 不可达 ECONNREFUSED / lock-lost 按 cause 不重试抢占——全部静默零抛错）
 * TF-6 + 白名单 v1.2 ②：触发 = kind==='result' 且（won===true 或 nearMiss 存在——near-miss 豁免
 * 仅限 result 携带的预注册判定产出，ssq/dlt 及其余类别维持零投喂），BRIDGE_FEED_KINDS 常量不动；
 * FZ-4：非回环 baseUrl 调用期拒绝 + validateConfig 配置期拒绝（端口绝不出回环，docs/10:186）。
 * 全部 HTTP 为注入桩（fetch stub / Response 构造），零外联；实机联调待装件后（docs/29 §3.8 记录位待填）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPetBridge, PET_BRIDGE_DEFAULTS, BRIDGE_FEED_KINDS, isLoopbackUrl, petBridgeCfg } from '../lib/pet-bridge.js'
import { buildConfigTemplate, buildConfigDefaults, validateConfig } from '../lib/config.js'
import { startKoiScheduler } from '../lib/scheduler.js'
import { winUnreadCount } from '../lib/ui-logic.js'
import { readJson } from '../lib/io.js'

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'koi-pet-'))
const jsonRes = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } })

// ── dsh-pet HTTP 桩（可编程；记录全部调用——零外联）─────────────────────────────
function petStub({ lockBody = { lockId: 'L-1', expiresAt: '2026-11-18T00:00:00Z' }, broadcastStatus = 200, broadcastBody = { ok: true }, lockError } = {}) {
  const calls = []
  const fn = async (url, init = {}) => {
    const u = String(url)
    calls.push({ url: u, method: init.method ?? 'GET', body: init.body ?? null })
    if (u.includes('/lock?') || u.endsWith('/lock')) {
      if (lockError) throw lockError
      return jsonRes(lockBody)
    }
    if (u.includes('/broadcast')) return jsonRes(broadcastBody, broadcastStatus)
    if (u.includes('/lock/release')) return jsonRes({ ok: true })
    return jsonRes({ error: 'not-found' }, 404)
  }
  fn.calls = calls
  return fn
}

const mkBridge = (cfg, stub) => {
  const logs = []
  const bridge = createPetBridge({ readCfg: () => cfg, log: (m) => logs.push(m), fetch: stub ?? petStub() })
  return { bridge, logs, stub: stub ?? petStub() }
}
const wonEvent = (over = {}) => ({ kind: 'result', won: true, game: 'p3', issue: '26283', body: '🎰【锦鲤战果 · 排列3 · 第 26283 期】\n开奖：0 4 7\n本回合计：中 1040 元', ...over })

// ── 默认值与配置面 ────────────────────────────────────────────────────────────────
test('桥接默认值：模板/运行时默认同源 enabled=false（ADR-0007 §8①装件前零行为变化）+ 白名单仅 result', () => {
  const t = buildConfigTemplate()
  assert.equal(t.petBridge.enabled, false, '桥接开关默认 off')
  assert.deepEqual({ ...t.petBridge }, { ...PET_BRIDGE_DEFAULTS })
  assert.deepEqual({ ...buildConfigDefaults().petBridge }, { ...t.petBridge }, '模板与运行时默认同源（含 _说明 差异不受影响）')
  assert.deepEqual([...BRIDGE_FEED_KINDS], ['result'], '集成深度=仅战果播报（ADR-0007 §6）')
  const v = validateConfig({ ...buildConfigDefaults() })
  assert.equal(v.ok, true, '默认配置合法')
})

test('isLoopbackUrl/petBridgeCfg：回环白名单 127.0.0.1/localhost/[::1] + http(s) 限定 + 缺段兜底', () => {
  for (const ok of ['http://127.0.0.1:3080/dsh-pet-7340', 'http://localhost:3080/dsh-pet-7340', 'http://[::1]:3080/dsh-pet-7340', 'https://127.0.0.1/dsh-pet-7340']) {
    assert.equal(isLoopbackUrl(ok), true, ok)
  }
  for (const bad of ['http://192.168.1.5:3080/dsh-pet-7340', 'http://10.0.0.9/x', 'http://example.com/dsh-pet-7340', 'ftp://127.0.0.1/x', 'not a url', '', null]) {
    assert.equal(isLoopbackUrl(bad), false, String(bad))
  }
  assert.deepEqual(petBridgeCfg({}), { ...PET_BRIDGE_DEFAULTS }, '无 petBridge 段 → 全默认')
  assert.equal(petBridgeCfg({ petBridge: { enabled: true } }).enabled, true, '用户段浅合并覆盖')
})

// ── 三态① 开关关闭 ───────────────────────────────────────────────────────────────
test('三态①开关关闭：默认 off 时 won=true 战果也零投喂（零 HTTP 零日志——ADR-0007 §8 回退①）', async () => {
  const { bridge, logs, stub } = mkBridge(buildConfigDefaults())
  const r = await bridge.onEvent(wonEvent())
  assert.deepEqual(r, { fed: false, skipped: 'disabled' })
  assert.equal(stub.calls.length, 0, '零 HTTP')
  assert.equal(logs.length, 0, '零日志（静默，非降级路径）')
})

// ── 三态② 桥接投喂 ───────────────────────────────────────────────────────────────
test('三态②桥接投喂：lock→broadcast→release 全序 + 正文=事件 body + petId/lock 实参（fetch 桩）', async () => {
  const stub = petStub()
  const { bridge, logs } = mkBridge({ ...buildConfigDefaults(), petBridge: { enabled: true, baseUrl: 'http://127.0.0.1:3080/dsh-pet-7340', petId: 'main' } }, stub)
  const ev = wonEvent()
  const r = await bridge.onEvent(ev)
  assert.deepEqual(r, { fed: true })
  const urls = stub.calls.map((c) => c.url)
  assert.equal(stub.calls.length, 3, '恰好三调用：取锁/投喂/释放')
  assert.ok(urls[0].includes('/lock?pet=main&surface=web'), `①取锁（0.4.9 实测：pet+surface 必填 query）：${urls[0]}`)
  assert.ok(urls[1].includes('/broadcast?pet=main&surface=web&lock=L-1'), `②投喂带锁：${urls[1]}`)
  assert.ok(urls[2].includes('/lock/release?pet=main'), `③释放（lockId 移 body）：${urls[2]}`)
  for (const c of stub.calls) assert.equal(c.method, 'POST', '全 POST（API.md 二、三节）')
  assert.deepEqual(JSON.parse(stub.calls[0].body), {}, 'lock 必须携带 JSON body（0.4.9 实测：缺 body 回 invalid-json）')
  assert.deepEqual(JSON.parse(stub.calls[1].body), { text: ev.body }, '文本=事件 body 渲染全文（ADR-0007 §6-1）')
  assert.deepEqual(JSON.parse(stub.calls[2].body), { lockId: 'L-1' }, 'release 的 lockId 在 JSON body（0.4.9 实测：query 不认）')
  assert.ok(logs.some((m) => m.includes('战果已投喂 dsh-pet')), '成功记一行日志')
})

test('桥接投喂·包裹层级兼容：data.lockId 两级包裹同样成链（docs/29 步骤 5 双路径实查兼容）', async () => {
  const stub = petStub({ lockBody: { data: { lockId: 'L-2' } } })
  const { bridge } = mkBridge({ ...buildConfigDefaults(), petBridge: { enabled: true } }, stub)
  const r = await bridge.onEvent(wonEvent())
  assert.equal(r.fed, true)
  assert.ok(stub.calls[1].url.includes('lock=L-2'), 'broadcast 用解出的 data.lockId')
  assert.equal(JSON.parse(stub.calls[2].body).lockId, 'L-2', 'release 用同一锁（lockId 在 body）')
})

test('桥接投喂·锁纪律：baseUrl 尾斜杠归一 + 自定义 petId 逐段实参', async () => {
  const stub = petStub()
  const { bridge } = mkBridge({ ...buildConfigDefaults(), petBridge: { enabled: true, baseUrl: 'http://127.0.0.1:3080/dsh-pet-7340/', petId: 'koi-pet' } }, stub)
  await bridge.onEvent(wonEvent())
  assert.ok(stub.calls[0].url.startsWith('http://127.0.0.1:3080/dsh-pet-7340/lock?'), '尾斜杠不重复')
  assert.ok(stub.calls[1].url.includes('pet=koi-pet'), 'petId 逐段透传')
})

// ── 三态③ 降级 ───────────────────────────────────────────────────────────────────
test('三态③降级·不可达：取锁网络异常（ECONNREFUSED 形）静默零抛错 + 不重试 + 一行日志', async () => {
  const stub = petStub({ lockError: Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }) })
  const { bridge, logs } = mkBridge({ ...buildConfigDefaults(), petBridge: { enabled: true } }, stub)
  const r = await bridge.onEvent(wonEvent())
  assert.deepEqual(r, { fed: false, skipped: 'lock-failed' })
  assert.equal(stub.calls.length, 1, '取锁失败即止：零重试零后续调用')
  assert.equal(logs.length, 1, '一行日志（零报错刷屏）')
  assert.ok(logs[0].includes('静默降级'), logs[0])
})

test('三态③降级·未装：路由不在（404）静默降级走简易气泡（ADR-0007 §1-3）', async () => {
  const calls = []
  const stub = async (url, init = {}) => { calls.push(String(url)); return jsonRes({ error: 'not-found' }, 404) }
  const { bridge, logs } = mkBridge({ ...buildConfigDefaults(), petBridge: { enabled: true } }, stub)
  const r = await bridge.onEvent(wonEvent())
  assert.deepEqual(r, { fed: false, skipped: 'lock-failed' })
  assert.equal(calls.length, 1)
  assert.equal(logs.length, 1)
  assert.ok(logs[0].includes('dsh-pet 未装'), logs[0])
})

test('三态③降级·lock-lost：按 cause 处理不重试抢占（ADR-0007 §2-3；API.md lock-lost 语义）', async () => {
  const stub = petStub({ broadcastStatus: 409, broadcastBody: { error: 'lock-lost', cause: 'user-takeover' } })
  const { bridge, logs } = mkBridge({ ...buildConfigDefaults(), petBridge: { enabled: true } }, stub)
  const r = await bridge.onEvent(wonEvent())
  assert.deepEqual(r, { fed: false, skipped: 'lock-lost' })
  assert.equal(stub.calls.length, 2, '取锁+投喂即止：不重试、不释放（锁已被撤）')
  assert.equal(logs.length, 1)
  assert.ok(logs[0].includes('lock-lost') && logs[0].includes('user-takeover'), logs[0])
})

test('三态③降级·投喂 5xx：静默降级零抛错 + 锁仍在手仍释放（不让桌宠静止到 expiresAt；ADR-0007 §2-3 锁纪律）', async () => {
  const stub = petStub({ broadcastStatus: 500, broadcastBody: { error: 'boom' } })
  const { bridge, logs } = mkBridge({ ...buildConfigDefaults(), petBridge: { enabled: true } }, stub)
  const r = await bridge.onEvent(wonEvent())
  assert.deepEqual(r, { fed: false, skipped: 'broadcast-failed' })
  assert.ok(stub.calls[2].url.includes('/lock/release'), '投喂失败仍释放锁（短窗口占用）')
  assert.equal(logs.length, 1)
})

// ── TF-6 口径 ─────────────────────────────────────────────────────────────────────
test('TF-6 口径：仅 kind=result 且 won=true 上桌宠气泡；其余七类与未中奖战果零投喂（ADR-0007 §7）', async () => {
  const stub = petStub()
  const { bridge } = mkBridge({ ...buildConfigDefaults(), petBridge: { enabled: true } }, stub)
  const cases = [
    [{ kind: 'predict', won: null, body: '预测正文' }, 'not-winning'],
    [{ kind: 'quickpick', won: null, body: '加餐正文' }, 'not-winning'],
    [{ kind: 'apology', won: null, body: '致歉' }, 'not-winning'],
    [{ kind: 'alert', won: null, body: '告警' }, 'not-winning'],
    [{ kind: 'advice', won: null, body: '建议' }, 'not-winning'],
    [{ kind: 'heartbeat', won: null, body: '心跳' }, 'not-winning'],
    [{ kind: 'test', won: null, body: '测试' }, 'not-winning'],
    [{ kind: 'review', won: null, body: '周报（TF-6 panelOnly）' }, 'not-winning'],
    [wonEvent({ won: false, body: '未中奖战果' }), 'not-winning'],
    [wonEvent({ won: null, body: '缺 won 标记' }), 'not-winning'],
  ]
  for (const [ev, skip] of cases) assert.deepEqual(await bridge.onEvent(ev), { fed: false, skipped: skip }, ev.kind)
  assert.equal(stub.calls.length, 0, '全部零 HTTP')
  const fed = await bridge.onEvent(wonEvent())
  assert.deepEqual(fed, { fed: true }, '唯一放行：won=true 战果')
  assert.equal(stub.calls.length, 3)
})

// ── TF-6 豁免白名单 v1.2 ②（主人 2026-11-18 拍板 #4，docs/31 §4.2）：near-miss 战果上气泡 ──
const nmEvent = (over = {}) => wonEvent({
  won: false, nearMiss: 'NM-1',
  body: '🎰【锦鲤战果 · 排列三 · 第 26283 期】\n本回合计：中 0 元\n气死气死！我们押的 607，开奖 067——三个数字一个不差，顺序全拧了！直选没奖，账本老老实实记 0 元。',
  ...over,
})

test('白名单 v1.2 ②：won=false 未中奖战果带 nearMiss → 投喂气泡，broadcast text 含 §4.3 文案特征', async () => {
  const stub = petStub()
  const { bridge } = mkBridge({ ...buildConfigDefaults(), petBridge: { enabled: true } }, stub)
  const ev = nmEvent()
  assert.deepEqual(await bridge.onEvent(ev), { fed: true }, 'nearMiss 存在即放行（won=false 不再一票否决）')
  assert.equal(stub.calls.length, 3, 'lock→broadcast→release 全序不变')
  const fedText = JSON.parse(stub.calls[1].body).text
  assert.equal(fedText, ev.body, '文本=事件 body 渲染全文（ADR-0007 §6-1）')
  assert.ok(fedText.includes('三个数字一个不差，顺序全拧了'), '§4.3 NM-1 特征：事实+人设情绪')
  assert.ok(fedText.includes('账本老老实实记 0 元'), '§4.3 特征：账本如实记 0（诚实）')
  for (const banned of ['差一点就是', '好运在积累', '下次稳了']) assert.ok(!fedText.includes(banned), `禁止诱导框架零命中：${banned}`)
  const stub2 = petStub()
  const { bridge: b2 } = mkBridge({ ...buildConfigDefaults(), petBridge: { enabled: true } }, stub2)
  const ev2 = nmEvent({ nearMiss: 'NM-2', body: '🎰【锦鲤战果 · 排列三 · 第 26283 期】\n047 对 067，两位都对就差一位……气人！不过直选就是直选，账本记 0，锦鲤不找借口。' })
  assert.deepEqual(await b2.onEvent(ev2), { fed: true }, 'NM-2 同样放行（两档都播报，拍板 #3）')
  assert.ok(JSON.parse(stub2.calls[1].body).text.includes('两位都对就差一位'), '§4.3 NM-2 特征')
})

test('白名单 v1.2 ②边界：非数字型未中奖与其余 kind 不豁免——nearMiss 恒不产出/kind 门不变', async () => {
  const stub = petStub()
  const { bridge } = mkBridge({ ...buildConfigDefaults(), petBridge: { enabled: true } }, stub)
  const cases = [
    [{ kind: 'result', won: false, game: 'ssq', body: 'ssq 未中奖战果' }, 'not-winning'],   // judgeNearMiss 对 ssq 恒 null → 事件无 nearMiss（①非数字型返回 null）
    [{ kind: 'result', won: false, game: 'dlt', body: 'dlt 未中奖战果' }, 'not-winning'],
    [{ kind: 'result', won: null, game: 'p3', body: 'won 缺失且无 nearMiss' }, 'not-winning'],
    [{ kind: 'predict', won: null, nearMiss: 'NM-1', body: '预测事件' }, 'not-winning'],    // kind 门不变：白名单仍仅 result
    [{ kind: 'quickpick', won: null, nearMiss: 'NM-1', body: '加餐' }, 'not-winning'],
  ]
  for (const [ev, skip] of cases) assert.deepEqual(await bridge.onEvent(ev), { fed: false, skipped: skip }, ev.game ?? ev.kind)
  assert.equal(stub.calls.length, 0, '全部零 HTTP')
})

test('白名单 v1.2 ②：ssq/dlt 维持唯一 won===true 不豁免；BRIDGE_FEED_KINDS 白名单常量不动（仍仅 result）', async () => {
  assert.deepEqual([...BRIDGE_FEED_KINDS], ['result'], '扩面在 won 判定处（nearMiss 显式豁免），kind 白名单常量不动（ADR-0007 v1.2）')
  const stub = petStub()
  const { bridge } = mkBridge({ ...buildConfigDefaults(), petBridge: { enabled: true } }, stub)
  assert.deepEqual(await bridge.onEvent(wonEvent({ game: 'ssq', body: 'ssq 中奖战果' })), { fed: true }, 'ssq won=true 照常投喂（原路径不变）')
  assert.equal(stub.calls.length, 3)
  assert.deepEqual(await bridge.onEvent(wonEvent({ game: 'ssq', won: false, body: 'ssq 未中奖' })), { fed: false, skipped: 'not-winning' }, 'ssq 未中奖不上气泡')
  assert.deepEqual(await bridge.onEvent(wonEvent({ game: 'dlt', won: false, body: 'dlt 未中奖' })), { fed: false, skipped: 'not-winning' }, 'dlt 未中奖不上气泡')
  assert.equal(stub.calls.length, 3, '未中奖两例零新增 HTTP')
})

test('白名单 v1.2 ②·3d：福彩3D near-miss 战果上气泡（docs/31 §6 第二批：judgeNearMiss 生效门扩 p3/3d → 谓词对 3d 自动覆盖，零改触发代码）', async () => {
  const stub = petStub()
  const { bridge } = mkBridge({ ...buildConfigDefaults(), petBridge: { enabled: true } }, stub)
  const ev = nmEvent({
    game: '3d', issue: '2026322',
    body: '🎰【锦鲤战果 · 福彩3D · 第 2026322 期】\n本回合计：中 0 元\n气死气死！我们押的 607，开奖 067——三个数字一个不差，顺序全拧了！直选没奖，账本老老实实记 0 元。',
  })
  assert.deepEqual(await bridge.onEvent(ev), { fed: true }, '3d NM-1 放行（won=false + nearMiss 存在，game 无关白名单门）')
  assert.equal(stub.calls.length, 3, 'lock→broadcast→release 全序不变')
  const fedText = JSON.parse(stub.calls[1].body).text
  assert.ok(fedText.includes('福彩3D'), 'gameName=福彩3D 进气泡文本')
  assert.ok(fedText.includes('三个数字一个不差，顺序全拧了'), '§4.3 NM-1 特征')
  const stub2 = petStub()
  const { bridge: b2 } = mkBridge({ ...buildConfigDefaults(), petBridge: { enabled: true } }, stub2)
  const ev2 = nmEvent({ game: '3d', won: true, body: '🎰【锦鲤战果 · 福彩3D · 第 2026322 期】\n本回合计：中 1040 元' })
  assert.deepEqual(await b2.onEvent(ev2), { fed: true }, '3d won=true 战果走原路径（①行全彩种不变）')
})

test('白名单 v1.2 ②联动：红点/未读口径不受影响——winUnreadCount 只认 won===true，NM 事件不计未读（叙事非待办）', () => {
  const evs = [
    { id: 'e1', kind: 'predict', won: null },
    { id: 'e2', kind: 'result', won: false, nearMiss: 'NM-1', body: 'NM 叙事' },   // 上气泡但不计未读
    { id: 'e3', kind: 'result', won: false, nearMiss: 'NM-2', body: 'NM 叙事2' },
    { id: 'e4', kind: 'result', won: true, body: '中奖战果' },
  ]
  assert.equal(winUnreadCount(evs, null), 1, '只数 won===true（NM 两条均不计）')
  assert.equal(winUnreadCount(evs, 'e2'), 1, '游标后仍只数 won===true')
  assert.equal(winUnreadCount([{ id: 'x', kind: 'result', won: false, nearMiss: 'NM-1' }], null), 0, '纯 NM 轮红点为零')
})

// ── FZ-4 围栏（调用期 + 配置期双层）───────────────────────────────────────────────
test('FZ-4 围栏：非回环 baseUrl 调用期拒绝（零 HTTP）+ validateConfig 配置期拒绝/放行（docs/10:186）', async () => {
  const stub = petStub()
  const { bridge, logs } = mkBridge({ ...buildConfigDefaults(), petBridge: { enabled: true, baseUrl: 'http://192.168.1.5:3080/dsh-pet-7340' } }, stub)
  const r = await bridge.onEvent(wonEvent())
  assert.deepEqual(r, { fed: false, skipped: 'non-loopback' })
  assert.equal(stub.calls.length, 0, '非回环零 HTTP')
  assert.equal(logs.length, 1)

  const base = buildConfigDefaults()
  const bad1 = validateConfig({ ...base, petBridge: { enabled: true, baseUrl: 'http://10.0.0.9/dsh-pet-7340' } })
  assert.equal(bad1.ok, false)
  assert.ok(bad1.errors.some((e) => e.includes('petBridge.baseUrl') && e.includes('回环')), bad1.errors.join('；'))
  const bad2 = validateConfig({ ...base, petBridge: { enabled: 'yes' } })
  assert.equal(bad2.ok, false)
  assert.ok(bad2.errors.some((e) => e.includes('petBridge.enabled')), bad2.errors.join('；'))
  const bad3 = validateConfig({ ...base, petBridge: { petId: '' } })
  assert.equal(bad3.ok, false)
  assert.ok(bad3.errors.some((e) => e.includes('petBridge.petId')), bad3.errors.join('；'))
  const ok1 = validateConfig({ ...base, petBridge: { enabled: true, baseUrl: 'http://127.0.0.1:3080/dsh-pet-7340', petId: 'main' } })
  assert.deepEqual(ok1, { ok: true, errors: [] }, '合法回环段放行')
})

// ── 调度器接线（emit 后旁路钩子；ADR-0007 §7）────────────────────────────────────
const P3_WIN_26283 = { issue: '26283', date: '2026-10-25', digits: [0, 4, 7], prizeGrades: { 1: 1040 } }

function mkHarness({ cfgPatch = {}, now = new Date('2026-10-25T17:35:00'), petFetch, latestDraw = P3_WIN_26283, picks: picksOverride = null } = {}) {
  const dir = tmpdir()
  const configPath = path.join(dir, 'koi.config.json')
  const dataDir = path.join(dir, 'koi')
  const workDir = path.join(dir, 'koi-work')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify({ schemaVersion: 2, ...buildConfigDefaults(), ...cfgPatch }))
  let t = now
  const ctx = {
    sessionController: {
      create: async () => {},
      prompt: async (req) => {
        const m = req.content[0].text.match(/predict-[\w.-]+\.json/)
        if (!m) return
        fs.writeFileSync(path.join(workDir, m[0]), JSON.stringify({
          schemaVersion: 1, issue: '0',
          picks: picksOverride ?? { digits: [0, 4, 7] },   // p3-x1 直选单式（units=1 扁平三元组）：与 P3_WIN_26283 逐位命中 → won=true
          message: '本锦鲤今天研究心得：就这组！', summary: '一句话摘要。',
        }))
      },
    },
  }
  const fetchDraws = {
    async fetchHistory(game, count) {
      const n = Math.min(count, 30)
      return Array.from({ length: n }, (_, i) => ({ issue: String(26282 - i), date: new Date(Date.parse('2026-10-23') - i * 86_400_000).toLocaleDateString('sv-SE'), digits: [(i + 1) % 10, 4, 7] }))
    },
    async fetchLatestDraw() { return latestDraw },
  }
  const sched = startKoiScheduler(ctx, {
    dshHome: dir, configPath, dataDir, workDir, log: () => {},
    now: () => t, fetch: fetchDraws, petFetch,
  })
  return {
    sched, dir, configPath, dataDir,
    setNow: (d) => { t = d },
  }
}
const waitPreds = async (h, n, ms = 8000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const p = readJson(path.join(h.dataDir, 'predictions.json'), { entries: [] })
    if ((p.entries ?? []).length >= n) return p
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('predictions 超时')
}

test('调度器接线·开：won=true 战果对账 → emit 后旁路投喂全序（lock→broadcast→release），事件层形状零改动', async () => {
  const pet = petStub()
  const h = mkHarness({
    petFetch: pet,
    cfgPatch: {
      advisory: { enabled: false },
      petBridge: { enabled: true, baseUrl: 'http://127.0.0.1:3080/dsh-pet-7340', petId: 'main' },
      modes: { ssq: { mode: 'off' }, dlt: { mode: 'off' }, p3: { mode: 'auto', tier: 'p3-x1', predictAt: '17:30', gates: { honestyAck: true } } },
    },
  })
  try {
    await h.sched.tick()
    await waitPreds(h, 1)
    h.setNow(new Date('2026-10-25T22:05:00'))
    await h.sched.tick()   // settleOne → emitNotify → 旁路钩子 await 完成（settleOne 在 tick 内 await，接线确定性）
    const preds = readJson(path.join(h.dataDir, 'predictions.json'))
    const e = preds.entries.find((x) => x.kind === 'daily')
    assert.equal(e.prize, 1040, '直选命中 → won=true 前置成立')
    assert.equal(pet.calls.length, 3, '桥接三调用')
    assert.ok(pet.calls[0].url.includes('/lock?pet=main&surface=web'))
    assert.ok(pet.calls[1].url.includes('/broadcast?pet=main&surface=web&lock=L-1'))
    assert.ok(JSON.parse(pet.calls[1].body).text.includes('锦鲤战果'), '投喂文本=战果事件 body')
    assert.ok(pet.calls[2].url.includes('/lock/release'))
    // 事件层形状零改动（ADR-0007 §1-3：桥接不写 delivery/不改状态机）
    const evs = readJson(path.join(h.dataDir, 'events.json'), { entries: [] }).entries
    const result = evs.find((x) => x.kind === 'result')
    assert.ok(result && result.won === true)
    assert.deepEqual(result.delivery.map((d) => d.channel), ['panel'], 'delivery 仍是渠道适配器专属（桥接不在其中——ADR-0007 §7 不进渠道目录）')
    assert.equal(result.status, 'sent')
    assert.equal(readJson(path.join(h.dataDir, 'state.json')).games.p3.phase, 'settled', 'FZ-5 相位机不受桥接影响')
  } finally { h.sched.stop() }
})

test('调度器接线·关：默认 off 对账零桥接调用（装件前 koi 零行为变化）；开但未中奖战果零投喂（TF-6 接线面）', async () => {
  // ① 默认关闭：战果事件照发，桥接零调用
  const petOff = petStub()
  const h1 = mkHarness({
    petFetch: petOff,
    cfgPatch: {
      advisory: { enabled: false },
      modes: { ssq: { mode: 'off' }, dlt: { mode: 'off' }, p3: { mode: 'auto', tier: 'p3-x1', predictAt: '17:30', gates: { honestyAck: true } } },
    },
  })
  try {
    await h1.sched.tick()
    await waitPreds(h1, 1)
    h1.setNow(new Date('2026-10-25T22:05:00'))
    await h1.sched.tick()
    const evs = readJson(path.join(h1.dataDir, 'events.json'), { entries: [] }).entries
    assert.ok(evs.some((x) => x.kind === 'result' && x.won === true), '事件层照常')
    assert.equal(petOff.calls.length, 0, '默认 off：桥接零 HTTP')
  } finally { h1.sched.stop() }
  // ② 桥接开但开奖号与预测不命中（won=false）→ 零投喂
  const petNoWin = petStub()
  const h2 = mkHarness({
    petFetch: petNoWin,
    latestDraw: { issue: '26283', date: '2026-10-25', digits: [9, 9, 9], prizeGrades: { 1: 1040 } },
    cfgPatch: {
      advisory: { enabled: false },
      petBridge: { enabled: true, baseUrl: 'http://127.0.0.1:3080/dsh-pet-7340', petId: 'main' },
      modes: { ssq: { mode: 'off' }, dlt: { mode: 'off' }, p3: { mode: 'auto', tier: 'p3-x1', predictAt: '17:30', gates: { honestyAck: true } } },
    },
  })
  try {
    await h2.sched.tick()
    await waitPreds(h2, 1)
    h2.setNow(new Date('2026-10-25T22:05:00'))
    await h2.sched.tick()
    const evs2 = readJson(path.join(h2.dataDir, 'events.json'), { entries: [] }).entries
    const result2 = evs2.find((x) => x.kind === 'result')
    assert.ok(result2, '对账照常产生战果事件')
    assert.equal(result2.won, false, '本组开奖号与预测不命中 → won=false 前置成立')
    assert.equal(petNoWin.calls.length, 0, '未中奖战果零投喂（TF-6 红线在接线面成立）')
  } finally { h2.sched.stop() }
})

test('调度器接线·白名单 v1.2 ②：NM 未中奖对账（won=false + nearMiss 存在）→ 旁路投喂，broadcast text 含 §4.3 叙事特征', async () => {
  const pet = petStub()
  const h = mkHarness({
    petFetch: pet,
    latestDraw: { issue: '26283', date: '2026-10-25', digits: [0, 6, 7], prizeGrades: { 1: 1040 } },   // vs picks [0,4,7]：两位对 → NM-2、won=false
    cfgPatch: {
      advisory: { enabled: false },
      petBridge: { enabled: true, baseUrl: 'http://127.0.0.1:3080/dsh-pet-7340', petId: 'main' },
      modes: { ssq: { mode: 'off' }, dlt: { mode: 'off' }, p3: { mode: 'auto', tier: 'p3-x1', predictAt: '17:30', gates: { honestyAck: true } } },
    },
  })
  try {
    await h.sched.tick()
    await waitPreds(h, 1)
    h.setNow(new Date('2026-10-25T22:05:00'))
    await h.sched.tick()
    const preds = readJson(path.join(h.dataDir, 'predictions.json'))
    const e = preds.entries.find((x) => x.kind === 'daily')
    assert.equal(e.nearMiss, 'NM-2', 'NM 入档前置成立（②）')
    assert.equal(e.prize, 0, '未中奖前置成立')
    assert.equal(pet.calls.length, 3, 'NM 未中奖战果投喂全序三调用（lock→broadcast→release）')
    const fedText = JSON.parse(pet.calls[1].body).text
    assert.ok(fedText.includes('两位都对就差一位'), 'broadcast text 含 §4.3 NM-2 叙事特征（事件 body 直传）')
    assert.ok(fedText.includes('账本记 0'), '诚实口径随文案直达气泡')
    const evs = readJson(path.join(h.dataDir, 'events.json'), { entries: [] }).entries
    const result = evs.find((x) => x.kind === 'result')
    assert.equal(result.nearMiss, 'NM-2', '事件携带 nearMiss（④谓词的判据源）')
    assert.equal(result.won, false, 'won 口径不变：NM 事件仍 won=false（红点不计）')
  } finally { h.sched.stop() }
})
