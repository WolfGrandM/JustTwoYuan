#!/usr/bin/env node
/**
 * dsh-koi 命令行（市场版 0.3.0；服务器/本机手工操作/体检/补账用；与宿主共用同一份配置/校验/数据，FR-1020 等价路径）：
 *
 *   node koi.mjs history <ssq|dlt|p3> [--count 30]     抓官方历史并打印规范化 JSON
 *   node koi.mjs validate <game> <json串|@file>        校验一注号合不合规（按该彩种当前档位）
 *   node koi.mjs settle [--date YYYY-MM-DD]            手工补账：对某天正式预测开奖对账
 *          [--push] [--force]                          --push 经事件层发战果事件；--force 重开「放弃待补」
 *   node koi.mjs ledger [--reset]                      看模拟账本 / 清空重来
 *   node koi.mjs deps [--json]                         依赖体检（渠道层 / 数据目录 / 配置 / 数据源新鲜度）
 *   node koi.mjs selftest                              判奖金样本回归（全奖级断言，退出码表成败，AC-002）
 *   node koi.mjs demo-predict [game]                   本地演练「随机兜底 + 校验 + 记账规格」
 *   node koi.mjs config get|set <path> [value]         配置等价路径（点路径；同一份 validateConfig）
 *   node koi.mjs channels list|test [index]            渠道清单（掩码）/ 单渠道测试
 *   node koi.mjs mode <game> <off|manual|auto>         三态切换（auto 走四项门控；--time/--tier 可选）
 *   node koi.mjs backbone status|pull                  本地库状态 / 近期窗口按需拉取
 *   node koi.mjs backbone full [--game] [--smoke]      全量回拉（--smoke=每彩种最多2页自验；无=真实全量仅手动）
 *          [--no-offpeak]                              --no-offpeak 显式越过 17:00–22:30 错峰守卫
 *   node koi.mjs backbone stop                         停止进行中的回拉（当前批完成后退出，断点保留）
 *   node koi.mjs ingest <file> | ingest status         学习上传（清洗+守卫本地跑；拆卡交宿主续跑）/ 任务列表
 *   node koi.mjs cards list                            卡片库（名称/彩种/信任级/状态/回测结论）
 *   node koi.mjs backtest run [--game] [--factor]      回测（六内置+卡片因子；--smoke=随机数据本跑不依赖全库）
 *          [--smoke] [--no-offpeak]                    backtest gold = 四金样本自检（AC-012 适配）
 *   node koi.mjs events list [--limit N]               事件列表（含失败原因/队列）
 *   node koi.mjs migrate-v2 [--dry-run]                v1.1 → v2 配置一次性迁移（作者实例升级，S-125）
 *   node koi.mjs report weekly|monthly [--no-offpeak]  手动生成复盘报告（B-21 不受 mind 闸限；BC-012 错峰守卫；计量照记）
 *   node koi.mjs veto [factorId] --note <理由>          否决窗口内晋升（无参=列待否决清单；FR-035/§9-R6）
 *   node koi.mjs migrate-archive [--dry-run] [--bakdir d] 预测档案迁移 review.db（dry-run/实跑/幂等三跑；备份硬门槛；生产实跑待主人授权）
 *   node koi.mjs insight similarity|percentile|aggregate <game>  全量数据探索三件（docs/32 §6.2①②③；纯计算零 LLM 零 token 零落盘）
 *          [--issue N] [--k 12] [--cell r07] [--json]    相似检索防前视只看该期之前（§6.2① 硬约束）；探索性素材、无预测力声明（BC-001）
 *   node koi.mjs hygiene [path]                        市场包卫生扫描（零命中退出 0，AC-102）
 *
 * `push --text` 已退役（通知走事件层/渠道；测试消息用 `channels test`）。
 * 所有路径与宿主半边一致（DSH_HOME 优先），共用同一份配置/账本。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GAMES, GAME_ORDER, gamesForDate, stakesOf, validatePicks, randomPicks, picksLine,
         judge, gradeSummaryText, ledgerTotals, ledgerTotalsText, appendLedgerEntry, emptyLedger, nextIssue } from '../lib/draws.js'
import { fetchHistory, fetchLatestDraw } from '../lib/fetch-draws.mjs'
import { writeJsonAtomic, ensureSchemaVersion, readJson } from '../lib/io.js'
import { settleOutcome, buildSupplementEntry, buildReversalEntry, isStaleDraw } from '../lib/scheduler.js'
import { createDrawStore } from '../lib/drawstore.js'
import { createBackfill } from '../lib/backfill.js'
import { createJobLock } from '../lib/joblock.js'
import { createCardsStore } from '../lib/cards.js'
import { createBacktestWithBuiltins } from '../lib/backtest.js'
import { createIngest } from '../lib/ingest.js'
import { createUsageTracker, demotionFor } from '../lib/usage.js'
import { createReviewStore } from '../lib/review/store.js'
import { createNarrator } from '../lib/review/narrate.js'
import { createWeeklyReview } from '../lib/review/weekly.js'
import { createMonthlyReview } from '../lib/review/monthly.js'
import { migrateArchive } from '../lib/review/migrate.js'
import { hasProbabilityClaim } from '../lib/render.js'
import { inOffpeakWindow } from '../lib/backfill.js'
import { buildConfigTemplate, buildConfigDefaults, readConfig, validateConfig, checkGates, modeOf, tierOf, maskConfig } from '../lib/config.js'
import { TIERS, tierById, judgeTier, v1EquivTier, specText } from '../lib/tiers.js'
import { loadAdapters, channelsStatus, resolveChannelCfg, maskChannelCfg } from '../lib/channels/index.js'
import { createEventBus } from '../lib/events.js'
import { GOLDEN_SSQ, GOLDEN_DLT, GOLDEN_P3 } from '../lib/golden-fixtures.js'
import { similar, profile, aggregate, fingerprint, cellsOf, omissionSeriesByCell, percentileRank, drawFeatures, DISCLAIMER } from '../lib/insight.js'
import { scanPackage } from './hygiene.mjs'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const CONFIG_FILE = process.env.KOI_CONFIG || path.join(DSH_HOME, 'koi.config.json')
const DATA_DIR = path.join(DSH_HOME, 'koi')
const USER_CHANNELS_DIR = path.join(DSH_HOME, 'koi', 'channels')
const PRED_FILE = path.join(DATA_DIR, 'predictions.json')
const LEDGER_FILE = path.join(DATA_DIR, 'ledger.json')
const EVENTS_FILE = path.join(DATA_DIR, 'events.json')

const arg = (name, def = null) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : def
}
const hasFlag = (name) => process.argv.includes(name)
const readJsonOr = (p, fb) => readJson(p, fb)
const cfg = () => readConfig(CONFIG_FILE, buildConfigDefaults())

const cmd = process.argv[2] ?? 'help'

/**
 * 判奖金样本断言（C5/FR-007）—— 夹具单一源 lib/golden-fixtures.js（v0.2-B1 T-04 下沉，
 * 与 tests/judge-golden.test.mjs 同源消费；CLI 打包不依赖 tests/ 目录，W2B-14）。
 * 期望值按官方固定奖级表手算（SSQ 三~六等 3000/200/10/5；
 * DLT 三~九等 10000/3000/300/200/100/15/5；P3 直选 1040；一/二等浮动按 0 计、给 gradeMoney 才计入）。
 */
function goldenChecks() {
  const SSQ = GOLDEN_SSQ
  const DLT = GOLDEN_DLT
  const P3 = GOLDEN_P3
  const cases = []
  const t = (name, cond) => cases.push({ name, ok: Boolean(cond) })
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

  const a1 = judge('ssq', { red: [2, 7, 20, 24, 26, 30, 31, 33], blue: 2 }, SSQ)
  t('SSQ 一等×1 三等×12 四等×15（6红+蓝）', a1.bets === 28 && eq(a1.grades, { 1: 1, 3: 12, 4: 15 }))
  t('SSQ 一等未给金额 → 浮动标记、固定部分 39000', a1.floating === true && a1.money === 12 * 3000 + 15 * 200)
  const a1m = judge('ssq', { red: [2, 7, 20, 24, 26, 30, 31, 33], blue: 2 }, SSQ, { 1: 10_000_000 })
  t('SSQ 一等给了金额 → 计入（10,039,000）', a1m.floating === false && a1m.money === 10_000_000 + 39_000)
  const a2 = judge('ssq', { red: [2, 7, 20, 24, 26, 30, 31, 33], blue: 3 }, SSQ)
  t('SSQ 二等×1 四等×12 五等×15（6红0蓝）', eq(a2.grades, { 2: 1, 4: 12, 5: 15 }) && a2.money === 12 * 200 + 15 * 10 && a2.floating === true)
  const a3 = judge('ssq', { red: [2, 7, 20, 24, 5, 9, 13, 17], blue: 2 }, SSQ)
  t('SSQ 四等×6 五等×16 六等×6（4红+蓝）=1390', eq(a3.grades, { 4: 6, 5: 16, 6: 6 }) && a3.money === 6 * 200 + 16 * 10 + 6 * 5 && a3.floating === false)

  const d1 = judge('dlt', { front: [1, 6, 10, 15, 32, 7, 14], back: [3, 4] }, DLT)
  t('DLT 一等×1 四等×10 六等×10（前5后2）', d1.bets === 21 && eq(d1.grades, { 1: 1, 4: 10, 6: 10 }))
  t('DLT 一等浮动 → 固定部分 32000', d1.floating === true && d1.money === 10 * 3000 + 10 * 200)
  const d2 = judge('dlt', { front: [1, 6, 10, 15, 32, 7, 14], back: [3, 9] }, DLT)
  t('DLT 二等×1 五等×10 八等×10（前5后1）=3150', eq(d2.grades, { 2: 1, 5: 10, 8: 10 }) && d2.money === 10 * 300 + 10 * 15 && d2.floating === true)
  const d3 = judge('dlt', { front: [1, 6, 10, 15, 32, 7, 14], back: [8, 9] }, DLT)
  t('DLT 三等×1 七等×10 九等×10（前5后0）=11050', eq(d3.grades, { 3: 1, 7: 10, 9: 10 }) && d3.money === 10_000 + 10 * 100 + 10 * 5 && d3.floating === false)
  const d2m = judge('dlt', { front: [1, 6, 10, 15, 32, 7, 14], back: [3, 9] }, DLT, { 2: 250_000 })
  t('DLT 二等给了金额 → 计入（253,150）', d2m.floating === false && d2m.money === 250_000 + 3_150)

  t('P3 直选中 1040', judge('p3', { digits: [6, 4, 7] }, P3).money === 1040)
  t('P3 未中 0 且无奖级', judge('p3', { digits: [6, 4, 8] }, P3).money === 0 && eq(judge('p3', { digits: [6, 4, 8] }, P3).grades, {}))

  return { cases, pass: cases.filter((c) => c.ok).length, fail: cases.filter((c) => !c.ok).length }
}

// ── 一次性事件总线（settle --push 手工补账的事件层路径，MD-25）───────────────────
function makeBus() {
  return createEventBus({
    dataDir: DATA_DIR,
    userChannelsDir: USER_CHANNELS_DIR,
    readCfg: () => cfg(),
    now: () => new Date(),
    log: () => {},
  })
}

/** 点路径取值 */
function getPath(obj, dotted) {
  let cur = obj
  for (const k of String(dotted).split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = cur[k]
  }
  return cur
}
/** 点路径赋值（返回浅拷贝） */
function setPath(obj, dotted, value) {
  const out = structuredClone(obj)
  const parts = String(dotted).split('.')
  let cur = out
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {}
    cur = cur[parts[i]]
  }
  cur[parts[parts.length - 1]] = value
  return out
}

async function main() {
  if (cmd === 'help' || !cmd) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].split('/*')[1] ?? '')
    console.log('彩种：' + GAME_ORDER.map((k) => `${k}=${GAMES[k].name}`).join(' '))
    console.log('今天开奖：' + (gamesForDate(new Date().toLocaleDateString('sv-SE')).join(', ') || '无'))
    return
  }

  if (cmd === 'history') {
    const game = process.argv[3]
    if (!GAMES[game]) { console.error(`彩种要是 ${GAME_ORDER.join('/')}`); process.exit(1) }
    const count = Number(arg('--count', 10))
    const h = await fetchHistory(game, count)
    console.log(JSON.stringify(h.slice(0, Number(arg('--show', 5))), null, 2))
    console.log(`（共取回 ${h.length} 期，最新一期：${h[0]?.issue} @ ${h[0]?.date}）`)
    return
  }

  if (cmd === 'validate') {
    const game = process.argv[3]
    let raw = process.argv[4] ?? ''
    if (raw.startsWith('@')) raw = fs.readFileSync(raw.slice(1), 'utf8')
    const tier = tierOf(cfg(), game)
    const v = require_tier_validate(game, tier, JSON.parse(raw).picks ?? JSON.parse(raw))
    console.log(v.ok ? `✓ 合规（${specText(tier)}）：${picksLine(game, v.picks)}` : `✗ 不合规：${v.error}`)
    if (!v.ok) process.exit(1)
    return
  }

  if (cmd === 'settle') {
    const date = arg('--date', new Date().toLocaleDateString('sv-SE'))
    const force = hasFlag('--force')
    const preds = readJsonOr(PRED_FILE, { entries: [] })
    const targets = (preds.entries ?? []).filter((e) => e.kind === 'daily' && e.date === date
      && (!e.settled || (force && e.settleState === 'given-up')))
    if (!targets.length) { console.log(`${date} 没有待对账的正式预测${force ? '（--force 会连「放弃待补」条目一起重开，仍无）' : '；若有放弃待补条目，加 --force 重开'}`); return }
    const ledger = readJsonOr(LEDGER_FILE, emptyLedger())
    const store = createDrawStore({ dataDir: DATA_DIR })
    for (const entry of targets) {
      const latest = await fetchLatestDraw(entry.game)
      if (!latest || !latest.issue) {
        console.log(`${GAMES[entry.game].name}：开奖数据为空，稍后再试`)
        continue
      }
      // 与调度器同款：期号跳跃先翻历史核实（目标期可能已公布），翻不到才作废
      let result = null
      if (String(latest.issue) === String(entry.issue)) result = latest
      else if (Number(latest.issue) > Number(entry.issue)) {
        const hist = await fetchHistory(entry.game, 50).catch(() => [])
        result = (Array.isArray(hist) ? hist : []).find((d) => String(d.issue) === String(entry.issue)) ?? null
        if (Array.isArray(hist) && hist.length) store.upsertBatch(entry.game, hist)
      }
      const outcome = settleOutcome(entry, latest.issue, Boolean(result),
        new Date().toLocaleTimeString('sv-SE', { hour12: false }).slice(0, 5), cfg().time?.settleGiveUp ?? '23:30')
      if (outcome === 'void') {
        appendLedgerEntry(ledger, buildReversalEntry(entry))
        entry.settled = true; entry.settleState = 'voided'
        entry.settleNote = `官方已到第 ${latest.issue} 期且历史无第 ${entry.issue} 期，作废冲销（手工）`
        console.log(`${GAMES[entry.game].name} 第 ${entry.issue} 期：官方已到第 ${latest.issue} 期且历史无此期 → 作废冲销（投入不计入账本口径）`)
        continue
      }
      if (!result) {
        console.log(`${GAMES[entry.game].name}：官方最新是第 ${latest.issue} 期，预测的 ${entry.issue} 期还没公布，稍后再试`)
        continue
      }
      const tierObj = tierById(entry.tier)
      const judged = tierObj && tierObj.game === entry.game
        ? judgeTier(tierObj, entry.picks, result, result.prizeGrades ?? null)
        : judge(entry.game, entry.picks, result, result.prizeGrades ?? null)
      const wasGivenUp = entry.settleState === 'given-up'
      if (wasGivenUp) {
        appendLedgerEntry(ledger, buildSupplementEntry(entry, judged, new Date().toISOString(),
          force ? 'manual:true 手工补账' : '补判'))
      } else {
        appendLedgerEntry(ledger, {
          at: new Date().toISOString(), kind: 'daily', game: entry.game, issue: entry.issue, date,
          cost: entry.cost, prize: judged.money, bets: judged.bets, grades: judged.grades, entryType: 'main',
        })
      }
      entry.settled = true; entry.settleState = 'settled'
      entry.result = result; entry.prize = judged.money; entry.grades = judged.grades
      store.upsert(entry.game, result)   // 抓过即入库（BC-105）
      if (tierObj && entry.baselinePicks) {
        const bj = judgeTier(tierObj, entry.baselinePicks, result, result.prizeGrades ?? null)
        entry.baselinePrize = bj.money; entry.baselineGrades = bj.grades
      }
      console.log(`${GAMES[entry.game].name} 第 ${entry.issue} 期${wasGivenUp ? '（补判' + (force ? ' · manual' : '') + '）' : ''}：开奖 ${JSON.stringify(result.red ?? result.front ?? result.digits)}${result.blue != null ? ' + ' + result.blue : ''}${result.back != null ? ' + ' + result.back.join(' ') : ''}`)
      console.log(`  我们的号：${picksLine(entry.game, entry.picks)}（${entry.spec ?? stakesOf(entry.game).spec}）`)
      console.log(`  结果：${gradeSummaryText(entry.game, judged)} · 中 ${judged.money} 元${judged.floating ? '（含浮动奖另计）' : ''}`)
      if (hasFlag('--push')) {
        const bus = makeBus()
        const ev = await bus.emit({
          kind: 'result', game: entry.game, issue: entry.issue, gameName: GAMES[entry.game].name, date,
          picksLine: picksLine(entry.game, entry.picks), summary: entry.summary ?? null, via: entry.via,
          fullRef: `${entry.game}|${entry.issue}`, flags: { fallback: entry.via === 'fallback' },
        })
        console.log(`  战果事件：${ev.status === 'sent' ? '✓ 已送达' : ev.status + '（事件层续试/见面板）'}`)
      }
    }
    fs.mkdirSync(DATA_DIR, { recursive: true })
    writeJsonAtomic(LEDGER_FILE, ensureSchemaVersion(ledger))
    writeJsonAtomic(PRED_FILE, ensureSchemaVersion(preds))
    console.log('\n' + ledgerTotalsText(ledgerTotals(readJsonOr(LEDGER_FILE, emptyLedger()))))
    return
  }

  if (cmd === 'ledger') {
    if (hasFlag('--reset')) {
      fs.mkdirSync(DATA_DIR, { recursive: true })
      writeJsonAtomic(LEDGER_FILE, ensureSchemaVersion(emptyLedger()))
      console.log('账本已清空')
      return
    }
    const l = readJsonOr(LEDGER_FILE, emptyLedger())
    console.log(ledgerTotalsText(ledgerTotals(l)))
    for (const e of l.entries.slice(-10)) {
      console.log(`  ${e.date} ${e.game} ${e.issue} 期：投 ${e.cost} 中 ${e.prize}${e.grades ? '（' + Object.entries(e.grades).map(([g, n]) => `${g}等×${n}`).join(' ') + '）' : ''}${e.entryType && e.entryType !== 'main' ? ` [${e.entryType}]` : ''}`)
    }
    return
  }

  if (cmd === 'deps') {
    const items = []
    // 1) 配置
    const c = cfg()
    const v = validateConfig(c)
    items.push({ name: '配置文件', ok: fs.existsSync(CONFIG_FILE) && v.ok, detail: v.ok ? CONFIG_FILE : `校验不过：${v.errors.join('；')}` })
    // 2) 渠道层（适配器发现 + 逐渠道探针；QQ 推送语义已随市场版迁渠道层）
    try {
      const { adapters, problems } = await loadAdapters(USER_CHANNELS_DIR)
      for (const p of problems) items.push({ name: `渠道适配器 ${p.file}`, ok: false, detail: p.error })
      const st = await channelsStatus(c.channels ?? [], { adapters, userDir: USER_CHANNELS_DIR })
      const enabledOk = st.filter((s) => s.enabled && s.status === 'ok').length
      items.push({ name: '通知渠道', ok: enabledOk >= 1, detail: `${enabledOk}/${st.filter((s) => s.enabled).length} 可用（${st.map((s) => `${s.type}:${s.status}`).join('、') || '无'}）` })
    } catch (e) { items.push({ name: '通知渠道', ok: false, detail: String(e.message ?? e) }) }
    // 3) 数据目录可写
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true })
      const probe = path.join(DATA_DIR, '.probe')
      fs.writeFileSync(probe, 'ok'); fs.rmSync(probe)
      items.push({ name: '数据目录', ok: true, detail: DATA_DIR })
    } catch (e) { items.push({ name: '数据目录', ok: false, detail: String(e.message ?? e) }) }
    // 4) 三个数据源连通性 + 数据新鲜度（各抓 1 期；最新开奖距今 >7 天 → ✗，C6/FR-008）
    for (const k of GAME_ORDER) {
      try {
        const h = await fetchHistory(k, 1)
        if (!h.length) { items.push({ name: `${GAMES[k].name} 数据源`, ok: false, detail: '空' }); continue }
        const stale = isStaleDraw(h[0].date, new Date().toLocaleDateString('sv-SE'))
        items.push({
          name: `${GAMES[k].name} 数据源`,
          ok: !stale,
          detail: `最新 ${h[0].issue} @ ${h[0].date}${stale ? '（距今超 7 天，数据陈旧 ✗）' : ''}`,
        })
      } catch (e) { items.push({ name: `${GAMES[k].name} 数据源`, ok: false, detail: String(e.message ?? e).slice(0, 120) }) }
    }
    // 5) 今天开什么
    const today = new Date().toLocaleDateString('sv-SE')
    items.push({ name: '今天开奖', ok: true, detail: gamesForDate(today).map((k) => GAMES[k].name).join('、') || '无' })
    if (hasFlag('--json')) { console.log(JSON.stringify({ ok: items.every((i) => i.ok), items }, null, 2)); return }
    for (const i of items) console.log(`${i.ok ? '✓' : '✗'} ${i.name} — ${i.detail}`)
    console.log(items.every((i) => i.ok) ? '\n全部可用 ✓' : '\n有项不可用 ✗（看上面）')
    return
  }

  if (cmd === 'selftest') {
    const r = goldenChecks()
    for (const c of r.cases) console.log(`${c.ok ? '✓' : '✗'} ${c.name}`)
    console.log(r.fail ? `\n判奖金样本回归：${r.pass} pass / ${r.fail} fail ✗` : `\n判奖金样本回归：${r.pass} pass / 0 fail ✓`)
    process.exit(r.fail ? 1 : 0)
  }

  if (cmd === 'demo-predict') {
    const game = process.argv[3] ?? 'p3'
    const tier = tierOf(cfg(), game)
    const picks = randomPicks(game)
    const v = validatePicks(game, picks)
    console.log(`随机兜底号（v1 规格路径）：${picksLine(game, picks)} · 校验：${v.ok ? '✓' : '✗ ' + v.error} · 规格：${JSON.stringify(stakesOf(game))}`)
    console.log(`当前档位：${specText(tier)}`)
    return
  }

  // ─────────────────────────── 市场版新命令 ───────────────────────────

  if (cmd === 'config') {
    const sub = process.argv[3]
    const dotted = process.argv[4]
    if (sub === 'get') {
      if (!dotted) { console.log(JSON.stringify(maskConfig(cfg()), null, 2)); return }
      const val = getPath(cfg(), dotted)
      console.log(val === undefined ? `（未配置：${dotted}）` : JSON.stringify(val))
      return
    }
    if (sub === 'set') {
      if (!dotted || process.argv.length < 5) { console.error('用法：config set <a.b.c> <value>'); process.exit(1) }
      let value = process.argv[5]
      try { value = JSON.parse(value) } catch { /* 保持字符串 */ }
      const next = setPath(cfg(), dotted, value)
      const v = validateConfig(next)
      if (!v.ok) { console.error(`✗ 拒绝（非法值，S-113）：\n  ${v.errors.join('\n  ')}`); process.exit(1) }
      writeJsonAtomic(CONFIG_FILE, next)
      console.log(`✓ 已写入 ${dotted} = ${JSON.stringify(value)}（下一轮 tick 生效）`)
      return
    }
    console.error('用法：config get [path] | config set <path> <value>')
    process.exit(1)
  }

  if (cmd === 'channels') {
    const sub = process.argv[3] ?? 'list'
    const c = cfg()
    const { adapters, problems } = await loadAdapters(USER_CHANNELS_DIR)
    for (const p of problems) console.log(`△ 适配器加载失败 ${p.file}：${p.error}`)
    if (sub === 'list') {
      const st = await channelsStatus(c.channels ?? [], { adapters, userDir: USER_CHANNELS_DIR })
      for (const s of st) console.log(`${s.enabled ? '●' : '○'} [${s.index}] ${s.type} — ${s.status}${s.error ? `（${s.error}）` : ''} ${Object.keys(s.masked ?? {}).length ? '凭证：' + JSON.stringify(s.masked) : ''}`)
      console.log(st.length ? '' : '（未配置渠道；panel 为内置桌宠渠道）')
      return
    }
    if (sub === 'test') {
      const idx = Number(process.argv[4] ?? 0)
      const entry = (c.channels ?? [])[idx]
      if (!entry) { console.error(`没有索引为 ${idx} 的渠道（channels list 查看）`); process.exit(1) }
      const found = adapters.get(entry.type)
      if (!found) { console.error(`渠道 ${entry.type} 的适配器缺失，请在 ${USER_CHANNELS_DIR} 补入 ${entry.type}.js 或停用`); process.exit(1) }
      const chCfg = resolveChannelCfg(entry, USER_CHANNELS_DIR)
      try {
        const r = await found.adapter.test(chCfg)
        console.log(`${r?.ok ? '✓' : '✗'} ${entry.type}：${r?.word ?? ''}`)
        console.log(`  凭证回显（掩码）：${JSON.stringify(maskChannelCfg(chCfg, found.adapter))}`)
        if (!r?.ok) process.exit(1)
      } catch (e) { console.error(`✗ ${entry.type}：${String(e.message ?? e)}`); process.exit(1) }
      return
    }
    console.error('用法：channels list | channels test [index]')
    process.exit(1)
  }

  if (cmd === 'mode') {
    const game = process.argv[3]
    const mode = process.argv[4]
    if (!GAMES[game] || !['off', 'manual', 'auto'].includes(mode)) {
      console.error(`用法：mode <${GAME_ORDER.join('|')}> <off|manual|auto> [--time HH:MM] [--tier 档位id]`)
      process.exit(1)
    }
    const c = cfg()
    const current = c.modes?.[game] ?? {}
    const next = {
      ...current,
      mode,
      ...(arg('--time') ? { predictAt: arg('--time') } : {}),
      ...(arg('--tier') ? { tier: arg('--tier') } : {}),
    }
    if (mode === 'auto') {
      const { adapters } = await loadAdapters(USER_CHANNELS_DIR)
      const channelsOk = (c.channels ?? []).filter((ch) => ch && ch.enabled !== false && adapters.has(ch.type)).length
      const g = checkGates(game, { modes: { [game]: next } }, { channelsOk })
      if (!g.ok) {
        console.error(`✗ 门控不满足（S-116），缺项：`)
        for (const m of g.missing) console.error(`  - ${m.label}：${m.hint}`)
        process.exit(1)
      }
      next.wizardDone = true
    }
    const merged = { ...c, modes: { ...c.modes, [game]: next } }
    const v = validateConfig(merged)
    if (!v.ok) { console.error(`✗ 配置校验不过：\n  ${v.errors.join('\n  ')}`); process.exit(1) }
    writeJsonAtomic(CONFIG_FILE, merged)
    console.log(`✓ ${GAMES[game].name} → ${mode}${arg('--tier') ? `（档位 ${arg('--tier')}）` : ''}（下一期起生效）`)
    return
  }

  if (cmd === 'backbone') {
    const sub = process.argv[3] ?? 'status'
    const store = createDrawStore({ dataDir: DATA_DIR })
    const mkBackfill = () => createBackfill({
      dataDir: DATA_DIR, store, lock: createJobLock({ file: path.join(DATA_DIR, 'job-lock.json'), log: (m) => console.log(m) }),
      readCfg: () => cfg(), log: (m) => console.log(m),
    })
    if (sub === 'status') {
      for (const k of GAME_ORDER) {
        const s = store.status(k)
        console.log(`${GAMES[k].name}：${s.count} 期在库 · 最新 ${s.latestIssue ?? '无'} @ ${s.latestDate ?? '-'}${s.fresh ? '' : '（陈旧）'} · 连续性 ${s.continuityOk ?? '—'}`)
      }
      const bf = mkBackfill().status()
      for (const [k, pg] of Object.entries(bf.perGame ?? {})) {
        const line = `${GAMES[k]?.name ?? k}：${pg.done ? '全量完成' : pg.status ?? '未完成'} · 已拉 ${pg.fetchedIssues ?? 0} 条（${pg.requests ?? 0} 请求）· ${pg.progress?.note ?? ''}`
        console.log(`  回拉 ${line}${pg.lastErr ? ` · ✗ ${pg.lastErr}` : ''}${pg.rejectedTotal ? ` · 拒用 ${pg.rejectedTotal}` : ''}`)
        if (pg.audit?.continuity?.gaps?.length) console.log(`  ⚠ ${pg.audit.continuity.gaps.length} 处断档（可能为源端历史缺失；审计只报告不自动补拉）`)
      }
      console.log('（近期窗口按需拉取见 backbone pull；全量回拉见 backbone full——真实全量仅手动执行）')
      return
    }
    if (sub === 'pull') {
      const n = Number(cfg().historyCount ?? 30)
      for (const k of GAME_ORDER) {
        try {
          const r = await store.ensureRecent(k, n)
          console.log(`${GAMES[k].name}：${r.fetched ? '在线拉取 ' : '本地命中 '}${r.history.length} 期（库内共 ${store.status(k).count} 期）`)
        } catch (e) { console.error(`${GAMES[k].name}：✗ ${String(e.message ?? e)}`) }
      }
      return
    }
    if (sub === 'full') {
      const smoke = hasFlag('--smoke')
      const noOffpeak = hasFlag('--no-offpeak')
      const game = arg('--game')
      if (game != null && !GAMES[game]) { console.error(`--game 要是 ${GAME_ORDER.join('/')} 之一`); process.exit(1) }
      if (!smoke) {
        console.log('⚠ 真实全量回拉：约 140–160 个请求、15–30 分钟（批间隔 2 秒；17:00–22:30 错峰窗口内不开始、跨入自动暂停待续；可 Ctrl+C 中止，断点保留）。')
        console.log('  冒烟自验请用 --smoke（每彩种最多 2 页 + 抽样核验 1 请求）。')
      }
      const before = Object.fromEntries(GAME_ORDER.map((k) => [k, store.status(k).count]))
      const bf = mkBackfill()
      const r = await bf.runAll({ games: game ? [game] : [...GAME_ORDER], smoke, noOffpeak })
      for (const [k, x] of Object.entries(r.perGame)) {
        if (!x.ok) { console.error(`${GAMES[k].name}：✗ ${x.error}`); continue }
        console.log(`${GAMES[k].name}：${x.status} · 本次 ${x.requests} 请求 · 累计 ${x.fetchedIssues} 条 · 在库 ${store.status(k).count} 期（此前 ${before[k]}）`)
        if (x.rejectedTotal) console.log(`  拒用累计 ${x.rejectedTotal} 条（明细 koi/draws-rejected.log）`)
        if (x.progress?.note) console.log(`  ${x.progress.note}`)
        const pg = bf.status().perGame[k]
        if (pg?.audit?.crossCheck) {
          const c = pg.audit.crossCheck
          console.log(`  抽样核验（最新 1 期）：${c.ok === false ? '✗ ' + (c.error ?? '') : c.mismatch ? '⚠ ' + c.detail : '✓ ' + (c.detail ?? '')}`)
        }
        if (pg?.audit?.continuity?.gaps?.length) console.log(`  ⚠ ${pg.audit.continuity.gaps.length} 处断档（可能为源端历史缺失；审计只报告不自动补拉）`)
      }
      return
    }
    if (sub === 'stop') {
      const r = mkBackfill().stop()
      console.log(r.note)
      console.log('（断点已保留：koi/databackbone.json；重新 backbone full 从断点续拉，已抓取数据不重复请求）')
      return
    }
    console.error('用法：backbone status | backbone pull | backbone full [--game ssq] [--smoke] [--no-offpeak] | backbone stop')
    process.exit(1)
  }

  if (cmd === 'events') {
    const limit = Number(arg('--limit', 20))
    const entries = (readJsonOr(EVENTS_FILE, { entries: [] }).entries ?? []).slice(-limit).reverse()
    if (!entries.length) { console.log('（暂无事件）'); return }
    for (const e of entries) {
      console.log(`[${e.at}] ${e.kind}${e.status !== 'sent' ? `·${e.status}` : ''} ${e.game ?? ''}${e.issue ? ' 第' + e.issue + '期' : ''}`)
      console.log(`    ${(e.body ?? '').split('\n')[0]}${e.lastErr ? `\n    ✗ ${e.lastErr}` : ''}`)
    }
    return
  }

  if (cmd === 'migrate-v2') {
    const code = await migrateV2({ dryRun: hasFlag('--dry-run'), weeklyCap: arg('--weekly-cap') })
    process.exit(code)
  }

  // ── M4 复盘报告手动生成（B-21：CLI 不受 mind 闸限制；BC-012 错峰守卫 + --no-offpeak 显式越过；
  //    计量照记——narrator 走 usage.record('review', …)。CLI 无宿主会话 → 叙述如实降级 code-only）──
  if (cmd === 'report') {
    const kind = process.argv[3]
    if (!['weekly', 'monthly'].includes(kind)) { console.error('用法：report weekly|monthly [--no-offpeak]'); process.exit(1) }
    if (inOffpeakWindow(new Date()) && !hasFlag('--no-offpeak')) {
      console.error('错峰窗口（17:00–22:30）内不执行叙述类复盘生成（BC-012）：22:30 后再试，或 --no-offpeak 显式越过')
      process.exit(1)
    }
    const reviewStore = createReviewStore({ dataDir: DATA_DIR, log: (m) => console.log(m) })
    const usageTracker = createUsageTracker({ dataDir: DATA_DIR })
    const bus = makeBus()
    const narrator = createNarrator({
      promptAgent: async () => { throw new Error('CLI 形态无宿主会话——叙述降级 code-only（宿主侧生成才有 LLM 叙述，S-119 同款诚实路径）') },
      usage: usageTracker,
      readCfg: () => cfg(),
      budgetState: (c) => {
        const totals = usageTracker.weekTotals()
        const demo = demotionFor({ used: totals.total, cap: Number(c?.budget?.weeklyCap) > 0 ? Number(c.budget.weeklyCap) : 1_500_000, warn1: c?.budget?.warn1 ?? 0.7, warn2: c?.budget?.warn2 ?? 0.9, effortTier: c?.effort?.tier ?? 'follow-host' })
        return { totals, demo }
      },
      now: () => new Date(),
      workDir: path.join(DSH_HOME, 'koi-work'),
      log: (m) => console.log(m),
      hasProbabilityClaim,
    })
    const common = {
      store: reviewStore, usage: usageTracker, narrator,
      emit: (p) => bus.emit(p), now: () => new Date(), readCfg: () => cfg(),
      log: (m) => console.log(m),
      lock: createJobLock({ file: path.join(DATA_DIR, 'job-lock.json'), log: (m) => console.log(m) }),
      reportsDir: path.join(DATA_DIR, 'review', 'reports'),
      readLedger: () => readJsonOr(LEDGER_FILE, { entries: [] }),
      readPreds: () => readJsonOr(PRED_FILE, { entries: [] }),
    }
    if (kind === 'weekly') {
      const weekly = createWeeklyReview(common)
      const r = await weekly.generateNow({})
      if (!r.ok && r.skipped === 'duplicate') {
        const row = reviewStore.getReport('weekly', r.period)
        console.log(`本周期周报已存在（${r.period}，period 幂等不重发）：\n`)
        console.log(row?.content ?? '')
        return
      }
      if (!r.ok) { console.error(`✗ 周报生成失败：${r.error ?? r.skipped ?? ''}`); process.exit(1) }
      console.log(r.content)
      return
    }
    // monthly：晋升流水线逐因子评估需要回测引擎（registry 注入）
    const drawStore = createDrawStore({ dataDir: DATA_DIR })
    const bt = createBacktestWithBuiltins({ dataDir: DATA_DIR, drawStore, now: () => new Date(), readCfg: () => cfg(), log: () => {} })
    const monthly = createMonthlyReview({ ...common, backtest: bt })
    const r = await monthly.generateNow({})
    if (!r.ok && r.skipped === 'duplicate') {
      const row = reviewStore.getReport('monthly', r.period)
      console.log(`本周期月报已存在（${r.period}，period 幂等不重发；流水线不在重复生成时重跑——状态变更唯一时点）：\n`)
      console.log(row?.content ?? '')
      return
    }
    if (!r.ok) { console.error(`✗ 月报生成失败：${r.error ?? r.skipped ?? ''}`); process.exit(1) }
    console.log(r.content)
    return
  }

  // ── M4 晋升否决（FR-035/§9-R6）：无参=列待否决清单（可发现性③）；带参+note=执行否决 ──
  if (cmd === 'veto') {
    const factorId = process.argv[3] && !String(process.argv[3]).startsWith('--') ? process.argv[3] : null
    const note = arg('--note')
    const reviewStore = createReviewStore({ dataDir: DATA_DIR })
    const vetoHours = Number(cfg()?.review?.vetoWindowHours) > 0 ? Number(cfg().review.vetoWindowHours) : 24
    if (!factorId) {
      const { pending } = reviewStore.resolvePendingPromotions(new Date(), { vetoWindowHours: vetoHours })
      if (!pending.length) { console.log('当前无待否决晋升（promoted 且未过否决窗口的因子清单为空）'); return }
      console.log(`待否决晋升清单（否决窗口 ${vetoHours}h，过期不可回退）：`)
      for (const p of pending) console.log(`  ${p.id}（${p.name}）· 晋升于 ${p.promotedAt} · 生效 ${p.effectiveAt} · 剩余 ${p.hoursLeft.toFixed(1)}h`)
      console.log('\n否决：node koi.mjs veto <factorId> --note "<理由>"（BC-008 审计必填）')
      return
    }
    if (!note || !String(note).trim()) { console.error('否决必须附 --note <理由>（BC-008 审计必填）'); process.exit(1) }
    const monthly = createMonthlyReview({ store: reviewStore, readCfg: () => cfg(), log: (m) => console.log(m) })
    const r = monthly.vetoFactor(factorId, String(note))
    if (!r.ok) { console.error(`✗ ${r.error}`); process.exit(1) }
    console.log(`✓ 已否决：${factorId} promoted→observing（actor=owner，审计注记已入 factor_state_log；生效门恢复为未生效）`)
    return
  }

  // ── M4 档案迁移（§4.2 三跑：dry-run 只读 / 实跑（备份硬门槛）/ 幂等短路；不改 archiveAuthoritative 开关）──
  if (cmd === 'migrate-archive') {
    const r = await migrateArchive({
      dataDir: DATA_DIR,
      dryRun: hasFlag('--dry-run'),
      bakDir: arg('--bakdir'),
      now: () => new Date(),
      log: (m) => console.log(m),
      readCfg: () => cfg(),
    })
    for (const line of r.report ?? []) console.log('  ' + line)
    process.exit(r.code ?? (r.ok ? 0 : 1))
  }

  if (cmd === 'hygiene') {
    const target = path.resolve(process.argv[3] ?? path.dirname(path.dirname(fileURLToPath(import.meta.url))))
    const { hits, waived, files } = scanPackage(target)
    console.log(`市场包卫生扫描：${target}（${files} 个文件）`)
    for (const h of hits) console.log(`✖ [${h.kind}] ${h.file}:${h.line} ${h.detail}`)
    for (const w of waived) console.log(`△ [${w.kind}·白名单] ${w.file}:${w.line} ${w.detail}`)
    if (!hits.length) { console.log(`零命中 ✓（白名单豁免 ${waived.length} 行）`); process.exit(0) }
    console.log(`\n命中 ${hits.length} 处 ✗（BC-103/NFR-102）`)
    process.exit(1)
  }

  if (cmd === 'ingest') {
    const sub = process.argv[3]
    const cardsStore = createCardsStore({ dataDir: DATA_DIR })
    const usage = createUsageTracker({ dataDir: DATA_DIR })
    const mkIngest = () => createIngest({
      dshHome: DSH_HOME, cardsStore, usage,
      lock: createJobLock({ file: path.join(DATA_DIR, 'job-lock.json'), log: (m) => console.log(m) }),
      // CLI 无宿主会话：拆卡环节交卷不了会如实落 pending-llm（宿主锦鲤运行中由 tick 自动续跑，S-119）
      promptAgent: undefined,
      readCfg: () => cfg(), log: (m) => console.log(m),
    })
    if (sub === 'status') {
      const st = mkIngest().list()
      if (!st.jobs.length) { console.log('（暂无学习任务；上传见 ingest <file>，目录投喂见 ~/.dsh/koi-work/inbox/）'); return }
      for (const j of st.jobs.slice(-20).reverse()) {
        console.log(`[${j.status}] ${j.name} · ${(Number(j.size) / 1024).toFixed(1)}KB · ${j.at.slice(0, 19).replace('T', ' ')}${j.waitingNote ? ` · ${j.waitingNote}` : ''}${j.error ? ` · ✗ ${j.error}` : ''}`)
        for (const c of j.cards ?? []) console.log(`    ${c.verdict.padEnd(28)} ${c.name}${c.ruleDupName ? `（疑似重复被保守拒入，与『${c.ruleDupName}』词法相似 ≥0.8）` : ''}`)
      }
      console.log(`卡片库：${st.cards.length} 张（cards list 查看）`)
      return
    }
    if (sub && sub !== 'status' && !sub.startsWith('-')) {
      const file = path.resolve(sub)
      if (!fs.existsSync(file)) { console.error(`没有这个文件：${file}`); process.exit(1) }
      const buf = fs.readFileSync(file)
      const ing = mkIngest()
      const r = ing.acceptBuffer({ name: path.basename(file), buffer: buf, sourceType: 'cli', process: false })
      if (!r.ok) { console.error(`✗ 拒收：${r.error}`); process.exit(1) }
      console.log(`✓ 已建学习任务 ${r.job.id}（估算 ≈ ${r.estimate} tokens，口径：字节/12）`)
      const done = await ing.processJob(r.job.id)
      const j = done.job ?? {}
      if (j.status === 'done') {
        console.log(`清洗 ✓（${j.stats?.droppedLines ?? 0} 行噪声/页眉剔除，断行修复 ${j.clean?.fixedBreaks ?? 0} 处）→ 拆卡完成`)
      } else if (j.status === 'pending-llm') {
        console.log(`拆卡环节已登记为「待补」（${j.error ?? '模型未就绪/超时'}）——宿主锦鲤运行中会自动重试，绝不静默丢弃。`)
      } else if (j.status === 'rejected') {
        console.error(`✗ 拒收：${j.error}`)
      } else {
        console.log(`任务停在 ${j.status}${j.waitingNote ? `（${j.waitingNote}）` : ''}——宿主调度器会按守卫自动继续。`)
      }
      return
    }
    console.error('用法：ingest <file> | ingest status')
    process.exit(1)
  }

  if (cmd === 'cards') {
    const sub = process.argv[3] ?? 'list'
    if (sub === 'list') {
      const cards = createCardsStore({ dataDir: DATA_DIR }).list()
      if (!cards.length) { console.log('（卡片库为空；学习上传见 ingest <file> 或面板「学习」区）'); return }
      for (const c of cards) {
        const bt = c.backtest ? `回测：${c.backtest.verdict}（${c.backtest.rounds} 轮 · 命中 ${(c.backtest.hitRate * 100).toFixed(1)}% · p=${c.backtest.pValue.toExponential(2)}）` : '回测：未跑'
        console.log(`· ${c.name} [${(c.games ?? []).join('/')}] 信任=${c.trustLevel} 状态=${c.status}${c.factorId ? ` 因子=${c.factorId}` : ''}`)
        console.log(`    ${bt}${c.factorizeError ? ` · ${c.factorizeError}` : ''}`)
        console.log(`    规则：${String(c.rule).slice(0, 80)}`)
      }
      console.log(`（共 ${cards.length} 张；口径：回测结论仅供你参考，不改变任何自动行为）`)
      return
    }
    console.error('用法：cards list')
    process.exit(1)
  }

  if (cmd === 'backtest') {
    const sub = process.argv[3] ?? 'run'
    const store = createDrawStore({ dataDir: DATA_DIR })
    const cardsStore = createCardsStore({ dataDir: DATA_DIR })
    const lock = createJobLock({ file: path.join(DATA_DIR, 'job-lock.json'), log: (m) => console.log(m) })
    const mkBt = (drawStore) => createBacktestWithBuiltins({
      dataDir: DATA_DIR, cardsStore, drawStore, now: () => new Date(), lock, readCfg: () => cfg(), log: (m) => console.log(m),
    })
    if (sub === 'run') {
      const game = arg('--game', 'ssq')
      if (!GAMES[game]) { console.error(`--game 要是 ${GAME_ORDER.join('/')} 之一`); process.exit(1) }
      const noOffpeak = hasFlag('--no-offpeak')
      if (hasFlag('--smoke')) {
        // --smoke：金样本+随机数据本跑，不依赖全库（docs/19 §8 CLI 增量）
        const data = randomGoldData(game, 42)
        const bt = mkBt({ getRecent: () => [...data].reverse() })
        const r = await bt.runBuiltin({ game, noOffpeak })
        printBacktest(r)
        return
      }
      const bt = mkBt(store)
      if (hasFlag('--factor')) {
        const r = await bt.runFactor(String(arg('--factor')), { noOffpeak })
        printBacktest({ ok: r.ok, game, results: r.ok ? [r] : [], errors: r.ok ? [] : [{ factorId: arg('--factor'), error: r.error }] })
        return
      }
      const r = await bt.runAll({ game, noOffpeak })
      printBacktest(r)
      return
    }
    if (sub === 'gold') {
      const fails = await runBacktestGold()
      process.exit(fails ? 1 : 0)
    }
    console.error('用法：backtest run [--game ssq] [--factor <id>] [--smoke] [--no-offpeak] | backtest gold')
    process.exit(1)
  }

  // ── docs/32 §6.2 第一批：全量数据探索三件（数据面：纯计算零 LLM 零 token 零落盘——只读本地库；
  //    注入面已于收尾批 T1 接进 dataPack（lib/stats.js insightBlock：相似 top-3 + 局势分位，
  //    prompt 增量计量走 usage predict 桶既有机制 est 恒标）；本命令=独立查询面，语义不变）。
  //    防前视硬约束（§6.2①）：相似检索只看严格早于目标期的历史——模块构造级保证 + 测试断言锁死。──
  if (cmd === 'insight') {
    const sub = process.argv[3] ?? ''
    if (!['similarity', 'percentile', 'aggregate'].includes(sub)) {
      console.error('用法：insight similarity|percentile|aggregate <ssq|dlt|p3> [--issue N] [--k 12] [--cell r07] [--json]')
      process.exit(1)
    }
    const game = process.argv[4]
    if (!GAMES[game]) { console.error(`彩种要是 ${GAME_ORDER.join('/')} 之一`); process.exit(1) }
    const store = createDrawStore({ dataDir: DATA_DIR })
    const entries = store.getRecent(game, Infinity)   // 最新在前；insight 内部按期号升序整理（scheduler.js:217 同语义）
    if (!entries.length) {
      console.error(`${GAMES[game].name}：本地库为空（0 期）——先跑 backbone pull / backbone full 回填在库，再来 insight 查询`)
      process.exit(1)
    }
    const latest = entries[0]
    // 默认目标期=下一期（与 scheduler.js:296 同款 nextIssue 口径，跨年 26xxx→27001 由其承担）；--issue 显式指定优先。
    // 名义期号仅作检索阈值（局势编码 = 严格早于它的全部在库期）；真实下一期号以出号管线口径为准。
    const targetIssue = arg('--issue') != null ? String(arg('--issue')) : nextIssue(latest.issue, latest.date, new Date().toLocaleDateString('sv-SE'))
    if (sub === 'similarity') {
      const k = Number(arg('--k', 12))
      const r = similar(game, entries, targetIssue, k)
      if (hasFlag('--json')) { console.log(JSON.stringify(r, null, 2)); return }
      console.log(`${GAMES[game].name} 相似局势检索（探索性素材 · 无预测力声明——BC-001）`)
      console.log(`目标期 ${r.issue}${arg('--issue') == null ? '（名义下一期；局势=在库严格早于它的全部期）' : ''}${r.target ? ` · 开奖前局势基于在库 ${r.target.priorCount} 期` : ''}`)
      if (!r.target) {
        console.log('该期之前无历史可编码（在库不足或 --issue 过早）——命中为空，不虚构。')
        console.log('注：' + r.note)
        return
      }
      const f = r.target.fingerprint.last
      const zoneTxt = (g, x) => g === 'ssq' ? ` / 蓝球 ${x.blue}` : g === 'dlt' ? ` / 后区和 ${x.backSum}` : ''
      console.log(`当前局势（最近一期开奖）：和值 ${f.sum} / 奇数 ${f.odd} / 012 路 ${f.road.join('-')} / AC ${f.ac} / 连号对 ${f.consec}${zoneTxt(game, f)}`)
      console.log(`比对 ${r.scanned} 个历史候选局势（有前期历史且早于目标期）· top-${r.hits.length} 相似期（距离升序）：`)
      for (const h of r.hits) {
        const nf = drawFeatures(game, h.next)
        console.log(`  ${h.issue} @ ${h.date}  距离 ${h.distance.toFixed(4)}  后续开奖：和值 ${nf.sum} / 奇数 ${nf.odd} / 012 路 ${nf.road.join('-')} / AC ${nf.ac} / 连号对 ${nf.consec}${zoneTxt(game, nf)}`)
        console.log(`    号码：${pickLine(game, h.next)}`)
      }
      console.log('注：' + r.note)
      return
    }
    if (sub === 'percentile') {
      const p = profile(game, entries)
      if (hasFlag('--json')) { console.log(JSON.stringify(p, null, 2)); return }
      console.log(`${GAMES[game].name} 极值/分位数档案（现算不落表 · 在库 ${p.count} 期；探索性素材 · 无预测力声明——BC-001）`)
      const row = (label, s) => s
        ? `  ${label}  n=${s.n}  min=${s.min}  p25=${s.p25}  p50=${s.p50}  p75=${s.p75}  p90=${s.p90}  p95=${s.p95}  p99=${s.p99}  max=${s.max}`
        : `  ${label}  （无数据）`
      console.log('[主区逐期分布（极值区间 = min/max）]')
      for (const [label, s] of [['和值', p.summary.sum], ['跨度', p.summary.span], ['AC 值', p.summary.ac], ['连号对', p.summary.consec], ['奇数个数', p.summary.odd], ['最长连号', p.summary.maxRun]]) console.log(row(label, s))
      const cellFilter = arg('--cell')
      const cellNames = cellsOf(game).filter((c) => !cellFilter || c === cellFilter)
      console.log(`[按 cell 遗漏分布（遗漏口径同 stats.js：0=上期刚开）]${cellFilter ? `（--cell ${cellFilter}）` : ''}`)
      for (const c of cellNames) console.log(row(c, p.cells[c]))
      // §6.2② 注入语义演示：当前遗漏 vs 历史分布 → 罕见性客观度量（「当前蓝球遗漏 12 期 = 历史 89 分位」）
      const fp = fingerprint(game, entries, targetIssue)
      if (fp) {
        const seriesByCell = omissionSeriesByCell(game, entries)
        const ranked = cellsOf(game)
          .map((c) => ({ c, cur: fp.omissions[c], rank: percentileRank(seriesByCell[c], fp.omissions[c]) }))
          .sort((a, b) => b.rank - a.rank || b.cur - a.cur)
        console.log(`[当前局势 vs 历史分位]（截至名义期 ${targetIssue}；最罕见 8 个 cell）`)
        for (const x of ranked.slice(0, 8)) console.log(`  ${x.c}：当前遗漏 ${x.cur} 期 = 历史 ${Number(x.rank).toFixed(1)} 分位`)
      }
      console.log('注：' + DISCLAIMER)
      return
    }
    // aggregate：Markdown（默认）或 JSON（--json）——环 A 锚 A 输入规格（LLM 提案面另行拍板，§8.5 :134）
    const r = aggregate(game, entries)
    if (hasFlag('--json')) { console.log(JSON.stringify(r.json, null, 2)); return }
    console.log(r.markdown)
    return
  }

  console.error(`不认识的命令：${cmd}（help 看用法；v1 的 push 命令已退役——测试消息用 channels test）`)
  process.exit(1)
}

function printBacktest(r) {
  if (!r.ok) {
    console.error(`✗ ${r.error ?? (r.errors ?? []).map((e) => `${e.factorId}: ${e.error}`).join('；')}`)
    process.exitCode = 1
    return
  }
  for (const x of r.results ?? []) {
    console.log(`${x.factorId}：${x.rounds} 轮（跳过 ${x.skips}）· 命中 ${(x.hitRate * 100).toFixed(1)}% vs 基线 ${(x.baselineRate * 100).toFixed(1)}% · p=${x.pValue.toExponential(2)} → ${x.verdict}`)
  }
  for (const e of r.errors ?? []) console.log(`△ ${e.factorId}：${e.error}`)
  console.log(`口径：本地全量历史滚动回测 · 命中判据回测前预注册 · 基线=判据滞后自评满足率 · 单侧精确二项检验（α=0.05）。「与随机无异」= 命中率与随机基线无统计学差异。`)
  console.log('开奖是独立随机事件，回测结论不改变中奖概率，也不驱动任何自动行为。')
}

/** backtest gold / --smoke 共用：固定种子随机数据（值域合规） */
function randomGoldData(game, seed) {
  let a = seed >>> 0
  const rnd = () => {
    let t = (a += 0x6D2B79F5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const n = 200
  if (game === 'p3') return Array.from({ length: n }, (_, i) => ({ issue: String(26001 + i), date: '2026-01-01', digits: [Math.floor(rnd() * 10), Math.floor(rnd() * 10), Math.floor(rnd() * 10)] }))
  if (game === 'dlt') {
    return Array.from({ length: n }, (_, i) => {
      const s = new Set()
      while (s.size < 5) s.add(1 + Math.floor(rnd() * 35))
      return { issue: String(26001 + i), date: '2026-01-01', front: [...s].sort((x, y) => x - y), back: [1 + Math.floor(rnd() * 12), 1 + Math.floor(rnd() * 12)] }
    })
  }
  return Array.from({ length: n }, (_, i) => {
    const s = new Set()
    while (s.size < 6) s.add(1 + Math.floor(rnd() * 33))
    return { issue: String(2026001 + i), date: '2026-01-01', red: [...s].sort((x, y) => x - y), blue: 1 + Math.floor(rnd() * 16) }
  })
}

/** backtest gold：四金样本程序化自检（与 tests/market-backtest.test.mjs 同源口径） */
async function runBacktestGold() {
  const { binomTailAtLeast, createBacktestWithBuiltins: mkBt } = await import('../lib/backtest.js')
  const cases = []
  const t = (name, ok) => { cases.push({ name, ok: Boolean(ok) }); console.log(`${ok ? '✓' : '✗'} ${name}`) }
  // ① 二项数值
  t('二项数值 n=20/h=15/p=.5', Math.abs(binomTailAtLeast(15, 20, 0.5) - 21700 / 1048576) < 1e-9)
  t('二项数值 n=100/h=65/p=.5（参考 0.0017588…）', Math.abs(binomTailAtLeast(65, 100, 0.5) - 0.0017588282433534206) < 1e-6)
  // ② 已知规律（植入交替 + 回带内因子）
  const planted = Array.from({ length: 200 }, (_, i) => ({
    issue: String(2026001 + i), date: '2026-01-01',
    red: i % 2 === 0 ? [5, 10, 15, 20, 25, 30] : [1, 2, 3, 4, 5, 45], blue: 1,
  }))
  const sumOf = (e) => e.red.reduce((x, y) => x + y, 0)
  const factor = {
    id: 'gold-return-to-band', source: 'builtin', game: 'ssq', name: 'gold',
    predict(h) {
      const last = h[h.length - 1]
      if (sumOf(last) >= 90 && sumOf(last) <= 130) return null
      return { claim: '回带内', judge: (nx) => ({ hit: sumOf(nx) >= 90 && sumOf(nx) <= 130, detail: '' }) }
    },
  }
  const bt1 = mkBt({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'koi-gold-')), drawStore: { getRecent: () => [...planted].reverse() } })
  bt1.register(factor)
  const r1 = await bt1.runFactor(factor.id)
  t('已知规律：hitRate=1.0 且 better-in-sample 且 p≈0', r1.ok && r1.hitRate === 1 && r1.verdict === 'better-in-sample' && r1.pValue === 0)
  // ③ 纯随机：六内置 no-advantage（固定种子 42）
  const data = randomGoldData('ssq', 42)
  const bt2 = mkBt({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'koi-gold-')), drawStore: { getRecent: () => [...data].reverse() } })
  const r2 = await bt2.runBuiltin({ game: 'ssq' })
  t('纯随机（种子 42）：六内置因子全部 no-advantage', r2.ok && r2.results.length === 6 && r2.results.every((x) => x.verdict === 'no-advantage'))
  // ④ 前视：spy 切片长度恒 t+1
  const seen = []
  const spy = { id: 'gold-spy', source: 'builtin', game: 'ssq', name: 'spy', predict(slice) { seen.push(slice.length); return { claim: 'x', judge: () => ({ hit: false, detail: '' }) } } }
  const bt3 = mkBt({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'koi-gold-')), drawStore: { getRecent: () => [...data].reverse() } })
  bt3.register(spy)
  const r3 = await bt3.runFactor(spy.id)
  t('前视防护：每轮切片长度 = t+1', r3.ok && seen.length === data.length - 31 && seen.every((L, i) => L === 31 + i))
  const fails = cases.filter((c) => !c.ok).length
  console.log(fails ? `\n金样本回归：${cases.length - fails} pass / ${fails} fail ✗` : `\n金样本回归：${cases.length} pass / 0 fail ✓`)
  return fails
}

// validate 命令的档位感知校验（FZ-2 原函数不认非默认档结构）
import { validateTierPicks } from '../lib/tiers.js'
function require_tier_validate(game, tier, raw) {
  const t = tierById(tier)
  if (t && t.game === game) return validateTierPicks(t, raw)
  return validatePicks(game, raw)
}

/** insight 命令的号码呈现（pad2 口径与 lib/stats.js 一致） */
function pickLine(game, e) {
  const pad2 = (n) => String(n).padStart(2, '0')
  if (game === 'ssq') return `红 ${(e.red ?? []).map(pad2).join(' ')} · 蓝 ${pad2(e.blue)}`
  if (game === 'dlt') return `前 ${(e.front ?? []).map(pad2).join(' ')} · 后 ${(e.back ?? []).map(pad2).join(' ')}`
  return (e.digits ?? []).join('')
}

// ── migrate-v2（S-125/MA-21/MB-24/29/35；docs/10 §6 规则3 破坏性变更通道）──────────
async function migrateV2({ dryRun = false, weeklyCap = null } = {}) {
  const old = readJsonOr(CONFIG_FILE, null)
  if (!old) { console.error(`没有配置文件可迁移：${CONFIG_FILE}`); return 1 }
  const report = []
  const alreadyV2 = Number(old.schemaVersion) === 2
  let nu = alreadyV2 ? old : structuredClone(old)

  if (!alreadyV2) {
    nu = { ...structuredClone(buildConfigTemplate()), ...nu }   // v2 缺省补齐（模板零 QQ）
    const push = old.push ?? {}
    const channels = Array.isArray(old.channels) && old.channels.length ? [...old.channels] : [{ type: 'panel', enabled: true }]
    if (push.target != null || push.napcatHttp != null) { // koi-hygiene-allow：读取 v1 字段以迁出
      const sidecar = { target: push.target, napcatHttp: push.napcatHttp } /* koi-hygiene-allow：迁移必须引用并迁出 v1 凭证字段 */
      if (!dryRun) {
        fs.mkdirSync(USER_CHANNELS_DIR, { recursive: true })
        writeJsonAtomic(path.join(USER_CHANNELS_DIR, 'qq.config.json'), sidecar)
      }
      if (!channels.some((ch) => ch.type === 'qq')) channels.push({ type: 'qq', enabled: true })
      report.push('v1 推送凭证 → koi/channels/qq.config.json（侧车凭证，凭证不进主配置）+ channels 注册 {type:"qq", enabled:true}') /* koi-hygiene-allow */
      report.push('提醒：请把私有 qq.js 适配器放入 koi/channels/（模板：docs/16 §8.6），否则渠道层报「适配器缺失」')
    } else {
      report.push('v1 配置无推送凭证（push 段缺省）——跳过侧车迁移')
    }
    if (push.retryMinutes != null) {
      nu.time = { ...nu.time, retryMinutes: push.retryMinutes }
      report.push(`push.retryMinutes（${push.retryMinutes}）→ time.retryMinutes（重试参数归 time 段）`)
    }
    delete nu.push
    // games.enabled → modes 三态（true→auto 语义保持不重置 manual；false→off；缺省彩种→manual）
    const oldPredictAt = old.time?.predictAt
    const modes = {}
    for (const k of GAME_ORDER) {
      const g = old.games?.[k]
      const mode = g == null ? 'manual' : (g.enabled === false ? 'off' : 'auto')
      modes[k] = {
        mode,
        tier: v1EquivTier(k),   // v1 复式结构反查（ssq-r8b1/dlt-f7b2/p3-x1，作者账本连续性，MB-29）
        predictAt: '17:30',
        gates: mode === 'auto' ? { channelOk: true, tierOk: true, timeOk: true, honestyAck: true } : {},
        wizardDone: mode === 'auto',
      }
      if (mode === 'auto') report.push(`games.${k}.enabled=true → modes.${k}.mode=auto（既有运行语义保持，MA-21）`)
    }
    if (oldPredictAt && oldPredictAt !== '17:30') {
      for (const k of GAME_ORDER) modes[k].predictAt = oldPredictAt
      report.push(`time.predictAt（${oldPredictAt}，非默认）→ modes.*.predictAt 显式携带（防静默重置，MB-24）`)
    }
    nu.modes = modes
    delete nu.games
    delete nu.time?.predictAt
    nu.channels = channels
    // 作者实例预算写入配置值（非代码默认，MD-18）
    const cap = weeklyCap != null ? Number(weeklyCap) : 10_000_000
    nu.budget = { ...(nu.budget ?? {}), weeklyCap: cap, ...(old.budget ?? {}) }
    if (old.budget == null) report.push(`budget.weeklyCap = ${cap}（作者实例迁移写入配置值；--weekly-cap 可覆盖）`)
    nu.schemaVersion = 2
    const v = validateConfig(nu)
    if (!v.ok) {
      console.error('迁移产物未过 validateConfig，中止：\n  ' + v.errors.join('\n  '))
      return 1
    }
  } else {
    report.push('配置已是 schemaVersion 2 —— 配置面跳过（幂等，不产生 diff）')
  }

  // state.repushQueue → 事件存储待发队列（MB-35 豁免：瞬态队列搬家，原字段保留读取容忍，无数据删除）
  const stateFile = path.join(DATA_DIR, 'state.json')
  const st = readJsonOr(stateFile, null)
  const rq = Array.isArray(st?.repushQueue) ? st.repushQueue : []
  if (rq.length) {
    const events = readJsonOr(EVENTS_FILE, { schemaVersion: 1, entries: [] })
    const keyOf = (e) => `${e.kind}|${e.game}|${e.issue ?? ''}`
    const queuedKeys = new Set((events.entries ?? []).filter((e) => e.status === 'queued').map(keyOf))
    let moved = 0
    for (const item of rq) {
      if (queuedKeys.has(keyOf(item))) continue   // 幂等键（MD-19）
      ;(events.entries ?? []).push({
        id: `evt-mig-${Date.now()}-${moved}`, kind: item.kind, level: 'info',
        game: item.game, issue: item.issue ?? null,
        at: item.failedAt ?? new Date().toISOString(), deadline: item.deadline ?? '23:30',
        body: item.text ?? '', fullRef: null, status: 'queued', delivery: [],
        attempts: item.attempts ?? 1, lastTryAt: null, lastErr: item.lastErr ?? '', migrated: true,
      })
      moved++
    }
    if (moved && !dryRun) {
      fs.mkdirSync(DATA_DIR, { recursive: true })
      writeJsonAtomic(EVENTS_FILE, { ...events, schemaVersion: 1 })
    }
    report.push(`state.repushQueue（${rq.length} 条）→ 事件存储待发队列${moved ? `（本次搬入 ${moved} 条，业务键去重）` : '（全部已存在，幂等跳过）'}；state.json 原字段保留（读取容忍，不删数据）`)
  } else {
    report.push('state.repushQueue：无待迁移内容（幂等跳过）')
  }
  report.push('predictions.json / ledger.json 业务条目零触碰（DC-009 只加不改不删；AC-114 演练断言覆盖）')

  console.log(`migrate-v2${dryRun ? ' --dry-run（不落盘）' : ''} 迁移报告：`)
  for (const line of report) console.log('  · ' + line)
  if (!dryRun && !alreadyV2) {
    writeJsonAtomic(CONFIG_FILE, nu)
    console.log(`✓ 配置已升 schemaVersion 2：${CONFIG_FILE}`)
  } else if (!dryRun && alreadyV2) {
    console.log('✓ 幂等：配置未改动（重跑无 diff）')
  }
  return 0
}

main().catch((e) => { console.error('出错：' + (e?.stack ?? e)); process.exit(1) })
