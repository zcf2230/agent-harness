# Resume bullets — Agent Harness

> 简历条目（瘦身后）。**定位 = 运行时 / 系统工程**：把 agent "跑起来、跑不崩、跑得可被量"。
> 评测里的统计严谨（McNemar / pass@R / gold）放面试话术附录，不在简历正文反复讲——那是 sql-agent-lab 的主叙事。
> 数字全部可由代码 / 自检 / 轨迹复核；仓库 <https://github.com/zcf2230/agent-harness>；配套文章 <https://juejin.cn/post/7689045619357499401>。

## 中文 · 简历正文（每条 ≤2 行，措辞即成品）

- 独立实现**零依赖 TypeScript 的 Agent 运行时**（约 2.9k 行 / 17 模块 / 无构建，Node 原生运行）：多轮工具循环，在 **OS 强制沙箱**里真跑模型生成的代码，含上下文压缩、崩溃续跑与成本/时限护栏。
- 手写**模型无关的 provider 抽象**（OpenAI 兼容、重试、工具调用协议序列化）与 **MCP 客户端**（stdio JSON-RPC）：换模型、接外部工具都只改配置。
- 建**独立判分的评测闭环**：22 任务 / 4 类判分器只读产物不读模型自述；用重复跑分衡量可靠性、用配对对照量化各机制的贡献。
- 真实 API 跑分定位并修复 **4 个 mock 测不到的跨层缺陷**（含序列化致 422）；经两轮评审再修 **7 个安全/完整性与"声明≠实现"问题**，均由离线自检锁死（现 **97 项**断言 + CI 全绿）。
- 诚实边界：不拦网络出口、Python 侧无对等隔离、仅测单模型；对机制收益重跑配对对照，**据此推翻了自己首轮的"护栏 +4.5% / 压缩 −4%"结论**，只保留可复现的信号。

## 中文 · 精简版（2 条）

- 零依赖 TS Agent 运行时：OS 强制沙箱 + 凭据白名单、上下文压缩+续跑、provider 抽象 + MCP；真实跑分修 4 跨层缺陷 + 两轮评审修 7 问题，97 项自检 + 类型门禁 + CI 全绿。
- 独立判分 + 多次跑分的可靠性与配对消融度量（含精确检验与置信区间）；诚实标注能力边界，并据重测撤回了自己首轮的机制结论。

## English · Full (resume-ready, ≤2 lines each)

- Built a **zero-dependency TypeScript agent runtime** (~2.9k LOC / 17 modules, no build step): a multi-turn tool loop that runs model-generated code in an **OS-enforced sandbox** (Node permission model), with context compaction, crash-resume, and cost/time guardrails.
- Hand-wrote a **model-agnostic provider layer** (OpenAI-compatible; retries; tool-call wire serialization) and an **MCP stdio JSON-RPC client** — swap models or add external tools by config alone.
- Built an **independent, artifact-graded evaluation loop** (22 tasks / 4 grader types score outputs, not the model's self-report), with repeated-run reliability and paired ablation for mechanism attribution.
- Live runs surfaced **4 cross-layer bugs invisible to mocks** (incl. a 422 serialization fix); two review rounds drove **7 further security/integrity and claim-vs-code fixes**, each locked by an offline assertion (**97 assertions**, CI green).
- Honest limits: network egress not enforced, no equivalent Python jail, single model; a paired re-run **refuted my first-round "+4.5% / −4%" mechanism claims**, keeping only what reproduces.

## 面试话术 / 追问应对（术语放这里，别写进正文）

- **定位分工（两个项目别讲成一个套路）**：agent-harness = **运行时 / 系统工程**（沙箱、续跑、provider/MCP，让 agent 跑稳跑不崩）；sql-agent-lab = **评测方法学与统计严谨**（判分器审计、执行准确率、有效样本量、不挑数、McNemar/Wilson）。"敢证伪自己 / 并列不利数字" 是 sql-agent-lab 的主叙事；本项目只把它当一句诚实支撑，不反复当标题。
- **"含金量在哪？"** 不是调 API，是三层硬核 + 一套度量：OS 强制沙箱、上下文压缩+续跑、独立判分闭环、多次跑分的可靠性度量。
- **"最难的 bug？"** 讲 tool_calls 序列化：mock 测不出、真实 API 才 422 —— 论证"为什么必须有真实评测闭环"。
- **"你的消融可信吗？"**（大概率被追问）主动承认：首轮是单轮、压缩对照当时是空跑、gold 曾过松，结论已撤回；正确做法是每配置多轮、逐任务配对、报 pass@R/中位数与配对检验。**能自曝方法缺陷、用度量推翻自己的漂亮数字，比给一个存活百分比更能证明工程判断力**——但这句话点到为止，不展开成第二个项目的招牌。
- **"沙箱到底隔离了什么？"** 文件读写被运行时 jail 强制、判分执行的模型文件同样受限、子进程 env 白名单剥离凭据；诚实残留：不拦网络、Python 侧无对等隔离、生产需容器后端。
- **术语白话注释**（面试要能脱口而出）：pass@R = R 次里至少过一次的比例（看能力上限）；方差/flaky = 同一任务时好时坏的稳定性信号；gold = 标准答案，且上线前先拿正/负例自校验判分器；McNemar / Wilson = 配对显著性检验与比例置信区间（本项目已加进 ablate 输出，与 sql-agent-lab 同一套统计纪律）。

## 可安全主张的事实（有代码 / 自检 / 轨迹支撑，被追问能复现）

- 零依赖 TS、Node 原生运行（≥23.6）、无构建；约 2.9k 行 / 17 模块。97 项离线断言全绿 + `tsc --noEmit` 类型门禁 + GitHub Actions CI（不需 key）。
- 组件：受沙箱约束的多轮工具循环、回合分组 + LLM 摘要 + 规则兜底的上下文压缩、事件溯源 + 原子快照的断点续跑、独立判分器（4 类）、手写 MCP 客户端（stdio JSON-RPC）、轨迹回放、并发 runner、成本核算、pass@R/方差 + 配对消融（含 McNemar 精确检验、Wilson 95% CI）。
- 22 任务 / 7 能力域；真实跑分修复 4 个跨层缺陷 + 两轮评审修复 7 个安全/完整性与"声明≠实现"问题（每项补自检）。
- 默认分支 `main`；MIT；配套技术文章发布于掘金「人工智能」。

## 暂不主张（诚实）

- ❌ "整体可靠性 100%±0%"、"护栏 +4.5%"、"压缩省 4% token"——首轮单轮结论，已按 R=3 配对（4 配置 × 22 任务 × 3 轮 = 264 次任务运行，每次含多轮 API）重测证伪，不写进简历。
- ❌ "多模型对比"——仅对 deepseek-chat 评测过。
