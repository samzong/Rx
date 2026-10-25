import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import * as acp from "@agentclientprotocol/sdk";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createAcpApp } from "../src/acp.ts";
import { assertProcessExited, fauxModels, mcpPid, tempDir } from "./helpers.ts";

process.env.HOME = tempDir();
process.env.RX_HOME = tempDir();
const fixture = new URL("./fixtures/mcp-server.ts", import.meta.url).pathname;
const records = (path: string) => readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
const source = "Keep MCP_FACT and do not repeat completed side effects. " + "historical evidence ".repeat(1200);

function harness() {
  const { faux, models, model } = fauxModels();
  const sessions: NonNullable<Parameters<typeof createAcpApp>[1]> = new Map();
  const home = tempDir();
  const cwd = tempDir();
  const updates: acp.SessionUpdate[] = [];
  const app = createAcpApp({ home, models, choose: async () => ({ model: { ...model, contextWindow: 65536 }, thinking: "off" }) }, sessions);
  const client = acp.client().onNotification(acp.methods.client.session.update, ({ params }) => { updates.push(params.update); });
  const server = (name: string): acp.McpServer => ({ name, command: process.execPath, args: [fixture, `--trace=${join(home, `${name}.jsonl`)}`], env: [] });
  const pid = (name: string) => mcpPid(join(home, `${name}.jsonl`));
  const prompt = (ctx: acp.ClientContext, sessionId: string, text: string) => ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text }] });
  const open = async (ctx: acp.ClientContext) => {
    await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION });
    return (await ctx.request(acp.methods.agent.session.new, { cwd, mcpServers: [server("first")] })).sessionId;
  };
  return { faux, sessions, home, cwd, updates, app, client, server, pid, prompt, open };
}

test("ACP restores compacted MCP history and replaces servers without replaying tools", async () => {
  const h = harness();
  h.faux.setResponses([
    fauxAssistantMessage([fauxToolCall("mcp__first__echo", { value: "MCP_FACT" }, { id: "first-call" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Completed MCP_FACT"),
    fauxAssistantMessage("Keep MCP_FACT. Do not repeat completed side effects."),
    (context) => {
      assert.match(JSON.stringify(context.messages), /MCP_FACT/);
      assert.equal(context.messages.some((message) => message.role === "toolResult"), false);
      assert.match(JSON.stringify(context), /mcp__next__echo/);
      return fauxAssistantMessage([fauxToolCall("mcp__next__echo", { value: "MCP_AFTER_LOAD" }, { id: "next-call" })], { stopReason: "toolUse" });
    },
    fauxAssistantMessage("Loaded MCP complete"),
  ]);
  await h.client.connectWith(h.app, async (ctx) => {
    const sessionId = await h.open(ctx);
    const first = await h.pid("first");
    assert.equal((await h.prompt(ctx, sessionId, source)).stopReason, "end_turn");
    const log = h.sessions.get(sessionId)!.log;
    assert.equal((await h.prompt(ctx, sessionId, "/compact")).stopReason, "end_turn");
    assert.match(JSON.stringify(h.sessions.get(sessionId)!.agent.state.messages), /Recorded tool result mcp__first__echo/);
    assert.match(JSON.stringify(h.sessions.get(sessionId)!.agent.state.messages), /MCP_FACT/);
    assert.equal(records(log.path).filter((entry) => entry.type === "compaction").length, 1);
    const compacted = readFileSync(log.path);
    await assert.rejects(ctx.request(acp.methods.agent.session.load, { sessionId, cwd: h.cwd, mcpServers: [{ name: "bad", command: "/missing-rx-mcp", args: [], env: [] }] }), /MCP server bad/);
    assert.deepEqual(readFileSync(log.path), compacted);
    process.kill(first, 0);
    const before = h.updates.length;
    await ctx.request(acp.methods.agent.session.load, { sessionId, cwd: h.cwd, mcpServers: [h.server("next")] });
    await assertProcessExited(first);
    process.kill(await h.pid("next"), 0);
    const replay = h.updates.slice(before);
    assert.ok(replay.some((update) => update.sessionUpdate === "tool_call_update" && update.toolCallId === "first-call" && update.status === "completed"));
    assert.equal(replay.some((update) => update.sessionUpdate === "usage_update"), false);
    assert.equal(records(join(h.home, "first.jsonl")).filter((entry) => entry.event === "echo").length, 1);
    assert.equal((await h.prompt(ctx, sessionId, "Call the current MCP echo")).stopReason, "end_turn");
    assert.ok(records(log.path).some((entry) => entry.message?.toolCallId === "next-call" && entry.message?.role === "toolResult"));
  });
  await assertProcessExited(await h.pid("next"));
});

for (const disconnect of [false, true]) {
  test(`ACP ${disconnect ? "disconnect" : "cancel"} during compaction preserves MCP lifecycle`, async () => {
    const h = harness();
    let started!: () => void;
    const begin = new Promise<void>((resolve) => { started = resolve; });
    let aborted = false;
    h.faux.setResponses([
      fauxAssistantMessage("Recorded progress"),
      async (_context, options) => {
        started();
        const signal = options!.signal!;
        if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        aborted = signal.aborted;
        return { ...fauxAssistantMessage([]), stopReason: "aborted" };
      },
      fauxAssistantMessage([fauxToolCall("mcp__first__echo", { value: "AFTER_CANCEL" }, { id: "after-cancel" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("MCP survived cancellation"),
    ]);
    let sessionId!: string;
    let observed!: Promise<unknown>;
    await h.client.connectWith(h.app, async (ctx) => {
      sessionId = await h.open(ctx);
      await h.prompt(ctx, sessionId, source);
      const pending = h.prompt(ctx, sessionId, "/compact");
      observed = pending.catch(() => undefined);
      await begin;
      await assert.rejects(ctx.request(acp.methods.agent.session.load, { sessionId, cwd: h.cwd, mcpServers: [h.server("blocked")] }), /session is running/);
      if (disconnect) return;
      await ctx.notify(acp.methods.agent.session.cancel, { sessionId });
      await observed;
      assert.ok(aborted);
      const log = h.sessions.get(sessionId)!.log;
      assert.equal(records(log.path).some((entry) => entry.type === "compaction"), false);
      assert.equal(records(log.path).at(-1).message.stopReason, "aborted");
      if (!disconnect) {
        process.kill(await h.pid("first"), 0);
        assert.equal((await h.prompt(ctx, sessionId, "Call MCP after cancelling the summary")).stopReason, "end_turn");
        assert.ok(records(log.path).some((entry) => entry.message?.toolCallId === "after-cancel" && entry.message?.role === "toolResult"));
      }
    });
    await observed;
    assert.ok(aborted);
    assert.equal(records(h.sessions.get(sessionId)!.log.path).some((entry) => entry.type === "compaction"), false);
    await assertProcessExited(await h.pid("first"));
  });
}
