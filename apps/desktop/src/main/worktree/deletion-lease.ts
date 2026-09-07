/**
 * The per-path deletion lease (VC-284 review C4).
 *
 * The window the review found: cleanup asked "is anything running in here?",
 * then awaited the release of every agent binding rooted in the directory, and
 * only then removed it. A terminal created during that await starts in a
 * directory that is about to stop existing, and no re-check placed before the
 * removal can close a gap that opens after it.
 *
 * So the destructive act and the starts are serialized rather than merely
 * ordered. A cleanup takes a lease on the exact path it is about to change, and
 * the two places that can put live work INTO a directory — terminal create
 * (`pty/manager.ts`) and, through it, any harness the terminal hosts — refuse
 * while a lease is held. The lease is released the moment the item settles,
 * successfully or not.
 *
 * Deliberately process-local and deliberately tiny. It is not a lock file and
 * it makes no promise across processes: a second Volli install cannot reach
 * these paths at all (containers.ts is what enforces that), and within this
 * process one map is the whole serialization the window needs.
 */
import { isInside } from "./paths";

/** Paths currently being changed by a destructive worktree act. */
const held = new Map<string, number>();

/** A lease, until it is released. Releasing twice is a no-op. */
export interface DeletionLease {
  path: string;
  release(): void;
}

/**
 * Takes the lease for `path`, or answers `null` when something else already
 * holds it — two cleanups selecting the same directory, or a cleanup racing the
 * manual orphan delete. The caller SKIPS rather than waits: a directory another
 * act is already changing is not one this run should also be changing.
 */
export function acquireDeletionLease(path: string): DeletionLease | null {
  if (held.has(path)) return null;
  const token = (held.get(path) ?? 0) + 1;
  held.set(path, token);
  let released = false;
  return {
    path,
    release() {
      if (released) return;
      released = true;
      held.delete(path);
    },
  };
}

/**
 * Whether `target` sits at or under a directory a destructive act is holding.
 *
 * Asked by anything that would put live work into a directory. Containment
 * rather than equality: a shell started in a subdirectory of a checkout being
 * removed is in exactly as much trouble as one started at its root.
 */
export function isUnderDeletion(target: string): boolean {
  for (const path of held.keys()) {
    if (isInside(path, target)) return true;
  }
  return false;
}

/** The refusal a start gets while a deletion holds its directory. */
export const UNDER_DELETION_REFUSAL =
  "This worktree is being removed right now. Wait for the cleanup to finish.";

/** Test seam: drops every lease, so one test's leak cannot fail the next. */
export function resetDeletionLeasesForTest(): void {
  held.clear();
}
