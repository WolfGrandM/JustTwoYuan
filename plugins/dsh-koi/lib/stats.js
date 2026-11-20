/**
 * dsh-koi 统计层 —— 把最近 N 期开奖压缩成 AI 一眼能读的数据包。
 *
 * 纯函数：输入规范化的历史数组（见 fetch-draws.mjs），输出多行文本。
 * 统计口径（玩法味最浓、也是彩民最常用的三样）：
 *   · 遗漏值：这个号已经多少期没开出来了（0 = 上期刚开）
 *   · 频次：最近 N 期开了几次
 *   · 近 10 期流水：和值/奇偶比（双色球、大乐透）或三位流水（排列三）
 * 数据只是给「研究」当谈资 —— 不改变任何概率，提示词里也对她说明这点。
 *
 * 探索性素材注入段（收尾批 T1，docs/32 §6.2 注入面 v2，主人 2026-11-21 拍板=接；加法通道）：
 *   ①相似局势 top-3：insight.similar 检索历史上与「当前局势」最像的开奖前时刻，一行一条附后续开奖。
 *     防前视双保险——insight 构造级只返回严格早于目标期的命中，接线处（本文件 insightBlock）再断言一次，
 *     断言不过 → 整段不出（宁可缺不可泄）。
 *   ②当前局势分位行：insight.percentileRank 现算——当前和值与最罕见遗漏 cell 各处于历史多少分位
 *     （「当前蓝球遗漏 12 期 = 历史 89 分位」的罕见性客观度量）。
 *   数据不足（严格早于目标期的在库期 < INSIGHT_MIN_HISTORY）→ 整段省略降级，不硬凑；
 *   不传目标期号（issue）→ 两段都不出（旧调用面逐字节不变——快照变更仅限新增段）。
 *   BC-001 诚实条款：DISCLAIMER 常量常驻段尾——纯历史统计描述，不构成预测、不改变任何概率。
 */

import { similar, fingerprint, percentileRank, omissionSeriesByCell, mainNums, DISCLAIMER } from './insight.js'

const pad2 = (n) => String(n).padStart(2, '0')

/** 探索性素材最低在库期数（严格早于目标期；不足 → 整段省略，样本太小算出来的分位/距离全是噪声） */
const INSIGHT_MIN_HISTORY = 30
const INSIGHT_K = 3        // 相似局势 top-3（拍板定值）
const INSIGHT_CELLS = 3    // 最罕见遗漏 cell 展示个数（与相似 top-3 同宽，控 token）

/** 后续开奖摘要（一行一条的号码念法；p3/3d 与本文件流水行同款三位连写） */
function drawSummaryLine(gameKey, e) {
  if (gameKey === 'ssq') return `红 ${(e.red ?? []).map(pad2).join(' ')} + 蓝 ${pad2(e.blue)}`
  if (gameKey === 'dlt') return `前 ${(e.front ?? []).map(pad2).join(' ')} + 后 ${(e.back ?? []).map(pad2).join(' ')}`
  return (e.digits ?? []).map((d) => String(d)).join('')
}

/**
 * 探索性素材段（相似局势 top-3 + 当前局势分位）。返回多行文本；数据不足/无目标期 → null（整段省略）。
 * 全部输入取「严格早于目标期」的在库切片（防前视）；insight 侧纯函数现算，零落盘零 LLM。
 */
function insightBlock(gameKey, history, issue) {
  if (issue == null) return null
  const target = Number(issue)
  if (!Number.isFinite(target)) return null
  const asc = (Array.isArray(history) ? history : []).filter((e) => e && e.issue != null && Number(e.issue) < target)
  if (asc.length < INSIGHT_MIN_HISTORY) return null   // 数据不足：整段省略降级（不硬凑）
  const L = []
  // ① 相似局势 top-3（防前视接线断言：命中若混入 ≥ 目标期的条目 → 整段不出，宁可缺不可泄）
  const sim = similar(gameKey, asc, issue, INSIGHT_K)
  const hits = sim.hits ?? []
  const safeHits = hits.filter((h) => Number(h.issue) < target)
  if (safeHits.length !== hits.length) return null
  if (safeHits.length) {
    L.push(`【探索性素材 · 相似局势 top-${safeHits.length}】（历史上与当前局势最像的开奖前时刻，及其后续开奖）`)
    for (const h of safeHits) {
      L.push(`  第 ${h.issue} 期 @ ${h.date}（距离 ${Number(h.distance).toFixed(3)}）→ 后续开奖：${drawSummaryLine(gameKey, h.next)}`)
    }
  }
  // ② 当前局势分位行（当前和值 + 最罕见遗漏 cell 的历史分位；基线序列同取严格早于目标期的切片）
  const fp = fingerprint(gameKey, asc, issue)
  if (fp) {
    const sums = asc.map((e) => mainNums(gameKey, e).reduce((a, b) => a + Number(b), 0))
    const sumRank = percentileRank(sums, fp.last.sum)
    L.push('【探索性素材 · 当前局势分位】（当前局势在历史中的位置——罕见性客观度量）')
    L.push(`  当前和值 ${fp.last.sum}（最近一期）= 历史 ${sumRank == null ? '—' : Number(sumRank).toFixed(1)} 分位（≤该值占比，基线 ${asc.length} 期）`)
    const seriesByCell = omissionSeriesByCell(gameKey, asc)
    const ranked = Object.keys(seriesByCell)
      .map((c) => ({ c, cur: fp.omissions[c], rank: percentileRank(seriesByCell[c], fp.omissions[c]) }))
      .sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0) || b.cur - a.cur)
      .slice(0, INSIGHT_CELLS)
    L.push('  最罕见遗漏：' + ranked.map((x) => `${x.c} 遗 ${x.cur}=历史 ${x.rank == null ? '—' : Number(x.rank).toFixed(1)} 分位`).join('；'))
  }
  if (!L.length) return null
  L.push(`> ${DISCLAIMER}`)
  return L.join('\n')
}

/** 号序列（红球/前区）的遗漏 + 频次表 */
function omissionLines(numbers, max, draws, field) {
  // draws 按时间倒序（最新在前）
  const freq = new Map()
  const lastSeen = new Map()
  for (let i = 0; i < draws.length; i++) {
    // 蓝球/后区可能是单个数字而不是数组 —— 统一包一层
    const v = draws[i][field]
    for (const n of (Array.isArray(v) ? v : [v])) {
      freq.set(n, (freq.get(n) ?? 0) + 1)
      if (!lastSeen.has(n)) lastSeen.set(n, i)   // 倒序数组 → 第一次见到就是最近一次
    }
  }
  const lines = []
  for (let n = 1; n <= max; n++) {
    lines.push(`${pad2(n)}(遗${lastSeen.has(n) ? lastSeen.get(n) : draws.length}/频${freq.get(n) ?? 0})`)
  }
  // 按遗漏降序排个「最冷」Top，省得 AI 自己扫全表
  const cold = [...lastSeen.entries()]
    .filter(([n]) => freq.has(n))
    .map(([n, seen]) => ({ n, gap: seen }))
  for (let n = 1; n <= max; n++) if (!lastSeen.has(n)) cold.push({ n, gap: draws.length })
  cold.sort((a, b) => b.gap - a.gap)
  const coldText = cold.slice(0, 6).map((x) => `${pad2(x.n)}号已 ${x.gap} 期未开`).join('，')
  const hot = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([n, c]) => `${pad2(n)}(${c}次)`).join('，')
  return { lines, coldText, hotText: hot || '（样本不足）' }
}

function tailLines(draws, field, { sum }) {
  return draws.slice(0, 10).map((d) => {
    const nums = (d[field] ?? []).map(pad2).join(' ')
    if (sum) {
      const s = (d[field] ?? []).reduce((a, b) => a + Number(b), 0)
      const odd = (d[field] ?? []).filter((x) => x % 2 === 1).length
      const big = (d[field] ?? []).filter((x) => Number(x) > sum.bigAt).length
      return `  ${d.date} ${d.issue}：${nums}（和值${s}，奇偶${odd}:${(d[field] ?? []).length - odd}，大小${big}:${(d[field] ?? []).length - big}）`
    }
    return `  ${d.date} ${d.issue}：${nums}`
  })
}

/** 生成一份数据包文本（AI 提示词里直接拼）。issue=即将开奖的目标期号（注入探索性素材段用；缺省不出该段） */
export function dataPack(gameKey, history, { tailCount = 10, issue } = {}) {
  if (!Array.isArray(history) || !history.length) return '（历史数据抓取失败——今天凭感觉给一注合法号，并在 message 里说明数据没抓到）'
  // fetch-draws 保证倒序（最新在前）；保险起见这里再排一次
  const draws = history.slice().sort((a, b) => (a.date < b.date ? 1 : -1))
  const L = []
  L.push(`最近 ${draws.length} 期开奖（最新在前）：`)
  if (gameKey === 'ssq') {
    const red = omissionLines(null, 33, draws, 'red')
    L.push(`【红球遗漏/频次表】${red.lines.join(' ')}`)
    L.push(`【红球最冷】${red.coldText}`)
    L.push(`【红球最热】${red.hotText}`)
    const blue = omissionLines(null, 16, draws, 'blue')
    L.push(`【蓝球遗漏/频次表】${blue.lines.join(' ')}`)
    L.push('【红球近 10 期流水】')
    L.push(...tailLines(draws.slice(0, tailCount), 'red', { sum: { bigAt: 17 } }))
  } else if (gameKey === 'dlt') {
    const front = omissionLines(null, 35, draws, 'front')
    L.push(`【前区遗漏/频次表】${front.lines.join(' ')}`)
    L.push(`【前区最冷】${front.coldText}`)
    L.push(`【前区最热】${front.hotText}`)
    const back = omissionLines(null, 12, draws, 'back')
    L.push(`【后区遗漏/频次表】${back.lines.join(' ')}`)
    L.push('【前区近 10 期流水】')
    L.push(...tailLines(draws.slice(0, tailCount), 'front', { sum: { bigAt: 18 } }))
    L.push(`【后区近 ${Math.min(tailCount, draws.length)} 期】${draws.slice(0, tailCount).map((d) => (d.back ?? []).map(pad2).join(' ')).join(' / ')}`)
  } else {
    // 排列三：按位统计（百位/十位/个位各自 0–9 遗漏与频次）
    const posNames = ['百位', '十位', '个位']
    for (let p = 0; p < 3; p++) {
      const cells = []
      for (let d = 0; d <= 9; d++) {
        let gap = draws.length
        let freq = 0
        for (let i = 0; i < draws.length; i++) {
          const v = Number((draws[i].digits ?? [])[p])
          if (v === d) { freq++; if (gap === draws.length) gap = i }
        }
        cells.push(`${d}(遗${gap}/频${freq})`)
      }
      L.push(`【${posNames[p]}】${cells.join(' ')}`)
    }
    L.push(`【近 ${Math.min(tailCount, draws.length)} 期流水】${draws.slice(0, tailCount).map((d) => (d.digits ?? []).join('')).join(' ')}`)
  }
  // 探索性素材段（加法通道，收尾批 T1）：旧调用面（不传 issue）逐字节不变；快照变更仅限新增段
  const insight = insightBlock(gameKey, history, issue)
  return insight ? `${L.join('\n')}\n${insight}` : L.join('\n')
}
