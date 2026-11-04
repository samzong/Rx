import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { fauxAssistantMessage, type UserMessage } from "@earendil-works/pi-ai";
import { listSessions, SessionLog } from "../src/session-log.ts";
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
  assert.throws(() => SessionLog.open(home, id));
  assert.equal(existsSync(lock), false);
  assert.throws(() => SessionLog.open(home, "01900000-0000-7000-8000-000000000000"));
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
  assert.throws(() => SessionLog.open(home, log.id));
  assert.throws(() => SessionLog.open(home, "../../etc/passwd"));
});
