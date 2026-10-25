import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { connectMcp } from "../src/mcp.ts";
import { assertProcessExited, mcpPid, tempDir } from "./helpers.ts";

const fixture = new URL("./fixtures/mcp-server.ts", import.meta.url).pathname;
const stdio = (name: string, trace?: string) => ({ name, command: process.execPath, args: [fixture, ...(trace ? [`--trace=${trace}`] : [])], env: [] });
const initialized = { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } };

async function endpoint(t: TestContext, handle: (message: { id?: number | string; method: string }, request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(async (request, response) => {
    if (request.method !== "POST") { response.writeHead(request.method === "DELETE" ? 200 : 405).end(); return; }
    let text = "";
    for await (const chunk of request) text += chunk;
    response.setHeader("content-type", "application/json");
    handle(JSON.parse(text), request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

test("MCP isolates invalid entries and missing env/header references without exposing values", async () => {
  const home = tempDir();
  const path = join(home, "mcp.json");
  const config = JSON.stringify({ mcpServers: {
    badHeader: { url: "http://127.0.0.1:1", headers: { Authorization: "secret-prefix-${RX_MCP_UNSET_STARTUP_TEST}" } },
    badEnv: { command: process.execPath, args: [fixture], env: { TOKEN: "${RX_MCP_UNSET_STARTUP_TEST}" } },
    invalid: { command: "/private-command-value", env: { TOKEN: "private-env-value" }, unexpected: "private-field-value" },
    shape: "private-invalid-value",
    healthy: { command: process.execPath, args: [fixture] },
  } });
  assert.equal(process.env.RX_MCP_UNSET_STARTUP_TEST, undefined);
  writeFileSync(path, config);
  const mcp = await connectMcp({ home, cwd: tempDir() });
  try {
    assert.equal(mcp.tools.length, 7);
    assert.ok(mcp.tools.every((tool) => tool.name.startsWith("mcp__healthy__")));
    assert.equal(mcp.warnings.length, 4);
    const warnings = mcp.warnings.join("\n");
    assert.match(warnings, /headers needs environment variable RX_MCP_UNSET_STARTUP_TEST/);
    assert.match(warnings, /env needs environment variable RX_MCP_UNSET_STARTUP_TEST/);
    assert.doesNotMatch(warnings, /secret-prefix|private-/);
    assert.equal(readFileSync(path, "utf8"), config);
    assert.equal(existsSync(join(home, "sessions")), false);
  } finally { await mcp.close(); }
});

test("MCP invalid root configuration still connects ACP servers", async () => {
  for (const text of ['{"private-value":', '{"mcpServers":[]}', '[]', '{"unexpected":"private-value"}']) {
    const home = tempDir();
    writeFileSync(join(home, "mcp.json"), text);
    const mcp = await connectMcp({ home, cwd: tempDir(), servers: [stdio("client")] });
    try {
      assert.equal(mcp.tools.length, 7);
      assert.match(mcp.warnings.join("\n"), /MCP user configuration not loaded/);
      assert.doesNotMatch(mcp.warnings.join("\n"), /private-value/);
      assert.equal(readFileSync(join(home, "mcp.json"), "utf8"), text);
    } finally { await mcp.close(); }
  }
});

test("MCP HTTP startup failures exclude response bodies and resolved credentials", async (t) => {
  let received = false;
  process.env.RX_MCP_STARTUP_HTTP_TOKEN = "private-http-value";
  t.after(() => { delete process.env.RX_MCP_STARTUP_HTTP_TOKEN; });
  const url = await endpoint(t, (_message, request, response) => {
    received = request.headers.authorization === "Bearer private-http-value";
    response.writeHead(401).end("private-response-value");
  });
  const home = tempDir();
  writeFileSync(join(home, "mcp.json"), JSON.stringify({ mcpServers: { unauthorized: { url, headers: { Authorization: "Bearer ${RX_MCP_STARTUP_HTTP_TOKEN}" } } } }));
  const mcp = await connectMcp({ home, cwd: tempDir(), servers: [stdio("healthy")] });
  try {
    assert.equal(received, true);
    assert.equal(mcp.tools.length, 7);
    assert.match(mcp.warnings.join("\n"), /unauthorized not connected: HTTP 401/);
    assert.doesNotMatch(mcp.warnings.join("\n"), /private-/);
  } finally { await mcp.close(); }
});

test("MCP starts servers concurrently rather than waiting for the preceding server", { timeout: 5000 }, async (t) => {
  let first: (() => void) | undefined;
  let second = false;
  const url = await endpoint(t, (message, request, response) => {
    const reply = (result: unknown) => response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    if (message.method === "initialize") {
      if (request.url === "/first") {
        first = () => reply(initialized);
        if (second) first();
      } else {
        second = true;
        first?.();
        reply(initialized);
      }
    } else if (message.id === undefined) response.writeHead(202).end();
    else reply({ tools: [{ name: "echo", inputSchema: { type: "object" } }] });
  });
  const home = tempDir();
  writeFileSync(join(home, "mcp.json"), JSON.stringify({ mcpServers: { first: { url: `${url}/first`, timeout: 0.5 }, second: { url: `${url}/second`, timeout: 0.5 } } }));
  const mcp = await connectMcp({ home, cwd: tempDir() });
  try {
    assert.deepEqual(mcp.warnings, []);
    assert.deepEqual(mcp.tools.map((tool) => tool.name), ["mcp__first__echo", "mcp__second__echo"]);
  } finally { await mcp.close(); }
});

test("MCP startup deadline includes an initialized notification that never completes", { timeout: 5000 }, async (t) => {
  let reached = false;
  const url = await endpoint(t, (message, _request, response) => {
    if (message.method === "initialize") response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: initialized }));
    else if (message.method === "notifications/initialized") reached = true;
  });
  const home = tempDir();
  writeFileSync(join(home, "mcp.json"), JSON.stringify({ mcpServers: { hanging: { url, timeout: 0.2 } } }));
  const start = Date.now();
  const mcp = await connectMcp({ home, cwd: tempDir(), servers: [stdio("healthy")] });
  try {
    assert.equal(reached, true);
    assert.ok(Date.now() - start < 2000);
    assert.match(mcp.warnings.join("\n"), /hanging not connected: request timed out/);
    assert.equal(mcp.tools.length, 7);
  } finally { await mcp.close(); }
});

test("MCP discovery pagination cannot renew the total startup deadline", { timeout: 5000 }, async (t) => {
  let pages = 0;
  const url = await endpoint(t, (message, _request, response) => {
    const reply = (result: unknown) => response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    if (message.method === "initialize") reply(initialized);
    else if (message.id === undefined) response.writeHead(202).end();
    else {
      pages++;
      const timer = setTimeout(() => reply({ tools: [], nextCursor: String(pages) }), 25);
      response.on("close", () => clearTimeout(timer));
    }
  });
  const home = tempDir();
  writeFileSync(join(home, "mcp.json"), JSON.stringify({ mcpServers: { endless: { url, timeout: 0.2 } } }));
  const start = Date.now();
  const mcp = await connectMcp({ home, cwd: tempDir() });
  try {
    assert.ok(pages > 1);
    assert.ok(Date.now() - start < 2000);
    assert.equal(mcp.tools.length, 0);
    assert.match(mcp.warnings.join("\n"), /endless not connected: request timed out/);
  } finally { await mcp.close(); }
});

test("MCP cancellation rejects startup and closes healthy and hanging children", { timeout: 5000 }, async () => {
  const home = tempDir();
  const ready = join(home, "ready.jsonl");
  const hanging = join(home, "hanging.jsonl");
  const controller = new AbortController();
  const stopped = assert.rejects(connectMcp({ home, cwd: tempDir(), signal: controller.signal, servers: [stdio("healthy", ready), { ...stdio("hanging", hanging), args: [fixture, "--hang", `--trace=${hanging}`] }] }), { name: "AbortError" });
  const pids = await Promise.all([mcpPid(ready), mcpPid(hanging)]);
  controller.abort();
  await stopped;
  for (const pid of pids) await assertProcessExited(pid);
});
