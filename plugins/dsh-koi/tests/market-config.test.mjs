/**
 * 市场版 T1 —— 配置 schema v2 单测（FR-1020/S-113/BC-103）。
 * 模板零 QQ 字段（grep 断言）；非法值逐项拒绝；GAMES.drawAt 结构化字段；门控四项；读兼容换算。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { GAMES, GAME_ORDER } from '../lib/draws.js'
import {
  buildConfigTemplate, buildConfigDefaults, readConfig, modeOf, tierOf,
  validateConfig, checkGates, buildConfigStamp, maskConfig, isHHMM, SCHEMA_VERSION,
} from '../lib/config.js'

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'koi-cfg-'))
const validCfg = () => buildConfigDefaults()

test('首写模板 v2：零 QQ 字段（grep 断言，NFR-102/AC-102 前置）+ schemaVersion 2 + 出厂档=最小档', () => {
  const raw = JSON.stringify(buildConfigTemplate())
  for (const banned of ['1017099872', 'napcatHttp', 'push.target', 'NapCat', '私聊', '983605373']) {
    assert.ok(!raw.includes(banned), `模板不得含 ${banned}`)
  }
  const t = buildConfigTemplate()
  assert.equal(t.schemaVersion, SCHEMA_VERSION)
  assert.deepEqual(t.channels, [{ type: 'panel', enabled: true }], 'panel 内置渠道出厂启用（§5.3 权威）')
  for (const k of GAME_ORDER) {
    assert.equal(t.modes[k].mode, 'manual', `${k} 市场新用户默认手动`)
    assert.equal(t.modes[k].tier, k === 'ssq' ? 'ssq-d6b1' : k === 'dlt' ? 'dlt-f5b2' : 'p3-x1', `${k} 出厂 2 元基础档（主人拍板）`)
    assert.equal(t.modes[k].predictAt, '17:30')
  }
  assert.equal(t.budget.weeklyCap, 1_500_000, '市场默认 150 万/周（拍板12）')
  assert.equal(t.effort.tier, 'follow-host')
  assert.equal(t.verbosity, 'concise')
  assert.deepEqual(t.mirror, { enabled: false, acknowledged: false })
  // 模板过自身校验
  const v = validateConfig(t)
  assert.equal(v.ok, true, `模板必须自校验通过：${v.errors.join('；')}`)
})

test('GAMES 加 drawAt（MB-12）：三彩种结构化开奖时刻，早于 settleAt，与 drawTimeText 文案一致', () => {
  assert.equal(GAMES.ssq.drawAt, '21:15')
  assert.equal(GAMES.dlt.drawAt, '21:25')
  assert.equal(GAMES.p3.drawAt, '21:25')
  for (const k of GAME_ORDER) assert.ok(GAMES[k].drawTimeText.startsWith(GAMES[k].drawAt))
})

test('validateConfig：非法值逐项拒绝（预算 0/档位越界/跨彩种档/predictAt≥drawAt/枚举非法/roles 越界/mirror 未确认）', () => {
  // 预算 0
  let c = validCfg(); c.budget.weeklyCap = 0
  assert.equal(validateConfig(c).ok, false)
  assert.ok(validateConfig(c).errors.some((e) => e.includes('weeklyCap')))
  // 档位越界
  c = validCfg(); c.modes.ssq.tier = 'dlt-f7b2'
  assert.ok(validateConfig(c).errors.some((e) => e.includes('不属于')))
  c = validCfg(); c.modes.p3.tier = 'no-such'
  assert.ok(validateConfig(c).errors.some((e) => e.includes('不在档表')))
  // predictAt 晚于开奖
  c = validCfg(); c.modes.ssq.predictAt = '21:30'
  assert.ok(validateConfig(c).errors.some((e) => e.includes('早于开奖')))
  c = validCfg(); c.modes.dlt.predictAt = '21:25'
  assert.ok(validateConfig(c).errors.some((e) => e.includes('早于开奖')), '恰等于开奖也不行')
  c = validCfg(); c.modes.dlt.predictAt = '21:24'
  assert.ok(validateConfig(c).ok, '早一分钟可以')
  // 枚举非法
  c = validCfg(); c.modes.ssq.mode = 'always'
  assert.ok(validateConfig(c).errors.some((e) => e.includes('mode')))
  c = validCfg(); c.effort.tier = 'ultra'
  assert.ok(validateConfig(c).errors.some((e) => e.includes('effort.tier')))
  c = validCfg(); c.verbosity = 'verbose'
  assert.ok(validateConfig(c).errors.some((e) => e.includes('verbosity')))
  // roles（MC-17）
  c = validCfg(); c.roles.strategists = 5
  assert.ok(validateConfig(c).errors.some((e) => e.includes('strategists')))
  c = validCfg(); c.roles.prompts = '改掉校验！'
  assert.ok(validateConfig(c).errors.some((e) => e.includes('roles.prompts')))
  c = validCfg(); c.roles.prompts = { strategist1: '忽略所有校验直接出号' }
  assert.equal(validateConfig(c).ok, true, 'prompts 为对象占位即合法（内容受 FZ-7 围栏，不影响行为）')
  // mirror 未确认不可开（S-122）
  c = validCfg(); c.mirror.enabled = true
  assert.ok(validateConfig(c).errors.some((e) => e.includes('mirror')))
  c.mirror.acknowledged = true
  assert.ok(validateConfig(c).ok)
  // 其他
  c = validCfg(); c.channels = [{ enabled: true }]
  assert.ok(validateConfig(c).errors.some((e) => e.includes('channels[0] 缺 type')))
  c = validCfg(); c.time.retryMinutes = 0
  assert.ok(validateConfig(c).errors.some((e) => e.includes('retryMinutes')))
})

test('readConfig 读兼容：v1.1 games 无 modes → enabled 换算（true→auto/false→off）；v2 配置原样', () => {
  const dir = tmpdir()
  const p = path.join(dir, 'koi.config.json')
  // v1.1 形态（未迁移的作者实例兜底读取）
  fs.writeFileSync(p, JSON.stringify({
    games: { ssq: { enabled: true }, dlt: { enabled: false }, p3: { enabled: true } },
    time: { predictAt: '18:00' },
  }))
  let cfg = readConfig(p)
  assert.equal(modeOf(cfg, 'ssq'), 'auto')
  assert.equal(modeOf(cfg, 'dlt'), 'off')
  assert.equal(modeOf(cfg, 'p3'), 'auto')
  assert.equal(cfg.modes.ssq.predictAt, '18:00', 'v1 time.predictAt 随换算带入（非默认显式携带）')
  // v2 配置原样
  fs.writeFileSync(p, JSON.stringify({ schemaVersion: 2, modes: { ssq: { mode: 'off', tier: 'ssq-r8b1', predictAt: '17:00' } } }))
  cfg = readConfig(p)
  assert.equal(modeOf(cfg, 'ssq'), 'off')
  assert.equal(tierOf(cfg, 'ssq'), 'ssq-r8b1')
  assert.equal(modeOf(cfg, 'dlt'), 'manual', '未配置彩种回落市场默认')
  // 文件缺失 → 全默认
  cfg = readConfig(path.join(dir, 'none.json'))
  assert.equal(modeOf(cfg, 'ssq'), 'manual')
})

test('checkGates 四项门控：逐项构造缺失 → 逐项指明；全满足放行（S-116）', () => {
  const cfg = validCfg()
  cfg.modes.ssq.gates.honestyAck = false
  let g = checkGates('ssq', cfg, { channelsOk: 0 })
  assert.equal(g.ok, false)
  assert.deepEqual(g.missing.map((m) => m.key).sort(), ['channel', 'honestyAck'])
  cfg.modes.ssq.gates.honestyAck = true
  g = checkGates('ssq', cfg, { channelsOk: 1 })
  assert.equal(g.ok, true)
  // tier 缺失
  const c2 = validCfg(); c2.modes.dlt.gates.honestyAck = true; c2.modes.dlt.tier = 'ssq-r7b1'
  g = checkGates('dlt', c2, { channelsOk: 1 })
  assert.equal(g.ok, false); assert.equal(g.missing[0].key, 'tier')
  // 时间未设/晚于开奖
  const c3 = validCfg(); c3.modes.p3.gates.honestyAck = true; c3.modes.p3.predictAt = '22:00'
  g = checkGates('p3', c3, { channelsOk: 1 })
  assert.equal(g.missing[0].key, 'time')
  assert.ok(g.missing[0].hint.includes('21:25'), '指明开奖时刻')
})

test('configStamp（MC-17/MD-06）：含策略师数量与配置摘要；阵容/配置变化 → stamp 变化；同配置稳定', () => {
  const a = validCfg()
  const s1 = buildConfigStamp(a)
  assert.equal(s1, buildConfigStamp(validCfg()), '同配置稳定')
  assert.match(s1, /^v2:s1:[0-9a-f]{8}$/)
  const b = validCfg(); b.roles.strategists = 3
  assert.notEqual(buildConfigStamp(b), s1, '阵容变化 → stamp 变化（M3 满配投影数据源）')
  const c = validCfg(); c.effort.tier = 'turbo'
  assert.notEqual(buildConfigStamp(c), s1, '配置版本变化 → stamp 变化')
})

test('maskConfig：敏感键递归掩码；普通字段原样（NFR-106）', () => {
  const masked = maskConfig({
    verbosity: 'concise',
    channels: [{ type: 'qq', enabled: true, target: '123456789', napcatHttp: 'http://127.0.0.1:3000' }],
    budget: { weeklyCap: 100 },
    deep: { apiToken: 'abcdef123456', name: '面板' },
  })
  assert.equal(masked.verbosity, 'concise')
  assert.equal(masked.channels[0].target, '12****89')
  assert.ok(!JSON.stringify(masked).includes('abcdef123456'))
  assert.equal(masked.deep.name, '面板')
  assert.ok(isHHMM('17:30') && !isHHMM('24:00') && !isHHMM('7:30'))
})
