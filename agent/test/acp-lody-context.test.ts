import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as acp from "@agentclientprotocol/sdk/unstable";
import { createAssistantMessageEventStream, createModels, fauxProvider, fauxAssistantMessage, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import { createAcpApp } from "../src/acp.ts";
import { SessionLog } from "../src/session-log.ts";
import { tempDir } from "./helpers.ts";

process.env.HOME = tempDir();
process.env.RX_HOME = tempDir();

test("steering delivered through automatic compaction is acknowledged and replayed", async () => {
  const faux = fauxProvider({ models: [{ id: "large", contextWindow: 65536, maxTokens: 8192 }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel("large")!;
  const home = tempDir();
  const cwd = tempDir();
  const applied: unknown[] = [];
  const seen: boolean[] = [];
  let toolStarted!: () => void;
  const tool = new Promise<void>((resolve) => { toolStarted = resolve; });
  const replay: string[] = [];
  const marker = "STEER_THROUGH_COMPACTION";
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 0.2" }, { id: "wait" })], { stopReason: "toolUse" }),
    ...Array.from({ length: 10 }, () => (context: Context, _options: unknown, _state: unknown, called: typeof model) => {
      seen.push(context.messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes(marker)));
      return fauxAssistantMessage(called.maxTokens <= 4096 ? "Historical instructions retained. [log 1-1]" : marker);
    }),
  ]);
  const client = acp.client()
    .onNotification(acp.methods.client.session.update, ({ params }) => {
      if (params.update.sessionUpdate === "tool_call") toolStarted();
      if (params.update.sessionUpdate === "user_message_chunk" && params.update.content.type === "text") replay.push(params.update.content.text);
    })
    .onNotification("_lody/session/steer_applied", (value: unknown) => value, ({ params }) => { applied.push(params); });
  await client.connectWith(createAcpApp({ home, models, choose: async () => ({ model, thinking: "off" }) }), async (ctx) => {
    await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION });
    const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd, mcpServers: [] });
    const prompt = ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "historical evidence ".repeat(13000) }] });
    await tool;
    const steer = ctx.request("_lody/session/steer", { sessionId, steerId: "compacting", prompt: [{ type: "text", text: marker }] }).then((result) => result, (error: unknown) => error);
    assert.equal((await prompt).stopReason, "end_turn");
    assert.ok(seen.includes(false) && seen.at(-1) === true, JSON.stringify(seen));
    assert.ok(readFileSync(SessionLog.open(home, sessionId).log.path, "utf8").includes('"type":"compaction"'));
    assert.deepEqual(await steer, { outcome: "injected" });
    assert.deepEqual(applied, [{ sessionId, steerId: "compacting" }]);
    replay.length = 0;
    await ctx.request(acp.methods.agent.session.load, { sessionId, cwd, mcpServers: [] });
    assert.ok(replay.includes(marker));
  });
});

test("saved fast false is harmless on unsupported models while fast true still fails", async () => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const home = tempDir();
  const cwd = tempDir();
  await acp.client().connectWith(createAcpApp({ home, models, choose: async () => ({ model: faux.getModel()!, thinking: "off" }) }), async (ctx) => {
    await ctx.request(acp.methods.agent.initialize, { protocolVersion: 1, clientCapabilities: { session: { configOptions: { boolean: {} } } } });
    const meta = (fast: boolean) => ({ lody: { sessionConfig: { version: 1, configOptionValues: { fast } } } });
    const created = await ctx.request(acp.methods.agent.session.new, { cwd, mcpServers: [], _meta: meta(false) });
    assert.ok(!created.configOptions?.some((option) => option.id === "fast"));
    const loaded = await ctx.request(acp.methods.agent.session.load, { sessionId: created.sessionId, cwd, mcpServers: [], _meta: meta(false) });
    assert.ok(!loaded.configOptions?.some((option) => option.id === "fast"));
    await assert.rejects(ctx.request(acp.methods.agent.session.new, { cwd, mcpServers: [], _meta: meta(true) }), { code: -32602 });
    await assert.rejects(ctx.request(acp.methods.agent.session.load, { sessionId: created.sessionId, cwd, mcpServers: [], _meta: meta(true) }), { code: -32602 });
  });
});

test("pruning preserves steering confirmation and replay without a summary", async () => {
  const faux = fauxProvider({ models: [{ id: "large", contextWindow: 65536, maxTokens: 8192 }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel("large")!;
  const home = tempDir();
  const cwd = tempDir();
  const log = SessionLog.create(home, cwd);
  log.append("acp", { role: "user", content: "Inspect old and recent files", timestamp: 1 });
  for (const id of ["old", "recent"]) {
    log.append("model", fauxAssistantMessage([fauxToolCall("read", { path: id }, { id })], { stopReason: "toolUse" }));
    log.append("tool", { role: "toolResult", toolName: "read", toolCallId: id, content: [{ type: "text", text: id === "old" ? "old evidence ".repeat(9000) : "recent evidence" }], timestamp: 2, isError: false });
  }
  log.append("model", fauxAssistantMessage("Ready"));
  const waiting = fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 0.2" }, { id: "wait" })], { stopReason: "toolUse" });
  waiting.usage.input = 60000;
  waiting.usage.output = waiting.usage.cacheRead = waiting.usage.cacheWrite = 0;
  const marker = "STEER_THROUGH_PRUNING";
  let requests = 0;
  models.streamSimple = (selected, context) => {
    if (requests > 0) {
      assert.equal(selected.maxTokens, 8192);
      assert.ok(JSON.stringify(context.messages).includes(marker));
      assert.ok(JSON.stringify(context.messages).includes("[cleared, log seq"));
    }
    const response = { ...(requests++ === 0 ? waiting : fauxAssistantMessage(marker)), api: selected.api, provider: selected.provider, model: selected.id };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "done", reason: response.stopReason === "toolUse" ? "toolUse" : "stop", message: response });
      stream.end(response);
    });
    return stream;
  };
  let toolStarted!: () => void;
  const tool = new Promise<void>((resolve) => { toolStarted = resolve; });
  const applied: unknown[] = [];
  const replay: string[] = [];
  const client = acp.client()
    .onNotification(acp.methods.client.session.update, ({ params }) => {
      if (params.update.sessionUpdate === "tool_call") toolStarted();
      if (params.update.sessionUpdate === "user_message_chunk" && params.update.content.type === "text") replay.push(params.update.content.text);
    })
    .onNotification("_lody/session/steer_applied", (value: unknown) => value, ({ params }) => { applied.push(params); });
  await client.connectWith(createAcpApp({ home, models, choose: async () => ({ model, thinking: "off" }) }), async (ctx) => {
    await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION });
    await ctx.request(acp.methods.agent.session.load, { sessionId: log.id, cwd, mcpServers: [] });
    const prompt = ctx.request(acp.methods.agent.session.prompt, { sessionId: log.id, prompt: [{ type: "text", text: "wait then answer" }] });
    await tool;
    const steer = ctx.request("_lody/session/steer", { sessionId: log.id, steerId: "pruning", prompt: [{ type: "text", text: marker }] });
    assert.deepEqual(await steer, { outcome: "injected" });
    assert.equal((await prompt).stopReason, "end_turn");
    assert.deepEqual(applied, [{ sessionId: log.id, steerId: "pruning" }]);
    const records = readFileSync(log.path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(records.some((entry) => entry.type === "context_prune"));
    assert.ok(!records.some((entry) => entry.type === "compaction"));
    replay.length = 0;
    await ctx.request(acp.methods.agent.session.load, { sessionId: log.id, cwd, mcpServers: [] });
    assert.ok(replay.includes(marker));
  });
});
