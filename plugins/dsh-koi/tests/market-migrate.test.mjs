/**
 * 市场版 T10/T13 —— migrate-v2 迁移演练 + 包卫生门 + AC-114 市场用户目录隔离演练（MC-19）。
 * v1.1 fixture 全字段映射断言（QQ 字段→侧车 / retryMinutes→time / predictAt→modes 非默认携带 /
 * enabled→mode / tier 反查 / repushQueue 搬家 / 三 JSON 零触碰）；幂等重跑无 diff；
 * hygiene 门（真实包零命中退出 0 + 植入违例能命中）；升级隔离（用户数据 diff 为空 + 镜像开关不变）。
 * 全部经子进程真实执行 tools/koi.mjs（DSH_HOME/KOI_CONFIG 指向临时目录，纯本地文件操作，零网络）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const NODE = process.execPath
// 路径锚定测试文件自身位置（验收门可从仓库任意 cwd 运行，如 D:/QQ工作区 根目录）
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = path.resolve(TEST_DIR, '..')   // plugins/dsh-koi（tests 的上一级）
const KOI = path.join(PKG_ROOT, 'tools', 'koi.mjs')
const PKG = PKG_ROOT
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'koi-mig-'))

const V11_FIXTURE = {
  push: { target: '1017099872', napcatHttp: 'http://127.0.0.1:3000', retryMinutes: 7 },
  time: { predictAt: '18:00', catchUpEnd: '19:50', settleAt: '22:00', settleGiveUp: '23:30' },
  games: { ssq: { enabled: true }, dlt: { enabled: false }, p3: { enabled: true } },
  historyCount: 30, historyTail: 10, persona: '元气小财迷', holidays: ['2027-01-01'],
}

function mkAuthorHome() {
  const home = tmpdir()
  const configPath = path.join(home, 'koi.config.json')
  const dataDir = path.join(home, 'koi')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify(V11_FIXTURE, null, 2))
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({
    date: '2026-10-24', games: {}, carry: [],
    repushQueue: [
      { kind: 'result', game: 'ssq', issue: '2026121', text: '战果 A', deadline: '23:30', failedAt: '2026-10-24T22:05:00', lastErr: 'e1', attempts: 2 },
      { kind: 'predict', game: 'p3', issue: '26282', text: '出号 B', deadline: '19:50', failedAt: '2026-10-24T18:00:00', lastErr: 'e2', attempts: 1 },
    ],
    lastError: null,
  }))
  const preds = { schemaVersion: 1, entries: [{ at: 't1', kind: 'daily', game: 'ssq', issue: '2026121', date: '2026-10-22', picks: { red: [1, 2, 3, 4, 5, 6, 7, 8], blue: 9 }, via: 'ai', bets: 28, cost: 56, spec: '红8+蓝1 复式', settled: true, prize: 0 }] }
  const ledger = { schemaVersion: 1, entries: [{ at: 't1', kind: 'daily', game: 'ssq', issue: '2026121', date: '2026-10-22', cost: 56, prize: 0, bets: 28, entryType: 'main' }] }
  const predsRaw = JSON.stringify(preds, null, 2) + '\n'
  const ledgerRaw = JSON.stringify(ledger, null, 2) + '\n'
  fs.writeFileSync(path.join(dataDir, 'predictions.json'), predsRaw)
  fs.writeFileSync(path.join(dataDir, 'ledger.json'), ledgerRaw)
  return { home, configPath, dataDir, predsRaw, ledgerRaw }
}

const runKoi = (home, args, { expectFail = false } = {}) => {
  const r = spawnSync(NODE, [KOI, ...args], {
    env: { ...process.env, DSH_HOME: home, KOI_CONFIG: path.join(home, 'koi.config.json') },
    encoding: 'utf8',
    timeout: 60_000,
  })
  if (!expectFail && r.status !== 0) throw new Error(`koi ${args.join(' ')} 退出码 ${r.status}：${r.stdout}\n${r.stderr}`)
  return r
}

const snapDir = (dir) => {
  const out = {}
  const walk = (d) => {
    for (const n of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, n.name)
      if (n.isDirectory()) walk(p)
      else out[path.relative(dir, p).replaceAll('\\', '/')] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
    }
  }
  walk(dir)
  return out
}

test('migrate-v2 --dry-run：全字段映射报告、不落盘', () => {
  const { home, configPath, dataDir } = mkAuthorHome()
  const before = snapDir(home)
  const r = runKoi(home, ['migrate-v2', '--dry-run'])
  const out = r.stdout
  assert.match(out, /qq\.config\.json/)
  assert.match(out, /retryMinutes/)
  assert.match(out, /time\.retryMinutes/)
  assert.match(out, /predictAt/)
  assert.match(out, /repushQueue/)
  assert.match(out, /零触碰/)
  assert.match(out, /dry-run（不落盘）/)
  assert.deepEqual(snapDir(home), before, 'dry-run 零写入')
})

test('migrate-v2 实跑：QQ 字段→侧车、retryMinutes→time、predictAt 非默认携带、enabled→mode、tier 反查、repushQueue 搬家、三 JSON 零触碰', () => {
  const { home, configPath, dataDir, predsRaw, ledgerRaw } = mkAuthorHome()
  const r = runKoi(home, ['migrate-v2'])
  assert.equal(r.status, 0)
  // 配置面
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  assert.equal(cfg.schemaVersion, 2)
  assert.equal(cfg.push, undefined, 'push 段整体移除（BC-103，规则3 破坏性变更）')
  assert.ok(cfg.channels.some((c) => c.type === 'panel' && c.enabled))
  assert.ok(cfg.channels.some((c) => c.type === 'qq' && c.enabled), 'channels 注册 qq')
  assert.equal(cfg.time.retryMinutes, 7, 'retryMinutes 归 time 段')
  assert.equal(cfg.time.predictAt, undefined, 'time.predictAt 已迁 modes')
  assert.equal(cfg.modes.ssq.mode, 'auto', 'enabled=true → auto（MA-21 语义保持）')
  assert.equal(cfg.modes.ssq.tier, 'ssq-r8b1', 'v1 复式结构反查（作者账本连续性，MB-29）')
  assert.equal(cfg.modes.ssq.predictAt, '18:00', '非默认 predictAt 显式携带（MB-24）')
  assert.equal(cfg.modes.ssq.gates.honestyAck, true, 'auto 既有语义保持（迁移即满足门控）')
  assert.equal(cfg.modes.dlt.mode, 'off', 'enabled=false → off')
  assert.equal(cfg.modes.dlt.tier, 'dlt-f7b2')
  assert.equal(cfg.modes.p3.mode, 'auto')
  assert.equal(cfg.modes.p3.tier, 'p3-x1')
  assert.equal(cfg.budget.weeklyCap, 10_000_000, '作者预算写入配置值（MD-18）')
  assert.equal(cfg.persona, '元气小财迷', 'v1 用户字段保留')
  assert.deepEqual(cfg.holidays, ['2027-01-01'])
  // 侧车
  const sidecar = JSON.parse(fs.readFileSync(path.join(dataDir, 'channels', 'qq.config.json'), 'utf8'))
  assert.deepEqual(sidecar, { target: '1017099872', napcatHttp: 'http://127.0.0.1:3000' })
  // repushQueue 搬家
  const events = JSON.parse(fs.readFileSync(path.join(dataDir, 'events.json'), 'utf8'))
  const queued = events.entries.filter((e) => e.status === 'queued')
  assert.equal(queued.length, 2)
  assert.ok(queued.every((e) => e.migrated === true))
  assert.ok(queued.some((e) => e.kind === 'result' && e.issue === '2026121' && e.attempts === 2))
  // state 原字段保留（读取容忍，不删数据）
  const st = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'))
  assert.equal(st.repushQueue.length, 2, 'MB-35：原字段保留（搬家非删除）')
  // 三 JSON 零触碰
  assert.equal(fs.readFileSync(path.join(dataDir, 'predictions.json'), 'utf8'), predsRaw, 'predictions 逐字节不变')
  assert.equal(fs.readFileSync(path.join(dataDir, 'ledger.json'), 'utf8'), ledgerRaw, 'ledger 逐字节不变')
})

test('migrate-v2 幂等：重跑配置无 diff、事件不重复搬入', () => {
  const { home } = mkAuthorHome()
  runKoi(home, ['migrate-v2'])
  const snap1 = snapDir(home)
  const r = runKoi(home, ['migrate-v2'])
  assert.match(r.stdout, /幂等/)
  assert.deepEqual(snapDir(home), snap1, '重跑全部文件零 diff（幂等键去重，MD-19）')
})

test('hygiene 门：真实市场包零命中退出 0（AC-102）；植入违例能命中退出 1', () => {
  const r = spawnSync(NODE, [KOI, 'hygiene'], { cwd: PKG, encoding: 'utf8', timeout: 60_000 })
  assert.equal(r.status, 0, `卫生门必须零命中退出 0：\n${r.stdout}\n${r.stderr}`)
  assert.match(r.stdout, /零命中/)
  // 植入违例（临时包副本，不动真实包）
  const fake = tmpdir()
  fs.mkdirSync(path.join(fake, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(fake, 'package.json'), JSON.stringify({ name: 'x', description: '测试包' }))
  fs.writeFileSync(path.join(fake, 'lib', 'evil.js'), 'const napcatHttp = "http://127.0.0.1:3000" // 私聊残留\n')
  const r2 = spawnSync(NODE, [KOI, 'hygiene', fake], { encoding: 'utf8', timeout: 60_000 })
  assert.equal(r2.status, 1, '植入违例必须退出 1')
  assert.match(r2.stdout, /napcatHttp/)
  assert.match(r2.stdout, /私聊/)
  // tools/hygiene.mjs 直跑（验收门引用形态）
  const r3 = spawnSync(NODE, [path.join(PKG, 'tools', 'hygiene.mjs')], { cwd: PKG, encoding: 'utf8', timeout: 60_000 })
  assert.equal(r3.status, 0)
})

test('AC-114 市场用户目录隔离演练（MC-19）：模拟包目录替换 + 多命令运行后用户数据 diff 为空、镜像开关不变', () => {
  // 用户家目录：v2 配置（自定义渠道/预算/档位）+ 侧车 + 三 JSON + 本地库 + 私有适配器
  const home = tmpdir()
  const dataDir = path.join(home, 'koi')
  const chDir = path.join(dataDir, 'channels')
  fs.mkdirSync(chDir, { recursive: true })
  fs.mkdirSync(path.join(dataDir, 'draws'), { recursive: true })
  const userCfg = {
    schemaVersion: 2,
    channels: [{ type: 'panel', enabled: true }, { type: 'mockchan', enabled: true }],
    modes: { ssq: { mode: 'auto', tier: 'ssq-r9b2', predictAt: '17:00', gates: { honestyAck: true }, wizardDone: true }, dlt: { mode: 'manual', tier: 'dlt-f7b2', predictAt: '17:30', gates: {}, wizardDone: false }, p3: { mode: 'off', tier: 'p3-x5', predictAt: '17:30', gates: {}, wizardDone: false } },
    budget: { weeklyCap: 2_000_000, warn1: 0.7, warn2: 0.9 },
    effort: { tier: 'turbo' }, verbosity: 'chatty',
    mirror: { enabled: false, acknowledged: false },
    historyCount: 30, persona: '用户自定义',
  }
  fs.writeFileSync(path.join(home, 'koi.config.json'), JSON.stringify(userCfg, null, 2))
  fs.writeFileSync(path.join(chDir, 'mockchan.config.json'), JSON.stringify({ token: 'USER-SECRET-98765432' }))
  fs.writeFileSync(path.join(chDir, 'mockchan.js'), [
    'export default {',
    '  type: "mockchan",',
    '  configSchema: { token: { type: "string", required: true, mask: true } },',
    '  async send(event, cfg) { return { ok: true, word: "sent" } },',
    '  async test(cfg) { return { ok: true, word: "用户渠道在位" } },',
    '}',
  ].join('\n'))
  fs.writeFileSync(path.join(dataDir, 'predictions.json'), JSON.stringify({ schemaVersion: 1, entries: [{ at: 't', kind: 'daily', game: 'ssq', issue: '2026121', date: '2026-10-22', picks: { red: [1, 2, 3, 4, 5, 6], blue: 7 }, via: 'ai', bets: 6, cost: 12 }] }, null, 2))
  fs.writeFileSync(path.join(dataDir, 'ledger.json'), JSON.stringify({ schemaVersion: 1, entries: [] }, null, 2))
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ date: '2026-10-25', games: {}, carry: [], lastError: null }, null, 2))
  fs.writeFileSync(path.join(dataDir, 'draws', 'ssq.json'), JSON.stringify({ schemaVersion: 1, entries: [{ issue: '2026121', date: '2026-10-22', red: [2, 7, 20, 24, 26, 30], blue: 2 }] }, null, 2))

  const before = snapDir(home)
  // 模拟「包目录替换」（新包 = 当前工作区包）：对新包跑卫生门（只读），
  // 再以新包代码对用户目录跑一组只读/等价命令 —— 全部不得改用户数据
  const hygiene = spawnSync(NODE, [KOI, 'hygiene', PKG], { env: { ...process.env, DSH_HOME: home, KOI_CONFIG: path.join(home, 'koi.config.json') }, encoding: 'utf8', timeout: 60_000 })
  assert.equal(hygiene.status, 0, hygiene.stdout + hygiene.stderr)
  runKoi(home, ['config', 'get', 'verbosity'])
  runKoi(home, ['channels', 'list'])
  runKoi(home, ['events', 'list'])
  runKoi(home, ['backbone', 'status'])
  runKoi(home, ['selftest'])
  const after = snapDir(home)
  assert.deepEqual(after, before, '升级（包替换）前后用户数据 diff 为空（S-115/AC-114）')
  const cfgAfter = JSON.parse(fs.readFileSync(path.join(home, 'koi.config.json'), 'utf8'))
  assert.deepEqual(cfgAfter.mirror, { enabled: false, acknowledged: false }, '镜像开关默认关闭状态在升级后保持')
  assert.equal(cfgAfter.budget.weeklyCap, 2_000_000, '用户预算不重置')
  assert.equal(cfgAfter.modes.ssq.tier, 'ssq-r9b2', '用户档位不重置')
})

test('CLI 等价路径：config set 校验拒绝非法值（与面板同一份 validateConfig）；mode 门控阻止（零渠道）', () => {
  const { home, configPath } = mkAuthorHome()
  runKoi(home, ['migrate-v2'])
  // 非法值拒绝（S-113 等价）
  const bad = runKoi(home, ['config', 'set', 'budget.weeklyCap', '0'], { expectFail: true })
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /拒绝|非法/)
  // 合法写入
  runKoi(home, ['config', 'set', 'verbosity', '"chatty"'])
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).verbosity, 'chatty')
  // mode 门控：清空渠道后开 auto 被阻并指明缺项
  runKoi(home, ['config', 'set', 'channels', '[]'])
  const m = runKoi(home, ['mode', 'ssq', 'auto'], { expectFail: true })
  assert.equal(m.status, 1)
  assert.match(m.stdout + m.stderr, /通知渠道/)
  // 恢复渠道后可开
  runKoi(home, ['config', 'set', 'channels', '[{"type":"panel","enabled":true}]'])
  runKoi(home, ['mode', 'ssq', 'auto'])
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).modes.ssq.mode, 'auto')
})
