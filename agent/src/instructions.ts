import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { rxHome } from "./config.ts";

export interface Instructions {
  file: string;
  text: string;
}

export function projectDirectories(cwd: string): string[] {
  let current: string;
  try {
    current = realpathSync(cwd);
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return [];
    throw error;
  }
  let root: string;
  try {
    root = realpathSync(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: current, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
  } catch {
    return [current];
  }
  const within = relative(root, current);
  if (within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) return [current];
  const directories = [current];
  while (directories[0] !== root) directories.unshift(dirname(directories[0]!));
  return directories;
}

function present(file: string): boolean {
  try {
    lstatSync(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function reference(line: string): string | undefined {
  if (/^(?: {4}|\t)/.test(line)) return undefined;
  const match = /^\s{0,3}@([^@\r\n]+?)\s*$/.exec(line);
  const path = match?.[1];
  if (!path || /^[a-z][a-z\d+.-]*:\/\//i.test(path)) return undefined;
  if (isAbsolute(path) || path.startsWith("~/") || path.startsWith("./") || path.startsWith("../")) return path;
  return !/\s/.test(path) && /[/.\\]/.test(path) ? path : undefined;
}

export function loadInstructions(directories: string[], home: string = rxHome()): Instructions[] {
  const seen = new Set<string>();
  const active = new Set<string>();

  const expand = (file: string, from?: string): string => {
    let canonical: string;
    let text: string;
    try {
      canonical = realpathSync(file);
      if (active.has(canonical)) throw new Error("instruction reference cycle");
      if (seen.has(canonical)) return "";
      text = readFileSync(canonical, "utf8");
    } catch (error) {
      throw new Error(`${from ? `${from}: cannot import ${file}` : `Cannot load instructions from ${file}`}: ${(error as Error).message}`);
    }
    active.add(canonical);
    seen.add(canonical);
    let fence: { marker: string; length: number } | undefined;
    const expanded = text.split(/\r?\n/).map((line, index) => {
      const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (delimiter) {
        const markers = delimiter[1]!;
        if (!fence) fence = { marker: markers[0]!, length: markers.length };
        else if (markers[0] === fence.marker && markers.length >= fence.length && !delimiter[2]!.trim()) fence = undefined;
        return line;
      }
      if (fence) return line;
      const path = reference(line);
      if (!path) return line;
      const target = path.startsWith("~/") ? join(homedir(), path.slice(2)) : resolve(dirname(canonical), path);
      if (!isAbsolute(path) && !/^(?:~\/|\.\.?\/)/.test(path)) {
        try {
          if (!statSync(target).isFile()) return line;
        } catch (error) {
          if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return line;
          throw new Error(`${canonical}:${index + 1}: cannot import ${target}: ${(error as Error).message}`);
        }
      }
      return expand(target, `${canonical}:${index + 1}`);
    }).join("\n");
    active.delete(canonical);
    return expanded.trim();
  };

  const files = [join(home, "AGENTS.md")];
  for (const directory of directories) {
    const file = ["AGENTS.md", "CLAUDE.md"].map((name) => join(directory, name)).find(present);
    if (file) files.push(file);
  }
  return files.filter(present).map((file) => {
    const text = expand(file);
    return { file: realpathSync(file), text };
  }).filter(({ text }) => text.length > 0);
}
