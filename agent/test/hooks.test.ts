import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import * as acp from "@agentclientprotocol/sdk";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createRxAgent } from "../src/agent.ts";
import { createAcpApp } from "../src/acp.ts";
import { loadHooks } from "../src/hook-config.ts";
import { hookControl } from "../src/hooks.ts";
import { listSessions, SessionLog } from "../src/session-log.ts";
import { fauxModels, tempDir } from "./helpers.ts";

process.env.HOME = tempDir();
process.env.RX_HOME = tempDir();

function setup(events: string[], body: string) {
  const home = tempDir();
  const cwd = tempDir();
  const trace = join(home, "trace.jsonl");
  const script = join(home, "hook.mjs");
  writeFileSync(script, `import {appendFileSync} from 'node:fs'; let text=''; for await (const chunk of process.stdin) text+=chunk; const input=JSON.parse(text); appendFileSync(${JSON.stringify(trace)},JSON.stringify(input)+'\\n'); ${body}`);
  const hooks = Object.fromEntries(events.map((event) => [event, [{ hooks: [{ type: "command", command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}` }] }]]));
  writeFileSync(join(home, "hooks.json"), JSON.stringify({ hooks }));
  const records = () => existsSync(trace) ? readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  return { home, cwd, records };
}

test("pre denial and post failure preserve per-call execution, output, status, and replay", async () => {
  const { home, cwd, records } = setup(["PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop"], `
    if(input.hook_event_name==='PreToolUse' && input.tool_input.command?.includes('denied')) console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'marker denied'}}));
    if(input.hook_event_name==='PostToolUse') console.log(JSON.stringify({decision:'block',reason:'post marker failed'}));
  `);
  const { faux, models, model } = fauxModels();
  faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall("bash", { command: "touch denied" }, { id: "deny" }),
      fauxToolCall("bash", { command: "touch allowed; echo ORIGINAL_OUTPUT" }, { id: "allow" }),
      fauxToolCall("bash", { command: "exit 7" }, { id: "failure" }),
      fauxToolCall("bash", {}, { id: "invalid" }),
    ], { stopReason: "toolUse" }),
    (context) => {
      assert.match(JSON.stringify(context), /marker denied/);
      assert.match(JSON.stringify(context), /ORIGINAL_OUTPUT/);
      assert.match(JSON.stringify(context), /post marker failed/);
      return fauxAssistantMessage("checks reported");
    },
  ]);
  const updates: acp.SessionUpdate[] = [];
  const client = acp.client().onNotification(acp.methods.client.session.update, ({ params }) => { updates.push(params.update); });
  const app = createAcpApp({ home, models, choose: async () => ({ model, thinking: "off" }) });
  await client.connectWith(app, async (ctx) => {
    const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd, mcpServers: [] });
    const response = await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "mixed checks" }] });
    assert.equal(response.stopReason, "end_turn");
    assert.equal(existsSync(join(cwd, "denied")), false);
    assert.equal(existsSync(join(cwd, "allowed")), true);
    const finalized = updates.filter((update) => update.sessionUpdate === "tool_call_update");
    for (const id of ["deny", "allow", "failure", "invalid"]) assert.ok(finalized.some((update) => update.toolCallId === id && update.status === "failed"));
    const loaded = SessionLog.open(home, sessionId);
    const results = loaded.messages.filter((message) => message.role === "toolResult");
    assert.deepEqual(results.map((message) => message.toolCallId), ["deny", "allow", "failure", "invalid"]);
    assert.match(JSON.stringify(results[1]), /ORIGINAL_OUTPUT.*post marker failed/);
    const toolEvents = records().filter((entry) => entry.tool_use_id);
    assert.deepEqual(toolEvents.filter((entry) => entry.tool_use_id === "deny").map((entry) => entry.hook_event_name), ["PreToolUse"]);
    assert.deepEqual(toolEvents.filter((entry) => entry.tool_use_id === "failure").map((entry) => entry.hook_event_name), ["PreToolUse", "PostToolUseFailure"]);
    assert.equal(toolEvents.some((entry) => entry.tool_use_id === "invalid"), false);
    const count = records().length;
    updates.length = 0;
    await ctx.request(acp.methods.agent.session.load, { sessionId, cwd, mcpServers: [] });
    assert.equal(records().length, count);
    assert.ok(updates.some((update) => update.sessionUpdate === "tool_call_update" && update.toolCallId === "allow" && update.status === "failed" && JSON.stringify(update.content).includes("ORIGINAL_OUTPUT")));
  });
});

test("chained pre rewrites are revalidated, executed, logged, shown on the same ACP card, and replayed", async () => {
  const { home, cwd, records } = setup(["PreToolUse", "PostToolUse"], `
    const rewrites={'echo ORIGINAL':{command:'echo REWRITTEN',timeout:'5'},'touch blocked':{}};
    const updatedInput=input.hook_event_name==='PreToolUse'?rewrites[input.tool_input.command]:undefined;
    if(updatedInput) console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecisionReason:'rewrite',updatedInput}}));
  `);
  const configuration = JSON.parse(readFileSync(join(home, "hooks.json"), "utf8"));
  configuration.hooks.PreToolUse[0].hooks.push(configuration.hooks.PreToolUse[0].hooks[0]);
  writeFileSync(join(home, "hooks.json"), JSON.stringify(configuration));
  const effective = { command: "echo REWRITTEN", timeout: 5 };
  const { faux, models, model } = fauxModels();
  faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall("bash", { command: "echo ORIGINAL" }, { id: "rewrite" }),
      fauxToolCall("bash", { command: "touch blocked" }, { id: "invalid" }),
    ], { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ]);
  const updates: acp.SessionUpdate[] = [];
  const client = acp.client().onNotification(acp.methods.client.session.update, ({ params }) => { updates.push(params.update); });
  const app = createAcpApp({ home, models, choose: async () => ({ model, thinking: "off" }) });
  await client.connectWith(app, async (ctx) => {
    const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd, mcpServers: [] });
    await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "rewrite" }] });
    const rewritten = records().filter((entry) => entry.tool_use_id === "rewrite");
    assert.deepEqual(rewritten.map((entry) => [entry.hook_event_name, entry.tool_input]), [["PreToolUse", { command: "echo ORIGINAL" }], ["PreToolUse", effective], ["PostToolUse", effective]]);
    assert.deepEqual(records().filter((entry) => entry.tool_use_id === "invalid").map((entry) => entry.hook_event_name), ["PreToolUse"]);
    assert.equal(existsSync(join(cwd, "blocked")), false);
    const loaded = SessionLog.open(home, sessionId);
    const results = loaded.messages.filter((message) => message.role === "toolResult");
    assert.match(JSON.stringify(results[0]?.content), /REWRITTEN/);
    assert.doesNotMatch(JSON.stringify(results[0]?.content), /ORIGINAL/);
    assert.equal(results[1]?.isError, true);
    assert.match(JSON.stringify(loaded.messages), /"arguments":\{"command":"echo ORIGINAL"\}/);
    assert.deepEqual([...loaded.inputs], [["rewrite", effective]]);
    assert.ok(updates.some((update) => update.sessionUpdate === "tool_call_update" && update.toolCallId === "rewrite" && update.title?.includes("REWRITTEN") && JSON.stringify(update.rawInput) === JSON.stringify(effective)));
    const count = records().length;
    updates.length = 0;
    await ctx.request(acp.methods.agent.session.load, { sessionId, cwd, mcpServers: [] });
    assert.equal(records().length, count);
    assert.ok(updates.some((update) => update.sessionUpdate === "tool_call" && update.toolCallId === "rewrite" && JSON.stringify(update.rawInput) === JSON.stringify(effective)));
  });
});

test("hook contexts have rx origin, enter the model once, and replay as labeled agent notices", async () => {
  const { home, cwd, records } = setup(["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse"], `
    console.log(JSON.stringify({hookSpecificOutput:{hookEventName:input.hook_event_name,additionalContext:'CONTEXT_'+input.hook_event_name}}));
  `);
  const { faux, models, model } = fauxModels();
  faux.setResponses([
    (context) => {
      assert.equal(JSON.stringify(context.messages).split("CONTEXT_SessionStart").length - 1, 1);
      assert.equal(JSON.stringify(context.messages).split("CONTEXT_UserPromptSubmit").length - 1, 1);
      return fauxAssistantMessage([fauxToolCall("bash", { command: "echo ok" }, { id: "context-tool" })], { stopReason: "toolUse" });
    },
    (context) => {
      for (const event of ["PreToolUse", "PostToolUse"]) assert.equal(JSON.stringify(context.messages).split(`CONTEXT_${event}`).length - 1, 1);
      return fauxAssistantMessage("received");
    },
  ]);
  const updates: acp.SessionUpdate[] = [];
  const app = createAcpApp({ home, models, choose: async () => ({ model, thinking: "off" }) });
  const client = acp.client().onNotification(acp.methods.client.session.update, ({ params }) => { updates.push(params.update); });
  await client.connectWith(app, async (ctx) => {
    const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd, mcpServers: [] });
    await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "user request" }] });
    const loaded = SessionLog.open(home, sessionId);
    const contexts = loaded.entries.filter((entry) => entry.origin === "rx" && entry.message.role === "user");
    assert.equal(contexts.length, 4);
    assert.equal(listSessions(home)[0]?.title, "user request");
    for (const entry of contexts) assert.match(JSON.stringify(entry.message), /Hook-provided context/);
    const count = records().length;
    updates.length = 0;
    await ctx.request(acp.methods.agent.session.load, { sessionId, cwd, mcpServers: [] });
    const fresh = records().slice(count);
    assert.deepEqual(fresh.map((entry) => [entry.hook_event_name, entry.source]), [["SessionStart", "resume"]]);
    const contextUpdates = updates.filter((update) => JSON.stringify(update).includes("Hook-provided context"));
    assert.equal(contextUpdates.length, 4);
    assert.ok(contextUpdates.every((update) => update.sessionUpdate === "agent_message_chunk"));
    assert.equal(SessionLog.open(home, sessionId).entries.filter((entry) => entry.origin === "rx").length, 4);
  });
});

test("a rejected ACP prompt has no model access or accepted user record, even after a model error", async () => {
  const { home, cwd, records } = setup(["UserPromptSubmit", "Stop"], `
    if(input.prompt==='reject') { console.error('prompt denied'); process.exitCode=2; }
  `);
  const { faux, models, model } = fauxModels();
  faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "earlier failure" })]);
  const notices: acp.SessionUpdate[] = [];
  const app = createAcpApp({ home, models, choose: async () => ({ model, thinking: "off" }) });
  const client = acp.client().onNotification(acp.methods.client.session.update, ({ params }) => { notices.push(params.update); });
  await client.connectWith(app, async (ctx) => {
    const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd, mcpServers: [] });
    const prompt = (text: string) => ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text }] });
    await assert.rejects(prompt("fail"), /earlier failure/);
    assert.equal((await prompt("reject")).stopReason, "end_turn");
    assert.equal(SessionLog.open(home, sessionId).messages.filter((message) => message.role === "user").length, 1);
    assert.ok(notices.some((update) => JSON.stringify(update).includes("Prompt rejected")));
    assert.equal(records().some((entry) => entry.hook_event_name === "Stop"), false);
  });
});

test("Stop failure is observable without continuing the model or changing completed results", async () => {
  const { home, cwd, records } = setup(["Stop"], "console.error('final check refused'); process.exitCode=2;");
  const { faux, models, model } = fauxModels();
  faux.setResponses([fauxAssistantMessage("done")]);
  const log = SessionLog.create(home, cwd);
  const agent = createRxAgent({ models, model, thinking: "off", cwd, systemPrompt: "test", log, origin: "cli", hooks: loadHooks(home) });
  const notices: string[] = [];
  hookControl(agent)!.subscribe((notice) => {
    if ("text" in notice) notices.push(notice.text);
  });
  await hookControl(agent)!.start("startup");
  await agent.prompt("finish");
  assert.deepEqual(records().map((entry) => entry.hook_event_name), ["Stop"]);
  assert.match(notices.join(""), /Final check failed.*final check refused/s);
  assert.equal(agent.state.messages.filter((message) => message.role === "assistant").length, 1);
});

test("post protocol errors preserve executed output and still run later checks", async () => {
  const { home, cwd, records } = setup(["PostToolUse"], "console.log(JSON.stringify({updatedToolOutput:'forbidden replacement'}));");
  const config = JSON.parse(readFileSync(join(home, "hooks.json"), "utf8"));
  config.hooks.PostToolUse[0].hooks.push({ type: "command", command: "touch checked-later" });
  writeFileSync(join(home, "hooks.json"), JSON.stringify(config));
  const { faux, models, model } = fauxModels();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("bash", { command: "echo PRESERVED_RESULT" }, { id: "post-protocol" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("reported"),
  ]);
  const log = SessionLog.create(home, cwd);
  const agent = createRxAgent({ models, model, thinking: "off", cwd, systemPrompt: "test", log, origin: "cli", hooks: loadHooks(home) });
  await agent.prompt("run");
  assert.equal(records().length, 1);
  assert.equal(existsSync(join(cwd, "checked-later")), true);
  const result = SessionLog.open(home, log.id).messages.find((message) => message.role === "toolResult");
  assert.ok(result?.role === "toolResult" && result.isError);
  assert.match(JSON.stringify(result.content), /PRESERVED_RESULT.*Validation failed.*unsupported field/);
  assert.doesNotMatch(JSON.stringify(result.content), /forbidden replacement/);
});

for (const event of ["UserPromptSubmit", "Stop"]) {
  test(`ACP cancels a ${event} hook outside the core model loop`, { timeout: 10_000 }, async () => {
    const { home, cwd, records } = setup([event], "setInterval(()=>{},1000); await new Promise(()=>{});");
    const { faux, models, model } = fauxModels();
    faux.setResponses([fauxAssistantMessage("completed before Stop")]);
    const app = createAcpApp({ home, models, choose: async () => ({ model, thinking: "off" }) });
    await acp.client().connectWith(app, async (ctx) => {
      const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd, mcpServers: [] });
      const pending = ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "cancel hook" }] });
      const deadline = Date.now() + 5_000;
      while (!records().length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(records().length, 1);
      await ctx.notify(acp.methods.agent.session.cancel, { sessionId });
      assert.equal((await pending).stopReason, "cancelled");
      const loaded = SessionLog.open(home, sessionId);
      const last = loaded.messages.at(-1);
      assert.ok(last?.role === "assistant" && last.stopReason === "aborted");
      if (event === "UserPromptSubmit") assert.equal(loaded.messages.some((message) => message.role === "user"), false);
      else assert.equal(loaded.messages.filter((message) => message.role === "assistant").length, 2);
    });
  });
}

test("MCP calls use the same preflight and final-result boundaries", async () => {
  const { home, cwd, records } = setup(["PreToolUse", "PostToolUse"], `
    if(input.hook_event_name==='PreToolUse' && input.tool_input.value==='DENY') console.log(JSON.stringify({decision:'block',reason:'MCP denied'}));
  `);
  const { faux, models, model } = fauxModels();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("mcp__fixture__echo", { value: "DENY" }, { id: "mcp-deny" }), fauxToolCall("mcp__fixture__echo", { value: "ALLOW" }, { id: "mcp-allow" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ]);
  const app = createAcpApp({ home, models, choose: async () => ({ model, thinking: "off" }) });
  await acp.client().connectWith(app, async (ctx) => {
    const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd, mcpServers: [{ name: "fixture", command: process.execPath, args: [new URL("./fixtures/mcp-server.ts", import.meta.url).pathname], env: [] }] });
    assert.equal((await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "MCP checks" }] })).stopReason, "end_turn");
    const results = SessionLog.open(home, sessionId).messages.filter((message) => message.role === "toolResult");
    assert.equal(results[0]?.isError, true);
    assert.match(JSON.stringify(results[0]), /MCP denied/);
    assert.equal(results[1]?.isError, false);
    assert.deepEqual(records().map((entry) => [entry.hook_event_name, entry.tool_use_id]), [["PreToolUse", "mcp-deny"], ["PreToolUse", "mcp-allow"], ["PostToolUse", "mcp-allow"]]);
  });
});
