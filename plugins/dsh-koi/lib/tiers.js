/**
 * dsh-koi 投注档位层（市场版 FR-1011/DC-106/BC-113）—— 档位表、拆单元判奖、档位感知校验/随机。
 *
 * 铁律（FZ-1/FZ-2 零修改，docs/16 §2.2.4 / §8.1）：
 *   · judge / enumerateBets / stakesOf / comb / validatePicks / randomPicks 全部只调用不修改；
 *   · 档位感知逻辑走本模块平行函数（validateTierPicks / randomTierPicks），规则风格与 FZ-2 同源；
 *   · 拆单元 = 把档位 picks 拆为现有 judge 可直接消化的单单元，逐单元判奖后聚合（D-004）。
 * 全部纯函数，tests/market-tiers.test.mjs 直连单测（沿 v1.1 C-06 纪律）。
 */
import { GAMES, comb, judge } from './draws.js'

// ── 档位表（DC-106 初始档集，A2.1 V2 实测注数/价格；出厂默认档 = 2 元单式基础档，主人 2026-10-25 拍板）──
// 结构：ssq { red, blue } / dlt { front, back } / p3 { units }（直选单式 ×N）
export const TIERS = {
  'p3-x1': { id: 'p3-x1', game: 'p3', units: 1, label: '直选单式 ×1' },
  'p3-x3': { id: 'p3-x3', game: 'p3', units: 3, label: '直选单式 ×3' },
  'p3-x5': { id: 'p3-x5', game: 'p3', units: 5, label: '直选单式 ×5' },
  'ssq-d6b1': { id: 'ssq-d6b1', game: 'ssq', red: 6, blue: 1, label: '单式 6+1' },
  'ssq-r7b1': { id: 'ssq-r7b1', game: 'ssq', red: 7, blue: 1, label: '红7+蓝1' },
  'ssq-r8b1': { id: 'ssq-r8b1', game: 'ssq', red: 8, blue: 1, label: '红8+蓝1' },
  'ssq-r9b2': { id: 'ssq-r9b2', game: 'ssq', red: 9, blue: 2, label: '红9+蓝2' },
  'dlt-f5b2': { id: 'dlt-f5b2', game: 'dlt', front: 5, back: 2, label: '单式 5+2' },
  'dlt-f6b2': { id: 'dlt-f6b2', game: 'dlt', front: 6, back: 2, label: '前6+后2' },
  'dlt-f7b2': { id: 'dlt-f7b2', game: 'dlt', front: 7, back: 2, label: '前7+后2' },
  'dlt-f8b3': { id: 'dlt-f8b3', game: 'dlt', front: 8, back: 3, label: '前8+后3' },
}

/** id 或 tier 对象 → 档位对象（不存在返回 null） */
export function tierById(tier) {
  if (tier == null) return null
  if (typeof tier === 'string') return TIERS[tier] ?? null
  return TIERS[tier.id] ?? (tier.game ? tier : null)
}

/** 某彩种的全部档位（附 bets/cost 实算） */
export function tiersForGame(gameKey) {
  return Object.values(TIERS).filter((t) => t.game === gameKey).map((t) => ({ ...t, ...tierStakes(t) }))
}

/** 出厂默认档 = 2 元单式基础档（主人 2026-10-25 拍板：所有彩种默认推荐 2 元档，其余档位保留） */
export function defaultTierFor(gameKey) {
  return gameKey === 'ssq' ? 'ssq-d6b1' : gameKey === 'dlt' ? 'dlt-f5b2' : 'p3-x1'
}

/** v1 复式结构的等价档（migrate-v2 反查用：作者账本连续性，§2.2.10-4②） */
export function v1EquivTier(gameKey) {
  return gameKey === 'ssq' ? 'ssq-r8b1' : gameKey === 'dlt' ? 'dlt-f7b2' : 'p3-x1'
}

/** 档位一期的注数与投注额（D-004：ssq C(red,6)×blue×2 / dlt C(front,5)×C(back,2)×2 / p3 units×2） */
export function tierStakes(tier) {
  const t = tierById(tier)
  if (!t) return null
  const unit = GAMES[t.game]?.unitStake ?? 2
  let bets = 0
  let spec = ''
  if (t.game === 'ssq') {
    bets = comb(t.red, 6) * t.blue
    spec = (t.red === 6 && t.blue === 1 ? '单式 红6+蓝1' : `复式 红${t.red}+蓝${t.blue}`)
  } else if (t.game === 'dlt') {
    bets = comb(t.front, 5) * comb(t.back, 2)
    spec = (t.front === 5 && t.back === 2 ? '单式 前5+后2' : `复式 前${t.front}+后${t.back}`)
  } else {
    bets = t.units
    spec = t.units === 1 ? '直选一注' : `直选单式 ×${t.units}`
  }
  return { bets, cost: bets * unit, spec }
}

/** 档位一行可读规格（提示词/面板/账本共用；stakesOf 同款 spec 文案 + 注数/价格） */
export function specText(tier) {
  const t = tierById(tier)
  if (!t) return ''
  const s = tierStakes(t)
  return `${s.spec}（${s.bets} 注 · ${s.cost} 元）`
}

/**
 * 拆单元（§4.1）：把档位 picks 拆为现有 judge 直接可吃的单元列表。
 *   ssq 蓝多选 → 每蓝一个单元（红池共享）；蓝单选 → 单单元
 *   dlt → 单单元（enumerateBets 按池长组合展开，天然支持长池）
 *   p3 ×N → N 个三位数单元
 */
export function unitsOf(tier, picks) {
  const t = tierById(tier)
  if (!t || !picks || typeof picks !== 'object') return []
  if (t.game === 'ssq') {
    const blues = Array.isArray(picks.blue) ? picks.blue : [picks.blue]
    return blues.map((b) => ({ red: picks.red, blue: b }))
  }
  if (t.game === 'dlt') return [{ front: picks.front, back: picks.back }]
  // p3：单注 = { digits:[3] }；多注 = { digits:[[3],[3],…] }
  if (t.units === 1 || !Array.isArray(picks.digits?.[0])) return [picks]
  return picks.digits.map((d) => ({ digits: d }))
}

/**
 * 拆单元判奖聚合（FZ-1 judge 零修改）：逐单元 judge 后聚合
 * { bets, grades(逐级求和), money(求和), floating(或) }。
 */
export function judgeTier(tier, picks, result, gradeMoney = null) {
  const units = unitsOf(tier, picks)
  const grades = {}
  let bets = 0
  let money = 0
  let floating = false
  for (const unit of units) {
    const g = GAMES[tierById(tier).game]
    const j = judge(g.key, unit, result, gradeMoney)
    bets += j.bets
    money += j.money
    floating = floating || j.floating
    for (const [k, n] of Object.entries(j.grades)) grades[k] = (grades[k] ?? 0) + n
  }
  return { bets, grades, money, floating }
}

const uniqInts = (a) => Array.isArray(a) && a.length === new Set(a).size && a.every((x) => Number.isInteger(Number(x)))
const inRange = (a, lo, hi) => a.every((x) => Number(x) >= lo && Number(x) <= hi)
const num = (x) => Number(x)

/**
 * 档位感知校验（FZ-2 validatePicks 的平行函数，规则风格同源；原函数零触碰）。
 * 合法返回 { ok:true, picks }，否则 { ok:false, error }。
 * 规范化形状：ssq blue 单选=数字、双选=升序数组；dlt 前/后区升序；p3 单注 digits=[3]、多注 digits=[[3]…]。
 */
export function validateTierPicks(tier, raw) {
  const t = tierById(tier)
  if (!t || !raw || typeof raw !== 'object') return { ok: false, error: '档位缺失或 picks 不是对象' }
  const g = GAMES[t.game]
  try {
    if (t.game === 'ssq') {
      const red = (raw.red ?? []).map(num)
      if (!uniqInts(red) || red.length !== t.red) return { ok: false, error: `红球必须是 ${t.red} 个不重复数字` }
      if (!inRange(red, 1, g.redMax)) return { ok: false, error: `红球必须在 1–${g.redMax} 之间` }
      const blueRaw = Array.isArray(raw.blue) ? raw.blue.map(num) : [num(raw.blue)]
      if (!uniqInts(blueRaw) || blueRaw.length !== t.blue) return { ok: false, error: `蓝球必须是 ${t.blue} 个不重复数字（1–${g.blueMax}）` }
      if (!inRange(blueRaw, 1, g.blueMax)) return { ok: false, error: `蓝球必须在 1–${g.blueMax} 之间` }
      return { ok: true, picks: { red: red.slice().sort((a, b) => a - b), ...(t.blue === 1 ? { blue: blueRaw[0] } : { blue: blueRaw.slice().sort((a, b) => a - b) }) } }
    }
    if (t.game === 'dlt') {
      const front = (raw.front ?? []).map(num)
      const back = (raw.back ?? []).map(num)
      if (!uniqInts(front) || front.length !== t.front) return { ok: false, error: `前区必须是 ${t.front} 个不重复数字` }
      if (!inRange(front, 1, g.frontMax)) return { ok: false, error: `前区必须在 1–${g.frontMax} 之间` }
      if (!uniqInts(back) || back.length !== t.back) return { ok: false, error: `后区必须是 ${t.back} 个不重复数字` }
      if (!inRange(back, 1, g.backMax)) return { ok: false, error: `后区必须在 1–${g.backMax} 之间` }
      return { ok: true, picks: { front: front.slice().sort((a, b) => a - b), back: back.slice().sort((a, b) => a - b) } }
    }
    // p3：单注 [3 个 0–9]；多注 [[3]…units 组]，重复单元拒绝（MD-15）
    if (t.units === 1) {
      const digits = (raw.digits ?? []).map(num)
      if (!Array.isArray(digits) || digits.length !== g.digits) return { ok: false, error: `必须是 ${g.digits} 个数字` }
      if (!digits.every((x) => Number.isInteger(x) && x >= 0 && x <= 9)) return { ok: false, error: '每位必须是 0–9' }
      return { ok: true, picks: { digits } }
    }
    const groups = raw.digits ?? []
    if (!Array.isArray(groups) || groups.length !== t.units) return { ok: false, error: `必须是 ${t.units} 组三位数` }
    const units = groups.map((gr) => {
      const d = (Array.isArray(gr) ? gr : []).map(num)
      if (d.length !== g.digits) throw new Error('bad')
      if (!d.every((x) => Number.isInteger(x) && x >= 0 && x <= 9)) throw new Error('bad')
      return d
    })
    const keys = new Set(units.map((d) => d.join('-')))
    if (keys.size !== t.units) return { ok: false, error: '各组三位数不能重复' }
    return { ok: true, picks: { digits: units } }
  } catch {
    return { ok: false, error: 'picks 结构不认识' }
  }
}

/** 档位感知随机兜底（FZ-2 randomPicks 的平行同构函数） */
export function randomTierPicks(tier) {
  const t = tierById(tier)
  if (!t) return null
  const g = GAMES[t.game]
  const rnd = (n) => Math.floor(Math.random() * n)
  const pickUnique = (count, max) => {
    const s = new Set()
    while (s.size < count) s.add(rnd(max) + 1)
    return [...s].sort((a, b) => a - b)
  }
  if (t.game === 'ssq') {
    const red = pickUnique(t.red, g.redMax)
    const blues = new Set()
    while (blues.size < t.blue) blues.add(rnd(g.blueMax) + 1)
    const blue = [...blues].sort((a, b) => a - b)
    return { red, ...(t.blue === 1 ? { blue: blue[0] } : { blue }) }
  }
  if (t.game === 'dlt') {
    return { front: pickUnique(t.front, g.frontMax), back: pickUnique(t.back, g.backMax) }
  }
  const one = () => [rnd(10), rnd(10), rnd(10)]
  if (t.units === 1) return { digits: one() }
  const seen = new Set()
  while (seen.size < t.units) seen.add(one().join('-'))
  return { digits: [...seen].map((k) => k.split('-').map(Number)) }
}

/** 档表自检（§2.2.4 非功能：units×单价 与组合数互证；测试与启动体检共用） */
export function tierTableSelfCheck() {
  const problems = []
  for (const t of Object.values(TIERS)) {
    const s = tierStakes(t)
    if (!s || s.bets <= 0) problems.push(`${t.id} 注数非法`)
    if (s && s.cost !== s.bets * (GAMES[t.game]?.unitStake ?? 2)) problems.push(`${t.id} 价格≠注数×单价`)
  }
  return { ok: problems.length === 0, problems }
}
