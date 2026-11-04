import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { nativeResult } from "./adapters.ts";
import { Budget } from "./budget.ts";
import { launchProcess } from "./launch.ts";
import { inside, loadTasks, saveArtifacts, treeHash } from "./files.ts";
import { canRetry, summarize } from "./report.ts";
import { taskSchema, type Attempt, type Task } from "./schema.ts";

const scratchBase = tmpdir();

function dataset() {
  const root = mkdtempSync(join(scratchBase, "rx-evals-test-"));
  mkdirSync(join(root, "tasks"));
  const fixture = join(root, "fixtures", "example");
  for (const name of ["initial", "reference", "alternative", "incorrect", "checks"]) mkdirSync(join(fixture, name), { recursive: true });
  writeFileSync(join(fixture, "initial", "answer.txt"), "wrong");
  const task: Task = { version: 1, id: "example", family: "files", split: "development", requirement: { prompt: "Write the result.", constraints: [] }, initial: { directory: "initial", sha256: treeHash(join(fixture, "initial")), base: "synthetic" }, environment: { instructions: [], runtime: "node" }, acceptance: { directory: "checks", revision: "v1", checks: [{ id: "answer", dimension: "correctness", argv: ["node", "/checks/test.mjs"] }] }, reference: { directory: "reference", alternativeDirectory: "alternative", incorrectDirectory: "incorrect" }, provenance: { sources: [{ kind: "rx", reference: "synthetic-test" }], reconstruction: "Synthetic self-test." } };
  const save = () => writeFileSync(join(root, "tasks", "example.json"), JSON.stringify(task));
  save();
  return { root, fixture, task, save };
}

test("hidden material and symlinks cannot enter the task projection", () => {
  const data = dataset();
  try {
    assert.equal(loadTasks(data.root).length, 1);
    data.task.acceptance.directory = "initial";
    data.save();
    assert.throws(() => loadTasks(data.root));
    data.task.acceptance.directory = "checks";
    data.task.reference.incorrectDirectory = "initial";
    data.save();
    assert.throws(() => loadTasks(data.root));
    symlinkSync(data.root, join(data.fixture, "initial", "escape"));
    assert.throws(() => treeHash(join(data.fixture, "initial")));
    assert.throws(() => inside(data.fixture, "../.."));
  } finally { rmSync(data.root, { recursive: true, force: true }); }
});

test("changed input and a task family across splits fail before execution", () => {
  const data = dataset();
  try {
    const second = { ...data.task, id: "other", split: "holdout" };
    mkdirSync(join(data.root, "fixtures", "other"));
    for (const path of ["initial", "reference", "alternative", "incorrect", "checks"]) mkdirSync(join(data.root, "fixtures", "other", path));
    writeFileSync(join(data.root, "fixtures", "other", "initial", "answer.txt"), "wrong");
    writeFileSync(join(data.root, "tasks", "other.json"), JSON.stringify(second));
    assert.throws(() => loadTasks(data.root));
    writeFileSync(join(data.fixture, "initial", "answer.txt"), "changed");
    assert.throws(() => loadTasks(data.root));
    assert.equal(taskSchema.safeParse({ ...data.task, initial: { ...data.task.initial, directory: "../answer" } }).success, false);
  } finally { rmSync(data.root, { recursive: true, force: true }); }
});

test("only infrastructure failures retry and the first scored attempt determines pass@1", () => {
  const attempts: Attempt[] = [
    { task: "a", split: "development", attempt: 0, state: "failed", seconds: 3, checks: [{ id: "a", dimension: "correctness", passed: false, exitCode: 1 }] },
    { task: "b", split: "holdout", attempt: 0, state: "infra_error", seconds: 2, checks: [{ id: "b", dimension: "correctness", passed: false, exitCode: null }] },
    { task: "a", split: "development", attempt: 1, state: "completed", seconds: 4, checks: [{ id: "a", dimension: "correctness", passed: true, exitCode: 0 }] },
    { task: "c", split: "development", attempt: 0, state: "planned", seconds: 0, checks: [] },
  ];
  const summary = summarize(attempts);
  assert.equal(summary[0]!.n, 2);
  assert.equal(canRetry("failed"), false);
  assert.equal(canRetry("infra_error"), true);
  assert.equal(summary[0]!.states.completed, 0);
  assert.equal(summary[0]!.states.failed, 1);
  assert.deepEqual(summary[0]!.dimensions.correctness, { passed: 0, n: 1 });
  assert.equal(summary[0]!.metric, "pass@1");
  assert.equal(summary[0]!.states.planned, 1);
  assert.equal(summary[0]!.retries, 1);
  assert.equal(summary[0]!.seconds, 7);
  assert.equal(summary[1]!.states.infra_error, 1);
  assert.equal(summary[1]!.infrastructureErrors, 1);
  assert.deepEqual(summary[1]!.dimensions.correctness, { passed: 0, n: 0 });
  const recovered = summarize([...attempts, { task: "b", split: "holdout", attempt: 1, state: "completed", seconds: 1, checks: [{ id: "b", dimension: "correctness", passed: true, exitCode: 0 }] }])[1]!;
  assert.equal(recovered.states.completed, 1);
  assert.equal(recovered.infrastructureErrors, 1);
});

test("an external command that cannot start is infrastructure failure rather than a failed score", async () => {
  const root = mkdtempSync(join(scratchBase, "rx-evals-launch-"));
  try {
    const denied = join(root, "denied");
    writeFileSync(denied, "inaccessible");
    chmodSync(denied, 0o600);
    for (const command of [join(root, "missing"), denied]) {
      const { child, closed } = launchProcess(command, []);
      child.stdin.end();
      const result = nativeResult("external", await closed, "");
      assert.equal(result.completed, false);
      assert.ok(result.infrastructureError);
      assert.equal(canRetry(result.infrastructureError ? "infra_error" : "failed"), true);
      const summary = summarize([{ task: "launch", split: "development", attempt: 0, state: "infra_error", seconds: 0, checks: [] }])[0]!;
      assert.deepEqual(summary.dimensions.correctness, { passed: 0, n: 0 });
    }
    for (const code of [1, 254]) {
      const { child, closed } = launchProcess(process.execPath, ["-e", `process.exit(${code})`]);
      child.stdin.end();
      const result = nativeResult("external", await closed, "");
      assert.equal(result.exitCode, code);
      assert.equal(result.completed, false);
      assert.equal(result.infrastructureError, undefined);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the time budget includes previous agents and reserves in-flight trials", () => {
  const root = mkdtempSync(join(scratchBase, "rx-evals-budget-"));
  mkdirSync(join(root, "runs", "prior"), { recursive: true });
  writeFileSync(join(root, "runs", "prior", "result.json"), JSON.stringify({ attempts: [{ state: "failed", seconds: 70_000 }] }));
  const budget = new Budget(root, "current");
  try {
    assert.equal(budget.reserve(), true);
    assert.equal(budget.reserve(), true);
    assert.equal(budget.reserve(), false);
    assert.throws(() => new Budget(root, "other"));
    budget.finish(100);
    assert.equal(budget.reserve(), true);
  } finally { budget.close(); rmSync(root, { recursive: true, force: true }); }
});

test("retained artifacts redact supplied credentials and omit links", () => {
  const data = dataset();
  try {
    const secret = "synthetic-credential-value";
    const source = join(data.fixture, "reference");
    writeFileSync(join(source, `${secret}.bin`), Buffer.from(`before\0${secret}\0after`));
    symlinkSync(data.root, join(source, "outside"));
    const target = join(data.root, "retained");
    const artifact = saveArtifacts(source, target, [secret]);
    assert.equal(artifact.redacted, true);
    assert.deepEqual(artifact.omitted, ["outside"]);
    assert.equal(readFileSync(join(target, "[REDACTED].bin")).includes(secret), false);
    assert.equal(artifact.sha256, treeHash(target));
  } finally { rmSync(data.root, { recursive: true, force: true }); }
});
