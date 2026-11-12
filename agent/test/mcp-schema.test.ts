import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import { type Context, type JsonObject, type Tool, validateToolArguments } from "@earendil-works/pi-ai";
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

function provider(api: Handoff["api"], id = "fixture") {
  const models = builtinModels();
  applyHandoff(models, { id, name: "Fixture", api, baseUrl: "http://127.0.0.1:9", env: "RX_MCP_SCHEMA_TEST_KEY", models: [{ id: "probe", contextWindow: 200000, reasoning: false }], defaultModel: "probe" });
  return { models, model: models.getModel(id, "probe")! };
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

test("Tokener MCP schemas preserve literal $ref arguments and constraints without changing other providers", async () => {
  const input = {
    type: "object",
    properties: { item: { $ref: "#/$defs/Item" }, copy: { $ref: "#/$defs/Item/properties/$ref" } },
    required: ["item"],
    $defs: { Item: {
      type: "object", properties: { $ref: { type: "string", minLength: 2 } }, required: ["$ref"], additionalProperties: false,
      patternProperties: { "^\\$ref$": { maxLength: 5 } },
      examples: [{ properties: { $ref: { type: "number" } } }],
    } },
  };
  const original = JSON.stringify(input);
  const tool: Tool = { name: "mcp__fixture__ref", description: "Read a reference", parameters: Type.Unsafe(input) };
  const ordinary = { ...tool, name: "mcp__fixture__ordinary", parameters: Type.Unsafe(schema) };
  const context: Context = { tools: [tool, ordinary, { ...tool, name: "builtin_reference" }], messages: [{ role: "user", content: "Inspect tools", timestamp: 1 }] };
  for (const api of ["anthropic-messages", "openai-completions", "openai-responses"] as const) {
    const { model } = provider(api);
    const capture = async (tokener: boolean) => {
      const { models, model: selected } = provider(api, tokener ? "tokener" : "fixture");
      let body: Record<string, any> | undefined;
      const options = mcpStreamOptions(selected, context, {
        apiKey: "local-fixture", maxRetries: 0,
        fetch: async (_url, init) => { body = JSON.parse(init!.body as string); return response(api); },
      });
      const result = await models.streamSimple(selected, context, options).result();
      assert.equal(result.stopReason, "stop", result.errorMessage ?? "Provider stream failed");
      assert.ok(body);
      return body;
    };
    const before = await capture(false);
    const after = await capture(true);
    const definition = (body: Record<string, any>) => {
      const sent = body.tools[0];
      return sent.input_schema ?? sent.parameters ?? sent.function.parameters;
    };
    const sent = definition(after);
    assert.equal(JSON.stringify(after.tools.slice(1)), JSON.stringify(before.tools.slice(1)));
    assert.equal(Object.hasOwn(sent.$defs.Item.properties, "$ref"), false);
    assert.deepEqual(sent.$defs.Item.examples, input.$defs.Item.examples);
    assert.deepEqual(sent.$defs.Item.required, ["$ref"]);
    assert.equal(JSON.stringify(input), original);
    const valid: JsonObject[] = [{ item: { $ref: "abc" }, copy: "ab" }, { item: { $ref: "abcd" } }];
    const invalid: JsonObject[] = [{ item: {} }, { item: { $ref: "a" } }, { item: { $ref: "abcdef" } }, { item: { $ref: "abc", "$ref\n": "abc" } }, { item: { $ref: "abc", extra: 1 } }, { item: { $ref: "abc" }, copy: "a" }];
    for (const parameters of [input, sent]) {
      const candidate = { ...tool, parameters: Type.Unsafe(parameters) };
      for (const args of valid) assert.deepEqual(validateToolArguments(candidate, { type: "toolCall", id: "ok", name: tool.name, arguments: args }), args);
      for (const args of invalid) assert.throws(() => validateToolArguments(candidate, { type: "toolCall", id: "bad", name: tool.name, arguments: args }));
    }
    assert.equal(JSON.stringify(await capture(true)), JSON.stringify(after));
    assert.equal(JSON.stringify(await capture(false)), JSON.stringify(before));
    if (api === "anthropic-messages") {
      const root = { type: "object", properties: { $ref: { type: "string" } }, required: ["$ref"], additionalProperties: false };
      const payload = { messages: [{ content: [{ type: "tool_addition", tool: { type: "tool_definition", definition: { name: tool.name, input_schema: root } } }] }] };
      const options = mcpStreamOptions({ ...model, provider: "tokener" }, context, {});
      const rewritten = await options.onPayload!(payload, model) as typeof payload;
      const parameters = rewritten.messages[0]!.content[0]!.tool.definition.input_schema;
      assert.equal(Object.hasOwn(parameters.properties, "$ref"), false);
      assert.deepEqual(validateToolArguments({ ...tool, parameters: Type.Unsafe(parameters) }, { type: "toolCall", id: "inline", name: tool.name, arguments: { $ref: "abc" } }), { $ref: "abc" });
      assert.deepEqual(root.properties, { $ref: { type: "string" } });
      assert.throws(() => validateToolArguments({ ...tool, parameters: Type.Unsafe(root) }, { type: "toolCall", id: "newline", name: tool.name, arguments: { $ref: "abc", "$ref\n": "abc" } }));
    }
  }
});
