import { spawn } from "node:child_process";
import { once } from "node:events";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { codexArgs, credentials, nativeResult, runAgent, tokenerCodexDefaults } from "./adapters.ts";
import { Budget } from "./budget.ts";
import { launchProcess } from "./launch.ts";
import { inside, loadTasks, saveArtifacts, treeHash } from "./files.ts";
import { capture, dockerRun, type Container } from "./process.ts";
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
    assert.throws(() => loadTasks(data.root), /hidden/);
    data.task.acceptance.directory = "checks";
    data.task.reference.incorrectDirectory = "initial";
    data.save();
    assert.throws(() => loadTasks(data.root), /hidden/);
    symlinkSync(data.root, join(data.fixture, "initial", "escape"));
    assert.throws(() => treeHash(join(data.fixture, "initial")), /regular files/);
    assert.throws(() => inside(data.fixture, "../.."), /escaped/);
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
    assert.throws(() => loadTasks(data.root), /holdout boundary/);
    writeFileSync(join(data.fixture, "initial", "answer.txt"), "changed");
    assert.throws(() => loadTasks(data.root), /Initial state changed/);
    assert.equal(taskSchema.safeParse({ ...data.task, initial: { ...data.task.initial, directory: "../answer" } }).success, false);
  } finally { rmSync(data.root, { recursive: true, force: true }); }
});

test("native completion requires a successful process and terminal event", () => {
  assert.equal(nativeResult("codex", 0, '{"type":"thread.started"}\n').completed, false);
  assert.equal(nativeResult("codex", 0, '{"type":"turn.completed","usage":{"input_tokens":2,"output_tokens":3}}\n').completed, true);
  assert.equal(nativeResult("codex", 1, '{"type":"turn.completed"}\n').completed, false);
  assert.equal(nativeResult("claude", 0, '{"type":"result","subtype":"error_max_turns","is_error":true}').completed, false);
  assert.equal(nativeResult("claude", 0, '{"type":"result","subtype":"success","is_error":false,"result":"ready"}').completed, true);
  assert.equal(nativeResult("claude", 0, "").cost, "unknown");
  assert.ok(nativeResult("codex", 1, '{"type":"error","message":"401 Unauthorized"}').infrastructureError);
  assert.ok(nativeResult("claude", 1, '{"type":"result","subtype":"error_during_execution","api_error_status":429,"is_error":true}').infrastructureError);
  assert.equal(nativeResult("claude", 1, '{"type":"result","subtype":"error_max_turns","is_error":true}').infrastructureError, undefined);
  assert.equal(nativeResult("codex", 0, '{"type":"error"}\n{"type":"turn.completed"}').infrastructureError, undefined);
  assert.equal(nativeResult("external", 0, '{"type":"error","text":"diagnostic only"}').completed, true);
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

test("the tested agent receives only its selected credential variables", () => {
  const env = { ANTHROPIC_API_KEY: "example-a", DEEPSEEK_API_KEY: "example-d", AWS_SECRET_ACCESS_KEY: "unrelated" };
  assert.deepEqual(credentials("rx-agent", env), { DEEPSEEK_API_KEY: "example-d" });
  assert.deepEqual(credentials("claude", env), { ANTHROPIC_API_KEY: "example-a" });
  assert.deepEqual(credentials("codex", env), {});
});


test("Codex Tokener retains native events and ignores non-terminal rejection text", async () => {
  const root = mkdtempSync(join(scratchBase, "rx-evals-tokener-"));
  const previousPath = process.env.PATH;
  try {
    const configuration = { provider: "tokener", model: "example-model", effort: "medium" } as const;
    const source = { TOKENER_API_KEY: "synthetic-gateway-credential", OPENAI_API_KEY: "synthetic-unrelated", CODEX_ACCESS_TOKEN: "synthetic-subscription" };
    const env = credentials("codex", source, [], configuration);
    assert.deepEqual(env, { TOKENER_API_KEY: source.TOKENER_API_KEY });
    assert.deepEqual(credentials("codex", source), { OPENAI_API_KEY: source.OPENAI_API_KEY, CODEX_ACCESS_TOKEN: source.CODEX_ACCESS_TOKEN });
    assert.deepEqual(credentials("claude", source), {});
    const args = codexArgs(configuration);
    assert.ok(args.includes("--ignore-user-config"));
    assert.ok(args.includes('model_provider="tokener"'));
    assert.ok(args.includes('model="example-model"'));
    assert.ok(args.includes('model_reasoning_effort="medium"'));
    assert.ok(args.some((value) => value.includes('env_key="TOKENER_API_KEY"') && value.includes('wire_api="responses"') && value.includes('supports_websockets=false')));
    assert.equal(JSON.stringify(args).includes(source.TOKENER_API_KEY), false);
    assert.equal(codexArgs().some((value) => value.includes("tokener")), false);
    writeFileSync(join(root, "docker"), '#!/usr/bin/env node\nprocess.stdin.resume();process.stdin.on("end",()=>{process.stdout.write(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"ready"}})+"\\n"+JSON.stringify({type:"turn.completed",usage:{input_tokens:12,output_tokens:3}})+"\\n")});\n', { mode: 0o755 });
    process.env.PATH = [root, dirname(process.execPath), previousPath ?? ""].join(delimiter);
    const result = await runAgent("codex", `sha256:${"0".repeat(64)}`, root, "Synthetic task", env, undefined, configuration);
    assert.equal(result.completed, true);
    assert.equal(result.text, "ready");
    assert.equal(result.model, configuration.model);
    assert.equal(result.thinking, configuration.effort);
    assert.deepEqual(result.configuration, configuration);
    assert.deepEqual(result.usage, { input: 12, output: 3 });
    assert.equal(result.cost, "unknown");
    for (const message of ["unexpected status 503: model gpt-6-sol is not available", "unexpected status 500: invalid max_output_tokens", "unexpected status 400: invalid max_output_tokens", "unexpected status 404: route not found", "model_not_found"]) {
      const transient = [
        ...Array.from({ length: 5 }, (_, index) => ({ type: "error", message: `Reconnecting... ${index + 1}/5 (unexpected status 401: invalid token, model_not_found)` })),
        { type: "item.completed", item: { type: "agent_message", text: "The fixture contains status 401 and model_not_found." } },
        { type: "turn.failed", error: { message } },
      ].map((event) => JSON.stringify(event)).join("\n");
      writeFileSync(join(root, "docker"), `#!/usr/bin/env node\nprocess.stdin.resume();process.stdin.on("end",()=>{process.stdout.write(${JSON.stringify(transient)});process.exitCode=1});\n`, { mode: 0o755 });
      await assert.rejects(runAgent("codex", `sha256:${"0".repeat(64)}`, root, "Synthetic task", env, undefined, tokenerCodexDefaults), (error: unknown) => {
        assert.equal((error as { abortRun: boolean }).abortRun, false);
        return true;
      });
    }
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(root, { recursive: true, force: true });
  }
});

test("grader Docker mounts protect artifacts and checks while agent work stays writable", async () => {
  const root = mkdtempSync(join(scratchBase, "rx-evals-mounts-"));
  const previousPath = process.env.PATH;
  const containers: Container[] = [];
  try {
    writeFileSync(join(root, "docker"), "#!/usr/bin/env node\nprocess.stdin.resume();\n", { mode: 0o755 });
    process.env.PATH = [root, dirname(process.execPath), previousPath ?? ""].join(delimiter);
    for (const checks of [join(root, "checks"), undefined]) {
      const container = dockerRun(`sha256:${"0".repeat(64)}`, join(root, "work"), ["node", "check.mjs"], { checks });
      containers.push(container);
      const args = container.child.spawnargs.slice(1);
      assert.ok(args.includes(`type=bind,source=${join(root, "work")},target=/work${checks ? ",readonly" : ""}`));
      assert.equal(args.some((value) => value.includes("target=/checks")), !!checks);
      if (checks) assert.ok(args.includes(`type=bind,source=${checks},target=/checks,readonly`));
      assert.equal(args.some((value, index) => args[index - 1] === "--tmpfs" && value.startsWith("/grade:")), !!checks);
      assert.equal((await capture(container)).code, 0);
    }
  } finally {
    await Promise.all(containers.map((container) => container.stop()));
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(root, { recursive: true, force: true });
  }
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
    assert.throws(() => new Budget(root, "other"), /owns this dataset/);
    budget.finish(100);
    assert.equal(budget.reserve(), true);
  } finally { budget.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a timed-out process retains the output produced before termination", async () => {
  const child = spawn(process.execPath, ["-e", "process.stdin.on('data',()=>process.stdout.write('partial-output\\n')); process.stdout.write('ready\\n'); setInterval(()=>{},1000)"], { stdio: ["pipe", "pipe", "pipe"] });
  const closed = once(child, "close").then(([code]) => code as number | null);
  try {
    await once(child.stdout, "data");
    const container: Container = { child, name: "synthetic-process", closed, stop: async () => { child.kill(); await closed; } };
    const result = await capture(container, "go", 200);
    assert.equal(result.code, 124);
    assert.match(result.stdout, /partial-output/);
    assert.match(result.stderr, /declared time budget/);
  } finally { child.kill(); await closed; }
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


test("captured output preserves split UTF-8 and enforces a byte limit", async () => {
  for (const [source, input, code, expected] of [
    ["process.stdin.on('data',()=>{process.stdout.write(Buffer.from([228,184]));setTimeout(()=>process.stdout.write(Buffer.from([173])),80)});setTimeout(()=>process.exit(),300)", "go", 0, "中"],
    ["process.stdout.write('界'.repeat(6*1024*1024))", "", 122, undefined],
  ] as const) {
    const child = spawn(process.execPath, ["-e", source], { stdio: ["pipe", "pipe", "pipe"] });
    const closed = once(child, "close").then(([value]) => value as number | null);
    try {
      const result = await capture({ child, name: "synthetic-output", closed, stop: async () => { child.kill(); await closed; } }, input, 5000);
      assert.equal(result.code, code);
      if (expected !== undefined) assert.equal(result.stdout, expected);
      assert.ok(Buffer.byteLength(result.stdout) <= 16 * 1024 * 1024 + 3);
    } finally { child.kill(); await closed; }
  }
});
