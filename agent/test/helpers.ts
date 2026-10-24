import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createModels, fauxProvider, type Api, type Model, type MutableModels } from "@earendil-works/pi-ai";
import { SessionLog, type Origin } from "../src/session-log.ts";

export function tempDir(prefix = "rx-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
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
