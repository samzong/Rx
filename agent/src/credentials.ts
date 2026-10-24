import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { isAlive, tryLink } from "./pid-lock.ts";

const LOCK_RETRY_MS = 50;
const LOCK_WAIT_MS = 30_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Entries = Record<string, Credential>;

function ensureHome(home: string): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function writeAtomic(path: string, text: string): void {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, text, { mode: 0o600, flag: "wx" });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

function validEntry(value: unknown): value is Credential {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  if (entry.type === "api_key") {
    return (entry.key === undefined || typeof entry.key === "string") && (entry.env === undefined || (typeof entry.env === "object" && entry.env !== null));
  }
  return entry.type === "oauth" && typeof entry.access === "string" && typeof entry.refresh === "string" && typeof entry.expires === "number";
}

export class FileCredentialStore implements CredentialStore {
  readonly path: string;
  private readonly home: string;
  private readonly launchProvider: string | undefined;
  private readonly lockPath: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(home: string, launchProvider?: string) {
    this.home = home;
    this.launchProvider = launchProvider;
    this.path = join(home, "auth.json");
    this.lockPath = `${this.path}.lock`;
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return providerId === this.launchProvider ? undefined : this.load()[providerId];
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return Object.entries(this.load())
      .filter(([providerId]) => providerId !== this.launchProvider)
      .map(([providerId, credential]) => ({ providerId, type: credential.type }));
  }

  modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>, options?: AuthOperationOptions): Promise<Credential | undefined> {
    return this.exclusive(providerId, options?.signal, async () => {
      const entries = this.load();
      const next = await fn(entries[providerId]);
      if (next === undefined) return entries[providerId];
      if (!validEntry(next)) throw new Error(`refusing to store a malformed credential for ${providerId}`);
      entries[providerId] = next;
      this.save(entries);
      return next;
    });
  }

  delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    return this.exclusive(providerId, options?.signal, async () => {
      const entries = this.load();
      if (!(providerId in entries)) return;
      delete entries[providerId];
      this.save(entries);
    });
  }

  private load(): Entries {
    const text = readText(this.path);
    if (text === undefined) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`${this.path}: invalid JSON: ${(error as Error).message}`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`${this.path}: expected a JSON object`);
    for (const [providerId, entry] of Object.entries(parsed)) {
      if (!validEntry(entry)) throw new Error(`${this.path}: malformed credential for "${providerId}"`);
    }
    return parsed as Entries;
  }

  private save(entries: Entries): void {
    ensureHome(this.home);
    writeAtomic(this.path, `${JSON.stringify(entries, null, 2)}\n`);
  }

  private exclusive<T>(providerId: string, signal: AbortSignal | undefined, task: () => Promise<T>): Promise<T> {
    if (providerId === this.launchProvider) {
      return Promise.reject(new Error(`credentials for "${providerId}" come from the rx launch; run rx-agent login or logout without an rx provider`));
    }
    const run = this.queue.then(async () => {
      await this.lock(signal);
      try {
        return await task();
      } finally {
        try {
          unlinkSync(this.lockPath);
        } catch {}
      }
    });
    this.queue = run.catch(() => {});
    return run;
  }

  private async lock(signal: AbortSignal | undefined): Promise<void> {
    ensureHome(this.home);
    const temp = `${this.lockPath}.${process.pid}.${randomUUID()}.tmp`;
    const deadline = Date.now() + LOCK_WAIT_MS;
    try {
      writeFileSync(temp, String(process.pid), { mode: 0o600 });
      while (!tryLink(temp, this.lockPath)) {
        const text = readText(this.lockPath);
        if (text === undefined) continue;
        const owner = Number(text);
        if (!(owner > 0 && owner !== process.pid && isAlive(owner))) {
          rmSync(this.lockPath, { force: true });
          continue;
        }
        if (Date.now() >= deadline) {
          throw new Error(`${this.path} is locked by process ${owner}; if no rx-agent process is using it, delete ${this.lockPath}`);
        }
        await sleep(LOCK_RETRY_MS, undefined, { signal });
      }
    } finally {
      rmSync(temp, { force: true });
    }
  }
}

export function deviceId(home: string): string {
  const path = join(home, "device-id");
  const existing = readText(path)?.trim();
  if (existing !== undefined) {
    if (!UUID.test(existing)) throw new Error(`${path}: expected a UUID`);
    return existing;
  }
  ensureHome(home);
  const id = randomUUID();
  try {
    writeFileSync(path, `${id}\n`, { mode: 0o600, flag: "wx" });
    return id;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return deviceId(home);
  }
}
