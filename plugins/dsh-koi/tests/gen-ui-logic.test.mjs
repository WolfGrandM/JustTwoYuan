/**
 * v0.2-B3 T-12 —— 内联副本生成器的同源守卫。
 *
 * 三件事：
 *   ① client.js 的生成块必须与 lib/ui-logic.js 当前内容一致（等价于 --check；手改会被拦）
 *   ② 排除清单只有服务端成员，且生成块里不得出现它们（浏览器包不拖 validateConfig 链）
 *   ③ 权威源新增的非排除导出必须被生成（防止「加了导出但忘了重跑生成器」）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { extractBlock, renderBlock, parseExports, SERVER_ONLY } from '../tools/gen-ui-logic.mjs'

const CLIENT = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const UI_SRC = fs.readFileSync(new URL('../lib/ui-logic.js', import.meta.url), 'utf8')

test('T-12 生成块与权威源同源（手改即失败）', () => {
  const cur = extractBlock(CLIENT)
  assert.ok(cur, 'client.js 必须保留 BEGIN/END 生成标记')
  const norm = (s) => String(s ?? '').replace(/\r\n/g, '\n')
  assert.equal(norm(cur), norm(renderBlock()), '生成块已过期：运行 node tools/gen-ui-logic.mjs')
})

test('T-12 排除清单只有服务端成员，且生成块零引用', () => {
  assert.deepEqual([...SERVER_ONLY].sort(), ['SECTIONS', 'sectionValidation'])
  const block = extractBlock(CLIENT)
  for (const name of SERVER_ONLY) {
    assert.ok(!new RegExp(`\\b${name}\\b`).test(block), `${name} 不应出现在浏览器生成块（服务端依赖 validateConfig）`)
  }
})

test('T-12 权威源的全部非排除导出都已生成', () => {
  const names = parseExports(UI_SRC).map((b) => b.name)
  const block = extractBlock(CLIENT)
  for (const n of names.filter((x) => !SERVER_ONLY.has(x))) {
    assert.ok(new RegExp(`\\b${n}\\b`).test(block), `${n} 未被生成——请重跑 node tools/gen-ui-logic.mjs`)
  }
})
