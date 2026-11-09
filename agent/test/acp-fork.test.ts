import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import * as acp from "@agentclientprotocol/sdk/unstable";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createAcpApp } from "../src/acp.ts";
import { createRxAgent } from "../src/agent.ts";
import { SESSION_USAGE_METHOD, type SessionUsageUpdate } from "../src/acp-session-usage.ts";
import { SessionLog } from "../src/session-log.ts";
import { fauxModels, tempDir } from "./helpers.ts";

process.env.HOME = tempDir();
process.env.RX_HOME = tempDir();

function harness() {
  const { faux, models, model } = fauxModels();
  const home = tempDir();
  const cwd = tempDir();
  const updates: acp.SessionNotification[] = [];
  const usage: SessionUsageUpdate[] = [];
  const app = createAcpApp({ home, models, choose: async () => ({ model, thinking: "off" }) });
  const client = acp.client()
    .onNotification(acp.methods.client.session.update, ({ params }) => { updates.push(params); })
    .onNotification(SESSION_USAGE_METHOD, (params) => params as SessionUsageUpdate, ({ params }) => { usage.push(params); });
  return { faux, home, cwd, updates, usage, run: <T>(operation: (ctx: acp.ClientContext) => Promise<T>) => client.connectWith(app, async (ctx) => {
    await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION });
    return operation(ctx);
  }) };
}

function turnIds(updates: acp.SessionNotification[], sessionId: string): string[] {
  return updates.filter((update) => update.sessionId === sessionId).flatMap(({ update }) => {
    const lody = update._meta?.lody as { turnId?: string } | undefined;
    return lody?.turnId ? [lody.turnId] : [];
  });
}

test("fork advertises Lody turn boundaries and keeps the selected complete turn", async () => {
  const { faux, home, cwd, updates, run } = harness();
  let continued = false;
  faux.setResponses([fauxAssistantMessage("answer A"), fauxAssistantMessage("answer B"), (context) => {
    assert.match(JSON.stringify(context.messages), /secret A/);
    assert.doesNotMatch(JSON.stringify(context.messages), /secret B|answer B/);
    continued = true;
    return fauxAssistantMessage("answer C");
  }]);
  await run(async (ctx) => {
    const init = await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION });
    assert.deepEqual(init.agentCapabilities?.sessionCapabilities?.fork, {});
    assert.deepEqual((init.agentCapabilities?._meta?.lody as { forkAtTurn?: unknown })?.forkAtTurn, { version: 1 });
    const source = await ctx.request(acp.methods.agent.session.new, { cwd, mcpServers: [] });
    const prompt = (sessionId: string, text: string) => ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text }] });
    await prompt(source.sessionId, "secret A");
    await prompt(source.sessionId, "secret B");
    const ids = turnIds(updates, source.sessionId);
    assert.equal(ids.length, 2);
    assert.notEqual(ids[0], ids[1]);
    const path = join(home, "sessions", `${source.sessionId}.jsonl`);
    const original = readFileSync(path);
    const fork = await ctx.request(acp.methods.agent.session.fork, { sessionId: source.sessionId, cwd, mcpServers: [], _meta: { lody: { forkAtTurn: { version: 1, turnId: ids[0] } } } });
    assert.notEqual(fork.sessionId, source.sessionId);
    assert.ok(fork.configOptions?.length);
    assert.ok((fork._meta?.lody as { modelCapabilities?: unknown })?.modelCapabilities);
    assert.deepEqual(readFileSync(path), original);
    const copied = readFileSync(join(home, "sessions", `${fork.sessionId}.jsonl`), "utf8");
    assert.match(copied, /secret A/);
    assert.match(copied, /answer A/);
    assert.doesNotMatch(copied, /secret B|answer B/);
    const before = updates.length;
    await ctx.request(acp.methods.agent.session.load, { sessionId: fork.sessionId, cwd, mcpServers: [] });
    assert.deepEqual(turnIds(updates.slice(before), fork.sessionId), [ids[0]]);
    const replay = JSON.stringify(updates.slice(before));
    assert.match(replay, /secret A/);
    assert.match(replay, /answer A/);
    assert.doesNotMatch(replay, /secret B|answer B/);
    assert.equal((await prompt(fork.sessionId, "continue C")).stopReason, "end_turn");
    assert.equal(continued, true);
    assert.deepEqual(readFileSync(path), original);
  });
});

test("fork without a turn copies all turns and accepts a prompt without load", async () => {
  const { faux, cwd, updates, run } = harness();
  let observed = false;
  faux.setResponses([fauxAssistantMessage("A"), fauxAssistantMessage("B"), (context) => {
    assert.match(JSON.stringify(context.messages), /first input/);
    assert.match(JSON.stringify(context.messages), /second input/);
    observed = true;
    return fauxAssistantMessage("continued");
  }]);
  await run(async (ctx) => {
    const source = await ctx.request(acp.methods.agent.session.new, { cwd, mcpServers: [] });
    for (const text of ["first input", "second input"]) await ctx.request(acp.methods.agent.session.prompt, { sessionId: source.sessionId, prompt: [{ type: "text", text }] });
    const fork = await ctx.request(acp.methods.agent.session.fork, { sessionId: source.sessionId, cwd });
    assert.deepEqual(fork.configOptions, source.configOptions);
    await ctx.request(acp.methods.agent.session.prompt, { sessionId: fork.sessionId, prompt: [{ type: "text", text: "continue" }] });
    assert.equal(observed, true);
    assert.equal(turnIds(updates, fork.sessionId).length, 1);
  });
});

test("fork rejects missing sessions and invalid turn metadata without creating a target", async () => {
  const { home, cwd, run } = harness();
  await run(async (ctx) => {
    const source = await ctx.request(acp.methods.agent.session.new, { cwd, mcpServers: [] });
    const before = readdirSync(join(home, "sessions"));
    for (const [params, code] of [
      [{ sessionId: "missing", cwd }, -32602],
      [{ sessionId: "00000000-0000-0000-0000-000000000000", cwd }, -32002],
      [{ sessionId: source.sessionId, cwd, _meta: { lody: { forkAtTurn: { version: 1, turnId: "missing" } } } }, -32602],
      [{ sessionId: source.sessionId, cwd, _meta: { lody: { forkAtTurn: { version: 2 } } } }, -32602],
    ] as const) await assert.rejects(ctx.request(acp.methods.agent.session.fork, params), (error: unknown) => error instanceof acp.RequestError && error.code === code);
    assert.deepEqual(readdirSync(join(home, "sessions")), before);
  });
});

test("CLI continuation starts a distinct boundary after an ACP turn", async () => {
  const { faux, models, model } = fauxModels();
  const home = tempDir();
  const cwd = tempDir();
  const source = SessionLog.create(home, cwd);
  const first = source.beginTurn();
  source.append("acp", { role: "user", content: "ACP input", timestamp: Date.now() });
  source.append("model", fauxAssistantMessage("ACP answer"));
  faux.setResponses([fauxAssistantMessage("CLI answer")]);
  const loaded = SessionLog.open(home, source.id);
  const agent = createRxAgent({ models, model, thinking: "off", cwd, systemPrompt: "", log: loaded.log, messages: loaded.messages, origin: "cli" });
  await agent.prompt("CLI input");
  const before = readFileSync(source.path);
  const fork = SessionLog.fork(home, source.id, cwd, first);
  assert.doesNotMatch(JSON.stringify(fork.history), /CLI/);
  assert.equal(SessionLog.open(home, source.id).turns.length, 2);
  assert.deepEqual(readFileSync(source.path), before);
});

test("rejected prompts and manual compaction keep distinct replayable fork boundaries", async () => {
  const { faux, home, cwd, updates, run } = harness();
  const script = join(home, "deny.mjs");
  writeFileSync(script, "let text=''; for await (const chunk of process.stdin) text+=chunk; if(JSON.parse(text).prompt==='reject') process.exitCode=2;");
  writeFileSync(join(home, "hooks.json"), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}` }] }] } }));
  faux.setResponses([fauxAssistantMessage("A answer"), fauxAssistantMessage("A summary [log 1-1]")]);
  await run(async (ctx) => {
    const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd, mcpServers: [] });
    const prompt = (text: string) => ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text }] });
    await prompt("A input ".repeat(800));
    await prompt("reject");
    await prompt("/compact");
    const ids = turnIds(updates, sessionId);
    assert.equal(ids.length, 3);
    assert.equal(new Set(ids).size, 3);
    const source = readFileSync(join(home, "sessions", `${sessionId}.jsonl`));
    assert.match(source.toString(), /"type":"compaction"/);
    const fork = SessionLog.fork(home, sessionId, cwd, ids[0]);
    assert.doesNotMatch(readFileSync(fork.log.path, "utf8"), /"type":"compaction"|A summary/);
    const rejected = SessionLog.fork(home, sessionId, cwd, ids[1]);
    assert.equal(rejected.turns.length, 2);
    assert.doesNotMatch(readFileSync(rejected.log.path, "utf8"), /"type":"compaction"/);
    const before = updates.length;
    await ctx.request(acp.methods.agent.session.load, { sessionId, cwd, mcpServers: [] });
    assert.deepEqual(turnIds(updates.slice(before), sessionId), ids);
    assert.deepEqual(readFileSync(join(home, "sessions", `${sessionId}.jsonl`)), source);
  });
});

test("fork during a prompt snapshots unfinished tools without changing or cancelling the source", { timeout: 15_000 }, async () => {
  const { faux, home, cwd, updates, run } = harness();
  faux.setResponses([fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 30" }, { id: "running-1" })], { stopReason: "toolUse" }), fauxAssistantMessage("fork continued")]);
  await run(async (ctx) => {
    const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd, mcpServers: [] });
    const pending = ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "wait" }] });
    try {
      while (!updates.some(({ update }) => update.sessionUpdate === "tool_call")) await new Promise((resolve) => setTimeout(resolve, 5));
      const path = join(home, "sessions", `${sessionId}.jsonl`);
      const before = readFileSync(path);
      const fork = await ctx.request(acp.methods.agent.session.fork, { sessionId, cwd, _meta: { lody: { forkAtTurn: { version: 1, turnId: turnIds(updates, sessionId)[0] } } } });
      assert.deepEqual(readFileSync(path), before);
      const copied = readFileSync(join(home, "sessions", `${fork.sessionId}.jsonl`), "utf8");
      assert.match(copied, /side effects are unknown/);
      assert.equal(updates.filter(({ sessionId: id, update }) => id === sessionId && update.sessionUpdate === "tool_call_update").length, 0);
      assert.equal((await ctx.request(acp.methods.agent.session.prompt, { sessionId: fork.sessionId, prompt: [{ type: "text", text: "continue without rerunning tools" }] })).stopReason, "end_turn");
    } finally {
      await ctx.notify(acp.methods.agent.session.cancel, { sessionId });
      assert.equal((await pending).stopReason, "cancelled");
    }
  });
});

test("fork truncates historical context usage and starts fresh accounting without billing replay", async () => {
  const { faux, home, cwd, updates, usage, run } = harness();
  const replies = [100, 200, 300, 400, 500].map((input) => {
    const reply = fauxAssistantMessage(`answer ${input}`);
    return { ...reply, usage: { ...reply.usage, input, output: 10, totalTokens: input + 10 } };
  });
  faux.setResponses(replies);
  await run(async (ctx) => {
    const source = await ctx.request(acp.methods.agent.session.new, { cwd, mcpServers: [] });
    const prompt = (sessionId: string) => ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "continue" }] });
    await prompt(source.sessionId);
    await prompt(source.sessionId);
    const original = readFileSync(join(home, "sessions", `${source.sessionId}.jsonl`));
    assert.equal(usage.length, 2);
    const sourceScope = usage[0]!._meta.lody.usageScopeId;
    const model = Object.keys(usage[0]!.modelUsage)[0]!;
    assert.equal(usage[1]!.modelUsage[model]!.inputTokens, usage[0]!.usage.inputTokens + usage[1]!.usage.inputTokens);
    const fork = await ctx.request(acp.methods.agent.session.fork, { sessionId: source.sessionId, cwd, _meta: { lody: { forkAtTurn: { version: 1, turnId: turnIds(updates, source.sessionId)[0] } } } });
    const copied = SessionLog.open(home, fork.sessionId).usageMessages.filter((message) => message.role === "assistant");
    assert.deepEqual(copied.map((message) => message.usage.input), [usage[0]!.usage.inputTokens]);
    const projected = await ctx.request(acp.methods.agent.session.fork, { sessionId: source.sessionId, cwd, _meta: { lody: { forkAtTurn: { version: 1, turnId: turnIds(updates, source.sessionId)[0] } } } });
    const replayStart = updates.length;
    await ctx.request(acp.methods.agent.session.load, { sessionId: projected.sessionId, cwd, mcpServers: [] });
    assert.equal(usage.length, 2);
    const replayed = updates.slice(replayStart).filter(({ update }) => update.sessionUpdate === "usage_update");
    assert.equal(replayed.length, 1);
    assert.equal(replayed[0]!.update.sessionUpdate === "usage_update" && replayed[0]!.update.used, usage[0]!.usage.inputTokens + usage[0]!.usage.outputTokens + usage[0]!.usage.cacheReadInputTokens + (usage[0]!.usage.cacheCreationInputTokens ?? 0));
    await prompt(fork.sessionId);
    assert.equal(usage[2]!.sessionId, fork.sessionId);
    assert.notEqual(usage[2]!._meta.lody.usageScopeId, sourceScope);
    assert.deepEqual(usage[2]!.modelUsage, usage[2]!.delta.modelUsage);
    assert.equal(usage.filter((update) => update.sessionId === source.sessionId).length, 2);
    const before = updates.length;
    await ctx.request(acp.methods.agent.session.load, { sessionId: fork.sessionId, cwd, mcpServers: [] });
    assert.equal(usage.length, 3);
    const context = updates.slice(before).filter(({ update }) => update.sessionUpdate === "usage_update");
    assert.equal(context.length, 1);
    assert.equal(context[0]!.update.sessionUpdate === "usage_update" && context[0]!.update.used, usage[2]!.usage.inputTokens + usage[2]!.usage.outputTokens + usage[2]!.usage.cacheReadInputTokens + (usage[2]!.usage.cacheCreationInputTokens ?? 0));
    await prompt(fork.sessionId);
    assert.equal(usage[3]!.sessionId, fork.sessionId);
    assert.notEqual(usage[3]!._meta.lody.usageScopeId, sourceScope);
    assert.notEqual(usage[3]!._meta.lody.usageScopeId, usage[2]!._meta.lody.usageScopeId);
    assert.deepEqual(usage[3]!.modelUsage, usage[3]!.delta.modelUsage);
    assert.deepEqual(readFileSync(join(home, "sessions", `${source.sessionId}.jsonl`)), original);
    await prompt(source.sessionId);
    assert.equal(usage[4]!._meta.lody.usageScopeId, sourceScope);
    assert.equal(usage[4]!.modelUsage[model]!.inputTokens, usage[1]!.modelUsage[model]!.inputTokens + usage[4]!.usage.inputTokens);
  });
});
