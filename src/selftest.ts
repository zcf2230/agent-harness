import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS } from './config.ts';
import { estimateTextTokens, estimateMessagesTokens, writeJsonAtomic } from './util.ts';
import { safeResolve, resolveExecutable } from './agent/sandbox.ts';
import { splitGroups, compactMessages } from './agent/context.ts';
import { executeTool } from './agent/tools.ts';
import { RunLog } from './agent/checkpoint.ts';
import { newRunState, runAgent } from './agent/loop.ts';
import { connectMcpServers, emptyMcpBridge } from './mcp/bridge.ts';
import { McpClient } from './mcp/client.ts';
import { gradeTask, loadTasks, requiredOutputFiles } from './eval/grade.ts';
import { executeTask, setupWorkspace } from './eval/runner.ts';
import { MockProvider, callTool, finish } from './providers/mock.ts';
import { OpenAIProvider, toWire } from './providers/openai.ts';
import type { ChatProvider, Message, TaskDef } from './types.ts';

const cfg = { ...DEFAULTS, pythonCommand: process.env.HARNESS_PYTHON ?? 'python' };
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-selftest-'));
let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name} ${extra}`);
  }
}

function section(s: string): void {
  console.log(`\n== ${s} ==`);
}

async function testSandbox(): Promise<void> {
  section('沙箱与路径边界');
  const ws = path.join(tmpRoot, 'ws1');
  fs.mkdirSync(ws, { recursive: true });
  check('相对路径合法', safeResolve(ws, 'a/b.txt').startsWith(path.resolve(ws)));
  let escaped = false;
  try {
    safeResolve(ws, '../outside.txt');
  } catch {
    escaped = true;
  }
  check('拒绝 .. 越界', escaped);
  escaped = false;
  try {
    safeResolve(ws, 'C:\\Windows\\system32\\evil.txt');
  } catch {
    escaped = true;
  }
  check('拒绝 Windows 绝对路径', escaped);
  escaped = false;
  try {
    safeResolve(ws, '/etc/passwd');
  } catch {
    escaped = true;
  }
  check('拒绝 POSIX 绝对路径', escaped);
  check('node 令牌解析为当前解释器', resolveExecutable('node', 'py') === process.execPath);
  check('python 令牌解析为配置命令', resolveExecutable('python', 'X:/py.exe') === 'X:/py.exe');
}

async function testTools(): Promise<void> {
  section('工具执行');
  const ws = path.join(tmpRoot, 'ws2');
  fs.mkdirSync(ws, { recursive: true });
  const ctx = { workspace: ws, cfg };
  const w = await executeTool(ctx, 'write_file', JSON.stringify({ path: 'src/a.mjs', content: 'export const x = 1;\n// 标记ABC\n' }));
  check('write_file 成功', w.ok && w.output.includes('已写入'), w.output);
  const r = await executeTool(ctx, 'read_file', JSON.stringify({ path: 'src/a.mjs' }));
  check('read_file 读回内容', r.ok && r.output.includes('标记ABC'), r.output);
  const f = await executeTool(ctx, 'find_text', JSON.stringify({ pattern: '标记ABC' }));
  check('find_text 命中', f.ok && f.output.includes('src/a.mjs:2'), f.output);
  const l = await executeTool(ctx, 'list_files', JSON.stringify({}));
  check('list_files 列出结构', l.ok && l.output.includes('a.mjs'), l.output);
  const j = await executeTool(ctx, 'run_js', JSON.stringify({ code: "console.log(6*7);" }));
  check('run_js 计算并捕获 stdout', j.ok && j.output.includes('42'), j.output);
  const bad = await executeTool(ctx, 'run_js', JSON.stringify({ code: "throw new Error('boom');" }));
  check('run_js 失败被捕获而非崩溃', !bad.ok && bad.output.includes('boom'), bad.output);
  const evil = await executeTool(ctx, 'read_file', JSON.stringify({ path: '../../../etc/passwd' }));
  check('工具层拒绝越界读取', !evil.ok && evil.output.includes('越界'), evil.output);
  fs.writeFileSync(path.join(tmpRoot, 'outside-secret.txt'), 'SECRET-OUTSIDE-WS');
  const jailRead = await executeTool(ctx, 'run_js', JSON.stringify({ code: `import fs from 'node:fs'; try { fs.readFileSync(${JSON.stringify(path.join(tmpRoot, 'outside-secret.txt'))}, 'utf8'); console.log('LEAKED'); } catch (e) { console.log('DENIED', e.code); }` }));
  check('run_js 被 Node 权限模型关进工作区（越界读被拒）', jailRead.output.includes('DENIED') && !jailRead.output.includes('LEAKED'), jailRead.output);
  const jailWrite = await executeTool(ctx, 'run_js', JSON.stringify({ code: `import fs from 'node:fs'; try { fs.writeFileSync(${JSON.stringify(path.join(tmpRoot, 'pwned.txt'))}, 'x'); console.log('WROTE'); } catch (e) { console.log('DENIED', e.code); }` }));
  check('run_js 无法写工作区外', jailWrite.output.includes('DENIED') && !fs.existsSync(path.join(tmpRoot, 'pwned.txt')), jailWrite.output);
  const unknown = await executeTool(ctx, 'no_such_tool', '{}');
  check('未知工具返回错误而非异常', !unknown.ok && unknown.output.includes('未知工具'), unknown.output);
}

async function testContext(): Promise<void> {
  section('上下文与压缩');
  check('中文 token 估算高于等长英文', estimateTextTokens('汉字汉字汉字') > estimateTextTokens('abcdefgh'));
  const msgs: Message[] = [{ role: 'assistant', content: null, tool_calls: [{ id: '1', name: 'run_js', arguments: JSON.stringify({ code: 'x'.repeat(4000) }) }] }];
  check('工具调用参数计入估算', estimateMessagesTokens(msgs) > 800);

  const script: Message[] = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'task' }];
  for (let i = 0; i < 8; i++) {
    script.push({ role: 'assistant', content: null, tool_calls: [{ id: `c${i}`, name: 'run_js', arguments: JSON.stringify({ code: `第${i}轮` + 'y'.repeat(600) }) }] });
    script.push({ role: 'tool', tool_call_id: `c${i}`, name: 'run_js', content: `结果${i} ` + 'z'.repeat(600) });
  }
  const { head, groups } = splitGroups(script);
  check('头部与回合正确分组', head.length === 2 && groups.length === 8 && groups[0].length === 2);

  const summarizer: ChatProvider = {
    async chat() {
      return { message: { role: 'assistant', content: '摘要：已完成 1-4 轮验证，剩余任务待办' }, usage: { prompt_tokens: 10, completion_tokens: 10 } };
    },
  };
  const before = estimateMessagesTokens(script);
  const c = await compactMessages(summarizer, script, 3);
  const after = c.messages ? estimateMessagesTokens(c.messages) : before;
  check('压缩真实减少 token', c.compacted && after < before, `${before}→${after}`);
  check('保留最近 3 个完整回合', !!c.messages && c.messages[c.messages.length - 1].content!.includes('结果7'));
  check('摘要注入为 system 消息', !!c.messages && c.messages[2].role === 'system' && c.messages[2].content!.includes('摘要'));
  const m2 = await compactMessages(summarizer, [{ role: 'system', content: 'a' }, ...script.slice(1, 5)], 3);
  check('回合过少时不压缩', !m2.compacted);

  let boom = true;
  const failing: ChatProvider = {
    async chat() {
      if (boom) {
        boom = false;
        throw new Error('压缩调用失败');
      }
      return { message: { role: 'assistant', content: '' }, usage: { prompt_tokens: 0, completion_tokens: 0 } };
    },
  };
  const c2 = await compactMessages(failing, script, 3);
  check('LLM 失败时规则兜底仍压缩', c2.compacted && c2.method === 'rule' && !!c2.messages && c2.messages.some((m) => m.content!.includes('调用 run_js')), c2.method);
}

async function testCheckpoint(): Promise<void> {
  section('checkpoint 与事件流');
  const dir = path.join(tmpRoot, 'run-ck');
  const log = new RunLog(dir);
  log.event('message', { role: 'user', content: 'hi' });
  log.event('tool_exec', { name: 'run_js', ok: true });
  const state = newRunState({ id: 'x', name: 'x', category: 'demo', prompt: 'p' }, cfg);
  log.saveState(state);
  const loaded = RunLog.loadState(dir);
  check('state.json 快照可读回', loaded.task_id === 'x' && loaded.turn === 0);
  const events = RunLog.loadEvents(dir);
  check('trajectory.jsonl 顺序完整', events.length === 2 && events[0].seq === 1 && events[1].type === 'tool_exec');
  writeJsonAtomic(path.join(dir, 'nested', 'j.json'), { a: 1 });
  check('原子写创建嵌套目录', fs.existsSync(path.join(dir, 'nested', 'j.json')));
}

async function testLoop(): Promise<void> {
  section('主循环（Mock provider）');
  const budgetState = newRunState({ id: 'b', name: 'b', category: 'demo', prompt: 'p', context_budget_tokens: 1234, difficulty: 'hard' }, cfg);
  check('按任务覆盖上下文预算', budgetState.contextBudget === 1234, String(budgetState.contextBudget));
  check('无覆盖时回退全局预算', newRunState({ id: 'b2', name: 'b2', category: 'demo', prompt: 'p' }, cfg).contextBudget === cfg.contextBudgetTokens);
  const ws = path.join(tmpRoot, 'run-loop');
  const dir = path.join(tmpRoot, 'run-loop-log');
  const log = new RunLog(dir);
  const task: TaskDef = { id: 'l1', name: '循环测试', category: 'demo', prompt: '把 7 写入 answer.txt' };
  const plan = (messages: Message[]) => {
    const hasTool = messages.some((m) => m.role === 'tool');
    if (!hasTool) return callTool('write_file', { path: 'answer.txt', content: '7' });
    return finish('已写入 answer.txt：7');
  };
  const state = await runAgent({ provider: new MockProvider(plan), cfg, state: newRunState(task, cfg), workspace: ws, log });
  check('两轮完成并调用 finish', state.status === 'final' && state.turn === 2, `status=${state.status} turn=${state.turn}`);
  check('工具真实落盘', fs.existsSync(path.join(ws, 'answer.txt')) && fs.readFileSync(path.join(ws, 'answer.txt'), 'utf8') === '7');
  check('usage 累计', state.usage.prompt_tokens > 0);
  const events = RunLog.loadEvents(dir);
  check('事件含 message/tool_exec/final', ['message', 'tool_exec', 'final'].every((t) => events.some((e) => e.type === t)));

  const dir2 = path.join(tmpRoot, 'run-loop2-log');
  const cappedCfg = { ...cfg, maxTurns: 3 };
  const state2 = await runAgent({
    provider: new MockProvider(() => callTool('run_js', { code: 'console.log(1);' })),
    cfg: cappedCfg,
    state: newRunState({ id: 'l2', name: '超限测试', category: 'demo', prompt: 'x' }, cappedCfg),
    workspace: ws,
    log: new RunLog(dir2),
  });
  check('轮数超限正确止损', state2.status === 'max_turns' && state2.turn === 3, state2.status);

  const dir3 = path.join(tmpRoot, 'run-resume-log');
  const log3 = new RunLog(dir3);
  const task3: TaskDef = { id: 'l3', name: '续跑测试', category: 'demo', prompt: 'p' };
  const halfState = newRunState(task3, cfg);
  halfState.turn = 1;
  halfState.messages.push({ role: 'assistant', content: null, tool_calls: [{ id: 'c1', name: 'run_js', arguments: '{"code":"console.log(1)"}' }] });
  halfState.messages.push({ role: 'tool', tool_call_id: 'c1', name: 'run_js', content: 'exit=0\n[stdout]\n1\n' });
  log3.saveState(halfState);
  const resumed = RunLog.loadState(dir3);
  const state4 = await runAgent({ provider: new MockProvider(() => finish('续跑后完成')), cfg, state: resumed, workspace: ws, log: log3 });
  check('从 checkpoint 续跑成功', state4.status === 'final' && state4.turn === 2 && state4.answer === '续跑后完成', `turn=${state4.turn}`);

  const loopPlan = (messages: Message[]) => {
    const sawNudge = messages.some((m) => m.role === 'user' && (m.content ?? '').includes('接近回合上限'));
    return sawNudge ? finish('收到收尾提醒，基于当前结果结束') : callTool('read_file', { path: 'nope.txt' });
  };
  const nudgeTask: TaskDef = { id: 'l5', name: '收尾测试', category: 'demo', prompt: 'p', max_turns: 4 };
  const nudgedCfg = { ...cfg, terminationNudge: true };
  const stateN = await runAgent({ provider: new MockProvider(loopPlan), cfg: nudgedCfg, state: newRunState(nudgeTask, nudgedCfg), workspace: ws, log: new RunLog(path.join(tmpRoot, 'run-nudge-log')) });
  check('收尾轻推把停滞转为正常结束', stateN.status === 'final' && stateN.nudged === true && (stateN.answer ?? '').includes('收尾提醒'), `status=${stateN.status} nudged=${stateN.nudged}`);
  const noNudgeCfg = { ...cfg, terminationNudge: false };
  const stateNN = await runAgent({ provider: new MockProvider(loopPlan), cfg: noNudgeCfg, state: newRunState(nudgeTask, noNudgeCfg), workspace: ws, log: new RunLog(path.join(tmpRoot, 'run-nonudge-log')) });
  check('关闭轻推则空转到上限', stateNN.status === 'max_turns' && stateNN.nudged === false, `status=${stateNN.status}`);
  const repeatEvents = RunLog.loadEvents(path.join(tmpRoot, 'run-nudge-log')).filter((e) => e.type === 'tool_exec' && String(e.data.output).includes('重复'));
  check('重复相同调用被检测并告警', repeatEvents.length >= 1, JSON.stringify(repeatEvents.length));

  const dlTask: TaskDef = { id: 'dl', name: '交付物检测', category: 'demo', prompt: '写 out.txt 内容为 HI', max_turns: 6, grade: { type: 'file_regex', path: 'out.txt', pattern: 'HI' } };
  check('从判分规则提取交付物', requiredOutputFiles(dlTask).join(',') === 'out.txt', JSON.stringify(requiredOutputFiles(dlTask)));
  const dlWs = path.join(tmpRoot, 'run-dl-ws');
  const dlLog = new RunLog(path.join(tmpRoot, 'run-dl-log'));
  const dlPlan = (messages: Message[]) => {
    const saw = messages.some((m) => m.role === 'user' && (m.content ?? '').includes('交付物检查'));
    return saw ? callTool('write_file', { path: 'out.txt', content: 'HI' }) : callTool('run_js', { code: 'console.log(1)' });
  };
  const dlCfg = { ...cfg, terminationNudge: true };
  await runAgent({ provider: new MockProvider(dlPlan), cfg: dlCfg, state: newRunState(dlTask, dlCfg), workspace: dlWs, log: dlLog, requiredFiles: requiredOutputFiles(dlTask) });
  check('交付物缺失触发定向提醒', RunLog.loadEvents(path.join(tmpRoot, 'run-dl-log')).some((e) => e.type === 'nudge' && e.data.type === 'deliverable'), '');
  check('提醒后模型补齐交付物文件', fs.existsSync(path.join(dlWs, 'out.txt')) && fs.readFileSync(path.join(dlWs, 'out.txt'), 'utf8') === 'HI', '');
}

async function testWire(): Promise<void> {
  section('OpenAI 兼容 wire 序列化');
  const msgs: Message[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'task' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', name: 'run_js', arguments: '{"code":"x"}' }] },
    { role: 'tool', tool_call_id: 'c1', name: 'run_js', content: 'exit=0' },
  ];
  const wire = toWire(msgs) as any[];
  const asst = wire[2];
  check('assistant tool_calls 还原为嵌套 function', asst.tool_calls[0].type === 'function' && asst.tool_calls[0].function.name === 'run_js' && asst.tool_calls[0].function.arguments === '{"code":"x"}', JSON.stringify(asst));
  check('assistant 保留 content 字段', 'content' in asst);
  const tool = wire[3];
  check('tool 消息含 tool_call_id 且去掉 name', tool.role === 'tool' && tool.tool_call_id === 'c1' && !('name' in tool), JSON.stringify(tool));
  check('system/user 原样映射', wire[0].role === 'system' && wire[1].role === 'user');
}

async function testBudget(): Promise<void> {
  section('成本/时限预算止损');
  const ws = path.join(tmpRoot, 'run-budget');
  const bCfg = { ...cfg, maxCostPerTask: 0.00005 };
  const st = await runAgent({ provider: new MockProvider(() => callTool('run_js', { code: 'console.log(1)' })), cfg: bCfg, state: newRunState({ id: 'bc', name: '成本上限', category: 'demo', prompt: 'x' }, bCfg), workspace: ws, log: new RunLog(path.join(tmpRoot, 'run-budget-log')) });
  check('成本超限提前止损', st.status === 'budget' && st.stop_reason === 'max_cost', `status=${st.status} reason=${st.stop_reason}`);
  const dCfg = { ...cfg, deadlineMs: 1 };
  const dState = newRunState({ id: 'bd', name: '时限', category: 'demo', prompt: 'x' }, dCfg);
  dState.started_at = new Date(Date.now() - 5000).toISOString();
  const st2 = await runAgent({ provider: new MockProvider(() => callTool('run_js', { code: 'console.log(1)' })), cfg: dCfg, state: dState, workspace: ws, log: new RunLog(path.join(tmpRoot, 'run-deadline-log')) });
  check('墙钟超时提前止损', st2.status === 'budget' && st2.stop_reason === 'deadline', `status=${st2.status} reason=${st2.stop_reason}`);
}

async function testResilience(): Promise<void> {
  section('Provider/MCP 网络韧性');
  const realFetch = globalThis.fetch;
  try {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls <= 2) return { ok: false, status: 429, text: async () => 'slow down' };
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { role: 'assistant', content: 'hi' } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }) };
    }) as unknown as typeof fetch;
    const p = new OpenAIProvider({ ...cfg, apiKey: 'x' });
    const resp = await p.chat([{ role: 'user', content: 'hi' }], []);
    check('429 触发指数退避重试并最终成功', calls === 3 && resp.message.content === 'hi', `calls=${calls}`);
    calls = 0;
    globalThis.fetch = (async () => { calls++; return { ok: false, status: 400, text: async () => 'bad request' }; }) as unknown as typeof fetch;
    let threw = false;
    try { await p.chat([{ role: 'user', content: 'hi' }], []); } catch { threw = true; }
    check('400 不重试、立即抛出', threw && calls === 1, `calls=${calls} threw=${threw}`);
  } finally {
    globalThis.fetch = realFetch;
  }
  const serverPath = fileURLToPath(new URL('./mcp/test-server.ts', import.meta.url));
  const client = new McpClient({ command: process.execPath, args: [serverPath] });
  await client.initialize();
  let mcpErr = '';
  try { await client.request('boom'); } catch (e: any) { mcpErr = String(e?.message ?? e); }
  client.close();
  check('MCP JSON-RPC error 被 reject', mcpErr.includes('故意失败') || mcpErr.includes('-32000'), mcpErr);
}

async function testSecurity(): Promise<void> {
  section('安全边界（env 白名单 + 判分器沙箱）');
  const ws = path.join(tmpRoot, 'sec-ws');
  fs.mkdirSync(ws, { recursive: true });
  const ctx = { workspace: ws, cfg };
  process.env.DEEPSEEK_API_KEY = 'SECRET-TEST-KEY-123';
  const envProbe = await executeTool(ctx, 'run_js', JSON.stringify({ code: "console.log('KEY=' + (process.env.DEEPSEEK_API_KEY || 'ABSENT'));" }));
  check('子进程环境白名单剥离 API key', envProbe.output.includes('ABSENT') && !envProbe.output.includes('SECRET-TEST-KEY-123'), envProbe.output.slice(0, 80));
  delete process.env.DEEPSEEK_API_KEY;
  const pathProbe = await executeTool(ctx, 'run_js', JSON.stringify({ code: "console.log('HASPATH=' + (process.env.PATH ? 'yes' : 'no'));" }));
  check('白名单保留 PATH 使解释器可用', pathProbe.output.includes('HASPATH=yes'), pathProbe.output.slice(0, 60));
  const outside = path.join(tmpRoot, 'sec-escaped.txt');
  const task: TaskDef = {
    id: 'sec', name: '逃逸', category: 'demo', prompt: 'x',
    workspace_files: [{ path: 'solution.mjs', content: `import fs from 'node:fs'; try { fs.writeFileSync(${JSON.stringify(outside)}, 'pwned'); console.log('ESCAPED'); } catch (e) { console.log('DENIED', e.code); process.exit(1); }` }],
    grade: { type: 'run_test', command: 'node solution.mjs' },
  };
  const gws = path.join(tmpRoot, 'sec-grade');
  setupWorkspace(task, gws);
  const graded = await gradeTask(task, gws, 'done', cfg);
  check('判分器执行模型文件时也在沙箱内（越界写被拒）', !graded.pass && !fs.existsSync(outside), graded.detail.slice(0, 90));

  const protTask: TaskDef = {
    id: 'prot', name: '保护', category: 'demo', prompt: 'x',
    workspace_files: [{ path: 'test.mjs', content: "// grader\n", protected: true }, { path: 'data.txt', content: 'x' }],
  };
  const pws = path.join(tmpRoot, 'prot-ws');
  const pset = setupWorkspace(protTask, pws);
  const pctx = { workspace: pws, cfg, protectedPaths: pset };
  const tamper = await executeTool(pctx, 'write_file', JSON.stringify({ path: 'test.mjs', content: 'trivially pass' }));
  check('模型不能覆写受保护验收文件', !tamper.ok && tamper.output.includes('受保护'), tamper.output.slice(0, 60));
  const okWrite = await executeTool(pctx, 'write_file', JSON.stringify({ path: 'answer.txt', content: 'ok' }));
  check('非保护文件仍可写', okWrite.ok, okWrite.output.slice(0, 40));
}

async function testGraders(): Promise<void> {
  section('判分器');
  const ws = path.join(tmpRoot, 'ws-grade');
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, 'out.json'), '{"avg": 86.67, "max": 100}');
  const g1 = await gradeTask({ id: 'g', name: 'g', category: 'demo', prompt: 'p', grade: { type: 'file_regex', path: 'out.json', pattern: '"avg"\\s*:\\s*86\\.67' } }, ws, 'x', cfg);
  check('file_regex 命中', g1.pass, g1.detail);
  const g2 = await gradeTask({ id: 'g', name: 'g', category: 'demo', prompt: 'p', grade: { type: 'answer_number', expected: 467 } }, ws, '答案是 467 个', cfg);
  check('answer_number 提取末位数字', g2.pass, g2.detail);
  const g3 = await gradeTask({ id: 'g', name: 'g', category: 'demo', prompt: 'p', grade: { type: 'answer_number', expected: 1126.83, tolerance: 0.05 } }, ws, 'boxed{1126.83} 元', cfg);
  check('answer_number 容差', g3.pass, g3.detail);
  const g3b = await gradeTask({ id: 'g', name: 'g', category: 'demo', prompt: 'p', grade: { type: 'answer_number', expected: 23 } }, ws, '鸡有 23 只（兔 12 只，共 35 头、94 脚）', cfg);
  check('answer_number 正确值非末位仍通过', g3b.pass, g3b.detail);
  const g3c = await gradeTask({ id: 'g', name: 'g', category: 'demo', prompt: 'p', grade: { type: 'answer_number', expected: 99 } }, ws, '鸡有 23 只，94 脚', cfg);
  check('answer_number 无匹配则失败', !g3c.pass, g3c.detail);
  const g4 = await gradeTask({ id: 'g', name: 'g', category: 'demo', prompt: 'p', grade: { type: 'answer_regex', pattern: '^MOCK$' } }, ws, 'not mock', cfg);
  check('answer_regex 拒绝不匹配', !g4.pass);
  fs.writeFileSync(path.join(ws, 'ok.mjs'), "console.log('ALL TESTS PASSED');");
  const g5 = await gradeTask({ id: 'g', name: 'g', category: 'demo', prompt: 'p', grade: { type: 'run_test', command: 'node ok.mjs', stdout_regex: 'ALL TESTS PASSED' } }, ws, null, cfg);
  check('run_test 退出码+stdout', g5.pass, g5.detail);
  fs.writeFileSync(path.join(ws, 'fail.mjs'), "throw new Error('nope');");
  const g6 = await gradeTask({ id: 'g', name: 'g', category: 'demo', prompt: 'p', grade: { type: 'run_test', command: 'node fail.mjs' } }, ws, null, cfg);
  check('run_test 失败被捕获', !g6.pass, g6.detail);
}

async function testEvalE2E(): Promise<void> {
  section('评测链路端到端（mock）');
  const tasks = loadTasks(process.env.HARNESS_TASKS ?? path.join(process.cwd(), 'tasks'));
  const demo = tasks.find((t) => t.category === 'demo');
  check('任务集加载', tasks.length >= 10 && !!demo, `count=${tasks.length}`);
  const batchDir = path.join(tmpRoot, 'eval-mock');
  const { records } = await (await import('./eval/runner.ts')).evalSuite({
    tasks: [demo!],
    providerFactory: () => new MockProvider(),
    cfg: { ...cfg },
    concurrency: 1,
    batchDir,
    quiet: true,
  });
  check('mock 任务通过判分', records[0].pass, records[0].detail);
  check('summary.json 生成', fs.existsSync(path.join(batchDir, 'summary.json')));
  const summary = JSON.parse(fs.readFileSync(path.join(batchDir, 'summary.json'), 'utf8'));
  check('汇总含难度/类别分解', !!summary.by_difficulty?.easy && !!summary.by_category?.demo, JSON.stringify(summary.by_difficulty));
  const { record } = await executeTask({
    task: demo!,
    provider: new MockProvider(() => finish('错误的随机答案')),
    cfg,
    runDir: path.join(tmpRoot, 'eval-mock-2'),
  });
  check('判分能识别错误答案', !record.pass);
}

async function testMcp(): Promise<void> {
  section('MCP 客户端与工具桥接');
  const serverPath = fileURLToPath(new URL('./mcp/test-server.ts', import.meta.url));
  check('测试服务器文件存在', fs.existsSync(serverPath));

  const empty = emptyMcpBridge();
  check('空桥不接管任何工具', empty.specs.length === 0 && !empty.has('anything'));

  const bridge = await connectMcpServers({ test: { command: process.execPath, args: [serverPath] } });
  try {
    check('握手成功并上报服务器', bridge.servers.length === 1 && bridge.servers[0].ok === true, JSON.stringify(bridge.servers[0]));
    check('工具命名空间化', bridge.specs.map((s) => s.name).join(',') === 'test__add,test__echo', bridge.specs.map((s) => s.name).join(','));
    check('桥接管 MCP 工具', bridge.has('test__add') && !bridge.has('run_js'));
    const add = await bridge.call('test__add', JSON.stringify({ a: 2, b: 3 }));
    check('MCP add 返回 5', add.ok && add.output.trim() === '5', add.output);
    const echo = await bridge.call('test__echo', JSON.stringify({ text: '中文回显' }));
    check('MCP echo 透传文本', echo.ok && echo.output.includes('中文回显'), echo.output);
    const badArgs = await bridge.call('test__add', '不是 JSON');
    check('MCP 非法参数被拦截', !badArgs.ok && badArgs.output.includes('JSON'), badArgs.output);
    const unknown = await bridge.call('test__nope', '{}');
    check('未知 MCP 工具被拦截', !unknown.ok && unknown.output.includes('未知'), unknown.output);
  } finally {
    await bridge.close();
  }

  const broken = await connectMcpServers({ bad: { command: 'nonexistent-mcp-binary-xyz', args: [] } });
  check('单个服务器失败不崩溃整体', broken.servers.length === 1 && broken.servers[0].ok === false && !!broken.servers[0].error, JSON.stringify(broken.servers[0]));
  await broken.close();

  const ws = path.join(tmpRoot, 'run-mcp');
  const dir = path.join(tmpRoot, 'run-mcp-log');
  const log = new RunLog(dir);
  const bridge2 = await connectMcpServers({ test: { command: process.execPath, args: [serverPath] } });
  const task: TaskDef = { id: 'mc', name: 'MCP 计算', category: 'demo', prompt: '用 MCP 计算 20+22' };
  const plan = (messages: Message[]) => {
    const called = messages.some((m) => m.role === 'tool');
    if (!called) return callTool('test__add', { a: 20, b: 22 });
    const last = messages[messages.length - 1].content ?? '';
    return finish(`MCP 返回 ${last.trim()}`);
  };
  const state = await runAgent({ provider: new MockProvider(plan), cfg, state: newRunState(task, cfg), workspace: ws, log, mcp: bridge2 });
  await bridge2.close();
  check('agent 经 MCP 完成回合', state.status === 'final' && state.turn === 2, `status=${state.status} turn=${state.turn}`);
  check('agent 答案含 MCP 计算结果 42', (state.answer ?? '').includes('42'), state.answer ?? '');
  const toolEvents = RunLog.loadEvents(dir).filter((e) => e.type === 'tool_exec');
  check('tool_exec 记录了 MCP 调用', toolEvents.length === 1 && toolEvents[0].data.name === 'test__add' && toolEvents[0].data.ok === true, JSON.stringify(toolEvents[0]?.data?.name));
}

async function testBench(): Promise<void> {
  section('可靠性曲线聚合（mock，runs=2）');
  const all = loadTasks(process.env.HARNESS_TASKS ?? path.join(process.cwd(), 'tasks'));
  const demo = all.find((t) => t.id === 'd01')!;
  const willFail = all.find((t) => t.id === 'c01')!;
  const dir = path.join(tmpRoot, 'bench-mock');
  const { runBench } = await import('./eval/runner.ts');
  const res = await runBench({
    tasks: [demo, willFail],
    providerFactory: () => new MockProvider(),
    cfg: { ...cfg, runsDir: dir },
    concurrency: 1,
    runs: 2,
  });
  const bench = JSON.parse(fs.readFileSync(path.join(res.dir, 'bench.json'), 'utf8'));
  check('bench.json 记录轮数与任务数', bench.runs === 2 && bench.total_tasks === 2, JSON.stringify({ r: bench.runs, t: bench.total_tasks }));
  const d = bench.tasks.find((t: any) => t.task_id === 'd01');
  const c = bench.tasks.find((t: any) => t.task_id === 'c01');
  check('稳定通过任务 pass@2=2/2', d && d.passes === 2 && d.runs === 2 && d.flaky === false, JSON.stringify(d));
  check('稳定失败任务 pass@2=0/2', c && c.passes === 0 && c.flaky === false, JSON.stringify(c));
  check('每轮通过率各 50%，标准差 0', bench.per_run_pass_rate.join(',') === '50,50' && bench.std_pass_rate === 0, JSON.stringify(bench.per_run_pass_rate));
}

async function main(): Promise<void> {
  console.log('agent-harness 离线自检（不调用真实 API）');
  await testSandbox();
  await testTools();
  await testContext();
  await testCheckpoint();
  await testLoop();
  await testMcp();
  await testWire();
  await testBudget();
  await testResilience();
  await testSecurity();
  await testGraders();
  await testEvalE2E();
  await testBench();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log(`\n结果: ${passed} 通过 / ${failed} 失败`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error('自检崩溃:', e);
  process.exit(1);
});
