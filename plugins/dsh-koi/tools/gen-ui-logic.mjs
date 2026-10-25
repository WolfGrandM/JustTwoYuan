#!/usr/bin/env node
/**
 * T-12：把 lib/ui-logic.js 的「浏览器可用导出」机械生成到 lib/client.js 的标记块。
 *
 * 为什么要有它：浏览器工厂无法 import ESM，内联副本是手工维护的第二份实现（MD-21），
 * 漏同步就产生真实缺陷（TF-13 的 `latest` 即同类盲区）。本工具让内联副本只由权威源生成，
 * 手改会被 `--check` 与测试拦下。
 *
 * 生成范围（v0.2B3-D3）：
 *   排除 sectionValidation —— 依赖 validateConfig（→ draws/tiers），整链不能进浏览器包；
 *   排除 SECTIONS —— 服务端/测试面的分区清单（sectionValidation 的对外视图），浏览器零消费。
 *   其余导出全量生成，新增导出默认自动纳入。
 *
 * 用法：
 *   node tools/gen-ui-logic.mjs           # 就地写入
 *   node tools/gen-ui-logic.mjs --check   # 只比对（CI/测试用），过期退出码 1
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const SRC = path.join(ROOT, 'lib', 'ui-logic.js')
const CLIENT = path.join(ROOT, 'lib', 'client.js')

const BEGIN_LINE = '    // >>> BEGIN GENERATED: lib/ui-logic.js（node tools/gen-ui-logic.mjs 生成，勿手改）'
const END_LINE = '    // <<< END GENERATED'
const BEGIN_KEY = '// >>> BEGIN GENERATED: lib/ui-logic.js'

/** 浏览器不可内联的导出（见头注释；改动需同步 tests/ui-equivalence.test.mjs 的豁免清单） */
export const SERVER_ONLY = new Set(['SECTIONS', 'sectionValidation'])

const EXPORT_RE = /^export (const|function) ([A-Za-z_$][\w$]*)/

/** 解析权威源的顶层导出块（含紧邻的文档注释），返回 [{name, lines}] —— 顺序即源文件顺序 */
export function parseExports(source) {
  const lines = source.split(/\r?\n/)
  const hits = []
  for (let i = 0; i < lines.length; i++) if (EXPORT_RE.test(lines[i])) hits.push(i)

  const blocks = []
  const starts = hits.map((at) => {
    let s = at
    while (s > 0) {
      const prev = lines[s - 1].trim()
      if (prev.startsWith('//') || prev.startsWith('/**') || prev.startsWith('*') || prev.endsWith('*/')) { s--; continue }
      break
    }
    return s
  })
  for (let n = 0; n < hits.length; n++) {
    const at = hits[n]
    const start = starts[n]
    let end = n + 1 < hits.length ? starts[n + 1] : lines.length
    while (end > at && lines[end - 1].trim() === '') end--
    const name = lines[at].match(EXPORT_RE)[2]
    const body = lines.slice(start, end)
    body[at - start] = body[at - start].replace(/^export /, '')
    blocks.push({ name, lines: body })
  }
  return blocks
}

const pad = (ls, prefix) => ls.map((l) => (l.trim() === '' ? '' : prefix + l))

/** 渲染生成块（不含前后空行） */
export function renderBlock() {
  const blocks = parseExports(fs.readFileSync(SRC, 'utf8')).filter((b) => !SERVER_ONLY.has(b.name))
  const names = blocks.map((b) => b.name)
  const body = []
  for (const b of blocks) {
    body.push(...b.lines)
    body.push('')
  }
  return [
    BEGIN_LINE,
    '    exports.__uiLogic = (() => {',
    ...pad(body, '      '),
    `      return { ${names.join(', ')} };`,
    '    })();',
    END_LINE,
  ].join('\n')
}

/** 取出 client.js 现有生成块（无标记返回 null） */
export function extractBlock(clientText) {
  const lines = clientText.split(/\r?\n/)
  const b = lines.findIndex((l) => l.trimStart().startsWith(BEGIN_KEY))
  const e = lines.findIndex((l) => l.trimStart() === '// <<< END GENERATED')
  if (b < 0 || e < 0 || e < b) return null
  return lines.slice(b, e + 1).join('\n')
}

/** 就地重写生成块；标记缺失即报错（不猜位置） */
export function writeBlock() {
  const text = fs.readFileSync(CLIENT, 'utf8')
  const lines = text.split(/\r?\n/)
  const b = lines.findIndex((l) => l.trimStart().startsWith(BEGIN_KEY))
  const e = lines.findIndex((l) => l.trimStart() === '// <<< END GENERATED')
  if (b < 0 || e < 0 || e < b) throw new Error('client.js 缺少生成标记（BEGIN/END）——先手工放回标记再生成')
  const next = [...lines.slice(0, b), ...renderBlock().split('\n'), ...lines.slice(e + 1)].join('\n')
  fs.writeFileSync(CLIENT, next)
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  const norm = (s) => String(s ?? '').replace(/\r\n/g, '\n')
  if (process.argv.includes('--check')) {
    const cur = extractBlock(fs.readFileSync(CLIENT, 'utf8'))
    const want = renderBlock()
    if (norm(cur) !== norm(want)) {
      console.error('生成块与 lib/ui-logic.js 不同源：请运行 node tools/gen-ui-logic.mjs')
      process.exit(1)
    }
    console.log(`生成块最新 ✓（${parseExports(fs.readFileSync(SRC, 'utf8')).length - SERVER_ONLY.size} 个成员）`)
  } else {
    writeBlock()
    console.log(`已生成 lib/client.js 内联块（排除 ${[...SERVER_ONLY].join(', ')}）`)
  }
}
