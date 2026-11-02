import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { sourceHash, treeHash } from "./files.ts";

const active = new Set<Container>();
let stopping = false;
export const isStopping = () => stopping;
export async function stopContainers(): Promise<void> {
  stopping = true;
  await Promise.allSettled([...active].map((container) => container.stop()));
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
  process.exitCode = signal === "SIGINT" ? 130 : 143;
  void stopContainers();
});

export interface Container { child: ChildProcessWithoutNullStreams; name: string; closed: Promise<number | null>; stop(): Promise<void> }
export function retainImage(id: string): () => void {
  const tag = `rx-evals-run:${randomUUID()}`;
  const result = spawnSync("docker", ["image", "tag", id, tag], { encoding: "utf8", timeout: 30_000 });
  if (result.status !== 0) throw new Error("The inspected eval image could not be retained.");
  return () => { spawnSync("docker", ["image", "rm", tag], { stdio: "ignore", timeout: 30_000 }); };
}
export function dockerRun(image: string, work: string, argv: string[], options: { env?: Record<string, string>; checks?: string; network?: boolean } = {}): Container {
  if (stopping) throw new Error("The eval run is stopping.");
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error("Use an inspected Docker image ID.");
  const name = `rx-eval-${randomUUID()}`;
  const args = ["run", "--rm", "--init", "--name", name, "-i", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "256", "--memory", "4g", "--tmpfs", "/tmp:rw,nosuid,nodev,size=1g,mode=1777", "--tmpfs", "/home/node:rw,nosuid,nodev,size=512m,uid=1000,gid=1000", "--mount", `type=bind,source=${work},target=/work${options.checks ? ",readonly" : ""}`, "--workdir", "/work"];
  if (!options.network) args.push("--network", "none");
  if (options.checks) args.push("--mount", `type=bind,source=${options.checks},target=/checks,readonly`, "--tmpfs", "/grade:rw,exec,nosuid,nodev,size=1g,uid=1000,gid=1000,mode=0700");
  args.push(image, "node", "/opt/rx/evals/entry.ts");
  if (options.checks) args.push("--grader");
  const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.on("error", () => {});
  const closed = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  child.stdin.write(`${JSON.stringify({ argv, env: options.env ?? {} })}\n`);
  let stopped = false;
  const container: Container = { child, name, closed, stop: async () => {
    if (stopped) return;
    stopped = true;
    spawnSync("docker", ["rm", "-f", name], { stdio: "ignore", timeout: 15_000 });
    child.kill("SIGKILL");
    await closed.catch(() => {});
    active.delete(container);
  } };
  active.add(container);
  return container;
}

export async function capture(container: Container, input = "", timeoutMs = 900_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const chunks: Record<"stdout" | "stderr", Buffer[]> = { stdout: [], stderr: [] };
  let bytes = 0;
  let overflow = false;
  const append = (part: "stdout" | "stderr", chunk: Buffer) => {
    if (bytes + chunk.length > 16 * 1024 * 1024) { overflow = true; void container.stop(); return; }
    bytes += chunk.length;
    chunks[part].push(chunk);
  };
  container.child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
  container.child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
  let expired = false;
  const timer = setTimeout(() => { expired = true; void container.stop(); }, timeoutMs);
  container.child.stdin.end(input);
  try {
    const code = await container.closed;
    const stdout = Buffer.concat(chunks.stdout).toString();
    const stderr = Buffer.concat(chunks.stderr).toString();
    if (expired) return { code: 124, stdout, stderr: `${stderr}\nThe task exceeded its declared time budget.\n` };
    if (overflow) return { code: 122, stdout, stderr: `${stderr}\nThe process output exceeded its limit.\n` };
    return { code, stdout, stderr };
  } finally { clearTimeout(timer); await container.stop(); }
}

export function inspectImage(name: string): { id: string; architecture: string; versions: string[]; sourceHash: string; runnerHash: string } {
  const result = spawnSync("docker", ["image", "inspect", name], { encoding: "utf8", timeout: 30_000 });
  if (result.status !== 0) throw new Error("The eval image is missing. Run make eval-image.");
  const image = JSON.parse(result.stdout)[0] as { Id: string; Architecture: string };
  const script = "node --version; rx-agent --version; claude --version; codex --version; node --input-type=module -e 'import {treeHash} from \"/opt/rx/evals/files.ts\"; console.log(JSON.stringify({...JSON.parse((await import(\"node:fs\")).readFileSync(\"/opt/rx/source.json\",\"utf8\")),runnerHash:treeHash(\"/opt/rx/evals\")}))'";
  const probe = spawnSync("docker", ["run", "--rm", "--network", "none", "--read-only", image.Id, "sh", "-c", script], { encoding: "utf8", timeout: 30_000 });
  if (probe.status !== 0) throw new Error("The eval image failed its version probe.");
  const lines = probe.stdout.trim().split("\n");
  const hashes = JSON.parse(lines.pop()!) as { sourceHash: string; runnerHash: string };
  if (hashes.sourceHash !== sourceHash(fileURLToPath(new URL("..", import.meta.url))) || hashes.runnerHash !== treeHash(fileURLToPath(new URL(".", import.meta.url)))) throw new Error("The eval image contains different source. Run make eval-image.");
  return { id: image.Id, architecture: image.Architecture, versions: lines, ...hashes };
}

export function runnerVersion(): string {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "unknown";
}
