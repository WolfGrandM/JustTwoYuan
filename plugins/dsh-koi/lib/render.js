/**
 * dsh-koi 渲染层（市场版 FR-1010/BC-108/DC-107）—— 事件正文按全局单档（concise/chatty）渲染；
 * 合规字段恒拼；推送不含全文（全文仅面板详情 + 档案，fullRef 指针跳转）。
 *
 * 合规字段（BC-108，两档恒在）：兜底标注 / 加餐·不记账 / 手动推荐·不记账 / 补发前缀（事件层）/
 * 基线缺失标注 + 诚实基调句。summary ≤100 字为结构化字段（主持人输出 schema），非事后删减：
 * AI 未写 → chatty 如实显示「（无摘要）」；超长 → 拒发并标注（不静默截断）。
 */
export const SUMMARY_MAX = 100

const TITLES = {
  predict: (ev) => `🐟【锦鲤 · ${ev.gameName} · 第 ${ev.issue} 期 · ${ev.date ?? ''}】`,
  quickpick: (ev, flags) => `🐟【锦鲤${flags.manual ? '手动推荐' : '加餐'} · ${ev.gameName} · 第 ${ev.issue} 期】`,
  result: (ev) => `🎰【锦鲤战果 · ${ev.gameName} · 第 ${ev.issue} 期】`,
  apology: () => `🐟 锦鲤致歉`,
  advice: (ev) => `💡【锦鲤 · 今日策略建议 · ${ev.gameName} · 第 ${ev.issue} 期】`,
  alert: () => `⚠️ 锦鲤告警`,
  heartbeat: () => `🔴 锦鲤心跳告警`,
}

/** 诚实基调句（预测类/战果类/建议类；BC-001 在输出面的恒拼落点） */
export function honestyTail(kind) {
  if (kind === 'result') return '开奖是随机的，图个乐～ 明天继续攒运气！'
  if (kind === 'advice') return '建议不记账；建议不会自动生效，换档请手动操作。'
  if (kind === 'predict' || kind === 'quickpick') return '开奖是独立随机事件，本内容不改变中奖概率。'
  return ''
}

/**
 * 渲染事件正文。ev = { kind, gameName, issue, date?, picksLine?, message?, summary?, via?, flags? }
 * flags = { fallback, quickpick, manual, baselineMissing, repush }
 * 返回 { body, summaryRejected }；verbosity 全局单档（拍板18）。
 * 正文使用 message 的仅 apology/alert/heartbeat/advice（短内容）；predict/result/quickpick
 * 的完整分析全文不进推送（FR-1010「全文推送取消」）。
 */
export function renderEvent(ev, { verbosity = 'concise' } = {}) {
  const flags = ev?.flags ?? {}
  const kind = ev?.kind ?? 'alert'
  const title = TITLES[kind]?.(ev, flags) ?? '🐟 锦鲤'
  const lines = []
  lines.push(`${flags.repush ? '【补发】' : ''}${title}`)
  if (ev.picksLine) {
    lines.push(`号码：${ev.picksLine}${flags.fallback || ev.via === 'fallback' ? '（兜底号）' : ''}${flags.baselineMissing ? '（基线缺失）' : ''}`)
  }
  if (flags.quickpick) lines.push('（加餐 · 不记账）')
  if (flags.manual) lines.push('（手动推荐 · 不记账）')
  if (ev.message && ['apology', 'alert', 'heartbeat', 'advice'].includes(kind)) lines.push(String(ev.message))
  let summaryRejected = false
  if (verbosity === 'chatty' && ['predict', 'quickpick', 'result'].includes(kind)) {
    const s = String(ev.summary ?? '').trim()
    if (!s) lines.push('摘要：（无摘要）')
    else if (s.length > SUMMARY_MAX) { lines.push('摘要：（超长已拒发）'); summaryRejected = true }
    else lines.push(`摘要：${s}`)
  }
  const tail = honestyTail(kind)
  if (tail) lines.push(tail)
  return { body: lines.join('\n'), summaryRejected }
}

/** 概率宣称禁用词检测（BC-112：建议/学习/力度文案零概率宣称；advisory 渲染前过闸） */
const PROB_CLAIM_RE = /(提高|增加|提升|加大|改善)[^。\n]{0,12}(中奖|获奖|中奖概率|胜率)|(中奖概率|胜率)[^。\n]{0,8}(提高|增加|提升|上升)/
export function hasProbabilityClaim(text) {
  return PROB_CLAIM_RE.test(String(text ?? ''))
}

/** 摘要闸（BC-108 结构化字段语义）：合法返回 null，非法返回原因 */
export function summaryProblem(summary) {
  const s = String(summary ?? '').trim()
  if (!s) return null
  if (s.length > SUMMARY_MAX) return `summary 超长（${s.length} 字 > ${SUMMARY_MAX}），请压缩到 ${SUMMARY_MAX} 字内`
  if (hasProbabilityClaim(s)) return 'summary 含概率宣称（禁用词），请改写'
  return null
}
