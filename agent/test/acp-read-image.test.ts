import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import * as acp from "@agentclientprotocol/sdk";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createAcpApp, type AcpOptions } from "../src/acp.ts";
import { SessionLog } from "../src/session-log.ts";
import { fauxModels, tempDir } from "./helpers.ts";

process.env.HOME = tempDir();
process.env.RX_HOME = tempDir();

function harness(choose?: AcpOptions["choose"]) {
  const { faux, models, model } = fauxModels();
  const home = tempDir();
  const cwd = tempDir();
  const updates: acp.SessionNotification[] = [];
  const app = createAcpApp({ home, models, choose: choose ?? (async () => ({ model, thinking: "off" })) });
  const client = acp.client().onNotification(acp.methods.client.session.update, ({ params }) => {
    updates.push(params);
  });
  const run = <T>(op: (ctx: acp.ClientContext) => Promise<T>) => client.connectWith(app, op);
  const kinds = (sessionId: string) => updates.filter((u) => u.sessionId === sessionId).map((u) => u.update.sessionUpdate);
  return { faux, home, cwd, updates, run, kinds };
}

const newSession = (ctx: acp.ClientContext, cwd: string) => ctx.request(acp.methods.agent.session.new, { cwd, mcpServers: [] });

test("read images reach the model and ACP tool cards, persist, and replay on load", async () => {
  const { faux, home, cwd, run, updates } = harness();
  const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=";
  const image = { type: "image" as const, data, mimeType: "image/png" };
  writeFileSync(join(cwd, "screen.png"), Buffer.from(data, "base64"));
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("read", { path: "screen.png" }, { id: "image-read" })], { stopReason: "toolUse" }),
    (context) => {
      const result = context.messages.find((message) => message.role === "toolResult");
      assert.ok(result?.role === "toolResult" && !result.isError);
      assert.deepEqual(result.content[1], image);
      return fauxAssistantMessage("image received");
    },
  ]);
  const sessionId = await run(async (ctx) => {
    const { sessionId } = await newSession(ctx, cwd);
    const response = await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "read screen.png" }] });
    assert.equal(response.stopReason, "end_turn");
    return sessionId;
  });
  const completed = updates.map(({ update }) => update).find((update) => update.sessionUpdate === "tool_call_update" && update.status === "completed");
  assert.ok(completed?.sessionUpdate === "tool_call_update");
  assert.deepEqual(completed.content?.[1], { type: "content", content: image });
  const loaded = SessionLog.open(home, sessionId);
  assert.deepEqual(loaded.messages.find((message) => message.role === "toolResult")?.content[1], image);
  const replay: acp.SessionUpdate[] = [];
  const { models, model } = fauxModels();
  const app = createAcpApp({ home, models, choose: async () => ({ model, thinking: "off" }) });
  const client = acp.client().onNotification(acp.methods.client.session.update, ({ params }) => { replay.push(params.update); });
  await client.connectWith(app, (ctx) => ctx.request(acp.methods.agent.session.load, { sessionId, cwd, mcpServers: [] }));
  assert.deepEqual(replay.find((update) => update.sessionUpdate === "tool_call_update"), completed);
});
