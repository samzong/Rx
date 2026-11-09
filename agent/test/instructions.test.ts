import assert from "node:assert/strict";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { systemPrompt } from "../src/agent.ts";
import { loadInstructions } from "../src/instructions.ts";
import { tempDir } from "./helpers.ts";

process.env.RX_HOME = tempDir();

test("an unreadable AGENTS.md stops startup even when CLAUDE.md is readable", () => {
  const cwd = tempDir();
  symlinkSync(join(cwd, "missing.md"), join(cwd, "AGENTS.md"));
  writeFileSync(join(cwd, "CLAUDE.md"), "fallback");
  assert.throws(() => systemPrompt(cwd));
});

test("unprefixed references stop on unreadable files and inaccessible parent directories", { skip: process.platform === "win32" || process.getuid?.() === 0 }, () => {
  const cwd = tempDir();
  const directory = join(cwd, "protected");
  const file = join(directory, "rules.md");
  mkdirSync(directory);
  writeFileSync(file, "required rules");
  writeFileSync(join(cwd, "AGENTS.md"), "@protected/rules.md");
  try {
    chmodSync(file, 0o000);
    assert.throws(() => systemPrompt(cwd));
    chmodSync(file, 0o600);
    chmodSync(directory, 0o000);
    assert.throws(() => systemPrompt(cwd));
  } finally {
    chmodSync(directory, 0o700);
    chmodSync(file, 0o600);
  }
});

test("each directory adds its local files after its override, its AGENTS.md and CLAUDE.md, or nothing", () => {
  const directory = (files: Record<string, string>): string => {
    const cwd = tempDir();
    for (const [name, text] of Object.entries(files)) writeFileSync(join(cwd, name), text);
    return cwd;
  };
  const texts = (cwd: string) => loadInstructions([cwd], tempDir()).map(({ text }) => text);
  assert.deepEqual(texts(directory({ "AGENTS.override.md": "OVERRIDE", "AGENTS.md": "BASE", "CLAUDE.md": "CLAUDE", "AGENTS.local.md": "LOCAL" })), ["OVERRIDE", "LOCAL"]);
  assert.deepEqual(texts(directory({ "AGENTS.md": "BASE", "CLAUDE.md": "CLAUDE", "AGENTS.local.md": "LOCAL" })), ["BASE", "CLAUDE", "LOCAL"]);
  assert.deepEqual(texts(directory({ "AGENTS.local.md": "LOCAL" })), ["LOCAL"]);
  assert.deepEqual(texts(directory({ "CLAUDE.md": "CLAUDE", "AGENTS.local.md": "LOCAL", "CLAUDE.local.md": "CLAUDE_LOCAL" })), ["CLAUDE", "LOCAL", "CLAUDE_LOCAL"]);
  assert.deepEqual(texts(directory({ "AGENTS.md": "BASE", "CLAUDE.local.md": "CLAUDE_LOCAL" })), ["BASE", "CLAUDE_LOCAL"]);
  assert.deepEqual(texts(directory({ "AGENTS.md": "BASE", "AGENTS.local.md": "LOCAL\n@./r.md\n", "CLAUDE.local.md": "LOCAL\n@./r.md", "r.md": "R" })), ["BASE", "LOCAL\nR"]);
});
