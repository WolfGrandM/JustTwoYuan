/**
 * dsh-koi 对账核心纯函数层（v0.2 T-05 / docs/22 P3）—— 自 scheduler.js 搬迁的 v1.1 纯函数组，
 * 消除 events.js→scheduler.js 与 drawstore.js→scheduler.js 两条循环 import（docs/22 §2.1 循环①②）。
 *
 * 搬迁纪律（行为保持）：函数体逐字拷贝、语义零改动——
 *   · carryJobsFromEntries 是 FZ-5（docs/10 §2）命名的 carry 扫描实现（C8），相位与转移语义零改动；
 *   · buildMainPendingEntry / buildSupplementEntry / buildReversalEntry 是 C1 账本三类条目
 *     （main/supplement/reversal，docs/10 §5.1 ledger 契约、ADR-0004 账本诚实面）构造函数，输出形状零改动；
 *   · scheduler.js 原地 re-export 全部符号，既有 import 路径（tests / tools/koi.mjs）保持兼容。
 *
 * 依赖面：零相对依赖，仅 timeutil（isPastDeadline 的同日 hhmm 比较，sv-SE 逐字保持）。
 */
import { hhmm } from './timeutil.js'

/** C10：补发队列上限（不过期、跨天携带）——事件层队列同参（原 scheduler.js 三处镜像的单一源） */
export const REPUSH_QUEUE_MAX = 20

// ── v1.1 纯逻辑（C-06：新逻辑以可导出纯函数落地，tests/v11-fixes.test.mjs 直连）────

/** C2/FR-002：日期是否命中休市日历（YYYY-MM-DD 精确字符串匹配） */
export function isHoliday(dateStr, holidays) {
  return Array.isArray(holidays) && holidays.some((d) => String(d) === String(dateStr))
}

/**
 * C1/FR-001 三态对账决策（纯函数，settleOne 的决策核）：
 *   'done'     条目已终态（settled / voided）→ 幂等直接了结，绝不重复记账
 *   'settle'   目标期已公布（最新期号相等，或期号跳跃但历史里翻得到目标期）→ 判奖记账
 *   'void'     官方期号已跳过目标期且历史无此期（§4.5 数值比较，证实休市/取消）→ 作废冲销
 *   'give-up'  过放弃线仍未公布 → 记「放弃待补」（首次；重复给-up 由 settleState 守卫挡下）
 *   'wait'     未公布且未到放弃线 → 下一轮再问
 */
export function settleOutcome(entry, latestIssue, historyFound, nowHHMM, giveUpHHMM = '23:30') {
  if (entry?.settleState === 'settled' || entry?.settleState === 'voided') return 'done'
  if (latestIssue == null || latestIssue === '') return 'wait'
  const after = Number(latestIssue) > Number(entry.issue)   // 两套期号格式均以年份为前缀，跨年单调
  if (String(latestIssue) === String(entry.issue) || (after && historyFound)) return 'settle'
  if (after) return 'void'
  return String(nowHHMM) > String(giveUpHHMM) ? 'give-up' : 'wait'
}

/** C1：放弃待补的账本 main 条目（投入照记、奖金挂空、pending 标记） */
export function buildMainPendingEntry(entry, at = new Date().toISOString()) {
  return {
    at, kind: 'daily', game: entry.game, issue: entry.issue, date: entry.date,
    cost: entry.cost, prize: null, bets: entry.bets ?? null, grades: null,
    entryType: 'main', pending: true, note: '放弃待补',
  }
}

/** C1：补判 supplement 条目（cost:0 + 判奖结果 + 指向主条目的 ref 指针） */
export function buildSupplementEntry(entry, judged, at = new Date().toISOString(), note) {
  return {
    at, kind: 'daily', game: entry.game, issue: entry.issue, date: entry.date,
    cost: 0, prize: judged.money, bets: judged.bets, grades: judged.grades,
    entryType: 'supplement', ref: { game: entry.game, issue: entry.issue, date: entry.date },
    ...(note ? { note } : {}),
  }
}

/** C1：休市作废 reversal 冲销条目（ref 指针；该期投入经 ledgerTotals 的 voided 集排除出口径） */
export function buildReversalEntry(entry, at = new Date().toISOString(), note = '休市作废') {
  return {
    at, kind: 'daily', game: entry.game, issue: entry.issue, date: entry.date,
    cost: 0, prize: 0, bets: 0, grades: null,
    entryType: 'reversal', ref: { game: entry.game, issue: entry.issue, date: entry.date }, note,
  }
}

/** C8/FR-006：跨天顺延扫描 —— 全部未结清条目（!settled 或 given-up；排除 voided 与加餐），按日期+彩种去重 */
export function carryJobsFromEntries(entries) {
  const seen = new Set()
  const out = []
  for (const e of (Array.isArray(entries) ? entries : [])) {
    if (e.kind !== 'daily') continue
    if (e.settleState === 'voided') continue
    if (e.settled && e.settleState !== 'given-up') continue
    const key = `${e.date}|${e.game}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ date: e.date, gameKey: e.game })
  }
  return out
}

/** C10/FR-005：推送重试间隔（毫秒），来自 push.retryMinutes（默认 5，非法值回退 5） */
export function retryIntervalMs(cfg) {
  const m = Number(cfg?.push?.retryMinutes ?? 5)
  return (Number.isFinite(m) && m > 0 ? m : 5) * 60_000
}

/** C10/FR-005：分类终止线 —— 预测至 catchUpEnd，战果/致歉至 settleGiveUp */
export function deadlineForKind(kind, time = {}) {
  return kind === 'predict' ? (time.catchUpEnd ?? '19:50') : (time.settleGiveUp ?? '23:30')
}

/**
 * C10：一条补发消息此刻送达是否已过自己的终止线（过了线 → 加【补发】前缀）。
 * 同日按 HH:MM 比较；失败发生在更早的日期（跨天滞留）→ 必然已过线。
 */
export function isPastDeadline(now, deadlineHHMM, failedAtISO) {
  if (!failedAtISO) return false
  const f = new Date(failedAtISO)
  if (Number.isNaN(f.getTime())) return false
  const sameDay = now.toLocaleDateString('sv-SE') === f.toLocaleDateString('sv-SE')
  return sameDay ? hhmm(now) > String(deadlineHHMM) : true
}

/**
 * C10/B-31：入补发队列（纯函数）。同类合并（kind+game+issue 相同只留最新、累计合并次数）；
 * 队列满且无同类可合并 → 溢出丢弃最早条目并在返回值 dropped 里报告（调用方推告警，不静默丢弃）。
 */
export function enqueueRepush(queue, item, max = REPUSH_QUEUE_MAX) {
  const q = [...(Array.isArray(queue) ? queue : [])]
  const key = (x) => `${x.kind}|${x.game}|${x.issue ?? ''}`
  const i = q.findIndex((x) => key(x) === key(item))
  if (i >= 0) {
    const prev = q[i]
    q[i] = { ...item, mergedCount: (prev.mergedCount ?? 0) + 1 }
    return { queue: q, merged: true, dropped: [] }
  }
  const dropped = []
  while (q.length >= max) dropped.push(q.shift())
  q.push(item)
  return { queue: q, merged: false, dropped }
}

/** C6/FR-008：数据新鲜度判定 —— 最新开奖日期距今超过 maxDays 天 → 该源数据陈旧 */
export function isStaleDraw(latestDate, today, maxDays = 7) {
  if (!latestDate || !today) return true
  const a = Date.parse(String(latestDate).slice(0, 10))
  const b = Date.parse(String(today).slice(0, 10))
  if (Number.isNaN(a) || Number.isNaN(b)) return true
  return Math.floor((b - a) / 86_400_000) > maxDays
}

// ── 市场版：无模型错误分类（FR-1022/S-117；模式表可配置，MD-09 保守种子 + 实测校准）──

export const DEFAULT_NO_MODEL_PATTERNS = [
  'no model', 'model not configured', 'model not found', 'no available model',
  '未配置模型', '没有配置模型', '未配置可用的模型',
]

/**
 * 宿主异常分类：命中 no-model 模式 → {kind:'no-model', hint:配置指引}（quickpick 直接返回指引、
 * 跳过打回重写与随机兜底——手动模式无「必须出号」承诺，清晰失败优于静默兜底）；
 * 未命中 → {kind:'other', hint:原语义}（不劣于现状）。
 */
export function classifyHostError(err, patterns = DEFAULT_NO_MODEL_PATTERNS) {
  const msg = String(err?.message ?? err ?? '')
  const list = Array.isArray(patterns) && patterns.length ? patterns : DEFAULT_NO_MODEL_PATTERNS
  const lower = msg.toLowerCase()
  const hit = list.some((p) => p && lower.includes(String(p).toLowerCase()))
  if (hit) {
    return { kind: 'no-model', hint: '宿主未配置模型，请先在 DSH 设置中配置模型（入口：设置→模型），配置后重试' }
  }
  return { kind: 'other', hint: msg.slice(0, 200) }
}
