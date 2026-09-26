# Resume bullets — Agent Harness

> 可直接取用的简历条目与面试话术。**评审后修订版**：删去了站不住脚的量化结论（单轮消融、被过松 gold 撑起的"100%"），
> 只保留可被代码/轨迹/自检复核的事实。数字若要用，须先按"每配置 R≥3、逐任务配对"重测。

## 可安全主张的事实（有代码/自检/轨迹支撑）

- 零依赖 TypeScript，Node 原生运行（≥23.6），无构建、无第三方包；约 2.9k 行、17 个模块。
- **90 项离线自检断言全绿**，GitHub Actions CI（无需 API key 即可回归）。
- 组件：受沙箱约束的多轮工具循环、上下文压缩（回合分组 + LLM 摘要 + 规则兜底）、断点续跑（事件溯源 + 原子快照）、
  独立判分器（4 类）、MCP 客户端（手写 stdio JSON-RPC）、轨迹回放、并发评测 runner、成本核算。
- **22 任务 / 7 能力域**评测套件；真实 DeepSeek 跑分**定位并修复 4 个 mock 测不到的跨层缺陷**
  （含工具调用序列化不合规致 API 422、沙箱路径拼接错误等）。
- 经第三方严格评审后，**修复了 3 个安全/完整性问题**：判分器执行模型文件时未上沙箱、子进程继承全部环境变量（含 API key）、
  系统提示词谎称无网络；并修正了交付物兜底泄漏验收标准的问题。每项都补了自检锁死。
- 具备**度量方法学意识**：pass@R、方差、flaky 归因、消融脚手架、判分器 gold 自校验纪律。

## 暂不主张（诚实）

- ❌ "整体可靠性 100%±0%"、"护栏 +4.5%"、"压缩省 4% token"——首轮 n=1 结论。<b>已按评审做 R=3 配对重测（4 配置 × 22 任务 × 3 轮 = 264 次任务运行，每次含多轮 API 调用）</b>，结果证伪了它们：
  四配置全在噪声内（均值 97–98.5%）、g01 在所有配置里都 flaky、关压缩 token 几乎不变。故这些百分比不写进简历。
- ❌ "多模型对比"——仅对 deepseek-chat 评测过。

> 反而可主张的亮点：<b>我设计了 R=3 配对消融来检验自己的机制，并据此推翻了自己首轮的漂亮数字</b>——
> 这种"用实验证伪自己"的严谨，比一个存活的百分比更经得起面试追问。

## 中文 · 完整版（稳健版，5 条）

- 独立设计并实现带**可复现评测闭环**的 Agent 运行时（零依赖 TypeScript、无构建）：受沙箱约束的多轮工具循环、
  上下文压缩与断点续跑、独立判分器、MCP 协议客户端与轨迹回放；抽象模型无关的 provider 层，兼容任意 OpenAI 格式端点。
- 实现 **OS 强制级执行隔离**（Node `--permission`）：模型生成代码与被判分执行的脚本，其文件读写被运行时限制在工作区内、
  子进程环境做白名单以剥离凭据；越界访问与判分阶段逃逸均由离线自检锁死。
- 构建 **22 任务 / 4 类判分器**的评测套件，用真实 API 跑分**定位并修复 4 个跨层缺陷**；经第三方评审再修复 3 个安全/完整性问题。
- 提出并实现**多次跑分可靠性度量（pass@R + 方差 + flaky 归因）与 R=3 配对消融**；用它**主动证伪了自己首轮的机制结论**
  （四配置在噪声内、g01 才是真实前沿），体现评测严谨与自我批判。
- 编写 **90 项离线自检**、`tsc --noEmit` 类型门禁并配置 **GitHub Actions CI**，保证核心机制在迭代中不劣化。

## 中文 · 精简版（2 条）

- 独立实现零依赖 TS Agent Harness：OS 强制沙箱 + 凭据白名单、上下文压缩+断点续跑、独立判分、MCP 客户端；
  22 任务套件真实跑分定位并修复 4 个跨层缺陷 + 3 个安全问题。
- 设计 pass@R/方差/flaky 可靠性度量与 R=3 配对消融；用它**证伪了自己首轮的机制结论**（诚实）；90 项自检 + 类型门禁 + CI 全绿。

## English · Full (defensible version)

- Built an agent harness with a **reproducible evaluation loop** (zero-dependency TypeScript, no build step): sandboxed
  multi-turn tool use, context compaction with checkpoint/resume, independent auto-graders, an MCP (Model Context Protocol)
  client, and a trajectory replay viewer; model-agnostic provider layer for any OpenAI-compatible endpoint.
- Implemented **OS-enforced isolation** via Node's permission model (out-of-workspace fs access denied for both model code
  and grader-executed artifacts) and an **environment allowlist** that strips credentials from child processes — each backed by an offline assertion.
- Built a 22-task / 4-grader suite; **live runs surfaced and fixed 4 cross-layer bugs** invisible to mock tests, and a third-party
  review drove 3 further security/integrity fixes.
- Introduced **repeated-run reliability metrics (pass@R + variance + flaky attribution)** and an ablation harness; can articulate
  why the first single-run ablation was not statistically valid (noise, null control, over-loose gold) and how to fix it.
- 90 offline assertions gated by GitHub Actions CI.

## 面试话术 / 追问应对

- **"含金量在哪？"** 不是调 API，是三层硬核 + 一套度量：OS 强制沙箱、上下文压缩+续跑、独立判分闭环、pass@R/方差。
- **"最难的 bug？"** 讲 tool_calls 序列化：mock 测不出、真实 API 才 422 —— 论证"为什么必须有真实评测闭环"。
- **"你的消融可信吗？"**（大概率被追问）主动承认：首轮是 n=1、压缩对照空跑、g01 gold 过松，结论已撤回；
  正确做法是每配置 R≥3、逐任务配对、报 pass@R/中位数。**能自曝方法缺陷，比给一个存活百分比更能证明工程判断力。**
- **"沙箱到底隔离了什么？"** 文件读写被运行时 jail 强制、判分执行的模型文件同样受限、子进程 env 白名单剥离凭据；
  诚实说残留：不拦网络、Python 侧无对等隔离、生产需容器后端。
