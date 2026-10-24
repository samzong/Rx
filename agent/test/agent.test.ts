import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createRxAgent, systemPrompt } from "../src/agent.ts";
import { SessionLog } from "../src/session-log.ts";
import { fauxModels, tempDir } from "./helpers.ts";

process.env.HOME = tempDir();
process.env.RX_HOME = tempDir();

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
  const agent = createRxAgent({ models, model, thinking: "off", cwd, systemPrompt: systemPrompt(cwd), log, origin: "acp" });
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
  await createRxAgent({ models, model, thinking: "off", cwd, systemPrompt: systemPrompt(cwd), log, origin: "cli" }).prompt("one");
  const loaded = SessionLog.open(home, log.id);
  const resumed = createRxAgent({ models, model, thinking: "off", cwd, systemPrompt: systemPrompt(cwd), log: loaded.log, origin: "cli", messages: loaded.messages });
  await resumed.prompt("two");
  const last = resumed.state.messages.at(-1)!;
  assert.ok(last.role === "assistant");
  assert.deepEqual(last.content, [{ type: "text", text: "saw system,user,assistant,user" }]);
  assert.equal(SessionLog.open(home, log.id).messages.length, 4);
});

test("the system prompt includes AGENTS.md before CLAUDE.md", () => {
  const cwd = tempDir();
  assert.doesNotMatch(systemPrompt(cwd), /Instructions from/);
  writeFileSync(join(cwd, "CLAUDE.md"), "claude rules");
  assert.match(systemPrompt(cwd), /claude rules/);
  writeFileSync(join(cwd, "AGENTS.md"), "agents rules");
  const prompt = systemPrompt(cwd, new Date("2026-10-24T00:00:00Z"));
  assert.match(prompt, /agents rules/);
  assert.doesNotMatch(prompt, /claude rules/);
  assert.match(prompt, /Date: 2026-10-24/);
});

test("the agent combines current instructions and skill metadata, then reads a skill through its existing tool", async (t) => {
  const previousHome = process.env.HOME;
  const previousRxHome = process.env.RX_HOME;
  const home = realpathSync(tempDir());
  const rxHome = realpathSync(tempDir());
  process.env.HOME = home;
  process.env.RX_HOME = rxHome;
  t.after(() => {
    process.env.HOME = previousHome;
    process.env.RX_HOME = previousRxHome;
  });
  const diagnostics: string[] = [];
  t.mock.method(process.stderr, "write", (chunk: string | Uint8Array) => { diagnostics.push(String(chunk)); return true; });
  const root = realpathSync(tempDir());
  const parent = join(root, "parent");
  const cwd = join(parent, "child");
  mkdirSync(cwd, { recursive: true });
  execFileSync("git", ["init", "--quiet", root]);
  writeFileSync(join(rxHome, "AGENTS.md"), "GLOBAL_POLICY\n@./shared.md");
  writeFileSync(join(rxHome, "shared.md"), "IMPORTED_POLICY");
  writeFileSync(join(root, "AGENTS.md"), "ROOT_POLICY");
  writeFileSync(join(root, "CLAUDE.md"), "IGNORED_POLICY");
  writeFileSync(join(parent, "CLAUDE.md"), "PARENT_POLICY");
  writeFileSync(join(cwd, "AGENTS.md"), "CWD_POLICY");
  const skill = (base: string, directory: string, name: string, disabled = false): string => {
    const dir = join(base, ".agents", "skills", directory);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "SKILL.md");
    writeFileSync(file, `---\nname: ${name}\ndescription: Instructions for ${name}\ndisable-model-invocation: ${disabled}\n---\nSKILL_BODY_${name}\n`);
    return file;
  };
  const globalSkill = skill(home, "inspect", "inspect");
  const rootSkill = skill(root, "inspect", "inspect");
  const nearest = skill(cwd, "inspect", "inspect");
  skill(home, ".system/system-helper", "system-helper");
  skill(cwd, "manual-only", "manual-only", true);
  symlinkSync(join(cwd, ".agents", "skills"), join(cwd, ".agents", "skills", "loop"));
  const { faux, models, model } = fauxModels();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("read", { path: nearest }, { id: "skill-read" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("read complete"),
  ]);
  const log = SessionLog.create(rxHome, cwd);
  const agent = createRxAgent({ models, model, thinking: "off", cwd, systemPrompt: systemPrompt(cwd), log, origin: "cli" });
  const prompt = agent.state.systemPrompt;
  const markers = ["GLOBAL_POLICY", "IMPORTED_POLICY", "ROOT_POLICY", "PARENT_POLICY", "CWD_POLICY"];
  for (let i = 1; i < markers.length; i++) assert.ok(prompt.indexOf(markers[i - 1]!) < prompt.indexOf(markers[i]!));
  for (const marker of markers) assert.ok(prompt.includes(marker));
  assert.doesNotMatch(prompt, /IGNORED_POLICY|SKILL_BODY_|manual-only/);
  assert.ok(prompt.includes(nearest));
  assert.ok(!prompt.includes(globalSkill) && !prompt.includes(rootSkill));
  assert.ok(prompt.includes("system-helper") && prompt.includes("read"));
  assert.ok(diagnostics.some((d) => d.includes(nearest) && d.includes(rootSkill)));
  assert.ok(diagnostics.some((d) => d.includes(nearest) && d.includes(globalSkill)));
  await agent.prompt("Read the inspect skill.");
  const saved = SessionLog.open(rxHome, log.id);
  const result = saved.messages.find((m) => m.role === "toolResult");
  assert.ok(result && JSON.stringify(result).includes("SKILL_BODY_inspect"));
  const logged = readFileSync(log.path, "utf8");
  assert.doesNotMatch(logged, /GLOBAL_POLICY|IMPORTED_POLICY|ROOT_POLICY|PARENT_POLICY|CWD_POLICY|available_skills/);
  writeFileSync(join(rxHome, "AGENTS.md"), "GLOBAL_UPDATED");
  const resumed = createRxAgent({ models, model, thinking: "off", cwd: saved.log.cwd, systemPrompt: systemPrompt(saved.log.cwd), log: saved.log, origin: "cli", messages: saved.messages });
  assert.match(resumed.state.systemPrompt, /GLOBAL_UPDATED/);
  assert.doesNotMatch(resumed.state.systemPrompt, /GLOBAL_POLICY/);
});
