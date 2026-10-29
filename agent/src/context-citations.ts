import type { SourceRange } from "./context-source.ts";

export function mergeSources(ranges: SourceRange[]): SourceRange[] {
  const result: SourceRange[] = [];
  for (const range of [...ranges].sort((a, b) => a.from - b.from || b.to - a.to)) {
    const previous = result.at(-1);
    if (previous && range.from <= previous.to && (previous.coverage || range.coverage)) {
      previous.to = Math.max(previous.to, range.to);
      previous.coverage = true;
    } else if (previous && previous.coverage === range.coverage && range.from <= previous.to + 1) {
      previous.to = Math.max(previous.to, range.to);
    } else result.push({ ...range });
  }
  return result;
}

export function sourceLabel(ranges: SourceRange[]): string {
  if (!ranges.length) throw new Error("A context message has no original log source");
  return ranges.map(({ from, to, coverage }) => `${coverage ? "Coverage reference " : ""}[log ${from}-${to}]`).join(" ");
}

export class CitationError extends Error {}

function supported(from: number, to: number, allowed: SourceRange[]): boolean {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || from > to) return false;
  let next = from;
  for (const range of mergeSources(allowed)) {
    if (range.to < next) continue;
    if (range.from > next) return false;
    if (range.coverage && (from > range.from || to < range.to)) return false;
    next = range.to + 1;
    if (next > to) return true;
  }
  return false;
}

function nonSubstantive(line: string, nextLine: string | undefined): boolean {
  const trimmed = line.trim();
  if (!trimmed || /^#{1,6}\s+/.test(trimmed)) return true;
  if (/^(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/.test(trimmed)) return true;
  if (/^(?:`{3,}|~{3,})(?:[a-zA-Z0-9_-]+)?$/.test(trimmed)) return true;
  const tableSeparator = (text: string) => /^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?$/.test(text.trim());
  if (tableSeparator(trimmed) || /^\|(?:\s*\|)+$/.test(trimmed)) return true;
  if (trimmed.includes("|") && nextLine !== undefined && tableSeparator(nextLine)) return true;
  const body = trimmed.replace(/^(?:[-*+]|\d+[.)])(?:\s+|$)/, "").replace(/^\[[ xX]\]\s*/, "").replace(/[*_]/g, "").trim();
  const placeholder = body.replace(/[()[\]]/g, "");
  if (!body || /^(?:none|n\/a)(?:\s+(?:identified|stated|reported|noted|specified|known|currently))?[.!]?$/i.test(placeholder)) return true;
  return /^(?:Goal|Constraints & Preferences|Progress|Done|In Progress|Blocked|Key Decisions|Next Steps|Critical Context):?$/i.test(body);
}

export function validateSummarySources(summary: string, allowed: SourceRange[]): SourceRange[] {
  const cited: SourceRange[] = [];
  const lines = summary.split("\n");
  for (const [index, line] of lines.entries()) {
    const references = [...line.matchAll(/\[log ([1-9]\d*)-([1-9]\d*)\]/g)];
    if (/\[log\b/i.test(line.replace(/\[log ([1-9]\d*)-([1-9]\d*)\]/g, ""))) {
      throw new CitationError("The context summary contains an invalid log reference");
    }
    if (!references.length && !nonSubstantive(line, lines[index + 1])) {
      throw new CitationError("Each substantive summary line needs a log reference");
    }
    for (const reference of references) {
      const from = Number(reference[1]);
      const to = Number(reference[2]);
      if (!supported(from, to, allowed)) throw new CitationError("The context summary cites content outside its original sources");
      for (const range of allowed) {
        if (range.from <= to && range.to >= from) cited.push({ ...range, from: Math.max(from, range.from), to: Math.min(to, range.to) });
      }
    }
  }
  if (!cited.length) throw new CitationError("The context summary has no cited source content");
  return mergeSources(cited);
}
