/**
 * dsh-koi M3 议程与阵容档位层（FR-017/021 / docs/33 §2.2 agenda.js 行 + §3 降档链 + §4.1 数据衔接）。
 *
 * 职责：四角色框架常量（数据官/策略师×N/质询者/主持人——docs/06 §九整合地图「每期编排=粘合非重写」）、
 * 角色任务提示词（数量可配 + cfg.roles.prompts 覆盖任务段，FZ-7 围栏：可改角色怎么想，改不动纪律）、
 * 议程版本管理（FR-021/DC-010：版本 stamp + agenda_versions 登记；模板常量在 git = 议程文件入代码
 * 版本控制的 ADR-14 市场版落地）、切片预算表（§3.2，估算值——FR-047 首月实测回填）。
 *
 * 依赖纪律（docs/33 §2.3）：纯函数层，零相对 import（版本 hash 自含 fnv1a——config.js:226-232 同源
 * 算法本地实现；BC-001 声明行与 insight.js DISCLAIMER 同文，同文性由 mind-fence 测试断言防漂移）。
 *
 * 拍板 P15（2026-11-21，不再询问）：单插件承载；每角色每期独立会话 koi-daily-<game>-<issue>-<role>；
 * 3d 轻量对称（p3/3d 同走 lite）；满配档=阵容参数在位+拉前条件解锁门（默认关）；
 * SESSION_BUDGET_MS=25min、硬限 30min。
 *
 * BC-001 诚实条款：四角色提示词常驻声明行（数据官材料头 + 全角色任务段恒拼）——博弈不改变概率；
 * 本模块零选号零判奖零归因（FZ-1/FZ-7 结构锁定，侵蚀测试随 T5）。
 */

// ── 阵容档位（§3.1 链五档）─────────────────────────────────────────────────────
export const CAST_TIERS = ['full', 'standard', 'lite', 'single']
export const FALLBACK_TIER = 'fallback'   // 兜底档（随机号零 LLM——BC-005 照发+透明标注）

/** 彩种默认档映射：ssq/dlt='standard'（IR 起步档）、p3/3d='lite'（Q6 混合档 + docs/31 拍板 #6 数字型轻量；P15 3d 对称）；cfg.cast.tiers 覆盖 */
const DEFAULT_TIER_BY_GAME = { ssq: 'standard', dlt: 'standard', p3: 'lite', '3d': 'lite' }

/**
 * 彩种编排档位（FR-023 双向闸落点：mind.enabled !== true → 强制 'single'——无注入无博弈，
 * AC-008 收窄口径；true → 默认映射 / cfg.cast.tiers 覆盖，非法值回落默认映射不抛错）。
 */
export function castTierOf(cfg, gameKey) {
  if (cfg?.mind?.enabled !== true) return 'single'
  const override = cfg?.cast?.tiers?.[gameKey]
  if (override != null && CAST_TIERS.includes(override)) return override
  const t = DEFAULT_TIER_BY_GAME[gameKey]
  return CAST_TIERS.includes(t) ? t : 'lite'
}

/** 降档步进（§3.1 链：full→standard→lite→single；single 已是保底档 → null（编排让位现状路径）） */
export function nextTier(tier) {
  const i = CAST_TIERS.indexOf(tier)
  if (i < 0 || i >= CAST_TIERS.length - 1) return null
  return CAST_TIERS[i + 1]
}

/**
 * 计划档位（FR-017 拉前条件 / FR-033 告警基准 DC-001）：连续 4 周无降级 且 周 token<70% → 'full'，
 * 否则计划档 = 配置档（castTierOf 含 mind 闸）。full 未解锁期间 standard 即计划档位（§3.1 market
 * 版口径注记——设计内差值不告警）。
 */
export function planTierOf(cfg, gameKey, { demotionFreeWeeks = 0, weekRatio = 1 } = {}) {
  const configured = castTierOf(cfg, gameKey)
  if (configured === 'full') return 'full'
  if (configured === 'standard' && Number(demotionFreeWeeks) >= 4 && Number(weekRatio) < 0.7) return 'full'
  return configured
}

/** 满配解锁拉前条件常量（FR-017 原文口径，单点供配置面/周报引用） */
export const FULL_UNLOCK = { demotionFreeWeeks: 4, weekRatioMax: 0.7 }

// ── 切片预算表（§3.2，估算值——FR-047 首月实测回填；17:55 硬停线为承诺红线不受估算影响）──
export const SLICE_BUDGETS = {
  injection: 60_000,     // 注入 ≤1 分钟（injector 检索+trimmer 裁剪，零 LLM 本地计算；T3 装配）
  dataOfficer: 180_000,  // 数据官 ≤3 分钟
  strategist: 240_000,   // 策略师每人 ≤4 分钟
  provoker: 180_000,     // 质询轮 ≤3 分钟（full 档专属）
  revision: 120_000,     // 修订轮 ≤2 分钟（full 档专属）
  chair: 240_000,        // 主持人 ≤4 分钟
  validate: 120_000,     // 校验+打回 ≤2 分钟（现状 60s 上限同款 ×2）
}
export const SESSION_BUDGET_MS = 25 * 60_000   // 拍板 P15：25 分钟链（有效预算 = min(25min, 距 17:55)）
export const HARD_LIMIT_MS = 30 * 60_000       // 拍板 P15：绝对硬限 30 分钟（进程级保险丝）
export const HARD_STOP_HHMM = '17:55'          // BC-011 时效承诺：predictAt 晚于 17:30 的彩种硬停线仍 17:55

/** 角色切片预算（未知角色回落 strategist 档——宁多勿少不卡链） */
export function sliceBudgetOf(role) {
  return SLICE_BUDGETS[role] ?? SLICE_BUDGETS.strategist
}

/**
 * 阵容序列（§3.1 链表 + §2.2 四角色表）。返回 [{ role, id, round, sliceMs }]——
 * id 供产出文件/剔除登记/会话 id（koi-daily-<game>-<issue>-<id>，P15）。
 *   full    = 数据官 + 策略师×N + 质询轮(round2) + 修订轮(round3) + 主持人(round4)
 *   standard= 数据官 + 策略师×N + 主持人（IR 起步档；策略师互不读对方产出——独立性保真）
 *   lite    = 数据官 + 单策略师 + 主持人（P15 3d 对称同款）
 *   single  = []（编排不接手——runPredictFlow 现状主体）
 */
export function lineupFor(tier, cfg) {
  const n = Math.max(1, Math.min(4, Number(cfg?.roles?.strategists ?? 1)))
  const strategists = Array.from({ length: n }, (_, i) => ({
    role: 'strategist', id: `strategist-${i + 1}`, round: 1, sliceMs: SLICE_BUDGETS.strategist,
  }))
  if (tier === 'full') {
    return [
      { role: 'dataOfficer', id: 'dataOfficer', round: 1, sliceMs: SLICE_BUDGETS.dataOfficer },
      ...strategists,
      { role: 'provoker', id: 'provoker', round: 2, sliceMs: SLICE_BUDGETS.provoker },
      ...strategists.map((s) => ({ ...s, round: 3, sliceMs: SLICE_BUDGETS.revision })),   // 修订轮（同 id 不同 round）
      { role: 'chair', id: 'chair', round: 4, sliceMs: SLICE_BUDGETS.chair },
    ]
  }
  if (tier === 'standard') {
    return [
      { role: 'dataOfficer', id: 'dataOfficer', round: 1, sliceMs: SLICE_BUDGETS.dataOfficer },
      ...strategists,
      { role: 'chair', id: 'chair', round: 2, sliceMs: SLICE_BUDGETS.chair },
    ]
  }
  if (tier === 'lite') {
    return [
      { role: 'dataOfficer', id: 'dataOfficer', round: 1, sliceMs: SLICE_BUDGETS.dataOfficer },
      { role: 'strategist', id: 'strategist-1', round: 1, sliceMs: SLICE_BUDGETS.strategist },
      { role: 'chair', id: 'chair', round: 2, sliceMs: SLICE_BUDGETS.chair },
    ]
  }
  return []   // single：编排不接手（现状 runPredictFlow 主体——FZ-5 相位机不动）
}

// ── 四级优先序（§3.3「cap 短路 > 硬停线 > 切片超时降档 > 计划档」——orchestrator 入口一次性判定）──
/**
 * @returns {{tier: string, action: 'run'|'skip-cap'|'hard-stop', reason: string}}
 *   skip-cap：周预算 cap 态（allowLLM=false）→ 编排不起跑，兜底档直接出号零 LLM（scheduler.js:322-328 既有行为零改动）
 *   hard-stop：硬停线（17:55）已过 → 立即兜底档 proposal（随机号，17:56 前交付——BC-011 承诺优先于链预算）
 *   run：按计划档起跑（切片超时降档在运行中逐角色处理——中途只降不升）
 */
export function resolveTier({ castTier, allowLLM = true, hhmmNow = '17:30', hardStop = HARD_STOP_HHMM } = {}) {
  if (allowLLM === false) return { tier: castTier, action: 'skip-cap', reason: '预算触顶 · 编排不起跑（BC-013 cap 短路优先于一切会话级编排）' }
  if (String(hhmmNow ?? '') >= String(hardStop)) return { tier: 'fallback', action: 'hard-stop', reason: `已达 ${hardStop} 硬停线（BC-011 时效承诺优先于链预算）——立即兜底档` }
  return { tier: castTier, action: 'run', reason: `按计划档 ${castTier} 起跑` }
}

// ── 提示词模板（FZ-7：内置默认 + cfg.roles.prompts 覆盖任务段；交卷契约段代码恒拼不进覆盖面）──
/** BC-001 声明行（insight.js:30 DISCLAIMER 同文——同文性由 mind-fence 测试断言防漂移；§1 BC-001 行①） */
export const BC001_LINE = '探索性素材 · 无预测力声明（BC-001）：开奖为独立随机事件，任何博弈与讨论都不改变中奖概率，本流程全部产出仅为历史统计描述，不构成预测、不改变任何概率。'

const DEFAULT_TASKS = {
  dataOfficer: '你是「数据官」。通读下方研究材料，产出当期局势快照数据包：遗漏/冷暖/和值带/分位行引用，逐项给数字并标注引用行号；只陈述数据事实，零结论、零选号、零建议。',
  strategist: '你是「策略师」。基于数据官数据包与研究材料独立给出号码提案：号码 + 理由 + 引用材料行编号；不读其他策略师的产出（独立性保真），讲得出故事就行，但禁止宣称概率优势。',
  provoker: '你是「质询者」。对各策略师提案提结构性质询：数据引用是否成立、是否自相矛盾、引用行号是否真的在材料内；只质询，不出号、不下结论。',
  chair: '你是「主持人」。汇总数据官数据包与各策略师提案，合成定稿：选出最终号码（picks 完全合规）、写给主人的正文 message（无概率宣称）、一句话摘要 summary、置信档 confidenceTier（只许 low/mid/high 三档之一，禁止数值置信度），并逐条列出引用的材料行编号。',
}

/** 用户覆盖段上限（§4.1 议程层「用户覆盖段≤2000 字符校验」——校验在 config.validateConfig，渲染侧超限截断） */
export const PROMPT_OVERRIDE_MAX = 2000

/**
 * 渲染单角色提示词。materials = orchestrator 拼好的材料段（数据层 dataPack/记忆层注入块/前序角色产出）；
 * contract = orchestrator 给出的交卷契约段（含 outPath 与 JSON 结构——chair 的 picks 契约按档位规格
 * 由 scheduler 侧 specText 提供，agenda 保持零相对 import）。cfg.roles.prompts[role] 覆盖任务段
 * （FZ-7 围栏：用户可改角色怎么想；BC-001 声明行与交卷契约恒代码拼装，围栏外不可及）。
 */
export function renderRolePrompt({ role, round = 1, gameKey, issue, materials = '', outPath, cfg = null, contract = '', roleIndex = null } = {}) {
  const override = String(cfg?.roles?.prompts?.[role] ?? '').trim().slice(0, PROMPT_OVERRIDE_MAX)
  const task = override || DEFAULT_TASKS[role] || DEFAULT_TASKS.strategist
  const label = role === 'strategist' && roleIndex ? `策略师#${roleIndex}` : { dataOfficer: '数据官', strategist: '策略师', provoker: '质询者', chair: '主持人' }[role] ?? role
  return [
    `【角色】${label}（M3 博弈编排 · 第 ${round} 轮 · ${gameKey} 第 ${issue} 期）`,
    '',
    `【任务】${task}`,
    '',
    `【纪律（常驻，不可覆盖）】`,
    `  · ${BC001_LINE}`,
    '  · 引用材料必须标注行编号，且只允许引用下方已注入的行（防幻觉引用）;',
    '  · 不许自己发消息、不许动交卷文件之外的任何东西。',
    '',
    '【研究材料】',
    ...(String(materials ?? '').trim() ? [String(materials)] : ['  （本期无记忆注入/无前序产出——基于现有材料独立完成，如实声明）']),
    '',
    '【交卷方式 —— 最重要的部分】',
    ...(contract ? [contract] : []),
    '  写完文件就收工：不要发任何消息、不要调用任何对外工具。',
    `  （交卷文件：${outPath}）`,
  ].join('\n')
}

// ── 议程版本（FR-021/DC-010：'m3:v<模板版本>:<prompts 内容 hash8>'）───────────────
const AGENDA_TEMPLATE_VERSION = 1   // 内置模板常量版本号（模板内容变更时递增——git 版本控制 ADR-14 口径）

function fnv1a(str) {   // config.js:226-232 同源算法（本地实现保 agenda 纯函数层零 import）
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** 议程版本号 = 内置模板版本 + cfg.roles.prompts 内容 fnv1a（同配置同版本 → 重跑幂等登记） */
export function versionOf(cfg) {
  const prompts = cfg?.roles?.prompts ?? {}
  const keys = Object.keys(prompts).sort()
  const h = fnv1a(JSON.stringify(keys.map((k) => [k, String(prompts[k] ?? '')])))
  return `m3:v${AGENDA_TEMPLATE_VERSION}:${h}`
}
