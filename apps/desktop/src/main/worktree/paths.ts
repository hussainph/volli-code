/**
 * Path canonicalization for reconciliation and the copy-step guards. Every
 * cross-path comparison in this module runs on realpath-canonicalized paths so
 * macOS `/private` aliasing (a Vibe Kanban footgun — `/tmp` is a symlink to
 * `/private/tmp`) can never make an identical worktree read as two different
 * locations. Both sides of any comparison are always canonicalized.
 */
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

/**
 * Absolute realpath of `p`, resolving symlinks and `/private` aliasing. A path
 * that does not exist yet canonicalizes its DEEPEST EXISTING ANCESTOR and
 * re-appends the missing tail; if not even the root resolves, falls back to
 * `path.resolve`. So a to-be-created worktree path still canonicalizes to the
 * same value its parent (`~/.volli/worktrees/...`) would.
 */
export function canonicalize(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync.native(abs);
  } catch {
    // Walk up until an ancestor exists, then re-attach the missing tail.
    const tail: string[] = [];
    let current = abs;
    for (;;) {
      const parent = dirname(current);
      if (parent === current) return abs; // reached the root, nothing resolved
      tail.unshift(basename(current));
      current = parent;
      try {
        return join(realpathSync.native(current), ...tail);
      } catch {
        // keep walking up
      }
    }
  }
}

/**
 * Whether canonical `child` is `root` itself or lives inside it. Both operands
 * are canonicalized first, so this is the traversal guard the copy step uses to
 * reject `../escape`-style destinations.
 */
export function isInside(root: string, child: string): boolean {
  const r = canonicalize(root);
  const c = canonicalize(child);
  if (c === r) return true;
  const rel = relative(r, c);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Two paths point at the same location once canonicalized. */
export function samePath(a: string, b: string): boolean {
  return canonicalize(a) === canonicalize(b);
}
