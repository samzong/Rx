import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall, type UserMessage } from "@earendil-works/pi-ai";
import type { CompactionCheckpoint } from "../src/context-control.ts";
import { checkpointMessages, SessionLog } from "../src/session-log.ts";
import { foreignSession, tempDir } from "./helpers.ts";

const user = (text: string): UserMessage => ({ role: "user", content: text, timestamp: Date.now() });

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
    assert.throws(() => SessionLog.open(home, id));
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

test("a checkpoint cannot hide a dangling call and loading such a boundary preserves all bytes", () => {
  const home = tempDir();
  const log = SessionLog.create(home, "/work");
  log.append("model", fauxAssistantMessage([fauxToolCall("bash", {}, { id: "hidden-call" })], { stopReason: "toolUse" }));
  const before = readFileSync(log.path);
  assert.throws(() => log.appendCheckpoint("A summary", []));
  assert.deepEqual(readFileSync(log.path), before);
  appendFileSync(log.path, `${JSON.stringify({ type: "compaction", version: 1, at: new Date().toISOString(), through: 1, summary: "A summary", retained: [] })}\npartial`);
  const hidden = readFileSync(log.path);
  assert.throws(() => SessionLog.open(home, log.id));
  assert.deepEqual(readFileSync(log.path), hidden);
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
