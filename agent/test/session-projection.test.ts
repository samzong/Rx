import assert from "node:assert/strict";
import fs, { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall, type UserMessage } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CompactionCheckpoint } from "../src/context-control.ts";
import { messageSources, rawMessageSeq } from "../src/context-source.ts";
import { checkpointMessages, SessionLog } from "../src/session-log.ts";
import { foreignSession, tempDir } from "./helpers.ts";

const user = (content: string): UserMessage => ({ role: "user", content, timestamp: 0 });
const result = (id = "call") => ({
  role: "toolResult" as const, toolCallId: id, toolName: "bash", content: [{ type: "text" as const, text: "original evidence" }], isError: false, timestamp: 0,
});
function visible(message: AgentMessage) {
  assert.ok(message.role === "user" || message.role === "assistant" || message.role === "toolResult");
  return message;
}
function toolLog() {
  const log = SessionLog.create(tempDir(), "/work");
  log.append("cli", user("task"));
  log.append("model", fauxAssistantMessage([fauxToolCall("bash", { command: "requested" }, { id: "call" })], { stopReason: "toolUse" }));
  log.appendToolInput("call", { command: "executed" });
  log.append("tool", result());
  return log;
}
function checkpoint(through: number): CompactionCheckpoint {
  return { type: "compaction", version: 1, at: new Date().toISOString(), through, summary: "Earlier evidence", retained: [] };
}
function prune(through: number, clearedSeqs: number[]) {
  return { type: "context_prune", version: 1, at: new Date().toISOString(), through, clearedSeqs };
}

test("raw ordinals include summary usage and exclude control records", () => {
  const log = toolLog();
  const working = user("after tool");
  const usage = fauxAssistantMessage("summary");
  usage.usage.input = 9;
  log.appendCompactionUsage(usage);
  log.appendCheckpoint("The tool finished", []);
  appendFileSync(log.path, '{"type":"future"}\n');
  log.append("acp", working);
  assert.equal(rawMessageSeq(working), 5);
  const loaded = SessionLog.open(log.home, log.id);
  assert.equal(loaded.log.messageCount, 5);
  assert.deepEqual(loaded.entries.map((entry) => rawMessageSeq(entry.message)), [1, 2, 3, undefined, 5]);
  assert.deepEqual(loaded.history.map(rawMessageSeq), [1, 2, 3, 5]);
  assert.deepEqual(log.readRange(2, 5).entries.map((entry) => [entry.seq, entry.origin, entry.purpose]), [
    [2, "model", undefined], [3, "tool", undefined], [4, "model", "compaction"], [5, "acp", undefined],
  ]);
});

test("range reads return raw snapshots and executed inputs without repair or locking", () => {
  const log = toolLog();
  log.append("model", fauxAssistantMessage([fauxToolCall("bash", {}, { id: "unfinished" })], { stopReason: "toolUse" }));
  appendFileSync(log.path, "partial");
  const lock = log.path.replace(/\.jsonl$/, ".lock");
  rmSync(lock);
  const before = readFileSync(log.path);
  const snapshot = log.readRange(1, 4);
  assert.equal(existsSync(lock), false);
  assert.deepEqual(readFileSync(log.path), before);
  assert.deepEqual(snapshot.inputs.get("call"), { command: "executed" });
  assert.equal(snapshot.entries[2]!.message.role, "toolResult");
  visible(snapshot.entries[0]!.message).content = "changed snapshot";
  assert.equal(visible(log.readRange(1, 1).entries[0]!.message).content, "task");
  for (const [from, to] of [[0, 1], [1, 5], [3, 2], [1.5, 2], [1, Infinity], [1, Number.MAX_SAFE_INTEGER + 1]]) {
    assert.throws(() => log.readRange(from!, to!), /range/i);
  }
  assert.deepEqual(readFileSync(log.path), before);
});

test("checkpoint source metadata survives repeated projection and raw history stays intact", () => {
  const log = toolLog();
  const retained = user("visible result");
  const saved = log.appendCheckpoint("Tool evidence [log 1-2]", [retained], {
    summarySources: [{ from: 1, to: 2 }], retainedSources: [[{ from: 3, to: 3 }]],
  });
  assert.deepEqual(checkpointMessages(saved).map(messageSources), [[{ from: 1, to: 2 }], [{ from: 3, to: 3 }]]);
  const next = log.appendCheckpoint("All evidence [log 1-3]", [], { summarySources: [{ from: 1, to: 3 }], retainedSources: [] });
  const loaded = SessionLog.open(log.home, log.id);
  assert.deepEqual(messageSources(loaded.messages[0]!), next.summarySources);
  assert.deepEqual(loaded.history.map(rawMessageSeq), [1, 2, 3]);
  assert.match(JSON.stringify(visible(log.readRange(3, 3).entries[0]!.message).content), /original evidence/);
});

test("old checkpoints use conservative coverage without invented single-message sources", () => {
  const log = toolLog();
  const saved = log.appendCheckpoint("Historical work", [user("retained")]);
  assert.deepEqual(checkpointMessages(saved).map(messageSources), [
    [{ from: 1, to: 3, coverage: true }], [{ from: 1, to: 3, coverage: true }],
  ]);
  assert.ok(SessionLog.open(log.home, log.id).messages.every((message) => rawMessageSeq(message) === undefined));
  const empty = SessionLog.create(tempDir(), "/work");
  assert.deepEqual(checkpointMessages(empty.appendCheckpoint("Empty history", [user("legacy")])).map(messageSources), [[], []]);
  const usage = fauxAssistantMessage("");
  usage.usage.input = 1;
  empty.appendCompactionUsage(usage);
  appendFileSync(empty.path, `${JSON.stringify({ ...checkpoint(1), retained: [user("old")] })}\n`);
  assert.deepEqual(SessionLog.open(empty.home, empty.id).messages.map(messageSources), [[], []]);
});

test("invalid source metadata fails before tail truncation or interrupted-tool repair", () => {
  const invalid = [
    { summarySources: [], retainedSources: [] },
    { summarySources: [{ from: 1, to: 1 }] },
    { retainedSources: [] },
    { summarySources: [{ from: 1, to: 1 }], retainedSources: [[]] },
    { summarySources: [{ from: 0, to: 1 }], retainedSources: [] },
    { summarySources: [{ from: 1, to: 4 }], retainedSources: [] },
    { summarySources: [{ from: 2, to: 1 }], retainedSources: [] },
    { summarySources: [{ from: 1.5, to: 2 }], retainedSources: [] },
    { summarySources: [{ from: 1, to: 1, coverage: false }], retainedSources: [] },
    { summarySources: [{ from: 1, to: 1, coverage: "true" }], retainedSources: [] },
    { summarySources: [{ from: 1, to: 2 }, { from: 2, to: 2 }], retainedSources: [] },
    { summarySources: [{ from: 2, to: 2 }, { from: 1, to: 1 }], retainedSources: [] },
    { summarySources: [{ from: 1, to: 1, extra: true }], retainedSources: [] },
    { summarySources: [{ from: Number.MAX_SAFE_INTEGER + 1, to: Number.MAX_SAFE_INTEGER + 1 }], retainedSources: [] },
  ];
  for (const metadata of invalid) {
    const { home, id, path, lock } = foreignSession("/work", [
      ["cli", user("task")], ["model", fauxAssistantMessage([fauxToolCall("bash", {}, { id: "unfinished" })], { stopReason: "toolUse" })],
    ]);
    appendFileSync(path, `${JSON.stringify({ ...checkpoint(2), ...metadata })}\npartial`);
    const before = readFileSync(path);
    assert.throws(() => SessionLog.open(home, id), /invalid compaction checkpoint/);
    assert.deepEqual(readFileSync(path), before);
    assert.equal(existsSync(lock), false);
  }
});

test("exact sources reject summary usage while coverage requires a real original message", () => {
  const log = SessionLog.create(tempDir(), "/work");
  log.append("cli", user("task"));
  const usage = fauxAssistantMessage("");
  usage.usage.input = 1;
  log.appendCompactionUsage(usage);
  for (const ranges of [[{ from: 2, to: 2 }], [{ from: 1, to: 2 }], [{ from: 2, to: 2, coverage: true as const }]]) {
    assert.throws(() => log.appendCheckpoint("Summary", [], { summarySources: ranges, retainedSources: [] }), /checkpoint sources/);
    assert.throws(() => log.appendCheckpoint("Summary", [user("retained")], { summarySources: [], retainedSources: [ranges] }), /checkpoint sources/);
  }
  log.appendCheckpoint("Conservative summary [log 1-2]", [], { summarySources: [{ from: 1, to: 2, coverage: true }], retainedSources: [] });
  assert.deepEqual(messageSources(SessionLog.open(log.home, log.id).messages[0]!), [{ from: 1, to: 2, coverage: true }]);
});

test("prune records restore cleared context and preserve raw messages and tool inputs", () => {
  const log = toolLog();
  const loaded = SessionLog.open(log.home, log.id);
  const original = loaded.history[2]!;
  const before = readFileSync(log.path);
  log.appendPrune([3]);
  assert.deepEqual(visible(original).content, result().content);
  assert.deepEqual(visible(loaded.messages[2]!).content, result().content);
  const resumed = SessionLog.open(log.home, log.id);
  assert.ok(readFileSync(log.path).subarray(0, before.length).equals(before));
  assert.deepEqual(visible(resumed.messages[2]!).content, [{ type: "text", text: "[cleared, log seq 3]" }]);
  assert.equal(rawMessageSeq(resumed.messages[2]!), 3);
  assert.deepEqual(visible(resumed.history[2]!).content, result().content);
  assert.deepEqual(visible(log.readRange(3, 3).entries[0]!.message).content, result().content);
  assert.deepEqual(resumed.inputs.get("call"), { command: "executed" });
  assert.deepEqual(resumed.usageMessages, []);
  assert.throws(() => log.appendPrune([3]), /prune sources/);
  log.append("acp", user("next"));
  assert.deepEqual(SessionLog.open(log.home, log.id).usageMessages.map(rawMessageSeq), [4]);
});

test("prune watermarks do not hide tool calls from repair and pairing checks", () => {
  const log = toolLog();
  log.appendCheckpoint("Earlier work", []);
  log.append("model", fauxAssistantMessage([fauxToolCall("bash", {}, { id: "second" })], { stopReason: "toolUse" }));
  log.append("tool", result("second"));
  log.append("model", fauxAssistantMessage([fauxToolCall("bash", {}, { id: "unfinished" })], { stopReason: "toolUse" }));
  log.appendPrune([5]);
  const loaded = SessionLog.open(log.home, log.id);
  assert.equal(loaded.repaired, 1);
  assert.deepEqual(loaded.usageMessages.map(rawMessageSeq), [7]);
  assert.equal(SessionLog.open(log.home, log.id).repaired, 0);
  assert.equal(loaded.messages.length, 5);
});

test("every complete prune record fails closed before any repair", () => {
  const invalid = [
    { version: 2 }, { through: 2 }, { through: 3.5 }, { at: "bad" }, { extra: true },
    { clearedSeqs: [] }, { clearedSeqs: [0] }, { clearedSeqs: [3.5] }, { clearedSeqs: [4] },
    { clearedSeqs: [3, 3] }, { clearedSeqs: [3, 2] }, { clearedSeqs: [1] },
    { clearedSeqs: [Number.MAX_SAFE_INTEGER + 1] }, { clearedSeqs: null },
  ];
  for (const patch of invalid) {
    const log = toolLog();
    log.append("model", fauxAssistantMessage([fauxToolCall("bash", {}, { id: "unfinished" })], { stopReason: "toolUse" }));
    const beforeRecord = readFileSync(log.path);
    appendFileSync(log.path, `${JSON.stringify({ ...prune(4, [3]), ...patch })}\npartial`);
    const before = readFileSync(log.path);
    assert.throws(() => SessionLog.open(log.home, log.id), /invalid context prune/);
    assert.throws(() => log.readRange(1, 1), /invalid context prune/);
    assert.deepEqual(readFileSync(log.path), before);
    assert.ok(before.subarray(0, beforeRecord.length).equals(beforeRecord));
  }
  const log = toolLog();
  log.appendCheckpoint("Hidden tool [log 1-2]", [user("visible old tool")], { summarySources: [{ from: 1, to: 2 }], retainedSources: [[{ from: 3, to: 3 }]] });
  assert.throws(() => log.appendPrune([3]), /prune sources/);
});

test("a complete-looking prune without its newline stays inactive", () => {
  const log = toolLog();
  appendFileSync(log.path, JSON.stringify(prune(3, [3])));
  assert.deepEqual(visible(log.readRange(3, 3).entries[0]!.message).content, result().content);
  assert.deepEqual(visible(SessionLog.open(log.home, log.id).messages[2]!).content, result().content);
});

test("a failed prune append rolls back its bytes and leaves the projection intact", () => {
  const log = toolLog();
  const loaded = SessionLog.open(log.home, log.id);
  const before = readFileSync(log.path);
  const append = fs.appendFileSync;
  fs.appendFileSync = ((path: fs.PathOrFileDescriptor, data: string) => {
    append(path, data.slice(0, 13));
    throw new Error("injected append failure");
  }) as typeof fs.appendFileSync;
  syncBuiltinESMExports();
  try {
    assert.throws(() => log.appendPrune([3]), /injected append failure/);
  } finally {
    fs.appendFileSync = append;
    syncBuiltinESMExports();
  }
  assert.deepEqual(readFileSync(log.path), before);
  assert.deepEqual(visible(loaded.messages[2]!).content, result().content);
  assert.deepEqual(visible(SessionLog.open(log.home, log.id).messages[2]!).content, result().content);
  log.appendPrune([3]);
  assert.deepEqual(visible(SessionLog.open(log.home, log.id).messages[2]!).content, [{ type: "text", text: "[cleared, log seq 3]" }]);
});

test("new checkpoint citations fail closed before repair while old checkpoints remain readable", () => {
  for (const summary of ["Uncited fact", "Invented source [log 2-2]", "Malformed source [log 1]"]) {
    const { home, id, path, lock } = foreignSession("/work", [["cli", user("original")]]);
    appendFileSync(path, `${JSON.stringify({ ...checkpoint(1), summary, summarySources: [{ from: 1, to: 1 }], retainedSources: [] })}\npartial`);
    const before = readFileSync(path);
    assert.throws(() => SessionLog.open(home, id));
    assert.deepEqual(readFileSync(path), before);
    assert.equal(existsSync(lock), false);
  }
});
