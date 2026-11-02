import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { capture, dockerRun, type Container } from "./process.ts";
import type { AgentResult } from "./schema.ts";

export const agents = ["rx-agent", "claude", "codex", "external"] as const;
export type AgentName = typeof agents[number];
export interface CodexConfiguration { provider: "tokener"; model: string; effort: string }
export const tokenerCodexDefaults: CodexConfiguration = { provider: "tokener", model: "gpt-6-sol", effort: "medium" };

export function codexArgs(configuration?: CodexConfiguration): string[] {
  const args = ["codex", "exec", "--json", "--ephemeral", "--ignore-user-config", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox"];
  if (configuration) args.push(
    "-c", 'model_providers.tokener={name="Tokener",base_url="https://api.tokener.ai/v1",env_key="TOKENER_API_KEY",wire_api="responses",supports_websockets=false}',
    "-c", 'model_provider="tokener"',
    "-c", `model=${JSON.stringify(configuration.model)}`,
    "-c", `model_reasoning_effort=${JSON.stringify(configuration.effort)}`,
  );
  return [...args, "-"];
}
export function credentials(agent: AgentName, source: NodeJS.ProcessEnv = process.env, externalNames: string[] = [], codex?: CodexConfiguration): Record<string, string> {
  if (externalNames.some((name) => !/^[A-Z][A-Z0-9_]*$/.test(name) || ["HOME", "PATH", "NODE_OPTIONS", "RX_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR"].includes(name))) throw new Error("Use credential variable names without runtime overrides.");
  const names = agent === "rx-agent" ? ["DEEPSEEK_API_KEY"] : agent === "claude" ? ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"] : agent === "codex" ? codex ? ["TOKENER_API_KEY"] : ["CODEX_ACCESS_TOKEN", "CODEX_API_KEY", "OPENAI_API_KEY"] : externalNames;
  return Object.fromEntries(names.filter((name) => source[name]).map((name) => [name, source[name]!]));
}

function eventLines(stdout: string): unknown[] {
  return stdout.split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line) as unknown; } catch { return { type: "unparsed", text: line }; } });
}

export function nativeResult(agent: AgentName, code: number | null, stdout: string): AgentResult {
  const events = eventLines(stdout);
  if (agent === "external") return { exitCode: code, completed: code === 0, model: "unknown", thinking: "unknown", text: stdout, events, usage: "unknown", cost: "unknown",
    ...([125, 126, 127].includes(code ?? -1) ? { infrastructureError: "The agent command could not start." } : {}),
  };
  let completed = false;
  let model = "unknown";
  let thinking = "unknown";
  let usage: AgentResult["usage"] = "unknown";
  let cost: AgentResult["cost"] = "unknown";
  let requestFailed = false;
  const text: string[] = [];
  for (const item of events) {
    if (typeof item !== "object" || !item) continue;
    const event = item as Record<string, unknown>;
    if (event.type === "error" || event.type === "turn.failed" || (event.type === "result" && (event.subtype === "error_during_execution" || Number(event.api_error_status) >= 400))) requestFailed = true;
    if (event.type === "system" && event.subtype === "init" && typeof event.model === "string") model = event.model;
    if (event.type === "result") {
      completed = event.is_error === false && event.subtype === "success";
      if (typeof event.result === "string") text.push(event.result);
      if (typeof event.total_cost_usd === "number") cost = { usd: event.total_cost_usd, basis: "agent_reported" };
      const value = event.usage as Record<string, unknown> | undefined;
      if (typeof value?.input_tokens === "number" && typeof value.output_tokens === "number") usage = { input: value.input_tokens + Number(value.cache_creation_input_tokens ?? 0) + Number(value.cache_read_input_tokens ?? 0), output: value.output_tokens };
    }
    if (event.type === "turn.completed") {
      completed = true;
      const value = event.usage as Record<string, unknown> | undefined;
      if (typeof value?.input_tokens === "number" && typeof value.output_tokens === "number") usage = { input: value.input_tokens, output: value.output_tokens };
    }
    if (event.type === "turn.failed" || event.type === "error") completed = false;
    if (event.type === "item.completed") {
      const value = event.item as Record<string, unknown> | undefined;
      if (value?.type === "agent_message" && typeof value.text === "string") text.push(value.text);
    }
    if (typeof event.model === "string") model = event.model;
    if (typeof event.reasoning_effort === "string") thinking = event.reasoning_effort;
  }
  return { exitCode: code, completed: completed && code === 0, model, thinking, text: text.join("\n"), events, usage, cost,
    ...(requestFailed && !(completed && code === 0) && ![122, 124].includes(code ?? -1) ? { infrastructureError: "The native agent reported a failed request." } : {}),
  };
}

export async function runAgent(agent: AgentName, image: string, work: string, prompt: string, env: Record<string, string>, external?: string[], codex?: CodexConfiguration): Promise<AgentResult> {
  if (agent === "rx-agent") return runAcp(image, work, prompt, env);
  const argv = agent === "claude" ? ["claude", "-p", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--dangerously-skip-permissions", "--setting-sources", "", "--strict-mcp-config", "--model", "claude-sonnet-5-5", "--effort", "medium"]
    : agent === "codex" ? codexArgs(codex) : external;
  if (!argv?.length) throw new Error("Provide an external agent command after --.");
  const result = await capture(dockerRun(image, work, argv, { env, network: true }), prompt);
  const parsed = nativeResult(agent, result.code, result.stdout);
  if (agent === "claude") parsed.thinking = "medium";
  if (agent === "codex" && codex) {
    parsed.configuration = codex;
    if (parsed.model === "unknown") parsed.model = codex.model;
    if (parsed.thinking === "unknown") parsed.thinking = codex.effort;
  }
  parsed.events.push({ type: "process_stderr", text: result.stderr });
  if ([125, 126, 127].includes(result.code ?? -1)) throw Object.assign(new Error("The agent command could not start."), { partialResult: parsed });
  if (parsed.infrastructureError) {
    const failure = parsed.events.findLast((event) => typeof event === "object" && event !== null && (event as { type?: unknown }).type === "turn.failed") as { error?: { message?: unknown } } | undefined;
    const message = typeof failure?.error?.message === "string" ? failure.error.message : "";
    const status = Number(/^unexpected status\s+(\d{3})\b/i.exec(message.trim())?.[1]);
    let modelRejected = /\bmodel\s+[`"'][^`"']+[`"']\s+does not exist\b/i.test(message);
    if (Number.isNaN(status)) {
      try {
        const body = JSON.parse(message) as { error?: { code?: unknown; message?: unknown } } | null;
        modelRejected ||= body?.error?.code === "model_not_found" || (typeof body?.error?.message === "string" && /\bunsupported[ _-]+model\b/i.test(body.error.message));
      } catch {}
    }
    const rejected = agent === "codex" && !!codex && ([401, 403].includes(status) || ((Number.isNaN(status) || [400, 404].includes(status)) && modelRejected));
    throw Object.assign(new Error(rejected ? "Tokener rejected TOKENER_API_KEY or the configured model." : parsed.infrastructureError), { partialResult: parsed, abortRun: rejected });
  }
  return parsed;
}

export async function runAcp(image: string, work: string, prompt: string, env: Record<string, string>): Promise<AgentResult> {
  const container = dockerRun(image, work, ["rx-agent", "acp", "-m", "deepseek/deepseek-flash"], { env, network: true });
  return acpPrompt(container, prompt);
}

export async function acpPrompt(container: Container, prompt: string): Promise<AgentResult> {
  const events: unknown[] = [];
  const text: string[] = [];
  let eventBytes = 0;
  let overflow = false;
  const record = (event: unknown): boolean => {
    eventBytes += Buffer.byteLength(JSON.stringify(event));
    if (eventBytes > 16 * 1024 * 1024) { overflow = true; void container.stop(); return false; }
    events.push(event);
    return true;
  };
  let model = "unknown";
  let thinking = "unknown";
  const client = acp.client().onNotification(acp.methods.client.session.update, ({ params }) => {
    if (!record(params.update)) return;
    if (params.update.sessionUpdate === "agent_message_chunk" && params.update.content.type === "text") text.push(params.update.content.text);
  });
  let expired = false;
  const timer = setTimeout(() => { expired = true; void container.stop(); }, 900_000);
  container.child.stderr.setEncoding("utf8").on("data", (chunk: string) => record({ type: "process_stderr", text: chunk }));
  try {
    const stream = acp.ndJsonStream(Writable.toWeb(container.child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(container.child.stdout) as ReadableStream<Uint8Array>);
    let completed = false;
    await client.connectWith(stream, async (ctx) => {
      await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { session: { configOptions: { boolean: {} }, compaction: {} } } });
      const created = await ctx.request(acp.methods.agent.session.new, { cwd: "/work", mcpServers: [] });
      model = String(created.configOptions?.find((option) => option.category === "model")?.currentValue ?? "unknown");
      thinking = String(created.configOptions?.find((option) => option.category === "thought_level")?.currentValue ?? "unknown");
      const response = await ctx.request(acp.methods.agent.session.prompt, { sessionId: created.sessionId, prompt: [{ type: "text", text: prompt }] });
      completed = response.stopReason === "end_turn";
      events.push({ type: "prompt_result", stopReason: response.stopReason });
    });
    if (expired) throw new Error("The task exceeded its declared time budget.");
    if (overflow) throw new Error("The process output exceeded its limit.");
    return { exitCode: null, completed, model, thinking, text: text.join(""), events, usage: "unknown", cost: "unknown" };
  } catch (error) {
    const failure = expired ? new Error("The task exceeded its declared time budget.") : overflow ? new Error("The process output exceeded its limit.") : error instanceof Error ? error : new Error("The ACP connection failed.");
    throw Object.assign(failure, { partialResult: { exitCode: null, completed: false, model, thinking, text: text.join(""), events, usage: "unknown", cost: "unknown" } satisfies AgentResult });
  } finally { clearTimeout(timer); await container.stop(); }
}
