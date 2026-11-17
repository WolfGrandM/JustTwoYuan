/**
 * dsh-koi 档案迁移（M4 T5 / docs/28 §2.1 migrate.js + §4.2 裁决 b 全规格）——
 * predictions.json 的对账回填职责迁 review.db 的 CLI 三跑（dry-run / 实跑 / 幂等）。
 *
 * 语义参照 tools/koi.mjs migrate-v2：--dry-run 只读报告不落盘、schemaVersion 幂等短路、业务键去重幂等。
 *
 * 三跑语义（§4.2）：
 *   1. dry-run：只读统计 + 报告行，零写盘（review.db 缺席时不创建；存在时以 readOnly 连接仅计数）。
 *   2. 实跑：① 备份 predictions.json/ledger.json → koi/backups/archive-migrate-<ts>/（manifest.json
 *      含字节数+SHA-256+时刻）——备份为硬门槛，缺备份能力 → 中止退出码 1；
 *      ② 建/升 review.db（store migrate 幂等）；③ 全量回填 predictions.json kind==='daily' 条目 →
 *      predictions_archive（业务键 game|issue|date|kind 幂等去重；quickpick 不入档——BC-006 加餐
 *      永不进正式口径，如实记报告行）；④ outcome 列单次回填（触发器 archive_outcome_once 守卫）；
 *      ⑤ 逐期代码归因回填 attribution 表（内置因子库 × 本地质历史切片，O(期数×因子数) 亚秒级，
 *      零 LLM——BC-014）；⑥ schema_info.migrate_state='applied' + 源 SHA 记录。
 *   3. 幂等重跑：migrate_state='applied' 且源 SHA 未变 → 「已迁移，零 diff」短路退出码 0。
 *
 * 部署边界（§4.2）：本命令只碰数据目录文件；review.archiveAuthoritative 开关**不由此命令改动**
 * （false 时 settle 行为与现状逐位一致；true 的生产切换与生产实跑均待主人授权）。
 * 回滚 = 备份覆盖回 predictions.json/ledger.json + 删 review.db + 若开关已切 true 同步改回 false
 * （防「文件回 JSON、开关仍指 db」的半回退态）。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { readJson } from '../io.js'
import { createDrawStore } from '../drawstore.js'
import { buildBuiltinFactors } from '../factors.js'
import { createReviewStore } from './store.js'
import { computeForIssue } from './attribution.js'

const sha256File = (p) => {
  const buf = fs.readFileSync(p)
  return { bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') }
}

export function migrateArchive({
  dataDir,
  dryRun = false,
  bakDir = null,           // 备份根目录覆盖（缺省 koi/backups）
  now = () => new Date(),
  log = () => {},
  readCfg = () => ({}),
} = {}) {
  const PRED_FILE = path.join(dataDir, 'predictions.json')
  const LEDGER_FILE = path.join(dataDir, 'ledger.json')
  const DB_FILE = path.join(dataDir, 'review.db')
  const report = []

  const stats = () => {
    const preds = readJson(PRED_FILE, null)
    if (!preds || !Array.isArray(preds.entries)) return { error: `源 predictions.json 不存在或无 entries：${PRED_FILE}` }
    const daily = preds.entries.filter((e) => e?.kind === 'daily')
    const settled = daily.filter((e) => e.settled && e.settleState === 'settled' && e.result != null)
    const givenUp = daily.filter((e) => e.settleState === 'given-up')
    const voided = daily.filter((e) => e.settleState === 'voided')
    const quickpick = preds.entries.filter((e) => e?.kind !== 'daily')
    return {
      daily, settled, givenUp, voided, quickpick,
      predSha: sha256File(PRED_FILE),
      ledgerSha: fs.existsSync(LEDGER_FILE) ? sha256File(LEDGER_FILE) : null,
      hasLedger: fs.existsSync(LEDGER_FILE),
    }
  }

  /** dry-run：只读统计 + 报告，零写盘（零 db 打开写事务——readOnly 连接或完全不打开） */
  function dryRunReport() {
    const s = stats()
    if (s.error) { report.push(`源不可读，中止：${s.error}`); return { ok: false, code: 1 } }
    let existing = null
    if (fs.existsSync(DB_FILE)) {
      try {
        // dry-run 零写盘纪律：直接连接、仅 SELECT 计数——不跑 DDL、不播种、零写事务
        const db = new DatabaseSync(DB_FILE)
        const r = db.prepare(`SELECT COUNT(*) AS n FROM predictions_archive`).get()
        existing = Number(r.n)
        db.close()
      } catch {
        existing = null   // 表尚未建（库文件存在但未迁移）——如实报告
      }
    }
    const factorCount = buildBuiltinFactors().length
    const perGame = {}
    for (const f of buildBuiltinFactors()) perGame[f.game] = (perGame[f.game] ?? 0) + 1
    const evalEstimate = s.settled.reduce((n, e) => n + (perGame[e.game] ?? 0), 0)
    report.push(`源 predictions.json：${s.daily.length} 条 daily 条目（${s.settled.length} settled / ${s.givenUp.length} given-up / ${s.voided.length} voided），quickpick ${s.quickpick.length} 条不入档（BC-006 加餐不进正式口径）`)
    report.push(`目标 review.db：${existing == null ? (fs.existsSync(DB_FILE) ? '已存在但 predictions_archive 未建' : '尚不存在 → 将新建') : `现有 ${existing} 行`} → 将回填 ${s.daily.length} 行（业务键 game|issue|date|kind 幂等去重）`)
    report.push(`outcome 列单次回填：${s.daily.length} 行 result/prize/grades/baseline*（触发器 archive_outcome_once 守卫，已落定行零改写）`)
    report.push(`归因回填：因子库 ${factorCount} 件（内置六件×3 彩种，逐彩种 ${Object.values(perGame).join('/')} 件）逐期求值 ≈${evalEstimate} 次，O(期数×因子数) 亚秒级（本地质历史切片，缺历史的期如实跳过）`)
    report.push(`备份计划：实跑先备份 predictions.json${s.hasLedger ? '/ledger.json' : ''} → koi/backups/archive-migrate-<ts>/（manifest 含字节数+SHA-256+时刻）`)
    report.push(`迁移后开关 review.archiveAuthoritative 当前 = ${readCfg()?.review?.archiveAuthoritative === true ? 'true' : 'false'}（生产切换待主人授权，本命令不改该开关）`)
    return { ok: true, code: 0 }
  }

  async function run() {
    if (dryRun) {
      report.push('migrate-archive --dry-run（不落盘）迁移报告：')
      const r = dryRunReport()
      return { ...r, report }
    }
    const s = stats()
    if (s.error) { report.push('migrate-archive 实跑迁移报告：'); report.push(`源不可读，中止：${s.error}`); return { ok: false, code: 1, report } }
    report.push('migrate-archive 实跑迁移报告：')
    // ① 备份（硬门槛：写不进 → 中止，零 db 写）
    const ts = now().toISOString().replace(/[:.]/g, '-')
    const backupDir = bakDir ? path.join(bakDir, `archive-migrate-${ts}`) : path.join(dataDir, 'backups', `archive-migrate-${ts}`)
    try {
      fs.mkdirSync(backupDir, { recursive: true })
      const manifest = { schemaVersion: 1, createdAt: now().toISOString(), files: [] }
      const files = [[PRED_FILE, 'predictions.json'], ...(s.hasLedger ? [[LEDGER_FILE, 'ledger.json']] : [])]
      for (const [src, name] of files) {
        const { bytes, sha256 } = s[name === 'predictions.json' ? 'predSha' : 'ledgerSha']
        fs.copyFileSync(src, path.join(backupDir, name))
        manifest.files.push({ name, bytes, sha256 })
      }
      fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
      report.push(`备份完成：${backupDir}（predictions.json sha256=${s.predSha.sha256.slice(0, 12)}…${s.hasLedger ? ` · ledger.json sha256=${s.ledgerSha.sha256.slice(0, 12)}…` : ''}）`)
    } catch (e) {
      report.push(`备份目录不可写，中止（硬门槛 §4.2）：${String(e?.message ?? e).slice(0, 120)}`)
      return { ok: false, code: 1, report }
    }
    // ② 建/升 review.db + 幂等短路判定
    const store = createReviewStore({ dataDir, now, log })
    const state = store.db.prepare(`SELECT key, value FROM schema_info WHERE key IN ('migrate_state','migrate_src_sha')`).all()
    const applied = state.find((r) => r.key === 'migrate_state')?.value === 'applied'
    const appliedSha = state.find((r) => r.key === 'migrate_src_sha')?.value ?? null
    if (applied && appliedSha === s.predSha.sha256) {
      report.push('已迁移（migrate_state=applied 且源 SHA 未变）——「已迁移，零 diff」短路退出（幂等重跑 §4.2-3）')
      return { ok: true, code: 0, report, shortCircuit: true }
    }
    if (applied && appliedSha !== s.predSha.sha256) {
      report.push(`检测到源文件变化（旧 SHA ${String(appliedSha).slice(0, 12)}… → 新 ${s.predSha.sha256.slice(0, 12)}…）——追加回填（业务键幂等去重，outcome 已落定行零改写）`)
    }
    // ③④ 全量回填 + outcome 单次回填（upsertArchive 幂等；触发器①②守卫）
    const factorsByGame = {}
    for (const f of buildBuiltinFactors()) (factorsByGame[f.game] ??= []).push(f)
    let created = 0
    let deduped = 0
    let outcomeFilled = 0
    const archiveIdOf = new Map()
    for (const entry of s.daily) {
      const r = store.upsertArchive(entry)
      archiveIdOf.set(`${entry.game}|${entry.issue}|${entry.date}|${entry.kind ?? 'daily'}`, r.id)
      if (r.created) created += 1
      else deduped += 1
      if (r.outcomeFilled && entry.result != null) outcomeFilled += 1
    }
    report.push(`档案回填：新建 ${created} 行 · 幂等跳过 ${deduped} 行（业务键 game|issue|date|kind）· outcome 单次回填 ${outcomeFilled} 行（触发器 archive_outcome_once 守卫）`)
    // ⑤ 逐期代码归因回填（本地质历史切片防前视：asc = 截至上一期含）
    const drawStore = createDrawStore({ dataDir })
    const ascCache = new Map()
    let attributed = 0
    let attributionSkips = 0
    let evals = 0
    for (const entry of s.settled) {
      const archiveId = archiveIdOf.get(`${entry.game}|${entry.issue}|${entry.date}|${entry.kind ?? 'daily'}`)
      if (!archiveId) continue
      const factors = factorsByGame[entry.game] ?? []
      if (!factors.length) { attributionSkips += 1; continue }
      if (!ascCache.has(entry.game)) {
        const asc = [...drawStore.getRecent(entry.game, Infinity)].reverse()   // getRecent 最新在前 → 反转升序
        ascCache.set(entry.game, asc)
      }
      const asc = ascCache.get(entry.game)
      const idx = asc.findIndex((h) => String(h.issue) === String(entry.issue))
      if (idx < 0) { attributionSkips += 1; continue }   // 本地库无该期历史 → 如实跳过不虚构
      const slice = asc.slice(0, idx)                    // 截至上一期（含）——backtest.js:130-138 同款契约
      const { items } = computeForIssue({ game: entry.game, asc: slice, draw: entry.result, factors })
      store.recordAttribution(archiveId, items, { at: now().toISOString() })
      evals += items.length
      attributed += 1
    }
    report.push(`归因回填：${attributed} 期完成（≈${evals} 次因子求值）· 跳过 ${attributionSkips} 期（本地库缺该期历史或无该彩种因子——如实跳过不虚构）`)
    // ⑥ migrate_state 落盘
    store.db.prepare(`INSERT INTO schema_info(key, value) VALUES('migrate_state','applied')
      ON CONFLICT(key) DO UPDATE SET value='applied'`).run()
    store.db.prepare(`INSERT INTO schema_info(key, value) VALUES('migrate_src_sha', ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(s.predSha.sha256)
    store.db.prepare(`INSERT INTO schema_info(key, value) VALUES('migrate_at', ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(now().toISOString())
    report.push(`migrate_state=applied · 源 SHA 已记录（${s.predSha.sha256.slice(0, 12)}…）`)
    report.push(`开关 review.archiveAuthoritative 当前 = ${readCfg()?.review?.archiveAuthoritative === true ? 'true' : 'false'}（本命令不改该开关；true 的生产切换待主人授权，§4.2）`)
    report.push('回滚：用备份覆盖回 predictions.json/ledger.json + 删 review.db' + (readCfg()?.review?.archiveAuthoritative === true ? ' + 把 review.archiveAuthoritative 改回 false（防半回退态）' : ''))
    return { ok: true, code: 0, report, created, deduped, attributed }
  }

  return run()
}
