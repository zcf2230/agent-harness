import fs from 'node:fs';
import path from 'node:path';
import type { GradeRule, TaskDef } from '../types.ts';
import type { HarnessConfig } from '../config.ts';
import { exec, resolveExecutable, safeResolve, nodeSandboxArgs } from '../agent/sandbox.ts';

function extractNumbers(s: string): number[] {
  const out: number[] = [];
  const boxed = /\$\?\\?boxed\{([^}]*)\}\$?|\\boxed\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  const cleaned = s.replace(/,/g, '');
  while ((m = boxed.exec(cleaned)) !== null) {
    const n = parseFloat((m[1] ?? m[2] ?? '').replace(/[^0-9.\-]/g, ''));
    if (Number.isFinite(n)) out.push(n);
  }
  const plain = /-?\d+(?:\.\d+)?/g;
  while ((m = plain.exec(cleaned)) !== null) {
    const n = parseFloat(m[0]);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

export type FailReason = 'none' | 'missing_deliverable' | 'wrong_answer' | 'grader_mismatch' | 'test_failed' | 'grader_tampered';

export async function gradeTask(
  task: TaskDef,
  workspace: string,
  answer: string | null,
  cfg: HarnessConfig
): Promise<{ pass: boolean; reason: FailReason; detail: string }> {
  const rule: GradeRule | undefined = task.grade;
  if (!rule) {
    const pass = answer != null && answer.length > 0;
    return { pass, reason: pass ? 'none' : 'wrong_answer', detail: '无判分规则，按是否提交答案计' };
  }
  try {
    switch (rule.type) {
      case 'answer_regex': {
        const re = new RegExp(rule.pattern, rule.flags ?? '');
        const s = answer ?? '';
        const pass = re.test(s);
        return { pass, reason: pass ? 'none' : 'wrong_answer', detail: `answer_regex ${rule.pattern} → ${pass ? '命中' : '未命中'}` };
      }
      case 'answer_number': {
        const nums = extractNumbers(answer ?? '');
        if (nums.length === 0) return { pass: false, reason: 'wrong_answer', detail: '答案中提取不到数字' };
        const tol = rule.tolerance ?? 1e-6;
        const hit = nums.find((n) => Math.abs(n - rule.expected) <= tol);
        const pass = hit != null;
        return {
          pass,
          reason: pass ? 'none' : 'wrong_answer',
          detail: pass
            ? `答案含正确值 ${hit}（期望 ${rule.expected}±${tol}）`
            : `候选 [${nums.join(', ')}]，无一匹配期望 ${rule.expected}±${tol}`,
        };
      }
      case 'file_regex': {
        const abs = safeResolve(workspace, rule.path);
        if (!fs.existsSync(abs)) return { pass: false, reason: 'missing_deliverable', detail: `文件不存在: ${rule.path}` };
        const text = fs.readFileSync(abs, 'utf8');
        const re = new RegExp(rule.pattern, rule.flags ?? 's');
        const pass = re.test(text);
        return { pass, reason: pass ? 'none' : 'grader_mismatch', detail: `file_regex ${rule.path} ${rule.pattern} → ${pass ? '命中' : '未命中'}` };
      }
      case 'run_test': {
        const parts = rule.command.split(/\s+/).filter(Boolean);
        const cmd = resolveExecutable(parts[0], cfg.pythonCommand);
        // 判分会执行模型写出的文件（solution.mjs / 交付物），必须与 run_js 同级沙箱，
        // 否则"把 payload 写进交付物、让判分器替你跑"即可越狱。
        const pre = cmd === process.execPath ? nodeSandboxArgs(workspace, cfg.sandboxNodePermission) : [];
        const r = await exec(cmd, [...pre, ...parts.slice(1)], {
          cwd: workspace,
          timeoutMs: rule.timeout_ms ?? cfg.execTimeoutMs,
          maxOutput: cfg.maxOutputChars,
        });
        if (r.code !== 0) {
          return {
            pass: false,
            reason: 'test_failed',
            detail: `判分命令 ${rule.command} 退出码 ${r.code}${r.timedOut ? '（超时）' : ''}: ${(r.stderr || r.stdout).slice(0, 300)}`,
          };
        }
        if (rule.stdout_regex) {
          const re = new RegExp(rule.stdout_regex, 'm');
          const pass = re.test(r.stdout);
          return { pass, reason: pass ? 'none' : 'grader_mismatch', detail: `命令通过，stdout_regex ${rule.stdout_regex} → ${pass ? '命中' : '未命中'}` };
        }
        return { pass: true, reason: 'none', detail: `命令 ${rule.command} 退出码 0` };
      }
      default:
        return { pass: false, reason: 'grader_mismatch', detail: '未知判分类型' };
    }
  } catch (e: any) {
    return { pass: false, reason: 'grader_mismatch', detail: `判分异常: ${e?.message ?? e}` };
  }
}

export function requiredOutputFiles(task: TaskDef): string[] {
  const rule = task.grade;
  if (rule && rule.type === 'file_regex') return [rule.path];
  return [];
}

export function loadTasks(dir: string): TaskDef[] {
  if (!fs.existsSync(dir)) return [];
  const out: TaskDef[] = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    const t = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as TaskDef;
    if (!t.id || !t.prompt) throw new Error(`任务文件缺少 id/prompt: ${f}`);
    out.push(t);
  }
  return out;
}
