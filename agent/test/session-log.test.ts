import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxText, fauxToolCall, type UserMessage } from "@earendil-works/pi-ai";
import type { CompactionCheckpoint } from "../src/context-control.ts";
import { checkpointMessages, INTERRUPTED_TOOL_TEXT, listSessions, SessionLog } from "../src/session-log.ts";
import { foreignSession, tempDir } from "./helpers.ts";

const user = (text: string): UserMessage => ({ role: "user", content: text, timestamp: Date.now() });

test("a session round-trips messages with their origin and private permissions", () => {
  const home = tempDir();
  const log = SessionLog.create(home, "/work");
  log.append("cli", user("hello"));
  log.append("model", fauxAssistantMessage("hi"));
  const loaded = SessionLog.open(home, log.id);
  assert.equal(loaded.log.cwd, "/work");
  assert.deepEqual(loaded.entries.map((e) => e.origin), ["cli", "model"]);
  assert.equal(loaded.messages.length, 2);
  assert.deepEqual(loaded.history, loaded.messages);
  assert.deepEqual(loaded.usageMessages, loaded.messages);
  assert.equal(loaded.log.messageCount, 2);
  assert.equal(loaded.repaired, 0);
  assert.equal(statSync(log.path).mode & 0o777, 0o600);
  assert.equal(statSync(`${home}/sessions`).mode & 0o777, 0o700);
});

test("open closes interrupted tool calls once and records rx as their origin", () => {
  const home = tempDir();
  const log = SessionLog.create(home, "/work");
  log.append("cli", user("run it"));
  log.append("model", fauxAssistantMessage([fauxToolCall("bash", { command: "make" }, { id: "call-1" })], { stopReason: "toolUse" }));
  const first = SessionLog.open(home, log.id);
  assert.equal(first.repaired, 1);
  const repair = first.entries.at(-1)!;
  assert.equal(repair.origin, "rx");
  assert.equal(repair.message.role, "toolResult");
  assert.ok(repair.message.role === "toolResult" && repair.message.isError && repair.message.toolCallId === "call-1");
  assert.match(JSON.stringify(repair.message.content), new RegExp(INTERRUPTED_TOOL_TEXT.slice(0, 30)));
  const second = SessionLog.open(home, log.id);
  assert.equal(second.repaired, 0);
  assert.equal(second.messages.length, 3);
});

test("a torn final line is ignored but corruption elsewhere is an error", () => {
  const home = tempDir();
  const log = SessionLog.create(home, "/work");
  log.append("cli", user("one"));
  appendFileSync(log.path, '{"type":"message","at":');
  assert.equal(SessionLog.open(home, log.id).messages.length, 1);
  const broken = SessionLog.create(home, "/work");
  appendFileSync(broken.path, "not json\n");
  broken.append("cli", user("two"));
  assert.throws(() => SessionLog.open(home, broken.id), /corrupt log line/);
});

test("opening a session drops a torn tail so later appends stay readable", () => {
  const home = tempDir();
  const log = SessionLog.create(home, "/work");
  log.append("cli", user("one"));
  appendFileSync(log.path, '{"type":"message","at":');
  assert.equal(listSessions(home).length, 1);
  const resumed = SessionLog.open(home, log.id);
  resumed.log.append("cli", user("two"));
  resumed.log.append("cli", user("three"));
  assert.deepEqual(
    SessionLog.open(home, log.id).messages.map((m) => m.role === "user" && m.content),
    ["one", "two", "three"],
  );
});

test("a session held by another live process cannot be opened", () => {
  const { home, id, lock } = foreignSession("/work");
  writeFileSync(lock, String(process.ppid));
  assert.throws(() => SessionLog.open(home, id), (error: Error) => error.message.includes(`in use by process ${process.ppid}`) && error.message.includes(lock));
  writeFileSync(lock, String(spawnSync("true").pid));
  assert.equal(SessionLog.open(home, id).log.id, id);
  assert.equal(readFileSync(lock, "utf8"), String(process.pid));
});

test("a failed open releases its lock and a missing session takes none", () => {
  const { home, id, path, lock } = foreignSession("/work");
  appendFileSync(path, "not json\n");
  appendFileSync(path, '{"type":"message"}\n');
  assert.throws(() => SessionLog.open(home, id), /corrupt log line/);
  assert.equal(existsSync(lock), false);
  assert.throws(() => SessionLog.open(home, "01900000-0000-7000-8000-000000000000"), /ENOENT/);
  assert.deepEqual(readdirSync(join(home, "sessions")), [`${id}.jsonl`]);
});

test("a failed append removes only its own partial line", () => {
  const { home, id } = foreignSession("/work");
  const script = `
    import { SessionLog } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "../src/session-log.ts")).href)};
    const first = SessionLog.open(${JSON.stringify(home)}, ${JSON.stringify(id)}).log;
    const second = SessionLog.open(${JSON.stringify(home)}, ${JSON.stringify(id)}).log;
    first.append("cli", { role: "user", content: "before", timestamp: 0 });
    try {
      second.append("cli", { role: "user", content: "x".repeat(4096), timestamp: 0 });
    } catch (error) {
      console.log(error.code);
    }
    second.append("cli", { role: "user", content: "after", timestamp: 0 });
  `;
  const child = spawnSync("bash", ["-c", 'ulimit -f 1; exec "$0" --input-type=module -e "$1"', process.execPath, script], { encoding: "utf8" });
  assert.equal(child.stdout.trim(), "EFBIG", child.stderr);
  assert.deepEqual(
    SessionLog.open(home, id).messages.map((m) => m.role === "user" && m.content),
    ["before", "after"],
  );
});

test("unknown log versions and path-like ids are rejected", () => {
  const home = tempDir();
  const log = SessionLog.create(home, "/work");
  const header = JSON.parse(readFileSync(log.path, "utf8"));
  writeFileSync(log.path, `${JSON.stringify({ ...header, v: 99 })}\n`);
  assert.throws(() => SessionLog.open(home, log.id), /unsupported session log version 99/);
  assert.throws(() => SessionLog.open(home, "../../etc/passwd"), /invalid session id/);
});

test("listSessions filters by cwd, titles by first user text, and orders by last update", () => {
  const home = tempDir();
  assert.deepEqual(listSessions(home), []);
  const older = SessionLog.create(home, "/a");
  older.append("acp", user("  first\n task  "));
  older.append("model", fauxAssistantMessage([fauxText("ok")]));
  const newer = SessionLog.create(home, "/a");
  const other = SessionLog.create(home, "/b");
  other.append("cli", user("elsewhere"));
  utimesSync(older.path, new Date(1000), new Date(1000));
  writeFileSync(`${home}/sessions/not-a-session.jsonl`, "garbage");
  const listed = listSessions(home, "/a");
  assert.deepEqual(listed.map((s) => s.id), [newer.id, older.id]);
  assert.deepEqual(listed.map((s) => s.title), ["(empty)", "first task"]);
  assert.equal(listSessions(home).length, 3);
});
