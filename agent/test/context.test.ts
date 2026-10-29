import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxToolCall, type AssistantMessage } from "@earendil-works/pi-ai";
import { createRxAgent } from "../src/agent.ts";
import { contextControl, type CompactionEvent } from "../src/context-control.ts";
import { contextBudget, MAX_SUMMARY_CALLS, messageTokens, textTokens, visibleMessage } from "../src/context.ts";
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

test("every measured summary response is logged before success, failure, output rejection, or cancellation", async (t) => {
  for (const outcome of ["stop", "error", "length", "aborted", "over-budget", "cancel"] as const) {
    const { agent, models, control, log } = setup(16384, history());
    const original = structuredClone(agent.state.messages);
    const response = { ...summary(), stopReason: outcome === "over-budget" || outcome === "cancel" ? "stop" as const : outcome };
    response.usage = { ...response.usage, input: 123, output: outcome === "over-budget" ? 10000 : 12, cacheRead: 30, cacheWrite: 4, totalTokens: 169 };
    t.mock.method(models, "streamSimple", () => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        if (outcome === "cancel") control.abort();
        if (response.stopReason === "error" || response.stopReason === "aborted") stream.push({ type: "error", reason: response.stopReason, error: response });
        else stream.push({ type: "done", reason: response.stopReason, message: response });
        stream.end(response);
      });
      return stream;
    });
    if (outcome === "stop") await control.compact();
    else await assert.rejects(control.compact());
    const entries = records(log);
    const usage = entries.filter((entry) => entry.purpose === "compaction");
    assert.equal(usage.length, 1, outcome);
    assert.equal(usage[0].message.usage.input, 123);
    assert.equal(usage[0].message.usage.cacheRead, 30);
    assert.equal(usage[0].message.usage.cacheWrite, 4);
    assert.deepEqual(usage[0].message.content, []);
    assert.equal(entries.filter((entry) => entry.type === "compaction").length, outcome === "stop" ? 1 : 0);
    if (outcome !== "stop") {
      assert.deepEqual(agent.state.messages.slice(0, original.length), original);
      const added = agent.state.messages.slice(original.length);
      assert.equal(added.length, outcome === "cancel" ? 1 : 0);
      if (outcome === "cancel") assert.ok(added[0]?.role === "assistant" && added[0].stopReason === "aborted");
    }
  }
});

test("small windows reserve actual output room without treating empty history as pressure", async () => {
  for (const window of [8192, 16384]) {
    const { faux, agent, control, log, model } = setup(window);
    const events: CompactionEvent[] = [];
    control.subscribe((event) => events.push(event));
    await control.compact();
    assert.equal(faux.state.callCount, 0);
    assert.equal(records(log).length, 1);
    faux.setResponses([fauxAssistantMessage("ready")]);
    await agent.prompt("hello");
    assert.equal(faux.state.callCount, 1);
    assert.equal(records(log).some((entry) => entry.type === "compaction"), false);
    assert.ok(contextBudget(model).ceiling > 0);
    assert.equal(events.at(-1)?.status, "completed");
  }
});

test("automatic compaction commits before the working request and survives load without another summary", async () => {
  const { agent, faux, log, model } = setup(16384, history(45000));
  agent.state.thinkingLevel = "high";
  const original = readFileSync(log.path, "utf8");
  let summaryCalls = 0;
  faux.setResponses(Array.from({ length: MAX_SUMMARY_CALLS + 2 }, () => (context, options, _state, called) => {
    if (called.maxTokens <= 4096) {
      summaryCalls++;
      assert.equal(options?.maxTokens, contextBudget(model).summary);
      assert.equal(called.maxTokens, contextBudget(model).summary);
      assert.equal(options?.reasoning, undefined);
      assert.ok(!context.messages.some((message) => message.role === "system" && message.toolsAdded?.length));
      return summary();
    }
    assert.ok(records(log).some((entry) => entry.type === "compaction"));
    assert.ok(JSON.stringify(context).includes("secret.txt"));
    assert.ok(JSON.stringify(context).includes("continue now"));
    assert.ok(JSON.stringify(context).includes('"name":"bash"'));
    return fauxAssistantMessage("constraints retained");
  }));
  await agent.prompt("continue now");
  assert.ok(summaryCalls > 0 && summaryCalls <= MAX_SUMMARY_CALLS);
  assert.equal(records(log).filter((entry) => entry.purpose === "compaction").length, summaryCalls);
  assert.equal(agent.state.thinkingLevel, "high");
  assert.ok(readFileSync(log.path, "utf8").startsWith(original));
  const loaded = SessionLog.open(log.home, log.id);
  assert.ok(loaded.messages.reduce((sum, message) => sum + messageTokens(message), 0) < loaded.history.reduce((sum, message) => sum + messageTokens(message), 0));
  assert.ok(JSON.stringify(loaded.messages).includes("secret.txt"));
  assert.ok(!JSON.stringify(loaded.messages).includes("prior evidence prior evidence"));
  assert.equal(loaded.usageMessages.length, 1);
  const resumed = createRxAgent({ models: setup().models, model, cwd: log.cwd, thinking: "off", systemPrompt: "Updated current instructions", log: loaded.log, origin: "cli", messages: loaded.messages });
  assert.match(resumed.state.systemPrompt, /Updated current instructions/);
  assert.equal(records(log).filter((entry) => entry.type === "compaction").length, 1);
});

test("manual compaction preserves recent images and removes all old native reasoning and tool protocol", async () => {
  const messages = history();
  messages.push({ ...fauxAssistantMessage([{ type: "thinking", thinking: "private old reasoning", thinkingSignature: "signed-old" }, fauxToolCall("read", { path: "picture.png" }, { id: "call-1" })]), stopReason: "toolUse" });
  messages.push({ role: "toolResult", toolCallId: "call-1", toolName: "read", isError: false, content: [{ type: "text", text: "read evidence" }], timestamp: Date.now() });
  messages.push({ role: "user", content: [{ type: "text", text: "Inspect this image next" }, { type: "image", data: "AAAA", mimeType: "image/png" }], timestamp: Date.now() });
  const { agent, faux, control, log } = setup(32768, messages);
  faux.setResponses(Array.from({ length: MAX_SUMMARY_CALLS }, summary));
  await control.compact();
  const active = JSON.stringify(agent.state.messages);
  assert.doesNotMatch(active, /private old reasoning|signed-old|"type":"toolCall"|"role":"toolResult"/);
  assert.match(active, /"data":"AAAA"/);
  assert.match(active, /Recorded tool call read/);
  assert.match(readFileSync(log.path, "utf8"), /signed-old/);
});

test("an 8K model compacts nonempty history and continues within its smaller budget", async () => {
  const { agent, faux, log, model } = setup(8192, history(12000));
  let summaries = 0;
  faux.setResponses(Array.from({ length: MAX_SUMMARY_CALLS + 1 }, () => (_context, options, _state, called) => {
    if (called.maxTokens < 4096) {
      summaries++;
      assert.equal(options?.maxTokens, contextBudget(model).summary);
      return summary();
    }
    return fauxAssistantMessage("continued");
  }));
  await agent.prompt("continue under the original restriction");
  assert.ok(summaries > 0 && summaries <= MAX_SUMMARY_CALLS);
  assert.equal(records(log).filter((entry) => entry.type === "compaction").length, 1);
  assert.equal(agent.state.messages.at(-1)?.role, "assistant");
  assert.equal((agent.state.messages.at(-1) as AssistantMessage).stopReason, "stop");
});

test("empty, truncated, tool-calling, and failed summaries preserve history while retaining measured usage", async () => {
  const invalid: AssistantMessage[] = [
    fauxAssistantMessage(""),
    { ...summary(), stopReason: "length" },
    { ...summary(), stopReason: "error", errorMessage: "quota exceeded" },
    fauxAssistantMessage([fauxToolCall("bash", { command: "touch forbidden" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("x".repeat(10000)),
  ];
  for (const response of invalid) {
    const { agent, faux, control, log } = setup(16384, history());
    const before = readFileSync(log.path, "utf8");
    const active = JSON.stringify(agent.state.messages);
    faux.setResponses([response]);
    const events: CompactionEvent[] = [];
    control.subscribe((event) => events.push(event));
    await assert.rejects(control.compact());
    assert.ok(readFileSync(log.path, "utf8").startsWith(before));
    assert.equal(records(log).filter((entry) => entry.type === "compaction").length, 0);
    assert.deepEqual(SessionLog.open(log.home, log.id).history, JSON.parse(active).filter((message: AgentMessage) => message.role !== "system"));
    assert.equal(JSON.stringify(agent.state.messages), active);
    assert.equal(events.at(-1)?.status, "failed");
    assert.equal(faux.state.callCount, 1);
  }
});

test("manual Stop aborts the summary, closes activity, writes an aborted response, and permits a later prompt", async () => {
  const { agent, faux, control, log } = setup(16384, history());
  const events: CompactionEvent[] = [];
  const unsubscribe = control.subscribe((event) => { events.push(event); if (event.status === "in_progress") control.abort(); });
  await assert.rejects(control.compact());
  await control.waitForIdle();
  assert.equal(events.at(-1)?.status, "failed");
  assert.equal(records(log).filter((entry) => entry.type === "compaction").length, 0);
  assert.equal(records(log).at(-1).message.stopReason, "aborted");
  unsubscribe();
  faux.setResponses(Array.from({ length: MAX_SUMMARY_CALLS + 2 }, () => (_context, _options, _state, called) => called.maxTokens <= 4096 ? summary() : fauxAssistantMessage("continued")));
  await agent.prompt("continue");
  assert.match(JSON.stringify(agent.state.messages.at(-1)), /continued/);
});

test("provider-confirmed oversized instructions and input preserve the complete original request", async () => {
  for (const mode of ["instructions", "input"]) {
    const { agent, faux, log } = setup(8192, [], mode === "instructions" ? "fixed ".repeat(10000) : "Brief instructions");
    const input = mode === "input" ? "current ".repeat(10000) : "go";
    faux.setResponses([{ ...fauxAssistantMessage([]), stopReason: "error", errorMessage: "context_length_exceeded" }]);
    await assert.rejects(agent.prompt(input));
    assert.equal(faux.state.callCount, 1);
    const last = agent.state.messages.at(-1);
    assert.ok(last?.role === "assistant" && last.stopReason === "error");
    const logged = records(log).find((entry) => entry.message?.role === "user").message;
    assert.equal(typeof logged.content === "string" ? logged.content : logged.content.map((block: { text: string }) => block.text).join(""), input);
    assert.ok(!records(log).some((entry) => entry.type === "compaction"));
  }
});

test("huge archives hit a fixed summary-call limit before any paid call", async () => {
  const { control, faux, log } = setup(8192, history(200000));
  const before = readFileSync(log.path, "utf8");
  await assert.rejects(control.compact(), /more than 8 summary requests/);
  assert.equal(faux.state.callCount, 0);
  assert.equal(readFileSync(log.path, "utf8"), before);
});

test("only explicit context overflow retries once after a durable reduction", async () => {
  for (const error of ["context_length_exceeded", "TLS failure", "insufficient_credits", "400 bad request"]) {
    const { agent, faux, log } = setup(32768, history(18000));
    let working = 0;
    faux.setResponses(Array.from({ length: MAX_SUMMARY_CALLS + 3 }, () => (_context, _options, _state, called) => {
      if (called.maxTokens <= 4096) return summary();
      working++;
      return { ...fauxAssistantMessage([]), stopReason: "error", errorMessage: error };
    }));
    await agent.prompt("continue");
    assert.equal(working, error === "context_length_exceeded" ? 2 : 1);
    assert.equal(records(log).filter((entry) => entry.type === "compaction").length, error === "context_length_exceeded" ? 1 : 0);
    assert.equal(records(log).filter((entry) => entry.message?.stopReason === "error").length, working);
  }
});

test("an overflow with visible output does not retry", async () => {
  const { agent, faux, log } = setup(32768, history());
  faux.setResponses([{ ...fauxAssistantMessage("already delivered"), stopReason: "error", errorMessage: "context_length_exceeded" }]);
  await agent.prompt("continue");
  assert.equal(faux.state.callCount, 1);
  assert.equal(records(log).some((entry) => entry.type === "compaction"), false);
});

test("dense text estimates account for CJK and visible transcripts do not truncate tool evidence", () => {
  assert.ok(textTokens("压".repeat(1000)) >= 1000);
  const message: AgentMessage = { role: "toolResult", toolCallId: "r", toolName: "read", content: [{ type: "text", text: "head" + "x".repeat(10000) + "critical tail" }], isError: false, timestamp: Date.now() };
  assert.match(JSON.stringify(visibleMessage(message)), /critical tail/);
  assert.ok(messageTokens(user("压".repeat(1000))) >= 1000);
});

test("overflow recovery does not execute a completed file side effect twice", async () => {
  const { agent, faux, log } = setup(32768, history());
  let requests = 0;
  faux.setResponses(Array.from({ length: MAX_SUMMARY_CALLS + 4 }, () => (_context, _options, _state, called) => {
    if (called.maxTokens <= 4096) return summary();
    requests++;
    if (requests === 1) return fauxAssistantMessage([fauxToolCall("bash", { command: "printf x >> side-effect.txt" }, { id: "once" })], { stopReason: "toolUse" });
    if (requests === 2) return { ...fauxAssistantMessage([]), stopReason: "error", errorMessage: "context_length_exceeded" };
    return fauxAssistantMessage("continued without repeating the tool");
  }));
  await agent.prompt("perform the task once");
  assert.equal(readFileSync(`${log.cwd}/side-effect.txt`, "utf8"), "x");
  assert.equal(requests, 3);
  assert.equal(records(log).filter((entry) => entry.message?.role === "toolResult").length, 1);
});

test("a checkpoint append failure cannot install an in-memory summary", async (t) => {
  const { agent, faux, control, log } = setup(16384, history());
  const before = JSON.stringify(agent.state.messages);
  const bytes = readFileSync(log.path, "utf8");
  faux.setResponses(Array.from({ length: MAX_SUMMARY_CALLS }, summary));
  t.mock.method(log, "appendCheckpoint", () => { throw new Error("Checkpoint write failed"); });
  await assert.rejects(control.compact(), /Checkpoint write failed/);
  assert.equal(JSON.stringify(agent.state.messages), before);
  assert.ok(readFileSync(log.path, "utf8").startsWith(bytes));
  assert.equal(records(log).filter((entry) => entry.type === "compaction").length, 0);
  assert.deepEqual(SessionLog.open(log.home, log.id).history, JSON.parse(before).filter((message: AgentMessage) => message.role !== "system"));
});

test("Stop reaches an active summary model request and a late Stop preserves a committed checkpoint", async () => {
  for (const afterCommit of [false, true]) {
    const { agent, faux, control, log } = setup(16384, history());
    const events: CompactionEvent[] = [];
    let started!: () => void;
    const start = new Promise<void>((resolve) => { started = resolve; });
    faux.setResponses([async (_context, options) => {
      started();
      if (!afterCommit) {
        await new Promise<void>((resolve) => options!.signal!.addEventListener("abort", () => resolve(), { once: true }));
        return { ...fauxAssistantMessage([]), stopReason: "aborted" };
      }
      return summary();
    }]);
    control.subscribe((event) => {
      events.push(event);
      if (afterCommit && event.status === "completed") control.abort();
    });
    const pending = control.compact();
    await start;
    if (!afterCommit) control.abort();
    if (afterCommit) await pending;
    else await assert.rejects(pending);
    assert.equal(events.at(-1)?.status, afterCommit ? "completed" : "failed");
    assert.equal(records(log).filter((entry) => entry.type === "compaction").length, afterCommit ? 1 : 0);
    assert.equal(records(log).at(-1).message.stopReason, "aborted");
    assert.equal(agent.state.messages.at(-1)?.role, "assistant");
  }
});

test("a provider that ignores the wire cap is aborted during summary streaming without a checkpoint", async (t) => {
  const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
  const { models, control, log } = setup(16384, history());
  const bytes = readFileSync(log.path, "utf8");
  let cutOff = false;
  t.mock.method(models, "streamSimple", (...args: Parameters<typeof models.streamSimple>) => {
    const options = args[2];
    assert.ok(options?.signal);
    const signal = options.signal;
    const stream = createAssistantMessageEventStream();
    const partial = fauxAssistantMessage("x".repeat(8000));
    queueMicrotask(() => {
      stream.push({ type: "start", partial: { ...partial, content: [] } });
      stream.push({ type: "text_delta", contentIndex: 0, delta: "x".repeat(8000), partial });
      signal.addEventListener("abort", () => {
        cutOff = true;
        const error = { ...partial, stopReason: "aborted" as const };
        stream.push({ type: "error", reason: "aborted", error });
        stream.end(error);
      }, { once: true });
    });
    return stream;
  });
  const events: CompactionEvent[] = [];
  control.subscribe((event) => events.push(event));
  await assert.rejects(control.compact(), /exceeded its output budget/);
  assert.equal(cutOff, true);
  assert.equal(events.at(-1)?.status, "failed");
  assert.doesNotMatch(events.at(-1)?.message ?? "", /cancelled/);
  assert.equal(readFileSync(log.path, "utf8"), bytes);
});
