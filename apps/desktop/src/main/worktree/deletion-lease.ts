/**
 * The per-path deletion lease (VC-284 review C4) — two-sided.
 *
 * The window the review found: cleanup asked "is anything running in here?",
 * then awaited the release of every agent binding rooted in the directory, and
 * only then removed it. A terminal created during that await starts in a
 * directory that is about to stop existing, and no re-check placed before the
 * removal can close a gap that opens after it.
 *
 * Ordering the two acts is not enough, because BOTH of them take time. A
 * terminal start passes its "is this being deleted?" guard and then awaits
 * harness files, a lazy `node-pty` import and a `mkdir` before it spawns; a
 * cleanup passes its last check and awaits a durable write before it removes.
 * Either one can be overtaken inside those awaits by the other. So the two
 * sides are SERIALIZED rather than ordered, and both take a lease
 * (re-review C4):
 *
 *  - a DELETE lease is taken by every act that destroys a worktree directory —
 *    the confirmed cleanup, the manual orphan delete — and it refuses if
 *    anything else holds an overlapping path, in either direction;
 *  - a START lease is taken by every act that puts live work INTO one — a
 *    terminal spawn, an agent binding being prepared or reaffirmed — from
 *    before its first await until the work is registered where the activity
 *    supplier can see it. Starts do not exclude each other; they exclude
 *    deletion.
 *
 * Overlap, not equality: a shell started in a subdirectory of a checkout being
 * removed is in exactly as much trouble as one started at its root, so
 * containment is tested both ways over canonicalized paths.
 *
 * Contenders never wait. A directory another act is already changing is not one
 * this act should also be changing, so both `acquire` functions answer `null`
 * and the caller skips or refuses. That is also why there is no deadlock to
 * reason about: nothing here ever blocks.
 *
 * Deliberately process-local and deliberately tiny. It is not a lock file and
 * it makes no promise across processes: a second Volli install cannot reach
 * these paths at all (containers.ts is what enforces that), and within this
 * process one map is the whole serialization the window needs.
 */
import { canonicalize, isInside } from "./paths";

/** What a holder is doing to the directory: destroying it, or starting work in it. */
type LeaseKind = "delete" | "start";

interface HeldLease {
  id: number;
  path: string;
  kind: LeaseKind;
}

/** Paths currently held by a destructive act or by a start, canonicalized. */
const held = new Map<number, HeldLease>();
let nextLeaseId = 0;

/** A lease, until it is released. Releasing twice is a no-op. */
export interface DeletionLease {
  path: string;
  release(): void;
}

/** Whether `path` overlaps any held lease of one of `kinds`, in either direction. */
function conflicting(path: string, kinds: readonly LeaseKind[]): boolean {
  const target = canonicalize(path);
  for (const lease of held.values()) {
    if (!kinds.includes(lease.kind)) continue;
    if (isInside(lease.path, target) || isInside(target, lease.path)) return true;
  }
  return false;
}

function take(
  path: string,
  kind: LeaseKind,
  blockedBy: readonly LeaseKind[],
): DeletionLease | null {
  if (conflicting(path, blockedBy)) return null;
  const id = (nextLeaseId += 1);
  held.set(id, { id, path: canonicalize(path), kind });
  let released = false;
  return {
    path,
    release() {
      if (released) return;
      released = true;
      held.delete(id);
    },
  };
}

/**
 * Takes the DELETE lease for `path`, or answers `null` when something else
 * overlaps it — two cleanups selecting the same directory, a cleanup racing the
 * manual orphan delete, or a terminal/agent currently starting inside it. The
 * caller SKIPS rather than waits.
 */
export function acquireDeletionLease(path: string): DeletionLease | null {
  return take(path, "delete", ["delete", "start"]);
}

/**
 * Takes the START lease for `path`, or answers `null` when a destructive act
 * holds it — the answer a terminal or agent start must treat as a refusal
 * ({@link UNDER_DELETION_REFUSAL}).
 *
 * Held from BEFORE the start's first await until the work is visible to the
 * activity supplier, which is the whole span in which a deletion would
 * otherwise find the directory idle.
 */
export function acquireWorktreeStartLease(path: string): DeletionLease | null {
  return take(path, "start", ["delete"]);
}

/**
 * Whether `target` sits at or under a directory a destructive act is holding.
 *
 * A read, for a caller that only wants to refuse rather than to hold anything.
 * A start that is going to do work should take {@link acquireWorktreeStartLease}
 * instead: asking is a statement about one instant, holding is a statement
 * about a span.
 */
export function isUnderDeletion(target: string): boolean {
  return conflicting(target, ["delete"]);
}

/** The refusal a start gets while a deletion holds its directory. */
export const UNDER_DELETION_REFUSAL =
  "This worktree is being removed right now. Wait for the cleanup to finish.";

/** Test seam: drops every lease, so one test's leak cannot fail the next. */
export function resetDeletionLeasesForTest(): void {
  held.clear();
}
