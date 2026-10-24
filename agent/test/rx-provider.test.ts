import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { resolveModel } from "../src/models.ts";
import { applyHandoff, parseHandoff } from "../src/rx-provider.ts";
import { tempDir } from "./helpers.ts";

const CLI = join(import.meta.dirname, "../src/cli.ts");

function handoff(overrides: Record<string, unknown> = {}): string {
  const fields: Record<string, unknown> = {
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
  };
  return JSON.stringify({ defaultModel: (fields.models as { id?: string }[])[0]?.id, ...fields });
}

type Recorded = { url?: string; authorization?: string; apiKey?: string; body: Record<string, unknown> };

function chatServer(requests: Recorded[]): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const parsed = JSON.parse(body);
      const apiKey = request.headers["x-api-key"] as string | undefined;
      requests.push({ url: request.url, authorization: request.headers.authorization, apiKey, body: parsed });
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (request.url?.startsWith("/v1/messages")) {
        const usage = { input_tokens: 1, output_tokens: 1 };
        const events = [
          { type: "message_start", message: { id: "m1", type: "message", role: "assistant", model: parsed.model, content: [], stop_reason: null, usage } },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "pong" } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn" }, usage },
          { type: "message_stop" },
        ];
        response.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
        return;
      }
      if (request.url?.endsWith("/responses")) {
        const message = { type: "message", id: "m1", role: "assistant", status: "completed" };
        const events = [
          { type: "response.created", response: { id: "r1" } },
          { type: "response.output_item.added", output_index: 0, item: { ...message, content: [] } },
          { type: "response.output_item.done", output_index: 0, item: { ...message, content: [{ type: "output_text", text: "pong" }] } },
          { type: "response.completed", response: { id: "r1", status: "completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
        ];
        response.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
        return;
      }
      const chunk = (delta: Record<string, unknown>, finish: string | null) =>
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: parsed.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      response.end(`${chunk({ role: "assistant", content: "pong" }, null)}${chunk({}, "stop")}data: [DONE]\n\n`);
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` })),
  );
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
  assert.throws(() => parseHandoff(handoff({ api: "google-generative-ai" })), /unsupported api "google-generative-ai"/);
  assert.throws(
    () => parseHandoff(handoff({ models: [{ id: "m", contextWindow: 1, reasoning: false, api: "google-generative-ai" }] })),
    /unsupported models\[0\]\.api "google-generative-ai"/,
  );
  assert.throws(
    () => parseHandoff(handoff({ models: [{ id: "m", contextWindow: 1, reasoning: false, baseUrl: "" }] })),
    /models\[0\]\.baseUrl must be a non-empty string/,
  );
  assert.throws(() => parseHandoff(handoff({ models: [] })), /models must be a non-empty array/);
  assert.throws(() => parseHandoff(handoff({ defaultModel: undefined })), /defaultModel must be/);
  assert.throws(() => parseHandoff(handoff({ defaultModel: "gone-1" })), /defaultModel "gone-1" is not in models/);
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
  const requests: Recorded[] = [];
  const { server, baseUrl } = await chatServer(requests);
  process.env.ACME_TEST_API_KEY = "test-key";
  try {
    const models = builtinModels();
    applyHandoff(
      models,
      parseHandoff(
        handoff({
          baseUrl,
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

test("responses handoffs omit prompt_cache_key", async () => {
  const requests: { url?: string; body: Record<string, unknown> }[] = [];
  const { server, baseUrl } = await chatServer(requests);
  process.env.ACME_TEST_API_KEY = "test-key";
  try {
    const models = builtinModels();
    applyHandoff(models, parseHandoff(handoff({ api: "openai-responses", baseUrl })));
    const { model } = await resolveModel(models, "acme/plain-1", "off");
    const reply = await models.completeSimple(model, { messages: [{ role: "user", content: "ping", timestamp: 0 }] }, { sessionId: "s1" });
    assert.equal(reply.stopReason, "stop", reply.errorMessage);
    assert.deepEqual(reply.content.map((block) => block.type === "text" && block.text), ["pong"]);
    assert.equal(requests[0]!.url, "/v1/responses");
    assert.equal(requests[0]!.body.model, "plain-1");
    assert.equal(Object.hasOwn(requests[0]!.body, "prompt_cache_key"), false);
  } finally {
    delete process.env.ACME_TEST_API_KEY;
    server.close();
  }
});

test("a model handed off on anthropic-messages uses its own endpoint, caching, and adaptive effort", async () => {
  const requests: Recorded[] = [];
  const { server, baseUrl } = await chatServer(requests);
  const origin = baseUrl.replace(/\/v1$/, "");
  process.env.ACME_TEST_API_KEY = "test-key";
  try {
    const models = builtinModels();
    applyHandoff(
      models,
      parseHandoff(
        handoff({
          api: "openai-responses",
          baseUrl,
          models: [
            {
              id: "claude-1",
              contextWindow: 200000,
              reasoning: true,
              api: "anthropic-messages",
              baseUrl: origin,
              thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
            },
            { id: "plain-1", contextWindow: 64000, reasoning: false },
          ],
        }),
      ),
    );
    const context = { systemPrompt: "rules", messages: [{ role: "user" as const, content: "ping", timestamp: 0 }] };
    const { model, thinking } = await resolveModel(models, "acme/claude-1", "xhigh");
    assert.equal(thinking, "xhigh");
    const reply = await models.completeSimple(model, context, { reasoning: "xhigh" });
    assert.equal(reply.stopReason, "stop", reply.errorMessage);
    assert.deepEqual(reply.content, [{ type: "text", text: "pong" }]);
    const off = await models.completeSimple(model, context);
    assert.equal(off.stopReason, "stop", off.errorMessage);
    const plain = await models.completeSimple((await resolveModel(models, "acme/plain-1", "off")).model, context);
    assert.equal(plain.stopReason, "stop", plain.errorMessage);
    const [high, quiet, responses] = requests;
    assert.match(high!.url!, /^\/v1\/messages(\?|$)/);
    assert.equal(high!.apiKey, "test-key");
    assert.equal(high!.body.model, "claude-1");
    assert.deepEqual(high!.body.thinking, { type: "adaptive", display: "summarized" });
    assert.deepEqual(high!.body.output_config, { effort: "xhigh" });
    assert.deepEqual((high!.body.system as { cache_control?: unknown }[]).at(-1)?.cache_control, { type: "ephemeral" });
    assert.equal(Object.hasOwn(quiet!.body, "thinking"), false);
    assert.equal(Object.hasOwn(quiet!.body, "output_config"), false);
    assert.equal(responses!.url, "/v1/responses");
    assert.equal(responses!.body.model, "plain-1");
  } finally {
    delete process.env.ACME_TEST_API_KEY;
    server.close();
  }
});

test("in an rx launch, config.json picks the model unless RX_MODEL or --model does", async () => {
  const requests: { body: Record<string, unknown> }[] = [];
  const { server, baseUrl } = await chatServer(requests);
  const run = (config: Record<string, unknown> | undefined, extra: Record<string, string> = {}, args: string[] = []) => {
    const home = tempDir();
    if (config) writeFileSync(join(home, "config.json"), JSON.stringify(config));
    const env = { ...process.env, RX_HOME: home, RX_MODEL: "", ACME_TEST_API_KEY: "test-key", RX_AGENT_PROVIDER: handoff({ baseUrl }), ...extra };
    const before = requests.length;
    const child = spawn(process.execPath, [CLI, ...args, "-p", "ping"], { env });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.stdout.resume();
    return new Promise<{ status: number | null; stderr: string; model: unknown }>((resolve) =>
      child.on("close", (status) => resolve({ status, stderr, model: requests.length > before ? requests.at(-1)?.body.model : undefined })),
    );
  };
  try {
    const launchDefault = await run(undefined);
    assert.equal(launchDefault.status, 0, launchDefault.stderr);
    assert.equal(launchDefault.model, "think-1");
    assert.match(launchDefault.stderr, /rx-agent: using acme\/think-1 \(rx launch default; set "model" in .*config\.json or pass --model\)/);

    const configured = await run({ model: "acme/plain-1" });
    assert.equal(configured.status, 0, configured.stderr);
    assert.equal(configured.model, "plain-1");
    assert.doesNotMatch(configured.stderr, /rx-agent:/);

    const unavailable = await run({ model: "acme/model-9" });
    assert.equal(unavailable.status, 0, unavailable.stderr);
    assert.equal(unavailable.model, "think-1");
    assert.match(unavailable.stderr, /"model" acme\/model-9 in .*config\.json is unavailable in this launch \(unknown model "model-9" for provider "acme"[^)]*\); using acme\/think-1/);

    const otherProvider = await run({ model: "deepseek/deepseek-flash" }, { DEEPSEEK_API_KEY: "other-key" });
    assert.equal(otherProvider.status, 0, otherProvider.stderr);
    assert.equal(otherProvider.model, "think-1");
    assert.match(otherProvider.stderr, /"model" deepseek\/deepseek-flash in .*config\.json belongs to another provider and this rx launch uses acme; using acme\/think-1 \(pass --model, or --provider none to use it\)/);

    const bare = await run({ model: "plain-1" });
    assert.equal(bare.model, "think-1");
    assert.match(bare.stderr, /"model" plain-1 in .*config\.json is unavailable in this launch \(invalid model "plain-1"[^)]*\); using acme\/think-1/);

    const selected = await run({ model: "acme/think-1" }, { RX_MODEL: "acme/plain-1" });
    assert.equal(selected.model, "plain-1");
    const argv = await run({ model: "acme/think-1" }, { RX_MODEL: "acme/think-1" }, ["--model", "acme/plain-1"]);
    assert.equal(argv.model, "plain-1");
    assert.doesNotMatch(selected.stderr + argv.stderr, /rx-agent:/);

    const badThinking = await run({ model: "acme/plain-1", thinking: "ultra" });
    assert.equal(badThinking.status, 1);
    assert.match(badThinking.stderr, /unknown thinking level "ultra"/);
    assert.doesNotMatch(badThinking.stderr, /unavailable in this launch/);
  } finally {
    server.close();
  }
});
