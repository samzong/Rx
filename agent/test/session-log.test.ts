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

test("checkpoints project only the latest summary, retained messages, and subsequent raw messages", () => {
  const home = tempDir();
  const log = SessionLog.create(home, "/work");
  const first = user("original task");
  const answer = fauxAssistantMessage("first answer");
  log.append("cli", first);
  log.append("model", answer);
  const before = readFileSync(log.path);
  const checkpoint = log.appendCheckpoint("The first task is complete.", [user("recent transcript")]);
  assert.equal(checkpoint.through, 2);
  assert.equal(log.messageCount, 2);
  assert.ok(readFileSync(log.path).subarray(0, before.length).equals(before));
  const after = user("next task");
  log.append("acp", after);
  const loaded = SessionLog.open(home, log.id);
  assert.deepEqual(loaded.messages, [...checkpointMessages(checkpoint), after]);
  assert.deepEqual(loaded.history, [first, answer, after]);
  assert.deepEqual(loaded.usageMessages, [after]);
  assert.equal(loaded.entries.length, 3);
  assert.equal(loaded.log.messageCount, 3);
  assert.equal(loaded.repaired, 0);
  const summary = checkpointMessages(checkpoint)[0]!;
  assert.equal(summary.role, "user");
  assert.match(String(summary.content), /Rx generated this summary/);
  assert.match(String(summary.content), /not a new user request or authorization/);
  assert.match(String(summary.content), /Current system and project instructions still apply/);
  assert.equal(summary.timestamp, Date.parse(checkpoint.at));
  const latest = loaded.log.appendCheckpoint("Both tasks are complete.", []);
  assert.equal(latest.through, 3);
  const resumed = SessionLog.open(home, log.id);
  assert.deepEqual(resumed.messages, checkpointMessages(latest));
  assert.deepEqual(resumed.history, [first, answer, after]);
  assert.deepEqual(resumed.usageMessages, []);
  assert.equal(resumed.entries.length, 3);
  assert.equal(listSessions(home)[0]!.title, "original task");
});

test("unknown v1 records do not affect checkpoint positions or raw message counts", () => {
  const home = tempDir();
  const log = SessionLog.create(home, "/work");
  appendFileSync(log.path, `${JSON.stringify({ type: "future", message: user("not a message record") })}\nnull\n`);
  const second = SessionLog.open(home, log.id).log;
  log.append("cli", user("one"));
  second.append("cli", user("two"));
  assert.equal(log.messageCount, 2);
  assert.equal(second.messageCount, 2);
  const checkpoint = second.appendCheckpoint("A summary", []);
  assert.equal(checkpoint.through, 2);
  assert.deepEqual(SessionLog.open(home, log.id).messages, checkpointMessages(checkpoint));
  assert.equal(readFileSync(log.path, "utf8").split("\n").filter(Boolean).length, 6);
  assert.equal(listSessions(home)[0]!.title, "one");
});

test("retained user text and images round-trip without old assistant or tool protocol", () => {
  const home = tempDir();
  const log = SessionLog.create(home, "/work");
  const retained: UserMessage[] = [user("plain text"), {
    role: "user", content: [{ type: "text", text: "a picture" }, { type: "image", data: "aGVsbG8=", mimeType: "image/png" }], timestamp: 1,
  }];
  const checkpoint = log.appendCheckpoint("A summary", retained);
  assert.deepEqual(SessionLog.open(home, log.id).messages, checkpointMessages(checkpoint));
  retained[0]!.content = "changed after append";
  assert.notDeepEqual(checkpoint.retained[0], retained[0]);
});

test("an invalid latest checkpoint preserves the previous checkpoint and every old byte", () => {
  const home = tempDir();
  const log = SessionLog.create(home, "/work");
  log.append("cli", user("old"));
  const checkpoint = log.appendCheckpoint("A valid summary", []);
  appendFileSync(log.path, `${JSON.stringify({ ...checkpoint, through: 9 })}\npartial`);
  const before = readFileSync(log.path);
  assert.throws(() => SessionLog.open(home, log.id), /invalid compaction checkpoint/);
  assert.throws(() => log.appendCheckpoint("Another summary", []), /invalid compaction checkpoint/);
  assert.deepEqual(readFileSync(log.path), before);
});

test("checkpoint append validates content before changing any bytes", () => {
  const home = tempDir();
  const log = SessionLog.create(home, "/work");
  log.append("cli", user("one"));
  appendFileSync(log.path, '{"type":"compaction"');
  const before = readFileSync(log.path);
  const invalid: unknown[] = [
    fauxAssistantMessage("old signed assistant"),
    { role: "toolResult", toolCallId: "old", toolName: "bash", content: [{ type: "text", text: "old result" }], timestamp: 0 },
    { ...user("signed"), content: [{ type: "text", text: "signed", textSignature: "old-signature" }] },
    { ...user("thinking"), content: [{ type: "thinking", thinking: "old", thinkingSignature: "old-signature" }] },
    { ...user("call"), content: [fauxToolCall("bash", {})] },
    { ...user("malformed"), timestamp: Number.NaN },
    { ...user("malformed"), content: [{ type: "image", data: "", mimeType: "image/png" }] },
    { ...user("malformed"), content: [{ type: "image", data: "aGVsbG8=" }] },
    { ...user("malformed"), content: [null] },
    { ...user("malformed"), content: new Array(1) },
    null,
  ];
  for (const value of invalid) {
    assert.throws(() => log.appendCheckpoint("A summary", [value] as AgentMessage[]), /invalid compaction checkpoint/);
    assert.deepEqual(readFileSync(log.path), before);
  }
  assert.throws(() => log.appendCheckpoint(" ", []), /invalid compaction checkpoint/);
  assert.throws(() => log.appendCheckpoint("A summary", new Array(1)), /invalid compaction checkpoint/);
  assert.deepEqual(readFileSync(log.path), before);
});

test("every complete checkpoint is validated before tail truncation or dangling-call repair", () => {
  const invalid = [
    { version: 2 }, { version: undefined }, { through: 0 }, { through: -1 }, { through: 1.5 }, { through: "2" },
    { summary: " " }, { at: "not a date" }, { retained: null }, { retained: [fauxAssistantMessage("old")] },
  ];
  for (const patch of invalid) {
    const { home, id, path, lock } = foreignSession("/work", [
      ["cli", user("run it")],
      ["model", fauxAssistantMessage([fauxToolCall("bash", {}, { id: "dangling" })], { stopReason: "toolUse" })],
    ]);
    const checkpoint = { type: "compaction", version: 1, at: new Date().toISOString(), through: 2, summary: "A summary", retained: [] };
    appendFileSync(path, `${JSON.stringify({ ...checkpoint, ...patch })}\n${JSON.stringify(checkpoint)}\npartial`);
    const before = readFileSync(path);
    assert.throws(() => SessionLog.open(home, id), /invalid compaction checkpoint/);
    assert.deepEqual(readFileSync(path), before);
    assert.equal(existsSync(lock), false);
  }
});

test("an unterminated checkpoint stays inactive even when its JSON is complete", () => {
  for (const suffix of ["", "\n"]) {
    const home = tempDir();
    const log = SessionLog.create(home, "/work");
    const original = user("original");
    log.append("cli", original);
    const checkpoint: CompactionCheckpoint = { type: "compaction", version: 1, at: new Date().toISOString(), through: 1, summary: "A summary", retained: [] };
    appendFileSync(log.path, `${JSON.stringify(checkpoint)}${suffix}`);
    const loaded = SessionLog.open(home, log.id);
    assert.deepEqual(loaded.messages, suffix ? checkpointMessages(checkpoint) : [original]);
    assert.deepEqual(loaded.history, [original]);
    assert.deepEqual(loaded.usageMessages, suffix ? [] : [original]);
    loaded.log.append("cli", user("next"));
    assert.equal(SessionLog.open(home, log.id).history.length, 2);
  }
});

test("a partial checkpoint preserves the previous checkpoint projection", () => {
  const home = tempDir();
  const log = SessionLog.create(home, "/work");
  log.append("cli", user("old"));
  const checkpoint = log.appendCheckpoint("Existing summary", []);
  const recent = user("recent");
  log.append("cli", recent);
  appendFileSync(log.path, '{"type":"compaction","version":1,"summary":"torn');
  const loaded = SessionLog.open(home, log.id);
  assert.deepEqual(loaded.messages, [...checkpointMessages(checkpoint), recent]);
  assert.deepEqual(loaded.usageMessages, [recent]);
  assert.equal(loaded.log.messageCount, 2);
});

test("repairs after a checkpoint enter raw history, usage history, and the active context once", () => {
  const home = tempDir();
  const log = SessionLog.create(home, "/work");
  log.append("cli", user("old"));
  const checkpoint = log.appendCheckpoint("Earlier work", []);
  const call = fauxAssistantMessage([fauxToolCall("bash", { command: "make" }, { id: "new-call" })], { stopReason: "toolUse" });
  log.append("model", call);
  const loaded = SessionLog.open(home, log.id);
  const repair = loaded.history.at(-1)!;
  assert.equal(loaded.repaired, 1);
  assert.equal(loaded.entries.at(-1)!.origin, "rx");
  assert.equal(repair.role, "toolResult");
  assert.ok(repair.role === "toolResult" && repair.isError && repair.toolCallId === "new-call");
  assert.deepEqual(loaded.messages, [...checkpointMessages(checkpoint), call, repair]);
  assert.deepEqual(loaded.usageMessages, [call, repair]);
  assert.equal(loaded.log.messageCount, 3);
  assert.equal(SessionLog.open(home, log.id).repaired, 0);
});

test("a checkpoint cannot hide a dangling call and loading such a boundary preserves all bytes", () => {
  const home = tempDir();
  const log = SessionLog.create(home, "/work");
  log.append("model", fauxAssistantMessage([fauxToolCall("bash", {}, { id: "hidden-call" })], { stopReason: "toolUse" }));
  const before = readFileSync(log.path);
  assert.throws(() => log.appendCheckpoint("A summary", []), /hides an interrupted tool call/);
  assert.deepEqual(readFileSync(log.path), before);
  appendFileSync(log.path, `${JSON.stringify({ type: "compaction", version: 1, at: new Date().toISOString(), through: 1, summary: "A summary", retained: [] })}\npartial`);
  const hidden = readFileSync(log.path);
  assert.throws(() => SessionLog.open(home, log.id), /hides an interrupted tool call/);
  assert.deepEqual(readFileSync(log.path), hidden);
});

test("complete historical tool results prevent repairs after compaction", () => {
  const home = tempDir();
  const log = SessionLog.create(home, "/work");
  log.append("model", fauxAssistantMessage([fauxToolCall("bash", {}, { id: "finished" })], { stopReason: "toolUse" }));
  log.append("tool", { role: "toolResult", toolCallId: "finished", toolName: "bash", content: [{ type: "text", text: "done" }], isError: false, timestamp: 0 });
  const checkpoint = log.appendCheckpoint("The tool finished.", []);
  const loaded = SessionLog.open(home, log.id);
  assert.equal(loaded.repaired, 0);
  assert.deepEqual(loaded.messages, checkpointMessages(checkpoint));
  assert.equal(loaded.history.length, 2);
});

test("a repaired tool result cannot be replayed without its call across a checkpoint boundary", () => {
  const { home, id, path, lock } = foreignSession("/work", [
    ["model", fauxAssistantMessage([fauxToolCall("bash", {}, { id: "hidden-call" })], { stopReason: "toolUse" })],
  ]);
  const checkpoint: CompactionCheckpoint = { type: "compaction", version: 1, at: new Date().toISOString(), through: 1, summary: "A summary", retained: [] };
  const repair = { type: "message", at: new Date().toISOString(), origin: "rx", message: {
    role: "toolResult", toolCallId: "hidden-call", toolName: "bash", content: [{ type: "text", text: INTERRUPTED_TOOL_TEXT }], isError: true, timestamp: 0,
  } };
  appendFileSync(path, `${JSON.stringify(checkpoint)}\n${JSON.stringify(repair)}\npartial`);
  const before = readFileSync(path);
  assert.throws(() => SessionLog.open(home, id), /isolated tool result/);
  assert.deepEqual(readFileSync(path), before);
  assert.equal(existsSync(lock), false);
});

test("a failed checkpoint append restores the previous projection and permits later appends", () => {
  const { home, id, path } = foreignSession("/w", [["cli", user("old")]]);
  const checkpoint: CompactionCheckpoint = { type: "compaction", version: 1, at: new Date().toISOString(), through: 1, summary: "Existing summary", retained: [] };
  appendFileSync(path, `${JSON.stringify(checkpoint)}\n`);
  const before = readFileSync(path);
  const script = `
    import { SessionLog } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "../src/session-log.ts")).href)};
    const log = SessionLog.open(${JSON.stringify(home)}, ${JSON.stringify(id)}).log;
    try {
      log.appendCheckpoint("x".repeat(4096), []);
    } catch (error) {
      console.log(error.code);
    }
  `;
  const child = spawnSync("bash", ["-c", 'ulimit -f 1; exec "$0" --input-type=module -e "$1"', process.execPath, script], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), "EFBIG", child.stderr);
  assert.deepEqual(readFileSync(path), before);
  const loaded = SessionLog.open(home, id);
  assert.deepEqual(loaded.messages, checkpointMessages(checkpoint));
  assert.deepEqual(loaded.usageMessages, []);
  assert.equal(loaded.log.messageCount, 1);
  loaded.log.append("cli", user("after failure"));
  assert.equal(SessionLog.open(home, id).history.length, 2);
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
