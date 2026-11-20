/**
 * dsh-koi M3 记忆注入 RAG-lite（FR-028/029/030 / docs/33 §2.2 injector.js 行 + §4.4 失败语义）。
 *
 * 两块候选合成（FR-030）：
 *   ① 活跃因子块 = review.db factors（status ∈ observing/promoted）× attribution 近期命中行摘要；
 *   ② 局势块 = predictions.json 同彩种近 30 期逐期一行（期号/号码/vs 基线胜负）+ 最近 3 期 summary 摘要。
 *
 * 候选过滤纪律（BC-004 观察纪律注入面 / FR-030 原文 / docs/33 §4.2 环 A 引用规则）：
 *   demoted/retired 永不回注；candidate（环 A 提案因子）同样不入注入——未过观察期的假设连注入都不进
 *   （零特权纪律 proposal.js:10-12 精神延续）；引用因子 ID 必须在过滤后集合（防幻觉因子）。
 *   教训白名单子项延后（DC-013 lessons 表市场版未建——本批如实不虚构，教训块恒缺席，AC-027 断言面）。
 *
 * 失败语义（FR-031 / §4.4）：assemble 任何异常/空库 → { blocks: [], ok: false, note: '本期无记忆注入：<原因>' }
 * → orchestrator 照常编排（记忆层为空不阻塞出号）→ 条目 stamp injectionNote；单期不推送；
 * 连续 ≥2 期（per 彩种）→ health.js 触发器③告警（本批接线）。
 *
 * 缓存定位（FR-029 / AC-022 fixture）：注入所需全部内容可从 predictions.json + review.db 重建——
 * 本模块零自持缓存文件、零 LLM、纯本地只读聚合。
 *
 * 输出 = koi 自有独立中间格式 blocks（[{kind,text,estTokens}]，非 dsh-auto-memory 原生结构——AC-022 断言面）。
 * 依赖方向（docs/33 §2.3）：review/store.js（只读 listFactors/listAttribution）+ io.js（readPreds 注入），
 * 零 draws.js import（号码呈现用本地纯格式化——呈现文本非业务逻辑）。
 */
import { estTokens } from '../usage.js'

/** 注入候选合法状态集（BC-004：observing/promoted 之外一律排除——demoted/retired/candidate 永不回注） */
export const INJECTABLE_STATUS = ['observing', 'promoted']

/** 局势块回看期数（FR-030 原文「近 30 期局势」）与摘要条数（最近 3 期） */
export const SITUATION_TAIL = 30
export const SUMMARY_TAIL = 3

/** 号码呈现（纯文本化——呈现层非业务逻辑，不判奖不改动 picks 数据） */
function picksText(gameKey, picks) {
  if (!picks || typeof picks !== 'object') return '（无号）'
  if (Array.isArray(picks.red)) return `红 ${picks.red.map((n) => String(n).padStart(2, '0')).join(' ')}` + (picks.blue != null ? ` + 蓝 ${String(picks.blue).padStart(2, '0')}` : '')
  if (Array.isArray(picks.front)) return `前 ${picks.front.join(' ')}` + (Array.isArray(picks.back) ? ` + 后 ${picks.back.join(' ')}` : '')
  if (Array.isArray(picks.digits)) return Array.isArray(picks.digits[0])
    ? picks.digits.map((d) => d.join('-')).join(' / ')
    : picks.digits.join('-')
  return JSON.stringify(picks)
}

/**
 * 记忆注入器。readPreds/reviewStore 全部注入（FR-029：源=predictions.json+review.db 可重建）。
 */
export function createInjector({ reviewStore = null, readPreds = () => ({ entries: [] }), now = () => new Date(), log = () => {} } = {}) {
  /**
   * 组装注入块。返回 { blocks: [{kind, text, estTokens}], note, ok }——
   *   ok=true：blocks 可含 0~2 块（空库=0 块+ok=true+note 说明，属「无记忆可注」非失败）；
   *   ok=false：注入失败（FR-031 降级面）——blocks 恒空、note 如实（永不阻塞出号）。
   */
  function assemble({ gameKey, issue } = {}) {
    try {
      const blocks = []
      // ── ① 活跃因子块（BC-004 过滤 + attribution 命中摘要；零因子/零归因 → 块缺席如实）──────
      const factors = (reviewStore?.listFactors?.() ?? [])
        .filter((f) => INJECTABLE_STATUS.includes(f.status) && (f.game == null || f.game === gameKey))
      if (factors.length) {
        const lines = [`[因子战绩（探索性素材 · 无预测力声明；引用请标注因子 ID）]`]
        let cited = 0
        for (const f of factors) {
          const rows = (reviewStore?.listAttribution?.(f.id, 8) ?? []).filter((r) => r.game == null || r.game === gameKey)
          const judged = rows.filter((r) => r.hit != null)
          const hits = judged.filter((r) => r.hit === 1).length
          const recent = judged.slice(0, 3).map((r) => `${r.issue ?? r.date ?? '?'}:${r.hit === 1 ? '命中' : '未中'}`).join('，')
          lines.push(`- ${f.id}（${f.name} · ${f.status} · v${f.version}）：判定 ${judged.length} 次命中 ${hits}${recent ? `；最近 ${recent}` : '；暂无归因样本'}${rows.some((r) => r.detail) ? `；${(judged.find((r) => r.detail) ?? rows.find((r) => r.detail)).detail}` : ''}`)
          cited += 1
        }
        if (cited) blocks.push({ kind: 'factor-form', text: lines.join('\n'), estTokens: estTokens(lines.join('\n')) })
      }
      // ── ② 局势块（predictions.json 同彩种近 30 期逐期一行 + 最近 3 期 summary）────────────
      const all = (readPreds()?.entries ?? []).filter((e) => e?.kind === 'daily' && e?.game === gameKey)
      const tail = all.slice(-SITUATION_TAIL).slice().reverse()   // 最新在前
      if (tail.length) {
        const lines = [`[近 ${tail.length} 期档案局势（期号 | 我们的号 | vs 随机基线 | 战果）——探索性素材 · 无预测力声明]`]
        for (const e of tail) {
          const prize = Number(e.prize ?? 0)
          const base = e.baselinePrize != null ? Number(e.baselinePrize) : null
          lines.push(`- ${e.issue}（${e.date ?? '?'}）| ${picksText(gameKey, e.picks)} | 基线对照 ${base == null ? '未回填' : `${prize - base >= 0 ? '+' : ''}${prize - base} 元`} | ${e.settled && e.settleState === 'settled' ? (prize > 0 ? `中 ${prize} 元` : '未中奖（0 元）') : '未结清'}${e.via ? ` · via=${e.via}` : ''}`)
        }
        const summaries = tail.slice(0, SUMMARY_TAIL).filter((e) => String(e.summary ?? '').trim())
        if (summaries.length) lines.push('', '[最近摘要]', ...summaries.map((e) => `- ${e.issue}：${String(e.summary).trim().slice(0, 80)}`))
        blocks.push({ kind: 'situation', text: lines.join('\n'), estTokens: estTokens(lines.join('\n')) })
      }
      if (!blocks.length) {
        return { blocks: [], note: `本期无记忆注入：${gameKey} 无活跃因子且无档案条目（首期/空库——如实空注）`, ok: true }
      }
      return { blocks, note: null, ok: true, issue: issue ?? null }
    } catch (e) {
      // FR-031：任何异常 → 空 blocks + note 如实，永不阻塞出号
      log(`[koi] ${gameKey ?? '?'} 注入组装异常（照常出号，FR-031）：${String(e?.message ?? e).slice(0, 120)}`)
      return { blocks: [], note: `本期无记忆注入：${String(e?.message ?? e).slice(0, 100)}`, ok: false }
    }
  }

  /** 注入健康摘要（面板/health 消费）：候选集计数与过滤排除计数（BC-004 过滤面可观测） */
  function stats({ gameKey } = {}) {
    try {
      const fs0 = reviewStore?.listFactors?.() ?? []
      return {
        injectable: fs0.filter((f) => INJECTABLE_STATUS.includes(f.status) && (f.game == null || f.game === gameKey)).length,
        excluded: fs0.filter((f) => !INJECTABLE_STATUS.includes(f.status)).length,
        excludedReasons: Object.fromEntries(['candidate', 'demoted', 'retired'].map((s) => [s, fs0.filter((f) => f.status === s && (f.game == null || f.game === gameKey)).length])),
      }
    } catch { return { injectable: 0, excluded: 0, excludedReasons: {} } }
  }

  return { assemble, stats, INJECTABLE_STATUS, SITUATION_TAIL, SUMMARY_TAIL }
}
