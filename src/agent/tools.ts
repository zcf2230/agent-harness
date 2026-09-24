import fs from 'node:fs';
import path from 'node:path';
import type { HarnessConfig } from '../config.ts';
import type { ToolSpec } from '../types.ts';
import { clip } from '../util.ts';
import { relPath, runScript, safeResolve } from './sandbox.ts';

export interface ToolContext {
  workspace: string;
  cfg: HarnessConfig;
}

export interface ToolResult {
  ok: boolean;
  output: string;
  ms: number;
}

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'read_file',
    description: '读取工作区内文本文件的按行内容。输出过长时会截断，可用 offset/limit 分段读取。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '工作区相对路径，如 src/app.js' },
        offset: { type: 'integer', description: '起始行号（从 1 开始），默认 1' },
        limit: { type: 'integer', description: '最多读取行数，默认 300，上限 800' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: '将 UTF-8 文本写入工作区文件（覆盖写入，自动创建父目录）。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '工作区相对路径' },
        content: { type: 'string', description: '完整文件内容' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_files',
    description: '递归列出工作区目录结构（最多 400 条，目录以 / 结尾）。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '起始目录，默认工作区根目录' },
      },
    },
  },
  {
    name: 'find_text',
    description: '在工作区文本文件中搜索字符串或正则，返回 文件:行号: 内容。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '要搜索的文本（regex=true 时按正则解析）' },
        path: { type: 'string', description: '搜索起始目录，默认根目录' },
        regex: { type: 'boolean', description: '是否按正则搜索，默认 false' },
        max_results: { type: 'integer', description: '最多返回条数，默认 30' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'run_js',
    description: '在沙箱目录中用本地 Node.js 执行一段 JavaScript（ESM 模块，用 import 而非 require）。返回 exit 码与 stdout/stderr。',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '要执行的完整 JS 代码' },
      },
      required: ['code'],
    },
  },
  {
    name: 'run_py',
    description: '在沙箱目录中用本地 Python 执行一段代码。返回 exit 码与 stdout/stderr。',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '要执行的完整 Python 代码' },
      },
      required: ['code'],
    },
  },
  {
    name: 'finish',
    description: '任务完成时调用，提交最终答案。answer 用一两句话说明结果、关键数字与你创建/修改的文件。',
    parameters: {
      type: 'object',
      properties: {
        answer: { type: 'string', description: '最终答案' },
      },
      required: ['answer'],
    },
  },
];

function fmtExec(r: { code: number; stdout: string; stderr: string; timedOut: boolean; missing: boolean }): string {
  let s = `exit=${r.code}${r.timedOut ? '（超时被终止）' : ''}${r.missing ? '（可执行文件不存在）' : ''}\n`;
  if (r.stdout.trim()) s += `[stdout]\n${r.stdout}\n`;
  if (r.stderr.trim()) s += `[stderr]\n${r.stderr}\n`;
  if (!r.stdout.trim() && !r.stderr.trim()) s += '（无输出）';
  if (r.missing) s += '\n提示：若为 python，请在 config.json 中把 pythonCommand 设为完整路径。';
  return s.trimEnd();
}

function nodeSandboxArgs(workspace: string, cfg: HarnessConfig): string[] {
  if (!cfg.sandboxNodePermission) return [];
  const ws = path.resolve(workspace);
  return ['--permission', `--allow-fs-read=${ws}`, `--allow-fs-write=${ws}`];
}

function walkFiles(dir: string, base: string, acc: { rel: string; abs: string }[], limit: number): void {
  if (acc.length >= limit) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === '.sandbox' || e.name === 'node_modules' || e.name.startsWith('.git')) continue;
    const abs = path.join(dir, e.name);
    const rel = base ? `${base}/${e.name}` : e.name;
    if (acc.length >= limit) return;
    if (e.isDirectory()) {
      walkFiles(abs, rel, acc, limit);
    } else {
      acc.push({ rel, abs });
    }
  }
}

export async function executeTool(
  ctx: ToolContext,
  name: string,
  argsRaw: string
): Promise<ToolResult> {
  const t0 = Date.now();
  const done = (ok: boolean, output: string): ToolResult => ({ ok, output, ms: Date.now() - t0 });
  let args: any = {};
  try {
    args = argsRaw ? JSON.parse(argsRaw) : {};
  } catch {
    return done(false, `错误: 工具参数不是合法 JSON: ${clip(String(argsRaw), 200)}`);
  }
  const cfg = ctx.cfg;
  try {
    switch (name) {
      case 'read_file': {
        const abs = safeResolve(ctx.workspace, args.path);
        const text = fs.readFileSync(abs, 'utf8');
        const lines = text.split(/\r?\n/);
        const offset = Math.max(1, args.offset ?? 1);
        const limit = Math.min(800, args.limit ?? 300);
        const slice = lines.slice(offset - 1, offset - 1 + limit);
        const header = `${args.path}（共 ${lines.length} 行，显示第 ${offset}-${offset + slice.length - 1} 行）\n`;
        return done(true, clip(header + slice.join('\n'), cfg.maxOutputChars));
      }
      case 'write_file': {
        const abs = safeResolve(ctx.workspace, args.path);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        const content = String(args.content ?? '');
        fs.writeFileSync(abs, content, 'utf8');
        return done(true, `已写入 ${args.path}（${Buffer.byteLength(content, 'utf8')} 字节）`);
      }
      case 'list_files': {
        const start = safeResolve(ctx.workspace, args.path ?? '.');
        const rootRel = relPath(ctx.workspace, start);
        const out: string[] = [];
        const walk = (dir: string, base: string) => {
          if (out.length >= 400) return;
          let entries;
          try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
          } catch {
            return;
          }
          for (const e of entries) {
            if (e.name === '.sandbox' || e.name === 'node_modules' || e.name.startsWith('.git')) continue;
            const abs = path.join(dir, e.name);
            const rel = base ? `${base}/${e.name}` : e.name;
            if (out.length >= 400) return;
            if (e.isDirectory()) {
              out.push(`${rootRel ? rootRel + '/' : ''}${rel}/`);
              walk(abs, rel);
            } else {
              const size = fs.statSync(abs).size;
              out.push(`${rootRel ? rootRel + '/' : ''}${rel} (${size}B)`);
            }
          }
        };
        walk(start, '');
        return done(true, out.length ? clip(out.join('\n'), cfg.maxOutputChars) : '（目录为空）');
      }
      case 'find_text': {
        let re: RegExp;
        if (args.regex) {
          re = new RegExp(String(args.pattern), 'g');
        } else {
          re = new RegExp(String(args.pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
        }
        const max = Math.min(100, args.max_results ?? 30);
        const start = safeResolve(ctx.workspace, args.path ?? '.');
        const files: { rel: string; abs: string }[] = [];
        const st = fs.statSync(start);
        if (st.isFile()) files.push({ rel: args.path, abs: start });
        else walkFiles(start, '', files, 600);
        const hits: string[] = [];
        for (const f of files) {
          if (hits.length >= max) break;
          let size = 0;
          try {
            size = fs.statSync(f.abs).size;
          } catch {
            continue;
          }
          if (size > 512 * 1024) continue;
          const text = fs.readFileSync(f.abs, 'utf8');
          if (text.includes('\u0000')) continue;
          const lines = text.split(/\r?\n/);
          for (let i = 0; i < lines.length && hits.length < max; i++) {
            re.lastIndex = 0;
            if (re.test(lines[i])) {
              hits.push(`${f.rel}:${i + 1}: ${clip(lines[i].trim(), 200)}`);
            }
          }
        }
        return done(true, hits.length ? clip(hits.join('\n'), cfg.maxOutputChars) : '无匹配');
      }
      case 'run_js': {
        const pre = nodeSandboxArgs(ctx.workspace, cfg);
        const r = await runScript(ctx.workspace, 'mjs', String(args.code ?? ''), process.execPath, {
          cwd: ctx.workspace,
          timeoutMs: cfg.execTimeoutMs,
          maxOutput: cfg.maxOutputChars,
        }, pre);
        return done(r.code === 0, clip(fmtExec(r), cfg.maxOutputChars));
      }
      case 'run_py': {
        const r = await runScript(ctx.workspace, 'py', String(args.code ?? ''), cfg.pythonCommand, {
          cwd: ctx.workspace,
          timeoutMs: cfg.execTimeoutMs,
          maxOutput: cfg.maxOutputChars,
        });
        return done(r.code === 0, clip(fmtExec(r), cfg.maxOutputChars));
      }
      default:
        return done(false, `错误: 未知工具 "${name}"，可用工具: ${TOOL_SPECS.map((t) => t.name).join(', ')}`);
    }
  } catch (e: any) {
    return done(false, `错误: ${e?.message ?? e}`);
  }
}
