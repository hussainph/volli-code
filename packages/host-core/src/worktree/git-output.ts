/** Shared NUL-delimited Git output tokenizer used by Change Set and worktree reports. */
export interface ParsedNumstat {
  path: string;
  previousPath?: string;
  insertions: number | null;
  deletions: number | null;
  binary: boolean;
}

/** Parses `git diff --numstat -z`, optionally starting after grouped raw records. */
export function parseNumstatTokens(tokens: readonly string[], start = 0): ParsedNumstat[] {
  const entries: ParsedNumstat[] = [];
  let i = start;
  while (i < tokens.length) {
    const field = tokens[i++]!;
    if (field.length === 0) continue;
    const parts = field.split("\t");
    if (parts.length < 2) continue;
    const insertions = parseCount(parts[0]!);
    const deletions = parseCount(parts[1]!);
    // Only the first two tabs separate counts; tabs inside a literal path survive.
    const pathPart = parts.slice(2).join("\t");
    const binary = insertions === null && deletions === null;
    if (pathPart.length > 0) {
      entries.push({ path: pathPart, insertions, deletions, binary });
      continue;
    }
    const previousPath = tokens[i++] ?? "";
    const path = tokens[i++] ?? "";
    if (path.length === 0) continue;
    entries.push({ path, previousPath, insertions, deletions, binary });
  }
  return entries;
}

/** `"-"` (binary) → null; otherwise the parsed integer. */
function parseCount(field: string): number | null {
  if (field === "-") return null;
  const n = Number.parseInt(field, 10);
  return Number.isInteger(n) ? n : null;
}

export function splitNul(out: string): string[] {
  if (out.length === 0) return [];
  const parts = out.split("\0");
  // git's trailing NUL leaves a final empty token — drop it.
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}
