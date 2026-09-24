# Resume bullets — Agent Harness

> 可直接取用的简历条目与面试话术。数字与 README / `runs/*/bench.json` / `ablation.json` 一致。

## 关键量化事实（务必与仓库一致）

- 零依赖 TypeScript，Node 原生运行（≥23.6），无构建步骤、无第三方包
- 22 个任务 / 7 能力域 / 4 类判分器；12 基础 + 10 hard（带难度标注）
- 80 项离线自检断言，GitHub Actions CI 全绿（无需 API key）
- 真实跑分定位并修复 4 个 mock 测不到的跨层缺陷
- 可靠性：套件 pass@3 从 98.5%±2.1% → 100%±0%（flaky 清零）
- 消融：护栏 ≈ +4.5% 可靠性；压缩 ≈ −4% prompt token；沙箱与能力正交
- 全量评测成本 ≈ 0.1–0.2¥（DeepSeek），成本/时限护栏可强制止损

## 中文 · 完整版（主项目，5 条）

- 独立设计并实现带评测闭环的 Agent 运行时（零第三方依赖、无构建）：受沙箱约束的多轮工具循环、上下文压缩与断点续跑、独立判分器、MCP 协议客户端与轨迹回放；抽象模型无关的 provider 层，兼容任意 OpenAI 格式端点。
- 构建 22 任务 / 7 能力域 / 4 类判分器的评测套件，用真实 DeepSeek 跑分定位并修复 4 个 mock 无法暴露的跨层缺陷（含工具调用序列化不合规致 API 422、沙箱路径拼接错误）。
- 实现 OS 强制级执行沙箱（Node `--permission` 运行时）：模型生成代码的越界文件读写被内核拒绝、子进程默认禁用，把"约定式隔离"升级为"强制式隔离"。
- 设计多次跑分可靠性度量（pass@R + 方差 + flaky 归因）与成本/时限预算护栏；据此定位开放式任务的终止缺陷并实现"交付物兜底"，将套件可靠性从 98.5%±2.1% 提升至 100%±0%。
- 用消融实验量化每个机制的贡献（护栏 ≈ +4.5% 可靠性、压缩 ≈ −4% prompt token、沙箱与能力正交）；编写 80 项离线自检并配置 GitHub Actions CI。

## 中文 · 精简版（2 条）

- 独立实现零依赖 TS Agent Harness：OS 强制沙箱、上下文压缩+断点续跑、独立判分、MCP 客户端；22 任务套件真实跑分定位并修复 4 个跨层缺陷。
- 设计 pass@R/方差/失败归因可靠性度量与成本护栏，用消融实验量化各机制贡献，将套件可靠性从 98.5%±2.1% 提升至 100%±0%；80 项自检 + CI 全绿。

## English · Full

- Built an agent harness with a closed-loop evaluation (zero-dependency TypeScript): sandboxed tool loop, context compaction with checkpoint/resume, independent auto-graders, an MCP (Model Context Protocol) client, and a trajectory replay viewer; model-agnostic provider layer for any OpenAI-compatible endpoint.
- Implemented OS-enforced isolation via Node's permission model (out-of-workspace fs access and child processes denied at runtime).
- Introduced repeated-run reliability metrics (pass@R + variance + flaky attribution) and cost/latency budget enforcement; used them to find a termination defect and ship a deliverable-completion guardrail, lifting suite reliability from 98.5%±2.1% to 100%±0%.
- Ran an ablation study quantifying each mechanism's contribution (guardrail ≈ +4.5% reliability, compaction ≈ −4% prompt tokens, sandbox orthogonal to capability); surfaced and fixed 4 cross-layer bugs via live evals; 80 offline assertions gated by GitHub Actions CI.

## 面试话术 / 追问应对

- **"含金量在哪？"** 不是调 API，是三层硬核：OS 强制沙箱、上下文压缩+续跑、可复现评测闭环；且每项都能拿数据说话。
- **"最难的 bug？"** 讲 tool_calls 序列化：mock 测不出、真实 API 才 422 —— 正好论证"为什么必须有评测闭环"。
- **"你怎么证明改进有效？"** 讲消融：把护栏单独关掉，g01 从 3/3 回退到 2/3（max_turns），量化出它值 +4.5%。
- **"局限？"** 诚实说：关沙箱对通过率中性（安全≠能力）；g01 靠产物判分兜底、模型仍不主动 finish；进程级沙箱不控网络、Python 侧无对等隔离。能讲局限比只报喜更可信。
