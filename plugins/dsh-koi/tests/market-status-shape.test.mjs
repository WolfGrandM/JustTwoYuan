/**
 * v0.2 T-09 · status() 结构快照（FZ-6 护栏，v0.2B2-D3）
 *
 * 目的：在拆装 status() 之前，把「/api/status 响应形状」钉死——顶层键集、games.<k> 子键集、
 * events/ledger/mind/push/tiers/backbone/costEstimate 的形状与关键值。此后任何字段增删改
 * 都会在这里先失败（FZ-6：面板 API 只增字段）。
 *
 * 只断言形状与稳定值；today/time 随真实时钟变化，只做格式断言。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startKoiScheduler } from '../lib/scheduler.js'
import { buildConfigDefaults } from '../lib/config.js'

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'koi-status-shape-'))

function mkSched() {
  const dir = tmpdir()
  const configPath = path.join(dir, 'koi.config.json')
  const dataDir = path.join(dir, 'koi')
  const workDir = path.join(dir, 'koi-work')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify({ schemaVersion: 2, ...buildConfigDefaults() }))
  return startKoiScheduler(
    { sessionController: { create: async () => {}, prompt: async () => {} } },
    {
      dshHome: dir, configPath, dataDir, workDir, log: () => {},
      now: () => new Date('2026-10-25T17:35:00'),
      fetch: { fetchHistory: async () => [], fetchLatestDraw: async () => null },
    },
  )
}

const keys = (o) => Object.keys(o).sort()

const TOP_KEYS = [
  'backbone', 'carry', 'costEstimate', 'effort', 'events', 'games', 'heartbeatCheckedAt',
  'holiday', 'lastError', 'ledger', 'ledgerText', 'mind', 'modes', 'ok', 'push',
  'pushTargetMasked', 'repushQueue', 'schedulerOk', 'tierTable', 'tiers', 'time', 'today', 'verbosity',
]
const GAME_KEYS = [
  'bets', 'cost', 'enabledToday', 'issue', 'lastError', 'mode', 'phase',
  'picksLine', 'pushErr', 'pushedAt', 'settled', 'spec', 'via',
]
const EVENT_KEYS = ['failed', 'heartbeatRed', 'pending', 'queued', 'retrying', 'sent']
const LEDGER_KEYS = ['best', 'cost', 'draws', 'net', 'prize']
const MIND_KEYS = ['enabled', 'handshake']
const PUSH_KEYS = ['detail', 'ok']
const TIER_KEYS = ['bets', 'cost', 'id', 'spec']
const BACKBONE_KEYS = ['continuityOk', 'count', 'fresh', 'latestDate', 'latestIssue']

test('T-09 status 快照：顶层与各子对象键集逐位不变（FZ-6）', () => {
  const sched = mkSched()
  try {
    const st = sched.status()
    assert.deepEqual(keys(st), TOP_KEYS, '顶层字段集必须逐位不变')
    assert.deepEqual(Object.keys(st.games), ['ssq', 'dlt', 'p3'], 'games 三彩种与顺序')
    for (const k of ['ssq', 'dlt', 'p3']) {
      assert.deepEqual(keys(st.games[k]), GAME_KEYS, `games.${k} 子字段集`)
      assert.deepEqual(keys(st.tiers[k]), TIER_KEYS, `tiers.${k} 子字段集`)
      assert.deepEqual(keys(st.backbone[k]), BACKBONE_KEYS, `backbone.${k} 子字段集`)
      assert.deepEqual(keys(st.modes[k]).sort(), ['gates', 'mode', 'predictAt', 'tier', 'wizardDone'], `modes.${k} 子字段集`)
    }
    assert.deepEqual(keys(st.events), EVENT_KEYS, 'events 子字段集')
    assert.deepEqual(keys(st.ledger), LEDGER_KEYS, 'ledger 子字段集')
    assert.deepEqual(keys(st.mind), MIND_KEYS, 'mind 子字段集')
    assert.deepEqual(keys(st.push), PUSH_KEYS, 'push 子字段集')
    assert.equal(typeof st.costEstimate, 'object', 'costEstimate 存在')
    assert.equal(typeof st.tierTable.ssq[0].label, 'string', 'tierTable 行含 label')
  } finally { sched.stop() }
})

test('T-09 status 快照：稳定值不变（空库初始态）', () => {
  const sched = mkSched()
  try {
    const st = sched.status()
    assert.equal(st.ok, true)
    assert.equal(st.schedulerOk, true)
    assert.match(st.today, /^\d{4}-\d{2}-\d{2}$/)
    assert.match(st.time, /^\d{2}:\d{2}$/)
    assert.equal(st.carry, 0)
    assert.equal(st.holiday, false)
    assert.equal(st.repushQueue, 0)
    assert.equal(st.verbosity, 'concise')
    assert.equal(st.lastError, null)
    assert.equal(st.heartbeatCheckedAt, null)
    assert.equal(st.pushTargetMasked, '')
    assert.deepEqual(st.push, { ok: true, detail: '推送已迁移至渠道层，见 channels' })
    assert.deepEqual(st.events, { pending: 0, queued: 0, retrying: 0, sent: 0, failed: 0, heartbeatRed: false })
    assert.deepEqual(st.ledger, { draws: 0, cost: 0, prize: 0, net: 0, best: null })
    assert.deepEqual(st.mind, { enabled: false, handshake: 'absent' })
    assert.equal(st.games.ssq.mode, 'manual')
    assert.equal(st.games.ssq.spec, '单式 红6+蓝1')
    assert.equal(st.tiers.ssq.id, 'ssq-d6b1')
    assert.deepEqual(st.backbone.ssq, { count: 0, latestIssue: null, latestDate: null, fresh: false, continuityOk: null })
    assert.equal(st.effort.tier, 'follow-host')
  } finally { sched.stop() }
})

test('T-09 status 快照：整体可 JSON 序列化且无函数值', () => {
  const sched = mkSched()
  try {
    const st = sched.status()
    const round = JSON.parse(JSON.stringify(st))
    assert.deepEqual(keys(round), TOP_KEYS, '序列化后键集不变')
    const walk = (v, p) => {
      if (typeof v === 'function') assert.fail(`status.${p} 出现函数值（不可序列化）`)
      if (v && typeof v === 'object') for (const k of Object.keys(v)) walk(v[k], `${p}.${k}`)
    }
    walk(st, '')
  } finally { sched.stop() }
})
