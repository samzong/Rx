import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as acp from "@agentclientprotocol/sdk";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createAcpApp } from "../src/acp.ts";
import { registerContextControl, type CompactionEvent, type ContextControl } from "../src/context-control.ts";
import { SessionLog } from "../src/session-log.ts";
import { fauxModels, tempDir } from "./helpers.ts";

process.env.HOME = tempDir();
process.env.RX_HOME = tempDir();

type Sessions = NonNullable<Parameters<typeof createAcpApp>[1]>;
type LiveSession = Sessions extends Map<string, infer Live> ? Live : never;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function mockControl() {
  const listeners = new Set<(event: CompactionEvent) => void>();
  let active: AbortController | undefined;
  let job = Promise.resolve();
  const fixture = {
    calls: 0,
    aborts: 0,
    idleWaits: 0,
    work: async (_signal: AbortSignal) => {},
    emit: (event: CompactionEvent) => { for (const listener of listeners) listener(event); },
    listenerCount: () => listeners.size,
  };
  const control: ContextControl = {
    compact: () => {
      const id = `compact-${++fixture.calls}`;
      const controller = new AbortController();
      active = controller;
      fixture.emit({ id, status: "in_progress" });
      job = (async () => {
        try {
          await fixture.work(controller.signal);
          controller.signal.throwIfAborted();
          fixture.emit({ id, status: "completed" });
        } catch (error) {
          fixture.emit({ id, status: "failed", message: error instanceof Error ? error.message : String(error) });
          throw error;
        } finally {
          active = undefined;
        }
      })();
      return job;
    },
    abort: () => { fixture.aborts++; active?.abort(); },
    waitForIdle: async () => { fixture.idleWaits++; await job.catch(() => {}); },
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  return Object.assign(fixture, { control });
}

function harness(hold?: (message: acp.AnyMessage) => Promise<void>) {
  const { faux, models, model } = fauxModels();
  const home = tempDir();
  const cwd = tempDir();
  const updates: acp.SessionUpdate[] = [];
  const controls = new Map<string, ReturnType<typeof mockControl>>();
  class RegisteredSessions extends Map<string, LiveSession> {
    override set(id: string, live: LiveSession): this {
      const fixture = mockControl();
      controls.set(id, fixture);
      registerContextControl(live.agent, fixture.control);
      return super.set(id, live);
    }
  }
  const sessions = new RegisteredSessions();
  const app = createAcpApp({ home, models, choose: async () => ({ model, thinking: "off" }) }, sessions);
  const client = acp.client().onNotification(acp.methods.client.session.update, ({ params }) => { updates.push(params.update); });
  const run = async <T>(op: (ctx: acp.ClientContext) => Promise<T>) => {
    if (!hold) return client.connectWith(app, op);
    const toAgent = new TransformStream<acp.AnyMessage, acp.AnyMessage>();
    const toClient = new TransformStream<acp.AnyMessage, acp.AnyMessage>();
    const writer = toClient.writable.getWriter();
    const connection = app.connect({
      readable: toAgent.readable,
      writable: new WritableStream<acp.AnyMessage>({
        write: async (message) => { await hold(message); await writer.write(message); },
        close: () => writer.close(),
        abort: (reason) => writer.abort(reason),
      }),
    });
    try {
      return await client.connectWith({ readable: toClient.readable, writable: toAgent.writable }, op);
    } finally {
      connection.close();
    }
  };
  const create = async (ctx: acp.ClientContext, compaction?: object | null) => {
    await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { session: { compaction } } });
    const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd, mcpServers: [] });
    return { sessionId, live: sessions.get(sessionId)!, fixture: controls.get(sessionId)! };
  };
  const prompt = (ctx: acp.ClientContext, sessionId: string, blocks: acp.ContentBlock[] = [{ type: "text", text: "/compact" }]) => ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: blocks });
  return { faux, home, cwd, updates, run, create, prompt, controls };
}

test("new and load advertise compact without parameters", async () => {
  const h = harness();
  await h.run(async (ctx) => {
    const { sessionId } = await h.create(ctx);
    await ctx.request(acp.methods.agent.session.load, { sessionId, cwd: h.cwd, mcpServers: [] });
    const commands = h.updates.filter((update) => update.sessionUpdate === "available_commands_update");
    assert.equal(commands.length, 2);
    for (const update of commands) {
      assert.deepEqual(update.availableCommands.map(({ name, input }) => ({ name, input })), [{ name: "compact", input: undefined }]);
    }
  });
});

for (const capability of [undefined, null, {}]) {
  test(`manual compact uses ${capability === undefined ? "omitted" : JSON.stringify(capability)} capability and leaves the task log intact`, async () => {
    const h = harness();
    await h.run(async (ctx) => {
      const { sessionId, live, fixture } = await h.create(ctx, capability);
      live.agent.state.messages.push(fauxAssistantMessage([], { stopReason: "error", errorMessage: "previous failure" }));
      const before = readFileSync(live.log.path);
      const response = await h.prompt(ctx, sessionId, [{ type: "text", text: " " }, { type: "text", text: " \n/compact\t" }]);
      assert.equal(response.stopReason, "end_turn");
      assert.equal(fixture.calls, 1);
      assert.equal(h.faux.state.callCount, 0);
      assert.deepEqual(readFileSync(live.log.path), before);
      assert.equal(fixture.listenerCount(), 0);
      const events = h.updates.filter((update) => update.sessionUpdate !== "available_commands_update");
      if (capability != null) {
        assert.deepEqual(events, [
          { sessionUpdate: "compaction_update", compactionId: "compact-1", status: "in_progress" },
          { sessionUpdate: "compaction_update", compactionId: "compact-1", status: "completed" },
        ]);
      } else {
        assert.deepEqual(events.map((update) => update.sessionUpdate), ["tool_call", "tool_call_update"]);
        for (const update of events) {
          assert.ok(update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update");
          assert.equal(update.toolCallId, "compact-1");
          assert.deepEqual(update._meta, { lody: { activity: { version: 1, kind: "context_compaction" } } });
        }
        assert.equal(events[0]?.sessionUpdate === "tool_call" && events[0].status, "in_progress");
        assert.equal(events[1]?.sessionUpdate === "tool_call_update" && events[1].status, "completed");
      }
    });
  });
}

test("resource, image, arguments, and quoted command content stay ordinary prompts", async () => {
  const h = harness();
  const cases: acp.ContentBlock[][] = [
    [{ type: "text", text: "/compact" }, { type: "image", data: "AAAA", mimeType: "image/png" }],
    [{ type: "text", text: "/compact" }, { type: "resource", resource: { uri: "file:///note", text: "" } }],
    [{ type: "resource", resource: { uri: "file:///note", text: "/compact" } }],
    [{ type: "text", text: "/compact" }, { type: "resource_link", name: "", uri: "file:///note" }],
    [{ type: "text", text: "/compact focus" }],
    [{ type: "text", text: "`/compact`" }],
    [{ type: "text", text: "/com" }, { type: "text", text: "pact" }],
  ];
  h.faux.setResponses(cases.map(() => fauxAssistantMessage("ordinary prompt")));
  await h.run(async (ctx) => {
    const { sessionId, fixture, live } = await h.create(ctx, {});
    for (const blocks of cases) assert.equal((await h.prompt(ctx, sessionId, blocks)).stopReason, "end_turn");
    assert.equal(fixture.calls, 0);
    assert.equal(h.faux.state.callCount, cases.length);
    assert.equal(live.agent.state.messages.filter((message) => message.role === "user").length, cases.length);
  });
});

for (const capability of [undefined, {}]) {
  test(`summary failure closes ${capability ? "standard" : "synthetic"} activity and does not reuse a previous stop reason`, async () => {
    const h = harness();
    await h.run(async (ctx) => {
      const { sessionId, fixture, live } = await h.create(ctx, capability);
      live.agent.state.messages.push(fauxAssistantMessage([], { stopReason: "aborted" }));
      fixture.work = async () => { throw new Error("summary unavailable"); };
      await assert.rejects(h.prompt(ctx, sessionId), /summary unavailable/);
      assert.equal(live.running, false);
      assert.equal(fixture.listenerCount(), 0);
      const last = h.updates.at(-1);
      assert.ok(last?.sessionUpdate === "compaction_update" || last?.sessionUpdate === "tool_call_update");
      assert.equal(last.status, "failed");
      fixture.work = async () => {};
      assert.equal((await h.prompt(ctx, sessionId)).stopReason, "end_turn");
    });
  });
}

for (const capability of [undefined, {}]) {
  test(`cancel aborts summary, awaits its cleanup, and closes ${capability ? "standard" : "synthetic"} activity`, async () => {
    const h = harness();
    await h.run(async (ctx) => {
      const { sessionId, fixture, live } = await h.create(ctx, capability);
      const started = deferred();
      const cancelled = deferred();
      const cleanup = deferred();
      fixture.work = async (signal) => {
        signal.addEventListener("abort", cancelled.resolve, { once: true });
        started.resolve();
        await cancelled.promise;
        await cleanup.promise;
      };
      let settled = false;
      const pending = h.prompt(ctx, sessionId).finally(() => { settled = true; });
      await started.promise;
      await ctx.notify(acp.methods.agent.session.cancel, { sessionId });
      await cancelled.promise;
      assert.equal(settled, false);
      assert.equal(live.running, true);
      await assert.rejects(h.prompt(ctx, sessionId), /already running/);
      await assert.rejects(ctx.request(acp.methods.agent.session.setConfigOption, { sessionId, configId: "thinking", value: "off" }), /running/);
      cleanup.resolve();
      assert.equal((await pending).stopReason, "cancelled");
      assert.equal(live.running, false);
      const last = h.updates.at(-1);
      assert.ok(last?.sessionUpdate === "compaction_update" || last?.sessionUpdate === "tool_call_update");
      assert.equal(last.status, capability ? "cancelled" : "failed");
      assert.ok(fixture.idleWaits > 0);
      assert.equal(fixture.listenerCount(), 0);
      fixture.work = async () => {};
      assert.equal((await h.prompt(ctx, sessionId)).stopReason, "end_turn");
    });
  });
}

test("connection close aborts summary and waits for its idle lifecycle", async () => {
  const h = harness();
  const cancelled = deferred();
  const cleanup = deferred();
  let fixture!: ReturnType<typeof mockControl>;
  const live = await h.run(async (ctx) => {
    const created = await h.create(ctx);
    fixture = created.fixture;
    const started = deferred();
    fixture.work = async (signal) => {
      signal.addEventListener("abort", cancelled.resolve, { once: true });
      started.resolve();
      await cancelled.promise;
      await cleanup.promise;
    };
    void h.prompt(ctx, created.sessionId).catch(() => {});
    await started.promise;
    return created.live;
  });
  await cancelled.promise;
  assert.equal(live.running, true);
  cleanup.resolve();
  await fixture.control.waitForIdle();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(live.running, false);
  assert.equal(fixture.listenerCount(), 0);
});

test("automatic compaction events are reported only within the active prompt subscription", async () => {
  const h = harness();
  await h.run(async (ctx) => {
    const { sessionId, fixture } = await h.create(ctx, {});
    fixture.emit({ id: "outside-before", status: "in_progress" });
    h.faux.setResponses([async () => {
      fixture.emit({ id: "automatic", status: "in_progress" });
      fixture.emit({ id: "automatic", status: "completed" });
      return fauxAssistantMessage("continued");
    }]);
    assert.equal((await h.prompt(ctx, sessionId, [{ type: "text", text: "work" }])).stopReason, "end_turn");
    fixture.emit({ id: "outside-after", status: "completed" });
    const events = h.updates.filter((update) => update.sessionUpdate === "compaction_update");
    assert.deepEqual(events.map(({ compactionId, status }) => ({ compactionId, status })), [
      { compactionId: "automatic", status: "in_progress" },
      { compactionId: "automatic", status: "completed" },
    ]);
    assert.equal(h.updates.filter((update) => update.sessionUpdate === "usage_update").length, 1);
  });
});

test("a prompt stays running until the terminal compaction notification is written", async () => {
  const terminal = deferred();
  const flush = deferred();
  const h = harness(async (message) => {
    if ("method" in message && message.method === acp.methods.client.session.update) {
      const { update } = message.params as acp.SessionNotification;
      if (update.sessionUpdate === "compaction_update" && update.status === "completed") {
        terminal.resolve();
        await flush.promise;
      }
    }
  });
  await h.run(async (ctx) => {
    const { sessionId, live } = await h.create(ctx, {});
    let settled = false;
    const response = h.prompt(ctx, sessionId).finally(() => { settled = true; });
    await terminal.promise;
    assert.equal(live.running, true);
    assert.equal(settled, false);
    flush.resolve();
    assert.equal((await response).stopReason, "end_turn");
    assert.equal(live.running, false);
    assert.equal(h.updates.at(-1)?.sessionUpdate, "compaction_update");
  });
});

test("load replays raw history and restricts usage to messages after the checkpoint", async (t) => {
  const h = harness();
  await h.run(async (ctx) => {
    const { sessionId, live } = await h.create(ctx);
    const old = fauxAssistantMessage("original answer");
    Object.assign(old, { api: live.selection.model.api, model: live.selection.model.id, provider: live.selection.model.provider });
    old.usage.input = 123;
    const raw = [{ role: "user" as const, content: "original task", timestamp: 1 }, old];
    const loaded = SessionLog.open(h.home, sessionId);
    const usageMessages: typeof raw = [];
    t.mock.method(SessionLog, "open", () => ({
      ...loaded,
      messages: [{ role: "user", content: "model summary projection", timestamp: 2 }],
      history: raw,
      usageMessages,
    }));
    h.updates.length = 0;
    await ctx.request(acp.methods.agent.session.load, { sessionId, cwd: h.cwd, mcpServers: [] });
    assert.deepEqual(h.updates.filter((update) => update.sessionUpdate === "user_message_chunk" || update.sessionUpdate === "agent_message_chunk").map((update) => update.content), [
      { type: "text", text: "original task" },
      { type: "text", text: "original answer" },
    ]);
    assert.equal(h.updates.some((update) => update.sessionUpdate === "usage_update"), false);
    usageMessages.push(old);
    h.updates.length = 0;
    await ctx.request(acp.methods.agent.session.load, { sessionId, cwd: h.cwd, mcpServers: [] });
    assert.deepEqual(h.updates.filter((update) => update.sessionUpdate === "usage_update"), [{ sessionUpdate: "usage_update", used: 123, size: live.selection.model.contextWindow }]);
  });
});
