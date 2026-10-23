/**
 * dsh-koi 数据层 —— 官方开奖数据抓取。
 *
 * 数据源（2026-10-23 在国内网络实测可用；体彩接口必须带完整浏览器头，否则回验证页）：
 *   · 双色球：中国福彩官网 findDrawNotice —— 自带每期各奖级单注奖金（对账直接用 ✓）
 *   · 大乐透：体彩 webapi gameNo=85 —— list 为历史，lastPoolDraw 为最新一期（含奖级）
 *   · 排列三：体彩 webapi gameNo=350133（排列五）—— 排列三开奖号 = 排列五前三位
 *     （3501xx 段没有排列三自己的 gameNo，实测 350128–350133 全空 ✗ 只好走这条路 ✓）
 *
 * 响应编码注意：福彩接口是 GBK，但我们要的字段（code/red/blue/数字金额）全是 ASCII，
 * 按 utf8 解析丢的只是 name/content 里的中文——不影响任何功能 ✓
 */
import { GAMES } from './draws.js'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const TIMEOUT = 15_000

async function jget(url, headers) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), TIMEOUT)
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    return JSON.parse(buf.toString('utf8'))
  } finally { clearTimeout(t) }
}

const CWL_HEADERS = { 'user-agent': UA, referer: 'https://www.cwl.gov.cn/', accept: 'application/json' }
const SPORTTERY_HEADERS = {
  'user-agent': UA,
  referer: 'https://static.sporttery.cn/',
  origin: 'https://static.sporttery.cn',
  accept: 'application/json',
}

/** 体彩 prizeLevelList → {级: 单注奖金}（跳过追加行；金额串带逗号） */
function parseSportteryPrizes(list) {
  const out = {}
  const CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九']
  for (const it of list ?? []) {
    const name = String(it.prizeLevel ?? '')
    if (name.includes('追加')) continue
    const idx = CN.findIndex((c) => name.includes(`${c}等奖`))
    if (idx >= 0) {
      const money = Number(String(it.stakeAmountFormat ?? it.stakeAmount ?? '0').replace(/,/g, ''))
      if (money > 0) out[idx + 1] = money
    }
  }
  return out
}

/**
 * 抓历史。返回按时间倒序（最新在前）的数组：
 *   ssq { issue, date, red:[6], blue, prizeGrades:{1:…} }
 *   dlt { issue, date, front:[5], back:[2] }          （历史项一般不带奖级，对账走 fetchLatestDraw）
 *   p3  { issue, date, digits:[3] }                   （取排列五前三位）
 */
export async function fetchHistory(gameKey, count = 30) {
  if (gameKey === 'ssq') {
    const j = await jget(`https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice?name=ssq&issueCount=${count}`, CWL_HEADERS)
    const items = Array.isArray(j?.result) ? j.result : []
    return items.map((it) => ({
      issue: String(it.code ?? ''),
      date: String(it.date ?? '').slice(0, 10),
      red: String(it.red ?? '').split(',').map(Number).filter((x) => x >= 1 && x <= 33),
      blue: Number(it.blue),
      prizeGrades: Object.fromEntries((it.prizegrades ?? [])
        .map((p) => [Number(p.type), Number(p.typemoney ?? 0)])
        .filter(([_, m]) => m > 0)),
    }))
  }
  if (gameKey === 'dlt' || gameKey === 'p3') {
    const gameNo = gameKey === 'dlt' ? 85 : 350133
    const url = `https://webapi.sporttery.cn/gateway/lottery/getHistoryPageListV1.qry?gameNo=${gameNo}&provinceId=0&pageSize=${count}&isVerify=1&pageNo=1`
    const j = await jget(url, SPORTTERY_HEADERS)
    const items = Array.isArray(j?.value?.list) ? j.value.list : []
    return items.map((it) => {
      const nums = String(it.lotteryDrawResult ?? '').trim().split(/\s+/).map(Number)
      return {
        issue: String(it.lotteryDrawNum ?? ''),
        date: String(it.lotteryDrawTime ?? '').slice(0, 10),
        ...(gameKey === 'dlt'
          ? { front: nums.slice(0, 5), back: nums.slice(5, 7) }
          : { digits: nums.slice(0, 3) }),
      }
    })
  }
  throw new Error(`未知彩种 ${gameKey}`)
}

/** 抓最新一期（对账用）：带该期奖级奖金表 */
export async function fetchLatestDraw(gameKey) {
  if (gameKey === 'ssq') {
    const [latest] = await fetchHistory(gameKey, 1)
    return latest ?? null
  }
  if (gameKey === 'dlt' || gameKey === 'p3') {
    const gameNo = gameKey === 'dlt' ? 85 : 350133
    const url = `https://webapi.sporttery.cn/gateway/lottery/getHistoryPageListV1.qry?gameNo=${gameNo}&provinceId=0&pageSize=1&isVerify=1&pageNo=1`
    const j = await jget(url, SPORTTERY_HEADERS)
    const lp = j?.value?.lastPoolDraw ?? {}
    const item = (Array.isArray(j?.value?.list) ? j.value.list : [])[0] ?? null
    const src = item ?? lp
    if (!src) return null
    const nums = String(src.lotteryDrawResult ?? '').trim().split(/\s+/).map(Number)
    return {
      issue: String(src.lotteryDrawNum ?? ''),
      date: String(src.lotteryDrawTime ?? '').slice(0, 10),
      prizeGrades: parseSportteryPrizes(lp.prizeLevelList ?? src.prizeLevelList),
      ...(gameKey === 'dlt'
        ? { front: nums.slice(0, 5), back: nums.slice(5, 7) }
        : { digits: nums.slice(0, 3) }),
    }
  }
  throw new Error(`未知彩种 ${gameKey}`)
}

/** 彩种元信息（提示词里引用开奖时间文案） */
export function gameMeta(gameKey) { return GAMES[gameKey] ?? null }
