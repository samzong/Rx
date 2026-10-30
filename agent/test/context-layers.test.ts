import assert from "node:assert/strict";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readTool } from "../src/tools.ts";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import { createRxAgent } from "../src/agent.ts";
import { contextControl } from "../src/context-control.ts";
import { validateSummarySources } from "../src/context-citations.ts";
import { pruningPlan, compactionPlan } from "../src/context-plan.ts";
import { messageSources } from "../src/context-source.ts";
import { SessionLog } from "../src/session-log.ts";
import { fauxModels, tempDir } from "./helpers.ts";

const user = (content: string): AgentMessage => ({ role: "user", content, timestamp: Date.now() });
const call = (id: string) => fauxAssistantMessage([fauxToolCall("read", { path: `${id}.txt` }, { id })], { stopReason: "toolUse" });
const result = (id: string, text: string): ToolResultMessage => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text }], isError: false, timestamp: Date.now() });
const records = (log: SessionLog) => readFileSync(log.path, "utf8").trim().split("\n").map((line) => JSON.parse(line));

function setup(messages: AgentMessage[]) {
  const { models, faux, model } = fauxModels();
  const selected = { ...model, contextWindow: 16384 };
  const log = SessionLog.create(tempDir(), tempDir());
  for (const message of messages) log.append(message.role === "user" ? "cli" : message.role === "toolResult" ? "tool" : "model", message);
  const agent = createRxAgent({ models, model: selected, thinking: "off", cwd: log.cwd, systemPrompt: "Use historical evidence without repeating completed tools.", log, origin: "cli", messages });
  return { models, faux, model: selected, log, agent, control: contextControl(agent) };
}

test("a durable pruning pass satisfies pressure without requesting a summary and survives load", async () => {
  const original = "ORIGINAL_RANDOM_MARKER_81d2 " + "old evidence ".repeat(5000);
  const h = setup([user("Inspect the evidence"), call("old"), result("old", original), fauxAssistantMessage("Observed"), user("A later task"), call("recent"), result("recent", "recent visible evidence"), fauxAssistantMessage("Ready")]);
  h.faux.setResponses([(_context, _options, _state, model) => {
    assert.ok(model.maxTokens > 4096);
    return fauxAssistantMessage("continued");
  }]);
  await h.agent.prompt("Continue with the current task");
  const entries = records(h.log);
  assert.equal(h.faux.state.callCount, 1);
  assert.equal(entries.filter((entry) => entry.type === "context_prune").length, 1);
  assert.equal(entries.some((entry) => entry.type === "compaction"), false);
  const loaded = SessionLog.open(h.log.home, h.log.id);
  assert.deepEqual(loaded.messages, h.agent.state.messages.filter((message) => message.role !== "system"));
  assert.match(JSON.stringify(loaded.messages), /recent visible evidence/);
  assert.doesNotMatch(JSON.stringify(loaded.messages), /ORIGINAL_RANDOM_MARKER/);
  assert.equal((loaded.history[2] as any).content[0].text, original);
  assert.equal(loaded.usageMessages.length, 1);
});

test("remaining pressure summarizes the cleared projection without treating omitted output as inspected evidence", async () => {
  const h = setup([user("Keep the original goal. " + "prior user evidence ".repeat(4500)), call("old"), result("old", "OMITTED_RAW_EVIDENCE ".repeat(2000)), fauxAssistantMessage("Observed"), call("recent"), result("recent", "Recent evidence")]);
  let summaryCalls = 0;
  h.faux.setResponses(Array.from({ length: 9 }, () => (context, _options, _state, model) => {
    if (model.maxTokens > 4096) return fauxAssistantMessage("continued");
    summaryCalls++;
    const text = JSON.stringify(context);
    assert.doesNotMatch(text, /OMITTED_RAW_EVIDENCE/);
    return fauxAssistantMessage("Keep the original goal. [log 1-1]");
  }));
  await h.agent.prompt("Continue");
  const entries = records(h.log);
  assert.ok(summaryCalls > 0);
  assert.ok(entries.findIndex((entry) => entry.type === "context_prune") < entries.findIndex((entry) => entry.type === "compaction"));
  assert.deepEqual(SessionLog.open(h.log.home, h.log.id).messages, h.agent.state.messages.filter((message) => message.role !== "system"));
});

test("three compactions preserve original source ordinals across new retained objects and reloads", async () => {
  const original = "Stable early marker 923f71: do not edit protected.txt. " + "early evidence ".repeat(1400);
  const h = setup([user(original), fauxAssistantMessage("Recorded")]);
  h.faux.setResponses(Array.from({ length: 20 }, () => (_context, _options, _state, model) => model.maxTokens <= 4096
    ? fauxAssistantMessage("Do not edit protected.txt. [log 1-1]") : fauxAssistantMessage("New evidence recorded")));
  for (let index = 0; index < 3; index++) {
    await contextControl(h.agent).compact();
    const checkpoint = records(h.log).filter((entry) => entry.type === "compaction").at(-1)!;
    assert.deepEqual(checkpoint.summarySources, [{ from: 1, to: 1 }]);
    const loaded = SessionLog.open(h.log.home, h.log.id);
    assert.deepEqual(messageSources(loaded.messages[0]!), [{ from: 1, to: 1 }]);
    assert.equal((loaded.log.readRange(1, 1).entries[0]!.message as any).content, original);
    if (index < 2) await h.agent.prompt(`New evidence ${index}. ` + "later visible evidence ".repeat(550));
  }
  assert.equal(records(h.log).filter((entry) => entry.type === "compaction").length, 3);
});

test("source labels repeat on each split of an oversized original message", () => {
  const h = setup([user("evidence ".repeat(13000)), fauxAssistantMessage("Recorded")]);
  const plan = compactionPlan(h.agent.state.messages, h.model)!;
  assert.ok(plan.chunks.length > 1);
  for (const chunk of plan.chunks) assert.match(chunk.text, /^\[log 1-1\]/);
});

test("citation validation rejects missing, malformed, fabricated, usage-gap, and narrowed legacy references", () => {
  const allowed = [{ from: 1, to: 2 }, { from: 4, to: 4 }];
  for (const text of ["An uncited fact", "A fact. [log 1]", "A fact. [log 9-9]", "A fact. [log 1-4]", "A fact. [log 2-1]", "## Only headings"]) {
    assert.throws(() => validateSummarySources(text, allowed));
  }
  assert.throws(() => validateSummarySources("A narrow claim. [log 2-2]", [{ from: 1, to: 10, coverage: true }]));
  assert.deepEqual(validateSummarySources("## Goal\nA supported claim. [log 1-2]\n(none)", allowed), [{ from: 1, to: 2 }]);
  assert.deepEqual(validateSummarySources("A coverage claim. [log 1-10]", [{ from: 1, to: 10, coverage: true }]), [{ from: 1, to: 10, coverage: true }]);
});

test("a failed prune append never installs cleared content", async (t) => {
  const h = setup([user("Inspect evidence"), call("old"), result("old", "preserved original ".repeat(4000)), fauxAssistantMessage("Observed"), call("recent"), result("recent", "Recent evidence")]);
  const original = h.agent.state.messages.find((message) => message.role === "toolResult")!;
  t.mock.method(h.log, "appendPrune", () => { throw new Error("Injected append failure"); });
  await h.agent.prompt("Continue");
  assert.equal(records(h.log).at(-1).message.stopReason, "error");
  assert.equal(h.agent.state.messages.find((message) => message.role === "toolResult"), original);
  assert.equal(records(h.log).some((entry) => entry.type === "context_prune"), false);
  assert.equal(h.faux.state.callCount, 0);
});

test("cancelling a summary after clearing preserves the committed clearing selection without replay", async () => {
  const h = setup([user("Keep the original goal. " + "user evidence ".repeat(5000)), call("old"), result("old", "original result ".repeat(2000)), fauxAssistantMessage("Observed"), call("recent"), result("recent", "Recent evidence")]);
  h.control.subscribe((event) => { if (event.status === "in_progress") h.control.abort(); });
  await h.agent.prompt("Continue");
  const entries = records(h.log);
  assert.equal(entries.filter((entry) => entry.type === "context_prune").length, 1);
  assert.equal(entries.some((entry) => entry.type === "compaction"), false);
  assert.equal(entries.at(-1).message.stopReason, "aborted");
  assert.equal(h.faux.state.callCount, 0);
  const loaded = SessionLog.open(h.log.home, h.log.id);
  assert.equal(loaded.repaired, 0);
  assert.deepEqual(loaded.messages, h.agent.state.messages.filter((message) => message.role !== "system"));
  assert.match(JSON.stringify(loaded.history), /original result original result/);
});

test("the registered recall tool restores logged image bytes after compaction, source deletion, and load", async () => {
  const h = setup([user("Keep the original image for a later visual check")]);
  const bytes = Buffer.alloc(33);
  Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").copy(bytes);
  bytes.writeUInt32BE(320, 16);
  bytes.writeUInt32BE(240, 20);
  const path = join(h.log.cwd, "original.png");
  writeFileSync(path, bytes);
  const original = await readTool(h.log.cwd, () => h.model).execute("original", { path });
  const image = original.content.find((block) => block.type === "image")!;
  const messages = [call("image"), { ...result("image", "Original image"), content: original.content }, fauxAssistantMessage("Image recorded"), user("Later historical data. " + "bulk evidence ".repeat(3500)), fauxAssistantMessage("Later data recorded")];
  for (const message of messages) {
    h.log.append(message.role === "user" ? "cli" : message.role === "toolResult" ? "tool" : "model", message);
    h.agent.state.messages.push(message);
  }
  rmSync(path);
  h.faux.setResponses(Array.from({ length: 8 }, () => fauxAssistantMessage("The original image remains available by its source. [log 3-3]")));
  await h.control.compact();
  assert.equal(h.agent.state.messages.some((message) => (message.role === "user" || message.role === "toolResult") && Array.isArray(message.content) && message.content.some((block) => block.type === "image")), false);
  const loaded = SessionLog.open(h.log.home, h.log.id);
  const resumed = createRxAgent({ models: h.models, model: h.model, thinking: "off", cwd: h.log.cwd, systemPrompt: "Continue from the saved context", log: loaded.log, origin: "cli", messages: loaded.messages });
  const tool = resumed.state.tools.find((tool) => tool.name === "recall_log")!;
  assert.ok(tool);
  const recalled = await tool.execute("recall", { from: 3, to: 3 });
  assert.deepEqual(recalled.content.find((block) => block.type === "image"), image);
});
