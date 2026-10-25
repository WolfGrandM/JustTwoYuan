/**
 * dsh-koi UI 逻辑纯函数层（市场版 MC-16 ①）—— React 无关，node --test 直测。
 * 权威实现；lib/client.js 工厂内含同源内联副本（浏览器工厂无法 import ESM），
 * tests/market-ui.test.mjs 断言两实现行为等价（MD-21）。
 *
 * 覆盖：向导门控状态机 / 六区校验联动 / 降级判定 / 红点未读游标 / 详略选择。
 */
import { validateConfig } from './config.js'

// ── 向导门控状态机（S-102/S-116 五步：渠道→档位→时间→诚实条款→数据就绪）──────────
export const WIZARD_STEPS = [
  { key: 'channels', title: '通知渠道', desc: '至少启用一个可用渠道（桌宠面板渠道即算）' },
  { key: 'tier', title: '投注档位', desc: '在档位表里选一档（显示注数/价格）' },
  { key: 'time', title: '出号时间', desc: '默认 17:30，必须早于该彩种开奖时刻' },
  { key: 'honesty', title: '诚实条款', desc: '开奖是独立随机事件，本内容不改变中奖概率' },
  { key: 'data', title: '数据就绪', desc: '拉取近期开奖入库（秒—分钟级）；全量历史回拉见下方「数据」区' },
]

/** 单步可否前进；stepBad = { channels, tier, time, honesty, data } 布尔集 */
export function wizardCanAdvance(stepIndex, stepBad = {}) {
  const step = WIZARD_STEPS[stepIndex]
  if (!step) return false
  return stepBad[step.key] !== true
}

/** 向导完成是否可置 mode=auto（全部五步通过；四项门控的 UI 面） */
export function wizardComplete(stepBad = {}) {
  return WIZARD_STEPS.every((s) => stepBad[s.key] !== true)
}

// ── 六区校验联动（S-113：保存前全量校验按区分组）─────────────────────────────
const SECTION_OF = {
  channels: 'channels', modes: 'tiers', time: 'tiers', budget: 'budget',
  roles: 'roles', effort: 'effort', verbosity: 'verbosity',
}
export const SECTIONS = [
  { key: 'channels', title: '渠道凭证' },
  { key: 'roles', title: '角色数量' },
  { key: 'budget', title: '预算权重' },
  { key: 'effort', title: '力度' },
  { key: 'verbosity', title: '详略' },
  { key: 'tiers', title: '投注档位' },
]

/** validateConfig 的分区视图：{ [section]: [errors…] }（未出错区不出场） */
export function sectionValidation(cfg) {
  const v = validateConfig(cfg)
  const out = {}
  for (const err of v.errors) {
    const s = String(err)
    const section = Object.keys(SECTION_OF).find((k) => s.startsWith(k)) ?? 'other'
    ;(out[section] ?? (out[section] = [])).push(err)
  }
  return { ok: v.ok, sections: out }
}

// ── 降级判定（MC-16 ②/MB-28 第一级：React 渲染壳缺席 ≠ 通知丢失）────────────────
export function degradeDecision({ reactDomAvailable = false, petEnabled = true, panelChannelEnabled = true } = {}) {
  if (petEnabled && reactDomAvailable) return { level: 'normal', removePetContainer: false, note: '桌宠正常挂载' }
  if (petEnabled && !reactDomAvailable) {
    return {
      level: 'panel-only',
      removePetContainer: true,
      note: '桌宠渲染组件不可用（已静默移除）：通知不丢——设置→彩票节的事件横幅、心跳红标与事件列表（/api/events）仍送达',
      panelChannelUnaffected: panelChannelEnabled,
    }
  }
  return { level: 'pet-off', removePetContainer: true, note: '桌宠已整体关闭（S-123：事件照常分发其他渠道）', panelChannelUnaffected: panelChannelEnabled }
}

// ── 红点未读游标（DC-102 窗口；localStorage 持久 lastReadId）────────────────────
/** events（升序数组）中 lastReadId 之后的条数；游标不在窗口 → 全部计未读 */
export function unreadCount(events, lastReadId) {
  if (!Array.isArray(events) || events.length === 0) return 0
  if (!lastReadId) return events.length
  const i = events.findIndex((e) => e?.id === lastReadId)
  return i >= 0 ? events.length - 1 - i : events.length
}

/** 未读「中奖」战果数（主人 2026-10-25 拍板：只有中奖才通知——红点/冒泡/面板未读只统计 won===true 的战果） */
export function winUnreadCount(events, lastReadId) {
  if (!Array.isArray(events) || events.length === 0) return 0
  let start = 0
  if (lastReadId) {
    const i = events.findIndex((e) => e?.id === lastReadId)
    if (i >= 0) start = i + 1
  }
  return events.slice(start).filter((e) => e?.won === true).length
}

// ── 详略选择（DC-107 全局单档；拍板17/18）─────────────────────────────────────
export function verbosityChoice(current) {
  return current === 'chatty'
    ? { value: 'concise', label: '简洁', next: 'chatty', desc: '只号码 + 合规字段 + 诚实基调句' }
    : { value: 'chatty', label: '叨逼叨', next: 'concise', desc: '号码 + ≤100 字结构化摘要 + 合规字段' }
}

/** 事件冒泡预览行（桌宠消息卡标题）：标题 + 号码行（无 body 依赖） */
export function bubbleTitle(event) {
  if (!event) return ''
  const kindText = { predict: '出号', quickpick: '来一注', result: '战果', apology: '致歉', alert: '告警', advice: '建议', heartbeat: '心跳', test: '测试通知' }[event.kind] ?? '通知'
  const game = event.game ? `· ${event.game} ` : ''
  const issue = event.issue ? `第 ${event.issue} 期` : ''
  return `🐟 ${kindText} ${game}${issue}`.trim()
}

// ── 第二波：学习/数据/结论区文案与纯逻辑（docs/19 §6/§8；FR-1015/BC-112——文案即需求，
//    常量定稿进设计防自由发挥；client.js 内联副本等价断言，MD-21）──────────────────────

/** 上传页文案（§6 定稿原文；MA-25 正向断言口径） */
export const LEARNING_COPY = '📚 学习 = 严格回测检验：上传的技巧会先清洗拆成卡片，再用你的本地全量历史逐一回测。结论可能证明技巧无效——多数技巧的结论会是「与随机无异」，这会如实记录、不会美化。学习影响的是「我们知道的多少」，不改变中奖概率。'
/** 上传控件旁提示（§6 定稿原文；FR-1013 收窄口径 W2A-04） */
export const UPLOAD_HINT = '支持 .txt / .md（≤20MB）；PDF/EPUB 请先转为文本（暂不支持直接解析）。'
/** 结论页口径行（§6 定稿原文；每条结论恒拼） */
export const VERDICT_CALIBER = '口径：本地全量历史 N 期滚动回测 · 命中判据回测前预注册 · 基线=判据滞后自评满足率 · 单侧精确二项检验（α=0.05）。「与随机无异」= 命中率与随机基线无统计学差异。开奖是独立随机事件，回测结论不改变中奖概率，也不驱动任何自动行为。'
/** 状态页待补文案（§6 定稿原文；S-119） */
export const PENDING_LLM_NOTE = '拆卡环节暂不可用（模型未就绪/超时）——已标『待补』，恢复后自动重试，绝不静默丢弃'
/** 全量回拉确认框文案（§2.5 定稿原文；AC-108 计数口径） */
export const FULLBACKFILL_CONFIRM = '将从官方数据源全量回拉历史开奖（约 140–160 个请求、15–30 分钟，批间隔 2 秒；17:00–22:30 错峰窗口内不开始、跨入自动暂停待续；可随时中止，断点保留）。数据经四项校验后入本地库——已抓取的数据不会重复请求（异常中断重启至多重访一个小批次）。确定开始？'
/** 体彩深翻提示注（docs/19 §13.3 未验证项③——面板如实显示） */
export const SPORTTERY_DEEP_NOTE = '注：体彩 pageNo 深翻（>2 页）行为未实测——真实全量首跑时请关注进度与错误提示（若中止，断点保留可续拉）。'

/** 拒收原因拼装（§6 状态页定稿句式） */
export function rejectedNote(reasons) {
  return `拒收原因：${Array.isArray(reasons) ? reasons.join('；') : String(reasons ?? '')}（支持格式与上限见上）`
}

/** rule-dup 保守拒入提示（§4.5 三态；面板如实显示） */
export function ruleDupHint(existingName) {
  return `疑似重复被保守拒入（词法相似度 ≥0.8，与『${existingName}』）`
}

/** 结论档文案映射（离散档，禁百分比置信度——BC-007/W2-D05） */
export function verdictTextOf(verdict) {
  return verdict === 'better-in-sample' ? '样本内优于随机' : '与随机无异'
}

/** 上传格式校验（.txt/.md 白名单；S-118） */
export function uploadFormatOk(name) {
  const m = String(name ?? '').toLowerCase().match(/\.(txt|md)$/)
  return m ? { ok: true, ext: m[1] } : { ok: false, ext: null, error: UPLOAD_HINT }
}

/** 文件大小格式化 */
export function formatBytes(n) {
  const b = Number(n) || 0
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / 1024 / 1024).toFixed(1)} MB`
}

/** 上传面 token 估算与周预算占比（§4.1，BC-107 补位：字节/12 保守口径，标注估算口径） */
export function uploadEstimate(bytes, weeklyCap) {
  const tokens = Math.max(0, Math.ceil(Number(bytes ?? 0) / 12))
  const cap = Number(weeklyCap) > 0 ? Number(weeklyCap) : 0
  return { tokens, pct: cap > 0 ? Number(((tokens / cap) * 100).toFixed(2)) : null, basis: '估算口径：字节/12' }
}

/** 回拉进度行（§2.4 诚实显示：已拉至 <最早期号>（N 期在库），非百分比——W2A-08） */
export function backfillProgressText(progressNote, countInStore) {
  if (!progressNote) return '尚未回拉'
  return countInStore != null ? `${progressNote}（${countInStore} 期在库）` : progressNote
}

/** 学习任务状态徽标文案（queued/cleaning/splitting/dedup/done/pending-llm/rejected + 等待标注） */
export function jobBadgeText(job) {
  const base = { queued: '排队中', cleaning: '清洗中', splitting: '拆卡中', dedup: '判重中', done: '完成', 'pending-llm': '待补', rejected: '已拒收' }[job?.status] ?? String(job?.status ?? '—')
  return job?.waitingNote ? `${base} · ${job.waitingNote}` : base
}
