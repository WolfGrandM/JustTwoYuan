/**
 * dsh-koi 复盘循环存储层（M4 / docs/28 §2.1-2.2，T1）—— review.db（$DSH_HOME/koi/review.db）。
 *
 * 单插件谱系（docs/16/19）：无独立 dsh-koi-mind 插件，复盘档案落本插件数据目录（§9-R7）。
 * node:sqlite（Node 24 内置，零 npm 依赖纪律不破，cards.js:5 实测先例）。
 *
 * schema（docs/28 §2.2，schemaVersion=1，只加不改不删）：
 *   predictions_archive —— 预注册列（at/picks/via/game/issue/date/kind）禁改（BC-002）；
 *                          outcome 列（result/grades/prize/cost/baseline×2/pushed_result）开奖后单次填充（B-07）。
 *   attribution         —— 逐因子代码归因（FR-034，LLM 永不参与判定——BC-014/§5）。
 *   factors             —— 因子库状态机（DC-004 单向 + promoted→observing 唯一回退边）。
 *   factor_state_log    —— 状态变更审计注记（BC-008：状态变更唯一时点 = monthly 流水线事务 + veto CLI）。
 *   factor_proposals    —— 环 A 探索性提案表（收尾批 T2：提案时刻/依据数据血统/观察期起点；DSL 拒收如实记录）。
 *   reports             —— 周/月报全文（UNIQUE(kind,period) 幂等守卫）。
 *
 * 纪律双闸（§2.2）：应用层只有 monthly.js 与 veto CLI 调 applyFactorTransition；
 * DB 层 4 触发器钉死：①预注册列禁改 ②outcome 单次 ③状态边合法 ④变更必带审计注记。
 * BC-001 诚实条款：本存储不修饰任何数字，判定全部来自代码（judge/attribution 纯函数）。
 */
import path from 'node:path'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { buildBuiltinFactors } from '../factors.js'

const SCHEMA_VERSION = 1

/** DC-004 合法状态边（§2.2 触发器③同源；应用层先行校验，DB 层兜底） */
export const LEGAL_EDGES = [
  ['candidate', 'observing'],
  ['observing', 'promoted'],
  ['observing', 'demoted'],
  ['observing', 'retired'],
  ['promoted', 'observing'],   // 唯一回退边（否决窗口 veto）
]

const DDL = `
CREATE TABLE IF NOT EXISTS schema_info(
  key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS predictions_archive(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game TEXT NOT NULL, issue TEXT NOT NULL, date TEXT, kind TEXT NOT NULL DEFAULT 'daily',
  at TEXT NOT NULL,
  picks TEXT NOT NULL, via TEXT,
  tier TEXT, effort_tier TEXT, config_stamp TEXT, baseline_picks TEXT,
  result TEXT, grades TEXT, prize REAL, cost REAL,
  baseline_prize REAL, baseline_grades TEXT, pushed_result INTEGER,
  attribution TEXT, corrected_by INTEGER,
  UNIQUE(game, issue, date, kind));

CREATE TABLE IF NOT EXISTS attribution(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  archive_id INTEGER NOT NULL,
  factor_id TEXT NOT NULL, hit INTEGER, detail TEXT, at TEXT,
  UNIQUE(archive_id, factor_id));

CREATE TABLE IF NOT EXISTS factors(
  id TEXT PRIMARY KEY, game TEXT, name TEXT, source TEXT, spec_ref TEXT, p0 REAL,
  status TEXT CHECK(status IN ('candidate','observing','promoted','demoted','retired')),
  version INTEGER NOT NULL DEFAULT 1, created_at TEXT, state_changed_at TEXT);

CREATE TABLE IF NOT EXISTS factor_state_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT, factor_id TEXT,
  from_status TEXT, to_status TEXT, at TEXT, actor TEXT, note TEXT);

-- 环 A 探索性提案表（收尾批 T2；只加不改不删——schema_version 保持 1）
CREATE TABLE IF NOT EXISTS factor_proposals(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period TEXT NOT NULL,              -- 提案所在月报期（yyyy-mm）
  factor_id TEXT,                    -- DSL 通过 → 因子库 candidate 态的 id；DSL 拒收 → NULL
  game TEXT, name TEXT, claim TEXT,
  spec TEXT,                         -- 原始 DSL spec JSON（血统可追溯）
  status TEXT CHECK(status IN ('accepted','rejected-dsl')),
  errors TEXT,                       -- DSL 校验错误清单 JSON（如实记录不静默）
  lineage TEXT,                      -- 依据数据血统 JSON（insight.aggregate 摘要）
  observe_from TEXT,                 -- 观察期起点（下一月报期 yyyy-mm；accepted 才有）
  at TEXT NOT NULL);                 -- 提案时刻

CREATE TABLE IF NOT EXISTS reports(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT CHECK(kind IN ('weekly','monthly')),
  period TEXT, content TEXT, created_at TEXT, event_id TEXT,
  UNIQUE(kind, period));

-- M3-T2 议程版本登记（FR-021/DC-010：versionOf(cfg) stamp + 登记；只加不改不删——schema_version 保持 1，factor_proposals 先例 store.js:66）
CREATE TABLE IF NOT EXISTS agenda_versions(
  version TEXT PRIMARY KEY,          -- 'm3:v<n>:<hash8>'（agenda.js versionOf 单点）
  file_hash TEXT,                    -- prompts 内容 fnv1a（模板常量在 git = ADR-14 市场版落地）
  activated_at TEXT,                 -- 首次登记时刻（重跑幂等 INSERT OR IGNORE 不覆盖）
  retired_at TEXT);                  -- 退役时刻（版本切换时填，当前版本恒 NULL）

-- M3-T2 编排全记录（FR-016/BC-002 预注册 append-only：逐角色逐轮只插不改——store 零 UPDATE/DELETE 导出；
-- 落盘先于开奖核对，BC-002 预注册语义由写入时点结构保证）
CREATE TABLE IF NOT EXISTS orchestration_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  archive_key TEXT NOT NULL,         -- '<game>|<issue>'（与 predictions_archive 关联键同源；AC-019）
  role TEXT,                         -- dataOfficer/strategist/provoker/chair
  round INTEGER,                     -- 轮次（1=提案轮 2=质询轮 3=修订轮 4=定稿轮）
  at TEXT,                           -- 产出时刻（开奖前一次性写入——BC-002）
  content TEXT,                      -- 角色产出 JSON 全文（剔除/超时行记标记文本如实不虚构）
  agenda_version TEXT,               -- 议程版本 stamp（DC-010 归因分段键）
  call_ref TEXT);                    -- '<archiveKey>#<id>-<round>'（计量 callRef 同源）

-- 触发器①：预注册列禁改（BC-002；date/kind 属业务键同样禁改——§2.2「禁改」注释行覆盖）
CREATE TRIGGER IF NOT EXISTS archive_prereg_no_update
BEFORE UPDATE ON predictions_archive
WHEN NEW.picks IS NOT OLD.picks OR NEW.at IS NOT OLD.at OR NEW.via IS NOT OLD.via
  OR NEW.game IS NOT OLD.game OR NEW.issue IS NOT OLD.issue
  OR NEW.date IS NOT OLD.date OR NEW.kind IS NOT OLD.kind
BEGIN
  SELECT RAISE(ABORT, '预注册列不可改写（BC-002）');
END;

-- 触发器②：outcome 单次填充（B-07；更正走 correction 追加行 + corrected_by 指针）
CREATE TRIGGER IF NOT EXISTS archive_outcome_once
BEFORE UPDATE ON predictions_archive
WHEN OLD.result IS NOT NULL AND NEW.result IS NOT OLD.result
BEGIN
  SELECT RAISE(ABORT, 'outcome 已落定，更正走 correction 追加行（corrected_by 指针）');
END;

-- 触发器③：状态机合法边（DC-004 单向 + promoted→observing 唯一回退边）
CREATE TRIGGER IF NOT EXISTS factor_edge_legal
BEFORE UPDATE OF status ON factors
WHEN NOT (
  (OLD.status = 'candidate' AND NEW.status = 'observing') OR
  (OLD.status = 'observing' AND NEW.status IN ('promoted','demoted','retired')) OR
  (OLD.status = 'promoted' AND NEW.status = 'observing')
)
BEGIN
  SELECT RAISE(ABORT, '非法状态边（DC-004 单向 + promoted→observing 唯一回退边）');
END;

-- 触发器④：状态变更必须同事务写审计注记（BC-008/AC-024；log 行先插、at 与 NEW.state_changed_at 同刻）
CREATE TRIGGER IF NOT EXISTS factor_status_log_required
AFTER UPDATE OF status ON factors
WHEN NOT EXISTS(
  SELECT 1 FROM factor_state_log WHERE factor_id = NEW.id AND at = NEW.state_changed_at)
BEGIN
  SELECT RAISE(ABORT, '状态变更必须同事务写审计注记（BC-008/AC-024）');
END;
`

/**
 * 打开/迁移 review.db。migrate() 幂等（CREATE IF NOT EXISTS + schema_version 只升不降）。
 * 播种：内置六件 ×3 彩种（factors.js:99-190）→ status='observing'——内置件已在回测引擎
 * 持续观察中（backtest.js 全家跑），monthly 晋升流水线（T3）从 observing 达标者晋升；
 * candidate 边保留给后续卡片因子入观察（candidate→observing）。
 */
export function createReviewStore({ dataDir, now = () => new Date(), log = () => {} } = {}) {
  const FILE = path.join(dataDir ?? '.', 'review.db')
  fs.mkdirSync(path.dirname(FILE), { recursive: true })
  const db = new DatabaseSync(FILE)
  db.exec('PRAGMA journal_mode = WAL')

  function migrate() {
    db.exec(DDL)
    const row = db.prepare(`SELECT value FROM schema_info WHERE key='schema_version'`).get()
    const v = row ? Number(row.value) : 0
    if (v > SCHEMA_VERSION) throw new Error(`review.db schema_version ${v} 高于已知 ${SCHEMA_VERSION}，拒绝打开（docs/10 §6 规则 2）`)
    if (!row) {
      db.prepare(`INSERT INTO schema_info(key, value) VALUES('schema_version', ?)`).run(String(SCHEMA_VERSION))
    }
    seedBuiltinFactors()
    return { schemaVersion: SCHEMA_VERSION, file: FILE }
  }

  /** 内置因子播种（幂等：已存在的 id 跳过——只加不改不删） */
  function seedBuiltinFactors() {
    const ins = db.prepare(`INSERT OR IGNORE INTO factors(id, game, name, source, spec_ref, p0, status, version, created_at)
      VALUES(?, ?, ?, 'builtin', 'lib/factors.js buildBuiltinFactors', NULL, 'observing', 1, ?)`)
    const at = now().toISOString()
    for (const f of buildBuiltinFactors()) ins.run(f.id, f.game, f.name, at)
  }

  migrate()   // 构造期即迁移（DDL 幂等；数据迁移写是 T5 CLI 的事，不在首开）

  // ── predictions_archive ──────────────────────────────────────────────────
  const safeJson = (s) => { try { return s == null ? null : JSON.parse(s) } catch { return s } }

  /**
   * 预测条目入档（幂等：业务键 game|issue|date|kind 唯一，重复入档零 diff）。
   * entry = predictions.json 条目（scheduler.js:257-272 stamp + :394-400 对账回填字段）。
   * outcome 列（result/grades/prize/cost/baselinePrize/baselineGrades/pushedResult）随 entry
   * 已有则首插即填；行已存在且 result 为空、新 entry 带结果 → 单次回填（触发器②守卫改写）。
   */
  function upsertArchive(entry) {
    if (!entry || !entry.game || entry.issue == null || !entry.at) {
      throw new Error('入档条目缺 game/issue/at（预注册字段必在）')
    }
    const picks = JSON.stringify(entry.picks ?? null)
    const existing = db.prepare(`SELECT id, result FROM predictions_archive WHERE game=? AND issue=? AND date=? AND kind=?`)
      .get(entry.game, String(entry.issue), entry.date ?? null, entry.kind ?? 'daily')
    if (!existing) {
      const r = db.prepare(`INSERT INTO predictions_archive(
          game, issue, date, kind, at, picks, via, tier, effort_tier, config_stamp, baseline_picks,
          result, grades, prize, cost, baseline_prize, baseline_grades, pushed_result)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(entry.game, String(entry.issue), entry.date ?? null, entry.kind ?? 'daily', String(entry.at),
          picks, entry.via ?? null, entry.tier ?? null, entry.effortTier ?? null, entry.configStamp ?? null,
          entry.baselinePicks == null ? null : JSON.stringify(entry.baselinePicks),
          entry.result == null ? null : JSON.stringify(entry.result),
          entry.grades == null ? null : JSON.stringify(entry.grades),
          numOrNull(entry.prize), numOrNull(entry.cost), numOrNull(entry.baselinePrize),
          entry.baselineGrades == null ? null : JSON.stringify(entry.baselineGrades),
          entry.pushedResult == null ? null : (entry.pushedResult ? 1 : 0))
      return { id: Number(r.lastInsertRowid), created: true, outcomeFilled: entry.result != null }
    }
    // 已存在：outcome 未填且本次带结果 → 单次回填（触发器②允许 NULL→值）
    if (existing.result == null && entry.result != null) {
      db.prepare(`UPDATE predictions_archive SET result=?, grades=?, prize=?, cost=?,
          baseline_prize=?, baseline_grades=?, pushed_result=? WHERE id=?`)
        .run(JSON.stringify(entry.result), entry.grades == null ? null : JSON.stringify(entry.grades),
          numOrNull(entry.prize), numOrNull(entry.cost), numOrNull(entry.baselinePrize),
          entry.baselineGrades == null ? null : JSON.stringify(entry.baselineGrades),
          entry.pushedResult == null ? null : (entry.pushedResult ? 1 : 0), existing.id)
      return { id: existing.id, created: false, outcomeFilled: true }
    }
    return { id: existing.id, created: false, outcomeFilled: existing.result != null }
  }

  const numOrNull = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v))

  /** 归因行入档（幂等：UNIQUE(archive_id, factor_id)，重复记录零 diff）。hit: true→1 / false→0 / null→NULL（本期无观点） */
  function recordAttribution(archiveId, items, { at } = {}) {
    const stamp = at ?? now().toISOString()
    const ins = db.prepare(`INSERT OR IGNORE INTO attribution(archive_id, factor_id, hit, detail, at)
      VALUES(?,?,?,?,?)`)
    let rows = 0
    for (const it of Array.isArray(items) ? items : []) {
      if (!it || !it.factorId) continue
      const hit = it.hit === true ? 1 : it.hit === false ? 0 : null
      const r = ins.run(archiveId, it.factorId, hit, it.detail ?? null, stamp)
      rows += Number(r.changes)
    }
    return { rows }
  }

  // ── factors（BC-008：状态变更唯一入口 = applyFactorTransition）────────────────
  const listFactors = () => db.prepare(`SELECT id, game, name, source, spec_ref, p0, status, version, created_at, state_changed_at
    FROM factors ORDER BY id`).all()
    .map((r) => ({ id: r.id, game: r.game, name: r.name, source: r.source, specRef: r.spec_ref, p0: r.p0,
      status: r.status, version: r.version, createdAt: r.created_at, stateChangedAt: r.state_changed_at }))

  /**
   * 因子状态变更（唯一写路径）。同事务：先插审计注记（at = state_changed_at 同刻，满足触发器④）、
   * 后 UPDATE status。note 非空硬要求（诚实审计）；promoted→observing 回退边调用方须传 actor='owner'
   * （veto 语义，T3 月报测试断言）。
   */
  function applyFactorTransition(id, from, to, actor, note) {
    if (!LEGAL_EDGES.some(([a, b]) => a === from && b === to)) {
      throw new Error(`非法状态边 ${from}→${to}（DC-004 单向 + promoted→observing 唯一回退边）`)
    }
    if (!actor || !String(actor).trim()) throw new Error('状态变更缺 actor（BC-008 审计必填）')
    if (!note || !String(note).trim()) throw new Error('状态变更缺 note（BC-008 审计必填）')
    const f = db.prepare(`SELECT id, status, name FROM factors WHERE id=?`).get(id)
    if (!f) throw new Error(`没有这个因子：${id}`)
    if (f.status !== from) throw new Error(`因子 ${id} 现状态为 ${f.status}，与申报 from=${from} 不符`)
    const at = now().toISOString()
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare(`INSERT INTO factor_state_log(factor_id, from_status, to_status, at, actor, note)
        VALUES(?,?,?,?,?,?)`).run(id, from, to, at, String(actor), String(note))
      db.prepare(`UPDATE factors SET status=?, state_changed_at=?, version=version+1 WHERE id=?`)
        .run(to, at, id)
      db.exec('COMMIT')
    } catch (e) {
      try { db.exec('ROLLBACK') } catch { /* 尽力回滚 */ }
      throw e
    }
    log(`[koi] 因子状态变更：${id} ${from}→${to}（actor=${actor}）`)
    return { id, from, to, at, actor, note }
  }

  /**
   * 待否决晋升解析（§9-R6：promoted 先落状态、消费端以 state_changed_at+24h 为生效门——lazy 判生效）。
   * 返回 { pending:[{id,name,promotedAt,effectiveAt,hoursLeft}], effective:[{id,name}] }。
   */
  function resolvePendingPromotions(nowD = now(), { vetoWindowHours = 24 } = {}) {
    const rows = db.prepare(`SELECT id, name, state_changed_at FROM factors WHERE status='promoted' ORDER BY state_changed_at`).all()
    const t = nowD instanceof Date ? nowD.getTime() : Date.parse(String(nowD))
    const pending = []
    const effective = []
    for (const r of rows) {
      const promotedAt = r.state_changed_at
      const base = Date.parse(promotedAt ?? '')
      const effectiveAt = Number.isNaN(base) ? null : new Date(base + vetoWindowHours * 3600_000).toISOString()
      if (effectiveAt && t < Date.parse(effectiveAt)) {
        pending.push({ id: r.id, name: r.name, promotedAt, effectiveAt, hoursLeft: Math.max(0, (Date.parse(effectiveAt) - t) / 3600_000) })
      } else {
        effective.push({ id: r.id, name: r.name, promotedAt, effectiveAt })
      }
    }
    return { pending, effective }
  }

  const stateLogOf = (factorId) => db.prepare(`SELECT id, factor_id, from_status, to_status, at, actor, note
    FROM factor_state_log WHERE factor_id=? ORDER BY at DESC, id DESC`).all(factorId ?? null)
    .map((r) => ({ id: r.id, factorId: r.factor_id, fromStatus: r.from_status, toStatus: r.to_status, at: r.at, actor: r.actor, note: r.note }))

  // ── factor_proposals（环 A 提案表，收尾批 T2）＋ 提案因子入库（candidate 态）──────────
  /**
   * 提案因子入库：candidate 态（LEGAL_EDGES candidate→observing 保留边的消费面；
   * store.js:115 注释「candidate 边保留给后续卡片因子入观察」）。id 确定性（proposal-<period>-<game>-<n>）
   * → 重跑幂等：UNIQUE 冲突不覆盖不改写（只加不改），返回 duplicate 供调用方如实记账。
   */
  function addCandidateFactor({ id, game, name, source, specRef = null, p0 = null }) {
    if (!id || !game || !name) throw new Error('提案因子入库缺 id/game/name')
    const at = now().toISOString()
    try {
      db.prepare(`INSERT INTO factors(id, game, name, source, spec_ref, p0, status, version, created_at)
        VALUES(?,?,?,?,?,?,'candidate',1,?)`).run(String(id), String(game), String(name), String(source ?? 'proposal'), specRef, p0, at)
    } catch (e) {
      if (/UNIQUE constraint failed: factors\.id/.test(String(e.message))) return { ok: false, duplicate: true, id: String(id) }
      throw e
    }
    log(`[koi] 提案因子入库：${id}（candidate 态；观察期起点见 factor_proposals）`)
    return { ok: true, id: String(id), status: 'candidate', createdAt: at }
  }

  /** 提案一行落表（accepted / rejected-dsl 两种状态；DSL 拒收 errors 必带——如实记录不静默）。
   *  node:sqlite 绑定纪律：对象/数组字段（spec/errors/lineage）统一 JSON 字符串化后落库。 */
  function recordProposal({ period, factorId = null, game = null, name = null, claim = null, spec = null, status, errors = null, lineage = null, observeFrom = null, at }) {
    if (!period) throw new Error('提案缺 period')
    if (!['accepted', 'rejected-dsl'].includes(status)) throw new Error(`提案 status 非法：${status}`)
    if (status === 'accepted' && !factorId) throw new Error('accepted 提案缺 factorId（进因子库 candidate 态的落点）')
    const txt = (v) => (v == null || typeof v === 'string') ? v : JSON.stringify(v)
    const r = db.prepare(`INSERT INTO factor_proposals(period, factor_id, game, name, claim, spec, status, errors, lineage, observe_from, at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run(String(period), factorId, txt(game), txt(name), txt(claim), txt(spec), String(status), txt(errors), txt(lineage), observeFrom, String(at ?? now().toISOString()))
    return { ok: true, id: Number(r.lastInsertRowid) }
  }

  /** 提案清单（月报流水线 ⓪ 观察期起点激活 + 面板/CLI 消费；period 过滤可选） */
  const listProposals = (period = null) => db.prepare(
    `SELECT id, period, factor_id AS factorId, game, name, claim, spec, status, errors, lineage, observe_from AS observeFrom, at
     FROM factor_proposals ${period ? 'WHERE period=?' : ''} ORDER BY at DESC, id DESC`)
    .all(...(period ? [String(period)] : []))
    .map((r) => ({ ...r, spec: safeJson(r.spec), errors: safeJson(r.errors), lineage: safeJson(r.lineage) }))

  // ── orchestration_log / agenda_versions（M3-T2 编排记录与议程版本；append-only 只加通道）──
  /**
   * 归因行读取（M3-T3 注入面只读扩展：按因子聚合近期命中行——injector 因子战绩块数据源；
   * 只读零写路径）。factorId 过滤可选；返回按写入序倒序（最新在前）。
   */
  const listAttribution = (factorId = null, limit = 20) => db.prepare(
    `SELECT a.id, a.archive_id AS archiveId, a.factor_id AS factorId, a.hit, a.detail, a.at,
            p.game AS game, p.issue AS issue, p.date AS date
     FROM attribution a LEFT JOIN predictions_archive p ON p.id = a.archive_id
     ${factorId ? 'WHERE a.factor_id = ?' : ''} ORDER BY a.id DESC LIMIT ?`)
    .all(...(factorId ? [String(factorId)] : []), limit)
  /**
   * 编排一行落表（逐角色逐轮；content=角色产出 JSON 全文或剔除标记文本；append-only——本方法
   * 只 INSERT，零 UPDATE/DELETE 导出，BC-002 预注册语义）。
   */
  function recordOrchestration({ archiveKey, role = null, round = null, content = null, agendaVersion = null, callRef = null, at } = {}) {
    if (!archiveKey) throw new Error('编排记录缺 archiveKey（AC-019 关联键必填）')
    const r = db.prepare(`INSERT INTO orchestration_log(archive_key, role, round, at, content, agenda_version, call_ref)
      VALUES(?,?,?,?,?,?,?)`)
      .run(String(archiveKey), role, round == null ? null : Number(round), String(at ?? now().toISOString()),
        content == null || typeof content === 'string' ? content : JSON.stringify(content),
        agendaVersion, callRef)
    return { ok: true, id: Number(r.lastInsertRowid) }
  }

  /** 编排记录清单（面板/测试消费；archiveKey 过滤可选，按写入序返回） */
  const listOrchestration = (archiveKey = null, limit = 500) => db.prepare(
    `SELECT id, archive_key AS archiveKey, role, round, at, content, agenda_version AS agendaVersion, call_ref AS callRef
     FROM orchestration_log ${archiveKey ? 'WHERE archive_key=?' : ''} ORDER BY id ASC LIMIT ?`)
    .all(...(archiveKey ? [String(archiveKey)] : []), limit)

  /** 议程版本登记（幂等：version PRIMARY KEY——INSERT OR IGNORE 重跑零 diff 不覆盖，FR-021） */
  function registerAgendaVersion(version, fileHash = null, { at } = {}) {
    if (!version) throw new Error('议程版本号必填（agenda.js versionOf 单点）')
    db.prepare(`INSERT OR IGNORE INTO agenda_versions(version, file_hash, activated_at, retired_at)
      VALUES(?,?,?,NULL)`).run(String(version), fileHash, String(at ?? now().toISOString()))
    return { ok: true, version: String(version) }
  }

  /** 议程版本清单（登记序；月报混杂声明与面板消费——FR-021 决定性规则数据源） */
  const listAgendaVersions = () => db.prepare(
    `SELECT version, file_hash AS fileHash, activated_at AS activatedAt, retired_at AS retiredAt
     FROM agenda_versions ORDER BY activated_at ASC, version ASC`).all()

  // ── reports（周/月报全文；UNIQUE(kind,period) 幂等守卫）───────────────────────
  function recordReport(kind, period, content, eventId = null) {
    try {
      const r = db.prepare(`INSERT INTO reports(kind, period, content, created_at, event_id)
        VALUES(?,?,?,?,?)`).run(kind, String(period), String(content), now().toISOString(), eventId)
      return { ok: true, id: Number(r.lastInsertRowid), duplicate: false }
    } catch (e) {
      if (/UNIQUE constraint failed: reports\.kind, reports\.period|reports\.kind, reports\.period/.test(String(e.message))) {
        return { ok: false, duplicate: true, id: getReport(kind, period)?.id ?? null }
      }
      throw e
    }
  }
  const getReport = (kind, period) => {
    const r = db.prepare(`SELECT id, kind, period, content, created_at, event_id FROM reports WHERE kind=? AND period=?`)
      .get(kind, String(period))
    return r ? { id: r.id, kind: r.kind, period: r.period, content: r.content, createdAt: r.created_at, eventId: r.event_id } : null
  }
  const listReports = (kind = null, limit = 50) => db.prepare(
    `SELECT id, kind, period, content, created_at, event_id FROM reports ${kind ? 'WHERE kind=?' : ''}
     ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(...(kind ? [kind] : []), limit)
    .map((r) => ({ id: r.id, kind: r.kind, period: r.period, content: r.content, createdAt: r.created_at, eventId: r.event_id }))

  // ── 只读统计面（T2 周报/T6 面板消费）────────────────────────────────────────
  const archiveStats = () => {
    const r = db.prepare(`SELECT COUNT(*) AS n FROM predictions_archive`).get()
    const a = db.prepare(`SELECT COUNT(*) AS n FROM attribution`).get()
    const f = db.prepare(`SELECT COUNT(*) AS n FROM factors`).get()
    return { archiveRows: Number(r.n), attributionRows: Number(a.n), factors: Number(f.n) }
  }
  /** 归因聚合（周报节 1 因子命中统计，AC-009 口径）：hit=1 计命中、hit=0 计未中、NULL 不进分母 */
  const attributionAgg = ({ from, to } = {}) => {
    const where = []
    const args = []
    let sql = `SELECT a.factor_id AS factorId,
           SUM(CASE WHEN a.hit = 1 THEN 1 ELSE 0 END) AS hits,
           SUM(CASE WHEN a.hit IS NOT NULL THEN 1 ELSE 0 END) AS judged,
           COUNT(*) AS recorded
    FROM attribution a JOIN predictions_archive p ON p.id = a.archive_id`
    if (from) { where.push('p.date >= ?'); args.push(String(from)) }
    if (to) { where.push('p.date <= ?'); args.push(String(to)) }
    if (where.length) sql += ' WHERE ' + where.join(' AND ')
    sql += ' GROUP BY a.factor_id ORDER BY a.factor_id'
    return db.prepare(sql).all(...args).map((r) => ({
      factorId: r.factorId, hits: Number(r.hits), judged: Number(r.judged), recorded: Number(r.recorded),
    }))
  }

  return {
    db, migrate, fileOf: () => FILE,
    upsertArchive, recordAttribution,
    listFactors, applyFactorTransition, resolvePendingPromotions, stateLogOf,
    addCandidateFactor, recordProposal, listProposals,
    recordOrchestration, listOrchestration, registerAgendaVersion, listAgendaVersions,   // M3-T2 编排记录/议程版本（append-only 只加通道）
    listAttribution,                                                                     // M3-T3 注入面只读扩展（按因子聚合近期命中行）
    recordReport, getReport, listReports,
    archiveStats, attributionAgg,
  }
}
