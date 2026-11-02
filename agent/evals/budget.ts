import { closeSync, existsSync, openSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Attempt } from "./schema.ts";

export class Budget {
  readonly previousSeconds: number;
  private spent = 0;
  private reserved = 0;
  private readonly lock: string;
  constructor(root: string, current: string) {
    this.lock = join(root, "run.lock");
    let fd: number;
    try { fd = openSync(this.lock, "wx", 0o600); } catch { throw new Error("Another eval run owns this dataset. Inspect run.lock before removing a stale lock."); }
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
    try {
      this.previousSeconds = readdirSync(join(root, "runs")).filter((name) => name !== current).reduce((total, name) => {
        const path = join(root, "runs", name, "result.json");
        if (!existsSync(path)) return total;
        const prior = JSON.parse(readFileSync(path, "utf8")) as { attempts?: Attempt[] };
        return total + (prior.attempts ?? []).reduce((sum, attempt) => {
          if (!Number.isFinite(attempt.seconds) || attempt.seconds < 0) throw new Error("The runtime ledger contains an invalid duration.");
          return sum + (attempt.state === "planned" && attempt.started ? 900 : attempt.seconds);
        }, 0);
      }, 0);
    } catch (error) { this.close(); throw error; }
  }
  reserve(): boolean {
    if (this.previousSeconds + this.spent + this.reserved + 900 > 72_000) return false;
    this.reserved += 900;
    return true;
  }
  finish(seconds: number): void { this.reserved -= 900; this.spent += seconds; }
  close(): void { unlinkSync(this.lock); }
}
