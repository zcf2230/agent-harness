import type { ChatProvider, ChatResponse, Message, ToolSpec } from '../types.ts';
import { uid } from '../util.ts';

export type MockPlan = (messages: Message[], tools: ToolSpec[], turn: number) => ChatResponse | undefined;

export function callTool(name: string, args: unknown, content: string | null = null): ChatResponse {
  return {
    message: {
      role: 'assistant',
      content,
      tool_calls: [{ id: `call_${uid(6)}`, name, arguments: JSON.stringify(args) }],
    },
    usage: { prompt_tokens: 100, completion_tokens: 20 },
  };
}

export function finish(answer: string): ChatResponse {
  return callTool('finish', { answer });
}

export class MockProvider implements ChatProvider {
  turn = 0;
  plan: MockPlan | null;

  constructor(plan?: MockPlan) {
    this.plan = plan ?? null;
  }

  async chat(messages: Message[], tools: ToolSpec[]): Promise<ChatResponse> {
    this.turn++;
    const planned = this.plan ? this.plan(messages, tools, this.turn) : undefined;
    if (planned) return planned;
    return finish('MOCK');
  }
}
