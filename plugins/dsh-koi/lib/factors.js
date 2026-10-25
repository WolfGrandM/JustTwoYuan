/**
 * dsh-koi 内置基础因子集（第二波 docs/19 §5.6，docs/12 FR-040 九类中取六，全部零依赖）。
 *
 * 因子 = 纯函数对象（W2-D04）：predict(升序历史切片) → { claim, judge(下一期) } | null。
 * 引擎（lib/backtest.js）保证防前视——predict 只见截至 asOf 期（含）的切片。
 * 自适应参数（众数/滚动 μ±σ/热冷集）均只用切片内数据（预注册窗 W=100 / 30 / 20），确定性可复现。
 *
 * 六件（game 后缀实例化 ×3 彩种）：parity-ratio 奇偶比 / sum-band 和值区间 / mod3-road 012 路 /
 * consecutive 连号 / hot-cold 冷热号 / omission 遗漏值。
 * 移交（第三波，接口即插即用）：AC 值、斜跳号、蓝球周期（§5.6）。
 * p3 口径（docs §5.6 注）：判据按位解释——奇偶=各位奇数个数；和值=三位和；012 路=各位 mod3；
 * 连号=相邻位数字差 1（体位相邻）；冷热/遗漏=位数字合并频次池（0–9）。
 */
import { GAMES } from './draws.js'

/** 一期的号码序列（ssq=红球 6 / dlt=前区 5 / p3=三位数字） */
export function numsOf(game, e) {
  if (game === 'ssq') return e.red ?? []
  if (game === 'dlt') return e.front ?? []
  return e.digits ?? []
}
const sumOf = (game, e) => numsOf(game, e).reduce((a, b) => a + Number(b), 0)
const oddCountOf = (game, e) => numsOf(game, e).filter((x) => x % 2 === 1).length
const mod3ZeroCountOf = (game, e) => numsOf(game, e).filter((x) => x % 3 === 0).length

/** 众数（出现次数最多；并列取较小值——确定性） */
function modeOf(values) {
  const freq = new Map()
  for (const v of values) freq.set(v, (freq.get(v) ?? 0) + 1)
  let best = null
  for (const [v, n] of freq) {
    if (best == null || n > freq.get(best) || (n === freq.get(best) && v < best)) best = v
  }
  return best
}

/** 连号判定：ssq/dlt = 排序后相邻差 1；p3 = 相邻位数字差 1 */
function hasConsecutive(game, e) {
  const nums = numsOf(game, e)
  if (game === 'p3') {
    for (let i = 0; i + 1 < nums.length; i++) if (Math.abs(Number(nums[i + 1]) - Number(nums[i])) === 1) return true
    return false
  }
  const s = [...nums].sort((a, b) => a - b)
  for (let i = 0; i + 1 < s.length; i++) if (s[i + 1] - s[i] === 1) return true
  return false
}

/** 号码空间（冷热/遗漏遍历域）：ssq 1–33 / dlt 1–35 / p3 按位 0–9（docs §5.6 注：位数字频次/遗漏） */
export function numberSpace(game) {
  if (game === 'ssq') return { min: 1, max: 33 }
  if (game === 'dlt') return { min: 1, max: 35 }
  return { min: 0, max: 9 }
}

/** 一期的冷热键：ssq/dlt = `*:<号>`；p3 = `<位>:<数字>`（位敏感——合并池会使 p3 冷热/遗漏恒退化） */
export function keysOfEntry(game, e) {
  if (game === 'p3') return (e.digits ?? []).map((d, p) => `${p}:${Number(d)}`)
  return numsOf(game, e).map((n) => `*:${Number(n)}`)
}

/** 全部候选键（冷号遍历域）：p3 = 3 位 × 0–9；其余 = 号码空间 */
function allKeys(game) {
  const { min, max } = numberSpace(game)
  const out = []
  if (game === 'p3') {
    for (let p = 0; p < 3; p++) for (let v = min; v <= max; v++) out.push(`${p}:${v}`)
  } else {
    for (let v = min; v <= max; v++) out.push(`*:${v}`)
  }
  return out
}

/** 近 window 期出现 ≥ k 次的键集合（热号；p3 按位） */
export function hotSet(historyAsc, window, k, game) {
  const tail = historyAsc.slice(-window)
  const freq = new Map()
  for (const e of tail) for (const key of keysOfEntry(game, e)) freq.set(key, (freq.get(key) ?? 0) + 1)
  const hot = new Set()
  for (const [key, c] of freq) if (c >= k) hot.add(key)
  return hot
}

/** 连续 ≥ n 期未开出的键集合（冷号；遗漏 = 距最近一次出现的期数 ≥ n；p3 按位） */
export function coldSet(historyAsc, n, game) {
  const tail = historyAsc.slice(-n)   // 只看最近 n 期：不出现在其中 = 遗漏 ≥ n
  const seen = new Set()
  for (const e of tail) for (const key of keysOfEntry(game, e)) seen.add(key)
  const cold = new Set()
  for (const key of allKeys(game)) if (!seen.has(key)) cold.add(key)
  return cold
}

function mk({ id, game, name, predict }) {
  return { id, source: 'builtin', game, name, predict }
}

/** 内置六件 × 三彩种（docs/19 §5.6 表） */
export function buildBuiltinFactors() {
  const out = []
  for (const game of ['ssq', 'dlt', 'p3']) {
    const g = GAMES[game]
    const tail = (h, w) => h.slice(-w)

    // 1. 奇偶比：下一期奇数个数 = 近 100 期众数
    out.push(mk({
      id: `builtin-parity-ratio-${game}`, game, name: `${g.name}·奇偶比（众数）`,
      predict(h) {
        const m = modeOf(tail(h, 100).map((e) => oddCountOf(game, e)))
        if (m == null) return null
        return {
          claim: `下一期${g.name}奇数个数 = ${m}（近 100 期众数）`,
          judge(next) { const n = oddCountOf(game, next); return { hit: n === m, detail: `奇数个数=${n}` } },
        }
      },
    }))

    // 2. 和值区间：下一期和值 ∈ [μ-σ, μ+σ]（截至 t 的滚动 100 期，预注册窗）
    out.push(mk({
      id: `builtin-sum-band-${game}`, game, name: `${g.name}·和值区间（μ±σ）`,
      predict(h) {
        const sums = tail(h, 100).map((e) => sumOf(game, e))
        if (!sums.length) return null
        const mu = sums.reduce((a, b) => a + b, 0) / sums.length
        const sigma = Math.sqrt(sums.reduce((a, b) => a + (b - mu) ** 2, 0) / sums.length)
        const lo = Math.round(mu - sigma)
        const hi = Math.round(mu + sigma)
        return {
          claim: `下一期${g.name}和值将落在 ${lo}–${hi}（滚动 μ±σ，预注册窗 100 期）`,
          judge(next) { const s = sumOf(game, next); return { hit: s >= lo && s <= hi, detail: `和值=${s}` } },
        }
      },
    }))

    // 3. 012 路：下一期 0 路（mod3=0）个数 = 近 100 期众数
    out.push(mk({
      id: `builtin-mod3-road-${game}`, game, name: `${g.name}·012 路（0 路众数）`,
      predict(h) {
        const m = modeOf(tail(h, 100).map((e) => mod3ZeroCountOf(game, e)))
        if (m == null) return null
        return {
          claim: `下一期${g.name} 0 路号（mod3=0）个数 = ${m}（近 100 期众数）`,
          judge(next) { const n = mod3ZeroCountOf(game, next); return { hit: n === m, detail: `0 路个数=${n}` } },
        }
      },
    }))

    // 4. 连号：下一期含 ≥1 对连号
    out.push(mk({
      id: `builtin-consecutive-${game}`, game, name: `${g.name}·连号（≥1 对）`,
      predict() {
        return {
          claim: `下一期${g.name}含至少 1 对连号`,
          judge(next) { const ok = hasConsecutive(game, next); return { hit: ok, detail: ok ? '含连号' : '无连号' } },
        }
      },
    }))

    // 5. 冷热号：近 30 期出现 ≥3 次的号中至少 2 个再出现（热集空 → 本期无观点；p3 按位）
    out.push(mk({
      id: `builtin-hot-cold-${game}`, game, name: `${g.name}·冷热号（热号≥2 回现）`,
      predict(h) {
        const hot = hotSet(h, 30, 3, game)
        if (!hot.size) return null
        return {
          claim: `近 30 期出现 ≥3 次的 ${hot.size} 个热号中至少 2 个再出现${game === 'p3' ? '（位数字频次）' : ''}`,
          judge(next) { const c = keysOfEntry(game, next).filter((key) => hot.has(key)).length; return { hit: c >= 2, detail: `热号回现=${c}` } },
        }
      },
    }))

    // 6. 遗漏值：遗漏 ≥20 期的号中至少 1 个回补（冷集空 → 本期无观点；p3 按位）。
    //    冷集窗取「形成期之前 20 期」（不含形成期）：判据对形成期/下一期均为带外判定——
    //    若窗含形成期，形成期自身号码必然不在冷集（刚开出），基线结构性恒 0（随机数据会被
    //    误判显著），滞后一期的预注册窗让判据滞后自评基线良定义（docs/19 §5.2 精神，登记 W2B）。
    out.push(mk({
      id: `builtin-omission-${game}`, game, name: `${g.name}·遗漏回补（≥20 期冷号）`,
      predict(h) {
        const before = h.length >= 1 ? h.slice(0, -1) : h   // 形成期之前的 20 期
        const cold = coldSet(before, 20, game)
        if (!cold.size) return null
        return {
          claim: `遗漏 ≥20 期的 ${cold.size} 个冷号中至少 1 个回补出现${game === 'p3' ? '（位数字遗漏）' : ''}`,
          judge(next) { const c = keysOfEntry(game, next).filter((key) => cold.has(key)); return { hit: c.length >= 1, detail: `冷号回补=${c.length}` } },
        }
      },
    }))
  }
  return out
}
