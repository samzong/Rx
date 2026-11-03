import { readdirSync, readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";

let checked = 0;
for (const root of ["src", "test", "scripts", "evals"]) {
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".d.ts")) continue;
    const path = join(entry.parentPath, entry.name);
    stripTypeScriptTypes(readFileSync(path, "utf8"), { mode: "strip", sourceUrl: path });
    checked++;
  }
}
console.log(`Node type-stripping syntax: ${checked} files passed`);
