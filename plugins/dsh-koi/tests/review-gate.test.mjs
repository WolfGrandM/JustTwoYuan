/**
 * M4 T2 双向闸 fixture（docs/28 §6 review-gate，AC-008 / AC-034）——
 * mind.enabled=false：周日 22:40 tick → 三零断言（promptAgent 0 调用 / review 事件 0 /
 * review.db 行数不变 + koi/review 零新增文件）；mind.enabled=true：同一夹具重跑 →
 * 周报生成 + review 事件 1 条且 panelOnly=true + usage review 桶增量正确。
 * AC-034：review×backtest 并发 → review 侧 acquire 失败 → 跳过本轮 + 下轮补跑（不照抄 409）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startKoiScheduler } from '../lib/scheduler.js'
import { buildConfigDefaults } from '../lib/config.js'
import { readJson, writeJsonAtomic } from '../lib/io.js'

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'koi-review-gate-'))
const SUNDAY = new Date('2026-11-22T22:40:00')   // ISO 2026-W47 周日

/** 调度器测试台（market-scheduler 同款骨架 + narrate 交卷分支 + promptAgent 计数） */
function mkGateHarness({ mindEnabled, cfgPatch = {} } = {}) {
  const dir = tmpdir()
  const configPath = path.join(dir, 'koi.config.json')
  const dataDir = path.join(dir, 'koi')
  const workDir = path.join(dir, 'koi-work')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.mkdirSync(workDir, { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify({
    schemaVersion: 2, ...buildConfigDefaults(),
    mind: { enabled: mindEnabled },
    ...cfgPatch,
  }))
  let t = new Date(SUNDAY.getTime())
  let promptCalls = 0
  const ctx = {
    sessionController: {
      create: async () => {},
      prompt: async (req) => {
        promptCalls += 1
        const text = req.content[0].text
        // narrate 交卷（文件契约，同 predict/advisory 先例）
        const m = text.match(/narrate-[\w.-]+\.json/)
        if (m) {
          fs.writeFileSync(path.join(workDir, m[0]), JSON.stringify({
            text: '代码数据如实叙述：本周命中与基线对照数字见报告正文，随机仍随机。',
          }))
          return
        }
        // 其余（predict/advisory）不交卷——本夹具不走出号流水线
        return
      },
    },
  }
  const fetch = {
    async fetchHistory() { return [] },
    async fetchLatestDraw() { return null },
    async fetchHistoryPage() { return { items: [], done: true } },
  }
  const sched = startKoiScheduler(ctx, {
    dshHome: dir, configPath, dataDir, workDir, log: () => {},
    now: () => t,
    fetch,
  })
  return {
    sched, dir, dataDir, workDir, configPath,
    setNow: (d) => { t = d },
    get promptCalls() { return promptCalls },
    eventsFile: path.join(dataDir, 'events.json'),
    usageFile: path.join(dataDir, 'token-usage.json'),
    reviewDbFile: path.join(dataDir, 'review.db'),
    reportsDir: path.join(dataDir, 'review', 'reports'),
    writeCfg: (patch) => {
      const cur = readJson(configPath, {})
      fs.writeFileSync(configPath, JSON.stringify({ ...cur, ...patch }, null, 2))
    },
  }
}

const reviewEventCount = (h) => (readJson(h.eventsFile, { entries: [] }).entries ?? []).filter((e) => e.kind === 'review').length

test('AC-008 闸关：mind.enabled=false 周日 22:40 tick → promptAgent 0 调用 + review 事件 0 + review.db 零行 + koi/review 零新增文件', async () => {
  const h = mkGateHarness({ mindEnabled: false })
  try {
    await h.sched.tick()
    assert.equal(h.promptCalls, 0, '闸关 → 叙述零调用')
    assert.equal(reviewEventCount(h), 0, 'review 事件零条')
    // review.db 行数不变：reports 0 / predictions_archive 0 / factor_state_log 0
    const { createReviewStore } = await import('../lib/review/store.js')
    const s = createReviewStore({ dataDir: h.dataDir })   // 重新打开同一 db 只读核对
    assert.equal(Number(s.db.prepare(`SELECT COUNT(*) AS n FROM reports`).get().n), 0)
    assert.equal(Number(s.db.prepare(`SELECT COUNT(*) AS n FROM predictions_archive`).get().n), 0)
    assert.equal(Number(s.db.prepare(`SELECT COUNT(*) AS n FROM factor_state_log`).get().n), 0)
    s.db.close()
    // koi/review 目录零新增文件（claims 目录的市场版等价物 = review 状态文件；docs/11 §5.4 口径）
    assert.equal(fs.existsSync(h.reportsDir), false, 'reports 目录未创建')
    assert.equal(fs.existsSync(path.join(h.dataDir, 'review', 'health-state.json')), false, '健康去重状态未落盘')
  } finally { h.sched.stop() }
})

test('AC-008 闸开：mind.enabled=true 同一夹具重跑 → 周报生成 + review 事件 1 条 panelOnly=true + usage review 桶增量', async () => {
  const h = mkGateHarness({ mindEnabled: true })
  try {
    await h.sched.tick()
    assert.ok(h.promptCalls >= 2, `叙述调用 ≥2（节 1/节 3），实际 ${h.promptCalls}`)
    const events = (readJson(h.eventsFile, { entries: [] }).entries ?? []).filter((e) => e.kind === 'review')
    assert.equal(events.length, 1, '健康夹具无告警 → 恰 1 条周报事件')
    assert.equal(events[0].panelOnly, true)
    assert.match(events[0].body, /周报 2026-W47/)
    assert.match(events[0].body, /命中率只作与随机基线对照的观测值/)
    // review.db 落行 + 报告文件
    assert.equal(fs.existsSync(path.join(h.reportsDir, 'weekly-2026-W47.md')), true)
    // usage review 桶增量正确（AC-008/AC-007 联动）：activity=review 且 est=true，tokens>0
    const usage = readJson(h.usageFile, { entries: [] })
    const reviewEntries = (usage.entries ?? []).filter((e) => e.activity === 'review')
    assert.ok(reviewEntries.length >= 3, '节 1/节 3 输入侧 + 输出侧计量')
    assert.ok(reviewEntries.every((e) => e.est === true && Number(e.tokens) > 0))
    assert.ok(reviewEntries.reduce((s2, e) => s2 + Number(e.tokens), 0) > 0)
  } finally { h.sched.stop() }
})

test('AC-034 review×backtest 并发：backtest 持锁 → review 跳过本轮（无事件无报告）；释放 → 下轮 tick 补跑', async () => {
  const h = mkGateHarness({ mindEnabled: true })
  try {
    const held = h.sched.jobLock.acquire('backtest', 'builtin-ssq')
    assert.equal(held.ok, true)
    await h.sched.tick()
    assert.equal(reviewEventCount(h), 0, '锁被占 → 本轮跳过，零事件')
    assert.equal(h.promptCalls, 0, '跳过本轮零 LLM 调用')
    h.sched.jobLock.release()
    await h.sched.tick()
    const events = (readJson(h.eventsFile, { entries: [] }).entries ?? []).filter((e) => e.kind === 'review')
    assert.equal(events.length, 1, '下轮 tick（≤30s 语义）补跑成功')
    assert.equal(events[0].panelOnly, true)
  } finally { h.sched.stop() }
})

test('AC-008 附：闸关但 CLI 直调 generateNow 仍可生成并同样计量（B-21 CLI 手动命令不受限）', async () => {
  const h = mkGateHarness({ mindEnabled: false })
  try {
    const weekly = h.sched.review.weekly
    const r = await weekly.generateNow({ period: '2026-W47' })
    assert.equal(r.ok, true, 'CLI 手动路径绕过 mind 闸（闸只管调度侧自动生成）')
    assert.ok(h.promptCalls >= 2, 'CLI 路径叙述照常调用')
    assert.ok(fs.existsSync(path.join(h.reportsDir, 'weekly-2026-W47.md')))
    const usage = readJson(h.usageFile, { entries: [] })
    assert.ok((usage.entries ?? []).some((e) => e.activity === 'review'), 'CLI 路径计量照记')
  } finally { h.sched.stop() }
})
