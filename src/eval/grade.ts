import fs from 'node:fs';
import path from 'node:path';
import type { GradeRule, TaskDef } from '../types.ts';
import type { HarnessConfig } from '../config.ts';
import { exec, resolveExecutable, safeResolve } from '../agent/sandbox.ts';

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

export async function gradeTask(
  task: TaskDef,
  workspace: string,
  answer: string | null,
  cfg: HarnessConfig
): Promise<{ pass: boolean; detail: string }> {
  const rule: GradeRule | undefined = task.grade;
  if (!rule) {
    return { pass: answer != null && answer.length > 0, detail: '无判分规则，按是否提交答案计' };
  }
  try {
    switch (rule.type) {
      case 'answer_regex': {
        const re = new RegExp(rule.pattern, rule.flags ?? '');
        const s = answer ?? '';
        return { pass: re.test(s), detail: `answer_regex ${rule.pattern} → ${re.test(s) ? '命中' : '未命中'}` };
      }
      case 'answer_number': {
        const nums = extractNumbers(answer ?? '');
        if (nums.length === 0) return { pass: false, detail: '答案中提取不到数字' };
        const tol = rule.tolerance ?? 1e-6;
        const hit = nums.find((n) => Math.abs(n - rule.expected) <= tol);
        const pass = hit != null;
        return {
          pass,
          detail: pass
            ? `答案含正确值 ${hit}（期望 ${rule.expected}±${tol}）`
            : `候选 [${nums.join(', ')}]，无一匹配期望 ${rule.expected}±${tol}`,
        };
      }
      case 'file_regex': {
        const abs = safeResolve(workspace, rule.path);
        if (!fs.existsSync(abs)) return { pass: false, detail: `文件不存在: ${rule.path}` };
        const text = fs.readFileSync(abs, 'utf8');
        const re = new RegExp(rule.pattern, rule.flags ?? 's');
        return { pass: re.test(text), detail: `file_regex ${rule.path} ${rule.pattern} → ${re.test(text) ? '命中' : '未命中'}` };
      }
      case 'run_test': {
        const parts = rule.command.split(/\s+/).filter(Boolean);
        const cmd = resolveExecutable(parts[0], cfg.pythonCommand);
        const r = await exec(cmd, parts.slice(1), {
          cwd: workspace,
          timeoutMs: rule.timeout_ms ?? cfg.execTimeoutMs,
          maxOutput: cfg.maxOutputChars,
        });
        if (r.code !== 0) {
          return {
            pass: false,
            detail: `判分命令 ${rule.command} 退出码 ${r.code}${r.timedOut ? '（超时）' : ''}: ${(r.stderr || r.stdout).slice(0, 300)}`,
          };
        }
        if (rule.stdout_regex) {
          const re = new RegExp(rule.stdout_regex, 'm');
          const pass = re.test(r.stdout);
          return { pass, detail: `命令通过，stdout_regex ${rule.stdout_regex} → ${pass ? '命中' : '未命中'}` };
        }
        return { pass: true, detail: `命令 ${rule.command} 退出码 0` };
      }
      default:
        return { pass: false, detail: '未知判分类型' };
    }
  } catch (e: any) {
    return { pass: false, detail: `判分异常: ${e?.message ?? e}` };
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
