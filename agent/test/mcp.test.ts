import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { connectMcp, mcpToolName } from "../src/mcp.ts";
import { assertProcessExited, mcpPid, tempDir } from "./helpers.ts";

const fixture = new URL("./fixtures/mcp-server.ts", import.meta.url).pathname;
const stdio = (name = "fixture", args: string[] = []) => ({ name, command: process.execPath, args: [fixture, ...args], env: [] });

test("MCP merges user and ACP servers and preserves results and tool failures", async () => {
  const home = tempDir();
  const cwd = tempDir();
  writeFileSync(join(home, "mcp.json"), JSON.stringify({ mcpServers: { user: { command: process.execPath, args: [fixture] }, fixture: { command: "missing-command" } } }));
  const mcp = await connectMcp({ home, cwd, servers: [stdio()] });
  try {
    assert.equal(mcp.tools.length, 14);
    assert.equal(new Set(mcp.tools.map((tool) => tool.name)).size, 14);
    for (const tool of mcp.tools) assert.match(tool.name, /^[A-Za-z0-9_]{1,64}$/);
    const echo = mcp.tools.find((tool) => tool.name === "mcp__fixture__echo")!;
    assert.deepEqual((await echo.execute("1", { value: "tool answer" })).content, [{ type: "text", text: "tool answer" }]);
    const failed = await mcp.tools.find((tool) => tool.name === "mcp__fixture__fail")!.execute("2", {});
    assert.equal(failed.isError, true);
    assert.equal(failed.content[0]?.type, "text");
    const structured = await mcp.tools.find((tool) => tool.name === "mcp__fixture__structured")!.execute("3", {});
    assert.match(JSON.stringify(structured.content), /42/);
    assert.equal(existsSync(join(home, "sessions")), false);
  } finally { await mcp.close(); }
});

test("MCP names remain distinct after normalization and truncation", () => {
  const pairs = [["a-b", "tool"], ["a_b", "tool"], ["a", "b.c"], ["a", "b_c"], ["a", "x".repeat(80)], ["a", `${"x".repeat(80)}y`], ["Workspace Docs 文档", "echo"], ["a__b", "c"], ["a", "b__c"], ["a_", "b"], ["a", "_b"]];
  const names = pairs.map(([server, tool]) => mcpToolName(server!, tool!));
  assert.equal(new Set(names).size, pairs.length);
  for (const name of names) assert.match(name, /^[A-Za-z0-9_]{1,64}$/);
});

test("MCP duplicate tool discovery reports a safe distinct failure and closes its child", async (t) => {
  const trace = join(tempDir(), "duplicate.jsonl");
  t.after(async () => { if (existsSync(trace)) { try { process.kill(await mcpPid(trace), "SIGKILL"); } catch {} } });
  const mcp = await connectMcp({ home: tempDir(), cwd: tempDir(), servers: [stdio("duplicate", ["--duplicate-tool", `--trace=${trace}`]), stdio("healthy")] });
  try {
    assert.match(mcp.warnings.join("\n"), /MCP server duplicate not connected: duplicate tool name/);
    assert.equal(mcp.tools.some((tool) => tool.name.startsWith("mcp__duplicate__")), false);
    assert.deepEqual((await mcp.tools.find((tool) => tool.name === "mcp__healthy__echo")!.execute("1", { value: "HEALTHY" })).content, [{ type: "text", text: "HEALTHY" }]);
  } finally { await mcp.close(); }
  await assertProcessExited(await mcpPid(trace));
});

test("MCP partial startup failure keeps healthy servers connected", async (t) => {
  const trace = join(tempDir(), "partial.jsonl");
  t.after(async () => { if (existsSync(trace)) { try { process.kill(await mcpPid(trace), "SIGKILL"); } catch {} } });
  const mcp = await connectMcp({ home: tempDir(), cwd: tempDir(), servers: [stdio("ready", [`--trace=${trace}`]), { name: "bad", command: "/missing-rx-mcp", args: [], env: [] }] });
  try {
    process.kill(await mcpPid(trace), 0);
    assert.match(mcp.warnings.join("\n"), /MCP server bad/);
    assert.equal(mcp.tools.length, 7);
  } finally { await mcp.close(); }
  await assertProcessExited(await mcpPid(trace));
});

test("MCP timeout and cancellation fail visibly and close the server", async () => {
  const home = tempDir();
  const cwd = tempDir();
  const trace = join(home, "trace.jsonl");
  writeFileSync(join(home, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [fixture, `--trace=${trace}`], timeout: 0.3 } } }));
  const mcp = await connectMcp({ home, cwd });
  const slow = mcp.tools.find((tool) => tool.name === "mcp__fixture__slow")!;
  try {
    await assert.rejects(slow.execute("timeout", {}), /MCP server fixture: request timed out/);
    const controller = new AbortController();
    const request = slow.execute("cancel", {}, controller.signal);
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(request, /MCP server fixture: request cancelled/);
  } finally { await mcp.close(); }
  const events = readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(events.some(({ event }) => event === "cancelled"));
  const pid = events[0].pid;
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("MCP startup failures, malformed configuration, and legacy SSE leave sessions usable", async () => {
  const home = tempDir();
  const cwd = tempDir();
  const missing = await connectMcp({ home, cwd, servers: [{ name: "bad", command: "/missing-rx-mcp", args: [], env: [] }] });
  assert.match(missing.warnings.join("\n"), /MCP server bad not connected: executable or working directory not found/);
  assert.equal(missing.tools.length, 0);
  await missing.close();
  const sse = await connectMcp({ home, cwd, servers: [{ name: "sse", type: "sse", url: "http://localhost/sse", headers: [] }] });
  assert.match(sse.warnings.join("\n"), /legacy SSE/);
  await sse.close();
  writeFileSync(join(home, "mcp.json"), '{"secret":"do-not-echo",');
  const malformed = await connectMcp({ home, cwd, servers: [stdio()] });
  assert.match(malformed.warnings.join("\n"), /invalid JSON/);
  assert.equal(malformed.warnings.join("\n").includes("do-not-echo"), false);
  assert.equal(malformed.tools.length, 7);
  await malformed.close();
  writeFileSync(join(home, "mcp.json"), JSON.stringify({ mcpServers: { hanging: { command: process.execPath, args: [fixture, "--hang"], timeout: 0.3 } } }));
  const hanging = await connectMcp({ home, cwd });
  assert.match(hanging.warnings.join("\n"), /request timed out/);
  assert.equal(hanging.tools.length, 0);
  await hanging.close();
  assert.equal(existsSync(join(home, "sessions")), false);
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
