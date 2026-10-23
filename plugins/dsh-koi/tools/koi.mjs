#!/usr/bin/env node
/**
 * dsh-koi 命令行（服务器上手工操作/体检/补账用）：
 *
 *   node koi.mjs history <ssq|dlt|p3> [--count 30]   抓官方历史并打印规范化 JSON
 *   node koi.mjs validate <game> <json串|@文件>       校验一注号合不合规
 *   node koi.mjs settle [--date YYYY-MM-DD]          手工补账：对某天正式预测开奖对账
 *   node koi.mjs ledger [--reset]                    看模拟账本 / 清空重来
 *   node koi.mjs push --text "…"                     走 NapCat 私聊发一条
 *   node koi.mjs deps [--json]                       依赖体检（NapCat 通道 / 数据目录 / 配置）
 *
 * 所有路径与宿主半边一致（DSH_HOME 优先），共用同一份配置/账本。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GAMES, GAME_ORDER, gamesForDate, stakesOf, validatePicks, randomPicks, picksLine,
         judge, gradeSummaryText, ledgerTotals, ledgerTotalsText, appendLedgerEntry, emptyLedger, nextIssue } from '../lib/draws.js'
import { fetchHistory, fetchLatestDraw } from '../lib/fetch-draws.mjs'
import { pushPrivate, napcatAlive } from '../lib/push.mjs'

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
    const preds = readJson(PRED_FILE) ?? { entries: [] }
    const targets = preds.entries.filter((e) => e.kind === 'daily' && e.date === date && !e.settled)
    if (!targets.length) { console.log(`${date} 没有待对账的正式预测`); return }
    for (const entry of targets) {
      const latest = await fetchLatestDraw(entry.game)
      if (!latest || String(latest.issue) !== String(entry.issue)) {
        console.log(`${GAMES[entry.game].name}：官方最新是第 ${latest?.issue ?? '?'} 期，预测的 ${entry.issue} 期还没公布，稍后再试`)
        continue
      }
      const judged = judge(entry.game, entry.picks, latest, latest.prizeGrades ?? null)
      const ledger = readJson(LEDGER_FILE) ?? emptyLedger()
      appendLedgerEntry(ledger, { at: new Date().toISOString(), kind: 'daily', game: entry.game, issue: entry.issue, date, cost: entry.cost, prize: judged.money, bets: judged.bets, grades: judged.grades })
      fs.mkdirSync(DATA_DIR, { recursive: true })
      fs.writeFileSync(LEDGER_FILE, JSON.stringify(ledger, null, 2) + '\n')
      entry.settled = true; entry.result = latest; entry.prize = judged.money; entry.grades = judged.grades
      fs.writeFileSync(PRED_FILE, JSON.stringify(preds, null, 2) + '\n')
      console.log(`${GAMES[entry.game].name} 第 ${entry.issue} 期：开奖 ${JSON.stringify(latest.red ?? latest.front ?? latest.digits)}${latest.blue != null ? ' + ' + latest.blue : ''}`)
      console.log(`  我们的号：${picksLine(entry.game, entry.picks)}`)
      console.log(`  结果：${gradeSummaryText(entry.game, judged)} · 中 ${judged.money} 元${judged.floating ? '（含浮动奖另计）' : ''}`)
      if (hasFlag('--push')) {
        const c = cfg()
        const r = await pushPrivate(c.push.napcatHttp, c.push.target, `🎰【锦鲤战果 · ${GAMES[entry.game].name} · 第 ${entry.issue} 期】\n（手工补账）\n${ledgerTotalsText(ledgerTotals(ledger))}`)
        console.log(`  推送：${r.ok ? '✓' : '✗ ' + (r.word || r.retcode)}`)
      }
    }
    console.log('\n' + ledgerTotalsText(ledgerTotals(readJson(LEDGER_FILE))))
    return
  }

  if (cmd === 'ledger') {
    if (hasFlag('--reset')) {
      fs.mkdirSync(DATA_DIR, { recursive: true })
      fs.writeFileSync(LEDGER_FILE, JSON.stringify(emptyLedger(), null, 2) + '\n')
      console.log('账本已清空')
      return
    }
    const l = readJson(LEDGER_FILE) ?? emptyLedger()
    console.log(ledgerTotalsText(ledgerTotals(l)))
    for (const e of l.entries.slice(-10)) {
      console.log(`  ${e.date} ${e.game} ${e.issue} 期：投 ${e.cost} 中 ${e.prize}${e.grades ? '（' + Object.entries(e.grades).map(([g, n]) => `${g}等×${n}`).join(' ') + '）' : ''}`)
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
    // 4) 三个数据源连通性（各抓 1 期）
    for (const k of GAME_ORDER) {
      try {
        const h = await fetchHistory(k, 1)
        items.push({ name: `${GAMES[k].name} 数据源`, ok: h.length > 0, detail: h.length ? `最新 ${h[0].issue} @ ${h[0].date}` : '空' })
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
