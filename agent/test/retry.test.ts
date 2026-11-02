import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxToolCall, type AssistantMessage } from "@earendil-works/pi-ai";
import { createRxAgent } from "../src/agent.ts";
import { retryControl, type RetryEvent } from "../src/retry.ts";
import { SessionLog } from "../src/session-log.ts";
import { fauxModels, tempDir } from "./helpers.ts";

function setup(t: TestContext, tools: AgentTool[] = []) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { models, model, faux } = fauxModels();
  const log = SessionLog.create(tempDir(), tempDir());
  const agent = createRxAgent({ models, model, thinking: "off", cwd: log.cwd, log, origin: "cli", tools, systemPrompt: "Use tools only when needed" });
  return { models, model, faux, log, agent };
}

async function finish(t: TestContext, operation: Promise<void>) {
  let settled = false;
  const pending = operation.finally(() => { settled = true; });
  const deadline = Date.now() + 5000;
  while (!settled && Date.now() < deadline) {
    await setImmediate();
    t.mock.timers.tick(16000);
  }
  assert.ok(settled, "The request did not settle");
  await pending;
}

const failure = (errorMessage: string, content = "") => fauxAssistantMessage(content, { stopReason: "error", errorMessage });

for (const error of ["429 rate_limit_error", "500 server error", "Stream ended without finish_reason", "Connection error."]) {
  test(`a transient ${error} retries the current request and retains failed usage`, async (t) => {
    const h = setup(t);
    h.faux.setResponses([failure(error, "PARTIAL"), fauxAssistantMessage("recovered")]);
    const events: string[] = [];
    h.agent.subscribe((event) => { if (event.type === "message_start" || event.type === "message_end") events.push(`${event.type}:${event.message.role}`); });
    await finish(t, h.agent.prompt("test"));
    assert.equal(h.faux.state.callCount, 2);
    const last = h.agent.state.messages.at(-1) as AssistantMessage;
    assert.equal(last.stopReason, "stop");
    assert.equal(last.content[0]?.type === "text" && last.content[0].text, "recovered");
    assert.equal(events.filter((event) => event === "message_start:assistant").length, 1);
    assert.equal(events.filter((event) => event === "message_end:assistant").length, 1);
    const loaded = SessionLog.open(h.log.home, h.log.id);
    assert.deepEqual(loaded.messages, h.agent.state.messages.filter((message) => message.role !== "system"));
    const attempts = loaded.messages.filter((message) => message.role === "assistant");
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0]!.stopReason, "error");
    assert.ok(attempts[0]!.usage.output > 0);
    assert.deepEqual(attempts[1]!.usage, last.usage);
  });
}

for (const error of ["401 invalid API key", "403 rate limit access denied", "429 insufficient_quota", "429 monthly usage limit reached"]) {
  test(`a permanent ${error} does not retry`, async (t) => {
    const h = setup(t);
    h.faux.setResponses([failure(error), fauxAssistantMessage("unexpected")]);
    await finish(t, h.agent.prompt("test"));
    assert.equal(h.faux.state.callCount, 1);
    assert.equal((h.agent.state.messages.at(-1) as AssistantMessage).stopReason, "error");
  });
}

test("a dropped request after a completed tool keeps the result and executes the tool once", async (t) => {
  let calls = 0;
  const h = setup(t, [{ name: "count", label: "Count", description: "Count one execution", parameters: Type.Object({}), execute: async () => { calls++; return { content: [{ type: "text", text: "done" }], details: {} }; } }]);
  h.faux.setResponses([
    fauxAssistantMessage([fauxToolCall("count", {}, { id: "once" })], { stopReason: "toolUse" }),
    failure("Stream ended without finish_reason", "PARTIAL"),
    (context) => {
      assert.ok(context.messages.some((message) => message.role === "toolResult" && message.toolCallId === "once"));
      return fauxAssistantMessage("complete");
    },
  ]);
  await finish(t, h.agent.prompt("write once"));
  assert.equal(calls, 1);
  assert.equal(h.faux.state.callCount, 3);
  assert.equal(h.agent.state.messages.filter((message) => message.role === "toolResult").length, 1);
});

test("retry exhaustion is bounded and the same session accepts another prompt", async (t) => {
  const h = setup(t);
  h.faux.setResponses([...Array.from({ length: 4 }, () => failure("503 service unavailable")), fauxAssistantMessage("next prompt")]);
  await finish(t, h.agent.prompt("test"));
  assert.equal(h.faux.state.callCount, 4);
  assert.equal((h.agent.state.messages.at(-1) as AssistantMessage).stopReason, "error");
  await finish(t, h.agent.prompt("continue"));
  assert.equal(h.faux.state.callCount, 5);
  assert.equal((h.agent.state.messages.at(-1) as AssistantMessage).stopReason, "stop");
});


test("retry waits use 2, 4, and 8 seconds and cancellation clears incomplete tool content", async (t) => {
  const h = setup(t);
  h.faux.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage([fauxToolCall("bash", { command: "touch unexpected" }, { id: "unfinished" })], { stopReason: "error", errorMessage: "terminated" })));
  const activity: RetryEvent[] = [];
  const unsubscribe = retryControl(h.agent).subscribe((event) => {
    activity.push(event);
    if (event.attempt === 3 && event.status === "in_progress") h.agent.abort();
  });
  await finish(t, h.agent.prompt("test"));
  unsubscribe();
  assert.deepEqual(activity.filter((event) => event.status === "in_progress").map((event) => event.delayMs), [2000, 4000, 8000]);
  assert.equal(activity.at(-1)?.status, "failed");
  assert.equal(new Set(activity.map((event) => event.id)).size, 1);
  assert.equal(h.faux.state.callCount, 3);
  const last = h.agent.state.messages.at(-1) as AssistantMessage;
  assert.equal(last.stopReason, "aborted");
  assert.deepEqual(last.content, []);
  assert.equal(h.agent.state.messages.filter((message) => message.role === "toolResult").length, 0);
  assert.deepEqual(SessionLog.open(h.log.home, h.log.id).messages.at(-1), last);
});

for (const unfinishedTool of [false, true]) {
  test(`cancelling a live response preserves text${unfinishedTool ? " and removes unfinished tool calls" : ""} in the session log`, async (t) => {
    const h = setup(t);
    let calls = 0;
    h.models.streamSimple = (model, _context, options) => {
      calls++;
      const stream = createAssistantMessageEventStream();
      const message = { ...fauxAssistantMessage("PARTIAL", { stopReason: "aborted" }), api: model.api, provider: model.provider, model: model.id };
      if (unfinishedTool) message.content.push(fauxToolCall("bash", { command: "touch unexpected" }, { id: "unfinished" }));
      void (async () => {
        stream.push({ type: "start", partial: { ...message, content: [] } });
        stream.push({ type: "text_delta", contentIndex: 0, delta: "PARTIAL", partial: message });
        await setImmediate();
        assert.equal(options?.signal?.aborted, true);
        stream.push({ type: "error", reason: "aborted", error: message });
        stream.end(message);
      })();
      return stream;
    };
    const activity: RetryEvent[] = [];
    retryControl(h.agent).subscribe((event) => activity.push(event));
    h.agent.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") h.agent.abort();
    });
    await finish(t, h.agent.prompt("test"));
    const last = h.agent.state.messages.at(-1) as AssistantMessage;
    assert.equal(last.stopReason, "aborted");
    assert.deepEqual(last.content, [{ type: "text", text: "PARTIAL" }]);
    assert.deepEqual(SessionLog.open(h.log.home, h.log.id).history.at(-1), last);
    assert.equal(calls, 1);
    assert.equal(activity.length, 0);
    assert.equal(h.agent.state.messages.some((message) => message.role === "toolResult"), false);
  });
}
