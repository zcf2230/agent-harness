# Agent Harness — 带评测闭环的 DeepSeek Agent 运行时

[![CI](https://github.com/zcf2230/agent-harness/actions/workflows/ci.yml/badge.svg)](https://github.com/zcf2230/agent-harness/actions/workflows/ci.yml)

一个零依赖的 TypeScript 命令行 harness：让模型在受沙箱约束的环境里多轮调用工具完成任务，
并用**独立判分器 + 自动评测**量化 agent 的真实能力（通过率 / 回合数 / token 成本）。

核心主张：**模型决定上限，harness 决定下限。** 这个项目做的不是"调 API"，而是把 agent
从演示品变成可运维、可度量、可复盘的系统。

## 快速开始

要求 Node.js ≥ 23.6（直接运行 TypeScript，无构建步骤、无第三方依赖）。

```bash
# 离线自检：不需要 API key，验证沙箱/压缩/续跑/判分全链路
node src/cli.ts selftest

# 配置 key（二选一）：环境变量 DEEPSEEK_API_KEY，或复制 config.example.json → config.json
node src/cli.ts tasks                 # 查看内置 22 个任务（12 基础 + 10 困难）
node src/cli.ts run --task c01        # 跑单个任务（自动判分）
node src/cli.ts eval --all --yes      # 并发跑全部任务，产出 summary.json
node src/cli.ts bench --all --runs 3  # 重复跑分，产出 pass@R / 方差 / flaky 任务
node src/cli.ts ablate --all --yes    # 消融实验：逐一关机制，量化各自贡献
node src/cli.ts run --resume runs/... # 从 checkpoint 续跑中断的任务
node src/cli.ts mcp                   # 查看已连接的 MCP 工具（需在 config.json 配置）
node src/cli.ts eval --all --mock     # 用内置 Mock 模型离线演示整条链路
```

跑完把运行目录里的 `trajectory.jsonl` 拖进 `viewer/replay.html`，逐回合回放执行过程。

## 架构

```
src/
├── cli.ts                 命令入口（run / eval / tasks / selftest）
├── config.ts              配置加载 + token 费用核算
├── types.ts               共享类型（消息、任务、判分规则、运行状态）
├── providers/
│   ├── openai.ts          OpenAI 兼容 provider（DeepSeek 默认）：指数退避重试
│   └── mock.ts            可编程 Mock provider：离线测试整条 agent 链路
├── agent/
│   ├── loop.ts            主循环：决策→执行→回填，finish 止损，轮数上限
│   ├── tools.ts           7 个工具：读写/列目录/搜索/run_js/run_py/finish
│   ├── sandbox.ts         执行沙箱：工作区路径封锁、超时 SIGKILL、输出上限
│   ├── context.ts         上下文管理：token 估算 + 按回合分组的 LLM 压缩
│   └── checkpoint.ts      trajectory.jsonl 事件流 + state.json 原子快照
├── mcp/
│   ├── client.ts          MCP 客户端：stdio 上的 JSON-RPC + initialize 握手
│   ├── bridge.ts          多服务器桥接：工具命名空间化 + 按名路由
│   └── test-server.ts     离线测试用最小 MCP 服务器（add / echo）
├── eval/
│   ├── grade.ts           4 类独立判分器 + 任务加载
│   ├── runner.ts          并发池、逐任务隔离工作区、汇总报告
│   └── (tasks/*.json)     声明式任务：提示词 + 初始文件 + 判分规则
└── selftest.ts            80 项离线断言，不联网验证全部机制
```

## 六个设计要点（也是难点）

### 1. 安全边界：OS 强制的进程级沙箱
- 所有文件工具只接受**工作区相对路径**，`safeResolve` 统一做 `..`、绝对路径、
  Windows 盘符、UNC 路径的越界检查（模型给了恶意路径也只是返回错误文本，不会崩溃）；
- `run_js` / `run_py` 走 `execFile`（非 shell，避免命令注入），SIGKILL 超时、
  输出字节上限；判分命令里的 `node` 统一重映射为 `process.execPath`，
  `python` 重映射为配置的绝对路径，屏蔽 PATH 环境差异。
- **关键升级**：模型生成的代码本身能 `import fs` 绕过工具层的路径约定。因此 `run_js`
  现在在 Node 的 **permission model** 下执行（`--permission --allow-fs-read/write=<workspace>`），
  由**运行时强制**把文件读写关进工作区——越界读写抛 `ERR_ACCESS_DENIED`，`child_process`
  默认也被禁。selftest 用"模型代码尝试读写工作区外"直接验证这一边界。
- 诚实标注残留：Node 权限模型不拦截网络；`run_py` 无对等的零依赖沙箱（Python 侧仍是
  工具层路径约束 + 超时）。升级路径是容器/沙箱后端（见 Roadmap）。

### 2. 上下文管理：压缩而不是截断
- token 估算按"CJK 字符 ≈ 1 token、ASCII ≈ 4 字符 1 token"的启发式，并优先采用
  API 返回的真实 `prompt_tokens` 作为水位判断；
- 压缩以**回合**为原子单位（assistant 消息 + 其全部 tool 结果为一组），保证任何时刻
  发给 API 的消息序列都是合法的工具调用配对；
- 摘要由模型生成（要求保留文件名/数字等可验证锚点），摘要调用失败时退化为
  规则式 digest，压缩带 120s 超时，超时则跳过本轮压缩——压缩永不阻塞主流程；
- 若压缩后 token 反而变大（no-benefit），放弃压缩。

### 3. 可恢复性：事件溯源 + 原子快照
- 每个事件（消息/工具执行/压缩/判分）即时追加进 `trajectory.jsonl`（只追加，永不改写），
  既是回放数据源，也是审计日志；
- 每回合结束把完整状态原子写入 `state.json`（tmp 文件 + rename），断电/崩溃后
  `run --resume <目录>` 从最后一个完整回合继续，不浪费已花的钱。

### 4. 评测闭环：判分器独立于模型
- 4 类判分规则：`answer_regex` / `answer_number`（容差）/ `file_regex` /
  `run_test`（真实执行验收测试，看退出码与 stdout）；
- 22 个内置任务覆盖 7 类能力（JS/Python 编码、数学、多步工具链、文本压缩，及带难度标注的
  hard-* 前沿任务）：off-by-one 缺陷、深层配置检索、隐藏标记、多约束配置、跨文件去重聚合、
  干扰分支寻路、大数模运算、迭代搜索，以及专门压测上下文压缩的长链任务；
  失败归因写进 summary.json；
- 并发池隔离运行：每个任务独立工作区目录，任务间零共享状态；
- 成本核算逐任务累计（输入/输出分开计价），报告输出通过率、总费用、压缩次数。
- 关键原则：判分器绝不使用被评测的模型，避免"模型给自己打分"的系统性虚高。

### 5. 工具生态：MCP 客户端（stdio / JSON-RPC 2.0）
- 手写 MCP 客户端，不依赖官方 SDK：在子进程 stdin/stdout 上做**换行分隔的 JSON-RPC**，
  完成 `initialize` → `notifications/initialized` → `tools/list` → `tools/call` 全流程；
- 请求按自增 id 关联响应，带超时；进程退出时统一 reject 所有在途请求，不会悬挂；
- 多个服务器工具**命名空间化**为 `<server>__<tool>` 注入主循环，与内置工具共用同一条
  决策—执行链路；调用结果按 MCP 的 `content[]` / `isError` 归一成 harness 的 ToolResult；
- 单个服务器连接失败只标记该 server `ok:false` 并继续，不拖垮整批评测（优雅降级）。

### 6. 可靠性：停滞检测与"交付物兜底"（用真实跑分发现、再用数据验证修复）
- **重复动作检测**：连续两回合发出完全相同的工具调用（`name:args` 签名一致）判定为停滞，
  在工具返回里注入告警，打断空转；
- **收尾轻推**：进入预算最后 1 回合时注入一次"若已完成请立即 finish"的提醒；
- **交付物兜底（关键）**：harness 从任务的判分规则反推**要求的输出文件**（`file_regex.path`），
  若在预算最后 25% 仍缺失，就定向提醒"立即用 write_file 生成这些文件，否则判分会因缺文件失败"。
  这是对症修复——真实 bench 里 g01 的失败**不是不 finish，而是模型空转到从没写出文件**；
- 效果可量化：加此机制前 g01 `pass@3=2/3`、整体 `98.5%±2.1%`；加后 g01 `3/3`、整体 `100%±0%`、
  flaky 清空。诚实残留：g01 三轮仍 `max_turns`（模型依旧不主动收尾），但交付物已落盘→产物判分通过；
  代价是 g01 回合/费用偏高（0.061¥），即"可靠性上去了、效率仍是短板"，这本身是下一轮优化方向。

## 使用 MCP 工具

在 `config.json` 声明 `mcpServers`（`command` + `args` 启动一个 stdio MCP 服务器），
`run` / `eval` 会自动连接并把其工具暴露给模型；`mcp` 命令用于查看已连接的工具：

```bash
node src/cli.ts mcp                       # 列出各 MCP 服务器及其工具
node src/cli.ts run --prompt "用 add 工具算 20+22"   # 模型可直接调用 calc__add
```

内置 `src/mcp/test-server.ts`（提供 add / echo）可作为接入模板，无需外部依赖即可跑通。

## 扩展方式

- **加任务**：在 `tasks/` 放一个 JSON（id/prompt/workspace_files/grade），无需改代码；
- **换模型**：任何 OpenAI 兼容端点改 `baseUrl`/`model` 即可（支持 DeepSeek 的
  prefix caching 计费字段可扩展进 usage 统计）；
- **加工具**：`tools.ts` 里加 spec + 一个 case；
- **Mock 驱动测试**：`MockProvider(plan)` 可编程返回任意回合脚本，用于回归测试。

## 实测结果（deepseek-chat，2026-09-24，并发 4）

评测闭环不是摆设——**真实跑分抓出了 4 个 mock 测不出的 bug**，也暴露了模型的真实边界：

| 现象 | 只有真实 API 才暴露？ | 结论 |
|---|---|---|
| `run_js` 相对路径叠加 cwd → 路径重复 | 是 | 修 `runScript` 用绝对路径 |
| assistant `tool_calls` 扁平回传 → DeepSeek 422 | 是（mock 不校验 wire） | 加 `toWire` 还原嵌套 function 结构 |
| c01 任务期望正则把第 26 行误写为 Fizz | 判分笔误 | 修任务；教训：判分器需独立 gold 自校验 |
| `answer_number` 取"末位数字"被中间量带偏 | 真实答案格式才触发 | 改为"含正确值即通过" |

**判分器自校验**：每个任务都先用"标准答案 + 负例"离线跑一遍判分（`gradeTask`），确保
任务本身没写错再上线——正是这一步发现了上面两个判分 bug。

**通过率与前沿**：多轮全量跑分稳定在 **20–22 / 22**，`hard` 类基本全过。真正的失败前沿
不在知识难度，而在 **agent 可靠性**：
- 唯一开放式任务 g01（摘要）会**间歇性 `max_turns`**——模型过度迭代、迟迟不调用 `finish`，
  白烧到回合上限（单任务费用是其它任务的 4 倍）。这暴露了"何时收手"是当前模型的弱点；
- 结果**非确定**：同一套任务多次跑分会在 100% 与 95% 间波动（temperature 0.2 下 g01 时好时坏），
  印证了 agent 评测必须**多次跑分看分布**，单次通过率数字不可全信。

**可靠性曲线（`bench` 命令，把非确定性变成一等指标）**：`node src/cli.ts bench --all --runs 3`
把全量任务重复跑 R 轮，输出每轮通过率、均值±标准差、以及逐任务 `pass@R` 与 `flaky` 标记：

```
修复前  每轮通过率：100%  100%  95.5%  →  均值 98.5% ± 标准差 2.1%   flaky：g01(pass@3 2/3, 均回合 8.7)
修复后  每轮通过率：100%  100%  100%   →  均值 100%  ± 标准差 0%     flaky：无（g01 → 3/3）
```

即：**用 bench 的方差/flaky 指标定位到 g01 的终止缺陷 → 加"交付物兜底"机制（设计要点 6）→
重跑 bench 测得 g01 从 2/3 升到 3/3、整体从 98.5%±2.1% 到 100%±0%。** 这是一条完整的
"发现→归因→修复→量化验证"闭环，也正是"多次跑分 + 方差 + flaky 归因"相比"单次通过率"多出来的信息量。
诚实残留：g01 三轮仍 `max_turns`（模型依旧不主动 finish），只是交付物已被逼着落盘、产物判分才通过——
可靠性补上了，效率（g01 现 0.061¥）仍是下一步要优化的短板。

**上下文压缩被真实触发并验证保真**：`x10 长链压缩保真`（不透明 8 跳链 + 600 token 预算）
在真实模型上触发 `method=llm, dropped_groups=6` 的压缩，任务仍判分通过——证明压缩层在
保住关键锚点（各位数字）的前提下工作。同时也发现：模型会用 `run_js` 批量读文件**绕过**
预设的长程压力，说明"沙箱越开放，越难逼出上下文瓶颈"本身是 harness 设计要权衡的点。

**消融实验（`ablate` 命令，量化每个机制的贡献）**：`node src/cli.ts ablate --all --yes`
在同一 22 任务集上逐一关闭核心机制，对照如下（deepseek-chat 真实跑分）：

| 配置 | 通过率 | 均回合 | 均 prompt tok | 失败归因 |
|---|---|---|---|---|
| baseline（全开） | 22/22 (100%) | 4.2 | 8361 | — |
| no_compaction | 22/22 | 4.6 | 8692 (+4%) | — |
| no_guardrail | 21/22 (95.5%) | 4.7 | 8754 | max_turns×1 |
| no_sandbox | 21/22 | 4.1 | 7709 | max_turns×1 |

诚实解读：**关"收尾/交付物兜底"→ g01 回退 max_turns**，证明护栏贡献约 +4.5% 可靠性；
**关压缩→通过率不变但 prompt token +4%、回合上升**，其价值在上下文效率而非通过率；
**关沙箱对通过率中性**（安全属性≠任务能力，那 1 例是模型方差，非因果）。
——这张表说明"每个机制值多少"，而不是只堆功能。

**成本/时限护栏与失败归因**：`maxCostPerTask` / `deadlineMs`（可按任务覆盖）在超限时以
`stop_reason=max_cost|deadline` 优雅早停，防止自主 agent 跑飞烧钱；`summary.json` 输出
`failure_reasons` 直方图（max_turns / provider_error / missing_deliverable / wrong_answer /
grader_mismatch），把"为什么失败"从口头变成数据。

> 简历叙事：不是"我做了个能跑分的脚本"，而是"我构建了带独立判分、成本护栏与失败归因的
> agent 评测闭环，用真实跑分定位并修复 4 个跨层 bug，并用消融实验量化了每个机制的贡献"。

## Roadmap

- [x] MCP 协议支持（已作为 client 接入外部工具生态，见设计要点 5）
- [ ] MCP 服务端能力（把本 harness 的工具反向暴露为 MCP server）
- [ ] Docker 沙箱后端（当前进程级隔离之上抽象 ExecBackend 接口）
- [ ] DeepSeek cache-hit token 计费统计
- [ ] 网页化实时面板（SSE 推送事件流替代事后回放）

## 自检覆盖（80 项断言）

路径越界拒绝 ×4 · 工具执行/失败捕获/Node 权限沙箱越界读写 ×10 · token 估算与回合分组 ×3 ·
压缩有效性/锚点保留/失败兜底/无收益放弃 ×6 · checkpoint 读写与事件流 ×3 ·
主循环完成/超限止损/断点续跑/收尾轻推/交付物兜底 ×12 · OpenAI wire 序列化 ×4 ·
成本/墙钟预算止损 ×2 · Provider 429 重试/400 不重试/MCP JSON-RPC 错误 ×3 ·
MCP 握手/列工具/调用/命名空间/失败降级/agent 经 MCP ×13 · 判分器 ×8 · 评测端到端与消融聚合 ×8

```bash
node src/cli.ts selftest   # 全绿即核心机制可信（含 MCP，全程离线）
```
