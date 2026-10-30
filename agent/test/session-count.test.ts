import assert from "node:assert/strict";
import fs, { appendFileSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { rawMessageSeq } from "../src/context-source.ts";
import { SessionLog } from "../src/session-log.ts";
import { foreignSession, tempDir } from "./helpers.ts";

const user = (content: string): AgentMessage => ({ role: "user", content, timestamp: 0 });

function usage() {
  const response = fauxAssistantMessage("");
  response.usage.input = 10;
  return response;
}

test("only successful message records consume ordinals", () => {
  const log = SessionLog.create(tempDir(), "/work");
  assert.equal(log.messageCount, 0);
  log.appendCompactionUsage(fauxAssistantMessage(""));
  log.appendToolInput("call", { command: "executed" });
  log.appendCheckpoint("Empty history", []);
  assert.equal(log.messageCount, 0);
  const first = user("task");
  log.append("cli", first);
  log.append("model", fauxAssistantMessage([fauxToolCall("bash", {}, { id: "call" })], { stopReason: "toolUse" }));
  log.append("tool", { role: "toolResult", toolCallId: "call", toolName: "bash", content: [{ type: "text", text: "done" }], isError: false, timestamp: 0 });
  log.appendPrune([3]);
  assert.equal(log.messageCount, 3);
  log.appendCompactionUsage(usage());
  const checkpoint = log.appendCheckpoint("Completed task", []);
  assert.equal(checkpoint.through, 4);
  appendFileSync(log.path, '{"type":"future"}\n');
  const next = user("next");
  log.append("acp", next);
  assert.equal(rawMessageSeq(first), 1);
  assert.equal(rawMessageSeq(next), 5);
  const loaded = SessionLog.open(log.home, log.id);
  assert.equal(loaded.log.messageCount, 5);
  assert.deepEqual(loaded.entries.map((entry) => rawMessageSeq(entry.message)), [1, 2, 3, undefined, 5]);
  assert.deepEqual(loaded.history.map(rawMessageSeq), [1, 2, 3, 5]);
  assert.deepEqual(log.readRange(2, 5).entries.map((entry) => [entry.seq, entry.origin, entry.purpose]), [
    [2, "model", undefined], [3, "tool", undefined], [4, "model", "compaction"], [5, "acp", undefined],
  ]);
});

test("old handles see appends, summary usage, and repairs from newer handles", () => {
  const first = SessionLog.create(tempDir(), "/work");
  first.append("cli", user("task"));
  const second = SessionLog.open(first.home, first.id).log;
  second.append("model", fauxAssistantMessage([
    fauxToolCall("bash", {}, { id: "one" }), fauxToolCall("bash", {}, { id: "two" }),
  ], { stopReason: "toolUse" }));
  assert.equal(first.messageCount, 2);
  const third = SessionLog.open(first.home, first.id);
  assert.equal(third.repaired, 2);
  assert.deepEqual(third.history.map(rawMessageSeq), [1, 2, 3, 4]);
  assert.equal(first.messageCount, 4);
  assert.equal(second.messageCount, 4);
  const fromOld = user("old handle");
  first.append("cli", fromOld);
  second.appendCompactionUsage(usage());
  const fromNew = user("new handle");
  third.log.append("acp", fromNew);
  assert.equal(rawMessageSeq(fromOld), 5);
  assert.equal(rawMessageSeq(fromNew), 7);
  const resumed = SessionLog.open(first.home, first.id);
  assert.equal(resumed.repaired, 0);
  assert.equal(resumed.log.messageCount, 7);
  assert.deepEqual(resumed.entries.map((entry) => rawMessageSeq(entry.message)), [1, 2, 3, 4, 5, undefined, 7]);
});

test("handles share ordinals when the session directory has a symlink alias", () => {
  const log = SessionLog.create(tempDir(), "/work");
  log.append("cli", user("original"));
  const alias = join(tempDir(), "session-home");
  symlinkSync(log.home, alias, "dir");
  const other = SessionLog.open(alias, log.id).log;
  other.append("cli", user("alias"));
  const next = user("original again");
  log.append("cli", next);
  assert.equal(rawMessageSeq(next), 3);
  assert.equal(other.messageCount, 3);
  assert.equal(SessionLog.open(log.home, log.id).log.messageCount, 3);
});

test("failed opens do not replace the count used by existing handles", () => {
  const log = SessionLog.create(tempDir(), "/work");
  log.append("cli", user("one"));
  log.appendCompactionUsage(usage());
  const before = readFileSync(log.path);
  const corrupt = `${JSON.stringify({ type: "message", at: new Date().toISOString(), origin: "cli", message: user("untrusted") })}\n`;
  appendFileSync(log.path, `${corrupt}{"type":"context_prune","version":9}\npartial`);
  assert.throws(() => SessionLog.open(log.home, log.id));
  assert.equal(log.messageCount, 2);
  writeFileSync(log.path, before);
  const next = user("three");
  log.append("cli", next);
  assert.equal(rawMessageSeq(next), 3);
  assert.equal(SessionLog.open(log.home, log.id).log.messageCount, 3);
});

test("failed message and usage appends do not consume an ordinal", () => {
  const log = SessionLog.create(tempDir(), "/work");
  log.append("cli", user("one"));
  const other = SessionLog.open(log.home, log.id).log;
  const before = readFileSync(log.path);
  const failed = user("failed");
  const append = fs.appendFileSync;
  fs.appendFileSync = ((path: fs.PathOrFileDescriptor, data: string) => {
    append(path, data.slice(0, 13));
    throw new Error("injected append failure");
  }) as typeof fs.appendFileSync;
  syncBuiltinESMExports();
  try {
    assert.throws(() => log.append("cli", failed));
    assert.throws(() => other.appendCompactionUsage(usage()));
    assert.equal(log.messageCount, 1);
    assert.equal(other.messageCount, 1);
    assert.equal(rawMessageSeq(failed), undefined);
    assert.deepEqual(readFileSync(log.path), before);
  } finally {
    fs.appendFileSync = append;
    syncBuiltinESMExports();
  }
  other.appendCompactionUsage(usage());
  const next = user("three");
  log.append("cli", next);
  assert.equal(rawMessageSeq(next), 3);
  assert.equal(SessionLog.open(log.home, log.id).log.messageCount, 3);
});

test("appending to an existing 32MB log does not read the log again", () => {
  const body = "x".repeat(32_000_000);
  const { home, id } = foreignSession("/work", [["cli", user(body)]]);
  const log = SessionLog.open(home, id).log;
  const read = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
    if (String(args[0]) === log.path) {
      reads++;
      throw new Error("unexpected full log read");
    }
    return read(...args);
  }) as typeof fs.readFileSync;
  syncBuiltinESMExports();
  try {
    assert.equal(log.messageCount, 1);
    for (let index = 0; index < 500; index++) {
      const next = user(`next ${index}`);
      log.append("cli", next);
      assert.equal(rawMessageSeq(next), index + 2);
    }
    log.appendCompactionUsage(usage());
    assert.equal(log.messageCount, 502);
    assert.equal(reads, 0);
  } finally {
    fs.readFileSync = read;
    syncBuiltinESMExports();
  }
  assert.equal(SessionLog.open(home, id).log.messageCount, 502);
});
