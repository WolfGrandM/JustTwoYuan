/**
 * dsh-koi 纯逻辑层 —— 不碰网络、不碰文件，全部可单测。
 *
 * 一个提前说透的事实（产品定位的根）：
 *   彩票每期开奖都是独立随机事件，任何选号方法都不能改变中奖概率。
 *   本插件卖的是「有人认真研究过 + 按时送达 + 诚实记账」这件事本身，
 *   所以对账/账本按官方规则算到分，不粉饰。
 */

// ── 彩种定义 ────────────────────────────────────────────────────────────────
// drawDays 用 Date#getDay()：0=周日 … 6=周六
//   双色球：周二(2)、周四(4)、周日(0)开奖，20:00 停售，21:15 开奖
//   大乐透：周一(1)、周三(3)、周六(6)开奖，20:00 停售，21:25 开奖
//   排列三：每天开奖（开奖号 = 排列五开奖号的前三位，同机同期摇出）
export const GAMES = {
  ssq: {
    key: 'ssq', name: '双色球', emoji: '🔴',
    drawDays: [0, 2, 4],
    drawTimeText: '21:15 开奖 · 20:00 停售',
    drawAt: '21:15',                      // ⚠M 结构化开奖时刻（市场版加法，供 predictAt 校验；drawTimeText 保留展示用）
    redMax: 33, redPick: 6, blueMax: 16, bluePick: 1,
    complex: { red: 8, blue: 1 },        // 主人定的复式规格：红8+蓝1 = C(8,6)×1 = 28 注 × 2 元 = 56 元
    unitStake: 2,
  },
  dlt: {
    key: 'dlt', name: '大乐透', emoji: '🐰',
    drawDays: [1, 3, 6],
    drawTimeText: '21:25 开奖 · 20:00 停售',
    drawAt: '21:25',                      // ⚠M 结构化开奖时刻（市场版加法）
    frontMax: 35, frontPick: 5, backMax: 12, backPick: 2,
    complex: { front: 7, back: 2 },      // 前7+后2 = C(7,5)×C(2,2) = 21 注 × 2 元 = 42 元
    unitStake: 2,
  },
  p3: {
    key: 'p3', name: '排列三', emoji: '🎯',
    drawDays: [0, 1, 2, 3, 4, 5, 6],
    drawTimeText: '21:25 开奖 · 20:00 停售',
    drawAt: '21:25',                      // ⚠M 结构化开奖时刻（市场版加法）
    digits: 3,                           // 直选一注，2 元，中 1040 元
    unitStake: 2,
  },
}

export const GAME_ORDER = ['ssq', 'dlt', 'p3']

/** 组合数 C(n, k) —— 这里的 n ≤ 9，直接乘除不溢出 */
export function comb(n, k) {
  if (k < 0 || k > n) return 0
  let r = 1
  for (let i = 0; i < k; i++) r = r * (n - i) / (i + 1)
  return Math.round(r)
}

/** 该彩种一期的注数与投注额（按复式规格 / 直选） */
export function stakesOf(gameKey) {
  const g = GAMES[gameKey]
  if (!g) return null
  if (gameKey === 'ssq') {
    const bets = comb(g.complex.red, g.redPick) * g.complex.blue
    return { bets, cost: bets * g.unitStake, spec: `红${g.complex.red}+蓝${g.complex.blue} 复式` }
  }
  if (gameKey === 'dlt') {
    const bets = comb(g.complex.front, g.frontPick) * comb(g.complex.back, g.backPick)
    return { bets, cost: bets * g.unitStake, spec: `前${g.complex.front}+后${g.complex.back} 复式` }
  }
  return { bets: 1, cost: g.unitStake, spec: '直选一注' }
}

/** 某天（'YYYY-MM-DD'）开哪些彩种 */
export function gamesForDate(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number)
  if (!y || !m || !d) return []
  const day = new Date(y, m - 1, d).getDay()
  return GAME_ORDER.filter((k) => GAMES[k].drawDays.includes(day))
}

// ── 号码校验（AI 产出的硬闸门：格式不对就重来/兜底，绝不把垃圾推给主人）─────────
const uniqInts = (a) => Array.isArray(a) && a.length === new Set(a).size && a.every((x) => Number.isInteger(Number(x)))
const inRange = (a, lo, hi) => a.every((x) => Number(x) >= lo && Number(x) <= hi)

/**
 * 校验 picks。合法返回 { ok:true, picks: 规范化后的 picks }，否则 { ok:false, error }。
 * 期望结构：
 *   ssq { red:[8个], blue:1个 }  dlt { front:[7个], back:[2个] }  p3 { digits:[3个] }
 */
export function validatePicks(gameKey, raw) {
  const g = GAMES[gameKey]
  if (!g || !raw || typeof raw !== 'object') return { ok: false, error: 'picks 缺失或不是对象' }
  const num = (x) => Number(x)
  try {
    if (gameKey === 'ssq') {
      const red = (raw.red ?? []).map(num)
      const blue = num(raw.blue)
      if (!uniqInts(red) || red.length !== g.complex.red) return { ok: false, error: `红球必须是 ${g.complex.red} 个不重复数字` }
      if (!inRange(red, 1, g.redMax)) return { ok: false, error: `红球必须在 1–${g.redMax} 之间` }
      if (!Number.isInteger(blue) || blue < 1 || blue > g.blueMax) return { ok: false, error: `蓝球必须是 1–${g.blueMax} 的一个数字` }
      return { ok: true, picks: { red: red.slice().sort((a, b) => a - b), blue } }
    }
    if (gameKey === 'dlt') {
      const front = (raw.front ?? []).map(num)
      const back = (raw.back ?? []).map(num)
      if (!uniqInts(front) || front.length !== g.complex.front) return { ok: false, error: `前区必须是 ${g.complex.front} 个不重复数字` }
      if (!inRange(front, 1, g.frontMax)) return { ok: false, error: `前区必须在 1–${g.frontMax} 之间` }
      if (!uniqInts(back) || back.length !== g.complex.back) return { ok: false, error: `后区必须是 ${g.complex.back} 个不重复数字` }
      if (!inRange(back, 1, g.backMax)) return { ok: false, error: `后区必须在 1–${g.backMax} 之间` }
      return { ok: true, picks: { front: front.slice().sort((a, b) => a - b), back: back.slice().sort((a, b) => a - b) } }
    }
    if (gameKey === 'p3') {
      const digits = (raw.digits ?? []).map(num)
      if (!Array.isArray(digits) || digits.length !== g.digits) return { ok: false, error: `必须是 ${g.digits} 个数字` }
      if (!digits.every((x) => Number.isInteger(x) && x >= 0 && x <= 9)) return { ok: false, error: '每位必须是 0–9' }
      return { ok: true, picks: { digits } }
    }
  } catch { /* 落到下面 */ }
  return { ok: false, error: 'picks 结构不认识' }
}

/** 兜底随机号（AI 摆烂时也一定能推送） */
export function randomPicks(gameKey) {
  const g = GAMES[gameKey]
  const rnd = (n) => Math.floor(Math.random() * n)
  const pickUnique = (count, max) => {
    const s = new Set()
    while (s.size < count) s.add(rnd(max) + 1)
    return [...s].sort((a, b) => a - b)
  }
  if (gameKey === 'ssq') return { red: pickUnique(g.complex.red, g.redMax), blue: rnd(g.blueMax) + 1 }
  if (gameKey === 'dlt') return { front: pickUnique(g.complex.front, g.frontMax), back: pickUnique(g.complex.back, g.backMax) }
  return { digits: [rnd(10), rnd(10), rnd(10)] }
}

/** picks 的一行可读展示（推送/面板/日志共用） */
export function picksLine(gameKey, picks) {
  if (!picks) return '（无号）'
  if (gameKey === 'ssq') return `红 ${picks.red.map((n) => String(n).padStart(2, '0')).join(' ')} + 蓝 ${String(picks.blue).padStart(2, '0')}`
  if (gameKey === 'dlt') return `前 ${picks.front.map((n) => String(n).padStart(2, '0')).join(' ')} + 后 ${picks.back.map((n) => String(n).padStart(2, '0')).join(' ')}`
  return `直选 ${picks.digits.join('-')}`
}

// ── 期号 ────────────────────────────────────────────────────────────────────
// 双色球 code = 年(4位)+年内期号(3位)：2026121 → 2026122
// 体彩（大乐透/排列五）lotteryDrawNum = 年(2位)+期号(3位)：26120 → 26121
// 跨年：新一年第一期从 001 重排 —— 用开奖日期的年份判断（lastDate 是最新一期开奖日，
// nextDate 是即将开奖那天的日期）。
export function nextIssue(lastIssue, lastDate, nextDate) {
  const s = String(lastIssue)
  const yLast = Number(String(lastDate).slice(0, 4))
  const yNext = Number(String(nextDate).slice(0, 4))
  if (yNext > yLast) {
    // 体彩是两位年份：26xxx → 27001；福彩是四位：2026xxx → 2027001
    return s.length <= 5 ? `${String(yNext).slice(2)}001` : `${yNext}001`
  }
  return String(Number(s) + 1)
}

// ── 复式拆注 + 官方奖级判定 ─────────────────────────────────────────────────
// 枚举复式里的每一注（ssq: C(8,6)×1；dlt: C(7,5)×C(2,2)），逐注按官方规则判奖。
function* combinations(arr, k, start = 0, acc = []) {
  if (acc.length === k) { yield acc.slice(); return }
  for (let i = start; i <= arr.length - (k - acc.length); i++) {
    acc.push(arr[i])
    yield* combinations(arr, k, i + 1, acc)
    acc.pop()
  }
}

export function enumerateBets(gameKey, picks) {
  const g = GAMES[gameKey]
  if (gameKey === 'ssq') {
    // 蓝球单选：每注共用同一个蓝球，注数 = C(8,6)
    return [...combinations(picks.red, g.redPick)].map((red) => ({ red, blue: picks.blue }))
  }
  if (gameKey === 'dlt') {
    const out = []
    for (const front of combinations(picks.front, g.frontPick)) {
      for (const back of combinations(picks.back, g.backPick)) out.push({ front, back })
    }
    return out
  }
  return [picks]
}

// 固定奖级金额（双色球三~六等 / 大乐透三~九等是全固定值；一、二等浮动）
const SSQ_FIXED = { 3: 3000, 4: 200, 5: 10, 6: 5 }
const DLT_FIXED = { 3: 10000, 4: 3000, 5: 300, 6: 200, 7: 100, 8: 15, 9: 5 }
const P3_ZHIXUAN = 1040

/**
 * 判一期的奖。
 * result:   ssq { red:[6], blue } / dlt { front:[5], back:[2] } / p3 { digits:[3] }
 * gradeMoney: 该期官方单注奖金表（可选）。ssq 传 {1:…,2:…,…}（来自福彩 API prizegrades），
 *             dlt 传 {1:…,…,9:…}（来自体彩 prizeLevelList）。缺省用固定表 + 浮动按 0 计。
 * 返回 { bets, grades:{级:注数}, money, floating } —— floating=true 表示含浮动奖未计入金额。
 */
export function judge(gameKey, picks, result, gradeMoney = null) {
  const bets = enumerateBets(gameKey, picks)
  const grades = {}
  let money = 0
  let floating = false
  const add = (grade, unit) => {
    grades[grade] = (grades[grade] ?? 0) + 1
    const fixed = gameKey === 'ssq' ? SSQ_FIXED[grade] : gameKey === 'dlt' ? DLT_FIXED[grade] : P3_ZHIXUAN
    if (fixed != null) money += fixed
    else {
      const m = Number(gradeMoney?.[grade] ?? 0)
      if (m > 0) money += m
      else floating = true
    }
  }
  if (gameKey === 'ssq') {
    const redSet = new Set(result.red)
    for (const bet of bets) {
      const r = bet.red.filter((x) => redSet.has(x)).length
      const b = bet.blue === Number(result.blue)
      if (r === 6 && b) add(1)
      else if (r === 6) add(2)
      else if (r === 5 && b) add(3)
      else if (r === 5 || (r === 4 && b)) add(4)
      else if (r === 4 || (r === 3 && b)) add(5)
      else if (b) add(6)   // 蓝球中即六等（0–2 红 + 蓝）
    }
  } else if (gameKey === 'dlt') {
    const frontSet = new Set(result.front)
    const backSet = new Set(result.back)
    for (const bet of bets) {
      const f = bet.front.filter((x) => frontSet.has(x)).length
      const b = bet.back.filter((x) => backSet.has(x)).length
      if (f === 5 && b === 2) add(1)
      else if (f === 5 && b === 1) add(2)
      else if (f === 5) add(3)
      else if (f === 4 && b === 2) add(4)
      else if (f === 4 && b === 1) add(5)
      else if (f === 3 && b === 2) add(6)
      else if (f === 4) add(7)
      else if ((f === 3 && b === 1) || (f === 2 && b === 2)) add(8)
      else if ((f === 3 && b === 0) || (f === 2 && b === 1) || (f === 1 && b === 2) || (f === 0 && b === 2)) add(9)
    }
  } else {
    for (const bet of bets) {
      if (bet.digits.every((d, i) => Number(d) === Number(result.digits[i]))) add(1)
    }
  }
  return { bets: bets.length, grades, money, floating }
}

/** 奖级一行中文（战果消息用）："三等奖×1(3000元) 六等奖×2(10元)" */
export function gradeSummaryText(gameKey, judged) {
  const names = gameKey === 'ssq'
    ? { 1: '一等奖', 2: '二等奖', 3: '三等奖', 4: '四等奖', 5: '五等奖', 6: '六等奖' }
    : gameKey === 'dlt'
      ? Object.fromEntries(Array.from({ length: 9 }, (_, i) => [i + 1, `${['一', '二', '三', '四', '五', '六', '七', '八', '九'][i]}等奖`]))
      : { 1: '直选' }
  const parts = Object.entries(judged.grades)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([g, n]) => `${names[g] ?? g + '等奖'}×${n}`)
  return parts.length ? parts.join('、') : '未中奖'
}

// ── 模拟账本 ────────────────────────────────────────────────────────────────
// 口径（主人 2026-10-23 定）：「若每期正式预测都买」—— 每期正式预测入账投注额，
// 中奖金额按官方奖级；加餐（quickpick）不记账。这样账本永远诚实，数字会难看，
// 难看本身就是它存在的意义。
export function emptyLedger() { return { entries: [] } }

export function appendLedgerEntry(ledger, entry) {
  // entry: { at, game, issue, date, kind:'daily', cost, prize, bets, grades }
  // v1.1（C1/ADR-10）：追加模型 —— entryType 缺省 'main'（旧数据零迁移），
  // supplement（补判）与 reversal（休市作废冲销）带 ref 指向主条目，任何结清只追加不改写。
  const l = ledger && Array.isArray(ledger.entries) ? ledger : emptyLedger()
  l.entries.push(entry)
  return l
}

/**
 * 账本合计（v1.1 扩展口径，C1/FR-001 —— 唯一改动的既有聚合函数）：
 *   voided 集   = reversal 条目 ref 键集（game|issue|date）
 *   聚合集      =（非 reversal 且未被作废的 main）∪ supplement
 *   cost 求和于 main、prize 求和于 main∪supplement、期数按 main 计
 * 无任何新字段的旧文件输出与 v1.0 实现逐位一致（阶段B 21/21 模拟 + 本仓库单测双重验证）。
 */
export function ledgerTotals(ledger) {
  const all = (ledger && Array.isArray(ledger.entries) ? ledger.entries : [])
    .filter((e) => e.kind !== 'quickpick')
  const voided = new Set(all
    .filter((e) => e.entryType === 'reversal' && e.ref)
    .map((e) => `${e.ref.game}|${e.ref.issue}|${e.ref.date}`))
  const main = all.filter((e) => (e.entryType ?? 'main') === 'main'
    && !voided.has(`${e.game}|${e.issue}|${e.date}`))
  const agg = [...main, ...all.filter((e) => e.entryType === 'supplement')]
  const cost = main.reduce((s, e) => s + Number(e.cost ?? 0), 0)
  const prize = agg.reduce((s, e) => s + Number(e.prize ?? 0), 0)
  const draws = main.length
  const best = agg.filter((e) => Number(e.prize ?? 0) > 0)
    .sort((a, b) => Number(b.prize) - Number(a.prize))[0] ?? null
  return { cost, prize, net: prize - cost, draws, best }
}

export function ledgerTotalsText(totals) {
  if (!totals.draws) return '模拟账本：还没有账（预测发出并开奖后开始记）'
  const best = totals.best ? `最好一期 +${totals.best.prize} 元（${totals.best.game.toUpperCase()} ${totals.best.issue} 期）` : '还没开过胡'
  return `模拟账本（若每期都买）：投入 ${totals.cost} 元 · 中 ${totals.prize} 元 · 净 ${totals.net >= 0 ? '+' : ''}${totals.net} 元 · 共 ${totals.draws} 期 · ${best}`
}
