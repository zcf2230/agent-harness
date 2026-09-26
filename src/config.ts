import fs from 'node:fs';
import path from 'node:path';
import type { McpServerConfig, Usage } from './types.ts';

export interface HarnessConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  temperature: number;
  maxTokens: number;
  maxTurns: number;
  contextBudgetTokens: number;
  maxCostPerTask: number;
  deadlineMs: number;
  compactEnabled: boolean;
  execTimeoutMs: number;
  maxOutputChars: number;
  pythonCommand: string;
  sandboxNodePermission: boolean;
  terminationNudge: boolean;
  runsDir: string;
  priceInputPerMTok: number;
  priceOutputPerMTok: number;
  currency: string;
  mcpServers: Record<string, McpServerConfig>;
}

export const DEFAULTS: HarnessConfig = {
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  apiKey: '',
  temperature: 0.2,
  maxTokens: 4096,
  maxTurns: 12,
  contextBudgetTokens: 20000,
  maxCostPerTask: 0,
  deadlineMs: 0,
  compactEnabled: true,
  execTimeoutMs: 30000,
  maxOutputChars: 20000,
  pythonCommand: 'python',
  sandboxNodePermission: true,
  terminationNudge: true,
  runsDir: 'runs',
  // 默认为 DeepSeek-chat 的近似牌价（按缓存未命中口径），单位 元/百万 token。
  // 仅为可配置兜底：真实账单请以 DeepSeek 现行价目表为准，并按 config.json 覆盖。
  priceInputPerMTok: 1,
  priceOutputPerMTok: 2,
  currency: '¥',
  mcpServers: {},
};

export function loadConfig(cwd = process.cwd()): HarnessConfig {
  let fileCfg: Partial<HarnessConfig> = {};
  const f = path.join(cwd, 'config.json');
  if (fs.existsSync(f)) {
    fileCfg = JSON.parse(fs.readFileSync(f, 'utf8'));
  }
  const cfg: HarnessConfig = { ...DEFAULTS, ...fileCfg };
  if (process.env.DEEPSEEK_API_KEY) cfg.apiKey = process.env.DEEPSEEK_API_KEY;
  if (process.env.DEEPSEEK_BASE_URL) cfg.baseUrl = process.env.DEEPSEEK_BASE_URL;
  if (process.env.HARNESS_MODEL) cfg.model = process.env.HARNESS_MODEL;
  return cfg;
}

export function computeCost(usage: Usage, cfg: HarnessConfig): number {
  return (
    (usage.prompt_tokens * cfg.priceInputPerMTok +
      usage.completion_tokens * cfg.priceOutputPerMTok) /
    1e6
  );
}
