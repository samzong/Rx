import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { test } from "node:test";
import * as acp from "@agentclientprotocol/sdk/unstable";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { builtinModels, getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { createAcpApp } from "../src/acp.ts";
import { tempDir } from "./helpers.ts";

process.env.HOME = tempDir();
process.env.RX_HOME = tempDir();

test("a fresh agent process uses launch defaults for fork and applies explicit sessionConfig", { timeout: 15_000 }, async (t) => {
  const home = tempDir();
  const cwd = tempDir();
  const credentials = new InMemoryCredentialStore();
  const access = "local-process-test";
  await credentials.modify("openai-codex", async () => ({ type: "oauth", access, refresh: "local", expires: Date.now() + 3600000 }));
  const models = builtinModels({ credentials });
  const model = getBuiltinModel("openai-codex", "gpt-6.1-sol");
  const app = createAcpApp({ home, models, choose: async () => ({ model, thinking: "high" }) });
  const initialize = { protocolVersion: 1, clientCapabilities: { session: { configOptions: { boolean: {} } } } };
  await acp.client().connectWith(app, async (source) => {
    await source.request(acp.methods.agent.initialize, initialize);
    const { sessionId } = await source.request(acp.methods.agent.session.new, { cwd, mcpServers: [] });
    await source.request(acp.methods.agent.session.setConfigOption, { sessionId, configId: "thinking", value: "low" });
    await source.request(acp.methods.agent.session.setConfigOption, { sessionId, configId: "fast", type: "boolean", value: true });
    const sourcePath = join(home, "sessions", `${sessionId}.jsonl`);
    const before = readFileSync(sourcePath);
    const script = `
      import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
      import { builtinModels, getBuiltinModel } from '@earendil-works/pi-ai/providers/all';
      import { serveAcp } from ${JSON.stringify(new URL("../src/acp.ts", import.meta.url).href)};
      const credentials = new InMemoryCredentialStore();
      await credentials.modify('openai-codex', async () => ({type:'oauth',access:process.env.RX_TEST_ACCESS,refresh:'local',expires:Date.now()+3600000}));
      const models = builtinModels({credentials});
      const model = getBuiltinModel('openai-codex','gpt-6-sol');
      const server = serveAcp({home:process.env.RX_HOME,models,choose:async()=>({model,thinking:'high'})});
      process.on('SIGTERM',()=>{void server.stop().finally(()=>process.exit(0));});
      await server.closed;
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      cwd: join(import.meta.dirname, ".."),
      env: { PATH: process.env.PATH, HOME: tempDir(), RX_HOME: home, RX_TEST_ACCESS: access },
      stdio: ["pipe", "pipe", "inherit"],
    });
    const exited = once(child, "exit");
    t.after(async () => {
      child.kill();
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      try { await exited; } finally { clearTimeout(timer); }
    });
    assert.ok(child.pid && child.pid !== process.pid);
    const stream = acp.ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>);
    await acp.client().connectWith(stream, async (forker) => {
      await forker.request(acp.methods.agent.initialize, initialize);
      const defaults = await forker.request(acp.methods.agent.session.fork, { sessionId, cwd });
      const values = (result: acp.ForkSessionResponse) => Object.fromEntries(result.configOptions!.map((option) => [option.id, option.currentValue]));
      assert.deepEqual(values(defaults), { model: "openai-codex/gpt-6-sol", thinking: "high", fast: false });
      const overridden = await forker.request(acp.methods.agent.session.fork, { sessionId, cwd, _meta: { lody: { sessionConfig: { version: 1, modelId: "openai-codex/gpt-6.1-sol", configOptionValues: { thinking: "low", fast: true } } } } });
      assert.deepEqual(values(overridden), { model: "openai-codex/gpt-6.1-sol", thinking: "low", fast: true });
      assert.deepEqual(readFileSync(sourcePath), before);
    });
  });
});
