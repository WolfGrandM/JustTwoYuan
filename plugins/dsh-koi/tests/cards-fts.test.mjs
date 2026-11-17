/**
 * M2 FTS5 全文检索（docs/28 §8，FR-038 底线组件「语义去重与全文检索不可省」/ AC-031「卡片可全文检索」）
 * —— cards.db（node:sqlite，零 npm 依赖纪律不破）单测。
 *
 * 断言面：
 *   ① 可检索性（AC-031）：写入/查询两侧 ruleTokens bigram 化同源，名称/规则/彩种三面命中，
 *      [{card, score}] 形状、score 越大越优、limit 生效、空查询空返回；
 *   ② external-content 三同步触发器全写路径（insert/update/delete）索引不漂移——
 *      以第二只读连接跑 FTS5 'integrity-check' 作证；
 *   ③ 两段式迁移（docs/28 §8.5）：构造期零数据写（db 计数 0 + DDL 幂等）→ pending 态
 *      list/get/search 退化 cards.json 全扫（detail 注明）→ ensureMigrated（域内首步）导入 +
 *      行数校验 + 快照标记 + 幂等短路 + cards.json 字节级零改动（§7 F2 验收「快照零改动」）；
 *   ④ 降级闸（§8.4）：fts:false 注入（模拟 FTS5 未编入构建）→ search LIKE 全表扫描 +
 *      detail「FTS5 不可用，词法降级」——诚实降级，绝不静默；
 *   ⑤ 判重漏斗①候选集（§8.6）：dedupCandidates top-K 供给、findRuleDup 语义不变
 *      （Jaccard ≥0.8 命中 / 变体不误伤），降级态全扫兜底（宁可少入不可漏检）；
 *   ⑥ 既有方法行为逐位不变（§2.3 约束）：addCards 默认值 / update 任意补丁键（extra 列
 *      开世界通道零丢失）/ markFactorizeFailed / setBacktest / removeByJob / get。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  createCardsStore, findRuleDup, bigramString, bigramQuery,
  FTS_UNAVAILABLE_DETAIL, MIGRATION_PENDING_DETAIL,
} from '../lib/cards.js'

const NOW = () => new Date('2026-11-18T10:00:00Z')
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'koi-cards-fts-'))

const SEED = [
  { name: '和值区间法', games: ['ssq'], rule: '红球六码和值长期落在 90 至 130 区间。', computable: true },
  { name: '蓝球追热法', games: ['ssq'], rule: '近 30 期出现 3 次以上的蓝球至少一个再出。', computable: true },
  { name: '邻号间距法', games: ['kl8'], rule: '相邻号码间距小于等于 2 的组合优先。', computable: false },
]

/** 只读第二连接查 sqlite_master（不借 store 内部——纪律面：写方只走 store 方法） */
const masterNames = (dbFile, type, like) => {
  const ro = new DatabaseSync(dbFile, { readOnly: true })
  try {
    return ro.prepare(`SELECT name FROM sqlite_master WHERE type=? AND name LIKE ? ORDER BY name`).all(type, like).map((r) => r.name)
  } finally { ro.close() }
}

test('FTS5 落库：cards.db + cards_fts 虚表 + 三同步触发器存在；node:sqlite 零 npm 依赖', () => {
  const dir = tmpdir()
  const cards = createCardsStore({ dataDir: dir, now: NOW })
  assert.ok(cards.fileOf().endsWith('cards.db'), '存储主载体 = cards.db')
  assert.ok(cards.ftsReady(), '本构建 FTS5 可用（docs/28 §8 选型前提）')
  assert.deepEqual(masterNames(cards.fileOf(), 'table', 'cards_fts'), ['cards_fts'], 'external-content 虚表在库')
  assert.deepEqual(masterNames(cards.fileOf(), 'trigger', 'cards_fts_%'),
    ['cards_fts_ad', 'cards_fts_ai', 'cards_fts_au'], 'AI/AD/AU 三触发器全写路径覆盖')
  assert.ok(cards.snapshotFileOf().endsWith('cards.json'), '备份双载体：cards.json 快照路径可达')
})

test('可检索性（AC-031）：名称/规则/彩种三面命中；[{card,score}] 形状；score 越大越优；limit 生效', () => {
  const dir = tmpdir()
  const cards = createCardsStore({ dataDir: dir, now: NOW })
  cards.addCards(SEED, { source: '技巧.md', sourceJob: 'job-1' })
  // 名称/规则面
  const h1 = cards.search('和值区间')
  assert.equal(h1.length, 1)
  assert.equal(h1[0].card.name, '和值区间法')
  assert.equal(typeof h1[0].score, 'number')
  assert.ok(h1[0].score > 0, 'score = -rank（bm25 取负，越大越优）')
  assert.equal(h1.detail, null, 'FTS 正常态 detail=null')
  const h2 = cards.search('蓝球追热')
  assert.equal(h2[0].card.name, '蓝球追热法')
  // 彩种面（games 列）
  assert.equal(cards.search('kl8')[0].card.name, '邻号间距法')
  // 排序：多卡共享 bigram 时匹配更多者在前
  const h3 = cards.search('ssq')
  assert.ok(h3.length === 2 && h3[0].score >= h3[1].score, 'score 降序')
  // limit 生效 + 空查询/无命中空返回
  assert.equal(cards.search('和值区间', { limit: 0 }).length, 0)
  assert.deepEqual([...cards.search('')], [], '空查询 → 空数组')
  assert.deepEqual([...cards.search('绝不存在的技巧串xyz')], [], '无命中 → 空数组')
  // 返回卡对象与 list 同形（完整字段）
  const card = cards.search('和值区间')[0].card
  assert.equal(card.computable, true)
  assert.deepEqual(card.games, ['ssq'])
  assert.equal(card.trustLevel, 'mid')
  assert.ok(card.createdAt && card.lastReviewedAt)
})

test('索引同步（external-content 三触发器）：update 旧文本失配新文本命中；removeByJob 失配；integrity-check 无漂移', () => {
  const dir = tmpdir()
  const cards = createCardsStore({ dataDir: dir, now: NOW })
  const [c1, c2, c3] = cards.addCards(SEED, { source: '技巧.md', sourceJob: 'job-1' })
  // UPDATE 路径：AFTER UPDATE OF name, rule, games 触发器——'delete' 特殊 INSERT + 重插
  cards.update(c3.id, { rule: '相邻号码间距不大于 2 的组合优先考虑。' })
  assert.deepEqual([...cards.search('小于等于')], [], '旧文本失配（无漂移残留）')
  assert.equal(cards.search('不大于')[0].card.name, '邻号间距法', '新文本命中')
  // DELETE 路径：AFTER DELETE 触发器
  assert.equal(cards.removeByJob('job-1'), 3)
  assert.deepEqual([...cards.search('和值区间')], [], '删除后检索不再命中')
  assert.deepEqual([...cards.search('蓝球追热')], [], '删除后检索不再命中（2）')
  // FTS5 'integrity-check'：external-content 索引与内容表逐位一致（第二连接作证——
  // integrity-check 以 INSERT 语句承载，须可写连接；单参形式；本检查零数据变更）
  const ro = new DatabaseSync(cards.fileOf())
  try {
    ro.prepare(`INSERT INTO cards_fts(cards_fts) VALUES('integrity-check')`).run()
  } finally { ro.close() }
})

test('两段式迁移·构造期：pending 探测零数据写；list/get/search 退化 cards.json 全扫（detail 注明）', () => {
  const dir = tmpdir()
  const legacy = {
    schemaVersion: 1,
    cards: [
      { id: 'card-x1', name: '旧卡甲', source: '旧.md', sourceType: 'user-file', sourceJob: 'old-1', games: ['ssq'],
        rule: '红球和值九十到一百三十。', computable: true, trustLevel: 'mid',
        clean: { strippedImages: 0, ocrNoise: 0, fixedBreaks: 0, headersFooters: 0 }, similarOf: null,
        status: 'active', factorId: null, backtest: null,
        createdAt: '2026-01-01T00:00:00.000Z', lastReviewedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'card-x2', name: '旧卡乙', source: '旧.md', sourceType: 'user-file', sourceJob: 'old-1', games: ['kl8'],
        rule: '选号尾数偏好小。', computable: false, trustLevel: 'high',
        clean: { strippedImages: 1, ocrNoise: 0, fixedBreaks: 0, headersFooters: 0 }, similarOf: 'card-x1',
        status: 'active', factorId: null, backtest: null, factorizeError: '适用彩种非唯一',
        createdAt: '2026-01-02T00:00:00.000Z', lastReviewedAt: '2026-01-02T00:00:00.000Z' },
    ],
  }
  const jsonFile = path.join(dir, 'cards.json')
  fs.writeFileSync(jsonFile, JSON.stringify(legacy, null, 2) + '\n')
  const bytes = fs.readFileSync(jsonFile)
  const cards = createCardsStore({ dataDir: dir, now: NOW })
  assert.ok(cards.migrationPending(), 'cards.json 在 && cards.db 计数 0 → pendingMigration（构造期只读探测）')
  // 构造期零数据写：db cards 表无行、快照标记未落
  {
    const ro = new DatabaseSync(cards.fileOf(), { readOnly: true })
    try {
      assert.equal(ro.prepare('SELECT COUNT(*) AS n FROM cards').get().n, 0, '构造期 db 行数 = 0')
      assert.equal(ro.prepare(`SELECT COUNT(*) AS n FROM schema_info WHERE key='cards_json_snapshot'`).get().n, 0, '快照标记未落')
    } finally { ro.close() }
  }
  // 读面三件全走 cards.json（数据可见性零回退）
  assert.deepEqual(cards.list().map((c) => c.id), ['card-x1', 'card-x2'], 'list 全扫 json')
  assert.equal(cards.get('card-x2').name, '旧卡乙')
  assert.equal(cards.get('card-x2').factorizeError, '适用彩种非唯一', 'factorizeError 经迁移面可读')
  const sh = cards.search('旧卡甲')
  assert.equal(sh[0]?.card.name, '旧卡甲', 'search 走 json 全扫仍可命中')
  assert.equal(sh.detail, MIGRATION_PENDING_DETAIL, '诚实降级 detail 注明')
  assert.equal(fs.readFileSync(jsonFile).equals(bytes), true, 'pending 态 cards.json 字节不动')
})

test('两段式迁移·域内实跑：导入+行数校验+快照标记+幂等短路；cards.json 快照字节零改动；FTS 命中迁移内容', () => {
  const dir = tmpdir()
  const legacy = {
    schemaVersion: 1,
    cards: [
      { id: 'card-x1', name: '旧卡甲', source: '旧.md', sourceType: 'user-file', sourceJob: 'old-1', games: ['ssq'],
        rule: '红球和值九十到一百三十。', computable: true, trustLevel: 'mid',
        clean: { strippedImages: 0, ocrNoise: 0, fixedBreaks: 0, headersFooters: 0 }, similarOf: null,
        status: 'active', factorId: null, backtest: null, legacyNote: '主人的手工注记',
        createdAt: '2026-01-01T00:00:00.000Z', lastReviewedAt: '2026-01-01T00:00:00.000Z' },
    ],
  }
  const jsonFile = path.join(dir, 'cards.json')
  fs.writeFileSync(jsonFile, JSON.stringify(legacy, null, 2) + '\n')
  const bytes = fs.readFileSync(jsonFile)
  const cards = createCardsStore({ dataDir: dir, now: NOW })
  const r = cards.ensureMigrated()
  assert.equal(r.ok, true)
  assert.equal(r.skipped, false)
  assert.equal(r.imported, 1, '导入 1 行')
  assert.ok(r.snapshot.endsWith('cards.json'))
  assert.equal(cards.migrationPending(), false, '标志已清')
  // 幂等短路（第二段重复触发零写）
  const r2 = cards.ensureMigrated()
  assert.equal(r2.skipped, true, '幂等短路')
  // 快照零改动：字节级不动；快照标记落 cards.db（cards.json 不承载标记）
  assert.equal(fs.readFileSync(jsonFile).equals(bytes), true, 'cards.json 字节级零改动（§7 F2）')
  {
    const ro = new DatabaseSync(cards.fileOf(), { readOnly: true })
    try {
      const mark = JSON.parse(ro.prepare(`SELECT value FROM schema_info WHERE key='cards_json_snapshot'`).get().value)
      assert.equal(mark.rows, 1)
      assert.ok(mark.file.endsWith('cards.json'))
    } finally { ro.close() }
  }
  // 迁移后读/写/检索全走 db：字段同形（含 extra 开世界键）
  const list = cards.list()
  assert.equal(list.length, 1)
  assert.equal(list[0].id, 'card-x1')
  assert.equal(list[0].legacyNote, '主人的手工注记', '未知键经 extra 列迁移零丢失')
  assert.deepEqual(list[0].games, ['ssq'])
  assert.equal(list[0].computable, true)
  const h = cards.search('和值九十')
  assert.equal(h[0]?.card.name, '旧卡甲', 'FTS 命中迁移内容')
  assert.equal(h.detail, null, 'FTS 正常态（pending 已清）')
  // 迁移后写路径：update / 回填
  const upd = cards.update('card-x1', { factorId: 'f-1' })
  assert.equal(upd.factorId, 'f-1')
  assert.equal(cards.get('card-x1').legacyNote, '主人的手工注记', 'update 后 extra 键仍在')
})

test('降级闸（§8.4，fts:false 注入模拟 FTS5 未编入构建）：LIKE 词法降级 + detail 注明 + 写入照常', () => {
  const dir = tmpdir()
  const cards = createCardsStore({ dataDir: dir, now: NOW, fts: false })
  assert.equal(cards.ftsReady(), false, '降级闸开启')
  assert.deepEqual(masterNames(cards.fileOf(), 'table', 'cards_fts'), [], '虚表残件已清理')
  assert.deepEqual(masterNames(cards.fileOf(), 'trigger', 'cards_fts_%'), [], '触发器残件已清理')
  cards.addCards(SEED, { source: '技巧.md', sourceJob: 'job-1' })
  const h = cards.search('和值区间')
  assert.equal(h[0]?.card.name, '和值区间法', 'LIKE 全表扫描仍可命中')
  assert.equal(h.detail, FTS_UNAVAILABLE_DETAIL, '诚实降级：detail 注明')
  assert.ok(h[0].score >= 0 && h[0].score <= 1, '降级态 score = Jaccard 0..1')
  // 写入照常（无触发器路径）：update/removeByJob 不报错
  const [c] = cards.list()
  cards.update(c.id, { status: 'retired' })
  assert.equal(cards.get(c.id).status, 'retired')
  assert.equal(cards.removeByJob('job-1'), 3)
  // 漏斗①降级口径：全扫兜底（宁可少入不可漏检）
  cards.addCards(SEED.slice(0, 1), { source: 'again.md', sourceJob: 'job-2' })
  assert.equal(cards.dedupCandidates('和值区间法 红球六码和值').length, 1, 'dedupCandidates 退化全扫')
})

test('判重漏斗①候选集（§8.6）：dedupCandidates 供给 top-K、findRuleDup 语义不变（≥0.8 命中/变体不误伤）', () => {
  const dir = tmpdir()
  const cards = createCardsStore({ dataDir: dir, now: NOW })
  cards.addCards([{ name: '蓝球追热法', games: ['ssq'], rule: '近 30 期出现 3 次以上的蓝球至少一个再出。', computable: true }],
    { source: '旧.md', sourceJob: 'job-0' })
  // 候选集 = 卡片对象数组（与旧 list() 同形，findRuleDup 直供）
  const cand = cards.dedupCandidates('另一个名字 近 30 期出现 3 次以上的蓝球至少一个再出', { limit: 100 })
  assert.ok(Array.isArray(cand) && cand.length >= 1 && cand[0].name === '蓝球追热法')
  // 规则词法 0.95 ≥ 0.8 → 命中（漏斗①保守拒入语义保持）
  const dup = findRuleDup({ name: '另一个名字', rule: '近 30 期出现 3 次以上的蓝球至少一个再出' }, cand)
  assert.equal(dup?.type, 'rule')
  assert.equal(dup?.card.name, '蓝球追热法')
  // 变体（Jaccard < 0.8）→ 不误伤（similar-to 入库路径畅通）
  const v = findRuleDup({ name: '蓝球追热法变体', rule: '近 30 期出现 3 次以上的蓝球中两个再出（区间不同）。' }, cand)
  assert.equal(v, null, 'Jaccard < 0.8 不误伤')
  // 名称同键路径：FTS 召回 + nameKey 精确裁决（同名卡 → name 路先于 rule 路命中）
  const cand2 = cards.dedupCandidates('蓝球追热法 近 30 期出现 3 次以上的蓝球至少一个再出。')
  const dup2 = findRuleDup({ name: '蓝球追热法', rule: '近 30 期出现 3 次以上的蓝球至少一个再出。' }, cand2)
  assert.equal(dup2?.type, 'name')
  assert.equal(dup2?.card.name, '蓝球追热法')
})

test('纯函数：bigramString（tokenize_ci 本体）/bigramQuery（引号包裹 OR 连接、纯标点剔除、注入转义）', () => {
  assert.equal(bigramString('和值区间'), '和值 值区 区间')
  assert.equal(bigramString(''), '')
  assert.equal(bigramString('A B'), 'AB', '空白先剥离再 bigram（与 ruleTokens 同源）')
  const q = bigramQuery('和值区间')
  assert.equal(q, '"和值" OR "值区" OR "区间"', '唯一 bigram 引号包裹 OR 连接')
  assert.equal(bigramQuery('！！！'), '', '纯标点 bigram（unicode61 零 token 空短语）剔除')
  assert.equal(bigramQuery('a"b'), '"a""" OR """b"', 'FTS5 语法注入转义（bigram 内双引号成对化）')
  // NFKC 全半角归一两侧同源
  assert.equal(bigramString('和值９０'), bigramString('和值90'))
})

test('既有方法行为逐位不变（§2.3 约束）：addCards 默认值 / update 任意补丁键 / markFactorizeFailed / setBacktest / get', () => {
  const dir = tmpdir()
  let tick = 0
  const cards = createCardsStore({ dataDir: dir, now: () => new Date(1_700_000_000_000 + (tick += 1)) })
  const [c] = cards.addCards([{ name: '和值区间法', games: ['ssq'], rule: 'R'.repeat(500), computable: true, trustLevel: 'high' }],
    { source: '技巧.md', sourceType: 'cli', sourceJob: 'job-1', clean: { strippedImages: 2, ocrNoise: 1, fixedBreaks: 3, headersFooters: 4 } })
  assert.match(c.id, /^card-170000000000\d+-[0-9a-z]+$/, 'id 形如 card-<ts>-<rand>（now() 注入时间戳）')
  assert.equal(c.name, '和值区间法')
  assert.equal(c.rule.length, 400, 'rule 截 400（既有口径）')
  assert.equal(c.source, '技巧.md')
  assert.equal(c.sourceType, 'cli')
  assert.equal(c.sourceJob, 'job-1')
  assert.deepEqual(c.games, ['ssq'])
  assert.equal(c.computable, true)
  assert.equal(c.trustLevel, 'high', '显式信任级不覆盖')
  assert.deepEqual(c.clean, { strippedImages: 2, ocrNoise: 1, fixedBreaks: 3, headersFooters: 4 })
  assert.equal(c.similarOf, null)
  assert.equal(c.status, 'active')
  assert.equal(c.factorId, null)
  assert.equal(c.backtest, null)
  // get / 任意补丁键（extra 列开世界通道零丢失）
  assert.equal(cards.get(c.id).id, c.id)
  assert.equal(cards.get('card-none'), null)
  const u1 = cards.update(c.id, { note: '主人备注', factorId: 'f-9' })
  assert.equal(u1.note, '主人备注')
  assert.equal(u1.factorId, 'f-9')
  assert.equal(cards.list()[0].note, '主人备注', '任意补丁键持久化（list 复读仍在）')
  // undefined 值补丁 = 抹除。如实注记一处病态边差异：旧 JSON store 抹除后键消失（复读 undefined），
  // 新 store 列态统一读回 null（新建卡本就 factorId: null）——调用方全为真值判断（c.factorId ?），
  // 零行为差；这里断言新口径并记录差异，不谎称逐位相同。
  const u2 = cards.update(c.id, { factorId: undefined, status: 'observed' })
  assert.equal(u2.status, 'observed')
  assert.equal(u2.factorId, null, 'undefined 补丁值抹除既有值（读回列态 null）')
  assert.equal(cards.get(c.id).factorId, null, '复读同样已抹除')
  // markFactorizeFailed / setBacktest
  const m = cards.markFactorizeFailed(c.id, 'DSL 解析失败')
  assert.equal(m.status, 'factorize-failed')
  assert.equal(m.factorizeError, 'DSL 解析失败')
  const b = cards.setBacktest(c.id, { rounds: 100, hitRate: 0.3, pValue: 0.02, verdict: 'better-in-sample', runRef: 'bt-1' })
  assert.equal(b.status, 'factorize-failed', 'setBacktest 只写 backtest/lastReviewedAt，状态不覆盖')
  assert.equal(b.backtest.verdict, 'better-in-sample')
  assert.ok(b.lastReviewedAt > m.lastReviewedAt ?? true)
  // removeByJob 计数与幂等
  assert.equal(cards.removeByJob('job-1'), 1)
  assert.equal(cards.removeByJob('job-1'), 0, '二次回滚零 diff（S-119）')
  assert.equal(cards.list().length, 0)
})
