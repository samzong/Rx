import assert from "node:assert/strict";
import { test } from "node:test";
import * as acp from "@agentclientprotocol/sdk/unstable";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { LODY_EXTENSION_METHODS, type RateLimitsSnapshot } from "acp-extension-core";
import { codexRateLimitEvent, codexRateLimits } from "../src/acp-rate-limits.ts";
import { createAcpApp } from "../src/acp.ts";
import { createRxAgent } from "../src/agent.ts";
import { contextControl } from "../src/context-control.ts";
import { SessionLog } from "../src/session-log.ts";
import { fauxModels, tempDir } from "./helpers.ts";

process.env.HOME = tempDir();
process.env.RX_HOME = tempDir();

const { model: fauxModel } = fauxModels();
const model = { ...fauxModel, provider: "openai-codex", api: "openai-codex-responses" as const, baseUrl: "https://chatgpt.com/backend-api" };
const headers = {
  "x-codex-primary-used-percent": "12.5",
  "x-codex-primary-window-minutes": "300",
  "x-codex-primary-reset-at": "1800000000",
  "x-codex-secondary-used-percent": "50",
  "x-codex-secondary-window-minutes": "10080",
  "x-codex-secondary-reset-at": "1800000100",
};

const rateLimitEvent = {
  type: "codex.rate_limits",
  rate_limits: { primary: { used_percent: 41, window_minutes: 10080, reset_at: 1794206353 }, secondary: null },
};

test("Codex headers preserve percentage and Unix seconds and convert minutes to seconds", () => {
  assert.deepEqual(codexRateLimits({ status: 200, headers }, model, 1700000000123), {
    rateLimits: [{ limitId: "codex", scope: { providerId: "openai-codex" }, windows: [
      { usedPercent: 12.5, windowDurationSeconds: 18000, resetsAtEpochSeconds: 1800000000 },
      { usedPercent: 50, windowDurationSeconds: 604800, resetsAtEpochSeconds: 1800000100 },
    ] }], fetchedAtEpochSeconds: 1700000000,
  });
  assert.equal(codexRateLimits({ status: 429, headers }, model)?.rateLimits[0]?.windows.length, 2);
});

test("Codex stream events preserve a primary window with null secondary and ignore additional limits", () => {
  assert.deepEqual(codexRateLimitEvent({ ...rateLimitEvent,
    additional_rate_limits: [{ rate_limits: { primary: { used_percent: 99 } } }],
    credits: { has_credits: true }, plan_type: "plus",
  }, model, 1700000000123), {
    rateLimits: [{ limitId: "codex", scope: { providerId: "openai-codex" }, windows: [
      { usedPercent: 41, windowDurationSeconds: 604800, resetsAtEpochSeconds: 1794206353 },
    ] }], fetchedAtEpochSeconds: 1700000000,
  });
});

test("Codex stream events normalize the native limit identity and ignore missing or invalid windows", () => {
  const named = { ...rateLimitEvent, metered_limit_name: "  CODEX-OTHER  ", limit_name: "fallback" };
  assert.equal(codexRateLimitEvent(named, model)?.rateLimits[0]?.limitId, "codex_other");
  assert.equal(codexRateLimitEvent({ ...rateLimitEvent, limit_name: "CODEX-OTHER" }, model)?.rateLimits[0]?.limitId, "codex_other");
  assert.deepEqual(codexRateLimitEvent({ ...rateLimitEvent, rate_limits: {
    primary: null, secondary: { used_percent: 25, window_minutes: 300, reset_at: 1794206354 },
  } }, model)?.rateLimits[0]?.windows, [{ usedPercent: 25, windowDurationSeconds: 18000, resetsAtEpochSeconds: 1794206354 }]);
  for (const event of [null, {}, { type: "codex.rate_limits" }, { ...rateLimitEvent, type: "response.completed" },
    { ...rateLimitEvent, rate_limits: null }, { ...rateLimitEvent, rate_limits: { primary: null, secondary: null } },
    { ...rateLimitEvent, rate_limits: { primary: { used_percent: 101 } } },
    { ...rateLimitEvent, rate_limits: { primary: { used_percent: "41" } } },
  ]) assert.equal(codexRateLimitEvent(event, model), undefined);
});

test("Codex stream events from non-subscription providers or custom endpoints report no quota", () => {
  for (const selected of [fauxModel, { ...model, provider: "tokener" }, { ...model, baseUrl: "https://gateway.example/v1" }, { ...model, api: "openai-responses" as const }]) {
    assert.equal(codexRateLimitEvent(rateLimitEvent, selected), undefined);
  }
});

test("partial, zero, malformed, and equal-duration quota windows retain their actual meaning", () => {
  const parsed = codexRateLimits({ status: 200, headers: {
    "X-Codex-Primary-Used-Percent": "0",
    "x-codex-secondary-used-percent": "100",
    "x-codex-secondary-window-minutes": "-1",
    "x-codex-secondary-reset-at": "junk",
    "x-codex-other-primary-used-percent": "42",
    "x-codex-other-primary-window-minutes": "300",
    "x-codex-other-secondary-used-percent": "43",
    "x-codex-other-secondary-window-minutes": "300",
    "x-codex-other-limit-name": "Other models",
  } }, model)!;
  assert.deepEqual(parsed.rateLimits[0]?.windows, [
    { usedPercent: 0, windowDurationSeconds: null, resetsAtEpochSeconds: null },
    { usedPercent: 100, windowDurationSeconds: null, resetsAtEpochSeconds: null },
  ]);
  assert.equal(parsed.rateLimits[1]?.windows.length, 2);
  assert.equal(parsed.rateLimits[1]?.windows[0]?.label, "Other models");
  for (const value of ["", "NaN", "Infinity", "-1", "101", "bad", "0x32"]) {
    assert.equal(codexRateLimits({ status: 200, headers: { "x-codex-primary-used-percent": value } }, model), undefined, value);
  }
  assert.equal(codexRateLimits({ status: 200, headers: {} }, model), undefined);
});

test("headers from Tokener, API-key providers, and custom Codex endpoints report no subscription quota", () => {
  for (const selected of [fauxModel, { ...model, provider: "tokener" }, { ...model, baseUrl: "https://gateway.example/v1" }, { ...model, api: "openai-responses" as const }]) {
    assert.equal(codexRateLimits({ status: 200, headers }, selected), undefined);
  }
});

for (const source of ["headers", "stream event"]) test(`context-summary requests preserve the ${source} observer`, async () => {
  const { models, faux, model: local } = fauxModels();
  const stream = models.streamSimple.bind(models);
  const observations: RateLimitsSnapshot[] = [];
  models.streamSimple = (selected, context, options) => {
    if (source === "headers") void options?.onResponse?.({ status: 200, headers }, selected);
    else void options?.onProviderStreamEvent?.(rateLimitEvent, selected);
    return stream(local, context, options);
  };
  const messages = [
    { role: "user" as const, content: `Keep a.txt unchanged. ${"prior evidence ".repeat(1300)}`, timestamp: Date.now() },
    fauxAssistantMessage("Pending verification."),
  ];
  const log = SessionLog.create(tempDir(), tempDir());
  for (const message of messages) log.append(message.role === "user" ? "cli" : "model", message);
  faux.setResponses([fauxAssistantMessage("Keep a.txt unchanged. Verify next. [log 1-1]")]);
  const agent = createRxAgent({ models, model: { ...model, contextWindow: 16384 }, thinking: "off", cwd: log.cwd, systemPrompt: "Follow the user.", log, origin: "acp", messages,
    onResponse: (response, selected) => { const snapshot = codexRateLimits(response, selected); if (snapshot) observations.push(snapshot); },
    onProviderStreamEvent: (event, selected) => { const snapshot = codexRateLimitEvent(event, selected); if (snapshot) observations.push(snapshot); },
  });
  await contextControl(agent).compact();
  assert.equal(observations.length, 1);
  assert.equal(observations[0]?.rateLimits[0]?.windows[0]?.usedPercent, source === "headers" ? 12.5 : 41);
});

for (const source of ["headers", "stream event"]) test(`ACP ${source} quota push retains observation time and hides quotas after switching providers`, async () => {
  const { models, faux, model: local } = fauxModels();
  const stream = models.streamSimple.bind(models);
  models.streamSimple = (selected, context, options) => {
    if (source === "headers") void options?.onResponse?.({ status: 200, headers }, selected);
    else void options?.onProviderStreamEvent?.(rateLimitEvent, selected);
    return stream(local, context, options);
  };
  faux.setResponses([fauxAssistantMessage("done"), fauxAssistantMessage("again")]);
  const updates: RateLimitsSnapshot[] = [];
  const client = acp.client().onNotification(LODY_EXTENSION_METHODS.rateLimitsUpdate, (value) => value as RateLimitsSnapshot, ({ params }) => { updates.push(params); });
  const cwd = tempDir();
  await client.connectWith(createAcpApp({ models, home: tempDir(), choose: async () => ({ model, thinking: "off" }) }), async (ctx) => {
    const get = (params = {}) => ctx.request<RateLimitsSnapshot, object>(LODY_EXTENSION_METHODS.rateLimitsGet, params);
    const init = await ctx.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION });
    assert.deepEqual((init.agentCapabilities?._meta?.lody as Record<string, unknown>).rateLimits, { version: 1 });
    assert.deepEqual(await get({ sessionId: "unknown" }), { rateLimits: [] });
    const { sessionId } = await ctx.request("session/new", { cwd, mcpServers: [] });
    assert.deepEqual(await get(), { rateLimits: [] });
    await ctx.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "quota" }] });
    assert.equal(updates.length, 1);
    assert.equal(updates[0]?.rateLimits[0]?.windows[0]?.usedPercent, source === "headers" ? 12.5 : 41);
    assert.deepEqual(await get(), { rateLimits: [] });
    assert.deepEqual(await get({ sessionId: "unknown" }), { rateLimits: [] });
    assert.deepEqual(await get({ sessionId }), updates[0]);
    assert.deepEqual(await get({ sessionId, modelId: "tokener/model" }), { rateLimits: [] });
    assert.deepEqual(await get({ sessionId, accountId: "unknown" }), { rateLimits: [] });
    await ctx.request("session/set_config_option", { sessionId, configId: "model", value: `${local.provider}/${local.id}` });
    assert.deepEqual(await get({ sessionId }), { rateLimits: [] });
    await ctx.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "no quota" }] });
    assert.equal(updates.length, 1);
  });
});
