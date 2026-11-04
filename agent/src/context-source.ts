import type { AgentMessage } from "@earendil-works/pi-agent-core";

export interface SourceRange {
  from: number;
  to: number;
  coverage?: true;
}

export interface HistoryRecord {
  seq: number;
  origin: string;
  purpose?: "compaction";
  message: AgentMessage;
}

export interface HistorySnapshot {
  entries: HistoryRecord[];
  inputs: ReadonlyMap<string, Record<string, unknown>>;
}

export interface SessionHistoryReader {
  readonly home: string;
  readonly id: string;
  readRange(from: number, to: number): HistorySnapshot;
}

const sources = new WeakMap<AgentMessage, SourceRange[]>();
const invalidatedUsage = new WeakSet<AgentMessage>();

export function invalidateContextUsage(messages: AgentMessage[]): void {
  for (const message of messages) if (message.role === "assistant") invalidatedUsage.add(message);
}

export function contextUsageInvalidated(message: AgentMessage): boolean {
  return invalidatedUsage.has(message);
}

export function contextRequestMessage(message: AgentMessage): AgentMessage {
  if (message.role !== "assistant" || !invalidatedUsage.has(message)) return message;
  const request = {
    ...message,
    usage: { ...message.usage, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
  };
  invalidatedUsage.add(request);
  return request;
}

export function setMessageSources(message: AgentMessage, ranges: SourceRange[]): void {
  sources.set(message, ranges.map((range) => ({ ...range })));
}

export function messageSources(message: AgentMessage): SourceRange[] {
  return sources.get(message)?.map((range) => ({ ...range })) ?? [];
}

export function rawMessageSeq(message: AgentMessage): number | undefined {
  const ranges = messageSources(message);
  const first = ranges[0];
  return ranges.length === 1 && first && !first.coverage && first.from === first.to ? first.from : undefined;
}

export function clearedMessage(message: AgentMessage, seq: number): AgentMessage {
  if (message.role !== "toolResult") throw new Error("Only tool results can be cleared");
  const result: AgentMessage = { ...message, content: [{ type: "text", text: `[cleared, log seq ${seq}]` }] };
  setMessageSources(result, [{ from: seq, to: seq }]);
  return result;
}
