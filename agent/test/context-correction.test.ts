import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createRxAgent } from "../src/agent.ts";
import { contextControl } from "../src/context-control.ts";
import { compactionPlan, MAX_SUMMARY_CALLS } from "../src/context-plan.ts";
import { SessionLog } from "../src/session-log.ts";
import { fauxModels, tempDir } from "./helpers.ts";

function setup(length = 12000) {
  const { models, faux, model } = fauxModels();
  const selected = { ...model, contextWindow: 16384 };
  const log = SessionLog.create(tempDir(), tempDir());
  const messages: AgentMessage[] = [{ role: "user", content: "Original evidence " + "x".repeat(length), timestamp: Date.now() }];
  log.append("cli", messages[0]!);
  const usage = fauxAssistantMessage("Accounting does not provide source evidence");
  usage.usage.input = 1;
  log.appendCompactionUsage(usage);
  messages.push(fauxAssistantMessage("Recorded"));
  log.append("model", messages[1]!);
  const agent = createRxAgent({ models, model: selected, cwd: log.cwd, log, origin: "cli", thinking: "off", systemPrompt: "Use original evidence", messages });
  return { agent, control: contextControl(agent), log, faux, model: selected };
}

const entries = (log: SessionLog) => readFileSync(log.path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
const summary = () => fauxAssistantMessage("Original evidence remains available. [log 1-1]");

test("one citation correction uses original sources without promoting the rejected draft", async () => {
  const h = setup();
  assert.equal(compactionPlan(h.agent.state.messages, h.model)!.chunks.length, 1);
  h.faux.setResponses([
    fauxAssistantMessage("REJECTED_DRAFT_IS_NOT_EVIDENCE. [log 1-3]"),
    (context) => {
      const request = JSON.stringify(context);
      assert.match(request, /previous attempt failed source validation/);
      assert.match(request, /Allowed source ranges: \[log 1-1\]/);
      assert.doesNotMatch(request, /REJECTED_DRAFT_IS_NOT_EVIDENCE/);
      assert.match(request, /Original evidence/);
      return summary();
    },
  ]);
  await h.control.compact();
  assert.equal(h.faux.state.callCount, 2);
  const stored = entries(h.log);
  assert.equal(stored.filter((entry) => entry.purpose === "compaction").length, 3);
  const checkpoint = stored.find((entry) => entry.type === "compaction");
  assert.equal(checkpoint.through, 5);
  assert.deepEqual(checkpoint.summarySources, [{ from: 1, to: 1 }]);
  assert.deepEqual(SessionLog.open(h.log.home, h.log.id).messages, h.agent.state.messages.filter((message) => message.role !== "system"));
});

test("a second citation failure ends the operation and preserves the projection", async () => {
  const h = setup();
  const original = structuredClone(h.agent.state.messages);
  h.faux.setResponses(Array.from({ length: 3 }, () => fauxAssistantMessage("An uncited claim")));
  await assert.rejects(h.control.compact());
  assert.equal(h.faux.state.callCount, 2);
  assert.deepEqual(h.agent.state.messages, original);
  assert.equal(entries(h.log).some((entry) => entry.type === "compaction"), false);
});

test("citation corrections reserve a request for every remaining chunk within the eight-call limit", async () => {
  for (const count of [7, 8]) {
    const h = setup(22000 * count);
    const plan = compactionPlan(h.agent.state.messages, h.model)!;
    assert.equal(plan.chunks.length, count);
    const original = structuredClone(h.agent.state.messages);
    h.faux.setResponses(Array.from({ length: MAX_SUMMARY_CALLS + 1 }, (_, index) => index === 0 || index === 2 ? fauxAssistantMessage("Invalid source. [log 99-99]") : summary()));
    await assert.rejects(h.control.compact());
    assert.equal(h.faux.state.callCount, count === 7 ? 3 : 1);
    assert.deepEqual(h.agent.state.messages, original);
    assert.equal(entries(h.log).some((entry) => entry.type === "compaction"), false);
  }
  const h = setup(22000 * 7);
  h.faux.setResponses(Array.from({ length: 9 }, (_, index) => index === 0 ? fauxAssistantMessage("Uncited claim") : summary()));
  await h.control.compact();
  assert.equal(h.faux.state.callCount, MAX_SUMMARY_CALLS);
});

test("correction of a later chunk retains the last valid summary", async () => {
  const h = setup(44000);
  assert.equal(compactionPlan(h.agent.state.messages, h.model)!.chunks.length, 2);
  h.faux.setResponses([
    fauxAssistantMessage("LAST_VALID_SUMMARY. [log 1-1]"),
    fauxAssistantMessage("REJECTED_LATER_DRAFT. [log 99-99]"),
    (context) => {
      const request = JSON.stringify(context);
      assert.match(request, /LAST_VALID_SUMMARY/);
      assert.doesNotMatch(request, /REJECTED_LATER_DRAFT/);
      return summary();
    },
  ]);
  await h.control.compact();
  assert.equal(h.faux.state.callCount, 3);
});
