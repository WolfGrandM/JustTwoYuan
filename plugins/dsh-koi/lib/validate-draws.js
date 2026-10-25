/**
 * dsh-koi 校验公共层（市场版 FR-1017/BC-104）—— 四项校验，自拉底座/增量入库/手动按需三方共用。
 *
 * 四项（docs/14 R8 校验清单）：
 *   ① 期号格式（DC-006：福彩 ssq 7 位数字；体彩 dlt/p3 5 位数字）
 *   ② 日期合理性（可解析且不晚于今日）
 *   ③ 号码值域（红 1–33 / 蓝 1–16 / 前 1–35 / 后 1–12 / 位 0–9，且个数与彩种一致）
 *   ④ 连续性（同年相邻期号差 1；跨年重排放行；断档/单调性破坏拒用）
 * 不过关即拒用（BC-104：绝不静默学习假数据），拒用条目带原因返回（rejected 清单，DC-109）。
 * 全部纯函数；新鲜度探针沿用 scheduler.isStaleDraw（>7 天 ✗，FR-008）。
 */
import { GAMES } from './draws.js'
import { todayStr } from './timeutil.js'   // T-07：时间工具单点（sv-SE 逐字保持）

const ISSUE_RE = { ssq: /^\d{7}$/, dlt: /^\d{5}$/, p3: /^\d{5}$/ }

const yearOf = (issue) => {
  const s = String(issue)
  return Number(s.length <= 5 ? ('20' + s.slice(0, 2)) : s.slice(0, 4))
}

/** 单条目前三项校验（格式/日期/值域）。返回 null=通过，否则拒绝原因。 */
function checkEntry(gameKey, e, today) {
  if (!e || typeof e !== 'object') return '条目不是对象'
  if (!ISSUE_RE[gameKey]?.test(String(e.issue ?? ''))) {
    return `期号格式非法（${gameKey === 'ssq' ? '应为 7 位数字' : '应为 5 位数字'}）：${e.issue}`
  }
  const d = Date.parse(String(e.date ?? '').slice(0, 10))
  if (Number.isNaN(d)) return `日期不可解析：${e.date}`
  if (String(e.date).slice(0, 10) > String(today)) return `日期晚于今日（未来数据）：${e.date}`
  const g = GAMES[gameKey]
  if (gameKey === 'ssq') {
    if (!Array.isArray(e.red) || e.red.length !== 6) return '红球个数≠6'
    if (!e.red.every((x) => Number.isInteger(Number(x)) && x >= 1 && x <= g.redMax)) return `红球值域越界（1–${g.redMax}）`
    if (!Number.isInteger(Number(e.blue)) || e.blue < 1 || e.blue > g.blueMax) return `蓝球值域越界（1–${g.blueMax}）`
  } else if (gameKey === 'dlt') {
    if (!Array.isArray(e.front) || e.front.length !== 5) return '前区个数≠5'
    if (!e.front.every((x) => Number.isInteger(Number(x)) && x >= 1 && x <= g.frontMax)) return `前区值域越界（1–${g.frontMax}）`
    if (!Array.isArray(e.back) || e.back.length !== 2) return '后区个数≠2'
    if (!e.back.every((x) => Number.isInteger(Number(x)) && x >= 1 && x <= g.backMax)) return `后区值域越界（1–${g.backMax}）`
  } else {
    if (!Array.isArray(e.digits) || e.digits.length !== 3) return '位数≠3'
    if (!e.digits.every((x) => Number.isInteger(Number(x)) && x >= 0 && x <= 9)) return '位值域越界（0–9）'
  }
  return null
}

/**
 * 四项校验（第④项连续性在批次内判定）。entries 任意顺序均可（内部先按期号降序排）。
 * 返回 { ok, valid:[…], rejected:[{ issue, reason }] }；ok = rejected 为空。
 * 连续性：同年相邻差 1；跨年（年份前缀变化）重排放行；断档或倒挂 → 涉事两条均拒（MD 登记）。
 */
export function validateDraws(gameKey, entries, { today } = {}) {
  const t = today ?? todayStr()   // T-07：参数优先、缺省走单点（默认真实时钟）
  const list = Array.isArray(entries) ? entries.filter(Boolean) : []
  const rejected = []
  const seen = new Set()
  const stage = []   // 通过前三项的，降序（最新在前）
  for (const e of list) {
    const reason = checkEntry(gameKey, e, t)
    if (reason) { rejected.push({ issue: e?.issue ?? '?', reason }); continue }
    if (seen.has(String(e.issue))) { rejected.push({ issue: e.issue, reason: '期号重复' }); continue }
    seen.add(String(e.issue))
    stage.push(e)
  }
  stage.sort((a, b) => Number(b.issue) - Number(a.issue))
  // 连续性（≥2 条才判定；断档/倒挂涉事两条均拒——无法判别哪条是假的，保守全拒）
  const bad = new Set()
  for (let i = 0; i + 1 < stage.length; i++) {
    const a = Number(stage[i].issue)      // 新
    const b = Number(stage[i + 1].issue)  // 旧
    const yA = yearOf(stage[i].issue)
    const yB = yearOf(stage[i + 1].issue)
    const ok = yA !== yB ? (yA > yB) : a - b === 1   // 跨年重排放行；同年差 1
    if (!ok) { bad.add(String(stage[i].issue)); bad.add(String(stage[i + 1].issue)) }
  }
  const valid = stage.filter((e) => {
    if (bad.has(String(e.issue))) { rejected.push({ issue: e.issue, reason: '期号断档/不连续' }); return false }
    return true
  })
  return { ok: rejected.length === 0, valid, rejected }
}

/**
 * 全库连续性审计（第二波 §3.1，FR-1017 增强；纯函数）——backfill done 后 / backbone status 按需。
 * 对整库 entries 跑与入库校验同一套连续性规则（同年相邻差 1、跨年重排放行），
 * 返回 { ok, gaps:[{between:[旧,新], note}], count }。与入库时的差异：只报「断档位置」不拒数据
 * （数据已在库，审计是发现面不是闸门）；发现断档不自动补拉（列 openIssue 供主人决断）。
 * 已知合理断档口径：春节休市不占期号（同年期号差 1 天然连续），跨年重排放行——与第一波一致。
 */
export function auditContinuity(entries) {
  const list = (Array.isArray(entries) ? entries : []).filter(Boolean).slice()
  list.sort((a, b) => Number(a.issue) - Number(b.issue))
  const gaps = []
  for (let i = 0; i + 1 < list.length; i++) {
    const older = list[i]
    const newer = list[i + 1]
    const a = Number(older.issue)
    const b = Number(newer.issue)
    const yA = yearOf(older.issue)
    const yB = yearOf(newer.issue)
    if (yA !== yB) continue   // 跨年重排放行（与入库校验同口径）
    if (b - a !== 1) gaps.push({ between: [String(older.issue), String(newer.issue)], note: `同年期号差 ${b - a}（可能为源端历史缺失；审计只报告不自动补拉）` })
  }
  return { ok: gaps.length === 0, gaps, count: list.length }
}

/**
 * 同源双接口抽样核验（第二波 §3.2，MA-23 口径；纯函数包装 + 1 次真实请求）。
 * 对库内最新一期：dlt/p3 用 getHistoryPageListV1 的 lastPoolDraw 路径（fetchLatestDraw 已有）、
 * ssq 无第二接口 → 退化为同接口重取一次（findDrawNotice count=1）比对号码/日期。
 * 不一致 → mismatch 留痕（BC-104，绝不静默）。抽样≠全量核验：结论恒标「抽样核验（最新 1 期）」。
 */
export async function crossCheckLatest(store, fetchers, game) {
  const local = (typeof store?.getRecent === 'function' ? store.getRecent(game, 1) : [])[0] ?? null
  if (!local) return { ok: false, game, crossCheck: 'no-local', error: '本地库为空，无最新期可比对' }
  let remote = null
  try {
    remote = await fetchers.fetchLatestDraw(game)
  } catch (e) {
    return { ok: false, game, crossCheck: 'fetch-error', error: String(e?.message ?? e).slice(0, 160) }
  }
  if (!remote || !remote.issue) return { ok: false, game, crossCheck: 'fetch-error', error: '官方最新一期拉取失败' }
  const base = { game, issue: String(local.issue), note: '抽样核验（最新 1 期，非全量双源核验）' }
  if (String(remote.issue) !== String(local.issue)) {
    return { ...base, ok: true, crossCheck: 'issue-differs', mismatch: true, detail: `库内最新 ${local.issue} 与官方接口最新 ${remote.issue} 不一致（库可能落后于官方；如实留痕，不自动改库）` }
  }
  const diffs = []
  if (game === 'ssq') {
    if (JSON.stringify([...local.red].sort((a, b) => a - b)) !== JSON.stringify([...remote.red].sort((a, b) => a - b))) diffs.push('红球不一致')
    if (Number(local.blue) !== Number(remote.blue)) diffs.push('蓝球不一致')
  } else if (game === 'dlt') {
    if (JSON.stringify([...local.front].sort((a, b) => a - b)) !== JSON.stringify([...remote.front].sort((a, b) => a - b))) diffs.push('前区不一致')
    if (JSON.stringify([...local.back].sort((a, b) => a - b)) !== JSON.stringify([...remote.back].sort((a, b) => a - b))) diffs.push('后区不一致')
  } else {
    if (JSON.stringify(local.digits) !== JSON.stringify(remote.digits)) diffs.push('位数不一致')
  }
  if (String(local.date ?? '').slice(0, 10) !== String(remote.date ?? '').slice(0, 10)) diffs.push('开奖日期不一致')
  if (diffs.length) return { ...base, ok: true, crossCheck: 'mismatch', mismatch: true, detail: diffs.join('；') + '（BC-104 留痕：拒绝写入本次比对结果，绝不静默）' }
  return { ...base, ok: true, crossCheck: 'ok', mismatch: false, detail: '号码与日期与官方接口一致' }
}
