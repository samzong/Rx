import { createInterface } from "node:readline";
import { cpSync, mkdirSync } from "node:fs";
import { launchProcess } from "./launch.ts";

interface Launch { argv: string[]; env: Record<string, string> }
let buffered = Buffer.alloc(0);
process.stdin.on("data", function header(chunk: Buffer) {
  try {
    buffered = Buffer.concat([buffered, chunk]);
    if (buffered.length > 1024 * 1024) throw new Error("The launch header exceeded its limit.");
    const end = buffered.indexOf(10);
    if (end < 0) return;
    process.stdin.removeListener("data", header);
    const launch = JSON.parse(buffered.subarray(0, end).toString()) as Launch;
    for (const path of ["/home/node/.rx", "/home/node/.codex", "/home/node/.claude"]) mkdirSync(path, { recursive: true, mode: 0o700 });
    if (!Array.isArray(launch.argv) || !launch.argv.length || !launch.argv.every((value) => typeof value === "string")) throw new Error("Invalid process arguments.");
    if (process.argv[2] === "--grader") {
      cpSync("/work", "/grade/work", { recursive: true });
      process.chdir("/grade/work");
    }
    const secrets = Object.values(launch.env).filter(Boolean);
    const redact = (text: string) => secrets.reduce((result, value) => result.replaceAll(value, "[REDACTED]"), text);
    let running: ReturnType<typeof launchProcess>;
    try {
      running = launchProcess(launch.argv[0]!, launch.argv.slice(1), {
        env: { PATH: process.env.PATH, HOME: "/home/node", XDG_CONFIG_HOME: "/home/node/.config", RX_HOME: "/home/node/.rx", CODEX_HOME: "/home/node/.codex", CLAUDE_CONFIG_DIR: "/home/node/.claude", ...launch.env },
        detached: true,
      });
    } catch {
      process.stderr.write("The agent command could not start.\n");
      process.exitCode = 127;
      return;
    }
    const { child, closed } = running;
    for (const [stream, output] of [[child.stdout, process.stdout], [child.stderr, process.stderr]] as const) {
      createInterface({ input: stream }).on("line", (line) => output.write(`${redact(line)}\n`));
    }
    child.on("error", () => { process.stderr.write("The agent command could not start.\n"); });
    void closed.then((code) => { process.exitCode = code; });
    process.stdin.pipe(child.stdin);
    const rest = buffered.subarray(end + 1);
    if (rest.length) child.stdin.write(rest);
    if (process.stdin.readableEnded) child.stdin.end();
    child.stdin.on("error", () => {});
    const stop = () => { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} } };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
  } catch (error) {
    if (process.argv[2] !== "--grader") throw error;
    process.stderr.write("The grader could not prepare its inputs.\n");
    process.exit(125);
  }
});
