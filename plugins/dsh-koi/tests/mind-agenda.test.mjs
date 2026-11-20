/**
 * M3-T2 议程与阵容档位（docs/33 §2.2 agenda.js 行 / §6.1 AC-026 / §6.4 resolveTier 矩阵）。
 * 起步档映射（ssq/dlt=standard、p3/3d=lite——拍板 P15 3d 轻量对称）/ cfg.cast.tiers 覆盖 /
 * mind.enabled 双向闸强制 single（FR-023）/ 拉前条件（FR-017）/ 阵容与降档步进 /
 * 四级优先序（§3.3 cap>硬停>切片超时>计划档）/ 议程版本稳定性（FR-021）+ BC-001 声明行同文防漂移。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CAST_TIERS, castTierOf, planTierOf, lineupFor, nextTier, resolveTier, versionOf,
  sliceBudgetOf, SESSION_BUDGET_MS, HARD_LIMIT_MS, HARD_STOP_HHMM, FULL_UNLOCK, BC001_LINE,
} from '../lib/mind/agenda.js'
import { DISCLAIMER } from '../lib/insight.js'

const MIND_ON = { mind: { enabled: true } }
const MIND_OFF = { mind: { enabled: false } }

test('AC-026 castTierOf：默认映射 ssq/dlt=standard、p3/3d=lite（P15 3d 轻量对称）；cfg.cast.tiers 覆盖；mind 关强制 single（FR-023 双向闸）', () => {
  assert.deepEqual(CAST_TIERS, ['full', 'standard', 'lite', 'single'])
  assert.equal(castTierOf(MIND_ON, 'ssq'), 'standard')
  assert.equal(castTierOf(MIND_ON, 'dlt'), 'standard')
  assert.equal(castTierOf(MIND_ON, 'p3'), 'lite')
  assert.equal(castTierOf(MIND_ON, '3d'), 'lite', '拍板 P15：3d 轻量对称（与 p3 同档）')
  // 覆盖：合法值生效、非法值回落默认映射（不抛错）
  assert.equal(castTierOf({ ...MIND_ON, cast: { tiers: { p3: 'standard' } } }, 'p3'), 'standard')
  assert.equal(castTierOf({ ...MIND_ON, cast: { tiers: { p3: 'ultra' } } }, 'p3'), 'lite', '非法覆盖值回落默认映射')
  // mind 双向闸：false → 强制 single（无注入无博弈，AC-008 收窄口径）
  assert.equal(castTierOf(MIND_OFF, 'ssq'), 'single')
  assert.equal(castTierOf({}, 'ssq'), 'single', 'mind 缺省（=关）→ single')
  assert.equal(castTierOf({ ...MIND_ON, cast: { tiers: { ssq: 'single' } } }, 'ssq'), 'single', '用户显式配 single → single')
})

test('AC-026 planTierOf 拉前条件：连续 4 周无降级 且 周 token<70% → full；条件不满足 → 配置档；满配解锁门默认关', () => {
  // 满足两条件 → 拉前 full
  assert.equal(planTierOf(MIND_ON, 'ssq', { demotionFreeWeeks: 4, weekRatio: 0.5 }), 'full')
  // 任一不满足 → 配置档 standard（full 未解锁期间 standard 即计划档位——§3.1 market 版口径注记）
  assert.equal(planTierOf(MIND_ON, 'ssq', { demotionFreeWeeks: 3, weekRatio: 0.5 }), 'standard', '周数不足 → 不拉前')
  assert.equal(planTierOf(MIND_ON, 'ssq', { demotionFreeWeeks: 4, weekRatio: 0.7 }), 'standard', '周 token 恰 70% → 不拉前（<70% 严格）')
  assert.equal(planTierOf(MIND_ON, 'ssq', { demotionFreeWeeks: 8, weekRatio: 0.9 }), 'standard', '预算压力 → 不拉前')
  assert.equal(planTierOf(MIND_ON, 'p3', { demotionFreeWeeks: 8, weekRatio: 0.3 }), 'lite', 'lite 起步档无拉前语义（链 full 仅 ssq/dlt 适用）')
  assert.equal(planTierOf(MIND_OFF, 'ssq', { demotionFreeWeeks: 8, weekRatio: 0.3 }), 'single', 'mind 关 → 计划档 single')
  // 常量与 FR-017 原文一致（拉前条件单点）
  assert.equal(FULL_UNLOCK.demotionFreeWeeks, 4)
  assert.equal(FULL_UNLOCK.weekRatioMax, 0.7)
})

test('AC-026 lineupFor 阵容：standard=数据官+策略师×N+主持人；lite=数据官+单策略师+主持人；full 追加质询/修订轮；single=编排不接手；nextTier 单调步进', () => {
  const ids = (tier, cfg) => lineupFor(tier, cfg).map((s) => `${s.id}-${s.round}`)
  // standard（N=2）：数据官 + 策略师×2 + 主持人（互不读对方产出——独立性保真，无互评轮）
  assert.deepEqual(ids('standard', { roles: { strategists: 2 } }), ['dataOfficer-1', 'strategist-1-1', 'strategist-2-1', 'chair-2'])
  // lite：数据官 + 单策略师 + 主持人（P15 3d 对称同款阵容）
  assert.deepEqual(ids('lite', { roles: { strategists: 4 } }), ['dataOfficer-1', 'strategist-1-1', 'chair-2'], 'lite 恒单策略师（克隆数不影响 lite）')
  // full：追加质询轮(round2)+修订轮(round3)+主持人(round4)——满配阵容参数在位（解锁是运行期事件非本批动作）
  const full = ids('full', { roles: { strategists: 2 } })
  assert.deepEqual(full, ['dataOfficer-1', 'strategist-1-1', 'strategist-2-1', 'provoker-2', 'strategist-1-3', 'strategist-2-3', 'chair-4'])
  // single：编排不接手（runPredictFlow 现状主体——FZ-5）
  assert.deepEqual(lineupFor('single', { roles: { strategists: 2 } }), [])
  // 策略师克隆数上限 4（MC-17 同域）
  assert.equal(lineupFor('standard', { roles: { strategists: 9 } }).filter((s) => s.role === 'strategist').length, 4)
  // 降档步进 full→standard→lite→single→null（编排让位现状路径）
  assert.equal(nextTier('full'), 'standard')
  assert.equal(nextTier('standard'), 'lite')
  assert.equal(nextTier('lite'), 'single')
  assert.equal(nextTier('single'), null, 'single 已是保底档——编排让位现状路径')
  // 切片预算表（§3.2 估算值——FR-047 首月回填）与拍板常量
  assert.equal(sliceBudgetOf('dataOfficer'), 180_000)
  assert.equal(sliceBudgetOf('strategist'), 240_000)
  assert.equal(sliceBudgetOf('chair'), 240_000)
  assert.equal(sliceBudgetOf('unknown-role'), 240_000, '未知角色回落 strategist 档（宁多勿少不卡链）')
  assert.equal(SESSION_BUDGET_MS, 25 * 60_000, '拍板 P15：SESSION_BUDGET_MS=25min')
  assert.equal(HARD_LIMIT_MS, 30 * 60_000, '拍板 P15：硬限 30min')
  assert.equal(HARD_STOP_HHMM, '17:55', 'BC-011 硬停线承诺红线')
})

test('§6.4 resolveTier 四级优先序矩阵：cap 短路 > 硬停线 > 切片超时（运行中） > 计划档', () => {
  // ① cap 短路最高优先：allowLLM=false → 编排不起跑（兜底档直接出号零 LLM，scheduler.js:322 既有行为零改动）
  assert.deepEqual(resolveTier({ castTier: 'standard', allowLLM: false, hhmmNow: '17:30' }),
    { tier: 'standard', action: 'skip-cap', reason: resolveTier({ castTier: 'standard', allowLLM: false }).reason })
  assert.equal(resolveTier({ castTier: 'full', allowLLM: false }).action, 'skip-cap')
  // ② 硬停线（17:55）已过 → 立即兜底（BC-011 承诺优先于链预算；predictAt 晚于 17:30 硬停线仍 17:55）
  assert.equal(resolveTier({ castTier: 'standard', allowLLM: true, hhmmNow: '17:55' }).action, 'hard-stop')
  assert.equal(resolveTier({ castTier: 'standard', allowLLM: true, hhmmNow: '17:56' }).action, 'hard-stop')
  assert.equal(resolveTier({ castTier: 'standard', allowLLM: true, hhmmNow: '17:56' }).tier, 'fallback')
  // ③④ 正常窗口 → 按计划档起跑（切片超时降档在运行中逐角色处理——中途只降不升）
  assert.deepEqual(resolveTier({ castTier: 'lite', allowLLM: true, hhmmNow: '17:30' }), { tier: 'lite', action: 'run', reason: resolveTier({ castTier: 'lite' }).reason })
  assert.equal(resolveTier({ castTier: 'standard', allowLLM: true, hhmmNow: '17:54' }).action, 'run', '17:54 仍可起跑（有效预算被截断属如实语义）')
})

test('AC-019 versionOf：同配置同版本（重跑幂等登记）；改 roles.prompts → 新版本号；格式 m3:v<n>:<hash8>；BC-001 声明行与 insight.DISCLAIMER 关键句同文防漂移', () => {
  const v1 = versionOf(MIND_ON)
  const v2 = versionOf({ ...MIND_ON, roles: { strategists: 1, prompts: {} } })
  assert.equal(v1, v2, '空 prompts 同版本')
  assert.match(v1, /^m3:v\d+:[0-9a-f]{8}$/, '格式 = m3:v<模板版本>:<fnv1a hash8>（config.js:226 同源算法）')
  const v3 = versionOf({ ...MIND_ON, roles: { strategists: 1, prompts: { strategist: '改成保守风格' } } })
  assert.notEqual(v1, v3, 'prompts 内容变化 → 新版本号（FR-021 议程版本管理）')
  assert.equal(versionOf({ ...MIND_ON, roles: { strategists: 1, prompts: { strategist: '改成保守风格' } } }), v3, '同 prompts 同 hash（重跑幂等）')
  // BC-001 声明行关键句同文（agenda.js 零 import insight——同文性由本断言防漂移）
  assert.ok(DISCLAIMER.includes('开奖为独立随机事件'), 'insight.DISCLAIMER 关键句在位')
  assert.ok(BC001_LINE.includes('开奖为独立随机事件') && BC001_LINE.includes('不改变中奖概率'), 'agenda BC001_LINE 关键句同文（BC-001 四角色提示词常驻）')
})
