import assert from "node:assert/strict";
import { test } from "node:test";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { streamSimple as responses } from "@earendil-works/pi-ai/api/openai-responses";
import { streamSimple as anthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { fauxAssistantMessage, fauxToolCall, type Api, type Model, normalizeContext, type StreamFunction, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { visibleMessage } from "../src/context.ts";

const builtins = builtinModels();

for (const api of ["openai-responses", "anthropic-messages"] as const) {
  for (const kind of ["custom", "builtin"] as const) {
    test(`compacted ${kind} ${api} payload keeps images and output cap without old signatures or tool protocol`, async () => {
      const builtin = builtins.getModel(api === "openai-responses" ? "openai" : "anthropic", api === "openai-responses" ? "gpt-4.1" : "claude-haiku-4-5")!;
      const model: Model<Api> = kind === "builtin" ? { ...builtin, maxTokens: 1024 } : {
        id: "fixture-model", name: "Fixture", api, provider: "fixture", baseUrl: "http://127.0.0.1:1/v1", reasoning: true,
        input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024,
        ...(api === "anthropic-messages" ? { compat: { forceAdaptiveThinking: true }, thinkingLevelMap: { off: null, high: "high" } } : {}),
      };
      const old = { ...fauxAssistantMessage([{ type: "thinking", thinking: "old hidden reasoning", thinkingSignature: "old-thinking-signature" }, { type: "text", text: "visible answer", textSignature: "old-text-signature" }, fauxToolCall("bash", { command: "touch already-done" }, { id: "old-call" })]), api, provider: model.provider, model: model.id };
      const context = normalizeContext({ messages: [
        { role: "system", content: "Current authoritative instructions", timestamp: 0 },
        { role: "user", content: "Rx summary of earlier work. Do not repeat recorded tools.", timestamp: 1 },
        visibleMessage(old)!,
        { role: "user", content: [{ type: "text", text: "continue with this image" }, { type: "image", data: "AAAA", mimeType: "image/png" }], timestamp: 2 },
      ] });
      let wire: any;
      let networkCalls = 0;
      const adapter = (api === "openai-responses" ? responses : anthropic) as StreamFunction<Api, SimpleStreamOptions>;
      const response = await adapter(model, context, {
        apiKey: "sk-fixture-not-a-credential", reasoning: "high", maxTokens: 1024,
        fetch: async () => { networkCalls++; throw new Error("Unexpected network access"); },
        onPayload: (payload) => { wire = payload; throw new Error("Payload inspected"); },
      }).result();
      assert.match(response.errorMessage ?? "", /Payload inspected/);
      assert.equal(networkCalls, 0);
      assert.ok(wire);
      const serialized = JSON.stringify(wire);
      assert.doesNotMatch(serialized, /old hidden reasoning|old-thinking-signature|old-text-signature|"tool_use"|"function_call"|"tool_result"/);
      assert.match(serialized, /visible answer/);
      assert.match(serialized, /Recorded tool call bash/);
      assert.match(serialized, /AAAA/);
      assert.equal(wire.max_output_tokens ?? wire.max_tokens, 1024);
      assert.equal(wire.context_management, undefined);
    });
  }
}

test("small Anthropic summaries disable thinking instead of sending an invalid budget", async () => {
  const model = { ...builtins.getModel("anthropic", "claude-haiku-4-5")!, maxTokens: 1500 } as Model<"anthropic-messages">;
  let wire: any;
  await anthropic(model, normalizeContext({ messages: [{ role: "user", content: "Summarize earlier work", timestamp: 1 }] }), {
    apiKey: "sk-fixture-not-a-credential", reasoning: undefined, maxTokens: 1500,
    onPayload: (payload) => { wire = payload; throw new Error("Payload inspected"); },
  }).result();
  assert.equal(wire.max_tokens, 1500);
  assert.ok(wire.thinking === undefined || wire.thinking.type === "disabled");
});

test("Codex summaries request the lowest mapped effort and expose the missing provider cap", async () => {
  const { streamSimple } = await import("@earendil-works/pi-ai/api/openai-codex-responses");
  const model = { ...builtins.getModels("openai-codex")[0]!, maxTokens: 1500 } as Model<"openai-codex-responses">;
  assert.ok(model.id);
  let wire: any;
  await streamSimple(model, normalizeContext({ messages: [{ role: "user", content: "Summarize earlier work", timestamp: 1 }] }), {
    apiKey: `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.fixture`, reasoning: undefined, maxTokens: 1500,
    onPayload: (payload) => { wire = payload; throw new Error("Payload inspected"); },
  }).result();
  assert.ok(wire);
  assert.equal(wire.max_output_tokens, undefined);
  assert.equal(wire.reasoning?.effort, model.thinkingLevelMap?.off === null ? undefined : model.thinkingLevelMap?.off ?? "none");
});
