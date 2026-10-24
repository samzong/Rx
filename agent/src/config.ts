import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface RxConfig {
  model?: string;
  thinking?: string;
}

export function rxHome(): string {
  return process.env.RX_HOME || join(homedir(), ".rx");
}

export function configPath(home: string): string {
  return join(home, "config.json");
}

export function loadConfig(home: string = rxHome()): RxConfig {
  const path = configPath(home);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path}: invalid JSON: ${(error as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path}: expected a JSON object`);
  }
  const { model, thinking } = parsed as Record<string, unknown>;
  for (const [key, value] of Object.entries({ model, thinking })) {
    if (value !== undefined && typeof value !== "string") throw new Error(`${path}: "${key}" must be a string`);
  }
  return { model: model as string | undefined, thinking: thinking as string | undefined };
}
