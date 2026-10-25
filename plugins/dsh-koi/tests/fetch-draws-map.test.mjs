/**
 * v0.2-B1 T-14 —— fetch-draws 字段映射夹具测试（fetch-draws.mjs:54-72 mapCwlItem/mapSportteryItem
 * 与 :80-121 fetchHistory/fetchHistoryPage 的映射段回归网；docs/22 P11②）。
 *
 * 动机：映射段是信任边界上游——期号/切片错位可产出「错但合规」的号码（如 dlt 后区切到前区
 * 仍过值域校验），下游 validate-draws 拦不住。全局 fetch 桩 + fixture JSON，零网络。
 * 夹具与 lib/golden-fixtures.js 同源口径（SSQ 2026121 / DLT 26120 / P3=排列五 26282 前三位）。
 * 桩形态：jget 走 fetch(url,{headers,signal}) → res.ok → res.arrayBuffer() → utf8 JSON.parse；
 * 本桩按 URL 分发（cwl.gov.cn vs webapi.sporttery.cn + gameNo），不改变被测代码路径。
 */
import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { fetchHistory, fetchHistoryPage } from '../lib/fetch-draws.mjs'

// ── 原始 API 形态夹具（字段名/形态照真实接口，仅数据为金样本同源）────────────────
const CWL_SSQ_ITEMS = [
  {
    code: '2026121', date: '2026-10-22 00:00:00', red: '02,07,20,24,26,30', blue: '2',
    prizegrades: [
      { type: '1', typemoney: '10000000' },     // 福彩 API 数字串（无逗号；带逗号归一是体彩路径 parseSportteryPrizes 的职责）
      { type: '3', typemoney: '3000' },
      { type: '9', typemoney: '0' },            // 0 元 → 过滤不出场
    ],
  },
]
const SPORTTERY_DLT_ITEMS = [
  { lotteryDrawNum: '26120', lotteryDrawTime: '2026-10-21 10:00:00', lotteryDrawResult: '01 06 10 15 32 03 04' },
]
const SPORTTERY_P3_ITEMS = [
  { lotteryDrawNum: '26282', lotteryDrawTime: '2026-10-23 21:25:00', lotteryDrawResult: '6 4 7 9 2' },  // 排列五行
]

const jsonResponse = (obj) => ({
  ok: true, status: 200,
  arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(obj)).buffer,
})

const realFetch = globalThis.fetch
let fetchCalls = []
beforeEach(() => { fetchCalls = [] })
afterEach(() => { globalThis.fetch = realFetch })

function stubFetch(handler) {
  globalThis.fetch = async (url, opts) => {
    fetchCalls.push({ url: String(url), opts })
    return handler(String(url))
  }
}

const installApiStub = () => stubFetch((url) => {
  if (url.includes('cwl.gov.cn')) return jsonResponse({ result: CWL_SSQ_ITEMS })
  if (url.includes('sporttery.cn')) {
    if (url.includes('gameNo=85')) return jsonResponse({ value: { list: SPORTTERY_DLT_ITEMS } })
    if (url.includes('gameNo=350133')) return jsonResponse({ value: { list: SPORTTERY_P3_ITEMS } })
  }
  throw new Error('桩外 URL 不应被抓取: ' + url)
})

// ── mapCwlItem（经 fetchHistory('ssq') 与 fetchHistoryPage('ssq', window) 双入口）──

test('SSQ 映射：期号 String / 日期 slice(0,10) / 红球逗号拆数 / 蓝 Number / 奖级 type→Number 键且 0 元过滤', async () => {
  installApiStub()
  const [it] = await fetchHistory('ssq', 30)
  assert.equal(it.issue, '2026121')
  assert.equal(it.date, '2026-10-22')
  assert.deepEqual(it.red, [2, 7, 20, 24, 26, 30])
  assert.equal(it.blue, 2)
  assert.deepEqual(it.prizeGrades, { 1: 10_000_000, 3: 3000 }, '奖级键转 Number、逗号金额归一、0 元项不出场')
})

test('SSQ 深分页映射与 fetchHistory 同源（window.issueStart/issueEnd 成对必传，否则拒绝）', async () => {
  installApiStub()
  const items = await fetchHistoryPage('ssq', { window: { issueStart: '2026100', issueEnd: '2026121' } })
  assert.equal(items.length, 1)
  assert.deepEqual(items[0], {
    issue: '2026121', date: '2026-10-22', red: [2, 7, 20, 24, 26, 30], blue: 2, prizeGrades: { 1: 10_000_000, 3: 3000 },
  })
  await assert.rejects(() => fetchHistoryPage('ssq', { window: { issueStart: '2026100' } }), /issueStart\/issueEnd/)
})

// ── mapSportteryItem（dlt 切前 5+2；p3 取排列五前三位——核心切片规则）─────────────

test('DLT 映射：7 个号码切 front[0:5] + back[5:7]，期号/日期同源规则', async () => {
  installApiStub()
  const [it] = await fetchHistory('dlt', 30)
  assert.deepEqual(it, { issue: '26120', date: '2026-10-21', front: [1, 6, 10, 15, 32], back: [3, 4] })
})

test('P3 映射：排列五 5 位取前三位 digits[0:3]（错位=「错但合规」高危点的回归锚）', async () => {
  installApiStub()
  const [it] = await fetchHistory('p3', 30)
  assert.deepEqual(it, { issue: '26282', date: '2026-10-23', digits: [6, 4, 7] })
})

test('体彩深分页：pageNo 必传；映射与 fetchHistory 逐字段一致（pageSize=100 路径）', async () => {
  installApiStub()
  const dlt = await fetchHistoryPage('dlt', { pageNo: 2 })
  assert.deepEqual(dlt, [{ issue: '26120', date: '2026-10-21', front: [1, 6, 10, 15, 32], back: [3, 4] }])
  const p3 = await fetchHistoryPage('p3', { pageNo: 7 })
  assert.deepEqual(p3, [{ issue: '26282', date: '2026-10-23', digits: [6, 4, 7] }])
  await assert.rejects(() => fetchHistoryPage('dlt', {}), /pageNo/)
})

test('空列表与未知彩种：非数组 result/list 按 [] 返回；未知 gameKey 拒绝（不出「错但合规」数据）', async () => {
  stubFetch(() => jsonResponse({ result: null, value: null }))
  assert.deepEqual(await fetchHistory('ssq', 5), [], 'result 非数组 → 空数组')
  assert.deepEqual(await fetchHistory('dlt', 5), [], 'value.list 缺席 → 空数组')
  stubFetch(() => jsonResponse({}))
  assert.deepEqual(await fetchHistoryPage('ssq', { window: { issueStart: '1', issueEnd: '2' } }), [])
  await assert.rejects(() => fetchHistory('ssq5', 5), /未知彩种/)
  await assert.rejects(() => fetchHistoryPage('ssq5', { pageNo: 1 }), /未知彩种/)
})
