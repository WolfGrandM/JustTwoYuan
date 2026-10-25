/**
 * 判奖金样本夹具（单一源）—— v0.2-B1 T-04 自 tools/koi.mjs goldenChecks 与
 * tests/judge-golden.test.mjs 的双份手工镜像下沉（docs/22 P4-f；原两处注释均自警
 * 「两处改动须同步」，纯手工同步易漂移）。
 *
 * 纯数据模块：零 import——保住 W2B-14「CLI 打包不依赖 tests/ 目录」前提，
 * CLI（tools/koi.mjs selftest）与测试（tests/judge-golden.test.mjs）同源消费。
 *
 * 夹具为历史真实开奖（2026-10-24 核实）：
 *   · SSQ 2026121（2026-10-22 开奖）红 02 07 20 24 26 30 + 蓝 02 —— 本仓库开发期自福彩官网实测数据
 *     （tests/stats.test.mjs 同源夹具，issue/日期映射与 tests/draws.mjs nextIssue 用例互证）；
 *   · DLT 26120（2026-10-21 开奖）前区 01 06 10 15 32 + 后区 03 04 —— 体彩开奖公告核实（新浪体育
 *     26120 期数据复盘文 + 上海体彩开奖公告页两源一致；期号/日期与本仓库 nextIssue 夹具互证）；
 *   · P3 26282（2026-10-23 开奖）6-4-7 —— 本仓库开发期自体彩官网实测数据（排列五前三位）。
 *
 * 注：lib/draws.js judge() 只读开奖号字段（red/blue/front/back/digits，draws.js:210-241）；
 * issue/date/prizeGrades 为溯源与展示附加字段（SSQ 的 prizeGrades 沿 tests/judge-golden.test.mjs
 * 既有超集形态）。期望值口径（SSQ 三~六等 3000/200/10/5；DLT 三~九等 10000/3000/300/200/100/15/5；
 * P3 直选 1040；一/二等浮动按 0 计、给 gradeMoney 才计入）与全部断言见两个消费点——
 * 断言逐条不变，本文件只承载数据。
 */

/** SSQ 2026121（2026-10-22）红 02 07 20 24 26 30 + 蓝 02 */
export const GOLDEN_SSQ = { issue: '2026121', date: '2026-10-22', red: [2, 7, 20, 24, 26, 30], blue: 2, prizeGrades: { 3: 3000 } }

/** DLT 26120（2026-10-21）前区 01 06 10 15 32 + 后区 03 04 */
export const GOLDEN_DLT = { issue: '26120', date: '2026-10-21', front: [1, 6, 10, 15, 32], back: [3, 4] }

/** P3 26282（2026-10-23）直选 6-4-7 */
export const GOLDEN_P3 = { issue: '26282', date: '2026-10-23', digits: [6, 4, 7] }
