export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface Message {
  role: Role;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
}

export interface ChatResponse {
  message: Message;
  usage: Usage;
}

export interface ChatProvider {
  chat(messages: Message[], tools: ToolSpec[]): Promise<ChatResponse>;
}

export interface WorkspaceFile {
  path: string;
  content: string;
}

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export type GradeRule =
  | { type: 'answer_regex'; pattern: string; flags?: string }
  | { type: 'answer_number'; expected: number; tolerance?: number }
  | { type: 'file_regex'; path: string; pattern: string; flags?: string }
  | { type: 'run_test'; command: string; stdout_regex?: string; timeout_ms?: number };

export interface TaskDef {
  id: string;
  name: string;
  category: string;
  prompt: string;
  difficulty?: 'easy' | 'hard';
  max_turns?: number;
  context_budget_tokens?: number;
  workspace_files?: WorkspaceFile[];
  grade?: GradeRule;
}

export type RunStatus = 'running' | 'final' | 'max_turns' | 'error';
export interface RunState {
  task_id: string;
  name: string;
  category: string;
  prompt: string;
  model: string;
  max_turns: number;
  contextBudget: number;
  turn: number;
  compactions: number;
  nudged: boolean;
  last_prompt_tokens: number;
  usage: Usage;
  status: RunStatus;
  answer: string | null;
  stop_reason: string | null;
  messages: Message[];
  started_at: string;
}
