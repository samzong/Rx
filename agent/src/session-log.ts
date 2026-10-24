import { appendFileSync, chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { uuidv7, type ToolResultMessage } from "@earendil-works/pi-ai";
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
    if (end < size) truncateSync(path, end);
    const log = new SessionLog(home, header.id, header.cwd, header.createdAt);
    const entries = rest.filter((value): value is MessageEntry => (value as MessageEntry)?.type === "message");
    const messages = entries.map((entry) => entry.message);
    const dangling = danglingToolCalls(messages);
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
    }
    return { log, entries, messages, repaired: dangling.length };
  }

  append(origin: Origin, message: AgentMessage): MessageEntry {
    const entry: MessageEntry = { type: "message", at: new Date().toISOString(), origin, message };
    const size = statSync(this.path).size;
    try {
      appendFileSync(this.path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch (error) {
      try {
        truncateSync(this.path, size);
      } catch {}
      throw error;
    }
    return entry;
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
      const firstUser = rest.map((value) => (value as MessageEntry).message).find((m) => m?.role === "user");
      const title = (firstUser && userText(firstUser)?.replace(/\s+/g, " ").trim().slice(0, 80)) || "(empty)";
      sessions.push({ id, cwd: header.cwd, createdAt: header.createdAt, updatedAt: statSync(path).mtime.toISOString(), title });
    } catch (error) {
      process.stderr.write(`rx: skipping session ${id}: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
