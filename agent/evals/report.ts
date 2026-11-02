import type { Attempt, Dimension, RunState } from "./schema.ts";

export function canRetry(state: RunState): boolean { return state === "infra_error"; }

export function summarize(attempts: Attempt[]) {
  return ["development", "holdout"].map((split) => {
    const rows = attempts.filter((attempt) => attempt.split === split);
    const firstScored = new Map<string, Attempt>();
    for (const row of rows) {
      const previous = firstScored.get(row.task);
      if (previous?.state !== "completed" && previous?.state !== "failed") firstScored.set(row.task, row);
    }
    const selected = [...firstScored.values()];
    const states: Record<RunState, number> = { planned: 0, completed: 0, failed: 0, infra_error: 0, unscored: 0 };
    for (const row of selected) states[row.state]++;
    const dimensions = Object.fromEntries((["correctness", "constraints", "evidence"] satisfies Dimension[]).map((dimension) => {
      const scored = selected.filter((attempt) => attempt.checks.some((check) => check.dimension === dimension));
      const passed = scored.filter((attempt) => attempt.checks.filter((check) => check.dimension === dimension).every((check) => check.passed));
      return [dimension, { passed: passed.length, n: scored.length }];
    }));
    return { metric: "pass@1", infrastructureErrors: rows.filter((row) => row.state === "infra_error").length, split, n: selected.length, states, dimensions, retries: rows.length - selected.length, seconds: rows.reduce((sum, row) => sum + row.seconds, 0), humanInterventions: "unknown" };
  });
}
