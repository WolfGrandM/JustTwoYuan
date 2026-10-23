/** 统计层与提示词测试 —— 数据包能造出来、字段齐全、AI 契约里的关键约束都在 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { dataPack } from '../lib/stats.js'
import { buildPredictPrompt, DEFAULT_PERSONA, fallbackMessage } from '../lib/prompt.js'

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
