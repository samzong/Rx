import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { copyTree, inside } from "./files.ts";
import { capture, dockerRun } from "./process.ts";
import type { CheckResult, Task } from "./schema.ts";

export async function grade(image: string, work: string, taskRoot: string, task: Task, deadline = Date.now() + 900_000, secrets: string[] = []): Promise<CheckResult[]> {
  const checks: CheckResult[] = [];
  const scratch = mkdtempSync(join(dirname(work), "checks-"));
  const directory = join(scratch, "checks");
  copyTree(inside(taskRoot, task.acceptance.directory), directory);
  try { for (const check of task.acceptance.checks) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("The task exceeded its declared time budget.");
    const result = await capture(dockerRun(image, work, check.argv, { checks: directory }), "", remaining);
    if (result.code === 125 || result.code === 126 || result.code === 127) throw new Error(`The grader process did not start: ${secrets.reduce((value, secret) => value.replaceAll(secret, "[REDACTED]"), result.stderr).slice(0, 4096)}`);
    checks.push({ id: check.id, dimension: check.dimension, passed: result.code === 0, exitCode: result.code, stdout: secrets.reduce((value, secret) => value.replaceAll(secret, "[REDACTED]"), result.stdout), stderr: secrets.reduce((value, secret) => value.replaceAll(secret, "[REDACTED]"), result.stderr) });
  } } finally { rmSync(scratch, { recursive: true, force: true }); }
  return checks;
}

export async function selfCheck(image: string, scratch: string, taskRoot: string, task: Task): Promise<{ reference: boolean; alternative: boolean; incorrectRejected: boolean; controls: CheckResult[][] }> {
  const results: boolean[] = [];
  const controls: CheckResult[][] = [];
  for (const path of [task.reference.directory, task.reference.alternativeDirectory, task.reference.incorrectDirectory]) {
    const root = mkdtempSync(join(scratch, "grader-"));
    try {
      const work = join(root, "work");
      copyTree(inside(taskRoot, path), work);
      const checks = await grade(image, work, taskRoot, task);
      controls.push(checks);
      results.push(checks.every((check) => check.passed));
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  return { reference: results[0]!, alternative: results[1]!, incorrectRejected: !results[2], controls };
}
