/**
 * v0.2-B1 T-01 —— 浏览器加载链（exports → roster → combo）静态属性测试（纯只读，零网络）。
 * 动机：该链路失败模式是「静默跳过」（545f491：exports 缺 ./client 映射时面板『设置 → 彩票』
 * 从未出现，无报错）；docs/20 §4 / ADR-0005 已登记「部署后必开一次面板」。本文件把三类本地可验
 * 的破坏拦在「跑测试即失败」，不覆盖宿主运行时行为（docs/22 P2 风险列已声明此边界）。
 * 三腿各自独立断言：
 *   ① package.json exports["./client"] 指向存在文件；
 *   ② cordis.patch.yml 的 name === 包名（注释自警：不一致 = 「装上了但面板 404」）且含 dsh-koi insert；
 *   ③ lib/client.js 以 window.__ModuleLoader__.load({ id }) 挂载且 id === 包名。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

test('加载链腿①：package.json exports["./client"] 存在且指向存在文件', () => {
  const target = pkg.exports?.['./client']
  assert.equal(
    typeof target, 'string',
    `exports["./client"] 必须存在且为字符串（缺失时 dsh-client-modules 按 MissingClientBundleError 静默跳过，545f491 先例）`,
  )
  const abs = path.join(ROOT, target)
  assert.ok(
    fs.existsSync(abs),
    `exports["./client"] 指向的文件不存在: ${target}`,
  )
})

test('加载链腿②：cordis.patch.yml 的 name === 包名且含本插件 insert', () => {
  const yml = fs.readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8')
  assert.match(yml, /(^|\n)\s*- insert:/, 'cordis.patch.yml 必须含 insert 块（否则宿主不会挂载本插件）')

  const names = [...yml.matchAll(/^\s*-?\s*name:\s*(\S+)\s*$/gm)].map((m) => m[1])
  assert.ok(names.length >= 1, 'cordis.patch.yml 必须声明 name（注释自警：name 与包名不一致 = 「装上了但面板 404」）')
  for (const n of names) assert.equal(n, pkg.name, `cordis.patch.yml name "${n}" !== 包名 "${pkg.name}"`)

  const ids = [...yml.matchAll(/^\s*-?\s*id:\s*(\S+)\s*$/gm)].map((m) => m[1])
  assert.ok(ids.includes(pkg.name), `cordis.patch.yml insert 必须含 id: ${pkg.name}`)
})

test('加载链腿③：lib/client.js 以 __ModuleLoader__.load({id}) 挂载且 id === 包名', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8')
  const m = src.match(/window\.__ModuleLoader__\.load\(\{\s*id:\s*["']([^"']+)["']/)
  assert.ok(m, 'lib/client.js 必须以 window.__ModuleLoader__.load({ id: ... }) 壳挂载')
  assert.equal(m[1], pkg.name, `client.js 挂载 id "${m[1]}" !== 包名 "${pkg.name}"`)
})
