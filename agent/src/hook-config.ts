import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HOOK_EVENTS } from "./hook-types.ts";
import type { HookCommand, HookCommandResult, HookConfiguration, HookEvent, HookGroup, HookOutput } from "./hook-types.ts";

export const HOOK_OUTPUT_LIMIT = 65536;

const EMPTY_HOOKS: HookConfiguration = Object.freeze({});

function object(value: unknown, location: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${location}: expected an object`);
  return value as Record<string, unknown>;
}

function fields(value: Record<string, unknown>, allowed: readonly string[], location: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(`${location}: unsupported field`);
}

function command(value: unknown): HookCommand {
  const entry = object(value, "Hook command");
  fields(entry, ["type", "command", "timeout"], "Hook command");
  if (entry.type !== "command") throw new Error("Hook command: only command handlers are supported");
  if (typeof entry.command !== "string" || !entry.command.trim() || entry.command.includes("\0")) throw new Error("Hook command: expected a nonempty command without NUL characters");
  const timeout = entry.timeout === undefined ? 30 : entry.timeout;
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0 || timeout > 600) throw new Error("Hook command: timeout must be positive, finite, and at most 600 seconds");
  return Object.freeze({ command: entry.command, timeout });
}

function group(event: HookEvent, value: unknown): HookGroup {
  const entry = object(value, `Hook configuration ${event}`);
  fields(entry, ["matcher", "hooks"], `Hook configuration ${event}`);
  if (entry.matcher !== undefined && typeof entry.matcher !== "string") throw new Error(`Hook configuration ${event}: matcher must be a string`);
  if (!Array.isArray(entry.hooks)) throw new Error(`Hook configuration ${event}: hooks must be an array`);
  let matcher: RegExp | undefined;
  if (typeof entry.matcher === "string" && entry.matcher !== "") {
    if (event === "UserPromptSubmit" || event === "Stop") throw new Error(`Hook configuration ${event}: matcher is not supported`);
    if (entry.matcher !== "*") {
      try { matcher = Object.freeze(new RegExp(entry.matcher)); }
      catch { throw new Error(`Hook configuration ${event}: invalid matcher regex`); }
    }
  }
  const commands = Object.freeze(entry.hooks.map(command));
  if (matcher === undefined) return Object.freeze({ commands });
  const source = matcher.source;
  return Object.freeze({ get matcher() { return Object.freeze(new RegExp(source)); }, commands });
}

export function loadHooks(home: string): HookConfiguration {
  let text: string;
  try { text = readFileSync(join(home, "hooks.json"), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_HOOKS;
    throw new Error("Hook configuration: cannot read hooks.json");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { throw new Error("Hook configuration: hooks.json must contain valid JSON"); }
  const root = object(parsed, "Hook configuration");
  fields(root, ["hooks"], "Hook configuration");
  const hooks = object(root.hooks, "Hook configuration hooks");
  fields(hooks, HOOK_EVENTS, "Hook configuration hooks");
  const configuration: Partial<Record<HookEvent, readonly HookGroup[]>> = {};
  for (const event of HOOK_EVENTS) {
    const entries = hooks[event];
    if (entries === undefined) continue;
    if (!Array.isArray(entries)) throw new Error(`Hook configuration ${event}: expected an array`);
    configuration[event] = Object.freeze(entries.map((entry) => group(event, entry)));
  }
  return Object.freeze(configuration);
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const entry = value[key];
  if (entry === undefined) return undefined;
  if (typeof entry !== "string") throw new Error(`Hook output: ${key} must be a string`);
  return entry;
}

function contextOutput(event: HookEvent, context: string): string {
  if (event === "Stop") throw new Error("Hook output: Stop does not support context");
  if (Buffer.byteLength(context, "utf8") > HOOK_OUTPUT_LIMIT) throw new Error("Hook output: context exceeds 64 KiB");
  return context;
}

export function parseHookOutput(event: HookEvent, result: HookCommandResult): HookOutput {
  if (result.code !== 0) {
    const status = result.code === null ? "did not exit normally" : `exited with code ${result.code}`;
    return { blocked: true, reason: result.stderr.trim() || `Hook ${status}` };
  }
  const output: HookOutput = { blocked: false };
  if (result.stderr.trim()) output.diagnostic = result.stderr;
  const stdout = result.stdout.trim();
  if (!stdout) return output;
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); }
  catch {
    if (stdout.startsWith("{")) throw new Error("Hook output: invalid JSON");
    if (event === "SessionStart" || event === "UserPromptSubmit") output.context = contextOutput(event, result.stdout);
    else output.diagnostic = [result.stdout, output.diagnostic].filter(Boolean).join("\n");
    return output;
  }
  const root = object(parsed, "Hook output");
  fields(root, ["hookSpecificOutput", "decision", "reason", "additionalContext", "continue", "stopReason", "suppressOutput"], "Hook output");
  const specific = root.hookSpecificOutput === undefined ? {} : object(root.hookSpecificOutput, "Hook output hookSpecificOutput");
  fields(specific, ["hookEventName", "permissionDecision", "permissionDecisionReason", "additionalContext"], "Hook output hookSpecificOutput");
  if (root.hookSpecificOutput !== undefined && specific.hookEventName !== event) throw new Error("Hook output: hookEventName must match the current event");
  if (root.suppressOutput !== undefined && root.suppressOutput !== true) throw new Error("Hook output: only suppressOutput true is supported");
  const reason = stringField(root, "reason");
  const stopReason = stringField(root, "stopReason");
  const permissionReason = stringField(specific, "permissionDecisionReason");
  if (root.decision !== undefined) {
    if (root.decision !== "block") throw new Error("Hook output: only decision block is supported");
    if (event === "SessionStart" || event === "Stop") throw new Error(`Hook output: ${event} does not support decision block`);
    output.blocked = true;
    output.reason = reason || "Hook blocked the check";
  } else if (reason !== undefined) throw new Error("Hook output: reason requires decision block");
  if (specific.permissionDecision !== undefined) {
    if (event !== "PreToolUse") throw new Error("Hook output: permissionDecision is only supported for PreToolUse");
    if (specific.permissionDecision !== "deny" && specific.permissionDecision !== "allow") throw new Error("Hook output: permissionDecision must be deny or allow");
    if (specific.permissionDecision === "deny") {
      output.blocked = true;
      output.reason = permissionReason || output.reason || "Hook denied the tool call";
    }
  } else if (permissionReason !== undefined) throw new Error("Hook output: permissionDecisionReason requires permissionDecision");
  if (root.continue !== undefined) {
    if (typeof root.continue !== "boolean") throw new Error("Hook output: continue must be a boolean");
    if (root.continue === false) {
      if (event !== "UserPromptSubmit") throw new Error("Hook output: continue false is only supported for UserPromptSubmit");
      output.blocked = true;
      output.reason = stopReason || output.reason || "Hook rejected the prompt";
    }
  }
  if (stopReason !== undefined && root.continue !== false) throw new Error("Hook output: stopReason requires continue false");
  const contexts = [stringField(root, "additionalContext"), stringField(specific, "additionalContext")].filter((entry) => entry !== undefined);
  if (contexts.length) output.context = contextOutput(event, contexts.join("\n"));
  return output;
}
