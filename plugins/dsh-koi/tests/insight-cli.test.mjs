/**
 * docs/32 §6.2 第一批 ④ CLI smoke 测试 —— tools/koi.mjs 新增 insight 三合一子命令
 * （similarity/percentile/aggregate），全经子进程真实执行（market-migrate.test.mjs 先例：
 * DSH_HOME/KOI_CONFIG 指向临时目录；夹具直接种 koi/draws/<game>.json；零网络零外部依赖）。
 * 附加纪律断言：目录哈希前后一致 —— insight 命令零落盘（§8.5 本批零新表）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const NODE = process.execPath
// 路径锚定测试文件自身位置（验收门可从仓库任意 cwd 运行，如 D:/QQ工作区 根目录）
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = path.resolve(TEST_DIR, '..')
const KOI = path.join(PKG_ROOT, 'tools', 'koi.mjs')

// p3 夹具（升序入库；与 tests/insight.test.mjs 同源手算口径：26286 为名义下一期）
const P3_ENTRIES = [
  { issue: '26281', date: '2026-10-22', digits: [1, 2, 3] },
  { issue: '26282', date: '2026-10-23', digits: [4, 5, 6] },
  { issue: '26283', date: '2026-10-24', digits: [7, 8, 9] },
  { issue: '26284', date: '2026-10-25', digits: [0, 2, 4] },
  { issue: '26285', date: '2026-10-26', digits: [3, 3, 3] },
]

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'koi-insight-'))

/** 种库：koi/draws/p3.json（drawstore 升序存形态，schemaVersion 1） */
function mkHome({ seeded = true } = {}) {
  const home = tmpdir()
  const dataDir = path.join(home, 'koi')
  if (seeded) {
    fs.mkdirSync(path.join(dataDir, 'draws'), { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'draws', 'p3.json'), JSON.stringify({ schemaVersion: 1, entries: P3_ENTRIES }, null, 2))
  }
  return home
}

const runKoi = (home, args) => spawnSync(NODE, [KOI, ...args], {
  env: { ...process.env, DSH_HOME: home, KOI_CONFIG: path.join(home, 'koi.config.json') },
  encoding: 'utf8',
  timeout: 60_000,
})

const hashDir = (dir) => {
  const out = {}
  const walk = (d) => {
    for (const n of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, n.name)
      if (n.isDirectory()) walk(p)
      else out[path.relative(dir, p).replaceAll('\\', '/')] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
    }
  }
  if (fs.existsSync(dir)) walk(dir)
  return out
}

test('insight similarity：默认名义下一期 26286 + top-K 表 + BC-001 注记；--json 结构（scanned=4/target.priorCount=5/hits 严格早于目标期）；零落盘', () => {
  const home = mkHome()
  const before = hashDir(home)
  const r = runKoi(home, ['insight', 'similarity', 'p3', '--k', '2'])
  assert.equal(r.status, 0, `退出码 0（stderr：${r.stderr}）`)
  assert.ok(r.stdout.includes('相似局势检索'))
  assert.ok(r.stdout.includes('目标期 26286'), '默认目标期=nextIssue 名义下一期（scheduler.js:296 同款）')
  assert.ok(r.stdout.includes('当前局势（最近一期开奖）'))
  assert.ok(r.stdout.includes('后续开奖'), '命中表带各期后续开奖')
  assert.ok(r.stdout.includes('无预测力'), 'BC-001 注记常驻')
  assert.ok(r.stdout.includes('号码：789') || r.stdout.includes('号码：'), '号码行呈现')
  const j = JSON.parse(runKoi(home, ['insight', 'similarity', 'p3', '--k', '2', '--json']).stdout)
  assert.equal(j.scanned, 4, '候选=有前期历史且 <26286：26282..26285')
  assert.equal(j.target.priorCount, 5)
  assert.equal(j.hits.length, 2, '--k 2 截断')
  assert.ok(j.hits.every((h) => Number(h.issue) < 26286), '防前视：命中严格早于目标期')
  assert.ok(j.note.includes('无预测力'))
  assert.deepEqual(hashDir(home), before, 'insight 命令零落盘（目录哈希不变）')
})

test('insight percentile：主区分布/按 cell 遗漏/「当前=历史分位」段；--json 手算值（p0d1 p50=1.5、maxRun max=3）；--cell 过滤；零落盘', () => {
  const home = mkHome()
  const before = hashDir(home)
  const r = runKoi(home, ['insight', 'percentile', 'p3'])
  assert.equal(r.status, 0, `退出码 0（stderr：${r.stderr}）`)
  assert.ok(r.stdout.includes('极值/分位数档案'))
  assert.ok(r.stdout.includes('现算不落表'))
  assert.ok(r.stdout.includes('最长连号'))
  assert.ok(r.stdout.includes('当前局势 vs 历史分位'), '§6.2② 注入语义演示段')
  assert.match(r.stdout, /历史 \d+\.\d 分位/)
  const j = JSON.parse(runKoi(home, ['insight', 'percentile', 'p3', '--json']).stdout)
  assert.equal(j.count, 5)
  assert.equal(j.cells.p0d1.p50, 1.5, '手算（tests/insight-percentile.test.mjs 同源）')
  assert.equal(j.summary.maxRun.max, 3)
  assert.ok(j.note.includes('无预测力'))
  const filtered = runKoi(home, ['insight', 'percentile', 'p3', '--cell', 'p0d1'])
  assert.equal(filtered.status, 0)
  assert.ok(filtered.stdout.includes('p0d1'))
  assert.ok(!filtered.stdout.includes('p2d9'), '--cell 过滤后不打印其他 cell')
  assert.deepEqual(hashDir(home), before, 'insight 命令零落盘')
})

test('insight aggregate：markdown 三段在位（转移频次表/盲区清单含 AC 值）；--json blindSpots；无参/坏彩种/空库错误路径', () => {
  const home = mkHome()
  const before = hashDir(home)
  const r = runKoi(home, ['insight', 'aggregate', 'p3'])
  assert.equal(r.status, 0, `退出码 0（stderr：${r.stderr}）`)
  assert.ok(r.stdout.includes('## 转移频次表'))
  assert.ok(r.stdout.includes('## 因子覆盖盲区清单'))
  assert.ok(r.stdout.includes('**AC 值**'))
  assert.ok(r.stdout.includes('无预测力'))
  const j = JSON.parse(runKoi(home, ['insight', 'aggregate', 'p3', '--json']).stdout)
  assert.deepEqual(j.blindSpots.uncovered.map((d) => d.dimension), ['ac', 'span'])
  assert.equal(j.count, 5)
  assert.deepEqual(hashDir(home), before, 'insight 命令零落盘')
  // 错误路径：无子命令 → 用法 + 退出 1；彩种非法 → 退出 1；空库 → 指引先回填 + 退出 1
  const noSub = runKoi(home, ['insight'])
  assert.equal(noSub.status, 1)
  assert.match(noSub.stderr, /用法：insight/)
  const badGame = runKoi(home, ['insight', 'similarity', 'pks'])
  assert.equal(badGame.status, 1)
  assert.match(badGame.stderr, /彩种要是/)
  const emptyHome = mkHome({ seeded: false })
  const empty = runKoi(emptyHome, ['insight', 'percentile', 'p3'])
  assert.equal(empty.status, 1)
  assert.match(empty.stderr, /本地库为空/)
})
