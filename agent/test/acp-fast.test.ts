import assert from "node:assert/strict";
import * as acp from "@agentclientprotocol/sdk";
import { test } from "node:test";
import { zstdDecompressSync } from "node:zlib";
import { InMemoryCredentialStore, normalizeContext } from "@earendil-works/pi-ai";
import { builtinModels, getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { fastStreamOptions, supportsFast } from "../src/acp-fast.ts";
import { createAcpApp } from "../src/acp.ts";
import { tempDir } from "./helpers.ts";

process.env.HOME = tempDir();
process.env.RX_HOME = tempDir();

const model = getBuiltinModel("openai-codex", "gpt-6.1-sol");
const apiKey = `local.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "local-test" } })).toString("base64url")}.local`;

test("Fast reaches the Codex wire payload through streamSimple and preserves the payload callback", async () => {
  for (const fast of [false, true]) {
    let body: Record<string, unknown> | undefined;
    let networkCalls = 0;
    const response = await streamSimple(model, normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: Date.now() }] }), fastStreamOptions(model, {
      apiKey,
      transport: "sse",
      maxRetries: 0,
      onPayload: (payload) => ({ ...payload as object, probe: "preserved" }),
      fetch: async (input, init) => {
        networkCalls++;
        const raw = input instanceof Request ? await input.text() : typeof init?.body === "string" ? init.body : zstdDecompressSync(init?.body as Uint8Array).toString();
        body = JSON.parse(raw);
        throw new Error("stopped before network");
      },
    }, fast)).result();
    assert.equal(response.stopReason, "error");
    assert.ok(networkCalls > 0);
    assert.equal(body?.probe, "preserved");
    assert.equal(body?.service_tier, fast ? "priority" : undefined);
  }
});

test("Fast is limited to the supported Codex provider, API, endpoint, and exact models", () => {
  assert.equal(supportsFast(model), true);
  for (const other of [
    { ...model, provider: "xai" },
    { ...model, provider: "openai" },
    { ...model, api: "openai-responses" as const },
    { ...model, baseUrl: "https://gateway.example/v1" },
    { ...model, id: "gpt-6.1-sol-custom" },
    { ...model, id: "gpt-5.5" },
  ]) {
    assert.equal(supportsFast(other), false);
    const options = { maxTokens: 1 };
    assert.equal(fastStreamOptions(other, options, true), options);
  }
});

test("ACP Fast negotiation controls the next request and resets on model changes", async () => {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("openai-codex", async () => ({ type: "oauth", access: apiKey, refresh: "local", expires: Date.now() + 3600000 }));
  const models = builtinModels({ credentials });
  const bodies: Record<string, unknown>[] = [];
  const stream = models.streamSimple.bind(models);
  models.streamSimple = (selected, context, options) => stream(selected, context, {
    ...options,
    transport: "sse",
    maxRetries: 0,
    fetch: async (_input, init) => {
      const raw = typeof init?.body === "string" ? init.body : zstdDecompressSync(init?.body as Uint8Array).toString();
      bodies.push(JSON.parse(raw));
      return new Response(`data: ${JSON.stringify({ type: "response.completed", response: { id: "local", status: "completed", output: [], usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
    },
  });
  const home = tempDir();
  const cwd = tempDir();
  const updates: acp.SessionUpdate[] = [];
  const app = createAcpApp({ home, models, choose: async () => ({ model, thinking: "high" }) });
  const client = acp.client().onNotification(acp.methods.client.session.update, ({ params }) => { updates.push(params.update); });
  await client.connectWith(app, async (ctx) => {
    await ctx.request(acp.methods.agent.initialize, { protocolVersion: 1 });
    const withoutBoolean = await ctx.request(acp.methods.agent.session.new, { cwd, mcpServers: [] });
    assert.equal(withoutBoolean.configOptions?.some((option) => option.id === "fast"), false);
    await assert.rejects(ctx.request(acp.methods.agent.session.setConfigOption, { sessionId: withoutBoolean.sessionId, configId: "fast", type: "boolean", value: true }));
    await ctx.request(acp.methods.agent.initialize, { protocolVersion: 1, clientCapabilities: { session: { configOptions: { boolean: {} } } } });
    const created = await ctx.request(acp.methods.agent.session.new, { cwd, mcpServers: [] });
    const { sessionId } = created;
    assert.equal(created.configOptions?.find((option) => option.id === "fast")?.currentValue, false);
    for (const value of [true, false, true]) {
      const changed = await ctx.request(acp.methods.agent.session.setConfigOption, { sessionId, configId: "fast", type: "boolean", value });
      assert.equal(changed.configOptions.find((option) => option.id === "fast")?.currentValue, value);
      await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "hello" }] });
      assert.equal(bodies.at(-1)?.service_tier, value ? "priority" : undefined);
    }
    const reset = await ctx.request(acp.methods.agent.session.setConfigOption, { sessionId, configId: "model", value: "openai-codex/gpt-6-sol" });
    assert.equal(reset.configOptions.find((option) => option.id === "fast")?.currentValue, false);
    await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "hello" }] });
    assert.equal(bodies.at(-1)?.service_tier, undefined);
    assert.ok(updates.some((update) => update.sessionUpdate === "usage_update" && update.used === 120 && update.size === model.contextWindow));
  });
});
