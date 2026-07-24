/**
 * Tab naming for the Project Files strip. A tab is named by its basename —
 * anything longer stops being scannable at tab width — which means two open
 * files can legitimately claim the same name (`index.ts`, `README.md`,
 * `main.rs`). The disambiguation rule is the editor convention: show a muted
 * slice of the parent path, and only for the tabs that actually collide, so a
 * calm strip stays calm.
 *
 * Pure and order-preserving: the caller hands over the strip's relPaths in
 * strip order and gets one descriptor back per tab, in the same order.
 */

/** One tab's rendered name plus the parent slice that separates it from its twins. */
export interface FileTabLabel {
  relPath: string;
  /** The basename — always shown. */
  name: string;
  /** A muted parent slice, or `null` when this basename is already unique. */
  hint: string | null;
}

/** The hint shown for a colliding file that sits at the repository root (no parent segments). */
const ROOT_HINT = "/";

/** The path's directory segments, root-first (`[]` for a file at the repo root). */
function parentSegments(relPath: string): string[] {
  const parts = relPath.split("/");
  return parts.slice(0, -1);
}

/** The last `depth` parent segments, joined — the candidate hint at that depth. */
function hintAtDepth(segments: readonly string[], depth: number): string {
  if (segments.length === 0) return ROOT_HINT;
  return segments.slice(Math.max(0, segments.length - depth)).join("/");
}

/**
 * The shallowest parent depth at which every member of a colliding group gets a
 * distinct hint. Deepening stops at the longest parent in the group: past that
 * point every hint is the member's whole parent path, which is as distinct as
 * two different relPaths sharing a basename can be.
 */
function disambiguatingDepth(group: readonly string[][]): number {
  const maxDepth = Math.max(1, ...group.map((segments) => segments.length));
  for (let depth = 1; depth < maxDepth; depth += 1) {
    const hints = group.map((segments) => hintAtDepth(segments, depth));
    if (new Set(hints).size === group.length) return depth;
  }
  return maxDepth;
}

/** Tab descriptors for the strip's relPaths, in the caller's order. */
export function fileTabLabels(relPaths: readonly string[]): FileTabLabel[] {
  const byName = new Map<string, string[]>();
  for (const relPath of relPaths) {
    const name = relPath.slice(relPath.lastIndexOf("/") + 1);
    const bucket = byName.get(name);
    if (bucket === undefined) byName.set(name, [relPath]);
    else bucket.push(relPath);
  }

  const depthByName = new Map<string, number>();
  for (const [name, bucket] of byName) {
    if (bucket.length < 2) continue;
    depthByName.set(name, disambiguatingDepth(bucket.map(parentSegments)));
  }

  return relPaths.map((relPath) => {
    const name = relPath.slice(relPath.lastIndexOf("/") + 1);
    const depth = depthByName.get(name);
    return {
      relPath,
      name,
      hint: depth === undefined ? null : hintAtDepth(parentSegments(relPath), depth),
    };
  });
}
