/**
 * dsh-koi 配置层（市场版 schema v2，FR-1020/S-113/BC-103）—— 首写模板、三入口共用校验、
 * 模式读取兼容、门控四项、configStamp、配置掩码。
 *
 * 零 QQ（BC-103）：模板与默认值不含任何 QQ 推送凭证字段（v1 的 push 段已随破坏性变更移除）；
 * 作者实例经 tools/koi.mjs migrate-v2 迁移（S-125），本模块只认 v2。
 * docs/16 §5.3 为配置 schema 唯一权威；第二波增量字段（backfill 扩展/ingest/backtest）以
 * docs/19 §7 为增量权威（纯加字段，schemaVersion 维持 2）。
 */
import fs from 'node:fs'
import { GAMES, GAME_ORDER } from './draws.js'
import { TIERS, defaultTierFor } from './tiers.js'

export const SCHEMA_VERSION = 2

const MODES_DEFAULT = () => Object.fromEntries(GAME_ORDER.map((k) => [
  k,
  { mode: 'manual', tier: defaultTierFor(k), predictAt: '17:30', gates: { channelOk: true, tierOk: true, timeOk: true, honestyAck: false }, wizardDone: false },
]))

/** 首写模板（index.js 落盘用；与 docs/16 §5.3 逐字段一致；出厂默认档 = 各彩种最小档，MB-29） */
export function buildConfigTemplate() {
  return {
    _说明: '锦鲤市场版配置（schemaVersion 2）。channels=通知渠道（panel 为内置桌宠渠道，出厂启用；其他渠道在面板或 CLI 添加，凭证存 koi/channels/ 侧车文件）；modes=每彩种 off/manual/auto 三态（出厂 manual）；budget.weeklyCap=每周 token 预算；effort.tier=思考力度四档；verbosity=输出详略两档；改完下一轮 tick 生效（约 30 秒）。',
    schemaVersion: SCHEMA_VERSION,
    channels: [{ type: 'panel', enabled: true }],
    modes: MODES_DEFAULT(),
    time: { catchUpEnd: '19:50', settleAt: '22:00', settleGiveUp: '23:30', retryMinutes: 5, heartbeatAt: '22:30' },
    budget: {
      weeklyCap: 1_500_000, warn1: 0.7, warn2: 0.9,
      categories: { predict: null, learning: null, advisory: null },
      roleWeights: { strategist: [1.0] },
      overrides: { injectionCap: 4000, perCallCap: null },
    },
    roles: { strategists: 1, prompts: {} },            // prompts 为 M3 接缝（FR-1007），受 FZ-7 围栏约束
    effort: { tier: 'follow-host' },
    verbosity: 'concise',
    advisory: { enabled: true },
    pet: { enabled: true, corner: 'br', zIndex: 2147483000 },
    events: { retentionDays: 90, listWindow: 200 },
    backfill: { targetIssues: null, batchSize: 100, batchGapMs: 2000, retryMax: 3, offpeakOnly: true },   // 第二波 §7（W2A-06/07）
    ingest: { maxFileMB: 20, maxCleanChars: 200000, dedup: 'merged', offpeakOnly: true },                  // 第二波 §7（W2A-22：maxCleanChars=清洗后诚实上限）
    backtest: { warmup: 30, minRounds: 100, alpha: 0.05, offpeakOnly: true },                              // 第二波 §7
    mirror: { enabled: false, acknowledged: false },   // FR-1018 默认关闭，启用须显式知情确认
    historyCount: 30,
    historyTail: 10,
    persona: '',
    holidays: [],
    mind: { enabled: false },
  }
}

/** 运行时默认值（与模板同源；首写模板含 _说明，运行时不含） */
export function buildConfigDefaults() {
  const { _说明, ...rest } = buildConfigTemplate()
  return rest
}

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/
export const isHHMM = (s) => HHMM_RE.test(String(s ?? ''))
const MODES = ['off', 'manual', 'auto']
const EFFORTS = ['follow-host', 'economy', 'standard', 'turbo']
const VERBOSITIES = ['concise', 'chatty']
const CORNERS = ['br', 'bl', 'tr', 'tl']

/**
 * 读配置 + v1 读兼容换算（§2.2.2-1）：用户文件有 games 无 modes（未迁移的 v1.1 配置）时
 * 按 games.<k>.enabled 换算（true→auto、false→off、缺省该彩种→manual），migrate-v2 后不再触发。
 */
export function readConfig(configPath, defaults = buildConfigDefaults()) {
  let user = {}
  try { user = JSON.parse(fs.readFileSync(configPath, 'utf8')) } catch { /* 没配用默认 */ }
  const cfg = { ...structuredClone(defaults), ...structuredClone(user) }
  if (!user.modes && user.games) {
    cfg.modes = {}
    for (const k of GAME_ORDER) {
      const g = user.games[k]
      cfg.modes[k] = {
        mode: g == null ? 'manual' : (g.enabled === false ? 'off' : 'auto'),
        tier: defaultTierFor(k),
        predictAt: user.time?.predictAt && isHHMM(user.time.predictAt) ? user.time.predictAt : '17:30',
        gates: {}, wizardDone: false,
      }
    }
  }
  return cfg
}

/** 每彩种模式（三态；无效值兜底 manual——市场默认） */
export function modeOf(cfg, gameKey) {
  const m = cfg?.modes?.[gameKey]?.mode
  return MODES.includes(m) ? m : 'manual'
}

export function tierOf(cfg, gameKey) {
  return cfg?.modes?.[gameKey]?.tier ?? defaultTierFor(gameKey)
}

/**
 * 三入口（面板/CLI/配置文件）共用的全量校验（FR-1020/S-113）。
 * 返回 { ok, errors:[逐项说明] }。非法值即时拒绝 + 逐项说明。
 */
export function validateConfig(cfg) {
  const errors = []
  const err = (msg) => errors.push(msg)
  if (cfg == null || typeof cfg !== 'object') return { ok: false, errors: ['配置不是对象'] }
  if (cfg.schemaVersion != null && Number(cfg.schemaVersion) > SCHEMA_VERSION) err(`schemaVersion ${cfg.schemaVersion} 高于已知版本 ${SCHEMA_VERSION}`)

  // channels
  if (!Array.isArray(cfg.channels)) err('channels 必须是数组')
  else cfg.channels.forEach((c, i) => {
    if (!c || typeof c !== 'object' || typeof c.type !== 'string' || !c.type.trim()) err(`channels[${i}] 缺 type（适配器标识）`)
    else if (c.enabled !== undefined && typeof c.enabled !== 'boolean') err(`channels[${i}].enabled 必须是布尔`)
  })

  // modes：三态/档位/时间（predictAt 早于该彩种开奖时刻，MB-12）
  if (!cfg.modes || typeof cfg.modes !== 'object') err('modes 缺失')
  else for (const k of GAME_ORDER) {
    const m = cfg.modes[k] ?? {}
    if (!MODES.includes(m.mode)) err(`modes.${k}.mode 必须是 ${MODES.join('/')}`)
    const tier = TIERS[m.tier]
    if (!tier) err(`modes.${k}.tier 不在档表（${m.tier}）`)
    else if (tier.game !== k) err(`modes.${k}.tier（${m.tier}）不属于 ${GAMES[k].name}`)
    if (!isHHMM(m.predictAt)) err(`modes.${k}.predictAt 必须是 HH:MM`)
    else if (m.predictAt >= GAMES[k].drawAt) err(`modes.${k}.predictAt（${m.predictAt}）必须早于开奖时刻 ${GAMES[k].drawAt}`)
  }

  // time
  const time = cfg.time ?? {}
  for (const f of ['catchUpEnd', 'settleAt', 'settleGiveUp', 'heartbeatAt']) {
    if (time[f] !== undefined && !isHHMM(time[f])) err(`time.${f} 必须是 HH:MM`)
  }
  if (time.retryMinutes !== undefined && !(Number(time.retryMinutes) > 0)) err('time.retryMinutes 必须大于 0')

  // budget
  const b = cfg.budget ?? {}
  if (!(Number(b.weeklyCap) > 0)) err('budget.weeklyCap 必须大于 0（预算为 0 = 什么都跑不了）')
  for (const f of ['warn1', 'warn2']) {
    if (b[f] !== undefined && !(Number(b[f]) > 0 && Number(b[f]) < 1)) err(`budget.${f} 必须在 (0,1)`)
  }
  if (b.warn1 != null && b.warn2 != null && !(Number(b.warn1) < Number(b.warn2))) err('budget.warn1 必须小于 warn2')

  // roles（MC-17：strategists 1–4；prompts 仅对象占位，非法类型拒绝——FZ-7 接缝）
  const r = cfg.roles ?? {}
  if (!Number.isInteger(Number(r.strategists)) || Number(r.strategists) < 1 || Number(r.strategists) > 4) err('roles.strategists 必须是 1–4 的整数')
  if (r.prompts !== undefined && (typeof r.prompts !== 'object' || Array.isArray(r.prompts))) err('roles.prompts 必须是对象（任务提示词编辑器随 M3 编排器开放）')

  // effort / verbosity / advisory / pet / events / backfill / mirror
  if (!EFFORTS.includes(cfg.effort?.tier)) err(`effort.tier 必须是 ${EFFORTS.join('/')}`)
  if (!VERBOSITIES.includes(cfg.verbosity)) err(`verbosity 必须是 ${VERBOSITIES.join('/')}`)
  if (cfg.advisory?.enabled !== undefined && typeof cfg.advisory.enabled !== 'boolean') err('advisory.enabled 必须是布尔')
  const pet = cfg.pet ?? {}
  if (pet.enabled !== undefined && typeof pet.enabled !== 'boolean') err('pet.enabled 必须是布尔')
  if (pet.corner !== undefined && !CORNERS.includes(pet.corner)) err(`pet.corner 必须是 ${CORNERS.join('/')}`)
  if (pet.zIndex !== undefined && !Number.isInteger(Number(pet.zIndex))) err('pet.zIndex 必须是整数')
  const ev = cfg.events ?? {}
  if (ev.retentionDays !== undefined && !(Number(ev.retentionDays) > 0)) err('events.retentionDays 必须大于 0')
  if (ev.listWindow !== undefined && !(Number(ev.listWindow) > 0)) err('events.listWindow 必须大于 0')
  const bf = cfg.backfill ?? {}
  if (bf.targetIssues != null && !(Number(bf.targetIssues) > 0)) err('backfill.targetIssues 必须为 null 或大于 0')
  if (bf.batchSize !== undefined && !(Number(bf.batchSize) > 0)) err('backfill.batchSize 必须大于 0')
  if (bf.batchGapMs !== undefined && !(Number(bf.batchGapMs) > 0)) err('backfill.batchGapMs 必须大于 0')
  if (bf.retryMax !== undefined && !(Number.isInteger(Number(bf.retryMax)) && Number(bf.retryMax) >= 0)) err('backfill.retryMax 必须是 ≥0 的整数')
  if (bf.offpeakOnly !== undefined && typeof bf.offpeakOnly !== 'boolean') err('backfill.offpeakOnly 必须是布尔')
  // 第二波增量（docs/19 §7：schema v2 只加不改不删）
  const ing = cfg.ingest ?? {}
  if (ing.maxFileMB !== undefined && !(Number(ing.maxFileMB) > 0)) err('ingest.maxFileMB 必须大于 0')
  if (ing.maxCleanChars !== undefined && !(Number(ing.maxCleanChars) > 0)) err('ingest.maxCleanChars 必须大于 0')
  if (ing.dedup !== undefined && !['merged', 'rule-only'].includes(ing.dedup)) err('ingest.dedup 必须是 merged/rule-only')
  if (ing.offpeakOnly !== undefined && typeof ing.offpeakOnly !== 'boolean') err('ingest.offpeakOnly 必须是布尔')
  const bt = cfg.backtest ?? {}
  if (bt.warmup !== undefined && !(Number.isInteger(Number(bt.warmup)) && Number(bt.warmup) >= 0)) err('backtest.warmup 必须是 ≥0 的整数')
  if (bt.minRounds !== undefined && !(Number(bt.minRounds) > 0)) err('backtest.minRounds 必须大于 0')
  if (bt.alpha !== undefined && !(Number(bt.alpha) > 0 && Number(bt.alpha) < 1)) err('backtest.alpha 必须在 (0,1)')
  if (bt.offpeakOnly !== undefined && typeof bt.offpeakOnly !== 'boolean') err('backtest.offpeakOnly 必须是布尔')
  const mir = cfg.mirror ?? {}
  if (mir.enabled === true && mir.acknowledged !== true) err('mirror.enabled 开启必须先显式知情确认（acknowledged: true，S-122）')
  if (cfg.historyCount !== undefined && !(Number(cfg.historyCount) > 0)) err('historyCount 必须大于 0')
  if (cfg.historyTail !== undefined && !(Number(cfg.historyTail) > 0)) err('historyTail 必须大于 0')
  if (cfg.classify?.noModelPatterns !== undefined && !Array.isArray(cfg.classify.noModelPatterns)) err('classify.noModelPatterns 必须是字符串数组')

  return { ok: errors.length === 0, errors }
}

/**
 * 自动模式四项门控（S-116/拍板16；MC-11：channelOk/tierOk/timeOk 为实时校验，gates 字段仅向导缓存展示；
 * honestyAck 为唯一持久门控事实）。env.channelsOk = 启用且可用的渠道数 ≥1（含桌宠）。
 * 返回 { ok, missing:[{key, label, hint}] }。
 */
export function checkGates(gameKey, cfg, env = {}) {
  const missing = []
  const m = cfg?.modes?.[gameKey] ?? {}
  if (!(Number(env.channelsOk ?? 0) >= 1)) missing.push({ key: 'channel', label: '通知渠道', hint: '至少启用一个可用渠道（桌宠面板渠道即算）' })
  const tier = TIERS[m.tier]
  if (!tier || tier.game !== gameKey) missing.push({ key: 'tier', label: '投注档位', hint: '先在该彩种的档位表里选一档' })
  if (!isHHMM(m.predictAt)) missing.push({ key: 'time', label: '出号时间', hint: '设置出号时间（HH:MM）' })
  else if (m.predictAt >= GAMES[gameKey].drawAt) missing.push({ key: 'time', label: '出号时间', hint: `出号时间必须早于开奖时刻（${GAMES[gameKey].drawAt}）` })
  if (m.gates?.honestyAck !== true) missing.push({ key: 'honestyAck', label: '诚实条款', hint: '阅读并勾选诚实条款（开奖是独立随机事件，本内容不改变中奖概率）' })
  return { ok: missing.length === 0, missing }
}

// ── configStamp（§5.2 ⚠C：角色阵容与配置版本摘要；FR-1006/FR-021/DC-103 继承；格式 MD-06）──
function fnv1a(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

export function buildConfigStamp(cfg) {
  const relevant = {
    effort: cfg?.effort?.tier, verbosity: cfg?.verbosity,
    weeklyCap: cfg?.budget?.weeklyCap, strategists: cfg?.roles?.strategists,
    promptsKeys: Object.keys(cfg?.roles?.prompts ?? {}).sort(),
    tiers: Object.fromEntries(GAME_ORDER.map((k) => [k, cfg?.modes?.[k]?.tier])),
  }
  return `v2:s${Number(cfg?.roles?.strategists ?? 1)}:${fnv1a(JSON.stringify(relevant))}`
}

const SENSITIVE_KEY_RE = /token|secret|password|apikey|api_key|napcat|target|credential/i

/** 配置下发掩码（NFR-106：面板/CLI 永不接收明文凭证；递归掩码敏感键） */
export function maskConfig(value, depth = 0) {
  if (Array.isArray(value)) return value.map((v) => maskConfig(v, depth + 1))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY_RE.test(k) && typeof v === 'string' && v ? `${v.slice(0, 2)}****${v.slice(-2)}` : maskConfig(v, depth + 1)
    }
    return out
  }
  return value
}
