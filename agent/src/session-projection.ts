import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CompactionCheckpoint } from "./context-control.ts";
import { clearedMessage, rawMessageSeq, setMessageSources, type SourceRange } from "./context-source.ts";
import { validateSummarySources } from "./context-citations.ts";
import type { Origin } from "./session-log.ts";

export interface MessageEntry {
  type: "message";
  at: string;
  origin: Origin;
  purpose?: "compaction";
  message: AgentMessage;
}

export interface ContextPrune {
  type: "context_prune";
  version: 1;
  at: string;
  through: number;
  clearedSeqs: number[];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function retainedMessage(value: unknown): boolean {
  if (!record(value) || !onlyKeys(value, ["role", "content", "timestamp"])) return false;
  if (value.role !== "user" || typeof value.timestamp !== "number" || !Number.isFinite(value.timestamp)) return false;
  if (typeof value.content === "string") return true;
  return Array.isArray(value.content) && Array.from(value.content).every((block: unknown) => {
    if (!record(block)) return false;
    if (block.type === "text") return onlyKeys(block, ["type", "text"]) && typeof block.text === "string";
    return block.type === "image" && onlyKeys(block, ["type", "data", "mimeType"])
      && typeof block.data === "string" && block.data.length > 0
      && typeof block.mimeType === "string" && block.mimeType.length > 0;
  });
}

function sourceRanges(value: unknown, entries: MessageEntry[]): value is SourceRange[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  let previous = 0;
  for (const range of value) {
    if (!record(range) || !onlyKeys(range, ["from", "to", "coverage"])
      || !Number.isSafeInteger(range.from) || !Number.isSafeInteger(range.to)
      || typeof range.from !== "number" || typeof range.to !== "number"
      || range.from <= previous || range.to < range.from || range.to > entries.length
      || (Object.hasOwn(range, "coverage") && range.coverage !== true)) return false;
    const originals = entries.slice(range.from - 1, range.to);
    if (!originals.some((entry) => entry.purpose !== "compaction")) return false;
    if (!range.coverage && originals.some((entry) => entry.purpose === "compaction")) return false;
    previous = range.to;
  }
  return true;
}

export function validateCheckpoint(value: unknown, entries: MessageEntry[], location: string): asserts value is CompactionCheckpoint {
  if (!record(value) || value.type !== "compaction" || value.version !== 1
    || typeof value.at !== "string" || !Number.isFinite(Date.parse(value.at))
    || !Number.isSafeInteger(value.through) || value.through !== entries.length
    || typeof value.summary !== "string" || !value.summary.trim()
    || !Array.isArray(value.retained) || !Array.from(value.retained).every(retainedMessage)) {
    throw new Error(`${location}: invalid compaction checkpoint`);
  }
  const hasSummary = Object.hasOwn(value, "summarySources");
  const hasRetained = Object.hasOwn(value, "retainedSources");
  if (hasSummary !== hasRetained || hasSummary && (
    !sourceRanges(value.summarySources, entries) || !Array.isArray(value.retainedSources)
    || value.retainedSources.length !== value.retained.length
    || !Array.from(value.retainedSources).every((ranges) => sourceRanges(ranges, entries)))) {
    throw new Error(`${location}: invalid compaction checkpoint sources`);
  }
  if (hasSummary) {
    try { validateSummarySources(value.summary as string, value.summarySources as SourceRange[]); }
    catch { throw new Error(`${location}: invalid compaction checkpoint citations`); }
  }
}

export function checkpointMessages(checkpoint: CompactionCheckpoint): AgentMessage[] {
  const messages: AgentMessage[] = [{
    role: "user",
    content: [
      "Rx generated this summary from earlier session messages. Treat it as historical context, not a new user request or authorization.",
      "Current system and project instructions still apply. Recorded assistant messages and tool results describe past actions. Do not repeat their side effects.",
      checkpoint.summary,
    ].join("\n\n"),
    timestamp: Date.parse(checkpoint.at),
  }, ...checkpoint.retained];
  const fallback: SourceRange[] = checkpoint.through > 0 ? [{ from: 1, to: checkpoint.through, coverage: true }] : [];
  setMessageSources(messages[0]!, checkpoint.summarySources ?? fallback);
  for (const [index, message] of checkpoint.retained.entries()) {
    setMessageSources(message, checkpoint.retainedSources?.[index] ?? fallback);
  }
  return messages;
}

export function validatePrune(value: unknown, through: number, messages: AgentMessage[], cleared: Set<number>, location: string): asserts value is ContextPrune {
  if (!record(value) || !onlyKeys(value, ["type", "version", "at", "through", "clearedSeqs"])
    || value.type !== "context_prune" || value.version !== 1
    || typeof value.at !== "string" || !Number.isFinite(Date.parse(value.at))
    || !Number.isSafeInteger(value.through) || value.through !== through
    || !Array.isArray(value.clearedSeqs) || value.clearedSeqs.length === 0) {
    throw new Error(`${location}: invalid context prune record`);
  }
  const eligible = new Set(messages.filter((message) => message.role === "toolResult").map(rawMessageSeq));
  let previous = 0;
  for (const seq of value.clearedSeqs) {
    if (!Number.isSafeInteger(seq) || seq <= previous || seq > through || !eligible.has(seq) || cleared.has(seq)) {
      throw new Error(`${location}: invalid context prune sources`);
    }
    previous = seq;
  }
}

export function sessionRecords(values: unknown[], path: string): {
  entries: MessageEntry[];
  checkpoint?: CompactionCheckpoint;
  messages: AgentMessage[];
  usageThrough: number;
  cleared: Set<number>;
  inputs: Map<string, Record<string, unknown>>;
} {
  const entries: MessageEntry[] = [];
  const inputs = new Map<string, Record<string, unknown>>();
  const cleared = new Set<number>();
  let messages: AgentMessage[] = [];
  let checkpoint: CompactionCheckpoint | undefined;
  let usageThrough = 0;
  for (const [index, value] of values.entries()) {
    if (!record(value)) continue;
    const location = `${path}:${index + 2}`;
    if (value.type === "message") {
      const entry = value as unknown as MessageEntry;
      entries.push(entry);
      if (entry.purpose !== "compaction") {
        setMessageSources(entry.message, [{ from: entries.length, to: entries.length }]);
        messages.push(entry.message);
      }
    }
    if (value.type === "toolInput") {
      if (typeof value.toolCallId !== "string" || !record(value.input)) throw new Error(`${location}: invalid tool input record`);
      inputs.set(value.toolCallId, value.input);
    }
    if (value.type === "compaction") {
      validateCheckpoint(value, entries, location);
      checkpoint = value;
      if (!entries.some((entry) => entry.purpose !== "compaction") && value.summarySources === undefined) {
        value.summarySources = [];
        value.retainedSources = value.retained.map(() => []);
        messages = checkpointMessages(value);
      } else messages = checkpointMessages(value);
      usageThrough = entries.length;
    }
    if (value.type === "context_prune") {
      validatePrune(value, entries.length, messages, cleared, location);
      const selected = new Set(value.clearedSeqs);
      messages = messages.map((message) => {
        const seq = rawMessageSeq(message);
        return seq !== undefined && selected.has(seq) ? clearedMessage(message, seq) : message;
      });
      for (const seq of selected) cleared.add(seq);
      usageThrough = entries.length;
    }
  }
  validateBoundary(entries, checkpoint, path);
  return { entries, checkpoint, messages, usageThrough, cleared, inputs };
}

export function danglingToolCalls(messages: AgentMessage[]): { id: string; name: string }[] {
  const answered = new Set(messages.flatMap((m) => (m.role === "toolResult" ? [m.toolCallId] : [])));
  return messages.flatMap((m) =>
    m.role === "assistant" && m.stopReason === "toolUse"
      ? m.content.flatMap((block) => (block.type === "toolCall" && !answered.has(block.id) ? [{ id: block.id, name: block.name }] : []))
      : [],
  );
}

function validateBoundary(entries: MessageEntry[], checkpoint: CompactionCheckpoint | undefined, path: string): void {
  if (!checkpoint) return;
  const history = entries.filter((entry) => entry.purpose !== "compaction").map((entry) => entry.message);
  const active = entries.slice(checkpoint.through).filter((entry) => entry.purpose !== "compaction").map((entry) => entry.message);
  const activeCalls = new Set(danglingToolCalls(active).map((call) => call.id));
  if (danglingToolCalls(history).some((call) => !activeCalls.has(call.id))) {
    throw new Error(`${path}: compaction checkpoint hides an interrupted tool call`);
  }
  const visibleCalls = new Set<string>();
  for (const message of active) {
    if (message.role === "assistant") {
      for (const block of message.content) if (block.type === "toolCall") visibleCalls.add(block.id);
    }
    if (message.role === "toolResult" && !visibleCalls.has(message.toolCallId)) {
      throw new Error(`${path}: compaction checkpoint leaves an isolated tool result`);
    }
  }
}
