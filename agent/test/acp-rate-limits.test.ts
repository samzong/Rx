import assert from "node:assert/strict";
import { test } from "node:test";
import * as acp from "@agentclientprotocol/sdk/unstable";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { LODY_EXTENSION_METHODS, type RateLimitsSnapshot } from "acp-extension-core";
import { createAcpApp } from "../src/acp.ts";
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

test("ACP quotas preserve secondary windows and identities without inventing malformed values", async () => {
  const partial = [
    { usedPercent: 0, windowDurationSeconds: null, resetsAtEpochSeconds: null },
    { usedPercent: 100, windowDurationSeconds: null, resetsAtEpochSeconds: null },
  ];
  const validSecondary = [{ usedPercent: 25, windowDurationSeconds: 18000, resetsAtEpochSeconds: 1800000100 }];
  const observations = [
    { headers: {
      "x-codex-other-primary-used-percent": "0",
      "x-codex-other-secondary-used-percent": "100",
      "x-codex-other-secondary-window-minutes": "-1",
      "x-codex-other-secondary-reset-at": "junk",
    }, windows: partial },
    { event: { type: "codex.rate_limits", metered_limit_name: " CODEX-OTHER ", limit_name: "fallback", rate_limits: {
      primary: { used_percent: 0 }, secondary: { used_percent: 100, window_minutes: -1, reset_at: "junk" },
    } }, windows: partial },
    { headers: {
      "x-codex-other-primary-used-percent": "bad",
      "x-codex-other-secondary-used-percent": "25",
      "x-codex-other-secondary-window-minutes": "300",
      "x-codex-other-secondary-reset-at": "1800000100",
    }, windows: validSecondary },
    { event: { type: "codex.rate_limits", limit_name: "CODEX-OTHER", rate_limits: {
      primary: { used_percent: 101 }, secondary: { used_percent: 25, window_minutes: 300, reset_at: 1800000100 },
    } }, windows: validSecondary },
  ];
  const { models, faux, model: local } = fauxModels();
  const stream = models.streamSimple.bind(models);
  let current = 0;
  models.streamSimple = (selected, context, options) => {
    const observation = observations[current]!;
    if (observation.headers) void options?.onResponse?.({ status: 200, headers: observation.headers }, selected);
    else void options?.onProviderStreamEvent?.(observation.event, selected);
    return stream(local, context, options);
  };
  faux.setResponses(observations.map(() => fauxAssistantMessage("done")));
  const updates: RateLimitsSnapshot[] = [];
  const client = acp.client().onNotification(LODY_EXTENSION_METHODS.rateLimitsUpdate, (value) => value as RateLimitsSnapshot, ({ params }) => { updates.push(params); });
  await client.connectWith(createAcpApp({ models, home: tempDir(), choose: async () => ({ model, thinking: "off" }) }), async (ctx) => {
    const { sessionId } = await ctx.request("session/new", { cwd: tempDir(), mcpServers: [] });
    for (; current < observations.length; current++) {
      await ctx.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "quota" }] });
      assert.equal(updates.length, current + 1);
      const limit = updates.at(-1)?.rateLimits[0];
      assert.equal(limit?.limitId, "codex_other");
      assert.deepEqual(limit?.windows, observations[current]!.windows);
    }
  });
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
    const window = updates[0]?.rateLimits[0]?.windows[0];
    assert.equal(window?.usedPercent, source === "headers" ? 12.5 : 41);
    assert.equal(window?.windowDurationSeconds, source === "headers" ? 18000 : 604800);
    assert.equal(window?.resetsAtEpochSeconds, source === "headers" ? 1800000000 : 1794206353);
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

test("non-subscription providers and custom endpoints never expose quotas", async () => {
  for (const selected of [fauxModel, { ...model, provider: "tokener" }, { ...model, baseUrl: "https://gateway.example/v1" }, { ...model, api: "openai-responses" as const }]) {
    for (const source of ["headers", "stream event"]) {
      const { models, faux, model: local } = fauxModels();
      const stream = models.streamSimple.bind(models);
      models.streamSimple = (current, context, options) => {
        if (source === "headers") void options?.onResponse?.({ status: 200, headers }, current);
        else void options?.onProviderStreamEvent?.(rateLimitEvent, current);
        return stream(local, context, options);
      };
      faux.setResponses([fauxAssistantMessage("done")]);
      const updates: RateLimitsSnapshot[] = [];
      const client = acp.client().onNotification(LODY_EXTENSION_METHODS.rateLimitsUpdate, (value) => value as RateLimitsSnapshot, ({ params }) => { updates.push(params); });
      const app = createAcpApp({ models, home: tempDir(), choose: async () => ({ model: selected, thinking: "off" }) });
      await client.connectWith(app, async (ctx) => {
        const { sessionId } = await ctx.request("session/new", { cwd: tempDir(), mcpServers: [] });
        assert.equal((await ctx.request<{ stopReason: string }, object>("session/prompt", { sessionId, prompt: [{ type: "text", text: "quota" }] })).stopReason, "end_turn");
        assert.deepEqual(updates, []);
        assert.deepEqual(await ctx.request(LODY_EXTENSION_METHODS.rateLimitsGet, { sessionId }), { rateLimits: [] });
      });
    }
  }
});
