/**
 * dsh-koi 本地开奖库（市场版 FR-1024/BC-105）—— koi/draws/<game>.json 永久累积，
 * 抓过即入库（增量挂对账 + 手动按需共用），二次请求零网络（AC-115）。
 *
 * 近期窗口按需抓取（MC-03）：ensureRecent = 库足（≥n 且最新非陈旧）→ 零网络返回本地；
 * 不足/为空/陈旧 → fetchHistory 按需补拉 → 校验 → 入库 → 返回。
 * 全量回拉底座（backfill）已在第二波落地为 lib/backfill.js（docs/19 §2）——本模块是其
 * 存取基座（upsertBatch/status/oldest）。
 *
 * 工厂注入 fetch/now（MD-04）：测试以 mock fetch 计网络调用次数（AC-115 断言口径）。
 * 读写全部走 lib/io.js 原子写（IF-R03）。
 */
import path from 'node:path'
import { readJson, writeJsonAtomic } from './io.js'
import { validateDraws } from './validate-draws.js'
import { isStaleDraw } from './settle-core.js'   // T-05：原自 scheduler.js import（循环②消除，函数体零改动）
import { todayStr as todayOf } from './timeutil.js'   // T-07：时间工具单点（sv-SE 逐字保持）

const defaultFetch = {
  history: null,   // 惰性绑定，避免与 fetch-draws.mjs 形成加载期循环
  async fetchHistory(game, count) {
    this.history ??= (await import('./fetch-draws.mjs')).fetchHistory
    return this.history(game, count)
  },
}

export function createDrawStore({ dataDir, fetch = defaultFetch, now = () => new Date(), staleMaxDays = 7 } = {}) {
  const dir = path.join(dataDir ?? '.', 'draws')
  const fileOf = (game) => path.join(dir, `${game}.json`)
  const todayStr = () => todayOf(now())   // T-07：实现体引用单点，保留 now 注入

  const readStore = (game) => readJson(fileOf(game), { schemaVersion: 1, entries: [] })
  const writeStore = (game, store) => writeJsonAtomic(fileOf(game), store)

  /** 最新在前（与 fetchHistory 同序），切片 n 条（防御性按期号排序，不依赖文件写入顺序） */
  function getRecent(game, n) {
    const entries = readStore(game).entries ?? []
    return entries.slice().sort((a, b) => Number(b.issue) - Number(a.issue)).slice(0, n).map((e) => ({ ...e }))
  }

  /**
   * 批量入库：先 validateDraws 后入库（BC-104），逐条拒用记 rejected；upsert 幂等去重（键 issue）。
   * 返回 { added, rejected, total }。
   */
  function upsertBatch(game, batch) {
    const v = validateDraws(game, batch, { today: todayStr() })
    const store = readStore(game)
    const map = new Map((store.entries ?? []).map((e) => [String(e.issue), e]))
    for (const e of v.valid) map.set(String(e.issue), { ...e })
    store.entries = [...map.values()].sort((a, b) => Number(a.issue) - Number(b.issue))   // 升序存（§5.1）
    store.schemaVersion = 1
    writeStore(game, store)
    return { added: v.valid.length, rejected: v.rejected, total: store.entries.length }
  }

  /** 库内最早期号（第二波 backfill 续拉起点；升序存语义下 O(1)。空库返回 null） */
  function oldest(game) {
    const entries = readStore(game).entries ?? []
    let min = null
    for (const e of entries) if (min == null || Number(e.issue) < Number(min)) min = e.issue
    return min
  }

  /** 库状态（DC-109 面向 /api/backbone GET；latest 防御性取期号最大者——正常文件升序，异常顺序不误判） */
  function status(game) {
    const entries = readStore(game).entries ?? []
    let latest = null
    for (const e of entries) if (latest == null || Number(e.issue) > Number(latest.issue)) latest = e
    let continuityOk = null
    if (entries.length >= 2) {
      const nums = entries.map((e) => Number(e.issue))
      continuityOk = Math.max(...nums) > Math.min(...nums)   // 单调（跨年也单调）；详细连续性由入库时校验把关
    }
    return {
      count: entries.length,
      latestIssue: latest?.issue ?? null,
      latestDate: latest?.date ?? null,
      fresh: latest ? !isStaleDraw(latest.date, todayStr(), staleMaxDays) : false,
      continuityOk,
    }
  }

  /**
   * 近期窗口按需抓取（FR-1024 / MC-03 向导第 5 步后端）：
   * 库足（≥n 且最新期非陈旧）→ { history, fetched:0 } 零网络；
   * 否则 fetchHistory(game, n) → 校验入库 → { history, fetched:1 }。
   * 抓取失败抛清晰错误（S-117 可重试）。
   */
  async function ensureRecent(game, n) {
    const st = status(game)
    if (st.count >= n && st.fresh) return { history: getRecent(game, n), fetched: 0 }
    let remote
    try {
      remote = await fetch.fetchHistory(game, n)
    } catch (e) {
      throw new Error(`本地库不足且在线抓取失败（可重试）：${e?.message ?? e}`)
    }
    if (!Array.isArray(remote) || !remote.length) throw new Error('官方历史数据为空（本地库不足）')
    upsertBatch(game, remote)
    return { history: getRecent(game, n), fetched: 1 }
  }

  return { getRecent, upsertBatch, upsert: (game, one) => upsertBatch(game, [one]), ensureRecent, status, oldest, fileOf }
}

// ── 第二波接缝已落地（MC-03 → docs/19 §2）：backfill 全量回拉底座在 lib/backfill.js ──
// 引擎消费本模块（upsertBatch/status/oldest/getRecent）+ fetch-draws.mjs 的 fetchHistoryPage
// 分页层（福彩期号窗口 / 体彩 pageSize=100+pageNo）；checkpoint koi/databackbone.json、
// 断点续传、批间限速、退避、错峰（含运行中跨入暂停）与作业锁互斥均由 backfill 编排。
// 本模块保持「本地库」单一职责。
