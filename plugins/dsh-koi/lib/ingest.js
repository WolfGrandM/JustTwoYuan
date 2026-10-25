/**
 * dsh-koi 学习摄入流水线（第二波 docs/19 §4，FR-1013/1014、S-107/118/119、BC-012/107）。
 *
 * 三通道：面板上传（raw body，W2A-11）/ 目录投喂（$DSH_HOME/koi-work/inbox/，W2A-21）/ CLI。
 * jobs 存储 koi-ingest/jobs.json（完成态滚动保留 50）；文件产物 koi-ingest/files/*（审计面，不主动清）。
 *
 * 流水线（processJob，§4.4）：
 *   0 作业互斥（W2A-20 job-lock，backfill/ingest/backtest 三者互斥；被占 → queued 等待）
 *   1 守卫：格式白名单 .txt/.md（PDF/EPUB 明示暂不支持，S-118）/ ≤20MB
 *   2 错峰守卫（BC-012）：17:00–22:30 → queued「错峰等待中」
 *   3 cleaning：cleanText（§4.3）→ 清洗文本落盘；清洗后为空 rejected；> maxCleanChars rejected（分卷提示）；
 *     预算预检（W2A-22：估算超本周剩余 → rejected，防单文件把整周学习锁死在 pauseLearning）
 *   4 splitting：走既有会话 promptAgent（FR-1022/S-117，与 advisory 同款注入先例）；
 *     文件契约交卷 → schema 校验 → 一次打回 → 仍不过 → pending-llm（S-119）；
 *     no-model → 直接 rejected（不进待补，清晰失败更诚实）
 *   5 dedup 两级（W2A-12 merged 默认 + rule-dup 三态保守拒入）
 *   6 done：新卡入库（cards 单写者=持锁串行域，W2A-23）→ 因子化链式触发（逐卡：因子化→注册→回测→回写；
 *     单卡失败不阻塞下一卡）→ pending-llm 自动重试（每 tick 至多 1 个，重跑前按 sourceJob 回滚）
 */
import fs from 'node:fs'
import path from 'node:path'
import { readJson, writeJsonAtomic } from './io.js'
import { cleanText } from './preprocess.js'
import { findRuleDup, nameKey } from './cards.js'
import { estTokens } from './usage.js'
import { factorizeCard } from './factorize.js'
import { inOffpeakWindow } from './backfill.js'

const EXT_OK = ['.txt', '.md']
const FORMAT_REJECT = '支持 .txt / .md（≤20MB）；PDF/EPUB 请先转为文本（暂不支持直接解析，已在待办）'
const SPLIT_WAIT_MS = 10 * 60_000
const SPLIT_POLL_MS = 3_000
const JOBS_KEEP_DONE = 50

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const randSuffix = () => Math.random().toString(36).slice(2, 8)
const extOf = (name) => path.extname(String(name ?? '')).toLowerCase()

/** 上传面 token 估算（§4.1 BC-107 补位：字节/12，中文 UTF-8 保守折算） */
export const estimateTokensFromBytes = (bytes) => Math.max(0, Math.ceil(Number(bytes ?? 0) / 12))

/** 分块拆卡（主人 2026-10-25 反馈：420KB 文档单次交卷两次不合格——大文档超出模型单次合规上限）：
 *  按空行段落聚成 chunkChars 块，超长单段硬切。导出供测试。 */
export function splitIntoChunks(text, chunkChars) {
  const t = String(text ?? '')
  if (t.length <= chunkChars) return [t]
  const out = []
  let buf = ''
  for (const para of t.split(/\n{2,}/)) {
    const candidate = buf ? buf + '\n\n' + para : para
    if (candidate.length > chunkChars && buf) { out.push(buf); buf = para } else { buf = candidate }
    while (buf.length > chunkChars) { out.push(buf.slice(0, chunkChars)); buf = buf.slice(chunkChars) }
  }
  if (buf.trim()) out.push(buf)
  return out.length ? out : [t]
}

export function createIngest({
  dshHome,
  cardsStore,
  usage,                       // createUsageTracker（预算预检用；可 null）
  lock,                        // job-lock（W2A-20）
  promptAgent,                 // (text) => Promise —— 调度器侧注入其会话（activity=learning 由注入方包装）
  now = () => new Date(),
  readCfg = () => ({}),
  log = () => {},
  backtest = null,             // 回测引擎（链式触发；null → 只入库不因子化）
  budgetState = null,          // () => { totals, demo } —— 预算预检（可 null → 退化为只看周额度）
  waitMs = SPLIT_WAIT_MS,
} = {}) {
  const INGEST_DIR = path.join(dshHome ?? '.', 'koi-ingest')
  const FILES_DIR = path.join(INGEST_DIR, 'files')
  const JOBS_FILE = path.join(INGEST_DIR, 'jobs.json')
  const INBOX_DIR = path.join(dshHome ?? '.', 'koi-work', 'inbox')

  // CLI 形态无宿主会话（promptAgent 未注入）：拆卡调用抛清晰错误 → job 落 pending-llm
  // （宿主调度器 tick 自动续跑，S-119）——清晰失败优于假装处理。
  const callAgent = typeof promptAgent === 'function'
    ? promptAgent
    : async () => { throw new Error('当前进程无宿主会话（已登记待补：宿主锦鲤运行中会自动续跑拆卡）') }

  const readJobs = () => readJson(JOBS_FILE, { schemaVersion: 1, jobs: [] })
  const writeJobs = (s) => writeJsonAtomic(JOBS_FILE, s)
  const findJob = (id) => (readJobs().jobs ?? []).find((j) => j.id === id) ?? null
  const saveJob = (job) => {
    const s = readJobs()
    const i = (s.jobs ?? []).findIndex((j) => j.id === job.id)
    if (i >= 0) s.jobs[i] = job
    else s.jobs.push(job)
    writeJobs(s)
    return job
  }
  const compactJobs = () => {
    const s = readJobs()
    const open = (s.jobs ?? []).filter((j) => !['done', 'rejected'].includes(j.status))
    const done = (s.jobs ?? []).filter((j) => ['done', 'rejected'].includes(j.status))
    s.jobs = [...open, ...done.slice(-JOBS_KEEP_DONE)]
    writeJobs(s)
  }

  const cfgOf = () => {
    const c = readCfg()?.ingest ?? {}
    return {
      maxFileBytes: (Number(c.maxFileMB) > 0 ? Number(c.maxFileMB) : 20) * 1024 * 1024,
      maxCleanChars: Number(c.maxCleanChars) > 0 ? Number(c.maxCleanChars) : 200_000,
      chunkChars: Number(c.chunkChars) > 0 ? Number(c.chunkChars) : 30_000,
      dedup: c.dedup === 'rule-only' ? 'rule-only' : 'merged',
      offpeakOnly: c.offpeakOnly !== false,
    }
  }

  /** §4.6 拆卡提示词（文件契约；库内既有卡片清单注入——>200 张按近 30 天+全部名称截断；分块模式附 chunkNote） */
  function buildSplitPrompt({ cleanFile, outFile, jobId, chunkNote = '' }) {
    const cards = cardsStore.list()
    let listText = '（库内还没有卡片）'
    let truncNote = ''
    if (cards.length) {
      const recent = cards.filter((c) => Date.parse(c.createdAt ?? '') > now().getTime() - 30 * 86_400_000)
      const picked = cards.length > 200 ? recent : cards
      listText = picked.map((c) => `${c.id}｜${c.name}｜${String(c.rule ?? '').slice(0, 60)}`).join('\n  ') || '（近 30 天无卡片，仅名称清单见下）'
      if (cards.length > 200) {
        listText += '\n  ' + cards.map((c) => `${c.id}｜${c.name}`).join('\n  ')
        truncNote = `（库内共 ${cards.length} 张，超过 200 张：先列近 30 天 ${recent.length} 张全量，再列全部名称清单——截断口径）`
      }
    }
    return [
      `【任务】读取清洗后的文本文件：${cleanFile}，把其中的「选号技巧」拆成结构化卡片。${chunkNote}`,
      '【库内既有卡片（判重参照）】' + truncNote,
      `  ${listText}`,
      '',
      '【交卷方式 —— 最重要的部分】',
      `用 shell 把结果写进 ${outFile}（合法 JSON）：`,
      '{"schemaVersion":1,"cards":[',
      '{"name":"≤20字技巧名","games":["ssq|dlt|p3 子集"],"rule":"原文规则忠实摘录（≤200字，不改写不脑补）","computable":true|false,"dupOf":null|"card-…既有id","similarTo":null|"card-…既有id"}]}',
      '硬性规则：',
      '  · 只拆「针对具体彩种开奖号码的选号技巧」；作者闲谈/心态建议 → 不成卡（宁缺毋滥）；',
      '  · rule 必须是文本中真实存在的表述（可轻度压缩，不得引入文本外知识）；',
      '  · dupOf/similarTo 只能填上面清单里的 id，别的值一律按 null 处理会被校验拒收；',
      '  · 与既有卡完全同义 → dupOf 指它（不重复入库）；相近但条件不同（如区间不同）→ similarTo；',
      `  · 写完文件就收工：不要发任何消息、不要动这个文件之外的东西。（jobId=${jobId}）`,
    ].join('\n')
  }

  /** 交卷 schema 校验（白名单 games / dupOf 白名单 → 非法引用按 null） */
  function validateCardsPayload(raw) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.cards)) return { ok: false, error: 'cards 数组缺失' }
    const ids = new Set(cardsStore.list().map((c) => c.id))
    const out = []
    for (const [i, c] of raw.cards.entries()) {
      if (!c || typeof c !== 'object' || typeof c.name !== 'string' || !c.name.trim()) return { ok: false, error: `cards[${i}].name 缺失` }
      if (typeof c.rule !== 'string' || !c.rule.trim()) return { ok: false, error: `cards[${i}].rule 缺失` }
      const games = Array.isArray(c.games) ? c.games.filter((g) => ['ssq', 'dlt', 'p3'].includes(g)) : []
      if (!games.length) return { ok: false, error: `cards[${i}].games 必须是 ssq/dlt/p3 的非空子集` }
      const refOf = (v) => (typeof v === 'string' && ids.has(v) ? v : null)   // 白名单外一律 null
      out.push({
        name: c.name.trim().slice(0, 20),
        games,
        rule: c.rule.trim().slice(0, 200),
        computable: c.computable === true,
        dupOf: refOf(c.dupOf),
        similarTo: refOf(c.similarTo),
      })
    }
    return { ok: true, cards: out }
  }

  async function waitJsonFile(p, timeoutMs) {
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs) {
      try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { /* 还没写好 */ }
      await sleep(SPLIT_POLL_MS)
    }
    return null
  }

  const rejectJob = (job, error) => saveJob({ ...job, status: 'rejected', error, updatedAt: now().toISOString() })

  /**
   * 上传/投喂入口：写原件 + 建 job（queued）。process=true 时异步开跑流水线（面板/CLI 同步处理用 false）。
   * 守卫失败不建 job（S-118 拒收并说明）：返回 { ok:false, code:415|413, error }。
   */
  function acceptBuffer({ name, buffer, sourceType = 'user-file', process = true }) {
    const cfg = cfgOf()
    const ext = extOf(name)
    if (!EXT_OK.includes(ext)) return { ok: false, code: 415, error: FORMAT_REJECT }
    const size = Buffer.isBuffer(buffer) ? buffer.length : Buffer.byteLength(String(buffer ?? ''))
    if (size > cfg.maxFileBytes) {
      return { ok: false, code: 413, error: `文件 ${(size / 1024 / 1024).toFixed(1)}MB 超过 ${Math.round(cfg.maxFileBytes / 1024 / 1024)}MB 上限` }
    }
    const id = `ing-${now().getTime()}-${randSuffix()}`
    const job = {
      id, name: path.basename(String(name ?? 'upload')), size, ext: ext.slice(1),
      status: 'queued', error: null, cards: null,
      sourceType, at: now().toISOString(), updatedAt: now().toISOString(),
    }
    fs.mkdirSync(FILES_DIR, { recursive: true })
    fs.writeFileSync(path.join(FILES_DIR, `${id}${ext}`), buffer)
    saveJob(job)
    if (process) processJob(id).catch((e) => log(`[koi] ingest ${id} 处理异常：${String(e?.message ?? e).slice(0, 160)}`))
    return { ok: true, job: { ...job }, estimate: estimateTokensFromBytes(size) }
  }

  /** 目录投喂扫描（调度器 tick 挂载；仅发现新文件建 job，处理受守卫约束） */
  function scanInbox() {
    let created = 0
    let files = []
    try { files = fs.readdirSync(INBOX_DIR, { withFileTypes: true }) } catch { return { created: 0, note: 'inbox 不存在（首次投喂时创建）' } }
    for (const f of files) {
      if (!f.isFile()) continue
      const ext = extOf(f.name)
      if (!EXT_OK.includes(ext)) { log(`[koi] inbox 跳过不支持的文件：${f.name}（${FORMAT_REJECT}）`); continue }
      try {
        const buf = fs.readFileSync(path.join(INBOX_DIR, f.name))
        const r = acceptBuffer({ name: f.name, buffer: buf, sourceType: 'inbox' })
        if (r.ok) { fs.rmSync(path.join(INBOX_DIR, f.name), { force: true }); created += 1 }   // 移动即防重复投喂
        else log(`[koi] inbox 文件被拒收：${f.name}（${r.error}）——文件保留在 inbox 待主人处理`)
      } catch (e) { log(`[koi] inbox 扫描 ${f.name} 失败：${String(e?.message ?? e).slice(0, 120)}`) }
    }
    return { created }
  }

  /** 流水线主入口（§4.4）。返回 { ok, job } / { ok:false, waiting, note } / { ok:false, error } */
  async function processJob(jobId) {
    let job = findJob(jobId)
    if (!job) return { ok: false, error: '没有这个任务' }
    if (['done', 'rejected'].includes(job.status)) return { ok: true, job }
    if (['cleaning', 'splitting', 'dedup'].includes(job.status)) return { ok: false, error: '该任务处理中' }
    const cfg = cfgOf()
    // 0 作业互斥（被占 → queued 等待，面板可见）
    const acq = typeof lock?.acquire === 'function' ? lock.acquire('ingest', jobId) : { ok: true }
    if (!acq.ok) {
      const note = `等待另一后台作业（${acq.held?.kind ?? '?'}/${acq.held?.key ?? '-'}）`
      const waiting = saveJob({ ...job, waitingNote: note, updatedAt: now().toISOString() })
      return { ok: false, waiting: true, note, job: waiting }
    }
    try {
      // 2 错峰守卫（学习不是时效性活动，等一夜无害）
      if (cfg.offpeakOnly && inOffpeakWindow(now())) {
        const note = '错峰等待中（22:30 后自动继续）'
        const waiting = saveJob({ ...job, waitingNote: note, updatedAt: now().toISOString() })
        return { ok: false, waiting: true, note, job: waiting }
      }
      job = findJob(jobId)
      // 1 格式/大小守卫（入口已查，重入防御）
      if (!EXT_OK.includes(`.${job.ext}`)) return { ok: true, job: rejectJob(job, FORMAT_REJECT) }
      if (Number(job.size) > cfg.maxFileBytes) return { ok: true, job: rejectJob(job, `文件超过 ${Math.round(cfg.maxFileBytes / 1024 / 1024)}MB 上限`) }

      // 3 cleaning
      job = saveJob({ ...job, status: 'cleaning', waitingNote: null, updatedAt: now().toISOString() })
      try { lock?.heartbeat?.() } catch {}
      const raw = fs.readFileSync(path.join(FILES_DIR, `${job.id}.${job.ext}`), 'utf8')
      const cleaned = cleanText(raw)
      const cleanFile = path.join(FILES_DIR, `${job.id}.clean.md`)
      fs.mkdirSync(FILES_DIR, { recursive: true })
      fs.writeFileSync(cleanFile, cleaned.text)
      if (cleaned.stats.outChars === 0) return { ok: true, job: rejectJob(job, '清洗后无可读文本（原文可能全是图片/噪声）') }
      if (cleaned.stats.outChars > cfg.maxCleanChars) {
        return { ok: true, job: rejectJob(job, `清洗后 ${cleaned.stats.outChars} 字符超上限 ${cfg.maxCleanChars}，请分卷上传`) }
      }
      // 预算预检（W2A-22：拒绝发生在拆卡之前，零 LLM 成本）
      const weeklyCap = Number(readCfg()?.budget?.weeklyCap) > 0 ? Number(readCfg().budget.weeklyCap) : 1_500_000
      const used = usage ? usage.weekTotals().total : 0
      const est = estTokens(cleaned.text)
      if (est > weeklyCap - used) {
        return { ok: true, job: rejectJob(job, `单文件估算 ${est} tokens 超本周剩余额度 ${Math.max(0, weeklyCap - used)}，请调高预算或分卷`) }
      }
      const demo = budgetState ? budgetState().demo : null
      if (demo?.pauseLearning) {
        const note = '预算触顶，自然周重置后继续'
        const waiting = saveJob({ ...job, status: 'queued', waitingNote: note, updatedAt: now().toISOString() })
        return { ok: false, waiting: true, note, job: waiting }
      }

      // 4 splitting（LLM，文件契约；分块拆卡——主人 2026-10-25 反馈 420KB 文档单次交卷两次不合格后引入）
      job = saveJob({ ...job, status: 'splitting', clean: cleaned.clean, stats: cleaned.stats, updatedAt: now().toISOString() })
      const chunkChars = Number(cfg.chunkChars) > 0 ? Number(cfg.chunkChars) : 30_000
      const chunks = splitIntoChunks(cleaned.text, chunkChars)
      const noModel = (msg) => msg.includes('未配置模型') || msg.includes('[no-model]')
      const merged = []
      const chunkErrors = []
      for (let ci = 0; ci < chunks.length; ci++) {
        if (cfg.offpeakOnly && inOffpeakWindow(now())) {
          const note = `错峰等待中（拆卡 ${ci + 1}/${chunks.length} 块完成，22:30 后自动继续——续跑将从第 1 块重新拆起）`
          const waiting = saveJob({ ...job, status: 'queued', waitingNote: note, splitProgress: { done: ci, total: chunks.length }, updatedAt: now().toISOString() })
          return { ok: false, waiting: true, note, job: waiting }
        }
        job = saveJob({ ...job, splitProgress: { done: ci, total: chunks.length, note: `拆卡分块 ${ci + 1}/${chunks.length}` }, updatedAt: now().toISOString() })
        const partFile = path.join(FILES_DIR, `${job.id}.part${ci + 1}.md`)
        fs.writeFileSync(partFile, chunks[ci])
        const outFile = path.join(FILES_DIR, `${job.id}.cards.p${ci + 1}.json`)
        try { fs.rmSync(outFile, { force: true }) } catch {}
        try { lock?.heartbeat?.() } catch {}
        let splitErr = null
        try {
          await callAgent(buildSplitPrompt({
            cleanFile: partFile, outFile,
            jobId: `${job.id}#${ci + 1}/${chunks.length}`,
            chunkNote: `（本块是全文第 ${ci + 1}/${chunks.length} 段，前后文可能不完整——只拆本块内真实存在的技巧，宁缺毋滥）`,
          }))
        } catch (e) { splitErr = e }
        if (splitErr) {
          const msg = String(splitErr?.message ?? splitErr)
          if (noModel(msg)) return { ok: true, job: rejectJob(job, `拆卡环节不可用：${msg}（配置模型后重新上传）`) }   // 不进 pending-llm
          return { ok: true, job: saveJob({ ...job, status: 'pending-llm', error: `拆卡环节暂不可用（${msg.slice(0, 160)}）`, updatedAt: now().toISOString() }) }
        }
        try { lock?.heartbeat?.() } catch {}
        const raw1 = await waitJsonFile(outFile, waitMs)
        let v = raw1 == null ? { ok: false, error: '交卷超时（未等到文件）', timeout: true } : validateCardsPayload(raw1)
        if (!v.ok) {
          log(`[koi] ingest ${job.id} 块 ${ci + 1}/${chunks.length} 第一次交卷不合格（${v.error}），打回重写一次`)
          await callAgent(`【打回重写】你刚写的拆卡交卷校验没过：${v.error}。请立刻重写 ${outFile}（还是那个 JSON 契约），写完就停。`)
          try { lock?.heartbeat?.() } catch {}
          const raw2 = await waitJsonFile(outFile, Math.min(waitMs, 60_000))
          v = raw2 == null ? { ok: false, error: '重写交卷超时', timeout: true } : validateCardsPayload(raw2)
        }
        if (!v.ok) {
          if (v.timeout) {
            // 超时=瞬时态：S-119 落 pending-llm 由宿主续跑重拆（已拆块结果由重跑重建，dedup 按 sourceJob 回滚幂等）
            return { ok: true, job: saveJob({ ...job, status: 'pending-llm', error: `块 ${ci + 1}/${chunks.length} 交卷超时（宿主续跑将重拆）`, updatedAt: now().toISOString() }) }
          }
          chunkErrors.push(`块 ${ci + 1}/${chunks.length} 两次交卷不合格（${v.error}）`)
          continue   // 内容不合格=确定态：单块失败不拖垮整体（部分成功优于整体拒收）
        }
        for (const c of v.cards) {
          const nk = nameKey(c.name)
          if (nk && merged.some((m) => nameKey(m.name) === nk)) continue   // 块间同名去重（跨块边界重复提及同一技巧）
          merged.push(c)
        }
      }
      if (!merged.length) {
        const detail = chunkErrors.length ? `分块错误：${chunkErrors.join('；')}` : '全文未拆出任何选号技巧（宁缺毋滥口径）'
        return { ok: true, job: rejectJob(job, `拆卡完成但 0 张卡片——${detail}`) }
      }
      if (chunkErrors.length) job = saveJob({ ...job, splitErrors: chunkErrors, updatedAt: now().toISOString() })
      let v = { ok: true, cards: merged }

      // 5 dedup（三态 + 开关；S-119 幂等：重跑前先回滚本 job 已写入的卡片）
      job = saveJob({ ...job, status: 'dedup', updatedAt: now().toISOString() })
      cardsStore.removeByJob(job.id)
      const existing = cardsStore.list()
      const accepted = []
      const results = []
      for (const c of v.cards) {
        const ruleDup = findRuleDup({ name: c.name, rule: c.rule }, [...existing, ...accepted])
        if (cfg.dedup === 'merged' && c.dupOf) {
          results.push({ name: c.name, verdict: `duplicate-of:${c.dupOf}`, cardId: null })
          continue
        }
        if (ruleDup) {
          results.push({ name: c.name, verdict: `rule-dup:${ruleDup.card.id}`, cardId: null, ruleDupName: ruleDup.card.name })
          continue
        }
        const [created] = cardsStore.addCards([{
          name: c.name, games: c.games, rule: c.rule, computable: c.computable,
          similarOf: cfg.dedup === 'merged' ? c.similarTo : null,
          source: job.name, sourceType: job.sourceType, sourceJob: job.id, clean: cleaned.clean,
        }])
        accepted.push(created)
        results.push({
          name: c.name, cardId: created.id,
          verdict: created.similarOf ? `similar-to:${created.similarOf}` : 'new',
        })
      }

      // 6 done + 因子化链式触发（W2A-23：同一持锁串行域；单卡失败不阻塞下一卡）
      job = saveJob({ ...job, status: 'done', error: null, cards: results, updatedAt: now().toISOString() })
      compactJobs()
      for (const card of accepted) {
        try {
          await runFactorizeChain(card)
        } catch (e) {
          log(`[koi] 卡片 ${card.id} 因子化链失败（不阻塞下一卡）：${String(e?.message ?? e).slice(0, 160)}`)
        }
      }
      return { ok: true, job }
    } finally {
      try { lock?.release?.() } catch {}
    }
  }

  /** 链式触发：因子化 → 注册 → 回测（useLock:false，锁域内）→ 结论回写（§5.7/§5.5） */
  async function runFactorizeChain(card) {
    if (!backtest) return { ok: false, skipped: 'no-backtest' }
    if (!card.computable) return { ok: false, skipped: 'not-computable' }
    if ((card.games ?? []).length !== 1) {
      cardsStore.update(card.id, { status: 'factorize-failed', factorizeError: '适用彩种非唯一，本波 DSL 需单彩种（多彩种拆卡请分卡上传）' })
      return { ok: false, reason: '多彩种卡片暂不因子化（登记待办）' }
    }
    const fr = await factorizeCard({ card, promptAgent: callAgent, filesDir: FILES_DIR, now, log })
    if (!fr.ok) {
      cardsStore.markFactorizeFailed(card.id, fr.reason ?? fr.error ?? '未知')
      return { ok: false, reason: fr.reason ?? fr.error }
    }
    cardsStore.update(card.id, { factorId: fr.factor.id })
    try { backtest.register(fr.factor) } catch (e) {
      cardsStore.markFactorizeFailed(card.id, `注册失败：${String(e?.message ?? e)}`)
      return { ok: false, reason: 'register-failed' }
    }
    const r = await backtest.runFactor(fr.factor, { useLock: false })
    if (r.ok) {
      backtest.archiveRun([r], { game: fr.factor.game, label: `chain:${card.id}` })
      return { ok: true, factorId: fr.factor.id, verdict: r.verdict }
    }
    cardsStore.update(card.id, { factorizeError: `回测未出结论：${r.error}` })
    return { ok: false, reason: r.error }
  }

  /** 调度器 tick 驱动：pending-llm 重试（S-119，每 tick 至多 1 个）+ queued 处理（每 tick 至多 1 个） */
  async function pumpJobs() {
    const jobs = readJobs().jobs ?? []
    const pending = jobs.find((j) => j.status === 'pending-llm')
    if (pending) {
      const cfg = cfgOf()
      if (cfg.offpeakOnly && inOffpeakWindow(now())) return { ran: 0, note: '错峰等待中' }
      const demo = budgetState ? budgetState().demo : null
      if (demo?.pauseLearning) return { ran: 0, note: '预算触顶等待' }
      const r = await processJob(pending.id)
      return { ran: r.ok && !r.waiting ? 1 : 0, retried: pending.id }
    }
    const queued = jobs.find((j) => j.status === 'queued')
    if (queued) {
      const r = await processJob(queued.id)
      return { ran: r.ok && !r.waiting ? 1 : 0, job: queued.id }
    }
    return { ran: 0 }
  }

  return {
    INGEST_DIR, JOBS_FILE, FILES_DIR, INBOX_DIR,
    acceptBuffer,
    scanInbox,
    processJob,
    pumpJobs,
    runFactorizeChain,
    buildSplitPrompt,
    validateCardsPayload,
    list: () => ({ jobs: readJobs().jobs ?? [], cards: cardsStore.list() }),
    getJob: findJob,
    statusOf: () => {
      const jobs = readJobs().jobs ?? []
      const counts = {}
      for (const j of jobs) counts[j.status] = (counts[j.status] ?? 0) + 1
      return { counts, total: jobs.length }
    },
  }
}
