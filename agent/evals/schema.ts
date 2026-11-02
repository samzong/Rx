import { z } from "zod";

const relativePath = z.string().min(1).refine((value) => !value.startsWith("/") && !value.split(/[\\/]/).includes("..") && !value.includes("\0"), "Use a relative path inside the task directory.");
const command = z.array(z.string()).min(1);
export const dimensionSchema = z.enum(["correctness", "constraints", "evidence"]);
export const stateSchema = z.enum(["planned", "completed", "failed", "infra_error", "unscored"]);
export const taskSchema = z.strictObject({
  version: z.literal(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
  family: z.string().min(1),
  split: z.enum(["development", "holdout"]),
  requirement: z.strictObject({ prompt: z.string().min(1), constraints: z.array(z.string()) }),
  initial: z.strictObject({ directory: relativePath, sha256: z.string().regex(/^[a-f0-9]{64}$/), base: z.string().min(1) }),
  environment: z.strictObject({ instructions: z.array(z.string()), runtime: z.string().min(1) }),
  acceptance: z.strictObject({
    directory: relativePath,
    revision: z.string().min(1),
    checks: z.array(z.strictObject({ id: z.string().min(1), dimension: dimensionSchema, argv: command })).min(1),
  }),
  reference: z.strictObject({ directory: relativePath, alternativeDirectory: relativePath, incorrectDirectory: relativePath }),
  provenance: z.strictObject({ sources: z.array(z.strictObject({ kind: z.enum(["rx", "lody", "claude", "codex"]), reference: z.string().min(1) })).min(1), reconstruction: z.string().min(1) }),
});

export type Task = z.infer<typeof taskSchema>;
export type RunState = z.infer<typeof stateSchema>;
export type Dimension = z.infer<typeof dimensionSchema>;
export interface CheckResult { id: string; dimension: Dimension; passed: boolean; exitCode: number | null; stdout?: string; stderr?: string }
export interface AgentResult {
  exitCode: number | null;
  completed: boolean;
  model: string;
  thinking: string;
  text: string;
  events: unknown[];
  usage: { input: number; output: number } | "unknown";
  cost: { usd: number; basis: "agent_reported" } | "unknown";
  configuration?: { provider: string; model: string; effort: string };
  infrastructureError?: string;
}
export interface Attempt {
  task: string;
  split: Task["split"];
  attempt: number;
  state: RunState;
  seconds: number;
  started?: string;
  checks: CheckResult[];
  result?: AgentResult;
  reason?: string;
  artifacts?: { directory: string; sha256: string; omitted: string[]; redacted: boolean };
}
export const publicTaskSchema = z.toJSONSchema(taskSchema);
