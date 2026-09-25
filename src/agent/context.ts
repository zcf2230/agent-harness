import type { HarnessConfig } from '../config.ts';
import type { ChatProvider, Message, RunState } from '../types.ts';
import { clip, estimateMessagesTokens } from '../util.ts';

const COMPACT_SYS =
  '你是 agent 执行历史的压缩器。用中文要点式总结下面的执行记录：' +
  '1) 任务目标与硬性约束（原样保留文件名/路径/数字/命令）' +
  '2) 已完成的步骤与关键结论 3) 创建或修改过的文件及其作用 ' +
  '4) 遇到过的错误与解决方法 5) 尚未完成的事项。' +
  '只输出摘要本身，不超过 400 字。';

export function estimate(messages: Message[]): number {
  return estimateMessagesTokens(messages);
}

export function splitGroups(messages: Message[]): { head: Message[]; groups: Message[][] } {
  const head: Message[] = [];
  const groups: Message[][] = [];
  for (const m of messages) {
    if (groups.length === 0 && (m.role === 'system' || m.role === 'user')) {
      head.push(m);
      continue;
    }
    if (m.role === 'assistant') {
      groups.push([m]);
    } else if (groups.length > 0) {
      groups[groups.length - 1].push(m);
    } else {
      head.push(m);
    }
  }
  return { head, groups };
}

function serializeForSummary(m: Message, maxChars: number): string {
  const parts: string[] = [];
  if (m.content) parts.push(`[${m.role}] ${clip(m.content, maxChars)}`);
  for (const tc of m.tool_calls ?? []) {
    parts.push(`[assistant 调用工具] ${tc.name}(${clip(tc.arguments, maxChars)})`);
  }
  if (m.role === 'tool' && m.content) {
    parts.push(`[工具 ${m.name ?? ''} 返回] ${clip(m.content, maxChars)}`);
  }
  return parts.join('\n');
}

function ruleDigest(groups: Message[][]): string {
  const lines: string[] = [];
  for (const g of groups) {
    for (const m of g) {
      for (const tc of m.tool_calls ?? []) {
        lines.push(`- 调用 ${tc.name}: ${clip(tc.arguments, 100)}`);
      }
      if (m.role === 'tool') {
        const first = (m.content ?? '').split('\n')[0] ?? '';
        lines.push(`  结果: ${clip(first, 120)}`);
      }
    }
  }
  return lines.length ? lines.join('\n') : '（无可摘要内容）';
}

export interface CompactResult {
  compacted: boolean;
  before: number;
  after: number;
  method: string;
  droppedGroups: number;
  messages: Message[] | null;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

const NO_COMPACT: CompactResult = {
  compacted: false,
  before: 0,
  after: 0,
  method: 'none',
  droppedGroups: 0,
  messages: null,
};

export async function compactMessages(
  provider: ChatProvider,
  messages: Message[],
  keepGroups: number
): Promise<CompactResult> {
  const before = estimate(messages);
  const { head, groups } = splitGroups(messages);
  const keep = Math.min(groups.length, Math.max(2, keepGroups));
  const dropped = groups.slice(0, groups.length - keep);
  const kept = groups.slice(groups.length - keep);
  if (dropped.length === 0) {
    return { ...NO_COMPACT, before, after: before };
  }
  const transcript = dropped
    .flat()
    .map((m) => serializeForSummary(m, 500))
    .join('\n---\n');
  let summary = '';
  let method = 'rule';
  let usage: { prompt_tokens: number; completion_tokens: number } | undefined;
  try {
    const resp = await provider.chat(
      [
        { role: 'system', content: COMPACT_SYS },
        { role: 'user', content: transcript },
      ],
      []
    );
    summary = (resp.message.content ?? '').trim();
    usage = resp.usage;
    if (summary) method = 'llm';
  } catch {
    /* 走规则兜底 */
  }
  if (!summary) summary = ruleDigest(dropped);
  const out: Message[] = [
    ...head,
    {
      role: 'system',
      content:
        `[上下文压缩] 以下 ${dropped.length} 个回合的历史已被压缩为摘要，细节（文件内容、完整输出）已省略，需要时可重新读取文件或重跑命令获得：\n${summary}`,
    },
    ...kept.flat(),
  ];
  const after = estimate(out);
  if (after >= before) {
    return { ...NO_COMPACT, before, after: before, method: 'no-benefit' };
  }
  return { compacted: true, before, after, method, droppedGroups: dropped.length, messages: out, usage };
}

export async function maybeCompact(
  provider: ChatProvider,
  state: RunState,
  cfg: HarnessConfig,
  budget: number
): Promise<CompactResult> {
  if (!cfg.compactEnabled) {
    return { ...NO_COMPACT, method: 'disabled' };
  }
  const used = Math.max(estimate(state.messages), state.last_prompt_tokens);
  if (used < budget) {
    return { ...NO_COMPACT, before: used, after: used };
  }
  const result = await compactMessages(provider, state.messages, 4);
  if (result.compacted && result.messages) {
    state.messages = result.messages;
    if (result.usage) {
      state.usage.prompt_tokens += result.usage.prompt_tokens;
      state.usage.completion_tokens += result.usage.completion_tokens;
    }
  }
  return result;
}
