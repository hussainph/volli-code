/**
 * A minimal, dependency-free line diff for surfacing *why* a managed file was
 * left untouched (spec decision 12: "warn + diff instead" of a bare path). Pure
 * string-in/string-out — no Node, no DOM — so it can render into an Electron
 * dialog's plain-text detail. Not a full Myers diff: it strips the shared common
 * prefix and suffix and shows the differing middle as `-` (on disk) / `+`
 * (desired) hunks, which reads clearly for the small, mostly-append edits these
 * managed files see. Output is capped so a wholesale rewrite can't flood a
 * dialog.
 */
const MAX_DIFF_LINES = 200;

export function diffManagedContent(current: string, desired: string): string {
  const a = current.split("\n");
  const b = desired.split("\n");

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;

  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const removed = a.slice(start, endA).map((line) => `- ${line}`);
  const added = b.slice(start, endB).map((line) => `+ ${line}`);
  const hunk = [...removed, ...added];
  if (hunk.length === 0) return "(no textual difference)";
  if (hunk.length <= MAX_DIFF_LINES) return hunk.join("\n");
  return [
    ...hunk.slice(0, MAX_DIFF_LINES),
    `… (${hunk.length - MAX_DIFF_LINES} more changed lines)`,
  ].join("\n");
}
