import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { resolveModel } from "../src/models.ts";
import { applyHandoff, parseHandoff } from "../src/rx-provider.ts";

function handoff(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: "acme",
    name: "Acme",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:9/v1",
    env: "ACME_TEST_API_KEY",
    models: [
      {
        id: "think-1",
        contextWindow: 200000,
        reasoning: true,
        thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null },
      },
      { id: "plain-1", name: "Plain One", contextWindow: 64000, reasoning: false },
    ],
    ...overrides,
  });
}

test("an rx handoff registers its provider, catalog, and reasoning levels", async () => {
  const models = builtinModels();
  applyHandoff(models, parseHandoff(handoff()));
  assert.deepEqual(
    models.getModels("acme").map((model) => model.id),
    ["think-1", "plain-1"],
  );
  const think = models.getModel("acme", "think-1")!;
  assert.equal(think.baseUrl, "http://127.0.0.1:9/v1");
  assert.deepEqual(getSupportedThinkingLevels(think), ["off", "low", "medium", "high"]);
  assert.deepEqual(getSupportedThinkingLevels(models.getModel("acme", "plain-1")!), ["off"]);
  await assert.rejects(resolveModel(models, "acme/think-1", "max"), /no credentials for provider "acme"/);
  process.env.ACME_TEST_API_KEY = "test-key";
  try {
    assert.equal((await resolveModel(models, "acme/think-1", "max")).thinking, "high");
  } finally {
    delete process.env.ACME_TEST_API_KEY;
  }
});

test("a handoff for a built-in provider endpoint keeps pi-ai model metadata", () => {
  const models = builtinModels();
  const builtin = models.getModel("deepseek", "deepseek-flash")!;
  applyHandoff(
    models,
    parseHandoff(
      handoff({
        id: "deepseek",
        name: "DeepSeek",
        baseUrl: "https://api.deepseek.com/v1",
        env: "DEEPSEEK_API_KEY",
        models: [
          { id: "deepseek-flash", contextWindow: 200000, reasoning: false },
          { id: "deepseek-next", contextWindow: 200000, reasoning: false },
        ],
      }),
    ),
  );
  assert.deepEqual(
    models.getModels("deepseek").map((model) => model.id),
    ["deepseek-flash", "deepseek-next"],
  );
  assert.deepEqual(models.getModel("deepseek", "deepseek-flash"), builtin);
  assert.equal(models.getModel("deepseek", "deepseek-next")!.reasoning, false);
});

test("a handoff to another endpoint does not borrow built-in metadata", () => {
  const models = builtinModels();
  applyHandoff(
    models,
    parseHandoff(
      handoff({
        id: "deepseek",
        baseUrl: "https://proxy.example/v1",
        models: [{ id: "deepseek-flash", contextWindow: 200000, reasoning: false }],
      }),
    ),
  );
  const model = models.getModel("deepseek", "deepseek-flash")!;
  assert.equal(model.baseUrl, "https://proxy.example/v1");
  assert.equal(model.reasoning, false);
  assert.equal(model.compat, undefined);
});

test("malformed handoffs fail closed", () => {
  assert.throws(() => parseHandoff("{"), /RX_AGENT_PROVIDER: invalid JSON/);
  assert.throws(() => parseHandoff(handoff({ api: "anthropic-messages" })), /unsupported api "anthropic-messages"/);
  assert.throws(() => parseHandoff(handoff({ models: [] })), /models must be a non-empty array/);
  assert.throws(
    () => parseHandoff(handoff({ models: [{ id: "m", reasoning: false }] })),
    /models\[0\]\.contextWindow must be a positive integer/,
  );
  assert.throws(
    () => parseHandoff(handoff({ models: [{ id: "m", contextWindow: 1, reasoning: true, thinkingLevelMap: { ultra: "x" } }] })),
    /unknown level "ultra"/,
  );
});

test("requests go to the handed-off endpoint with its key and mapped effort", async () => {
  const requests: { url?: string; authorization?: string; body: Record<string, unknown> }[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      requests.push({ url: request.url, authorization: request.headers.authorization, body: JSON.parse(body) });
      response.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: Record<string, unknown>, finish: string | null) =>
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: "think-1", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      response.end(`${chunk({ role: "assistant", content: "pong" }, null)}${chunk({}, "stop")}data: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  process.env.ACME_TEST_API_KEY = "test-key";
  try {
    const models = builtinModels();
    applyHandoff(
      models,
      parseHandoff(
        handoff({
          baseUrl: `http://127.0.0.1:${port}/v1`,
          models: [{ id: "think-1", contextWindow: 200000, reasoning: true, thinkingLevelMap: { off: "none", low: "l", medium: "m", high: "h", xhigh: null, max: null } }],
        }),
      ),
    );
    const { model, thinking } = await resolveModel(models, "acme/think-1", "xhigh");
    assert.equal(thinking, "high");
    const reply = await models.completeSimple(model, { messages: [{ role: "user", content: "ping", timestamp: 0 }] }, { reasoning: "high" });
    assert.equal(reply.stopReason, "stop");
    assert.deepEqual(reply.content, [{ type: "text", text: "pong" }]);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.url, "/v1/chat/completions");
    assert.equal(requests[0]!.authorization, "Bearer test-key");
    assert.equal(requests[0]!.body.model, "think-1");
    assert.equal(requests[0]!.body.reasoning_effort, "h");
  } finally {
    delete process.env.ACME_TEST_API_KEY;
    server.close();
  }
});
