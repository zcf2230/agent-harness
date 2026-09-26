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
  const keep = Math.min(groups.length, Math.max(1, keepGroups));
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
    // 摘要调用已经发生、token 已花费：no-benefit 也要把 usage 带出去，否则成本核算漏计这次调用。
    return { ...NO_COMPACT, before, after: before, method: 'no-benefit', usage };
  }
  return { compacted: true, before, after, method, droppedGroups: dropped.length, messages: out, usage };
}

// 按 token 预算从最新往回决定保留几个完整回合：只保留塞得进预算的最近组，其余丢弃。
// 这样只要总用量超预算就会触发压缩（不再要求攒够固定 4 组），修掉"空对照"。
export function groupsToKeepForBudget(messages: Message[], budget: number): number {
  const { head, groups } = splitGroups(messages);
  if (groups.length < 2) return groups.length;
  let tok = estimate(head) + 200;
  let keep = 0;
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = estimate(groups[i]);
    if (keep > 0 && tok + g > budget) break;
    tok += g;
    keep++;
  }
  return Math.max(1, Math.min(keep, groups.length - 1));
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
  const keepGroups = groupsToKeepForBudget(state.messages, budget);
  const result = await compactMessages(provider, state.messages, keepGroups);
  if (result.compacted && result.messages) {
    state.messages = result.messages;
  }
  // 摘要调用无论是否最终采纳都真实产生了 token/成本：只要带 usage 就累计，兑现"压缩自身计入成本"。
  if (result.usage) {
    state.usage.prompt_tokens += result.usage.prompt_tokens;
    state.usage.completion_tokens += result.usage.completion_tokens;
  }
  return result;
}
