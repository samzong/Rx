import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadInstructions, projectDirectories } from "../src/instructions.ts";
import { tempDir } from "./helpers.ts";

test("instructions follow the Git root through cwd, after global rules, with per-directory fallback", () => {
  const parent = realpathSync(tempDir());
  const root = join(parent, "project");
  const middle = join(root, "middle");
  const cwd = join(middle, "child");
  const home = tempDir();
  mkdirSync(cwd, { recursive: true });
  execFileSync("git", ["init", "--quiet", root]);
  writeFileSync(join(parent, "AGENTS.md"), "outside rules");
  writeFileSync(join(home, "AGENTS.md"), "global rules");
  writeFileSync(join(root, "AGENTS.md"), "root rules");
  writeFileSync(join(root, "CLAUDE.md"), "ignored fallback");
  writeFileSync(join(middle, "CLAUDE.md"), "middle rules");
  writeFileSync(join(cwd, "AGENTS.md"), "child rules");
  assert.deepEqual(projectDirectories(cwd), [root, middle, cwd]);
  assert.deepEqual(loadInstructions(projectDirectories(cwd), home).map(({ text }) => text), ["global rules", "root rules", "middle rules", "child rules"]);
});

test("a non-Git directory uses only cwd, and a nested repository defines its own root", () => {
  const parent = realpathSync(tempDir());
  const cwd = join(parent, "child");
  mkdirSync(cwd);
  writeFileSync(join(parent, "AGENTS.md"), "outside");
  writeFileSync(join(cwd, "CLAUDE.md"), "inside");
  assert.deepEqual(projectDirectories(cwd), [cwd]);
  assert.deepEqual(loadInstructions(projectDirectories(cwd), tempDir()).map(({ text }) => text), ["inside"]);
  execFileSync("git", ["init", "--quiet", parent]);
  execFileSync("git", ["init", "--quiet", cwd]);
  assert.deepEqual(projectDirectories(cwd), [cwd]);
});

test("a symlinked cwd resolves to the real Git root", () => {
  const root = realpathSync(tempDir());
  execFileSync("git", ["init", "--quiet", root]);
  const alias = join(tempDir(), "alias");
  symlinkSync(root, alias);
  assert.deepEqual(projectDirectories(alias), [root]);
});

test("standalone local references expand in place relative to the real source and deduplicate symlinks", () => {
  const cwd = realpathSync(tempDir());
  const home = tempDir();
  const source = join(cwd, "source");
  mkdirSync(source);
  writeFileSync(join(source, "rules.md"), "included once");
  symlinkSync(join(source, "rules.md"), join(source, "alias.md"));
  writeFileSync(join(source, "actual.md"), "before\n@./rules.md\n@alias.md\n@" + join(source, "rules.md") + "\nafter");
  symlinkSync(join(source, "actual.md"), join(home, "AGENTS.md"));
  const loaded = loadInstructions([cwd], home);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0]!.file, join(source, "actual.md"));
  assert.match(loaded[0]!.text, /^before\nincluded once\n\n\nafter$/);
});

test("code fences, indented code, email addresses, inline references, and mentions stay literal", () => {
  const cwd = tempDir();
  const lines = ["```md", "@./missing.md", "````", "~~~", "@./also-missing.md", "~~~", "    @./code.md", "\t@./tab.md", "user@example.com", "@person@example.com", "ask @person", "@person", "text @./inline.md", "@https://example.com/rules.md"];
  writeFileSync(join(cwd, "AGENTS.md"), lines.join("\n"));
  assert.equal(loadInstructions([cwd], tempDir())[0]!.text, lines.join("\n"));
});

test("home references and local paths with spaces expand without changing their order", () => {
  const cwd = realpathSync(tempDir());
  const home = tempDir();
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    mkdirSync(join(cwd, "folder"));
    writeFileSync(join(home, "home rules.md"), "home rules");
    writeFileSync(join(cwd, "shared rules.md"), "shared rules");
    writeFileSync(join(cwd, "folder", "rules.md"), "@../shared rules.md");
    writeFileSync(join(cwd, "AGENTS.md"), "@~/home rules.md\n@folder/rules.md");
    assert.equal(loadInstructions([cwd], tempDir())[0]!.text, "home rules\nshared rules");
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
  }
});

test("missing explicit imports and realpath cycles fail with their source location", () => {
  const cwd = realpathSync(tempDir());
  const file = join(cwd, "AGENTS.md");
  writeFileSync(file, "rules\n@./missing.md");
  assert.throws(() => loadInstructions([cwd], tempDir()), (error: Error) => error.message.includes(`${file}:2`) && error.message.includes("missing.md"));
  symlinkSync(file, join(cwd, "loop.md"));
  writeFileSync(file, "@./loop.md");
  assert.throws(() => loadInstructions([cwd], tempDir()), /instruction reference cycle/);
});

test("unprefixed missing paths stay literal while existing relative files expand", () => {
  const cwd = realpathSync(tempDir());
  const literal = ["@types/node", "@1.4.0", "@app.route", "@missing.md", "@broken.md"];
  writeFileSync(join(cwd, "types"), "not a directory");
  symlinkSync(join(cwd, "missing.md"), join(cwd, "broken.md"));
  writeFileSync(join(cwd, "rules.md"), "existing relative rules");
  writeFileSync(join(cwd, "AGENTS.md"), [...literal, "@rules.md"].join("\n"));
  assert.equal(loadInstructions([cwd], tempDir())[0]!.text, [...literal, "existing relative rules"].join("\n"));
  for (const path of ["./missing.md", "../missing.md", "~/missing.md", join(cwd, "missing.md")]) {
    writeFileSync(join(cwd, "AGENTS.md"), `@${path}`);
    assert.throws(() => loadInstructions([cwd], tempDir()));
  }
});

test("an unreadable instruction target does not select the fallback or disappear", () => {
  const cwd = tempDir();
  symlinkSync(join(cwd, "missing.md"), join(cwd, "AGENTS.md"));
  writeFileSync(join(cwd, "CLAUDE.md"), "fallback");
  assert.throws(() => loadInstructions([cwd], tempDir()), (error: Error) => error.message.includes("AGENTS.md") && !error.message.includes("fallback"));
});

test("unprefixed directories stay literal while existing files expand", () => {
  const cwd = tempDir();
  mkdirSync(join(cwd, "src"));
  mkdirSync(join(cwd, ".git"));
  symlinkSync(join(cwd, "src"), join(cwd, "linked-dir"));
  writeFileSync(join(cwd, "rules.md"), "included rules");
  const literal = "@src/\n@.git\n@linked-dir/";
  writeFileSync(join(cwd, "AGENTS.md"), `${literal}\n@rules.md`);
  assert.equal(loadInstructions([cwd], tempDir())[0]!.text, `${literal}\nincluded rules`);
  writeFileSync(join(cwd, "AGENTS.md"), "@./src/");
  assert.throws(() => loadInstructions([cwd], tempDir()));
});

test("unprefixed references stop on unreadable files and inaccessible parent directories", { skip: process.platform === "win32" || process.getuid?.() === 0 }, () => {
  const cwd = realpathSync(tempDir());
  const source = join(cwd, "AGENTS.md");
  const directory = join(cwd, "protected");
  const file = join(directory, "rules.md");
  mkdirSync(directory);
  writeFileSync(file, "required rules");
  writeFileSync(source, "@protected/rules.md");
  const located = (error: Error) => error.message.includes(`${source}:1`) && error.message.includes("EACCES");
  try {
    chmodSync(file, 0o000);
    assert.throws(() => loadInstructions([cwd], tempDir()), located);
    chmodSync(file, 0o600);
    chmodSync(directory, 0o000);
    assert.throws(() => loadInstructions([cwd], tempDir()), located);
  } finally {
    chmodSync(directory, 0o700);
    chmodSync(file, 0o600);
  }
});
