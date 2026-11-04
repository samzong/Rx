import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { connectMcp, mcpToolName } from "../src/mcp.ts";
import { mcpPid, tempDir } from "./helpers.ts";

const fixture = new URL("./fixtures/mcp-server.ts", import.meta.url).pathname;
const stdio = (name = "fixture", args: string[] = []) => ({ name, command: process.execPath, args: [fixture, ...args], env: [] });

test("MCP startup timeout closes its child before returning", async (t) => {
  const home = tempDir();
  const trace = join(home, "timeout.jsonl");
  t.after(async () => { if (existsSync(trace)) { try { process.kill(await mcpPid(trace), "SIGKILL"); } catch {} } });
  writeFileSync(join(home, "mcp.json"), JSON.stringify({ mcpServers: { hanging: { command: process.execPath, args: [fixture, "--hang-list", `--trace=${trace}`], timeout: 0.3 } } }));
  const mcp = await connectMcp({ home, cwd: tempDir() });
  try {
    assert.throws(() => process.kill(JSON.parse(readFileSync(trace, "utf8").split("\n")[0]!).pid, 0), { code: "ESRCH" });
    assert.equal(mcp.tools.length, 0);
  } finally { await mcp.close(); }
});

test("MCP expands environment references without changing the user file", async () => {
  const home = tempDir();
  const cwd = tempDir();
  process.env.RX_MCP_VALUE_FOR_TEST = "expanded-value";
  const config = JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [fixture], env: { RX_MCP_TEST_VALUE: "${RX_MCP_VALUE_FOR_TEST}" } }, disabled: { enabled: false } } });
  writeFileSync(join(home, "mcp.json"), config);
  const mcp = await connectMcp({ home, cwd, servers: [{ ...stdio("Workspace Docs 文档"), env: [{ name: "RX_MCP_TEST_VALUE", value: "${RX_MCP_VALUE_FOR_TEST}" }] }] });
  try {
    const result = await mcp.tools.find((tool) => tool.name === "mcp__fixture__echo")!.execute("1", {});
    assert.deepEqual(result.content, [{ type: "text", text: "expanded-value" }]);
    const literal = await mcp.tools.find((tool) => tool.name === mcpToolName("Workspace Docs 文档", "echo"))!.execute("2", {});
    assert.deepEqual(literal.content, [{ type: "text", text: "${RX_MCP_VALUE_FOR_TEST}" }]);
    assert.equal(readFileSync(join(home, "mcp.json"), "utf8"), config);
  } finally { await mcp.close(); delete process.env.RX_MCP_VALUE_FOR_TEST; }
});

test("MCP Streamable HTTP uses ACP headers and returns actual tool content", async () => {
  let authorized = false;
  let deleted = false;
  const server = createServer(async (request, response) => {
    if (request.method === "GET") { response.writeHead(405).end(); return; }
    if (request.method === "DELETE") { deleted = true; response.writeHead(200).end(); return; }
    let text = "";
    for await (const chunk of request) text += chunk;
    const message = JSON.parse(text);
    authorized ||= request.headers.authorization === "Bearer fixture-token";
    response.setHeader("content-type", "application/json");
    response.setHeader("mcp-session-id", "fixture-session");
    if (message.id === undefined) { response.writeHead(202).end(); return; }
    const result = message.method === "initialize"
      ? { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "http-fixture", version: "1" } }
      : message.method === "tools/list" ? { tools: [{ name: "echo", inputSchema: { type: "object" } }] }
      : { content: [{ type: "text", text: "HTTP_MCP_OK" }] };
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const mcp = await connectMcp({ home: tempDir(), cwd: tempDir(), servers: [{ name: "remote", type: "http", url: `http://127.0.0.1:${address.port}/mcp`, headers: [{ name: "Authorization", value: "Bearer fixture-token" }] }] });
    try { assert.deepEqual((await mcp.tools[0]!.execute("1", {})).content, [{ type: "text", text: "HTTP_MCP_OK" }]); }
    finally { await mcp.close(); }
    assert.equal(authorized, true);
    assert.equal(deleted, true);
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});

test("MCP names remain distinct after normalization and truncation", () => {
  const pairs = [["a-b", "tool"], ["a_b", "tool"], ["a", "b.c"], ["a", "b_c"], ["a", "x".repeat(80)], ["a", `${"x".repeat(80)}y`], ["Workspace Docs 文档", "echo"], ["a__b", "c"], ["a", "b__c"], ["a_", "b"], ["a", "_b"]];
  const names = pairs.map(([server, tool]) => mcpToolName(server!, tool!));
  assert.equal(new Set(names).size, pairs.length);
  for (const name of names) assert.match(name, /^[A-Za-z0-9_]{1,64}$/);
});

test("MCP cross-server tool collisions retain the first server and close the skipped child before returning", async (t) => {
  const home = tempDir();
  const firstTrace = join(home, "first.jsonl");
  const skippedTrace = join(home, "skipped.jsonl");
  t.after(async () => { for (const trace of [firstTrace, skippedTrace]) { if (existsSync(trace)) { try { process.kill(await mcpPid(trace), "SIGKILL"); } catch {} } } });
  const collision = mcpToolName("a-b", "t");
  const skippedTool = collision.slice("mcp__a_b__".length);
  assert.equal(mcpToolName("a_b", skippedTool), collision);
  const mcp = await connectMcp({ home, cwd: tempDir(), servers: [
    stdio("a-b", ["--tool=t", `--trace=${firstTrace}`]),
    stdio("a_b", [`--tool=${skippedTool}`, `--trace=${skippedTrace}`]),
  ] });
  try {
    assert.throws(() => process.kill(JSON.parse(readFileSync(skippedTrace, "utf8").split("\n")[0]!).pid, 0), { code: "ESRCH" });
    process.kill(await mcpPid(firstTrace), 0);
    assert.ok(mcp.tools.some((tool) => tool.name === mcpToolName("a-b", "echo")));
    assert.equal(mcp.tools.some((tool) => tool.name === mcpToolName("a_b", "echo")), false);
    assert.ok(mcp.warnings.length > 0);
    assert.deepEqual((await mcp.tools.find((tool) => tool.name === collision)!.execute("1", { value: "FIRST_SERVER" })).content, [{ type: "text", text: "FIRST_SERVER" }]);
    assert.ok(readFileSync(firstTrace, "utf8").split("\n").filter(Boolean).some((line) => JSON.parse(line).event === "t"));
  } finally { await mcp.close(); }
});
