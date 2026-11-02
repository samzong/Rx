import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { SESSION_USAGE_METHOD, type ModelUsage, type SessionUsageUpdate } from "../src/acp-session-usage.ts";

const root = mkdtempSync(join(existsSync("/Volumes/git/scratch") ? "/Volumes/git/scratch" : tmpdir(), "rx-acp-usage-"));
const cwd = join(root, "work");
mkdirSync(cwd);
const model = process.argv[2] ?? process.env.RX_MODEL ?? "deepseek/deepseek-flash";
const expectUnknownCost = process.argv.includes("--unknown-cost");
const updates: SessionUsageUpdate[] = [];
const child = spawn(process.execPath, [new URL("../src/cli.ts", import.meta.url).pathname, "acp", "-m", model], {
  env: { ...process.env, RX_HOME: join(root, "home") }, stdio: ["pipe", "pipe", "inherit"],
});
const exited = new Promise<void>((resolve, reject) => { child.once("exit", () => resolve()); child.once("error", reject); });
const deadline = setTimeout(() => child.kill(), 120_000);
const client = acp.client().onNotification(SESSION_USAGE_METHOD, (params) => params as SessionUsageUpdate, ({ params }) => { updates.push(params); });
const total = (usage: ModelUsage) => usage.inputTokens + usage.outputTokens + usage.cacheReadInputTokens + (usage.cacheCreationInputTokens ?? 0) + (usage.reasoningOutputTokens ?? 0);
const stream = acp.ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>);
try {
  await client.connectWith(stream, async (ctx) => {
    const init = await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION });
    assert.deepEqual((init.agentCapabilities?._meta?.lody as { usage: unknown }).usage, { version: 1 });
    const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd, mcpServers: [] });
    const snapshots: SessionUsageUpdate[] = [];
    for (const word of ["first", "second"]) {
      const before = updates.length;
      const result = await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: `Reply with exactly ${word}. Do not use tools.` }] });
      assert.equal(result.stopReason, "end_turn");
      assert.ok(updates.length > before);
      const snapshot = updates.at(-1)!;
      assert.equal(snapshot.sessionId, sessionId);
      assert.ok(total(snapshot.usage) > 0);
      if (expectUnknownCost) {
        for (const update of updates.slice(before)) {
          for (const usage of [update.usage, ...Object.values(update.modelUsage), update.delta.usage, ...Object.values(update.delta.modelUsage)]) {
            assert.equal(Object.hasOwn(usage, "costUSD"), false);
          }
        }
      }
      snapshots.push(snapshot);
      console.log(word, JSON.stringify({ modelUsage: snapshot.modelUsage, usageScopeId: snapshot._meta.lody.usageScopeId }));
    }
    const [first, second] = snapshots;
    assert.equal(first!._meta.lody.usageScopeId, second!._meta.lody.usageScopeId);
    for (const [key, usage] of Object.entries(first!.modelUsage)) {
      assert.ok(total(second!.modelUsage[key]!) > total(usage));
      if (usage.costUSD !== undefined && second!.modelUsage[key]!.costUSD !== undefined) assert.ok(second!.modelUsage[key]!.costUSD! >= usage.costUSD);
    }
    console.log("usage accounting: PASS", updates.length, "notifications", expectUnknownCost ? "costUSD absent in usage, modelUsage, and delta" : "");
  });
} finally {
  clearTimeout(deadline);
  child.kill();
  await exited;
  rmSync(root, { recursive: true, force: true });
}
