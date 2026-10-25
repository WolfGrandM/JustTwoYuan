# 市场版 · 阶段B（系统设计）默认决策记录

> 管线：市场版 SDD 四阶段流水线（A→B→C→D），阶段B = aet-req-design。
> 上游：docs/15（IR v1.0.1，权威需求输入）→ 本阶段产出 docs/16-市场版-软件设计文档-SDD.md（v1.0.0）。
> 纪律：主人休息期间无人值守，一切本应向主人提问/确认的点按系统设计师角色最佳推荐默认值执行，逐条登记（编号 MB-xx）。醒来后逐条过一遍，任何一条不同意都可指出，由 C/D 阶段修正。全程未 git commit/push、未触碰服务器/现网。

## 默认决策表

|编号|事项/问题|候选项|采用的默认值|选择理由|影响与后续可改点|
|-|-|-|-|-|-|
|MB-01|事件层持久化载体：塞 state.json / 新建独立文件|a) events 并入 state.json；b) 新建 koi/events.json|b：`koi/events.json`（schemaVersion:1），90 天滚动清理 + 桌宠列表窗口 200 条（MA-24 定值，可配）|state.json 属调度器独占当日状态机（docs/10 §5.1），事件为跨天业务数据，职责分离；FZ-3 对新增数据文件属布局加法|载体与清理参数可调；若嫌文件多可在 C 阶段合并回 state（需重评 FZ-3）|
|MB-02|v1.1 state.repushQueue 的去向|a) 保留双写；b) 一次性迁入事件存储后停写|b：migrate-v2 把 repushQueue 迁入事件待发队列；此后 state 不再写、读取容忍旧字段|事件层接管重试后双写会语义分叉；迁移保补发连续性（作者实例）|迁移在 D 实施；若主人要保留双写观察期可指示|
|MB-03|渠道适配器发现目录|a) 仅包内内置；b) 内置+用户目录双扫描|b：`lib/channels/builtin/`（打包，市场版仅 panel.js）∪ `$DSH_HOME/koi/channels/`（用户/作者私有 qq.js）|FR-1003「内置+用户放入均可」原文；用户目录天然满足 S-115 升级隔离（市场包覆盖安装不触碰）|目录路径可再议；适配器为 ESM default export（包 type:module 一致）|
|MB-04|桌宠挂载机制（任务点名 Gemba 定）|a) 找全局 slot 注册；b) 独立 React root 挂 document.body|b：复刻 dsh-m mountPanel 实证模式（createRoot + ensureCss + body 容器）；实读 4 个已知 slot 均为区域位、无全局浮层 slot|dsh-m 同款已在 DSH 0.2.1-rc.2 双 profile 实跑（§8.4 证据链）；不赌未验证的宿主能力|若宿主未来提供 overlay slot 可切换；React 不可用时降级纯 DOM 渲染（dsh-m fallback 姿势）|
|MB-05|桌宠数据轮询|a) WebSocket/SSE；b) HTTP 轮询|b：`GET /api/events?since=&limit=200`，30s 周期（koi status 轮询同周期先例 client.js:81）|宿主无插件级推送通道证据；轮询窗口有界=NFR-104 常量级|周期/窗口可配；若宿主提供推送通道可升级|
|MB-06|档位判奖实现路径|a) 改 judge 支持任意结构；b) 拆单元聚合（长池直喂 + 多蓝/多注拆单元）|b：unitsOf 拆单元逐个过 FZ-1 judge 再聚合（A2.1 实测 r9b2=168 注逐位一致）|FZ-1 语义不变的唯一无损路径；改 judge 违反冻结区|聚合器纯函数可独立单测；档位扩展只需扩档表|
|MB-07|档位校验/随机的落点|a) 改 validatePicks/randomPicks 参数化；b) 平行新函数 validateTierPicks/randomTierPicks（tiers.js）|b：平行新函数，规则风格复刻、参数取自档位|FZ-2 明令冻结；平行函数零风险且档位缺省时行为等价旧规格|D 实施时旧函数调用点切换到 tier 版|
|MB-08|每彩种默认档位|a) 最小档（p3-x1/ssq-r7b1/dlt-f6b2）；b) v1 现状结构（p3-x1/ssq-r8b1/dlt-f7b2）|b：默认档 = v1 现状（ssq-r8b1/dlt-f7b2/p3-x1）|作者实例账本连续性（同结构可比）；市场用户可在面板任选|出厂档是配置默认值，改表零成本|
|MB-09|力度四档的杠杆定值（MA-16 恢复完整映射后的设计落点）|a) 只做参数直传（赌宿主支持）；b) 三维杠杆表 + 参数直传 spike|b：historyTail 6/10/14 + 正文字数 150-300/300-600/400-800 + turbo 自检段；reasoningEffort 直传留 D 阶段 spike 通道|任意模型都有可观测差异（材料量杠杆结构性保证）；不赌未验证宿主接口|杠杆数值为配置默认可调；spike 结果可能追加参数维|
|MB-10|koi 侧 token 计量路径|a) 等宿主 usage 接口；b) chars/4 保守估算自持记账|b：koi/token-usage.json 轻量计量（activity∈predict/learning/advisory，自然周重置，est:true 恒标）|宿主逐调用 usage 接口不可见（docs/11 ADR-13 同款困境）；估算先行不阻塞；诚实标注估算口径|若 D spike 验证 usage 可得，切实测并保留估算兜底|
|MB-11|off 模式下「现在来一注」|a) 沿 v1 enabled:false 拒绝；b) 放行（永久基础层）|b：三态任一均放行（FR-1023「任何模式可用」明文）|需求锁定项 R8+R11；v1 拒绝行为是 enabled 布尔的历史语义非产品意图|显式行为增量已在 docs/16 §2.2.2-3 声明，D 实施需同步面板文案|
|MB-12|出号时间校验的数据源|a) 解析 drawTimeText 字符串；b) GAMES 加结构化 drawAt 字段|b：GAMES 各彩种加 `drawAt:'HH:MM'`（drawTimeText 保留展示）|解析中文文案脆弱；加字段属 FZ-3 合规加法（GAMES 定义不在 FZ-1/2 函数冻结清单）|若主人认为 GAMES 也应整体冻结，可改为模块级常量表|
|MB-13|学习半环 preprocessor 实现|a) 宿主内嵌 PDF/EPUB 解析依赖；b) 会话 agent 文件契约清洗（零新原生依赖）|b：唤醒会话读文件→清洗 MD+拆卡 JSON 文件契约（ADR-1 同款）；上传路由独立 body 上限 20MB|零新依赖（PDF 解析库引入供应链与体积成本）；文件契约是本插件已验证模式|效果依赖 D 实测；若质量差再评估引解析库（届时过依赖审查）|
|MB-14|市场包卫生工具形态|a) 仓库外脚本；b) tools/hygiene.mjs 随包发布并作验收门|b：扫描器入 tools/（files 白名单内），AC-102 直接引用退出码|验收门必须可一键复跑；A2.1 V11 已验证模式集有效（6/6 耦合文件命中）|模式集随耦合点清零后可精简；白名单机制防误报|
|MB-15|作者私有 qq.js 模板的存放|a) 入仓库 tools/（随包发布）；b) 仅以文档形态收录 docs/16 §8.6|b：模板全文只在 SDD 附录，不入包目录|tools/ 在 files 白名单内——放那里会随市场包发布，直接违反 BC-103 物理不含|作者从文档复制到 $DSH_HOME/koi/channels/qq.js；若主人想要仓库留存可用不被发布的独立目录（C 阶段定）|
|MB-16|首写配置模板 v2 默认值|多项默认需定值|channels=[panel 启用]；三彩种 mode=manual；budget 150 万（拍板12）；effort=follow-host（拍板14）；verbosity=concise；pet.enabled=true；advisory.enabled=true；mirror 关|全部默认值均有拍板/IR 来源；manual 为市场新用户默认（BC-111）|concise 出厂（比 chatty 保守，用户可切）；pet 默认开（S-101 引导卡依赖其可见）|
|MB-17|advisory 周报对照的呈现|a) 推送周报（mind 体系行为）；b) 面板纯观测对照表|b：advisory-outcomes.json + 面板对照节（周聚合）|市场版无周报生成器（reports 属 mind/docs/11 体系）；FR-1012 只要求「周报做对照（纯观测）」——面板对照表满足观测语义且零新增推送打扰|若主人想要推送周报，作为待办池项随 mind 演进|
|MB-18|随机基线（DC-002）市场版落点|a) 不做（归 mind M1）；b) predictions 加 baselinePicks/baselinePrice 字段|b：auto 模式每期同刻 randomTierPicks 同构基线，对账回填判奖；predictions 只加字段（FZ-3 合规）|BC-113/AC-106 要求基线同构断言在市场版可验收；轻量实现（两字段+纯函数）不依赖 mind|字段只加不改；若 C 砍裁可整体不实施（无迁移负担）|
|MB-19|桌宠 z-index 冲突的降级值|a) 恒用 2147483000（dsh-m 同值）；b) 预留降级档|默认 2147483000（右下角小件与 dsh-m 全屏面板实际重叠瞬时）；若实测冲突降 100（`pet.zIndex` 可配）|dsh-m 同值先例是唯一实证参照；预置可配开关比事后改码便宜|D 阶段 AC-109 冒烟时观察；冲突则改配置而非发版|
|MB-20|DC-104「活动类别分项」在市场单 agent 路径的形态|a) 强制分项硬顶；b) 分项上限可空（null=仅记录），周总量硬顶优先|b：`budget.categories.{predict,learning,advisory}` 默认 null——记录各活动用量供面板展示，硬顶判定只看周总量；博弈类内角色权重分项随 M3 编排器生效|市场版无多角色博弈，强制分项会误伤出号主链路；记录面保留使 M3 接入零迁移|主人若要分项硬顶，填数值即生效（校验 >0）|

## 占位符定值情况

docs/16 全文无 `[[PH:...]]` 占位符。文中全部数值溯源：docs/14 拍板原文（150 万/1000 万、四档力度、初始档集示例、430 请求/15–30 分钟）、docs/15 继承值（5 分钟重试/19:50/22:30/23:30、90 天/200 条、4000 注入上限、70%/90%、>7 天、30 期窗口、20 上限）、代码现状（30s tick `scheduler.js:26`、16KB body `index.js:51`、4s 加餐轮询 `client.js:105`）、A2.1 本会话实测（58+33 pass、档表注数/价格、z-index 2147483000 取 dsh-m CSS 实测值）、本表 MB 默认（20MB 上限 MB-13、杠杆数值 MB-09、桌宠轮询 30s MB-05）。

## 自查记录（替代 sdd_advance 评审环节，2026-10-24）

sdd_advance 工具在本环境不存在（同阶段A MA-01 处置），按任务指示以一轮结构化自查替代：

|检查项|结论|
|-|-|
|模板符合性|通过——`assemble-template.mjs req-design` 装配后逐节对照（§1~§8 全结构、frontmatter effort=High、图例/IF 编号/条件节政策）；无模板注释残留|
|九大覆盖面（任务点名①~⑨）逐项函数级/字段级|通过——①§2.2.1（事件 schema 逐字段+emit 主循环+心跳算法）②§2.2.3+§8.4（挂载代码路径+样式隔离+风险）③§2.2.11（差异清单 7 行+补跑语义映射到代码行）④§2.2.7（六区+估算公式+校验规则）⑤§2.2.6（分批/续传/四项校验/增量接缝）⑥§2.2.4+§4.1（档表 9 档+拆单元+聚合算法）⑦§2.2.5（两档渲染+合规字段清单）⑧§2.2.9（条件纳入+流水线状态机）⑨§2.2.10+§8.3（扫描器+17 处耦合点逐点映射）|
|冻结区 FZ-1~6 零语义变更 + FZ-7 新增|通过——§8.1 对照表逐区核实；FZ-1/2 只调用不改（A2.1 实测）；FZ-3 只加字段（§5.2）；FZ-4 语义随私有适配器迁移保留；FZ-5 相位机不动；FZ-6 形状不变只加；FZ-7 结构性隔离（D-008）|
|改造不重写|通过——scheduler 保留状态机主体（5 处调用点改造清单式枚举）、draws 仅加 GAMES.drawAt 字段、prompt/io/stats/cordis 复用；无重写级变更|
|与 docs/15 逐条对齐|通过——§8.7 追溯矩阵 FR-1001~1024/NFR-101~106/AC-101~115 全落点；拍板 19 项经 docs/15 FR 映射继承；MA-16~28 复核处置全部体现（力度杠杆表、MA-17 联动写入 §3.4、MA-19 心跳口径 §4.3、MA-20 手动例外 §2.2.6-5、MA-21 迁移 §2.2.10-4、MA-26 口径边界 §2.2.8-3）|
|与 docs/11 权威分工|通过——市场版设计全部落 docs/16；mind 相关（编排/注入/晋升/回测）不触碰；「继承+增量」表述（FR-005 事件层重现、BC-013 链沿用、NFR-009 废除）|
|A2.1 验证完整性（effort=High）|通过——基线 58 pass（NFR-103）+ 设计主张 33 pass（档位数学/FZ-1 消费/拆单元/纯函数复用/心跳/校验/扫描器）；未验证项 5 条如实声明（§8.2）|
|无人值守纪律|通过——全程零 commit/push、零远程操作；一切询问点入 MB-01~20|

**自查遗留（如实声明）**：① reasoningEffort 直传通道、react-dom 可 require 性（本机）、官方接口分页上限、430 请求估计值、preprocessor 清洗质量——5 项不可本地验证，已列 §8.2 未验证项并给 D 阶段处置；② 学习半环与自拉底座是否纳入 D 轮属 C 阶段范围裁决（MA-17 联动已写入设计），本设计两者均给全量方案保证不悬空。

## 独立产品经理复核处置（2026-10-25，v1.0.0 → v1.0.1）

独立产品经理复核对 docs/16 v1.0.0 提出 16 条意见（high 2 / medium 8 / low 6），逐条核实后 **16 条全部采纳**，改动清单见 docs/16 §8.9。逐条登记（MB-21~36）：

|决策|对应意见（severity）|事项/问题|候选处置|采用的处置与落点|选择理由|影响与后续可改点|
|-|-|-|-|-|-|-|
|MB-21|意见1（high）|力度杠杆表 follow-host 与 standard 完全同参（tail 10/300-600/无自检），唯一差异是未验证的参数直传——spike 失败（DeepSeek chat 正是 R7 点名形态）则四档中两档零差异，违反 FR-1009/MA-16，AC-104 步骤3 确定性失败|a) 赌 spike 成功；b) 重构杠杆表使三维结构自身四档互异，参数直传降为叠加增强；同时修正「杠杆恒在=力度恒生效」的兜底判断|b：follow-host=纯 v1 原样（tail 10）、economy（6/150-300）、standard 改 tail 12、turbo（14/400-800+自检）——三元组两两互异（实测 dup=0）；§2.2.7-6/§4.2/§8.2① 兜底表述同步修正|四档互异必须不依赖任何未验证宿主能力；MA-16（v1.0.1 PM 意见1 刚恢复的要求）不可再违|杠杆取值可再调，约束=四档三元组互异；spike 成功则参数维叠加|
|MB-22|意见2（high）|FR-1006/AC-112/TC-112 要求「成本估算随角色数量/权重变化正确」，但市场单 agent 路径实际消耗不随阵容变化——需求前提与单 agent 现实矛盾，SDD 未显式决策且 §8.7 声称 AC-112 已落点；「降档链联动（满配=阵容）」同样无落点|a) 锁定策略师=1、UI 标注随 M3（违反 FR-1006 P0 数量可配）；b) 估算按阵容投影并明示 M3 后生效；c) 提请 C 修订 AC-112|b+c 组合：costEstimate 双显示——「当前形态实际估算（不随阵容）」+「M3 满配投影（随阵容/权重，标注随 M3 生效）」；降档链「满配=阵容」联动标注随 M3；AC-112/TC-112 口径修订（市场形态可验收面=投影随阵容变化+当前形态如实标注）提请 C 阶段在 docs/17 显式背书|FR-1006 P0「数量可配」不可由设计侧降级；诚实显示两态比假装单值更符合 BC-107；口径变更权在需求/确认书侧（docs/11 B 轮第 5 条「口径回流权威输入」先例）|C 阶段须对 AC-112 口径显式裁决；若主人不接受投影口径，回退 a 并同步修订 FR-1006|
|MB-23|意见3（medium）|qq 渠道按 v1.0.0 设计不可工作：契约只消费 send(event,cfg) 的 cfg，凭证却在侧车 qq.config.json，migrate-v2 只注册 {type,enabled} 无凭证——渠道层未定义侧车如何并入 cfg，照抄则 assertLoopback(undefined) 抛错，S-109 主通知路径断链|a) 凭证并入主配置 channels[]；b) 契约显式定义 cfg 组装=合并条目+侧车（侧车优先）；c) 适配器自读配置|b：IF-N03 定义 resolveChannelCfg(channels[i]) = 合并(条目非凭证字段, 侧车 <type>.config.json)，侧车优先且**凭证字段一律只存侧车**（统一用户渠道与作者渠道；凭证不进主配置，NFR-106 对齐；面板经 config API 掩码读写侧车）|凭证隔离在侧车是 NFR-106 最强形态；统一规则避免两套凭证来源；加载器集中组装比各适配器自读更可测|若主人倾向凭证进主配置（单文件管理），改 a 并重评掩码链路|
|MB-24|意见4（medium）|retryIntervalMs 读 cfg.push.retryMinutes 而 v2 已删 push 段（参数在 time.retryMinutes）——直接复用则用户改 time.retryMinutes 静默不生效恒 5 分钟；§2.2.10-4 说 retryMinutes 迁 qq.config.json 与侧车 schema 矛盾；迁移缺 time.predictAt→modes 映射（非默认 17:00 会被重置 17:30）|a) 改函数签名（触碰已测试导出）；b) 调用处形参 shim；c) 参数留在 push 段名|b：事件层调用 retryIntervalMs({push:{retryMinutes:cfg.time?.retryMinutes}})——函数本体零改写，等价性实测（7→420000ms、缺省→300000ms）；IF-R01/D-001 如实改「语义复用+参数面 shim」；迁移映射修正：push.retryMinutes→time.retryMinutes、time.predictAt→modes.\<g\>.predictAt（非默认显式携带）|零改已测试函数比重构安全；shim 一行且等价性可测；迁移映射补全消除静默重置|若后续重构 retryIntervalMs 直读 time 段，需同步 v1 兼容（读 push 段兜底）并升测试|
|MB-25|意见5（medium）|FZ-6 侵蚀：status 的 push/pushTargetMasked 失去 v1 数据源（NapCat 探测改渠道层），删除或恒空均触碰「只加不改」；enabledToday 三态语义未定义；§8.5 无 docs/10 §5.3 处置行|a) 字段退役并入 0.3.0 规则3 破坏性变更；b) 保留字段+值域连续的降级语义|b：push={ok:任一启用渠道 ok, detail:'推送已迁移至渠道层，见 channels'}；pushTargetMasked=掩码读 channels 首个 qq 型渠道侧车 target（无则 ''，与 v1 空配置逐位一致）；enabledToday=mode!=='off' && 当日开奖；docs/10 §5.3 补注记、§8.5 补行|降级语义零删零改类型、值域连续，FZ-6 最小侵入；破坏性退役留不出收益|若 C/D 发现下游依赖 push.detail 具体文案，再评估退役流程|
|MB-26|意见6（medium）|settleText 读 stakesOf 固定结构（scheduler.js:329），非默认档战果推送显示错误注数/价格——v1.0.0 改造清单①~⑥与 A2.1 均遗漏，违背 BC-113 文案层口径|维持（不改） / 补改造点|补：scheduler 改造清单⑦——settleText 改读 entry 自带 spec/bets/cost（出号时已随 scheduler.js:262 同款扩散写入 predictions 条目）；§2.2.4-5 补句；v1.0.0 遗漏如实承认（§8.9-6）|出号时已写入条目，读回即可，零新增存储；口径与账本同源|D 阶段实现时以 AC-106 战果文案断言覆盖|
|MB-27|意见7（medium）|FR-1022/S-117/AC-113 只有断言无机制：v1 流水线无模型时静默 5 分钟（等文件→重写→兜底），手动「现在来一注」返回兜底号而非清晰配置错误|a) 依赖宿主报错；b) 错误分类短路；c) 前置预检探针|b 为主、c 为辅：classifyHostError(err)→{kind:'no-model'|'other',hint}（模式表初值空+可配，宿主错误串不可本地验证——§8.2⑥）；命中 no-model：quickpick 直接返回含配置入口的错误、跳过打回重写与兜底；自动模式沿失败重试/致歉但 attempts 带 no-model 标注；不做常驻预检（每 tick 探活浪费），quickpick 前置轻量预检作为 D 阶段可选增强|手动模式无「必须出号」承诺，清晰失败优于静默兜底（S-117 原文）；分类点在既有 catch 内，零新增调用|模式表 D 阶段实测校准；若宿主无模型不抛错而是静默不响应，则需 c 路径补|
|MB-28|意见8（medium）|桌宠降级路径未进正文且 dsh-m 引证失实（其兜底分支实为 container.remove() 静默移除，无纯 DOM 渲染）；koi dsh.client.inject=[] 而 dsh-m 声明三宿主包——react-dom 可解析性论断更弱|a) 删降级承诺；b) 降级正文化+引证修正+inject 静态确认|b：§2.2.3-7 新增分级降级——第一级（必做）容器静默移除但渠道层 panel 与「设置→彩票节」事件横幅/红标/列表照常（桌宠 UI 缺席≠通知丢失）；第二级（可选）纯 DOM 冒泡；§8.2② 修正引证；react-dom 解析是否依赖 inject 声明列入 D 静态确认（必要时 package.json 补 @deepseek-ai/dsh-client-runtime 等条目，§2.1.2 已列）|最低可见性保证（设置节）不依赖任何未验证能力，结构上先成立；引证失实必须纠正|D 冒烟若证实 inject 依赖，补条目属加法零风险|
|MB-29|意见9（medium）|MB-08「默认档=v1 现状」论证错位：出厂默认服务市场新用户（与作者账本无连续性诉求；作者配置由 migrate-v2 携带）；新用户首注默认 ssq-r8b1（56 元/期）偏高，档表有更小档|维持 v1 现状档 / 改最小档|改最小档：出厂默认 ssq-r7b1（14 元）/dlt-f6b2（12 元）/p3-x1（2 元），向导第 2 步引导升档；作者连续性由 migrate-v2 按 v1 复式结构反查档表写入（ssq-r8b1/dlt-f7b2）；§2.2.4-1/§5.3/§2.2.10-4② 同步，MB-08 默认值部分被本条取代|低门槛起步符合 S-101「装完即用」市场定位；模拟投入档位是用户敏感面|出厂档为配置默认，主人可改回 v1 现状档（一行配置）|
|MB-30|意见14（low）|backfill 无终止条件/深度定义（进度缺分母、AC-108 缺基准）；「约 430 请求」与批 100 口径对不上（430×100=43000 期远超全量 ~1.5 万期）|留待 D / 定义目标深度与 done 判据|定义：默认全量历史至最早可得（mind M1 同口径，docs/11 §3.3 约 1.3 万期）；done=分页空页或短批；targetIssues 可配收口（null=全量）；进度分母=targetIssues（全量时由首批最早期号推算或直读接口总数）；请求口径修正：批 100 约 ⌈总期数/100⌉≈130–160 请求量级，docs/14 的 430 为按小批的估计上限（两口径均未实测，§8.2④）|全量是 BC-105「学习底座」价值最大化形态且与 M1 口径一致；估算口径必须自洽|若 C/D 容量有限可先 targetIssues=近 3 年，配置即改|
|MB-31|意见10（medium）|首写模板自相矛盾：§2.2.10-1 写 channels:[]，§5.3/MB-16 为 panel 启用——空数组则桌宠渠道未启用、S-101 引导卡与事件冒泡全失效、向导门控①首步失败|统一 / 维持|统一为 §5.3（panel 出厂启用）：§2.2.10-1 修正笔误并注明「panel 出厂启用是 S-101 引导链路前提」；§5.3 为唯一权威模板|笔误级修正；引导链路依赖明确|—|
|MB-32|意见11（low）|DC-102 kind 枚举缺 quickpick（§2.2.1-3 的加餐事件若 kind='quickpick' 会被自家 schema 拒收）|并入 predict+noRetry 标记 / 独立 kind|独立 kind：枚举补 quickpick（noRetry 恒 true）；心跳「当日应有事件」集合显式排除 quickpick（与 MA-19 口径集合一致）|独立 kind 保留加餐的查询/渲染语义（「加餐/手动·不记账」标注）；心跳排除与「无定时承诺」一致|—|
|MB-33|意见12（low）|§6.3 列 events.retentionDays/listWindow、MB-19 提 pet.zIndex，但 §5.3 权威模板无字段——D 实现将「表格有、模板无」分歧|删可配承诺 / 模板补字段|模板补字段：§5.3 加 events:{retentionDays:90,listWindow:200}、pet.zIndex、backfill.targetIssues——单一权威|模板为 D 实现的直接依据，补齐比删承诺好|—|
|MB-34|意见13（low）|docs/10 §5.6 CLI 契约未联动（push 退役、deps 语义、新命令集漂移）|留待 D / 就地补注记|docs/10 §5.6 补 ⚠M 注记（push 退役属规则3 变更带、deps 探针改渠道层汇总、settle --push 改事件层、新命令清单）；docs/16 §8.5 补行|已发布契约面漂移必须在契约文档显式声明|—|
|MB-35|意见15（low）|repushQueue 迁出与「三 JSON 只加不改不删、DC-009 不豁免」字面冲突（FR-1004/S-125）|保守实现（双写）/ 豁免声明提请 C|豁免声明提请 C：repushQueue 为瞬态队列字段（非业务数据），迁移=内容搬家至事件存储、原字段保留读取容忍，非删除数据——docs/16 §2.2.10-4③ 已加注记，豁免口径由 C 阶段确认书显式背书|设计侧不能单方面改需求豁免（口径回流权威输入纪律）；保守双写会引入语义分叉（MB-02 已弃）|C 若不背书，回退方案=双写过渡一个版本|
|MB-36|意见16（low）|成本估算未覆盖 advisory（默认开、每开奖日一次 LLM）与学习摄入——周预算占比显示偏低，用户可能在估算未触顶时撞预警（BC-107 覆盖面缺口）|仅出号 / 补全活动面|补全：costEstimate = 出号 + advisory（enabled×每开奖日）+ learning（若纳入，每文件粗估），同 chars/4 口径并标注估算；§2.2.7-2/§4.2 同步|BC-107「任何影响 token 消耗的配置」明文要求覆盖全部活动面|learning 项仅在 C 纳入学习半环时生效|

**v1.0.1 补充实测记录**（DSH runtime node，本会话执行）：`retryIntervalMs({push:{retryMinutes:7}}) → 420000 ok`、`retryIntervalMs({push:{retryMinutes:undefined}}) → 300000 ok`（shim 等价性）；力度四档三元组两两比较 `dup=0 ok`（互异性）。
