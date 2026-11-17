# M3 前置双 Spike 探测记录（M3-T1）

> 日期：2026-11-18　执行：ZCode 只读探测员（M3 博弈编排层前置）
> 对应待验证项：docs/11 §7「未验证项」①（DSH 宿主逐调用 usage 接口）与 ③（dsh-auto-memory 宿主级注入的会话级关闭开关名）；docs/12 FR-045 P0 前置验证；ADR-13 计量双路径；FR-028。
> 方法：全程只读。Spike 1 走 ssh（root@120.55.184.195，仅 cat/grep/ls/head/tail/sed -n/which 等只读命令）读运行时源码；Spike 2 经 codeload tarball 拉 GitHub 主分支源码到本机独立临时目录（`C:\Users\10170\AppData\Local\Temp\spike2-auto-memory\extracted\dsh-auto-memory-main`，不可信数据隔离，仅 grep/Read 分析，未执行任何其中代码）。本文件为本次唯一写入的文档。

---

## 结论速览

| Spike | 问题 | 结论 |
|---|---|---|
| 1 | DSH 宿主是否暴露逐 LLM 调用真实 usage | **可行**——逐 step 真实 usage（input/output/cache_read/cache_write）持久化在会话日志 `assistant/message` 事件内，并有 `ctx.tokenMeter` cordis 服务与 `deriveTurnTokenUsage()` 逐 turn 精确聚合，插件（cordis context 层）可达 |
| 2 | dsh-auto-memory 宿主级主动注入机制与开关名 | **有条件可行**——注入机制与全部配置键已确认（`memory:index` section / order 4000）；**插件无总开关、无会话级关闭开关**（CONTRACT 明文「明确不做」），但宿主 `system-prompt/assemble` waterfall 钩子面真实存在且返回值权威，koi-mind 可用一个小监听器实现「出号会话剥离注入段」 |

**M3 计量路径推荐：按 ADR-13 走路径 A（真实 usage 直采）为主路径，路径 B（定额估算）保留为 feature-detect 失败时的降级兜底**（详见 §3）。

---

## 0. 探测环境

- 服务器：120.55.184.195（Ubuntu, kernel 7.0.0-31-generic），dsh 入口 `/usr/local/bin/dsh -> /usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js`
- 宿主版本：`@deepseek-ai/dsh` **0.2.1-rc.2**（npm 包形态，描述 "dsh CLI: profile launch, plugin management, and configuration inspection"；运行时由 305 个 `@deepseek-ai/*` 作用域包组成，node_modules 内置）
- dsh home：`/root/.dsh/`，profiles：仅 `web`（`/root/.dsh/profiles/web/cordis.patch.yml` 当前为 `[]` 空补丁、package.json bundles 仅 `dsh-base`+`dsh-web-app`）——**dsh-auto-memory 尚未在服务器安装**，本 spike 为设计期预研
- Spike 2 源码：npm `dsh-auto-memory@1.9.0`（maintainer asktheway），仓库 `github.com/AskTheWay/dsh-auto-memory`，main 分支快照（2026-11-18）。git clone 三次均被重置（GitHub 连接不稳），按预案改 codeload tarball 成功。插件 peer 要求 `@deepseek-ai/dsh-* >=0.1.5-rc.2 <0.3.0`，与服务器 0.2.1-rc.2 兼容；README 1.8 条目记载在 dsh 0.2.2-rc.3 实测通过

---

## 1. Spike 1：DSH 宿主逐调用 token usage 接口

### 1.1 结论：可行（路径 A 直采成立）

宿主在**每一 step（= 一次 LLM 调用，含重试 attempt）**完成后把 provider 实报 usage 持久化进会话事件日志，并有逐 turn 精确聚合器与实时压力测量服务，两者都以 cordis context 形态暴露给插件。以下证据路径均相对 `/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`。

### 1.2 usage 数据结构（宿主标准类型）

- `dsh-llm/lib/types/types.d.ts:160-174` —— `TokenUsage` 接口：
  `inputTokens`（**仅未命中缓存的输入**）、`outputTokens`、`totalTokens?`、`cacheReadTokens?`、`cacheWriteTokens?`、`reasoningTokens?`
  注释（154-158 行）明确计数互斥（DISJOINT）：billed input = 三者之和；「Adapters whose providers fold cache hits into a total prompt count (DeepSeek's `prompt_tokens`) subtract them out」——即宿主已把 DeepSeek 折叠口径拆开归位。

### 1.3 数据流（provider → 持久化 → 聚合 → 服务），全链路证据

1. **Adapter 解析**：`dsh-llm-deepseek/lib/index.js:1821-1834` `updateUsage()` 将线上字段 `input_tokens / output_tokens / cache_read_input_tokens / cache_creation_input_tokens` 映射为 `inputTokens / outputTokens / cacheReadTokens / cacheWriteTokens`（非法值拒绝、缺项跳过）；2006-2009 行产出流事件 `{ type: "usage", usage }`（含 `totalTokens = input + output + cacheRead + cacheWrite`）。
2. **Agent loop 落盘**：`dsh-agent-loop/lib/index.js:460-462`（`get usage()` 取流聚合值），1098/1156 行 `session.append("assistant/message", { ..., usage })`（1110/1160 行 `...live.usage === void 0 ? {} : { usage: live.usage }`）——**每 step 的 assistant/message 事件内嵌该次调用 usage**。
3. **持久化事件类型**：`dsh-session/lib/types/types.d.ts:322-337` —— assistant/message 事件注释明文「Carries the step's `usage` when the adapter reported token accounting … (there is no separate usage record). `usage` is absent when the adapter reported none.」；`usage?: TokenUsage` 在 **337 行**。即：宿主没有独立的 usage 记录类型，计量直接读 assistant/message 事件即可，且 append-only 日志可回放重算（与 docs/11 ADR-13「replay-aware」一致）。
4. **逐 turn 精确聚合**：`dsh-token-meter/lib/types/turn-usage.d.ts` —— `deriveTurnTokenUsage(events: readonly SessionEvent[]): TurnTokenUsage | undefined`；`TurnTokenUsage` 字段：`uncachedInputTokens / outputTokens / totalTokens / cacheReadTokens? / cacheWriteTokens? / reasoningTokens? / routes?`（routes 带 provider+model 归因，TurnTokenUsageRoute）。语义严格：任何生命周期边界缺失、attempt usage 不完整、计数不安全或 total 自相矛盾 → 整个 turn 返回 undefined（宁缺毋假）。客户端安全入口 `@deepseek-ai/dsh-token-meter/client`（client.d.ts 直接再导出 `deriveTurnTokenUsage` 与两个类型）。
5. **实时服务**：`dsh-token-meter/lib/types/index.d.ts` —— 包描述即「Replay-aware token measurement service (**ctx.tokenMeter**) for the DeepSeek Harness」；`declare module '@deepseek-ai/cordis' { interface Context { tokenMeter: TokenMeter } }` —— **cordis 服务，任何拿到 Context 的插件可直接 `ctx.tokenMeter`**。方法：`measure(session, requestHeader?): TokenMeasurement`（当前请求压力/表面测量，provider usage 与启发式估价混合，用于 compaction 决策等）；`estimateMessage(message): number`（纯启发式估价）。
6. **插件可达性佐证**：`dsh-tool-cordis/lib/types/api-catalog.js:3296-3305` —— API 目录列出 `key: 'tokenMeter'` 及其 `measure(session, requestHeader?)` 签名（宿主对工具/插件公开的 API surface 明细）；tokenMeter 的其他消费者：`dsh-compaction-basic/lib/index.js`、`dsh-compaction-tool-result-pruner/lib/index.js`、`dsh-acp/lib/index.js`。
7. **实时逐调用钩子（供 koi-mind 流水线内直采用）**：`dsh-agent/lib/types/runtime-types.d.ts`（cordis Events 增广，scope 过滤到具体 agent）：
   - `agent/request`（327 行起，waterfall，payload 含 `agent/turn/step/signal`，返回 `LlmCallConfig`）——每次模型调用前的钩子，可在此打 call_ref 标签；
   - `agent/assistant-stream`（366 行起，emit）——frame 类型 `AssistantStreamFrame`（106-132 行：`eventType: 'assistant/message' | 'assistant/attempt'`），终帧携带提交的 assistant message（含 usage）；
   - 另有 `agent/request-error` / `agent/turn-stopping` / `agent/status` 等可辅助记录失败与耗时。
   - 无逐 step 专用 commit 事件的公开事件名；**实时直采用 `agent/assistant-stream` 终帧，事后/对账直采用会话日志 assistant/message 事件**，两者内容一致。
8. **headless 通道**：`dsh-headless/lib/json-stream-BA-F3lfb.js:116-176` —— JSON 行输出同样逐 step 累积 usage（`sum` 合并 input/output/total/cacheRead/cacheWrite/reasoning），终局 `final` 事件携带完整答案；多 attempt 缺项时该 step **整体省略 usage**（注释 121-126 行：不发布不可知的 step 总数）。

### 1.4 宿主现成用量展示

- **Web UI 已有逐 turn 用量面板**：`dsh-client-ui-chat/lib/client.js:5791`（`"stats.dialog.usageTitle": "Token 用量"`）、:6000-6001（settings "Performance & usage"）、:6082（`"message.turnUsage.title": "Turn usage"`）、:6835-6843（「Completed-Turn token usage action and its accounting details dialog」）——即宿主原生会按同一套 turn usage 记账展示明细对话框。
- CLI 顶层（`dsh --help`）只是 profile 引导器（boot/plugin/dump-config），**无独立 usage 统计子命令**；统计在 web 应用面板与会话日志层，不在 CLI 层。

### 1.5 口径注意（写进 metering.js 的实现约束）

- DeepSeek adapter（dsh-llm-deepseek）只映射上述四个字段；`reasoningTokens` 在该 adapter 的映射表中**不存在**——DeepSeek API 的 completion_tokens 已含推理输出，M3 计量按 outputTokens 记即可，不应假设 reasoningTokens 恒可得（类型上即 optional）。
- turn 级聚合是 all-or-nothing：turn 内任一 attempt 未报某桶，该桶缺失；usage 缺失（adapter 未报）时 assistant/message 无 usage 字段、deriveTurnTokenUsage 返回 undefined——这正是 ADR-13 的 feature-detect 降级触发点。
- `routes` 归因要求每个 billed attempt 带 provider/model，缺失时整个 routes 缺失（不影响 token 数字本身）。

---

## 2. Spike 2：dsh-auto-memory 宿主级主动注入机制与开关名

### 2.1 结论：有条件可行

机制、配置面、注入时机全部确认；**插件本身既无「总开关」也无「会话级关闭开关」**（1.9.0 能力契约明文拒绝），但宿主存在可用的钩子面（`system-prompt/assemble` waterfall），koi-mind 以极小监听器即可实现 FR-028 要求的「出号会话默认关闭宿主级自动注入」，同时保住工具级整合（memory_add 等四工具不受影响）。以下证据路径相对本机临时目录 `…\dsh-auto-memory-main\`（main 快照，版本 1.9.0）。

### 2.2 注入机制（精确到行）

- 插件形态（`src/index.ts:25-26`）：`export const name = 'dsh-auto-memory'`；`export const inject = ['tools', 'systemPrompt']` ——依赖宿主 `systemPrompt` 服务与 `tools`。
- **唯一注入点**（`src/index.ts:125-129`）：
  `ctx.systemPrompt.section({ name: MEMORY_SECTION, order: 4000, text: context => audit.text(context.agent?.session.header.cwd, context.agent?.session.id) })`
  - 段名常量：`MEMORY_SECTION = 'memory:index'`（`src/prompt.ts:23`）——**这是宿主内唯一的注入段名，M3 剥离监听器按 `name === 'memory:index'` 匹配**。
  - 注入内容：MEMORY.md 索引渲染文本（`renderMemoryIndexText`，含写入指导），超预算按会话冻结词集相关性截断（1.3.0 起，audit 层冻结）。
  - 注入时机：**动态段，每 step 组装（= 每次模型请求前）重新求值**（`src/index.ts:112-114` 注释「每个 step 重组装时按当前 agent 的 cwd 重新求值」；`docs/injection-design.md:87`「单个动态段，每步组装重新求值」）。内容策略为「会话快照」：会话首 USER 定格选择的相关性子集，会话内绝对稳定（`docs/injection-design.md:95` 对比表）；工具写入下一请求即生效。
  - 空库注 0 字节、整段消失（`src/index.ts:113`、CONTRACT「保证」条）。
- **注入内容来源**：记忆根目录 = `config.memoryDir` 缺省 `$DSH_HOME/memory`（`src/index.ts:61-63`，`resolveDshHome()`），project 层按会话 cwd 组织 + `_user` 用户层（`enableUserScope=true` 时注入所有会话，`src/index.ts:107`）；索引在会话首 agent 创建时刷新（`ctx.on('agent/created', …)`，`src/index.ts:101-109`）。
- 固化（反方向）：`autoSummarize=false`（默认）时会话结束不自动总结；开启则为后台 LLM 调用（本身也产生 token 消耗，须计入 FR-045）。
- 审计：1.0 起每次注入落 `audit.jsonl`（注入集合变化时追加，纯副作用；`src/index.ts:118-119`、`src/audit.ts`）。

### 2.3 配置面全集（含精确键名与默认值）

插件 Config schema（`src/index.ts:29-57`，schemastery，默认值写在 schema）：

| 键 | 类型 | 默认 | 语义 |
|---|---|---|---|
| `maxBytes` | number | 4096 | 注入索引段字节预算（**设 0 无效**：CONTRACT「保证」明文最小安全钳位 `max(maxBytes, 1024)`——不能靠归零关闭注入） |
| `memoryDir` | string | `$DSH_HOME/memory` | 记忆根目录 |
| `enableUserScope` | boolean | true | 用户级作用域（`_user` 注入所有会话）；false 仅关闭用户层，project 层不受影响 |
| `autoSummarize` | boolean | false | 会话结束自动固化（后台 LLM 调用） |
| `autoSummarizeMaxMemories` | number | 5 | 单次固化最多写入新记忆数 |
| `autoSummarizeMaxTokens` | number | 2048 | 固化调用输出 token 上限 |
| `minImportance` | number | 4 | 固化价值门槛 |
| `staleAfterDays` | number | 0 | 软淘汰天数（0 禁用） |

- 运行时 sidecar：`$DSH_HOME/memory/settings.json`（`src/settings.ts:21-31`，`SETTABLE_FIELDS` 白名单 = maxBytes / minImportance / staleAfterDays / autoSummarize / autoSummarizeMaxMemories），面板改后下一请求生效。
- **不存在 `enabled` / `inject` / `autoInject` / 任何会话级开关键**（Config schema 与 settings 白名单均无）。逐条记忆另有 `disabled` 软静音（`src/tools.ts:91-93`）与 `validUntil` 过期，均为**逐条**粒度，非会话粒度。

### 2.4 会话级关闭开关：不存在（官方明文）

- `docs/CONTRACT.md:43`（能力契约·隐私节，措辞冻结）：「**明确不做**：会话级"免记忆"模式（暂无宿主钩子面）。」——四档定性里的「明确不做」，提 issue 也不接。
- 由此回答 docs/11:604 未验证项③：**该开关名不存在，M3 不能指望插件侧配置解决 FR-028**。

### 2.5 但宿主钩子面存在——M3 落地路径（推荐）

插件作者说「暂无宿主钩子面」，实测宿主有（可能是作者指「无 per-section 配置面」；对能写小插件的一方，钩子是够用的）：

- `dsh-system-prompt/lib/types/index.d.ts`（服务器）——`system-prompt/assemble` waterfall 事件：scope 过滤分发，assembly 为可变对象，**「The returned value is authoritative」**；监听器不能增/替（complete 段会被还原），但可**删除非 complete 的注册段**。
- 实现（`dsh-system-prompt/lib/index.js:398-405`）：`const transformed = await this.ctx.waterfall(scopeTarget(this, scope), "system-prompt/assemble", assembly, context, …)`；`if (completeSection === void 0 && !runtimeContextSuppressed) return transformed;` ——无 complete 段时 waterfall 返回值**原样生效**。
- 会话识别：`dsh-agent/lib/types/runtime-types.d.ts:14-19` 把 `AssembleContext` 增广出 `agent?: Agent`（「When present, `scope` must identify the same agent」）——监听器可拿 `context.agent.session.id / header.cwd` 判定是否出号会话。
- 宿主内先例：`dsh-working-directory/lib/index.js:48-60` ——官方插件自己就用 `ctx.on("system-prompt/assemble", async (_assembly, context, next) => { … const assembly = await next(); …增改 assembly.contexts… })`。

**推荐实现**：koi-mind 插件注册一个 `system-prompt/assemble` 监听器：`await next()` 后按 `context.agent.session` 判定出号会话（koi-work cwd / 会话白名单），从 `assembly.sections` 中移除 `name === 'memory:index'` 的项。出号会话 → 宿主注入归零（满足 FR-028/AC-022 断言「不含认知层模板之外的宿主级自动注入内容」）；闲聊会话不受影响；`memory_write/read/list/delete` 四工具全局保留（FR-028 工具级整合不破坏）。风险：段名 `memory:index` 为插件私有常量，插件大版本升级若改名需同步（写进运行手册检查项，docs/11:604 ③ 已有此检查项安排）。

备选（不推荐）：A. profile 隔离——出号走独立 profile 不装 auto-memory，但工具也没了，与 FR-028「工具级整合」冲突；B. 修订 FR-028 接受宿主注入——违反 AC-022 断言与计量隔离意图。

---

## 3. 对 M3 计量路径 A/B 的推荐

**推荐：维持 ADR-13 双路径，主路径= A（真实 usage 直采），降级兜底= B（定额估算+账单对账）**。本 spike 证实路径 A 在当前宿主（0.2.1-rc.2）真实可得，FR-045 的「唯一计量来源=接口实测用量」可直接落地：

1. **记账主采**：koi-mind metering.js 订阅 `agent/assistant-stream` 终帧（或 turn 结束读会话日志 `assistant/message.usage`），每 step 落 `token_usage` 行：`model`、`prompt_tokens=inputTokens(+cacheRead+cacheWrite)`、`completion_tokens=outputTokens`、cache 分项另存、`estimated=0`、`call_ref` 用 `agent/request` waterfall 打的 turn/step 标签。activity 归类映射照 docs/11 §2.2.2（predict/deliberation/learning/review）。
2. **turn 级对账**：每 turn 收口时跑 `deriveTurnTokenUsage()`；返回 undefined（attempt 缺 usage / 流中断）→ 该 turn 各 step 回退路径 B（模型×activity 定额表）并 `estimated=1`，FR-047 首月与账单对账校准收敛。
3. **预算守卫（可选增强）**：注入/出号前用 `ctx.tokenMeter.measure(session)` 读请求压力做超限预判——注意其返回是「provider usage 与启发式混合」的测量值，只做预算闸门，**不做记账来源**（记账只认 assistant/message.usage 实报值，维持 DC-011 唯一来源口径）。
4. **口径写入设计文档**：计量字段以 `TokenUsage`（互斥口径）为准——`uncachedInputTokens / outputTokens / cacheReadTokens / cacheWriteTokens`；DeepSeek 路由 `reasoningTokens` 不可假设可得（§1.5）；docs/11 §5.2 `token_usage` 表的 prompt_tokens 建议明确为「uncached input + cache 分项之和」以防歧义。

## 4. 开放问题（带入 M3 design 阶段）

1. `memory:index` 段名耦合：koi-mind 剥离监听器依赖插件私有常量，dsh-auto-memory 升级需回归检查（建议 M3 验收断言：出号会话 system prompt 不含 'memory:index' 渲染产物，加进 AC-022 检查单）。
2. `deriveTurnTokenUsage` 对「cancelled mid-stream」turn 的行为：中断 turn 的 usage 披露可能不可得（严格语义），路径 B 兜底覆盖率需在 M3 首月实测统计。
3. `ctx.tokenMeter` 是否在 koi 所用组合（web profile + 插件）下默认挂载：token-meter 属宿主组合层（compaction 依赖它），但 koi-mind 作为插件 `inject: ['tokenMeter']` 的显式声明应在 M3-T1 实装时验证（本 spike 只验证了服务存在与目录公开，未实装）。
4. multi-agent 并发出号（M3 博弈多角色同会话/多会话）下的 usage 归因粒度：routes 提供 provider/model 归因，但「角色→调用」映射需靠 koi-mind 在 `agent/request` 打标（turn/step 与角色的对照表），属 M3 实装设计项。
5. 本机 GitHub 直连持续不稳（clone 3 次重置）：M3 依赖升级/锁版本时建议用 npm registry 快照或镜像（本次 tarball 走 codeload 成功）。

## 附录：关键证据速查

| # | 证据 | 位置 |
|---|---|---|
| S1-1 | TokenUsage 接口（互斥口径） | （服务器）`@deepseek-ai/dsh-llm/lib/types/types.d.ts:160-174` |
| S1-2 | DeepSeek adapter usage 映射与 {type:"usage"} 事件 | `dsh-llm-deepseek/lib/index.js:1821-1834, 2006-2009` |
| S1-3 | 每 step usage 落 assistant/message 事件 | `dsh-agent-loop/lib/index.js:1098, 1110, 1156, 1160` |
| S1-4 | 事件类型注释「no separate usage record」+ usage?: TokenUsage | `dsh-session/lib/types/types.d.ts:322-337` |
| S1-5 | ctx.tokenMeter 服务 + Context 增广 | `dsh-token-meter/lib/types/index.d.ts`（declare module 块） |
| S1-6 | deriveTurnTokenUsage / TurnTokenUsage（含 routes 归因） | `dsh-token-meter/lib/types/turn-usage.d.ts` |
| S1-7 | API 目录公开 tokenMeter.measure | `dsh-tool-cordis/lib/types/api-catalog.js:3296-3305` |
| S1-8 | agent/request、agent/assistant-stream、AssembleContext.agent 增广 | `dsh-agent/lib/types/runtime-types.d.ts:14-19, 327, 366` |
| S1-9 | Web UI「Token 用量 / Turn usage」面板 | `dsh-client-ui-chat/lib/client.js:5791, 6082, 6835-6843` |
| S2-1 | 注入点 section('memory:index', 4000) | （本机快照）`src/index.ts:125-129`；`src/prompt.ts:23` |
| S2-2 | Config schema 全集与默认值 | `src/index.ts:29-57`；README.zh.md:222-233 |
| S2-3 | 运行时 settings.json 白名单 | `src/settings.ts:21-31` |
| S2-4 | 「明确不做：会话级免记忆模式」 | `docs/CONTRACT.md:43` |
| S2-5 | maxBytes 最小钳位 1024（归零无效） | `docs/CONTRACT.md` 注入与预算·保证条 |
| S2-6 | system-prompt/assemble waterfall 返回值权威 | （服务器）`dsh-system-prompt/lib/index.js:398-405`；`…/lib/types/index.d.ts` |
| S2-7 | waterfall 修改 assembly 的宿主先例 | `dsh-working-directory/lib/index.js:48-60` |
| S2-8 | npm 包→仓库（AskTheWay/dsh-auto-memory, 1.9.0） | npm registry /dsh-auto-memory 元数据 |

*（S2 本机快照路径：`C:\Users\10170\AppData\Local\Temp\spike2-auto-memory\extracted\dsh-auto-memory-main\`；分析完毕可随时清除。）*
