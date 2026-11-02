import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as acp from "@agentclientprotocol/sdk/unstable";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createAcpApp } from "../src/acp.ts";
import { SessionLog } from "../src/session-log.ts";
import { fauxModels, tempDir } from "./helpers.ts";

process.env.HOME = tempDir();
process.env.RX_HOME = tempDir();

function harness() {
  const { faux, models, model } = fauxModels();
  const home = tempDir();
  const cwd = tempDir();
  const updates: acp.SessionUpdate[] = [];
  const applied: unknown[] = [];
  const client = acp.client()
    .onNotification(acp.methods.client.session.update, ({ params }) => { updates.push(params.update); })
    .onNotification("_lody/session/steer_applied", (value: unknown) => value, ({ params }) => { applied.push(params); });
  const app = createAcpApp({ home, models, choose: async () => ({ model, thinking: "off" }) });
  return { faux, models, model, home, cwd, updates, applied, run: <T>(op: (ctx: acp.ClientContext) => Promise<T>) => client.connectWith(app, op) };
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "timed out waiting for ACP update");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("Lody steering enters the next model request, persists, and replays as user input", async () => {
  const { faux, home, cwd, updates, applied, run } = harness();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 0.2" }, { id: "wait" })], { stopReason: "toolUse" }),
    (context) => {
      assert.ok(context.messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes("steered answer")));
      return fauxAssistantMessage("steered answer");
    },
  ]);
  await run(async (ctx) => {
    const init = await ctx.request(acp.methods.agent.initialize, { protocolVersion: 1 });
    assert.deepEqual((init.agentCapabilities?._meta?.lody as Record<string, unknown>)?.steering, { version: 1, transport: "request", upstreamTurn: "same", configPolicy: "active" });
    const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd, mcpServers: [] });
    await assert.rejects(ctx.request("_lody/session/steer", { sessionId, steerId: "idle", prompt: [] }), { code: -32600 });
    const prompt = ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "wait then answer" }] });
    await until(() => updates.some((update) => update.sessionUpdate === "tool_call"));
    const steer = ctx.request("_lody/session/steer", { sessionId, steerId: "s1", prompt: [{ type: "text", text: "steered answer" }] });
    await assert.rejects(ctx.request("_lody/session/steer", { sessionId, steerId: "s1", prompt: [{ type: "text", text: "duplicate" }] }), { code: -32600 });
    await assert.rejects(ctx.request("_lody/session/steer", { sessionId, steerId: "bad", prompt: [{ type: "text", text: 42 }] }), { code: -32602 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(applied, []);
    assert.deepEqual(await steer, { outcome: "injected" });
    assert.deepEqual(applied, [{ sessionId, steerId: "s1" }]);
    assert.equal((await prompt).stopReason, "end_turn");
    const saved = SessionLog.open(home, sessionId);
    assert.ok(saved.entries.some((entry) => entry.origin === "acp" && entry.message.role === "user" && JSON.stringify(entry.message.content).includes("steered answer")));
    updates.length = 0;
    await ctx.request(acp.methods.agent.session.load, { sessionId, cwd, mcpServers: [] });
    assert.ok(updates.some((update) => update.sessionUpdate === "user_message_chunk" && update.content.type === "text" && update.content.text === "steered answer"));
  });
});

test("startup model selection owns thinking and malformed unrelated fields do not discard it", async () => {
  const faux = fauxProvider({ models: [
    { id: "plain", name: "Plain", reasoning: false, contextWindow: 8192 },
    { id: "reasoner", name: "Reasoner", reasoning: true, contextWindow: 10000 },
  ] });
  const models = createModels();
  models.setProvider(faux.provider);
  const home = tempDir();
  const cwd = tempDir();
  const app = createAcpApp({ home, models, choose: async () => ({ model: faux.getModel("plain")!, thinking: "off" }) });
  await acp.client().connectWith(app, async (ctx) => {
    const modelId = `${faux.provider.id}/reasoner`;
    const meta = { lody: { sessionConfig: { version: 1, modelId, configOptionValues: { model: `${faux.provider.id}/plain`, thinking: "high", unrelated: 42 } } } };
    const created = await ctx.request(acp.methods.agent.session.new, { cwd, mcpServers: [], _meta: meta });
    assert.equal(created.configOptions?.find((option) => option.id === "model")?.currentValue, modelId);
    assert.equal(created.configOptions?.find((option) => option.id === "thinking")?.currentValue, "high");
    faux.setResponses([(context, options, _state, model) => {
      assert.equal(model.id, "reasoner");
      assert.equal(options?.reasoning, "high");
      assert.ok(context.messages.some((message) => message.role === "user"));
      return fauxAssistantMessage("selected");
    }]);
    assert.equal((await ctx.request(acp.methods.agent.session.prompt, { sessionId: created.sessionId, prompt: [{ type: "text", text: "go" }] })).stopReason, "end_turn");
    const loaded = await ctx.request(acp.methods.agent.session.load, { sessionId: created.sessionId, cwd, mcpServers: [], _meta: meta });
    assert.equal(loaded.configOptions?.find((option) => option.id === "thinking")?.currentValue, "high");
    const malformed = await ctx.request(acp.methods.agent.session.new, { cwd, mcpServers: [], _meta: { lody: { sessionConfig: { version: 1, modelId: 42, configOptionValues: { model: modelId, thinking: "high" } } } } });
    assert.equal(malformed.configOptions?.find((option) => option.id === "thinking")?.currentValue, "high");
    const partial = await ctx.request(acp.methods.agent.session.new, { cwd, mcpServers: [], _meta: { lody: { sessionConfig: { version: 1, modelId, configOptionValues: "unrelated malformed field" } } } });
    assert.equal(partial.configOptions?.find((option) => option.id === "model")?.currentValue, modelId);
  });
});

test("cancel rejects pending steering and prevents delivery into the next prompt", async () => {
  const { faux, home, cwd, updates, applied, run } = harness();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 30" }, { id: "wait" })], { stopReason: "toolUse" }),
    (context) => {
      assert.ok(!JSON.stringify(context.messages).includes("cancelled steer"));
      return fauxAssistantMessage("fresh answer");
    },
  ]);
  await run(async (ctx) => {
    const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd, mcpServers: [] });
    const prompt = ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "wait" }] });
    await until(() => updates.some((update) => update.sessionUpdate === "tool_call"));
    const steer = assert.rejects(ctx.request("_lody/session/steer", { sessionId, steerId: "cancel", prompt: [{ type: "text", text: "cancelled steer" }] }), { code: -32600 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await ctx.notify(acp.methods.agent.session.cancel, { sessionId });
    assert.equal((await prompt).stopReason, "cancelled");
    await steer;
    assert.deepEqual(applied, []);
    assert.ok(!readFileSync(SessionLog.open(home, sessionId).log.path, "utf8").includes("cancelled steer"));
    assert.equal((await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "fresh" }] })).stopReason, "end_turn");
  });
});

test("startup configuration precedes the snapshot and logical project metadata survives load", async () => {
  const { model, home, cwd, run } = harness();
  const origin = tempDir();
  const meta = { lody: { sessionConfig: { version: 1, modelId: `${model.provider}/${model.id}`, configOptionValues: { thinking: "off", unrelated: true } }, worktreeProject: { version: 1, originProjectPath: origin } } };
  await run(async (ctx) => {
    const created = await ctx.request(acp.methods.agent.session.new, { cwd, mcpServers: [], _meta: meta });
    assert.equal(created.configOptions?.find((option) => option.id === "thinking")?.currentValue, "off");
    const listed = await ctx.request(acp.methods.agent.session.list, { cwd: origin });
    assert.equal(listed.sessions[0]?.cwd, cwd);
    assert.deepEqual(listed.sessions[0]?._meta, { lody: { worktreeProject: meta.lody.worktreeProject } });
    assert.equal(readFileSync(SessionLog.open(home, created.sessionId).log.path, "utf8").includes(origin), true);
    await ctx.request(acp.methods.agent.session.load, { sessionId: created.sessionId, cwd, mcpServers: [], _meta: meta });
    assert.equal((await ctx.request(acp.methods.agent.session.list, { cwd: origin })).sessions.length, 1);
    await assert.rejects(ctx.request(acp.methods.agent.session.new, { cwd, mcpServers: [], _meta: { lody: { sessionConfig: { version: 1, configOptionValues: { thinking: "invalid" } } } } }), { code: -32602 });
  });
});
