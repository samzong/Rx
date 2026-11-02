import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { agents, credentials, runAgent, tokenerCodexDefaults, type AgentName, type CodexConfiguration } from "./adapters.ts";
import { Budget } from "./budget.ts";
import { copyTree, inside, loadTasks, privateDirectory, privateJson, saveArtifacts } from "./files.ts";
import { grade, selfCheck } from "./grading.ts";
import { inspectImage, isStopping, retainImage, runnerVersion, stopContainers } from "./process.ts";
import { canRetry, summarize } from "./report.ts";
import type { AgentResult, Attempt } from "./schema.ts";

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  agent: { type: "string", default: "rx-agent" }, root: { type: "string", default: join(homedir(), ".rx", "evals") },
  split: { type: "string", default: "all" }, image: { type: "string", default: "rx-evals:local" },
  "self-check": { type: "boolean", default: false }, limit: { type: "string" },
  task: { type: "string", multiple: true },
  env: { type: "string", multiple: true },
  "codex-provider": { type: "string" }, "codex-model": { type: "string" }, "codex-effort": { type: "string" },
} });
if (!agents.includes(values.agent as AgentName)) throw new Error("Agent must be rx-agent, claude, codex, or external.");
if (!["all", "development", "holdout"].includes(values.split)) throw new Error("Split must be all, development, or holdout.");
const agent = values.agent as AgentName;
let codex: CodexConfiguration | undefined;
if (values["codex-provider"] || values["codex-model"] || values["codex-effort"]) {
  const model = values["codex-model"] ?? tokenerCodexDefaults.model;
  if (agent !== "codex" || values["codex-provider"] !== "tokener" || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(model)) throw new Error("Use --agent codex --codex-provider tokener with a valid --codex-model.");
  const effort = values["codex-effort"] ?? tokenerCodexDefaults.effort;
  if (!["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(effort)) throw new Error("Use a supported Codex reasoning effort.");
  codex = { provider: "tokener", model, effort };
}
const root = realpathSync(resolve(values.root));
const checkout = fileURLToPath(new URL("../../", import.meta.url));
const relativeToCheckout = (await import("node:path")).relative(checkout, root);
if (relativeToCheckout === "" || (!relativeToCheckout.startsWith("../") && !relativeToCheckout.startsWith("/"))) throw new Error("Keep the eval dataset outside the repository.");
const available = loadTasks(root).filter(({ task }) => values.split === "all" || task.split === values.split);
if (values.task?.some((id) => !available.some(({ task }) => task.id === id))) throw new Error("A requested task is absent from the selected split.");
const cohort = available.filter(({ task }) => !values.task?.length || values.task.includes(task.id));
const limit = values.limit === undefined ? cohort.length : Number(values.limit);
if (!Number.isInteger(limit) || limit < 1) throw new Error("Limit must be a positive integer.");
const selected = cohort.slice(0, limit);
if (!selected.length) throw new Error("The selected split has no tasks.");
const image = inspectImage(values.image);
const scratchBase = tmpdir();
const runId = `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${agent}`;
const output = join(root, "runs", runId);
privateDirectory(output);
const budget = new Budget(root, runId);
let allocatedScratch: string | undefined;
let releaseImage: (() => void) | undefined;
try {
  releaseImage = retainImage(image.id);
  const scratch = allocatedScratch = mkdtempSync(join(scratchBase, "rx-evals-"));
  const attempts: Attempt[] = selected.map(({ task }) => ({ task: task.id, split: task.split, attempt: 0, state: "planned", seconds: 0, checks: [] }));
  const metadata = { version: 1, agent, configuration: codex, image, runnerCommit: runnerVersion(), taskSetHash: createHash("sha256").update(selected.map(({ hash }) => hash).join("\n")).digest("hex"), taskHashes: selected.map(({ task, hash }) => ({ id: task.id, hash, inputHash: createHash("sha256").update(JSON.stringify([task.initial.sha256, task.requirement, task.environment])).digest("hex"), grader: task.acceptance.revision })), budget: { timeoutSeconds: 900, concurrency: 2, maxAgentSeconds: 72_000, maxRetries: 1, maxOutputBytes: 16 * 1024 * 1024 }, started: new Date().toISOString() };
  const save = () => privateJson(join(output, "result.json"), { ...metadata, attempts, summary: summarize(attempts) });
  save();
  let index = 0;
  const env = credentials(agent, process.env, values.env, codex);
  const calibration = [];
  for (const { task, root: taskRoot, hash } of selected) {
    const proof = await selfCheck(image.id, scratch, taskRoot, task);
    calibration.push({ task: task.id, hash, ...proof });
    privateJson(join(output, "calibration.json"), calibration);
    if (!proof.reference || !proof.alternative || !proof.incorrectRejected) throw new Error(`The grader controls failed for ${task.id}.`);
  }
  privateJson(join(output, "calibration.json"), calibration);
  if (!values["self-check"] && agent !== "external" && !Object.keys(env).length) throw new Error("No agent credential was supplied through the environment.");
  const worker = async () => {
    while (!isStopping() && index < selected.length) {
      const item = selected[index++]!;
      for (let retry = 0; retry < 2; retry++) {
        if (isStopping() || !budget.reserve()) return;
        const attempt: Attempt = retry === 0 ? attempts.find((row) => row.task === item.task.id)! : { task: item.task.id, split: item.task.split, attempt: 1, state: "planned", seconds: 0, checks: [] };
        if (retry) attempts.push(attempt);
        const trial = mkdtempSync(join(scratch, "trial-"));
        const work = join(trial, "work");
        const started = Date.now();
        attempt.started = new Date(started).toISOString();
        save();
        try {
          copyTree(inside(item.root, item.task.initial.directory), work);
          const prompt = [item.task.requirement.prompt, ...item.task.requirement.constraints, ...item.task.environment.instructions].join("\n");
          const result = await runAgent(agent, image.id, work, prompt, env, positionals, codex);
          attempt.result = result;
          if (isStopping()) throw new Error("The eval run stopped during the trial.");
          const answer = join(work, ".eval-answer.txt");
          rmSync(answer, { force: true });
          writeFileSync(answer, result.text, { flag: "wx", mode: 0o600 });
          attempt.artifacts = saveArtifacts(work, join(output, "artifacts", `${item.task.id}-${retry}`), Object.values(env));
          attempt.checks = await grade(image.id, work, item.root, item.task, started + 900_000, Object.values(env));
          if (isStopping()) throw new Error("The eval run stopped during grading.");
          attempt.state = result.completed && attempt.checks.every((check) => check.passed) ? "completed" : "failed";
          if (!attempt.checks.length) attempt.state = "unscored";
        } catch (error) {
          const message = error instanceof Error ? error.message : "The trial failed.";
          const partial = (error as { partialResult?: AgentResult } | null)?.partialResult;
          if ((error as { abortRun?: boolean } | null)?.abortRun) { process.exitCode = 1; await stopContainers(); }
          if (partial) attempt.result = partial;
          attempt.state = !isStopping() && (message.includes("exceeded its declared time budget") || message.includes("output exceeded its limit")) ? "failed" : "infra_error";
          if (!attempt.artifacts && existsSync(work)) attempt.artifacts = saveArtifacts(work, join(output, "artifacts", `${item.task.id}-${retry}`), Object.values(env));
          attempt.reason = Object.values(env).reduce((text, secret) => text.replaceAll(secret, "[REDACTED]"), message);
        } finally {
          attempt.seconds = (Date.now() - started) / 1000;
          budget.finish(attempt.seconds);
          rmSync(trial, { recursive: true, force: true });
          save();
          console.log(JSON.stringify({ task: attempt.task, split: attempt.split, attempt: retry, state: attempt.state, seconds: attempt.seconds }));
        }
        if (!canRetry(attempt.state)) break;
      }
    }
  };
  if (!values["self-check"]) {
    const outcomes = await Promise.allSettled([worker(), worker()].map((work) => work.catch(async (error) => { await stopContainers(); throw error; })));
    const failure = outcomes.find((outcome) => outcome.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
  save();
  console.log(JSON.stringify({ run: runId, selfCheck: values["self-check"], summary: summarize(attempts) }));
} finally {
  await stopContainers();
  try { budget.close(); } finally {
    if (allocatedScratch) rmSync(allocatedScratch, { recursive: true, force: true });
    releaseImage?.();
  }
}
