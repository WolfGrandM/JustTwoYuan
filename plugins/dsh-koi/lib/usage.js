/**
 * dsh-koi 成本与用量层（市场版 FR-1008/FR-1009/BC-107/BC-113，D-007）——
 * 力度杠杆表、koi 侧轻量 token 计量（koi/token-usage.json，chars/4 保守估算 + est 恒标）、
 * 周度降档链（BC-013 市场版链）、costEstimate 双显示（MB-22：当前形态实际 / M3 满配投影）。
 *
 * 全部纯函数 + 一个可注入 now 的 tracker（自然周 ISO 周一归档重置，MD-22 保留近 4 周）。
 */
import path from 'node:path'
import { readJson, writeJsonAtomic } from './io.js'
import { GAMES, GAME_ORDER } from './draws.js'

// ── 力度杠杆表（§2.2.7-6，PM 复核意见1 重构后口径；四档三元组两两互异，MB-21 实测 dup=0）──
// follow-host = 纯 v1 现状（tail 用 config.historyTail 默认 10，MC-10）；
// reasoningEffort 参数直传为第四维叠加增强（宿主通道 D 阶段 spike，失败不损互异性，R2）。
export const EFFORT_LEVERS = {
  'follow-host': { tail: null, min: 300, max: 600, selfCheck: false },   // tail=null → 用 config.historyTail（v1 宿主默认语义）
  'economy': { tail: 6, min: 150, max: 300, selfCheck: false },
  'standard': { tail: 12, min: 300, max: 600, selfCheck: false },
  'turbo': { tail: 14, min: 400, max: 800, selfCheck: true },
}
export const EFFORT_ORDER = ['turbo', 'standard', 'economy', 'follow-host']

/** 当前配置的生效杠杆（MC-10：effort ≠ follow-host 以杠杆表值为准；follow-host 用 config.historyTail） */
export function leversFor(cfg) {
  const tier = EFFORT_ORDER.includes(cfg?.effort?.tier) ? cfg.effort.tier : 'follow-host'
  const base = EFFORT_LEVERS[tier]
  const tail = tier === 'follow-host' ? Math.max(1, Number(cfg?.historyTail ?? 10)) : base.tail
  return { tier, tail, min: base.min, max: base.max, selfCheck: base.selfCheck }
}

/** 力度杠杆是否可观测生效（三维杠杆结构性恒在——本设计下恒 true；配置页如实显示用） */
export function leverActive(cfg) {
  return true   // 杠杆表 tail/字数/自检三维结构性注入，任意模型可观测（MB-21：互异由取值保证）
}

/** chars/4 保守估算（docs/11 §4.4 先例，est 恒标） */
export const estTokens = (text) => Math.ceil(String(text ?? '').length / 4)

// ── 自然周（ISO 周一）──────────────────────────────────────────────────────────
export function weekKey(d = new Date()) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const dayNum = date.getUTCDay() || 7          // 周一=1 … 周日=7
  date.setUTCDate(date.getUTCDate() + 4 - dayNum) // 本周四（ISO 定义锚点）
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((date - yearStart) / 86_400_000 + 1) / 7)
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

/**
 * koi 侧轻量计量 tracker：koi/token-usage.json {schemaVersion:1, week, entries:[{at,activity,tokens,est:true}], archived}
 * 自然周切换自动归档重置（保留近 keepWeeks 周，MD-22）。
 */
export function createUsageTracker({ dataDir, now = () => new Date(), keepWeeks = 4 } = {}) {
  const FILE = path.join(dataDir ?? '.', 'token-usage.json')
  const load = () => readJson(FILE, { schemaVersion: 1, week: weekKey(now()), entries: [], archived: [] })
  const ensureWeek = (s) => {
    const wk = weekKey(now())
    if (s.week !== wk) {
      s.archived = [...(Array.isArray(s.archived) ? s.archived : []), { week: s.week, entries: s.entries ?? [] }].slice(-keepWeeks)
      s.week = wk
      s.entries = []
    }
    return s
  }
  return {
    fileOf: () => FILE,
    /** 记一笔估算用量（activity ∈ predict/learning/advisory）；周切换时归档重置 */
    record(activity, tokens) {
      const s = ensureWeek(load())
      s.entries.push({ at: now().toISOString(), activity, tokens: Math.max(0, Math.round(tokens)), est: true })
      writeJsonAtomic(FILE, s)
      return s
    },
    /** 本周用量 {total, predict, learning, advisory, week} */
    weekTotals() {
      const s = ensureWeek(load())
      writeJsonAtomic(FILE, s)   // 周切换时的归档落盘
      const t = { total: 0, predict: 0, learning: 0, advisory: 0, week: s.week }
      for (const e of s.entries ?? []) {
        t.total += Number(e.tokens ?? 0)
        if (t[e.activity] != null) t[e.activity] += Number(e.tokens ?? 0)
      }
      return t
    },
  }
}

/**
 * 周度降档链判定（BC-013 市场版链，MD-23）：
 *   ratio < warn1        → ok（原档）
 *   warn1 ≤ ratio < warn2 → warn1（70% 预警事件，effort 不动）
 *   warn2 ≤ ratio < 1     → warn2（90% 预警 + effort 降一档：turbo→standard→economy→follow-host）
 *   ratio ≥ 1            → cap（100% 触顶：follow-host + allowLLM=false 兜底档出号零 LLM + 学习/advisory 暂停）
 */
export function demotionFor({ used, cap, warn1 = 0.7, warn2 = 0.9, effortTier = 'follow-host' }) {
  const c = Number(cap) > 0 ? Number(cap) : 1
  const ratio = Number(used ?? 0) / c
  const configured = EFFORT_ORDER.includes(effortTier) ? effortTier : 'follow-host'
  const idx = EFFORT_ORDER.indexOf(configured)
  if (ratio >= 1) return { ratio, level: 'cap', effectiveEffort: 'follow-host', allowLLM: false, pauseAdvisory: true, pauseLearning: true }
  if (ratio >= warn2) return { ratio, level: 'warn2', effectiveEffort: EFFORT_ORDER[Math.min(idx + 1, EFFORT_ORDER.length - 1)], allowLLM: true, pauseAdvisory: false, pauseLearning: false }
  if (ratio >= warn1) return { ratio, level: 'warn1', effectiveEffort: configured, allowLLM: true, pauseAdvisory: false, pauseLearning: false }
  return { ratio, level: 'ok', effectiveEffort: configured, allowLLM: true, pauseAdvisory: false, pauseLearning: false }
}

// ── 成本估算（BC-107/MB-22 双显示；O(1) 查表 + 字符计数，§7.2）──────────────────
const EMPTY_PACK_CHARS = { ssq: 2200, dlt: 2600, p3: 800 }   // 空库估计（MD-17；§4.2「30 期×平均行宽估」）
const ADVISORY_IN_CHARS = 600   // 判据 JSON + 档表 + 预算余量的提示词规模估计
const ADVISORY_OUT_CHARS = 200
const M3_MULTIPLIER_BASE = 3    // 数据官/质询者/主持人各 1 次基线调用（MD-16）

function autoGames(cfg) {
  return GAME_ORDER.filter((k) => cfg?.modes?.[k]?.mode === 'auto')
}

/**
 * costEstimate(config)：服务端实时估算（status API 附加字段，FZ-6 加法）。
 * packChars: { game: 字符数 } 实测数据包长度（本地库 ≥10 期实测；缺省用空库估计，MD-17）。
 * 返回双显示：currentForm（市场单 agent 实际，不随阵容）+ m3Projection（随阵容/权重，标注随 M3 生效）。
 */
export function costEstimate(cfg, { packChars = {} } = {}) {
  const lever = leversFor(cfg)
  const perCall = {}
  const weekly = { predict: 0, advisory: 0 }
  for (const g of autoGames(cfg)) {
    const input = Math.ceil((Number(packChars[g]) > 0 ? Number(packChars[g]) : EMPTY_PACK_CHARS[g]) / 4)
    const output = Math.ceil(lever.max / 4)
    const days = GAMES[g].drawDays.length
    perCall[g] = { input, output, total: input + output }
    weekly.predict += days * perCall[g].total
  }
  if (cfg?.advisory?.enabled !== false && autoGames(cfg).length) {
    perCall.advisory = { input: Math.ceil(ADVISORY_IN_CHARS / 4), output: Math.ceil(ADVISORY_OUT_CHARS / 4) }
    for (const g of autoGames(cfg)) weekly.advisory += GAMES[g].drawDays.length * (perCall.advisory.input + perCall.advisory.output)
  }
  const weights = Array.isArray(cfg?.budget?.roleWeights?.strategist) && cfg.budget.roleWeights.strategist.length
    ? cfg.budget.roleWeights.strategist.map(Number).filter((w) => w > 0)
    : [1.0]
  const m3Factor = 2 * weights.reduce((a, b) => a + b, 0) + M3_MULTIPLIER_BASE   // MD-16：每策略师提案×权重 + 互评轮 + 三基线角色
  const weeklyCap = Number(cfg?.budget?.weeklyCap) > 0 ? Number(cfg.budget.weeklyCap) : 1_500_000
  const total = weekly.predict + weekly.advisory
  return {
    basis: '估算值（chars/4 保守口径，est 恒标；不宣称精确）',
    effortTier: lever.tier,
    perCall,
    weekly: {
      ...weekly,
      total,
      cap: weeklyCap,
      ratio: Number((total / weeklyCap).toFixed(4)),
    },
    currentForm: {
      note: '当前形态实际估算（单 agent：每开奖日一次出号调用 + 一次建议调用，不随阵容变化）',
      weeklyTotal: total,
    },
    m3Projection: {
      note: 'M3 满配投影（每策略师一次提案×权重 + 互评轮 + 数据官/质询者/主持人基线；随阵容/权重变化，随 M3 编排器生效）',
      factor: Number(m3Factor.toFixed(2)),
      weeklyPredict: Math.round(weekly.predict * m3Factor),
    },
  }
}
