import assert from "node:assert/strict";
import { test } from "node:test";
import * as acp from "@agentclientprotocol/sdk/unstable";
import { Agent } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createAcpApp } from "../src/acp.ts";
import { SessionLog } from "../src/session-log.ts";
import { fauxModels, tempDir } from "./helpers.ts";

process.env.HOME = tempDir();
process.env.RX_HOME = tempDir();

test("identical steering input in one millisecond acknowledges only the consumed message", { timeout: 10000 }, async (t) => {
  const { faux, models, model } = fauxModels();
  const home = tempDir();
  const cwd = tempDir();
  const marker = "identical steering input";
  const applied: unknown[] = [];
  let requestStarted!: () => void;
  let releaseRequest!: () => void;
  let queued!: () => void;
  const enqueued = new Promise<void>((resolve) => { queued = resolve; });
  const requestGate = new Promise<void>((resolve) => { releaseRequest = resolve; });
  let release!: () => void;
  const started = new Promise<void>((resolve) => { requestStarted = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let consumed = 0;
  faux.setResponses([
    async () => {
      requestStarted();
      await requestGate;
      return fauxAssistantMessage("ready");
    },
    async (context) => {
      consumed = context.messages.filter((message) => message.role === "user" && JSON.stringify(message.content).includes(marker)).length;
      await gate;
      return fauxAssistantMessage("done");
    },
  ]);
  const sessions: NonNullable<Parameters<typeof createAcpApp>[1]> = new Map();
  const client = acp.client()
    .onNotification("_lody/session/steer_applied", (value: unknown) => value, ({ params }) => { applied.push(params); });
  await client.connectWith(createAcpApp({ home, models, choose: async () => ({ model, thinking: "off" }) }, sessions), async (ctx) => {
    const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd, mcpServers: [] });
    const agent = sessions.get(sessionId)!.agent;
    const steer = agent.steer.bind(agent);
    let queuedCount = 0;
    t.mock.method(agent, "steer", (message: Parameters<Agent["steer"]>[0]) => {
      steer(message);
      if (++queuedCount === 2) queued();
    });
    const prompt = ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "wait" }] });
    await started;
    const clock = t.mock.method(Date, "now", () => 1700000000000);
    const input = { sessionId, prompt: [{ type: "text", text: marker }] };
    const first = ctx.request("_lody/session/steer", { ...input, steerId: "first" });
    const second = ctx.request("_lody/session/steer", { ...input, steerId: "second" }).then((value) => value, (error: unknown) => error);
    try {
      await enqueued;
      releaseRequest();
      assert.deepEqual(await first, { outcome: "injected" });
      clock.mock.restore();
      await ctx.notify(acp.methods.agent.session.cancel, { sessionId });
      release();
      assert.equal((await prompt).stopReason, "cancelled");
      const result = await second;
      assert.ok(result instanceof acp.RequestError, JSON.stringify(result));
      assert.equal(result.code, -32600);
      assert.match(result.message, /prompt ended before steer delivery/);
      assert.equal(consumed, 1);
      assert.deepEqual(applied, [{ sessionId, steerId: "first" }]);
      const saved = SessionLog.open(home, sessionId);
      assert.equal(saved.entries.filter((entry) => entry.message.role === "user" && JSON.stringify(entry.message.content).includes(marker)).length, 1);
    } finally {
      clock.mock.restore();
      releaseRequest();
      release();
    }
  });
});
