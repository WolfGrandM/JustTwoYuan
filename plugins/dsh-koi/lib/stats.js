/**
 * dsh-koi 统计层 —— 把最近 N 期开奖压缩成 AI 一眼能读的数据包。
 *
 * 纯函数：输入规范化的历史数组（见 fetch-draws.mjs），输出多行文本。
 * 统计口径（玩法味最浓、也是彩民最常用的三样）：
 *   · 遗漏值：这个号已经多少期没开出来了（0 = 上期刚开）
 *   · 频次：最近 N 期开了几次
 *   · 近 10 期流水：和值/奇偶比（双色球、大乐透）或三位流水（排列三）
 * 数据只是给「研究」当谈资 —— 不改变任何概率，提示词里也对她说明这点。
 */

const pad2 = (n) => String(n).padStart(2, '0')

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

/** 生成一份数据包文本（AI 提示词里直接拼） */
export function dataPack(gameKey, history, { tailCount = 10 } = {}) {
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
  return L.join('\n')
}
