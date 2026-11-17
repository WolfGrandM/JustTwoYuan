/**
 * dsh-koi 代码化归因引擎（M4 T1 / docs/28 §2.1，FR-034 市场版落点 + §9-R4 口径）。
 *
 * 归因口径（R4，不虚构关联）：市场版 predictions 条目无 factor_ids 字段——归因 = 因子库 ×
 * 每期官方开奖逐期判定（docs/27 §F1「内置六类因子战绩可归因 ✓」）。
 *
 * 防前视契约（与 backtest.js:130-138 逐字同源，结构性保证非提示词约束）：
 *   调用方传入的 asc 恒为「截至上一期（含）」的升序切片；draw = 待归因的下一期开奖。
 *   本模块不放大、不重切 asc——predict(asc) 收到的就是调用方给的切片。
 *
 * BC-014 诚实条款：本模块是纯代码判定——LLM 叙述归因 = 被审计者自己写审计报告，禁止（docs/28 §5）。
 * 本文件零 LLM、零网络、零文件——纯函数 + 注入的 store 包装（attachAttribution）。
 */

/**
 * 对一期开奖做逐因子归因。
 * @param {object}   p
 * @param {string}   p.game       彩种（ssq|dlt|p3）
 * @param {Array}    p.asc        升序历史切片（截至上一期含；调用方保证防前视）
 * @param {object}   p.draw       待归因期开奖号（ssq{red,blue} / dlt{front,back} / p3{digits}）
 * @param {Array}    p.factors    因子对象数组（factors.js/factorize.js 产物，registry 注入）
 * @param {Array}    [p.factorIds] 只归因这些因子（缺省 = 全部适用本彩种的因子）
 * @returns {{ items: Array<{factorId, hit, detail}>, unknownFactorIds: string[], skipped: string[] }}
 *   hit: true|false（有观点且已判）| null（predict 返回 null = 本期无观点，如实入档不进分母）；
 *   unknownFactorIds = 点名但不在 factors 里的 id（幻觉因子检测面，AC-009）；
 *   skipped = 存在但非本彩种（不适用，不算未知）。
 */
export function computeForIssue({ game, asc, draw, factors, factorIds = null } = {}) {
  if (!game) throw new Error('归因缺 game')
  if (!Array.isArray(asc)) throw new Error('归因缺 asc（升序历史切片）')
  if (!draw) throw new Error('归因缺 draw（待归因期开奖号）')
  const list = Array.isArray(factors) ? factors : []
  const scope = []
  const unknownFactorIds = []
  const skipped = []
  if (factorIds) {
    for (const id of factorIds) {
      const f = list.find((x) => x?.id === id)
      if (!f) { unknownFactorIds.push(id); continue }
      if (f.game !== game) { skipped.push(id); continue }
      scope.push(f)
    }
  } else {
    for (const f of list) if (f?.game === game) scope.push(f)
  }
  const items = []
  for (const f of scope) {
    const opinion = f.predict(asc)   // 防前视：asc 即调用方切片（t 期含），judge 的是 t+1 期 draw
    if (opinion == null) {
      items.push({ factorId: f.id, hit: null, detail: '本期无观点' })
      continue
    }
    const r = opinion.judge(draw)
    items.push({ factorId: f.id, hit: r?.hit === true, detail: String(r?.detail ?? '') })
  }
  return { items, unknownFactorIds, skipped }
}

/**
 * 叙述输出的因子 ID 白名单闸（§5 三闸之一；narrate.js T2 消费，AC-009 幻觉因子拒用）。
 * 返回 { allowed, rejected }——rejected 非空即叙述含幻觉因子 → 整段拒用、code-only 降级。
 */
export function whitelistFactorIds(ids, knownIds) {
  const known = new Set(Array.isArray(knownIds) ? knownIds : [])
  const allowed = []
  const rejected = []
  for (const id of Array.isArray(ids) ? ids : []) {
    ;(known.has(id) ? allowed : rejected).push(id)
  }
  return { allowed, rejected }
}

/**
 * 归因入档包装（注入 store——本模块不 import review/store.js，保持纯层可单测）。
 * items 来自 computeForIssue；幂等由 store.recordAttribution 的 UNIQUE 保证。
 */
export function attachAttribution(store, { archiveId, items, at } = {}) {
  if (!store || typeof store.recordAttribution !== 'function') throw new Error('attachAttribution 缺 store')
  if (!Number.isInteger(Number(archiveId))) throw new Error('attachAttribution 缺 archiveId')
  return store.recordAttribution(Number(archiveId), Array.isArray(items) ? items : [], { at })
}
