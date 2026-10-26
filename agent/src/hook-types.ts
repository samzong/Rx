export const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop"] as const;

export type HookEvent = typeof HOOK_EVENTS[number];

export interface HookCommand {
  readonly command: string;
  readonly timeout: number;
}

export interface HookGroup {
  readonly matcher?: RegExp;
  readonly commands: readonly HookCommand[];
}

export type HookConfiguration = Readonly<Partial<Record<HookEvent, readonly HookGroup[]>>>;

export interface HookInput {
  hook_event_name: HookEvent;
  session_id: string;
  cwd: string;
  transcript_path: string;
  transcript_format: "rx-jsonl-v1";
  source?: "startup" | "resume";
  prompt?: string;
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  error?: string;
}

export interface HookOutput {
  blocked: boolean;
  reason?: string;
  context?: string;
  diagnostic?: string;
}

export interface HookCommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
}
