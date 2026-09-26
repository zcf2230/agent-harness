import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ChatProvider, RunState, TaskDef } from '../types.ts';
import type { HarnessConfig } from '../config.ts';
import { computeCost } from '../config.ts';
import { RunLog } from '../agent/checkpoint.ts';
import { newRunState, runAgent } from '../agent/loop.ts';
import { safeResolve } from '../agent/sandbox.ts';
import type { McpBridge } from '../mcp/bridge.ts';
import { gradeTask, requiredOutputFiles } from './grade.ts';
import { batchTs, fmtSec, padCell, slug, uid } from '../util.ts';

export interface TaskRecord {
  task_id: string;
  name: string;
  category: string;
  difficulty: string;
  pass: boolean;
  status: string;
  reason: string | null;
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

export function setupWorkspace(task: TaskDef, workspace: string): Set<string> {
  fs.mkdirSync(workspace, { recursive: true });
  const protectedPaths = new Set<string>();
  for (const f of task.workspace_files ?? []) {
    const abs = safeResolve(workspace, f.path);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, f.content, 'utf8');
    if (f.protected) {
      protectedPaths.add(f.path);
      try {
        fs.chmodSync(abs, 0o444);
      } catch {
        /* Windows 上 chmod 有限，write_file 层已拒绝覆写 */
      }
    }
  }
  return protectedPaths;
}

function hashFiles(workspace: string, files: Set<string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of files) {
    try {
      out[f] = crypto.createHash('sha256').update(fs.readFileSync(path.join(workspace, f))).digest('hex');
    } catch {
      out[f] = '<missing>';
    }
  }
  return out;
}

function tamperedFiles(workspace: string, baseline: Record<string, string>): string[] {
  return Object.entries(baseline)
    .filter(([f, h]) => {
      try {
        return crypto.createHash('sha256').update(fs.readFileSync(path.join(workspace, f))).digest('hex') !== h;
      } catch {
        return true;
      }
    })
    .map(([f]) => f);
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
  let protectedSet: Set<string> | undefined;
  let baselineHashes: Record<string, string> = {};
  const startAt = Date.now();
  if (opts.resume && fs.existsSync(path.join(opts.runDir, 'state.json'))) {
    state = RunLog.loadState(opts.runDir);
    log.event('resume', { from: state.started_at, turn: state.turn });
    opts.print?.(`↺ 从回合 ${state.turn} 续跑`);
    // 续跑同样要保住判分独立性：按任务定义重建 protectedSet，并以当前 protected 文件内容作哈希基线，
    // 这样续跑段内模型若改写验收脚本，仍会在下方 tamperedFiles 校验中被判 grader_tampered。
    protectedSet = new Set((task.workspace_files ?? []).filter((f) => f.protected).map((f) => f.path));
    baselineHashes = hashFiles(workspace, protectedSet);
  } else {
    const protectedPaths = setupWorkspace(task, workspace);
    state = newRunState(task, cfg);
    log.event('run_start', {
      task_id: task.id,
      name: task.name,
      category: task.category,
      model: cfg.model,
      prompt: task.prompt,
      workspace,
      protected: [...protectedPaths],
    });
    log.saveState(state);
    protectedSet = protectedPaths;
    baselineHashes = hashFiles(workspace, protectedPaths);
  }
  state = await runAgent({ provider: opts.provider, cfg, state, workspace, log, mcp: opts.mcp ?? null, requiredFiles: requiredOutputFiles(task), protectedPaths: protectedSet, print: opts.print });
  const tampered = protectedSet && protectedSet.size > 0 ? tamperedFiles(workspace, baselineHashes) : [];
  const graded = tampered.length > 0
    ? { pass: false, reason: 'grader_tampered' as const, detail: `验收文件被篡改：${tampered.join(', ')}（判分独立性受损，记为失败）` }
    : await gradeTask(task, workspace, state.answer, cfg);
  const duration_ms = Date.now() - startAt;
  const record: TaskRecord = {
    task_id: task.id,
    name: task.name,
    category: task.category,
    difficulty: task.difficulty ?? 'easy',
    pass: graded.pass,
    status: state.status,
    reason: graded.pass ? null : classifyFailure(state.status, graded.reason),
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

export interface AblationConfig {
  name: string;
  note: string;
  override: Partial<HarnessConfig>;
}

export interface AblationRow {
  name: string;
  note: string;
  runs: number;
  mean_pass_rate: number;
  median_pass_rate: number;
  min_pass_rate: number;
  mean_turns: number;
  mean_prompt_tokens: number;
  mean_cost: number;
  flaky_tasks: string[];
  // 配对统计：pooled 通过率的 Wilson 95% 置信区间（%），以及相对 baseline 的 McNemar 精确检验
  wilson_ci?: [number, number];
  mcnemar?: { vs: string; b: number; c: number; n: number; p: number };
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Wilson score 95% 区间（对小样本 / 极端比例比正态近似稳健）。返回百分比上下界。
export function wilsonCI(k: number, n: number, z = 1.96): [number, number] {
  if (n <= 0) return [0, 0];
  const ph = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (ph + z2 / (2 * n)) / denom;
  const margin = (z / denom) * Math.sqrt((ph * (1 - ph)) / n + z2 / (4 * n * n));
  const lo = Math.max(0, center - margin);
  const hi = Math.min(1, center + margin);
  return [Math.round(lo * 1000) / 10, Math.round(hi * 1000) / 10];
}

// McNemar 精确（二项）双尾检验：不一致对 b、c，H0 下 X~Bin(b+c,0.5)，p=2·P(X≤min(b,c))，封顶 1。
export function mcNemarExact(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  const m = Math.min(b, c);
  let term = Math.pow(0.5, n); // C(n,0)·0.5^n
  let sum = term;
  for (let i = 1; i <= m; i++) {
    term *= (n - i + 1) / i;
    sum += term;
  }
  return Math.min(1, 2 * sum);
}

export async function runAblation(o: {
  tasks: TaskDef[];
  providerFactory: () => ChatProvider;
  cfg: HarnessConfig;
  concurrency: number;
  configs: AblationConfig[];
  runs?: number;
  batchDir?: string;
}): Promise<{ dir: string; rows: AblationRow[] }> {
  const runs = Math.max(1, o.runs ?? 1);
  const dir = o.batchDir ?? path.join(o.cfg.runsDir, `ablation-${batchTs()}`);
  fs.mkdirSync(dir, { recursive: true });
  const rows: AblationRow[] = [];
  const cells: Map<string, boolean>[] = []; // 每配置：key=`${task_id}#${run}` → pass，用于跨配置配对
  const pooled: { k: number; n: number }[] = [];
  for (const c of o.configs) {
    const cfg: HarnessConfig = { ...o.cfg, ...c.override };
    const allRecs: TaskRecord[][] = [];
    for (let r = 0; r < runs; r++) {
      process.stdout.write(`\n===== 消融：${c.name} 第 ${r + 1}/${runs} 轮 =====\n`);
      const { records } = await evalSuite({
        tasks: o.tasks,
        providerFactory: o.providerFactory,
        cfg,
        concurrency: o.concurrency,
        batchDir: path.join(dir, c.name, `run-${r + 1}`),
        quiet: true,
      });
      allRecs.push(records);
    }
    const perRunRates = allRecs.map((recs) => (recs.filter((x) => x.pass).length / Math.max(1, recs.length)) * 100);
    const flat = allRecs.flat();
    const byTask = new Map<string, boolean[]>();
    const cell = new Map<string, boolean>();
    let pk = 0;
    allRecs.forEach((recs, ri) => {
      for (const rec of recs) {
        cell.set(`${rec.task_id}#${ri}`, rec.pass);
        if (rec.pass) pk++;
      }
    });
    for (const rec of flat) {
      const arr = byTask.get(rec.task_id) ?? [];
      arr.push(rec.pass);
      byTask.set(rec.task_id, arr);
    }
    cells.push(cell);
    pooled.push({ k: pk, n: Math.max(1, flat.length) });
    const flaky_tasks = [...byTask.entries()].filter(([, ps]) => ps.some(Boolean) && !ps.every(Boolean)).map(([id]) => id);
    rows.push({
      name: c.name,
      note: c.note,
      runs,
      mean_pass_rate: Math.round(mean(perRunRates) * 10) / 10,
      median_pass_rate: Math.round(median(perRunRates) * 10) / 10,
      min_pass_rate: Math.round(Math.min(...perRunRates) * 10) / 10,
      mean_turns: Math.round(mean(flat.map((r) => r.turns)) * 10) / 10,
      mean_prompt_tokens: Math.round(mean(flat.map((r) => r.prompt_tokens))),
      mean_cost: Math.round(mean(flat.map((r) => r.cost)) * 1e6) / 1e6,
      flaky_tasks,
      wilson_ci: wilsonCI(pk, flat.length),
    });
  }
  // 相对 baseline（首个配置）做 McNemar 配对精确检验
  const baseCells = cells[0];
  for (let i = 1; i < rows.length; i++) {
    let b = 0; // baseline pass、该配置 fail
    let cc = 0; // baseline fail、该配置 pass
    for (const [key, bp] of baseCells) {
      const cp = cells[i].get(key);
      if (cp === undefined) continue;
      if (bp && !cp) b++;
      else if (!bp && cp) cc++;
    }
    rows[i].mcnemar = { vs: rows[0].name, b, c: cc, n: b + cc, p: mcNemarExact(b, cc) };
  }
  fs.writeFileSync(path.join(dir, 'ablation.json'), JSON.stringify({ generated_at: new Date().toISOString(), model: o.cfg.model, runs, configs: rows }, null, 2));
  process.stdout.write(`\n===== 消融对照（${o.tasks.length} 任务 × ${runs} 轮 = ${o.tasks.length * runs} 次任务运行/配置）=====\n`);
  process.stdout.write(`${padCell('配置', 16)}${padCell('均值%', 8)}${padCell('Wilson95%', 16)}${padCell('McNemar p', 12)}${padCell('均回合', 8)}${padCell('ptok', 8)}费用  flaky\n`);
  for (const r of rows) {
    const ci = r.wilson_ci ? `${r.wilson_ci[0]}–${r.wilson_ci[1]}` : '—';
    const mp = r.mcnemar ? `${r.mcnemar.p.toFixed(3)} (b=${r.mcnemar.b},c=${r.mcnemar.c})` : r === rows[0] ? 'baseline' : '—';
    process.stdout.write(
      `${padCell(r.name, 16)}${padCell(String(r.mean_pass_rate), 8)}${padCell(ci, 16)}${padCell(mp, 12)}${padCell(String(r.mean_turns), 8)}${padCell(String(r.mean_prompt_tokens), 8)}${r.mean_cost.toFixed(4)}  ${r.flaky_tasks.join(',') || '—'}\n`
    );
  }
  process.stdout.write(`注：McNemar 为相对 ${rows[0]?.name ?? 'baseline'} 的配对精确二项检验；n=${runs} 轮功效有限，p 值仅供参考而非"证明无效"。\n`);
  process.stdout.write(`→ ${path.join(dir, 'ablation.json')}\n`);
  return { dir, rows };
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
    failure_reasons: countBy(records.filter((r) => !r.pass).map((r) => r.reason ?? 'other')),
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
  const fr = Object.entries(summary.failure_reasons);
  process.stdout.write('失败归因：' + (fr.length ? fr.map(([k, v]) => `${k}×${v}`).join('  ') : '无失败') + '\n');
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

function countBy(xs: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs) out[x] = (out[x] ?? 0) + 1;
  return out;
}

function classifyFailure(status: string, gradeReason: string): string {
  if (status === 'error') return 'provider_error';
  if (status === 'budget') return 'budget';
  if (status === 'max_turns') return 'max_turns';
  return gradeReason === 'none' ? 'grader_mismatch' : gradeReason;
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
