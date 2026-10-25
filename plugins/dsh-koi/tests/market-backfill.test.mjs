/**
 * 第二波 T1 + T3 —— lib/backfill.js 全量回拉引擎 + 作业锁 + 全库审计/同源抽样核验单测
 * （docs/19 §2/§3；FR-1016/FR-1017 增强、BC-104/105/112、AC-108 计数口径）。
 * fetchPage/now/sleep/store/lock 全注入，零网络；福彩窗口算术（含跨年步进）/体彩页码续拉/
 * 断点续传（双写间隙 ≤1 窗口重访）/退避 3 次/批间限速/错峰启动拒绝 + 运行中跨入暂停 + 22:30 续拉/
 * stop 中止保断点/空页 done/smoke 2 页上限/job-lock 互斥与残留锁抢占。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDrawStore } from '../lib/drawstore.js'
import { createBackfill, inOffpeakWindow } from '../lib/backfill.js'
import { createJobLock } from '../lib/joblock.js'
import { auditContinuity, crossCheckLatest } from '../lib/validate-draws.js'

const NOW_ISO = new Date('2026-10-25T12:00:00')
const NOW = () => new Date('2026-10-25T12:00:00')
const dayStr = (rank, stepDays = 2) => new Date(NOW_ISO.getTime() - rank * stepDays * 86_400_000).toLocaleDateString('sv-SE')

// ── 夹具：宇宙（源端全部存在期号，最新在前）──────────────────────────────────────
// ssq：2026 年 001–121、2025 年 001–153（上市更早年份不存在——连续 3 空窗判 done 的素材）
function buildSsqUniverse() {
  const issues = []
  for (let n = 121; n >= 1; n--) issues.push(2026000 + n)
  for (let n = 153; n >= 1; n--) issues.push(2025000 + n)
  return issues   // 最新在前（2026121 起）
}
const mkSsq = (issue, rank) => ({ issue: String(issue), date: dayStr(rank), red: [1, 2, 3, 4, 5, 6], blue: 1 })
// p3：26100–26282（183 期，pageSize=100 → 2 页满 + 第 3 页空）
function buildP3Universe() { return Array.from({ length: 183 }, (_, i) => 26282 - i) }
const mkP3 = (issue, rank) => ({ issue: String(issue), date: dayStr(rank, 1), digits: [1, 2, 3] })

const fakeLock = () => ({ acquire: () => ({ ok: true }), release() {}, heartbeat() {} })
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'koi-bf-'))

/** mock fetchPage：按源端语义返回窗口/页码内容；calls 记录每次请求参数 */
function mkFetchPage({ universe, mkEntry, pageSize = 100, onCall } = {}) {
  const calls = []
  const fetchPage = async (game, page) => {
    calls.push(page)
    onCall?.(page, calls.length)
    if (page.window) {
      const s = Number(page.window.issueStart)
      const e = Number(page.window.issueEnd)
      return universe.filter((i) => i >= s && i <= e).map((issue, i) => mkEntry(issue, i))
    }
    const pno = Number(page.pageNo)
    return universe.slice((pno - 1) * pageSize, pno * pageSize).map((issue, i) => mkEntry(issue, (pno - 1) * pageSize + i))
  }
  return { fetchPage, calls }
}

function mkSsqBackfill({ dir, universe, fetchPage, lock, readCfg, now = NOW, sleep, log, fetchLatest, store } = {}) {
  const st = store ?? createDrawStore({
    dataDir: dir, fetch: { fetchHistory: async (g, n) => universe.slice(0, n).map((issue, i) => mkSsq(issue, i)) }, now,
  })
  const bf = createBackfill({
    dataDir: dir, store: st, fetchPage, lock: lock ?? fakeLock(), now,
    sleep: sleep ?? (async () => {}), readCfg: readCfg ?? (() => ({})), log: log ?? (() => {}),
    fetchLatest: fetchLatest ?? (async () => mkSsq(universe[0], 0)),
  })
  return { bf, store: st }
}

test('错峰窗口判定：[17:00, 22:30) 内为禁算窗（BC-012）', () => {
  assert.equal(inOffpeakWindow(new Date('2026-10-25T16:59:59')), false)
  assert.equal(inOffpeakWindow(new Date('2026-10-25T17:00:00')), true)
  assert.equal(inOffpeakWindow(new Date('2026-10-25T22:29:59')), true)
  assert.equal(inOffpeakWindow(new Date('2026-10-25T22:30:00')), false)
})

test('福彩窗口算术 + 跨年步进：库内 2026001 → 首窗 issueEnd=2025400；空年段连探；连续 3 空窗判 done', async () => {
  const dir = tmpdir()
  const universe = buildSsqUniverse()
  const { fetchPage, calls } = mkFetchPage({ universe, mkEntry: mkSsq })
  const logs = []
  const { bf, store } = mkSsqBackfill({ dir, universe, fetchPage, log: (m) => logs.push(m) })
  store.upsertBatch('ssq', universe.filter((i) => i >= 2026001).map((issue, i) => mkSsq(issue, i)))   // 只种 2026 年
  const r = await bf.run('ssq')
  assert.equal(r.ok, true)
  assert.equal(r.status, 'done')
  assert.equal(r.stoppedAtEmptyStreak, true, '2024 年段连续 3 空窗 → done 并标注')
  // 首窗：windowEnd = 2026000（末三位 000 不存在区）→ 跨年步进到 2025400
  assert.equal(calls[0].window.issueEnd, '2025400')
  assert.equal(calls[0].window.issueStart, '2025301')
  // 请求数：2025 年 4 窗（301-400 空 / 201-300 空 / 101-200 有 / 001-100 有）+ 2024 年 3 空窗 = 7
  assert.equal(calls.length, 7, JSON.stringify(calls))
  assert.equal(store.status('ssq').count, 121 + 153)
  const cp = JSON.parse(fs.readFileSync(bf.CHECKPOINT_FILE, 'utf8'))
  assert.equal(cp.perGame.ssq.done, true)
  assert.equal(cp.perGame.ssq.requests, 7)
  assert.equal(cp.perGame.ssq.mode, 'window')
  assert.equal(cp.perGame.ssq.progress.note, '已拉至 2025001')
  assert.equal(cp.perGame.ssq.audit.continuity.ok, true, '2025153→2026001 跨年重排不算断档')
  assert.equal(cp.perGame.ssq.audit.crossCheck.crossCheck, 'ok')
})

test('体彩页码续拉：pageSize=100 连续翻页，第 3 页空 → done；checkpoint 记 nextPageNo/requests', async () => {
  const dir = tmpdir()
  const universe = buildP3Universe()
  const { fetchPage, calls } = mkFetchPage({ universe, mkEntry: mkP3 })
  const st = createDrawStore({ dataDir: dir, fetch: { fetchHistory: async () => [] }, now: NOW })
  const bf = createBackfill({
    dataDir: dir, store: st, fetchPage, lock: fakeLock(), now: NOW,
    sleep: async () => {}, readCfg: () => ({}), log: () => {},
    fetchLatest: async () => mkP3(26282, 0),
  })
  const r = await bf.run('p3')
  assert.equal(r.status, 'done')
  assert.deepEqual(calls.map((c) => c.pageNo), [1, 2, 3])
  assert.equal(st.status('p3').count, 183)
  const cp = JSON.parse(fs.readFileSync(bf.CHECKPOINT_FILE, 'utf8'))
  assert.equal(cp.perGame.p3.requests, 3)
  assert.equal(cp.perGame.p3.nextPageNo, 3)
  assert.equal(cp.perGame.p3.fetchedIssues, 183)
  assert.equal(cp.perGame.p3.mode, 'pageNo')
})

test('拒用留痕：批次内混入格式非法条目 → rejected 计数 + draws-rejected.log 一行一条（BC-104/S-111）', async () => {
  const dir = tmpdir()
  const universe = buildP3Universe()
  let injected = false
  const base = mkFetchPage({ universe, mkEntry: mkP3 })
  const fetchPage = async (game, page) => {
    const out = await base.fetchPage(game, page)
    if (!injected && page.pageNo === 1) { injected = true; out.push({ issue: '9999999', date: '2026-10-24', digits: [1, 2, 3] }) }
    return out
  }
  const st = createDrawStore({ dataDir: dir, fetch: { fetchHistory: async () => [] }, now: NOW })
  const bf = createBackfill({
    dataDir: dir, store: st, fetchPage, lock: fakeLock(), now: NOW,
    sleep: async () => {}, readCfg: () => ({ backfill: { targetIssues: 100 } }), log: () => {},
    fetchLatest: async () => mkP3(26282, 0),
  })
  const r = await bf.run('p3')
  assert.equal(r.status, 'done')
  assert.equal(r.earlyStop, true, 'targetIssues=100 在第 1 页后提前收口')
  const cp = JSON.parse(fs.readFileSync(bf.CHECKPOINT_FILE, 'utf8'))
  assert.equal(cp.perGame.p3.rejectedTotal, 1)
  const logText = fs.readFileSync(path.join(dir, 'draws-rejected.log'), 'utf8')
  assert.ok(logText.includes('9999999') && logText.includes('p3'), '拒用条目：期号+原因留痕')
  assert.equal(st.status('p3').count, 100, '非法条目不入库')
})

test('断点续传 + 双写间隙（AC-108 口径）：入库后崩溃未写 checkpoint → 重启重访 ≤1 页，upsert 幂等不重复入库', async () => {
  const dir = tmpdir()
  const universe = buildP3Universe()
  const { fetchPage } = mkFetchPage({ universe, mkEntry: mkP3 })
  const real = createDrawStore({ dataDir: dir, fetch: { fetchHistory: async () => [] }, now: NOW })
  let crashed = false
  const crashing = { ...real, upsertBatch(game, batch) {
    if (!crashed) {
      crashed = true
      real.upsertBatch(game, batch)          // 先真实入库……
      throw new Error('进程在入库后、checkpoint 写入前崩溃')   // ……再崩（双写间隙）
    }
    return real.upsertBatch(game, batch)
  } }
  const mkBf = (store) => createBackfill({
    dataDir: dir, store, fetchPage, lock: fakeLock(), now: NOW,
    sleep: async () => {}, readCfg: () => ({}), log: () => {}, fetchLatest: async () => mkP3(26282, 0),
  })
  const r1 = await mkBf(crashing).run('p3')
  assert.equal(r1.ok, false)
  assert.equal(r1.status, 'error')
  assert.equal(real.status('p3').count, 100, '崩溃前第 1 页已入库')
  const r2 = await mkBf(real).run('p3')
  assert.equal(r2.status, 'done')
  // 计数口径：新增（3 页）+ 续拉幂等重访（1 页）= 4 请求；库内 183 期无重复
  const cp = JSON.parse(fs.readFileSync(mkBf(real).CHECKPOINT_FILE, 'utf8'))
  assert.equal(cp.perGame.p3.requests, 4)
  assert.equal(real.status('p3').count, 183, '重访页 upsert 幂等（≤1 窗口重访）')
})

test('退避 3 次（2s/8s/30s）：福彩 4 败后窗口减半再试；体彩直接中止保断点', async () => {
  // 福彩：前 4 次全失败 → 第 5 次（窗口减半为 50）成功（batchGapMs 特置 777 与退避间隔区分）
  const dir = tmpdir()
  const universe = buildSsqUniverse()
  let fails = 0
  const sleeps = []
  const tried = []
  const { fetchPage } = mkFetchPage({ universe, mkEntry: mkSsq })
  const flaky = async (game, page) => {
    tried.push(page)
    if (fails < 4) { fails += 1; throw new Error(`HTTP 503（第 ${fails} 次）`) }
    return fetchPage(game, page)
  }
  const { bf, store } = mkSsqBackfill({
    dir, universe, fetchPage: flaky,
    sleep: async (ms) => { sleeps.push(ms) },
    readCfg: () => ({ backfill: { batchGapMs: 777 } }),
  })
  store.upsertBatch('ssq', universe.filter((i) => i >= 2026001).map((issue, i) => mkSsq(issue, i)))
  const r = await bf.run('ssq')
  assert.equal(r.ok, true)
  assert.deepEqual(sleeps.slice(0, 3), [2_000, 8_000, 30_000], '3 次重试间隔 2s/8s/30s')
  assert.ok(sleeps.slice(3).every((x) => x === 777), '后续 sleep 全为批间隔（退避不再出现）')
  assert.equal(fails, 4, '恰好 4 次失败（1 初始 + 3 重试）后窗口减半')
  assert.equal(tried.length, 7, '4 败 + 减半成功（空窗）+ 2 个后续空窗 → 连续 3 空窗 done')
  assert.ok(tried.slice(4).every((p) => Number(p.window.issueEnd) - Number(p.window.issueStart) === 49), '减半后窗口宽 50')
  // 体彩：不可减页 → 4 次尝试后中止
  const dir2 = tmpdir()
  let fails2 = 0
  const st2 = createDrawStore({ dataDir: dir2, fetch: { fetchHistory: async () => [] }, now: NOW })
  const bf2 = createBackfill({
    dataDir: dir2, store: st2,
    fetchPage: async () => { fails2 += 1; throw new Error('网络不通') },
    lock: fakeLock(), now: NOW, sleep: async () => {}, readCfg: () => ({}), log: () => {},
  })
  const r2 = await bf2.run('dlt')
  assert.equal(r2.ok, false)
  assert.equal(r2.status, 'error')
  assert.equal(fails2, 4, '1 次初始 + 3 次重试')
  const cp2 = JSON.parse(fs.readFileSync(bf2.CHECKPOINT_FILE, 'utf8'))
  assert.ok(cp2.perGame.dlt.lastErr.includes('网络不通'), '中止信息写 checkpoint.lastErr（S-111）')
})

test('批间限速：成功批之间 sleep(batchGapMs)（默认 2000，礼貌秒级间隔）', async () => {
  const dir = tmpdir()
  const universe = buildP3Universe()
  const { fetchPage } = mkFetchPage({ universe, mkEntry: mkP3 })
  const sleeps = []
  const st = createDrawStore({ dataDir: dir, fetch: { fetchHistory: async () => [] }, now: NOW })
  const bf = createBackfill({
    dataDir: dir, store: st, fetchPage, lock: fakeLock(), now: NOW,
    sleep: async (ms) => { sleeps.push(ms) }, readCfg: () => ({}), log: () => {},
    fetchLatest: async () => mkP3(26282, 0),
  })
  await bf.run('p3')
  assert.deepEqual(sleeps, [2_000, 2_000], '2 个成功批后各一次间隔（空页 done 后不加）')
})

test('错峰启动拒绝：17:00–22:30 内 run 直接拒绝（零请求），--no-offpeak 显式越过', async () => {
  const dir = tmpdir()
  const universe = buildP3Universe()
  const { fetchPage, calls } = mkFetchPage({ universe, mkEntry: mkP3 })
  const st = createDrawStore({ dataDir: dir, fetch: { fetchHistory: async () => [] }, now: NOW })
  const evening = () => new Date('2026-10-25T18:00:00')
  const bf = createBackfill({
    dataDir: dir, store: st, fetchPage, lock: fakeLock(), now: evening,
    sleep: async () => {}, readCfg: () => ({}), log: () => {},
  })
  const r = await bf.run('p3')
  assert.equal(r.ok, false)
  assert.equal(r.code, 400)
  assert.ok(r.error.includes('错峰窗口（17:00–22:30）'), r.error)
  assert.equal(calls.length, 0, '零请求')
  // noOffpeak 显式越过（仅限显式指令）
  const r2 = await bf.run('p3', { noOffpeak: true })
  assert.equal(r2.ok, true)
  assert.ok(calls.length >= 1)
})

test('运行中跨入暂停 + 22:30 自动续拉（16:35 启动场景）：paused-offpeak 留痕，断点保留后续完', async () => {
  const dir = tmpdir()
  const universe = buildP3Universe()
  const { fetchPage } = mkFetchPage({ universe, mkEntry: mkP3 })
  let clock = new Date('2026-10-25T16:35:00')
  const pausePolls = []
  const st = createDrawStore({ dataDir: dir, fetch: { fetchHistory: async () => [] }, now: () => clock })
  let pageNo = 0
  const bf = createBackfill({
    dataDir: dir, store: st,
    fetchPage: async (g, p) => { pageNo = p.pageNo; if (p.pageNo === 2) clock = new Date('2026-10-25T17:10:00'); return fetchPage(g, p) },
    lock: fakeLock(), now: () => clock,
    sleep: async (ms) => { if (ms === 30_000) pausePolls.push(ms); clock = new Date(clock.getTime() + ms) },
    readCfg: () => ({}), log: () => {},
    fetchLatest: async () => mkP3(26282, 0),
  })
  const r = await bf.run('p3')
  assert.equal(r.status, 'done', '暂停后自动续拉至完成')
  assert.ok(pausePolls.length >= 600, `暂停期按 30s 复检（实际 ${pausePolls.length} 轮）`)
  assert.ok(clock.getTime() - Date.parse('2026-10-25T22:30:00') >= 0, '时钟已越过 22:30')
  const cp = JSON.parse(fs.readFileSync(bf.CHECKPOINT_FILE, 'utf8'))
  assert.equal(cp.perGame.p3.requests, 3)
  assert.equal(st.status('p3').count, 183)
})

test('stop 中止保断点：当前批完成后退出 → 断点保留 → 重启续拉完成（幂等不重复）', async () => {
  const dir = tmpdir()
  const universe = buildP3Universe()
  const { fetchPage, calls } = mkFetchPage({ universe, mkEntry: mkP3 })
  const st = createDrawStore({ dataDir: dir, fetch: { fetchHistory: async () => [] }, now: NOW })
  const mkBf = () => createBackfill({
    dataDir: dir, store: st, fetchPage, lock: fakeLock(), now: NOW,
    sleep: async () => {}, readCfg: () => ({}), log: () => {}, fetchLatest: async () => mkP3(26282, 0),
  })
  let bf = mkBf()
  const stopping = async (game, page) => { const out = await fetchPage(game, page); if (page.pageNo === 1) bf.stop(); return out }
  // 用会触发 stop 的 fetchPage 重打一次
  const bf1 = createBackfill({
    dataDir: dir, store: st, fetchPage: stopping, lock: fakeLock(), now: NOW,
    sleep: async () => {}, readCfg: () => ({}), log: () => {}, fetchLatest: async () => mkP3(26282, 0),
  })
  bf = bf1
  const r1 = await bf1.run('p3')
  assert.equal(r1.status, 'stopped')
  assert.equal(r1.stopped, true)
  assert.equal(st.status('p3').count, 100, '当前批完成入库后退出')
  const cp1 = JSON.parse(fs.readFileSync(bf1.CHECKPOINT_FILE, 'utf8'))
  assert.equal(cp1.perGame.p3.requests, 1)
  assert.equal(cp1.perGame.p3.nextPageNo, 2, '断点保留')
  // 重启续拉：从第 2 页继续，完成
  const r2 = await mkBf().run('p3')
  assert.equal(r2.status, 'done')
  assert.equal(st.status('p3').count, 183)
  assert.equal(calls.length, 3, '总请求 = 首页 1 + 续拉 2（不重复拉第 1 页）')
})

test('smoke：每彩种最多 2 页 + 抽样核验 1 请求（B 阶段唯一允许的真实触达规模）', async () => {
  const dir = tmpdir()
  const universe = buildP3Universe()
  const { fetchPage, calls } = mkFetchPage({ universe, mkEntry: mkP3 })
  let latestCalls = 0
  const st = createDrawStore({ dataDir: dir, fetch: { fetchHistory: async () => [] }, now: NOW })
  const bf = createBackfill({
    dataDir: dir, store: st, fetchPage, lock: fakeLock(), now: NOW,
    sleep: async () => {}, readCfg: () => ({}), log: () => {},
    fetchLatest: async () => { latestCalls += 1; return mkP3(26282, 0) },
  })
  const r = await bf.run('p3', { smoke: true })
  assert.equal(r.status, 'smoke-done')
  assert.equal(r.smoke, true)
  assert.equal(calls.length, 2, '最多 2 页')
  assert.equal(latestCalls, 1, '抽样核验恰好 1 个额外请求')
  const cp = JSON.parse(fs.readFileSync(bf.CHECKPOINT_FILE, 'utf8'))
  assert.equal(cp.perGame.p3.done, false, 'smoke 不置 done（不宣称全量完成）')
  assert.equal(cp.perGame.p3.audit.crossCheck.crossCheck, 'ok')
})

test('smoke 请求预算含空窗探测：ssq 跨年空段下每彩种仍 ≤2 页请求（真实冒烟发现的修正）', async () => {
  const dir = tmpdir()
  const universe = buildSsqUniverse()   // 2025 只有 001–153：跨年步进后必遇连续空窗
  const { fetchPage, calls } = mkFetchPage({ universe, mkEntry: mkSsq })
  const { bf, store } = mkSsqBackfill({ dir, universe, fetchPage })
  store.upsertBatch('ssq', universe.filter((i) => i >= 2026100).map((issue, i) => mkSsq(issue, i)))   // 只种最近 22 期
  const r = await bf.run('ssq', { smoke: true })
  assert.equal(r.status, 'smoke-done')
  assert.ok(calls.length <= 2, `smoke 每彩种请求 ≤2（含空窗探测；实际 ${calls.length}）`)
})

test('进程内并发守卫：同彩种已在拉 → 「正在拉取中」（409 语义）', async () => {
  const dir = tmpdir()
  const universe = buildP3Universe()
  const base = mkFetchPage({ universe, mkEntry: mkP3 })
  let release
  const gate = new Promise((r) => { release = r })
  const st = createDrawStore({ dataDir: dir, fetch: { fetchHistory: async () => [] }, now: NOW })
  const bf = createBackfill({
    dataDir: dir, store: st,
    fetchPage: async (g, p) => { if (p.pageNo === 1) { await gate; return base.fetchPage(g, p) } return base.fetchPage(g, p) },
    lock: fakeLock(), now: NOW, sleep: async () => {}, readCfg: () => ({}), log: () => {},
    fetchLatest: async () => mkP3(26282, 0),
  })
  const p1 = bf.run('p3')
  const r2 = await bf.run('p3')
  assert.equal(r2.ok, false)
  assert.equal(r2.code, 409)
  assert.equal(r2.error, '正在拉取中')
  release()
  const r1 = await p1
  assert.equal(r1.ok, true)
})

// ── 作业锁（W2A-20：backfill/ingest/backtest 三类互斥 + 心跳 + 残留锁抢占）─────────

test('joblock：acquire/heartbeat/release 落盘互斥；跨实例持锁 → 拒绝；残留锁（心跳 >30 分钟）→ 抢占留痕', () => {
  const dir = tmpdir()
  const file = path.join(dir, 'koi', 'job-lock.json')
  let clock = new Date('2026-10-25T12:00:00')
  const now = () => clock
  const a = createJobLock({ file, now })
  const r = a.acquire('backfill', 'ssq')
  assert.equal(r.ok, true)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).kind, 'backfill')
  // 另一实例（宿主进程视角）抢 → 拒绝并告知占用者
  const b = createJobLock({ file, now })
  const r2 = b.acquire('ingest', 'ing-1')
  assert.equal(r2.ok, false)
  assert.deepEqual(r2.held, { kind: 'backfill', key: 'ssq' })
  // 心跳推进 10 分钟 → 仍拒
  clock = new Date(clock.getTime() + 10 * 60_000)
  a.heartbeat()
  assert.equal(createJobLock({ file, now }).acquire('backtest', 'bt').ok, false)
  // 心跳停更 31 分钟 → 残留锁可抢占 + 留痕（preemptedOver）
  clock = new Date(clock.getTime() + 31 * 60_000)
  const r3 = createJobLock({ file, now }).acquire('ingest', 'ing-2')
  assert.equal(r3.ok, true)
  assert.equal(r3.preempted.kind, 'backfill')
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(rec.preemptedOver.kind, 'backfill', '抢占痕迹写入锁记录')
  // 抢占者的锁仍新鲜 → 再抢被拒；释放（ing-2 完成）后可获取
  assert.equal(createJobLock({ file, now }).acquire('backfill', 'x').ok, false, '新持锁者未停更前不可再抢')
  fs.rmSync(file)
  // release 删文件；同实例重复 acquire 被自持拒绝
  const c = createJobLock({ file, now })
  assert.equal(c.acquire('backfill', 'x').ok, true)
  assert.equal(c.acquire('ingest', 'y').ok, false, '同进程第二类作业也被互斥')
  c.release()
  assert.equal(fs.existsSync(file), false)
  assert.equal(createJobLock({ file, now }).acquire('ingest', 'z').ok, true)
})

test('backfill × joblock 集成：锁被 ingest 占用 → 409 排队语义；锁释放后可跑', async () => {
  const dir = tmpdir()
  const lockFile = path.join(dir, 'koi', 'job-lock.json')
  const universe = buildP3Universe()
  const { fetchPage, calls } = mkFetchPage({ universe, mkEntry: mkP3 })
  fs.mkdirSync(path.dirname(lockFile), { recursive: true })
  fs.writeFileSync(lockFile, JSON.stringify({ kind: 'ingest', key: 'ing-1', at: NOW_ISO.toISOString(), heartbeatAt: NOW_ISO.toISOString() }))
  const st = createDrawStore({ dataDir: dir, fetch: { fetchHistory: async () => [] }, now: NOW })
  const bf = createBackfill({
    dataDir: dir, store: st, fetchPage, lock: createJobLock({ file: lockFile, now: NOW }), now: NOW,
    sleep: async () => {}, readCfg: () => ({}), log: () => {}, fetchLatest: async () => mkP3(26282, 0),
  })
  const r = await bf.run('p3')
  assert.equal(r.ok, false)
  assert.equal(r.code, 409)
  assert.ok(r.error.includes('另一后台作业进行中（ingest/ing-1）'), r.error)
  assert.equal(calls.length, 0)
  // 释放后可跑（真实 run 结束后锁文件被删）
  fs.rmSync(lockFile)
  const r2 = await bf.run('p3')
  assert.equal(r2.ok, true)
  assert.equal(fs.existsSync(lockFile), false, '正常结束释放锁')
})

// ── T3：全库连续性审计 + 同源抽样核验（§3.1/§3.2，FR-1017 增强 / MA-23 口径）───────

test('auditContinuity：同年断档定位正确；跨年重排不算 gap；乱序输入稳定', () => {
  const e = (issue) => ({ issue: String(issue) })
  const ok = auditContinuity([e(26280), e(26281), e(26282)])
  assert.equal(ok.ok, true)
  assert.equal(ok.count, 3)
  const gap = auditContinuity([e(26282), e(26280), e(26279)])
  assert.equal(gap.ok, false)
  assert.deepEqual(gap.gaps[0].between, ['26280', '26282'])
  assert.ok(gap.gaps[0].note.includes('差 2'))
  // 跨年重排放行（福彩 4 位年 / 体彩 2 位年）
  assert.equal(auditContinuity([e(2026153), e(2027001)]).ok, true)
  assert.equal(auditContinuity([e(26365), e(27001)]).ok, true)
  // 乱序输入：内部升序后判定（26278–26280 连续，缺 26281）
  const shuffled = auditContinuity([e(26282), e(26278), e(26279), e(26280)])
  assert.equal(shuffled.ok, false)
  assert.deepEqual(shuffled.gaps[0].between, ['26280', '26282'])
})

test('crossCheckLatest：一致 → ok；号码不一致 → mismatch 留痕；库落后（期号不同）如实记录；拉取失败不误报', async () => {
  const dir = tmpdir()
  const store = createDrawStore({ dataDir: dir, fetch: { fetchHistory: async () => [] }, now: NOW })
  store.upsertBatch('p3', [mkP3(26282, 0), mkP3(26281, 1)])
  // 一致
  const ok = await crossCheckLatest(store, { fetchLatestDraw: async () => mkP3(26282, 0) }, 'p3')
  assert.equal(ok.crossCheck, 'ok')
  assert.equal(ok.mismatch, false)
  assert.ok(ok.note.includes('抽样核验（最新 1 期'))
  // 号码不一致 → mismatch（BC-104 留痕，绝不静默）
  const bad = await crossCheckLatest(store, { fetchLatestDraw: async () => ({ ...mkP3(26282, 0), digits: [9, 9, 9] }) }, 'p3')
  assert.equal(bad.crossCheck, 'mismatch')
  assert.equal(bad.mismatch, true)
  assert.ok(bad.detail.includes('位数不一致'))
  // 日期不一致
  const badDate = await crossCheckLatest(store, { fetchLatestDraw: async () => ({ ...mkP3(26282, 0), date: '2026-10-20' }) }, 'p3')
  assert.equal(badDate.crossCheck, 'mismatch')
  assert.ok(badDate.detail.includes('日期'))
  // 库落后（官方已到下一期）→ issue-differs 如实记录
  const behind = await crossCheckLatest(store, { fetchLatestDraw: async () => mkP3(26283, 0) }, 'p3')
  assert.equal(behind.crossCheck, 'issue-differs')
  // 拉取失败 → ok:false（不误报一致）
  const fail = await crossCheckLatest(store, { fetchLatestDraw: async () => { throw new Error('超时') } }, 'p3')
  assert.equal(fail.ok, false)
  assert.equal(fail.crossCheck, 'fetch-error')
  // 空库
  const empty = await crossCheckLatest(store, { fetchLatestDraw: async () => mkP3(26282, 0) }, 'ssq')
  assert.equal(empty.ok, false)
})

test('checkpoint 字段级形状（§2.2）：schemaVersion/perGame 每彩种完整字段', async () => {
  const dir = tmpdir()
  const universe = buildP3Universe()
  const { fetchPage } = mkFetchPage({ universe, mkEntry: mkP3 })
  const st = createDrawStore({ dataDir: dir, fetch: { fetchHistory: async () => [] }, now: NOW })
  const bf = createBackfill({
    dataDir: dir, store: st, fetchPage, lock: fakeLock(), now: NOW,
    sleep: async () => {}, readCfg: () => ({}), log: () => {}, fetchLatest: async () => mkP3(26282, 0),
  })
  await bf.run('p3', { smoke: true })
  const cp = JSON.parse(fs.readFileSync(bf.CHECKPOINT_FILE, 'utf8'))
  assert.equal(cp.schemaVersion, 1)
  const pg = cp.perGame.p3
  for (const f of ['done', 'mode', 'nextPageNo', 'fetchedIssues', 'targetIssues', 'pages', 'requests', 'rejectedTotal', 'lastBatchAt', 'progress', 'audit']) {
    assert.ok(f in pg, `checkpoint.perGame.p3 缺字段 ${f}`)
  }
  assert.equal(pg.targetIssues, null)
  assert.ok(pg.lastBatchAt)
  assert.equal(typeof bf.status().perGame.p3.requests, 'number')
})
