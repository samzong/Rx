import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, type AssistantMessage } from "@earendil-works/pi-ai";
import { createRxAgent } from "../src/agent.ts";
import { contextControl } from "../src/context-control.ts";
import { MAX_SUMMARY_CALLS } from "../src/context.ts";
import { SessionLog } from "../src/session-log.ts";
import { fauxModels, tempDir } from "./helpers.ts";

function setup(window = 16384, history: AgentMessage[] = [], prompt = "Follow the user's constraints. Never repeat completed side effects.") {
  const { models, faux, model } = fauxModels();
  const selected = { ...model, contextWindow: window };
  const cwd = tempDir();
  const log = SessionLog.create(tempDir(), cwd);
  for (const message of history) log.append(message.role === "user" ? "cli" : message.role === "toolResult" ? "tool" : "model", message);
  const agent = createRxAgent({ models, model: selected, cwd, thinking: "off", log, origin: "cli", systemPrompt: prompt, messages: history });
  return { models, faux, model: selected, log, agent, control: contextControl(agent) };
}

const user = (content: string): AgentMessage => ({ role: "user", content, timestamp: Date.now() });
const history = (length = 18000): AgentMessage[] => [user(`Keep file secret.txt unchanged. Fix issue A. ${"prior evidence ".repeat(Math.ceil(length / 15))}`), fauxAssistantMessage("Completed edit of result.txt. Pending verification. Unknown side effect of interrupted command.")];
const summary = () => fauxAssistantMessage("Goal: fix A. Do not edit secret.txt. result.txt was edited. Verify next. The interrupted command has unknown side effects. [log 1-1]");

function records(log: SessionLog): any[] {
  return readFileSync(log.path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

test("real-shaped measured responses trigger near 80 percent instead of the JSON estimate", async (t) => {
  const { agent, faux, log, models } = setup(128000, history(80000));
  const measured = (input: number, output = 1000): AssistantMessage => ({
    ...fauxAssistantMessage([{ type: "text", text: "Recorded evidence" }, { type: "thinking", thinking: "Reasoning summary", thinkingSignature: "opaque-provider-signature".repeat(20000) }]),
    usage: { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  let summaries = 0;
  const working = [measured(69000), measured(101399), fauxAssistantMessage("continued")];
  const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
  const original = models.streamSimple.bind(models);
  faux.setResponses(Array.from({ length: MAX_SUMMARY_CALLS }, summary));
  t.mock.method(models, "streamSimple", (...args: Parameters<typeof models.streamSimple>) => {
    if (args[0].maxTokens <= 4096) { summaries++; return original(...args); }
    const message = { ...working.shift()!, provider: args[0].provider, model: args[0].id, api: args[0].api };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "start", partial: { ...message, content: [] } });
      stream.push({ type: "done", reason: "stop", message });
      stream.end(message);
    });
    return stream;
  });
  await agent.prompt("Record current progress");
  await agent.prompt("Continue");
  assert.equal(summaries, 0);
  assert.equal(records(log).some((entry) => entry.type === "compaction"), false);
  await agent.prompt("Continue");
  assert.ok(summaries > 0);
  assert.equal(records(log).filter((entry) => entry.type === "compaction").length, 1);
});

test("uncertain instruction or input estimates do not preempt a native request", async () => {
  for (const window of [4095, 24000, 32768]) {
    const { agent, faux, log } = setup(window, [], "Current instructions. ".repeat(5000));
    faux.setResponses([fauxAssistantMessage("The provider accepted the request")]);
    await agent.prompt("hello");
    assert.equal(faux.state.callCount, 1);
    assert.equal(records(log).some((entry) => entry.type === "compaction"), false);
    assert.equal((agent.state.messages.at(-1) as AssistantMessage).stopReason, "stop");
  }
  const { agent, faux } = setup(8192);
  faux.setResponses([fauxAssistantMessage("The provider accepted the request")]);
  await agent.prompt("Dense current input. ".repeat(10000));
  assert.equal(faux.state.callCount, 1);
});
