import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import * as acp from "@agentclientprotocol/sdk";
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxProvider, fauxToolCall, type AssistantMessage, type Api, type Model, type MutableModels } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { applyHandoff } from "../src/rx-provider.ts";
import { createAcpApp } from "../src/acp.ts";
import { SESSION_USAGE_METHOD, type SessionUsageUpdate } from "../src/acp-session-usage.ts";
import { SessionLog } from "../src/session-log.ts";
import { fauxModels, tempDir } from "./helpers.ts";

process.env.HOME = tempDir();
process.env.RX_HOME = tempDir();

function response(text = "done"): AssistantMessage {
  const message = fauxAssistantMessage(text);
  return { ...message, usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 40, totalTokens: 190, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 } } };
}

function harness(responses: AssistantMessage[], window?: number, selected?: { models: MutableModels; model: Model<Api> }) {
  const { models, model } = selected ?? fauxModels();
  const other = fauxProvider({ provider: "second", models: [{ id: "two" }] });
  models.setProvider(other.provider);
  const home = tempDir();
  const cwd = tempDir();
  const requests: AssistantMessage[] = [];
  models.streamSimple = (selected) => {
    const next = responses.shift();
    assert.ok(next, "unexpected model request");
    const message = { ...next, api: selected.api, provider: selected.provider, model: selected.id };
    requests.push(message);
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "start", partial: { ...message, content: [] } });
      if (message.stopReason === "error") stream.push({ type: "error", reason: "error", error: message });
      else stream.push({ type: "done", reason: "stop", message });
      stream.end(message);
    });
    return stream;
  };
  const updates: acp.SessionUpdate[] = [];
  const usage: SessionUsageUpdate[] = [];
  const client = acp.client()
    .onNotification(acp.methods.client.session.update, ({ params }) => { updates.push(params.update); })
    .onNotification(SESSION_USAGE_METHOD, (params) => params as SessionUsageUpdate, ({ params }) => { usage.push(params); });
  const app = createAcpApp({ home, models, choose: async () => ({ model: window ? { ...model, contextWindow: window } : model, thinking: "off" }) });
  const prompt = (ctx: acp.ClientContext, sessionId: string, text = "continue") => ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text }] });
  return { home, cwd, model, requests, updates, usage, prompt, run: <T>(fn: (ctx: acp.ClientContext) => Promise<T>) => client.connectWith(app, fn) };
}

test("ACP advertises and sends per-request accounting across tools, prompts, and model switches", async () => {
  const tool = response();
  tool.content = [fauxToolCall("read", { path: "notes.txt" }, { id: "read-notes" })];
  tool.stopReason = "toolUse";
  const h = harness([tool, response(), response()]);
  writeFileSync(join(h.cwd, "notes.txt"), "data");
  await h.run(async (ctx) => {
    const init = await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION });
    assert.deepEqual((init.agentCapabilities?._meta?.lody as { usage: unknown }).usage, { version: 1 });
    const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd: h.cwd, mcpServers: [] });
    assert.equal((await h.prompt(ctx, sessionId)).stopReason, "end_turn");
    assert.equal(h.usage.length, 2);
    await ctx.request(acp.methods.agent.session.setConfigOption, { sessionId, configId: "model", value: "second/two" });
    await h.prompt(ctx, sessionId);
    assert.equal(h.usage.length, 3);
    const last = h.usage.at(-1)!;
    assert.equal(last.modelUsage[`${h.model.provider}/${h.model.id}`]!.inputTokens, 200);
    assert.equal(last.modelUsage["second/two"]!.inputTokens, 100);
    assert.equal(new Set(h.usage.map((update) => update._meta.lody.usageScopeId)).size, 1);
    const standard = h.updates.filter((update) => update.sessionUpdate === "usage_update");
    assert.equal(standard.length, 3);
    assert.equal(standard.at(-1)!.used, 190);
    assert.equal("cost" in standard.at(-1)!, false);
    const reconstructed: Record<string, number> = {};
    for (const update of h.usage) {
      assert.equal(update.sessionId, sessionId);
      for (const [model, usage] of Object.entries(update.delta.modelUsage)) reconstructed[model] = (reconstructed[model] ?? 0) + usage.inputTokens;
      assert.deepEqual(reconstructed, Object.fromEntries(Object.entries(update.modelUsage).map(([model, usage]) => [model, usage.inputTokens])));
    }
  });
});

test("ACP load emits no accounting for replay and starts a distinct scope for new requests", async () => {
  const h = harness([response(), response(), response()]);
  await h.run(async (ctx) => {
    const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd: h.cwd, mcpServers: [] });
    await h.prompt(ctx, sessionId);
    const before = h.usage[0]!;
    await ctx.request(acp.methods.agent.session.load, { sessionId, cwd: h.cwd, mcpServers: [] });
    assert.equal(h.usage.length, 1);
    await h.prompt(ctx, sessionId);
    assert.equal(h.usage[1]!.usage.inputTokens, 100);
    assert.equal(h.usage[1]!.modelUsage[`${h.model.provider}/${h.model.id}`]!.inputTokens, 100);
    assert.notEqual(h.usage[1]!._meta.lody.usageScopeId, before._meta.lody.usageScopeId);
    const next = await ctx.request(acp.methods.agent.session.new, { cwd: h.cwd, mcpServers: [] });
    await h.prompt(ctx, next.sessionId);
    assert.notEqual(h.usage[2]!._meta.lody.usageScopeId, h.usage[1]!._meta.lody.usageScopeId);
  });
});

test("ACP counts both the failed attempt and retry success before returning the prompt result", async () => {
  const failed = { ...response(), stopReason: "error" as const, errorMessage: "500 internal server error" };
  const h = harness([failed, response()]);
  await h.run(async (ctx) => {
    const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd: h.cwd, mcpServers: [] });
    assert.equal((await h.prompt(ctx, sessionId)).stopReason, "end_turn");
    assert.equal(h.usage.length, 2);
    assert.equal(h.usage[1]!.modelUsage[`${h.model.provider}/${h.model.id}`]!.inputTokens, 200);
    assert.equal(h.usage[1]!.modelUsage[`${h.model.provider}/${h.model.id}`]!.costUSD, 0.6);
  });
});

test("ACP counts summary requests without resetting cumulative usage or changing standard context measurements", async () => {
  const h = harness([response("Completed earlier work. ".repeat(1000)), response("Preserve the requested work. [log 1-1]"), response()], 16384);
  await h.run(async (ctx) => {
    const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd: h.cwd, mcpServers: [] });
    await h.prompt(ctx, sessionId);
    const scope = h.usage[0]!._meta.lody.usageScopeId;
    assert.equal((await h.prompt(ctx, sessionId, "/compact")).stopReason, "end_turn");
    assert.equal(h.usage.length, 2);
    assert.equal(h.updates.filter((update) => update.sessionUpdate === "usage_update").length, 1);
    await h.prompt(ctx, sessionId);
    assert.equal(h.usage.length, 3);
    assert.equal(h.usage[2]!.modelUsage[`${h.model.provider}/${h.model.id}`]!.inputTokens, 300);
    assert.equal(h.usage[2]!._meta.lody.usageScopeId, scope);
    const log = SessionLog.open(h.home, sessionId);
    assert.equal(log.entries.filter((entry) => entry.purpose === "compaction").length, 1);
  });
});

test("ACP omits placeholder handoff costs while preserving priced and free catalog models", async () => {
  const models = builtinModels();
  const priced = models.getModel("deepseek", "deepseek-flash")!;
  const free = models.getProviders().flatMap((provider) => models.getModels(provider.id)).find((model) => Object.values(model.cost).every((price) => price === 0))!;
  assert.ok(free);
  applyHandoff(models, { id: "handoff", name: "Handoff", api: "openai-completions", baseUrl: "https://example.test/v1", env: "HANDOFF_TEST_KEY", defaultModel: "one", models: [{ id: "one", contextWindow: 200000, reasoning: false }] });
  const placeholder = models.getModel("handoff", "one")!;
  for (const [model, cost] of [[placeholder, undefined], [priced, 0.3], [free, 0]] as const) {
    const reply = response();
    if (cost === 0 || cost === undefined) reply.usage.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    const h = harness([reply, reply], undefined, { models, model });
    await h.run(async (ctx) => {
      const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd: h.cwd, mcpServers: [] });
      await h.prompt(ctx, sessionId);
      await h.prompt(ctx, sessionId);
      const [first, second] = h.usage;
      const key = `${model.provider}/${model.id}`;
      assert.equal(first!.usage.costUSD, cost);
      assert.equal(second!.modelUsage[key]!.costUSD, cost === undefined ? undefined : cost * 2);
      for (const update of h.usage) {
        for (const usage of [update.usage, update.modelUsage[key]!, update.delta.usage, update.delta.modelUsage[key]!]) {
          assert.equal(Object.hasOwn(usage, "costUSD"), cost !== undefined);
        }
      }
    });
  }
});
