import assert from "node:assert/strict";
import { test } from "node:test";
import * as acp from "@agentclientprotocol/sdk/unstable";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { LODY_EXTENSION_METHODS, type LodySessionActivityUpdate } from "acp-extension-core";
import { createAcpApp } from "../src/acp.ts";
import { sessionActivityStream } from "../src/acp-activity.ts";
import { fauxModels, tempDir } from "./helpers.ts";

process.env.HOME = tempDir();
process.env.RX_HOME = tempDir();

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function harness(client: acp.ClientApp) {
  const { faux, models, model } = fauxModels();
  const home = tempDir();
  const cwd = tempDir();
  const app = createAcpApp({ home, models, choose: async () => ({ model, thinking: "off" }) });
  const input = new TransformStream<acp.AnyMessage, acp.AnyMessage>();
  const output = new TransformStream<acp.AnyMessage, acp.AnyMessage>();
  const connection = app.connect(sessionActivityStream({ readable: input.readable, writable: output.writable }));
  const run = async (op: (ctx: acp.ClientContext) => Promise<void>) => {
    try {
      await client.connectWith({ readable: output.readable, writable: input.writable }, async (ctx) => {
        const init = await ctx.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { elicitation: { form: {} } } });
        assert.deepEqual(init.agentCapabilities?._meta?.lody && (init.agentCapabilities._meta.lody as Record<string, unknown>).sessionActivity, { version: 1 });
        await op(ctx);
      });
    } finally {
      connection.close();
      await connection.closed;
    }
  };
  return { faux, home, cwd, run };
}

test("new, load, and fork publish their first idle only after the response reaches the client", async () => {
  const observed: string[] = [];
  const waiters: Array<() => void> = [];
  const client = acp.client().onNotification(LODY_EXTENSION_METHODS.sessionActivityUpdate, (value) => value as LodySessionActivityUpdate, ({ params }) => {
    assert.equal(observed.at(-1), "response");
    assert.equal(params.state, "idle");
    assert.equal(params.backgroundTaskCount, 0);
    observed.push("idle");
    waiters.shift()?.();
  });
  const { cwd, run } = harness(client);
  await run(async (ctx) => {
    const idle = () => new Promise<void>((resolve) => waiters.push(resolve));
    let next = idle();
    const created = await ctx.request("session/new", { cwd, mcpServers: [] });
    observed.push("response");
    await next;
    next = idle();
    await ctx.request("session/load", { sessionId: created.sessionId, cwd, mcpServers: [] });
    observed.push("response");
    await next;
    next = idle();
    await ctx.request("session/fork", { sessionId: created.sessionId, cwd, mcpServers: [] });
    observed.push("response");
    await next;
    await assert.rejects(ctx.request("session/resume", { sessionId: created.sessionId, cwd, mcpServers: [] }));
    assert.deepEqual(observed, ["response", "idle", "response", "idle", "response", "idle"]);
  });
});

test("a question reports running, requires_action, running, idle before the prompt response", async () => {
  const events: string[] = [];
  const idle = deferred<void>();
  const client = acp.client()
    .onNotification(LODY_EXTENSION_METHODS.sessionActivityUpdate, (value) => value as LodySessionActivityUpdate, ({ params }) => {
      events.push(params.state);
      if (events.length === 1) idle.resolve();
    })
    .onRequest(acp.methods.client.elicitation.create, () => {
      assert.equal(events.at(-1), "requires_action");
      return { action: "accept", content: { q0: "yes" } };
    });
  const { faux, cwd, run } = harness(client);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("ask_user", { questions: [{ id: "q", question: "Continue?" }] })], { stopReason: "toolUse" }),
    fauxAssistantMessage("finished"),
  ]);
  await run(async (ctx) => {
    const { sessionId } = await ctx.request("session/new", { cwd, mcpServers: [] });
    await idle.promise;
    const response = await ctx.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "ask" }] });
    assert.equal(response.stopReason, "end_turn");
    assert.deepEqual(events, ["idle", "running", "requires_action", "running", "idle"]);
  });
});

test("cancelled elicitation and provider errors end idle and cannot leak a late running state", async () => {
  const states: string[] = [];
  const idle = deferred<void>();
  const asked = deferred<void>();
  const answer = deferred<acp.CreateElicitationResponse>();
  const client = acp.client()
    .onNotification(LODY_EXTENSION_METHODS.sessionActivityUpdate, (value) => value as LodySessionActivityUpdate, ({ params }) => {
      states.push(params.state);
      if (states.length === 1) idle.resolve();
    })
    .onRequest(acp.methods.client.elicitation.create, () => { asked.resolve(); return answer.promise; });
  const { faux, cwd, run } = harness(client);
  faux.setResponses([fauxAssistantMessage([fauxToolCall("ask_user", { questions: [{ id: "q", question: "Continue?" }] })], { stopReason: "toolUse" })]);
  await run(async (ctx) => {
    const { sessionId } = await ctx.request("session/new", { cwd, mcpServers: [] });
    await idle.promise;
    const prompt = ctx.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "ask" }] });
    await asked.promise;
    await ctx.notify("session/cancel", { sessionId });
    assert.equal((await prompt).stopReason, "cancelled");
    assert.deepEqual(states, ["idle", "running", "requires_action", "idle"]);
    answer.resolve({ action: "accept", content: { q0: "late" } });
    faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 invalid API key" })]);
    await assert.rejects(ctx.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "fail" }] }));
    assert.deepEqual(states, ["idle", "running", "requires_action", "idle", "running", "idle"]);
    await assert.rejects(ctx.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "/compact" }] }));
    assert.deepEqual(states.slice(-2), ["running", "idle"]);
  });
});
