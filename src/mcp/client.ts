import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { McpServerConfig } from '../types.ts';

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface Pending {
  resolve: (v: any) => void;
  reject: (e: any) => void;
}

export const PROTOCOL_VERSION = '2025-03-26';

export class McpClient {
  proc: ChildProcess;
  stderrTail = '';
  serverInfo: { name?: string; version?: string } | null = null;
  protocolVersion = '';
  buf = '';
  nextId = 1;
  pending = new Map<number, Pending>();
  closed = false;

  constructor(cfg: McpServerConfig) {
    this.proc = spawn(cfg.command, cfg.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(cfg.env ?? {}) },
      cwd: cfg.cwd,
      windowsHide: true,
    });
    this.proc.stdout?.setEncoding('utf8');
    this.proc.stdout?.on('data', (chunk: string) => this.onData(chunk));
    this.proc.stderr?.setEncoding('utf8');
    this.proc.stderr?.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-2000);
    });
    this.proc.on('close', () => {
      this.closed = true;
      this.failAll(new Error('MCP 服务器进程已退出'));
    });
    this.proc.on('error', (e: any) => this.failAll(e));
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let idx = this.buf.indexOf('\n');
    while (idx >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (line) this.onLine(line);
      idx = this.buf.indexOf('\n');
    }
  }

  private onLine(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`MCP 错误 ${msg.error.code}: ${msg.error.message}`));
        else p.resolve(msg.result);
      }
      return;
    }
    if (msg.method != null && msg.id != null) {
      this.write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `client 未实现方法: ${msg.method}` } });
      return;
    }
  }

  private write(obj: unknown): void {
    this.proc.stdin?.write(JSON.stringify(obj) + '\n');
  }

  request(method: string, params?: unknown, timeoutMs = 15000): Promise<any> {
    if (this.closed) return Promise.reject(new Error('MCP 客户端已关闭'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`MCP 请求超时（${method}, ${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.write({ jsonrpc: '2.0', id, method, params: params ?? {} });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: '2.0', method, params: params ?? {} });
  }

  failAll(e: Error): void {
    for (const [, p] of this.pending) p.reject(e);
    this.pending.clear();
  }

  async initialize(): Promise<void> {
    const res = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'agent-harness', version: '0.1.0' },
    });
    this.serverInfo = res?.serverInfo ?? null;
    this.protocolVersion = res?.protocolVersion ?? '';
    this.notify('notifications/initialized');
  }

  async listTools(): Promise<McpToolDef[]> {
    const res = await this.request('tools/list');
    return Array.isArray(res?.tools) ? res.tools : [];
  }

  async callTool(name: string, args: unknown): Promise<any> {
    return await this.request('tools/call', { name, arguments: args ?? {} }, 60000);
  }

  close(): void {
    try {
      this.proc.stdin?.end();
    } catch {
      /* ignore */
    }
    try {
      this.proc.kill();
    } catch {
      /* ignore */
    }
  }
}
