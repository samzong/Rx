import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionLog } from "../src/session-log.ts";
import { foreignSession, tempDir } from "./helpers.ts";

const user = (content: string) => ({ role: "user" as const, content, timestamp: Date.now() });

test("fork retains only checkpoints and clearing selections before the next turn", () => {
  const home = tempDir();
  const cwd = tempDir();
  const source = SessionLog.create(home, cwd);
  const first = source.beginTurn();
  source.append("acp", user("A"));
  source.append("model", fauxAssistantMessage("answer A"));
  const second = source.beginTurn();
  source.append("acp", user("B"));
  source.appendCheckpoint("A and B summary", []);
  source.append("model", fauxAssistantMessage("answer B"));
  source.beginTurn();
  source.append("acp", user("C"));
  source.append("model", fauxAssistantMessage([fauxToolCall("read", { path: "x" }, { id: "read-1" })], { stopReason: "toolUse" }));
  source.appendToolInput("read-1", { path: "executed-x" });
  source.append("tool", { role: "toolResult", toolCallId: "read-1", toolName: "read", content: [{ type: "text", text: "large content" }], isError: false, timestamp: Date.now() });
  source.appendPrune([7]);
  source.append("model", fauxAssistantMessage("answer C"));
  const earlier = SessionLog.fork(home, source.id, cwd, first);
  assert.equal(earlier.messages.length, 2);
  assert.doesNotMatch(JSON.stringify(earlier.messages), /summary|B|C/);
  const later = SessionLog.fork(home, source.id, cwd, second);
  assert.equal(later.messages.length, 2);
  assert.match(JSON.stringify(later.messages[0]), /A and B summary/);
  assert.doesNotMatch(JSON.stringify(later.messages), /answer C|large content/);
  const all = SessionLog.fork(home, source.id, cwd);
  assert.match(JSON.stringify(all.messages), /cleared, log seq 7/);
  assert.deepEqual(all.inputs.get("read-1"), { path: "executed-x" });
});

test("old logs get stable ordinal boundaries and missing sources or turns cannot create forks", () => {
  const cwd = tempDir();
  const source = foreignSession(cwd, [["acp", user("old A")], ["model", fauxAssistantMessage("answer A")], ["acp", user("old B")], ["model", fauxAssistantMessage("answer B")]]);
  const original = readFileSync(source.path);
  const fork = SessionLog.fork(source.home, source.id, cwd, "message-1");
  assert.equal(fork.history.length, 2);
  assert.equal(fork.turns[0]?.id, "message-1");
  assert.throws(() => SessionLog.fork(source.home, source.id, cwd, "missing"));
  assert.throws(() => SessionLog.fork(source.home, "../missing", cwd));
  assert.throws(() => SessionLog.fork(source.home, "00000000-0000-0000-0000-000000000000", cwd));
  assert.deepEqual(readFileSync(source.path), original);
});
