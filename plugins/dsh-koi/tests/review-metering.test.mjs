/**
 * M4 T2 叙述计量测试（docs/28 §5/§1 BC-013，AC-007）——
 * review 桶入账 = estTokens(输入+输出)（est 恒标）；cap 态停叙述照发 code-only；
 * 三闸（概率宣称/幻觉因子/超长）两次不过 → code-only；错峰守卫；out 桶单记。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createNarrator } from '../lib/review/narrate.js'
import { createUsageTracker, estTokens } from '../lib/usage.js'
import { hasProbabilityClaim } from '../lib/render.js'

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'koi-review-meter-'))

/** 假宿主 promptAgent：行为同 scheduler.js:167-180——调 host 后 usage.record('review', estTokens(text))；按提示词写 narrate 交卷文件 */
function mkPromptAgent({ usage, workDir, outputs, log = [] }) {
  let callIdx = 0
  return async (text) => {
    log.push(text)
    usage.record('review', estTokens(text))          // 输入侧计量（scheduler 现路径，任意 activity 形参）
    const m = text.match(/narrate-[\w.-]+\.json/)
    const out = outputs[Math.min(callIdx, outputs.length - 1)]
    callIdx += 1
    if (out instanceof Error) throw out
    if (m && out != null) fs.writeFileSync(path.join(workDir, m[0]), JSON.stringify({ text: out }))
  }
}

function mkNarrator({ usage, outputs, budget = () => ({ demo: { allowLLM: true } }), cfg = {}, now = () => new Date('2026-11-22T23:00:00'), hasProb = hasProbabilityClaim, knownIds }) {
  const dir = tmpdir()
  const workDir = path.join(dir, 'koi-work')
  fs.mkdirSync(workDir, { recursive: true })
  const prompts = []
  const narrator = createNarrator({
    promptAgent: mkPromptAgent({ usage, workDir, outputs, log: prompts }),
    usage,
    readCfg: () => ({ mind: { enabled: true }, ...cfg }),
    budgetState: budget,
    now,
    workDir,
    log: () => {},
    hasProbabilityClaim: hasProb,
    stopCheck: () => false,
  })
  return { narrator, prompts, workDir, usage }
}

test('T2 AC-007 叙述计量：成功叙述后 weekTotals().review 增量 = estTokens(输入+输出)，est 恒标', async () => {
  const usage = createUsageTracker({ dataDir: tmpdir(), now: () => new Date('2026-11-22T23:00:00') })
  const before = usage.weekTotals().review
  assert.equal(before, 0)
  const OUT = '本周命中 1 期、基线对照 1 期，账本投入 100 元。一切数字如代码所示。'
  const fx = mkNarrator({ usage, outputs: [OUT] })
  const r = await fx.narrator.narrate({ section: '战绩对照', data: { ledger: { cost: 100 } }, knownFactorIds: ['builtin-parity-ratio-ssq'] })
  assert.equal(r.source, 'llm')
  assert.equal(r.text, OUT)
  const t = usage.weekTotals()
  const inTokens = estTokens(fx.prompts[0])
  assert.equal(t.review, inTokens + estTokens(OUT), 'review 桶 = 输入侧（promptAgent 记）+ 输出侧（narrate 记）')
  assert.ok(t.total >= t.review)
  // 计量文件里 est 恒标（BC-013 诚实口径）
  const file = JSON.parse(fs.readFileSync(usage.fileOf(), 'utf8'))
  assert.ok(file.entries.every((e) => e.est === true && e.activity === 'review'))
})

test('T2 cap 态：demo.allowLLM=false → 叙述跳过、review 桶零新增、code-only 照发并标注（BC-013）', async () => {
  const usage = createUsageTracker({ dataDir: tmpdir(), now: () => new Date('2026-11-22T23:00:00') })
  usage.record('predict', 5000)
  const before = usage.weekTotals().review
  const fx = mkNarrator({ usage, outputs: ['不该被调用'], budget: () => ({ demo: { allowLLM: false, level: 'cap' } }) })
  const r = await fx.narrator.narrate({ section: '健康节', data: { ok: 1 }, knownFactorIds: [] })
  assert.equal(r.source, 'code-only')
  assert.match(r.reason, /预算触顶 · 叙述暂停（BC-013）/)
  assert.equal(fx.prompts.length, 0, 'cap 态零 LLM 调用')
  assert.equal(usage.weekTotals().review, before, 'review 桶零新增')
  assert.ok(r.text.includes('健康节'), 'code-only 报告照发')
})

test('T2 review.narrative=false / 错峰窗口内（17:00–22:30）→ code-only；--no-offpeak 越过生效（BC-012）', async () => {
  const usage = createUsageTracker({ dataDir: tmpdir(), now: () => new Date('2026-11-22T23:00:00') })
  // 开关关
  const fx1 = mkNarrator({ usage, outputs: ['x'], cfg: { review: { narrative: false } } })
  const r1 = await fx1.narrator.narrate({ section: '战绩对照', data: {}, knownFactorIds: [] })
  assert.equal(r1.source, 'code-only')
  assert.match(r1.reason, /narrative 已关闭/)
  // 错峰窗口内拒调（18:00）
  const usage2 = createUsageTracker({ dataDir: tmpdir() })
  const fx2 = mkNarrator({ usage: usage2, outputs: ['x'], now: () => new Date('2026-11-22T18:00:00') })
  const r2 = await fx2.narrator.narrate({ section: '战绩对照', data: {}, knownFactorIds: [] })
  assert.equal(r2.source, 'code-only')
  assert.match(r2.reason, /错峰窗口（17:00–22:30）内不调用叙述 LLM（BC-012）/)
  assert.equal(fx2.prompts.length, 0)
  // noOffpeak 显式越过 → LLM 路径
  const r3 = await fx2.narrator.narrate({ section: '战绩对照', data: {}, knownFactorIds: [], noOffpeak: true })
  assert.equal(r3.source, 'llm')
})

test('T2 三闸：概率宣称/幻觉因子/超长——两次不过 → code-only + 原因标注，promptAgent 恰 2 次（1 + ≤1 打回）', async () => {
  // ① 概率宣称（BC-112 闸，render.js 既有正则）
  const usage1 = createUsageTracker({ dataDir: tmpdir() })
  const BAD1 = '这组号能提高中奖概率，值得期待！'
  const fx1 = mkNarrator({ usage: usage1, outputs: [BAD1, BAD1] })
  const r1 = await fx1.narrator.narrate({ section: '战绩对照', data: {}, knownFactorIds: [] })
  assert.equal(r1.source, 'code-only')
  assert.match(r1.reason, /概率宣称/)
  assert.equal(fx1.prompts.length, 2)
  assert.ok(fx1.prompts[1].includes('打回重写'), '一次打回')
  // ② 幻觉因子（AC-009：builtin-ac-value-ssq 不在 registry）
  const usage2 = createUsageTracker({ dataDir: tmpdir() })
  const BAD2 = 'builtin-ac-value-ssq 表现亮眼，命中 3 次。'
  const fx2 = mkNarrator({ usage: usage2, outputs: [BAD2, BAD2] })
  const r2 = await fx2.narrator.narrate({ section: '战绩对照', data: {}, knownFactorIds: ['builtin-parity-ratio-ssq'] })
  assert.equal(r2.source, 'code-only')
  assert.match(r2.reason, /幻觉因子|不在因子库/)
  // ③ 超长（>600 字）
  const usage3 = createUsageTracker({ dataDir: tmpdir() })
  const BAD3 = '长'.repeat(601)
  const fx3 = mkNarrator({ usage: usage3, outputs: [BAD3, BAD3] })
  const r3 = await fx3.narrator.narrate({ section: '健康节', data: {}, knownFactorIds: [] })
  assert.equal(r3.source, 'code-only')
  assert.match(r3.reason, /超长/)
})

test('T2 LLM 调用抛错（宿主无模型等）→ code-only + 原因；两次门内首过即停（单次调用）', async () => {
  const usage = createUsageTracker({ dataDir: tmpdir() })
  const fx = mkNarrator({ usage, outputs: [new Error('DSH runtime: no model configured for agent')] })
  const r = await fx.narrator.narrate({ section: '健康节', data: {}, knownFactorIds: [] })
  assert.equal(r.source, 'code-only')
  assert.match(r.reason, /LLM 调用失败/)
  assert.equal(fx.prompts.length, 1, '调用失败不重试（一次 narrate = 1 调用 + 闸败才打回）')
  // 正常路径首过即停：第二次叙述调用只 1 次 promptAgent
  const OUT = '正常叙述。'
  const fx2 = mkNarrator({ usage, outputs: [OUT] })
  await fx2.narrator.narrate({ section: '战绩对照', data: {}, knownFactorIds: [] })
  await fx2.narrator.narrate({ section: '健康节', data: {}, knownFactorIds: [] })
  assert.equal(fx2.prompts.length, 2, '节 1/节 3 各一次')
})
