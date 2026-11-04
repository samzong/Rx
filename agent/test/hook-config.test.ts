import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadHooks, parseHookOutput } from "../src/hook-config.ts";
import { HOOK_EVENTS } from "../src/hook-types.ts";
import { tempDir } from "./helpers.ts";

test("configuration rejects malformed roots, unknown fields, events, and handlers", () => {
  const home = tempDir();
  const handler = { type: "command", command: "./check" };
  for (const value of [
    null,
    { hooks: {}, extra: true },
    { hooks: { SessionEnd: [] } },
    { hooks: { PreToolUse: [{ hooks: [{ ...handler, type: "http" }] }] } },
    { hooks: { PreToolUse: [{ hooks: [{ ...handler, command: "" }] }] } },
    { hooks: { PreToolUse: [{ matcher: "[", hooks: [handler] }] } },
  ]) {
    writeFileSync(join(home, "hooks.json"), JSON.stringify(value));
    assert.throws(() => loadHooks(home));
  }
  writeFileSync(join(home, "hooks.json"), "{");
  assert.throws(() => loadHooks(home));
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
