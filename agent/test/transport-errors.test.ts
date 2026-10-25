import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test, type TestContext } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { createRxAgent } from "../src/agent.ts";
import { applyHandoff, parseHandoff } from "../src/rx-provider.ts";
import { SessionLog } from "../src/session-log.ts";
import { tempDir } from "./helpers.ts";

const API_KEY_ENV = "RX_TRANSPORT_TEST_API_KEY";
const API_KEY = "rx-fake-test-key";
const RAW_URL = "https://fake.invalid/v1/responses?key=fake-url-key";
const RAW_AUTHORIZATION = "Bearer fake-authorization-secret";
const RAW_MESSAGE = "raw transport failure secret";

function fakeCredential(t: TestContext): void {
  const previousKey = process.env[API_KEY_ENV];
  process.env[API_KEY_ENV] = API_KEY;
  t.after(() => {
    if (previousKey === undefined) delete process.env[API_KEY_ENV];
    else process.env[API_KEY_ENV] = previousKey;
  });
}

function agentFixture() {
  const models = builtinModels();
  applyHandoff(
    models,
    parseHandoff(
      JSON.stringify({
        id: "rx-transport-test",
        name: "Rx Transport Test",
        api: "openai-responses",
        baseUrl: "https://fake.invalid/v1",
        env: API_KEY_ENV,
        defaultModel: "transport-model",
        models: [{ id: "transport-model", contextWindow: 64000, reasoning: false }],
      }),
    ),
  );
  const model = models.getModel("rx-transport-test", "transport-model")!;
  const cwd = tempDir();
  const log = SessionLog.create(tempDir(), cwd);
  return { agent: createRxAgent({ models, model, thinking: "off", cwd, systemPrompt: "rules", log, origin: "cli" }), log, models };
}

function responsesOk(): Response {
  const message = { type: "message", id: "m1", role: "assistant", status: "completed" };
  const events = [
    { type: "response.created", response: { id: "r1" } },
    { type: "response.output_item.added", output_index: 0, item: { ...message, content: [] } },
    { type: "response.output_item.done", output_index: 0, item: { ...message, content: [{ type: "output_text", text: "recovered" }] } },
    { type: "response.completed", response: { id: "r1", status: "completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

function assistantMessages(messages: AgentMessage[]) {
  return messages.filter((message) => message.role === "assistant");
}

test("transport errors keep safe diagnostics in agent state and session log without leaking request data", async (t) => {
  fakeCredential(t);
  const cause = Object.assign(new Error("cause contains private details"), { code: "ECONNREFUSED", errno: -61, syscall: "connect" });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    if (calls === 1) throw new TypeError(`${RAW_MESSAGE}: ${RAW_URL}; Authorization: ${RAW_AUTHORIZATION}; key=${API_KEY}`, { cause });
    if (calls === 2) return new Response(JSON.stringify({ error: { message: "unauthorized" } }), { status: 401 });
    return responsesOk();
  });
  const { agent, log } = agentFixture();

  await agent.prompt("first request");
  assert.equal(calls, 1);
  const firstFailure = assistantMessages(agent.state.messages).at(-1)!;
  assert.equal(firstFailure.stopReason, "error");
  assert.ok(firstFailure.role === "assistant");
  for (const value of ["ECONNREFUSED", "connect", "-61"]) assert.ok(firstFailure.errorMessage?.includes(value));
  const loggedEntries = readFileSync(log.path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { type: string; message?: AgentMessage });
  const loggedFailure = loggedEntries.find(
    (entry) => entry.type === "message" && entry.message?.role === "assistant" && entry.message.stopReason === "error",
  )?.message;
  assert.deepEqual(loggedFailure, firstFailure);
  const firstFailureText = JSON.stringify(firstFailure);
  const firstLogText = JSON.stringify(loggedFailure);
  for (const value of [RAW_MESSAGE, RAW_URL, RAW_AUTHORIZATION, API_KEY, "cause contains private details"]) {
    assert.equal(firstFailureText.includes(value), false);
    assert.equal(firstLogText.includes(value), false);
  }

  await agent.prompt("second request");
  assert.equal(calls, 2);
  const secondFailure = assistantMessages(agent.state.messages).at(-1)!;
  assert.equal(secondFailure.stopReason, "error");
  assert.ok(secondFailure.role === "assistant");
  for (const value of ["ECONNREFUSED", "connect", "-61", RAW_MESSAGE, RAW_URL, RAW_AUTHORIZATION]) {
    assert.equal((secondFailure.errorMessage ?? "").includes(value), false);
  }

  await agent.prompt("third request");
  assert.equal(calls, 3);
  const recovered = assistantMessages(agent.state.messages).at(-1)!;
  assert.equal(recovered.stopReason, "stop");
  assert.equal(recovered.role === "assistant" && recovered.content.some((block) => block.type === "text" && block.text === "recovered"), true);
});

test("cancelling a Responses request leaves the assistant message aborted without transport diagnostics", async (t) => {
  fakeCredential(t);
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  t.mock.method(globalThis, "fetch", (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    markStarted();
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    return new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(Object.assign(new Error("Request was aborted"), { name: "AbortError", code: "ECONNRESET" })), { once: true });
    });
  });
  const { agent } = agentFixture();
  const prompt = agent.prompt("cancel request");
  await started;
  agent.abort();
  await prompt;
  const aborted = assistantMessages(agent.state.messages).at(-1)!;
  assert.equal(aborted.stopReason, "aborted");
  assert.ok(aborted.role === "assistant");
  for (const value of ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT"]) assert.equal((aborted.errorMessage ?? "").includes(value), false);
});

for (const [code, syscall] of [["ENOTFOUND", "getaddrinfo"], ["ERR_TLS_CERT_ALTNAME_INVALID", "connect"], ["UND_ERR_CONNECT_TIMEOUT", "connect"]]) {
  test(`a ${code} cause survives provider normalization without exposing exception text`, async (t) => {
    fakeCredential(t);
    const cause = Object.assign(new Error(RAW_URL), { code, syscall });
    t.mock.method(globalThis, "fetch", async () => { throw new TypeError(RAW_AUTHORIZATION, { cause }); });
    const { agent, log } = agentFixture();
    await agent.prompt("diagnose connection");
    const message = assistantMessages(agent.state.messages).at(-1)!;
    assert.equal(message.stopReason, "error");
    assert.ok(message.role === "assistant" && message.errorMessage?.includes(code!) && message.errorMessage.includes(syscall!));
    const saved = readFileSync(log.path, "utf8");
    assert.ok(saved.includes(code!) && saved.includes(syscall!));
    for (const value of [RAW_URL, RAW_AUTHORIZATION, API_KEY]) assert.ok(!saved.includes(value));
  });
}

test("unknown fields and cyclic aggregate causes cannot expose credentials or hang diagnostics", async (t) => {
  fakeCredential(t);
  const cause: Record<string, unknown> = { name: API_KEY, code: API_KEY, syscall: API_KEY, hostname: RAW_URL, stack: RAW_AUTHORIZATION };
  cause.cause = cause;
  cause.errors = [cause, Object.assign(new Error(RAW_MESSAGE), { code: "EAI_AGAIN" })];
  t.mock.method(globalThis, "fetch", async () => { throw new TypeError(RAW_MESSAGE, { cause }); });
  const { agent, log } = agentFixture();
  await agent.prompt("diagnose private failure");
  const message = assistantMessages(agent.state.messages).at(-1)!;
  assert.ok(message.role === "assistant" && message.errorMessage?.includes("EAI_AGAIN"));
  const saved = readFileSync(log.path, "utf8");
  for (const value of [RAW_URL, RAW_AUTHORIZATION, API_KEY, RAW_MESSAGE]) assert.ok(!saved.includes(value));
});

test("one agent keeps its fetch reference and reads the current global fetch for each call", async (t) => {
  fakeCredential(t);
  const { agent, models } = agentFixture();
  const references: unknown[] = [];
  const stream = models.streamSimple.bind(models);
  t.mock.method(models, "streamSimple", (...[model, context, options]: Parameters<typeof models.streamSimple>) => {
    references.push(options?.fetch);
    return stream(model, context, options);
  });
  t.mock.method(globalThis, "fetch", async () => { throw Object.assign(new Error(RAW_MESSAGE), { code: "ConnectionRefused", errno: 0 }); });
  await agent.prompt("first request");
  const failure = assistantMessages(agent.state.messages).at(-1)!;
  assert.ok(failure.role === "assistant" && failure.errorMessage?.includes("ConnectionRefused"));
  t.mock.method(globalThis, "fetch", async () => responsesOk());
  await agent.prompt("second request");
  assert.equal(assistantMessages(agent.state.messages).at(-1)!.stopReason, "stop");
  assert.equal(references.length, 2);
  assert.equal(typeof references[0], "function");
  assert.equal(references[0], references[1]);
  assert.ok(failure.role === "assistant" && !failure.errorMessage?.includes("errno="));
});

test("an SDK timeout keeps the pi-ai timeout message in state and the session log", async (t) => {
  fakeCredential(t);
  const { agent, models, log } = agentFixture();
  const stream = models.streamSimple.bind(models);
  t.mock.method(models, "streamSimple", (...[model, context, options]: Parameters<typeof models.streamSimple>) => stream(model, context, { ...options, timeoutMs: 50 }));
  t.mock.method(globalThis, "fetch", (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    return new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new DOMException("private abort details", "AbortError")), { once: true });
    });
  });
  await agent.prompt("time out this request");
  const message = assistantMessages(agent.state.messages).at(-1)!;
  assert.ok(message.role === "assistant");
  assert.equal(message.stopReason, "error");
  assert.equal(message.errorMessage, "Request timed out.");
  const saved = readFileSync(log.path, "utf8");
  assert.ok(saved.includes("Request timed out."));
  assert.ok(!saved.includes("private abort details") && !saved.includes("Model connection failed"));
});

test("concurrent agents keep transport failures in their own sessions", async (t) => {
  fakeCredential(t);
  const first = agentFixture();
  const second = agentFixture();
  const pending: ((reason: unknown) => void)[] = [];
  let bothStarted!: () => void;
  const started = new Promise<void>((resolve) => { bothStarted = resolve; });
  t.mock.method(globalThis, "fetch", () => new Promise<Response>((_resolve, reject) => {
    pending.push(reject);
    if (pending.length === 2) bothStarted();
  }));
  const firstTurn = first.agent.prompt("first session");
  const secondTurn = second.agent.prompt("second session");
  await started;
  pending[0]!(Object.assign(new Error(RAW_MESSAGE), { code: "ECONNREFUSED" }));
  pending[1]!(Object.assign(new Error(RAW_MESSAGE), { code: "ENOTFOUND" }));
  await Promise.all([firstTurn, secondTurn]);
  for (const [fixture, ownCode, otherCode] of [[first, "ECONNREFUSED", "ENOTFOUND"], [second, "ENOTFOUND", "ECONNREFUSED"]] as const) {
    const message = assistantMessages(fixture.agent.state.messages).at(-1)!;
    assert.ok(message.role === "assistant" && message.errorMessage?.includes(ownCode) && !message.errorMessage.includes(otherCode));
    const saved = readFileSync(fixture.log.path, "utf8");
    assert.ok(saved.includes(ownCode) && !saved.includes(otherCode));
  }
});
