import { resolve, sep } from "node:path";

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
