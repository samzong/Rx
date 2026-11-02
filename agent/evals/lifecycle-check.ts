import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import * as acp from "@agentclientprotocol/sdk";

let requests = 0;
const server = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk: Buffer) => { body += chunk.toString(); });
  request.on("end", () => {
    requests++;
    const input = JSON.parse(body) as { messages: { role: string; content: string | unknown[] }[] };
    const latestUser = input.messages.findLast((message) => message.role === "user");
    const prompt = JSON.stringify(latestUser?.content);
    if (prompt.includes("stall fixture")) return;
    const toolResult = input.messages.at(-1)?.role === "tool";
    const delta = toolResult ? { role: "assistant", content: "finished" } : {
      role: "assistant",
      tool_calls: [{ index: 0, id: `call-${requests}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command: prompt.includes("cancel fixture") ? "sleep 2; printf late > late.txt" : "printf done >> calls.txt" }) } }],
    };
    response.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (value: unknown, finish: string | null) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "plain", choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`;
    response.end(chunk(delta, null) + chunk({}, toolResult ? "stop" : "tool_calls") + "data: [DONE]\n\n");
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address === "object");
const provider = { id: "eval-fixture", name: "Eval fixture", api: "openai-completions", baseUrl: `http://127.0.0.1:${address.port}/v1`, env: "EVAL_FIXTURE_KEY", defaultModel: "plain", models: [{ id: "plain", name: "Plain", contextWindow: 32768, reasoning: false }] };
const env = { PATH: process.env.PATH, HOME: "/home/node", RX_HOME: "/work/.rx", EVAL_FIXTURE_KEY: "synthetic-placeholder", RX_AGENT_PROVIDER: JSON.stringify(provider) };
const children: ReturnType<typeof spawn>[] = [];
const start = () => {
  const child = spawn("rx-agent", ["acp"], { env, stdio: ["pipe", "pipe", "pipe"] });
  children.push(child);
  let stderr = "";
  child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const updates: acp.SessionNotification[] = [];
  const client = acp.client().onNotification(acp.methods.client.session.update, ({ params }) => { updates.push(params); });
  const stream = acp.ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>);
  return { child, client, stream, updates, stderr: () => stderr };
};
const until = async (condition: () => boolean) => {
  const deadline = Date.now() + 5000;
  while (!condition()) { if (Date.now() > deadline) throw new Error("The lifecycle fixture did not reach its checkpoint."); await delay(10); }
};
const initialize = (ctx: acp.ClientContext) => ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { session: { configOptions: { boolean: {} }, compaction: {} } } });
const prompt = (ctx: acp.ClientContext, sessionId: string, text: string) => ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text }] });
const results: Record<string, boolean> = {};
const timeout = setTimeout(() => { for (const child of children) child.kill("SIGKILL"); server.closeAllConnections(); }, 20_000);
try {
  const live = start();
  await live.client.connectWith(live.stream, async (ctx) => {
    const init = await initialize(ctx);
    assert.equal(init.protocolVersion, 1);
    const created = await ctx.request(acp.methods.agent.session.new, { cwd: "/work", mcpServers: [] });
    await ctx.request(acp.methods.agent.session.setConfigOption, { sessionId: created.sessionId, configId: "thinking", value: "off" });
    assert.equal((await prompt(ctx, created.sessionId, "normal fixture")).stopReason, "end_turn");
    assert.equal(readFileSync("/work/calls.txt", "utf8"), "done");
    const opened = live.updates.findIndex((event) => event.update.sessionUpdate === "tool_call");
    const firstTool = live.updates[opened]?.update;
    assert.ok(firstTool?.sessionUpdate === "tool_call");
    assert.ok(live.updates.some((event, index) => index > opened && event.update.sessionUpdate === "tool_call_update" && event.update.toolCallId === firstTool.toolCallId && event.update.status === "completed"));
    results.callOrderAndTools = true;
    const before = requests;
    const liveCount = live.updates.length;
    await ctx.request(acp.methods.agent.session.load, { sessionId: created.sessionId, cwd: "/work", mcpServers: [] });
    assert.equal(requests, before);
    assert.equal(readFileSync("/work/calls.txt", "utf8"), "done");
    assert.ok(live.updates.slice(liveCount).some((event) => event.update.sessionUpdate === "tool_call"));
    results.replayWithoutExecution = true;
    const pending = prompt(ctx, created.sessionId, "cancel fixture");
    await until(() => live.updates.slice(liveCount).some((event) => event.update.sessionUpdate === "tool_call" && event.update.title.includes("sleep")));
    await ctx.notify(acp.methods.agent.session.cancel, { sessionId: created.sessionId });
    assert.equal((await pending).stopReason, "cancelled");
    await delay(2200);
    assert.equal(existsSync("/work/late.txt"), false);
    results.cancelWithoutLateWrite = true;
    const count = requests;
    const stalled = prompt(ctx, created.sessionId, "stall fixture");
    await until(() => requests > count);
    await ctx.notify(acp.methods.agent.session.cancel, { sessionId: created.sessionId });
    assert.equal((await stalled).stopReason, "cancelled");
    results.stallCanStop = true;
  });
  live.child.kill("SIGTERM");
  const crash = start();
  let crashId = "";
  await assert.rejects(crash.client.connectWith(crash.stream, async (ctx) => {
    await initialize(ctx);
    crashId = (await ctx.request(acp.methods.agent.session.new, { cwd: "/work", mcpServers: [] })).sessionId;
    const count = requests;
    const pending = prompt(ctx, crashId, "stall fixture");
    void pending.catch(() => {});
    await until(() => requests > count);
    crash.child.kill("SIGKILL");
    await pending;
  }));
  results.crashCannotComplete = true;
  const resumed = start();
  await resumed.client.connectWith(resumed.stream, async (ctx) => {
    await initialize(ctx);
    const count = requests;
    await ctx.request(acp.methods.agent.session.load, { sessionId: crashId, cwd: "/work", mcpServers: [] });
    assert.equal(requests, count);
    results.crashResumeWithoutModelRequest = true;
  });
  console.log(JSON.stringify({ suite: "lifecycle", actualEntrypoint: "rx-agent acp", modelRequests: 0, fixtureRequests: requests, results }));
} finally {
  clearTimeout(timeout);
  for (const child of children) child.kill("SIGTERM");
  server.closeAllConnections();
  server.close();
}
