import fs from 'node:fs';
import path from 'node:path';
import type { ChatProvider, Message, RunState, TaskDef } from '../types.ts';
import type { HarnessConfig } from '../config.ts';
import type { RunLog } from './checkpoint.ts';
import type { McpBridge } from '../mcp/bridge.ts';
import { maybeCompact, estimate, type CompactResult } from './context.ts';
import { executeTool, TOOL_SPECS } from './tools.ts';

export function buildSystemPrompt(task: TaskDef): string {
  return [
    '你是一个通过工具与环境交互完成任务的 agent。',
    `你正在处理任务【${task.name}】。`,
    '工作环境规则：',
    '- 当前工作目录是任务工作区，所有文件工具只接受工作区内的相对路径，禁止访问工作区之外的文件；',
    '- run_js 以 ESM 模块执行（用 import，不支持 require），结果通过 console.log 打印；run_py 用 print 输出；',
    '- 代码执行没有网络访问权限，报错误码 127 表示解释器不存在；',
    '- 工具输出过长时会被截断，读大文件请用 read_file 的 offset/limit 分段读取。',
    '工作方式要求：',
    '1. 需要精确计算或可验证结果时，必须写代码验证，禁止心算；',
    '2. 命令或代码报错时，先阅读 stderr，修复后重试；',
    '3. 若任务指定了输出文件的路径和格式，严格遵守，判分会直接读取这些文件；',
    '4. 完成后必须调用 finish 工具提交最终答案，除此之外不要以纯文本结束回合。',
    task.prompt,
  ].join('\n');
}

export function newRunState(task: TaskDef, cfg: HarnessConfig): RunState {
  return {
    task_id: task.id,
    name: task.name,
    category: task.category,
    prompt: task.prompt,
    model: cfg.model,
    max_turns: task.max_turns ?? cfg.maxTurns,
    contextBudget: task.context_budget_tokens ?? cfg.contextBudgetTokens,
    turn: 0,
    compactions: 0,
    nudged: false,
    last_prompt_tokens: 0,
    usage: { prompt_tokens: 0, completion_tokens: 0 },
    status: 'running',
    answer: null,
    stop_reason: null,
    messages: [
      { role: 'system', content: buildSystemPrompt(task) },
      { role: 'user', content: `开始执行任务【${task.name}】。` },
    ],
    started_at: new Date().toISOString(),
  };
}

export interface RunOptions {
  provider: ChatProvider;
  cfg: HarnessConfig;
  state: RunState;
  workspace: string;
  log: RunLog;
  mcp?: McpBridge | null;
  requiredFiles?: string[];
  print?: (s: string) => void;
}

export async function runAgent(o: RunOptions): Promise<RunState> {
  const { state, log, cfg } = o;
  const toolsCtx = { workspace: o.workspace, cfg };
  const mcp = o.mcp ?? null;
  const specs = mcp && mcp.specs.length > 0 ? TOOL_SPECS.concat(mcp.specs) : TOOL_SPECS;
  state.status = 'running';
  let finished = false;
  let prevSig = '';
  const deliverableReminded = new Set<string>();
  try {
    while (state.turn < state.max_turns && !finished) {
      state.turn++;
      if (cfg.terminationNudge && !state.nudged && state.turn >= state.max_turns - 1) {
        state.nudged = true;
        const nudge: Message = {
          role: 'user',
          content: '⚠ 提醒：你已接近回合上限。若任务已完成，请立即调用 finish 提交最终答案；若某步骤反复失败，请基于当前已有的结果 finish，并在答案中说明未完成之处，不要继续无进展的重复操作。',
        };
        state.messages.push(nudge);
        log.event('nudge', { turn: state.turn, type: 'closing' });
      }
      const required = o.requiredFiles ?? [];
      if (cfg.terminationNudge && required.length > 0 && state.turn >= state.max_turns - Math.max(1, Math.ceil(state.max_turns * 0.25))) {
        const missing = required.filter((f) => !fs.existsSync(path.join(o.workspace, f)));
        const key = missing.join(',');
        if (missing.length > 0 && !deliverableReminded.has(key)) {
          deliverableReminded.add(key);
          state.messages.push({
            role: 'user',
            content: `⚠ 交付物缺失：任务要求但工作区尚未找到这些文件：${missing.join('、')}。请立即用 write_file 按任务要求生成它们，否则判分会因缺少文件而失败。`,
          });
          log.event('nudge', { turn: state.turn, type: 'deliverable', missing });
        }
      }
      const c = await maybeCompactGuarded(o.provider, state, cfg);
      if (c.compacted) {
        state.compactions++;
        log.event('compact', {
          turn: state.turn,
          before: c.before,
          after: c.after,
          method: c.method,
          dropped_groups: c.droppedGroups,
          est_now: estimate(state.messages),
        });
        log.saveState(state);
        o.print?.(`  ⟳ 上下文压缩 ${c.before}→${c.after} tok（${c.method}）`);
      }
      const resp = await o.provider.chat(state.messages, specs);
      state.usage.prompt_tokens += resp.usage.prompt_tokens;
      state.usage.completion_tokens += resp.usage.completion_tokens;
      if (resp.usage.prompt_tokens > 0) state.last_prompt_tokens = resp.usage.prompt_tokens;
      const msg = resp.message;
      state.messages.push(msg);
      log.event('message', msg);
      const calls = msg.tool_calls ?? [];
      if (calls.length === 0) {
        state.status = 'final';
        state.answer = (msg.content ?? '').trim() || '（模型返回空内容）';
        state.stop_reason = 'content_answer';
        break;
      }
      const nonFinish = calls.filter((c) => c.name !== 'finish');
      const sig = nonFinish.map((c) => `${c.name}:${c.arguments}`).sort().join('|');
      const repeated = cfg.terminationNudge && sig !== '' && sig === prevSig;
      prevSig = sig;
      for (const call of calls) {
        if (call.name === 'finish') {
          let answer = '';
          try {
            answer = String(JSON.parse(call.arguments || '{}').answer ?? '');
          } catch {
            answer = call.arguments;
          }
          state.status = 'final';
          state.answer = answer;
          state.stop_reason = 'finish';
          finished = true;
          break;
        }
        const result =
          mcp && mcp.has(call.name)
            ? await mcp.call(call.name, call.arguments)
            : await executeTool(toolsCtx, call.name, call.arguments);
        const warn = repeated
          ? '⚠ 你重复了与上一回合完全相同的工具调用，这通常意味着停滞。请改变方法，或基于当前结果调用 finish 结束任务。\n\n'
          : '';
        const tm: Message = {
          role: 'tool',
          tool_call_id: call.id,
          name: call.name,
          content: warn + result.output,
        };
        state.messages.push(tm);
        log.event('tool_exec', {
          turn: state.turn,
          name: call.name,
          args: call.arguments.length > 2000 ? call.arguments.slice(0, 2000) + '…' : call.arguments,
          ok: result.ok,
          ms: result.ms,
          output: tm.content,
        });
        o.print?.(`  ${result.ok ? '✓' : '✗'} ${call.name} ${(result.ms / 1000).toFixed(1)}s`);
      }
      log.saveState(state);
    }
    if (!finished && state.status === 'running') {
      state.status = state.turn >= state.max_turns ? 'max_turns' : 'running';
      state.stop_reason = 'max_turns';
    }
  } catch (e: any) {
    state.status = 'error';
    state.stop_reason = String(e?.message ?? e);
  }
  log.event('final', {
    status: state.status,
    answer: state.answer,
    stop_reason: state.stop_reason,
    usage: state.usage,
    turns: state.turn,
    compactions: state.compactions,
  });
  log.saveState(state);
  return state;
}

async function maybeCompactGuarded(
  provider: ChatProvider,
  state: RunState,
  cfg: HarnessConfig
): Promise<CompactResult> {
  const budget = state.contextBudget ?? cfg.contextBudgetTokens;
  const used = Math.max(estimate(state.messages), state.last_prompt_tokens);
  if (!cfg.compactEnabled || used < budget) {
    return { compacted: false, before: used, after: used, method: 'below-budget', droppedGroups: 0, messages: null };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<CompactResult>((r) => {
    timer = setTimeout(
      () => r({ compacted: false, before: used, after: used, method: 'timeout', droppedGroups: 0, messages: null }),
      120000
    );
  });
  try {
    return await Promise.race([maybeCompact(provider, state, cfg, budget), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
