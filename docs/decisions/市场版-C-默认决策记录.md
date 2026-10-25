# 市场版 · 阶段C（实施评审/确认书）默认决策记录

> 管线：市场版 SDD 四阶段流水线（A→B→C→D），阶段C = 实施评审人（product-manager 评审框架 + SOP 达成度对照）。
> 上游：docs/15 v1.0.1（需求权威）→ docs/16 v1.0.1（设计权威）→ 本阶段产出 docs/17-市场版-实施方案确认书.md（范围裁决 + 开工指令）。
> 纪律：主人休息期间无人值守，一切本应向主人提问/确认的点按本阶段角色最佳推荐默认值执行，逐条登记（编号 MC-xx）。醒来后逐条过一遍，任何一条不同意都可指出，由 D/后续会话修正。全程未 git commit/push、未触碰服务器/现网。

## 默认决策表

|编号|事项/问题|候选项|采用的默认值|选择理由|影响与后续可改点|
|-|-|-|-|-|-|
|MC-01|D 阶段范围总裁决|a) 仅任务推荐清单字面项；b) P0 执行层包 = 推荐清单 + 三态模式与门控（FR-1023）+ FR-1024 + FR-1017 + FR-1022 + migrate-v2 + hygiene + 向导；c) 再加学习半环与全量底座|b：采纳 docs/14 §六推荐默认，以 docs/15 交付物定义校准——三态模式与门控是市场包行为骨架（默认手动、门控、永久基础层，BC-111 锁定项），不纳入则市场包首装即自动跑全流水线，违反锁定决定；FR-1024/1017/1022 均为 P0 且为手动模式（市场默认形态）的必要支撑|docs/15 交付物定义明确含「三态模式与门控」；「装完即用、默认手动」是 R8+R11 锁定项，砍掉即违约|范围以 docs/17 §4.1（W1~W15）为准；主人可裁决增删工作流，增补需评估容量|
|MC-02|学习闭环（FR-1013/1014/1015）是否纳入 D|a) 纳入（docs/16 §2.2.9 设计完整）；b) 显式移交第二波|b：整体移交第二波|①FR-1013/1014 为 P1，FR-1015 的文案面依附学习页面；②preprocessor 会话清洗质量未验证（docs/16 §8.2⑤）——D 内高迭代风险；③回测引擎等 M1，入库半环独立价值有限；④TC-107 用例族（四格式+图片版 PDF+超限+不可解析+去重+待补）体量大，D 已满载|FR-1015 由 P0 登记降级为「随学习半环第二波交付」；设计完整保留（docs/16 §2.2.9），第二波零迁移；主人若坚持本轮要学习半环，须同步削减 W5/W8 的 UI 深度|
|MC-03|自拉全量底座（FR-1016 backfill）与 MA-17 冷启动联动裁决|a) 纳入 D；b) 全量回拉移交第二波，向导第 5 步改「近期窗口按需拉取（复用 FR-1024 机制）」|b：全量回拉（进度条/断点续传 UI）随第二波；D 交付 drawstore 近期窗口 + 按需抓取 + 增量挂对账（自动模式出号只需 historyCount=30，§2.2.6-5 路径完整覆盖冷启动）|MA-17 明文要求 C 对「底座移交后的冷启动」一并裁决不得悬空——本裁决使冷启动不依赖全量回拉；本地库随每期对账自然累积；全量深库属学习/M1 价值面|FR-1016 优先级登记降级为「近期窗口机制本轮交付 + 全量回拉第二波」；AC-108 拆分（校验层断言留 D，续传/进度/镜像断言随第二波）；第二波实施时 docs/16 §4.4 设计直接可用|
|MC-04|MB-22 提请：AC-112/TC-112 口径修订背书|a) 不背书（回退方案 a：锁定策略师=1，违反 FR-1006 P0）；b) 背书双显示口径|b：背书——市场单 agent 形态可验收面 = M3 满配投影随阵容/权重变化正确 + 当前形态实际估算如实标注「不随阵容」；TC-112 围栏侵蚀步骤维持原口径|FR-1006「数量可配」不可由确认书降级；诚实双显示符合 BC-107；需求侧口径经确认书回流是既有纪律（docs/11 B 轮第 5 条先例）|若主人不接受投影口径，回退 = 修订 FR-1006 并砍角色数量配置（影响 docs/15/16 两处）|
|MC-05|MB-35 提请：repushQueue 迁移豁免背书|a) 不背书（回退双写过渡一版）；b) 背书「瞬态字段内容搬家非删数据」口径|b：背书——repushQueue 为瞬态队列字段非业务数据；迁移 = 内容搬家至事件存储 + 原字段保留读取容忍；三 JSON 业务条目零触碰维持|保守双写会语义分叉（MB-02 已弃）；DC-009 保护对象是业务数据完整性，不受侵蚀|若主人认为 state.json 任何字段都不可停写，回退 = 双写过渡一版（D 加少量代码）|
|MC-06|MB-29 出厂默认档背书|维持 v1 现状档 / 背书最小档|背书最小档（ssq-r7b1 14 元/dlt-f6b2 12 元/p3-x1 2 元）|出厂默认服务市场新用户低门槛；作者连续性由 migrate-v2 反查档表写入保障|一行配置可改回；向导第 2 步引导升档|
|MC-07|FR-1021 捐献入口是否先行框架|a) 框架先行（docs/15 §5.4-6 字面）；b) 整体随素材第二波|b：与 B1/B2 素材同批移交|无素材可展示的空折叠入口无用户价值；BC-101 豁免边界以素材为「展示内容」前提，无素材则豁免论证不成立|素材定稿后第二波连同框架一起做（半小时级工作量）；若主人想先占位，D 补一个空折叠节即可|
|MC-08|FR-1018 社区镜像本轮形态|a) 完整实现；b) 仅 config 接口位（默认 off）|b：mirror.{enabled,acknowledged} 入 schema 默认 off；抓取器/知情确认/来源标注随第二波|P2 + 默认关闭 + 官方源为主路径；接口位成本≈0 且防第二波 schema 再动|AC-108 镜像断言随第二波；第二波实现时过 BC-104/105 校验闸|
|MC-09|docs/16 §6.3 配置表 modes.\<g\>.tier 默认值行残留 MB-08 旧值（ssq-r8b1/dlt-f7b2），与 §5.3 唯一权威（MB-29 最小档）矛盾——阶段C 复盘发现|a) 仅在 docs/17 记录、留 D 注意；b) 就地勘误并标注归属|b：docs/16 §6.3 该行已改为最小档并标注「⚠C 勘误 2026-10-24 阶段C / MC-09」，注明 ssq-r8b1/dlt-f7b2 仅为作者迁移值|§5.3 已被 MB-31 确立唯一权威，但 D 对照 §6.3 表实施时仍可能被残留值误导——勘误成本一行、误实现成本一轮返工|阶段B 文档的 C 阶段最小侵入修正，修订脉络在勘误标注与两份决策记录中可溯；主人若要求版本号随勘误升 v1.0.2 可补|
|MC-10|力度杠杆与用户直改 historyTail 的优先级未定义（§5.3 同时存在 effort.tier 与 historyTail:10）|a) config.historyTail 恒优先；b) effort≠follow-host 时杠杆表值优先，follow-host 用 config.historyTail|b：非 follow-host 档以杠杆表（6/12/14）为准；follow-host = 宿主默认语义 = config.historyTail（默认 10）；配置页力度区如实展示当前生效 tail|R7「统一四档旋钮自动映射」的语义是旋钮拥有杠杆值；follow-host 的「v1 原样」本就是读 config；两来源冲突时旋钮优先才可观测|D 实现于 prompt 组装处；若主人想让 historyTail 恒优先，改一处优先级判断即可（会削弱四档互异保证，不建议）|
|MC-11|gates 四项中 channelOk/tierOk/timeOk 的存储语义（§5.3 模板 gates 内含可推导项，易被误读为持久判定）|a) 全部持久判定；b) 仅 honestyAck 持久，其余为向导缓存展示值、判定以 setMode 实时校验为准|b：checkGates() 实时校验是唯一判定源；存储的三个布尔仅作向导界面缓存|渠道状态/档位合法性/时间约束都是时变量，持久化即会过期误判；honestyAck 是用户勾选的事实记录必须持久|D 实现向导时按此口径；模板 gates 示例值不构成断言|
|MC-12|advisory 生成与成本计量的生效彩种面未显式定义（manual 模式是否产建议）|a) 全彩种全模式；b) 仅 mode=auto 彩种|b：仅 auto 彩产生成建议并计入估算 advisory 项|判据含 ledgerPerTier（需自动模式账本）；MA-26 已定「观测仅覆盖自动模式档位建议」；manual 无投注行为、建议无对象|与 docs/16 §4.2 成本公式「advisory.enabled × 每开奖日」叠加理解为「auto 彩种的开奖日」；若主人想要 manual 下的「预备档建议」，第二波评估|
|MC-13|AC-109 桌面实机冒烟在本机不可得的处置|a) 等桌面环境齐备再验收（阻塞 D）；b) 分级降级——D 做静态确认（react-dom/inject 解析路径）+ web profile 本地冒烟 + 组件单测，desktop 实机项如实标注「未跑」移交主人上机补验|b：分级降级，不阻塞其余验收|本机无 dsh-web-app 前端包（docs/16 §8.2② 实查 .pnpm store 空）；诚实汇报纪律优先于形式完备|desktop 实机补验清单在 docs/17 §5.3-6；主人上机按 AC-109 四步跑即可|
|MC-14|D 验收门命令形态|目录形式 / glob 形式|glob 形式：`"C:/Users/10170/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe" --test "plugins/dsh-koi/tests/*.test.mjs"`（cwd=D:/QQ工作区），未过退回修复最多 3 轮|沿 docs/decisions/00 C-03 已验证结论（目录形式在该 runtime 实测失败，glob 自动覆盖新增测试文件）；本阶段已用同命令复核基线 58 pass / 0 fail|D 新增测试文件自动入门；如 runtime 路径变化以当次实跑为准|
|MC-15|D 期间容量富余时的范围纪律|a) 富余则回捞移交项；b) 不回捞，范围变更须显式登记新决策|b：不回捞——「不为凑数硬塞」双向生效|回捞学习半环/底座会重新引入未验证依赖（preprocessor 质量/分页上限）与测试族体量，破坏 D 可收口性|主人醒后若对 D 产出满意且想要提前第二波项，显式立新决策再扩展|
|MC-16|交叉复核意见1（high）：T8「组件级单测」不可执行——本机与 DSH runtime 测试环境均无 react/react-dom（C 实测：workspace 根与 plugins/dsh-koi 无 node_modules；`dependencies/node/node_modules` 仅 README.txt）；不预决则 P0 桌宠三交互零已执行验证|a) UI 逻辑抽 React 无关纯函数直测；b) factory(require) 注入微桩 harness；c) 引入 react+jsdom devDependency|**a 为主 + b 为辅**：向导门控状态机/六区校验联动/降级判定/红点未读游标/详略选择抽 lib/ui-logic.js 纯函数（node --test 直测）；client.js factory(require) 注入假 react 记录调用序列（验 mountPet/unmount 次序与降级触发）；React 渲染壳标注「未跑待主人上机」（沿 MC-13）。**c 不采纳为默认**：与红线7「零新原生依赖」冲突（MB-13 同款供应链/体积理由）|纯函数抽离是本插件既有纪律（v1.1 C-06、docs/16 §7.4「新模块全纯函数」）；微桩不依赖真 react 且可验证挂载调用契约；P0 验证必须在本机可执行|AC-101 桌宠三交互的 D 期已执行覆盖 = 逻辑面+微桩面，渲染面待主人上机（AC-109 清单同批）；主人若愿意放开 devDependency 面（react+jsdom 仅测试用不进打包），可改 c 并更新红线7 例外声明|
|MC-17|交叉复核意见2（medium）：W12（roles schema+stamp+FZ-7 侵蚀用例）在任务表无落点；docs/16 §5.2 与 scheduler 清单⑥均无角色/配置版本 stamp 字段——FR-1006「配置版本化 stamp 进档案」/FR-021/DC-103 继承项悬空（阶段B 遗留缺口，§8.7 追溯矩阵落点不含 stamp）|a) 仅补任务行不动 docs/16；b) 任务落点 + docs/16 §5.2 补 configStamp 行（标注 ⚠C 补）|b：T1 补 roles schema 校验（strategists 1–4、prompts 对象占位类型拒绝）；T6 stamp 扩展 configStamp（内容=角色阵容与配置版本摘要，格式 D 定，语义沿 FR-021/DC-103，FZ-3 只加字段）；T13 补侵蚀负向用例（直改配置文件注入侵蚀性 roles.prompts——编辑器只读，侵蚀面=配置文件直改；断言硬校验/基线/渲染/兜底标注行为不变）；docs/16 §5.2 已补行（⚠C 补标注）|设计权威文档缺字段行会让 D 的 FZ-3 合规审查无据可对；侵蚀用例必须有落点否则 §4.3 背书的 TC-112 第 2 步落空|configStamp 具体格式 D 定（推荐含策略师数量+配置版本号）；主人若认为 stamp 应含更多配置面（力度/详略已有独立字段），D 可扩展|
|MC-18|交叉复核意见3（medium）：T7「8 条新路由」与 MC-02/03 矛盾——docs/10:177 与 docs/16 §6.1 的 8 条计数含已移交的 /api/ingest；/api/backbone POST「启动拉取」在全量底座语境与 W9「backfill 仅留接缝」冲突；向导第 5 步路由承载未定义|a) ingest/backbone 整体随第二波（向导第 5 步失去后端）；b) 路由终集 = 5 新 + 2 改，backbone POST=近期窗口按需拉取|b：新 5 条（events/config/channels-test/mode/backbone）+ 改 2 条（status/test-push）；**/api/ingest 随学习半环第二波移除**；backbone GET=drawstore/databackbone 状态、POST=触发近期窗口按需拉取（MC-03 向导第 5 步后端），全量拉取动作第二波扩展；docs/10 §5.3 ⚠M 注记已同步修订（标注 ⚠C 修订/MC-18）|向导第 5 步（MC-03 裁决）必须有路由承载，砍 backbone 会让冷启动断链；ingest 留着则违反 MC-02 移交口径|D 期路由终集以 docs/17 §4.4 为准；第二波恢复 ingest 时沿用 docs/16 §6.1 原契约（20MB 上限等）|
|MC-19|交叉复核意见4（low）：AC-114 市场用户覆盖升级断言（配置/数据/适配器目录 diff 为空、镜像开关不变）无任务承接——T10 原只覆盖作者 migrate-v2 fixture 面|a) 留待主人上机验证；b) T10 补本地目录隔离演练|b：DSH_HOME/KOI_CONFIG 指向临时假目录（构造用户配置/侧车渠道 qq.config.json/三 JSON），模拟包目录替换（复制新版包文件），diff 断言用户数据零变化+mirror 开关状态不变——纯本地文件操作不涉网|AC-114 两半（市场用户面/作者实例面）都应有已执行验证；目录隔离是设计承诺（S-115）最直接的可测面|演练脚本可复用为第二波升级回归用例；真实市场覆盖升级仍待主人在真环境复验一次|
|MC-20|交叉复核意见5（low）：C 对 docs/15 的四处口径修改（AC-112 双显示/AC-108 拆分/FR-1015/1016 降级/S-102 第 5 步改近期窗口）只落 docs/17+决策记录，IR 原文未回流——第二波开工者按 docs/15 字面会拿到过期验收面|a) 本轮直接改 docs/15 正文；b) 列「待回流清单」（docs/17 附录B），第二波开工前或主人醒后一次性升版 v1.0.2|b：清单已落 docs/17 附录B（5 行：AC-112/AC-108/FR-1015/FR-1016+S-102/FR-1006 stamp 指针），第二波开工者以清单+docs/17 为准|裁决性口径变更宜一次性回流升版，避免 C 阶段对 IR 正文分散编辑导致修订记录混乱；与 MC-09/17 的区别：那是阶段B 自身事实性错误就地勘误，这是 C 的裁决增量|主人醒后或第二波开工前执行回流（升 v1.0.2 + 修订记录）；若主人要求现在就回流，改 docs/15 四处+版本号即可（半小时级）|
|MC-21|交叉复核意见6（low）：T1~T13 无工作量估计、R7 降级触发纯主观；R7 原预授权降级 T12 与「不做清单同等约束力」矛盾——T12 是 docs/15 §4.3 交付物本体，降级=砍交付物|a) 维持主观判断；b) T-shirt 粗估 + 降级纪律改写 + 客观触发线|b：规模列已加（4L+6M+2S+1L：events/channels、scheduler、client UI、测试族为 L）；可降项仅 T11 面板提示面，T12 不可整体降级（吃紧缩编篇幅并登记）；触发线 = T10 完成时点晚于 D 全程预算 75% 即启动降级评估；W1~W9 核心链路任何情况不降|PM 框架 T-shirt sizing 即可满足容量对齐精度；交付物本体（用户文档）与削峰项（面板提示）性质不同必须区分；客观触发线消除「尾部吃紧」的主观性|估计为粗估（±1 档误差），D 执行中偏差过大时登记调整；触发线 75% 为默认值，主人可调|

## 占位符定值情况

无。本阶段核对的全部文档（docs/14/15/16/09/10）经 grep 实测无 `[[PH:...]]` 未定值占位符（docs/15/16 文内仅有「无占位符」声明行）；本阶段产出（docs/17、本记录）全部数值可溯源：58 例基线（本会话实测）、最小档注数/价格（docs/16 §2.2.4-1 档表）、五道验收门（docs/decisions/00 + 本阶段补充）。

## 独立产品经理交叉复核处置（2026-10-25，docs/17 v1.0.0 → v1.0.1）

独立 PM 交叉复核对 docs/17 v1.0.0 提出 6 条意见（high 1 / medium 2 / low 3），逐条核实后 **6 条全部采纳**（意见1 采纳「①纯函数抽离为主 + ②微桩注入为辅」组合、其候选③ react+jsdom devDependency 不采纳为默认）。处置已全部落实到 docs/17 v1.0.1 与本表（决策编号 MC-16~21，见上表末 6 行）。涉及上游文档的两处联动：docs/16 §5.2 补 configStamp 行（MC-17，⚠C 补标注）、docs/10 §5.3 ⚠M 路由注记修订（MC-18，⚠C 修订标注）。

## 本阶段实测记录（2026-10-24/25，DSH runtime node）

1. 测试基线：`"C:/Users/10170/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe" --test "plugins/dsh-koi/tests/*.test.mjs"`（cwd=D:/QQ工作区）→ **58 pass / 0 fail**（与 docs/15 NFR-103、docs/16 §8.2 基线逐位一致）。
2. 代码主张抽查（docs/16 行号引用 5 处）：scheduler.js:105-108（retryIntervalMs 读 cfg.push.retryMinutes）、scheduler.js:589（quickpick 拒已关彩种）、scheduler.js:329（settleText 读固定 stakesOf）、index.js:29-42（模板含作者 QQ 1017099872）、scheduler.js 导出清单（FR-005 纯函数族五件套）——**全部属实**。
3. react/react-dom 缺失实测（交叉复核意见1 核实，MC-16 依据）：`ls node_modules`（workspace 根）→ No such file or directory；`ls plugins/dsh-koi/node_modules` → No such file or directory；`ls "C:/Users/10170/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/node_modules"` → 仅 README.txt——测试环境确无 react/react-dom。
4. configStamp 缺口核实（交叉复核意见2）：grep docs/16「stamp/roles/configStamp/FR-021」→ §5.2 字段表与 §2.2.2-⑥ stamp 清单均无角色/配置版本字段——FR-1006 stamp 落点悬空属实，已按 MC-17 补行。
5. 文档矛盾扫描：docs/16 §6.3 残留 1 处（MC-09 已勘误）；docs/09/10 ⚠M 注记（§2 FZ-7/§3 变更带/§5.1/§5.3/§5.6、INT-4/5/7/13）实读在位；docs/10 §5.3 路由计数已按 MC-18 修订。
6. git 纪律：零 commit/push（HEAD 仍为 7a927f3），全部产出留在工作区。

## 未验证项（如实声明）

1. aet-req-review 完整评审管线未跑（sdd_advance 不存在，A/B 两阶段以自查 + 独立 PM 复核替代——docs/17 §1 已复盘）；主人可事后补跑。
2. AC-109 桌面实机冒烟依赖的 desktop harness 本机不可得（MC-13 分级降级）。
3. docs/16 §8.2 声明的 6 项未验证项（reasoningEffort 通道/react-dom 解析/分页上限/请求量估计/preprocessor 质量/无模型错误串）维持原状，处置已在 docs/17 §5.2 风险表逐一落位。
