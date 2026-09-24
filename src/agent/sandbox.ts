import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { uid } from '../util.ts';

export function safeResolve(workspace: string, p: string): string {
  if (!p || typeof p !== 'string') throw new Error('path 不能为空');
  if (path.isAbsolute(p) || /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\')) {
    throw new Error(`仅允许工作区相对路径，收到绝对路径: ${p}`);
  }
  const root = path.resolve(workspace);
  const abs = path.resolve(root, p);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`路径越界（禁止访问工作区之外）: ${p}`);
  }
  return abs;
}

export function relPath(workspace: string, abs: string): string {
  return path.relative(path.resolve(workspace), abs).split(path.sep).join('/');
}

export interface ExecOptions {
  cwd: string;
  timeoutMs: number;
  maxOutput: number;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  missing: boolean;
  ms: number;
}

export function exec(cmd: string, args: string[], o: ExecOptions): Promise<ExecResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        cwd: o.cwd,
        timeout: o.timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env },
      },
      (err: any, stdout, stderr) => {
        const out = String(stdout ?? '');
        const e2 = String(stderr ?? '');
        let code = 0;
        let timedOut = false;
        let missing = false;
        if (err) {
          timedOut = err.killed === true || err.signal != null;
          missing = err.code === 'ENOENT';
          code = typeof err.code === 'number' ? err.code : missing ? 127 : 1;
        }
        let truncatedOut = out;
        let truncatedErr = e2;
        if (truncatedOut.length + truncatedErr.length > o.maxOutput) {
          const keep = Math.max(0, o.maxOutput - 60);
          truncatedOut = truncatedOut.slice(0, keep) + '\n[输出已截断]';
          truncatedErr = '';
        }
        resolve({ code, stdout: truncatedOut, stderr: truncatedErr, timedOut, missing, ms: Date.now() - started });
      }
    );
  });
}

export function resolveExecutable(token: string, pythonCommand: string): string {
  const t = token.toLowerCase();
  if (t === 'node') return process.execPath;
  if (t === 'python' || t === 'python3' || t === 'py') return pythonCommand;
  return token;
}

export async function runScript(
  workspace: string,
  ext: string,
  code: string,
  cmd: string,
  o: ExecOptions,
  preArgs: string[] = []
): Promise<ExecResult> {
  const dir = path.join(workspace, '.sandbox');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `s-${uid(6)}.${ext}`);
  fs.writeFileSync(file, code, 'utf8');
  try {
    return await exec(cmd, [...preArgs, path.resolve(file)], o);
  } finally {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* 忽略清理失败 */
    }
  }
}
