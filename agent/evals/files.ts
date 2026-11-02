import { createHash } from "node:crypto";
import { chmodSync, cpSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { taskSchema, type Task } from "./schema.ts";

export function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

export function privateJson(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

export function inside(root: string, path: string): string {
  const target = realpathSync(resolve(root, path));
  const rel = relative(realpathSync(root), target);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith("../")) throw new Error("A task path escaped its directory.");
  return target;
}

export function treeHash(root: string): string {
  const hash = createHash("sha256");
  const walk = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      if (name === ".git") throw new Error("Task trees must not contain Git history.");
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error("Task trees must contain only directories and regular files.");
      hash.update(`${relative(root, path)}\0${stat.isDirectory() ? "d" : "f"}\0`);
      if (stat.isDirectory()) walk(path);
      else hash.update(readFileSync(path));
    }
  };
  walk(root);
  return hash.digest("hex");
}

export function copyTree(source: string, target: string): void {
  treeHash(source);
  cpSync(source, target, { recursive: true, dereference: false });
  const permit = (path: string) => {
    const directory = lstatSync(path).isDirectory();
    chmodSync(path, directory ? 0o777 : 0o666 | (lstatSync(path).mode & 0o111));
    if (directory) for (const name of readdirSync(path)) permit(join(path, name));
  };
  permit(target);
}

export function loadTasks(root: string): { task: Task; root: string; hash: string }[] {
  const manifests = join(root, "tasks");
  const tasks = readdirSync(manifests).filter((name) => name.endsWith(".json")).sort().map((name) => {
    const manifest = inside(manifests, name);
    const task = taskSchema.parse(JSON.parse(readFileSync(manifest, "utf8")));
    const taskRoot = inside(root, `fixtures/${task.id}`);
    const initial = inside(taskRoot, task.initial.directory);
    if (treeHash(initial) !== task.initial.sha256) throw new Error(`Initial state changed for ${task.id}.`);
    for (const path of [task.acceptance.directory, task.reference.directory, task.reference.alternativeDirectory, task.reference.incorrectDirectory]) {
      const hidden = inside(taskRoot, path);
      const rel = relative(initial, hidden);
      if (rel === "" || (!isAbsolute(rel) && !rel.startsWith("../"))) throw new Error("The initial state contains hidden evaluation material.");
    }
    for (const path of [task.acceptance.directory, task.reference.directory, task.reference.alternativeDirectory, task.reference.incorrectDirectory]) treeHash(inside(taskRoot, path));
    return { task, root: taskRoot, hash: createHash("sha256").update(readFileSync(manifest)).update(treeHash(taskRoot)).digest("hex") };
  });
  const ids = new Set<string>();
  const families = new Map<string, string>();
  for (const { task } of tasks) {
    if (ids.has(task.id)) throw new Error(`Duplicate task ${task.id}.`);
    if (families.has(task.family) && families.get(task.family) !== task.split) throw new Error("A task family crossed the holdout boundary.");
    ids.add(task.id);
    families.set(task.family, task.split);
  }
  if (!tasks.length) throw new Error("No task manifests found.");
  return tasks;
}

export function sourceHash(root: string): string {
  const hash = createHash("sha256").update(treeHash(join(root, "src")));
  for (const name of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) hash.update(readFileSync(join(root, name)));
  return hash.digest("hex");
}

export function saveArtifacts(source: string, target: string, secrets: string[]): { directory: string; sha256: string; omitted: string[]; redacted: boolean } {
  privateDirectory(target);
  const omitted: string[] = [];
  let total = 0;
  let redacted = false;
  const redactName = (name: string) => secrets.filter(Boolean).reduce((value, secret) => {
    if (value.includes(secret)) redacted = true;
    return value.replaceAll(secret, "[REDACTED]");
  }, name);
  const copy = (from: string, to: string) => {
    for (const name of readdirSync(from).sort()) {
      const path = join(from, name);
      const destination = join(to, redactName(name));
      const stat = lstatSync(path);
      const rel = relative(source, path);
      if (name === "node_modules" || name === ".git" || stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) { omitted.push(redactName(rel)); continue; }
      if (stat.isDirectory()) { privateDirectory(destination); copy(path, destination); continue; }
      if (stat.size > 16 * 1024 * 1024) { omitted.push(redactName(rel)); continue; }
      let bytes = readFileSync(path);
      for (const secret of secrets) {
        const value = Buffer.from(secret);
        if (!value.length || !bytes.includes(value)) continue;
        bytes = Buffer.from(bytes.toString("latin1").replaceAll(value.toString("latin1"), "[REDACTED]"), "latin1");
        redacted = true;
      }
      if (bytes.length > 16 * 1024 * 1024 || total + bytes.length > 64 * 1024 * 1024) { omitted.push(redactName(rel)); continue; }
      total += bytes.length;
      writeFileSync(destination, bytes, { mode: 0o600 | (stat.mode & 0o100) });
    }
  };
  copy(source, target);
  return { directory: target, sha256: treeHash(target), omitted, redacted };
}
