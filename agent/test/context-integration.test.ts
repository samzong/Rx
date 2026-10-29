import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as acp from "@agentclientprotocol/sdk";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createAcpApp } from "../src/acp.ts";
import { contextControl } from "../src/context-control.ts";
import { fauxModels, tempDir } from "./helpers.ts";

process.env.HOME = tempDir();
process.env.RX_HOME = tempDir();

type Sessions = NonNullable<Parameters<typeof createAcpApp>[1]>;

function harness() {
  const { models, faux, model } = fauxModels();
  const selected = { ...model, contextWindow: 16384 };
  const sessions: Sessions = new Map();
  const updates: acp.SessionUpdate[] = [];
  const cwd = tempDir();
  const app = createAcpApp({ home: tempDir(), models, choose: async () => ({ model: selected, thinking: "off" }) }, sessions);
  const client = acp.client().onNotification(acp.methods.client.session.update, ({ params }) => { updates.push(params.update); });
  const prompt = (ctx: acp.ClientContext, sessionId: string, text: string) => ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text }] });
  const open = async (ctx: acp.ClientContext) => {
    await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION });
    const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd, mcpServers: [] });
    return { sessionId, live: sessions.get(sessionId)! };
  };
  return { faux, sessions, updates, cwd, client, app, prompt, open };
}

const source = "Keep protected.txt unchanged. accepted.txt is complete. Inspect unknown side effects before retrying. " + "historical evidence ".repeat(1200);
const summary = () => fauxAssistantMessage("Keep protected.txt unchanged. accepted.txt is complete. Inspect unknown side effects before retrying. [log 1-1]");
const entries = (path: string) => readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));

test("ACP uses the real context controller for manual compaction, full replay, and fresh working usage", async () => {
  const h = harness();
  let summaries = 0;
  let workings = 0;
  h.faux.setResponses(Array.from({ length: 10 }, () => (context, _options, _state, model) => {
    if (model.maxTokens <= 4096) { summaries++; return summary(); }
    workings++;
    if (workings > 1) {
      assert.match(JSON.stringify(context), /protected.txt/);
      assert.doesNotMatch(JSON.stringify(context), /historical evidence historical evidence historical evidence/);
    }
    return fauxAssistantMessage("Recorded progress. Do not repeat the completed edit.");
  }));
  await h.client.connectWith(h.app, async (ctx) => {
    const { sessionId, live } = await h.open(ctx);
    assert.ok(contextControl(live.agent));
    assert.equal((await h.prompt(ctx, sessionId, source)).stopReason, "end_turn");
    const before = h.updates.filter((update) => update.sessionUpdate === "usage_update").at(-1)!;
    const rawUsers = entries(live.log.path).filter((entry) => entry.message?.role === "user").length;
    const start = h.updates.length;
    assert.equal((await h.prompt(ctx, sessionId, "/compact")).stopReason, "end_turn");
    assert.ok(summaries > 0);
    assert.equal(workings, 1);
    assert.equal(entries(live.log.path).filter((entry) => entry.type === "compaction").length, 1);
    assert.equal(entries(live.log.path).filter((entry) => entry.message?.role === "user").length, rawUsers);
    const activity = h.updates.slice(start).filter((update) => update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update");
    assert.deepEqual(activity.map((update) => update.status), ["in_progress", "completed"]);
    assert.equal(activity[0]!.toolCallId, activity[1]!.toolCallId);
    assert.deepEqual(activity[1]!._meta, { lody: { activity: { version: 1, kind: "context_compaction" } } });
    const beforeLoad = h.updates.length;
    const summaryCalls = summaries;
    await ctx.request(acp.methods.agent.session.load, { sessionId, cwd: h.cwd, mcpServers: [] });
    const replay = h.updates.slice(beforeLoad);
    assert.ok(replay.some((update) => update.sessionUpdate === "user_message_chunk" && update.content.type === "text" && update.content.text === source));
    assert.equal(replay.some((update) => update.sessionUpdate === "usage_update"), false);
    assert.equal(summaries, summaryCalls);
    assert.equal((await h.prompt(ctx, sessionId, "Continue under the original restrictions")).stopReason, "end_turn");
    const after = h.updates.filter((update) => update.sessionUpdate === "usage_update").at(-1)!;
    assert.ok(after.used < before.used);
    assert.equal(after.size, 16384);
    assert.equal(h.sessions.get(sessionId)!.running, false);
  });
});

test("ACP Stop reaches the real summary request, closes its activity, and permits a later compact", async () => {
  const h = harness();
  let started!: () => void;
  const begin = new Promise<void>((resolve) => { started = resolve; });
  let cancelSummary = true;
  h.faux.setResponses(Array.from({ length: 10 }, () => async (_context, options, _state, model) => {
    if (model.maxTokens > 4096) return fauxAssistantMessage("Recorded progress");
    if (!cancelSummary) return summary();
    started();
    const signal = options!.signal!;
    if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    return { ...fauxAssistantMessage([]), stopReason: "aborted" };
  }));
  await h.client.connectWith(h.app, async (ctx) => {
    const { sessionId, live } = await h.open(ctx);
    await h.prompt(ctx, sessionId, source);
    const pending = h.prompt(ctx, sessionId, "/compact");
    await begin;
    await ctx.notify(acp.methods.agent.session.cancel, { sessionId });
    assert.equal((await pending).stopReason, "cancelled");
    const records = entries(live.log.path);
    assert.equal(records.some((entry) => entry.type === "compaction"), false);
    assert.equal(records.at(-1).message.stopReason, "aborted");
    assert.equal(live.running, false);
    const activity = h.updates.filter((update) => update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update");
    assert.deepEqual(activity.map((update) => update.status), ["in_progress", "failed"]);
    cancelSummary = false;
    assert.equal((await h.prompt(ctx, sessionId, "/compact")).stopReason, "end_turn");
    assert.equal(entries(live.log.path).filter((entry) => entry.type === "compaction").length, 1);
    assert.equal(live.running, false);
  });
});
