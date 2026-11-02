export interface SessionTurn {
  type: "turn";
  version: 1;
  id: string;
  through: number;
}

export interface LocatedTurn extends SessionTurn {
  index: number;
}

export function sessionTurns(values: unknown[], path: string): LocatedTurn[] {
  const turns: LocatedTurn[] = [];
  const ids = new Set<string>();
  let through = 0;
  let explicit = false;
  for (const [index, value] of values.entries()) {
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    if (record.type === "turn") {
      if (record.version !== 1 || typeof record.id !== "string" || !record.id || ids.has(record.id) || record.through !== through) {
        throw new Error(`${path}:${index + 2}: invalid session turn`);
      }
      explicit = true;
      ids.add(record.id);
      turns.push({ type: "turn", version: 1, id: record.id, through, index });
    }
    if (record.type === "message") {
      const message = record.message as { role?: unknown } | undefined;
      if (!explicit && record.purpose !== "compaction" && record.origin !== "rx" && message?.role === "user") {
        const id = `message-${through + 1}`;
        ids.add(id);
        turns.push({ type: "turn", version: 1, id, through, index });
      }
      through++;
    }
  }
  return turns;
}
