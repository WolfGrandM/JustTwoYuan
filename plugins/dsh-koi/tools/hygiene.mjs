#!/usr/bin/env node
/**
 * dsh-koi 市场包卫生扫描（市场版 NFR-102/AC-102，docs/16 §2.2.10-3）。
 *
 * 模式集（A2.1 V11 实证有效性：能命中全部已知 QQ 耦合文件，剔除白名单行后零误报）：
 *   ① 文件名 /qq/i
 *   ② 字段  push.target / napcatHttp / napcatAlive
 *   ③ 文案  NapCat / 私聊 / 作者 QQ 号
 *   ④ 包描述 QQ 表述（package.json description）
 *   ⑤ 代码内已知作者 QQ 默认值（数字串；已知号清单制，MD-27——通用数字启发式会误伤期号/端口夹具）
 * 零命中退出 0（AC-102 验收门）；命中退出 1 并逐条列出（人工复核通道）。
 *
 * 豁免：tests/ 夹具（迁移演练需要 v1.1 形态样例）、hygiene 自身、行级白名单标记
 * `/* koi-hygiene-allow *​/`（migrate-v2 必须引用 v1 字段名才能搬家——报告仍列出豁免行供复核）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF = path.resolve(fileURLToPath(import.meta.url))
const ALLOW_MARK = 'koi-hygiene-allow'

const FIELD_PATTERNS = [/push\.target/, /napcatHttp/, /napcatAlive/]
const TEXT_PATTERNS = [/NapCat/, /私聊/, /1017099872/, /983605373/]
const KNOWN_QQ = ['1017099872', '983605373']

const walk = (dir, out = []) => {
  let names = []
  try { names = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const n of names) {
    if (n.name === 'node_modules' || n.name === '.git' || n.name === '.zcode') continue
    const p = path.join(dir, n.name)
    if (n.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

export function scanPackage(root) {
  const hits = []
  const waived = []
  const files = walk(root)
  for (const file of files) {
    const rel = path.relative(root, file).replaceAll('\\', '/')
    if (rel.startsWith('tests/')) continue                       // 夹具豁免（v1.1 迁移演练样例）
    if (path.resolve(file) === SELF) continue                    // 扫描器自身
    if (/qq/i.test(path.basename(file))) hits.push({ file: rel, line: 0, kind: '文件名', detail: path.basename(file) })
    let text = ''
    try { text = fs.readFileSync(file, 'utf8') } catch { continue }
    const lines = text.split('\n')
    lines.forEach((line, i) => {
      const ln = i + 1
      const record = (kind, detail) => {
        if (line.includes(ALLOW_MARK)) waived.push({ file: rel, line: ln, kind, detail: detail + '（白名单行：' + line.trim().slice(0, 80) + '）' })
        else hits.push({ file: rel, line: ln, kind, detail: detail + '：' + line.trim().slice(0, 80) })
      }
      for (const re of FIELD_PATTERNS) if (re.test(line)) record('字段', String(re))
      for (const re of TEXT_PATTERNS) if (re.test(line)) record('文案', String(re))
      for (const qq of KNOWN_QQ) if (line.includes(qq)) record('作者QQ默认值', qq)
    })
    // 包描述 QQ 表述
    if (path.basename(file) === 'package.json') {
      try {
        const desc = String(JSON.parse(text).description ?? '')
        for (const re of [/QQ/, /私聊/, /NapCat/]) if (re.test(desc)) hits.push({ file: rel, line: 0, kind: '包描述', detail: `description 含 ${re}` })
      } catch { /* 坏 JSON 由别的门管 */ }
    }
  }
  return { hits, waived, files: files.length }
}

export async function main(argv = process.argv.slice(2)) {
  const root = path.resolve(argv[0] ?? path.dirname(path.dirname(SELF)))
  const { hits, waived, files } = scanPackage(root)
  console.log(`市场包卫生扫描：${root}（${files} 个文件；模式集=qq 文件名/push.target 等字段/NapCat·私聊·作者QQ 文案/包描述/代码默认 QQ）`)
  for (const h of hits) console.log(`✖ [${h.kind}] ${h.file}:${h.line} ${h.detail}`)
  for (const w of waived) console.log(`△ [${w.kind}·白名单] ${w.file}:${w.line} ${w.detail}`)
  if (!hits.length) {
    console.log(`零命中 ✓（白名单豁免 ${waived.length} 行已列出供人工复核）`)
    return 0
  }
  console.log(`\n命中 ${hits.length} 处 ✗ —— 市场包不得包含作者 QQ 痕迹（BC-103/NFR-102）`)
  return 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  main().then((code) => process.exit(code), (e) => { console.error(String(e?.stack ?? e)); process.exit(2) })
}
