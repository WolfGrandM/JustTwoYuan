/**
 * dsh-koi 卡片因子化最小版（第二波 docs/19 §5.7，FR-039 前半——「学习」的核心体验）。
 *
 * DSL（声明式，白名单指标 + AND 组合；不执行任意代码——W2-D06）：LLM 只产出 conditions
 * 数组，代码校验白名单/值域后由代码构造因子（predict/judge 全部代码实现）。
 * schema 不过 → 一次打回重写 → 仍不过或 unparseable:true → 卡片 status='factorize-failed'
 * （面板如实显示「无法因子化：<原因>」；不注册回测、不静默、卡片保留）。
 *
 * 注（W2B 决策）：docs/19 §5.7 示例条件里的 omissionMax 以白名单口径实现为 omissionBack
 * （冷号回补个数，参数 n=遗漏期数）——白名单为权威，示例字段名与之不一致处以白名单为准。
 */
import fs from 'node:fs'
import path from 'node:path'
import { numsOf, hotSet, coldSet, keysOfEntry } from './factors.js'
import { waitJsonFile } from './fspoll.js'   // T-06：轮询微工具单点（无取消语义，poll 由本模块参数传入）

/** metric 白名单（与内置因子同空间；docs/19 §5.7） */
export const METRICS = {
  sum: { kind: 'number', desc: '和值（红/前/位数字合计）' },
  span: { kind: 'number', desc: '跨度（最大号−最小号）' },
  parityOdd: { kind: 'number', desc: '奇数个数' },
  mod3Count0: { kind: 'number', desc: '0 路（mod3=0）个数' },
  mod3Count1: { kind: 'number', desc: '1 路（mod3=1）个数' },
  mod3Count2: { kind: 'number', desc: '2 路（mod3=2）个数' },
  consecutivePairs: { kind: 'number', desc: '连号对数（排序后相邻差 1；p3 按相邻位）' },
  hotHit: { kind: 'number', desc: '热号回现个数（近 window 期出现 ≥k 次，默认 30/3）', params: ['window', 'k'] },
  omissionBack: { kind: 'number', desc: '冷号回补个数（此前 n 期未出，默认 20）', params: ['n'] },
  blueIn: { kind: 'set', desc: 'ssq 蓝球 ∈ 集合（1–16）' },
}
export const OPS = ['eq', 'ne', 'gte', 'lte', 'in']

const isInt = (x) => Number.isInteger(Number(x))
const numOr = (x, d) => (Number.isFinite(Number(x)) ? Number(x) : d)

const condText = (c) => {
  const name = { sum: '和值', span: '跨度', parityOdd: '奇数个数', mod3Count0: '0 路个数', mod3Count1: '1 路个数', mod3Count2: '2 路个数', consecutivePairs: '连号对数', hotHit: `热号回现（近 ${c.window ?? 30} 期 ≥${c.k ?? 3} 次的号中）`, omissionBack: `冷号回补（此前 ${c.n ?? 20} 期未出的号中）`, blueIn: '蓝球' }[c.metric] ?? c.metric
  if (c.op === 'in' && c.metric === 'blueIn') return `${name} ∈ {${(c.set ?? []).join('/')}}`
  if (c.op === 'in') return `${name}在 ${c.range?.[0]}–${c.range?.[1]}`
  const opText = { eq: '=', ne: '≠', gte: '≥', lte: '≤' }[c.op] ?? c.op
  return `${name} ${opText} ${c.value}`
}

/** 单条件对某期的求值（historyAsc 供自适应窗；纯函数。冷热键 p3 按位，与内置因子同空间） */
function evalCond(c, game, entry, historyAsc) {
  const nums = numsOf(game, entry).map(Number)
  switch (c.metric) {
    case 'sum': return nums.reduce((a, b) => a + b, 0)
    case 'span': return nums.length ? Math.max(...nums) - Math.min(...nums) : 0
    case 'parityOdd': return nums.filter((x) => x % 2 === 1).length
    case 'mod3Count0': return nums.filter((x) => x % 3 === 0).length
    case 'mod3Count1': return nums.filter((x) => x % 3 === 1).length
    case 'mod3Count2': return nums.filter((x) => x % 3 === 2).length
    case 'consecutivePairs': {
      if (game === 'p3') {
        let p = 0
        for (let i = 0; i + 1 < nums.length; i++) if (Math.abs(nums[i + 1] - nums[i]) === 1) p += 1
        return p
      }
      const s = [...nums].sort((a, b) => a - b)
      let p = 0
      for (let i = 0; i + 1 < s.length; i++) if (s[i + 1] - s[i] === 1) p += 1
      return p
    }
    case 'hotHit': {
      const hot = hotSet(historyAsc, numOr(c.window, 30), numOr(c.k, 3), game)
      return keysOfEntry(game, entry).filter((key) => hot.has(key)).length
    }
    case 'omissionBack': {
      const before = historyAsc.length >= 1 ? historyAsc.slice(0, -1) : historyAsc   // 形成期之前 n 期（滞后窗，基线良定义）
      const cold = coldSet(before, numOr(c.n, 20), game)
      return keysOfEntry(game, entry).filter((key) => cold.has(key)).length
    }
    case 'blueIn': return Number(entry.blue)
    default: return NaN
  }
}

function testCond(c, value) {
  if (c.op === 'in') {
    if (c.metric === 'blueIn') return Array.isArray(c.set) && c.set.includes(value)
    const [lo, hi] = c.range ?? []
    return value >= Number(lo) && value <= Number(hi)
  }
  switch (c.op) {
    case 'eq': return value === numOr(c.value, NaN)
    case 'ne': return value !== numOr(c.value, NaN)
    case 'gte': return value >= numOr(c.value, NaN)
    case 'lte': return value <= numOr(c.value, NaN)
    default: return false
  }
}

/**
 * 校验 + 构造因子。spec = { game, conditions:[…], params? }；card 用于 game 一致性与 factorId 派生。
 * 返回 { ok:true, factor, claim } | { ok:false, errors:[…] }。
 */
export function validateFactorSpec(spec, { card } = {}) {
  const errors = []
  if (!spec || typeof spec !== 'object') return { ok: false, errors: ['spec 不是对象'] }
  const game = String(spec.game ?? card?.games?.[0] ?? '')
  if (!['ssq', 'dlt', 'p3'].includes(game)) errors.push(`game 非法：${spec.game}`)
  if (card && (card.games ?? []).length && !(card.games ?? []).includes(game)) {
    errors.push(`game（${game}）与卡片适用彩种（${(card.games ?? []).join('/')}）不一致`)
  }
  const conds = spec.conditions
  if (!Array.isArray(conds) || !conds.length) errors.push('conditions 必须是非空数组')
  const checked = []
  for (const [i, c] of (Array.isArray(conds) ? conds : []).entries()) {
    if (!c || typeof c !== 'object') { errors.push(`conditions[${i}] 不是对象`); continue }
    if (!METRICS[c.metric]) { errors.push(`conditions[${i}].metric（${c.metric}）不在白名单：${Object.keys(METRICS).join('/')}`); continue }
    if (!OPS.includes(c.op)) { errors.push(`conditions[${i}].op（${c.op}）不在 ${OPS.join('/')}`); continue }
    const kind = METRICS[c.metric].kind
    if (kind === 'set') {
      if (c.op !== 'in') { errors.push(`conditions[${i}] blueIn 只支持 op=in`); continue }
      if (!Array.isArray(c.set) || !c.set.length || !c.set.every((x) => isInt(x) && x >= 1 && x <= 16)) {
        errors.push(`conditions[${i}].set 必须是 1–16 的非空整数集合`)
      }
      if (game !== 'ssq') errors.push(`conditions[${i}] blueIn 仅适用 ssq`)
    } else if (c.op === 'in') {
      const [lo, hi] = c.range ?? []
      if (!isInt(lo) || !isInt(hi) || Number(lo) > Number(hi)) errors.push(`conditions[${i}].range 必须是 [lo,hi] 且 lo≤hi`)
    } else {
      if (!isInt(c.value)) errors.push(`conditions[${i}].value（${c.value}）必须是整数`)
    }
    checked.push({ ...c, metric: String(c.metric), op: String(c.op) })
  }
  if (errors.length) return { ok: false, errors }

  const claim = `下一期：${checked.map(condText).join(' 且 ')}`
  const factor = {
    id: card ? `card-${card.id}` : `card-manual-${Date.now()}`,
    source: card ? `card:${card.id}` : 'card:manual',
    game, name: card?.name ?? '卡片因子',
    predict(historyAsc) {
      // 热号/冷号集合为空 → 本期无观点（跳过该轮；与内置因子同款语义）
      for (const c of checked) {
        if (c.metric === 'hotHit') { const h = hotSet(historyAsc, numOr(c.window, 30), numOr(c.k, 3), game); if (!h.size) return null }
        if (c.metric === 'omissionBack') {
          const before = historyAsc.length >= 1 ? historyAsc.slice(0, -1) : historyAsc
          if (!coldSet(before, numOr(c.n, 20), game).size) return null
        }
      }
      return {
        claim,
        judge(next) {
          const details = []
          let hit = true
          for (const c of checked) {
            const v = evalCond(c, game, next, historyAsc)
            const ok = testCond(c, v)
            if (!ok) hit = false
            details.push(`${condText(c)}（实际=${v}${ok ? '✓' : '✗'}）`)
          }
          return { hit, detail: details.join('；') }
        },
      }
    },
  }
  return { ok: true, factor, claim }
}

/** DSL 规格说明 + 合规示例 + 越界反例（提示词常量；W2-D06：一次会话调用） */
export function buildFactorizePrompt({ card, outFile }) {
  return [
    '【任务】把下面这张「选号技巧卡片」转成一个声明式因子规格（DSL）。你只输出结构化 JSON，不执行任何代码。',
    '',
    `【卡片】名称：${card.name}`,
    `适用彩种：${(card.games ?? []).join('/')}`,
    `规则原文：${card.rule}`,
    '',
    '【DSL 规格】conditions 为 AND 组合（非空数组），每条形如：',
    '  {"metric":"<白名单指标>","op":"eq|ne|gte|lte|in","value":<整数>}   // op=in 时用 "range":[lo,hi]',
    '  {"metric":"blueIn","op":"in","set":[1,2,3]}                       // 仅 ssq 蓝球',
    '  热号/冷号可带参数：{"metric":"hotHit","op":"gte","value":2,"window":30,"k":3} / {"metric":"omissionBack","op":"gte","value":1,"n":20}',
    `【metric 白名单】${Object.entries(METRICS).map(([k, v]) => `${k}=${v.desc}`).join('；')}`,
    '',
    '【合规示例】{"schemaVersion":1,"game":"ssq","conditions":[{"metric":"sum","op":"in","range":[90,130]},{"metric":"parityOdd","op":"eq","value":3}],"claimHuman":"和值落在90-130且奇数3个","unparseable":false}',
    '【越界反例（会被拒收）】{"metric":"acValue","op":"gte","value":8}——acValue 不在白名单；只有白名单指标可用，别的值一律校验拒收。',
    '',
    '【无法表达时】规则无法用白名单指标组合表达 → 如实交 {"schemaVersion":1,"conditions":[],"claimHuman":"","unparseable":true}（诚实承认拆不出，不要硬凑）。',
    '',
    '【交卷方式 —— 最重要的部分】',
    `用 shell 把结果写进这个文件（合法 JSON）： ${outFile}`,
    '写完文件就收工：不要发任何消息、不要动这个文件之外的东西。',
  ].join('\n')
}

/**
 * 会话提取流水线（单次调用 + 一次打回）：promptAgent 注入（与拆卡同款先例，scheduler.js:261-266）。
 * 返回 { ok:true, factor, claim } | { ok:false, reason, error? }（调用方标 factorize-failed）。
 */
export async function factorizeCard({ card, promptAgent, filesDir, now = () => new Date(), waitMs = 10 * 60_000, pollMs = 3_000, log = () => {} }) {
  if (typeof promptAgent !== 'function') return { ok: false, reason: 'promptAgent 不可用（宿主会话未注入）' }
  const outFile = path.join(filesDir, `factorize-${card.id}.json`)
  // T-06：waitFile（含本地 sleep）已下沉 lib/fspoll.js——timeout/poll 仍由本函数参数控制
  try { fs.rmSync(outFile, { force: true }) } catch {}
  const run = async (extraText) => {
    await promptAgent(buildFactorizePrompt({ card, outFile }) + (extraText ? '\n\n' + extraText : ''))
    return await waitJsonFile(outFile, { timeoutMs: waitMs, pollMs })
  }
  let raw = await run('')
  let v = raw ? validateFactorSpec(raw, { card }) : { ok: false, errors: ['交卷文件没等到（超时或未写）'] }
  if (!v.ok && raw && raw.unparseable === true) {
    return { ok: false, reason: `无法因子化：规则不可表达为白名单指标组合（LLM unparseable 如实申报）` }
  }
  if (!v.ok) {
    log(`[koi] 因子化第一次交卷不合格（${v.errors.join('；')}），打回重写一次`)
    raw = await run(`【打回重写】你刚写的规格校验没过：${(v.errors ?? []).join('；')}。请立刻重写 ${outFile}（还是那个 JSON 契约，只用白名单指标），写完就停。`)
    v = raw ? validateFactorSpec(raw, { card }) : { ok: false, errors: ['重写交卷文件没等到'] }
    if (!v.ok && raw && raw.unparseable === true) {
      return { ok: false, reason: '无法因子化：规则不可表达为白名单指标组合（LLM unparseable 如实申报）' }
    }
    if (!v.ok) return { ok: false, reason: `因子化规格两次不过：${(v.errors ?? []).join('；')}` }
  }
  try { fs.rmSync(outFile, { force: true }) } catch {}
  return { ok: true, factor: v.factor, claim: v.claim, claimHuman: String(raw.claimHuman ?? '') }
}
