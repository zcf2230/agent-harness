import fs from 'node:fs';
import path from 'node:path';
import type { ChatProvider, RunState, TaskDef } from '../types.ts';
import type { HarnessConfig } from '../config.ts';
import { computeCost } from '../config.ts';
import { RunLog } from '../agent/checkpoint.ts';
import { newRunState, runAgent } from '../agent/loop.ts';
import { safeResolve } from '../agent/sandbox.ts';
import type { McpBridge } from '../mcp/bridge.ts';
import { gradeTask } from './grade.ts';
import { batchTs, fmtSec, padCell, slug, uid } from '../util.ts';

export interface TaskRecord {
  task_id: string;
  name: string;
  category: string;
  difficulty: string;
  pass: boolean;
  status: string;
  detail: string;
  turns: number;
  compactions: number;
  prompt_tokens: number;
  completion_tokens: number;
  cost: number;
  duration_s: number;
  answer: string | null;
  run_dir: string;
}

export function setupWorkspace(task: TaskDef, workspace: string): void {
  fs.mkdirSync(workspace, { recursive: true });
  for (const f of task.workspace_files ?? []) {
    const abs = safeResolve(workspace, f.path);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, f.content, 'utf8');
  }
}

export function createRunDir(cfg: HarnessConfig, batchDir: string, taskId: string, taskName: string): string {
  return path.join(batchDir, `${taskId}-${slug(taskName)}-${uid(4)}`);
}

export async function executeTask(opts: {
  task: TaskDef;
  provider: ChatProvider;
  cfg: HarnessConfig;
  runDir: string;
  mcp?: McpBridge | null;
  print?: (s: string) => void;
  resume?: boolean;
}): Promise<{ record: TaskRecord; state: RunState }> {
  const { task, cfg } = opts;
  const workspace = path.join(opts.runDir, 'workspace');
  const log = new RunLog(opts.runDir);
  let state: RunState;
  const startAt = Date.now();
  if (opts.resume && fs.existsSync(path.join(opts.runDir, 'state.json'))) {
    state = RunLog.loadState(opts.runDir);
    log.event('resume', { from: state.started_at, turn: state.turn });
    opts.print?.(`↺ 从回合 ${state.turn} 续跑`);
  } else {
    setupWorkspace(task, workspace);
    state = newRunState(task, cfg);
    log.event('run_start', {
      task_id: task.id,
      name: task.name,
      category: task.category,
      model: cfg.model,
      prompt: task.prompt,
      workspace,
    });
    log.saveState(state);
  }
  state = await runAgent({ provider: opts.provider, cfg, state, workspace, log, mcp: opts.mcp ?? null, print: opts.print });
  const graded = await gradeTask(task, workspace, state.answer, cfg);
  const duration_ms = Date.now() - startAt;
  const record: TaskRecord = {
    task_id: task.id,
    name: task.name,
    category: task.category,
    difficulty: task.difficulty ?? 'easy',
    pass: graded.pass,
    status: state.status,
    detail: graded.detail,
    turns: state.turn,
    compactions: state.compactions,
    prompt_tokens: state.usage.prompt_tokens,
    completion_tokens: state.usage.completion_tokens,
    cost: computeCost(state.usage, cfg),
    duration_s: Math.round((duration_ms / 1000) * 10) / 10,
    answer: state.answer,
    run_dir: opts.runDir,
  };
  log.event('graded', { pass: record.pass, detail: record.detail });
  return { record, state };
}

async function pool<T, R>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

export interface EvalOptions {
  tasks: TaskDef[];
  providerFactory: () => ChatProvider;
  cfg: HarnessConfig;
  concurrency: number;
  mcp?: McpBridge | null;
  batchDir?: string;
  quiet?: boolean;
}

export async function evalSuite(o: EvalOptions): Promise<{ batchDir: string; records: TaskRecord[] }> {
  const batchDir = o.batchDir ?? path.join(o.cfg.runsDir, `eval-${batchTs()}`);
  fs.mkdirSync(batchDir, { recursive: true });
  const started = Date.now();
  const total = o.tasks.length;
  let done = 0;
  const records = await pool(o.tasks, o.concurrency, async (task) => {
    const provider = o.providerFactory();
    const runDir = createRunDir(o.cfg, batchDir, task.id, task.name);
    const print = o.quiet ? undefined : (s: string) => process.stdout.write(`  [${task.id}] ${s}\n`);
    const { record } = await executeTask({ task, provider, cfg: o.cfg, runDir, mcp: o.mcp ?? null, print });
    done++;
    const flag = record.pass ? '通过' : '失败';
    process.stdout.write(
      `${done}/${total} ${padCell(task.id, 6)}${padCell(task.category, 10)}${padCell(flag, 6)} ` +
        `回合=${record.turns} 耗时=${fmtSec(record.duration_s * 1000)} 费用=${record.cost.toFixed(4)}${o.cfg.currency}\n`
    );
    if (!record.pass) process.stdout.write(`      ↳ ${record.detail.slice(0, 160)}\n`);
    return record;
  });
  const passCount = records.filter((r) => r.pass).length;
  const summary = {
    generated_at: new Date().toISOString(),
    model: o.cfg.model,
    total: records.length,
    passed: passCount,
    pass_rate: Math.round((passCount / Math.max(1, records.length)) * 1000) / 10,
    total_cost: Math.round(records.reduce((s, r) => s + r.cost, 0) * 1e6) / 1e6,
    total_duration_s: Math.round((Date.now() - started) / 100) / 10,
    compactions: records.reduce((s, r) => s + r.compactions, 0),
    by_category: breakdown(records, (r) => r.category),
    by_difficulty: breakdown(records, (r) => r.difficulty),
    tasks: records,
  };
  fs.writeFileSync(path.join(batchDir, 'summary.json'), JSON.stringify(summary, null, 2));
  process.stdout.write(
    `\n===== 评测汇总 =====\n通过率 ${passCount}/${records.length}（${summary.pass_rate}%） ` +
      `总费用 ${summary.total_cost}${o.cfg.currency} 总耗时 ${fmtSec(Date.now() - started)} ` +
      `→ ${path.join(batchDir, 'summary.json')}\n`
  );
  process.stdout.write('按难度：' + fmtBreakdown(summary.by_difficulty) + '\n');
  process.stdout.write('按类别：' + fmtBreakdown(summary.by_category) + '\n');
  return { batchDir, records };
}

function breakdown(records: TaskRecord[], key: (r: TaskRecord) => string): Record<string, { pass: number; total: number; rate: number }> {
  const map: Record<string, { pass: number; total: number }> = {};
  for (const r of records) {
    const k = key(r);
    map[k] = map[k] ?? { pass: 0, total: 0 };
    map[k].total++;
    if (r.pass) map[k].pass++;
  }
  const out: Record<string, { pass: number; total: number; rate: number }> = {};
  for (const [k, v] of Object.entries(map)) {
    out[k] = { pass: v.pass, total: v.total, rate: Math.round((v.pass / v.total) * 1000) / 10 };
  }
  return out;
}

function fmtBreakdown(b: Record<string, { pass: number; total: number; rate: number }>): string {
  return Object.entries(b)
    .map(([k, v]) => `${k} ${v.pass}/${v.total}(${v.rate}%)`)
    .join('  ');
}

export interface BenchTaskStat {
  task_id: string;
  name: string;
  category: string;
  difficulty: string;
  passes: number;
  runs: number;
  pass_rate: number;
  mean_turns: number;
  mean_cost: number;
  flaky: boolean;
}

export interface BenchOptions {
  tasks: TaskDef[];
  providerFactory: () => ChatProvider;
  cfg: HarnessConfig;
  concurrency: number;
  runs: number;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function populationStd(xs: number[]): number {
  if (!xs.length) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

export async function runBench(o: BenchOptions): Promise<{ dir: string; stats: BenchTaskStat[]; perRunRates: number[]; mean: number; std: number }> {
  const dir = path.join(o.cfg.runsDir, `bench-${batchTs()}`);
  fs.mkdirSync(dir, { recursive: true });
  const allRecords: TaskRecord[][] = [];
  for (let r = 0; r < o.runs; r++) {
    process.stdout.write(`\n===== 第 ${r + 1}/${o.runs} 轮 =====\n`);
    const { records } = await evalSuite({
      tasks: o.tasks,
      providerFactory: o.providerFactory,
      cfg: o.cfg,
      concurrency: o.concurrency,
      batchDir: path.join(dir, `run-${r + 1}`),
      quiet: true,
    });
    allRecords.push(records);
  }

  const byId = new Map<string, TaskRecord[]>();
  for (const run of allRecords) {
    for (const rec of run) {
      let arr = byId.get(rec.task_id);
      if (!arr) {
        arr = [];
        byId.set(rec.task_id, arr);
      }
      arr.push(rec);
    }
  }

  const stats: BenchTaskStat[] = [];
  for (const [id, recs] of byId) {
    const passes = recs.filter((r) => r.pass).length;
    const runs = recs.length;
    stats.push({
      task_id: id,
      name: recs[0].name,
      category: recs[0].category,
      difficulty: recs[0].difficulty,
      passes,
      runs,
      pass_rate: Math.round((passes / runs) * 1000) / 10,
      mean_turns: Math.round(mean(recs.map((r) => r.turns)) * 10) / 10,
      mean_cost: Math.round(mean(recs.map((r) => r.cost)) * 1e6) / 1e6,
      flaky: passes > 0 && passes < runs,
    });
  }
  stats.sort((a, b) => a.task_id.localeCompare(b.task_id));

  const perRunRates = allRecords.map((recs) => Math.round((recs.filter((r) => r.pass).length / recs.length) * 1000) / 10);
  const m = Math.round(mean(perRunRates) * 10) / 10;
  const sd = Math.round(populationStd(perRunRates) * 10) / 10;
  const flaky = stats.filter((s) => s.flaky).map((s) => s.task_id);

  const bench = {
    generated_at: new Date().toISOString(),
    model: o.cfg.model,
    runs: o.runs,
    total_tasks: stats.length,
    mean_pass_rate: m,
    std_pass_rate: sd,
    per_run_pass_rate: perRunRates,
    flaky_tasks: flaky,
    total_cost: Math.round(allRecords.flat().reduce((s, r) => s + r.cost, 0) * 1e6) / 1e6,
    tasks: stats,
  };
  fs.writeFileSync(path.join(dir, 'bench.json'), JSON.stringify(bench, null, 2));

  process.stdout.write(`\n===== 可靠性曲线（runs=${o.runs}）=====\n`);
  process.stdout.write(`每轮通过率：${perRunRates.join('%  ')}%   →  均值 ${m}% ± 标准差 ${sd}%\n`);
  process.stdout.write(`flaky（非全过全败）任务：${flaky.length ? flaky.join(', ') : '无'}\n`);
  process.stdout.write(`${padCell('任务', 6)}${padCell('难度', 7)}${padCell('pass@' + o.runs, 9)}${padCell('均回合', 7)}费用\n`);
  for (const s of stats) {
    const flag = s.flaky ? ' ⚠' : '';
    process.stdout.write(
      `${padCell(s.task_id, 6)}${padCell(s.difficulty, 7)}${padCell(`${s.passes}/${s.runs}(${s.pass_rate}%)`, 9)}${padCell(String(s.mean_turns), 7)}${s.mean_cost.toFixed(4)}${o.cfg.currency}${flag}\n`
    );
  }
  process.stdout.write(`→ ${path.join(dir, 'bench.json')}\n`);
  return { dir, stats, perRunRates: perRunRates, mean: m, std: sd };
}
