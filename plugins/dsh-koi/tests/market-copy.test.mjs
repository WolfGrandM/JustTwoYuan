/**
 * 第二波 T9/T10 —— 期望管理文案定稿与 ui-logic 增量（docs/19 §6/§8；FR-1015/BC-112，P0 不可降）。
 * §6 三处文案以常量进 lib/ui-logic.js 直测（MA-25 正向断言口径）+ 禁用词扫描（hasProbabilityClaim）
 * + client 内联副本等价断言（MD-21——文案断言不依赖 react 环境）+ config 增量字段校验。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  LEARNING_COPY, UPLOAD_HINT, VERDICT_CALIBER, PENDING_LLM_NOTE, FULLBACKFILL_CONFIRM, SPORTTERY_DEEP_NOTE,
  rejectedNote, ruleDupHint, verdictTextOf, uploadFormatOk, formatBytes, uploadEstimate,
  backfillProgressText, jobBadgeText, WIZARD_STEPS,
} from '../lib/ui-logic.js'
import { hasProbabilityClaim } from '../lib/render.js'
import { buildConfigTemplate, buildConfigDefaults, validateConfig } from '../lib/config.js'

// ── §6 文案定稿正向断言（MA-25 同款）───────────────────────────────────────────
test('上传页/结论页文案：含「学习 = 严格回测检验」「结论可能证明技巧无效」「与随机无异」原文（FR-1015 P0）', () => {
  assert.ok(LEARNING_COPY.includes('学习 = 严格回测检验'))
  assert.ok(LEARNING_COPY.includes('结论可能证明技巧无效'))
  assert.ok(LEARNING_COPY.includes('与随机无异'))
  assert.ok(LEARNING_COPY.includes('不改变中奖概率'))
  assert.ok(VERDICT_CALIBER.includes('判据滞后自评满足率'))
  assert.ok(VERDICT_CALIBER.includes('单侧精确二项检验（α=0.05）'))
  assert.ok(VERDICT_CALIBER.includes('与随机无异」= 命中率与随机基线无统计学差异'))
  assert.ok(VERDICT_CALIBER.includes('不改变中奖概率，也不驱动任何自动行为'))
  // 上传控件旁：格式收窄如实告知（W2A-04）
  assert.ok(UPLOAD_HINT.includes('.txt / .md') && UPLOAD_HINT.includes('暂不支持直接解析'))
  // 待补文案（S-119）
  assert.ok(PENDING_LLM_NOTE.includes('待补') && PENDING_LLM_NOTE.includes('绝不静默丢弃'))
  // 确认框：请求量/时长/错峰/中止断点/重访口径逐项在场（§2.5 定稿 + AC-108 计数口径）
  for (const part of ['140–160 个请求', '15–30 分钟', '批间隔 2 秒', '17:00–22:30', '可随时中止，断点保留', '不会重复请求', '重访一个小批次', '确定开始？']) {
    assert.ok(FULLBACKFILL_CONFIRM.includes(part), `确认框缺「${part}」`)
  }
  assert.ok(SPORTTERY_DEEP_NOTE.includes('未实测'), '体彩深翻未验证项如实显示（§13.3-③）')
})

test('禁用词扫描：全部新文案零概率宣称（BC-112/hasProbabilityClaim 覆盖学习区新文案）', () => {
  const all = [LEARNING_COPY, UPLOAD_HINT, VERDICT_CALIBER, PENDING_LLM_NOTE, FULLBACKFILL_CONFIRM, SPORTTERY_DEEP_NOTE,
    rejectedNote(['格式不支持']), ruleDupHint('蓝球追热法'), verdictTextOf('no-advantage'), verdictTextOf('better-in-sample')]
  for (const t of all) {
    assert.equal(hasProbabilityClaim(t), false, `文案含概率宣称：${t}`)
  }
})

// ── 纯逻辑 ────────────────────────────────────────────────────────────────────
test('上传格式校验 / 大小格式化 / token 估算（字节/12）与周预算占比', () => {
  assert.deepEqual(uploadFormatOk('技巧大全.md'), { ok: true, ext: 'md' })
  assert.deepEqual(uploadFormatOk('notes.TXT'), { ok: true, ext: 'txt' })
  assert.equal(uploadFormatOk('书.pdf').ok, false)
  assert.equal(uploadFormatOk('无扩展名').ok, false)
  assert.equal(formatBytes(500), '500 B')
  assert.equal(formatBytes(2048), '2.0 KB')
  assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MB')
  const est = uploadEstimate(1200 * 1024, 1_500_000)
  assert.equal(est.tokens, 102400, '字节/12 保守折算')
  assert.equal(est.pct, 6.83)
  assert.equal(est.basis, '估算口径：字节/12')
  assert.equal(uploadEstimate(1200, 0).pct, null, '无预算时不显示百分比')
})

test('回拉进度诚实显示：已拉至 X（N 期在库），不出现百分比（W2A-08）；任务徽标与三态提示文案', () => {
  assert.equal(backfillProgressText('已拉至 2025001', 274), '已拉至 2025001（274 期在库）')
  assert.equal(backfillProgressText('已拉至 2025001'), '已拉至 2025001')
  assert.equal(backfillProgressText(null), '尚未回拉')
  assert.ok(!backfillProgressText('已拉至 2025001', 274).includes('%'), '不出现百分比（分母是估计值，百分比会伪精确）')
  assert.equal(jobBadgeText({ status: 'queued', waitingNote: '错峰等待中（22:30 后自动继续）' }), '排队中 · 错峰等待中（22:30 后自动继续）')
  assert.equal(jobBadgeText({ status: 'pending-llm' }), '待补')
  assert.equal(jobBadgeText({ status: 'rejected' }), '已拒收')
  assert.equal(jobBadgeText(null), '—')
  assert.equal(ruleDupHint('蓝球追热法'), '疑似重复被保守拒入（词法相似度 ≥0.8，与『蓝球追热法』）')
  assert.equal(rejectedNote(['格式不支持 .pdf', '超过 20MB']), '拒收原因：格式不支持 .pdf；超过 20MB（支持格式与上限见上）')
  assert.equal(verdictTextOf('better-in-sample'), '样本内优于随机')
  assert.equal(verdictTextOf('no-advantage'), '与随机无异')
  assert.equal(WIZARD_STEPS[4].desc.includes('全量历史回拉见下方「数据」区'), true, '向导第 5 步文案到期翻转（非语义回退）')
})

// ── client 内联副本等价（MD-21）──────────────────────────────────────────────
function loadClientStub() {
  const src = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  let captured = null
  globalThis.window = { __ModuleLoader__: { load: (def) => { captured = def } } }
  new Function(src)()
  const fakeReact = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useCallback: (f) => f, useEffect: () => {}, useRef: () => ({ current: null }), useState: (v) => [v, () => {}],
  }
  const client = captured.factory((name) => fakeReact)
  return { client }
}

test('内联副本等价：§6 文案常量与全部新纯函数与 lib/ui-logic.js 逐项一致（MD-21）', () => {
  const { client } = loadClientStub()
  const inline = client.__uiLogic
  assert.equal(inline.LEARNING_COPY, LEARNING_COPY)
  assert.equal(inline.UPLOAD_HINT, UPLOAD_HINT)
  assert.equal(inline.VERDICT_CALIBER, VERDICT_CALIBER)
  assert.equal(inline.PENDING_LLM_NOTE, PENDING_LLM_NOTE)
  assert.equal(inline.FULLBACKFILL_CONFIRM, FULLBACKFILL_CONFIRM)
  assert.equal(inline.SPORTTERY_DEEP_NOTE, SPORTTERY_DEEP_NOTE)
  assert.deepEqual(inline.WIZARD_STEPS, WIZARD_STEPS)
  assert.deepEqual(inline.uploadFormatOk('书.pdf'), uploadFormatOk('书.pdf'))
  assert.deepEqual(inline.uploadFormatOk('a.md'), uploadFormatOk('a.md'))
  assert.deepEqual(inline.uploadEstimate(24000, 1200), uploadEstimate(24000, 1200))
  assert.deepEqual(inline.uploadEstimate(100, 0), uploadEstimate(100, 0))
  assert.equal(inline.formatBytes(2048), formatBytes(2048))
  assert.equal(inline.backfillProgressText('已拉至 1', 2), backfillProgressText('已拉至 1', 2))
  assert.equal(inline.backfillProgressText(null), backfillProgressText(null))
  assert.equal(inline.jobBadgeText({ status: 'queued', waitingNote: 'x' }), jobBadgeText({ status: 'queued', waitingNote: 'x' }))
  assert.equal(inline.ruleDupHint('甲'), ruleDupHint('甲'))
  assert.equal(inline.rejectedNote('a'), rejectedNote('a'))
  assert.equal(inline.verdictTextOf('no-advantage'), verdictTextOf('no-advantage'))
})

// ── T10：config 增量字段（docs/19 §7：schema v2 只加不改不删）──────────────────
test('config 模板增量：backfill 扩展/ingest/backtest 默认值齐备且模板自校验通过；schemaVersion 维持 2', () => {
  const t = buildConfigTemplate()
  assert.equal(t.schemaVersion, 2, '纯加字段，不走破坏性变更通道')
  assert.deepEqual(t.backfill, { targetIssues: null, batchSize: 100, batchGapMs: 2000, retryMax: 3, offpeakOnly: true })
  assert.deepEqual(t.ingest, { maxFileMB: 20, maxCleanChars: 200000, dedup: 'merged', offpeakOnly: true })
  assert.deepEqual(t.backtest, { warmup: 30, minRounds: 100, alpha: 0.05, offpeakOnly: true })
  const v = validateConfig(buildConfigDefaults())
  assert.equal(v.ok, true, `默认模板必须自校验通过：${v.errors.join('；')}`)
})

test('config 新字段非法值拒：batchSize≤0 / dedup 枚举 / alpha∉(0,1) / maxCleanChars≤0 / minRounds / offpeakOnly 类型', () => {
  const cases = [
    ['backfill.batchSize', 0, 'batchSize'],
    ['backfill.batchGapMs', -1, 'batchGapMs'],
    ['backfill.retryMax', 1.5, 'retryMax'],
    ['backfill.offpeakOnly', 'yes', 'offpeakOnly'],
    ['ingest.maxFileMB', 0, 'maxFileMB'],
    ['ingest.maxCleanChars', 0, 'maxCleanChars'],
    ['ingest.dedup', 'always', 'dedup'],
    ['ingest.offpeakOnly', 1, 'offpeakOnly'],
    ['backtest.warmup', -1, 'warmup'],
    ['backtest.minRounds', 0, 'minRounds'],
    ['backtest.alpha', 0, 'alpha'],
    ['backtest.alpha', 1, 'alpha'],
    ['backtest.offpeakOnly', 'no', 'offpeakOnly'],
  ]
  for (const [dotted, value, key] of cases) {
    const c = buildConfigDefaults()
    const parts = dotted.split('.')
    let cur = c
    for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]]
    cur[parts[parts.length - 1]] = value
    const r = validateConfig(c)
    assert.equal(r.ok, false, `${dotted}=${value} 应被拒`)
    assert.ok(r.errors.some((e) => e.includes(key)), `${dotted} 错误信息点名 ${key}：${r.errors.join('；')}`)
  }
})
