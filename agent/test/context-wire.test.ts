import assert from "node:assert/strict";
import { test } from "node:test";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { streamSimple as anthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as codex } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { fauxAssistantMessage, normalizeContext, type Api, type StreamFunction, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createRxAgent } from "../src/agent.ts";
import { contextControl } from "../src/context-control.ts";
import { SessionLog } from "../src/session-log.ts";
import { fauxModels, tempDir } from "./helpers.ts";

test("summary requests disable Anthropic thinking and use the minimum Codex effort", async () => {
  const builtins = builtinModels();
  for (const model of [builtins.getModel("anthropic", "claude-haiku-4-5")!, builtins.getModel("openai-codex", "gpt-6-sol")!]) {
    const { models } = fauxModels();
    let wire: any;
    let networkCalls = 0;
    const adapter = (model.api === "anthropic-messages" ? anthropic : codex) as StreamFunction<Api, SimpleStreamOptions>;
    models.streamSimple = (selected, context, options) => adapter(selected, normalizeContext(context), {
      ...options,
      apiKey: model.api === "anthropic-messages" ? "sk-fixture-not-a-credential" : `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.fixture`,
      fetch: async () => { networkCalls++; throw new Error("Unexpected network access"); },
      onPayload: (payload) => { wire = payload; throw new Error("Payload inspected"); },
    });
    const log = SessionLog.create(tempDir(), tempDir());
    const messages = [
      { role: "user" as const, content: `Keep a.txt unchanged. ${"prior evidence ".repeat(1300)}`, timestamp: Date.now() },
      fauxAssistantMessage("Pending verification."),
    ];
    for (const message of messages) log.append(message.role === "user" ? "cli" : "model", message);
    const agent = createRxAgent({ models, model: { ...model, contextWindow: 16384 }, cwd: log.cwd, thinking: "high", log, origin: "cli", systemPrompt: "Follow the user.", messages });
    await assert.rejects(contextControl(agent).compact());
    assert.equal(networkCalls, 0);
    assert.ok(wire);
    if (model.api === "anthropic-messages") {
      assert.ok(wire.thinking === undefined || wire.thinking.type === "disabled");
      assert.equal(wire.thinking?.budget_tokens, undefined);
    } else assert.equal(wire.reasoning?.effort, "none");
  }
});
