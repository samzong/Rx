import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createModels, fauxProvider, type Api, type Model, type MutableModels } from "@earendil-works/pi-ai";
import { SessionLog, type Origin } from "../src/session-log.ts";

export function tempDir(prefix = "rx-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export async function mcpPid(trace: string): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const text = existsSync(trace) ? readFileSync(trace, "utf8").trim() : "";
    if (text) {
      const entry = text.split("\n").map((line) => JSON.parse(line)).find(({ event }) => event === "start");
      assert.ok(Number.isInteger(entry?.pid) && entry.pid > 0);
      return entry.pid;
    }
    await setTimeout(10);
  }
  assert.fail("MCP fixture did not record its PID");
}

export async function assertProcessExited(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); }
    catch (error) { assert.equal((error as NodeJS.ErrnoException).code, "ESRCH"); return; }
    await setTimeout(10);
  }
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
}

export function foreignSession(cwd: string, entries: [Origin, AgentMessage][] = [], home = tempDir()): { home: string; id: string; path: string; lock: string } {
  const log = SessionLog.create(tempDir(), cwd);
  for (const [origin, message] of entries) log.append(origin, message);
  mkdirSync(join(home, "sessions"), { recursive: true });
  const path = join(home, "sessions", `${log.id}.jsonl`);
  copyFileSync(log.path, path);
  return { home, id: log.id, path, lock: join(home, "sessions", `${log.id}.lock`) };
}

export function fauxModels(): { faux: ReturnType<typeof fauxProvider>; models: MutableModels; model: Model<Api> } {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, models, model: faux.getModel() as Model<Api> };
}
