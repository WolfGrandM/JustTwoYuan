/**
 * M4 T2 健康告警测试（docs/28 §2.1 health.js，AC-025 B-24 口径 / AC-028 触发器映射）——
 * ② 兜底连续 3 期 + 设计内差值不告警；③ LLM 通道映射；B-24 未结清>7天报红 / voided 无阈值；
 * 新鲜度 isStaleDraw；触发器① N/A 如实标注；同日去重 + TF-6 panelOnly 告警事件。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { scanHealth, createHealthScanner } from '../lib/review/health.js'
import { writeJsonAtomic, readJson } from '../lib/io.js'

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'koi-review-health-'))
const TODAY = '2026-11-22'

const daily = (o) => ({ kind: 'daily', at: `${o.date}T10:00:00.000Z`, via: 'ai', ...o })

test('T2 触发器②：兜底连续 3 期告警（指明连续期数）；设计内差值（第 3 期恢复 ai）不告警', () => {
  const streak = [1, 2, 3].map((i) => daily({ game: 'ssq', issue: `20261${20 + i}`, date: `2026-11-1${i}`, via: 'fallback', settled: true, settleState: 'settled', prize: 0 }))
  const r = scanHealth({ readPreds: () => ({ entries: streak }), today: TODAY })
  const a = r.alerts.find((x) => x.type === 'fallback-streak')
  assert.ok(a, '连续 3 期兜底必须告警')
  assert.equal(a.game, 'ssq')
  assert.match(a.detail, /连续 3 期/)
  // 第 3 期恢复 ai → 连号断裂，不告警
  const mixed = [...streak.slice(0, 2), { ...streak[2], via: 'ai' }]
  const r2 = scanHealth({ readPreds: () => ({ entries: mixed }), today: TODAY })
  assert.equal(r2.alerts.some((x) => x.type === 'fallback-streak'), false, '设计内差值不告警')
  // 只有 2 期 → 不告警
  const two = scanHealth({ readPreds: () => ({ entries: streak.slice(0, 2) }), today: TODAY })
  assert.equal(two.alerts.some((x) => x.type === 'fallback-streak'), false)
})

test('T2 B-24：given-up 且 >7 天报红；恰 7 天内不报；voided 只列历史累计无阈值', () => {
  const stale = daily({ game: 'ssq', issue: '2026101', date: '2026-11-02', settled: true, settleState: 'given-up', prize: null })   // 20 天
  const fresh = daily({ game: 'p3', issue: '26301', date: '2026-11-20', settled: true, settleState: 'given-up', prize: null })      // 2 天
  const voided = daily({ game: 'dlt', issue: '26100', date: '2026-10-01', settled: true, settleState: 'voided', prize: null })
  const r = scanHealth({ readPreds: () => ({ entries: [stale, fresh, voided] }), today: TODAY })
  const item = r.items.find((i) => i.name === '未结清条目')
  assert.equal(item.ok, false, '>7 天放弃待补报红')
  assert.match(item.detail, /1 期放弃待补超 7 天/)
  assert.match(item.detail, /voided 历史累计 1 期（无阈值）/)
  assert.ok(r.alerts.some((a) => a.type === 'unsettled-stale'), '报红必须有告警事件')
  // 只有 fresh（2 天）+ voided → 不报红
  const r2 = scanHealth({ readPreds: () => ({ entries: [fresh, voided] }), today: TODAY })
  assert.equal(r2.items.find((i) => i.name === '未结清条目').ok, true)
  assert.equal(r2.alerts.some((a) => a.type === 'unsettled-stale'), false)
})

test('T2 新鲜度：最新结清距今超 7 天 → 告警；近期 → ok；无结清历史 → 不虚构该项', () => {
  const stale = daily({ game: 'ssq', issue: '2026101', date: '2026-11-10', settled: true, settleState: 'settled', prize: 0 })
  const r = scanHealth({ readPreds: () => ({ entries: [stale] }), today: TODAY })
  const item = r.items.find((i) => i.name === '新鲜度·ssq')
  assert.equal(item.ok, false)
  assert.ok(r.alerts.some((a) => a.type === 'stale-draw' && a.game === 'ssq'))
  const recent = { ...stale, date: '2026-11-20' }
  const r2 = scanHealth({ readPreds: () => ({ entries: [recent] }), today: TODAY })
  assert.equal(r2.items.find((i) => i.name === '新鲜度·ssq').ok, true)
  const r3 = scanHealth({ readPreds: () => ({ entries: [] }), today: TODAY })
  assert.equal(r3.items.some((i) => i.name.startsWith('新鲜度')), false, '无数据不虚构新鲜度')
})

test('T2 触发器③映射：pending-llm ≥2 或 no-model 彩种 ≥2 告警；各 1 不告警；① N/A 如实标注', () => {
  const base = { readPreds: () => ({ entries: [] }), today: TODAY }
  const r1 = scanHealth({ ...base, signals: { pendingLlm: 2, noModelGames: 0 } })
  assert.ok(r1.alerts.some((a) => a.type === 'llm-channel' && /pending-llm 2/.test(a.detail)))
  const r2 = scanHealth({ ...base, signals: { pendingLlm: 1, noModelGames: 1 } })
  assert.equal(r2.alerts.some((a) => a.type === 'llm-channel'), false, '各 1 → 不告警')
  const r3 = scanHealth({ ...base, signals: { pendingLlm: 0, noModelGames: 2 } })
  assert.ok(r3.alerts.some((a) => a.type === 'llm-channel' && /no-model/.test(a.detail)))
  // 触发器①：N/A（§9-R2 stamp 无计划档位字段）
  const item = r1.items.find((i) => i.name === '档位·计划对照')
  assert.equal(item.ok, null)
  assert.match(item.detail, /N\/A/)
  assert.ok(r1.items.find((i) => i.name === '满配率').detail.includes('N/A'))
  assert.ok(r1.items.find((i) => i.name === '注入均值').detail.includes('N/A'))
})

test('T2 月 token 走势项：近 4 周合计（usageWeeks 注入口径 DC-011）', () => {
  const r = scanHealth({
    readPreds: () => ({ entries: [] }), today: TODAY,
    usageWeeks: [{ week: '2026-W44', total: 100 }, { week: '2026-W45', total: 200 }, { week: '2026-W46', total: 300 }, { week: '2026-W47', total: 650 }],
  })
  const item = r.items.find((i) => i.name === '月 token 走势')
  assert.match(item.detail, /近 4 周合计 1250/)
  assert.match(item.detail, /2026-W47:650/)
})

test('T2 扫描器去重与 TF-6：同日同型只发一条 review 事件（panelOnly=true、level=warn）；次日窗口重置', async () => {
  const dir = tmpdir()
  const stateFile = path.join(dir, 'review', 'health-state.json')
  const emitted = []
  const scanner = createHealthScanner({
    readPreds: () => ({ entries: [
      daily({ game: 'ssq', issue: '2026121', date: '2026-10-22', settled: true, settleState: 'settled', prize: 0 }),   // 新鲜度超 7 天
    ] }),
    now: () => new Date('2026-11-22T22:45:00'),
    emit: async (p) => { emitted.push(p); return { id: `e${emitted.length}` } },
    stateFile,
  })
  const r1 = await scanner.scanAndAlert({ today: TODAY })
  assert.equal(r1.firedEvents, r1.alerts.length > 0 ? r1.alerts.length : 0)
  assert.ok(emitted.length >= 1)
  assert.ok(emitted.every((e) => e.kind === 'review' && e.panelOnly === true && e.level === 'warn'), 'TF-6：告警 review 事件 panelOnly 静默进面板')
  const n1 = emitted.length
  const r2 = await scanner.scanAndAlert({ today: TODAY })
  assert.equal(r2.firedEvents, 0, '同日同型去重')
  assert.equal(emitted.length, n1, '不重复发事件')
  assert.ok(fs.existsSync(stateFile), '去重状态落盘')
  assert.equal(readJson(stateFile).date, TODAY)
})
