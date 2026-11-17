/**
 * dsh-koi 健康告警扫描（M4 T2 / docs/28 §2.1 health.js，FR-033 市场版映射 + §9-R2）。
 *
 * 触发器映射表（改表即换口径——§9-R2 默认处置）：
 *   ① 档位连续 3 期低于计划档位 → **N/A**（stamp 无计划档位字段——DC-001 计划档位是 M3 编排器
 *      产物，effortTier 是 token 努力档不可混用；随 M3 接入补 stamp.plannedTier 后启用）
 *   ② 兜底连续 3 期 → 按条目 via='fallback' 映射（可计算）
 *   ③ 注入连续失败 ≥2 期 → 「LLM 通道连续异常」= ingest pending-llm ≥2 任务 或 no-model 错误
 *      彩种数 ≥2（signals 注入——state/ingest 不在 readPreds 数据源内，由 scheduler 提供）
 * 本地可验子集（FR-049，AC-025/B-24）：未结清 = given-up 且 >7 天才报红；voided 只列历史累计、无阈值；
 * 新鲜度复用 isStaleDraw（settle-core.js:129-135 单点）。
 *
 * TF-6：告警 = review 事件（panelOnly，level warn），静默进面板事件列表，不推 QQ。
 * 全部数字与告警触发判定零 LLM（§5 禁止清单 3）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { readJson, writeJsonAtomic } from '../io.js'
import { isStaleDraw } from '../settle-core.js'
import { EFFORT_ORDER } from '../usage.js'

const STALE_DAYS = 7            // B-24：未结清报红线（given-up 且 >7 天）
const FALLBACK_STREAK = 3       // 触发器②：连续 3 期兜底
const LLM_PENDING_MIN = 2       // 触发器③：pending-llm ≥2 任务
const NO_MODEL_GAMES_MIN = 2    // 触发器③：no-model 错误彩种数 ≥2

const effortIdx = (t) => EFFORT_ORDER.indexOf(t)

/**
 * 健康扫描（纯判定，零副作用）。
 * @param {object} p
 * @param {() => {entries}} p.readPreds predictions.json 读取器
 * @param {() => object} [p.readCfg] 配置读取器
 * @param {object} [p.store] review store（接口占位：T4 六项体检扩展落点；本子集不读）
 * @param {string} p.today 'YYYY-MM-DD'
 * @param {{pendingLlm?:number, noModelGames?:number}} [p.signals] LLM 通道信号（scheduler 注入）
 * @param {Array<{week:string,total:number}>} [p.usageWeeks] 近 4 周用量汇总（usage tracker 口径，DC-011）
 * @returns {{items:Array<{name,ok,detail}>, alerts:Array<{type,level,detail}>}}
 */
export function scanHealth({ readPreds, readCfg = () => ({}), store = null, today, signals = {}, usageWeeks = [] } = {}) {
  const entries = (readPreds()?.entries ?? []).filter((e) => e?.kind === 'daily')
  const settled = entries.filter((e) => e.settled && e.settleState === 'settled')
  const givenUp = entries.filter((e) => e.settleState === 'given-up')
  const voided = entries.filter((e) => e.settleState === 'voided')
  const items = []
  const alerts = []

  // ① 满配率 → N/A（M3 未建，如实标注不虚构）
  items.push({ name: '满配率', ok: null, detail: 'N/A（编排器与满配档属 M3，未建）' })

  // ② 降级次数：本年条目 effortTier 序列降档事件计数（turbo→standard→economy→follow-host 方向）
  const yearEntries = entries.filter((e) => e.date && String(today).slice(0, 4) === String(e.date).slice(0, 4))
    .slice().sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')))
  let demotions = 0
  let prevIdx = -1
  for (const e of yearEntries) {
    const idx = effortIdx(e.effortTier)
    if (idx < 0) continue
    if (prevIdx >= 0 && idx > prevIdx) demotions += 1
    prevIdx = idx
  }
  items.push({ name: '降级次数', ok: true, detail: `${demotions} 次（effortTier 降档事件，warn2/cap 链）` })

  // ③ 兜底率（结清条目占比）+ 触发器②：连续 3 期兜底（逐彩种，最近 3 期全部 fallback）
  const fallbackAll = settled.filter((e) => e.via === 'fallback').length
  const rate = settled.length ? `${Math.round((fallbackAll / settled.length) * 100)}%（${fallbackAll}/${settled.length}）` : 'N/A（无结清条目）'
  items.push({ name: '兜底率', ok: true, detail: rate })
  for (const game of ['ssq', 'dlt', 'p3']) {
    const last3 = settled.filter((e) => e.game === game).slice(-3)
    if (last3.length >= FALLBACK_STREAK && last3.every((e) => e.via === 'fallback')) {
      alerts.push({ type: 'fallback-streak', level: 'warn', game, detail: `${game} 连续 ${FALLBACK_STREAK} 期兜底（via=fallback，触发器②映射口径）` })
    }
  }

  // ④ 注入均值 → N/A（M3 未建）
  items.push({ name: '注入均值', ok: null, detail: 'N/A（注入层属 M3，未建）' })

  // ⑤ 月 token 走势：近 4 周合计（usage 周度汇总唯一来源 DC-011；review 桶并入后口径）
  const weeks = (Array.isArray(usageWeeks) ? usageWeeks : []).slice(-4)
  items.push({
    name: '月 token 走势',
    ok: true,
    detail: weeks.length
      ? weeks.map((w) => `${w.week}:${w.total}`).join(' · ') + `（近 4 周合计 ${weeks.reduce((s, w) => s + Number(w.total ?? 0), 0)}）`
      : 'N/A（无用量归档）',
  })

  // ⑥ 未结清（B-24 口径）：given-up 且 >7 天 → 报红；voided 只列历史累计、无阈值
  const staleGivenUp = givenUp.filter((e) => isStaleDraw(e.date, today, STALE_DAYS))
  items.push({
    name: '未结清条目',
    ok: staleGivenUp.length ? false : true,
    detail: staleGivenUp.length
      ? `红：${staleGivenUp.length} 期放弃待补超 ${STALE_DAYS} 天（${staleGivenUp.map((e) => `${e.game}|${e.issue}`).join('、')}）；voided 历史累计 ${voided.length} 期（无阈值）`
      : `未结清 ${givenUp.length} 期（未超 ${STALE_DAYS} 天）· voided 历史累计 ${voided.length} 期（无阈值）`,
  })
  if (staleGivenUp.length) {
    alerts.push({ type: 'unsettled-stale', level: 'warn', detail: `${staleGivenUp.length} 期对账放弃待补已超 ${STALE_DAYS} 天（B-24 报红线）` })
  }

  // ⑦ 数据新鲜度：逐彩种最新结清条目日期 → isStaleDraw（7 天）；无结清历史 → 不出该项（不虚构）
  for (const game of ['ssq', 'dlt', 'p3']) {
    const g = settled.filter((e) => e.game === game)
    if (!g.length) continue
    const latest = g.map((e) => String(e.date ?? '')).sort().slice(-1)[0]
    if (!latest) continue
    if (isStaleDraw(latest, today)) {
      items.push({ name: `新鲜度·${game}`, ok: false, detail: `最新结清 ${latest} 距今超 7 天（isStaleDraw）` })
      alerts.push({ type: 'stale-draw', level: 'warn', game, detail: `${game} 数据陈旧：最新结清条目 ${latest}，距今超过 7 天` })
    } else {
      items.push({ name: `新鲜度·${game}`, ok: true, detail: `最新结清 ${latest}` })
    }
  }

  // ⑧ LLM 通道连续异常（触发器③映射口径 §9-R2）：pending-llm ≥2 或 no-model 彩种 ≥2
  const pendingLlm = Number(signals?.pendingLlm ?? 0)
  const noModelGames = Number(signals?.noModelGames ?? 0)
  items.push({ name: 'LLM 通道', ok: pendingLlm >= LLM_PENDING_MIN || noModelGames >= NO_MODEL_GAMES_MIN ? false : true,
    detail: `pending-llm ${pendingLlm} 任务 · no-model 彩种 ${noModelGames} 个（触发器③映射）` })
  if (pendingLlm >= LLM_PENDING_MIN) {
    alerts.push({ type: 'llm-channel', level: 'warn', detail: `学习摄入 pending-llm ${pendingLlm} 个任务待续（触发器③映射：LLM 通道连续异常）` })
  } else if (noModelGames >= NO_MODEL_GAMES_MIN) {
    alerts.push({ type: 'llm-channel', level: 'warn', detail: `${noModelGames} 个彩种出号报 no-model 错误（触发器③映射：LLM 通道连续异常）` })
  }

  // ⑨ 档位计划（触发器①）→ N/A（§9-R2：stamp 无计划档位字段，随 M3 启用）
  items.push({ name: '档位·计划对照', ok: null, detail: 'N/A（stamp 无计划档位字段；随 M3 编排器接入补 stamp.plannedTier 后启用）' })

  return { items, alerts }
}

/**
 * 健康扫描 + 告警事件发射（每 tick 可调用；同日同型告警去重——health-state.json）。
 * TF-6：告警事件 kind='review' + level='warn' + panelOnly=true，静默进面板事件列表。
 */
export function createHealthScanner({
  readPreds,
  readCfg = () => ({}),
  store = null,
  now = () => new Date(),
  log = () => {},
  emit = async () => null,
  signalsOf = () => ({}),
  usageWeeksOf = () => [],
  stateFile = null,   // koi/review/health-state.json 路径（null = 只扫描不发射不落盘）
} = {}) {
  async function scanAndAlert({ today } = {}) {
    const d = today ?? now().toLocaleDateString('sv-SE')
    const { items, alerts } = scanHealth({ readPreds, readCfg, store, today: d, signals: signalsOf() ?? {}, usageWeeks: usageWeeksOf() ?? [] })
    let firedEvents = 0
    if (stateFile && alerts.length) {
      const st = readJson(stateFile, { schemaVersion: 1, date: d, fired: {} })
      const fired = st.date === d ? { ...(st.fired ?? {}) } : {}
      for (const a of alerts) {
        const key = `${a.type}|${a.game ?? '-'}`
        if (fired[key]) continue
        fired[key] = now().toISOString()
        firedEvents += 1
        try {
          await emit({
            kind: 'review', level: 'warn', title: `健康告警 · ${a.type}`, date: d,
            message: `${a.detail}（健康扫描 ${d}）`, fullRef: `review|health|${a.type}`,
            panelOnly: true,   // TF-6：告警静默进面板事件列表，不推 QQ
          })
        } catch (e) { log(`[koi] 健康告警事件发射失败：${String(e?.message ?? e).slice(0, 120)}`) }
      }
      fs.mkdirSync(path.dirname(stateFile), { recursive: true })
      writeJsonAtomic(stateFile, { schemaVersion: 1, date: d, fired })
    }
    return { ok: true, today: d, items, alerts, firedEvents }
  }
  /** 只读扫描视图（T6 /api/review 数据源）：零事件发射、零状态落盘（GET 路由无副作用） */
  function scan({ today } = {}) {
    const d = today ?? now().toLocaleDateString('sv-SE')
    return scanHealth({ readPreds, readCfg, store, today: d, signals: signalsOf() ?? {}, usageWeeks: usageWeeksOf() ?? [] })
  }
  return { scanAndAlert, scanHealth, scan }
}
