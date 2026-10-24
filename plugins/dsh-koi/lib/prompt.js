/**
 * dsh-koi 提示词层 —— 唤醒「锦鲤」时塞给她的完整回合内容。
 *
 * 设计要点：
 *   · 数据包直接嵌进提示词（她不用自己跑抓数命令，醒来即研究，2–4 分钟收工）
 *   · 输出走【文件契约】：她把结构化 JSON 写进会话目录里的约定文件名，
 *     调度器读文件 → validatePicks 硬校验 → 不合法重试 → 还不行随机兜底。
 *     绝不解析自由文本 ✓（这是她不会哑火的保证）
 *   · 明令禁止：不许自己发消息、不许动会话目录外的文件（她虽然 danger-full-access，
 *     但提示词里说清楚 + 她没有 QQ 发送工具，双保险）
 */
import { GAMES, stakesOf } from './draws.js'
import { dataPack } from './stats.js'

export const DEFAULT_PERSONA = [
  '你叫「锦鲤」，是主人养的第二条鱼（隔壁还有一条刷 B 站的鲸鱼，别串台）。',
  '性格：元气满满的小财迷，对「暴富」有谜之自信，说话又快又甜，偶尔自吹「本锦鲤今日运势极旺」。',
  '你研究走势图是真的认真（虽然你心里清楚开奖是随机的），但嘴上永远赢：没中就说「差一点点，气运在攒」，中了小奖就原地蹦高。',
  '你给主人写东西像一个热心朋友在耳边唠，不像 AI 汇报。禁止出现「作为 AI / 根据分析模型」这类词。',
].join('\n')

const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

const specText = (gameKey) => {
  const g = GAMES[gameKey]
  const s = stakesOf(gameKey)
  if (gameKey === 'ssq') return `复式：从 1–${g.redMax} 里选 ${g.complex.red} 个红球 + 1–${g.blueMax} 里选 1 个蓝球（自动拆成 ${s.bets} 注，投注额 ${s.cost} 元）`
  if (gameKey === 'dlt') return `复式：从 1–${g.frontMax} 里选 ${g.complex.front} 个前区号 + 1–${g.backMax} 里选 ${g.complex.back} 个后区号（自动拆成 ${s.bets} 注，投注额 ${s.cost} 元）`
  return `直选一注：三位数 0–9（百位-十位-个位，如 3-7-1），投注额 2 元`
}

/**
 * 组装唤醒提示词。
 * @param opts { gameKey, cfg, history, issue, outPath, late }
 */
export function buildPredictPrompt({ gameKey, cfg, history, issue, outPath, late }) {
  const g = GAMES[gameKey]
  const s = stakesOf(gameKey)
  const persona = String(cfg?.persona ?? '').trim() || DEFAULT_PERSONA
  const pack = dataPack(gameKey, history, { tailCount: Number(cfg?.historyTail ?? 10) })
  const today = new Date()
  const dateStr = today.toLocaleDateString('sv-SE')
  const week = WEEKDAY[today.getDay()]
  const drawDay = `${today.getFullYear()} 年 ${today.getMonth() + 1} 月 ${today.getDate()} 日（${week}）`

  return [
    `［人设］${persona}`,
    '',
    `【任务】今天是 ${drawDay}，${g.name}今晚开奖（${g.drawTimeText}）。第 ${issue} 期。${late ? '⚠️ 比平时晚了一拍（系统原因），分析可以短一点，先把号交出来。' : ''}`,
    `你今天的玩法：${specText(gameKey)}。`,
    '',
    '【今天的研究材料】（都是官方开奖数据，最新在前）',
    pack,
    '',
    '【怎么做】',
    '1) 把材料读一遍，形成你今天的看法（冷号回补？热号续走？和值区间？随你，讲得出故事就行）。',
    '2) 按玩法规格选出你的号码。',
    '3) 写给主人的推送正文 message，要求：',
    '   - 300–600 字；先聊两三句你对今天走势的「研究心得」，再亮号码，再讲这注的思路，最后一句祝福收尾；',
    `   - 号码写法：${gameKey === 'ssq' ? '红球 8 个 + 蓝球 1 个（比如「红 03 07 12 18 25 29 31 33 + 蓝 09」）' : gameKey === 'dlt' ? '前区 7 个 + 后区 2 个' : '百位-十位-个位（比如「6-4-7」）'}；`,
    '   - 用你的口气，元气一点；可以自嘲、可以嘴硬、可以提鲸鱼，但别吹「稳了」（不真实，也不诚实）。',
    '',
    '【交卷方式 —— 最重要的部分】',
    '把结果用 shell 写进这个文件（存在即可，内容必须是合法 JSON，字段一个不能少）：',
    `  ${outPath}`,
    'JSON 结构（严格照抄字段名，顶层带 schemaVersion）：',
    gameKey === 'ssq'
      ? '  {"schemaVersion":1,"issue":"' + issue + '","picks":{"red":[8个整数],"blue":1个整数},"message":"给主人的完整正文"}'
      : gameKey === 'dlt'
        ? '  {"schemaVersion":1,"issue":"' + issue + '","picks":{"front":[7个整数],"back":[2个整数]},"message":"给主人的完整正文"}'
        : '  {"schemaVersion":1,"issue":"' + issue + '","picks":{"digits":[3个整数]},"message":"给主人的完整正文"}',
    '写文件示例（heredoc 原样写入）：',
    `  cat > '${outPath}' <<'JSON'`,
    '  { …你的 JSON… }',
    '  JSON',
    '硬性规则：',
    `  · 号码范围与个数必须完全合规（${specText(gameKey)}），系统会做硬校验，不合规会打回重写 ✓`,
    '  · message 里【不要】写标题行和期号抬头（系统会统一加），不要用 Markdown 语法，纯文本换行即可',
    '  · 写完文件就收工：不要发任何消息、不要调用任何对外工具、不要动这个文件之外的东西',
    '  · 就算你对数据没感觉，也必须交一注合法号（可以说「今天凭感觉」）',
  ].join('\n')
}

/** AI 摆烂时的兜底正文（模板，不带 AI 腔，照样元气） */
export function fallbackMessage(gameKey, picks) {
  const g = GAMES[gameKey]
  return [
    '哎呀……主人，本锦鲤今天研究到一半卡壳了（系统那边数据有点闹脾气），这是系统帮我兜底摇出来的号：',
    picksLineOf(gameKey, picks),
    '虽然没了分析过程，但运势不打折！今晚一起开奖见真章～',
  ].join('\n')
}

function picksLineOf(gameKey, picks) {
  if (gameKey === 'ssq') return `红球 ${picks.red.map((n) => String(n).padStart(2, '0')).join(' ')} + 蓝球 ${String(picks.blue).padStart(2, '0')}`
  if (gameKey === 'dlt') return `前区 ${picks.front.map((n) => String(n).padStart(2, '0')).join(' ')} + 后区 ${picks.back.map((n) => String(n).padStart(2, '0')).join(' ')}`
  return `直选 ${picks.digits.join('-')}`
}
