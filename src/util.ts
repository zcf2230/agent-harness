import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Message } from './types.ts';

export function uid(len = 8): string {
  return crypto.randomBytes(16).toString('hex').slice(0, len);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function clip(s: string, n: number): string {
  if (s == null) return '';
  return s.length <= n ? s : s.slice(0, n) + `…[共${s.length}字符已截断]`;
}

export function batchTs(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'task';
}

export function fmtSec(ms: number): string {
  return (ms / 1000).toFixed(1) + 's';
}

export function padCell(s: string, n: number): string {
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) > 0x2e7f ? 2 : 1;
  return s + ' '.repeat(Math.max(0, n - w));
}

export function writeJsonAtomic(file: string, obj: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

export function estimateTextTokens(s: string): number {
  if (!s) return 0;
  let ascii = 0;
  let other = 0;
  for (const ch of s) {
    if (ch.charCodeAt(0) < 0x2e80) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 4 + other);
}

export function estimateMessagesTokens(messages: Message[]): number {
  let t = 0;
  for (const m of messages) {
    t += 4 + estimateTextTokens(m.content ?? '');
    for (const tc of m.tool_calls ?? []) {
      t += 8 + estimateTextTokens(tc.name + tc.arguments);
    }
  }
  return t;
}
