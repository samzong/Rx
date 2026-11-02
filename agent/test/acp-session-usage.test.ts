import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage, type Usage } from "@earendil-works/pi-ai";
import { SessionUsage } from "../src/acp-session-usage.ts";

function measured(usage: Partial<Usage> = {}, provider = "provider", model = "one") {
  const message = fauxAssistantMessage("response");
  return { ...message, provider, model, usage: { ...message.usage, input: 100, output: 20, cacheRead: 30, cacheWrite: 40, ...usage } };
}

test("session accounting uses disjoint buckets and immutable cumulative snapshots", () => {
  const ledger = new SessionUsage();
  const first = ledger.record("session", measured({ reasoning: 5 }))!;
  const second = ledger.record("session", measured({ reasoning: 3 }))!;
  assert.deepEqual(first.usage, { inputTokens: 100, outputTokens: 15, cacheReadInputTokens: 30, cacheCreationInputTokens: 40, reasoningOutputTokens: 5, costUSD: 0 });
  assert.deepEqual(second.modelUsage["provider/one"], { inputTokens: 200, outputTokens: 32, cacheReadInputTokens: 60, cacheCreationInputTokens: 80, reasoningOutputTokens: 8, costUSD: 0 });
  assert.deepEqual(second.delta.usage, second.usage);
  assert.deepEqual(second.delta.modelUsage, { "provider/one": second.usage });
  assert.equal(first.modelUsage["provider/one"]!.inputTokens, 100);
  first.modelUsage["provider/one"]!.inputTokens = 9999;
  assert.equal(ledger.record("session", measured())!.modelUsage["provider/one"]!.inputTokens, 300);
});

test("model and provider changes keep independent cumulative buckets", () => {
  const ledger = new SessionUsage();
  ledger.record("session", measured());
  ledger.record("session", measured({}, "provider", "two"));
  const update = ledger.record("session", measured({}, "other", "one"))!;
  assert.deepEqual(Object.keys(update.modelUsage), ["provider/one", "provider/two", "other/one"]);
  for (const usage of Object.values(update.modelUsage)) assert.equal(usage.inputTokens, 100);
  assert.deepEqual(update.delta.modelUsage, { "other/one": update.usage });
});

test("missing cost stays unknown in cumulative usage and delta while explicit zero stays known", () => {
  const ledger = new SessionUsage();
  const unknown = measured();
  delete (unknown.usage as Partial<Usage>).cost;
  const first = ledger.record("session", unknown)!;
  assert.equal("costUSD" in first.usage, false);
  assert.equal("costUSD" in first.modelUsage["provider/one"]!, false);
  assert.equal("costUSD" in first.delta.usage, false);
  const known = measured({ cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 } });
  const second = ledger.record("session", known)!;
  assert.equal(second.usage.costUSD, 0.3);
  assert.equal("costUSD" in second.modelUsage["provider/one"]!, false);
  assert.equal("costUSD" in second.delta.usage, false);
  const zero = new SessionUsage().record("session", measured())!;
  assert.equal(zero.usage.costUSD, 0);
  assert.equal(zero.modelUsage["provider/one"]!.costUSD, 0);
});

test("invalid measurements do not change the accounting baseline", () => {
  const ledger = new SessionUsage();
  for (const value of [-1, Infinity, NaN, 1.5]) assert.equal(ledger.record("session", measured({ input: value })), undefined);
  assert.equal(ledger.record("session", measured({ reasoning: 21 })), undefined);
  assert.equal(ledger.record("session", measured())!.modelUsage["provider/one"]!.inputTokens, 100);
});

test("placeholder pricing keeps cumulative and delta costs unknown after a known response", () => {
  const ledger = new SessionUsage();
  const first = ledger.record("session", measured(), false)!;
  assert.equal(Object.hasOwn(first.usage, "costUSD"), false);
  const second = ledger.record("session", measured())!;
  assert.equal(second.usage.costUSD, 0);
  assert.equal(Object.hasOwn(second.modelUsage["provider/one"]!, "costUSD"), false);
  assert.equal(Object.hasOwn(second.delta.usage, "costUSD"), false);
  assert.equal(Object.hasOwn(second.delta.modelUsage["provider/one"]!, "costUSD"), false);
});
