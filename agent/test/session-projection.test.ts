import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall, type UserMessage } from "@earendil-works/pi-ai";
import type { CompactionCheckpoint } from "../src/context-control.ts";
import { SessionLog } from "../src/session-log.ts";
import { foreignSession, tempDir } from "./helpers.ts";

const user = (content: string): UserMessage => ({ role: "user", content, timestamp: 0 });
const result = (id = "call") => ({
  role: "toolResult" as const, toolCallId: id, toolName: "bash", content: [{ type: "text" as const, text: "original evidence" }], isError: false, timestamp: 0,
});
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
    appendFileSync(path, `${JSON.stringify({ ...checkpoint(2), summary: "Summary [log 1-1]", ...metadata })}\npartial`);
    const before = readFileSync(path);
    assert.throws(() => SessionLog.open(home, id));
    assert.deepEqual(readFileSync(path), before);
    assert.equal(existsSync(lock), false);
  }
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
    assert.throws(() => SessionLog.open(log.home, log.id));
    assert.throws(() => log.readRange(1, 1));
    assert.deepEqual(readFileSync(log.path), before);
    assert.ok(before.subarray(0, beforeRecord.length).equals(beforeRecord));
  }
});
