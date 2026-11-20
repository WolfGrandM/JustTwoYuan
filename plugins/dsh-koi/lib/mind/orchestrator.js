/**
 * dsh-koi M3 编排器（FR-016/018/019/020 / docs/33 §2.2 orchestrator.js 行 + §3 降档链 + §3.3 两级降档关系）。
 *
 * 流水线：按 planTier/castTier 装配角色序列（agenda.lineupFor）→ 每角色每期独立会话顺序 prompt
 * （拍板 P15：koi-daily-<game>-<issue>-<id>）→ 角色产出文件契约（workDir/mind/<archiveKey>/<id>-<round>.json）
 * → 互评材料传递（读上一角色文件拼进下一角色 prompt）→ 主持人定稿（picks+message+summary+confidenceTier）
 * → 25 分钟切片计时与单角色剔除（FR-019：剔除继续、主持人不可剔除全败才降档）→ orchestration_log 全记录
 * （BC-002 append-only，落盘先于开奖核对）→ 定稿经注入的 validatePicks（FZ-2 硬校验单点复用，零重实现）
 * + hasProbabilityClaim 闸（BC-001③）→ 打回一次 → 仍不过 → 兜底语义上交 scheduler。
 *
 * 计量（T1 面）：每角色调用经 promptAgent 打标（activity='deliberation' 新桶 + role/callRef），
 * turn 收口 reconcileTurn（H2 可达时；缺失改标 est 兜底——FR-047 覆盖率统计输入）。
 *
 * 依赖方向（docs/33 §2.3 DAG）：agenda/injector/trimmer/metering（同层兄弟，单向）+ review/store.js
 * （orchestration_log 写面）+ fspoll.js（waitJsonFile）+ usage.js（estTokens）；判奖/校验/渲染经注入
 * 回调（validatePicks/probabilityClaim），零 draws.js/render.js import（FZ-1/FZ-7 结构锁定）。
 *
 * 两级降档关系（§3.3）：周级 effortTier/cap 由 scheduler budgetState 承担（cap 短路在分流点之前已
 * 兜底，本模块入口 resolveTier 二次判定保险）；会话级 25 分钟链在本模块内逐角色推进——两 stamp 各记
 * 其面（条目 effortTier=周级、castTier=会话级终态），中途只降不升。
 *
 * BC-001 诚实条款：主持人 message 经概率宣称闸；BC-008：本模块零因子状态写路径（不 import
 * 因子状态转移函数——monthly.js 与 veto CLI 唯一持有）；BC-012：编排全部 LLM 调用发生在 predictAt–17:55 出号窗口内（非重计算）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { waitJsonFile } from '../fspoll.js'
import { estTokens } from '../usage.js'
import { KOI_SESSION_PREFIX } from './metering.js'
import {
  castTierOf, planTierOf, lineupFor, nextTier, resolveTier, renderRolePrompt,
  versionOf, sliceBudgetOf, SESSION_BUDGET_MS, HARD_STOP_HHMM, BC001_LINE,
} from './agenda.js'

const POLL_MS = 3_000
const RETURN_TIMEOUT_MS = 60_000      // 打回重写上限（scheduler.js:342 现状 60s 同款）
const ORCH_MAX_DROPS = 3              // 降档重跑上限（full→standard→lite→编排放弃，single 让位现状路径）
const STRIPPED_TIMEOUT_TEXT = '（超时剔除——FR-019 单角色容错，剩余继续）'

/** 文件名安全 archiveKey（'<game>-<issue>'；log 关联键保持 '<game>|<issue>' 原样） */
const fsSafe = (s) => String(s ?? '').replace(/[^\w.-]+/g, '-')

export function createOrchestrator({
  promptAgent,
  validatePicks = null,          // (tier, picks) => { ok, picks?, error? }——FZ-2 硬校验单点注入（scheduler 侧 validateTierPicks 复用）
  probabilityClaim = null,       // (text) => bool——BC-001③ 概率宣称闸注入（render.js hasProbabilityClaim 单点）
  budgetState = null,            // (cfg) => { totals, demo }——cap 二次判定（§3.3 四级优先序①）
  reviewStore = null,            // orchestration_log/agenda_versions 写面（BC-002）
  metering = null,               // T1 计量面（recordStep 经 promptAgent 打标已走；reconcileTurn 收口在此）
  injector = null,               // T3 渐进装配（null = 注入段跳过，材料只有 dataPack——§7 渐进装配注记）
  trimmer = null,                // T3 渐进装配（null = 跳过裁剪）
  now = () => new Date(),
  hhmm = () => '17:30',          // 注入时刻读数（timeutil 单点由 scheduler 提供——mind 层零 timeutil import）
  workDir = '.',
  log = () => {},
  stopCheck = () => false,
  pollMs = POLL_MS,              // 测试可调小（真实 3s）
  sliceMsOverride = null,        // 测试注入：{ <role>: ms } 覆盖切片预算（AC-006 超时 fixture 用注入时钟/短切片实现，不调系统时间——§6.1 注记）
} = {}) {
  if (typeof promptAgent !== 'function') throw new Error('createOrchestrator 缺 promptAgent 注入')
  try { fs.mkdirSync(workDir, { recursive: true }) } catch { /* 目录在位即可 */ }

  /** 会话 id（拍板 P15：每角色每期独立会话 koi-daily-<game>-<issue>-<id>；§2.6 + metering KOI_SESSION_PREFIX 单点） */
  const sessionFor = (gameKey, issue, id) => `${KOI_SESSION_PREFIX}${gameKey}-${issue}-${id}`
  /** 单 Agent（single/fallback）出号会话（无 role 后缀——B-35 每期新开，scheduler sessionFor 同款规范） */
  const sessionForSingle = (gameKey, issue) => `${KOI_SESSION_PREFIX}${gameKey}-${issue}`

  /** 编排交卷契约段（agenda 保持零 import，规格文本由 scheduler 提供 specText） */
  function contractFor(step, { gameKey, issue, tierSpec, outPath }) {
    const head = [
      `用 shell 把结果写进这个文件（存在即可，内容必须是合法 JSON）：`,
      `  ${outPath}`,
    ]
    if (step.role === 'chair') {
      return [
        ...head,
        'JSON 结构（严格照抄字段名，顶层带 schemaVersion；picks 必须完全合规——系统硬校验，不合规打回重写）：',
        `  {"schemaVersion":1,"issue":"${issue}","picks":${tierSpec?.picksShape ?? '{按玩法规格给出号码}'},`,
        `   "message":"给主人的完整正文（不要写标题行和期号抬头，纯文本换行）",`,
        `   "summary":"≤100字一句话摘要（不得宣称任何中奖概率提升）",`,
        `   "confidenceTier":"low|mid|high（三档之一，禁止数值置信度）",`,
        `   "cites":["你引用的材料行编号，逐条列出"]}`,
      ].join('\n')
    }
    if (step.role === 'dataOfficer') {
      return [
        ...head,
        'JSON 结构：{"schemaVersion":1,"game":"' + gameKey + '","issue":"' + issue + '","snapshot":{"遗漏":{},"冷暖":{},"和值带":{},"分位行引用":[]},"note":"≤200字数据事实"}',
      ].join('\n')
    }
    if (step.role === 'provoker') {
      return [
        ...head,
        'JSON 结构：{"schemaVersion":1,"questions":[{"target":"strategist-N","q":"质询点","citeCheck":"引用行号在/不在材料内"}]}',
      ].join('\n')
    }
    return [
      ...head,
      `JSON 结构：{"schemaVersion":1,"game":"${gameKey}","issue":"${issue}","proposal":{"picks":${tierSpec?.picksShape ?? '{按玩法规格给出号码}'}},`,
      `"reason":"≤200字理由（引用材料行编号）","cites":["行编号"]}`,
    ].join('\n')
  }

  /**
   * 材料组装（§4.1 分层：数据层 dataPack 全文→数据官；数据官产出→策略师/主持人；
   * 策略师提案→主持人；质询轮/修订轮读轮次材料）。injector 注入块（T3）拼进数据官与主持人材料。
   */
  function materialsFor(step, produced, base) {
    const lines = []
    if (step.role === 'dataOfficer') {
      lines.push(`【第 1 层 · 数据层（官方开奖统计 + 探索性素材，引用行编号见内）】`, base.dataPack ?? '（本期 dataPack 为空）')
      if (base.tierSpec?.text) lines.push('', `【玩法规格】${base.tierSpec.text}`)
      if (base.injectionText) lines.push('', `【第 2 层 · 记忆层（因子战绩 + 近 30 期档案局势，探索性素材 · 无预测力声明）】`, base.injectionText)
    } else if (step.role === 'strategist') {
      const off = produced['dataOfficer-1']
      lines.push(`【数据官数据包】`, off ? JSON.stringify(off) : '（数据官被剔除/无产出——基于下方研究材料独立完成）')
      if (base.dataPack) lines.push('', `【研究材料（节选引用）】`, base.dataPack)
      if (base.injectionText) lines.push('', `【记忆层（探索性素材 · 无预测力声明）】`, base.injectionText)
      if (step.round >= 3) {   // full 档修订轮：补质询材料
        const pv = produced['provoker-2']
        lines.push('', `【质询者质询（请逐条回应后修订你的提案）】`, pv ? JSON.stringify(pv) : '（质询缺席——直接交修订稿）')
      }
    } else if (step.role === 'provoker') {
      const proposals = Object.entries(produced).filter(([k]) => k.startsWith('strategist-') && produced[k]?.round === 1)
      lines.push('【各策略师提案】', proposals.length ? JSON.stringify(proposals.map(([, v]) => v)) : '（无提案——如实声明无质询对象）')
    } else if (step.role === 'chair') {
      const off = produced['dataOfficer-1']
      const proposals = Object.entries(produced).filter(([k]) => k.startsWith('strategist-') && (produced[k]?.round === 1 || produced[k]?.round === 3))
      lines.push(`【数据官数据包】`, off ? JSON.stringify(off) : '（数据官无产出——如实声明）')
      lines.push('', `【各策略师提案】`, proposals.length ? JSON.stringify(proposals.map(([, v]) => v)) : '（无策略师提案——基于数据官数据包独立定稿，如实声明）')
      if (base.injectionText) lines.push('', `【记忆层（探索性素材 · 无预测力声明）】`, base.injectionText)
    }
    return lines.join('\n')
  }

  /** 降档重跑时复用已成功角色产出（produced 键 = `<id>-<round>`；lite 与 standard 的 round1 角色同键直接复用） */
  const reuseKey = (step) => `${step.id}-${step.round}`

  /** 落一行编排记录（BC-002：只插不改；失败尽力兜底不阻塞出号） */
  function logOrchestration({ archiveKey, step, content, agendaVersion, callRef }) {
    try {
      reviewStore?.recordOrchestration?.({ archiveKey, role: step.role, round: step.round, content, agendaVersion, callRef })
    } catch (e) { log(`[koi] 编排记录落盘失败（不阻塞出号）：${String(e?.message ?? e).slice(0, 120)}`) }
  }

  /**
   * 编排主入口。返回结构（docs/33 §2.5③：与现状 { picks, message, via, issue, summary } 超集兼容）：
   *   { via:'ai', picks, message, summary, confidenceTier, castTier, planTier, agendaVersion,
   *     roles, strippedRoles, injectionNote?, rounds }                        —— 定稿（picks 已过硬校验+概率闸）
   * | { via:'fallback', skip:{code,reason}, castTier:'fallback', planTier, agendaVersion, strippedRoles, rounds }
   *                                                                        —— 兜底语义（scheduler 侧随机号+标注）
   * | { via:'skip', skip:{code:'tier-exhausted',reason}, castTier, planTier, agendaVersion, ... }
   *                                                                        —— 链耗尽让位现状 single 路径
   */
  async function runPredict({ gameKey, issue, tier, history, cfg, dataPackText, tierSpec, late = false, effortTier = null } = {}) {
    const archiveKey = `${gameKey}|${issue}`
    const agendaVersion = versionOf(cfg)
    try { reviewStore?.registerAgendaVersion?.(agendaVersion, agendaVersion.split(':')[2] ?? null) } catch { /* 登记尽力而为 */ }

    const configured = castTierOf(cfg, gameKey)
    const planTier = planTierOf(cfg, gameKey, planInputsOf(cfg))
    const startedAt = now().getTime()

    // ── 入口一次性判定（§3.3 四级优先序：cap 短路 > 硬停线 > 切片超时降档 > 计划档）────────
    let allowLLM = true
    try { allowLLM = budgetState ? budgetState(cfg)?.demo?.allowLLM !== false : true } catch { allowLLM = true }
    const resolved = resolveTier({ castTier: configured, allowLLM, hhmmNow: hhmm(), hardStop: HARD_STOP_HHMM })
    if (resolved.action === 'skip-cap') {
      log(`[koi] ${archiveKey} 编排不起跑：${resolved.reason}`)
      return { via: 'skip', skip: { code: 'cap', reason: resolved.reason }, castTier: configured, planTier, agendaVersion, roles: [], strippedRoles: [], rounds: [] }
    }
    if (resolved.action === 'hard-stop') {
      log(`[koi] ${archiveKey} ${resolved.reason}`)
      return { via: 'fallback', skip: { code: 'hard-stop', reason: resolved.reason }, castTier: 'fallback', planTier, agendaVersion, roles: [], strippedRoles: [], rounds: [] }
    }

    // ── 有效预算（§3.1：min(25 分钟, 距 17:55 硬停线)；predictAt 晚于 17:30 的彩种硬停线仍 17:55）──
    const stopAt = deadlineOf(now())
    const leftMs = () => stopAt - now().getTime()

    // ── 注入段（≤1 分钟切片，零 LLM 本地计算；injector 缺位 → 跳过，材料只有 dataPack——§7 渐进装配）──
    let injectionText = null
    let injectionNote = null
    if (injector) {
      try {
        const inj = injector.assemble({ gameKey, issue })
        // trimmer cap 由装配侧读 cfg.budget.overrides.injectionCap（默认 4000——拍板 P3 与预算解耦）
        const blocks = trimmer ? trimmer.trimBlocks(inj.blocks ?? []) : { text: (inj.blocks ?? []).map((b) => b.text).join('\n'), dropped: [] }
        injectionText = blocks.text || null
        if (!inj.ok) injectionNote = inj.note ?? '本期无记忆注入：注入层返回失败（FR-031 如实标注）'
        if (blocks.dropped?.length) injectionNote = [injectionNote, `注入裁剪丢弃 ${blocks.dropped.length} 块（诚实标注）`].filter(Boolean).join('；')
      } catch (e) {
        injectionNote = `本期无记忆注入：${String(e?.message ?? e).slice(0, 120)}`   // FR-031：跳过继续出号
        log(`[koi] ${archiveKey} 注入失败（照常编排）：${injectionNote}`)
      }
    }

    let castTier = resolved.tier
    const strippedRoles = []
    const rounds = []
    const produced = {}   // `<id>-<round>` → { ...raw, round }

    // ── 降档重跑循环（中途只降不升；single 让位现状路径——不重实现 buildPredictPrompt）────────
    for (let drops = 0; drops < ORCH_MAX_DROPS; drops++) {
      const lineup = lineupFor(castTier, cfg)
      let chairFailed = false
      let chainBroken = false
      let chairKey = null   // 本档位 chair 产出键（standard/lite='chair-2'、full='chair-4'——round 随阵容）
      for (const step of lineup) {
        if (step.role === 'chair') chairKey = reuseKey(step)
        if (stopCheck()) chainBroken = true
        if (chainBroken) break
        if (produced[reuseKey(step)]) continue   // 降档复用已成功产出
        const left = leftMs()
        if (left <= 0) {
          log(`[koi] ${archiveKey} 有效预算耗尽（${HARD_STOP_HHMM} 硬停线/25 分钟链）——终止编排走兜底档`)
          chainBroken = true
          break
        }
        const timeoutMs = Math.min(sliceMsOverride?.[step.role] ?? step.sliceMs ?? sliceBudgetOf(step.role), left)
        const outPath = path.join(workDir, 'mind', fsSafe(archiveKey), `${step.id}-${step.round}.json`)
        try { fs.mkdirSync(path.dirname(outPath), { recursive: true }) } catch { /* 目录在位即可 */ }
        try { fs.rmSync(outPath, { force: true }) } catch {}
        const materials = materialsFor(step, produced, { dataPack: dataPackText, tierSpec, injectionText })
        const text = renderRolePrompt({
          role: step.role, round: step.round, gameKey, issue, materials, outPath, cfg,
          contract: contractFor(step, { gameKey, issue, tierSpec, outPath }),
          roleIndex: step.role === 'strategist' ? Number(step.id.split('-')[1] ?? 1) : null,
        })
        const callRef = `${archiveKey}#${step.id}-${step.round}`
        const at = now().toISOString()
        const sessionId = sessionFor(gameKey, issue, step.id)   // P15：每角色每期独立会话
        let raw = null
        try {
          // 计量打标（T1 面）：activity='deliberation' 新桶 + role/callRef + 独立会话——
          // 直采在位 path-a 分账、缺失 path-b est 兜底（recordStep 语义）
          await promptAgent(text, { activity: 'deliberation', role: step.role, callRef, sessionId })
          // 切片等待用真实时长（不注入恒定时钟——恒 now 会使 while(now()-t0<timeout) 死循环）；
          // 有效预算/硬停线判定走注入时钟（deadlineOf/leftMs——AC-006 fixture 不调系统时间）
          raw = await waitJsonFile(outPath, { timeoutMs, pollMs, stopCheck })
        } catch (e) {
          log(`[koi] ${archiveKey} ${step.id} 调用异常：${String(e?.message ?? e).slice(0, 120)}`)
        }
        // turn 收口对账（H2 可达时；cancelled/缺 usage → 改标 est 重估——FR-047 覆盖率统计）
        try { metering?.reconcileTurn?.({ callRef, events: null, promptText: text, role: step.role }) } catch { /* 计量尽力而为 */ }
        if (!raw || typeof raw !== 'object') {
          // 切片超时/无产出 → 剔除（FR-019：单角色容错，剩余继续）
          strippedRoles.push(step.id)
          rounds.push({ role: step.role, id: step.id, round: step.round, at, ref: callRef, outcome: 'stripped' })
          logOrchestration({ archiveKey, step, content: STRIPPED_TIMEOUT_TEXT, agendaVersion, callRef })
          log(`[koi] ${archiveKey} ${step.id} 切片超时/无产出 → 剔除继续（已剔除 ${strippedRoles.length} 角色）`)
          if (step.role === 'chair') { chairFailed = true }   // 主持人不可剔除 → 全败降档
          continue
        }
        produced[reuseKey(step)] = { ...raw, round: step.round }
        rounds.push({ role: step.role, id: step.id, round: step.round, at, ref: callRef, outcome: 'ok' })
        logOrchestration({ archiveKey, step, content: JSON.stringify(raw), agendaVersion, callRef })
        log(`[koi] ${archiveKey} ${step.id} 产出在位（${Math.round(timeoutMs / 1000)}s 切片内）`)
      }
      if (chainBroken) {
        // 硬停/停机/预算耗尽 → 兜底档（BC-005 照发+透明标注——scheduler 侧 randomTierPicks）
        return { via: 'fallback', skip: { code: 'session-budget', reason: `有效预算耗尽（25 分钟链/${HARD_STOP_HHMM} 硬停线）` }, castTier: 'fallback', planTier, agendaVersion, roles: rolesOf(produced), strippedRoles, injectionNote, rounds }
      }
      if (!chairFailed && chairKey && produced[chairKey] != null) {
        // ── 定稿校验段（FR-020：多 Agent 定稿仍走同一硬校验；BC-001③ 概率宣称闸；§3.2 校验切片 ≤2 分钟）──
        const v = await finalizeChair({ chair: produced[chairKey], chairKey, tier, gameKey, issue, cfg })
        if (v.ok) {
          const roles = rolesOf(produced)
          log(`[koi] ${archiveKey} 编排定稿（castTier=${castTier} agenda=${agendaVersion} roles=${roles.join('/')} stripped=${strippedRoles.length}）`)
          return {
            via: 'ai', picks: v.picks, message: v.message, summary: v.summary,
            confidenceTier: v.confidenceTier, castTier, planTier, agendaVersion,
            roles, strippedRoles, injectionNote, rounds,
          }
        }
        // 校验两次不过 → 兜底语义（AC-020：不合规号永不送达，档案如实记录打回——orchestration_log 已逐行在案）
        log(`[koi] ${archiveKey} 定稿两次不过闸（${v.error}）→ 兜底档`)
        return { via: 'fallback', skip: { code: 'chair-invalid', reason: `主持人定稿两次未过硬校验/概率闸：${v.error}` }, castTier: 'fallback', planTier, agendaVersion, roles: rolesOf(produced), strippedRoles, injectionNote, rounds }
      }
      // 全败降档（FR-019：主持人不可剔除，其位置由降档承担；中途只降不升）
      const nt = nextTier(castTier)
      if (!nt || nt === 'single') {
        log(`[koi] ${archiveKey} 降档到 single——编排让位现状单 Agent 路径（链耗尽）`)
        return { via: 'skip', skip: { code: 'tier-exhausted', reason: '编排链降档耗尽（主持人连续全败）——让位现状 single 路径' }, castTier: 'single', planTier, agendaVersion, roles: rolesOf(produced), strippedRoles, injectionNote, rounds }
      }
      log(`[koi] ${archiveKey} 全败降档：${castTier} → ${nt}（已成功角色产出复用）`)
      castTier = nt
    }
    return { via: 'skip', skip: { code: 'tier-exhausted', reason: '降档重跑上限到达' }, castTier: 'single', planTier, agendaVersion, roles: rolesOf(produced), strippedRoles, injectionNote, rounds }
  }

  /** planTierOf 拉前条件输入（周降档计数/周用量占比——scheduler 注入 budgetState 可算，缺省关闭拉前） */
  function planInputsOf(cfg) {
    try {
      const t = budgetState ? budgetState(cfg) : null
      const cap = Number(cfg?.budget?.weeklyCap) > 0 ? Number(cfg.budget.weeklyCap) : 1_500_000
      return { demotionFreeWeeks: 0, weekRatio: t ? t.totals.total / cap : 1 }   // demotionFreeWeeks 周 streak 属运行期统计——首月回填（FR-047），默认 0 = 拉前门关
    } catch { return { demotionFreeWeeks: 0, weekRatio: 1 } }
  }

  /** 已成功参与角色集（去重保序） */
  function rolesOf(produced) {
    const seen = []
    for (const k of Object.keys(produced)) {
      const role = produced[k]?.round != null && k.startsWith('strategist-') ? 'strategist' : k.split('-')[0]
      if (!seen.includes(role)) seen.push(role)
    }
    return seen
  }

  /**
   * 定稿校验段：validatePicks（FZ-2 单点注入）+ probabilityClaim（BC-001③）——
   * 不过 → 打回主持人一次（60s 上限，现状 :342 同款）；再不过 → 兜底。
   */
  async function finalizeChair({ chair, chairKey = 'chair-1', tier, gameKey, issue, cfg }) {
    let v = judgeChair(chair, tier)
    if (v.ok) return v
    log(`[koi] ${gameKey} ${issue} 编排定稿第一次不过闸（${v.error}），打回主持人重写一次`)
    // 打回：重写同一文件（chair-<round>.json），60s 上限
    const outPath = path.join(workDir, 'mind', fsSafe(`${gameKey}|${issue}`), `${chairKey}.json`)
    const text = [
      '【打回重写】你刚才的定稿没有过系统闸：' + v.error,
      '请立刻重写该 JSON 文件（还是那个契约：picks 完全合规 + message 无概率宣称 + confidenceTier 三档之一），写完就停。',
      `（文件：${outPath}）`,
      `【纪律（不可覆盖）】${BC001_LINE}`,
    ].join('\n')
    const callRef = `${gameKey}|${issue}#chair-revise`
    try {
      await promptAgent(text, { activity: 'deliberation', role: 'chair', callRef, sessionId: sessionFor(gameKey, issue, 'chair') })
    } catch (e) { log(`[koi] 打回调用异常：${String(e?.message ?? e).slice(0, 120)}`); return { ok: false, error: v.error } }
    let raw = null
    try {
      // 打回重写等待同款真实时长（恒定时钟死循环防线——同主循环注记）
      raw = await waitJsonFile(outPath, { timeoutMs: RETURN_TIMEOUT_MS, pollMs, stopCheck })
    } catch { raw = null }
    if (!raw) return { ok: false, error: v.error + '；重写也未等到文件' }
    try { reviewStore?.recordOrchestration?.({ archiveKey: `${gameKey}|${issue}`, role: 'chair', round: Number(chairKey.split('-')[1] ?? 1), content: JSON.stringify(raw), agendaVersion: versionOf(cfg), callRef }) } catch { /* 尽力而为 */ }
    return judgeChair(raw, tier)
  }

  /** 定稿判定（纯代码——硬校验单点注入 + 概率闸注入 + 枚举钳位 + 字段缺省兜底文案） */
  function judgeChair(chair, tier) {
    const v = validatePicks ? validatePicks(tier, chair?.picks ?? null) : { ok: false, error: '校验器未注入' }
    if (!v.ok) return { ok: false, error: v.error ?? 'picks 不合规' }
    const message = String(chair?.message ?? '').trim()
    if (!message) return { ok: false, error: 'message 缺失' }
    if (probabilityClaim && probabilityClaim(message)) return { ok: false, error: 'message 含概率宣称（BC-001③ 基调铁律）' }
    const conf = ['low', 'mid', 'high'].includes(chair?.confidenceTier) ? chair.confidenceTier : 'low'   // 枚举钳位（BC-007：禁数值置信度）
    return {
      ok: true,
      picks: v.picks,
      message,
      summary: String(chair?.summary ?? '').trim() || null,
      confidenceTier: conf,
    }
  }

  /** 有效预算线（§3.1：min(起点+25 分钟, 今日 17:55 硬停线)——BC-011 承诺优先） */
  function deadlineOf(startD) {
    const byBudget = startD.getTime() + SESSION_BUDGET_MS
    const d = new Date(startD.getTime())
    const [H, M] = String(HARD_STOP_HHMM).split(':').map(Number)
    const stop = new Date(d.getFullYear(), d.getMonth(), d.getDate(), H, M, 0, 0).getTime()
    return Math.min(byBudget, stop)
  }

  return { runPredict, sessionFor, sessionForSingle, deadlineOf, judgeChair, materialsFor }
}
