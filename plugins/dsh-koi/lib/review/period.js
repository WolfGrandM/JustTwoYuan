/**
 * dsh-koi 周期账本口径切片（M4 T1 / docs/28 §2.1 period.js，BC-006 账本唯一口径）。
 *
 * BC-006：周报/月报战绩数字唯一来源 = ledger.json + ledgerTotals（draws.js:281-296）；
 * 报告不读 predictions.json 的 prize 作账面。本函数「只做时间窗过滤」，聚合公式与
 * ledgerTotals 同源——直接复用 ledgerTotals 本体（同源实现而非镜像拷贝，杜绝两处漂移；
 * §2.4 依赖方向允许 lib/review/* → draws.js 纯函数）。
 *
 * 时间窗按条目 `date`（开奖日 'YYYY-MM-DD'）字典序闭区间 [from, to]；from/to 缺省 = 不限。
 * 窗内 voided 排除与 main/supplement 口径全部继承 ledgerTotals（reversal 与其 main 同窗时
 * 冲销语义与全量一致；跨窗冲销属窗切片固有边界，周报健康节如实显示、月报读全量终态兜底）。
 */
import { ledgerTotals } from '../draws.js'

/**
 * 周期账本切片聚合。
 * @param {Array} entries ledger.json 的 entries（原样传入，不挑拣）
 * @param {string} [from] 'YYYY-MM-DD' 起始（含）
 * @param {string} [to]   'YYYY-MM-DD' 截止（含）
 * @returns {{cost, prize, net, draws, best}} 形状与 ledgerTotals 逐字段一致
 */
export function periodLedgerSlice(entries, from, to) {
  const inWindow = (Array.isArray(entries) ? entries : []).filter((e) => {
    const d = e?.date == null ? '' : String(e.date).slice(0, 10)
    if (!d) return false   // 无 date 的条目不落任何周期（如实：不入窗也不入全周期口径）
    if (from && d < String(from)) return false
    if (to && d > String(to)) return false
    return true
  })
  return ledgerTotals({ entries: inWindow })
}
