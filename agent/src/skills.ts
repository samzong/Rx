import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { formatSkillsForPrompt, loadSkills, stripFrontmatter } from "@earendil-works/pi-coding-agent";

type SkillDiagnostic = ReturnType<typeof loadSkills>["diagnostics"][number];

export interface SkillCommand {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
}

export const BUILTIN_COMMANDS = ["compact", "exit", "quit"];
const COMMAND_NAME = /^[^\s/"]+$/;

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

export function skillCatalog(directories: string[], home: string = homedir()): { prompt: string; commands: SkillCommand[]; diagnostics: string[] } {
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
  const reserved = loaded.skills.filter(({ name }) => BUILTIN_COMMANDS.includes(name));
  const untypable = loaded.skills.filter(({ name }) => !COMMAND_NAME.test(name));
  return {
    prompt: formatSkillsForPrompt(loaded.skills, "read"),
    commands: loaded.skills.filter((skill) => !reserved.includes(skill) && !untypable.includes(skill)).map(({ name, description, filePath, baseDir }) => ({ name, description, filePath, baseDir })),
    diagnostics: [
      ...discovered.diagnostics,
      ...diagnostics.map(formatDiagnostic),
      ...reserved.map(({ name, filePath }) => `${filePath}: /${name} is a built-in command; the skill has no slash command`),
      ...untypable.map(({ name, filePath }) => `${filePath}: "${name}" contains a space, slash, or quote; the skill has no slash command`),
    ],
  };
}

const SKILL_TOKEN = /(?<=^|\s)\/([^\s/"]+)(?=\s|$)/gu;
const SKILL_BLOCK = /<skill name="([^"]+)" location="[^"]+">\n[\s\S]*?\n<\/skill>(?:\n\n|$)/y;

function skillBlock(skill: SkillCommand): string {
  const body = stripFrontmatter(readFileSync(skill.filePath, "utf8")).trim();
  return `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
}

export function expandSkillCommand(input: string, commands: readonly SkillCommand[]): string {
  const text = input.trim();
  const find = (name: string | undefined) => commands.find((command) => command.name === name);
  const leading = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text);
  const lead = find(leading?.[1]);
  const message = lead ? leading?.[2]?.trim() ?? "" : text;
  const skills = lead ? [lead] : [];
  for (const [, name] of message.matchAll(SKILL_TOKEN)) {
    const skill = find(name);
    if (skill && !skills.includes(skill)) skills.push(skill);
  }
  if (skills.length === 0) return input;
  const blocks = skills.map(skillBlock).join("\n\n");
  return message ? `${blocks}\n\n${message}` : blocks;
}

export function skillInvocationText(text: string): string {
  const names: string[] = [];
  SKILL_BLOCK.lastIndex = 0;
  let match;
  let end = 0;
  while ((match = SKILL_BLOCK.exec(text))) {
    names.push(match[1]!);
    end = SKILL_BLOCK.lastIndex;
  }
  if (names.length === 0) return text;
  const message = text.slice(end).trim();
  const mentioned = [...message.matchAll(SKILL_TOKEN)].some(([, name]) => name === names[0]);
  return mentioned ? message : `/${names[0]}${message ? ` ${message}` : ""}`;
}
