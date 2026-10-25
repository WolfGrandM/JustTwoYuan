/**
 * 第二波 T4 —— lib/preprocess.js 清洗管线金样本单测（docs/19 §4.3；FR-1014 清洗半边 / P3 拍板 / DC-108）。
 * 强转 MD 典型污染各构造样例：图片引用 / OCR 噪声行 / 断行 / 页眉页脚 → clean 标记计数正确、输出文本断言；
 * 全噪声输入 → outChars 0（ingest 侧据此标 rejected）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { cleanText } from '../lib/preprocess.js'

test('① 剥图片引用：MD 图片行整删；<img> 与裸 ![] 删；「图 3-1」「如图所示」正文引用保留', () => {
  const raw = [
    '第三章 和值分析法',
    '![走势图](./img/p21.png)',
    '<img src="p22.jpg" alt="x"/>',
    '![局部截图]',
    '如图所示，和值长期在 90–130 区间波动（见图 3-1）。',
    '图 3-1 是近 30 期的和值走势。',
  ].join('\n')
  const r = cleanText(raw)
  assert.equal(r.clean.strippedImages, 3)
  assert.ok(!r.text.includes('img') && !r.text.includes('p21.png') && !r.text.includes('局部截图'))
  assert.ok(r.text.includes('如图所示'), '正文「如图所示」保留（是内容不是图片）')
  assert.ok(r.text.includes('图 3-1'), '「图 3-1」引用保留')
})

test('② OCR 噪声：「…」连续行 / 孤立页码 / 「第 X 页」页脚 / 无元音 ASCII 长串删行', () => {
  const raw = [
    '红球三区比选法。',
    '。。。。。',
    '……',
    '42',
    '第 42 页',
    '第 3 页 共 200 页',
    'jkqwxzjnq',
    '冷热号回补的观察窗取 30 期。',
  ].join('\n')
  const r = cleanText(raw)
  // 「。。。。。」与「……」= 2 行噪声；页码 42；第 42 页；第 3 页 共 200 页；jkqwxzjnq（9 字符无元音）= 共 6
  assert.equal(r.clean.ocrNoise, 6)
  assert.ok(r.text.includes('红球三区比选法'))
  assert.ok(r.text.includes('冷热号回补'))
  assert.ok(!r.text.includes('42') && !r.text.includes('jkqwxzjnq'))
  // 有元音的 ASCII 串（如普通英文单词行）不删
  const keep = cleanText(['observation window'])
  assert.ok(keep.text.includes('observation'))
})

test('③ 断行修复：中文硬换行拼接（行尾无标点 + 下一行 CJK 开头）；英文连字符断词去连字符；段间空行保留', () => {
  const raw = [
    '冷热号回补是指连续多期未开出的号',
    '在随后若干期内回补出现。',
    '',
    '这是独立的一段。',
    'the hot-',
    'cold tracking',
  ].join('\n')
  const r = cleanText(raw)
  assert.equal(r.clean.fixedBreaks, 2)
  assert.ok(r.text.includes('冷热号回补是指连续多期未开出的号在随后若干期内回补出现。'), '中文硬换行拼接')
  assert.ok(r.text.includes('the hotcold tracking'), '英文断词去连字符拼接')
  const paras = r.text.split(/\n\n+/)
  assert.ok(paras.length >= 2, '段落边界（空行）保留')
  // 行尾有标点 → 不拼接
  const keep = cleanText(['第一句结束。', '第二句开头'])
  assert.ok(keep.text.includes('第一句结束。\n第二句开头') || keep.text.split('\n').length >= 2)
})

test('④ 页眉页脚：同一行出现 ≥3 次 → 全删（强转 MD 的书名页眉典型污染）；出现 2 次保留', () => {
  const header = '· 彩票技巧大全 ·'
  const raw = [
    header, '技巧一：和值区间。', header, '技巧二：奇偶比。', header, '技巧三：012 路。',
  ].join('\n')
  const r = cleanText(raw)
  assert.equal(r.clean.headersFooters, 3)
  assert.ok(!r.text.includes('彩票技巧大全'))
  assert.ok(r.text.includes('技巧一') && r.text.includes('技巧三'))
  const twice = cleanText([header, '正文甲。', header, '正文乙。'].join('\n'))
  assert.equal(twice.clean.headersFooters, 0, '出现 2 次不算页眉（保守防误删）')
})

test('组合金样本：强转 MD 全污染样例 → 各标记计数 + 段落结构输出', () => {
  const raw = [
    '· 彩票技巧大全 ·',
    '![封面](cover.jpg)',
    '第 1 页',
    '· 彩票技巧大全 ·',
    '技巧一：和值区间法。红球六码的和值长期落在 90–130 区',
    '间，超出该区间时下一期有向均值回归的倾向。',
    '。。。',
    '· 彩票技巧大全 ·',
    '12',
    '技巧二：奇偶比。奇数个数取近 100 期的众数。',
    '<img src="x.png">',
    '· 彩票技巧大全 ·',
  ].join('\n')
  const r = cleanText(raw)
  assert.equal(r.clean.strippedImages, 2)      // 封面 + x.png
  assert.equal(r.clean.ocrNoise, 3)            // 第 1 页 / 。。。 / 12
  assert.equal(r.clean.headersFooters, 4)      // 书名页眉 ×4
  assert.equal(r.clean.fixedBreaks, 1)         // 区/间 断行
  assert.ok(r.text.includes('90–130 区间，超出该区间'), '断行修复后语义连续')
  assert.ok(r.text.includes('技巧二：奇偶比'))
  assert.ok(!r.text.includes('彩票技巧大全') && !r.text.includes('cover.jpg'))
  assert.ok(r.stats.inChars > r.stats.outChars)
  assert.ok(r.stats.droppedLines >= 9)
})

test('空/全噪声输入 → outChars 0（ingest 侧据此 rejected「清洗后无可读文本」，S-118）', () => {
  assert.equal(cleanText('').stats.outChars, 0)
  assert.equal(cleanText('   \n\n  ').stats.outChars, 0)
  const allNoise = cleanText(['![x](y)', '42', '。。。', '第 9 页'].join('\n'))
  assert.equal(allNoise.stats.outChars, 0)
  assert.equal(allNoise.text.trim(), '')
  // 纯中文正文不受影响
  const pure = cleanText('只有一句话。')
  assert.ok(pure.text.includes('只有一句话'))
  assert.deepEqual(pure.clean, { strippedImages: 0, ocrNoise: 0, fixedBreaks: 0, headersFooters: 0 })
})
