import { resolve, sep } from "node:path";
import { isInside } from "./worktree/paths";

// Absolute project roots the renderer has registered. Filesystem and PTY
// handlers only operate inside these. Defense-in-depth for a compromised
// renderer, not a hard boundary — the registry itself is renderer-fed. This
// single module owns the registry so every main-process consumer (ipc.ts,
// pty.ts) shares one source of truth.
const projectRoots = new Set<string>();

/** True when `absPath` is one of `roots` or a descendant of one. Pure. */
export function isWithinRoots(roots: ReadonlySet<string>, absPath: string): boolean {
  for (const root of roots) {
    if (absPath === root || absPath.startsWith(root + sep)) {
      return true;
    }
  }
  return false;
}

/**
 * Replaces the registered roots wholesale. Ignores a non-array payload and
 * skips non-string entries — the arg arrives untrusted from the renderer.
 * Entries are resolved to absolute paths so later containment checks (which
 * `resolve()` incoming paths) compare like-for-like.
 */
export function syncProjectRoots(paths: unknown): void {
  projectRoots.clear();
  if (Array.isArray(paths)) {
    for (const path of paths) {
      if (typeof path === "string") {
        projectRoots.add(resolve(path));
      }
    }
  }
}

/** True when `absPath` falls inside the currently-registered project roots. */
export function isPathWithinRoots(absPath: string): boolean {
  return isWithinRoots(projectRoots, absPath);
}

/**
 * True when `absPath` falls inside the currently-registered project roots once
 * resolved through the filesystem — the seam `volli:list-directory` and
 * `volli:reveal-in-finder` walk through. {@link isPathWithinRoots} is lexical,
 * so a symlink inside a project that points outside it passes on its name
 * alone; here the target is canonicalized (following links, and judging the
 * deepest existing ancestor when the leaf itself is missing, so
 * `root/link-out/child` is caught too) against each canonicalized root, which
 * also makes macOS `/tmp` → `/private/tmp` aliasing compare like-for-like.
 * Both checks stay available: the lexical one answers registry questions
 * without touching the disk, this one is for seams that actually open, list,
 * or reveal the path.
 */
export function isRealPathWithinRoots(absPath: string): boolean {
  for (const root of projectRoots) {
    if (isInside(root, absPath)) {
      return true;
    }
  }
  return false;
}
