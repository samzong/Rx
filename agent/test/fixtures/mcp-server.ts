import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const trace = process.argv.find((arg) => arg.startsWith("--trace="))?.slice(8);
const writeTrace = (event: string) => { if (trace) appendFileSync(trace, `${JSON.stringify({ event, pid: process.pid })}\n`); };
const respond = (id: number | string, result: unknown) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
const timers = new Map<number | string, ReturnType<typeof setTimeout>>();
const input = createInterface({ input: process.stdin });
writeTrace("start");
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    if (process.argv.includes("--hang")) return;
    respond(message.id, { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "rx-mcp-fixture", version: "1" } });
  } else if (message.method === "tools/list") {
    const names = ["echo", "fail", "slow", "structured", "a.b", "a_b", "a".repeat(90)];
    if (process.argv.includes("--duplicate-tool")) names.push("echo");
    respond(message.id, { tools: names.map((name) => ({ name, description: `Fixture ${name} tool`, inputSchema: { type: "object", properties: { value: { type: "string" } } } })) });
  } else if (message.method === "tools/call") {
    const name = message.params.name;
    writeTrace(name);
    if (name === "slow") {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: message.params._meta?.progressToken, progress: 1, total: 2 } })}\n`);
      timers.set(message.id, setTimeout(() => respond(message.id, { content: [{ type: "text", text: "slow result" }] }), 20_000));
    } else if (name === "fail") respond(message.id, { isError: true, content: [{ type: "text", text: "fixture tool refused" }] });
    else if (name === "structured") respond(message.id, { structuredContent: { answer: 42 } });
    else respond(message.id, { content: [{ type: "text", text: message.params.arguments?.value ?? process.env.RX_MCP_TEST_VALUE ?? "MCP_FIXTURE_OK" }] });
  } else if (message.method === "notifications/cancelled") {
    writeTrace("cancelled");
    clearTimeout(timers.get(message.params.requestId));
    timers.delete(message.params.requestId);
  }
});
input.on("close", () => {
  for (const timer of timers.values()) clearTimeout(timer);
  writeTrace("close");
});
