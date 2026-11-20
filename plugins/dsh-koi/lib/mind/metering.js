/**
 * dsh-koi M3 计量路径 A（FR-045 / docs/33 §5.1，Spike 记录 docs/decisions/M3-双spike探测记录.md
 * §3 定论原样落纸；T1 主交付面）。
 *
 * 主路径 = A（真实 usage 直采）：
 *   ① 每 step 记账主采 = 会话日志 assistant/message 事件内嵌真实 TokenUsage（互斥口径
 *      uncachedInputTokens/outputTokens/cacheReadTokens/cacheWriteTokens，Spike §1.2——
 *      DeepSeek adapter 映射 dsh-llm-deepseek/lib/index.js:1821-1834；reasoningTokens 不可假设可得）；
 *      实时通道 = `agent/assistant-stream` 终帧（H1，Spike §1.3-7）；
 *   ② 事后/对账通道 = turn 收口 deriveTurnTokenUsage（H2，Spike §1.3-4——严格语义
 *      undefined = 降级触发点，宁缺毋假）；
 *   ③ 路径 B 兜底：三通道 feature-detect 全败 / turn usage 缺失（adapter 未报或 cancelled
 *      mid-stream）→ 该次调用按模型×activity 定额估算记账并 est:true（prompt 侧 chars/4
 *      usage.js estTokens 现状口径起步 + 输出定额表；FR-047 首月与账单对账校准）。
 *   ④ ctx.tokenMeter 仅预算闸门（H3，Spike §1.3-5——measure 返回 provider usage 与启发式
 *      混合，只做超限预判，不做记账来源，维持 DC-011 唯一来源=接口实测口径）；
 *      feature-detect 失败 → gate() 恒 null，闸门静默跳过，记账不受影响。
 *
 * 依赖方向（docs/33 §2.3）：本模块仅 import usage.js（estTokens）；宿主 ctx 仅经构造注入，
 * 模块自身零宿主 import；监听器全部 try/catch 兜底——计量尽力而为，永不抛出破坏宿主流。
 *
 * BC-001 诚实条款：计量数字只如实记录与披露（mode/channels 落 status 附加字段诚实披露口径），
 * 不修饰、不因计量失败虚构数据（est:true 如实标注估算条目）。
 * BC-008：本模块零因子状态写路径（不 import applyFactorTransition）。
 */
import { estTokens } from '../usage.js'

/** koi 出号会话 id 前缀（docs/33 §2.6 会话规范 koi-daily-<game>-<issue>[]-<role>；流帧 scope 过滤用——
 *  只对 koi 出号/编排会话消费直采帧，koi-lottery 闲聊与宿主其他会话不受影响） */
export const KOI_SESSION_PREFIX = 'koi-daily-'

/**
 * 路径 B 输出定额表（BC-013③：直采缺失 → 按模型×activity 定额估算记账 est:true）。
 * 起步口径：prompt 侧 chars/4（usage.js estTokens 现状口径）+ 输出按 activity 桶定额；
 * byModel 为模型覆盖层（未列模型走 byActivity/default）——FR-047 首月与账单对账后回填，
 * 诚实起步不拍脑袋（数值=docs/12 §5.10 各活动典型输出字数折算的一半保守值）。
 */
export const PATH_B_QUOTA = {
  defaultOut: 800,
  byActivity: { predict: 800, deliberation: 600, learning: 800, advisory: 200, review: 500 },
  byModel: {},   // FR-047 首月实测回填位（诚实起步留空）
}

/** 查定额：模型覆盖 > activity 桶 > 默认；返回 { out, basis } 供条目与测试断言口径来源 */
export function pathBQuota({ model = null, activity = 'deliberation' } = {}) {
  const m = PATH_B_QUOTA.byModel[String(model ?? '')]
  if (m != null && Number(m) > 0) return { out: Math.round(Number(m)), basis: 'model' }
  const a = PATH_B_QUOTA.byActivity[String(activity ?? '')]
  return { out: a != null && Number(a) > 0 ? Math.round(Number(a)) : PATH_B_QUOTA.defaultOut, basis: a != null ? 'activity' : 'default' }
}

/**
 * TokenUsage 互斥口径归一（Spike §1.5）：uncachedInputTokens/outputTokens/cacheReadTokens/
 * cacheWriteTokens 四桶 → { model, promptTokens(=uncached input + cache 分项之和，Spike §3-4
 * 建议口径防歧义), completionTokens, cacheReadTokens, cacheWriteTokens }。
 * 无效/全零 → null（宁缺毋假——不虚构记账）。兼容常见别名键（adapter 差异容忍）。
 */
export function normalizeTokenUsage(u) {
  if (!u || typeof u !== 'object') return null
  const num = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : null)
  const uncached = num(u.uncachedInputTokens ?? u.inputTokens ?? u.promptTokens)
  const out = num(u.outputTokens ?? u.completionTokens)
  const cr = num(u.cacheReadTokens ?? 0) ?? 0
  const cw = num(u.cacheWriteTokens ?? 0) ?? 0
  if (uncached == null || out == null) return null
  if (uncached + out + cr + cw <= 0) return null
  return {
    model: u.model != null ? String(u.model) : null,
    promptTokens: uncached + cr + cw,
    completionTokens: out,
    cacheReadTokens: cr,
    cacheWriteTokens: cw,
  }
}

/**
 * 计量引擎（T1）：feature-detect 三通道（H1 流终帧 / H2 turn 收口 / H3 tokenMeter）按优先级
 * 组合，逐 step 落 usage 条目（role/callRef/分项字段），gate() 预算闸门，modeOf() 诚实披露口径。
 * @param {object} p
 * @param {object} [p.ctx] 宿主 ctx（可选注入——测试传 null 即全路径 B；真宿主经 scheduler 注入）
 * @param {object} [p.usage] usage tracker（createUsageTracker 实例——record/reviseLast/weekByRole 消费面）
 * @param {() => Date} [p.now] 注入时钟（测试可控）
 * @param {(...a: any[]) => void} [p.log] 日志（探测结论如实落 log——T1 验收项）
 * @param {Function} [p.deriveTurn] H2 turn 收口通道注入（真宿主=deriveTurnTokenUsage(events)；
 *        缺省 null = 通道不可达 → 走流通道或路径 B。插件侧经 session 存储读取路径的实装验证
 *        属部署冒烟批（docs/33 §7 范围注记③），本批以注入面承接测试矩阵）
 */
export function createMetering({ ctx = null, usage = null, now = () => new Date(), log = () => {}, deriveTurn = null } = {}) {
  const channels = { stream: false, turnReplay: false, tokenMeter: false }
  const streamUsageBySession = new Map()   // H1 直采缓冲（sessionId → usage，取走即清——一次 step 一帧）
  const steps = []                          // 本进程逐 step 内存镜像（落账走 usage.record，镜像供调试/测试）
  let pathBCount = 0                        // 路径 B 兜底覆盖率计数器（FR-047 首月统计输入）

  /** 计量口径：流通道或 turn 收口任一可达 = path-a；全败 = path-b（est 兜底） */
  function modeOf() {
    return (channels.stream || channels.turnReplay) ? 'path-a' : 'path-b'
  }

  /**
   * 构造期 feature-detect（H1/H2/H3，docs/33 §2.4 一次性验证清单）：
   *   H1 `ctx.on('agent/assistant-stream', …)` 终帧取 usage——try/catch 注册 + scope 过滤到
   *      koi-daily- 前缀会话；注册失败如实 log → 启用通道②；
   *   H2 turn 收口 deriveTurnTokenUsage 探测（注入面在位 = 通道可达）；
   *   H3 ctx.tokenMeter.measure 探测——不可达 gate() 恒 null（闸门静默跳过）。
   * 探测结论如实落 log（T1 验收：诚实披露计量口径，BC-013 精神）。
   */
  function attachHostListeners() {
    try {
      if (ctx && typeof ctx.on === 'function') {
        ctx.on('agent/assistant-stream', (frame) => {
          try {
            const sid = String(frame?.session?.id ?? frame?.sessionId ?? frame?.sessionID ?? '')
            if (!sid.startsWith(KOI_SESSION_PREFIX)) return   // scope 过滤：只消费 koi 出号/编排会话
            const n = normalizeTokenUsage(frame?.message?.usage ?? frame?.usage ?? null)
            if (n) streamUsageBySession.set(sid, { ...n, at: now().toISOString() })
          } catch { /* 计量尽力而为：监听器永不抛出破坏宿主流 */ }
        })
        channels.stream = true
      }
    } catch (e) {
      log(`[koi] M3 计量 H1 agent/assistant-stream 注册失败（降级 turn 收口/路径 B）：${String(e?.message ?? e).slice(0, 120)}`)
    }
    if (typeof deriveTurn === 'function') channels.turnReplay = true
    if (ctx?.tokenMeter && typeof ctx.tokenMeter.measure === 'function') channels.tokenMeter = true
    log(`[koi] M3 计量探测：stream=${channels.stream} turnReplay=${channels.turnReplay} tokenMeter=${channels.tokenMeter} → mode=${modeOf()}` +
      (modeOf() === 'path-b' ? '（三通道全败=路径 B est 定额兜底，FR-047 首月对账校准）' : '（路径 A 直采；单通道失败逐 step 自动降 est 兜底）'))
    return { channels: { ...channels }, mode: modeOf() }
  }

  /** 从流通道缓冲取该会话最近一次直采 usage（取走即清；已是归一化形状——set 时经
   *  normalizeTokenUsage，无帧/无效帧 → null，recordStep 自动走路径 B） */
  function consumeStreamUsage(sessionId) {
    const u = streamUsageBySession.get(String(sessionId ?? '')) ?? null
    if (u) streamUsageBySession.delete(String(sessionId))
    return u
  }

  /**
   * 逐 step 落账（每角色每次 LLM 调用一笔；docs/33 §5.1 落账条目结构）：
   *   path-a（stepUsage 直采在位或流通道帧命中）→ 互斥口径分账（promptTokens=三者和/
   *   completionTokens/cache 分项原样），est:false；
   *   path-b（直采缺失）→ prompt chars/4 + activity/model 输出定额，est:true，覆盖率 +1。
   * 返回 { mode, est, promptTokens, completionTokens, tokens } 供调用方与测试断言。
   * 注意：流缓冲存的已是归一化形状（set 时 normalize），此处直接消费不再二次归一
   * （防 promptTokens 和值被当 uncached 重复加 cache 分项——双计 bug 面）。
   */
  function recordStep({ activity = 'deliberation', role = null, callRef = null, usage: stepUsage = null, sessionId = null, promptText = '', model = null } = {}) {
    const direct = stepUsage != null
      ? normalizeTokenUsage(stepUsage)
      : (sessionId != null ? consumeStreamUsage(sessionId) : null)
    const at = now().toISOString()
    if (direct) {
      const tokens = direct.promptTokens + direct.completionTokens
      try {
        usage?.record?.(activity, tokens, {
          role, callRef, model: direct.model ?? model, est: false,
          promptTokens: direct.promptTokens, completionTokens: direct.completionTokens,
          cacheReadTokens: direct.cacheReadTokens, cacheWriteTokens: direct.cacheWriteTokens,
        })
      } catch (e) { log(`[koi] M3 计量落账异常（step 继续）：${String(e?.message ?? e).slice(0, 120)}`) }
      steps.push({ at, activity, role, callRef, mode: 'path-a', est: false, tokens })
      return { mode: 'path-a', est: false, promptTokens: direct.promptTokens, completionTokens: direct.completionTokens, tokens }
    }
    // 路径 B 兜底（BC-013③）：定额估算记账 est:true（诚实标注估算条目）
    const promptTokens = estTokens(promptText)
    const q = pathBQuota({ model, activity })
    const tokens = promptTokens + q.out
    try {
      usage?.record?.(activity, tokens, { role, callRef, model, est: true, promptTokens, completionTokens: q.out })
    } catch (e) { log(`[koi] M3 计量落账异常（step 继续）：${String(e?.message ?? e).slice(0, 120)}`) }
    pathBCount += 1
    steps.push({ at, activity, role, callRef, mode: 'path-b', est: true, tokens })
    return { mode: 'path-b', est: true, promptTokens, completionTokens: q.out, tokens }
  }

  /**
   * turn 收口对账（H2 可达时每角色 turn 结束调用，docs/33 §5.1）：
   *   deriveTurn(events) 返回 usage → path-a step 记账为准（对账通过）；
   *   返回 undefined（attempt 缺 usage/cancelled mid-stream）→ 已记条目改标 est:true 并按
   *   定额重估（usage.reviseLast），路径 B 兜底覆盖率计数器 +1（FR-047 统计输入）。
   * H2 通道不可达 → { ok:false, reason:'turn-replay-unavailable' }（调用方如实跳过）。
   */
  function reconcileTurn({ callRef, events = null, promptText = '', activity = 'deliberation', role = null } = {}) {
    if (typeof deriveTurn !== 'function') return { ok: false, reason: 'turn-replay-unavailable' }
    let tu = null
    try { tu = deriveTurn(events) } catch (e) { tu = undefined }
    if (tu != null) {
      const n = normalizeTokenUsage(tu)
      if (n) return { ok: true, mode: 'path-a', usage: n }
    }
    const q = pathBQuota({ activity })
    const revised = (() => {
      try { return usage?.reviseLast?.({ callRef, est: true, completionTokens: q.out }) ?? null } catch { return null }
    })()
    if (revised) {
      pathBCount += 1
      log(`[koi] M3 计量 turn 收口缺失（${role ?? '-'} ${callRef ?? '-'}）：已记条目改标 est 重估（路径 B 兜底覆盖）`)
    }
    return { ok: true, mode: 'path-b', revised: revised != null }
  }

  /**
   * tokenMeter 预算闸门（H3，只预判不记账——docs/33 §5.4）：measure(session) 混合测量值透传；
   * feature-detect 失败 / measure 抛错 → null（闸门静默跳过，25 分钟链 + 周预算兜底仍全在）。
   */
  function gate(session) {
    try {
      const m = ctx?.tokenMeter
      if (!m || typeof m.measure !== 'function') return null
      return m.measure(session)
    } catch (e) {
      log(`[koi] M3 tokenMeter 闸门异常（跳过不阻塞）：${String(e?.message ?? e).slice(0, 120)}`)
      return null
    }
  }

  /** 本周按角色分账（委托 usage.weekByRole——FR-046 记账面；usage 缺席返回空壳不抛错） */
  function weekByRole() {
    try { return usage?.weekByRole?.() ?? { week: null, total: 0, byRole: {} } } catch { return { week: null, total: 0, byRole: {} } }
  }

  return {
    attachHostListeners,
    consumeStreamUsage,
    recordStep,
    reconcileTurn,
    gate,
    modeOf,
    channelsOf: () => ({ ...channels }),
    weekByRole,
    stepsOf: () => steps.slice(),
    pathBSteps: () => pathBCount,
  }
}
