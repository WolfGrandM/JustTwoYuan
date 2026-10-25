/**
 * 市场版 T5 + T11 —— 渲染层（FR-1010/BC-108）、提示词改造（力度杠杆/summary/档位感知）、
 * 成本与用量层（FR-1008/BC-107：周聚合/自然周重置/降档链/双显示估算）单测。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { renderEvent, honestyTail, hasProbabilityClaim, summaryProblem, SUMMARY_MAX } from '../lib/render.js'
import { buildPredictPrompt, DEFAULT_PERSONA, fallbackMessage } from '../lib/prompt.js'
import { EFFORT_LEVERS, leversFor, leverActive, weekKey, createUsageTracker, estTokens, demotionFor, costEstimate } from '../lib/usage.js'

const SSQ_HISTORY = [
  { issue: '2026121', date: '2026-10-22', red: [2, 7, 20, 24, 26, 30], blue: 2, prizeGrades: { 3: 3000 } },
  { issue: '2026120', date: '2026-10-20', red: [13, 14, 16, 18, 20, 31], blue: 3, prizeGrades: {} },
  { issue: '2026119', date: '2026-10-18', red: [2, 5, 11, 19, 26, 33], blue: 7, prizeGrades: {} },
]

// ── T5：render.js ─────────────────────────────────────────────────────────────

test('concise：标题 + 号码 + 合规字段 + 诚实基调句；不含全文 message', () => {
  const { body } = renderEvent({
    kind: 'predict', gameName: '双色球', issue: '2026122', date: '2026-10-25',
    picksLine: '红 01 02 + 蓝 03', message: '这是三百字的完整分析正文……'.repeat(20), summary: '今天看冷号回补',
    via: 'ai',
  }, { verbosity: 'concise' })
  assert.ok(body.includes('双色球') && body.includes('2026122'))
  assert.ok(body.includes('红 01 02 + 蓝 03'))
  assert.ok(!body.includes('完整分析正文'), 'concise 推送不含全文')
  assert.ok(!body.includes('摘要'), 'concise 不带 summary')
  assert.ok(body.includes('开奖是独立随机事件，本内容不改变中奖概率'), '诚实基调句恒在')
})

test('chatty：追加结构化 summary；≤100 字；未写显示（无摘要）；超长拒发标注', () => {
  const ok = renderEvent({ kind: 'predict', gameName: '双色球', issue: '1', picksLine: 'x', summary: '今天看冷号回补，蓝球盯小号。' }, { verbosity: 'chatty' })
  assert.ok(ok.body.includes('摘要：今天看冷号回补'))
  assert.equal(ok.summaryRejected, false)
  const none = renderEvent({ kind: 'predict', gameName: '双色球', issue: '1', picksLine: 'x', summary: '' }, { verbosity: 'chatty' })
  assert.ok(none.body.includes('摘要：（无摘要）'), 'AI 未写 → 如实显示（非事后删减）')
  const long = renderEvent({ kind: 'predict', gameName: '双色球', issue: '1', picksLine: 'x', summary: '长'.repeat(SUMMARY_MAX + 1) }, { verbosity: 'chatty' })
  assert.ok(long.body.includes('摘要：（超长已拒发）'))
  assert.equal(long.summaryRejected, true, '事件层据此告警一次（不静默截断）')
})

test('合规字段恒拼（BC-108）：兜底/加餐/手动/补发/基线缺失两档均出现', () => {
  for (const verbosity of ['concise', 'chatty']) {
    const fb = renderEvent({ kind: 'predict', gameName: 'x', issue: '1', picksLine: 'x', via: 'fallback' }, { verbosity })
    assert.ok(fb.body.includes('（兜底号）'), `${verbosity} 兜底标注`)
    const qp = renderEvent({ kind: 'quickpick', gameName: 'x', issue: '1', picksLine: 'x', flags: { quickpick: true } }, { verbosity })
    assert.ok(qp.body.includes('加餐 · 不记账'), `${verbosity} 加餐标注`)
    const manual = renderEvent({ kind: 'quickpick', gameName: 'x', issue: '1', picksLine: 'x', flags: { manual: true } }, { verbosity })
    assert.ok(manual.body.includes('手动推荐 · 不记账'), `${verbosity} 手动标注`)
    const rp = renderEvent({ kind: 'predict', gameName: 'x', issue: '1', picksLine: 'x', flags: { repush: true } }, { verbosity })
    assert.ok(rp.body.startsWith('【补发】'), `${verbosity} 补发前缀`)
    const bl = renderEvent({ kind: 'predict', gameName: 'x', issue: '1', picksLine: 'x', flags: { baselineMissing: true } }, { verbosity })
    assert.ok(bl.body.includes('（基线缺失）'), `${verbosity} 基线缺失标注`)
  }
  // 战果类基调句沿 v1「图个乐」句式
  assert.ok(honestyTail('result').includes('图个乐'))
  assert.ok(honestyTail('advice').includes('建议不记账'))
})

test('禁用词表：概率宣称检测（提高/增加/提升 × 中奖概率/胜率）', () => {
  assert.equal(hasProbabilityClaim('这个方法能提高中奖概率'), true)
  assert.equal(hasProbabilityClaim('坚持选号可以增加中奖概率'), true)
  assert.equal(hasProbabilityClaim('战绩引用提升胜率'), true)
  assert.equal(hasProbabilityClaim('开奖是随机的，研究不改变概率'), false)
  assert.equal(hasProbabilityClaim('今天看冷号回补'), false)
  assert.match(summaryProblem('这个技巧能提高中奖概率'), /概率宣称/)
  assert.equal(summaryProblem('正常摘要'), null)
  assert.match(summaryProblem('x'.repeat(101)), /超长/)
})

// ── T5：prompt.js 改造 ────────────────────────────────────────────────────────

test('提示词：tier 缺省 = v1 等价旧规格（向后兼容，既有快照锚点不回退）', () => {
  const p = buildPredictPrompt({ gameKey: 'ssq', cfg: {}, history: SSQ_HISTORY, issue: '2026122', outPath: '/tmp/x.json', late: false })
  assert.ok(p.includes('锦鲤'))
  assert.ok(p.includes('8 个红球'))
  assert.ok(p.includes('28 注'))
  assert.ok(p.includes('硬校验'))
  assert.ok(p.includes('不要发任何消息'))
  assert.ok(p.includes(DEFAULT_PERSONA.split('\n')[0]))
  assert.ok(p.includes('summary'), '契约新增 summary 字段')
})

test('提示词：档位感知（r9b2 规格/蓝双选契约；p3-x3 多组契约）', () => {
  const p = buildPredictPrompt({ gameKey: 'ssq', cfg: {}, tier: 'ssq-r9b2', history: SSQ_HISTORY, issue: '2026122', outPath: '/x.json' })
  assert.ok(p.includes('9 个红球'))
  assert.ok(p.includes('2 个不同的蓝球'))
  assert.ok(p.includes('336 元'))
  assert.ok(p.includes('"blue":[2个整数]'), '契约随档（蓝双选数组）')
  const p3 = buildPredictPrompt({ gameKey: 'p3', cfg: {}, tier: 'p3-x3', history: [], issue: '26283', outPath: '/x.json' })
  assert.ok(p3.includes('直选单式 ×3'))
  assert.ok(p3.includes('组与组不能重复'))
  assert.ok(p3.includes('共 3 注 / 6 元'))
})

test('提示词：四档杠杆注入差异断言（tail 6/10/12/14、字数档、自检段互异；MC-10）', () => {
  const mk = (effortTier, historyTail) => buildPredictPrompt({
    gameKey: 'ssq', cfg: { effort: { tier: effortTier }, historyTail }, history: SSQ_HISTORY, issue: '1', outPath: '/x.json',
  })
  const eco = mk('economy'); const host = mk('follow-host', 10); const std = mk('standard'); const turbo = mk('turbo')
  // 材料量杠杆：流水期数文案互异
  assert.ok(eco.includes('近 6 期流水'))
  assert.ok(host.includes('近 10 期流水'))
  assert.ok(std.includes('近 12 期流水'))
  assert.ok(turbo.includes('近 14 期流水'))
  // follow-host 用 config.historyTail（MC-10）
  assert.ok(mk('follow-host', 8).includes('近 8 期流水'), 'follow-host 尾随 config.historyTail')
  // 字数档
  assert.ok(eco.includes('150–300 字'))
  assert.ok(host.includes('300–600 字'))
  assert.ok(std.includes('300–600 字'))
  assert.ok(turbo.includes('400–800 字'))
  // 自检段（turbo 独有）
  assert.ok(turbo.includes('自检清单'))
  for (const p of [eco, host, std]) assert.ok(!p.includes('自检清单'))
  // 四档三元组互异（dup=0，MB-21）
  const tri = (t) => { const l = leversFor({ effort: { tier: t }, historyTail: 10 }); return `${l.tail}|${l.min}-${l.max}|${l.selfCheck}` }
  const set = new Set(['follow-host', 'economy', 'standard', 'turbo'].map(tri))
  assert.equal(set.size, 4, '三元组两两互异')
  assert.equal(leversFor({ effort: { tier: 'economy' } }).tail, EFFORT_LEVERS.economy.tail)
  assert.equal(leverActive({}), true, '三维杠杆结构性恒在（配置页如实显示基础）')
})

test('提示词：无概率宣称基调句恒在', () => {
  const p = buildPredictPrompt({ gameKey: 'p3', cfg: { persona: '冷静统计学家。' }, history: [], issue: '1', outPath: '/x.json' })
  assert.ok(p.includes('不得宣称提高/增加中奖概率'))
  assert.ok(p.includes('冷静统计学家'))
  assert.ok(fallbackMessage('p3', { digits: [1, 2, 3] }).includes('1-2-3'))
})

// ── T11：usage.js ─────────────────────────────────────────────────────────────

test('weekKey：ISO 周一自然周', () => {
  assert.equal(weekKey(new Date(2026, 9, 25)), '2026-W43', '2026-10-25 周日属 W43')
  assert.equal(weekKey(new Date(2026, 9, 26)), '2026-W44', '10-26 周一开新周')
  assert.equal(weekKey(new Date(2027, 0, 1)), '2026-W53', '2027-01-01 周五属 2026-W53（ISO 跨年周）')
  assert.equal(weekKey(new Date(2027, 0, 4)), '2027-W01', '2027-01-04 周一开新周')
})

test('usage tracker：记录/周聚合/自然周重置归档（est 恒标）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koi-usage-'))
  let t = new Date('2026-10-21T18:00:00')   // W43
  const tr = createUsageTracker({ dataDir: dir, now: () => t })
  tr.record('predict', estTokens('x'.repeat(4000)))   // 1000 tokens
  tr.record('advisory', 200)
  let w = tr.weekTotals()
  assert.equal(w.week, '2026-W43')
  assert.equal(w.predict, 1000)
  assert.equal(w.advisory, 200)
  assert.equal(w.total, 1200)
  const j = JSON.parse(fs.readFileSync(tr.fileOf(), 'utf8'))
  assert.equal(j.entries[0].est, true, '估算恒标（D-007）')
  // 周切换 → 归档重置
  t = new Date('2026-10-27T18:00:00')       // W44
  w = tr.weekTotals()
  assert.equal(w.week, '2026-W44')
  assert.equal(w.total, 0, '新周从零开始')
  const j2 = JSON.parse(fs.readFileSync(tr.fileOf(), 'utf8'))
  assert.equal(j2.archived[0].week, '2026-W43')
  assert.equal(j2.archived[0].entries.length, 2, '旧周条目归档不丢')
})

test('降档链（BC-013 市场版链，MD-23）：ok → warn1 → warn2（降一档）→ cap（follow-host + 零 LLM + 暂停）', () => {
  const cap = 1_000_000
  let d = demotionFor({ used: 500_000, cap, effortTier: 'turbo' })
  assert.equal(d.level, 'ok'); assert.equal(d.effectiveEffort, 'turbo'); assert.equal(d.allowLLM, true)
  d = demotionFor({ used: 750_000, cap, effortTier: 'turbo' })
  assert.equal(d.level, 'warn1'); assert.equal(d.effectiveEffort, 'turbo', '70% 仅预警不降档')
  d = demotionFor({ used: 950_000, cap, effortTier: 'turbo' })
  assert.equal(d.level, 'warn2'); assert.equal(d.effectiveEffort, 'standard', '90% 降一档')
  d = demotionFor({ used: 950_000, cap, effortTier: 'standard' })
  assert.equal(d.effectiveEffort, 'economy')
  d = demotionFor({ used: 950_000, cap, effortTier: 'follow-host' })
  assert.equal(d.effectiveEffort, 'follow-host', '已在底档保持')
  d = demotionFor({ used: 1_000_000, cap, effortTier: 'turbo' })
  assert.equal(d.level, 'cap'); assert.equal(d.effectiveEffort, 'follow-host')
  assert.equal(d.allowLLM, false, '兜底档出号零 LLM')
  assert.equal(d.pauseAdvisory, true); assert.equal(d.pauseLearning, true)
})

test('costEstimate 双显示（MB-22）：当前形态不随阵容 / M3 满配随阵容；auto-only 彩种计入；advisory 开关', () => {
  const cfg = {
    modes: { ssq: { mode: 'auto' }, dlt: { mode: 'manual' }, p3: { mode: 'auto' } },
    effort: { tier: 'economy' }, advisory: { enabled: true },
    budget: { weeklyCap: 1_500_000, roleWeights: { strategist: [1.0, 1.0] } },
  }
  const est = costEstimate(cfg, { packChars: { ssq: 2400, p3: 800 } })
  // ssq 3 天 + p3 7 天 = 10 个开奖日；economy 输出上限 300 字 → 75 tokens
  const ssqPer = Math.ceil(2400 / 4) + 75
  const p3Per = Math.ceil(800 / 4) + 75
  assert.equal(est.weekly.predict, 3 * ssqPer + 7 * p3Per, 'manual 彩种不计入')
  assert.ok(est.weekly.advisory > 0, 'advisory 默认开')
  assert.equal(est.weekly.cap, 1_500_000)
  // 双显示：当前形态不随阵容；M3 满配 = 2×Σweights+3 = 7 倍
  assert.ok(est.currentForm.note.includes('不随阵容'))
  assert.ok(est.m3Projection.note.includes('M3'))
  assert.equal(est.m3Projection.factor, 7)
  assert.equal(est.m3Projection.weeklyPredict, est.weekly.predict * 7)
  // advisory 关闭 → 0
  const est2 = costEstimate({ ...cfg, advisory: { enabled: false } }, { packChars: { ssq: 2400, p3: 800 } })
  assert.equal(est2.weekly.advisory, 0)
  // 全 manual → 全 0
  const est3 = costEstimate({ ...cfg, modes: { ssq: { mode: 'manual' }, dlt: { mode: 'off' }, p3: { mode: 'manual' } } }, {})
  assert.equal(est3.weekly.total, 0)
  assert.ok(est3.basis.includes('估算'))
})
