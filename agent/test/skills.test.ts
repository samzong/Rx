import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { skillCatalog } from "../src/skills.ts";
import { tempDir } from "./helpers.ts";

test("only .system hidden groups are included and skill roots do not recurse", () => {
  const cwd = tempDir();
  for (const [directory, name] of [
    [".system/review", "system-review"],
    [".system/review/references/nested", "should-not-load"],
    [".deprecated/review", "deprecated-review"],
    ["group/.hidden/ignored", "hidden-skill"],
  ] as const) {
    const path = join(cwd, ".agents/skills", directory);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} description\n---\n${name} body\n`);
  }
  const result = skillCatalog([cwd], tempDir());
  assert.match(result.prompt, /<name>system-review<\/name>/);
  assert.doesNotMatch(result.prompt, /should-not-load|deprecated-review|hidden-skill/);
});
