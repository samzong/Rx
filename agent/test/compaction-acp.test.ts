import assert from "node:assert/strict";
import { test } from "node:test";
import * as acp from "@agentclientprotocol/sdk/unstable";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createAcpApp } from "../src/acp.ts";
import { fauxModels, tempDir } from "./helpers.ts";

process.env.HOME = tempDir();
process.env.RX_HOME = tempDir();

test("resource, image, arguments, and quoted command content stay ordinary prompts", async () => {
  const { faux, models, model } = fauxModels();
  const app = createAcpApp({ home: tempDir(), models, choose: async () => ({ model, thinking: "off" }) });
  const cases: acp.ContentBlock[][] = [
    [{ type: "text", text: "/compact" }, { type: "image", data: "AAAA", mimeType: "image/png" }],
    [{ type: "text", text: "/compact" }, { type: "resource", resource: { uri: "file:///note", text: "" } }],
    [{ type: "resource", resource: { uri: "file:///note", text: "/compact" } }],
    [{ type: "text", text: "/compact" }, { type: "resource_link", name: "", uri: "file:///note" }],
    [{ type: "text", text: "/compact focus" }],
    [{ type: "text", text: "`/compact`" }],
    [{ type: "text", text: "/com" }, { type: "text", text: "pact" }],
  ];
  faux.setResponses(cases.map(() => fauxAssistantMessage("ordinary prompt")));
  await acp.client().connectWith(app, async (ctx) => {
    await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { session: { compaction: {} } } });
    const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd: tempDir(), mcpServers: [] });
    for (const blocks of cases) assert.equal((await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: blocks })).stopReason, "end_turn");
    assert.equal(faux.state.callCount, cases.length);
  });
});
