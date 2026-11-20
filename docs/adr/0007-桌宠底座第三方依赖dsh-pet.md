# ADR-0007 桌宠底座：第三方依赖 dsh-pet（PC2005-cloud）

- 状态：已采纳（主人 2026-11-17 拍板路线 A，docs/decisions/主人拍板记录.md P8；装件实施另行授权，执行单归 docs/29）
- 日期：2026-11-17
- 修订 v1.1（2026-11-17，设计复核处置）：撤销 §6-2「定时投喂」——它与 §7 TF-6 红线在 ADR 内部自相矛盾，且「既有定时点」经实查零代码载体；集成深度收窄为**仅战果播报（won=true）**，详见 §6-2 注记
- 修订 v1.1a（2026-11-18，修订员复核校准）：§6-2 注记② 的 EVENT_KINDS 计数加实查日期限定——M4 实施后 events.js:20 已增 review（第九种），其仍非定时投喂内容源，撤销结论不变
- 修订 v1.2（2026-11-19，拍板 P13 = docs/31 §3 #4/#7）：**TF-6 红线第二次显式豁免**——桥接触发白名单由「唯一 `won===true`」扩为「won 战果 + near-miss 战果（仅 p3/3d，两档预注册）+ 停购倒计时（待第三批）」，白名单全文见文末附注「TF-6 豁免白名单」节；§7「唯一触发」表述自本修订起按白名单口径读。实施载体 = docs/31 第一批工作流（本附注为授权记录，非实施完成）
- 修订 v1.3（2026-11-20，docs/31 §6 第二批实施回填）：白名单 ② near-miss 战果的**实现生效面**随福彩 3D 彩种实装由 p3 单彩种扩至 **p3/3d 全量生效**（lib/draws.js `judgeNearMiss` 生效门单点扩展，判据/文案/频率护栏零变化）——白名单 ② 行范围原文（仅 p3/3d）自 v1.2 起未变，本次为实施状态附注同步而非新扩面（「不得静默扩面」纪律不受影响；范围以白名单节原文为准）。第一批实施状态一并回填，见文末附注

## 背景

docs/26 调研定论：锦鲤桌宠四项需求（中奖播报/倒计时/特效/换肤）在 dsh-pet（PC2005-cloud 的 npm 插件，MIT）上全部有现成承载——播报=`/broadcast`（外部文本投喂不生成）、特效=`/anim` 点播、换肤=pet pack 管线、倒计时=`/broadcast` 定时投喂（docs/26 §2.4、§4；⚠「倒计时=定时投喂」这一承载经修订 v1.1 撤销，见 §6-2 注记——四项需求里的倒计时仍在，其承载方式待主人拍板定义内容源后再议）。主人拍板路线 A：安装 dsh-pet 作桌宠底座 + 锦鲤作内容提供方经其 HTTP/Cordis 接口驱动；koi 简易气泡保留为未装时的降级显示（拍板记录 P8）。

本 ADR 是**市场版零依赖纪律的例外入档**（docs/26 §5「市场版零依赖纪律的例外需 ADR」；docs/20 §7.1-3 Gate 1「新增 npm 依赖必须说明理由」）。同时收口 2026-10-24 遗留的「桌面 harness 与服务器实例的事件路径 A/B/C/D 未决问题」（docs/27 §F3；原始记录未在本轮可读文档中找到，仅 docs/27:35 一句提及——本轮按任务书给定选项框架，以上游文档实码证据重新定论）。

**证据边界（如实声明）**：本地副本 `桌宠调研/dsh-pet-src/` 实况 = 上游全量文档（README/API/CORDIS/CORDIS-API/INSTALL/CONFIG/FEATURES/MAKE-YOUR-OWN-PET/LICENSE）+ .agents skills + .github workflows + assets 截图，**不含 package.json 与 src 源码**（代码在 `dsh-pet/` 子目录，README.md:297-313 载明结构、副本未收录）。本轮「实读」= 实读上述接口契约/安装/配置文档；`package.json` 的 `dsh`/`engines` 字段**未实查**，列为装件时必查项（见决策 3）。本轮纪律零 npm（docs/27 §2），上游最新版号未实查。

## 候选方案

| 路线 | 内容 | 取舍 |
| --- | --- | --- |
| A | 安装 dsh-pet 作桌宠底座 + koi 经 HTTP/Cordis 接口驱动（播报/特效/换肤/定时投喂**能力**全现成——能力面指上游支持；koi 侧对接深度见决策 6，定时投喂经修订 v1.1 撤销） | 零自研框架；代价=引入第三方依赖，须版本锁定与供应链纪律——**采纳** |
| B | 参照 dsh-pet 模式自研锦鲤专属桌宠 | 成本高一个量级（docs/26:116），仅当上游停更或深度定制需求出现时再议——不选 |
| C | 维持现状（koi 简易气泡够用） | 四项桌宠需求（换肤/倒计时/特效/形象化播报）无承载（docs/26 §6-1）——不选 |

## 决策

### 1. 决策内容（路线 A 落定）

1. **dsh-pet 作为桌宠底座**：动画/物理/多形态渲染/碎碎念/睡觉/pet pack 全部复用上游，koi **不自建任何桌宠框架代码**。
2. **koi 作为内容提供方**：仅经 dsh-pet 对外接口投喂内容（战果播报文本、奖级动画点播；「定时投喂文本」经修订 v1.1 撤销，见 §6-2 注记），不反向依赖 dsh-pet 内部实现。
3. **桥接是渲染增强，不是通知义务承担者**：事件层（koi/events.json）与渠道适配器（ADR-0003）仍是唯一事实源与送达语义承担者；桥接投喂失败（dsh-pet 未装/未启用/端口不在）一律**静默跳过并记日志**，不影响事件状态机、补发队列与心跳判定。
4. **koi 简易气泡保留**：client.js 的 koi-pet React root（lib/client.js:2,26-66）+ 内置 panel 渠道（lib/channels/builtin/panel.js:8-10「send=标记面板可见」）原样不动，作为未装 dsh-pet 时的降级显示。

### 2. 事件桥接路径定论（A/B/C/D 收口，本 ADR 核心）

**先决事实**（上游文档实读）：
- dsh-pet 的 HTTP 接口由其**宿主半侧向 DSH 自己的 Web 服务注册一条前缀路由** `/dsh-pet-7340`，浏览器端、桌面端、设置页与第三方插件访问同一份实现；基址 `http://127.0.0.1:<port>/dsh-pet-7340`，`<port>` 为该 DSH 实例 Web 服务监听端口；**只监听 127.0.0.1、无鉴权**（桌宠调研/dsh-pet-src/API.md:3-8）。
- Cordis 服务 `petApi7340` 同名两半、分属不同容器、**互不可见**：客户端半侧（web 页面内）只有 `pose/progress/getState/menuEvents` 四个只读成员；宿主半侧（宿主插件进程内）只有 `balance/voice/speech/memory` 四组注册槽（CORDIS.md:3-15、122-127；CORDIS-API.md:13-33）。**两个服务都不提供控制通道；让它说话、做动作、改配置仍走 HTTP**（CORDIS-API.md:8）。
- `/broadcast`（第三方投喂）与 `/anim`（点播动画）均为**需锁接口**：须先 `POST /lock` 取 lockId，调用带 `?lock=<lockId>`；编号不对回 `lock-lost`；用户拖拽/隐藏立即撤锁=用户优先（API.md:27,33-41,48,62）。
- 安装按 profile 隔离：`dsh plugin --profile web add dsh-pet` 装 `dsh web` 实例、`--profile desktop` 装桌面 Electron 实例，装进各自 profile 的 node_modules（README.md:37；INSTALL.md:5,28-41）。
- 服务器 headless（Linux 无 DISPLAY）自动跳过桌面透明窗，浏览器 overlay 不受影响（README.md:88）——作者生产实例（服务器，docs/20 §4）的渲染面=浏览器 overlay。

**选项裁决**：

| 选项 | 机制 | 实码证据 | 裁决 |
| --- | --- | --- | --- |
| A 同实例 Cordis 直调 | koi 宿主进程 `ctx.get('petApi7340')` 直调播报 | CORDIS-API.md:8 两服务均无控制通道；宿主半侧成员仅 balance/voice/speech/memory 注册槽（CORDIS-API.md:26-33）——**没有 broadcast/say/anim 成员** | ✗ 机制上无法承载播报；只能用于注册余额/语音服务商（非本需求） |
| B 跨实例 HTTP broadcast | 桌宠装桌面 harness（desktop profile），koi（服务器实例）跨机调桌面机回环地址 | API.md:8 只监听 127.0.0.1——跨机不可达；docs/10:186 FZ-4 口径「端口绝不出回环」；桌面 harness 非 7×24（docs/16 §2.2.11-3 BC-110） | ✗ 网络不可达 + 违反 FZ-4 围栏精神 + 端不常开 |
| C 桌面端轮询 /state | 桌面端轮询 dsh-pet 状态取 koi 战果 | /state 是 dsh-pet **所在实例**的状态出口（API.md:136）；桌宠装桌面实例时其 /state 里没有服务器实例的 koi 事件（事件不跨实例汇聚）；轮询是渲染端消费 state 的模式（API.md:152-156），不是投喂通道 | ✗ 事件源与状态源不同实例，无物可轮；方向反了 |
| **D 桌宠装 koi 所在实例（服务器 web profile）+ koi 宿主进程回环 HTTP 调 `/broadcast`/`/anim`** | 同机同实例，回环调用 | API.md:3-4 宿主半侧向 DSH Web 服务注册路由、第三方插件访问同一份实现；API.md:7 基址=本机回环；README.md:73「通道一 HTTP：**跨进程、脚本可直接调**」；INSTALL.md:28-41 `--profile web` 装法；koi 已有同型回环调用先例（NapCat 127.0.0.1:3000 + assertLoopback，FZ-4，docs/10:37） | **✓ 唯一可行——采纳** |

**定论**：
1. **桌宠装 koi 所在实例**（作者生产=服务器 web profile；桌面 harness 若另装 dsh-pet，属本地装饰性实例，不在桥接范围——它收不到服务器实例的 koi 事件）。
2. **koi 战果事件（服务器实例产生）→ 同实例回环 HTTP**：`POST /dsh-pet-7340/lock` 取锁 → `POST /dsh-pet-7340/broadcast?pet=<id>&lock=<lockId>` 投喂文本（可带图/时长/动画联动，API.md:48）→ 短窗口内释放锁。`/anim` 特效点播同锁窗口。
3. **锁纪律**：取锁→投喂→释放尽量短（锁占用期桌宠全静止让路，API.md:30）；`lock-lost` 按 cause 处理不重试抢占（API.md:33-41）；不注册常驻长锁。
4. **备选升级路径**：上游若在宿主半侧 Cordis 开放控制类成员或提供跨实例事件汇聚，可改进程内直调/事件订阅——上游新能力出现时再议，本轮不预设。
5. 装件待实测项（docs/29）：DSH Web 端口获取方式；无端在线时 broadcast 写入 state 的气泡对后连端是否补渲染（写 state 链路见 API.md:150-156；dsh-pet 待办「等有端连上再补」模式见 FEATURES.md:49，broadcast 是否同型未在文档中明确）。

### 3. 版本锁定

1. **装件时实查回填**：装件执行单（docs/29）以 `npm view dsh-pet version` 实查当天最新版，**pin 精确版本**并回填本 ADR 文末附注（本轮纪律禁 npm，版号未实查——docs/27 §2）。
2. **engines 必查**：上游声明与服务器 dsh 0.2.1-rc.2（docs/20:114）的兼容性以装件时实查为准——已知上游开发/测试基线为 dsh **0.2.2-rc.1**（INSTALL.md:43「建议使用相同版本」），与服务器版本存在 0.2.2 vs 0.2.1 差口，若 engines 不匹配：先桌面 harness 实测或经主人授权升级服务器 dsh，**不得带病装件**。
3. **升级纪律**：手动升级（禁自动）；每次升级先审上游 CHANGELOG 与 README「反馈与发版节奏」小节（小修累计发版，「main 已修 ≠ 已装版包含」，README.md:324）；**灰度先行**——服务器实例先升级观察一个完整开奖周期再跟进其余环境。
4. pet pack 锦鲤形象（换肤）走 MAKE-YOUR-OWN-PET 管线，属素材工作（主人工作量，docs/26 §6-2 未拍板），不受本版本锁定约束。

### 4. 供应链风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 依赖树不透明 | 副本无 package.json，本轮无法预审（如实声明）。装件时实查 `npm view dsh-pet dependencies` 与安装后 profile node_modules 新增包清单，写入 docs/29 装件报告 |
| install scripts（postinstall 类） | 装件时 `npm view dsh-pet scripts` 实查；已知运行期行为=宿主自动下载 Electron 到 `~/.dsh/electron`（INSTALL.md:127-133，npmmirror 镜像）——**运行时下载外部二进制本身列为审计点**：服务器 headless 理论跳过桌面窗（README.md:88），装件后核对 `~/.dsh/electron` 是否被创建及下载来源，异常即停 |
| 进入锦鲤市场包 | **dsh-pet 不进锦鲤市场包**：koi `files[]` 白名单物理排除（lib/tools/cordis.patch.yml/README.md/tests，package.json:28-34；docs/16:262 同口径）；koi 保持零 npm dependencies（package.json 实查无 dependencies 段），dsh-pet 经 `dsh plugin add` 装入 profile，**不是 koi 的 npm 依赖**；hygiene 门审计面仅覆盖 koi 包目录（tools/hygiene.mjs:39-70,73），第三方包未经该审计面，更不得随包分发（同 D-005「模板放文档杜绝误打包」的更强形态，docs/16:35） |
| 装件越权 | 装件实施（npm 安装+重启 harness）**不进本轮**，待主人另行授权后由 docs/29 执行单承载（拍板记录 P8 执行边界） |
| 上游停更 | 退出三梯级：①关 koi 桥接配置——事件层/panel 渠道/简易气泡零受影响，功能无损回退（决策 5 回退条款）；②冻结最后可用版本 pin 不升级，本地副本（桌宠调研/dsh-pet-src 全量文档）+ npm cache 留档可复装；③确需框架级自研才启动路线 B（成本高一个量级，docs/26:116）——不预设 |

### 5. 市场包边界 = 推荐搭配插件，不强制捆绑

dsh-pet 对锦鲤市场用户是**推荐搭配插件**（文档推荐 + 装件指引，不随包分发、不自动安装、不声明为 npm 依赖）。技术前提：koi 桥接对 dsh-pet 缺装**零硬依赖**——未装时桥接静默跳过，koi 全功能照常。⚠ 该条为拍板默认值，**待主人微调**（docs/26 §6-4：推荐搭配 vs 声明为增强依赖，未拍板）。

### 6. 集成深度默认

**仅战果播报（won=true）**（P8:67 原默认推荐为「战果播报 + 定时投喂」两类，「定时投喂」经修订 v1.1 撤销——撤销理由与恢复条件见第 2 条注记；**待主人微调**，docs/26 §6-3）：
1. **战果播报**：`kind==='result'` 且 `won===true` 的事件（won 标记仅 result 携带，lib/events.js:141；emit 点 lib/scheduler.js:392）→ 桥接取事件正文投 `/broadcast`（文本=事件 body 或其摘录，配图/奖级动画可后续配置）。
2. **定时投喂（修订 v1.1 撤销，留档待拍板）**：原推荐「koi 调度器既有定时点（如停购倒计时/每日播报）→ `/broadcast` 投喂」撤销，三条理由——①**与 §7 红线自相矛盾**：定时投喂内容（倒计时/播报）是非中奖内容，把它投上气泡即违反 §7「非中奖事件不上任何气泡、桥接触发唯一 `won===true`」（TF-6 拍板），红线不能在 ADR 内部自破；②**「既有定时点」零代码载体**：实查 `grep -rnE "倒计时|countdown|每日播报|停购" plugins/dsh-koi --include=*.js` 零命中（2026-11-17 执行，exit 1），EVENT_KINDS 八种（lib/events.js:20，2026-11-17 实查；M4 实施后增 review 为第九种，仍无一为定时投喂内容源——修订 v1.1a 校准）——所谓「既有定时点」在代码中不存在；③**内容源/频率/上限完全未定义**，按原文本无法落码。若主人仍要定时投喂（如停购倒计时），须先拍板三件事：内容源（哪个既有事件或新增定时器）、频率与每日上限、豁免声明——然后以**白名单例外**形式修订本 ADR 附注与 docs/28 口径（显式写明「该类内容豁免 §7 红线」）后才可实施，**不得静默恢复**。
3. 其余事件类别（predict/quickpick/apology/alert/advice/heartbeat/test，lib/events.js:20）不投桌宠；扩展对接深度须主人拍板后改本 ADR 附注，不得静默扩面。

### 7. 与 TF-6 通知收敛的一致性

非中奖事件**静默进事件列表与档案，不上任何气泡**（TF-6 通知收敛拍板，docs/27:22；ADR-0003 决策 4「桌宠红点/冒泡/面板未读只统计中奖战果 won===true」）。因此：桥接触发条件**唯一**为 `won===true`（§6-2 原列的「定时投喂」正因违反本条而撤销，见该条注记）；且桥接**不注册为事件渠道适配器**——渠道适配器会接收全部事件且纳入心跳判定口径（「当日应有事件在全部启用渠道均无送达→红标」，lib/events.js:36-46），只认 won 的渠道进入渠道目录会污染心跳语义。桥接实现为 emit 后旁路钩子（不进渠道目录、不参与送达记录与心跳判定）——此为 ADR 级红线，实现形态细节归 docs/29。

### 8. 后果与回退

- **正面**：四项桌宠需求零自研落地；锦鲤专注内容供给；渲染物理/多形态/headless 降级全部复用上游成熟实现（docs/26 §2.2）。
- **代价/风险**：首个第三方 npm 依赖入档（零依赖纪律破例）；上游停更/接口变更需跟随；渲染面依赖「有端连着 web UI」（服务器 headless 时桌宠只在浏览器 overlay 可见，docs/26 §5）；`/broadcast`/`/anim` 需锁带来的短时桌宠静止。
- **回退（三级，全不触碰冻结区 FZ-1~7）**：①koi 配置关桥接开关（默认 off——装件前 koi 零行为变化）；②`dsh plugin remove` 卸载 dsh-pet，koi 简易气泡（client.js koi-pet + panel 渠道，panel.js:8-10）自动恢复原状——panel 渠道独立工作，事件层语义零改动；③上游停更走决策 4 退出三梯级。卸载遗留 `$DSH_HOME/dsh-pet/` 用户数据（main-config.jsonc、todos.json 等，CONFIG.md:36,40）为主人手动清理项。
- **验收口径**：桥接上线后，关桥接/卸载 dsh-pet 两种状态下全量测试绿 + 事件层行为逐位不变；开桥接时非中奖事件零投喂（TF-6 红线）。

## 附注（装件实测回填，2026-11-18 00:38–01:00，docs/29 §3 执行单）

- **锁定版本**：npm 实查最新 `0.4.9`，`dsh plugin --profile web add dsh-pet@0.4.9` 精确 pin 落装（`dsh plugin list` 回读 `dsh-pet@0.4.9` ✓）
- **engines 实查值**：`{ node: '>=22.12.0' }`——**无 dsh 版本约束**（§3-2 预担心的 0.2.2-rc.1 差口不存在）；服务器 node v24.21.0 满足 → 兼容 ✓
- **依赖树审计**：zod 4.6.7 / openai 7.39.0 / @anthropic-ai/sdk 0.135.0 / @electron/get ^5.1.0 / @andresaya/edge-tts ^1.9.1 / @electron-internal/extract-zip——均为常规公开包，无异常
- **scripts 审计**：**无 postinstall/preinstall 类钩子** ✓（全部为 dist/lint/test/build/prepack/release 等开发构建脚本）
- **`~/.dsh/electron`**：服务器**未创建** ✓（headless 未触发 Electron 下载，步骤 5-3 核对记录）
- **实测 API 形态（0.4.9，与本地 API.md 副本有差——副本滞后）**：lock/broadcast 的 `pet` 与 `surface` 均为 **query 必填**（surface 枚举 web/desktop/both/any，API.md 副本未载此字段）；lock 必须携带 JSON body（空 `{}` 即可，缺 body 回 `invalid-json`）；release 的 `lockId` 在 JSON body（query 不认）；lockId 响应为顶层字段。桥接代码已按实测适配（commit `83f4b2f`，测试桩同形，338/338 绿）
- **回环 API 冒烟**：lock→broadcast→release 三连全 `{"ok":true}`（lockId lk-mwl1j0e2-2，broadcast 文本「锦鲤桥接冒烟」成功投喂 state 气泡链路）；`/state` 返回真实 JSON（余额板块 deepseek-official ¥50.32 在跑）
- **CHANGELOG 审阅**：未逐条审阅（npm registry 未提供 changelog 字段）——以实测冒烟全链路通过 + engines 无约束作为兼容性依据，诚实留痕
- **灰度顺序**：服务器实例已装（本轮）→ **观察一个完整开奖周期（2026-11-18 17:30 出号 + 22:00 对账，koi 与 dsh-pet 纯共存零耦合）** → 桥接开关开启另行授权（petBridge.enabled 默认 off，合入≠启用）

### TF-6 豁免白名单（修订 v1.2，2026-11-19，主人拍板 P13）

| 白名单项 | 触发 | 范围 | 频率护栏 |
| --- | --- | --- | --- |
| ① won 战果 | result 事件 `won===true` | 全彩种（原有，不变） | 每期至多 1 |
| ② near-miss 战果 | result 事件带 `nearMiss` 字段（`'NM-1'`组选命中 / `'NM-2'`两位对，预注册判据 `judgeNearMiss` 代码产出，**LLM 不可标注**） | **仅 p3 / 3d**；ssq/dlt 及其余 kind 不豁免（维持不上气泡） | 每彩种每日 ≤1（事件本身 ~30 天一遇） |
| ③ 停购倒计时 | 定时投喂（待第三批实装，载体设计阶段定） | 全局（当日有开奖彩种才播） | 每日 19:30 一条 |

- **文案边界**（BC-001 播报面）：事实+人设情绪可以，诱导性框架禁止——占位文案与禁止清单见 docs/31 §4.3。
- **心跳与红点口径不变**：桥接仍为 emit 后旁路钩子（不进渠道目录、不参与送达判定）；ADR-0003 决策 4 的红点/未读统计口径维持 `won===true`——NM 播报上气泡但不计未读（叙事非待办）。
- **账本口径不变**（BC-006）：NM 播报纯叙事，永不进 ledger。
- **豁免纪律**：本白名单为 ADR 级显式豁免（主人 2026-11-18/19 拍板，docs/31 §3）；后续扩面仍须拍板改本节，**不得静默扩面**；撤销 = 删行 + 拍板记录留档。
- **实施状态**：**第一批（p3）已落地**——pet-bridge 触发谓词扩 + draws.js `judgeNearMiss` + predictions `nearMiss` 字段 + settleText NM 叙事段四 commit（ac95508/508f123/9c53710/4184230），2026-11-19 部署生产并验收（docs/31 §6 第一批实施状态回填），测试基线 354/354；**第二批（3d）随福彩 3D 彩种实装同构生效**（修订 v1.3，2026-11-20：judgeNearMiss 生效门单点扩 p3/3d，判据/文案/护栏零变化）。落地验收 = docs/31 §6 验收口径。
