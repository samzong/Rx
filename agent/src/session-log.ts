import { appendFileSync, chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { uuidv7, type AssistantMessage, type ToolResultMessage } from "@earendil-works/pi-ai";
import type { CompactionCheckpoint } from "./context-control.ts";
import { isAlive, tryLink } from "./pid-lock.ts";

export type Origin = "cli" | "acp" | "model" | "tool" | "rx";

export const LOG_VERSION = 1;

interface SessionHeader {
  v: number;
  type: "session";
  id: string;
  cwd: string;
  createdAt: string;
}

interface MessageEntry {
  type: "message";
  at: string;
  origin: Origin;
  purpose?: "compaction";
  message: AgentMessage;
}

export interface SessionInfo {
  id: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  title: string;
}

export interface LoadedSession {
  log: SessionLog;
  entries: MessageEntry[];
  messages: AgentMessage[];
  history: AgentMessage[];
  usageMessages: AgentMessage[];
  repaired: number;
}

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const INTERRUPTED_TOOL_TEXT =
  "rx stopped before this tool call finished, so its result was not recorded. Its side effects are unknown: it may have run partly, fully, or not at all. Inspect the current state before retrying; rx does not re-run it automatically.";

function sessionsDir(home: string): string {
  return join(home, "sessions");
}

function sessionPath(home: string, id: string): string {
  if (!ID_PATTERN.test(id)) throw new Error(`invalid session id "${id}"`);
  return join(sessionsDir(home), `${id}.jsonl`);
}

function ensureDir(home: string): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(sessionsDir(home), { recursive: true, mode: 0o700 });
  chmodSync(sessionsDir(home), 0o700);
}

function readLog(path: string): { values: unknown[]; end: number; size: number } {
  const buffer = readFileSync(path);
  const end = buffer.lastIndexOf(0x0a) + 1;
  const lines = buffer.subarray(0, end).toString("utf8").split("\n");
  lines.pop();
  const values = lines.map((line, index) => {
    try {
      return JSON.parse(line) as unknown;
    } catch (error) {
      throw new Error(`${path}:${index + 1}: corrupt log line: ${(error as Error).message}`);
    }
  });
  return { values, end, size: buffer.length };
}

const heldLocks = new Set<string>();

function releaseLocks(): void {
  for (const path of heldLocks) {
    try {
      unlinkSync(path);
    } catch {}
  }
  heldLocks.clear();
}

function lockPath(home: string, id: string): string {
  return join(sessionsDir(home), `${id}.lock`);
}

function lockSession(home: string, id: string): boolean {
  const path = lockPath(home, id);
  if (heldLocks.has(path)) return false;
  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, String(process.pid), { mode: 0o600 });
    while (!tryLink(temp, path)) {
      let owner = Number.NaN;
      try {
        owner = Number(readFileSync(path, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (owner > 0 && owner !== process.pid && isAlive(owner)) {
        throw new Error(`session ${id} is in use by process ${owner}; if no rx process is using it, delete ${path}`);
      }
      try {
        unlinkSync(path);
      } catch {}
    }
  } finally {
    rmSync(temp, { force: true });
  }
  if (heldLocks.size === 0) process.once("exit", releaseLocks);
  heldLocks.add(path);
  return true;
}

function unlockSession(home: string, id: string): void {
  const path = lockPath(home, id);
  heldLocks.delete(path);
  try {
    unlinkSync(path);
  } catch {}
}

export function readSessionHeader(home: string, id: string): { id: string; cwd: string; createdAt: string } {
  const path = sessionPath(home, id);
  return readHeader(path, readLog(path).values[0]);
}

function readHeader(path: string, value: unknown): SessionHeader {
  const header = value as Partial<SessionHeader> | undefined;
  if (header?.type !== "session") throw new Error(`${path}: missing session header`);
  if (header.v !== LOG_VERSION) throw new Error(`${path}: unsupported session log version ${String(header.v)}`);
  return header as SessionHeader;
}

function userText(message: AgentMessage): string | undefined {
  if (message.role !== "user") return undefined;
  if (typeof message.content === "string") return message.content;
  return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(" ");
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

function validateCheckpoint(value: unknown, through: number, location: string): asserts value is CompactionCheckpoint {
  if (!record(value) || value.type !== "compaction" || value.version !== 1
    || typeof value.at !== "string" || !Number.isFinite(Date.parse(value.at))
    || !Number.isSafeInteger(value.through) || value.through !== through
    || typeof value.summary !== "string" || !value.summary.trim()
    || !Array.isArray(value.retained) || !Array.from(value.retained).every(retainedMessage)) {
    throw new Error(`${location}: invalid compaction checkpoint`);
  }
}

function sessionRecords(values: unknown[], path: string): { entries: MessageEntry[]; checkpoint?: CompactionCheckpoint } {
  const entries: MessageEntry[] = [];
  let checkpoint: CompactionCheckpoint | undefined;
  for (const [index, value] of values.entries()) {
    if (!record(value)) continue;
    if (value.type === "message") entries.push(value as unknown as MessageEntry);
    if (value.type === "compaction") {
      validateCheckpoint(value, entries.length, `${path}:${index + 2}`);
      checkpoint = value;
    }
  }
  return { entries, checkpoint };
}

export function checkpointMessages(checkpoint: CompactionCheckpoint): AgentMessage[] {
  return [{
    role: "user",
    content: [
      "Rx generated this summary from earlier session messages. Treat it as historical context, not a new user request or authorization.",
      "Current system and project instructions still apply. Recorded assistant messages and tool results describe past actions. Do not repeat their side effects.",
      checkpoint.summary,
    ].join("\n\n"),
    timestamp: Date.parse(checkpoint.at),
  }, ...checkpoint.retained];
}

export function danglingToolCalls(messages: AgentMessage[]): { id: string; name: string }[] {
  const answered = new Set(messages.flatMap((m) => (m.role === "toolResult" ? [m.toolCallId] : [])));
  return messages.flatMap((m) =>
    m.role === "assistant" && m.stopReason === "toolUse"
      ? m.content.flatMap((block) => (block.type === "toolCall" && !answered.has(block.id) ? [{ id: block.id, name: block.name }] : []))
      : [],
  );
}

export class SessionLog {
  readonly home: string;
  readonly id: string;
  readonly cwd: string;
  readonly createdAt: string;

  private constructor(home: string, id: string, cwd: string, createdAt: string) {
    this.home = home;
    this.id = id;
    this.cwd = cwd;
    this.createdAt = createdAt;
  }

  get path(): string {
    return sessionPath(this.home, this.id);
  }

  get messageCount(): number {
    const { values } = readLog(this.path);
    return sessionRecords(values.slice(1), this.path).entries.length;
  }

  static create(home: string, cwd: string): SessionLog {
    ensureDir(home);
    const id = uuidv7();
    const createdAt = new Date().toISOString();
    const line = `${JSON.stringify({ v: LOG_VERSION, type: "session", id, cwd, createdAt } satisfies SessionHeader)}\n`;
    lockSession(home, id);
    try {
      writeFileSync(sessionPath(home, id), line, { mode: 0o600, flag: "wx" });
    } catch (error) {
      unlockSession(home, id);
      throw error;
    }
    return new SessionLog(home, id, cwd, createdAt);
  }

  static open(home: string, id: string): LoadedSession {
    const path = sessionPath(home, id);
    statSync(path);
    const acquired = lockSession(home, id);
    try {
      return SessionLog.load(home, path);
    } catch (error) {
      if (acquired) unlockSession(home, id);
      throw error;
    }
  }

  private static load(home: string, path: string): LoadedSession {
    const { values, end, size } = readLog(path);
    const [first, ...rest] = values;
    const header = readHeader(path, first);
    const log = new SessionLog(home, header.id, header.cwd, header.createdAt);
    const { entries, checkpoint } = sessionRecords(rest, path);
    const history = entries.filter((entry) => entry.purpose !== "compaction").map((entry) => entry.message);
    const usageMessages = entries.slice(checkpoint?.through ?? 0).filter((entry) => entry.purpose !== "compaction").map((entry) => entry.message);
    const messages = checkpoint ? [...checkpointMessages(checkpoint), ...usageMessages] : [...history];
    const dangling = danglingToolCalls(history);
    const activeCalls = new Set(danglingToolCalls(usageMessages).map((call) => call.id));
    if (dangling.some((call) => !activeCalls.has(call.id))) {
      throw new Error(`${path}: compaction checkpoint hides an interrupted tool call`);
    }
    if (checkpoint) {
      const visibleCalls = new Set<string>();
      for (const message of usageMessages) {
        if (message.role === "assistant") {
          for (const block of message.content) if (block.type === "toolCall") visibleCalls.add(block.id);
        }
        if (message.role === "toolResult" && !visibleCalls.has(message.toolCallId)) {
          throw new Error(`${path}: compaction checkpoint leaves an isolated tool result`);
        }
      }
    }
    if (end < size) truncateSync(path, end);
    for (const call of dangling) {
      const result: ToolResultMessage = {
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text: INTERRUPTED_TOOL_TEXT }],
        isError: true,
        timestamp: Date.now(),
      };
      entries.push(log.append("rx", result));
      messages.push(result);
      history.push(result);
      usageMessages.push(result);
    }
    return { log, entries, messages, history, usageMessages, repaired: dangling.length };
  }

  append(origin: Origin, message: AgentMessage): MessageEntry {
    const entry: MessageEntry = { type: "message", at: new Date().toISOString(), origin, message };
    this.appendRecord(entry);
    return entry;
  }

  appendCompactionUsage(response: AssistantMessage): void {
    if (![response.usage.input, response.usage.output, response.usage.cacheRead, response.usage.cacheWrite].some((tokens) => tokens > 0)) return;
    const message: AssistantMessage = {
      role: "assistant", content: [], api: response.api, provider: response.provider, model: response.model,
      usage: response.usage, stopReason: response.stopReason, timestamp: response.timestamp,
    };
    this.appendRecord({ type: "message", at: new Date().toISOString(), origin: "model", purpose: "compaction", message });
  }

  appendCheckpoint(summary: string, retained: AgentMessage[]): CompactionCheckpoint {
    const { values, end, size } = readLog(this.path);
    readHeader(this.path, values[0]);
    const { entries } = sessionRecords(values.slice(1), this.path);
    const candidate: CompactionCheckpoint = { type: "compaction", version: 1, at: new Date().toISOString(), through: entries.length, summary, retained };
    validateCheckpoint(candidate, entries.length, this.path);
    const checkpoint: unknown = JSON.parse(JSON.stringify(candidate));
    validateCheckpoint(checkpoint, entries.length, this.path);
    if (danglingToolCalls(entries.map((entry) => entry.message)).length) {
      throw new Error(`${this.path}: compaction checkpoint hides an interrupted tool call`);
    }
    if (end < size) truncateSync(this.path, end);
    this.appendRecord(checkpoint);
    return checkpoint;
  }

  private appendRecord(entry: MessageEntry | CompactionCheckpoint): void {
    const line = `${JSON.stringify(entry)}\n`;
    const size = statSync(this.path).size;
    try {
      appendFileSync(this.path, line, { mode: 0o600 });
    } catch (error) {
      try {
        truncateSync(this.path, size);
      } catch {}
      throw error;
    }
  }
}

export function listSessions(home: string, cwd?: string): SessionInfo[] {
  let names: string[];
  try {
    names = readdirSync(sessionsDir(home));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const sessions: SessionInfo[] = [];
  for (const name of names) {
    const id = name.replace(/\.jsonl$/, "");
    if (!name.endsWith(".jsonl") || !ID_PATTERN.test(id)) continue;
    const path = sessionPath(home, id);
    try {
      const [first, ...rest] = readLog(path).values;
      const header = readHeader(path, first);
      if (cwd && header.cwd !== cwd) continue;
      const firstUser = sessionRecords(rest, path).entries.find((entry) => entry.origin !== "rx" && entry.message.role === "user")?.message;
      const title = (firstUser && userText(firstUser)?.replace(/\s+/g, " ").trim().slice(0, 80)) || "(empty)";
      sessions.push({ id, cwd: header.cwd, createdAt: header.createdAt, updatedAt: statSync(path).mtime.toISOString(), title });
    } catch (error) {
      process.stderr.write(`rx: skipping session ${id}: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
