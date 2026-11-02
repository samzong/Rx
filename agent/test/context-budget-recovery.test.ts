import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxToolCall, type AssistantMessage } from "@earendil-works/pi-ai";
import { createRxAgent } from "../src/agent.ts";
import { contextControl } from "../src/context-control.ts";
import { contextBudget, MAX_SUMMARY_CALLS } from "../src/context.ts";
import { compactionPlan } from "../src/context-plan.ts";
import { SessionLog } from "../src/session-log.ts";
import { fauxModels, tempDir } from "./helpers.ts";

function setup(window = 16384, length = 18000) {
  const { models, faux, model } = fauxModels();
  const selected = { ...model, contextWindow: window };
  const cwd = tempDir();
  const log = SessionLog.create(tempDir(), cwd);
  const messages: AgentMessage[] = [
    { role: "user", content: `Keep file secret.txt unchanged. Fix issue A. ${"prior evidence ".repeat(Math.ceil(length / 15))}`, timestamp: Date.now() },
    fauxAssistantMessage("Completed edit of result.txt. Pending verification. Unknown side effect of interrupted command."),
  ];
  for (const message of messages) log.append(message.role === "user" ? "cli" : "model", message);
  const agent = createRxAgent({ models, model: selected, cwd, thinking: "off", log, origin: "cli", systemPrompt: "Follow the user's constraints. Never repeat completed side effects.", messages });
  return { models, faux, model: selected, log, agent, control: contextControl(agent), original: structuredClone(agent.state.messages) };
}

const summary = () => fauxAssistantMessage("Goal: fix A. Do not edit secret.txt. result.txt was edited. Verify next. The interrupted command has unknown side effects. [log 1-1]");
const records = (log: SessionLog): any[] => readFileSync(log.path, "utf8").trim().split("\n").map((line) => JSON.parse(line));

function overUsage(message: AssistantMessage, budget: number): AssistantMessage {
  return { ...message, usage: { ...message.usage, output: budget + 1, totalTokens: message.usage.input + budget + 1 } };
}

function mockSummaryResponses(h: ReturnType<typeof setup>, responses: AssistantMessage[], inspect?: (call: number, request: string) => void) {
  let calls = 0;
  const original = h.models.streamSimple.bind(h.models);
  h.models.streamSimple = (model, context, options) => {
    if (model.maxTokens > 4096) return original(model, context, options);
    const call = ++calls;
    inspect?.(call, JSON.stringify(context));
    const message = { ...responses[call - 1]!, api: model.api, provider: model.provider, model: model.id };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "start", partial: { ...message, content: [] } });
      if (message.stopReason === "stop" || message.stopReason === "length" || message.stopReason === "toolUse" || message.stopReason === "deferred") stream.push({ type: "done", reason: message.stopReason, message });
      else stream.push({ type: "error", reason: message.stopReason === "aborted" ? "aborted" : "error", error: message });
      stream.end(message);
    });
    return stream;
  };
  return () => calls;
}

test("compaction corrects streamed estimates, measured usage, and provider length", async () => {
  for (const failure of ["stream", "usage", "length"] as const) {
    const h = setup(16384, 80000);
    const budget = contextBudget(h.model).summary;
    const tooLarge = failure === "stream"
      ? fauxAssistantMessage(`Rejected draft. [log 1-1] ${"oversized content ".repeat(8000)}`)
      : failure === "usage"
        ? overUsage(summary(), budget)
        : { ...summary(), stopReason: "length" as const };
    h.faux.setResponses([fauxAssistantMessage("constraints retained")]);
    const target = Math.max(64, Math.floor(budget / 4));
    const summaryCalls = mockSummaryResponses(h, [summary(), tooLarge, ...Array.from({ length: MAX_SUMMARY_CALLS }, summary)], (call, request) => {
      assert.match(request, /prior evidence/);
      if (call === 3) {
        assert.match(request, /substantially shorter summary/);
        assert.match(request, new RegExp(`under ${target} characters`));
        assert.match(request, /Goal: fix A/);
        assert.doesNotMatch(request, /Rejected draft/);
      }
    });
    await h.control.compact();
    assert.ok(summaryCalls() >= 3 && summaryCalls() <= MAX_SUMMARY_CALLS, failure);
    assert.equal(records(h.log).filter((entry) => entry.type === "compaction").length, 1, failure);
  }
});

test("repeated budget failures preserve raw history and allow the same loaded session to compact later", async () => {
  const h = setup();
  const before = readFileSync(h.log.path, "utf8");
  const rejected = fauxAssistantMessage(`Rejected draft. [log 1-1] ${"oversized content ".repeat(8000)}`);
  h.faux.setResponses([rejected, rejected]);
  await assert.rejects(h.control.compact(), /output budget|shorter/i);
  assert.deepEqual(h.agent.state.messages, h.original);
  assert.equal(records(h.log).filter((entry) => entry.type === "compaction").length, 0);
  assert.ok(readFileSync(h.log.path, "utf8").startsWith(before));
  const loaded = SessionLog.open(h.log.home, h.log.id);
  assert.deepEqual(loaded.history, h.original.filter((message) => message.role !== "system"));
  const resumed = createRxAgent({ models: h.models, model: h.model, cwd: h.log.cwd, thinking: "off", log: loaded.log, origin: "cli", systemPrompt: "Current instructions", messages: loaded.messages });
  h.faux.setResponses([summary()]);
  await contextControl(resumed).compact();
  assert.equal(records(h.log).filter((entry) => entry.type === "compaction").length, 1);
});

test("budget correction respects the eight-request cap and reserves one request per remaining chunk", async () => {
  for (const count of [7, 8]) {
    const h = setup(16384, count === 7 ? 150000 : 180000);
    const planned = compactionPlan(h.agent.state.messages, h.model)!;
    assert.equal(planned.chunks.length, count);
    const budget = contextBudget(h.model).summary;
    const calls = mockSummaryResponses(h, [overUsage(summary(), budget), ...Array.from({ length: MAX_SUMMARY_CALLS }, summary)]);
    if (count === 7) {
      await h.control.compact();
      assert.equal(calls(), MAX_SUMMARY_CALLS);
      assert.equal(records(h.log).filter((entry) => entry.type === "compaction").length, 1);
    } else {
      await assert.rejects(h.control.compact());
      assert.equal(calls(), 1);
      assert.deepEqual(h.agent.state.messages, h.original);
      assert.equal(records(h.log).filter((entry) => entry.type === "compaction").length, 0);
    }
  }
});

test("cancellation before or during budget correction prevents another summary request", async () => {
  for (const mode of ["before", "during"] as const) {
    const h = setup();
    let calls = 0;
    const budget = contextBudget(h.model).summary;
    h.models.streamSimple = (model, _context, _options) => {
      calls++;
      const stream = createAssistantMessageEventStream();
      const message = mode === "during" && calls === 2
        ? { ...summary(), content: [], stopReason: "aborted" as const, errorMessage: "Request was aborted" }
        : calls === 1 ? overUsage(summary(), budget) : summary();
      queueMicrotask(() => {
        if (mode === "during" && calls === 2) h.control.abort();
        stream.push({ type: "start", partial: { ...message, content: [] } });
        if (message.stopReason === "aborted") stream.push({ type: "error", reason: "aborted", error: message });
        else if (message.stopReason === "stop" || message.stopReason === "length" || message.stopReason === "toolUse" || message.stopReason === "deferred") stream.push({ type: "done", reason: message.stopReason, message });
        else stream.push({ type: "error", reason: "error", error: message });
        stream.end(message);
        if (mode === "before" && calls === 1) h.control.abort();
      });
      return stream;
    };
    await assert.rejects(h.control.compact());
    assert.equal(calls, mode === "before" ? 1 : 2);
    assert.equal(records(h.log).filter((entry) => entry.type === "compaction").length, 0);
  }
});

test("tool calls remain a deterministic failure and are not treated as budget corrections", async () => {
  const h = setup();
  const toolResponse = fauxAssistantMessage([fauxToolCall("bash", { command: "touch forbidden" })], { stopReason: "toolUse" });
  h.faux.setResponses([toolResponse, summary()]);
  await assert.rejects(h.control.compact(), /tool/i);
  assert.equal(h.faux.state.callCount, 1);
  assert.deepEqual(h.agent.state.messages, h.original);
  assert.equal(records(h.log).filter((entry) => entry.type === "compaction").length, 0);
});
