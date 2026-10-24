# D · 默认决策记录（阶段D · 实施与测试）

> 2026-10-24（阶段D，无人值守）。依据：docs/13 v1.1.0 §7 开工指令 + 无人值守纪律四条。
> 本文件登记阶段D 一切「本应问主人」的实现层拍板；编号 D-01 起。上游决策见 A/B/C 三份记录。

| 编号 | 事项/问题 | 候选项 | 采用的默认值 | 选择理由 | 影响与后续可改点 |
|------|-----------|--------|--------------|----------|------------------|
| D-01 | 实施顺序：T1a 的 settleOne 最终形态依赖原子写/版本守卫（T3/T4 的产物） | 严格按 T1a→T3 顺序分两轮改写同一段代码；或 io.js 先行、T1a 一次写成最终形态 | **后者**：先落 lib/io.js（T3 库半边，纯新增零风险），T1a 直接按最终形态写；任务验证顺序与逐项测试纪律不变 | 确认书本身标注 T3 为「T5 前置」；避免同段代码两轮改写引入中间态缺陷 | 无行为差异；git diff 中 io.js 与 settleOne 改动耦合出现属预期 |
| D-02 | 作废判定口径：docs/13 T1a/§4.5 字面 =「期号数值比较 → 作废」；docs/12 FR-001（权威）=「官方公布更大期号而**目标期号缺席**（休市/取消）」 | ① 纯数值比较即作废；② 数值比较触发后先 fetchHistory 回看核实，翻得到目标期按公布结清、翻不到才作废 | **②**（回看 50 期，常量 VOID_HISTORY_COUNT） | fetchLatestDraw 只返回最新一期：多日宕机/晚公布场景下 latest>target 但目标期其实已公布并存在于历史，纯数值比较会把真实开奖误作废（漏记奖金）；docs/12 为权威输入且其作废条件原文即「缺席」 | 与 docs/11 §4.5 字面有口径差（以 docs/12 为准，确认书工作要求第 2 条）；回看期数 50 → p3 约 50 天/ssq·dlt 约 4–5 个月，更长宕机仍按作废处理（可调常量） |
| D-03 | 战果/致歉推送的重试形态：确认书 T5 =「重试至 23:30，超线入 repushQueue」 | ① settleOne 内再造一套重试游标至终止线再入队；② 失败即入队，由队列统一按 retryMinutes 续试（未过线送达不加前缀、过线加【补发】） | **②**（单一代码路径） | 语义等价：队列的续试间隔=retryMinutes、不过线送达无标注、过线送达有【补发】，可观察行为与 ① 一致；避免在 settleOne 里复制 tick 已有的推送游标逻辑 | 预测推送仍保留既有直重试游标、超 catchUpEnd 才入队（与 T5 字面一致）；apology 条目 issue=null，合并键按 `kind\|game\|issue` 空 issue 归并 |
| D-04 | 补发队列溢出告警的通道 | 告警也入队重试；告警只发一次（fire-and-forget） | **后者** | 防自激：告警失败→入队→再溢出→再告警；通道不通时告警物理上送不出，属诚实边界（心跳语义兜底：22:30 无消息=异常） | 通道恢复后队列状态在面板 status.repushQueue 可见 |
| D-05 | 休市日是否处理补发队列 | 休市跳过一切（含补发）；补发照常 | **补发照常** | T2/C2 的「不出号、不对账、不致歉」针对当日业务段；滞留消息送达是传输层职责，跨天携带（B-05）语义本就要求恢复即发 | 若主人希望休市日彻底静默，可把队列处理移入 !holiday 块（一行改动） |
| D-06 | `settle --force` 的目标集 | ① 仅 given-up 条目（排除普通 !settled）；② 普通 !settled ∪ given-up | **②** | B-18「仅重开 given-up」理解为对 given-up 的**重开授权**（区别于 voided 不可触碰）；普通待对账条目是 v1.0 既有行为，--force 没理由跳过它们 | voided 条目两种读法下都不触碰 ✓；若要 ① 改 filter 一行即可 |
| D-07 | status 附加字段落点 | ① docs/11 §2.1.2 行归属的 lib/index.js 内拼装；② scheduler.status() 构造处追加（index.js 仅展开） | **②** | status 载荷实际由 scheduler.status() 构造；在构造处加字段对 FZ-6「只增字段」效果完全一致，且可被单测直连（临时目录起真实调度器验证两读数）；index.js 一行未动 | 若 v2 需要在 index 侧再叠加字段，互不冲突 |
| D-08 | CLI settle 是否同步引入作废自动判定 | 仅调度器作废，CLI 遇跳号只提示；CLI 与调度器同款判定（settleOutcome 复用） | **后者** | S-011 明言「或经 CLI 人工标记」；两侧行为不一致会造成账本口径分裂；复用同一纯函数零额外语义 | CLI 作废同样走历史复核（D-02） |
| D-09 | selftest 与 judge-golden.test.mjs 的夹具关系 | 共享模块 import；各自内嵌同一套夹具（约 40 行重复，文件头互注同步义务） | **后者** | selftest 须在服务器运维环境直跑（不假设 node --test 与 tests/ 可达路径单一）；tools→tests 的交叉 import 会把 CLI 耦合到测试布局 | 夹具数据若需更新，两处同步改（均已注明） |
| D-10 | DLT 金样本夹具来源 | 构造假开奖；联网核实一期真实开奖内嵌 | **后者**：大乐透 26120 期（2026-10-21 开，前区 01 06 10 15 32 + 后区 03 04），新浪体育 26120 复盘文与上海体彩公告两源一致，且与仓库 draws.test nextIssue 夹具（26120@2026-10-21）互证；SSQ 2026121 / P3 26282 沿用仓库开发期实测真实数据 | AC-002 口径 =「历史真实开奖构造的假想投注」；测试本身完全离线 | 夹具来源与手算对照已写进 tests/judge-golden.test.mjs 文件头 |
| D-11 | settleOne 的条目查找谓词 | 维持 !settled；扩为「未结清 = !settled \|\| settleState==='given-up'」 | **后者** | carry（C8）把 given-up 条目持续带入对账，查找侧必须同一口径，否则补判永不发生；voided 排除 | 与 docs/10 §5.1 predictions 契约的未结清公式逐字一致 |
| D-12 | 历史复核回看期数 | 30（=historyCount 默认）/50/配置化 | **50（常量）** | p3 日开约 50 天、ssq/dlt 约 4–5 个月，覆盖 T8 的 8 天宕机场景有余；配置化属范围蔓延 | 调整只改 scheduler.js 的 VOID_HISTORY_COUNT |
| D-13 | 状态级 8 轮对账上限路径（g.settleTries > SETTLE_MAX_TRIES）是否也做放弃记账 | 补放弃记账；维持 v1.0（仅标 state settled，predictions 留待次日 carry） | **维持 v1.0** | 该路径仅在抓取持续报错时触达；FR-001「不允许永久滞留」由次日 carry 全量扫描兜底（已实现）；当晚 give-up 记账由 settleOne 内放弃分支在 23:30 后的正常轮次完成 | 不扩围改写罕见路径；若主人要求该路径也即时挂账，可在该分支调 buildMainPendingEntry |
| D-14 | 新配置三键是否写入 index.js 首写配置模板 | 写入模板；不写入（运行时默认值 + docs/05 说明） | **不写入** | index.js:32 裸写块属 C-09 已裁决的「不动」范围（避免范围蔓延）；DEFAULTS 与 ?? 兜底使旧配置文件零迁移可跑 | 部署会话顺手更新服务器上的实际配置文件时补三键即可 |
| D-15 | settle/deps 的联网路径如何验证 | 本地起假 HTTP 服务拦截抓取；如实标注「未本地验证」并交付离线可验部分 | **后者** | CLI settle 有目标时需真实体彩/福彩接口（fetchLatestDraw/fetchHistory），无人值守下构造假数据源验证的价值有限且引入测试桩；核心判定逻辑（settleOutcome/builders/ledgerTotals）已被纯函数单测全覆盖，空目标路径/原子写/版本字段已冒烟 | 部署会话执行 docs/05 五步验收时以真实数据覆盖（尤其第 3、5 步） |

## 验证记录（命令与结果摘要，全量原文见阶段D 报告）

- 基线（T0）：`node.exe --test "tests/*.test.mjs"`（plugins/dsh-koi/ 下）→ **29 pass / 0 fail**；`node.exe docs/decisions/B-verify-koi-v1.1.mjs` → **21 pass / 0 fail**（复现阶段B/C 结果）。
- 每任务中间轮：T1a/T1b/T2/T3/T4/T5/T7/T8 纯函数组 18 例全绿后进入 CLI 改造；CLI 冒烟（selftest 12 pass/0 fail、ledger --reset 产出含 schemaVersion:1 的原子写文件、settle --force 空目标路径、validate、demo-predict）全过。
- 终局（T11，验收门命令原样）：`~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe --test "plugins/dsh-koi/tests/*.test.mjs"`（仓库根目录）→ **58 tests / 58 pass / 0 fail**（draws 22 + stats 7 + v11-fixes 18 + judge-golden 11）；B 验证锚点复跑 **21 pass / 0 fail**；`package.json` 读回 `"version": "0.2.0"`。
- 冻结区走查（T9）：`git diff lib/draws.js` 仅 1 个 hunk（appendLedgerEntry 注释 + ledgerTotals 扩展，FZ-1/FZ-2 函数零触碰）；`git diff lib/push.mjs` 0 行（FZ-4）；fetch-draws/stats/client/index 零改动（B-04）；相位机字面量与转移完全不变（FZ-5，settleState 为条目级字段非相位）。

## 未验证项（如实）

1. `settle --force` 有目标路径、`deps` 新鲜度探针的联网半边（D-15）——需真实体彩/福彩数据源，留部署会话。
2. 整 tick 集成行为（休市跳段/补发队列循环/预测超线入队的运行时串联）——以纯函数单测 + 代码走查钉死；带假时钟的整 tick 注入属 C9（缓行）。
3. 部署环境项（AC-001 五步验收、TC-003/004/017/018/019 运行时部分、AC-025、M0-T10 四项）——按 docs/13 §5 移交清单未执行。
