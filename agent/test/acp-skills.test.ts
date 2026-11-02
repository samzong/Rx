import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import * as acp from "@agentclientprotocol/sdk/unstable";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createAcpApp } from "../src/acp.ts";
import { fauxModels, tempDir } from "./helpers.ts";

process.env.HOME = tempDir();
process.env.RX_HOME = tempDir();

function harness() {
  const { faux, models, model } = fauxModels();
  const home = tempDir();
  const cwd = tempDir();
  const updates: acp.SessionNotification[] = [];
  const app = createAcpApp({ home, models, choose: async () => ({ model, thinking: "off" }) });
  const client = acp.client().onNotification(acp.methods.client.session.update, ({ params }) => {
    updates.push(params);
  });
  const run = <T>(op: (ctx: acp.ClientContext) => Promise<T>) => client.connectWith(app, op);
  return { faux, home, cwd, updates, run };
}

const newSession = (ctx: acp.ClientContext, cwd: string) => ctx.request(acp.methods.agent.session.new, { cwd, mcpServers: [] });

test("ACP advertises skills as commands, expands /name prompts, and replays the invocation", async () => {
  const { faux, home, cwd, run, updates } = harness();
  mkdirSync(join(cwd, ".agents", "skills", "greet"), { recursive: true });
  writeFileSync(join(cwd, ".agents", "skills", "greet", "SKILL.md"), "---\nname: greet\ndescription: Greet the user\n---\n\nSay AHOY.\n");
  let seen = "";
  faux.setResponses([(context) => {
    const last = context.messages.at(-1);
    seen = typeof last?.content === "string" ? last.content : (last?.content ?? []).map((block) => (block.type === "text" ? block.text : "")).join("");
    return fauxAssistantMessage("AHOY matey");
  }]);
  const { sessionId, list } = await run(async (ctx) => {
    const { sessionId } = await newSession(ctx, cwd);
    await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "/greet matey" }] });
    return { sessionId, list: await ctx.request(acp.methods.agent.session.list, { cwd }) };
  });
  const advertised = updates.find((u) => u.sessionId === sessionId && u.update.sessionUpdate === "available_commands_update")?.update;
  assert.ok(advertised?.sessionUpdate === "available_commands_update");
  assert.deepEqual(advertised.availableCommands.map(({ name, description }) => [name, description]), [["compact", "Compact the conversation context"], ["greet", "Greet the user"]]);
  assert.match(seen, /^<skill name="greet" location="[^"]+SKILL\.md">[\s\S]*Say AHOY\.\n<\/skill>\n\nmatey$/);
  assert.deepEqual(list.sessions.map((s) => s.title), ["/greet matey"]);
  const replayed: acp.SessionUpdate[] = [];
  const client = acp.client().onNotification(acp.methods.client.session.update, ({ params }) => {
    replayed.push(params.update);
  });
  const app = createAcpApp({ home, models: fauxModels().models, choose: async () => ({ model: fauxModels().model, thinking: "off" }) });
  await client.connectWith(app, (ctx) => ctx.request(acp.methods.agent.session.load, { sessionId, cwd, mcpServers: [] }));
  const user = replayed.find((u) => u.sessionUpdate === "user_message_chunk");
  assert.ok(user?.sessionUpdate === "user_message_chunk" && user.content.type === "text");
  assert.equal(user.content.text, "/greet matey");
});
