import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createRxAgent, systemPrompt } from "../src/agent.ts";
import { SessionLog } from "../src/session-log.ts";
import { fauxModels, tempDir } from "./helpers.ts";

test("the agent runs tools in its cwd and logs every message with its real origin", async () => {
  const { faux, models, model } = fauxModels();
  const cwd = tempDir();
  const home = tempDir();
  writeFileSync(join(cwd, "note.txt"), "alpha\n");
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("edit", { path: "note.txt", old_text: "alpha", new_text: "beta" }, { id: "t1" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("bash", { command: "exit 4" }, { id: "t2" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ]);
  const log = SessionLog.create(home, cwd);
  const agent = createRxAgent({ models, model, thinking: "off", cwd, log, origin: "acp" });
  await agent.prompt("change it");
  assert.equal(readFileSync(join(cwd, "note.txt"), "utf8"), "beta\n");
  const loaded = SessionLog.open(home, log.id);
  assert.deepEqual(
    loaded.entries.map((e) => `${e.origin}:${e.message.role}`),
    ["acp:user", "model:assistant", "tool:toolResult", "model:assistant", "tool:toolResult", "model:assistant"],
  );
  const failed = loaded.messages[4]!;
  assert.ok(failed.role === "toolResult" && failed.isError);
  assert.match(JSON.stringify(failed.content), /exit code 4/);
});

test("a resumed agent continues from the logged history", async () => {
  const { faux, models, model } = fauxModels();
  const cwd = tempDir();
  const home = tempDir();
  faux.setResponses([fauxAssistantMessage("first"), (context) => fauxAssistantMessage(`saw ${context.messages.map((m) => m.role).join(",")}`)]);
  const log = SessionLog.create(home, cwd);
  await createRxAgent({ models, model, thinking: "off", cwd, log, origin: "cli" }).prompt("one");
  const loaded = SessionLog.open(home, log.id);
  const resumed = createRxAgent({ models, model, thinking: "off", cwd, log: loaded.log, origin: "cli", messages: loaded.messages });
  await resumed.prompt("two");
  const last = resumed.state.messages.at(-1)!;
  assert.ok(last.role === "assistant");
  assert.deepEqual(last.content, [{ type: "text", text: "saw system,user,assistant,user" }]);
  assert.equal(SessionLog.open(home, log.id).messages.length, 4);
});

test("the system prompt includes AGENTS.md before CLAUDE.md", () => {
  const cwd = tempDir();
  assert.doesNotMatch(systemPrompt(cwd), /Project instructions/);
  writeFileSync(join(cwd, "CLAUDE.md"), "claude rules");
  assert.match(systemPrompt(cwd), /claude rules/);
  writeFileSync(join(cwd, "AGENTS.md"), "agents rules");
  const prompt = systemPrompt(cwd, new Date("2026-10-24T00:00:00Z"));
  assert.match(prompt, /agents rules/);
  assert.doesNotMatch(prompt, /claude rules/);
  assert.match(prompt, /Date: 2026-10-24/);
});
