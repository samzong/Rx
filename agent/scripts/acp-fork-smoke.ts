import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk/unstable";

const root = process.argv[2];
if (!root) throw new Error("Pass an empty scratch directory as the first argument");
const binary = resolve(process.argv[3] ?? "../target/rx-agent");
const model = process.argv[4] ?? "deepseek/deepseek-flash";
const cwd = join(root, "work");
const home = join(root, "home");
mkdirSync(cwd, { recursive: true });
const updates: acp.SessionNotification[] = [];

async function withClient<T>(operation: (ctx: acp.ClientContext) => Promise<T>): Promise<T> {
  const child = spawn(binary, ["acp", "-m", model, "--thinking", "off"], { env: { ...process.env, RX_HOME: home }, stdio: ["pipe", "pipe", "inherit"] });
  const exited = new Promise<void>((resolve) => { child.once("exit", () => resolve()); });
  const stream = acp.ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>);
  try {
    return await acp.client().onNotification(acp.methods.client.session.update, ({ params }) => { updates.push(params); }).connectWith(stream, async (ctx) => {
      const init = await ctx.request(acp.methods.agent.initialize, { protocolVersion: 1 });
      assert.ok(init.agentCapabilities?.sessionCapabilities?.fork);
      assert.deepEqual((init.agentCapabilities?._meta?.lody as { forkAtTurn?: unknown })?.forkAtTurn, { version: 1 });
      return operation(ctx);
    });
  } finally {
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(timer);
  }
}

const prompt = (ctx: acp.ClientContext, sessionId: string, text: string) => ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text }] });
const orchid = `alpha-${randomUUID()}`;
const cedar = `beta-${randomUUID()}`;

await withClient(async (source) => {
  const created = await source.request(acp.methods.agent.session.new, { cwd, mcpServers: [] });
  assert.equal((await prompt(source, created.sessionId, `Remember that the ORCHID code is ${orchid}. Reply only ACK. Do not use tools.`)).stopReason, "end_turn");
  assert.equal((await prompt(source, created.sessionId, `Remember that the CEDAR code is ${cedar}. Reply only ACK. Do not use tools.`)).stopReason, "end_turn");
  const turnIds = updates.filter(({ sessionId }) => sessionId === created.sessionId).flatMap(({ update }) => {
    const turnId = (update._meta?.lody as { turnId?: string })?.turnId;
    return turnId ? [turnId] : [];
  });
  assert.equal(turnIds.length, 2);
  const path = join(home, "sessions", `${created.sessionId}.jsonl`);
  const original = readFileSync(path);
  await withClient(async (forkClient) => {
    const fork = await forkClient.request(acp.methods.agent.session.fork, {
      sessionId: created.sessionId, cwd, mcpServers: [],
      _meta: { lody: { forkAtTurn: { version: 1, turnId: turnIds[0] }, sessionConfig: { version: 1, modelId: model, configOptionValues: { thinking: "off" } } } },
    });
    assert.notEqual(fork.sessionId, created.sessionId);
    assert.ok(fork.configOptions?.length);
    assert.deepEqual(readFileSync(path), original);
    const beforeReplay = updates.length;
    await forkClient.request(acp.methods.agent.session.load, { sessionId: fork.sessionId, cwd, mcpServers: [] });
    const replay = JSON.stringify(updates.slice(beforeReplay));
    assert.ok(replay.includes(orchid) && !replay.includes(cedar));
    const beforePrompt = updates.length;
    assert.equal((await prompt(forkClient, fork.sessionId, "Return a JSON object with the remembered ORCHID and CEDAR codes. Use null for any code that was not given in this conversation. Do not guess. Do not use tools. Return JSON only, without Markdown.")).stopReason, "end_turn");
    const text = updates.slice(beforePrompt).filter(({ sessionId }) => sessionId === fork.sessionId).flatMap(({ update }) => update.sessionUpdate === "agent_message_chunk" && update.content.type === "text" ? [update.content.text] : []).join("");
    const answer = JSON.parse(text);
    assert.equal(answer.ORCHID, orchid);
    assert.equal(answer.CEDAR, null);
    assert.deepEqual(readFileSync(path), original);
    console.log(JSON.stringify({ result: "PASS", processBoundary: "separate source and fork processes", selectedTurnIncluded: true, nextTurnExcluded: true, sourceUnchanged: true, replayMatched: true, modelRecallMatched: true }));
  });
});
