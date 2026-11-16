/**
 * qq.js 适配器自检（零外联：只连本机 stub HTTP 服务，不碰真 NapCat）
 *
 * 跑法：node deploy/koi-channels/selftest.mjs
 * 断言：契约形状 / 回环围栏（FZ-4）/ 正常投递 / 失败回执 / 渠道层双目录发现 /
 *       侧车凭证组装 / 掩码 / 缺凭证分支
 */
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

const KOI_LIB = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../../plugins/dsh-koi/lib')
const { loadAdapters, channelsStatus, resolveChannelCfg } = await import(new URL('file://' + path.join(KOI_LIB, 'channels/index.js').replace(/\\/g, '/')).href)
const { default: qq } = await import(new URL('file://' + path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'qq.js').replace(/\\/g, '/')).href)

let pass = 0
let fail = 0
const results = []
function check(name, fn) {
  try { fn(); results.push(`✓ ${name}`); pass++ } catch (e) { results.push(`✗ ${name} —— ${e.message}`); fail++ }
}
async function checkAsync(name, fn) {
  try { await fn(); results.push(`✓ ${name}`); pass++ } catch (e) { results.push(`✗ ${name} —— ${e.message}`); fail++ }
}

// ── stub NapCat ────────────────────────────────────────────────────────────
let mode = 'ok'            // ok | reject | garbage
let lastPayload = null
const server = http.createServer((req, res) => {
  let buf = ''
  req.on('data', (c) => { buf += c })
  req.on('end', () => {
    let body = {}
    try { body = JSON.parse(buf || '{}') } catch { body = {} }
    if (req.url === '/send_private_msg') lastPayload = body
    res.setHeader('content-type', 'application/json')
    if (mode === 'garbage') { res.end('not json'); return }
    if (mode === 'reject') {
      res.end(JSON.stringify(req.url === '/get_login_info'
        ? { status: 'failed', retcode: 1403, wording: '账号未登录' }
        : { status: 'failed', retcode: 1404, wording: '对方不在好友列表' }))
      return
    }
    res.end(JSON.stringify(req.url === '/get_login_info'
      ? { status: 'ok', retcode: 0, data: { user_id: 983605373, nickname: '锦鲤' } }
      : { status: 'ok', retcode: 0, data: { message_id: 1 } }))
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`
const cfg = { target: '1017099872', napcatHttp: base }

// ── 1. 契约形状 ────────────────────────────────────────────────────────────
check('契约：type/send/test/configSchema 齐备', () => {
  assert.equal(qq.type, 'qq')
  assert.equal(typeof qq.send, 'function')
  assert.equal(typeof qq.test, 'function')
  assert.equal(qq.configSchema.target.required, true)
  assert.equal(qq.configSchema.napcatHttp.mask, false)
})

// ── 2. 回环围栏（FZ-4 语义）────────────────────────────────────────────────
await checkAsync('围栏：非回环地址 send 抛错且不发请求', async () => {
  lastPayload = null
  await assert.rejects(
    () => qq.send({ body: 'x' }, { ...cfg, napcatHttp: 'http://10.0.0.9:3000' }),
    /必须是本机回环/,
  )
  assert.equal(lastPayload, null)
})
await checkAsync('围栏：非法 URL 抛错', async () => {
  await assert.rejects(() => qq.test({ ...cfg, napcatHttp: 'not-a-url' }), /不合法/)
})
await checkAsync('围栏：localhost 放行', async () => {
  const r = await qq.test({ ...cfg, napcatHttp: base.replace('127.0.0.1', 'localhost') })
  assert.equal(r.ok, true)
})

// ── 3. 正常路径 ────────────────────────────────────────────────────────────
await checkAsync('test：在线回执带昵称', async () => {
  const r = await qq.test(cfg)
  assert.deepEqual(r.ok, true)
  assert.match(r.word, /锦鲤/)
})
await checkAsync('send：正文原样投递 + user_id 数字', async () => {
  const body = '【锦鲤】双色球 第2026123期\n红 03 07 12 18 23 29 蓝 06'
  const r = await qq.send({ body }, cfg)
  assert.equal(r.ok, true)
  assert.deepEqual(lastPayload, { user_id: 1017099872, message: body })
})

// ── 4. 失败回执 ────────────────────────────────────────────────────────────
await checkAsync('send：retcode 非 0 → ok=false 且带 wording', async () => {
  mode = 'reject'
  const r = await qq.send({ body: 'x' }, cfg)
  assert.equal(r.ok, false)
  assert.match(r.word, /好友列表/)
  mode = 'ok'
})
await checkAsync('send：QQ 号非法直接抛错（不发请求）', async () => {
  lastPayload = null
  await assert.rejects(() => qq.send({ body: 'x' }, { ...cfg, target: 'abc' }), /不合法/)
  assert.equal(lastPayload, null)
})

// ── 5. 渠道层集成（双目录发现 + 侧车 + 掩码 + 缺凭证）──────────────────────
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'koi-qq-selftest-'))
const channelsDir = path.join(home, 'koi', 'channels')
fs.mkdirSync(channelsDir, { recursive: true })
fs.writeFileSync(path.join(channelsDir, 'qq.js'), fs.readFileSync(new URL('./qq.js', import.meta.url)))
const writeSidecar = (obj) => fs.writeFileSync(path.join(channelsDir, 'qq.config.json'), JSON.stringify(obj))

await checkAsync('发现：用户目录 qq.js 被加载且 source=user', async () => {
  const { adapters, problems } = await loadAdapters(channelsDir)
  assert.deepEqual(problems, [])
  assert.equal(adapters.get('qq')?.source, 'user')
  assert.equal(adapters.get('panel')?.source, 'builtin')
})

await checkAsync('侧车：resolveChannelCfg 合并凭证且侧车优先', async () => {
  writeSidecar({ target: '1017099872', napcatHttp: base })
  const merged = resolveChannelCfg({ type: 'qq', enabled: true, target: 'stale' }, channelsDir)
  assert.equal(merged.target, '1017099872')
  assert.equal(merged.napcatHttp, base)
})

await checkAsync('status：启用渠道探针 ok + 凭证掩码', async () => {
  writeSidecar({ target: '1017099872', napcatHttp: base })
  const { adapters } = await loadAdapters(channelsDir)
  const st = await channelsStatus([{ type: 'qq', enabled: true }], { adapters, userDir: channelsDir })
  assert.equal(st[0].status, 'ok')
  assert.equal(st[0].masked.target, '101****72')
})

await checkAsync('status：缺侧车 → no-credentials 且不崩', async () => {
  const { adapters } = await loadAdapters(channelsDir)
  const st = await channelsStatus([{ type: 'qq', enabled: true }], { adapters, userDir: path.join(home, 'empty') })
  assert.equal(st[0].status, 'no-credentials')
  assert.match(st[0].error, /凭证缺失/)
})

await checkAsync('status：NapCat 掉线 → fail 且带 retcode', async () => {
  mode = 'reject'
  const { adapters } = await loadAdapters(channelsDir)
  const st = await channelsStatus([{ type: 'qq', enabled: true }], { adapters, userDir: channelsDir })
  assert.equal(st[0].status, 'fail')
  assert.match(st[0].error, /1403|未登录/)
  mode = 'ok'
})

server.close()
for (const line of results) console.log(line)
console.log(`\nqq.js 适配器自检：${pass} pass / ${fail} fail`)
process.exit(fail ? 1 : 0)
