#!/usr/bin/env node
/**
 * dsh-koi 命令行（服务器上手工操作/体检/补账用）：
 *
 *   node koi.mjs history <ssq|dlt|p3> [--count 30]   抓官方历史并打印规范化 JSON
 *   node koi.mjs validate <game> <json串|@文件>       校验一注号合不合规
 *   node koi.mjs settle [--date YYYY-MM-DD]          手工补账：对某天正式预测开奖对账
 *          [--push] [--force]                        --force 额外重开「放弃待补」条目补判（带 manual 审计注记，不触碰作废条目）
 *   node koi.mjs ledger [--reset]                    看模拟账本 / 清空重来
 *   node koi.mjs push --text "…"                     走 NapCat 私聊发一条
 *   node koi.mjs deps [--json]                       依赖体检（NapCat 通道 / 数据目录 / 配置 / 数据源新鲜度 >7 天报 ✗）
 *   node koi.mjs selftest                            判奖金样本回归（全奖级断言，退出码表成败，AC-002）
 *   node koi.mjs demo-predict [game]                 本地演练「随机兜底 + 校验 + 记账规格」
 *
 * 所有路径与宿主半边一致（DSH_HOME 优先），共用同一份配置/账本。
 * v1.1：写盘一律走 lib/io.js 原子写（C3）；predictions/ledger 顶层带 schemaVersion:1（C4）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GAMES, GAME_ORDER, gamesForDate, stakesOf, validatePicks, randomPicks, picksLine,
         judge, gradeSummaryText, ledgerTotals, ledgerTotalsText, appendLedgerEntry, emptyLedger, nextIssue } from '../lib/draws.js'
import { fetchHistory, fetchLatestDraw } from '../lib/fetch-draws.mjs'
import { pushPrivate, napcatAlive } from '../lib/push.mjs'
import { writeJsonAtomic, ensureSchemaVersion } from '../lib/io.js'
import { settleOutcome, buildSupplementEntry, buildReversalEntry, isStaleDraw } from '../lib/scheduler.js'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const CONFIG_FILE = process.env.KOI_CONFIG || path.join(DSH_HOME, 'koi.config.json')
const DATA_DIR = path.join(DSH_HOME, 'koi')
const PRED_FILE = path.join(DATA_DIR, 'predictions.json')
const LEDGER_FILE = path.join(DATA_DIR, 'ledger.json')

const arg = (name, def = null) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : def
}
const hasFlag = (name) => process.argv.includes(name)
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null } }
const cfg = () => ({ push: { target: '1017099872', napcatHttp: 'http://127.0.0.1:3000' }, ...(readJson(CONFIG_FILE) ?? {}) })

const cmd = process.argv[2] ?? 'help'

/**
 * 判奖金样本夹具与断言（C5/FR-007；与 tests/judge-golden.test.mjs 保持同一套数据）。
 * 夹具为历史真实开奖：SSQ 2026121 / P3 26282 出自本仓库开发期实测数据，
 * DLT 26120（2026-10-21，前区 01 06 10 15 32 + 后区 03 04）经体彩开奖公告核实（2026-10-24）。
 * 假想投注按「覆盖目标奖级」构造，期望值按官方固定奖级表手算（SSQ 三~六等 3000/200/10/5；
 * DLT 三~九等 10000/3000/300/200/100/15/5；P3 直选 1040；一/二等浮动按 0 计、给 gradeMoney 才计入）。
 */
function goldenChecks() {
  const SSQ = { issue: '2026121', date: '2026-10-22', red: [2, 7, 20, 24, 26, 30], blue: 2 }
  const DLT = { issue: '26120', date: '2026-10-21', front: [1, 6, 10, 15, 32], back: [3, 4] }
  const P3 = { issue: '26282', date: '2026-10-23', digits: [6, 4, 7] }
  const cases = []
  const t = (name, cond) => cases.push({ name, ok: Boolean(cond) })
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

  // SSQ 一/三/四等：6红全含 + 蓝中 → 一等×1、三等×12、四等×15
  const a1 = judge('ssq', { red: [2, 7, 20, 24, 26, 30, 31, 33], blue: 2 }, SSQ)
  t('SSQ 一等×1 三等×12 四等×15（6红+蓝）', a1.bets === 28 && eq(a1.grades, { 1: 1, 3: 12, 4: 15 }))
  t('SSQ 一等未给金额 → 浮动标记、固定部分 39000', a1.floating === true && a1.money === 12 * 3000 + 15 * 200)
  const a1m = judge('ssq', { red: [2, 7, 20, 24, 26, 30, 31, 33], blue: 2 }, SSQ, { 1: 10_000_000 })
  t('SSQ 一等给了金额 → 计入（10,039,000）', a1m.floating === false && a1m.money === 10_000_000 + 39_000)
  // SSQ 二/四/五等：6红全含 + 蓝不中
  const a2 = judge('ssq', { red: [2, 7, 20, 24, 26, 30, 31, 33], blue: 3 }, SSQ)
  t('SSQ 二等×1 四等×12 五等×15（6红0蓝）', eq(a2.grades, { 2: 1, 4: 12, 5: 15 }) && a2.money === 12 * 200 + 15 * 10 && a2.floating === true)
  // SSQ 四/五/六等：4红 + 蓝中
  const a3 = judge('ssq', { red: [2, 7, 20, 24, 5, 9, 13, 17], blue: 2 }, SSQ)
  t('SSQ 四等×6 五等×16 六等×6（4红+蓝）=1390', eq(a3.grades, { 4: 6, 5: 16, 6: 6 }) && a3.money === 6 * 200 + 16 * 10 + 6 * 5 && a3.floating === false)

  // DLT 一/四/六等：前区全含 + 后区双中
  const d1 = judge('dlt', { front: [1, 6, 10, 15, 32, 7, 14], back: [3, 4] }, DLT)
  t('DLT 一等×1 四等×10 六等×10（前5后2）', d1.bets === 21 && eq(d1.grades, { 1: 1, 4: 10, 6: 10 }))
  t('DLT 一等浮动 → 固定部分 32000', d1.floating === true && d1.money === 10 * 3000 + 10 * 200)
  // DLT 二/五/八等：后区一中一不中
  const d2 = judge('dlt', { front: [1, 6, 10, 15, 32, 7, 14], back: [3, 9] }, DLT)
  t('DLT 二等×1 五等×10 八等×10（前5后1）=3150', eq(d2.grades, { 2: 1, 5: 10, 8: 10 }) && d2.money === 10 * 300 + 10 * 15 && d2.floating === true)
  // DLT 三/七/九等：后区全不中
  const d3 = judge('dlt', { front: [1, 6, 10, 15, 32, 7, 14], back: [8, 9] }, DLT)
  t('DLT 三等×1 七等×10 九等×10（前5后0）=11050', eq(d3.grades, { 3: 1, 7: 10, 9: 10 }) && d3.money === 10_000 + 10 * 100 + 10 * 5 && d3.floating === false)
  // DLT 二等给了金额
  const d2m = judge('dlt', { front: [1, 6, 10, 15, 32, 7, 14], back: [3, 9] }, DLT, { 2: 250_000 })
  t('DLT 二等给了金额 → 计入（253,150）', d2m.floating === false && d2m.money === 250_000 + 3_150)

  // P3 直选 + 未中
  t('P3 直选中 1040', judge('p3', { digits: [6, 4, 7] }, P3).money === 1040)
  t('P3 未中 0 且无奖级', judge('p3', { digits: [6, 4, 8] }, P3).money === 0 && eq(judge('p3', { digits: [6, 4, 8] }, P3).grades, {}))

  return { cases, pass: cases.filter((c) => c.ok).length, fail: cases.filter((c) => !c.ok).length }
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
    const v = validatePicks(game, JSON.parse(raw).picks ?? JSON.parse(raw))
    console.log(v.ok ? `✓ 合规：${picksLine(game, v.picks)}` : `✗ 不合规：${v.error}`)
    if (!v.ok) process.exit(1)
    return
  }

  if (cmd === 'settle') {
    const date = arg('--date', new Date().toLocaleDateString('sv-SE'))
    const force = hasFlag('--force')
    const preds = readJson(PRED_FILE) ?? { entries: [] }
    // v1.0 语义：!settled 待对账；--force 额外重开 given-up 条目（不触碰 voided，B-18）
    const targets = preds.entries.filter((e) => e.kind === 'daily' && e.date === date
      && (!e.settled || (force && e.settleState === 'given-up')))
    if (!targets.length) { console.log(`${date} 没有待对账的正式预测${force ? '（--force 会连「放弃待补」条目一起重开，仍无）' : '；若有放弃待补条目，加 --force 重开'}`); return }
    const ledger = readJson(LEDGER_FILE) ?? emptyLedger()
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
      const judged = judge(entry.game, entry.picks, result, result.prizeGrades ?? null)
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
      console.log(`${GAMES[entry.game].name} 第 ${entry.issue} 期${wasGivenUp ? '（补判' + (force ? ' · manual' : '') + '）' : ''}：开奖 ${JSON.stringify(result.red ?? result.front ?? result.digits)}${result.blue != null ? ' + ' + result.blue : ''}${result.back != null ? ' + ' + result.back.join(' ') : ''}`)
      console.log(`  我们的号：${picksLine(entry.game, entry.picks)}`)
      console.log(`  结果：${gradeSummaryText(entry.game, judged)} · 中 ${judged.money} 元${judged.floating ? '（含浮动奖另计）' : ''}`)
      if (hasFlag('--push')) {
        const c = cfg()
        const r = await pushPrivate(c.push.napcatHttp, c.push.target, `🎰【锦鲤战果 · ${GAMES[entry.game].name} · 第 ${entry.issue} 期】\n（手工补账${wasGivenUp ? ' · 补判' : ''}）\n${ledgerTotalsText(ledgerTotals(ledger))}`)
        console.log(`  推送：${r.ok ? '✓' : '✗ ' + (r.word || r.retcode)}`)
      }
    }
    fs.mkdirSync(DATA_DIR, { recursive: true })
    writeJsonAtomic(LEDGER_FILE, ensureSchemaVersion(ledger))
    writeJsonAtomic(PRED_FILE, ensureSchemaVersion(preds))
    console.log('\n' + ledgerTotalsText(ledgerTotals(readJson(LEDGER_FILE))))
    return
  }

  if (cmd === 'ledger') {
    if (hasFlag('--reset')) {
      fs.mkdirSync(DATA_DIR, { recursive: true })
      writeJsonAtomic(LEDGER_FILE, ensureSchemaVersion(emptyLedger()))
      console.log('账本已清空')
      return
    }
    const l = readJson(LEDGER_FILE) ?? emptyLedger()
    console.log(ledgerTotalsText(ledgerTotals(l)))
    for (const e of l.entries.slice(-10)) {
      console.log(`  ${e.date} ${e.game} ${e.issue} 期：投 ${e.cost} 中 ${e.prize}${e.grades ? '（' + Object.entries(e.grades).map(([g, n]) => `${g}等×${n}`).join(' ') + '）' : ''}${e.entryType && e.entryType !== 'main' ? ` [${e.entryType}]` : ''}`)
    }
    return
  }

  if (cmd === 'push') {
    const text = arg('--text')
    if (!text) { console.error('用法：push --text "内容"'); process.exit(1) }
    const c = cfg()
    const r = await pushPrivate(c.push.napcatHttp, c.push.target, text)
    console.log(r.ok ? '✓ 已发出' : `✗ retcode=${r.retcode} ${r.word}`)
    if (!r.ok) process.exit(1)
    return
  }

  if (cmd === 'deps') {
    const items = []
    // 1) 配置
    const c = cfg()
    items.push({ name: '配置文件', ok: fs.existsSync(CONFIG_FILE), detail: CONFIG_FILE })
    items.push({ name: '推送目标', ok: /^\d{5,12}$/.test(String(c.push?.target ?? '')), detail: `QQ ${String(c.push?.target ?? '').replace(/^(\d{3})\d+(\d{2})$/, '$1****$2')}` })
    // 2) NapCat 通道
    try {
      const a = await napcatAlive(c.push?.napcatHttp ?? 'http://127.0.0.1:3000')
      items.push({ name: 'NapCat 通道', ok: a.ok, detail: a.ok ? `在线：${a.nickname}（QQ ${a.qq}）` : a.word })
    } catch (e) { items.push({ name: 'NapCat 通道', ok: false, detail: String(e.message ?? e) }) }
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
    // C5/FR-007/AC-002：判奖金样本回归（与 tests/judge-golden.test.mjs 同一套真实开奖夹具的命令行镜像，
    // 部署验收用；退出码表成败）。两处改动须同步。
    const r = goldenChecks()
    for (const c of r.cases) console.log(`${c.ok ? '✓' : '✗'} ${c.name}`)
    console.log(r.fail ? `\n判奖金样本回归：${r.pass} pass / ${r.fail} fail ✗` : `\n判奖金样本回归：${r.pass} pass / 0 fail ✓`)
    process.exit(r.fail ? 1 : 0)
  }

  if (cmd === 'demo-predict') {
    // 不唤醒 AI，纯本地走一遍「校验 + 记账」链路（调管线用，不会推送）
    const game = process.argv[3] ?? 'p3'
    const picks = randomPicks(game)
    const v = validatePicks(game, picks)
    console.log(`随机兜底号：${picksLine(game, picks)} · 校验：${v.ok ? '✓' : '✗ ' + v.error} · 规格：${JSON.stringify(stakesOf(game))}`)
    return
  }

  console.error(`不认识的命令：${cmd}（help 看用法）`)
  process.exit(1)
}

main().catch((e) => { console.error('出错：' + (e?.stack ?? e)); process.exit(1) })
