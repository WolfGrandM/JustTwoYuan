/**
 * dsh-koi 环 A 探索性提案引擎（收尾批 T2 / docs/32 §6.2③ 聚合视图→提案接口的 LLM 面）。
 *
 * 流水线（月报生成时点内、buildReport 之前跑一段）：
 *   mind.enabled 门控 → narrate 三闸同款护栏（cap/开关/错峰）→ 输入=insight.aggregate 全量在库
 *   聚合视图（含因子覆盖盲区清单——候选假设的目标区）→ LLM 提案 K=3 候选 →
 *   **每个候选必须过 factorize DSL 校验**（不合法即丢弃并如实记录，不静默不硬凑）→
 *   落提案表 factor_proposals（提案时刻/依据数据血统/观察期起点）→ 进因子库 candidate 态。
 *
 * 零特权纪律（任务书原文）：提案因子与卡片因子/内置因子走同一条月报检验流水线——样本外回测 +
 * Bonferroni×受检数 + 月度晋升上限 + 24h 否决窗，不存在任何加权旁路；candidate→observing 入观察
 * （store.js LEGAL_EDGES 保留边）由下一期月报流水线按「观察期起点」统一执行（monthly.js runPipeline ⓪）。
 *
 * 输入面（血统诚实）：聚合只喂 factorize DSL 白名单彩种（ssq/dlt/p3——validateFactorSpec :101 权威；
 * 3d 暂无 DSL 表达面，喂了也必被拒，浪费 K=3 预算——如实不喂，不静默扩面）。
 *
 * BC-001 诚实条款：提案是「探索性假设」，聚合视图是历史统计描述——都不构成预测、不改变任何概率；
 * 提示词与月报段两处常驻声明。计量（BC-013）：输入侧由注入的 promptAgent 记（activity='review'）；
 * 输出侧本模块再记一笔（同一 activity，est 恒标）。cap 态（allowLLM=false）→ 提案段整体跳过（零 LLM），
 * 月报缺席如实报告（narrate.js:66 同款护栏）。
 */
import path from 'node:path'
import fs from 'node:fs'
import { waitJsonFile, randSuffix } from '../fspoll.js'
import { estTokens } from '../usage.js'
import { validateFactorSpec, METRICS } from '../factorize.js'
import { aggregate, DISCLAIMER } from '../insight.js'
import { inOffpeakWindow } from '../backfill.js'

export const PROPOSAL_K = 3                                  // 拍板：环 A 提案预算 K=3（复用 usage review 桶既有周预算硬顶）
const PROPOSAL_GAMES = ['ssq', 'dlt', 'p3']                  // DSL 白名单彩种（factorize.js validateFactorSpec :101 同域）
const PROPOSAL_WAIT_MS = 10 * 60_000
const PROPOSAL_POLL_MS = 3_000

/** 下一个月报期（观察期起点）：2026-11 → 2026-12；2026-12 → 2027-01（跨年） */
export function nextPeriodOf(period) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(period ?? ''))
  if (!m) throw new Error(`period 要是 yyyy-mm：${period}`)
  const y = Number(m[1])
  const mon = Number(m[2])
  return mon === 12 ? `${y + 1}-01` : `${y}-${String(mon + 1).padStart(2, '0')}`
}

/** 提案提示词（文件契约，与 narrate/factorize 同款交卷形态） */
export function buildProposalPrompt({ sections, outPath, k = PROPOSAL_K }) {
  return [
    `【任务】你是「锦鲤」的因子提案员（环 A 数据面）。下面是各彩种的聚合视图（探索性素材 · 无预测力声明）——转移频次表/条件分位数/因子覆盖盲区清单。你在聚合视图上提出至多 ${k} 个候选假设（因子规格），交由预注册观察期验证。`,
    '',
    '【聚合视图（依据数据血统=insight.aggregate 全量在库现算）】',
    ...sections,
    '',
    '【DSL 规格（唯一合法表达面——不合规格的提案会被代码校验拒收并如实记录）】conditions 为 AND 组合（非空数组），每条形如：',
    '  {"metric":"<白名单指标>","op":"eq|ne|gte|lte|in","value":<整数>}   // op=in 时用 "range":[lo,hi]',
    '  {"metric":"blueIn","op":"in","set":[1,2,3]}                       // 仅 ssq 蓝球',
    `【metric 白名单】${Object.entries(METRICS).map(([key, v]) => `${key}=${v.desc}`).join('；')}`,
    '【game 白名单】ssq / dlt / p3（3d 暂无 DSL 表达面，不提案）',
    '【合规示例】{"schemaVersion":1,"proposals":[{"game":"ssq","name":"高和值区假设","rationale":"转移表显示上期高和值档下期…（≤100字，引用聚合视图数字）","spec":{"game":"ssq","conditions":[{"metric":"sum","op":"in","range":[120,160]}]},"claimHuman":"上一期和值……"}]}',
    '【越界反例（会被拒收）】{"metric":"acValue","op":"gte","value":8}——acValue 不在白名单；只有白名单指标可用，别的值一律校验拒收。',
    '',
    '【纪律（常驻）】',
    '  · 开奖是独立随机事件：你的提案是「探索性假设」，不构成预测、不改变任何概率；聚合视图仅是历史统计描述；',
    '  · 零特权：提案因子与全部因子走同一条月报检验流水线（样本外+Bonferroni+月度上限+否决窗），无任何加权旁路；',
    `  · 盲区维度（见各聚合视图「因子覆盖盲区清单」）是候选假设的目标区；白名单外的指标一律被拒收——宁缺毋滥，至多 ${k} 个。`,
    '【无法表达时】如实交 {"schemaVersion":1,"proposals":[],"unparseable":true}（诚实承认提不出，不要硬凑）。',
    '',
    '【交卷方式 —— 最重要的部分】',
    `用 shell 把结果写进这个文件（合法 JSON）： ${outPath}`,
    '写完文件就收工：不要发任何消息、不要动这个文件之外的东西。',
  ].join('\n')
}

/**
 * 环 A 探索性提案引擎。run({ period }) →
 *   { ok:true, period, accepted:[{factorId,game,name,claim,duplicate?}], rejected:[{game,name,errors}], observeFrom, at, lineage, note? }
 * | { ok:false, skipped:'mind-disabled'|'cap'|'narrative-off'|'offpeak'|'no-data'|'llm-error'|'no-file', reason }
 */
export function createProposalEngine({
  store,
  promptAgent,
  usage = null,
  readCfg = () => ({}),
  budgetState = null,
  now = () => new Date(),
  workDir = '.',
  log = () => {},
  historyOf = null,          // (game) => 在库条目数组（最新在前即可，insight 内部升序整理）；缺省按无数据处理
  waitMs = PROPOSAL_WAIT_MS,
  pollMs = PROPOSAL_POLL_MS,
  stopCheck = () => false,
} = {}) {
  if (typeof promptAgent !== 'function') throw new Error('createProposalEngine 缺 promptAgent 注入')
  try { fs.mkdirSync(workDir, { recursive: true }) } catch { /* 目录在位即可 */ }

  async function run({ period }) {
    const cfg = readCfg()
    const skip = (code, reason) => ({ ok: false, skipped: code, reason })
    // ① mind.enabled 门控（任务书：提案段 mind.enabled 门控——CLI 手动月报旁路 mind 闸，不旁路本段）
    if (cfg?.mind?.enabled !== true) return skip('mind-disabled', 'mind 未启用（探索性提案段不运行）')
    // ② cap 态（BC-013，narrate 三闸同款①）：预算触顶 → 提案段整体跳过（零 LLM），月报缺席如实报告
    let demo = null
    try { demo = budgetState ? budgetState(cfg)?.demo ?? null : null } catch { /* 预算面异常按可提案处理 */ }
    if (demo && demo.allowLLM === false) return skip('cap', '预算触顶 · 探索性提案暂停（BC-013）')
    // ③ 显式开关（narrate 三闸同款②）：review.narrative=false 一并停提案（同一 LLM 预算面）
    if (cfg?.review?.narrative === false) return skip('narrative-off', 'review.narrative 已关闭')
    // ④ 错峰守卫（narrate 三闸同款③）：月报 23:45 天然窗外；CLI 手动路径窗内拒调
    if (inOffpeakWindow(now())) return skip('offpeak', '错峰窗口（17:00–22:30）内不调用提案 LLM（BC-012）')

    // ⑤ 聚合视图输入（全量在库现算；血统落提案表）——DSL 白名单彩种
    const lineage = { basis: 'insight.aggregate（全量在库现算，docs/32 §6.2③）', games: {} }
    const sections = []
    for (const g of PROPOSAL_GAMES) {
      let hist = null
      try { hist = historyOf ? historyOf(g) : null } catch { hist = null }
      if (!Array.isArray(hist) || !hist.length) continue
      const agg = aggregate(g, hist)
      lineage.games[g] = {
        count: agg.count,
        latest: agg.latest,
        pairs: agg.json.transitions?.pairs ?? null,
        blindSpots: agg.json.blindSpots.uncovered.map((u) => u.dimension),
      }
      sections.push(agg.markdown)
    }
    if (!sections.length) return skip('no-data', '本地库为空（ssq/dlt/p3 均无在库历史）——无可供聚合的数据')

    // ⑥ LLM 提案（K=3，文件契约）
    const outPath = path.join(workDir, `proposals-${period}-${Date.now()}-${randSuffix()}.json`)
    try { fs.rmSync(outPath, { force: true }) } catch {}
    try {
      await promptAgent(buildProposalPrompt({ sections, outPath, k: PROPOSAL_K }))
    } catch (e) {
      return skip('llm-error', `LLM 调用失败：${String(e?.message ?? e).slice(0, 120)}`)
    }
    const raw = await waitJsonFile(outPath, { timeoutMs: waitMs, pollMs, stopCheck })
    if (!raw) return skip('no-file', '提案交卷超时或不可解析（未等到合法 JSON）——提案段缺席如实报告')
    try { usage?.record?.('review', estTokens(JSON.stringify(raw))) } catch { /* 计量尽力而为 */ }

    const at = now().toISOString()
    const cands = Array.isArray(raw?.proposals) ? raw.proposals.slice(0, PROPOSAL_K) : []
    if (raw?.unparseable === true || !cands.length) {
      // LLM 如实申报提不出 / 零候选：一条空轮记录（诚实不虚构），不落因子
      store.recordProposal({ period, status: 'rejected-dsl', name: null, game: null, claim: null, spec: null,
        errors: ['LLM 零候选或如实申报不可表达（unparseable）——空轮如实记录'], lineage, observeFrom: null, at })
      log(`[koi] 探索性提案 ${period}：LLM 零候选（如实记录空轮）`)
      return { ok: true, period, accepted: [], rejected: [], observeFrom: null, at, lineage, note: 'LLM 未给出可校验候选（unparseable 如实申报或零候选）' }
    }

    const observeFrom = nextPeriodOf(period)
    const accepted = []
    const rejected = []
    for (const [i, c] of cands.entries()) {
      const name = String(c?.name ?? '').trim().slice(0, 20) || '（未命名提案）'
      const game = String(c?.spec?.game ?? c?.game ?? '')
      const claim = String(c?.claimHuman ?? '').trim()
      const v = validateFactorSpec(c?.spec ?? null, {})
      if (!v.ok) {
        store.recordProposal({ period, factorId: null, game, name, claim, spec: JSON.stringify(c?.spec ?? null),
          status: 'rejected-dsl', errors: JSON.stringify(v.errors), lineage, observeFrom: null, at })
        rejected.push({ game, name, errors: v.errors })
        log(`[koi] 探索性提案 ${period} 候选 ${i + 1} DSL 拒收（如实记录）：${(v.errors ?? []).join('；')}`)
        continue
      }
      const factorId = `proposal-${period}-${v.factor.game}-${i + 1}`   // 确定性 id：重跑幂等（不产生第二份因子）
      const add = store.addCandidateFactor({
        id: factorId, game: v.factor.game, name, source: `proposal:${period}`,
        specRef: JSON.stringify(c?.spec ?? null), p0: null,
      })
      if (add.ok === false && add.duplicate) {
        accepted.push({ factorId, game: v.factor.game, name, claim, duplicate: true })   // 重跑幂等：因子已在库
        continue
      }
      store.recordProposal({ period, factorId, game: v.factor.game, name, claim, spec: JSON.stringify(c?.spec ?? null),
        status: 'accepted', errors: null, lineage, observeFrom, at })
      accepted.push({ factorId, game: v.factor.game, name, claim })
      log(`[koi] 探索性提案 ${period} 候选 ${i + 1} 落库：${factorId}（candidate 态，观察期起点 ${observeFrom}）`)
    }
    return { ok: true, period, accepted, rejected, observeFrom, at, lineage }
  }

  return { run, PROPOSAL_K, nextPeriodOf, DISCLAIMER }
}
