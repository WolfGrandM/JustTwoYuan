/**
 * 市场版 T3 —— 校验公共层 + 本地开奖库（FR-1017/FR-1024/BC-104/105）单测。
 * 四项校验各注入反例逐一拒用；mock fetch 下空库冷启动→入库→二次请求网络计数=0（AC-115）；upsert 幂等。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { validateDraws } from '../lib/validate-draws.js'
import { createDrawStore } from '../lib/drawstore.js'
import { isStaleDraw } from '../lib/scheduler.js'

const TODAY = '2026-10-25'
const goodSSQ = { issue: '2026121', date: '2026-10-22', red: [2, 7, 20, 24, 26, 30], blue: 2 }

test('校验①期号格式：ssq 7 位 / 体彩 5 位；非法格式拒用', () => {
  const r = validateDraws('ssq', [{ ...goodSSQ, issue: '26121' }], { today: TODAY })
  assert.equal(r.ok, false); assert.match(r.rejected[0].reason, /期号格式/)
  const r2 = validateDraws('dlt', [{ issue: '2026121', date: '2026-10-21', front: [1, 6, 10, 15, 32], back: [3, 4] }], { today: TODAY })
  assert.equal(r2.ok, false)
  assert.equal(validateDraws('p3', [{ issue: '26282', date: '2026-10-23', digits: [6, 4, 7] }], { today: TODAY }).ok, true)
})

test('校验②日期：不可解析/未来日期拒用；正常历史日期放行', () => {
  assert.equal(validateDraws('ssq', [{ ...goodSSQ, date: 'not-a-date' }], { today: TODAY }).ok, false)
  assert.equal(validateDraws('ssq', [{ ...goodSSQ, date: '2026-12-31' }], { today: TODAY }).ok, false, '未来日期=假数据')
  assert.equal(validateDraws('ssq', [goodSSQ], { today: TODAY }).ok, true)
})

test('校验③号码值域：红/蓝/前/后/位越界与个数不符逐一拒用', () => {
  assert.equal(validateDraws('ssq', [{ ...goodSSQ, red: [2, 7, 20, 24, 26, 34] }], { today: TODAY }).ok, false)
  assert.equal(validateDraws('ssq', [{ ...goodSSQ, blue: 17 }], { today: TODAY }).ok, false)
  assert.equal(validateDraws('ssq', [{ ...goodSSQ, red: [2, 7, 20, 24, 26] }], { today: TODAY }).ok, false, '个数不符')
  const dlt = { issue: '26120', date: '2026-10-21', front: [1, 6, 10, 15, 36], back: [3, 4] }
  assert.equal(validateDraws('dlt', [dlt], { today: TODAY }).ok, false, '前区越界 36')
  assert.equal(validateDraws('p3', [{ issue: '26282', date: '2026-10-23', digits: [6, 4, 10] }], { today: TODAY }).ok, false, '位越界')
})

test('校验④连续性：同年断档拒用；跨年重排放行（2026153→2027001 / 26153→27001）；倒挂拒用；单条/重复处理', () => {
  // 同年断档
  const gap = [
    { issue: '2026121', date: '2026-10-22', red: [1, 2, 3, 4, 5, 6], blue: 1 },
    { issue: '2026119', date: '2026-10-18', red: [1, 2, 3, 4, 5, 7], blue: 2 },
  ]
  const r = validateDraws('ssq', gap, { today: TODAY })
  assert.equal(r.ok, false); assert.equal(r.rejected[0].reason.includes('断档') || r.rejected[0].reason.includes('不连续'), true)
  assert.equal(r.valid.length, 0, '断档涉事两条均拒（保守）')
  // 连续正常
  const ok = [...gap, { issue: '2026120', date: '2026-10-20', red: [1, 2, 3, 4, 5, 8], blue: 3 }]
  assert.equal(validateDraws('ssq', ok, { today: TODAY }).ok, true)
  // 跨年重排放行（福彩 4 位年）
  const crossSSQ = [
    { issue: '2027001', date: '2027-01-01', red: [1, 2, 3, 4, 5, 6], blue: 1 },
    { issue: '2026153', date: '2026-12-31', red: [1, 2, 3, 4, 5, 7], blue: 2 },
  ]
  assert.equal(validateDraws('ssq', crossSSQ, { today: '2027-06-01' }).ok, true, '跨年重排放行')
  // 体彩 2 位年跨年
  const crossP3 = [
    { issue: '27001', date: '2027-01-01', digits: [1, 2, 3] },
    { issue: '26365', date: '2026-12-31', digits: [4, 5, 6] },
  ]
  assert.equal(validateDraws('p3', crossP3, { today: '2027-06-01' }).ok, true)
  // 倒挂（传入顺序乱不影响：内部排序后单调性破坏指真实的期号关系错乱）
  const wrong = [
    { issue: '26282', date: '2026-10-23', digits: [6, 4, 7] },
    { issue: '26283', date: '2026-10-24', digits: [1, 2, 3] },
    { issue: '26280', date: '2026-10-21', digits: [9, 9, 9] },   // 283→280 断档
  ]
  const rw = validateDraws('p3', wrong, { today: TODAY })
  assert.equal(rw.ok, false)
  // 单条无连续性可判 → 通过；重复期号拒
  assert.equal(validateDraws('ssq', [goodSSQ], { today: TODAY }).ok, true)
  const dup = validateDraws('ssq', [goodSSQ, { ...goodSSQ }], { today: TODAY })
  assert.equal(dup.ok, false); assert.equal(dup.rejected[0].reason, '期号重复')
})

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'koi-store-'))
const mkHistory = (n, startIssue = 2026121) => Array.from({ length: n }, (_, i) => ({
  issue: String(startIssue - i),
  date: new Date(Date.parse('2026-10-25') - i * 86_400_000).toLocaleDateString('sv-SE'),
  red: [1, 2, 3, 4, 5, 6], blue: (i % 16) + 1,
}))

test('drawstore：空库冷启动按需抓取→校验入库；二次请求网络计数=0（AC-115）；upsert 幂等去重', async () => {
  const dir = tmpdir()
  let calls = 0
  const fetch = { async fetchHistory(game, count) { calls++; return mkHistory(Math.min(count, 30)) } }
  const store = createDrawStore({ dataDir: dir, fetch, now: () => new Date('2026-10-25T12:00:00') })
  // 冷启动：空库 → 在线抓取 30 期 → 入库
  const r1 = await store.ensureRecent('ssq', 30)
  assert.equal(r1.fetched, 1); assert.equal(calls, 1)
  assert.equal(r1.history.length, 30)
  assert.equal(r1.history[0].issue, '2026121', '最新在前（fetchHistory 同序）')
  assert.equal(store.status('ssq').count, 30)
  // 二次请求：库足且新鲜 → 零网络
  const r2 = await store.ensureRecent('ssq', 30)
  assert.equal(r2.fetched, 0); assert.equal(calls, 1, '网络计数=0')
  assert.deepEqual(r2.history[0], r1.history[0])
  // 幂等：重复 upsert 同批次不加条目
  const before = store.status('ssq').count
  const up = store.upsertBatch('ssq', mkHistory(30))
  assert.equal(store.status('ssq').count, before, 'upsert 幂等（去重键 issue）')
  assert.equal(up.total, before)
  // 拒用记录：注入断档批次 → rejected 返回且不入库
  const bad = store.upsertBatch('ssq', [
    { issue: '2026200', date: '2026-10-24', red: [1, 2, 3, 4, 5, 6], blue: 1 },
    { issue: '2026198', date: '2026-10-22', red: [1, 2, 3, 4, 5, 7], blue: 2 },
  ])
  assert.equal(bad.rejected.length, 2)
  assert.equal(store.status('ssq').count, before)
  // 文件形状：升序 + schemaVersion 1
  const j = JSON.parse(fs.readFileSync(store.fileOf('ssq'), 'utf8'))
  assert.equal(j.schemaVersion, 1)
  assert.equal(j.entries.length, before)
  assert.ok(Number(j.entries[0].issue) < Number(j.entries[before - 1].issue), '升序存')
})

test('drawstore：本地库陈旧（>7 天）触发补拉；抓取失败报清晰错误（S-117）；getRecent 切片', async () => {
  const dir = tmpdir()
  let calls = 0
  const fetch = { async fetchHistory(game, count) { calls++; return mkHistory(count) } }
  // 本地只有旧数据（最新 2026-10-10，距今 15 天 → 陈旧）
  const store = createDrawStore({ dataDir: dir, fetch, now: () => new Date('2026-10-25T12:00:00') })
  store.upsertBatch('ssq', [{ issue: '2026100', date: '2026-10-10', red: [1, 2, 3, 4, 5, 6], blue: 1 }])
  assert.equal(store.status('ssq').fresh, false, 'isStaleDraw >7 天 → 陈旧')
  const r = await store.ensureRecent('ssq', 30)
  assert.equal(r.fetched, 1); assert.equal(calls, 1)
  assert.equal(store.status('ssq').fresh, true)
  // 抓取失败：清空目录模拟（用第二个 store 指向空目录 + 恒失败 fetch）
  const failStore = createDrawStore({
    dataDir: tmpdir(), fetch: { async fetchHistory() { throw new Error('网络不通') } },
    now: () => new Date('2026-10-25T12:00:00'),
  })
  await assert.rejects(() => failStore.ensureRecent('ssq', 30), /本地库不足且在线抓取失败/)
  // getRecent 切片 n 条
  assert.equal(store.getRecent('ssq', 5).length, 5)
  assert.equal(store.getRecent('ssq', 5)[0].issue, '2026121')
})

test('新鲜度探针沿用 isStaleDraw（FR-008 口径，>7 天 ✗）', () => {
  assert.equal(isStaleDraw('2026-10-24', TODAY), false)
  assert.equal(isStaleDraw('2026-10-18', TODAY), false, '恰 7 天不算失败')
  assert.equal(isStaleDraw('2026-10-17', TODAY), true, '8 天 → 陈旧')
})
