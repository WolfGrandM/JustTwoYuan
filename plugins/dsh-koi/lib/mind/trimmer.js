/**
 * dsh-koi M3 上下文裁剪器（FR-030 / 拍板 P3 / docs/33 §2.2 trimmer.js 行）。
 *
 * 每角色每次出号会话 ≤4000 token（上下文裁剪参数，与预算解耦不随预算放大——docs/12 §5.10 P3 原文）；
 * 口径 = chars/4（estTokens usage.js:37 同源）；裁剪按优先级**整块丢弃**（因子战绩 > 局势摘要；
 * lessons 延后不占位——DC-013 延后注记），被丢弃块如实进 dropped（不静默）。
 *
 * 角色差异化配额：cfg.budget.overrides.injectionCap 扩展位（默认恒 4000，权重差异化待主人给值——
 * P3 拍板原文；scheduler 装配处读 cfg，本模块只认传入 cap）。
 *
 * 纯函数层（docs/33 §2.3）：零相对 import——estTokens 口径本地实现（chars/4 ceil），与 usage.js:37
 * 同源（同文性由 mind-injector 测试断言）。
 */

/** chars/4 保守估算（usage.js estTokens:37 同口径——本地实现保 trimmer 纯函数层零 import） */
export const estTokensOf = (text) => Math.ceil(String(text ?? '').length / 4)

/** 默认每角色裁剪上限（拍板 P3：4000 token，与预算解耦不随预算放大） */
export const DEFAULT_CAP_PER_ROLE = 4000

/** 保留优先级（整块丢弃序：排位越靠后越先丢——因子战绩 > 局势摘要；lessons 延后不占位） */
export const DEFAULT_PRIORITY = ['factor-form', 'situation']

/**
 * 裁剪注入块集到单角色配额内。
 * @param {Array<{kind:string, text:string, estTokens?:number}>} blocks injector.assemble 产物
 * @param {{capPerRole?:number, priority?:string[]}} opts cap（默认 4000）与保留优先级
 * @returns {{text:string, tokens:number, kept:string[], dropped:Array<{kind:string, reason:string}>}}
 *   text=保留块原文 join（保持传入序）；dropped 如实逐块（kind+reason——诚实标注不静默）。
 *   blocks 空 → { text:'', tokens:0, kept:[], dropped:[] }（零块如实）。
 */
export function trimBlocks(blocks, { capPerRole = DEFAULT_CAP_PER_ROLE, priority = DEFAULT_PRIORITY } = {}) {
  const cap = Number(capPerRole) > 0 ? Number(capPerRole) : DEFAULT_CAP_PER_ROLE
  const list = (Array.isArray(blocks) ? blocks : []).filter((b) => b && typeof b.text === 'string')
  const rankOf = (kind) => { const i = priority.indexOf(kind); return i < 0 ? priority.length : i }
  const kept = []
  const dropped = []
  let used = 0
  for (const b of list) {
    const tokens = Number.isFinite(Number(b.estTokens)) && Number(b.estTokens) > 0 ? Number(b.estTokens) : estTokensOf(b.text)
    if (used + tokens <= cap) {
      kept.push(b)
      used += tokens
    } else {
      dropped.push({ kind: b.kind, reason: `整块丢弃（${tokens} estTokens，累计 ${used}+${tokens} 超单角色配额 ${cap}——优先级 ${priority.join('>')}）` })
    }
  }
  return { text: kept.map((b) => b.text).join('\n\n'), tokens: used, kept: kept.map((b) => b.kind), dropped }
}
