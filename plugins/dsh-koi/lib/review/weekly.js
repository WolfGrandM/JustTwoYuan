/**
 * dsh-koi 周报组装（M4 T2 / docs/28 §2.1 weekly.js + §3.1/§3.4）。
 *
 * 时刻表（§3.1）：周日 22:40（与 22:00 对账启动前向 40 分钟、23:30 放弃线后向 50 分钟，
 * 零写冲突——周报只读快照 + 自持文件写，不写 predictions.json/ledger.json）。
 *   · 生成窗口 A：周日 22:40–23:30（重试至 23:30 放弃线前停——防与对账收尾叠加）
 *   · 补生成窗口 B：任意日 ≥04:00，补上一「已完整结束」的 ISO 周（周日白天不补当周——周未结束）
 *   · 守卫：周日 && !holiday && mind.enabled && reports UNIQUE(kind,period) 幂等
 *   · joblock：acquire('review', weekly-<weekKey>)，被占 → 本轮跳过 + 日志 + 下轮补跑（AC-034 §3.3）
 *
 * 四节规格（§3.4，实施者不得自行发明目录）：
 *   节 1 战绩对照（BC-006：账本数字唯一来源 = ledger.json + periodLedgerSlice；诚实句头恒拼）
 *   节 2 五条纪律自评（全部代码判定 + 证据指针，零 LLM——§5 禁止清单 2）
 *   节 3 健康节六项（scanHealth items 逐项映射，N/A 如实标注）
 *   节 4 下周计划（开奖场次表与 draws.js drawDays 同源 + effortTier/configStamp + 未结清待办预告）
 *   叙述 LLM 只覆盖节 1/节 3 汇总段（各 1 次 + ≤1 打回，经 narrate.js 三闸）。
 *
 * BC-001：节 1 头部恒拼「命中率只作与随机基线对照的观测值」；报告不粉饰任何数字。
 */
import fs from 'node:fs'
import path from 'node:path'
import { readJson } from '../io.js'
import { GAMES, ledgerTotals } from '../draws.js'
import { isHoliday } from '../settle-core.js'
import { weekKey, EFFORT_ORDER, leversFor } from '../usage.js'
import { periodLedgerSlice } from './period.js'
import { scanHealth } from './health.js'

export const WEEKLY_AT = '22:40'        // 周日生成时刻
export const RETRY_GIVE_UP = '23:30'    // 当日重试放弃线（对账放弃线同源）
export const CATCHUP_AT = '04:00'       // 次日起补生成时刻（错峰窗外）
const HONESTY_HEAD = '命中率只作与随机基线对照的观测值。'
const LEGIT_STATE_ACTORS = ['monthly-pipeline', 'owner']   // BC-008：状态变更唯一合法 actor（monthly 流水线 + veto）

const dstr = (d) => d.toLocaleDateString('sv-SE')
const hhmmOf = (d) => d.toLocaleTimeString('sv-SE', { hour12: false }).slice(0, 5)
const addDays = (d, n) => { const x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x }

/** ISO 周信息（周一..周日）：{ weekKey, from, to }——weekKey 复用 usage.js:40-47 单点（§3.3） */
export function weekInfoOf(dateLike) {
  const d = dateLike instanceof Date ? new Date(dateLike.getTime()) : new Date(`${dateLike}T12:00:00`)
  const dow = d.getDay()                      // 0=周日..6=周六
  const monday = addDays(d, dow === 0 ? -6 : 1 - dow)
  const sunday = addDays(monday, 6)
  return { weekKey: weekKey(monday), from: dstr(monday), to: dstr(sunday) }
}

/** period 字符串（'2026-W47'）反查 ISO 周区间：Jan4（恒在第 1 周）回推第 1 周周一，再步进 N-1 周 */
export function weekInfoOfPeriod(period) {
  const m = /^(\d{4})-W(\d{1,2})$/.exec(String(period))
  if (!m) return weekInfoOf(new Date())
  const jan4 = new Date(Date.UTC(Number(m[1]), 0, 4))
  const isoDow = jan4.getUTCDay() || 7
  const monday1 = Date.UTC(Number(m[1]), 0, 4) - (isoDow - 1) * 86_400_000
  const targetMonday = new Date(monday1 + (Number(m[2]) - 1) * 7 * 86_400_000)
  return weekInfoOf(new Date(targetMonday.getUTCFullYear(), targetMonday.getUTCMonth(), targetMonday.getUTCDate()))
}

export function createWeeklyReview({
  store,
  readLedger,
  readPreds,
  usage = null,
  narrator = null,
  emit = async () => null,
  now = () => new Date(),
  readCfg = () => ({}),
  log = () => {},
  lock = null,
  reportsDir = null,   // koi/review/reports（注入；报告全文自持文件写，§3.1-2）
} = {}) {
  let lastAttemptAt = 0   // 生成失败后的重试节流（5 分钟，retryMinutes 语义）

  /** 近 4 周用量汇总（DC-011：token-usage.json 单一来源；archived + 当前周） */
  function usageWeeks() {
    if (!usage?.fileOf) return []
    const f = readJson(usage.fileOf(), null)
    if (!f) return []
    const out = (f.archived ?? []).map((a) => ({ week: a.week, total: (a.entries ?? []).reduce((s, e) => s + Number(e.tokens ?? 0), 0) }))
    out.push({ week: f.week, total: (f.entries ?? []).reduce((s, e) => s + Number(e.tokens ?? 0), 0) })
    return out.sort((a, b) => String(a.week).localeCompare(String(b.week))).slice(-4)
  }

  /** 节 2 五条纪律自评（全部代码判定 + 证据指针——§5 禁止 LLM 步骤 2） */
  function discipline({ weekEntries, settled }) {
    const triggerNames = ['archive_prereg_no_update', 'archive_outcome_once', 'factor_edge_legal', 'factor_status_log_required']
    const trigRows = store.db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND name IN (${triggerNames.map(() => '?').join(',')})`)
      .all(...triggerNames)
    const trigOk = trigRows.length === triggerNames.length
    const withBaseline = settled.filter((e) => e.baselinePicks)
    const baselineCovered = withBaseline.filter((e) => e.baselinePrize != null).length
    const logRows = store.db.prepare(`SELECT actor, COUNT(*) AS n FROM factor_state_log GROUP BY actor`).all()
    const rogues = logRows.filter((r) => !LEGIT_STATE_ACTORS.includes(r.actor))
    const viaMissing = weekEntries.filter((e) => e.via == null).length
    const ledgerEntries = readLedger()?.entries ?? []
    const mains = ledgerEntries.filter((e) => e?.kind === 'daily' && (e.entryType ?? 'main') === 'main')
    const badCost = mains.filter((e) => Number.isNaN(Number(e.cost))).length
    const badRef = ledgerEntries.filter((e) => ['supplement', 'reversal'].includes(e?.entryType) && !e.ref).length
    const honest = badCost === 0 && badRef === 0
      && JSON.stringify(periodLedgerSlice(ledgerEntries)) === JSON.stringify(ledgerTotals({ entries: ledgerEntries }))
    return [
      { item: '预注册完整', ok: trigOk, evidence: trigOk ? `review.db 4 触发器在位（${triggerNames.join('、')}）` : `触发器缺失：${triggerNames.filter((n) => !trigRows.some((r) => r.name === n))}` },
      { item: '基线同行', ok: withBaseline.length === 0 || baselineCovered === withBaseline.length, evidence: `本周带基线条目 ${withBaseline.length} 期，基线判奖回填覆盖 ${baselineCovered} 期` },
      { item: '无事后选择', ok: rogues.length === 0, evidence: rogues.length ? `factor_state_log 有非月报 actor 行：${rogues.map((r) => r.actor).join('、')}` : `factor_state_log 无非月报 actor 行（合法 actor：${LEGIT_STATE_ACTORS.join('/')}）` },
      { item: '兜底透明', ok: viaMissing === 0, evidence: `本周条目 ${weekEntries.length} 条，via 缺失 ${viaMissing} 条（fallback 均带标注）` },
      { item: '账本诚实', ok: honest, evidence: `main 条目 ${mains.length} 条 cost 全可解析（坏 ${badCost}）· supplement/reversal ref 指针齐（坏 ${badRef}）· periodLedgerSlice 全区间复算与 ledgerTotals 逐字段一致（BC-006）` },
    ]
  }

  /** 节 4 下周计划（开奖场次表与 draws.js drawDays 常量同源；§3.4） */
  function nextWeekPlan({ cfg, fromNext, toNext, weekEntries }) {
    const dayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
    const schedule = Object.entries(GAMES).map(([k, g]) => `${g.name} ${g.drawDays.map((x) => dayNames[x]).join('/')}`).join(' · ')
    const lever = leversFor(cfg)
    const configStamp = weekEntries.slice(-1)[0]?.configStamp ?? null
    const holidaysNext = (Array.isArray(cfg.holidays) ? cfg.holidays : []).filter((h) => h >= fromNext && h <= toNext)
    const openIssues = (readPreds()?.entries ?? []).filter((e) => e.kind === 'daily' && e.settleState === 'given-up').length
    return {
      schedule,
      effortTier: lever.tier,
      configStamp,
      holidaysNext,
      openIssues,
      text: [
        `下周开奖场次（与 draws.js drawDays 同源）：${schedule}`,
        `现行力度档：${lever.tier}（EFFORT_ORDER ${EFFORT_ORDER.join('→')}）${configStamp ? ` · configStamp ${configStamp}` : ''}`,
        holidaysNext.length ? `休市日命中：${holidaysNext.join('、')}（对账顺延）` : '下周无休市日命中',
        `未结清补判待办预告：${openIssues} 期放弃待补（超 7 天未补判将健康报红）`,
        `计划覆盖区间：${fromNext} ~ ${toNext}`,
      ].join('\n'),
    }
  }

  /** 组装周报全文（四节 + 诚实句头；narrator 缺席/降级时 code-only 全文照发） */
  async function buildReport({ period, info, cfg }) {
    const { from, to } = info
    const preds = readPreds()?.entries ?? []
    const weekEntries = preds.filter((e) => e?.kind === 'daily' && e.date >= from && e.date <= to)
    const settled = weekEntries.filter((e) => e.settled && e.settleState === 'settled')
    const ledgerEntries = readLedger()?.entries ?? []
    const slice = periodLedgerSlice(ledgerEntries, from, to)
    const attribution = store.attributionAgg({ from, to })
    const knownFactorIds = store.listFactors().map((f) => f.id)

    // 节 1（叙述 1 次 + ≤1 打回）
    const perIssue = weekEntries.map((e) => {
      return `  ${e.game} ${e.issue}（${e.date}）${e.tier ?? ''} via=${e.via ?? '-'}：` +
        (e.settled && e.settleState === 'settled' ? `中 ${e.prize ?? 0} 元 / 基线 ${e.baselinePrize ?? '-'} 元`
          : e.settleState === 'voided' ? '（休市作废）'
          : e.settleState === 'given-up' ? '放弃待补' : '未结清')
    })
    const ledgerLine = `账本口径合计（唯一来源 ledger.json+periodLedgerSlice，BC-006）：投入 ${slice.cost} 元 · 中 ${slice.prize} 元 · 净 ${slice.net >= 0 ? '+' : ''}${slice.net} 元 · 共 ${slice.draws} 期`
    const attrLine = attribution.length
      ? attribution.map((a) => `  ${a.factorId}: 命中 ${a.hits}/${a.judged}（已归因 ${a.recorded} 行，代码判定 AC-009 口径）`).join('\n')
      : '  （本周无归因行——archive 入档未启用或无对账）'
    let s1narr = null
    if (narrator) {
      s1narr = await narrator.narrate({
        section: '战绩对照',
        data: { period, ledger: { cost: slice.cost, prize: slice.prize, net: slice.net, draws: slice.draws },
          games: [...new Set(weekEntries.map((e) => e.game))], attribution, settled: settled.length },
        knownFactorIds,
      })
    }
    const s1 = [
      '【节 1 · 战绩对照】',
      `> ${HONESTY_HEAD}`,
      ...(s1narr ? [s1narr.text, ...(s1narr.source === 'code-only' && s1narr.reason ? [`（LLM 叙述缺席：${s1narr.reason}）`] : [])] : []),
      '逐期对照（picks/tier vs 随机基线，纯观测）：',
      ...(perIssue.length ? perIssue : ['  （本周无正式预测条目）']),
      ledgerLine,
      '因子命中统计（attribution 表聚合）：',
      attrLine,
    ].join('\n')

    // 节 2（零 LLM）
    const disc = discipline({ weekEntries, settled })
    const s2 = ['【节 2 · 纪律自评（代码判定 + 证据指针，零 LLM）】',
      ...disc.map((d, i) => `${i + 1}. ${d.item}：${d.ok ? '✓' : '✗'}——${d.evidence}`)].join('\n')

    // 节 3（健康节六项 + LLM 汇总段）
    const health = scanHealth({ readPreds, readCfg, store, today: to, usageWeeks: usageWeeks() })
    let s3narr = null
    if (narrator) {
      s3narr = await narrator.narrate({
        section: '健康节',
        data: { items: health.items.map((i) => ({ name: i.name, ok: i.ok, detail: i.detail })), alerts: health.alerts },
        knownFactorIds,
      })
    }
    const s3 = [
      '【节 3 · 健康节】',
      ...(s3narr ? [s3narr.text, ...(s3narr.source === 'code-only' && s3narr.reason ? [`（LLM 叙述缺席：${s3narr.reason}）`] : [])] : []),
      ...health.items.map((i) => `${i.ok === false ? '✗' : i.ok === true ? '·' : '—'} ${i.name}：${i.detail}`),
      ...(health.alerts.length ? [`告警 ${health.alerts.length} 条（review 事件已进面板）：${health.alerts.map((a) => a.type).join('、')}`] : []),
    ].join('\n')

    // 节 4（零 LLM）
    const infoNext = weekInfoOf(addDays(new Date(`${to}T12:00:00`), 1))
    const plan = nextWeekPlan({ cfg, fromNext: infoNext.from, toNext: infoNext.to, weekEntries })
    const s4 = ['【节 4 · 下周计划】', plan.text].join('\n')

    const head = `📋 锦鲤周报 ${period}（${from} ~ ${to}）`
    return { content: [head, s1, s2, s3, s4].join('\n\n'), health, period, info, slice }
  }

  /**
   * 生成并落盘 + 发事件（mind 闸旁路——CLI 手动路径 B-21；幂等由 reports UNIQUE 守卫）。
   * period 缺省 = 当前 ISO 周。
   */
  async function generateNow({ period } = {}) {
    const target = period ?? weekInfoOf(now()).weekKey
    const targetInfo = weekInfoOfPeriod(target)
    if (store.getReport('weekly', target)) {
      return { ok: false, skipped: 'duplicate', period: target }   // period 幂等（AC-029 不重发）
    }
    const acq = lock?.acquire?.('review', `weekly-${target}`)
    if (lock && acq && !acq.ok) {
      log(`[koi] 复盘作业锁被占（${acq.held?.kind}/${acq.held?.key ?? '-'}），本轮跳过，下轮补跑`)
      return { ok: false, skipped: 'lock', held: acq.held ?? null, period: target }
    }
    try {
      const cfg = readCfg()
      const built = await buildReport({ period: target, info: targetInfo, cfg })
      const ev = await emit({
        kind: 'review', level: 'info', title: `周报 ${target}`, date: targetInfo.to,
        message: built.content.split('\n').slice(0, 8).join('\n') + '\n…（全文见复盘卡片与 CLI report）',
        fullRef: `review|weekly|${target}`,
        panelOnly: true,   // TF-6：周报静默进面板事件列表，不推 QQ
      })
      const rec = store.recordReport('weekly', target, built.content, ev?.id ?? null)
      if (!rec.ok) return { ok: false, skipped: 'duplicate', period: target }
      if (reportsDir) {
        try {
          fs.mkdirSync(reportsDir, { recursive: true })
          fs.writeFileSync(path.join(reportsDir, `weekly-${target}.md`), built.content + '\n')
        } catch (e) { log(`[koi] 周报文件写盘失败（报告仍在 review.db 与面板）：${String(e?.message ?? e).slice(0, 120)}`) }
      }
      log(`[koi] 周报 ${target} 已生成（事件 ${ev?.id ?? '-'} · panelOnly）`)
      return { ok: true, period: target, content: built.content, eventId: ev?.id ?? null, health: built.health }
    } finally {
      if (lock && acq && acq.ok) { try { lock.release() } catch { /* 尽力释放 */ } }
    }
  }

  /**
   * 时刻表入口（tick 复盘段调用）。守卫链：mind.enabled → holiday → 生成窗口 → 幂等 → 锁。
   * 返回 { ok, period?, content?, skipped?, error? }。
   */
  async function maybeRunWeekly({ today, nowHHMM } = {}) {
    const cfg = readCfg()
    if (cfg?.mind?.enabled !== true) return { ok: false, skipped: 'mind-disabled' }   // 双向闸（AC-008）
    const d = today ?? dstr(now())
    const hh = nowHHMM ?? hhmmOf(now())
    const day = new Date(`${d}T12:00:00`)
    if (isHoliday(d, cfg.holidays)) return { ok: false, skipped: 'holiday', today: d }
    const isSunday = day.getDay() === 0
    // 窗口 A：周日 22:40–23:30（重试至放弃线前停；节流走注入时钟——测试可控）
    if (isSunday && hh >= WEEKLY_AT && hh < RETRY_GIVE_UP) {
      const t = now().getTime()
      if (t - lastAttemptAt < 5 * 60_000) return { ok: false, skipped: 'throttled' }
      try {
        const r = await generateNow({ period: weekKey(day) })
        // 仅真实失败置节流；lock/duplicate 跳过不节流（§3.3：下轮 tick ≤30s 即重试补跑）
        lastAttemptAt = (r.ok || r.skipped) ? 0 : t
        return r
      } catch (e) {
        lastAttemptAt = t
        log(`[koi] 周报生成失败（窗口内 5 分钟后重试，${RETRY_GIVE_UP} 前停止当日重试）：${String(e?.message ?? e).slice(0, 160)}`)
        return { ok: false, error: String(e?.message ?? e) }
      }
    }
    if (isSunday && hh >= RETRY_GIVE_UP) {
      return { ok: false, skipped: 'retry-giveup', today: d, detail: `已达 ${RETRY_GIVE_UP} 放弃线，当日重试停止（次日 ${CATCHUP_AT} 起补生成）` }
    }
    // 窗口 B：任意日 ≥04:00 补上一「已完整结束」的 ISO 周（周日白天不补当周——周未结束）
    if (hh >= CATCHUP_AT) {
      const yInfo = weekInfoOf(addDays(day, -1))
      const ended = yInfo.to < d
      if (ended && !store.getReport('weekly', yInfo.weekKey)) {
        try { return await generateNow({ period: yInfo.weekKey }) }
        catch (e) { log(`[koi] 周报补生成失败：${String(e?.message ?? e).slice(0, 160)}`); return { ok: false, error: String(e?.message ?? e) } }
      }
    }
    return { ok: false, skipped: 'window', today: d, hh }
  }

  return { maybeRunWeekly, generateNow, weekInfoOf, usageWeeks, WEEKLY_AT, RETRY_GIVE_UP, CATCHUP_AT }
}
