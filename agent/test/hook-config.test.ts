import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadHooks, parseHookOutput } from "../src/hook-config.ts";
import { HOOK_EVENTS, HOOK_OUTPUT_LIMIT } from "../src/hook-types.ts";
import type { HookEvent } from "../src/hook-types.ts";

const handler = { type: "command", command: "./check" };

function configured(home: string, value: unknown): void {
  writeFileSync(join(home, "hooks.json"), JSON.stringify(value));
}

function json(event: HookEvent, value: unknown) {
  return parseHookOutput(event, { code: 0, stdout: JSON.stringify(value), stderr: "" });
}

test("missing hooks.json disables hooks without discovering other files", (t) => {
  const home = mkdtempSync(join(tmpdir(), "rx-hooks-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  configured(home, { hooks: {} });
  const empty = loadHooks(home);
  assert.deepEqual(empty, {});
  rmSync(join(home, "hooks.json"));
  writeFileSync(join(home, "config.json"), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [handler] }] } }));
  mkdirSync(join(home, ".claude"));
  writeFileSync(join(home, ".claude", "settings.json"), "invalid JSON");
  assert.deepEqual(loadHooks(home), {});
});

test("configuration preserves handler order", (t) => {
  const home = mkdtempSync(join(tmpdir(), "rx-hooks-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  configured(home, { hooks: { PreToolUse: [
    { matcher: "^bash$", hooks: [handler, { ...handler, command: "./second", timeout: 0.5 }] },
    { matcher: "*", hooks: [{ ...handler, timeout: 600 }] },
  ] } });
  const original = readFileSync(join(home, "hooks.json"), "utf8");
  const snapshot = loadHooks(home);
  const groups = snapshot.PreToolUse!;
  assert.deepEqual(groups[0]!.commands, [{ command: "./check", timeout: 30 }, { command: "./second", timeout: 0.5 }]);
  assert.equal(groups[1]!.commands[0]!.timeout, 600);
  assert.equal(groups[0]!.matcher!.test("bash"), true);
  assert.equal(groups[0]!.matcher!.test("Bash"), false);
  assert.equal(readFileSync(join(home, "hooks.json"), "utf8"), original);
  configured(home, { hooks: {} });
  assert.equal(snapshot.PreToolUse![0]!.commands[0]!.command, "./check");
  assert.deepEqual(loadHooks(home), {});
});

test("matchers preserve native names and session sources", (t) => {
  const home = mkdtempSync(join(tmpdir(), "rx-hooks-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  for (const event of HOOK_EVENTS) {
    for (const matcher of [undefined, "", "*"]) {
      configured(home, { hooks: { [event]: [{ ...(matcher === undefined ? {} : { matcher }), hooks: [handler] }] } });
      if ((event === "UserPromptSubmit" || event === "Stop") && matcher === "*") assert.throws(() => loadHooks(home));
      else assert.equal(loadHooks(home)[event]![0]!.matcher, undefined);
    }
  }
  configured(home, { hooks: {
    SessionStart: [{ matcher: "^resume$", hooks: [handler] }],
    PostToolUse: [{ matcher: "^mcp__lody__", hooks: [handler] }],
    PostToolUseFailure: [{ matcher: "read|write", hooks: [handler] }],
  } });
  const hooks = loadHooks(home);
  assert.ok(hooks.SessionStart![0]!.matcher!.test("resume"));
  assert.equal(hooks.SessionStart![0]!.matcher!.test("startup"), false);
  assert.ok(hooks.PostToolUse![0]!.matcher!.test("mcp__lody__tool"));
  assert.ok(hooks.PostToolUseFailure![0]!.matcher!.test("write"));
});

test("configuration rejects malformed roots, unknown fields, events, and handlers", (t) => {
  const home = mkdtempSync(join(tmpdir(), "rx-hooks-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const invalid: unknown[] = [null, [], {}, { hooks: null }, { hooks: [] }, { hooks: {}, extra: true },
    { PreToolUse: [] }, { hooks: { SessionEnd: [] } }, { hooks: { constructor: [] } },
    { hooks: { PreToolUse: {} } }, { hooks: { PreToolUse: [null] } },
    { hooks: { PreToolUse: [{ hooks: [handler], async: true }] } },
    { hooks: { PreToolUse: [{ hooks: null }] } },
    { hooks: { PreToolUse: [{ hooks: [{ ...handler, timeout: 600.01 }] }] } },
    { hooks: { PreToolUse: [{ matcher: "[", hooks: [handler] }] } },
    ...[null, {}, { ...handler, type: "http" }, { ...handler, type: "prompt" }, { ...handler, async: true },
      { ...handler, command: "" }, { ...handler, command: "  " }, { ...handler, command: 1 }, { ...handler, command: "a\0b" }]
      .map((entry) => ({ hooks: { PreToolUse: [{ hooks: [entry] }] } })),
  ];
  for (const value of invalid) {
    configured(home, value);
    assert.throws(() => loadHooks(home), Error);
  }
  for (const raw of ["", "{", '{"hooks":{"__proto__":[]}}']) {
    writeFileSync(join(home, "hooks.json"), raw);
    assert.throws(() => loadHooks(home));
  }
});

test("empty output and supported no-op controls accept all events", () => {
  for (const event of HOOK_EVENTS) {
    assert.deepEqual(parseHookOutput(event, { code: 0, stdout: " \n", stderr: "" }), { blocked: false });
    assert.deepEqual(json(event, {}), { blocked: false });
    assert.deepEqual(json(event, { continue: true, suppressOutput: true, hookSpecificOutput: { hookEventName: event } }), { blocked: false });
  }
});

test("plain output supplies prompt context or an event diagnostic", () => {
  for (const event of HOOK_EVENTS) {
    const parsed = parseHookOutput(event, { code: 0, stdout: "context text\n", stderr: "check warning" });
    if (event === "SessionStart" || event === "UserPromptSubmit") assert.deepEqual(parsed, { blocked: false, context: "context text\n", diagnostic: "check warning" });
    else assert.deepEqual(parsed, { blocked: false, diagnostic: "context text\n\ncheck warning" });
  }
});

test("bracketed and quoted plain output stays text while malformed objects fail", () => {
  for (const value of [[], null]) assert.throws(() => json("PreToolUse", value));
  for (const event of HOOK_EVENTS) {
    for (const stdout of ["[ok] checked", '[INFO] checked', '"checked']) {
      const parsed = parseHookOutput(event, { code: 0, stdout, stderr: "" });
      if (event === "SessionStart" || event === "UserPromptSubmit") assert.deepEqual(parsed, { blocked: false, context: stdout });
      else assert.deepEqual(parsed, { blocked: false, diagnostic: stdout });
    }
    assert.throws(() => parseHookOutput(event, { code: 0, stdout: "  {invalid", stderr: "" }), /invalid JSON/);
  }
});

test("JSON context preserves content on context-capable events", () => {
  for (const event of HOOK_EVENTS.filter((event) => event !== "Stop")) {
    assert.deepEqual(json(event, { hookSpecificOutput: { hookEventName: event, additionalContext: "nested context" } }), { blocked: false, context: "nested context" });
    assert.deepEqual(json(event, { additionalContext: "root context" }), { blocked: false, context: "root context" });
    assert.equal(json(event, { additionalContext: "first", hookSpecificOutput: { hookEventName: event, additionalContext: "second" } }).context, "first\nsecond");
  }
});

test("pre-tool deny wins over allow and no-op controls", () => {
  assert.throws(() => json("PostToolUse", { hookSpecificOutput: { hookEventName: "PostToolUse", updatedInput: {} } }));
  assert.throws(() => json("PreToolUse", { hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: "rtk git status" } }));
  assert.deepEqual(json("PreToolUse", { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecisionReason: "RTK auto-rewrite", updatedInput: { command: "rtk git status" } } }), { blocked: false, updatedInput: { command: "rtk git status" } });
  assert.deepEqual(json("PreToolUse", { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "denied", updatedInput: { command: "x" } } }), { blocked: true, reason: "denied" });
  assert.deepEqual(json("PreToolUse", { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "guard denied" }, continue: true }), { blocked: true, reason: "guard denied" });
  assert.deepEqual(json("PreToolUse", { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } }), { blocked: false });
  assert.deepEqual(json("PreToolUse", { decision: "block", reason: "blocked check", hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } }), { blocked: true, reason: "blocked check" });
  assert.equal(json("PreToolUse", { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" } }).blocked, true);
});

test("prompt and tool checks return explicit denials", () => {
  assert.throws(() => json("PostToolUse", { hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: "replacement" } }));
  for (const event of ["UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure"] as const) {
    assert.deepEqual(json(event, { decision: "block", reason: "failed check", additionalContext: "feedback" }), { blocked: true, reason: "failed check", context: "feedback" });
    assert.equal(json(event, { decision: "block" }).blocked, true);
  }
  assert.deepEqual(json("UserPromptSubmit", { continue: false, stopReason: "prompt rejected" }), { blocked: true, reason: "prompt rejected" });
});

test("every unsuccessful exit blocks with stderr or a safe fallback", () => {
  for (const event of HOOK_EVENTS) {
    for (const code of [2, 1, 127, -1, null]) {
      assert.deepEqual(parseHookOutput(event, { code, stdout: "{invalid", stderr: " failure reason \n" }), { blocked: true, reason: "failure reason" });
      const parsed = parseHookOutput(event, { code, stdout: "private-sentinel", stderr: "" });
      assert.equal(parsed.blocked, true);
      assert.ok(parsed.reason);
      assert.equal(parsed.reason.includes("private-sentinel"), false);
    }
  }
});

test("context limits count UTF-8 bytes across both context fields", () => {
  const boundary = "é".repeat(HOOK_OUTPUT_LIMIT / 2);
  assert.equal(json("SessionStart", { additionalContext: boundary }).context, boundary);
  assert.equal(parseHookOutput("UserPromptSubmit", { code: 0, stdout: boundary, stderr: "" }).context, boundary);
  assert.throws(() => json("PreToolUse", { additionalContext: `${boundary}x` }));
  assert.throws(() => parseHookOutput("SessionStart", { code: 0, stdout: `${boundary}x`, stderr: "" }));
  assert.throws(() => json("PostToolUse", { additionalContext: boundary, hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "x" } }));
});
