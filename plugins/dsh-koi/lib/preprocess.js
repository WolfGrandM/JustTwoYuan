/**
 * dsh-koi 学习清洗管线（第二波 docs/19 §4.3，FR-1014 清洗半边 / P3 拍板 / DC-108）。
 *
 * 代码级纯函数（W2-D03，偏离 docs/16 §2.2.9「会话 agent 清洗」——格式收窄为 TXT/MD 后
 * 清洗规则全部可确定性表达：零 token 成本、可 golden 单测、失败语义消失）。
 *
 * 规则（全部确定性、可 golden 单测）：
 *   ① 剥图片引用：Markdown ![…](…) 整段删；残留 <img …>、裸 ![…] 行删；「图 3-1」「如图所示」等正文引用保留
 *   ② OCR 噪声：「…」连续行、孤立页码行 ^\d{1,4}$、「第 X 页」页脚行、纯 ASCII 无空格无元音长串（>8）删行
 *   ③ 断行修复：行尾无标点且下一行以 CJK 开头 → 拼接（硬换行）；行尾连字符断词（英文）→ 去连字符拼接；
 *      保留段落间空行（段落边界）
 *   ④ 页眉页脚：同一行文本全文出现 ≥ repeatMin（默认 3）且非空 → 视为页眉/页脚全部删除
 *
 * 输出 { text, clean, stats }：clean = DC-108 清洗标记；stats = 面板可见的清洗透明度。
 * 失败语义：无（确定性函数）；stats.outChars === 0 → 调用方（ingest）标 rejected「清洗后无可读文本」。
 */

const MD_IMG_RE = /!\[[^\]]*\]\([^)]*\)/g                  // 仅用于 replace（带 g）
const MD_IMG_TEST_RE = /!\[[^\]]*\]\([^)]*\)/
const BARE_MD_IMG_RE = /^\s*!\[[^\]]*\]\s*$/
const IMG_TAG_RE = /<img\b[^>]*\/?>/gi                     // 仅用于 replace（带 g）
const IMG_TAG_TEST_RE = /<img\b/i
const DOT_NOISE_RE = /^[.\s…·﹒。]{2,}$/                    // 「…」「。。。」类连续行（含全角句点连排）
const PAGE_NUM_RE = /^\s*\d{1,4}\s*$/
const PAGE_FOOT_RE = /^\s*第\s*\d+\s*页(\s*(共|\/|，)\s*\d+\s*页)?\s*$/
const ASCII_NOISE_RE = /^[\x21-\x7E]{9,}$/                  // >8 且无空格（\x20 排除）无元音见下
const hasVowel = (s) => /[aeiouAEIOU]/.test(s)
/** 行尾「有标点」判定（中英文句读 + 括引号收尾）——有标点则不与下一行拼接 */
const ENDS_WITH_PUNCT = /[。！？；：、…—～!?,.;:)\]）】」』"']$/

const isCJK = (ch) => {
  const c = typeof ch === 'string' ? ch.codePointAt(0) : 0
  return (c >= 0x4E00 && c <= 0x9FFF) || (c >= 0x3400 && c <= 0x4DBF) || (c >= 0xF900 && c <= 0xFAFF)
}

/**
 * cleanText(raw, { repeatMin = 3 })
 * → { text, clean: { strippedImages, ocrNoise, fixedBreaks, headersFooters }, stats: { inChars, outChars, droppedLines } }
 */
export function cleanText(raw, { repeatMin = 3 } = {}) {
  const input = String(raw ?? '')
  const clean = { strippedImages: 0, ocrNoise: 0, fixedBreaks: 0, headersFooters: 0 }
  let dropped = 0

  // ── ① 剥图片引用（保留「图 3-1」「如图所示」等正文文字）──────────────────────
  let lines = input.split(/\r?\n/).map((line) => {
    if (!MD_IMG_TEST_RE.test(line) && !IMG_TAG_TEST_RE.test(line) && !BARE_MD_IMG_RE.test(line)) return line
    clean.strippedImages += 1
    const rest = line.replace(MD_IMG_RE, '').replace(IMG_TAG_RE, '')
    if (rest.trim() === '' || BARE_MD_IMG_RE.test(line)) { dropped += 1; return null }   // 整行删
    return rest                                                                          // 剥掉标记留正文
  }).filter((l) => l !== null)

  // ── ② OCR 噪声行删除 ─────────────────────────────────────────────────────
  lines = lines.filter((line) => {
    const t = line.trim()
    if (t === '') return true                                   // 空行保留（段落边界）
    if (DOT_NOISE_RE.test(t)) { clean.ocrNoise += 1; dropped += 1; return false }
    if (PAGE_NUM_RE.test(t)) { clean.ocrNoise += 1; dropped += 1; return false }
    if (PAGE_FOOT_RE.test(t)) { clean.ocrNoise += 1; dropped += 1; return false }
    if (ASCII_NOISE_RE.test(t) && !hasVowel(t) && !/^\d+$/.test(t)) { clean.ocrNoise += 1; dropped += 1; return false }
    return true
  })

  // ── ④ 页眉页脚（重复出现 ≥ repeatMin 次的非空行）───────────────────────────
  const freq = new Map()
  for (const line of lines) {
    const t = line.trim()
    if (t === '') continue
    freq.set(t, (freq.get(t) ?? 0) + 1)
  }
  const repeated = new Set([...freq.entries()].filter(([, n]) => n >= repeatMin).map(([t]) => t))
  if (repeated.size) {
    lines = lines.filter((line) => {
      const t = line.trim()
      if (t !== '' && repeated.has(t)) { clean.headersFooters += 1; dropped += 1; return false }
      return true
    })
  }

  // ── ③ 断行修复（最后做：拼接不影响重复行统计与噪声判定）──────────────────────
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const cur = lines[i]
    const next = lines[i + 1]
    if (cur.trim() === '' || next == null || next.trim() === '') { out.push(cur); continue }
    const curT = cur.replace(/\s+$/, '')
    // 英文连字符断词：行尾 - 且下一行以字母开头 → 去连字符拼接
    if (/[A-Za-z]$/.test(curT.slice(0, -1)) && curT.endsWith('-') && /^[A-Za-z]/.test(next)) {
      out.push(curT.slice(0, -1) + next)
      clean.fixedBreaks += 1
      i += 1
      continue
    }
    // 中文硬换行：行尾无标点且下一行以 CJK 开头 → 拼接
    if (!ENDS_WITH_PUNCT.test(curT) && isCJK(next.trim()[0])) {
      out.push(curT + next.trim())
      clean.fixedBreaks += 1
      i += 1
      continue
    }
    out.push(cur)
  }

  const text = out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + (out.length ? '\n' : '')
  return {
    text,
    clean,
    stats: { inChars: input.length, outChars: text.trim().length, droppedLines: dropped },
  }
}
