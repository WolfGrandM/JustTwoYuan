/**
 * M4 T5 档案迁移测试（docs/28 §4.2 三跑全规格，AC-018 本地子集 + §2.3③ 观察者）——
 * dry-run 零写盘 / 实跑（备份 manifest + 业务键回填 + outcome 单次 + 归因回填 + migrate_state）/
 * 幂等短路（零 diff + factor_state_log/reports 零新增）/ 备份缺失中止 /
 * settleOne 观察者：archiveAuthoritative=false 零行为（既有套件作证零 diff）、true 入档+归因增量正确。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { migrateArchive } from '../lib/review/migrate.js'
import { writeJsonAtomic, readJson } from '../lib/io.js'
import { DatabaseSync } from 'node:sqlite'

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'koi-review-migrate-'))
const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')

/** 夹具：predictions.json（daily 4 + quickpick 2）+ ledger.json + 本地质历史（ssq/p3） */
function mkFixture({ withHistory = true } = {}) {
  const dir = tmpdir()
  const preds = { schemaVersion: 1, entries: [
    { at: '2026-11-19T09:50:00.000Z', kind: 'daily', game: 'ssq', issue: '2026123', date: '2026-11-19',
      picks: { red: [2, 7, 20, 24, 26, 30], blue: 2 }, via: 'ai', bets: 28, cost: 56, spec: '红8+蓝1 复式',
      tier: 'double', effortTier: 'standard', configStamp: 'cs-1', baselinePicks: { red: [1, 2, 3, 4, 5, 6], blue: 7 },
      settled: true, settleState: 'settled', result: { red: [2, 7, 20, 24, 26, 30], blue: 2 }, prize: 10, grades: { 5: 1 },
      baselinePrize: 5, baselineGrades: { 6: 1 }, pushedResult: true },
    { at: '2026-11-17T09:50:00.000Z', kind: 'daily', game: 'p3', issue: '26295', date: '2026-11-17',
      picks: { digits: [6, 4, 7] }, via: 'ai', bets: 1, cost: 2, spec: '直选一注', tier: 'p3-x1', effortTier: 'standard',
      configStamp: 'cs-1', baselinePicks: { digits: [1, 2, 3] }, settled: true, settleState: 'given-up', prize: null, grades: null },
    { at: '2026-11-20T09:50:00.000Z', kind: 'daily', game: 'p3', issue: '26296', date: '2026-11-20',
      picks: { digits: [6, 4, 7] }, via: 'ai', bets: 1, cost: 2, spec: '直选一注', tier: 'p3-x1', effortTier: 'standard',
      configStamp: 'cs-1', settled: true, settleState: 'voided', prize: null, grades: null },
    { at: '2026-11-21T09:50:00.000Z', kind: 'daily', game: 'p3', issue: '26297', date: '2026-11-21',
      picks: { digits: [6, 4, 7] }, via: 'fallback', bets: 1, cost: 2, spec: '直选一注', tier: 'p3-x1', effortTier: 'economy',
      configStamp: 'cs-1', baselinePicks: { digits: [1, 2, 3] },
      settled: true, settleState: 'settled', result: { digits: [6, 4, 7] }, prize: 1040, grades: { 1: 1 },
      baselinePrize: 0, baselineGrades: {}, pushedResult: true },
    { at: '2026-11-20T12:00:00.000Z', kind: 'quickpick', game: 'p3', issue: '26298', date: '2026-11-20',
      picks: { digits: [1, 1, 1] }, via: 'fallback', bets: 1, cost: 2 },
    { at: '2026-11-21T12:00:00.000Z', kind: 'quickpick', game: 'ssq', issue: '2026124', date: '2026-11-21',
      picks: { red: [1, 2, 3, 4, 5, 6, 7, 8], blue: 1 }, via: 'ai', bets: 28, cost: 56 },
  ] }
  writeJsonAtomic(path.join(dir, 'predictions.json'), preds)
  writeJsonAtomic(path.join(dir, 'ledger.json'), { schemaVersion: 1, entries: [
    { at: '2026-11-19T14:30:00.000Z', kind: 'daily', game: 'ssq', issue: '2026123', date: '2026-11-19', cost: 56, prize: 10, bets: 28, grades: { 5: 1 }, entryType: 'main' },
    { at: '2026-11-21T14:30:00.000Z', kind: 'daily', game: 'p3', issue: '26297', date: '2026-11-21', cost: 2, prize: 1040, bets: 1, grades: { 1: 1 }, entryType: 'main' },
  ] })
  if (withHistory) {
    const drawsDir = path.join(dir, 'draws')
    fs.mkdirSync(drawsDir, { recursive: true })
    writeJsonAtomic(path.join(drawsDir, 'ssq.json'), { schemaVersion: 1, entries: [
      { issue: '2026121', date: '2026-11-12', red: [1, 3, 5, 7, 9, 11], blue: 3 },
      { issue: '2026122', date: '2026-11-17', red: [2, 4, 6, 8, 10, 12], blue: 4 },
      { issue: '2026123', date: '2026-11-19', red: [2, 7, 20, 24, 26, 30], blue: 2 },
    ] })
    writeJsonAtomic(path.join(drawsDir, 'p3.json'), { schemaVersion: 1, entries: [
      { issue: '26295', date: '2026-11-17', digits: [1, 2, 3] },
      { issue: '26296', date: '2026-11-18', digits: [4, 5, 6] },
      { issue: '26297', date: '2026-11-21', digits: [6, 4, 7] },
    ] })
  }
  const cfgOf = { review: { archiveAuthoritative: false } }
  const mk = (over = {}) => migrateArchive({ dataDir: dir, readCfg: () => cfgOf, now: () => new Date('2026-11-22T01:00:00.000Z'), log: () => {}, ...over })
  return { dir, predsFile: path.join(dir, 'predictions.json'), ledgerFile: path.join(dir, 'ledger.json'), mk }
}

const q = (dir, sql) => {
  const db = new DatabaseSync(path.join(dir, 'review.db'))
  const r = db.prepare(sql).all()
  db.close()
  return r
}

test('T5 dry-run：只读统计零写盘（不建 review.db/不建 backups），报告行含 quickpick 排除与归因估价（AC-018 演练面）', async () => {
  const fx = mkFixture()
  const before = fs.readdirSync(fx.dir).sort()
  const r = await fx.mk({ dryRun: true })
  assert.equal(r.code, 0)
  const text = r.report.join('\n')
  assert.match(text, /4 条 daily 条目（2 settled \/ 1 given-up \/ 1 voided），quickpick 2 条不入档（BC-006 加餐不进正式口径）/)
  assert.match(text, /尚不存在 → 将新建/)
  assert.match(text, /将回填 4 行（业务键 game\|issue\|date\|kind 幂等去重）/)
  assert.match(text, /≈12 次/)
  assert.match(text, /archiveAuthoritative 当前 = false/)
  assert.match(text, /✓|不落盘|migrate-archive --dry-run/)
  const after = fs.readdirSync(fx.dir).sort()
  assert.deepEqual(after, before, 'dry-run 零写盘：目录内容零变化')
})

test('T5 实跑：备份 manifest（SHA-256）+ 全量回填 4 行 + outcome 单次 + 归因 12 行 + migrate_state=applied', async () => {
  const fx = mkFixture()
  const predShaBefore = sha256(fx.predsFile)
  const r = await fx.mk()
  assert.equal(r.code, 0, r.report?.join('\n'))
  // 备份三件套 + manifest SHA 与迁移前源文件一致
  const backups = fs.readdirSync(path.join(fx.dir, 'backups'))
  assert.equal(backups.length, 1)
  const bak = path.join(fx.dir, 'backups', backups[0])
  assert.equal(sha256(path.join(bak, 'predictions.json')), predShaBefore)
  assert.ok(fs.existsSync(path.join(bak, 'ledger.json')))
  const manifest = readJson(path.join(bak, 'manifest.json'))
  assert.equal(manifest.files.length, 2)
  assert.ok(manifest.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256) && Number(f.bytes) > 0))
  // 回填：4 行 daily（quickpick 不入档）；outcome 落定 2 行（settled）；given-up/voided 无 result
  const rows = q(fx.dir, 'SELECT game, issue, kind, result, prize, at, picks FROM predictions_archive ORDER BY issue')
  assert.equal(rows.length, 4)
  assert.ok(rows.every((r2) => r2.kind === 'daily'))
  assert.equal(rows.filter((r2) => r2.result != null).length, 2, 'outcome 单次回填只落 settled 两行')
  const givenUp = rows.find((r2) => r2.issue === '26295')
  assert.equal(givenUp.result, null)
  // 归因回填：settled 两期 × 各彩种 6 件内置 = 12 行（代码判定 BC-014，零 LLM）
  const attr = q(fx.dir, 'SELECT COUNT(*) AS n FROM attribution')
  assert.equal(Number(attr[0].n), 12)
  // migrate_state + 源 SHA
  const state = Object.fromEntries(q(fx.dir, `SELECT key, value FROM schema_info WHERE key LIKE 'migrate_%'`).map((r2) => [r2.key, r2.value]))
  assert.equal(state.migrate_state, 'applied')
  assert.equal(state.migrate_src_sha, predShaBefore)
})

test('T5 幂等重跑：同源 SHA 短路零 diff（行数/内容一致、factor_state_log/reports 零新增）；源变化 → 追加回填业务键去重', async () => {
  const fx = mkFixture()
  await fx.mk()
  const rows1 = q(fx.dir, 'SELECT * FROM predictions_archive ORDER BY id')
  const attr1 = q(fx.dir, 'SELECT * FROM attribution ORDER BY id')
  const r2 = await fx.mk()
  assert.equal(r2.code, 0)
  assert.equal(r2.shortCircuit, true, 'migrate_state=applied 且源 SHA 未变 → 零 diff 短路')
  const rows2 = q(fx.dir, 'SELECT * FROM predictions_archive ORDER BY id')
  const attr2 = q(fx.dir, 'SELECT * FROM attribution ORDER BY id')
  assert.equal(crypto.createHash('sha256').update(JSON.stringify(rows2)).digest('hex'),
    crypto.createHash('sha256').update(JSON.stringify(rows1)).digest('hex'), '二次实跑内容 hash 与首次一致')
  assert.equal(attr2.length, attr1.length)
  assert.equal(Number(q(fx.dir, 'SELECT COUNT(*) AS n FROM factor_state_log')[0].n), 0, 'factor_state_log 零新增')
  assert.equal(Number(q(fx.dir, 'SELECT COUNT(*) AS n FROM reports')[0].n), 0, 'reports 零新增')
  // 源变化：追加一条 daily → 追加回填（created 1，业务键去重不重复回填旧条目）
  const preds = readJson(fx.predsFile)
  preds.entries.push({ at: '2026-11-22T09:50:00.000Z', kind: 'daily', game: 'p3', issue: '26299', date: '2026-11-22',
    picks: { digits: [9, 9, 9] }, via: 'ai', bets: 1, cost: 2, tier: 'p3-x1', effortTier: 'standard', configStamp: 'cs-1',
    settled: true, settleState: 'settled', result: { digits: [9, 9, 9] }, prize: 0, grades: {} })
  writeJsonAtomic(fx.predsFile, preds)
  const r3 = await fx.mk()
  assert.equal(r3.code, 0)
  assert.ok(!r3.shortCircuit)
  assert.equal(Number(q(fx.dir, 'SELECT COUNT(*) AS n FROM predictions_archive')[0].n), 5, '追加回填 1 行（旧 4 行幂等不动）')
})

test('T5 备份缺失中止：备份路径不可创建 → 中止退出码 1，零 db 写（§4.2 硬门槛）', async () => {
  const fx = mkFixture()
  fs.writeFileSync(path.join(fx.dir, 'backups'), 'not a directory')   // 备份根路径被文件占用
  const r = await fx.mk()
  assert.equal(r.ok, false)
  assert.equal(r.code, 1)
  assert.match(r.report.join('\n'), /备份目录不可写，中止（硬门槛 §4\.2）/)
  assert.equal(fs.existsSync(path.join(fx.dir, 'review.db')), false, '零 db 写')
})

test('T5 settleOne 观察者：开关 false 零行为（返回 null、零行）；true 入档 + 归因增量正确（含防前视切片）', async () => {
  // false（默认）：零行为——既有 288 项套件全部在默认 false 下运行即为「settle 行为零 diff」的作证
  const { startKoiScheduler } = await import('../lib/scheduler.js')
  const mkSched = async (archiveAuthoritative) => {
    const dir = tmpdir()
    fs.mkdirSync(path.join(dir, 'koi', 'draws'), { recursive: true })
    writeJsonAtomic(path.join(dir, 'koi', 'draws', 'p3.json'), { schemaVersion: 1, entries: [
      { issue: '26296', date: '2026-11-20', digits: [4, 5, 6] },
      { issue: '26297', date: '2026-11-21', digits: [6, 4, 7] },
    ] })
    const configPath = path.join(dir, 'koi.config.json')
    const dataDir = path.join(dir, 'koi')
    const workDir = path.join(dir, 'koi-work')
    fs.mkdirSync(workDir, { recursive: true })
    fs.writeFileSync(configPath, JSON.stringify({
      schemaVersion: 2, channels: [], modes: { ssq: { mode: 'manual', tier: 'ssq-x1', predictAt: '17:30' }, dlt: { mode: 'manual', tier: 'dlt-x1', predictAt: '17:30' }, p3: { mode: 'manual', tier: 'p3-x1', predictAt: '17:30' } },
      time: {}, budget: { weeklyCap: 1500000 }, roles: { strategists: 1 }, effort: { tier: 'follow-host' },
      verbosity: 'concise', historyCount: 30, historyTail: 10, holidays: [],
      mind: { enabled: true }, review: { archiveAuthoritative },
    }))
    const sched = startKoiScheduler({ sessionController: { create: async () => {}, prompt: async () => {} } }, {
      dshHome: dir, configPath, dataDir, workDir, log: () => {},
      now: () => new Date('2026-11-21T22:45:00'),
      fetch: { fetchHistory: async () => [], fetchLatestDraw: async () => null },
    })
    return { sched, dataDir }
  }
  // false：零行
  const a = await mkSched(false)
  try {
    const entry = { at: '2026-11-21T09:50:00.000Z', kind: 'daily', game: 'p3', issue: '26297', date: '2026-11-21',
      picks: { digits: [6, 4, 7] }, via: 'fallback', bets: 1, cost: 2, tier: 'p3-x1', effortTier: 'economy',
      configStamp: 'cs-1', baselinePicks: { digits: [1, 2, 3] } }
    const judged = { money: 1040, grades: { 1: 1 }, bets: 1 }
    const result = { issue: '26297', date: '2026-11-21', digits: [6, 4, 7] }
    const idA = a.sched.review.onSettled(entry, judged, result)
    assert.equal(idA, null, '开关 false → 观察者零行为')
    assert.equal(Number(q(a.dataDir, 'SELECT COUNT(*) AS n FROM predictions_archive')[0].n), 0)
  } finally { a.sched.stop() }
  // true：入档 + 归因（切片 = 截至 26296 含——p3 六件内置，防前视：切片不含 26297 自身）
  const b = await mkSched(true)
  try {
    const entry = { at: '2026-11-21T09:50:00.000Z', kind: 'daily', game: 'p3', issue: '26297', date: '2026-11-21',
      picks: { digits: [6, 4, 7] }, via: 'fallback', bets: 1, cost: 2, tier: 'p3-x1', effortTier: 'economy',
      configStamp: 'cs-1', baselinePicks: { digits: [1, 2, 3] } }
    const judged = { money: 1040, grades: { 1: 1 }, bets: 1 }
    const result = { issue: '26297', date: '2026-11-21', digits: [6, 4, 7] }
    const idB = b.sched.review.onSettled(entry, judged, result)
    assert.ok(Number.isInteger(idB))
    const row = q(b.dataDir, 'SELECT * FROM predictions_archive')[0]
    assert.equal(row.game, 'p3')
    assert.equal(row.issue, '26297')
    assert.equal(JSON.parse(String(row.result)).digits.join(), '6,4,7')
    const attr = q(b.dataDir, 'SELECT factor_id, hit FROM attribution')
    assert.equal(attr.length, 6, 'p3 六件内置逐期判定（有观点 5 / 无观点如实 NULL 也入行）')
    // 防前视：连号因子对切片只见 26296（[4,5,6]），26297 自身不在切片 → 判「无连号」hit=0
    const consecutive = attr.find((x) => x.factor_id === 'builtin-consecutive-p3')
    assert.equal(consecutive.hit, 0, '切片截至上一期（含）：26297 的连号判定基于切片历史')
  } finally { b.sched.stop() }
})
