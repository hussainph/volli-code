/**
 * The file-collision radar's arithmetic (VC-185, split from VC-89 slice 3).
 *
 * Volli already holds every ticket worktree's diff against its base. What no
 * surface exposed was the OVERLAP between them — "VC-65 and VC-68 both touch
 * chat-plane.tsx" — so the rc-0.1.0 chat-plane cluster was tracked entirely in
 * one orchestrator's head and every collision was discovered at merge time,
 * after both branches were already written.
 *
 * This module is the join, and nothing else: paths in, contested paths out. It
 * runs no git and reads no database, because both halves of the radar want the
 * same answer from different evidence — the `conflicts` verb feeds it a live
 * numstat scan, and its own suite feeds it literals. Keeping the arithmetic
 * pure is what lets the ordering guarantees below be tested at all.
 *
 * Two orderings are promised, and both are load-bearing rather than cosmetic:
 * the verb is a read tier CLI string in a bash pipeline (VC-92's amendment on
 * VC-89), so two runs over unchanged worktrees must produce identical bytes
 * whatever order the scan visited them in. Paths sort lexically; claimants
 * sort lexically; pairs sort by how much they collide, worst first, because a
 * pair is the schedulable unit an orchestrator acts on.
 *
 * What this deliberately does NOT compute is whether an overlap would actually
 * conflict in git. Two tickets editing opposite ends of one file merge cleanly,
 * and saying otherwise would make the radar cry wolf. Shared PATHS are the
 * honest signal: they are what a scheduler can act on before either branch is
 * written, which is the whole point of seeing them early.
 */

/** One worktree's contribution to the scan: whose it is, and what it touches. */
export interface WorktreeTouch {
  /** The ticket display id, as every agent surface spells it (`VC-65`). */
  readonly ticket: string;
  /** Paths this ticket's branch touches versus its base. Duplicates are folded. */
  readonly paths: readonly string[];
}

/** One contested path and every ticket laying claim to it. */
export interface PathCollision {
  readonly path: string;
  /** Two or more ticket display ids, lexically ordered. */
  readonly tickets: readonly string[];
}

/** Two tickets that will collide, and every path they share. */
export interface TicketCollision {
  /** Exactly two ticket display ids, lexically ordered. */
  readonly tickets: readonly [string, string];
  /** The shared paths, lexically ordered. Never empty. */
  readonly paths: readonly string[];
}

/** The radar's matrix: the same overlaps read per path, and per ticket pair. */
export interface CollisionMatrix {
  readonly overlaps: readonly PathCollision[];
  readonly pairs: readonly TicketCollision[];
}

/**
 * The map key one ticket pair folds to.
 *
 * No ordering is imposed here, and none is needed: the only caller pairs off an
 * already-sorted claimant list, so `left` precedes `right` under the same
 * comparator every time — which is exactly what makes the same two tickets fold
 * to one key however many paths they share. A defensive re-sort would be dead
 * code pretending to be a guarantee.
 */
function pairKey(left: string, right: string): string {
  return `${left}\u0000${right}`;
}

/**
 * The overlap matrix over a set of worktree diffs.
 *
 * A path with one claimant is not in the answer at all, and neither is a
 * ticket that shares nothing: an empty matrix is the ordinary healthy case and
 * says so by being empty, rather than by listing every path nobody is fighting
 * over. Callers render the empty case plainly.
 */
export function collisionMatrix(touches: readonly WorktreeTouch[]): CollisionMatrix {
  // Folded per ticket first, so one ticket listing a path twice (a rename shows
  // up on both sides of a numstat scan) stays one claimant rather than becoming
  // a collision with itself.
  const claimants = new Map<string, Set<string>>();
  for (const touch of touches) {
    for (const path of new Set(touch.paths)) {
      const holders = claimants.get(path) ?? new Set<string>();
      holders.add(touch.ticket);
      claimants.set(path, holders);
    }
  }

  const overlaps: PathCollision[] = [];
  const shared = new Map<string, string[]>();
  for (const [path, holders] of [...claimants].toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (holders.size < 2) continue;
    const tickets = [...holders].toSorted((left, right) => left.localeCompare(right));
    overlaps.push({ path, tickets });
    for (const [index, left] of tickets.entries()) {
      for (const right of tickets.slice(index + 1)) {
        const key = pairKey(left, right);
        const paths = shared.get(key) ?? [];
        paths.push(path);
        shared.set(key, paths);
      }
    }
  }

  const pairs: TicketCollision[] = [...shared]
    .map(([key, paths]) => {
      const [left, right] = key.split("\u0000") as [string, string];
      return { tickets: [left, right] as [string, string], paths };
    })
    // Worst pair first — the one an orchestrator must not schedule together —
    // then lexically, so ties never depend on scan order.
    .toSorted(
      (left, right) =>
        right.paths.length - left.paths.length ||
        left.tickets[0].localeCompare(right.tickets[0]) ||
        left.tickets[1].localeCompare(right.tickets[1]),
    );

  return { overlaps, pairs };
}
