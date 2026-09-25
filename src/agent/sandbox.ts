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

// 子进程环境白名单：只透传解释器运行所需的变量，剥离 DEEPSEEK_API_KEY 等机密，
// 防止模型生成的代码（run_js / 被判分执行的脚本）通过 process.env 读到凭据。
const ENV_ALLOW = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR',
  'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
  'LANG', 'LC_ALL', 'SHELL', 'NODE_OPTIONS', 'PYTHONHOME', 'PYTHONPATH',
  'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'FORCE_COLOR',
]);

export function childEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && ENV_ALLOW.has(k.toUpperCase())) out[k] = v;
  }
  return out;
}

// Node 权限模型旗标：把 run_js 及被判分执行的 node 脚本的文件读写关进工作区。
export function nodeSandboxArgs(workspace: string, enabled: boolean): string[] {
  if (!enabled) return [];
  const ws = path.resolve(workspace);
  return ['--permission', `--allow-fs-read=${ws}`, `--allow-fs-write=${ws}`];
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
        env: childEnv(),
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
          // 保留 stderr 头部（报错信息最关键），再分配剩余预算给 stdout，绝不整段丢弃 stderr
          const errBudget = Math.min(e2.length, Math.floor(o.maxOutput * 0.5));
          truncatedErr = e2.slice(0, errBudget) + (e2.length > errBudget ? '\n[stderr 已截断]' : '');
          const outBudget = Math.max(0, o.maxOutput - errBudget - 40);
          truncatedOut = out.slice(0, outBudget) + (out.length > outBudget ? '\n[stdout 已截断]' : '');
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
