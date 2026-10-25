/**
 * dsh-koi 今日策略建议（市场版 FR-1012/BC-109）—— 单 agent 路径三段：
 *   ① preregister：判据预注册（纯代码计算的结构性数据）先落盘 koi/advisory/<game>-<date>.json
 *      （preregisteredAt 早于建议产出，AC-111 时戳断言的数据源）
 *   ② generate：单次 LLM 调用 → 文件契约交卷 {recommendedTier, reasonFull}（沿 ADR-1，绝不解析自由文本）；
 *      reasonFull 全文入档案；正文恒带「建议不记账」+ 固定句「建议不会自动生效，换档请手动操作」；
 *      永不自动改正式档位——本模块不 import 任何配置写路径（modes.tier 写路径物理隔离，FZ-7/D-008）
 *   ③ recordOutcome：对账时记录 koi/advisory-outcomes.json（当期实际档 vs 建议档、实际/假想判奖，纯观测）
 *
 * 仅对 mode=auto 彩种生效（MC-12）；空账本退化「样本不足」；零概率宣称（BC-112，禁用词表过闸）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { readJson, writeJsonAtomic } from './io.js'
import { tiersForGame, judgeTier, randomTierPicks, tierStakes, tierById } from './tiers.js'
import { hasProbabilityClaim } from './render.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function createAdvisory({ dataDir, workDir, promptAgent, now = () => new Date(), log = () => {}, waitMs = 90_000, pollMs = 3_000 } = {}) {
  const ADV_DIR = path.join(dataDir ?? '.', 'advisory')
  const OUTCOMES_FILE = path.join(dataDir ?? '.', 'advisory-outcomes.json')
  const waitFileMs = waitMs

  const fileOf = (game, date) => path.join(ADV_DIR, `${game}-${date}.json`)
  const readAdvice = (game, date) => readJson(fileOf(game, date), null)

  async function waitJsonFile(p, timeoutMs = waitFileMs) {
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs) {
      try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { /* 还没写好 */ }
      await sleep(pollMs)
    }
    return null
  }

  /**
   * ① 预注册判据（§4.5）：判据 = 纯代码计算的结构性数据，先于建议产出落盘。
   * predictions = 预测档案（tier/cost/prize 已回填的条目，供按档聚合）。
   * 空账本（新用户）→ sampleNote='样本不足'，不编造战绩。
   */
  function preregister(game, date, { predictions = { entries: [] }, budgetLeft = null } = {}) {
    const tiers = tiersForGame(game)
    // 账本按实际档位聚合（predictions 条目带 tier stamp；对账后带 prize）
    const byTier = {}
    for (const e of (predictions.entries ?? [])) {
      if (e.game !== game || e.kind !== 'daily') continue
      const t = e.tier ?? '(v1 未标档)'
      const b = byTier[t] ?? (byTier[t] = { tier: t, draws: 0, invest: 0, prize: 0 })
      b.draws += 1
      b.invest += Number(e.cost ?? 0)
      b.prize += Number(e.prize ?? 0)
    }
    // 近 30 期建议假想战绩回算（对 advisory-outcomes 的代码回算）
    const outcomes = (readJson(OUTCOMES_FILE, { entries: [] }).entries ?? []).filter((o) => o.game === game).slice(-30)
    let advisedStat = { draws: 0, prize: 0, cost: 0 }
    for (const o of outcomes) {
      if (o.bothOutcome?.advised == null) continue
      advisedStat.draws += 1
      advisedStat.prize += Number(o.bothOutcome.advised.prize ?? 0)
      advisedStat.cost += Number(o.bothOutcome.advised.cost ?? 0)
    }
    const hasSample = Object.keys(byTier).length > 0 || advisedStat.draws > 0
    const criteria = {
      tierCosts: tiers.map((t) => ({ id: t.id, bets: t.bets, cost: t.cost })),
      ledgerPerTier: byTier,
      recentAdviceHitRate: hasSample ? advisedStat : null,
      sampleNote: hasSample ? undefined : '样本不足（新用户或暂无建议历史）——判据退化为档表成本权衡，不编造战绩',
      factorNote: '活跃因子战绩引用随 M3 接入',
      budgetLeft,
    }
    const rec = { preregisteredAt: now().toISOString(), game, date, criteria }
    const f = fileOf(game, date)
    writeJsonAtomic(f, rec)   // mkdir 由 writeJsonAtomic 承担
    return { file: f, ...rec }
  }

  /**
   * ② 生成建议：单次 LLM 调用（判据 JSON + 档表 + 预算余量入提示词）→ 文件契约交卷。
   * recommendedTier 必须是该彩种档表内的档；reasonFull 零概率宣称（禁用词表过闸，违者拒用并如实标注）。
   * 结果追加写回判据档案（generatedAt 晚于 preregisteredAt——AC-111）。
   */
  async function generate(game, date, prereg, { budgetLeft = null } = {}) {
    if (typeof promptAgent !== 'function') throw new Error('advisory 需要 promptAgent（宿主会话不可用）')
    const tiers = tiersForGame(game)
    const outPath = path.join(workDir ?? '.', `advisory-${game}-${date}.json`)
    try { fs.rmSync(outPath, { force: true }) } catch {}
    const prompt = [
      '【任务】今天是 ' + date + '。你是锦鲤的「今日策略建议」环节：只对投注档位（不选号）给一条建议。',
      '',
      '【预注册判据（结构性数据，代码已算好，供你引用）】',
      JSON.stringify(prereg.criteria, null, 2),
      '',
      '【本彩种可选档位】',
      ...tiers.map((t) => `  ${t.id}：${t.label}，${t.bets} 注 / ${t.cost} 元`),
      budgetLeft != null ? `【本周预算余量（估算）】约 ${Math.round(budgetLeft)} tokens` : '',
      '',
      '【交卷方式 —— 最重要的部分】',
      `把结果用 shell 写进这个文件（合法 JSON，字段一个不能少）：${outPath}`,
      `  {"schemaVersion":1,"game":"${game}","date":"${date}","recommendedTier":"<档位 id>","reasonFull":"给主人的完整理由（200 字内）"}`,
      '硬性规则：',
      '  · recommendedTier 必须是上面档位表里的 id，别的一个字都不认；',
      '  · reasonFull 零概率宣称：不得出现「提高/增加/提升中奖概率、胜率」类表述——开奖是独立随机事件；',
      '  · 理由只能引用判据数据（成本权衡/历史战绩/预算余量），不得编造数据；',
      '  · 写完文件就收工：不要发任何消息、不要动这个文件之外的东西。',
    ].filter(Boolean).join('\n')
    await promptAgent(prompt)
    const raw = await waitJsonFile(outPath)
    try { fs.rmSync(outPath, { force: true }) } catch {}
    if (!raw || typeof raw !== 'object') return { ok: false, error: '建议交卷文件没等到（本轮跳过，不影响正式预测）' }
    const t = tierById(raw.recommendedTier)
    if (!t || t.game !== game) return { ok: false, error: `建议档位不在档表：${raw.recommendedTier}（拒用）` }
    const reasonFull = String(raw.reasonFull ?? '').trim()
    if (!reasonFull) return { ok: false, error: 'reasonFull 为空（拒用）' }
    if (hasProbabilityClaim(reasonFull)) return { ok: false, error: 'reasonFull 含概率宣称（禁用词），拒用并如实标注' }
    const gen = { recommendedTier: t.id, reasonFull, generatedAt: now().toISOString() }
    writeJsonAtomic(prereg.file ?? fileOf(game, date), { ...prereg, ...gen })
    return { ok: true, ...gen, file: prereg.file ?? fileOf(game, date) }
  }

  /**
   * ③ 对照观测（纯观测）：对账时记录当期「实际档 vs 建议档」双方结果。
   * advised 假想 = 建议档下的一注随机号按同期开奖判奖（口径固定记录在案；回算依据 outcomes 而非重摇）。
   */
  function recordOutcome(game, issue, { actualTier, actualPicks, actualJudged, advisedTier, result }) {
    const store = readJson(OUTCOMES_FILE, { schemaVersion: 1, entries: [] })
    const advised = tierById(advisedTier)
    const hypothetical = advised && result
      ? (() => {
          const picks = randomTierPicks(advised)
          const j = judgeTier(advised, picks, result, result.prizeGrades ?? null)
          const s = tierStakes(advised)
          return { picks, prize: j.money, cost: s.cost, note: '假想：建议档一注随机号按同期开奖判奖' }
        })()
      : null
    store.entries.push({
      at: now().toISOString(), game, issue,
      advisedTier: advisedTier ?? null, actualTier: actualTier ?? null,
      bothOutcome: {
        actual: actualJudged ? { prize: Number(actualJudged.money ?? 0), cost: null, picks: actualPicks ?? null } : null,
        advised: hypothetical,
      },
    })
    store.schemaVersion = 1
    writeJsonAtomic(OUTCOMES_FILE, store)
    return store
  }

  return { preregister, generate, recordOutcome, readAdvice, fileOf, OUTCOMES_FILE }
}
