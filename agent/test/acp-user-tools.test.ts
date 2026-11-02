import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as acp from "@agentclientprotocol/sdk/unstable";
import { fauxAssistantMessage, fauxToolCall, type JsonObject } from "@earendil-works/pi-ai";
import { createAcpApp } from "../src/acp.ts";
import { createRxAgent } from "../src/agent.ts";
import { SessionLog } from "../src/session-log.ts";
import { render } from "../src/terminal.ts";
import { todoTool, todoUpdate } from "../src/todo.ts";
import { fauxModels, tempDir } from "./helpers.ts";

process.env.HOME = tempDir();
process.env.RX_HOME = tempDir();

type Handler = acp.ClientRequestHandler<acp.CreateElicitationRequest, acp.CreateElicitationResponse>;

function harness(onQuestion?: Handler) {
  const { faux, models, model } = fauxModels();
  const sessions: NonNullable<Parameters<typeof createAcpApp>[1]> = new Map();
  const home = tempDir();
  const cwd = tempDir();
  const updates: acp.SessionUpdate[] = [];
  const app = createAcpApp({ home, models, choose: async () => ({ model, thinking: "off" }) }, sessions);
  const client = acp.client().onNotification(acp.methods.client.session.update, ({ params }) => { updates.push(params.update); });
  if (onQuestion) client.onRequest(acp.methods.client.elicitation.create, onQuestion);
  const open = async (ctx: acp.ClientContext, capability = true, notes = true) => {
    await ctx.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        ...(capability ? { elicitation: { form: {} } } : {}),
        _meta: { lody: { elicitation: { version: 1, answerNotes: notes } } },
      },
    });
    return (await ctx.request(acp.methods.agent.session.new, { cwd, mcpServers: [] })).sessionId;
  };
  const prompt = (ctx: acp.ClientContext, sessionId: string) => ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "work" }] });
  const result = (sessionId: string) => SessionLog.open(home, sessionId).history.filter((message) => message.role === "toolResult").at(-1)!;
  return { faux, models, model, home, cwd, sessions, updates, app, client, open, prompt, result };
}

const call = (name: string, args: Record<string, unknown>, id = name) => fauxAssistantMessage([fauxToolCall(name, args as JsonObject, { id })], { stopReason: "toolUse" });

test("todo persists complete snapshots and replays every plan at its original position without executing tools", async () => {
  const h = harness();
  const first = [{ content: "Inspect", status: "in_progress" }, { content: "Verify", status: "pending", priority: "high" }];
  const next = [{ content: "Inspect", status: "completed", priority: "low" }];
  h.faux.setResponses([call("todo", { entries: first }, "one"), fauxAssistantMessage("first done"), call("todo", { entries: next }, "two"), fauxAssistantMessage("second done"), call("todo", { entries: [] }, "clear"), fauxAssistantMessage("cleared")]);
  await h.client.connectWith(h.app, async (ctx) => {
    const id = await h.open(ctx);
    await h.prompt(ctx, id);
    await h.prompt(ctx, id);
    await h.prompt(ctx, id);
    const plans = h.updates.filter((update) => update.sessionUpdate === "plan");
    assert.deepEqual(plans, [
      { sessionUpdate: "plan", entries: [{ ...first[0], priority: "medium" }, first[1]] },
      { sessionUpdate: "plan", entries: next },
      { sessionUpdate: "plan", entries: [] },
    ]);
    const log = h.sessions.get(id)!.log;
    const before = readFileSync(log.path, "utf8");
    const offset = h.updates.length;
    await ctx.request(acp.methods.agent.session.load, { sessionId: id, cwd: h.cwd, mcpServers: [] });
    const replay = h.updates.slice(offset);
    assert.deepEqual(replay.filter((update) => update.sessionUpdate === "plan"), plans);
    for (const [index, update] of replay.entries()) {
      if (update.sessionUpdate !== "plan") continue;
      assert.equal(replay[index - 1]!.sessionUpdate, "tool_call_update");
      assert.equal(replay[index + 1]!.sessionUpdate, "agent_message_chunk");
    }
    assert.equal(h.faux.state.callCount, 6);
    assert.equal(readFileSync(log.path, "utf8"), before);
  });
});

test("CLI agents expose todo but no ask_user, and the terminal prints the complete checklist", async (t) => {
  const h = harness();
  const agent = createRxAgent({ models: h.models, model: h.model, thinking: "off", cwd: h.cwd, systemPrompt: "", log: SessionLog.create(h.home, h.cwd), origin: "cli" });
  assert.ok(agent.state.tools.some((tool) => tool.name === "todo"));
  assert.ok(!agent.state.tools.some((tool) => tool.name === "ask_user"));
  const result = await todoTool().execute("id", { entries: [{ content: "Run acceptance", status: "completed" }] });
  const output: string[] = [];
  t.mock.method(process.stderr, "write", (chunk: string | Uint8Array) => { output.push(String(chunk)); return true; });
  render({ type: "tool_execution_end", toolCallId: "id", toolName: "todo", result, isError: false }, false);
  assert.match(output.join(""), /\[x\] Run acceptance/);
  assert.equal(todoUpdate({ version: 1, entries: [{ content: "bad", status: "cancelled" }] }), undefined);
});

test("ask_user maps single, multiple, free-text, custom, and note fields to Lody form and returns accepted answers", async () => {
  let request: acp.CreateElicitationRequest | undefined;
  const h = harness(({ params }) => {
    request = params;
    return { action: "accept", content: { q0: "A", q0_note: "Need it today", q1: ["B", "C"], q2: "Plain text", q3_custom: "My choice" } };
  });
  const questions = [
    { id: "single", question: "Choose one", header: "Choice", options: [{ label: "A", description: "First" }], allowCustomAnswer: false },
    { id: "multi", question: "Choose several", options: [{ label: "B" }, { label: "C" }], multiSelect: true },
    { id: "free", question: "Describe it" },
    { id: "custom", question: "Choose or write", options: [{ label: "D" }] },
  ];
  h.faux.setResponses([call("ask_user", { questions }), fauxAssistantMessage("answered")]);
  await h.client.connectWith(h.app, async (ctx) => {
    const id = await h.open(ctx);
    assert.equal((await h.prompt(ctx, id)).stopReason, "end_turn");
    assert.ok(request?.mode === "form" && "requestedSchema" in request);
    assert.ok("sessionId" in request && "toolCallId" in request);
    assert.equal(request.sessionId, id);
    assert.equal(request.toolCallId, "ask_user");
    const schema = request.requestedSchema as acp.ElicitationSchema;
    assert.deepEqual(schema.properties?.q0, { type: "string", oneOf: [{ const: "A", title: "A", description: "First" }], title: "Choice", description: "Choose one" });
    assert.deepEqual(schema.properties?.q1, { type: "array", items: { anyOf: [{ const: "B", title: "B" }, { const: "C", title: "C" }] }, description: "Choose several" });
    assert.deepEqual(schema.properties?.q2, { type: "string", description: "Describe it" });
    assert.equal(schema.properties?.q0_custom, undefined);
    assert.deepEqual(schema.properties?.q3_custom?._meta, { lody: { elicitation: { version: 1, customAnswerFor: "q3" } } });
    assert.deepEqual(schema.properties?.q0_note?._meta, { lody: { elicitation: { version: 1, noteFor: "q0" } } });
    assert.deepEqual(request._meta, { lody: { elicitation: { version: 1, autoResolveAfterSeconds: null } } });
    const result = h.result(id);
    assert.deepEqual(result.details, { answers: { single: "A", multi: ["B", "C"], free: "Plain text", custom: "My choice" }, notes: { single: "Need it today" } });
    assert.equal(result.isError, false);
    const offset = h.updates.length;
    await ctx.request(acp.methods.agent.session.load, { sessionId: id, cwd: h.cwd, mcpServers: [] });
    assert.ok(h.updates.slice(offset).some((update) => update.sessionUpdate === "tool_call_update" && JSON.stringify(update.content).includes("Need it today")));
  });
});

test("ask_user accepts scalar option labels from Lody for multiple-choice answers", async () => {
  const h = harness(() => ({ action: "accept", content: { q0: "B", q1: "B", q2_custom: "Another choice" } }));
  const questions = [
    { id: "custom_matches_option", question: "Choose several", options: [{ label: "A" }, { label: "B" }], multiSelect: true },
    { id: "restricted", question: "Choose several", options: [{ label: "B" }], multiSelect: true, allowCustomAnswer: false },
    { id: "custom", question: "Choose or write", options: [{ label: "B" }], multiSelect: true },
  ];
  h.faux.setResponses([call("ask_user", { questions }), fauxAssistantMessage("answered")]);
  await h.client.connectWith(h.app, async (ctx) => {
    const id = await h.open(ctx);
    assert.equal((await h.prompt(ctx, id)).stopReason, "end_turn");
    assert.equal(h.result(id).isError, false);
    assert.deepEqual(h.result(id).details, { answers: { custom_matches_option: ["B"], restricted: ["B"], custom: "Another choice" } });
  });
});

for (const action of ["decline", "cancel", "accept"] as const) {
  test(`ask_user ${action} lets the model continue without inventing an answer`, async () => {
    const h = harness(({ params }) => {
      assert.ok("requestedSchema" in params);
      assert.ok(!Object.keys((params.requestedSchema as acp.ElicitationSchema).properties!).some((key) => key.endsWith("_note")));
      return { action };
    });
    h.faux.setResponses([call("ask_user", { questions: [{ id: "one", question: "What now?" }] }), fauxAssistantMessage("continued")]);
    await h.client.connectWith(h.app, async (ctx) => {
      const id = await h.open(ctx, true, false);
      assert.equal((await h.prompt(ctx, id)).stopReason, "end_turn");
      assert.deepEqual(h.result(id).details, action === "accept" ? { answers: {} } : { cancelled: true });
      assert.equal(h.result(id).isError, false);
      assert.equal(h.faux.state.callCount, 2);
    });
  });
}

test("clients without elicitation.form never receive an ask_user tool, including after load", async () => {
  const h = harness();
  await h.client.connectWith(h.app, async (ctx) => {
    const id = await h.open(ctx, false);
    const names = () => h.sessions.get(id)!.agent.state.tools.map((tool) => tool.name);
    assert.ok(names().includes("todo"));
    assert.ok(!names().includes("ask_user"));
    await ctx.request(acp.methods.agent.session.load, { sessionId: id, cwd: h.cwd, mcpServers: [] });
    assert.ok(!names().includes("ask_user"));
  });
});

test("cancelling a turn settles an elicitation even when the client ignores cancellation and answers late", { timeout: 10000 }, async () => {
  let started!: () => void;
  let reply!: (response: acp.CreateElicitationResponse) => void;
  let cancel!: () => void;
  const beginning = new Promise<void>((resolve) => { started = resolve; });
  const replied = new Promise<acp.CreateElicitationResponse>((resolve) => { reply = resolve; });
  const cancelled = new Promise<void>((resolve) => { cancel = resolve; });
  const h = harness(({ signal }) => {
    signal.addEventListener("abort", cancel, { once: true });
    started();
    return replied;
  });
  h.faux.setResponses([call("ask_user", { questions: [{ id: "one", question: "Waiting?" }] }), fauxAssistantMessage("next turn")]);
  await h.client.connectWith(h.app, async (ctx) => {
    const id = await h.open(ctx);
    const running = h.prompt(ctx, id);
    await beginning;
    await ctx.notify(acp.methods.agent.session.cancel, { sessionId: id });
    assert.equal((await running).stopReason, "cancelled");
    await cancelled;
    assert.equal(h.result(id).isError, true);
    const before = readFileSync(h.sessions.get(id)!.log.path, "utf8");
    reply({ action: "accept", content: { q0: "too late" } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(readFileSync(h.sessions.get(id)!.log.path, "utf8"), before);
    assert.equal(h.faux.state.callCount, 1);
    const history = SessionLog.open(h.home, id).history;
    const last = history.at(-1)!;
    assert.ok(last.role === "assistant" && last.stopReason === "aborted");
    assert.equal((await h.prompt(ctx, id)).stopReason, "end_turn");
  });
});

test("invalid question identities and invalid accepted choices fail the tool without recording an answer", async () => {
  let requests = 0;
  const h = harness(() => { requests++; return { action: "accept", content: { q0: "not an option" } }; });
  h.faux.setResponses([
    call("ask_user", { questions: [{ id: "same", question: "One" }, { id: "same", question: "Two" }] }, "duplicate"),
    call("ask_user", { questions: [{ id: "one", question: "Pick", options: [{ label: "Allowed" }], allowCustomAnswer: false }] }, "invalid"),
    fauxAssistantMessage("handled"),
  ]);
  await h.client.connectWith(h.app, async (ctx) => {
    const id = await h.open(ctx);
    await h.prompt(ctx, id);
    assert.equal(requests, 1);
    assert.equal(h.result(id).isError, true);
  });
});

test("closing the ACP connection aborts a pending question and records the aborted turn", { timeout: 10000 }, async () => {
  let started!: () => void;
  const beginning = new Promise<void>((resolve) => { started = resolve; });
  const h = harness(() => { started(); return new Promise<acp.CreateElicitationResponse>(() => {}); });
  h.faux.setResponses([call("ask_user", { questions: [{ id: "one", question: "Waiting?" }] }), fauxAssistantMessage("must not run")]);
  const id = await h.client.connectWith(h.app, async (ctx) => {
    const id = await h.open(ctx);
    void h.prompt(ctx, id).catch(() => {});
    await beginning;
    return id;
  });
  await h.sessions.get(id)!.agent.waitForIdle();
  assert.equal(h.result(id).isError, true);
  assert.equal(h.faux.state.callCount, 1);
  const last = SessionLog.open(h.home, id).history.at(-1)!;
  assert.ok(last.role === "assistant" && last.stopReason === "aborted");
});


test("forked sessions replay the selected turn plan and retain structured questions", async () => {
  let askedSession: string | undefined;
  const h = harness(({ params }) => {
    assert.ok("sessionId" in params && typeof params.sessionId === "string");
    askedSession = params.sessionId;
    return { action: "accept", content: { q0: "Blue" } };
  });
  const first = [{ content: "First turn", status: "completed", priority: "high" }];
  const next = [{ content: "Later turn", status: "pending", priority: "low" }];
  h.faux.setResponses([
    call("todo", { entries: first }, "first-plan"), fauxAssistantMessage("first done"),
    call("todo", { entries: next }, "later-plan"), fauxAssistantMessage("later done"),
    call("ask_user", { questions: [{ id: "color", question: "Which color?" }] }), fauxAssistantMessage("Blue received"),
  ]);
  await h.client.connectWith(h.app, async (ctx) => {
    const source = await h.open(ctx);
    await h.prompt(ctx, source);
    await h.prompt(ctx, source);
    const turn = h.updates.map((update) => (update._meta?.lody as { turnId?: string } | undefined)?.turnId).find(Boolean)!;
    const sourcePath = h.sessions.get(source)!.log.path;
    const sourceBefore = readFileSync(sourcePath, "utf8");
    const fork = await ctx.request(acp.methods.agent.session.fork, { sessionId: source, cwd: h.cwd, mcpServers: [], _meta: { lody: { forkAtTurn: { version: 1, turnId: turn } } } });
    assert.ok(h.sessions.get(fork.sessionId)!.agent.state.tools.some((tool) => tool.name === "ask_user"));
    assert.equal((await h.prompt(ctx, fork.sessionId)).stopReason, "end_turn");
    assert.equal(askedSession, fork.sessionId);
    assert.deepEqual(h.result(fork.sessionId).details, { answers: { color: "Blue" } });
    const before = h.updates.length;
    const calls = h.faux.state.callCount;
    await ctx.request(acp.methods.agent.session.load, { sessionId: fork.sessionId, cwd: h.cwd, mcpServers: [] });
    assert.deepEqual(h.updates.slice(before).filter((update) => update.sessionUpdate === "plan"), [{ sessionUpdate: "plan", entries: first }]);
    assert.equal(h.faux.state.callCount, calls);
    assert.equal(readFileSync(sourcePath, "utf8"), sourceBefore);
  });
});
