/* zcode-workflow
description: 锦鲤 SDD 四阶段无人值守流水线：A 需求分析查漏补缺（aet-req-analysis，IR 就地升版并定值全部
  [[PH:...]] 占位符）→ B 系统设计刷新（aet-req-design，SDD 文档主载体）→ C 全流程复盘 + 实施方案确认书（A/B/C
  每阶段附一轮独立产品经理复核与退回修订回路）→ D 按确认书实施 + node --test 独立验收门（失败退回修复，最多 maxGateRounds
  轮）。所有询问项按推荐默认执行并逐条落盘默认决策记录；全程禁止 git commit/push 与任何服务器部署。
whenToUse: 主人不在场、需要对既有 IR 需求规格与代码库跑一轮完整「分析查漏 → 设计刷新 → 方案确认 → 实施 + 测试验收」闭环时：如锦鲤
  v1.1 修复包这类小步迭代，或 v2 认知层 M1–M4 里程碑逐段实施（届时调整 irNextVersion 与 D
  阶段范围裁决相关的阶段提示词）。适合要求一切默认决策落盘供事后复核、由独立验收门把关的场景。需要在场交互拍板、或涉及服务器部署（scp/ssh/五步验收/M3
  spike）时不要使用。验收门命令写死了本机 DSH 运行时的 node 全路径，换机器需先改脚本。
args:
  analysisModel:
    type: string
    description: 阶段 A/B/C（需求分析/系统设计/方案确认）子代理所用模型："flash"=GLM-5.3-Flash（max
      思考），"glm53"=GLM-5.3（max 思考）。注：原运行 dwfrun-aa0abbc6 脚本默认 flash，实际执行时经 GUI
      覆盖为 glm53。
    default: flash
  decisionsDir:
    type: string
    description: 默认决策记录目录：00-流水线说明.md 与 A~D 四份默认决策记录所在处（不存在则由阶段自行创建）。
    default: docs/decisions
  implModel:
    type: string
    description: 阶段 D（实施+测试）子代理所用模型，取值同 analysisModel。
    default: glm53
  irDoc:
    type: string
    description: 需求分析规格（IR）文档路径：阶段 A 就地查漏刷新的对象，阶段 B/C/D 的权威需求输入。
    default: docs/12-需求分析规格-IR.md
  irNextVersion:
    type: string
    description: 阶段 A 刷新 IR 时 frontmatter version 升至的目标版本号（文末「修订记录（该版本）」小节同名）。复用时按当前版本递进传参。
    default: v1.1.0
  maxGateRounds:
    type: number
    description: 独立验收门最大执行轮数：测试失败则退回阶段 D 修复后重跑；达到上限仍未全绿即以失败如实上报（high 级发现）。
    default: 3
  planDoc:
    type: string
    description: 阶段 C 产出的实施方案确认书路径，同时是阶段 D 的唯一开工依据。
    default: docs/13-实施方案确认书.md
  pluginDir:
    type: string
    description: 目标插件目录（仓库相对路径）：阶段 A/B 的代码实读对象、阶段 D 的施工范围（禁止改动范围之外文件）。
    default: plugins/dsh-koi
  sddDoc:
    type: string
    description: 系统设计文档（SDD 主载体）路径：阶段 B 就地刷新，docs/09/10 按需同步。
    default: docs/11-软件设计文档-SDD.md
  testGlob:
    type: string
    description: 独立验收门的测试 glob（仓库相对路径）。注意：本机 node --test 传目录形式会失败，务必保持 glob 形式（由
      node 解析、可自动发现新增测试文件）。
    default: plugins/dsh-koi/tests/*.test.mjs
*/
// 锦鲤 SDD 四阶段流水线：A 需求分析查漏 → B 系统设计刷新 → C 实施方案确认 → D 实施与测试。
// 提炼自运行 dwfrun-aa0abbc6-59f4-4c16-9da0-df1f197adc53（脚本原样，仅把两次运行间会变化的值抽成 args）。
// 主人休息中：各阶段所有询问项按推荐默认执行，并逐条落盘到默认决策记录目录（约定见 <decisionsDir>/00-流水线说明.md）。
// 注意：验收门命令 node 路径为本机 DSH 运行时（写死为 world.run 的命令字面量）；换机器跑需改此路径。

const FLASH = model("account:zai-start-plan/GLM-5.3-Flash$max");
const GLM53 = model("account:zai-start-plan/GLM-5.3$max");
// 阶段 A/B/C 与 D 的模型按 args 在两个已声明的 ModelRef 间选择
const analysisModel = String(args.analysisModel ?? "flash") === "glm53" ? GLM53 : FLASH;
const implModel = String(args.implModel ?? "glm53") === "flash" ? FLASH : GLM53;

const pluginDir = String(args.pluginDir ?? "plugins/dsh-koi");
const irDoc = String(args.irDoc ?? "docs/12-需求分析规格-IR.md");
const irNextVersion = String(args.irNextVersion ?? "v1.1.0");
const sddDoc = String(args.sddDoc ?? "docs/11-软件设计文档-SDD.md");
const planDoc = String(args.planDoc ?? "docs/13-实施方案确认书.md");
const decisionsDir = String(args.decisionsDir ?? "docs/decisions");
const testGlob = String(args.testGlob ?? `${pluginDir}/tests/*.test.mjs`);
const maxGateRounds = Number(args.maxGateRounds ?? 3);

interface StageResult {
  /** 阶段代号：A / B / C / D。 */
  stage: string;
  /** 中文 3–6 句总结：做了什么、关键结论、权威产出是哪个文件。 */
  summary: string;
  /** 本阶段产出或修改的关键文件（仓库相对路径）。 */
  artifacts: string[];
  /** 默认决策记录文件路径。 */
  defaultsLog: string;
  /** 本阶段登记的默认决策条数。 */
  defaultsCount: number;
  /** 需主人事后注意的事项；无则空数组。 */
  openIssues: string[];
}

interface PmFindings {
  /** false 表示存在必须处理的问题。 */
  approved: boolean;
  /** 问题清单：point 一句话说清问题，suggestion 给出建议方向。 */
  issues: { point: string; suggestion: string; severity: "low" | "medium" | "high" }[];
}

interface Finding {
  /** 问题所在位置：文件路径或阶段代号。 */
  where: string;
  /** 一句话说明问题或发现。 */
  what: string;
  /** 依据：来自哪个阶段的什么记录。 */
  evidence: string;
  /** verified = 有确定性检查背书；unconfirmed = 待主人人工判断。 */
  status: "verified" | "unconfirmed";
  /** 影响程度；high 只用于测试未通过。 */
  severity: "low" | "medium" | "high";
}

interface WorkflowReport {
  /** 两三句话回答主人：四个阶段做完了什么、结果如何、先看哪里。 */
  conclusion: string;
  findings: Finding[];
  /** 本次运行实际做过的验证及方式。 */
  verified: string[];
  /** 没覆盖或没法查的部分及原因。 */
  notCovered: string[];
}

artifact.board("progress", {
  title: "四阶段流水线进度",
  key: "stage",
  status: "status",
  columns: ["进行中", "已完成", "受阻"],
  cardTitle: "stage",
  detail: [{ field: "note", label: "说明" }],
});

const POLICY = [
  "【无人值守纪律】主人正在休息，本阶段全程无人值守：",
  "1) 一切本应向用户提问/请求确认的点，采用你角色下的最佳推荐默认值继续执行；",
  "2) 每个这样的决策逐条登记到默认决策记录文件（不存在则创建，已存在则追加），表格列：编号 | 事项/问题 | 候选项 | 采用的默认值 | 选择理由 | 影响与后续可改点；",
  "3) 文档中的 [[PH:...]] 数值占位符按其 rec: 建议值定值（或你更优的推荐值）并登记；",
  "4) 如实汇报：没验证的明说，不虚报完成；遇到自相矛盾或无法绕行的硬阻塞，如实记录并写明绕行措施；",
  "5) 全程不执行 git commit/push，不做任何服务器部署（scp/ssh/远程 dsh 命令一律禁止）。",
].join("\n");

log(`流水线启动：A→B→C→D 顺序执行；全部询问项按推荐默认执行并落盘 ${decisionsDir}/。`);

phase("阶段A：需求分析查漏补缺");
report({ stage: "A·需求分析", status: "进行中", note: "按 aet-req-analysis 复查需求规格" }, "progress");
const aWorker = agent("A·需求分析师", {
  model: analysisModel,
  system: "你是资深需求分析师（Requirements Analyst）：只澄清与完善需求，绝不做技术设计决策；面向用户的询问一律以默认决策记录代替。",
});
let aRes = await aWorker.ask<StageResult>(`【背景】你是四阶段 SDD 流水线的阶段A。上游需求引出会话已完成并落盘 ${irDoc}（19 道拍板题见其附录 5.1；其 §5.4 声明该文档是进入设计阶段的权威需求输入）。
【任务】以 ${irDoc} 为对象，按 aet-req-analysis 技能做系统性查漏补缺与完善，产出可交给设计阶段的权威 IR。
【必读材料】
1. C:/Users/10170/.zcode/skills/aet-req-analysis/SKILL.md，并按其指示加载同目录 workflows/ 下的 SOP（sop-elicitation / sop-load-template / sop-generation / sop-review）；
2. ${irDoc}（本轮对象）；docs/05-锦鲤预测.md、docs/06-锦鲤心智-方案与待拍板问题.md、docs/07-产品经理评审-锦鲤PRD.md（RR 来源与既有 PM 评审）；${decisionsDir}/00-流水线说明.md（流水线约定）；
3. ${pluginDir}/ 代码按需实读（Gemba 原则：以代码事实校准需求描述）。
【工作要求】
- 逐节复查 ${irDoc}：EARS 规范性；场景 S-001~S-024 是否有遗漏的异常路径；业务规则 BC-001~016 与数据约束 DC-001~012 的完备自洽；FR/NFR 可测性；AC/TC 可执行性；
- §5.1「待主人评审确认」条目与全部 [[PH:...]] 占位符定值并登记默认决策；
- 与 docs/08-需求设计规格说明书.md 中仍有效的 v1/v1.1 条目比对，冲突处以 ${irDoc} 为准并显式标注；
- 不做任何技术设计决策（技术选型/架构/模块划分是下一阶段的事）；
- 技能流程中所有用户确认环节以默认决策记录代替；sdd_advance 工具在本环境不存在，对应评审环节改为自查一轮并记录。
【产出】
- 就地更新 ${irDoc}：frontmatter 的 version 升为 ${irNextVersion}、update_time 改为当前时间，文末新增「修订记录（${irNextVersion}）」小节列出本次全部改动点；
- 默认决策记录：${decisionsDir}/A-默认决策记录.md。
${POLICY}
【返回】StageResult：stage="A"；summary 用中文 3–6 句；artifacts 列出更新过的文件；defaultsLog="${decisionsDir}/A-默认决策记录.md"；defaultsCount；openIssues。`);

phase("阶段A：产品经理独立复核");
const aPm = agent("A·产品经理复核", {
  model: analysisModel,
  system: "你是没参与起草的独立产品经理。先读角色文件采纳其评审框架，然后只挑毛病、不改文件；没有确凿依据不轻易通过。",
});
const aPmF = await aPm.ask<PmFindings>(`【独立产品经理复核】请先完整阅读 C:/Users/10170/.zcode/agents/product-manager.md 并采用其评审框架与视角，然后独立复核阶段A的产出：
- 复核对象：${irDoc}（${irNextVersion}）与 ${decisionsDir}/A-默认决策记录.md；
- 上游依据：docs/05/06/07（原始需求记录与既有 PM 评审 docs/07）。
只挑毛病，返回 PmFindings：①真实需求缺口（遗漏的失败模式/边界/口径矛盾/不可验收项）；②站不住脚的默认决策（每条给出你更推荐的默认值与理由）；③范围蔓延或与「诚实条款/成本硬顶/改造不重写」冲突之处。不修改任何文件。没有问题才 approved=true；问题按 severity 分级。`);
if (aPmF.issues.length > 0) {
  log(`阶段A 产品经理复核提出 ${aPmF.issues.length} 条意见，退回修订`);
  aRes = await aWorker.ask<StageResult>(`独立产品经理复核对阶段A产出提出以下意见（JSON）：${JSON.stringify(aPmF.issues)}
逐条处理：采纳的落实到 ${irDoc} 与默认决策记录；不采纳的写明理由，作为「复核意见处置」条目登记进 ${decisionsDir}/A-默认决策记录.md。完成后返回最终 StageResult（结构与之前相同；summary 更新为最终结论）。`);
}
report({ stage: "A·需求分析", status: "已完成", note: aRes.summary.slice(0, 60) }, "progress");
log(`阶段A 完成：${aRes.defaultsCount} 条默认决策落盘`);
try {
  await artifact.file("log-a", aRes.defaultsLog, { title: "阶段A 默认决策记录" });
} catch {
  log("阶段A 默认决策记录卡片发布失败（文件仍在仓库默认决策记录目录下）");
}

phase("阶段B：系统设计刷新完善");
report({ stage: "B·系统设计", status: "进行中", note: "按 aet-req-design 刷新系统设计" }, "progress");
const bWorker = agent("B·系统设计师", {
  model: analysisModel,
  system: "你是资深系统设计师（Requirements Designer）：改造不重写、围栏式修改、契约先行、决策锚定需求规格；面向用户的询问一律以默认决策记录代替。",
});
let bRes = await bWorker.ask<StageResult>(`【背景】你是四阶段 SDD 流水线的阶段B。阶段A 已把需求分析规格刷新为 ${irDoc}（${irNextVersion}，权威需求输入；本次修订见文末「修订记录」），阶段A 默认决策在 ${decisionsDir}/A-默认决策记录.md。
【任务】按 aet-req-design 技能，以 ${irDoc} 为强制输入，对设计产物做查漏补缺与完善，产出可指导实施的系统设计文档。
【必读材料】
1. C:/Users/10170/.zcode/skills/aet-req-design/SKILL.md，并按阶段加载 workflows/ 下 SOP（sop-exploration / sop-design / sop-verification / sop-load-template / sop-generation / sop-review）；
2. 强制输入：${irDoc} + 项目代码库 ${pluginDir}/（lib/ 八个模块与 tools/koi.mjs 共约 1700 行，全部实读）；
3. 建议材料：docs/08-需求设计规格说明书.md、docs/09-系统集成方案.md、docs/10-模块变更规划与接口契约.md、${sddDoc}、${decisionsDir}/A-默认决策记录.md、${decisionsDir}/00-流水线说明.md。
【硬约束】改造不重写；v1 冻结区 FZ-1~6（docs/10 §2）语义不变；整合优先原则（docs/06 §9）；${irDoc} §5.2 前置架构决定不得重新发明；v1 三 JSON（state/predictions/ledger）永不被认知层写路径触碰；产出文档 frontmatter effort=High。
【工作要求】
- 按技能四阶段执行：A1 设计探索（现状解剖）→ A2 设计草案 + 可行性验证（High effort 必须执行 A2.1 验证；无法真机验证的部分以推演/清单方式验证并显式说明）→ A3 文档生成 → A4 复审（sdd_advance 工具在本环境不存在：改为自查一轮并记录）；
- 覆盖面：v1.1 修复包（${irDoc} FR-001~009 ≙ docs/10 变更计划 C1~C8）细化到模块级变更与接口契约字段级；v2 认知层 dsh-koi-mind 的架构/模块/文件与数据库契约/schemaVersion/版本握手/总开关细化到可实现程度；M0–M4 里程碑与每周时刻表（错峰窗口 17:00–22:30）可执行化；DFx 策略；
- docs/09/10/11 与 ${irDoc} 冲突处：以 ${irDoc} 为准刷新，并显式标注更新原因；
- 技能流程中所有用户确认环节以默认决策记录代替（${decisionsDir}/B-默认决策记录.md）。
【产出】刷新后的设计文档：${sddDoc} 为主载体就地刷新（frontmatter version 升位、文末附修订记录）；docs/10 按需同步刷新；若 SOP 模板要求不同结构，以 SOP 为准并在 summary 明确指出最终哪个文件是权威设计文档。
${POLICY}
【返回】StageResult：stage="B"；summary 用中文 3–6 句；artifacts；defaultsLog="${decisionsDir}/B-默认决策记录.md"；defaultsCount；openIssues。`);

phase("阶段B：产品经理独立复核");
const bPm = agent("B·产品经理复核", {
  model: analysisModel,
  system: "你是没参与起草的独立产品经理。先读角色文件采纳其评审框架，然后只挑毛病、不改文件；没有确凿依据不轻易通过。",
});
const bPmF = await bPm.ask<PmFindings>(`【独立产品经理复核】请先完整阅读 C:/Users/10170/.zcode/agents/product-manager.md 并采用其评审框架与视角，然后独立复核阶段B的产出：
- 复核对象：${JSON.stringify(bRes.artifacts)} 与 ${decisionsDir}/B-默认决策记录.md；
- 上游依据：${irDoc}（${irNextVersion}）。
只挑毛病，返回 PmFindings：①设计与需求的偏离/缺口（接口契约不可实现、里程碑不可执行、冻结区被侵蚀）；②站不住脚的默认决策（每条给出你更推荐的默认值与理由）；③与 2核2G 资源约束、成本硬顶、回退契约冲突之处。不修改任何文件。没有问题才 approved=true。`);
if (bPmF.issues.length > 0) {
  log(`阶段B 产品经理复核提出 ${bPmF.issues.length} 条意见，退回修订`);
  bRes = await bWorker.ask<StageResult>(`独立产品经理复核对阶段B产出提出以下意见（JSON）：${JSON.stringify(bPmF.issues)}
逐条处理：采纳的落实到设计文档与默认决策记录；不采纳的写明理由，作为「复核意见处置」条目登记进 ${decisionsDir}/B-默认决策记录.md。完成后返回最终 StageResult（结构与之前相同；summary 更新为最终结论）。`);
}
report({ stage: "B·系统设计", status: "已完成", note: bRes.summary.slice(0, 60) }, "progress");
log(`阶段B 完成：${bRes.defaultsCount} 条默认决策落盘`);
try {
  await artifact.file("log-b", bRes.defaultsLog, { title: "阶段B 默认决策记录" });
} catch {
  log("阶段B 默认决策记录卡片发布失败（文件仍在仓库默认决策记录目录下）");
}

phase("阶段C：全流程复盘与实施方案确认");
report({ stage: "C·实施确认", status: "进行中", note: "复盘技能流程与子智能体，确认最终实施方案" }, "progress");
const cWorker = agent("C·实施评审人", {
  model: analysisModel,
  system: "你是实施方案整合评审人：对全流程做复盘与裁决，产出可直接开工的确认书；面向用户的裁决一律以默认决策记录代替。",
});
let cRes = await cWorker.ask<StageResult>(`【背景】你是四阶段 SDD 流水线的阶段C：实施前的总复盘与最终确认。阶段A 产出 ${irDoc}（${irNextVersion}）；阶段B 产出刷新后的设计文档：${JSON.stringify(bRes.artifacts)}（权威文件以阶段B summary 说明为准：${bRes.summary}）。两阶段默认决策：${decisionsDir}/A-默认决策记录.md、${decisionsDir}/B-默认决策记录.md。
【任务】对本流水线用到的全部技能流程与子智能体做流程复盘，确认最终实施方案，产出给实施阶段（D）的开工指令。
【必读】${irDoc}（${irNextVersion}）；阶段B 产出文档（上列路径）；${decisionsDir}/A 与 B 默认决策记录；docs/06 §9（整合优先）、docs/10 §2（冻结区）；C:/Users/10170/.zcode/agents/product-manager.md（采纳其评审框架）；两个技能的 SKILL.md（复盘流程达成度用）；${decisionsDir}/00-流水线说明.md。
【复盘清单】
1. SOP 达成度：aet-req-analysis 三阶段与 aet-req-design 四阶段的完成判据逐条对照，未达成项补齐或显式说明降级理由；
2. 链条一致性：IR → 设计 → 实施计划之间无断层、无矛盾、无重复；docs/08–11 与需求规格/确认书的权威关系明确无歧义；
3. 产品经理视角通审：按 product-manager 框架挑盲区（范围蔓延、不可验收、成本失控、2核2G 运维风险）；
4. 范围裁决（D 阶段做什么）：推荐默认 = D 只实施 v1.1 修复包（FR-001~009 / C1~C8）+ 新增测试（判奖金样本回归等）+ 全量本地测试回归；v2 认知层设计定稿但本轮不实施（按 M0–M4 里程碑由后续会话推进）；部署排除。如你判断应不同，给出明确理由与替代范围并登记默认决策；
5. 产出给 D 的执行清单：任务分解（对应 FR/C 编号）、每项的验证方式、风险与回退、禁止事项（不 commit、不部署、冻结区不破）。
【产出】${planDoc}（含：流程复盘表、范围裁决、任务清单、验证计划、风险登记、给 D 的开工指令）；默认决策记录 ${decisionsDir}/C-默认决策记录.md。
${POLICY}
【返回】StageResult：stage="C"；summary 用中文 3–6 句；artifacts；defaultsLog="${decisionsDir}/C-默认决策记录.md"；defaultsCount；openIssues。`);

phase("阶段C：产品经理交叉复核");
const cPm = agent("C·产品经理复核", {
  model: analysisModel,
  system: "你是没参与起草的独立产品经理。先读角色文件采纳其评审框架，然后只挑毛病、不改文件；没有确凿依据不轻易通过。",
});
const cPmF = await cPm.ask<PmFindings>(`【独立产品经理交叉复核】请先完整阅读 C:/Users/10170/.zcode/agents/product-manager.md 并采用其评审框架与视角，然后独立复核 ${planDoc}：重点审 D 阶段范围裁决是否恰当（是否贪多或漏项）、任务清单是否可直接开工、验证计划是否可在本机（无服务器）执行、风险登记是否遗漏。返回 PmFindings；不修改任何文件。`);
if (cPmF.issues.length > 0) {
  log(`阶段C 产品经理交叉复核提出 ${cPmF.issues.length} 条意见，退回修订`);
  cRes = await cWorker.ask<StageResult>(`独立产品经理交叉复核对 ${planDoc} 提出以下意见（JSON）：${JSON.stringify(cPmF.issues)}
逐条处理：采纳的落实到 ${planDoc} 与默认决策记录；不采纳的写明理由并登记。完成后返回最终 StageResult（结构与之前相同；summary 更新为最终结论）。`);
}
report({ stage: "C·实施确认", status: "已完成", note: cRes.summary.slice(0, 60) }, "progress");
log(`阶段C 完成：实施方案已在 ${planDoc} 确认，${cRes.defaultsCount} 条默认决策落盘`);
try {
  await artifact.file("plan", planDoc, { title: `实施方案确认书（${planDoc}）` });
  await artifact.file("log-c", cRes.defaultsLog, { title: "阶段C 默认决策记录" });
} catch {
  log("阶段C 产出卡片发布失败（文件仍在仓库 docs/ 下）");
}

phase("阶段D：实施与自测");
report({ stage: "D·实施测试", status: "进行中", note: "按实施方案确认书开工" }, "progress");
const dWorker = agent("D·实现工程师", {
  model: implModel,
  system: "你是资深实现工程师：严格按确认书施工，改造不重写，如实报告测试结果；禁止 commit/push 与任何部署；实现层面的拍板以默认决策记录代替。",
});
let dRes = await dWorker.ask<StageResult>(`【背景】你是四阶段 SDD 流水线的阶段D：按确认书实施并测试。上游产出：${planDoc}（范围与开工指令的唯一依据）、${irDoc}（${irNextVersion}）、阶段B 刷新的设计文档、各阶段默认决策记录（${decisionsDir}/）。
【必读】${planDoc} 全文；docs/10-模块变更规划与接口契约.md（冻结区与契约）；${sddDoc}（v1.1 相关部分）；${pluginDir}/ 全部源码。
【环境事实】
- 代码：${pluginDir}/，Node ESM，无外部运行时依赖；lib/（client/draws/fetch-draws/index/prompt/push/scheduler/stats）+ tools/koi.mjs（CLI）；
- 本机无全局 node；Node 运行时：C:/Users/10170/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe（下称 NODE）；
- 测试：在 ${pluginDir}/ 目录下「NODE --test tests/*.test.mjs」，现有 draws.test.mjs（22 例）+ stats.test.mjs（7 例）必须保持全绿；新增测试一律加到 tests/ 下 *.test.mjs；
- 流水线在你结束后会独立运行同一验收门（可发现 tests/ 下新增文件），并最多给你 ${maxGateRounds} 轮修复机会。
【工作要求】
- 严格按确认书任务清单逐项实施：改造不重写；冻结区 FZ-1~6 语义不破；每完成一项跑相关测试再进入下一项；
- 如发现确认书与 ${irDoc} 矛盾：以 ${irDoc} 为准，登记默认决策并在 openIssues 报告；
- 实现细节需要拍板处按推荐默认执行并登记 ${decisionsDir}/D-默认决策记录.md；
- 禁止：git commit/push；任何服务器部署或远程连接；修改 ${pluginDir} 之外与任务无关的文件；削弱或跳过既有测试断言；
- 全部完成后自跑一次全量测试，把结果原文摘要写进 summary（pass/fail 数字必须真实）。
${POLICY}
【返回】StageResult：stage="D"；summary 用中文 3–6 句（含改动文件清单与测试结果摘要）；artifacts（改动与新增的文件）；defaultsLog="${decisionsDir}/D-默认决策记录.md"；defaultsCount；openIssues。`);

phase("验收门：全量测试与修复回路");
log(`独立验收门：node --test ${testGlob}（glob 由 node 解析，可发现新增测试）`);
let gate = await world.run("C:/Users/10170/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe", ["--test", testGlob], { timeoutMs: 600000 });
let gateRound = 1;
while (gate.exitCode !== 0 && gateRound < maxGateRounds) {
  log(`验收门第 ${gateRound} 轮未通过（退出码 ${gate.exitCode}），退回 D 修复`);
  dRes = await dWorker.ask<StageResult>(`流水线独立验收门的全量测试未通过（NODE --test ${testGlob}，退出码 ${gate.exitCode}）。失败输出摘要（末尾 4000 字符）：\n${(gate.stdout + "\n" + gate.stderr).slice(-4000)}\n请修复到全绿（不得削弱既有断言），然后返回更新后的 StageResult（结构与之前相同）。`);
  gate = await world.run("C:/Users/10170/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe", ["--test", testGlob], { timeoutMs: 600000 });
  gateRound = gateRound + 1;
}
report({ stage: "D·实施测试", status: gate.exitCode === 0 ? "已完成" : "受阻", note: gate.exitCode === 0 ? "独立验收门全绿" : "测试仍未全绿，需主人过目" }, "progress");
log(`验收门结束：退出码 ${gate.exitCode}，共 ${gateRound} 轮`);
try {
  await artifact.file("log-d", dRes.defaultsLog, { title: "阶段D 默认决策记录" });
} catch {
  log("阶段D 默认决策记录卡片发布失败（文件仍在仓库默认决策记录目录下）");
}

const stageNotes: { label: string; res: StageResult }[] = [
  { label: "需求分析查漏补缺", res: aRes },
  { label: "系统设计刷新完善", res: bRes },
  { label: "全流程复盘与实施方案确认", res: cRes },
  { label: "实施与测试", res: dRes },
];
const findings: Finding[] = [];
for (const s of stageNotes) {
  for (const issue of s.res.openIssues) {
    findings.push({
      where: s.res.defaultsLog,
      what: `【阶段${s.res.stage}】${issue}`,
      evidence: `见 ${s.res.defaultsLog} 与该阶段产出 ${s.res.artifacts.join("、")}`,
      status: "unconfirmed",
      severity: "medium",
    });
  }
}
if (gate.exitCode !== 0) {
  findings.push({
    where: `${pluginDir}/tests/`,
    what: `独立验收门 ${gateRound} 轮后仍有测试失败（退出码 ${gate.exitCode}）`,
    evidence: `node --test ${testGlob} 最终输出（见运行日志与 ${decisionsDir}/D-默认决策记录.md）`,
    status: "verified",
    severity: "high",
  });
}
const verified: string[] = [
  "阶段A/B/C 各经一轮独立产品经理复核，意见处置登记于各默认决策记录",
  "阶段D 结束后自跑全量测试并在 summary 报告结果",
  `流水线独立验收门：node --test ${testGlob}（退出码 ${gate.exitCode}，共 ${gateRound} 轮）`,
];
const notCovered: string[] = [
  "部署五步验收（测试推送/杀 NapCat/对账中途重启等）需真实服务器与 NapCat，本流水线明确禁止部署，留待主人部署后执行",
  `v2 认知层（dsh-koi-mind）的实施：设计已定稿，按 ${planDoc} 的里程碑由后续会话推进`,
  "git commit/push：按约定留给主人审阅后自行处理",
];
const section = (label: string, res: StageResult) => [
  `## 阶段${res.stage} · ${label}`,
  res.summary,
  "",
  `产出：${res.artifacts.join("、")}`,
  `默认决策：${res.defaultsLog}（${res.defaultsCount} 条）`,
  res.openIssues.length > 0 ? `待主人注意：${res.openIssues.join("；")}` : "无遗留提示",
  "",
];
const gateLine = `验收门：node --test ${testGlob} → ${gate.exitCode === 0 ? "✅ 全绿（退出码 0）" : `❌ 未通过（退出码 ${gate.exitCode}，共 ${gateRound} 轮）`}`;
const reportMd = [
  "# 锦鲤 SDD 四阶段流水线 — 执行汇总",
  "",
  gateLine,
  "",
  ...section("需求分析查漏补缺", aRes),
  ...section("系统设计刷新完善", bRes),
  ...section("全流程复盘与实施方案确认", cRes),
  ...section("实施与测试", dRes),
  "## 建议阅读顺序",
  `${decisionsDir}/00-流水线说明.md → A~D 四份默认决策记录 → ${planDoc} → git diff 审阅代码改动`,
].join("\n");
await artifact.markdown("summary", reportMd, {
  title: "四阶段流水线执行汇总",
  description: "A/B/C/D 四阶段结论、默认决策落点与验收门结果",
  primary: true,
});
const conclusion = gate.exitCode === 0
  ? `四阶段流水线完成：A 把 ${irDoc} 刷新为 ${irNextVersion} 并定值全部占位符；B 刷新系统设计（权威文件：${bRes.artifacts.join("、")}）；C 复盘全流程并在 ${planDoc} 确认实施方案；D 按确认书完成实施，独立验收门测试全绿。全部默认决策在 ${decisionsDir}/ 的四份记录中，等你逐条复核。`
  : `四阶段流水线已跑完，但独立验收门在 ${gateRound} 轮修复后仍未全绿（退出码 ${gate.exitCode}）：A/B/C 的文档产出与默认决策记录均已落盘，D 的代码改动留在工作区，请先看 ${decisionsDir}/D-默认决策记录.md 与测试日志再决定接手方式。`;
const result: WorkflowReport = { conclusion, findings, verified, notCovered };
return result;