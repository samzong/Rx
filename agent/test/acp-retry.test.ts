import assert from "node:assert/strict";
import { test } from "node:test";
import * as acp from "@agentclientprotocol/sdk";
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createAcpApp } from "../src/acp.ts";
import { SessionLog } from "../src/session-log.ts";
import { contextBudget } from "../src/context.ts";
import { fauxModels, tempDir } from "./helpers.ts";

process.env.HOME = tempDir();
process.env.RX_HOME = tempDir();

for (const cancel of [false, true]) {
  test(`ACP ${cancel ? "cancels" : "recovers"} a failed stream and closes the retry activity before the prompt response`, async () => {
    const { models, model, faux } = fauxModels();
    const home = tempDir();
    const cwd = tempDir();
    faux.setResponses([
      fauxAssistantMessage(cancel ? [fauxToolCall("bash", { command: "touch unexpected" }, { id: "incomplete" })] : "PARTIAL", { stopReason: "error", errorMessage: "Stream ended without finish_reason" }),
      fauxAssistantMessage("COMPLETE"),
    ]);
    const updates: acp.SessionUpdate[] = [];
    const app = createAcpApp({ home, models, choose: async () => ({ model, thinking: "off" }) });
    let connection: acp.ClientContext;
    const client = acp.client().onNotification(acp.methods.client.session.update, async ({ params }) => {
      updates.push(params.update);
      if (cancel && params.update.sessionUpdate === "tool_call") await connection.notify(acp.methods.agent.session.cancel, { sessionId: params.sessionId });
    });
    await client.connectWith(app, async (ctx) => {
      connection = ctx;
      const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd, mcpServers: [] });
      const result = await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "test" }] });
      assert.equal(result.stopReason, cancel ? "cancelled" : "end_turn");
      const activities = updates.filter((update) => update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update");
      assert.equal(activities.length, 2);
      assert.deepEqual(activities.map((update) => update.status), ["in_progress", cancel ? "failed" : "completed"]);
      assert.equal(activities[0]!.toolCallId, activities[1]!.toolCallId);
      assert.deepEqual(activities[0]!._meta, { lody: { activity: { version: 1, kind: "retry" } } });
      assert.equal(faux.state.callCount, cancel ? 1 : 2);
      if (cancel) {
        const last = SessionLog.open(home, sessionId).messages.at(-1);
        assert.ok(last?.role === "assistant" && last.stopReason === "aborted");
        assert.deepEqual(last.content, []);
      } else {
        const sequence = updates.filter((update) => update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "tool_call");
        assert.deepEqual(sequence.map((update) => update.sessionUpdate === "agent_message_chunk" ? update.content : update.title), [
          { type: "text", text: "PARTIAL" }, "Retrying model request (1/3)", { type: "text", text: "COMPLETE" },
        ]);
      }
    });
  });
}

test("ACP provider failures stay errors with an actionable hint and the session accepts another prompt", async () => {
  const { models, model, faux } = fauxModels();
  const cwd = tempDir();
  faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 invalid API key" }), fauxAssistantMessage("recovered")]);
  const app = createAcpApp({ home: tempDir(), models, choose: async () => ({ model, thinking: "off" }) });
  await acp.client().connectWith(app, async (ctx) => {
    const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd, mcpServers: [] });
    await assert.rejects(ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "test" }] }), (error: unknown) => {
      assert.ok(error instanceof acp.RequestError);
      assert.equal(error.code, -32010);
      assert.deepEqual(error.data, { type: "provider_error" });
      assert.match(error.message, /Model provider request failed:.*Check the provider credential/);
      return true;
    });
    assert.equal(faux.state.callCount, 1);
    const result = await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "continue" }] });
    assert.equal(result.stopReason, "end_turn");
  });
});

for (const failure of ["length", "usage"] as const) {
  test(`ACP automatic compaction ${failure} failure remains an internal error`, async () => {
    const { models, model } = fauxModels();
    const selected = { ...model, contextWindow: 16384 };
    const home = tempDir();
    const cwd = tempDir();
    const log = SessionLog.create(home, cwd);
    log.append("cli", { role: "user", content: "Keep the original constraints. " + "historical evidence ".repeat(2400), timestamp: Date.now() });
    log.append("model", fauxAssistantMessage("Completed the earlier step."));
    const rejected = fauxAssistantMessage("Rejected summary. [log 1-1]", { stopReason: failure === "length" ? "length" : "stop" });
    if (failure === "usage") rejected.usage = { ...rejected.usage, output: contextBudget(selected).summary + 1 };
    let calls = 0;
    models.streamSimple = (requested) => {
      calls++;
      assert.ok(requested.maxTokens <= 4096);
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "done", reason: failure === "length" ? "length" : "stop", message: rejected });
        stream.end(rejected);
      });
      return stream;
    };
    const app = createAcpApp({ home, models, choose: async () => ({ model: selected, thinking: "off" }) });
    await acp.client().connectWith(app, async (ctx) => {
      await ctx.request(acp.methods.agent.session.load, { sessionId: log.id, cwd, mcpServers: [] });
      await assert.rejects(ctx.request(acp.methods.agent.session.prompt, { sessionId: log.id, prompt: [{ type: "text", text: "continue" }] }), (error: unknown) => {
        assert.ok(error instanceof acp.RequestError);
        assert.equal(error.code, -32603);
        assert.doesNotMatch(error.message, /Model provider request failed|Check the provider|balance|account limit/);
        assert.notDeepEqual(error.data, { type: "provider_error" });
        return true;
      });
      assert.equal(calls, 2);
    });
  });
}
