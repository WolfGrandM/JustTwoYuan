/**
 * 收尾批 T3 —— EPUB/PDF 零依赖文本提取与摄入链测试（lib/extract.js + ingest 挂点）。
 *
 * P3 拍板优先级：EPUB=zip+XHTML node 内置解析；TXT/MD 不动；PDF=尽力提取文本型（未压缩文本流），
 * 图片版/加密/压缩流复杂明确拒收并给「请转文字版」指引；零 npm 依赖纪律（本测试自带最小 zip 写入器
 * 与手写 PDF 夹具，与被测实现同零依赖域）。
 *
 * 夹具纪律：zip 写入器按 PK 规范手写（本地头+中央目录+EOCD+CRC32，stored/deflate 两法）；
 * PDF 内容流手写（BT…ET + Tj/hex 串）。所有断言数字/文本均来自本测试内构造数据。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { detectFormat, extractIfNeeded, extractEpub, extractPdf, pdfStreamText } from '../lib/extract.js'
import { createIngest } from '../lib/ingest.js'
import { createCardsStore } from '../lib/cards.js'
import { createUsageTracker } from '../lib/usage.js'
import { createJobLock } from '../lib/joblock.js'

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'koi-extract-'))
const NOON = () => new Date('2026-10-25T12:00:00')

// ── 最小 zip 写入器（PK 规范：CRC32 + 本地头 + 中央目录 + EOCD；stored/deflate）───────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    t[n] = c >>> 0
  }
  return t
})()
const crc32 = (buf) => {
  let c = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

/** entries: [{ name, data(Buffer|string), deflate? }] → Buffer（EPUB 夹具用） */
function mkZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const e of entries) {
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf8')
    const data = e.deflate ? zlib.deflateRawSync(raw) : raw
    const method = e.deflate ? 8 : 0
    const nameBuf = Buffer.from(e.name, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)          // UTF-8 名字标志
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    locals.push(local, nameBuf, data)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(Buffer.concat([central, nameBuf]))
    offset += 30 + nameBuf.length + data.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}

/** 手写 PDF（未压缩文本流 / 图片版 / 压缩流 / 加密 四型） */
function mkPdf({ chinese = true, ascii = true, imageOnly = false, compressed = false, encrypted = false } = {}) {
  const zh = '红球和值区间法。'
  const hex = '<FEFF' + Buffer.from(zh, 'utf16le').swap16().toString('hex').toUpperCase() + '>'   // UTF-16BE + BOM
  const bodyParts = []
  if (!imageOnly) {
    bodyParts.push('BT /F1 18 Tf 72 700 Td')
    if (ascii) bodyParts.push('(SSQ red-sum band rule 90-130.) Tj')
    if (chinese) bodyParts.push('0 -24 Td')
    if (chinese) bodyParts.push(`${hex} Tj`)
    bodyParts.push('ET')
  } else {
    bodyParts.push('q 100 0 0 100 10 10 cm /Im0 Do Q')   // 无 BT 文字操作数
  }
  const content = Buffer.from(bodyParts.join('\n'), 'latin1')
  const stream = compressed ? zlib.deflateSync(content) : content
  const parts = [
    Buffer.from('%PDF-1.4\n', 'latin1'),
    Buffer.from('1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n', 'latin1'),
    Buffer.from('2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj\n', 'latin1'),
    Buffer.from('3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>endobj\n', 'latin1'),
    Buffer.from(`4 0 obj<< /Length ${stream.length}${compressed ? ' /Filter /FlateDecode' : ''} >>stream\n`, 'latin1'),
    stream,
    Buffer.from('\nendstream\nendobj\n', 'latin1'),
  ]
  if (imageOnly) {
    // 独立图片 XObject 流（DCTDecode）——图片版判定素材
    parts.push(Buffer.from('5 0 obj<< /Subtype /Image /Filter /DCTDecode /Width 4 /Height 4 /Length 4 >>stream\n', 'latin1'))
    parts.push(Buffer.from([0xFF, 0xD8, 0xFF, 0xD9]))
    parts.push(Buffer.from('\nendstream\nendobj\n', 'latin1'))
  }
  parts.push(Buffer.from(`trailer<< /Root 1 0 R /Size ${encrypted ? 6 : 5}${encrypted ? ' /Encrypt 5 0 R' : ''} >>\n%%EOF\n`, 'latin1'))
  return Buffer.concat(parts)
}

/** EPUB 夹具：mimetype + container + OPF + 章节（可配：加密 encryption.xml / 空章节 / deflate） */
function mkEpub({ encrypted = false, emptyChapter = false, deflate = false, chapters = ['chapter1'] } = {}) {
  const entries = [{ name: 'mimetype', data: 'application/epub+zip' }]
  if (encrypted) {
    entries.push({ name: 'META-INF/encryption.xml', data: '<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><EncryptedData><EncryptionMethod/></EncryptedData></encryption>' })
  }
  entries.push({ name: 'META-INF/container.xml', data: '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>' })
  const manifest = chapters.map((c, i) => `<item id="c${i}" href="${c}.xhtml" media-type="application/xhtml+xml"/>`).join('')
  const spine = chapters.map((_, i) => `<itemref idref="c${i}"/>`).join('')
  entries.push({
    name: 'OEBPS/content.opf',
    deflate,
    data: `<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><manifest>${manifest}</manifest><spine>${spine}</spine></package>`,
  })
  for (const c of chapters) {
    entries.push({
      name: `OEBPS/${c}.xhtml`,
      deflate,
      data: emptyChapter
        ? '<html><body></body></html>'
        : `<html><body><h1>双色球和值区间法</h1><p>红球六码和值长期落在 90 至 130 区间，配合冷号回补观察。</p><p>蓝球参考遗漏排行。</p></body></html>`,
    })
  }
  return mkZip(entries)
}

/** 轻量摄入夹具（mock 拆卡 agent 按契约路径交卷，逐次不同名防判重；无 backtest → 只入库不因子化） */
function mkIngest({ readCfg = () => ({}) } = {}) {
  const dir = tmpdir()
  const cardsStore = createCardsStore({ dataDir: dir, now: NOON })
  const usage = createUsageTracker({ dataDir: dir, now: NOON })
  const lock = createJobLock({ file: path.join(dir, 'job-lock.json'), now: NOON })
  let callN = 0
  const agent = async (text) => {
    const m = String(text).match(/(\S+\.cards\.p?\d*\.json)/)
    if (m) {
      callN += 1
      const variants = [
        { name: '和值区间法', rule: '红球六码和值长期落在 90 至 130 区间，配合冷号回补观察。' },
        { name: '深冷蓝球法', rule: '蓝球遗漏超过十期视为深冷，追冷回补需配合大小奇偶双看。' },
      ]
      const v = variants[(callN - 1) % variants.length]
      fs.writeFileSync(m[1], JSON.stringify({ schemaVersion: 1, cards: [{ ...v, games: ['ssq'], computable: true, dupOf: null, similarTo: null }] }))
    }
  }
  const ingest = createIngest({
    dshHome: dir, cardsStore, usage, lock, promptAgent: agent,
    now: NOON, readCfg, log: () => {}, backtest: null,
    budgetState: () => ({ demo: { allowLLM: true } }),
    waitMs: 300,
  })
  return { ingest, cardsStore }
}

// ── 提取器单测 ────────────────────────────────────────────────────────────────

test('T3 文本型 PDF 提取：未压缩 Tj/hex(UTF-16BE) 流 → 中文+ASCII 逐字提出，detectFormat 魔数优先', () => {
  const pdf = mkPdf({})
  assert.equal(detectFormat(pdf, { name: 'x.txt' }), 'pdf', '魔数 %PDF- 优先于扩展名')
  const r = extractPdf(pdf)
  assert.equal(r.ok, true, `提取成功：${r.error ?? ''}`)
  assert.ok(r.text.includes('红球和值区间法。'), `中文 hex(UTF-16BE+BOM) 解码：${r.text}`)
  assert.ok(r.text.includes('SSQ red-sum band rule 90-130.'), 'ASCII 字面量逐字提出')
  assert.ok(r.text.includes('\n'), 'Td 换行保段落')
  assert.equal(extractIfNeeded(pdf, { name: 'x.txt' }).ok, true, 'extractIfNeeded 单点入口直通')
})

test('T3 图片型 PDF 拒收文案：无文字操作数 + 图片 XObject → 未能提取到文本（图片版/扫描版）+ 请转文字版', () => {
  const r = extractPdf(mkPdf({ imageOnly: true }))
  assert.equal(r.ok, false)
  assert.match(r.error, /未能从 PDF 提取到文本/)
  assert.match(r.error, /图片版\/扫描版 PDF/)
  assert.match(r.error, /请转文字版/, '拒收文案带请转文字版指引（拍板原文）')
})

test('T3 PDF 加密拒收与压缩流拒收：/Encrypt 引用与 FlateDecode 滤波分别给明确原因', () => {
  const enc = extractPdf(mkPdf({ encrypted: true }))
  assert.equal(enc.ok, false)
  assert.match(enc.error, /PDF 已加密/)
  assert.match(enc.error, /请转文字版/)
  const comp = extractPdf(mkPdf({ compressed: true }))
  assert.equal(comp.ok, false)
  assert.match(comp.error, /压缩流（FlateDecode 等/)
  assert.match(comp.error, /请转文字版/)
  // 缺 %PDF 头
  const fake = extractPdf(Buffer.from('not a pdf at all'))
  assert.equal(fake.ok, false)
  assert.match(fake.error, /不是有效的 PDF/)
})

test('T3 EPUB 样例全链（提取单测）：mimetype/container/OPF spine 顺序 + stored/deflate 两法 + htmlToText', () => {
  const epub = mkEpub({ deflate: true })
  assert.equal(detectFormat(epub, { name: '书.txt' }), 'epub', 'PK 头 + EPUB mimetype 识别（魔数优先）')
  const r = extractEpub(epub)
  assert.equal(r.ok, true, `${r.error ?? ''}`)
  assert.ok(r.text.includes('红球六码和值长期落在 90 至 130 区间，配合冷号回补观察。'), '章节正文逐字提取')
  assert.ok(r.text.includes('双色球和值区间法'), 'h1 标题在位')
  assert.ok(r.spineDocs === 1 && r.zipEntries >= 4)
  // stored 法（无 deflate）同样可读
  const r2 = extractEpub(mkEpub({ deflate: false }))
  assert.equal(r2.ok, true)
  assert.ok(r2.text.includes('90 至 130 区间'))
})

test('T3 加密 EPUB 拒收 + 损坏 zip 拒收 + 缺 mimetype：明确文案不硬凑', () => {
  const enc = extractEpub(mkEpub({ encrypted: true }))
  assert.equal(enc.ok, false)
  assert.match(enc.error, /EPUB 已加密（DRM 保护）/)
  const bad = extractEpub(Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.from('garbage-not-a-zip')])
  )
  assert.equal(bad.ok, false)
  assert.match(bad.error, /不是有效的 EPUB（zip 目录损坏或不可读）/)
  const noMime = extractEpub(mkZip([{ name: 'chapter.xhtml', data: '<html><body>正文</body></html>' }]))
  assert.equal(noMime.ok, false)
  assert.match(noMime.error, /缺 EPUB mimetype/)
})

test('T3 空文档：EPUB 空章节 → 提取 ok 但文本空 → 既有清洗管线拒收「清洗后无可读文本」', async () => {
  const { ingest } = mkIngest()
  const acc = ingest.acceptBuffer({ name: '空书.epub', buffer: mkEpub({ emptyChapter: true }), process: false })
  assert.equal(acc.ok, true, '扩展名白名单放行（拒收发生在提取/清洗语义层）')
  const r = await ingest.processJob(acc.job.id)
  assert.equal(r.ok, true)
  assert.equal(r.job.status, 'rejected')
  assert.match(r.job.error, /清洗后无可读文本/)
})

test('T3 EPUB/PDF 全链入 ingest：accept → 提取 → cleanText 清洗 → 拆卡 → done + 卡片入库（拆卡/因子化零改动）', async () => {
  const { ingest, cardsStore } = mkIngest()
  const acc = ingest.acceptBuffer({ name: '技巧书.epub', buffer: mkEpub({ deflate: true }), process: false })
  assert.equal(acc.ok, true)
  const r = await ingest.processJob(acc.job.id)
  assert.equal(r.ok, true, `${r.job?.error ?? ''}`)
  assert.equal(r.job.status, 'done')
  assert.deepEqual(r.job.meta, { format: 'epub', zipEntries: r.job.meta.zipEntries, spineDocs: 1 }, '提取面元数据如实入 job')
  assert.ok(r.job.meta.zipEntries >= 4)
  assert.equal(cardsStore.list().length, 1, '拆卡出卡片（既有管线零改动）')
  assert.match(cardsStore.list()[0].rule, /90 至 130 区间/)
  // 文本型 PDF 同链
  const acc2 = ingest.acceptBuffer({ name: '技巧书.pdf', buffer: mkPdf({}), process: false })
  const r2 = await ingest.processJob(acc2.job.id)
  assert.equal(r2.ok, true)
  assert.equal(r2.job.status, 'done')
  assert.equal(r2.job.meta.format, 'pdf')
  assert.equal(cardsStore.list().length, 2, 'PDF 拆卡出第二张卡片')
  assert.match(cardsStore.list()[1].name, /深冷蓝球法/)
})

test('T3 格式自动识别：.txt 名字实为 PDF → 按魔数路由 PDF 提取；超大文件上限对 epub/pdf 生效（413）', async () => {
  const { ingest } = mkIngest()
  const acc = ingest.acceptBuffer({ name: '技巧.txt', buffer: mkPdf({}), process: false })
  assert.equal(acc.ok, true, '.txt 扩展名在白名单放行——内容魔数在 processJob 内识别')
  const r = await ingest.processJob(acc.job.id)
  assert.equal(r.ok, true)
  assert.equal(r.job.status, 'done', '按魔数路由到 PDF 提取（非 utf8 直读）')
  assert.equal(r.job.meta.format, 'pdf', '格式自动识别结果入 job.meta')
  // 超大文件上限（既有 413 守卫对新格式同等生效）
  const { ingest: ing2 } = mkIngest({ readCfg: () => ({ ingest: { maxFileMB: 1 } }) })
  const over = ing2.acceptBuffer({ name: '大书.epub', buffer: Buffer.alloc(1024 * 1024 + 1), process: false })
  assert.equal(over.ok, false)
  assert.equal(over.code, 413)
  const over2 = ing2.acceptBuffer({ name: '大书.pdf', buffer: Buffer.alloc(1024 * 1024 + 1), process: false })
  assert.equal(over2.ok, false)
  assert.equal(over2.code, 413)
  // pdfStreamText 转义面：八进制转义（\050=\(、\351=é 字节）与括号转义（\)）
  const t = pdfStreamText('BT (a\\050b\\)c\\351d) Tj ET')
  assert.equal(t, 'a(b)céd', '八进制转义 \\050=\\(、\\) 转义、\\351=latin1 é')
})
