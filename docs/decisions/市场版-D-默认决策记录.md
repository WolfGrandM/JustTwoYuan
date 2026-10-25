# 市场版 D 阶段（实施）默认决策记录

依据 docs/17 §6-8 无人值守纪律登记。表格列：编号 | 事项/问题 | 候选项 | 采用的默认值 | 选择理由 | 影响与后续可改点。

|编号|事项/问题|候选项|采用的默认值|选择理由|影响与后续可改点|
|-|-|-|-|-|-|
|MD-01|validateConfig/配置模板/configStamp 的落盘文件|新建 lib/config.js vs 并入 scheduler.js|新建 **lib/config.js**（CONFIG_DEFAULTS v2 模板、validateConfig、readConfig 读兼容换算、modeOf、buildConfigStamp、maskConfig）|三入口（面板/CLI/配置文件）共用一份校验（FR-1020/S-113）；scheduler 保持瘦；首写模板由 index.js 引用同源常量，杜绝模板与校验两处漂移|文件位置为实现细节；上游仅约束「三入口共用一份」|
|MD-02|token 计量与成本估算的落盘文件|并入 events.js vs 新建|新建 **lib/usage.js**（usage tracker + 降档链 + costEstimate）|计量与事件层职责不同；独立纯函数模块便于单测|同上|
|MD-03|事件层重试的驱动方式|emit 内自旋定时器 vs 调度器 tick 驱动 pump()|**emit 即首试 + bus.pump() 由调度器每 30s tick 驱动续试**|复用 v1「tick 驱动 + interval 判定」姿势（scheduler.js:491-514 同构）；避免事件层自带 setInterval 造成双写者与测试困难；FR-005 间隔语义由 pump 内 retryIntervalMs 判定保证|pump 频率=30s tick，重试间隔仍由 retryMinutes 控制（≥5min），语义等价|
|MD-04|drawstore 的网络依赖注入|直连 fetch-draws vs 工厂注入|**createDrawStore({ dataDir, fetch }) 工厂注入**（默认 fetch = fetch-draws 的 {fetchHistory, fetchLatestDraw}）|AC-115「二次请求网络计数=0」需要 mock fetch 计数；T3 验证计划明列 mock fetch|接口形状实现细节|
|MD-05|client.js（非 ESM、window.__ModuleLoader__ 工厂形态）的可测性|直接 import vs 读文件+假 loader eval|**测试读 lib/client.js 源码 + 注入假 window.__ModuleLoader__ 捕获 factory，再以假 require（假 react/react-dom 记录调用序列）驱动**（MC-16 ②微桩方案）|client.js 是浏览器工厂脚本不能被 node ESM import；MC-16 明确本机无 react/react-dom，组件级单测不可执行|React 渲染壳标注「未跑待主人上机」（MC-16 ③）|
|MD-06|configStamp 内容格式（docs/16 §5.2「内容格式 D 定，推荐含策略师数量与配置版本号摘要」）|仅策略师数 vs 仅版本摘要 vs 两者拼接|**`v2:s<strategists>:<摘要8位hex>`**，摘要 = 稳定字符串化（tier/effort/verbosity/budget.weeklyCap/roles/prompts 键集）后 FNV-1a 32bit 取 hex 前 8 位|含推荐双要素（数量+配置版本摘要）；纯函数可单测；不含凭证明文|格式为档案可读性服务，第二波若需扩展只加不改|
|MD-07|渠道侧车文件缺失/坏 JSON 的读取行为|报错 vs 容忍为空|**容忍为空对象**（凭证未配置时渠道 test 报「凭证缺失」，加载不崩）|S-112 缺适配器/缺凭证均不崩溃；缺文件≠致命|—|
|MD-08|deadlineForKind 对 advice/heartbeat 的扩展映射|改 scheduler.js 原函数 vs events.js 内包装|**events.js 内 kindDeadline() 包装**：predict/result/apology 直用 deadlineForKind（零修改复用），advice/heartbeat → '12:00'（次日语义由 isPastDeadline 跨天判定承担）|scheduler.js 纯函数逐字不动（冻结纪律）；docs/16 §2.2.1-2「kind 扩展映射」未要求改原函数|—|
|MD-09|classifyHostError 模式表初值（docs/16 §2.2.2-7「初始含关键词」vs R6「表初值为空」两句并存）|空表（全走 other）vs 保守种子表|**保守种子表 + config.classify.noModelPatterns 可覆盖**：['no model','model not configured','model not found','no available model','未配置模型','没有配置模型','未配置可用的模型']|FR-1022/S-117 要求无模型时给出配置指引——空表使该需求在 D 期完全失效；保守关键词不会误伤普通网络错误；未命中仍走 other 原语义（不劣于现状，R6 缓解措施保留）|D 本机实测校准后可改 config 覆盖；主人可清空列表回到「空表」口径|
|MD-10|scheduler 对 emit 后 pushedAt/pushErr 的回填时机|事件层全权回写 state vs emit 返回值快照|**emit() 返回事件对象，调度器按首试结果快照回填 st.pushedAt/st.pushErr；后续重试状态以 /api/events 为准**|避免事件层反向写 state.json（单写者约定 §2.2.1 非功能②）；面板兼容读既有字段|—|
|MD-11|status 路由的渠道探测频率（channels[].status 需 adapter.test 网络调用）|每次 status 实时探测 vs 30s 缓存|**30s TTL 缓存**（面板轮询周期同值，探测开销与 v1 napcatAlive 探测等量级）|v1 status 每次轮询探一次 NapCat（index.js:113 同姿势）；渠道多时缓存防放大|缓存 TTL 可配置化留第二波|
|MD-12|hygiene 扫描对 migrate-v2 必然出现的 v1 字段名（napcatHttp 等）的处理|改名访问（字符串拼接）vs 行级白名单标记|**行级白名单标记 `/* koi-hygiene-allow */`**：迁移代码必须引用 v1 字段名才能搬家，属已知安全语境；扫描器对带标记行豁免并在报告中列出|字符串拼接规避会伤可读性且欺骗扫描器语义；白名单行随报告透明可见（AC-102「报告逐条列出人工复核」）|—|
|MD-13|react-dom 解析对 dsh.client.inject 的依赖（R1 未验证项）|补 @deepseek-ai/dsh-client-runtime 条目 vs 保持 [] + 降级兜底|**保持 inject: []**，mountPet 分级降级第一级必做（容器静默移除 + panel 渠道与事件链路不受影响）|本机与 DSH runtime 均无 dsh-client-modules 实体（阶段C 实测 + 本阶段复核），补条目的包名属猜测、无法静态验证；docs/16 R1「即便失败——降级第一级保证通知不丢」|主人上机冒烟（AC-109）若确认需要，补条目属加法零风险|
|MD-14|emit 立即送全渠道 vs 先落盘再送|docs/16 §3.1 序列图已定：落盘 pending → 逐渠道 send → 更新状态|同左（照设计实施，非新决策，登记以示确认）|—|—|
|MD-15|p3 多单元档（×3/×5）重复单元的校验|允许重号（真实投注可买重号）vs 拒绝|**拒绝重复单元**（与「蓝双选两单元蓝值相同 → 校验拒绝」同款规则风格，docs/16 §4.1 边界条款）|档位语义=分散投注；AI 产出重复单元视为低质量产出打回；用户真要买重号可手动|如需放开改 validateTierPicks 一处|
|MD-16|M3 满配投影的估算公式（docs/16 §2.2.7-2 未给数值公式）|每策略师 1 次提案×权重 + 互评轮|**M3 满配 = 出号单次成本 × (Σstrategist 权重 + 1 互评轮 × Σ权重) + 数据官/质询者/主持人各 1 次基线调用**，即倍率 = 2×Σweights + 3；标注「随 M3 编排器生效」「估算值」|缺上游数值定值，按 docs/11 编排结构保守取整；公式集中于 usage.js 一处便于第二波校准|公式常量可配|
|MD-17|costEstimate 的 dataPackChars 空库估计值（§4.2「空库时按 30 期×平均行宽估」）|实测本地库 vs 常数表|**本地库 ≥10 期实测 dataPack 长度；不足用常数表 {ssq: 2200, dlt: 2600, p3: 800} 字符**|可测、可解释；面板标注「估算值」|常数表在 usage.js 顶部集中定义|
|MD-18|migrate-v2 的周预算写入值|不写（沿用代码默认 150 万）vs 写 1000 万|**写 budget.weeklyCap = 10,000,000（--weekly-cap 可覆盖）**|docs/16 §2.2.10-4「作者实例预算改 1000 万/周为配置值非代码默认」——迁移是唯一写入时机；v1 配置无 budget 字段|迁移场景特有；市场新用户不受影响|
|MD-19|migrate-v2 幂等键与 repushQueue 搬家的去重|时间戳 vs 业务键|**业务键 kind\|game\|issue**（与 enqueueRepush 同键语义）：事件存储已含同键 queued 事件则跳过；迁入事件标 `migrated:true`|幂等重跑无 diff（T10 验收）需要确定性去重|—|
|MD-20|backbone POST（近期窗口拉取）的范围|全彩种各拉 historyCount（默认 30）vs 可指定|**POST {game?} 可选；缺省对三彩种各执行 ensureRecent(historyCount)**|向导第 5 步 = 数据就绪检查（MC-03）；30 期即出号所需窗口|全量回拉随第二波扩展（MC-03）|
|MD-21|ui-logic 与 client.js 的同源性|client 内联副本 vs 仅 ui-logic|**lib/ui-logic.js 为权威纯函数模块（node --test 直测）；client.js 工厂内导出同名内联副本，market-ui 测试断言两实现行为等价**（门控缺失清单/未读游标/降级判定抽样对照）|client.js 是非 ESM 浏览器工厂无法 import ESM；等价断言防止两份漂移|—|
|MD-22|token-usage 自然周归档的保留窗口|不保留 vs 保留近 N 周|**归档 archived 保留近 4 周**（第 5 周丢弃）|「归档滚动」语义需要落点；4 周足够周对账自查（docs/16 §2.2.7-2「周对账提示」）|保留窗口可配|
|MD-23|降档链数值语义（BC-013 市场版链的精确阈值行为）|docs/15 只给 70%/90%/100% 三档|**ratio<0.7 原档；0.7–0.9 预警事件（effort 不动）；0.9–1.0 effort 降一档（turbo→standard→economy→follow-host）；≥1.0 follow-host + allowLLM=false（兜底档出号零 LLM）+ learning/advisory 暂停**|链路单调、每级只做一件事；预警与降档分离与 BC-013「70%/90% 预警 → 逐级降档 → 兜底档收口」一致|阈值继承 config.budget.warn1/warn2|
|MD-24|市场版用户文档落点|docs/ 下新文档 vs 插件包 README.md|**plugins/dsh-koi/README.md（包内用户文档，随包分发）**；docs/ 不新增（docs/ 为流水线内部材料）|交付物「市场版用户文档」面向市场用户，随包走；package.json files 已含 README.md；hygiene 扫描覆盖之|—|
|MD-25|settle --push 手工补账的事件化|CLI 内直接构造事件总线 emit|**CLI 构造一次性事件总线（与宿主同一 events.json/渠道层）emit kind='result'**|docs/10 §5.6 ⚠M「settle --push 改经事件层 emit result 事件」|—|

## 实施期补充决策（MD-26 起，随任务推进逐条登记）

|编号|事项/问题|候选|采用的默认值|理由|影响与后续可改点|
|-|-|-|-|-|-|
|MD-26|/api/config POST 的 patch 形状|整段嵌套对象 vs 点路径扁平键|**点路径扁平键**（如 `{"modes.p3.tier":"p3-x5"}`，深合并、数组整替）|嵌套整段 merge 会静默丢兄弟键；点路径与 CLI `config set a.b.c` 同构；单字段写回最小化|index.js applyPatch + koi.mjs setPath 两处同实现|
|MD-27|hygiene 的「代码内 QQ 默认值」检测口径|通用 5–11 位数字启发式 vs 已知号清单|**已知作者号清单**（1017099872/983605373）|通用启发式会误伤期号夹具（'2026121' 等）与端口/zIndex；A2.1 V11 的实证口径也是具体号|清单集中在 hygiene.mjs 顶部|
|MD-28|调度器可测性注入|改相位机加钩子 vs 加法参数|**startKoiScheduler 新增可选 now/fetch 参数**（默认真实时钟/真实官方源），测试全离线驱动 tick 全流程|加法参数零运行时差异；FZ-5 相位机逐字不动（已对照 git HEAD 逐字校验通过）|—|
|MD-29|fetch-draws.mjs 分页参数化（docs/16 §2.1.2 列项）|本轮做 vs 随第二波|**不做，随第二波 backfill 一并交付**|分页参数化的唯一消费方是全量回拉底座（MC-03 移交第二波）；近期窗口按需拉取用现有 count 参数即够；两官方源 URL 与头保持逐字不变（BC-104）|drawstore.js 尾部已留接缝注释|
|MD-30|向导档位下拉的数据源|客户端硬编码档表 vs status 加法字段|**status 增 tierTable 字段**（FZ-6 加法；每彩种全档 {id,label,bets,cost}）|档表是服务端 tiers.js 单一事实源，硬编码会漂移|—|
|MD-31|migrate-v2 对作者 auto 彩种的门控字段写入|要求作者重走向导 vs 迁移即满足|**迁移直接写 gates.honestyAck=true + wizardDone=true**|MA-21「既有运行语义保持」：作者 v1 本就在跑 auto，迁移后立即被门控挡住=语义重置；诚实条款作者早已确认（docs/12 BC-001 既有拍板链）|仅迁移路径；市场新用户仍须走完向导|
|MD-32|advisory 交卷等待上限的可测性|固定 90s vs 工厂参数|**createAdvisory 增 waitMs/pollMs 可选参数**（默认 90s/3s 不变）|交卷超时路径的测试不必真等 90s|—|
|MD-33|CLI mode/config 写路径的实现|复用调度器闭包 vs 同一份纯函数重建|**koi.mjs 内以同一份 validateConfig/checkGates/loadAdapters 组装等价路径**（FR-1020「三入口等价」）|setMode 闭包在 startKoiScheduler 内不可复用；校验/门控/渠道判定全部同源函数，无平行规则|行为等价已由 market-migrate 测试钉住|
|MD-34|本机静态确认（R1/W11）：dsh-client-modules 与 react-dom 实体|—|**实测确认本机与 DSH runtime 均无 dsh-client-modules / dsh-web-app / 任何 node_modules**（find ~/.dsh 与工作区空）——react-dom 解析行为无法本地静态验证，维持 inject:[] + 降级第一级兜底（MD-13）|与阶段B/C 实测一致；AC-109 渲染面标注「未跑待主人上机」|主人上机冒烟若需补 inject 条目属加法|
|MD-35|实施中新测试文件命名|R9 纪律|**market-*.test.mjs**（tiers/drawstore/config/events/render/scheduler/advisory/index/ui/migrate 共 10 个新文件）|与既有四文件夹具零冲突（R9 缓解）|—|
|MD-36|修复轮（验收门第 1 轮退回）：market-migrate 测试的包路径锚定|cwd 相对解析 vs 测试文件自身位置|**改锚 import.meta.url**（TEST_DIR = 测试文件目录，PKG_ROOT = tests 上一级）——首轮实现用 path.resolve('tools/koi.mjs') 在 plugins/dsh-koi 目录运行时通过、在仓库根目录（流水线验收门的实际 cwd）运行时解析到 D:/QQ工作区/tools/koi.mjs 报 MODULE_NOT_FOUND|验收门命令（docs/17 §5.3-4）从仓库根目录以 glob 路径运行，测试必须与 cwd 无关；修复后两种 cwd（仓库根 / 插件目录）实测均 143 pass / 0 fail|其余测试文件经 grep 复核无 cwd 相对解析|

## 体验反馈修正（2026-10-25，主人实机体验后直接拍板，AI 执行）

| # | 反馈 | 修复 | 落点 |
|---|------|------|------|
| TF-1 | 所有彩种缺 2 元基础档；默认推荐不是 2 元档 | 档位表新增 `ssq-d6b1`（单式 6+1，1 注/2 元）与 `dlt-f5b2`（单式 5+2，1 注/2 元），置于各彩种档位表首位；`defaultTierFor` 三彩种全部指向 2 元档（p3-x1 本就是）；主人本地实例配置同步切换 | lib/tiers.js、tests/market-tiers/config/index 断言更新（143/143 全绿） |
| TF-2 | 桌宠关不掉（× 只写配置不卸载，重启也不消失） | 关闭环修复：启动时读 `pet.enabled`（false 不挂载）；× = 持久化 + **立即卸载**；设置→彩票 新增「桌宠」开关（重新开启即时挂载） | lib/client.js（apply/KoiPet/ConfigPanel）、lib/index.js（status 暴露 pet 字段） |
| TF-3 | 通知气泡黑底黑字不可读 | 桌宠浮层配色**自持**（深色卡片 rgba(24,26,34,.97) + 浅色文字 #e8eaf0），不再依赖宿主 `--dsw-alias-*` CSS 变量（浮层挂在文档根部拿不到这些变量——黑字的真因） | lib/client.js CSS |

## 体验反馈修正·第二轮（2026-10-25，主人实机体验，AI 执行）

| # | 反馈 | 根因 | 修复 |
|---|------|------|------|
| TF-4 | 点「测试通知」后桌宠出现「⚠️ 锦鲤告警」，吓人且不合理 | 测试事件在事件层错用 `kind:'alert'`（EVENT_KINDS 无独立 test 类别） | 测试事件改 `kind:'test'`（EVENT_KINDS 扩充 + 桌宠气泡/列表标题映射「测试通知」）；真实故障告警语义不变（不稀释） |
| TF-5 | 有未读时点开查看、收起后红点仍是 2 | 「标记已读」两个写入陷阱：①`lastId` 为空时把字符串 `"null"` 写入 localStorage，此后永远匹配不到事件 id（未读恒=全部条数）；②收起动作无兜底标记 | readLastRead/writeLastRead 防毒（null 不写、读时过滤 "null"）；markRead 统一 helper（空值兜底取最后一条事件 id）；打开与收起都标记已读 |
