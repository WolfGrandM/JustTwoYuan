/**
 * dsh-koi 复盘叙述层（M4 T2 / docs/28 §2.1 narrate.js + §5 LLM 最小化）。
 *
 * LLM 只叙述：输入 = 代码计算结果 JSON（含归因 items/战绩/健康数字）；输出三闸——
 * ① 引用因子 ID 必须在因子库（防幻觉因子，AC-009，whitelistFactorIds 复用 attribution.js）；
 * ② hasProbabilityClaim 禁用词（BC-112 闸复用——经注入，§2.4 禁 review→render import）；
 * ③ 长度预算 ≤600 字。任一闸两次不过 → code-only 模板叙述 + 「LLM 叙述缺席：<原因>」标注（不静默）。
 *
 * 输出通道 = 文件契约（宿主先例：predict/advisory 均交卷文件——promptAgent 返回值不可用）：
 * 提示词指定 narrate-<ts>.json { text }，waitJsonFile 等卷。
 * 计量（BC-013）：输入侧由注入的 promptAgent 记（activity='review'）；输出侧本模块再记一笔（同一 activity）。
 * cap 态（demo.allowLLM=false）→ 叙述跳过、code-only 照发（BC-013「复盘/学习类活动暂停」）。
 */
import path from 'node:path'
import fs from 'node:fs'
import { waitJsonFile } from '../fspoll.js'
import { estTokens } from '../usage.js'
import { whitelistFactorIds } from './attribution.js'

const NARRATE_MAX_CHARS = 600
const FILE_WAIT_MS = 120_000
const FILE_POLL_MS = 3_000

/** BC-012 错峰窗口复用（backfill.js:32-35 单点；ingest.js:27 同款 import 先例——backfill 不依赖 review，无环） */
import { inOffpeakWindow } from '../backfill.js'

/** 因子 ID 提取（叙述文本中的 builtin-* / card:* 词形） */
const extractFactorIds = (text) =>
  String(text ?? '').match(/[A-Za-z0-9_-]*builtin[A-Za-z0-9_-]*|card:[A-Za-z0-9_-]+/g) ?? []

/** code-only 降级模板：代码数字的确定性汇总，绝不发明新数字（诚实条款） */
function codeOnlyText(section, data) {
  let compact = ''
  try { compact = JSON.stringify(data ?? {}) } catch { compact = '{}' }
  if (compact.length > 400) compact = compact.slice(0, 400) + '…'
  return `【${section} · 代码口径汇总】${compact}`
}

export function createNarrator({
  promptAgent,
  usage,
  readCfg = () => ({}),
  budgetState = () => ({ demo: { allowLLM: true } }),
  now = () => new Date(),
  workDir = '.',
  log = () => {},
  hasProbabilityClaim = null,   // BC-112 闸经注入（§2.4 禁 review→render import）；生产装配必注入（scheduler.js）
  stopCheck = () => false,
} = {}) {
  if (typeof promptAgent !== 'function') throw new Error('createNarrator 缺 promptAgent 注入')
  try { fs.mkdirSync(workDir, { recursive: true }) } catch { /* 目录在位即可 */ }   // 交卷文件落点（tick 外的 CLI 路径也保证存在）
  const probClaimGate = typeof hasProbabilityClaim === 'function'
    ? hasProbabilityClaim
    : () => false   // 测试态旁路（旁路时日志注明；生产装配注入 render.js 既有闸）

  /**
   * 叙述一段。section ∈ '战绩对照' | '健康节'（§3.4：LLM 只覆盖节 1/节 3 汇总段，各 1 次 + ≤1 打回）。
   * data = 代码计算结果（纯数字/数组，无自然语言结论）。
   * 返回 { ok:true, text, source:'llm'|'code-only', reason? }——code-only 时 reason=缺席原因（不静默）。
   */
  async function narrate({ section, data, noOffpeak = false, knownFactorIds = [] } = {}) {
    const cfg = readCfg()
    // ① cap 态（BC-013）：复盘/学习类活动暂停 → code-only 照发
    let demo = null
    try { demo = budgetState(cfg)?.demo ?? null } catch { /* 预算面异常按可叙述处理 */ }
    if (demo && demo.allowLLM === false) {
      return { ok: true, text: codeOnlyText(section, data), source: 'code-only', reason: '预算触顶 · 叙述暂停（BC-013）' }
    }
    // ② 显式开关（review.narrative=false；§2.3 config 设计，缺省视为开）
    if (cfg?.review?.narrative === false) {
      return { ok: true, text: codeOnlyText(section, data), source: 'code-only', reason: 'review.narrative 已关闭' }
    }
    // ③ BC-012 错峰守卫：17:00–22:30 拒调；调度侧 22:40/23:45 天然窗外；CLI --no-offpeak 显式越过
    if (!noOffpeak && inOffpeakWindow(now())) {
      return { ok: true, text: codeOnlyText(section, data), source: 'code-only', reason: '错峰窗口（17:00–22:30）内不调用叙述 LLM（BC-012）' }
    }
    if (hasProbabilityClaim == null) log('[koi] narrate 未注入概率宣称闸——闸②旁路（仅测试态允许）')

    const outPath = path.join(workDir, `narrate-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`)
    const dataJson = JSON.stringify({ section, data, knownFactorIds })
    const basePrompt = [
      '【任务】你是「锦鲤」复盘叙述员。下面是代码算好的复盘数据 JSON，你只把它叙述成人话，不许改任何数字、不许下「会中/建议买入/提高概率」类结论。',
      `【数据】${dataJson}`,
      `【交卷方式】用 shell 把叙述写进 ${outPath}（合法 JSON）：{"text":"≤${NARRATE_MAX_CHARS} 字的叙述"}，写完就停。`,
      '【红线】开奖是独立随机事件，叙述不得暗示任何预测能力；引用因子时只能用数据里 knownFactorIds 列出的因子 ID。',
    ].join('\n')
    let lastProblems = []
    try { fs.rmSync(outPath, { force: true }) } catch {}

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await promptAgent(attempt === 1 ? basePrompt : [
          '【打回重写】你上一稿叙述没过闸：' + lastProblems.join('；') + '。',
          `请重写并覆盖同一文件 ${outPath}（还是 {"text":"…"} 契约），写完就停。`,
        ].join('\n'))
      } catch (e) {
        return { ok: true, text: codeOnlyText(section, data), source: 'code-only', reason: `LLM 调用失败：${String(e?.message ?? e).slice(0, 120)}` }
      }
      const raw = await waitJsonFile(outPath, { timeoutMs: FILE_WAIT_MS, pollMs: FILE_POLL_MS, stopCheck })
      const text = String(raw?.text ?? '').trim()
      if (!text) { lastProblems = ['没有等到叙述文件或 text 为空']; continue }
      // 三闸
      const problems = []
      if (text.length > NARRATE_MAX_CHARS) problems.push(`叙述超长（${text.length} 字 > ${NARRATE_MAX_CHARS}）`)
      if (probClaimGate(text)) problems.push('叙述含概率宣称禁用词（BC-112）')
      const ids = extractFactorIds(text)
      const { rejected } = whitelistFactorIds(ids, knownFactorIds)
      if (rejected.length) problems.push(`叙述引用了不在因子库的因子：${rejected.join('、')}（AC-009 幻觉因子拒用）`)
      if (!problems.length) {
        try { usage?.record?.('review', estTokens(text)) } catch { /* 计量尽力而为，不损叙述 */ }
        try { fs.rmSync(outPath, { force: true }) } catch {}
        return { ok: true, text, source: 'llm' }
      }
      lastProblems = problems
    }
    try { fs.rmSync(outPath, { force: true }) } catch {}
    return { ok: true, text: codeOnlyText(section, data), source: 'code-only', reason: `LLM 叙述缺席：两次未过闸（${lastProblems.join('；')}）` }
  }

  return { narrate, NARRATE_MAX_CHARS }
}
