/**
 * dsh-koi 卡片库（第二波 docs/19 §4.5，FR-1014 / DC-003/DC-108；M2 FTS5 全文检索 docs/28 §8，
 * FR-038 底线组件「语义去重与全文检索不可省」/ AC-031「卡片可全文检索」）。
 *
 * 存储选型（W2A-10 → docs/28 §8 升级）：node:sqlite（Node 24 内置，零 npm 依赖纪律不破）。
 * cards.json → cards.db（与 review.db 同目录谱系）；FTS5 external-content 虚表 cards_fts +
 * 三同步触发器（AI/AD/AU 全写路径覆盖，delete 走 'delete' 特殊 INSERT——SQLite FTS5
 * §External Content Tables，漏一即索引漂移）。
 *
 * 两段式迁移（docs/28 §8.5，v1.1.0 口径）：构造期只读探测 + DDL 幂等（建空库不属数据写），
 * 零数据写；数据迁移写（cards.json 导入 + 行数校验 + 快照标记）挂进持锁域内首步
 * ——ingest/backtest acquire 成功后调 ensureMigrated()（域内首步），写入方法自带兜底触发
 * （W2A-23 cards 单写者：全部写方本就只在 ingest/backtest 持锁串行域内）。迁移标志以
 * 「活探测」实现（读/写时重查：json 在 && db 空 && 无快照标记），跨进程不陈旧——
 * scheduler 长驻进程在另一进程（CLI）完成迁移后即时切回 db 面。标志存续期间
 * list/get/search 与判重漏斗①退化为 cards.json 全扫（诚实降级不静默，S-119）；
 * 迁移后 cards.json 保留为只读快照（字节级零改动——§7 F2 验收「快照零改动」按
 * 快照文件不动解读，快照标记落 cards.db schema_info；备份双载体：fileOf()=cards.db +
 * snapshotFileOf()=cards.json）。
 *
 * 降级闸（§8.4）：FTS5 未编入构建 → CREATE VIRTUAL TABLE 抛错 → search() 退化 LIKE 全表
 * 扫描并 detail 注明「FTS5 不可用，词法降级」——诚实降级，绝不静默。
 *
 * 检索口径（§8.3）：写入/查询两侧都过 ruleTokens bigram 化（确定性、无分词依赖、与卡片判重
 * 的词法口径同源）；查询以引号包裹 bigram、OR 连接（召回层），FTS5 rank（bm25，越小越优）
 * 取负为 score（越大越优）。精度仍由 findRuleDup 的 JS Jaccard 把守——FTS 只做候选召回，
 * 不改变任何判重语义（§8.6：漏斗①候选集改由 search 供给 top-K，findRuleDup 语义不变）。
 *
 * 写方纪律（W2A-23 cards 单写者）：全部写方（ingest 入库、因子化 factorId 回填、回测结论回写）
 * 收敛在持锁进程的串行域内——本模块不持锁（锁属编排层 ingest/backtest）；谁调用谁保证在锁域内。
 *
 * 去重语义（§4.4-5/§4.5，三态）：duplicate-of（LLM 判同）→ 不入库；rule-dup（规则级疑似而
 * LLM 判 none → 保守拒入，宁可少入不可重复入库）；similar-to → 入库 + similarOf 指针。
 * 规则级判定（零成本）= 卡片名规范化精确匹配 + 规则文本词法 Jaccard ≥ 0.8（纯函数，可单测）。
 */
import path from 'node:path'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { readJson } from './io.js'

export const RULE_SIM_THRESHOLD = 0.8

/** 降级闸 detail 文案（docs/28 §8.4/§8.5：诚实降级，绝不静默） */
export const FTS_UNAVAILABLE_DETAIL = 'FTS5 不可用，词法降级'
export const MIGRATION_PENDING_DETAIL = '迁移未完成，cards.json 全扫降级'

const SCHEMA_VERSION = 1

/** 卡片对象已知键（列映射面）；其余键走 extra JSON 列（开世界通道，update 任意补丁零丢失） */
const KNOWN_KEYS = [
  'id', 'name', 'source', 'sourceType', 'sourceJob', 'games', 'rule', 'computable',
  'trustLevel', 'clean', 'similarOf', 'status', 'factorId', 'backtest', 'factorizeError',
  'createdAt', 'lastReviewedAt',
]
const DEFAULT_CLEAN = { strippedImages: 0, ocrNoise: 0, fixedBreaks: 0, headersFooters: 0 }

const DDL = `
CREATE TABLE IF NOT EXISTS schema_info(
  key TEXT PRIMARY KEY, value TEXT);

-- 与 cards.json 字段同构（docs/28 §8；games/clean/backtest 以 JSON TEXT 落列）。
-- factorize_error / extra 为蓝图 schema 的加法通道（只加不改不删）：前者承载
-- markFactorizeFailed 既有行为（cards.js 旧版 update 语义），后者保 update 任意补丁键零丢失。
CREATE TABLE IF NOT EXISTS cards(
  id TEXT PRIMARY KEY, name TEXT, source TEXT, source_type TEXT, source_job TEXT,
  games TEXT, rule TEXT, computable INTEGER, trust_level TEXT, clean TEXT,
  similar_of TEXT, status TEXT, factor_id TEXT, backtest TEXT, factorize_error TEXT,
  extra TEXT, created_at TEXT, last_reviewed_at TEXT);
`

/** FTS5 external-content 虚表 + 三同步触发器（docs/28 §8；tokenize_ci 为本模块注册的确定性 SQL 函数） */
const FTS_DDL = `
CREATE VIRTUAL TABLE IF NOT EXISTS cards_fts USING fts5(
  name_t, rule_t, games_t, content='cards', content_rowid='rowid');
CREATE TRIGGER IF NOT EXISTS cards_fts_ai AFTER INSERT ON cards BEGIN
  INSERT INTO cards_fts(rowid, name_t, rule_t, games_t)
  VALUES (new.rowid, tokenize_ci(new.name), tokenize_ci(new.rule), tokenize_ci(new.games)); END;
CREATE TRIGGER IF NOT EXISTS cards_fts_ad AFTER DELETE ON cards BEGIN
  INSERT INTO cards_fts(cards_fts, rowid, name_t, rule_t, games_t)
  VALUES ('delete', old.rowid, tokenize_ci(old.name), tokenize_ci(old.rule), tokenize_ci(old.games)); END;
CREATE TRIGGER IF NOT EXISTS cards_fts_au AFTER UPDATE OF name, rule, games ON cards BEGIN
  INSERT INTO cards_fts(cards_fts, rowid, name_t, rule_t, games_t)
  VALUES ('delete', old.rowid, tokenize_ci(old.name), tokenize_ci(old.rule), tokenize_ci(old.games));
  INSERT INTO cards_fts(rowid, name_t, rule_t, games_t)
  VALUES (new.rowid, tokenize_ci(new.name), tokenize_ci(new.rule), tokenize_ci(new.games)); END;
`

/** 名称规范化键：去空白 + NFKC（全半角归一）+ 小写 */
export function nameKey(name) {
  return String(name ?? '').normalize('NFKC').replace(/\s+/g, '').toLowerCase()
}

/** 规则文本词法 token：CJK bigram 为主（短文本退化为字符集）——确定性、可单测 */
export function ruleTokens(text) {
  const s = String(text ?? '').normalize('NFKC').replace(/\s+/g, '')
  if (!s) return new Set()
  if (s.length < 2) return new Set([s])
  const out = new Set()
  for (let i = 0; i + 1 < s.length; i++) out.add(s.slice(i, i + 2))
  return out
}

/** Jaccard 相似度（词法） */
export function jaccard(aTokens, bTokens) {
  const A = aTokens instanceof Set ? aTokens : ruleTokens(aTokens)
  const B = bTokens instanceof Set ? bTokens : ruleTokens(bTokens)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const t of A) if (B.has(t)) inter += 1
  return inter / (A.size + B.size - inter)
}

/** 规则级疑似重复判定（零成本、保守）：名称同键 或 规则词法 Jaccard ≥ 0.8 → 命中既有卡 */
export function findRuleDup({ name, rule }, existingCards) {
  const key = nameKey(name)
  for (const card of existingCards ?? []) {
    if (nameKey(card.name) === key && key !== '') return { type: 'name', card }
  }
  const tokens = ruleTokens(rule)
  for (const card of existingCards ?? []) {
    if (jaccard(tokens, ruleTokens(card.rule)) >= RULE_SIM_THRESHOLD) {
      return { type: 'rule', card, score: jaccard(tokens, ruleTokens(card.rule)) }
    }
  }
  return null
}

/**
 * tokenize_ci 的 JS 本体：ruleTokens bigram 以空格连接（docs/28 §8 落列口径）。
 * 经 db.function 注册为确定性 SQL 函数，写入（三触发器）与查询两侧同源。
 * 注意：本函数行为跨版本不可变（external-content 'delete' 分支依赖其确定性重放）。
 */
export function bigramString(text) {
  return [...ruleTokens(text)].join(' ')
}

/** FTS5 MATCH 查询串：唯一 bigram 引号包裹（防 FTS5 语法注入）+ OR 连接（召回层口径）。
 *  纯标点 bigram（unicode61 下为零 token 空短语）剔除——查询侧与索引侧同归一。 */
export function bigramQuery(q) {
  const toks = [...ruleTokens(q)].filter((t) => /[\p{L}\p{N}]/u.test(t))
  return toks.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ')
}

const randSuffix = () => Math.random().toString(36).slice(2, 8)
const safeJson = (s) => { try { return s == null ? null : JSON.parse(s) } catch { return null } }

export function createCardsStore({ dataDir, now = () => new Date(), log = () => {}, fts } = {}) {
  const JSON_FILE = path.join(dataDir ?? '.', 'cards.json')   // 旧存储 → 迁移后只读快照
  const FILE = path.join(dataDir ?? '.', 'cards.db')          // 新存储（node:sqlite）
  const legacyRead = () => readJson(JSON_FILE, { schemaVersion: 1, cards: [] })

  fs.mkdirSync(path.dirname(FILE), { recursive: true })
  const db = new DatabaseSync(FILE)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA busy_timeout = 3000')   // 跨进程（CLI × 长驻 scheduler）DDL/写偶发争用等待，绝不裸崩

  // tokenize_ci：确定性 SQL 函数（先于 FTS_DDL 注册——触发器体引用之）
  db.function('tokenize_ci', { deterministic: true }, bigramString)

  function migrate() {
    db.exec(DDL)
    const row = db.prepare(`SELECT value FROM schema_info WHERE key='schema_version'`).get()
    const v = row ? Number(row.value) : 0
    if (v > SCHEMA_VERSION) throw new Error(`cards.db schema_version ${v} 高于已知 ${SCHEMA_VERSION}，拒绝打开（docs/10 §6 规则 2）`)
    if (!row) {
      db.prepare(`INSERT INTO schema_info(key, value) VALUES('schema_version', ?)`).run(String(SCHEMA_VERSION))
    }
  }
  migrate()   // 构造期 DDL 幂等（docs/28 §8.5：建空库不属数据写，不在任何持锁域）

  // ── FTS5 装配（§8.4 降级闸：首用时建表抛错 → LIKE 词法降级，绝不静默）──────────
  let ftsOk = false
  if (fts !== false) {
    try {
      db.exec(FTS_DDL)
      ftsOk = true
    } catch {
      // FTS5 未编入构建：清残件（虚表在而触发器不在的半装状态一并撤销），诚实降级
      for (const t of ['cards_fts_ai', 'cards_fts_ad', 'cards_fts_au']) {
        try { db.exec(`DROP TRIGGER IF EXISTS ${t}`) } catch { /* 尽力清理 */ }
      }
      try { db.exec('DROP TABLE IF EXISTS cards_fts') } catch { /* 尽力清理 */ }
      ftsOk = false
    }
  }
  // fts:false 仅测试注入口（模拟 FTS5 未编入构建），生产一律缺省装配

  // ── 两段式迁移（§8.5）：活探测零数据写；数据迁移写只在持锁域（ensureMigrated）────────
  /** 迁移标志活探测：cards.json 在 && cards.db cards 计数为 0 && 无快照标记 → pending */
  function migrationPending() {
    if (db.prepare(`SELECT value FROM schema_info WHERE key='cards_json_snapshot'`).get()) return false
    const n = Number(db.prepare('SELECT COUNT(*) AS n FROM cards').get().n)
    if (n > 0) return false
    return fs.existsSync(JSON_FILE)
  }

  /**
   * 数据迁移写（两段式第二段）：cards.json 导入 + 行数校验 + 置快照标记（cards.db 侧；
   * cards.json 本体字节级零改动）+ 清标志。由 ingest/backtest acquire 成功后的域内首步
   * 显式调用；写入方法自带兜底触发（单写者纪律下等价，docs/28 §8.5）。
   * 幂等：活探测挡重入（标记/行数任一在即跳过）。
   */
  function ensureMigrated() {
    if (!migrationPending()) return { ok: true, skipped: true }
    const legacy = legacyRead()
    const cards = Array.isArray(legacy?.cards) ? legacy.cards : []
    db.exec('BEGIN IMMEDIATE')
    try {
      const ins = db.prepare(`INSERT INTO cards(
          id, name, source, source_type, source_job, games, rule, computable, trust_level, clean,
          similar_of, status, factor_id, backtest, factorize_error, extra, created_at, last_reviewed_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      for (const c of cards) ins.run(...cardToRow(c))
      const n = Number(db.prepare('SELECT COUNT(*) AS n FROM cards').get().n)
      if (n !== cards.length) throw new Error(`cards 迁移行数校验失败：db=${n} json=${cards.length}——中止回滚`)
      db.exec('COMMIT')
    } catch (e) {
      try { db.exec('ROLLBACK') } catch { /* 尽力回滚 */ }
      throw e
    }
    const at = now().toISOString()
    db.prepare(`INSERT INTO schema_info(key, value) VALUES('cards_json_snapshot', ?)`)
      .run(JSON.stringify({ file: JSON_FILE, rows: cards.length, at }))
    log(`[koi] cards.json → cards.db 迁移完成：${cards.length} 行（快照标记已落 schema_info，cards.json 保留为只读快照）`)
    return { ok: true, skipped: false, imported: cards.length, snapshot: JSON_FILE, at }
  }

  // ── 行 ↔ 卡片对象映射（与旧 JSON store 逐字段同形）────────────────────────────
  const pickExtra = (card) => {
    const extra = {}
    for (const [k, v] of Object.entries(card ?? {})) {
      if (!KNOWN_KEYS.includes(k) && v !== undefined) extra[k] = v
    }
    return Object.keys(extra).length ? JSON.stringify(extra) : null
  }

  function cardToRow(card) {
    const c = card ?? {}
    return [
      c.id ?? `card-${now().getTime()}-${randSuffix()}`,
      String(c.name ?? ''), c.source ?? '', c.sourceType ?? 'user-file', c.sourceJob ?? null,
      JSON.stringify(Array.isArray(c.games) ? c.games : []), String(c.rule ?? ''),
      c.computable === true ? 1 : 0, c.trustLevel ?? 'mid',
      JSON.stringify(c.clean ?? DEFAULT_CLEAN), c.similarOf ?? null, c.status ?? 'active',
      c.factorId ?? null, c.backtest == null ? null : JSON.stringify(c.backtest),
      c.factorizeError == null ? null : String(c.factorizeError), pickExtra(c),
      c.createdAt ?? now().toISOString(), c.lastReviewedAt ?? now().toISOString(),
    ]
  }

  function rowToCard(r) {
    const card = {
      id: r.id,
      name: r.name,
      source: r.source,
      sourceType: r.source_type,
      sourceJob: r.source_job,
      games: safeJson(r.games) ?? [],
      rule: r.rule,
      computable: r.computable === 1,
      trustLevel: r.trust_level,
      clean: safeJson(r.clean) ?? { ...DEFAULT_CLEAN },
      similarOf: r.similar_of,
      status: r.status,
      factorId: r.factor_id,
      backtest: safeJson(r.backtest),
      createdAt: r.created_at,
      lastReviewedAt: r.last_reviewed_at,
    }
    if (r.factorize_error != null) card.factorizeError = r.factorize_error
    const extra = safeJson(r.extra)
    if (extra && typeof extra === 'object') Object.assign(card, extra)
    return card
  }

  const writeRow = (card) => db.prepare(`UPDATE cards SET
      name=?, source=?, source_type=?, source_job=?, games=?, rule=?, computable=?, trust_level=?,
      clean=?, similar_of=?, status=?, factor_id=?, backtest=?, factorize_error=?, extra=?,
      created_at=?, last_reviewed_at=? WHERE id=?`)
    .run(...cardToRow(card).slice(1), card.id)

  // ── 读面（pending 期间退化 cards.json 全扫——诚实降级）────────────────────────
  const legacyList = () => (legacyRead().cards ?? []).map((c) => ({ ...c }))

  function list() {
    if (migrationPending()) return legacyList()
    return db.prepare('SELECT * FROM cards ORDER BY rowid').all().map(rowToCard)
  }

  function get(id) {
    if (migrationPending()) return legacyList().find((c) => c.id === id) ?? null
    const r = db.prepare('SELECT * FROM cards WHERE id=?').get(id)
    return r ? rowToCard(r) : null
  }

  // ── 写面（单写者纪律：调用方保证持锁域；每写先兜底 ensureMigrated）──────────────
  /**
   * 入库（去重后的新卡；三态裁决在 ingest 侧完成——本方法不做判重）。
   * 补齐 DC-003/DC-108 必填与默认：trustLevel 默认 mid（用户上传）、status active、时间戳。
   */
  function addCards(cards, { source, sourceType, sourceJob, clean } = {}) {
    ensureMigrated()
    const created = []
    db.exec('BEGIN IMMEDIATE')
    try {
      const ins = db.prepare(`INSERT INTO cards(
          id, name, source, source_type, source_job, games, rule, computable, trust_level, clean,
          similar_of, status, factor_id, backtest, factorize_error, extra, created_at, last_reviewed_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      for (const c of Array.isArray(cards) ? cards : []) {
        const card = {
          id: `card-${now().getTime()}-${randSuffix()}`,
          name: String(c.name ?? '').slice(0, 40),
          source: c.source ?? source ?? '',
          sourceType: c.sourceType ?? sourceType ?? 'user-file',
          sourceJob: c.sourceJob ?? sourceJob ?? null,
          games: Array.isArray(c.games) ? c.games.filter(Boolean) : [],
          rule: String(c.rule ?? '').slice(0, 400),
          computable: c.computable === true,
          trustLevel: c.trustLevel ?? 'mid',
          clean: c.clean ?? clean ?? { strippedImages: 0, ocrNoise: 0, fixedBreaks: 0, headersFooters: 0 },
          similarOf: c.similarOf ?? null,
          status: 'active',
          factorId: null,
          backtest: null,
          createdAt: now().toISOString(),
          lastReviewedAt: now().toISOString(),
        }
        ins.run(...cardToRow(card))
        created.push({ ...card })
      }
      db.exec('COMMIT')
    } catch (e) {
      try { db.exec('ROLLBACK') } catch { /* 尽力回滚 */ }
      throw e
    }
    return created
  }

  /** 按 sourceJob 回滚（S-119：job 重跑前先回滚已写入的卡片，绝不静默重复入库） */
  function removeByJob(sourceJob) {
    ensureMigrated()
    const r = db.prepare('DELETE FROM cards WHERE source_job=?').run(sourceJob)
    return Number(r.changes)
  }

  /** 单卡字段更新（持锁串行域内调用；factorId 回填 / backtest 回写 / 状态标记共用）。
   *  旧 JSON store 语义保持：浅合并、任意补丁键经 extra 列零丢失。undefined 补丁值 = 抹除
   *  （旧 store 持久化语义：JSON.stringify 丢 undefined 键）——列态统一读回 null，返回对象
   *  与后续 get()/list() 同形（旧 store 返回 pre-stringify 对象、复读却见键消失，内部不一致；
   *  本实现取一致口径，调用方全为真值判断零行为差）。 */
  function update(cardId, patch) {
    ensureMigrated()
    const cur = get(cardId)
    if (!cur) return null
    const next = { ...cur }
    for (const [k, v] of Object.entries(patch ?? {})) {
      next[k] = v === undefined ? null : v
    }
    writeRow(next)
    return { ...next }
  }

  function markFactorizeFailed(cardId, reason) {
    return update(cardId, { status: 'factorize-failed', factorizeError: String(reason ?? '').slice(0, 300) })
  }

  function setBacktest(cardId, result) {
    return update(cardId, { backtest: result, lastReviewedAt: now().toISOString() })
  }

  // ── 检索面（FR-038 底线 / AC-031；docs/28 §8.3-8.6）──────────────────────────
  /** 降级评分：查询 bigram 集对 name+rule+games 拼接文本的 Jaccard（词法降级同源口径） */
  const scoreCard = (qTokens, card) => {
    const hay = `${card?.name ?? ''} ${card?.rule ?? ''} ${(Array.isArray(card?.games) ? card.games : []).join(' ')}`
    return jaccard(qTokens, ruleTokens(hay))
  }

  /**
   * 全文检索（§8.6 接口）：search(q, { limit=10 }) → [{card, score}]。
   * score 越大越相关（FTS 态 = -rank，bm25 取负；降级态 = Jaccard 0..1）。
   * 返回数组带 detail 属性（null=FTS 正常；降级时为诚实降级文案——§8.4/§8.5）。
   */
  const limOf = (limit) => {
    const n = Number(limit)
    return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 10
  }

  function search(q, { limit = 10 } = {}) {
    const n = limOf(limit)
    const qTokens = ruleTokens(q)
    if (!qTokens.size || n === 0) return Object.assign([], { detail: null })
    if (migrationPending()) {
      const hits = legacyList()
        .map((card) => ({ card, score: scoreCard(qTokens, card) }))
        .filter((h) => h.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, n)
      return Object.assign(hits, { detail: MIGRATION_PENDING_DETAIL })
    }
    if (!ftsOk) {
      const esc = String(q ?? '').replace(/\s+/g, '').replace(/([%_\\])/g, '\\$1')
      if (!esc) return Object.assign([], { detail: null })
      const pat = `%${esc}%`
      const hits = db.prepare(
        `SELECT * FROM cards WHERE name LIKE ? ESCAPE '\\' OR rule LIKE ? ESCAPE '\\' OR games LIKE ? ESCAPE '\\'`)
        .all(pat, pat, pat)
        .map(rowToCard)
        .map((card) => ({ card, score: scoreCard(qTokens, card) }))
        .filter((h) => h.score > 0 || String(h.card.rule ?? '').includes(esc) || String(h.card.name ?? '').includes(esc))
        .sort((a, b) => b.score - a.score)
        .slice(0, n)
      return Object.assign(hits, { detail: FTS_UNAVAILABLE_DETAIL })
    }
    const query = bigramQuery(q)
    if (!query) return Object.assign([], { detail: null })
    const hits = db.prepare(
      `SELECT c.*, f.rank AS fts_rank FROM cards_fts f JOIN cards c ON c.rowid = f.rowid
       WHERE cards_fts MATCH ? ORDER BY f.rank LIMIT ?`)
      .all(query, n)
      .map((r) => ({ card: rowToCard(r), score: -Number(r.fts_rank) }))
    return Object.assign(hits, { detail: null })
  }

  /**
   * 判重漏斗①候选集（§8.6：候选集改由 search 供给 top-K，findRuleDup 语义不变）。
   * 降级口径（§8.5）：迁移未完成 / FTS 不可用 → 全扫兜底（宁可少入不可漏检——
   * 保守拒入方向绝不因候选集变窄而失守）。
   */
  function dedupCandidates(q, { limit = 100 } = {}) {
    if (migrationPending()) return list()
    if (!ftsOk) return list()
    return search(q, { limit }).map((h) => h.card)
  }

  return {
    FILE,
    fileOf: () => FILE,
    snapshotFileOf: () => JSON_FILE,
    ftsReady: () => ftsOk,
    migrationPending,
    ensureMigrated,
    list,
    get,
    addCards,
    removeByJob,
    update,
    markFactorizeFailed,
    setBacktest,
    search,
    dedupCandidates,
  }
}
