import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import { createRxAgent } from "../src/agent.ts";
import { pruningPlan, contextBudget } from "../src/context-plan.ts";
import { total } from "../src/context-messages.ts";
import { SessionLog } from "../src/session-log.ts";
import { fauxModels, tempDir } from "./helpers.ts";

const user = (content: string): AgentMessage => ({ role: "user", content, timestamp: Date.now() });
const call = (id: string) => fauxAssistantMessage([fauxToolCall("read", { path: id }, { id })], { stopReason: "toolUse" });
const result = (id: string, text: string): ToolResultMessage => ({ role: "toolResult", toolName: "read", toolCallId: id, content: [{ type: "text", text }], timestamp: Date.now(), isError: false });

function setup(messages: AgentMessage[]) {
  const { faux, models, model } = fauxModels();
  const selected = { ...model, contextWindow: 16384 };
  const log = SessionLog.create(tempDir(), tempDir());
  for (const message of messages) log.append(message.role === "user" ? "cli" : message.role === "toolResult" ? "tool" : "model", message);
  const agent = createRxAgent({ models, model: selected, cwd: log.cwd, systemPrompt: "sys", thinking: "off", log, origin: "cli", messages });
  return { agent, faux, models, model: selected, log, records: () => readFileSync(log.path, "utf8").trim().split("\n").map((line) => JSON.parse(line)) };
}

test("steady pressure clears batches to a low-water mark instead of repeatedly rewriting one old result", async () => {
  const messages: AgentMessage[] = [user("Start")];
  for (let index = 0; index < 8; index++) messages.push(call(`c${index}`), result(`c${index}`, `file ${index} `.repeat(800)), fauxAssistantMessage(`Read ${index}`));
  const h = setup(messages);
  h.faux.setResponses(Array.from({ length: 20 }, () => (context, _options, _state, model) => {
    if (model.maxTokens <= 4096) return fauxAssistantMessage("The original task remains active. [log 1-1]");
    const response = fauxAssistantMessage("answer ".repeat(250));
    response.usage.input = total(context.messages) + 450;
    response.usage.output = response.usage.cacheRead = response.usage.cacheWrite = 0;
    return response;
  }));
  for (let turn = 0; turn < 12; turn++) await h.agent.prompt(`Turn ${turn}`);
  const prunes = h.records().filter((entry) => entry.type === "context_prune");
  assert.ok(prunes.length >= 1 && prunes.length <= 2);
  assert.equal(h.records().some((entry) => entry.type === "compaction"), false);
  assert.ok(prunes.every((entry) => entry.clearedSeqs.length >= 2));
  const plan = pruningPlan(messages, h.model)!;
  const { ceiling, recent } = contextBudget(h.model);
  assert.ok(total(messages) - plan.freedTokens < ceiling - recent);
});

test("measured pressure that survives all eligible clearing requests a summary even when the projection estimate fits", async (t) => {
  const h = setup([user("Keep the original goal. " + "user evidence ".repeat(1200)), call("old"), result("old", "old evidence ".repeat(1100)), fauxAssistantMessage("Observed"), call("recent"), result("recent", "current evidence"), fauxAssistantMessage("Ready")]);
  let working = 0;
  let summaries = 0;
  h.faux.setResponses([fauxAssistantMessage("Keep the original goal. [log 1-1]")]);
  const original = h.models.streamSimple.bind(h.models);
  t.mock.method(h.models, "streamSimple", (...args: Parameters<typeof h.models.streamSimple>) => {
    const model = args[0];
    if (model.maxTokens <= 4096) { summaries++; return original(...args); }
    const response = { ...fauxAssistantMessage("Ready"), api: model.api, provider: model.provider, model: model.id };
    response.usage.input = working++ === 0 ? 15000 : 500;
    response.usage.output = response.usage.cacheRead = response.usage.cacheWrite = 0;
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "done", reason: "stop", message: response });
      stream.end(response);
    });
    return stream;
  });
  await h.agent.prompt("Establish a working measurement");
  assert.equal(summaries, 0);
  assert.ok(total(h.agent.state.messages) < contextBudget(h.model).ceiling);
  await h.agent.prompt("Continue using the current evidence");
  assert.equal((h.agent.state.messages.at(-1) as any).stopReason, "stop", (h.agent.state.messages.at(-1) as any).errorMessage);
  assert.equal(summaries, 1);
  assert.equal(working, 2);
  const entries = h.records();
  assert.ok(entries.findIndex((entry) => entry.type === "context_prune") < entries.findIndex((entry) => entry.type === "compaction"));
});

test("the most recent completed group remains protected after narration, a new user input, and partial later results", () => {
  for (const ending of [[], [fauxAssistantMessage("I read the config")], [fauxAssistantMessage("I read the config"), user("Now edit the config")]]) {
    const h = setup([user("Read the config"), call("config"), result("config", "config line ".repeat(3800)), ...ending]);
    assert.equal(pruningPlan(h.agent.state.messages, h.model), undefined);
  }
  const h = setup([user("Inspect"), call("old"), result("old", "old ".repeat(15000)), call("recent"), result("recent", "recent ".repeat(15000)),
    fauxAssistantMessage([fauxToolCall("read", { path: "one" }, { id: "one" }), fauxToolCall("read", { path: "two" }, { id: "two" })], { stopReason: "toolUse" }), result("one", "partial current result")]);
  assert.deepEqual(pruningPlan(h.agent.state.messages, h.model)!.clearedSeqs, [3]);
});


test("insufficient eligible savings leave the prefix unchanged instead of committing another small edit", () => {
  const h = setup([user("Inspect"), call("old"), result("old", "old ".repeat(200)), call("recent"), result("recent", "current ".repeat(3000)), fauxAssistantMessage("Ready")]);
  const { ceiling, recent } = contextBudget(h.model);
  assert.equal(pruningPlan(h.agent.state.messages, h.model, ceiling + 1), undefined);
  const large = setup([user("Inspect"), call("old"), result("old", "old ".repeat(6000)), call("recent"), result("recent", "current evidence"), fauxAssistantMessage("Ready")]);
  const plan = pruningPlan(large.agent.state.messages, large.model, ceiling + 1)!;
  assert.deepEqual(plan.clearedSeqs, [3]);
  assert.ok(plan.freedTokens >= recent);
});
