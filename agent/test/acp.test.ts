import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { test } from "node:test";
import * as acp from "@agentclientprotocol/sdk";
import { createModels, fauxProvider, fauxAssistantMessage, fauxThinking, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createAcpApp, historyUpdates, promptInput, type AcpOptions } from "../src/acp.ts";
import { SessionLog } from "../src/session-log.ts";
import { fauxModels, foreignSession, tempDir } from "./helpers.ts";

process.env.HOME = tempDir();
process.env.RX_HOME = tempDir();

function harness(choose?: AcpOptions["choose"]) {
  const { faux, models, model } = fauxModels();
  const home = tempDir();
  const cwd = tempDir();
  const updates: acp.SessionNotification[] = [];
  const app = createAcpApp({ home, models, choose: choose ?? (async () => ({ model, thinking: "off" })) });
  const client = acp.client().onNotification(acp.methods.client.session.update, ({ params }) => {
    updates.push(params);
  });
  const run = <T>(op: (ctx: acp.ClientContext) => Promise<T>) => client.connectWith(app, op);
  const kinds = (sessionId: string) => updates.filter((u) => u.sessionId === sessionId).map((u) => u.update.sessionUpdate);
  return { faux, home, cwd, updates, run, kinds };
}

const newSession = (ctx: acp.ClientContext, cwd: string) => ctx.request(acp.methods.agent.session.new, { cwd, mcpServers: [] });

test("initialize advertises load, list, and prompt capabilities", async () => {
  const { run } = harness();
  const result = await run((ctx) => ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION }));
  assert.equal(result.agentCapabilities?.loadSession, true);
  assert.deepEqual(result.agentCapabilities?.promptCapabilities, { image: true, audio: false, embeddedContext: true });
  assert.deepEqual(result.agentCapabilities?.sessionCapabilities, { list: {} });
  assert.equal(result.agentInfo?.name, "rx");
});

test("a prompt streams thought, text, and tool updates, then replays them on load", async () => {
  const { faux, home, cwd, run, kinds } = harness();
  writeFileSync(join(cwd, "a.txt"), "content\n");
  faux.setResponses([
    fauxAssistantMessage([fauxThinking("plan"), fauxText("reading"), fauxToolCall("read", { path: "a.txt" }, { id: "r1" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("finished"),
  ]);
  const { sessionId, response } = await run(async (ctx) => {
    const { sessionId } = await newSession(ctx, cwd);
    const response = await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "look" }] });
    return { sessionId, response };
  });
  assert.equal(response.stopReason, "end_turn");
  const live = kinds(sessionId);
  assert.ok(live.includes("agent_thought_chunk"));
  assert.ok(live.includes("agent_message_chunk"));
  assert.deepEqual(live.filter((k) => k.startsWith("tool_call")), ["tool_call", "tool_call_update"]);

  const loaded = harness();
  const replayed: acp.SessionUpdate[] = [];
  const client = acp.client().onNotification(acp.methods.client.session.update, ({ params }) => {
    replayed.push(params.update);
  });
  const app = createAcpApp({ home, models: fauxModels().models, choose: async () => ({ model: fauxModels().model, thinking: "off" }) });
  await client.connectWith(app, (ctx) => ctx.request(acp.methods.agent.session.load, { sessionId, cwd, mcpServers: [] }));
  assert.deepEqual(
    replayed.map((u) => u.sessionUpdate),
    ["user_message_chunk", "agent_thought_chunk", "agent_message_chunk", "tool_call", "tool_call_update", "agent_message_chunk", "available_commands_update"],
  );
  const call = replayed[3]!;
  assert.ok(call.sessionUpdate === "tool_call");
  assert.equal(call.kind, "read");
  assert.equal(call.title, "read: a.txt");
  assert.deepEqual(call.locations, [{ path: join(cwd, "a.txt") }]);
  assert.equal(loaded.updates.length, 0);
});

test("session/list returns sessions for the requested cwd", async () => {
  const { faux, cwd, run } = harness();
  faux.setResponses([fauxAssistantMessage("ok")]);
  const listed = await run(async (ctx) => {
    const { sessionId } = await newSession(ctx, cwd);
    await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "title me" }] });
    await newSession(ctx, tempDir());
    return { sessionId, list: await ctx.request(acp.methods.agent.session.list, { cwd }) };
  });
  assert.deepEqual(
    listed.list.sessions.map((s) => [s.sessionId, s.title]),
    [[listed.sessionId, "title me"]],
  );
});

test("cancel stops a running tool and the prompt ends as cancelled", async () => {
  const { faux, home, cwd, run, updates } = harness();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 30" }, { id: "b1" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("should not run"),
  ]);
  const started = Date.now();
  const { sessionId, response } = await run(async (ctx) => {
    const { sessionId } = await newSession(ctx, cwd);
    const pending = ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "wait" }] });
    while (!updates.some((u) => u.update.sessionUpdate === "tool_call")) await new Promise((r) => setTimeout(r, 10));
    await ctx.notify(acp.methods.agent.session.cancel, { sessionId });
    return { sessionId, response: await pending };
  });
  assert.equal(response.stopReason, "cancelled");
  assert.ok(Date.now() - started < 10_000);
  const logged = SessionLog.open(home, sessionId).messages;
  const result = logged.find((m) => m.role === "toolResult");
  assert.ok(result?.role === "toolResult" && result.isError);
  assert.match(JSON.stringify(result.content), /aborted/);
  const last = logged.at(-1);
  assert.ok(last?.role === "assistant" && last.stopReason === "aborted");
});

test("prompts are rejected for unknown sessions and while a session is running", async () => {
  const { faux, cwd, run, updates } = harness();
  faux.setResponses([fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 30" }, { id: "b1" })], { stopReason: "toolUse" })]);
  await run(async (ctx) => {
    await assert.rejects(ctx.request(acp.methods.agent.session.prompt, { sessionId: "missing", prompt: [] }));
    const { sessionId } = await newSession(ctx, cwd);
    const first = ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "a" }] });
    while (!updates.some((u) => u.update.sessionUpdate === "tool_call")) await new Promise((r) => setTimeout(r, 10));
    await assert.rejects(ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "b" }] }), /already running/);
    await assert.rejects(ctx.request(acp.methods.agent.session.load, { sessionId, cwd, mcpServers: [] }), /running/);
    await assert.rejects(ctx.request(acp.methods.agent.session.setConfigOption, { sessionId, configId: "thinking", value: "off" }), /running/);
    await ctx.notify(acp.methods.agent.session.cancel, { sessionId });
    await first;
  });
});

test("a closed connection aborts the running turn and the log records the abort", async () => {
  const { faux, home, cwd, run, updates } = harness();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 1; touch late" }, { id: "b1" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("should not run"),
  ]);
  const sessionId = await run(async (ctx) => {
    const { sessionId } = await newSession(ctx, cwd);
    void ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "wait" }] }).catch(() => {});
    while (!updates.some((u) => u.update.sessionUpdate === "tool_call")) await new Promise((r) => setTimeout(r, 10));
    return sessionId;
  });
  await new Promise((r) => setTimeout(r, 1_500));
  assert.equal(existsSync(join(cwd, "late")), false);
  const logged = SessionLog.open(home, sessionId).messages;
  assert.deepEqual(logged.map((m) => m.role), ["user", "assistant", "toolResult", "assistant"]);
  const last = logged.at(-1);
  assert.ok(last?.role === "assistant" && last.stopReason === "aborted");
});

test("session/load with a different cwd neither locks nor repairs the session", async () => {
  const { home, cwd, run } = harness();
  const dangling = fauxAssistantMessage([fauxToolCall("bash", { command: "make" }, { id: "d1" })], { stopReason: "toolUse" });
  const { id, path, lock } = foreignSession(cwd, [["model", dangling]], home);
  const before = readFileSync(path);
  await run(async (ctx) => {
    await assert.rejects(ctx.request(acp.methods.agent.session.load, { sessionId: id, cwd: tempDir(), mcpServers: [] }), /belongs to/);
  });
  assert.deepEqual(readFileSync(path), before);
  assert.equal(existsSync(lock), false);
});

test("failed session/new and session/load leave no files or locks behind", async () => {
  const { home, cwd, run } = harness(async () => {
    throw new Error("no model configured");
  });
  const { id } = foreignSession(cwd, [], home);
  await run(async (ctx) => {
    await assert.rejects(newSession(ctx, cwd), /no model configured/);
    await assert.rejects(ctx.request(acp.methods.agent.session.load, { sessionId: id, cwd, mcpServers: [] }), /no model configured/);
    await assert.rejects(ctx.request(acp.methods.agent.session.load, { sessionId: "01900000-0000-7000-8000-000000000000", cwd, mcpServers: [] }));
  });
  assert.deepEqual(readdirSync(join(home, "sessions")), [`${id}.jsonl`]);
});

test("instruction failures neither create sessions nor lock or repair a loaded session, and retries recover", async (t) => {
  const previousHome = process.env.RX_HOME;
  const rxHome = tempDir();
  process.env.RX_HOME = rxHome;
  t.after(() => { process.env.RX_HOME = previousHome; });
  const { faux, home, cwd, run } = harness();
  const dangling = fauxAssistantMessage([fauxToolCall("read", { path: "notes.txt" }, { id: "pending" })], { stopReason: "toolUse" });
  const { id, path, lock } = foreignSession(cwd, [["cli", { role: "user", content: "real task", timestamp: Date.now() }], ["model", dangling]], home);
  appendFileSync(path, '{"torn":');
  const before = readFileSync(path);
  const instructions = join(rxHome, "AGENTS.md");
  writeFileSync(instructions, "@./missing.md");
  await run(async (ctx) => {
    for (let retry = 0; retry < 3; retry++) {
      const located = (error: Error) => error.message.includes("AGENTS.md:1:") && error.message.includes("missing.md");
      await assert.rejects(newSession(ctx, cwd), located);
      await assert.rejects(ctx.request(acp.methods.agent.session.load, { sessionId: id, cwd, mcpServers: [] }), located);
      assert.deepEqual(readdirSync(join(home, "sessions")), [`${id}.jsonl`]);
      assert.deepEqual(readFileSync(path), before);
      assert.equal(existsSync(lock), false);
    }
    const listed = await ctx.request(acp.methods.agent.session.list, { cwd });
    assert.deepEqual(listed.sessions.map((session) => session.sessionId), [id]);
    writeFileSync(join(rxHome, "missing.md"), "recovered instructions");
    await ctx.request(acp.methods.agent.session.load, { sessionId: id, cwd, mcpServers: [] });
    faux.setResponses([fauxAssistantMessage("recovered")]);
    const response = await ctx.request(acp.methods.agent.session.prompt, { sessionId: id, prompt: [{ type: "text", text: "continue" }] });
    assert.equal(response.stopReason, "end_turn");
    assert.ok(existsSync(lock));
    const loaded = SessionLog.open(home, id);
    assert.equal(loaded.messages.filter((message) => message.role === "toolResult").length, 1);
    assert.equal(loaded.messages.at(-1)?.role, "assistant");
    const created = await newSession(ctx, cwd);
    assert.notEqual(created.sessionId, id);
  });
});

test("replayed tool calls from an aborted message are shown as failed", () => {
  const aborted = fauxAssistantMessage([fauxToolCall("bash", { command: "make" }, { id: "x1" })], { stopReason: "aborted" });
  const [update] = historyUpdates("/work", [aborted]);
  assert.ok(update?.sessionUpdate === "tool_call" && update.status === "failed");
});

test("prompt input maps resources and links to text and rejects audio", () => {
  const input = promptInput([
    { type: "text", text: "see" },
    { type: "resource_link", name: "spec", uri: "file:///spec.md" },
    { type: "resource", resource: { uri: "file:///a.ts", text: "code" } },
    { type: "image", data: "AAAA", mimeType: "image/png" },
  ]);
  assert.equal(input.text, 'see\n\n[spec](file:///spec.md)\n\n<resource uri="file:///a.ts">\ncode\n</resource>');
  assert.deepEqual(input.images, [{ type: "image", data: "AAAA", mimeType: "image/png" }]);
  assert.throws(() => promptInput([{ type: "audio", data: "AAAA", mimeType: "audio/wav" }]), /unsupported prompt content: audio/);
});

test("rx acp speaks ndjson over stdio", async () => {
  const home = tempDir();
  const child = spawn(process.execPath, [join(import.meta.dirname, "../src/cli.ts"), "acp"], {
    env: { PATH: process.env.PATH, HOME: home, RX_HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stream = acp.ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>);
  try {
    const result = await acp.client().connectWith(stream, async (ctx) => {
      const init = await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION });
      const list = await ctx.request(acp.methods.agent.session.list, {});
      const created = await newSession(ctx, home).then(
        () => "created",
        (error: Error) => error.message,
      );
      return { init, list, created };
    });
    assert.equal(result.init.agentInfo?.version, JSON.parse(readFileSync(join(import.meta.dirname, "../package.json"), "utf8")).version);
    assert.deepEqual(result.list.sessions, []);
    assert.match(result.created, /no model selected/);
  } finally {
    child.kill();
  }
});

test("load replays a session after its cwd is deleted while new rejects the missing cwd", async () => {
  const { faux, home, cwd, run, updates } = harness();
  const { id, path, lock } = foreignSession(cwd, [["cli", { role: "user", content: "saved task", timestamp: Date.now() }]], home);
  const before = readFileSync(path);
  rmSync(cwd, { recursive: true });
  await run(async (ctx) => {
    await assert.rejects(newSession(ctx, cwd));
    assert.deepEqual(readdirSync(join(home, "sessions")), [`${id}.jsonl`]);
    assert.equal(existsSync(lock), false);
    assert.deepEqual(readFileSync(path), before);
    await ctx.request(acp.methods.agent.session.load, { sessionId: id, cwd, mcpServers: [] });
    assert.ok(updates.some(({ update }) => update.sessionUpdate === "user_message_chunk"));
    faux.setResponses([fauxAssistantMessage("continued without project tools")]);
    const result = await ctx.request(acp.methods.agent.session.prompt, { sessionId: id, prompt: [{ type: "text", text: "continue" }] });
    assert.equal(result.stopReason, "end_turn");
  });
  assert.deepEqual(readdirSync(join(home, "sessions")).filter((file) => file.endsWith(".jsonl")), [`${id}.jsonl`]);
});


test("session configuration changes the next model call and load returns a fresh complete snapshot", async () => {
  const faux = fauxProvider({ models: [
    { id: "reasoner", name: "Reasoner", reasoning: true, contextWindow: 10000, input: ["text", "image"] },
    { id: "plain", name: "Plain", reasoning: false, contextWindow: 8192, input: ["text"] },
  ] });
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel("reasoner")!;
  const home = tempDir();
  const cwd = tempDir();
  const updates: acp.SessionUpdate[] = [];
  const client = acp.client().onNotification(acp.methods.client.session.update, ({ params }) => { updates.push(params.update); });
  const app = createAcpApp({ home, models, choose: async () => ({ model, thinking: "high" }) });
  await client.connectWith(app, async (ctx) => {
    const init = await ctx.request(acp.methods.agent.initialize, { protocolVersion: 1, clientCapabilities: { session: { configOptions: { boolean: {} } } } });
    assert.equal(init.agentCapabilities?.promptCapabilities?.image, true);
    assert.deepEqual(init.agentCapabilities?.mcpCapabilities, { http: true, sse: false });
    const created = await newSession(ctx, cwd);
    const { sessionId } = created;
    assert.deepEqual(created.configOptions?.map((option) => option.category), ["model", "thought_level"]);
    const configured = await ctx.request(acp.methods.agent.session.setConfigOption, { sessionId, configId: "model", value: `${model.provider}/plain` });
    assert.equal(configured.configOptions.find((option) => option.id === "model")?.currentValue, `${model.provider}/plain`);
    assert.equal(configured.configOptions.find((option) => option.id === "thinking")?.currentValue, "off");
    await assert.rejects(ctx.request(acp.methods.agent.session.setConfigOption, { sessionId, configId: "thinking", value: "high" }));
    await assert.rejects(ctx.request(acp.methods.agent.session.setConfigOption, { sessionId, configId: "fast", type: "boolean", value: true }));
    await assert.rejects(ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "image", data: "AAAA", mimeType: "image/png" }] }), /does not support image input/);
    assert.equal(faux.state.callCount, 0);
    faux.setResponses([(_context, options, _state, calledModel) => {
      assert.equal(calledModel.id, "plain");
      assert.equal(options?.reasoning, undefined);
      const message = fauxAssistantMessage("configured");
      return message;
    }]);
    await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "go" }] });
    const logged = readFileSync(join(home, "sessions", `${sessionId}.jsonl`), "utf8").trim().split("\n").map((line) => JSON.parse(line)).findLast((entry) => entry.message?.role === "assistant").message;
    const used = logged.usage.input + logged.usage.output + logged.usage.cacheRead + logged.usage.cacheWrite;
    assert.ok(used > 0);
    assert.deepEqual(updates.filter((update) => update.sessionUpdate === "usage_update").at(-1), { sessionUpdate: "usage_update", used, size: 8192 });
    assert.ok(updates.some((update) => update.sessionUpdate === "config_option_update"));
    const loaded = await ctx.request(acp.methods.agent.session.load, { sessionId, cwd, mcpServers: [] });
    assert.equal(loaded.configOptions?.find((option) => option.id === "model")?.currentValue, `${model.provider}/reasoner`);
    assert.equal(loaded.configOptions?.find((option) => option.id === "thinking")?.currentValue, "high");
  });
});
