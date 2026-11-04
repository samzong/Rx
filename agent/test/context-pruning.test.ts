import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxToolCall, normalizeContext, type ToolResultMessage } from "@earendil-works/pi-ai";
import { clampMaxTokensToContext } from "@earendil-works/pi-ai/api/simple-options";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { createRxAgent } from "../src/agent.ts";
import { SessionLog } from "../src/session-log.ts";
import { total } from "../src/context-messages.ts";
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
  await h.agent.prompt("Continue using the current evidence");
  assert.equal((h.agent.state.messages.at(-1) as any).stopReason, "stop", (h.agent.state.messages.at(-1) as any).errorMessage);
  assert.ok(summaries > 0);
  const entries = h.records();
  assert.ok(entries.findIndex((entry) => entry.type === "context_prune") < entries.findIndex((entry) => entry.type === "compaction"));
});

test("output budgets discard measurements from before a projection change and preserve measured accounting", async (t) => {
  for (const mode of ["live", "prune", "load", "cjk"] as const) {
    const old = call("old");
    const recent = call("recent");
    for (const message of [old, recent]) message.usage = { ...message.usage, input: 7700, output: 29, totalTokens: 7729 };
    const history = [user(mode === "live" ? "字".repeat(35000) : mode === "cjk" ? "字".repeat(50000) : "Keep the original goal"), old, result("old", "e".repeat(mode === "cjk" ? 60000 : mode === "live" ? 53000 : 28000)), recent, result("recent", "e".repeat(mode === "cjk" || mode === "live" ? 100 : 25800))];
    for (const message of history) message.timestamp = 1;
    const h = setup(history);
    h.model.maxTokens = mode === "live" || mode === "cjk" ? 16384 : 4096;
    if (mode === "live" || mode === "cjk") h.model.contextWindow = 65536;
    if (mode === "load") h.log.appendPrune([3]);
    if (mode !== "live") h.agent.state.messages = SessionLog.open(h.log.home, h.log.id).messages;
    const estimates: ReturnType<typeof estimateContextTokens>[] = [];
    const budgets: number[] = [];
    const inputEstimates: number[] = [];
    const measured: number[] = [];
    const realInputs: number[] = [];
    const uncappedBudgets: number[] = [];
    const before = readFileSync(h.log.path, "utf8");
    h.agent.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "assistant") measured.push(event.message.usage.input);
    });
    t.mock.method(h.models, "streamSimple", (...[model, context]: Parameters<typeof h.models.streamSimple>) => {
      const request = normalizeContext(context);
      estimates.push(estimateContextTokens(request));
      budgets.push(clampMaxTokensToContext(model, request, model.maxTokens));
      inputEstimates.push(total(request.messages));
      uncappedBudgets.push(clampMaxTokensToContext(h.model, request, h.model.maxTokens));
      const message = { ...fauxAssistantMessage("The complete answer"), api: model.api, provider: model.provider, model: model.id };
      const chineseCharacters = request.messages.reduce((sum, item) => sum + (JSON.stringify(item.content).match(/字/g)?.length ?? 0), 0);
      const realInput = total(request.messages) - (mode === "live" ? Math.floor(chineseCharacters * 0.4) : 0);
      realInputs.push(realInput);
      const input = mode === "live" ? realInput : 500;
      message.usage = { ...message.usage, input, output: 12, totalTokens: input + 12 };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "done", reason: "stop", message });
        stream.end(message);
      });
      return stream;
    });
    if (mode === "live") await h.agent.prompt("Establish a measurement");
    await h.agent.prompt(mode === "live" ? "Continue " + "e".repeat(80000) : "Continue");
    const prunedRequest = budgets.length - 1;
    if (mode === "live") {
      const totalOnlyBudget = Math.min(h.model.maxTokens, Math.max(1, h.model.contextWindow - inputEstimates[prunedRequest]! - 4096));
      assert.ok(budgets[prunedRequest]! > totalOnlyBudget, `live measured budget ${budgets[prunedRequest]} must exceed total-only budget ${totalOnlyBudget}: ${JSON.stringify({ budgets, realInputs, inputEstimates, estimates })}`);
    }
    assert.ok(budgets[prunedRequest]! >= 1024, `${mode}: ${JSON.stringify(budgets)}`);
    assert.ok(realInputs[prunedRequest]! + budgets[prunedRequest]! <= h.model.contextWindow, `${mode}: real input ${realInputs[prunedRequest]}, output ${budgets[prunedRequest]}`);
    assert.equal(estimates[prunedRequest]!.usageTokens, 0);
    await h.agent.prompt("Continue with the fresh measurement");
    assert.equal(estimates.at(-1)!.usageTokens, mode === "live" ? realInputs[prunedRequest]! + 12 : 512);
    assert.equal(budgets.at(-1), mode === "live" ? uncappedBudgets.at(-1) : h.model.maxTokens);
    assert.ok(readFileSync(h.log.path, "utf8").startsWith(before));
    assert.equal(old.usage.input, 7700);
    assert.equal(recent.usage.totalTokens, 7729);
    assert.deepEqual(measured, mode === "live" ? realInputs : [500, 500]);
    assert.equal(h.records().filter((entry) => entry.type === "context_prune").length, 1);
    assert.equal(h.records().some((entry) => entry.type === "compaction"), false);
    assert.deepEqual(h.records().filter((entry) => entry.message?.role === "assistant").map((entry) => entry.message.usage.input), [7700, 7700, ...measured]);
  }
});
