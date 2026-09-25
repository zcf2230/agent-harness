import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import type { TaskDef } from './types.ts';
import { loadConfig, computeCost } from './config.ts';
import { OpenAIProvider } from './providers/openai.ts';
import { MockProvider } from './providers/mock.ts';
import { RunLog } from './agent/checkpoint.ts';
import { runAgent } from './agent/loop.ts';
import { connectMcpServers, emptyMcpBridge, type McpBridge } from './mcp/bridge.ts';
import { loadTasks } from './eval/grade.ts';
import { executeTask, createRunDir } from './eval/runner.ts';
import { batchTs } from './util.ts';

function parseArgs(argv: string[]): { _: string[]; opts: Record<string, string | boolean> } {
  const opts: Record<string, string | boolean> = {};
  const _: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next != null && !next.startsWith('--')) {
        opts[key] = next;
        i++;
      } else {
        opts[key] = true;
      }
    } else {
      _.push(a);
    }
  }
  return { _, opts };
}

const HELP = `DeepSeek Agent Harness

用法：
  node src/cli.ts tasks                        列出内置任务
  node src/cli.ts run --task <id>              运行单个任务（自动判分）
  node src/cli.ts run --prompt "..."           运行一次性自由任务
  node src/cli.ts run --resume <run目录>       从 checkpoint 续跑中断的任务
  node src/cli.ts eval --all                   并发运行全部任务并出汇总报告
  node src/cli.ts eval --task c01,m01          只跑指定任务
  node src/cli.ts eval --category code-js      只跑指定类别
  node src/cli.ts bench --all --runs 3         多次跑分，产出 pass@R 与方差，识别 flaky 任务
  node src/cli.ts ablate --all                 消融实验：逐一关闭核心机制，量化各自贡献
  node src/cli.ts mcp                          连接并列出 config.json 中配置的 MCP 工具
  node src/cli.ts selftest                     离线自检（不需要 API key）

通用选项：
  --mock            使用内置 Mock 模型（离线验证整条链路）
  --concurrency n   评测并发数，默认 4
  --runs n          bench 重复轮数，默认 3
  --yes             跳过确认提示

API key：环境变量 DEEPSEEK_API_KEY 或 config.json 的 apiKey 字段。
MCP：在 config.json 的 mcpServers 里声明 { command, args }，run/eval 会自动接入。`;

function filterTasks(tasks: TaskDef[], opts: Record<string, string | boolean>): TaskDef[] {
  let out = tasks;
  if (typeof opts.task === 'string') {
    const ids = new Set(opts.task.split(',').map((s) => s.trim()));
    out = out.filter((t) => ids.has(t.id));
  }
  if (typeof opts.category === 'string') {
    out = out.filter((t) => t.category === opts.category);
  }
  return out;
}

async function main() {
  const { _, opts } = parseArgs(process.argv.slice(2));
  const cmd = _[0] ?? 'help';
  const cwd = process.cwd();
  const cfg = loadConfig(cwd);
  const tasksDir = path.join(cwd, 'tasks');

  if (cmd === 'help' || opts.help) {
    console.log(HELP);
    return;
  }

  if (cmd === 'tasks') {
    const tasks = loadTasks(tasksDir);
    for (const t of tasks) {
      console.log(`${t.id.padEnd(6)} ${t.category.padEnd(10)} ${t.name}`);
    }
    console.log(`共 ${tasks.length} 个任务`);
    return;
  }

  if (cmd === 'selftest') {
    await import('./selftest.ts');
    return;
  }

  if (cmd === 'run') {
    const provider = opts.mock ? new MockProvider() : newOpenAI(cfg);
    const mcp = await maybeConnectMcp(cfg);
    try {
      if (typeof opts.resume === 'string') {
        const runDir = path.resolve(opts.resume);
        const state = RunLog.loadState(runDir);
        console.log(`续跑 ${state.task_id}（上次中断于回合 ${state.turn}，状态 ${state.status}）`);
        const log = new RunLog(runDir);
        log.event('resume', { turn: state.turn });
        const next = await runAgent({
          provider,
          cfg,
          state,
          workspace: path.join(runDir, 'workspace'),
          log,
          mcp,
          print: (s) => console.log(s),
        });
        printResult(next.task_id, next.answer, next.status, next.stop_reason, next);
        return;
      }
      let task: TaskDef;
      if (typeof opts.task === 'string') {
        const found = loadTasks(tasksDir).find((t) => t.id === opts.task);
        if (!found) {
          console.error(`找不到任务: ${opts.task}（用 tasks 命令查看列表）`);
          process.exit(2);
        }
        task = found;
      } else if (typeof opts.prompt === 'string') {
        task = {
          id: `custom-${batchTs()}`,
          name: '自由任务',
          category: 'custom',
          prompt: `任务：${opts.prompt}`,
        };
      } else {
        console.error('run 需要 --task <id>、--prompt "..." 或 --resume <目录>');
        process.exit(2);
      }
      const batchDir = path.join(cfg.runsDir, `run-${batchTs()}`);
      const runDir = createRunDir(cfg, batchDir, task.id, task.name);
      const { record } = await executeTask({
        task,
        provider,
        cfg,
        runDir,
        mcp,
        print: (s) => console.log(s),
      });
      console.log(`\n[${record.task_id}] 状态=${record.status} 回合=${record.turns} 费用=${record.cost.toFixed(4)}${cfg.currency}`);
      if (task.grade) console.log(`判分: ${record.pass ? '通过' : '未通过'} — ${record.detail}`);
      console.log(`答案: ${record.answer ?? '（无）'}\n轨迹: ${path.join(runDir, 'trajectory.jsonl')}`);
    } finally {
      await mcp.close();
    }
    return;
  }

  if (cmd === 'mcp') {
    const mcp = await connectMcpServers(cfg.mcpServers);
    if (mcp.servers.length === 0) {
      console.log('config.json 未配置 mcpServers。示例：\n' + JSON.stringify({ mcpServers: { calc: { command: process.execPath, args: ['src/mcp/test-server.ts'] } } }, null, 2));
    }
    for (const s of mcp.servers) {
      console.log(`${s.ok ? '✓' : '✗'} ${s.key}：${s.tools.length} 个工具${s.ok ? ' → ' + s.tools.join(', ') : ' 失败: ' + s.error}`);
    }
    for (const spec of mcp.specs) {
      console.log(`  · ${spec.name} — ${spec.description}`);
    }
    await mcp.close();
    return;
  }

  if (cmd === 'eval') {
    const all = loadTasks(tasksDir);
    const selected = opts.all === true ? all : filterTasks(all, opts);
    if (selected.length === 0) {
      console.error('没有匹配的任务（--all / --task id,id / --category 名称）');
      process.exit(2);
    }
    if (!opts.mock && !opts.yes) {
      console.log(`将真实调用 ${cfg.model} API，共 ${selected.length} 个任务。用 --yes 跳过本提示，或加 --mock 离线演示。`);
      process.exit(3);
    }
    const { evalSuite } = await import('./eval/runner.ts');
    const concurrency = typeof opts.concurrency === 'string' ? parseInt(opts.concurrency, 10) || 4 : 4;
    const mcp = await maybeConnectMcp(cfg);
    try {
      await evalSuite({
        tasks: selected,
        providerFactory: () => (opts.mock ? new MockProvider() : newOpenAI(cfg)),
        cfg,
        concurrency,
        mcp,
      });
    } finally {
      await mcp.close();
    }
    return;
  }

  if (cmd === 'bench') {
    const all = loadTasks(tasksDir);
    const selected = opts.all === true ? all : filterTasks(all, opts);
    if (selected.length === 0) {
      console.error('没有匹配的任务（--all / --task id,id / --category 名称）');
      process.exit(2);
    }
    const runs = typeof opts.runs === 'string' ? parseInt(opts.runs, 10) || 3 : 3;
    if (!opts.mock && !opts.yes) {
      console.log(`将真实调用 ${cfg.model} API，共 ${selected.length} 任务 × ${runs} 轮 = ${selected.length * runs} 次执行。用 --yes 跳过，或加 --mock 离线演示。`);
      process.exit(3);
    }
    const { runBench } = await import('./eval/runner.ts');
    const concurrency = typeof opts.concurrency === 'string' ? parseInt(opts.concurrency, 10) || 4 : 4;
    const mcp = await maybeConnectMcp(cfg);
    try {
      await runBench({
        tasks: selected,
        providerFactory: () => (opts.mock ? new MockProvider() : newOpenAI(cfg)),
        cfg,
        concurrency,
        runs,
      });
    } finally {
      await mcp.close();
    }
    return;
  }

  if (cmd === 'ablate') {
    const all = loadTasks(tasksDir);
    const selected = opts.all === true ? all : filterTasks(all, opts);
    if (selected.length === 0) {
      console.error('没有匹配的任务（--all / --task id,id / --category 名称）');
      process.exit(2);
    }
    const runs = typeof opts.runs === 'string' ? parseInt(opts.runs, 10) || 1 : 1;
    if (!opts.mock && !opts.yes) {
      console.log(`消融将跑 ${4} 配置 × ${selected.length} 任务 × ${runs} 轮 = ${4 * selected.length * runs} 次真实调用。用 --yes 跳过，或 --mock 离线演示。`);
      process.exit(3);
    }
    const { runAblation } = await import('./eval/runner.ts');
    const concurrency = typeof opts.concurrency === 'string' ? parseInt(opts.concurrency, 10) || 4 : 4;
    const configs = [
      { name: 'baseline', note: '全部机制开启', override: {} },
      { name: 'no_compaction', note: '关上下文压缩', override: { compactEnabled: false } },
      { name: 'no_guardrail', note: '关收尾/交付物兜底', override: { terminationNudge: false } },
      { name: 'no_sandbox', note: '关 Node 权限沙箱', override: { sandboxNodePermission: false } },
    ];
    const mcp = await maybeConnectMcp(cfg);
    try {
      await runAblation({
        tasks: selected,
        providerFactory: () => (opts.mock ? new MockProvider() : newOpenAI(cfg)),
        cfg,
        concurrency,
        configs,
        runs,
      });
    } finally {
      await mcp.close();
    }
    return;
  }

  console.log(HELP);
}

async function maybeConnectMcp(cfg: ReturnType<typeof loadConfig>): Promise<McpBridge> {
  if (!cfg.mcpServers || Object.keys(cfg.mcpServers).length === 0) return emptyMcpBridge();
  const bridge = await connectMcpServers(cfg.mcpServers);
  for (const s of bridge.servers) {
    process.stdout.write(`MCP ${s.ok ? '✓' : '✗'} ${s.key}（${s.tools.length} 工具）${s.error ?? ''}\n`);
  }
  return bridge;
}

function newOpenAI(cfg: ReturnType<typeof loadConfig>) {
  if (!cfg.apiKey) {
    console.error('缺少 API key：设置环境变量 DEEPSEEK_API_KEY，或在 config.json 中填写 apiKey（参考 config.example.json）。');
    process.exit(2);
  }
  return new OpenAIProvider(cfg);
}

function printResult(id: string, answer: string | null, status: string, stopReason: string | null, state: { usage: { prompt_tokens: number; completion_tokens: number }; compactions: number }) {
  const cfg = loadConfig();
  console.log(`\n[${id}] 状态=${status} 原因=${stopReason ?? '-'} 压缩次数=${state.compactions}`);
  console.log(`token: ${state.usage.prompt_tokens}+${state.usage.completion_tokens} 费用≈${computeCost(state.usage, cfg).toFixed(4)}${cfg.currency}`);
  console.log(`答案: ${answer ?? '（无）'}`);
}

main().catch((e) => {
  console.error('运行失败:', e?.stack ?? e);
  process.exit(1);
});
