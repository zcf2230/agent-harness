import type { HarnessConfig } from '../config.ts';
import { sleep } from '../util.ts';
import type { ChatProvider, ChatResponse, Message, ToolSpec } from '../types.ts';

const RETRY_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

function normalize(data: any): ChatResponse {
  const ch = data?.choices?.[0]?.message ?? { role: 'assistant', content: null };
  const message: Message = { role: 'assistant', content: ch.content ?? null };
  if (Array.isArray(ch.tool_calls) && ch.tool_calls.length > 0) {
    message.tool_calls = ch.tool_calls.map((tc: any, i: number) => ({
      id: tc.id ?? `call_${Date.now()}_${i}`,
      name: tc.function?.name ?? '',
      arguments:
        typeof tc.function?.arguments === 'string'
          ? tc.function.arguments
          : JSON.stringify(tc.function?.arguments ?? {}),
    }));
  }
  const u = data?.usage ?? {};
  return {
    message,
    usage: {
      prompt_tokens: u.prompt_tokens ?? 0,
      completion_tokens: u.completion_tokens ?? 0,
    },
  };
}

// 内部用扁平 tool_calls；回传给 OpenAI 兼容端点时必须还原成嵌套 function 结构，
// 否则 DeepSeek 会因缺少 type 字段返回 422。
export function toWire(messages: Message[]): unknown[] {
  return messages.map((m) => {
    if (m.role === 'assistant') {
      const out: Record<string, unknown> = { role: 'assistant', content: m.content ?? null };
      if (m.tool_calls && m.tool_calls.length > 0) {
        out.tool_calls = m.tool_calls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        }));
      }
      return out;
    }
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.tool_call_id, content: m.content ?? '' };
    }
    return { role: m.role, content: m.content ?? '' };
  });
}

export class OpenAIProvider implements ChatProvider {
  attempts: number;
  cfg: HarnessConfig;

  constructor(cfg: HarnessConfig) {
    this.cfg = cfg;
    this.attempts = 5;
  }

  async chat(messages: Message[], tools: ToolSpec[]): Promise<ChatResponse> {
    const body = JSON.stringify({
      model: this.cfg.model,
      messages: toWire(messages),
      tools:
        tools.length > 0
          ? tools.map((t) => ({
              type: 'function',
              function: { name: t.name, description: t.description, parameters: t.parameters },
            }))
          : undefined,
      tool_choice: tools.length > 0 ? 'auto' : undefined,
      temperature: this.cfg.temperature,
      max_tokens: this.cfg.maxTokens,
      stream: false,
    });
    const url = this.cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < this.attempts; attempt++) {
      if (attempt > 0) {
        await sleep(Math.min(15000, 600 * 2 ** attempt) + Math.random() * 300);
      }
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.cfg.apiKey}`,
          },
          body,
          signal: AbortSignal.timeout(180000),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          const err: any = new Error(`API ${res.status}: ${text.slice(0, 300)}`);
          err.status = res.status;
          if (!RETRY_STATUS.has(res.status)) throw err;
          lastErr = err;
          continue;
        }
        return normalize(await res.json());
      } catch (e: any) {
        if (e?.status != null && !RETRY_STATUS.has(e.status)) throw e;
        lastErr = e;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('provider 请求失败');
  }
}
