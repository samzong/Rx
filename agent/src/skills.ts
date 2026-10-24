import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { formatSkillsForPrompt, loadSkills } from "@earendil-works/pi-coding-agent";

type SkillDiagnostic = ReturnType<typeof loadSkills>["diagnostics"][number];

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function discoverSkills(roots: string[]): { paths: string[]; systemPaths: Set<string>; diagnostics: string[] } {
  const paths: string[] = [];
  const systemPaths = new Set<string>();
  const diagnostics: string[] = [];
  const visitedDirectories = new Set<string>();
  const visitedFiles = new Set<string>();
  let systemDirectories: string[] = [];

  const visit = (directory: string, isRoot = false, system = false): void => {
    if (isRoot) {
      try {
        lstatSync(directory);
      } catch (error) {
        if (!isMissing(error)) diagnostics.push(`${directory}: ${describeError(error)}`);
        return;
      }
    }
    let canonicalDirectory: string;
    try {
      canonicalDirectory = realpathSync(directory);
    } catch (error) {
      diagnostics.push(`${directory}: ${describeError(error)}`);
      return;
    }
    if (visitedDirectories.has(canonicalDirectory)) return;
    visitedDirectories.add(canonicalDirectory);

    let entries;
    try {
      entries = readdirSync(canonicalDirectory, { withFileTypes: true });
    } catch (error) {
      diagnostics.push(`${canonicalDirectory}: ${describeError(error)}`);
      return;
    }
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);

    const skillEntry = entries.find((entry) => entry.name === "SKILL.md");
    if (skillEntry) {
      const skillPath = join(canonicalDirectory, skillEntry.name);
      try {
        const canonicalFile = realpathSync(skillPath);
        if (!statSync(canonicalFile).isFile()) {
          diagnostics.push(`${skillPath}: SKILL.md is not a file`);
          return;
        }
        if (!visitedFiles.has(canonicalFile)) {
          visitedFiles.add(canonicalFile);
          paths.push(skillPath);
          if (system) systemPaths.add(skillPath);
        }
      } catch (error) {
        diagnostics.push(`${skillPath}: ${describeError(error)}`);
      }
      return;
    }

    for (const entry of entries) {
      if (entry.name === "node_modules" || (entry.name.startsWith(".") && entry.name !== ".system")) continue;
      const childPath = join(canonicalDirectory, entry.name);
      if (entry.name === ".system" && !system && (entry.isDirectory() || entry.isSymbolicLink())) {
        systemDirectories.push(childPath);
        continue;
      }
      if (entry.isDirectory()) {
        visit(childPath, false, system || entry.name === ".system");
        continue;
      }
      if (!entry.isSymbolicLink()) continue;
      try {
        const canonicalChild = realpathSync(childPath);
        if (statSync(canonicalChild).isDirectory()) visit(canonicalChild, false, system || entry.name === ".system");
      } catch (error) {
        diagnostics.push(`${childPath}: ${describeError(error)}`);
      }
    }
  };

  for (const root of roots) {
    systemDirectories = [];
    visit(root, true);
    for (const directory of systemDirectories) visit(directory, false, true);
  }
  return { paths, systemPaths, diagnostics };
}

function formatDiagnostic(diagnostic: SkillDiagnostic): string {
  if (diagnostic.type === "collision" && diagnostic.collision) {
    const { name, winnerPath, loserPath } = diagnostic.collision;
    return `skill name collision: ${name} (winner: ${winnerPath}; loser: ${loserPath})`;
  }
  return `${diagnostic.path ?? "skills"}: ${diagnostic.message}`;
}

export function skillCatalog(directories: string[], home: string = homedir()): { prompt: string; diagnostics: string[] } {
  const projectRoots = [...directories].reverse().map((directory) => join(resolve(directory), ".agents", "skills"));
  const roots = [...projectRoots, join(resolve(home), ".agents", "skills")];
  const discovered = discoverSkills(roots);
  const cwd = directories.at(-1) ?? home;
  const loaded = loadSkills({
    cwd,
    agentDir: join(home, ".agents"),
    includeDefaults: false,
    skillPaths: discovered.paths,
  });
  const diagnostics = loaded.diagnostics.filter(({ collision }) => !collision || !discovered.systemPaths.has(collision.loserPath) || discovered.systemPaths.has(collision.winnerPath));
  return {
    prompt: formatSkillsForPrompt(loaded.skills, "read"),
    diagnostics: [...discovered.diagnostics, ...diagnostics.map(formatDiagnostic)],
  };
}
