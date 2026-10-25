import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, type AssistantMessage, type Usage } from "@earendil-works/pi-ai";
import { latestUsageUpdate, usageUpdate } from "../src/acp-usage.ts";
import { fauxModels } from "./helpers.ts";

const { model } = fauxModels();

function measured(usage: Partial<Usage> = {}, properties: Partial<AssistantMessage> = {}): AssistantMessage {
  const message = fauxAssistantMessage("response");
  return {
    ...message,
    provider: model.provider,
    model: model.id,
    api: model.api,
    usage: { ...message.usage, input: 100, output: 20, totalTokens: 120, ...usage },
    ...properties,
  };
}

test("context usage counts cache tokens once and excludes token subsets", () => {
  const message = measured({ input: 100, output: 20, cacheRead: 300, cacheWrite: 50, cacheWrite1h: 25, reasoning: 10, totalTokens: 470 });
  assert.deepEqual(usageUpdate(message, model), { sessionUpdate: "usage_update", used: 470, size: model.contextWindow });
});

test("each model call replaces the previous context measurement", () => {
  const first = measured({ input: 1000, output: 200, totalTokens: 1200 });
  const second = measured({ input: 50, output: 10, totalTokens: 60 });
  const messages: AgentMessage[] = [first, { role: "user", content: "continue", timestamp: Date.now() }, second];
  assert.deepEqual(usageUpdate(first, model), { sessionUpdate: "usage_update", used: 1200, size: model.contextWindow });
  assert.deepEqual(latestUsageUpdate(messages, model), { sessionUpdate: "usage_update", used: 60, size: model.contextWindow });
});

test("usage from a different provider, model, or API does not use the selected context size", () => {
  for (const selection of [
    { ...model, provider: "other-provider", contextWindow: 8192 },
    { ...model, id: "other-model", contextWindow: 8192 },
    { ...model, api: "openai-responses" as const, contextWindow: 8192 },
  ]) {
    assert.equal(usageUpdate(measured(), selection), undefined);
    assert.equal(latestUsageUpdate([measured()], selection), undefined);
  }
});

test("load finds the latest measurement for the selected model", () => {
  const first = measured({ input: 500, output: 20 });
  const latest = measured({ input: 100, output: 10 });
  const other = measured({ input: 1000 }, { model: "other-model" });
  const messages: AgentMessage[] = [first, latest, other, { role: "user", content: "next", timestamp: Date.now() }];
  assert.deepEqual(latestUsageUpdate(messages, model), { sessionUpdate: "usage_update", used: 110, size: model.contextWindow });
});

test("cancel and error placeholders preserve the last real measurement on load", () => {
  const previous = measured();
  for (const stopReason of ["aborted", "error"] as const) {
    const placeholder = measured({ input: 0, output: 0, totalTokens: 0 }, { stopReason, content: [] });
    assert.equal(usageUpdate(placeholder, model), undefined);
    assert.equal(latestUsageUpdate([placeholder], model), undefined);
    assert.deepEqual(latestUsageUpdate([previous, placeholder], model), { sessionUpdate: "usage_update", used: 120, size: model.contextWindow });
  }
  assert.equal(latestUsageUpdate([], model), undefined);
});

test("cancelled calls retain real measurements even when totalTokens is absent from the response", () => {
  const partial = measured({ input: 0, output: 0, cacheRead: 200, cacheWrite: 30, totalTokens: 0 }, { stopReason: "aborted", content: [] });
  assert.deepEqual(usageUpdate(partial, model), { sessionUpdate: "usage_update", used: 230, size: model.contextWindow });
});

test("usage omits cost even when the model uses zero prices", () => {
  const freeOrUnknown = { ...model, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const update = usageUpdate(measured(), freeOrUnknown);
  assert.ok(update);
  assert.equal("cost" in update, false);
});

test("invalid token measurements and context sizes do not produce usage", () => {
  for (const count of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(usageUpdate(measured({ cacheRead: count }), model), undefined);
  }
  assert.equal(usageUpdate(measured({ input: Number.MAX_SAFE_INTEGER, output: 1 }), model), undefined);
  for (const contextWindow of [0, -1, NaN, Infinity]) {
    assert.equal(usageUpdate(measured(), { ...model, contextWindow }), undefined);
  }
  const invalid = measured({ cacheWrite: -1 });
  assert.deepEqual(latestUsageUpdate([measured(), invalid], model), { sessionUpdate: "usage_update", used: 120, size: model.contextWindow });
});
