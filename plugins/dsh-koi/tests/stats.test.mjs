/** 统计层与提示词测试 —— 数据包能造出来、字段齐全、AI 契约里的关键约束都在 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dataPack } from '../lib/stats.js'
import { buildPredictPrompt, DEFAULT_PERSONA, fallbackMessage } from '../lib/prompt.js'
import { estTokens, createUsageTracker } from '../lib/usage.js'
import { DISCLAIMER } from '../lib/insight.js'

const SSQ_HISTORY = [
  { issue: '2026121', date: '2026-10-22', red: [2, 7, 20, 24, 26, 30], blue: 2, prizeGrades: { 3: 3000 } },
  { issue: '2026120', date: '2026-10-20', red: [13, 14, 16, 18, 20, 31], blue: 3, prizeGrades: {} },
  { issue: '2026119', date: '2026-10-18', red: [2, 5, 11, 19, 26, 33], blue: 7, prizeGrades: {} },
]
const P3_HISTORY = [
  { issue: '26282', date: '2026-10-23', digits: [6, 4, 7] },
  { issue: '26281', date: '2026-10-22', digits: [0, 9, 3] },
  { issue: '26280', date: '2026-10-21', digits: [6, 1, 7] },
]

test('双色球数据包：遗漏/频次/最冷最热/流水都在', () => {
  const pack = dataPack('ssq', SSQ_HISTORY)
  assert.ok(pack.includes('【红球遗漏/频次表】'))
  assert.ok(pack.includes('遗0'))            // 上期刚开的号遗漏为 0
  assert.ok(pack.includes('【红球最冷】'))
  assert.ok(pack.includes('【红球最热】'))
  assert.ok(pack.includes('【蓝球遗漏/频次表】'))
  assert.ok(pack.includes('和值'))            // 近 10 期流水带和值/奇偶/大小
})

test('排列三数据包：按位统计 + 流水', () => {
  const pack = dataPack('p3', P3_HISTORY)
  assert.ok(pack.includes('【百位】'))
  assert.ok(pack.includes('【十位】'))
  assert.ok(pack.includes('【个位】'))
  assert.ok(pack.includes('647 093 617'))    // 近期流水原样列出
})

test('数据包：历史为空给兜底话术，不炸', () => {
  const pack = dataPack('ssq', [])
  assert.ok(pack.includes('历史数据抓取失败'))
})

test('提示词：含人设、期号、文件契约与硬规则', () => {
  const p = buildPredictPrompt({
    gameKey: 'ssq', cfg: {}, history: SSQ_HISTORY, issue: '2026122',
    outPath: '/tmp/koi-work/predict-ssq-2026-10-25.json', late: false,
  })
  assert.ok(p.includes('锦鲤'))
  assert.ok(p.includes('2026122'))
  assert.ok(p.includes('predict-ssq-2026-10-25.json'))
  assert.ok(p.includes('8 个红球'))
  assert.ok(p.includes('28 注'))
  assert.ok(p.includes('硬校验'))
  assert.ok(p.includes('不要发任何消息'))
  assert.ok(p.includes(DEFAULT_PERSONA.split('\n')[0]))
})

test('提示词：人设可被配置覆盖', () => {
  const p = buildPredictPrompt({
    gameKey: 'p3', cfg: { persona: '你是一位冷静的统计学家。' }, history: P3_HISTORY,
    issue: '26283', outPath: '/x.json', late: false,
  })
  assert.ok(p.includes('冷静的统计学家'))
  assert.ok(!p.includes('元气满满'))
})

test('提示词：晚到模式会提醒她写短一点', () => {
  const p = buildPredictPrompt({
    gameKey: 'p3', cfg: {}, history: P3_HISTORY, issue: '26283',
    outPath: '/x.json', late: true,
  })
  assert.ok(p.includes('晚了一拍'))
})

test('兜底正文：三种号都能念出来', () => {
  assert.ok(fallbackMessage('ssq', { red: [1, 2, 3, 4, 5, 6, 7, 8], blue: 9 }).includes('红球'))
  assert.ok(fallbackMessage('dlt', { front: [1, 2, 3, 4, 5, 6, 7], back: [3, 4] }).includes('前区'))
  assert.ok(fallbackMessage('p3', { digits: [6, 4, 7] }).includes('6-4-7'))
})

// ── 收尾批 T1：探索性素材注入段（相似局势 top-3 + 当前局势分位；docs/32 §6.2 注入面 v2）────────

/** 合成历史序列（最新在前，drawstore.getRecent 同构；日期随期号严格递增，倒序后单调递减） */
const mkSeries = (n, { game = 'p3', start = 26200 } = {}) => {
  const out = []
  for (let i = 0; i < n; i++) {
    const date = new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10)
    const issue = String(start + i)
    out.push(game === 'p3'
      ? { issue, date, digits: [i % 10, (i * 3 + 1) % 10, (i * 7 + 2) % 10] }
      : { issue, date, red: [(i + 1) % 33 + 1, (i + 7) % 33 + 1, (i + 13) % 33 + 1, (i + 19) % 33 + 1, (i + 25) % 33 + 1, (i + 31) % 33 + 1], blue: (i % 16) + 1 })
  }
  return out.reverse()
}

test('T1 注入段在位：p3 40 期 + 目标期 → 相似 top-3 + 局势分位两段齐全，BC-001 注记常驻（dataPack 与提示词链两层面）', () => {
  const hist = mkSeries(40)
  const pack = dataPack('p3', hist, { issue: '26240' })
  assert.ok(pack.includes('【探索性素材 · 相似局势 top-3】'), '相似局势段在位')
  assert.ok(pack.includes('【探索性素材 · 当前局势分位】'), '局势分位段在位')
  assert.ok(pack.includes(DISCLAIMER), 'DISCLAIMER 常量逐字常驻（BC-001）')
  assert.ok(/第 \d+ 期 @ [\d-]+（距离 0\.\d{3}）→ 后续开奖：\d{3}/.test(pack), '相似行=期号/日期/距离/后续开奖一行一条')
  assert.ok(/当前和值 \d+（最近一期）= 历史 [\d.]+ 分位/.test(pack), '当前和值历史分位行')
  assert.ok(pack.includes('最罕见遗漏：'), '关键号位遗漏分位行')
  assert.ok((pack.match(/遗 \d+=历史 [\d.]+ 分位/g) ?? []).length === 3, '遗漏 cell 取 top-3')
  // 提示词组装链（prompt.js:87 传 issue）：探索性素材段随 dataPack 进出号上下文
  const p = buildPredictPrompt({ gameKey: 'p3', cfg: {}, history: hist, issue: '26240', outPath: '/x.json' })
  assert.ok(p.includes('【探索性素材 · 相似局势 top-3】'))
  assert.ok(p.includes('【探索性素材 · 当前局势分位】'))
})

test('T1 ssq 形态：相似行念红+蓝摘要，分位行用 r/b cell 口径（与 CLI insight percentile 同源）', () => {
  const hist = mkSeries(40, { game: 'ssq', start: 2026100 })
  const pack = dataPack('ssq', hist, { issue: '2026140' })
  assert.ok(pack.includes('【探索性素材 · 相似局势 top-3】'))
  assert.ok(/→ 后续开奖：红 \d{2} \d{2} \d{2} \d{2} \d{2} \d{2} \+ 蓝 \d{2}/.test(pack), 'ssq 后续开奖摘要=红球 6 + 蓝球 1')
  assert.ok(/最罕见遗漏：(r\d{1,2}|b\d{1,2}) 遗 \d+=历史 [\d.]+ 分位/.test(pack), 'cell 编号沿用 insight 口径（r/b 前缀）')
})

test('T1 防前视断言：历史含目标期与未来期时，相似命中与分位基线仍严格早于目标期（接线处再断言）', () => {
  const hist = [...mkSeries(41), { ...mkSeries(41)[0], issue: '26241', date: '2026-02-11' }]   // 含目标期 26240 自身与未来期 26241
  const pack = dataPack('p3', hist, { issue: '26240' })
  assert.ok(pack.includes('【探索性素材 · 相似局势 top-3】'), '数据充足段仍在')
  const hitIssues = [...pack.matchAll(/第 (\d+) 期 @/g)].map((m) => Number(m[1]))
  assert.ok(hitIssues.length >= 1, '至少一条命中')
  assert.ok(hitIssues.every((n) => n < 26240), `命中期号全部严格早于目标期：${hitIssues.join(',')}`)
  assert.equal(hitIssues.includes(26240), false, '目标期自身不作命中')
  assert.equal(hitIssues.includes(26241), false, '未来期不作命中')
  // 命中行「后续开奖」= 该命中期自身开奖（逐行对号）
  const byIssue = new Map(hist.map((e) => [String(e.issue), e]))
  for (const line of pack.split('\n').filter((l) => l.includes('→ 后续开奖：'))) {
    const issue = /第 (\d+) 期/.exec(line)[1]
    const e = byIssue.get(issue)
    assert.ok(line.endsWith((e.digits ?? []).join('')), `命中 ${issue} 的后续开奖摘要=该期自身开奖（行尾逐字对号）`)
  }
})

test('T1 数据不足降级：在库不足 30 期 → 整段省略（输出与旧调用面逐字节一致）；空库兜底话术不变', () => {
  const pack3 = dataPack('p3', P3_HISTORY, { issue: '26283' })
  assert.equal(pack3, dataPack('p3', P3_HISTORY), '3 期在库 → 探索性素材整段省略，不硬凑')
  assert.equal(dataPack('p3', [], { issue: '26283' }), dataPack('p3', []), '空库兜底话术逐字节不变')
  assert.ok(pack3.includes('【百位】'), '旧段落原样在位')
})

test('T1 无相似期降级：目标期早于全部在库期 → 无可编码局势，整段省略', () => {
  const hist = mkSeries(40)
  const pack = dataPack('p3', hist, { issue: '26000' })
  assert.equal(pack, dataPack('p3', hist), '目标期之前无历史 → 整段省略（与不传 issue 输出一致）')
  assert.equal(pack.includes('探索性素材'), false)
})

test('T1 旧段落逐字节不变：不传 issue = 旧形状；传 issue 输出以旧输出为严格前缀（快照变更仅限新增段）', () => {
  const hist = mkSeries(40)
  const legacy = dataPack('p3', hist)
  const withSeg = dataPack('p3', hist, { issue: '26240' })
  assert.ok(withSeg.startsWith(legacy), '旧段落逐字节不变（新增段仅追加其后）')
  assert.equal(withSeg[legacy.length], '\n')
  assert.ok(withSeg.length > legacy.length)
  const legacySsq = dataPack('ssq', SSQ_HISTORY)
  assert.equal(dataPack('ssq', SSQ_HISTORY, { tailCount: 10, issue: '2026122' }).startsWith(legacySsq), true,
    '小样本 ssq：新增段自动省略，输出逐字节等于旧形状（既有快照锚点零回退）')
})

test('T1 token 记账：探索性素材段带来 prompt 增量，usage predict 桶 est 恒标（scheduler promptAgent 既有机制零新增）', () => {
  const hist = mkSeries(40)
  const base = estTokens(dataPack('p3', hist))
  const withSeg = estTokens(dataPack('p3', hist, { issue: '26240' }))
  assert.ok(withSeg > base, '注入段带来正的 est 增量（chars/4 保守口径）')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koi-stats-usage-'))
  const tracker = createUsageTracker({ dataDir: dir, now: () => new Date('2026-11-21T12:00:00') })
  const rec = tracker.record('predict', withSeg)   // scheduler.js:271 同款调用（activity 默认 predict）
  assert.equal(rec.entries[0].est, true, 'est 恒标')
  const totals = tracker.weekTotals()
  assert.equal(totals.predict, withSeg, 'prompt 全文 est 入 predict 桶（增量随全文计入）')
  assert.ok(totals.predict > base, '增量真实计入 predict 桶')
})
