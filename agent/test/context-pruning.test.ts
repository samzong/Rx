import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import { createRxAgent } from "../src/agent.ts";
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
