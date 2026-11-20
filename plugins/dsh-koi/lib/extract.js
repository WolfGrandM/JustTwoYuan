/**
 * dsh-koi 学习摄入扩展：EPUB/PDF 文本提取（收尾批 T3，P3 拍板优先级）。
 *
 * 格式策略（拍板原文）：EPUB=zip+XHTML（node:zlib 零依赖解析）；TXT/MD 已支持不动；
 * PDF=零依赖尽力提取**文本型**（未压缩文本流），图片版/加密/压缩流复杂的 PDF **明确拒收**
 * 并给「请转文字版」指引。**零 npm 依赖纪律不破**——zip 解析=手写字节遍历+node:zlib inflateRawSync
 * （Node 内置）；PDF=纯字符串/字节扫描。实查结论：两条路均零依赖可行（tests/extract-ingest.test.mjs
 * 全链验证），无需报拍板 ADR。
 *
 * 挂点：lib/ingest.js processJob cleaning 段——extractIfNeeded(buf) 先按魔数识别（格式自动识别，
 * 优先于扩展名），epub/pdf 提取出的文本再进既有 cleanText 清洗管线（拆卡/因子化零改动）。
 *
 * 边界（尽力而为的诚实口径）：
 *   · EPUB：只认 zip+EPUB mimetype；META-INF/encryption.xml 在场=加密（DRM）拒收；
 *     spine 顺序来自 container.xml→OPF（解析失败回退全部 xhtml/html 按名排序，如实降级）。
 *   · PDF：加密（trailer /Encrypt 引用）拒收；内容流带 FlateDecode 等压缩滤波（拍板：压缩流复杂拒收，
 *     现代压缩流多为 CID 编码+字体 CMap，硬解出来是乱码——诚实不硬凑）；只扫未压缩流里 BT…ET 的
 *     Tj/TJ/'/" 字面量（八进制转义/十六进制串/UTF-16BE BOM/原始 UTF-8 字节尽力解码）；
 *     提不到文本 → 图片版/扫描版拒收 + 请转文字版。
 */
import zlib from 'node:zlib'

const GUIDE = '请转文字版后重新上传（另存 .txt / .md 或导出文字版）'

// ── 最小 zip 读取器（EOCD → 中央目录 → 本地头；stored + deflate 两法；zip64 不需要——≤20MB 上限）──

/** 手写 EOCD 定位 + 中央目录解析。不可读 → null（损坏 zip 拒收路径） */
function readZipEntries(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) return null
  let eocd = -1
  const floor = Math.max(0, buf.length - 22 - 65_535)
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4B && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) { eocd = i; break }
  }
  if (eocd < 0) return null
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const entries = new Map()
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) return null
    const method = buf.readUInt16LE(p + 10)
    const csize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8')
    entries.set(name, { method, csize, localOffset })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/** 按中央目录条目读数据（本地头另算 name/extra 长度；method 0=stored 8=deflate，其余不支持） */
function zipRead(buf, entry) {
  if (!entry) return null
  const p = entry.localOffset
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== 0x04034b50) return null
  const nameLen = buf.readUInt16LE(p + 26)
  const extraLen = buf.readUInt16LE(p + 28)
  const start = p + 30 + nameLen + extraLen
  const data = buf.slice(start, start + entry.csize)
  if (entry.method === 0) return data
  if (entry.method === 8) {
    try { return zlib.inflateRawSync(data) } catch { return null }
  }
  return null
}

// ── 格式自动识别（魔数优先于扩展名）──────────────────────────────────────────

/**
 * 按内容魔数识别格式：'pdf'（%PDF- 头）/ 'epub'（PK zip 头 + EPUB mimetype 或 .epub 扩展名）/
 * 'zip'（PK 头非 EPUB）/ 'text'（其余——.txt/.md 原路径零改动）。
 */
export function detectFormat(buf, { name = '' } = {}) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf ?? ''), 'latin1')
  if (b.length >= 5 && b.slice(0, 5).toString('latin1') === '%PDF-') return 'pdf'
  if (b.length >= 4 && b.slice(0, 4).toString('latin1') === 'PK\x03\x04') {
    const entries = readZipEntries(b)
    const mime = entries?.get('mimetype')
    const isEpub = (mime && zipRead(b, mime)?.toString('latin1').includes('application/epub+zip')) || /\.epub$/i.test(String(name))
    return isEpub ? 'epub' : 'zip'
  }
  return 'text'
}

/**
 * 摄入管线单点入口：epub/pdf → 提取文本；text → null（调用方走既有 utf8 直读，行为零改动）。
 * 返回 { ok:true, text, meta:{format,…} } | { ok:false, error }（error=明确拒收文案，含请转文字版指引）。
 */
export function extractIfNeeded(buf, { name = '' } = {}) {
  const fmt = detectFormat(buf, { name })
  if (fmt === 'text') return null
  if (fmt === 'epub') {
    const r = extractEpub(buf)
    if (!r.ok) return r
    return { ok: true, text: r.text, meta: { format: 'epub', zipEntries: r.zipEntries, spineDocs: r.spineDocs } }
  }
  if (fmt === 'pdf') {
    const r = extractPdf(buf)
    if (!r.ok) return r
    return { ok: true, text: r.text, meta: { format: 'pdf', textStreams: r.textStreams } }
  }
  return { ok: false, error: `文件内容是 zip 压缩包但不是有效的 EPUB（缺 EPUB mimetype 声明）——${GUIDE}` }
}

// ── EPUB：zip + XHTML → 文本 ─────────────────────────────────────────────────

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      const c = parseInt(h, 16)
      return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ' '
    })
    .replace(/&#(\d+);/g, (_, d) => {
      const c = parseInt(d, 10)
      return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ' '
    })
    .replace(/&([a-z]+);/gi, (_, n) => ENTITIES[n.toLowerCase()] ?? ' ')
}

/** XHTML/HTML → 文本（剥 script/style/注释；块级标签换行保段落；实体解码）——确定性纯函数 */
export function htmlToText(html) {
  let s = String(html ?? '')
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
  s = s.replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section|article|figcaption|caption)\s*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(/<[^>]+>/g, ' ')
  s = decodeEntities(s)
  s = s.replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
  return s.trim()
}

/**
 * EPUB 文本提取。拒收（ok:false）：损坏 zip / 加密（encryption.xml）/ 缺 EPUB mimetype。
 * spine 顺序：container.xml → rootfile OPF → manifest+itemref（解析失败回退全部 xhtml/html 按名排序）。
 */
export function extractEpub(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf ?? ''), 'latin1')
  const entries = readZipEntries(b)
  if (!entries || !entries.size) return { ok: false, error: `不是有效的 EPUB（zip 目录损坏或不可读）——${GUIDE}` }
  if (entries.has('META-INF/encryption.xml')) return { ok: false, error: `EPUB 已加密（DRM 保护）——请解密后重新导出，或${GUIDE}` }
  const mimetype = entries.get('mimetype')
  if (!mimetype || !(zipRead(b, mimetype) ?? Buffer.alloc(0)).toString('latin1').includes('application/epub+zip')) {
    return { ok: false, error: `不是有效的 EPUB（缺 EPUB mimetype 声明）——${GUIDE}` }
  }
  // container.xml → OPF 路径
  let opfPath = null
  const container = entries.get('META-INF/container.xml')
  if (container) {
    const c = (zipRead(b, container) ?? Buffer.alloc(0)).toString('utf8')
    opfPath = /full-path\s*=\s*"([^"]+)"/.exec(c)?.[1] ?? null
  }
  // spine 文档清单（OPF 目录为 href 基准）
  const base = opfPath ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : ''
  const spineFiles = []
  if (opfPath && entries.has(opfPath)) {
    const opf = (zipRead(b, entries.get(opfPath)) ?? Buffer.alloc(0)).toString('utf8')
    const manifest = new Map()
    for (const m of opf.matchAll(/<item\b[^>]*>/g)) {
      const id = /\bid\s*=\s*"([^"]+)"/.exec(m[0])?.[1]
      const href = /\bhref\s*=\s*"([^"]+)"/.exec(m[0])?.[1]
      if (id && href) manifest.set(id, href)
    }
    for (const r of opf.matchAll(/<itemref\b[^>]*>/g)) {
      const idref = /\bidref\s*=\s*"([^"]+)"/.exec(r[0])?.[1]
      const href = idref ? manifest.get(idref) : null
      if (href) spineFiles.push(href.replace(/^\.\//, ''))
    }
  }
  if (!spineFiles.length) {
    for (const n of [...entries.keys()].filter((n) => /\.(xhtml|html|htm)$/i.test(n)).sort()) spineFiles.push(n.replace(/^\.\//, ''))
  }
  const parts = []
  let spineDocs = 0
  for (const href of spineFiles) {
    const entry = entries.get(base + href) ?? entries.get(href)
    if (!entry) continue
    const data = zipRead(b, entry)
    if (!data) continue   // 不支持的压缩法/损坏条目：跳过（其余文档照常，尽力而为）
    parts.push(htmlToText(data.toString('utf8')))
    spineDocs += 1
  }
  return { ok: true, text: parts.filter((t) => t).join('\n\n'), zipEntries: entries.size, spineDocs }
}

// ── PDF：只扫未压缩内容流里的 BT…ET 文字操作数 ─────────────────────────────────

const COMPRESSED_FILTER_RE = /FlateDecode|LZWDecode|RunLengthDecode|ASCII85Decode|ASCIIHexDecode|DCTDecode|JPXDecode|CCITTFaxDecode|JBIG2Decode/

/** PDF 字面量串（括号平衡 + 转义）字节级扫描：返回 [latin1 原始字节串, 下一索引] */
function pdfLiteralAt(s, i) {
  let depth = 1
  let out = ''
  let j = i + 1
  while (j < s.length) {
    const ch = s[j]
    if (ch === '\\') {
      const n = s[j + 1] ?? ''
      if (n === 'n' || n === 'r') { out += '\n'; j += 2; continue }
      if (n === 't') { out += '\t'; j += 2; continue }
      if (n === 'b' || n === 'f') { out += ' '; j += 2; continue }
      if (n >= '0' && n <= '7') {
        const oct = /^([0-7]{1,3})/.exec(s.slice(j + 1))?.[1] ?? ''
        if (oct) { out += String.fromCharCode(parseInt(oct, 8)); j += 1 + oct.length; continue }
      }
      if (n === '\r' || n === '\n') { j += 2; continue }   // 行续接（行尾反斜杠）
      out += n
      j += 2
      continue
    }
    if (ch === '(') { depth += 1; out += ch; j += 1; continue }
    if (ch === ')') {
      depth -= 1
      if (depth === 0) return [out, j + 1]
      out += ch
      j += 1
      continue
    }
    out += ch
    j += 1
  }
  return [out, j]
}

/** 字节串解码（尽力）：UTF-16BE BOM 优先 → UTF-8 干净则 UTF-8 → latin1 兜底 */
function decodePdfBytes(latin1) {
  const b = Buffer.from(String(latin1 ?? ''), 'latin1')
  if (b.length >= 4 && b[0] === 0xFE && b[1] === 0xFF) {
    let s = ''
    for (let k = 2; k + 1 < b.length; k += 2) s += String.fromCharCode((b[k] << 8) | b[k + 1])
    return s
  }
  const u = b.toString('utf8')
  if (!(u.match(/\uFFFD/g) ?? []).length) return u
  return b.toString('latin1')
}

/** 一段内容流 → 文本（只认 BT…ET 内的 Tj/TJ/'/"；Td/TD/T* 视为换行；hex 串按字节解码） */
export function pdfStreamText(chunk) {
  const out = []
  const blockRe = /BT([\s\S]*?)ET/g
  let bm
  while ((bm = blockRe.exec(chunk))) {
    const block = bm[1]
    let i = 0
    let lineBuf = ''
    const flush = () => { if (lineBuf.trim()) out.push(lineBuf.trim()); lineBuf = '' }
    while (i < block.length) {
      const ch = block[i]
      if (ch === '(') {
        const [raw, next] = pdfLiteralAt(block, i)
        lineBuf += decodePdfBytes(raw)
        i = next
        continue
      }
      if (ch === '<' && block[i + 1] !== '<') {
        const end = block.indexOf('>', i)
        if (end > i) {
          const hex = block.slice(i + 1, end).replace(/\s+/g, '')
          let raw = ''
          for (let k = 0; k + 1 < hex.length; k += 2) raw += String.fromCharCode(parseInt(hex.slice(k, k + 2), 16))
          lineBuf += decodePdfBytes(raw)
          i = end + 1
          continue
        }
      }
      if (ch === 'T' && (block[i + 1] === 'd' || block[i + 1] === 'D' || block[i + 1] === '*')) { flush(); i += 2; continue }
      if (ch === "'" || ch === '"') { flush(); i += 1; continue }
      i += 1
    }
    flush()
  }
  return out.join('\n')
}

/**
 * PDF 文本提取（尽力=未压缩文本流）。拒收（ok:false）：缺 %PDF 头 / 加密（/Encrypt 引用）/
 * 提不到文本（图片版/扫描版 或 内容流全是压缩滤波——拍板明确拒收并给请转文字版指引）。
 */
export function extractPdf(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf ?? ''), 'latin1')
  if (b.length < 5 || b.slice(0, 5).toString('latin1') !== '%PDF-') {
    return { ok: false, error: `不是有效的 PDF（缺 %PDF 头）——${GUIDE}` }
  }
  const latin = b.toString('latin1')
  if (/\/Encrypt\s+\d+\s+\d+\s+R/.test(latin)) {
    return { ok: false, error: `PDF 已加密（带口令/权限保护）——请解密后重新导出，或${GUIDE}` }
  }
  let sawCompressed = false
  let sawImage = false
  const texts = []
  const re = /stream\r?\n/g
  let m
  while ((m = re.exec(latin))) {
    const streamStart = m.index + m[0].length
    const dictStart = Math.max(0, m.index - 400)
    const dict = latin.slice(dictStart, m.index)
    const endIdx = latin.indexOf('endstream', streamStart)
    if (endIdx < 0) break
    if (COMPRESSED_FILTER_RE.test(dict)) {
      if (/\/Subtype\s*\/Image|DCTDecode|JPXDecode|CCITTFaxDecode|JBIG2Decode/.test(dict)) sawImage = true
      else sawCompressed = true
      re.lastIndex = endIdx + 9   // 跳过 'endstream' 整词——防其内部 'stream\n' 子串吞掉下一流的 dict 匹配
      continue
    }
    const t = pdfStreamText(b.slice(streamStart, endIdx).toString('latin1'))
    if (t.trim()) texts.push(t.trim())
    re.lastIndex = endIdx + 9
  }
  const text = texts.join('\n\n')
  if (!text.trim()) {
    const why = sawImage && !sawCompressed ? '图片版/扫描版 PDF（未压缩文本流中无文字）'
      : sawCompressed ? '内容流为压缩流（FlateDecode 等——零依赖只提取未压缩文本流）'
        : '未发现可提取的未压缩文本流'
    return { ok: false, error: `未能从 PDF 提取到文本（${why}）——${GUIDE}` }
  }
  return { ok: true, text, textStreams: texts.length }
}
