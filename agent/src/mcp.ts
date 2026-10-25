import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { McpServer } from "@agentclientprotocol/sdk";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { McpAbortError, McpClient, McpConnectionClosedError, McpError, McpHttpError, McpTimeoutError, StdioTransport, StreamableHttpTransport, toLlmContent } from "@earendil-works/pi-mcp";
import { Type } from "typebox";
import { VERSION } from "./version.ts";

export interface McpConnection {
  tools: AgentTool[];
  warnings: string[];
  close(): Promise<void>;
}

export interface McpOptions {
  home: string;
  cwd: string;
  servers?: readonly McpServer[];
  signal?: AbortSignal;
}

interface Server {
  name: string;
  timeout: number;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

class ConfigurationError extends Error {}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function expand(value: string): string {
  return value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
}

function stringMap(value: unknown, field: string, references: boolean): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!record(value) || Object.values(value).some((entry) => typeof entry !== "string")) throw new ConfigurationError(`${field} must contain string values`);
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (!references) return [key, entry as string];
    if ((entry as string).startsWith("!")) throw new ConfigurationError(`${field} does not support command substitution`);
    return [key, (entry as string).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
      const replacement = process.env[name];
      if (replacement === undefined) throw new ConfigurationError(`${field} needs environment variable ${name}`);
      return replacement;
    })];
  }));
}

function parseServer(name: string, value: unknown, cwd: string, references: boolean): Server | undefined {
  if (!name.trim() || /[\u0000-\u001f\u007f]/.test(name)) throw new ConfigurationError("MCP server names must be nonempty and contain no control characters");
  if (!record(value)) throw new ConfigurationError("expected an object");
  const allowed = new Set(["command", "args", "env", "cwd", "url", "headers", "type", "timeout", "enabled", "description"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new ConfigurationError("unsupported configuration field; see agent/docs/mcp.md");
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") throw new ConfigurationError("enabled must be a boolean");
  if (value.enabled === false) return undefined;
  const timeout = value.timeout ?? 60;
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0 || timeout > 86400) throw new ConfigurationError("timeout must be between 0 and 86400 seconds");
  if (value.description !== undefined && typeof value.description !== "string") throw new ConfigurationError("description must be a string");
  if (typeof value.command === "string" && value.command.length && value.url === undefined) {
    if (value.type !== undefined && value.type !== "stdio") throw new ConfigurationError("command requires stdio transport");
    if (value.headers !== undefined) throw new ConfigurationError("stdio does not accept headers");
    if (value.args !== undefined && (!Array.isArray(value.args) || value.args.some((arg) => typeof arg !== "string"))) throw new ConfigurationError("args must be an array of strings");
    if (value.cwd !== undefined && typeof value.cwd !== "string") throw new ConfigurationError("cwd must be a string");
    return { name, timeout, command: expand(value.command), args: (value.args as string[] | undefined)?.map(expand), cwd: resolve(cwd, expand(value.cwd as string ?? cwd)), env: stringMap(value.env, "env", references) };
  }
  if (typeof value.url === "string" && value.command === undefined) {
    if (value.type !== undefined && value.type !== "http" && value.type !== "streamable-http") throw new ConfigurationError("only Streamable HTTP is supported");
    if (value.env !== undefined || value.args !== undefined || value.cwd !== undefined) throw new ConfigurationError("HTTP does not accept env, args, or cwd");
    let url: URL;
    try { url = new URL(value.url); } catch { throw new ConfigurationError("invalid HTTP URL"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new ConfigurationError("use an HTTP URL without embedded credentials");
    return { name, timeout, url: value.url, headers: stringMap(value.headers, "headers", references) };
  }
  throw new ConfigurationError("specify command or url");
}

function servers(options: McpOptions, warnings: string[]): Array<{ name: string; value: unknown; acp: boolean }> {
  const entries = new Map<string, { value: unknown; acp: boolean }>();
  try {
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(join(options.home, "mcp.json"), "utf8")); }
    catch (error) {
      if (error instanceof SyntaxError) throw new ConfigurationError("invalid JSON");
      throw error;
    }
    if (!record(parsed) || (parsed.mcpServers !== undefined && !record(parsed.mcpServers)) || Object.keys(parsed).some((key) => key !== "mcpServers")) throw new ConfigurationError("expected an object with mcpServers only");
    for (const [name, value] of Object.entries(parsed.mcpServers ?? {})) entries.set(name, { value, acp: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") warnings.push(`MCP user configuration not loaded: ${error instanceof ConfigurationError ? error.message : "configuration file could not be read"}.`);
  }
  const seen = new Set<string>();
  for (const server of options.servers ?? []) {
    if (seen.has(server.name)) {
      warnings.push(`MCP server ${displayName(server.name)} not connected: duplicate server name.`);
      continue;
    }
    seen.add(server.name);
    entries.set(server.name, { value: server, acp: true });
  }
  return [...entries].map(([name, entry]) => ({ name, ...entry }));
}

function displayName(name: string): string {
  return name.replace(/[\u0000-\u001f\u007f]/g, "?").trim() || "(unnamed)";
}

function acpServer(server: McpServer): Record<string, unknown> {
  if ("type" in server && server.type === "sse") throw new ConfigurationError("MCP legacy SSE is not supported; use Streamable HTTP");
  if ("type" in server && server.type === "http") return { type: "http", url: server.url, headers: Object.fromEntries(server.headers.map(({ name, value }) => [name, value])) };
  if (!("command" in server)) throw new ConfigurationError("Unsupported ACP MCP transport");
  return { command: server.command, args: server.args, env: Object.fromEntries(server.env.map(({ name, value }) => [name, value])) };
}

export function mcpToolName(server: string, tool: string): string {
  const raw = `mcp__${server}__${tool}`;
  const clean = raw.replace(/[^A-Za-z0-9_]/g, "_");
  if (raw === clean && clean.length <= 64 && !server.includes("__") && !server.endsWith("_") && !tool.startsWith("_") && !tool.includes("__")) return clean;
  const hash = createHash("sha256").update(JSON.stringify([server, tool])).digest("hex").slice(0, 12);
  return `${clean.slice(0, 51)}_${hash}`;
}

class DuplicateToolNameError extends Error {}

function failure(error: unknown): string {
  if (error instanceof ConfigurationError) return error.message;
  if (error instanceof DuplicateToolNameError) return "duplicate tool name";
  if (error instanceof McpTimeoutError) return "request timed out";
  if (error instanceof McpAbortError) return "request cancelled";
  if (error instanceof McpConnectionClosedError) return "connection closed";
  if (error instanceof McpHttpError) return `HTTP ${error.status}`;
  if (error instanceof McpError) return `protocol error ${error.code}`;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return "executable or working directory not found";
  if (code === "EACCES") return "permission denied";
  return "connection or protocol failed";
}

export async function connectMcp(options: McpOptions): Promise<McpConnection> {
  options.signal?.throwIfAborted();
  const warnings: string[] = [];
  const definitions = servers(options, warnings);
  const clients: Array<() => Promise<void>> = [];
  const tools: AgentTool[] = [];
  const close = async () => { await Promise.allSettled(clients.map((stop) => stop())); };
  try {
    const connected = await Promise.all(definitions.map(async (definition) => {
      let stop: (() => Promise<void>) | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abort: (() => void) | undefined;
      try {
        options.signal?.throwIfAborted();
        const server = parseServer(definition.name, definition.acp ? acpServer(definition.value as McpServer) : definition.value, options.cwd, !definition.acp);
        if (!server) return;
        const client = new McpClient({ name: "rx-agent", version: VERSION, requestTimeoutMs: server.timeout * 1000, roots: [{ uri: pathToFileURL(options.cwd).href, name: "workspace" }] });
        let closing: Promise<void> | undefined;
        stop = () => closing ??= client.close();
        clients.push(stop);
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new McpTimeoutError(server.timeout * 1000)), server.timeout * 1000);
          abort = () => reject(new McpAbortError());
          options.signal?.addEventListener("abort", abort, { once: true });
        });
        const discover = async () => {
          const transport = server.command
            ? new StdioTransport({ command: server.command, args: server.args, cwd: server.cwd, env: server.env, stderr: "pipe" })
            : new StreamableHttpTransport({ url: server.url!, headers: server.headers });
          await client.connect(transport);
          return client.serverCapabilities?.tools ? await client.listTools() : [];
        };
        const listed = await Promise.race([discover(), deadline]);
        const names = new Set<string>();
        const adapted = listed.map((tool) => {
          const name = mcpToolName(server.name, tool.name);
          if (names.has(name)) throw new DuplicateToolNameError();
          names.add(name);
          return {
            name,
            label: tool.title ?? tool.name,
            description: tool.description ?? `${server.name}: ${tool.name}`,
            parameters: Type.Unsafe({ ...tool.inputSchema, type: "object", properties: tool.inputSchema.properties ?? {} }),
            execute: async (_id, args, signal, onUpdate) => {
              try {
                const result = await client.callTool(tool.name, args as Record<string, unknown>, {
                  signal,
                  onProgress: (progress) => onUpdate?.({ content: [{ type: "text", text: `MCP progress: ${progress.progress}${progress.total === undefined ? "" : `/${progress.total}`}` }], details: undefined }),
                });
                return { content: toLlmContent(result), details: undefined, isError: result.isError === true };
              } catch (error) {
                throw new Error(`MCP server ${server.name}: ${failure(error)}`);
              }
            },
          } satisfies AgentTool;
        });
        return { name: server.name, tools: adapted, stop };
      } catch (error) {
        await stop?.();
        options.signal?.throwIfAborted();
        warnings.push(`MCP server ${displayName(definition.name)} not connected: ${failure(error)}.`);
      } finally {
        clearTimeout(timer);
        if (abort) options.signal?.removeEventListener("abort", abort);
      }
    }));
    for (const server of connected) {
      if (!server) continue;
      if (server.tools.some((tool) => tools.some((other) => other.name === tool.name))) {
        await server.stop();
        warnings.push(`MCP server ${displayName(server.name)} not connected: duplicate tool name.`);
      } else tools.push(...server.tools);
    }
    options.signal?.throwIfAborted();
    return { tools, warnings, close };
  } catch (error) {
    await close();
    throw error;
  }
}
