/**
 * dsh-koi 卡片库（第二波 docs/19 §4.5，FR-1014 / DC-003/DC-108）。
 *
 * 存储选型（W2A-10）：沿用 JSON store（koi/cards.json，io.js 原子写）——卡片 ≤数千条量级，
 * 全量载入内存去重/回测无压力；node:sqlite 实测可用但本波不采用。
 *
 * 写方纪律（W2A-23 cards 单写者）：全部写方（ingest 入库、因子化 factorId 回填、回测结论回写）
 * 收敛在持锁进程的串行域内，读-合并-全量原子写——events.json「调度器单写者」先例同款纪律。
 * 本模块不持锁（锁属编排层 ingest/backtest）；谁调用谁保证在锁域内。
 *
 * 去重语义（§4.4-5/§4.5，三态）：duplicate-of（LLM 判同）→ 不入库；rule-dup（规则级疑似而
 * LLM 判 none → 保守拒入，宁可少入不可重复入库）；similar-to → 入库 + similarOf 指针。
 * 规则级判定（零成本）= 卡片名规范化精确匹配 + 规则文本词法 Jaccard ≥ 0.8（下方纯函数，可单测）。
 */
import path from 'node:path'
import { readJson, writeJsonAtomic } from './io.js'

export const RULE_SIM_THRESHOLD = 0.8

/** 名称规范化键：去空白 + NFKC（全半角归一）+ 小写 */
export function nameKey(name) {
  return String(name ?? '').normalize('NFKC').replace(/\s+/g, '').toLowerCase()
}

/** 规则文本词法 token：CJK bigram 为主（短文本退化为字符集）——确定性、可单测 */
export function ruleTokens(text) {
  const s = String(text ?? '').normalize('NFKC').replace(/\s+/g, '')
  if (!s) return new Set()
  if (s.length < 2) return new Set([s])
  const out = new Set()
  for (let i = 0; i + 1 < s.length; i++) out.add(s.slice(i, i + 2))
  return out
}

/** Jaccard 相似度（词法） */
export function jaccard(aTokens, bTokens) {
  const A = aTokens instanceof Set ? aTokens : ruleTokens(aTokens)
  const B = bTokens instanceof Set ? bTokens : ruleTokens(bTokens)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const t of A) if (B.has(t)) inter += 1
  return inter / (A.size + B.size - inter)
}

/** 规则级疑似重复判定（零成本、保守）：名称同键 或 规则词法 Jaccard ≥ 0.8 → 命中既有卡 */
export function findRuleDup({ name, rule }, existingCards) {
  const key = nameKey(name)
  for (const card of existingCards ?? []) {
    if (nameKey(card.name) === key && key !== '') return { type: 'name', card }
  }
  const tokens = ruleTokens(rule)
  for (const card of existingCards ?? []) {
    if (jaccard(tokens, ruleTokens(card.rule)) >= RULE_SIM_THRESHOLD) {
      return { type: 'rule', card, score: jaccard(tokens, ruleTokens(card.rule)) }
    }
  }
  return null
}

const randSuffix = () => Math.random().toString(36).slice(2, 8)

export function createCardsStore({ dataDir, now = () => new Date() } = {}) {
  const FILE = path.join(dataDir ?? '.', 'cards.json')
  const read = () => readJson(FILE, { schemaVersion: 1, cards: [] })
  const write = (store) => writeJsonAtomic(FILE, store)

  return {
    FILE,
    fileOf: () => FILE,
    list() { return (read().cards ?? []).map((c) => ({ ...c })) },
    get(id) { return (read().cards ?? []).find((c) => c.id === id) ?? null },
    /**
     * 入库（去重后的新卡；三态裁决在 ingest 侧完成——本方法不做判重）。
     * 补齐 DC-003/DC-108 必填与默认：trustLevel 默认 mid（用户上传）、status active、时间戳。
     */
    addCards(cards, { source, sourceType, sourceJob, clean } = {}) {
      const store = read()
      const created = []
      for (const c of Array.isArray(cards) ? cards : []) {
        const card = {
          id: `card-${now().getTime()}-${randSuffix()}`,
          name: String(c.name ?? '').slice(0, 40),
          source: c.source ?? source ?? '',
          sourceType: c.sourceType ?? sourceType ?? 'user-file',
          sourceJob: c.sourceJob ?? sourceJob ?? null,
          games: Array.isArray(c.games) ? c.games.filter(Boolean) : [],
          rule: String(c.rule ?? '').slice(0, 400),
          computable: c.computable === true,
          trustLevel: c.trustLevel ?? 'mid',
          clean: c.clean ?? clean ?? { strippedImages: 0, ocrNoise: 0, fixedBreaks: 0, headersFooters: 0 },
          similarOf: c.similarOf ?? null,
          status: 'active',
          factorId: null,
          backtest: null,
          createdAt: now().toISOString(),
          lastReviewedAt: now().toISOString(),
        }
        store.cards.push(card)
        created.push({ ...card })
      }
      store.schemaVersion = 1
      write(store)
      return created
    },
    /** 按 sourceJob 回滚（S-119：job 重跑前先回滚已写入的卡片，绝不静默重复入库） */
    removeByJob(sourceJob) {
      const store = read()
      const before = (store.cards ?? []).length
      store.cards = (store.cards ?? []).filter((c) => c.sourceJob !== sourceJob)
      write(store)
      return before - store.cards.length
    },
    /** 单卡字段更新（持锁串行域内调用；factorId 回填 / backtest 回写 / 状态标记共用） */
    update(cardId, patch) {
      const store = read()
      const i = (store.cards ?? []).findIndex((c) => c.id === cardId)
      if (i < 0) return null
      store.cards[i] = { ...store.cards[i], ...patch }
      write(store)
      return { ...store.cards[i] }
    },
    markFactorizeFailed(cardId, reason) {
      return this.update(cardId, { status: 'factorize-failed', factorizeError: String(reason ?? '').slice(0, 300) })
    },
    setBacktest(cardId, result) {
      return this.update(cardId, { backtest: result, lastReviewedAt: now().toISOString() })
    },
  }
}
