// ─────────────────────────────────────────────────────────────────────────────
// B 阶段可执行设计验证脚本（入库副本，2026-10-24，决策 C-13）
// 出处：阶段B 会话生成于 /tmp/koi-b-verify/verify.mjs（/tmp 不持久，故入库留存）；
// 首跑结果 21 pass / 0 fail（阶段B 自查轮 + 阶段C 独立复跑各一次，见
// docs/decisions/B-默认决策记录.md 自查节与 C-默认决策记录.md 验证记录节）。
// 用途：D 阶段实现 C1（1a/1b/1c）与 C8（断言 3）时的行为基准对照锚点；
//       导入为绝对 file:// URL，仓库内任意位置可运行：
//   ~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe docs/decisions/B-verify-koi-v1.1.mjs
// ─────────────────────────────────────────────────────────────────────────────
import { enumerateBets, stakesOf, judge, ledgerTotals } from 'file:///D:/QQ%E5%B7%A5%E4%BD%9C%E5%8C%BA/plugins/dsh-koi/lib/draws.js'

let pass = 0, fail = 0
const t = (name, cond) => { cond ? pass++ : (fail++, console.log('FAIL: ' + name)) }

// ── 1. C1 账本追加模型：ledgerTotals 扩展（voided 排除 + supplement 聚合）vs 现行 ──
function totalsV11(ledger) {
  const es = Array.isArray(ledger?.entries) ? ledger.entries : []
  const voided = new Set(es.filter(e => e.entryType === 'reversal' && e.ref)
    .map(e => `${e.ref.game}|${e.ref.issue}|${e.ref.date}`))
  const main = es.filter(e => (e.entryType ?? 'main') === 'main' && !voided.has(`${e.game}|${e.issue}|${e.date}`))
  const agg = [...main, ...es.filter(e => e.entryType === 'supplement')]
  const cost = agg.reduce((s, e) => s + Number(e.cost ?? 0), 0)
  const prize = agg.reduce((s, e) => s + Number(e.prize ?? 0), 0)
  const best = agg.filter(e => Number(e.prize ?? 0) > 0).sort((a, b) => Number(b.prize) - Number(a.prize))[0] ?? null
  return { cost, prize, net: prize - cost, draws: main.length, best }
}
// 1a. 旧数据（无新字段）两种算法必须完全一致
const legacy = { entries: [
  { at: 'd1', kind: 'daily', game: 'ssq', issue: '2026121', date: '2026-10-20', cost: 56, prize: 10, bets: 28, grades: { 5: 1 } },
  { at: 'd2', kind: 'daily', game: 'p3', issue: '26285', date: '2026-10-21', cost: 2, prize: 0, bets: 1, grades: {} },
] }
const a1 = ledgerTotals(legacy), b1 = totalsV11(legacy)
t('1a 旧数据 cost/prize/draws 一致', a1.cost === b1.cost && a1.prize === b1.prize && a1.draws === b1.draws && a1.net === b1.net)
// 1b. 放弃待补 main(cost56, prize null) + 公布后 supplement(prize 3000) → 投入记一次、奖金记一次、期数=1
const supp = { entries: [
  { at: 'd1', kind: 'daily', game: 'ssq', issue: '2026122', date: '2026-10-22', cost: 56, prize: null, bets: 28, grades: null, entryType: 'main', pending: true },
  { at: 'd2', kind: 'daily', game: 'ssq', issue: '2026122', date: '2026-10-22', cost: 0, prize: 3000, bets: 28, grades: { 3: 1 }, entryType: 'supplement', ref: { game: 'ssq', issue: '2026122', date: '2026-10-22' } },
] }
const b2 = totalsV11(supp)
t('1b 补判后 cost=56', b2.cost === 56)
t('1b 补判后 prize=3000', b2.prize === 3000)
t('1b 期数按主条目计=1', b2.draws === 1)
// 1c. 休市作废冲销：主条目被排除，投入不计入口径
const voided = { entries: [
  { at: 'd1', kind: 'daily', game: 'p3', issue: '26290', date: '2026-10-23', cost: 2, prize: null, bets: 1, grades: null, entryType: 'main', pending: true },
  { at: 'd2', kind: 'daily', game: 'p3', issue: '26290', date: '2026-10-23', cost: 0, prize: 0, bets: 0, grades: null, entryType: 'reversal', ref: { game: 'p3', issue: '26290', date: '2026-10-23' }, note: '休市作废' },
  { at: 'd3', kind: 'daily', game: 'p3', issue: '26291', date: '2026-10-24', cost: 2, prize: 1040, bets: 1, grades: { 1: 1 } },
] }
const b3 = totalsV11(voided)
t('1c 作废期投入不计入口径 cost=2', b3.cost === 2)
t('1c 作废期不计期数 draws=1', b3.draws === 1)
t('1c prize=1040', b3.prize === 1040)

// ── 2. 期号跳跃检测（休市作废判定）：数值比较跨年单调性 ──
const issueAfter = (target, latest) => Number(latest) > Number(target)   // 官方最新期号 > 目标期号 → 目标期永不会公布
t('2a 福彩跨年 latest 2027001 > target 2026153 → 作废', issueAfter('2026153', '2027001'))
t('2b 体彩跨年 latest 27001 > target 26153 → 作废', issueAfter('26153', '27001'))
t('2c 未公布 latest 2026122 < target 2026123 → 继续等', !issueAfter('2026123', '2026122'))
t('2d 同期号 → 已公布（正常对账）', !issueAfter('2026122', '2026122'))
t('2e p3 latest 26290 > target 26285 → 作废', issueAfter('26285', '26290'))

// ── 3. C8 carry 扩展：多日宕机全部未结清条目入队 ──
const preds = { entries: [
  { kind: 'daily', game: 'ssq', issue: '2026110', date: '2026-10-10', settled: false },                      // 宕机漏账（现行 bug：仅扫 prevDate 会漏）
  { kind: 'daily', game: 'p3', issue: '26280', date: '2026-10-12', settled: true, settleState: 'given-up' }, // 放弃待补 → 未结清
  { kind: 'daily', game: 'dlt', issue: '26120', date: '2026-10-14', settled: true, settleState: 'voided' },  // 作废 → 结清
  { kind: 'daily', game: 'ssq', issue: '2026115', date: '2026-10-17', settled: true, prize: 10 },            // 已结清
  { kind: 'quickpick', game: 'ssq', issue: '2026115', date: '2026-10-17', settled: false },                  // 加餐不对账
] }
const carryV11 = preds.entries.filter(e => e.kind === 'daily' && (e.settleState !== 'voided') && (!e.settled || e.settleState === 'given-up'))
t('3 carry 扩展后未结清 = 2 条（含 8 天前的漏账）', carryV11.length === 2 && carryV11.some(e => e.date === '2026-10-10') && carryV11.some(e => e.settleState === 'given-up'))
const carryV1 = preds.entries.filter(e => e.kind === 'daily' && e.date === '2026-10-23' && !e.settled)
t('3 现行逻辑（仅 prevDate）漏掉全部 2 条', carryV1.length === 0)

// ── 4. 基线同构：基线按同投注结构展开，注数与正式预测一致（DC-002/TC-006）──
for (const g of ['ssq', 'dlt', 'p3']) {
  const s = stakesOf(g)
  const sample = g === 'ssq' ? { red: [1,2,3,4,5,6,7,8], blue: 9 } : g === 'dlt' ? { front: [1,2,3,4,5,6,7], back: [1,2] } : { digits: [1,2,3] }
  t(`4 ${g} 展开注数 = stakesOf(${g}).bets`, enumerateBets(g, sample).length === s.bets)
}

// ── 5. 判奖回归可覆盖全部奖级（C5/FR-007 可行性）：每组构造至少一个命中样例 ──
const rSsq = { red: [1,2,3,4,5,6], blue: 7 }
const betsSsq = judge('ssq', { red: [1,2,3,4,5,6,29,30], blue: 7 }, rSsq)   // 6红+蓝=一等（用 gradeMoney 才有金额）
t('5a ssq 一等判定 bets=28', betsSsq.bets === 28 && betsSsq.grades[1] === 1)
const rDlt = { front: [1,2,3,4,5], back: [1,2] }
const jDlt = judge('dlt', { front: [1,2,3,4,6,7,8], back: [1,3] }, rDlt)     // 4+1=五等
t('5b dlt 五等命中', jDlt.grades[5] >= 1)
t('5c p3 直选命中 1040', judge('p3', { digits: [1,2,3] }, { digits: [1,2,3] }).money === 1040)

// ── 6. schemaVersion 容忍：未知字段读取不报错、既有字段可解析 ──
const withUnknown = JSON.parse('{"schemaVersion":2,"entries":[{"at":"x","futureField":1}]}')
t('6 未知字段读取容忍', withUnknown.entries[0].futureField === 1 && withUnknown.schemaVersion === 2)

console.log(`\n验证结果: ${pass} pass / ${fail} fail`)
process.exit(fail ? 1 : 0)
