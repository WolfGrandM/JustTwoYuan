/**
 * dsh-koi 成本与用量层（市场版 FR-1008/FR-1009/BC-107/BC-113，D-007）——
 * 力度杠杆表、koi 侧轻量 token 计量（koi/token-usage.json，chars/4 保守估算 + est 恒标）、
 * 周度降档链（BC-013 市场版链）、costEstimate 双显示（MB-22：当前形态实际 / M3 满配投影）。
 *
 * M3-T1 增量（FR-045 计量路径 A / docs/33 §2.5 usage.js 行，全部加法）：
 *   · record 第三参 extra（role/model/est/分项 token/callRef）——条目结构扩展，旧条目缺字段容忍；
 *   · weekTotals 增 deliberation 桶（博弈编排新桶，docs/28 §9-R9 先例）；
 *   · weekByRole()（role 字段聚合——FR-046 角色分项记账面）；
 *   · reviseLast()（turn 收口对账改标：cancelled turn 的 path-a 条目改 est:true 重估）。
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
    /**
     * 记一笔用量（activity ∈ predict/learning/advisory/review/deliberation——deliberation 为 M3
     * 博弈编排新桶，docs/33 §5.1：多角色编排路径的全部调用进 deliberation，使 FR-046
     * 「博弈类内按角色权重分项」有明确桶）。
     * M3-T1 第三参加法（FR-045/docs/33 §2.5 usage.js 行）：extra = { role?, model?, est?,
     * promptTokens?, completionTokens?, cacheReadTokens?, cacheWriteTokens?, callRef? }——
     * 条目结构扩展，旧条目缺字段容忍（DC-009 精神）。未传 extra 的调用面（现状 predict/
     * learning/advisory/review 单 agent）est 恒标现状口径逐位不变。
     */
    record(activity, tokens, extra = {}) {
      const s = ensureWeek(load())
      const e = { at: now().toISOString(), activity, tokens: Math.max(0, Math.round(tokens)), est: true }
      if (extra && typeof extra === 'object') {
        if (extra.role != null) e.role = String(extra.role)
        if (extra.model != null) e.model = String(extra.model)
        if (extra.est != null) e.est = Boolean(extra.est)
        if (extra.callRef != null) e.callRef = String(extra.callRef)
        for (const f of ['promptTokens', 'completionTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
          if (extra[f] != null) e[f] = Math.max(0, Math.round(Number(extra[f])))
        }
      }
      s.entries.push(e)
      writeJsonAtomic(FILE, s)
      return s
    },
    /** 本周用量 {total, predict, learning, advisory, review, deliberation, week}（deliberation 桶 M3-T1 加法，docs/28 §9-R9 先例） */
    weekTotals() {
      const s = ensureWeek(load())
      writeJsonAtomic(FILE, s)   // 周切换时的归档落盘
      const t = { total: 0, predict: 0, learning: 0, advisory: 0, review: 0, deliberation: 0, week: s.week }
      for (const e of s.entries ?? []) {
        t.total += Number(e.tokens ?? 0)
        if (t[e.activity] != null) t[e.activity] += Number(e.tokens ?? 0)
      }
      return t
    },
    /**
     * 本周按角色分账（M3-T1 weekByRole，FR-046「博弈类内按角色权重分项」的记账面）：
     * role 字段聚合——无 role 条目（现状单 agent 调用）不进 byRole，如实不入账。
     * 返回 { week, total, byRole: { <role>: { tokens, steps, estSteps } } }。
     */
    weekByRole() {
      const s = ensureWeek(load())
      const out = { week: s.week, total: 0, byRole: {} }
      for (const e of s.entries ?? []) {
        out.total += Number(e.tokens ?? 0)
        if (e.role == null) continue
        const b = out.byRole[e.role] ?? (out.byRole[e.role] = { tokens: 0, steps: 0, estSteps: 0 })
        b.tokens += Number(e.tokens ?? 0)
        b.steps += 1
        if (e.est) b.estSteps += 1
      }
      return out
    },
    /**
     * 改标最近一条 callRef 匹配条目（M3-T1 turn 收口对账，docs/33 §5.1：deriveTurnTokenUsage
     * 返回 undefined（attempt 缺 usage/cancelled mid-stream）→ 已记 path-a 条目改标 est:true
     * 并按定额重估——BC-013③ 路径 B 兜底覆盖率统计面）。token-usage.json 单写者（koi 独占）
     * 域内操作，周内条目改标不影响归档（BC-009 三 JSON append-only 红线不涉本文件）。
     * 未匹配 → null（宁缺毋假，不虚构改标）。
     */
    reviseLast({ callRef, est, promptTokens, completionTokens } = {}) {
      if (callRef == null) return null
      const s = ensureWeek(load())
      for (let i = (s.entries?.length ?? 0) - 1; i >= 0; i--) {
        const e = s.entries[i]
        if (e.callRef == null || String(e.callRef) !== String(callRef)) continue
        if (est != null) e.est = Boolean(est)
        if (promptTokens != null) e.promptTokens = Math.max(0, Math.round(Number(promptTokens)))
        if (completionTokens != null) e.completionTokens = Math.max(0, Math.round(Number(completionTokens)))
        if (e.promptTokens != null || e.completionTokens != null) {
          e.tokens = Number(e.promptTokens ?? 0) + Number(e.completionTokens ?? 0)
        }
        writeJsonAtomic(FILE, s)
        return e
      }
      return null
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
const M3_MULTIPLIER_BASE = 3    // （M3-T4 前口径）数据官/质询者/主持人各 1 次基线调用（MD-16）
const M3_INTERVIEW_ROUND = 1    // （M3-T4 起口径）互评/质询轮权重——逐角色权重 + 互评轮取代「2×策略师和 + 3」

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
  // M3-T4：m3Projection 对齐 roleWeights 新结构（{dataOfficer, strategist:[…], provoker, chair}——
  // 拍板 P15 草案 1.0/[1.0,1.0]/0.8/1.5；旧结构 {strategist:[…]} 兼容——缺省角色按草案默认值）。
  // 只作成本投影权重（§5.3：记账可解释，不产生预算闸门差异）；MD-16 口径更新=逐角色权重 + 互评轮 1。
  const rwRaw = cfg?.budget?.roleWeights ?? {}
  const sWeights = Array.isArray(rwRaw.strategist) && rwRaw.strategist.length
    ? rwRaw.strategist.map(Number).filter((w) => w > 0)
    : [1.0]
  const rNum = (v, dflt) => (Number(v) > 0 ? Number(v) : dflt)
  const m3Factor = rNum(rwRaw.dataOfficer, 1.0)
    + sWeights.reduce((a, b) => a + b, 0)
    + rNum(rwRaw.provoker, 0.8)
    + rNum(rwRaw.chair, 1.5)
    + M3_INTERVIEW_ROUND   // 互评/质询轮（MD-16；现状「2×策略师和 + 3 基线角色」口径随 M3 编排器落地改逐角色权重）
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
      note: 'M3 满配投影（逐角色权重加权：数据官+策略师×N+质询者+主持人 + 互评轮——roleWeights 新结构对齐，随阵容/权重变化，随 M3 编排器生效）',
      factor: Number(m3Factor.toFixed(2)),
      weeklyPredict: Math.round(weekly.predict * m3Factor),
    },
  }
}
