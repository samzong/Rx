import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const root = process.argv[2];
if (!root) throw new Error("Pass an empty scratch directory as the first argument");
const model = process.argv[3] ?? process.env.RX_MODEL ?? "deepseek/deepseek-flash";
const cwd = join(root, "work");
const home = join(root, "home");
mkdirSync(cwd);
mkdirSync(home);
const command = process.env.RX_AGENT_BINARY ?? process.execPath;
const args = process.env.RX_AGENT_BINARY ? ["acp", "-m", model] : [new URL("../src/cli.ts", import.meta.url).pathname, "acp", "-m", model];
const child = spawn(command, args, { env: { ...process.env, RX_HOME: home }, stdio: ["pipe", "pipe", "inherit"] });
const stream = acp.ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>);
let toolStarted = false;
let answer = "";
let applied: unknown;
const client = acp.client()
  .onNotification(acp.methods.client.session.update, ({ params }) => {
    if (params.update.sessionUpdate === "tool_call" && params.update.kind === "execute") toolStarted = true;
    if (params.update.sessionUpdate === "agent_message_chunk" && params.update.content.type === "text") answer += params.update.content.text;
  })
  .onNotification("_lody/session/steer_applied", (value: unknown) => value, ({ params }) => {
    applied = params;
    console.log("steer_applied", JSON.stringify(params));
  });
try {
  await client.connectWith(stream, async (ctx) => {
    const init = await ctx.request(acp.methods.agent.initialize, { protocolVersion: 1 });
    assert.equal((init.agentCapabilities?._meta?.lody as Record<string, unknown>)?.steering !== undefined, true);
    const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd, mcpServers: [] });
    const prompt = ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "Run exactly `sleep 4` with bash, then answer ORIGINAL only. Do not do anything else." }] });
    const deadline = Date.now() + 90_000;
    while (!toolStarted) {
      assert.ok(Date.now() < deadline, "the model did not start bash within 90 seconds");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const steerId = "rx-steer-smoke";
    const result = await ctx.request("_lody/session/steer", { sessionId, steerId, prompt: [{ type: "text", text: "Change the final answer. Reply with STEER_ACCEPTED_826 only, instead of ORIGINAL." }] });
    assert.deepEqual(result, { outcome: "injected" });
    assert.deepEqual(applied, { sessionId, steerId });
    assert.equal((await prompt).stopReason, "end_turn");
    assert.match(answer, /STEER_ACCEPTED_826/);
    assert.ok(readFileSync(join(home, "sessions", `${sessionId}.jsonl`), "utf8").includes("Change the final answer"));
    console.log("result", JSON.stringify(result), "stopReason", "end_turn", "answer", JSON.stringify(answer));
  });
} finally {
  child.kill();
}
