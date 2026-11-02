import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { sourceHash, treeHash } from "./files.ts";
import type { Attempt, Task } from "./schema.ts";

const image = `sha256:${"0".repeat(64)}`;

test("stopping during an agent or grader records infrastructure failure without a quality score", async (t) => {
  for (const mode of ["SIGINT-agent", "SIGINT-grading", "abortRun-grading"]) await t.test(mode, { timeout: 15_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "rx-evals-stopping-"));
    const marker = join(root, "stopping-point");
    const watcher = watch(root);
    const ready = new Promise<void>((resolve) => watcher.on("change", () => { if (existsSync(marker)) resolve(); }));
    let child: ReturnType<typeof spawn> | undefined;
    let closed: Promise<unknown> | undefined;
    try {
      mkdirSync(join(root, "tasks"));
      for (const id of mode.startsWith("SIGINT") ? ["sibling"] : ["reject", "sibling"]) {
        const fixture = join(root, "fixtures", id);
        for (const name of ["initial", "reference", "alternative", "incorrect", "checks"]) {
          mkdirSync(join(fixture, name), { recursive: true });
          writeFileSync(join(fixture, name, "answer.txt"), ["reference", "alternative"].includes(name) ? "correct" : "wrong");
        }
        const task: Task = { version: 1, id, family: id, split: "development", requirement: { prompt: id, constraints: [] }, initial: { directory: "initial", sha256: treeHash(join(fixture, "initial")), base: "synthetic" }, environment: { instructions: [], runtime: "node" }, acceptance: { directory: "checks", revision: "v1", checks: [{ id: "answer", dimension: "correctness", argv: ["node", "/checks/test.mjs"] }] }, reference: { directory: "reference", alternativeDirectory: "alternative", incorrectDirectory: "incorrect" }, provenance: { sources: [{ kind: "rx", reference: "synthetic-test" }], reconstruction: "Synthetic stop regression." } };
        writeFileSync(join(root, "tasks", `${id}.json`), JSON.stringify(task));
      }
      const hashes = { sourceHash: sourceHash(fileURLToPath(new URL("..", import.meta.url))), runnerHash: treeHash(fileURLToPath(new URL(".", import.meta.url))) };
      writeFileSync(join(root, "docker"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const marker = ${JSON.stringify(marker)};
if (args[0] === "image") {
  if (args[1] === "inspect") console.log(JSON.stringify([{Id:${JSON.stringify(image)},Architecture:"synthetic"}]));
} else if (args[0] === "run" && args.includes("-c")) {
  console.log(${JSON.stringify(`synthetic versions\n${JSON.stringify(hashes)}`)});
} else if (args[0] === "run") {
  let input = "";
  process.stdin.on("data", chunk => input += chunk);
  process.stdin.on("end", () => {
    const split = input.indexOf("\\n");
    const prompt = input.slice(split + 1);
    const work = args.find(value => value.includes("target=/work")).split("source=")[1].split(",target=")[0];
    const hold = () => { setInterval(() => {}, 1000); fs.writeFileSync(marker, "ready"); };
    const success = () => console.log(JSON.stringify({type:"turn.completed"}));
    if (args.includes("--grader")) {
      if (work.includes("trial-")) hold();
      else process.exitCode = fs.readFileSync(work + "/answer.txt", "utf8") === "correct" ? 0 : 1;
    } else if (${JSON.stringify(mode)} === "SIGINT-agent") hold();
    else if (prompt === "reject") {
      const reject = () => { console.log(JSON.stringify({type:"turn.failed",error:{message:"unexpected status 401 Unauthorized"}})); process.exitCode = 1; };
      if (fs.existsSync(marker)) reject();
      else { const watcher = fs.watch(${JSON.stringify(root)}, () => { if (fs.existsSync(marker)) { watcher.close(); reject(); } }); }
    } else success();
  });
}
`, { mode: 0o755 });
      child = spawn(process.execPath, [fileURLToPath(new URL("./run.ts", import.meta.url)), "--agent", "codex", "--codex-provider", "tokener", "--root", root], { env: { PATH: [root, dirname(process.execPath), process.env.PATH ?? ""].join(delimiter), TMPDIR: root, TOKENER_API_KEY: "synthetic-stopping-credential" }, stdio: ["ignore", "pipe", "pipe"] });
      let errors = "";
      child.stderr!.on("data", (chunk: Buffer) => errors += chunk.toString());
      child.stdout!.resume();
      closed = once(child, "close");
      await Promise.race([ready, closed.then(() => { throw new Error(`The runner exited before reaching the stop point: ${errors}`); })]);
      if (mode.startsWith("SIGINT")) child.kill("SIGINT");
      const [code] = await closed as [number];
      assert.equal(code, mode.startsWith("SIGINT") ? 130 : 1, errors);
      const runs = readdirSync(join(root, "runs")).filter((name) => name.endsWith("-codex"));
      assert.equal(runs.length, 1);
      const result = JSON.parse(readFileSync(join(root, "runs", runs[0]!, "result.json"), "utf8")) as { attempts: Attempt[]; summary: { dimensions: { correctness: { n: number } } }[] };
      assert.equal(result.attempts.length, mode.startsWith("SIGINT") ? 1 : 2);
      assert.ok(result.attempts.every((attempt) => attempt.state === "infra_error"));
      assert.equal(result.summary[0]!.dimensions.correctness.n, 0);
    } finally {
      watcher.close();
      child?.kill("SIGKILL");
      await closed;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
