import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { capture, dockerRun, inspectImage } from "./process.ts";
import { privateDirectory, privateJson } from "./files.ts";

const image = inspectImage("rx-evals:local");
const scratch = mkdtempSync(join(tmpdir(), "rx-evals-"));
try {
  const result = await capture(dockerRun(image.id, scratch, ["node", "/opt/rx/evals/lifecycle-check.ts"]), "", 30_000);
  const output = join(homedir(), ".rx", "evals", "lifecycle");
  privateDirectory(output);
  privateJson(join(output, `${Date.now()}.json`), { image, ...result });
  if (result.code !== 0) throw new Error(`The lifecycle suite failed: ${result.stderr}`);
  console.log(result.stdout.trim());
} finally { rmSync(scratch, { recursive: true, force: true }); }
