import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { SourceRange } from "./context-source.ts";

export interface CompactionCheckpoint {
  type: "compaction";
  version: 1;
  at: string;
  through: number;
  summary: string;
  retained: AgentMessage[];
  summarySources?: SourceRange[];
  retainedSources?: SourceRange[][];
}

export interface CompactionEvent {
  id: string;
  status: "in_progress" | "completed" | "failed";
  message?: string;
}

export interface ContextControl {
  compact(): Promise<void>;
  abort(): void;
  waitForIdle(): Promise<void>;
  subscribe(listener: (event: CompactionEvent) => void): () => void;
}

const controls = new WeakMap<Agent, ContextControl>();

export function registerContextControl(agent: Agent, control: ContextControl): void {
  controls.set(agent, control);
}

export function contextControl(agent: Agent): ContextControl {
  const control = controls.get(agent);
  if (!control) throw new Error("Context control is not available for this agent");
  return control;
}
