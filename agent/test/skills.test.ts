import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { skillCatalog } from "../src/skills.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "rx-skills-"));
}

function addSkill(root: string, directory: string, name: string, description = `${name} description`, body = `${name} body`, extra = ""): string {
  const skillDirectory = join(root, directory);
  mkdirSync(skillDirectory, { recursive: true });
  const file = join(skillDirectory, "SKILL.md");
  writeFileSync(file, `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n${body}\n`);
  return file;
}

test("nearer project skills win over parent and global skills", () => {
  const home = tempDir();
  const project = tempDir();
  const child = join(project, "packages", "app");
  const parentSkill = realpathSync(addSkill(project, ".agents/skills/shared", "shared", "parent version"));
  const childSkill = realpathSync(addSkill(child, ".agents/skills/shared", "shared", "near version"));
  const globalSkill = realpathSync(addSkill(home, ".agents/skills/shared", "shared", "global version"));
  const result = skillCatalog([project, child], home);
  assert.match(result.prompt, /near version/);
  assert.doesNotMatch(result.prompt, /parent version|global version/);
  assert.equal(result.diagnostics.length, 2);
  for (const loser of [parentSkill, globalSkill]) {
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.includes("shared") && diagnostic.includes(childSkill) && diagnostic.includes(loser)));
  }
});

test("only .system hidden groups are included and skill roots do not recurse", () => {
  const home = tempDir();
  const cwd = tempDir();
  const skillFile = addSkill(cwd, ".agents/skills/.system/review", "system-review");
  addSkill(cwd, ".agents/skills/.system/review/references/nested", "should-not-load");
  addSkill(cwd, ".agents/skills/.deprecated/review", "system-review", "deprecated version");
  addSkill(cwd, ".agents/skills/group/.hidden/ignored", "hidden-skill");
  const result = skillCatalog([cwd], home);
  assert.match(result.prompt, new RegExp(skillFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(result.prompt, /should-not-load|deprecated version|hidden-skill/);
  assert.deepEqual(result.diagnostics, []);
});

test("user overrides of .system skills are silent while user collisions remain visible", () => {
  const home = tempDir();
  const cwd = tempDir();
  addSkill(home, ".agents/skills/.system/shared", "shared", "system version");
  addSkill(home, ".agents/skills/group/.system/shared", "shared", "nested system version");
  const user = realpathSync(addSkill(home, ".agents/skills/shared", "shared", "user version"));
  const global = skillCatalog([cwd], home);
  assert.match(global.prompt, /user version/);
  assert.doesNotMatch(global.prompt, /system version/);
  assert.deepEqual(global.diagnostics, []);
  const project = realpathSync(addSkill(cwd, ".agents/skills/shared", "shared", "project version"));
  const overridden = skillCatalog([cwd], home);
  assert.match(overridden.prompt, /project version/);
  assert.doesNotMatch(overridden.prompt, /user version|system version/);
  assert.equal(overridden.diagnostics.length, 1);
  assert.ok(overridden.diagnostics[0]!.includes(project) && overridden.diagnostics[0]!.includes(user));
});

test("directory and file symlinks are followed and real paths are loaded once", () => {
  const home = tempDir();
  const cwd = tempDir();
  const catalog = join(cwd, ".agents", "skills");
  const actual = addSkill(cwd, ".local/real-skill", "linked-skill");
  mkdirSync(catalog, { recursive: true });
  symlinkSync(join(cwd, ".local/real-skill"), join(catalog, "alias"), "dir");
  mkdirSync(join(catalog, "file-alias"));
  symlinkSync(actual, join(catalog, "file-alias", "SKILL.md"), "file");
  symlinkSync(catalog, join(catalog, "loop"), "dir");
  const result = skillCatalog([cwd], home);
  assert.equal((result.prompt.match(/<name>linked-skill<\/name>/g) ?? []).length, 1);
  assert.deepEqual(result.diagnostics, []);
});

test("a SKILL.md symlink can target a file with a different extension", () => {
  const home = tempDir();
  const cwd = realpathSync(tempDir());
  const directory = join(cwd, ".agents", "skills", "linked");
  mkdirSync(directory, { recursive: true });
  const target = join(cwd, "skill-content.txt");
  writeFileSync(target, "---\nname: linked\ndescription: Linked instructions\n---\nSkill body\n");
  const path = join(directory, "SKILL.md");
  symlinkSync(target, path);
  const result = skillCatalog([cwd], home);
  assert.ok(result.prompt.includes("<name>linked</name>") && result.prompt.includes(path));
  assert.deepEqual(result.diagnostics, []);
});

test("only SKILL.md files are cataloged, metadata is formatted without bodies, and disabled skills are omitted", () => {
  const home = tempDir();
  const cwd = tempDir();
  addSkill(cwd, ".agents/skills/visible", "visible", "visible description", "private body text");
  addSkill(cwd, ".agents/skills/disabled", "disabled", "disabled description", "disabled body text", "disable-model-invocation: true\n");
  addSkill(cwd, ".agents/skills/z-last", "z-last");
  addSkill(cwd, ".agents/skills/a-first", "a-first");
  addSkill(cwd, ".agents/skills/node_modules/ignored", "dependency-skill");
  const loose = join(cwd, ".agents", "skills", "loose.md");
  writeFileSync(loose, "---\nname: loose\ndescription: loose description\n---\nloose body");
  const result = skillCatalog([cwd], home);
  assert.match(result.prompt, /<name>visible<\/name>/);
  assert.ok(result.prompt.indexOf("<name>a-first</name>") < result.prompt.indexOf("<name>z-last</name>"));
  assert.match(result.prompt, /visible description/);
  assert.doesNotMatch(result.prompt, /private body text|disabled|loose|dependency-skill/);
  assert.deepEqual(result.diagnostics, []);
});

test("missing roots are silent and broken symlinks produce a located diagnostic", () => {
  const home = tempDir();
  const cwd = tempDir();
  const catalog = join(cwd, ".agents", "skills");
  mkdirSync(catalog, { recursive: true });
  const broken = join(catalog, "broken");
  symlinkSync(join(cwd, "missing-target"), broken, "dir");
  const result = skillCatalog([cwd], home);
  assert.equal(result.prompt, "");
  assert.equal(result.diagnostics.length, 1);
  assert.match(result.diagnostics[0]!, new RegExp(broken));
});

test("a broken search-root symlink produces a located diagnostic", () => {
  const home = tempDir();
  const cwd = realpathSync(tempDir());
  mkdirSync(join(cwd, ".agents"));
  const root = join(cwd, ".agents", "skills");
  symlinkSync(join(cwd, "missing-target"), root, "dir");
  const result = skillCatalog([cwd], home);
  assert.equal(result.prompt, "");
  assert.equal(result.diagnostics.length, 1);
  assert.ok(result.diagnostics[0]!.includes(root));
});
