/**
 * dsh-koi 全量数据探索层（docs/32 §6.2①②③ 第一批数据面）——纯函数、零 IO、零 LLM、零 token、零 npm 依赖。
 *
 * 批次边界（docs/32 §8.5 表 :129-137）：本批 = 纯函数 + 纯计算，零新表、零行为变化；依赖仅
 * drawstore/backfill（均已上线）。注入面（相似局势/分位数段接进 dataPack）原定另行拍板（§8.5 :137），
 * 已于收尾批 T1 实施（lib/stats.js insightBlock——加法通道、防前视接线断言、数据不足整段省略；
 * 本模块本身仍只读历史（调用方注入条目数组），绝不写 draws/ledger/predictions 任何文件——零新表零落盘。
 *
 * BC-001 诚实条款（进注释 + 全部产物常驻注记）：本模块全部输出是「探索性素材 · 无预测力声明」
 * ——开奖为独立随机事件，相似局势/分位数/聚合视图仅为历史统计描述，不构成预测、不改变任何
 * 概率、不驱动任何自动行为。
 *
 * 三件（docs/32 §6.2 表 :61-67）：
 *   ① 局势指纹与相似检索（本文件 fingerprint / fingerprintDistance / similar / fingerprintSeries）：
 *      每期编码为「该期开奖前」的局势向量——遗漏分布 + 最近一期和值/奇偶比/012 路/AC 值/连号状态
 *      （docs/06 §4.3「条件空间」的落地；状态变量集按彩种适配：p3 按位、ssq 红/蓝分区、dlt 前/后区）。
 *      similar(game, history, issue, k) 按目标指纹检索历史 top-K 相似期并如实附上各期「后续开奖」。
 *      **防前视硬约束（§6.2①）**：指纹只用该期之前的历史计算、检索范围严格早于给定 issue——
 *      由构造保证（内部按期号数值严格 `< issue` 过滤），测试断言锁死（tests/insight.test.mjs）。
 *   ② 极值/分位数档案（percentile / percentileRank / profile）：现算不落表（§8.2 L2.5，7000 期毫秒级）。
 *   ③ 聚合视图生成器（aggregate）：转移频次表/条件分位数/因子覆盖盲区清单（环 A 锚 A 输入规格）。
 *
 * 数据通路（盘点锚点）：调用方注入 drawstore.getRecent(game, n) 结果（最新在前）或任意顺序条目数组
 * ——本模块内部统一按期号数值升序整理（getRecent 降序 → reverse 语义自担，scheduler.js:217 先例同款）。
 * 条目形状 = validate-draws.js 校验过的库内条目（ssq red/blue / dlt front/back / p3 digits）。
 */
import { GAMES } from './draws.js'

/** BC-001 常驻注记（①②③所有产物必带；CLI 与测试断言同源消费此常量） */
export const DISCLAIMER = '探索性素材 · 无预测力声明（BC-001）：开奖为独立随机事件，本模块全部输出仅为历史统计描述，不构成预测、不改变任何概率、不驱动任何自动行为。'

// ── 彩种状态变量集适配（p3 按位 / ssq 红+蓝分区 / dlt 前+后区）────────────────────

const ZONE_SIZE = { ssq: 6, dlt: 5, p3: 3 }            // 主区号码个数
const SECOND_ZONE = { ssq: 'blue', dlt: 'back', p3: null }   // 第二区（ssq 蓝球单号 / dlt 后区两号 / p3 无）

/** 主区号码序列（ssq 红 6 / dlt 前 5 / p3 三位数字）——与 lib/factors.js numsOf 同口径 */
export function mainNums(game, e) {
  if (game === 'ssq') return (e.red ?? []).map(Number)
  if (game === 'dlt') return (e.front ?? []).map(Number)
  return (e.digits ?? []).map(Number)
}

function secondNums(game, e) {
  if (game === 'ssq') return [Number(e.blue)]
  if (game === 'dlt') return (e.back ?? []).map(Number)
  return []
}

/** 遗漏 cell 布局（指纹向量与 ②分位数档案共用的状态维度全集）：
 *  ssq r1..r33+b1..b16=49 / dlt f1..f35+b1..b12=47 / p3 p0d0..p2d9=30（按位） */
export function cellsOf(game) {
  if (game === 'ssq') {
    const out = []
    for (let n = 1; n <= 33; n++) out.push(`r${n}`)
    for (let n = 1; n <= 16; n++) out.push(`b${n}`)
    return out
  }
  if (game === 'dlt') {
    const out = []
    for (let n = 1; n <= 35; n++) out.push(`f${n}`)
    for (let n = 1; n <= 12; n++) out.push(`b${n}`)
    return out
  }
  const out = []
  for (let p = 0; p < 3; p++) for (let d = 0; d <= 9; d++) out.push(`p${p}d${d}`)
  return out
}

/** 一期开奖命中的遗漏 cell（增量扫描用）：ssq 六红+一蓝 / dlt 五前+两后 / p3 按位三 cell */
function cellsHitBy(game, e) {
  if (game === 'ssq') return (e.red ?? []).map((n) => `r${Number(n)}`).concat([`b${Number(e.blue)}`])
  if (game === 'dlt') return (e.front ?? []).map((n) => `f${Number(n)}`).concat((e.back ?? []).map((n) => `b${Number(n)}`))
  return (e.digits ?? []).map((d, p) => `p${p}d${Number(d)}`)
}

// ── 局势特征（和值/奇偶/012 路/AC 值/连号；口径与 lib/factors.js 六内置因子一致）──────

const sumOf = (nums) => nums.reduce((a, b) => a + Number(b), 0)
const oddCountOf = (nums) => nums.filter((x) => Number(x) % 2 === 1).length
const roadCountsOf = (nums) => {
  const c = [0, 0, 0]
  for (const x of nums) c[Number(x) % 3]++
  return c
}

/** AC 值：两两差值（正）去重个数 − (n−1)。六连号 ssq → 0；p3 全同号 → −2（标准定义，可为负）。
 *  内置六因子未覆盖此维度（lib/factors.js:10 移交项）——此处只做状态编码不做任何预测。 */
export function acOf(nums) {
  const diffs = new Set()
  for (let i = 0; i < nums.length; i++) {
    for (let j = i + 1; j < nums.length; j++) {
      const d = Math.abs(Number(nums[j]) - Number(nums[i]))
      if (d > 0) diffs.add(d)
    }
  }
  return diffs.size - (nums.length - 1)
}

/** 连号对数：ssq/dlt 排序后相邻差 1；p3 相邻位数字差 1（lib/factors.js hasConsecutive 同口径，布尔→计数） */
export function consecCountOf(game, nums) {
  if (game === 'p3') {
    let c = 0
    for (let i = 0; i + 1 < nums.length; i++) if (Math.abs(Number(nums[i + 1]) - Number(nums[i])) === 1) c++
    return c
  }
  const s = [...nums].sort((a, b) => Number(a) - Number(b))
  let c = 0
  for (let i = 0; i + 1 < s.length; i++) if (Number(s[i + 1]) - Number(s[i]) === 1) c++
  return c
}

/** 一期开奖的局势特征（主区和值/奇偶/012 路/AC 值/连号；第二区附 ssq 蓝球 / dlt 后区和）。
 *  这是「最近一期」的特征视角——指纹用它描述该期开奖前的最近已知开奖。 */
export function drawFeatures(game, e) {
  const nums = mainNums(game, e)
  const f = { sum: sumOf(nums), odd: oddCountOf(nums), road: roadCountsOf(nums), ac: acOf(nums), consec: consecCountOf(game, nums) }
  if (game === 'ssq') f.blue = Number(e.blue)
  if (game === 'dlt') f.backSum = sumOf(secondNums(game, e))
  return f
}

// ── 输入整理（任意顺序 → 期号数值升序；防御性拷贝不动调用方数组）────────────────────

function assertGame(game) {
  if (!GAMES[game]) throw new Error(`彩种要是 ssq/dlt/p3 之一：${game}`)
}

function ascending(history) {
  if (!Array.isArray(history)) throw new Error('history 要是条目数组（drawstore.getRecent 结果或库内条目，任意顺序均可）')
  return history.filter((e) => e && e.issue != null).slice().sort((a, b) => Number(a.issue) - Number(b.issue))
}

// ── ① 局势指纹 ────────────────────────────────────────────────────────────────

/** 单期指纹构建核心（prior = 严格早于 issue 的升序条目；无前期历史 → null，边界：库内首期/空库） */
function fingerprintFromPrior(game, prior, issue) {
  if (!prior.length) return null
  const m = prior.length
  const lastSeen = new Map()
  for (let i = 0; i < m; i++) {
    for (const cell of cellsHitBy(game, prior[i])) lastSeen.set(cell, i)
  }
  const omissions = {}
  for (const cell of cellsOf(game)) omissions[cell] = lastSeen.has(cell) ? m - 1 - lastSeen.get(cell) : m
  return { game, issue: String(issue), priorCount: m, omissions, last: drawFeatures(game, prior[m - 1]) }
}

/**
 * 局势指纹：issue 开奖前的局势向量。omission 口径与 lib/stats.js 一致（0=上期刚开；从未开出=前期期数）。
 * 防前视由构造保证：只使用期号数值严格 < issue 的条目——传入含 issue 自身与未来期的全库亦同。
 * 返回 null = 该期之前无任何历史（无可编码局势）。
 */
export function fingerprint(game, history, issue) {
  assertGame(game)
  const asc = ascending(history)
  const cutoff = Number(issue)
  return fingerprintFromPrior(game, asc.filter((e) => Number(e.issue) < cutoff), issue)
}

/** 全历史逐期指纹序列（升序；每期指纹=该期开奖前局势；首期无前期历史不产出）——②档案与③聚合共用底座。
 *  单趟增量扫描 O(N×cells)：7000 期 p3 约 21 万 cell 更新，毫秒级（§8.2 L2.5 现算约束）。 */
export function fingerprintSeries(game, history) {
  assertGame(game)
  const asc = ascending(history)
  const lastSeen = new Map()
  const out = []
  for (let i = 0; i < asc.length; i++) {
    if (i >= 1) {
      const m = i
      const omissions = {}
      for (const cell of cellsOf(game)) omissions[cell] = lastSeen.has(cell) ? m - 1 - lastSeen.get(cell) : m
      const fp = { game, issue: String(asc[i].issue), priorCount: m, omissions, last: drawFeatures(game, asc[i - 1]) }
      out.push({ issue: String(asc[i].issue), date: asc[i].date, fingerprint: fp })
    }
    for (const cell of cellsHitBy(game, asc[i])) lastSeen.set(cell, i)
  }
  return out
}

// ── ① 距离函数 ────────────────────────────────────────────────────────────────
// 归一化标尺（理论极值，手算）：和值上界 ssq 33+32+…+28=183 / dlt 35+…+31=165 / p3 9+9+9=27；
// AC 上界 = C(n,2)−(n−1)：6 号 15−5=10 / 5 号 10−4=6 / 3 位值域 [−2,1] 极差 3；
// 连号对数上限 n−1；蓝球最大 16；后区两球和最大 12+11=23。
const SUM_SCALE = { ssq: 183, dlt: 165, p3: 27 }
const AC_SCALE = { ssq: 10, dlt: 6, p3: 3 }
const CONSEC_SCALE = { ssq: 5, dlt: 4, p3: 2 }
const BLUE_SCALE = 16
const BACKSUM_SCALE = 23
const W_OMIT = 0.6   // 遗漏分布权重（长程状态）
const W_FEAT = 0.4   // 最近一期特征权重（短程状态）

/**
 * 局势距离 ∈ [0,1]：0.6×遗漏分量 + 0.4×特征分量，均为确定性纯函数（零随机零时钟）。
 * 遗漏分量 = 各 cell 遗漏率（各自 priorCount 归一）平均绝对差；特征分量 = 和值/奇偶/012 路/AC/连号
 * （+第二区）归一化距离的均值。跨彩种指纹不可比（状态变量集不同）→ 显式报错。
 */
export function fingerprintDistance(a, b) {
  if (a.game !== b.game) throw new Error('跨彩种指纹不可比（状态变量集不同）')
  const cells = cellsOf(a.game)
  let omitAcc = 0
  for (const cell of cells) omitAcc += Math.abs(a.omissions[cell] / a.priorCount - b.omissions[cell] / b.priorCount)
  const omitDist = omitAcc / cells.length
  const n = ZONE_SIZE[a.game]
  const feats = [
    Math.abs(a.last.sum - b.last.sum) / SUM_SCALE[a.game],
    Math.abs(a.last.odd - b.last.odd) / n,
    (Math.abs(a.last.road[0] - b.last.road[0]) + Math.abs(a.last.road[1] - b.last.road[1]) + Math.abs(a.last.road[2] - b.last.road[2])) / (2 * n),
    Math.abs(a.last.ac - b.last.ac) / AC_SCALE[a.game],
    Math.abs(a.last.consec - b.last.consec) / CONSEC_SCALE[a.game],
  ]
  if (a.game === 'ssq') feats.push(Math.abs(a.last.blue - b.last.blue) / BLUE_SCALE)
  if (a.game === 'dlt') feats.push(Math.abs(a.last.backSum - b.last.backSum) / BACKSUM_SCALE)
  const featDist = feats.reduce((x, y) => x + y, 0) / feats.length
  return W_OMIT * omitDist + W_FEAT * featDist
}

// ── ① 相似检索 ────────────────────────────────────────────────────────────────

/**
 * 相似局势检索（§6.2①）：目标 = issue 开奖前局势指纹；候选 = 历史上每个「有前期历史且期号严格
 * 早于 issue」的期，其指纹 = 该候选期开奖前局势（同样防前视）。命中附 next = 该候选期自身开奖
 * （「后续开奖分布如实给表」的原始素材）。排序：距离升序，并列取期号新者在前（确定性）。
 *
 * @returns { game, issue, k, target, hits:[{ issue, date, distance, priorCount, next }], scanned, note }
 *   target=null（目标期之前无历史）→ hits 空数组不崩（边界）。scanned = 参与比较的候选期数。
 */
export function similar(game, history, issue, k = 12) {
  assertGame(game)
  if (!Number.isInteger(k) || k < 1) throw new Error(`k 要是 ≥1 的整数：${k}`)
  const asc = ascending(history)
  const cutoff = Number(issue)
  const target = fingerprintFromPrior(game, asc.filter((e) => Number(e.issue) < cutoff), issue)
  const cands = fingerprintSeries(game, asc).filter((s) => Number(s.issue) < cutoff)   // 防前视硬约束：严格早于 issue
  if (!target) {
    return { game, issue: String(issue), k, target: null, hits: [], scanned: cands.length, note: DISCLAIMER }
  }
  const byIssue = new Map(asc.map((e) => [String(e.issue), e]))
  const hits = cands
    .map((s) => ({
      issue: s.issue,
      date: s.date,
      distance: fingerprintDistance(target, s.fingerprint),
      priorCount: s.fingerprint.priorCount,
      next: { ...byIssue.get(s.issue) },
    }))
    .sort((x, y) => x.distance - y.distance || Number(y.issue) - Number(x.issue))
    .slice(0, k)
  return {
    game,
    issue: String(issue),
    k,
    target: { issue: String(issue), priorCount: target.priorCount, fingerprint: target },
    hits,
    scanned: cands.length,
    note: DISCLAIMER,
  }
}

// ── ② 极值/分位数档案（docs/32 §6.2② :66——现算不落表，§8.2 L2.5「纯函数现算/实时」）──────

/**
 * 线性插值分位数（p ∈ [0,100]，与 numpy 默认 linear 法同型）。
 * values 空数组 → null（调用方决定如何呈现）；p 越界/非有限数 → 显式报错（边界不静默）。
 */
export function percentile(values, p) {
  if (!Number.isFinite(p) || p < 0 || p > 100) throw new Error(`p 要是 [0,100] 内的有限数：${p}`)
  const s = (Array.isArray(values) ? values : []).map(Number).filter(Number.isFinite).sort((a, b) => a - b)
  if (!s.length) return null
  const rank = (p / 100) * (s.length - 1)
  const lo = Math.floor(rank)
  const frac = rank - lo
  const hi = Math.min(lo + 1, s.length - 1)
  return s[lo] + (s[hi] - s[lo]) * frac
}

/** 历史分位：v 在 values 中的「≤ v 占比」（0–100）——「当前蓝球遗漏 12 期 = 历史 89 分位」的查询面。空数组 → null。 */
export function percentileRank(values, v) {
  const s = (Array.isArray(values) ? values : []).map(Number).filter(Number.isFinite)
  if (!s.length) return null
  const le = s.filter((x) => x <= Number(v)).length
  return (le / s.length) * 100
}

/** 极值/分位数区间（档案表的行单位）：n + min/p25/p50/p75/p90/p95/p99/max（min/max 即极值区间）。空 → null。 */
function statsOf(values) {
  if (!Array.isArray(values) || !values.length) return null
  return {
    n: values.length,
    min: percentile(values, 0),
    p25: percentile(values, 25),
    p50: percentile(values, 50),
    p75: percentile(values, 75),
    p90: percentile(values, 90),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
    max: percentile(values, 100),
  }
}

/** 各遗漏 cell 的逐期「开奖前」遗漏序列（升序；首期无前期局势不产出）——档案与「当前=历史 X 分位」查询共用。 */
export function omissionSeriesByCell(game, history) {
  assertGame(game)
  const out = {}
  for (const cell of cellsOf(game)) out[cell] = []
  for (const s of fingerprintSeries(game, history)) {
    for (const cell of cellsOf(game)) out[cell].push(s.fingerprint.omissions[cell])
  }
  return out
}

/** 最长连号长度（与 consecCountOf 同序口径：p3 相邻位 / 其余排序后相邻；单号=1） */
function maxRunOf(game, nums) {
  const seq = game === 'p3' ? nums.map(Number) : [...nums].map(Number).sort((a, b) => a - b)
  let best = 1
  let cur = 1
  for (let i = 0; i + 1 < seq.length; i++) {
    if (seq[i + 1] - seq[i] === 1) { cur++; if (cur > best) best = cur } else cur = 1
  }
  return best
}

/**
 * 极值/分位数档案（§6.2②）——一次现算、查询千次：
 *   cells = 各遗漏 cell 的历史「开奖前」遗漏分布（比较基准：「当前蓝球遗漏 12 期 = 历史 89 分位」）；
 *   summary = 和值/跨度/AC/连号对数/奇数个数/最长连号的逐期分布（极值区间 min/max 含于表内）。
 * 全部现算不落表（本批零新表）：7000 期 p3 = 7000×30 cell 更新 + 30 列排序，毫秒级。
 * 逐期分布用各期自身开奖（历史分布描述，非时点状态查询——时点比较用 cells + percentileRank）。
 */
export function profile(game, history) {
  assertGame(game)
  const asc = ascending(history)
  const seriesByCell = omissionSeriesByCell(game, asc)
  const cells = {}
  for (const cell of cellsOf(game)) cells[cell] = statsOf(seriesByCell[cell])
  const feats = asc.map((e) => drawFeatures(game, e))
  const summary = {
    sum: statsOf(feats.map((f) => f.sum)),
    span: statsOf(asc.map((e) => { const nums = mainNums(game, e); return Math.max(...nums, Number.NEGATIVE_INFINITY) - Math.min(...nums, Number.POSITIVE_INFINITY) })),
    ac: statsOf(feats.map((f) => f.ac)),
    consec: statsOf(feats.map((f) => f.consec)),
    odd: statsOf(feats.map((f) => f.odd)),
    maxRun: statsOf(asc.map((e) => maxRunOf(game, mainNums(game, e)))),
  }
  return { game, count: asc.length, cells, summary, note: DISCLAIMER }
}

// ── ③ 聚合视图生成器（docs/32 §6.2③ :67——环 A「锚 A」输入规格）────────────────────
// LLM 吃摘要、代码吃全量（§6.1）：给环 A 的不是原始期次而是聚合产物（转移频次表/条件分位数/
// 因子覆盖盲区清单）。本批只产聚合产物（Markdown+JSON 双形态、纯函数零 IO）；LLM 提案面
// （月报探索性提案段）= 下一批另行拍板（§8.5 :134）。

const BAND_KEYS = ['low', 'mid', 'high']
const BAND_LABEL = { low: '低', mid: '中', high: '高' }
const mkRow = () => ({ low: 0, mid: 0, high: 0 })

/**
 * 因子覆盖静态普查表（状态维度 → 内置因子家族；家族 id 实例化带 -<game> 后缀）。
 * 依据 lib/factors.js 六内置（:107-187）与其文件头明示的移交盲区（:10「AC 值、斜跳号、蓝球周期」）。
 * 静态登记不动态探测（零副作用、可复现）；新增内置因子时在此加行（纯数据）。
 */
const FACTOR_DIMENSIONS = [
  { key: 'omission', label: '遗漏分布', coveredBy: ['builtin-omission', 'builtin-hot-cold'] },
  { key: 'sum', label: '和值', coveredBy: ['builtin-sum-band'] },
  { key: 'parity', label: '奇偶比', coveredBy: ['builtin-parity-ratio'] },
  { key: 'road', label: '012 路', coveredBy: ['builtin-mod3-road'] },
  { key: 'consec', label: '连号状态', coveredBy: ['builtin-consecutive'] },
  { key: 'ac', label: 'AC 值', coveredBy: [], hint: 'lib/factors.js:10 明示移交项；本模块①指纹②档案已编码该维度，候选假设可经 docs/32 §2 预注册通道进回测观察期（样本外+Bonferroni，零特权）' },
  { key: 'span', label: '跨度', coveredBy: [], hint: '本模块②档案已给跨度分位/极值区间；同上可预注册' },
]

/**
 * 聚合视图（§6.2③）：Markdown + JSON 同构产物。
 *   转移频次表 = 上一期和值档 → 下一期和值档（档界 = 本序列自身三分位数，无外来参数，确定性）；
 *   条件分位数 = 按上一期和值档分组的下一期和值分布（count/min/p50/p90/max）；
 *   因子覆盖盲区清单 = 内置因子未覆盖的状态维度（环 A 候选假设的目标区）。
 * 期数不足（<3）→ 表位显式注明「不产表不虚构」；空库 → count 0 零崩溃。BC-001 注记头尾常驻。
 */
export function aggregate(game, history) {
  assertGame(game)
  const asc = ascending(history)
  const feats = asc.map((e) => drawFeatures(game, e))
  const sums = feats.map((f) => f.sum)
  const latest = asc.length ? { issue: String(asc[asc.length - 1].issue), date: asc[asc.length - 1].date } : null

  let transitions = null
  let conditional = null
  if (sums.length >= 3) {
    const q33 = percentile(sums, 100 / 3)
    const q66 = percentile(sums, 200 / 3)
    const bandOf = (s) => (s <= q33 ? 'low' : s <= q66 ? 'mid' : 'high')
    const matrix = { low: mkRow(), mid: mkRow(), high: mkRow() }
    const cond = { low: [], mid: [], high: [] }
    for (let i = 0; i + 1 < asc.length; i++) {
      const from = bandOf(sums[i])
      matrix[from][bandOf(sums[i + 1])]++
      cond[from].push(sums[i + 1])
    }
    const rowPct = {}
    for (const from of BAND_KEYS) {
      const total = BAND_KEYS.reduce((a, k) => a + matrix[from][k], 0)
      rowPct[from] = {}
      for (const to of BAND_KEYS) rowPct[from][to] = total ? Math.round((matrix[from][to] / total) * 1000) / 10 : null
    }
    transitions = { variable: 'sum', bands: [...BAND_KEYS], cutpoints: { low: q33, mid: q66 }, pairs: asc.length - 1, matrix, rowPct }
    const sumByPrevBand = {}
    for (const from of BAND_KEYS) {
      sumByPrevBand[from] = cond[from].length
        ? { count: cond[from].length, min: percentile(cond[from], 0), p50: percentile(cond[from], 50), p90: percentile(cond[from], 90), max: percentile(cond[from], 100) }
        : null
    }
    conditional = { variable: 'sumByPrevBand', bands: sumByPrevBand }
  }

  const covered = FACTOR_DIMENSIONS.filter((d) => d.coveredBy.length)
  const uncovered = FACTOR_DIMENSIONS.filter((d) => !d.coveredBy.length)
  const g = GAMES[game]
  const L = []
  L.push(`# ${g.name} 聚合视图（探索性素材 · 无预测力声明）`)
  L.push(`> ${DISCLAIMER}`)
  L.push(`- 在库期数：${asc.length}${latest ? `（最新 ${latest.issue} @ ${latest.date}）` : '（空库）'}`)
  if (!transitions) {
    L.push('## 转移频次表 / 条件分位数')
    L.push('在库期数不足（需 ≥3 期才可按和值三分位分带）——不产表、不虚构。')
  } else {
    L.push(`## 转移频次表（上一期和值档 → 下一期和值档；档界=本表自身历史和值三分位：low≤${transitions.cutpoints.low}、mid≤${transitions.cutpoints.mid}）`)
    L.push('')
    L.push('| 上一期＼下一期 | 低(low) | 中(mid) | 高(high) | 行合计 |')
    L.push('| --- | ---: | ---: | ---: | ---: |')
    for (const from of BAND_KEYS) {
      const total = BAND_KEYS.reduce((a, k) => a + transitions.matrix[from][k], 0)
      const cells = BAND_KEYS.map((to) => `${transitions.matrix[from][to]}（${transitions.rowPct[from][to] == null ? '—' : `${transitions.rowPct[from][to]}%`}）`)
      L.push(`| ${BAND_LABEL[from]}(${from}) | ${cells.join(' | ')} | ${total} |`)
    }
    L.push(`（共 ${transitions.pairs} 组相邻期转移；括号=行百分比）`)
    L.push('')
    L.push('## 条件分位数（下一期和值分布 | 上一期和值档）')
    L.push('')
    L.push('| 上一期档 | 期数 | min | p50 | p90 | max |')
    L.push('| --- | ---: | ---: | ---: | ---: | ---: |')
    for (const from of BAND_KEYS) {
      const row = conditional.bands[from]
      L.push(row
        ? `| ${BAND_LABEL[from]}(${from}) | ${row.count} | ${row.min} | ${row.p50} | ${row.p90} | ${row.max} |`
        : `| ${BAND_LABEL[from]}(${from}) | 0 | — | — | — | — |`)
    }
  }
  L.push('')
  L.push('## 因子覆盖盲区清单（内置因子未覆盖的状态维度——环 A 候选假设的目标区）')
  L.push(`- 已覆盖：${covered.map((d) => `${d.label}（${d.coveredBy.join(' / ')}）`).join('；')}`)
  L.push(`- 盲区：${uncovered.map((d) => `**${d.label}**（${d.hint}）`).join('；')}`)
  L.push('（普查为静态登记：内置因子家族 id 前缀，实例化后缀 -<game>；新增因子加行即纯数据登记。路径已就绪：聚合视图上提假设 → factorize DSL → backtest 全量+样本外验证，零特权同流水线。）')
  L.push('')
  L.push(`> ${DISCLAIMER}`)
  const markdown = L.join('\n')
  return {
    game,
    count: asc.length,
    latest,
    markdown,
    json: {
      game,
      count: asc.length,
      latest,
      disclaimer: DISCLAIMER,
      transitions,
      conditional,
      blindSpots: {
        covered: covered.map((d) => ({ dimension: d.key, label: d.label, coveredBy: d.coveredBy })),
        uncovered: uncovered.map((d) => ({ dimension: d.key, label: d.label, hint: d.hint })),
      },
    },
  }
}
