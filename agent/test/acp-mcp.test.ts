import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import * as acp from "@agentclientprotocol/sdk";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createAcpApp } from "../src/acp.ts";
import { assertProcessExited, foreignSession, fauxModels, mcpPid, tempDir } from "./helpers.ts";

process.env.HOME = tempDir();
process.env.RX_HOME = tempDir();
const fixture = new URL("./fixtures/mcp-server.ts", import.meta.url).pathname;
const server = (name: string): acp.McpServer => ({ name, command: process.execPath, args: [fixture], env: [] });

test("ACP load closes replaced MCP children and connection end closes current children", { timeout: 15_000 }, async (t) => {
  const { models, model } = fauxModels();
  const home = tempDir();
  const cwd = tempDir();
  const firstTrace = join(home, "first.jsonl");
  const nextTrace = join(home, "next.jsonl");
  const pids: number[] = [];
  t.after(() => { for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch {} } });
  const app = createAcpApp({ home, models, choose: async () => ({ model, thinking: "off" }) });
  const traced = (name: string, trace: string) => ({ ...server(name), args: [fixture, `--trace=${trace}`] });
  await acp.client().connectWith(app, async (ctx) => {
    const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd, mcpServers: [traced("first", firstTrace)] });
    const first = await mcpPid(firstTrace);
    pids.push(first);
    process.kill(first, 0);
    await ctx.request(acp.methods.agent.session.load, { cwd, sessionId, mcpServers: [traced("next", nextTrace)] });
    const next = await mcpPid(nextTrace);
    pids.push(next);
    await assertProcessExited(first);
    process.kill(next, 0);
  });
  await assertProcessExited(pids[1]!);
});

test("ACP new and load expose user and client MCP tools through normal model execution", async () => {
  const { faux, models, model } = fauxModels();
  const home = tempDir();
  const cwd = tempDir();
  writeFileSync(join(home, "mcp.json"), JSON.stringify({ mcpServers: { user: { command: process.execPath, args: [fixture] } } }));
  const updates: acp.SessionUpdate[] = [];
  const client = acp.client().onNotification(acp.methods.client.session.update, ({ params }) => { updates.push(params.update); });
  const app = createAcpApp({ home, models, choose: async () => ({ model, thinking: "off" }) });
  faux.setResponses([
    (context) => {
      const text = JSON.stringify(context);
      assert.ok(text.includes("mcp__client__echo") && text.includes("mcp__user__echo"));
      return fauxAssistantMessage([fauxToolCall("mcp__client__echo", { value: "ACP_NEW_MCP_OK" }, { id: "new-call" })], { stopReason: "toolUse" });
    },
    fauxAssistantMessage("new done"),
    fauxAssistantMessage([fauxToolCall("mcp__loaded__fail", {}, { id: "load-call" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("loaded failure reported"),
  ]);
  await client.connectWith(app, async (ctx) => {
    const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd, mcpServers: [server("client")] });
    const response = await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "use client" }] });
    assert.equal(response.stopReason, "end_turn");
    assert.ok(updates.some((update) => update.sessionUpdate === "tool_call_update" && update.status === "completed" && JSON.stringify(update.content).includes("ACP_NEW_MCP_OK")));
    await ctx.request(acp.methods.agent.session.load, { cwd, sessionId, mcpServers: [server("loaded")] });
    await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "use loaded" }] });
    assert.ok(updates.some((update) => update.sessionUpdate === "tool_call_update" && update.toolCallId === "load-call" && update.status === "failed"));
    const log = readFileSync(join(home, "sessions", `${sessionId}.jsonl`), "utf8");
    assert.ok(log.includes("ACP_NEW_MCP_OK") && log.includes("fixture tool refused"));
    assert.equal(log.includes('"mcpServers"'), false);
  });
});

test("ACP MCP startup failure preserves new and loaded logs", async () => {
  const { models, model } = fauxModels();
  const cwd = tempDir();
  const home = tempDir();
  const { id, path, lock } = foreignSession(cwd, [], home);
  const before = readFileSync(path);
  const app = createAcpApp({ home, models, choose: async () => ({ model, thinking: "off" }) });
  const bad = [{ name: "bad", command: "/missing-rx-mcp", args: [], env: [] }];
  await acp.client().connectWith(app, async (ctx) => {
    await assert.rejects(ctx.request(acp.methods.agent.session.new, { cwd, mcpServers: bad }), /MCP server bad/);
    await assert.rejects(ctx.request(acp.methods.agent.session.load, { cwd, sessionId: id, mcpServers: bad }), /MCP server bad/);
  });
  assert.deepEqual(readFileSync(path), before);
  assert.equal(existsSync(lock), false);
});

test("ACP cancellation reaches a slow MCP server and ends the turn as cancelled", async () => {
  const { faux, models, model } = fauxModels();
  const home = tempDir();
  const cwd = tempDir();
  faux.setResponses([fauxAssistantMessage([fauxToolCall("mcp__fixture__slow", {}, { id: "slow-call" })], { stopReason: "toolUse" })]);
  const app = createAcpApp({ home, models, choose: async () => ({ model, thinking: "off" }) });
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const client = acp.client().onNotification(acp.methods.client.session.update, ({ params }) => {
    if (params.update.sessionUpdate === "tool_call_update" && params.update.status === "in_progress") started();
  });
  await client.connectWith(app, async (ctx) => {
    const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd, mcpServers: [server("fixture")] });
    const turn = ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "run slow" }] });
    await ready;
    await ctx.notify(acp.methods.agent.session.cancel, { sessionId });
    assert.equal((await turn).stopReason, "cancelled");
  });
});
