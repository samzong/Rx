import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import { type Context, type Tool, validateToolArguments } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { createRxAgent } from "../src/agent.ts";
import { connectMcp, mcpStreamOptions } from "../src/mcp.ts";
import { applyHandoff, type Handoff } from "../src/rx-provider.ts";
import { SessionLog } from "../src/session-log.ts";
import { tempDir } from "./helpers.ts";

const schema = {
  type: "object",
  properties: { seat: { $ref: "#/$defs/Seat" }, metadata: { $ref: "#/definitions/Metadata" } },
  required: ["seat"],
  $defs: { Seat: { type: "object", properties: { name: { type: "string" }, children: { type: "array", items: { $ref: "#/$defs/Seat" } } }, required: ["name"] } },
  definitions: { Metadata: { type: "object", properties: { label: { type: "string" } } } },
  anyOf: [{ required: ["seat"] }],
};

function response(api: Handoff["api"]): Response {
  const events: Record<string, unknown>[] = api === "anthropic-messages" ? [
    { type: "message_start", message: { id: "m1", type: "message", role: "assistant", model: "probe", content: [], usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ] : api === "openai-responses" ? [
    { type: "response.created", response: { id: "r1" } },
    { type: "response.completed", response: { id: "r1", status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } } },
  ] : [{ id: "c1", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: "stop" }] }];
  return new Response(events.map((event) => `${api === "anthropic-messages" ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

function provider(api: Handoff["api"]) {
  const models = builtinModels();
  applyHandoff(models, { id: "fixture", name: "Fixture", api, baseUrl: "http://127.0.0.1:9", env: "RX_MCP_SCHEMA_TEST_KEY", models: [{ id: "probe", contextWindow: 200000, reasoning: false }], defaultModel: "probe" });
  return { models, model: models.getModel("fixture", "probe")! };
}

test("MCP reference targets survive provider serialization and object validation", async () => {
  const home = tempDir();
  const cwd = tempDir();
  const mcp = await connectMcp({ home, cwd, servers: [{ name: "fixture", command: process.execPath, args: [new URL("./fixtures/mcp-ref-server.ts", import.meta.url).pathname, JSON.stringify(schema)], env: [] }] });
  try {
    assert.deepEqual(mcp.warnings, []);
    const tool = mcp.tools[0]!;
    const args = { seat: { name: "parent", children: [{ name: "child" }] }, metadata: { label: "desk" } };
    const validated = validateToolArguments(tool, { type: "toolCall", id: "call", name: tool.name, arguments: args });
    assert.throws(() => validateToolArguments(tool, { type: "toolCall", id: "bad", name: tool.name, arguments: { seat: JSON.stringify(args.seat) } }));
    assert.deepEqual((await tool.execute("call", validated)).content, [{ type: "text", text: JSON.stringify(args) }]);
    for (const api of ["anthropic-messages", "openai-completions", "openai-responses"] as const) {
      const { models, model } = provider(api);
      let body: Record<string, any> | undefined;
      const stream = models.streamSimple.bind(models);
      models.streamSimple = (selected, context, options) => stream(selected, context, { ...options, apiKey: "local-fixture", maxRetries: 0, fetch: async (_url, init) => { body = JSON.parse(init!.body as string); return response(api); } });
      const log = SessionLog.create(home, cwd);
      const agent = createRxAgent({ models, model, thinking: "off", cwd, systemPrompt: "Inspect tools", log, origin: "acp", tools: mcp.tools });
      await agent.prompt("Inspect the seat schema");
      assert.ok(body);
      const sent = body.tools.find((entry: any) => (entry.name ?? entry.function?.name) === tool.name);
      const parameters = sent.input_schema ?? sent.parameters ?? sent.function.parameters;
      assert.deepEqual(parameters.$defs, schema.$defs);
      assert.deepEqual(parameters.definitions, schema.definitions);
      assert.deepEqual(parameters.properties, schema.properties);
      if (api === "anthropic-messages") assert.equal(parameters.anyOf, undefined);
      else assert.deepEqual(parameters, JSON.parse(JSON.stringify(tool.parameters)));
      assert.equal(agent.state.messages.at(-1)?.role, "assistant");
    }
  } finally { await mcp.close(); }
});

test("Anthropic inline tool definitions retain their own reference targets after a same-name redefinition", async () => {
  const { models, model } = provider("anthropic-messages");
  model.compat = { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true };
  const old: Tool = { name: "mcp__fixture__seat", description: "Old seat", parameters: Type.Unsafe(schema) };
  const nextDefinitions = { Seat: { type: "object", properties: { count: { type: "number" } } } };
  const next: Tool = { ...old, parameters: Type.Unsafe({ ...schema, properties: { ...schema.properties }, $defs: nextDefinitions }) };
  const context: Context = { messages: [
    { role: "system", content: "Use tools", toolsAdded: [old], timestamp: 1 },
    { role: "user", content: "First turn", timestamp: 2 },
    { role: "system", content: "New tools", toolsAdded: [next], timestamp: 3 },
    { role: "user", content: "Next turn", timestamp: 4 },
  ] };
  let body: Record<string, any> | undefined;
  let observed = false;
  const stream = models.streamSimple(model, context, mcpStreamOptions(model, context, {
    apiKey: "local-fixture", maxRetries: 0,
    onPayload: (payload) => { observed = true; return { ...payload as object, metadata: { user_id: "fixture" } }; },
    fetch: async (_url, init) => { body = JSON.parse(init!.body as string); return response("anthropic-messages"); },
  }));
  assert.equal((await stream.result()).stopReason, "stop");
  assert.ok(body && observed);
  assert.deepEqual(body.tools.find((tool: any) => tool.name === old.name).input_schema.$defs, schema.$defs);
  const addition = body.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : []).find((block: any) => block.type === "tool_addition");
  assert.deepEqual(addition.tool.definition.input_schema.$defs, nextDefinitions);
  assert.deepEqual(body.metadata, { user_id: "fixture" });
});
