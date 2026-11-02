import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { runAgent, tokenerCodexDefaults } from "./adapters.ts";

const captured = JSON.parse(readFileSync(new URL("./fixtures/codex-0.163.0-errors.json", import.meta.url), "utf8")) as { cases: { id: string; events: { type: string }[]; exitCode: number; abortRun: boolean }[] };

test("captured Codex 0.163.0 terminal failures distinguish rejection from capacity", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "rx-evals-codex-errors-"));
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = [root, dirname(process.execPath), previousPath ?? ""].join(delimiter);
    for (const capture of captured.cases) await t.test(capture.id, async () => {
      const output = capture.events.map((event) => JSON.stringify(event)).join("\n");
      writeFileSync(join(root, "docker"), `#!/usr/bin/env node\nprocess.stdin.resume();process.stdin.on("end",()=>{process.stdout.write(${JSON.stringify(output)});process.exitCode=${capture.exitCode}});\n`, { mode: 0o755 });
      await assert.rejects(runAgent("codex", `sha256:${"0".repeat(64)}`, root, "Synthetic task", { TOKENER_API_KEY: "synthetic-replay-credential" }, undefined, tokenerCodexDefaults), (error: unknown) => {
        assert.equal((error as { abortRun: boolean }).abortRun, capture.abortRun);
        return true;
      });
      if (capture.id === "503-reconnecting") assert.ok(capture.events.filter((event) => event.type === "error").length >= 5);
    });
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(root, { recursive: true, force: true });
  }
});
