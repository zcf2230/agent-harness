import type { McpServerConfig, ToolSpec } from '../types.ts';
import type { ToolResult } from '../agent/tools.ts';
import { McpClient, type McpToolDef } from './client.ts';

export interface McpServerReport {
  key: string;
  ok: boolean;
  tools: string[];
  error?: string;
}

export interface McpBridge {
  specs: ToolSpec[];
  servers: McpServerReport[];
  has(name: string): boolean;
  call(name: string, argsRaw: string): Promise<ToolResult>;
  close(): Promise<void>;
}

const EMPTY: McpBridge = {
  specs: [],
  servers: [],
  has: () => false,
  call: async () => ({ ok: false, output: '未连接任何 MCP 服务器', ms: 0 }),
  close: async () => {},
};

export function emptyMcpBridge(): McpBridge {
  return EMPTY;
}

function toSpec(key: string, tool: McpToolDef): ToolSpec {
  const params =
    tool.inputSchema && typeof tool.inputSchema === 'object'
      ? tool.inputSchema
      : { type: 'object', properties: {} };
  return {
    name: `${key}__${tool.name}`,
    description: `[MCP:${key}] ${tool.description ?? '(无描述)'}`,
    parameters: params,
  };
}

export async function connectMcpServers(
  servers: Record<string, McpServerConfig> | undefined
): Promise<McpBridge> {
  const keys = servers ? Object.keys(servers) : [];
  if (keys.length === 0) return EMPTY;

  const clients: McpClient[] = [];
  const specs: ToolSpec[] = [];
  const routes = new Map<string, { client: McpClient; tool: string }>();
  const report: McpServerReport[] = [];

  for (const key of keys) {
    const entry: McpServerReport = { key, ok: false, tools: [] };
    try {
      const client = new McpClient(servers![key]);
      await client.initialize();
      const tools = await client.listTools();
      clients.push(client);
      for (const t of tools) {
        const spec = toSpec(key, t);
        specs.push(spec);
        routes.set(spec.name, { client, tool: t.name });
        entry.tools.push(t.name);
      }
      entry.ok = true;
    } catch (e: any) {
      entry.error = String(e?.message ?? e);
    }
    report.push(entry);
  }

  return {
    specs,
    servers: report,
    has: (name) => routes.has(name),
    async call(name, argsRaw): Promise<ToolResult> {
      const t0 = Date.now();
      const target = routes.get(name);
      if (!target) return { ok: false, output: `未知 MCP 工具: ${name}`, ms: Date.now() - t0 };
      let args: unknown = {};
      try {
        args = argsRaw ? JSON.parse(argsRaw) : {};
      } catch {
        return { ok: false, output: `MCP 工具参数不是合法 JSON: ${String(argsRaw).slice(0, 200)}`, ms: Date.now() - t0 };
      }
      try {
        const res = await target.client.callTool(target.tool, args);
        const parts = Array.isArray(res?.content) ? res.content : [];
        const text =
          parts
            .map((p: any) => (p?.type === 'text' ? p.text : `[${p?.type ?? 'unknown'} 内容]`))
            .join('\n') || '（MCP 无文本返回）';
        const isError = res?.isError === true;
        return {
          ok: !isError,
          output: (isError ? 'MCP 工具返回错误：\n' : '') + text,
          ms: Date.now() - t0,
        };
      } catch (e: any) {
        return { ok: false, output: `MCP 调用失败: ${e?.message ?? e}`, ms: Date.now() - t0 };
      }
    },
    async close() {
      for (const c of clients) c.close();
    },
  };
}
