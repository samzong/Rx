import { createInterface } from "node:readline";

const schema = JSON.parse(process.argv[2]!);
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const result = message.method === "initialize"
    ? { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "ref-fixture", version: "1" } }
    : message.method === "tools/list"
      ? { tools: [{ name: "seat", description: "Create a seat", inputSchema: schema }] }
      : { content: [{ type: "text", text: JSON.stringify(message.params.arguments) }] };
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
});
