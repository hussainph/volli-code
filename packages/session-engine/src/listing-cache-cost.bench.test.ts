import { describe, expect, it } from "vite-plus/test";
import { createSessionProjectionCheckpoint } from "@volli/shared";
import type {
  Session,
  SessionEventProvenance,
  SessionLedgerIds,
  SessionProjection,
  SessionProjectionEvent,
} from "@volli/shared";
import { createInMemorySessionLedger, createSessionEngine } from "./index";

/**
 * What it costs to stop a caller aliasing a cached listing row (VC-393).
 *
 * VC-388 made `listSessions` hand the SAME projection to every caller while
 * its cache entry survives. That sharing is the cache's whole value, and it is
 * also the hazard: one mutating caller would rewrite every later read. VC-393
 * asked for the fix to be chosen by MEASURING the candidates against the entry
 * weights in `docs/research/perf/session-listing-vc388.md` (5.6 KB for an
 * ordinary Session, 79.8 KB for a deliberately extreme one), rather than by
 * arguing about them. This is that measurement.
 *
 * Three candidates, and the difference between them is not really speed:
 *
 *  - **freeze in place** — deep-freeze the folded object. The cheapest, and
 *    the one that is wrong: `foldSessionProjection` copies CONTAINERS and
 *    re-uses their ELEMENTS, so the graph it returns still holds the objects
 *    the ledger handed over inside the event payloads and the base checkpoint.
 *    Freezing it reaches back into all of them. That is a correctness fault,
 *    not a cost, and no timing can redeem it — so it is priced here only to
 *    show what the safe option costs ON TOP of it.
 *  - **frozen copy** — deep-copy, freezing as it goes. Owns everything it
 *    freezes. Paid once per FOLD, which is the shipped choice.
 *  - **copy on read** — give every caller its own `structuredClone`. Also
 *    owns everything, but is paid once per ROW PER LISTING, which is exactly
 *    the cost the cache was built to remove.
 *
 * Wall-clock microseconds are PRINTED, not asserted: at this size they do not
 * survive a loaded CI runner, which is the same reason
 * `turn-write-cost.bench.test.ts` asserts row counts instead of timings. What
 * is asserted is the structural claim the choice actually rests on — how many
 * times each candidate walks the graph, and whether what it froze is its own.
 */

const venue = { id: "machine-1", kind: "local" as const };
const provenance: SessionEventProvenance = {
  source: { kind: "user", id: "host-user", detail: null },
  venue,
};

function ids(): SessionLedgerIds {
  let sequence = 0;
  return { next: (kind) => `${kind}-${++sequence}` };
}

/**
 * The two roster shapes the entry weights were measured on. `submit` writes
 * three events per call — the command, its effect, and its receipt — so the
 * turn counts below land on the documented event counts.
 */
const SHAPES = [
  { name: "ordinary", submits: 8, approximateEvents: 27, documentedKb: 5.6 },
  { name: "extreme", submits: 150, approximateEvents: 453, documentedKb: 79.8 },
] as const;

/** Deep-freeze in place: the candidate that freezes what it does not own. */
function freezeInPlace(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freezeInPlace(child);
  return value;
}

/** Deep-copy, freezing as it goes: the shipped `frozenProjectionCopy`. */
function frozenCopy(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return Object.freeze(value.map(frozenCopy));
  const copy: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) copy[key] = frozenCopy(child);
  return Object.freeze(copy);
}

/** How many objects and arrays one projection's graph holds. */
function nodeCount(value: unknown): number {
  if (value === null || typeof value !== "object") return 0;
  let total = 1;
  for (const child of Object.values(value)) total += nodeCount(child);
  return total;
}

function microsecondsPerCall(repeats: number, operation: () => void): number {
  const startedAt = performance.now();
  for (let index = 0; index < repeats; index += 1) operation();
  return ((performance.now() - startedAt) * 1000) / repeats;
}

/**
 * Prices one candidate over a pool of projections built BEFORE the clock
 * starts.
 *
 * The fold is deliberately outside the timed region rather than subtracted
 * from it. Each candidate consumes its input — freezing in place cannot be
 * repeated on the same graph and mean anything — so a timed "fold then
 * protect" loop would measure a fold per repetition and leave the protection
 * as the difference between two much larger numbers, which at this size is
 * mostly JIT warm-up. A warm-up pass runs first for the same reason.
 */
function priceCandidate(
  repeats: number,
  freshProjection: () => SessionProjection,
  apply: (projection: SessionProjection) => unknown,
): number {
  for (let index = 0; index < 5; index += 1) apply(freshProjection());
  const pool = Array.from({ length: repeats }, freshProjection);
  const startedAt = performance.now();
  for (const projection of pool) apply(projection);
  return ((performance.now() - startedAt) * 1000) / repeats;
}

async function fixture(submits: number): Promise<{
  session: Session;
  events: readonly SessionProjectionEvent[];
}> {
  const ledger = createInMemorySessionLedger();
  let now = 100;
  const engine = createSessionEngine({ ledger, clock: { now: () => now++ }, ids: ids() });
  const created = await engine.createSession({
    commandId: "command-create",
    projectId: "project-1",
    ticketId: "ticket-1",
    role: "ticket",
    parentSessionId: null,
    title: "Durable Session",
    provenance,
  });
  for (let index = 0; index < submits; index += 1) {
    await engine.submit({
      commandId: `command-turn-${index}`,
      sessionId: created.session.id,
      intent: { kind: "session.retitle", title: `Turn ${index}` },
      provenance,
    });
  }
  return ledger.transaction((transaction) => ({
    session: created.session,
    events: transaction.listProjectionEvents({ sessionId: created.session.id }),
  }));
}

describe("listing fold cache: what protecting a shared row costs (VC-393)", () => {
  it(
    "prices freeze-in-place, frozen copy and copy-on-read against the entry weights",
    { timeout: 120_000 },
    async () => {
      const rows: string[] = [];

      for (const shape of SHAPES) {
        const { session, events } = await fixture(shape.submits);
        // Every fold starts from FRESH event objects, so one candidate
        // freezing what it was handed cannot make the next candidate's work
        // cheaper — `Object.freeze` on an already-frozen object is nearly
        // free, and measuring that would flatter the candidate this ticket
        // rejects. The clone is inside the timed baseline too, so it cancels.
        const fold = (): SessionProjection =>
          createSessionProjectionCheckpoint(session, structuredClone(events)).projection;

        const sample = fold();
        const eventCount = events.length;
        const nodes = nodeCount(sample);
        const jsonKb = JSON.stringify(sample).length / 1024;

        // Each candidate consumes its input — a frozen graph cannot be frozen
        // again meaningfully — so every repetition folds a fresh one. The fold
        // is timed separately and subtracted, so the figures below are the
        // protection alone rather than the fold plus the protection.
        const repeats = shape.submits > 50 ? 40 : 400;
        // The fold needs no fresh events of its own — it only reads them — so
        // its baseline is timed directly.
        for (let index = 0; index < 5; index += 1) {
          createSessionProjectionCheckpoint(session, events);
        }
        const foldUs = microsecondsPerCall(repeats, () => {
          createSessionProjectionCheckpoint(session, events);
        });
        const freezeUs = priceCandidate(repeats, fold, freezeInPlace);
        const copyUs = priceCandidate(repeats, fold, frozenCopy);
        const cloneUs = priceCandidate(repeats, fold, structuredClone);

        rows.push(
          [
            `  ${shape.name.padEnd(8)}`,
            `events ${String(eventCount).padStart(4)}`,
            `nodes ${String(nodes).padStart(5)}`,
            `json ${jsonKb.toFixed(1).padStart(6)} KB`,
            `(held ${shape.documentedKb} KB)`,
            `| in-memory fold ${foldUs.toFixed(1).padStart(6)} us`,
            `freeze-in-place ${freezeUs.toFixed(1).padStart(6)} us`,
            `copy+freeze ${copyUs.toFixed(1).padStart(6)} us`,
            `copy-on-read ${cloneUs.toFixed(1).padStart(6)} us`,
          ].join("  "),
        );

        // The fixture really is the documented shape, so the prices above are
        // about the rows the cache actually holds.
        expect(eventCount).toBeGreaterThanOrEqual(shape.approximateEvents - 6);
        expect(eventCount).toBeLessThanOrEqual(shape.approximateEvents + 6);

        // The claim the choice rests on, asserted rather than timed: the copy
        // owns every object it froze, so freezing it cannot reach anything the
        // ledger or a checkpoint still holds.
        const folded = fold();
        const owned = frozenCopy(folded) as SessionProjection;
        expect(owned).toEqual(folded);
        expect(owned.commands[0]).not.toBe(folded.commands[0]);
        expect(Object.isFrozen(owned.commands[0])).toBe(true);
        expect(Object.isFrozen(folded.commands[0])).toBe(false);
        // Whereas freezing in place reaches the very objects the fold read out
        // of the event payloads — which is the fault, stated as a test.
        const sharedEvents = structuredClone(events);
        const shared = createSessionProjectionCheckpoint(session, sharedEvents).projection;
        const payload = sharedEvents.find(
          (event) => event.payload.kind === "command.recorded",
        )?.payload;
        const ledgerOwned = payload?.kind === "command.recorded" ? payload.command : undefined;
        expect(shared.commands).toContain(ledgerOwned);
        expect(Object.isFrozen(ledgerOwned)).toBe(false);
        freezeInPlace(shared);
        expect(Object.isFrozen(ledgerOwned)).toBe(true);
      }

      console.log(
        [
          "",
          "[listing fold cache] cost of protecting one shared row, per row",
          ...rows,
          "  the fold above is the in-memory one only: a real listing also reads",
          "  and decodes a checkpoint row, so it is the larger number this is",
          "  spent against. copy+freeze is paid once per FOLD; copy-on-read is",
          "  paid once per row per LISTING, including every warm one.",
          "",
        ].join("\n"),
      );
    },
  );

  /**
   * Why the copy is paid per FOLD and not per listing, which is the whole
   * reason it is affordable. Counted rather than timed: a cache hit does no
   * protection work at all, so the cost does not scale with how often a
   * roster is listed — and copy-on-read's would.
   */
  it("pays for protection once per fold, not once per listing", async () => {
    const ledger = createInMemorySessionLedger();
    let now = 100;
    const engine = createSessionEngine({ ledger, clock: { now: () => now++ }, ids: ids() });
    await engine.createSession({
      commandId: "command-create",
      projectId: "project-1",
      ticketId: "ticket-1",
      role: "ticket",
      parentSessionId: null,
      title: "Durable Session",
      provenance,
    });
    const query = { projectId: "project-1", scope: "all" } as const;

    const first = await engine.listSessions(query);
    const second = await engine.listSessions(query);
    const third = await engine.listSessions(query);

    // One protected object, handed out three times. Copy-on-read would have
    // built three graphs here, and would build one more on every later
    // listing for as long as the Session sat still.
    expect(second[0]).toBe(first[0]);
    expect(third[0]).toBe(first[0]);
    expect(Object.isFrozen(first[0])).toBe(true);
  });
});
