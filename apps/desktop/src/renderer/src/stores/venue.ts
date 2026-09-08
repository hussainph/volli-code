/**
 * One shared cache of venue readings — where a Session runs, measured (VC-55).
 *
 * TWO SURFACES ask the same question about the same Session and neither owns
 * the other: the empty chat draws the venue, and Home's rail names it in the
 * Now page's venue card. A second copy of this fetch would mean two git reads
 * of the same tree on the same frame and two answers that can disagree —
 * `stores/project-sessions.ts` is the same argument already settled once, for a
 * project's Session rows.
 *
 * PULLED, NOT PUSHED, and deliberately so. A Change Set has a filesystem watch
 * behind it because a ticket's Changes rail is a live surface someone reads
 * while an agent writes; the venue is drawn on an EMPTY chat and in a rail
 * beside it, which is to say at rest. {@link VenueState.refresh} is there for
 * the moments a caller knows the tree moved (a Session started, a turn ended);
 * everything else reads the last answer, which is what it was already looking
 * at.
 *
 * The error is kept rather than toasted. A venue that cannot be read is a
 * drawing that does not appear — the surface is a chat, and a toast about git
 * over a chat someone is about to type in would be the loudest thing on screen
 * for the least useful reason. The rail names the failure where there is room
 * for it.
 *
 * A READING BELONGS TO A CHECKOUT, not to a scope (VC-286). A ticket keeps its
 * scope across materializing, removing and recreating its worktree, but each of
 * those is a different tree — or none — and the answer taken in the last one is
 * not a slower version of the next one. {@link VenueState.invalidateTickets}
 * is that boundary: it advances a per-scope REVISION, which both drops the
 * reading on screen and disowns any read still in flight, so a snapshot taken
 * before the worktree existed can never land after it does. When a venue grows
 * an execution-host identity (`SessionLocation.venue`), a host change is
 * another move of the same revision and joins here rather than beside it.
 */
import { create } from "zustand";
import { errorMessage, type VenueSnapshot } from "@volli/shared";

/**
 * What is known about one venue right now.
 *
 * `loading` and `resolving` are different silences. `loading` is "a read is on
 * its way"; `resolving` is main's own answer that this ticket has no checkout
 * yet — its isolated worktree is being created, was removed, or failed to be
 * created. Both draw the waiting shape, and neither may be drawn as the main
 * checkout: a worktree-scoped Session binds its worktree or it does not start
 * (`session-runtime/location.ts`).
 */
export type VenueEntry =
  | { status: "loading" }
  | { status: "resolving" }
  | { status: "ready"; venue: VenueSnapshot }
  | { status: "error"; error: string };

/**
 * Cache key for a Session's scope.
 *
 * Keyed by SCOPE rather than by Session id: every Session of the same scope
 * stands in the same tree, so two chats on one ticket must never disagree about
 * what is in it — and a new Session in that scope inherits the reading rather
 * than issuing a fresh one.
 */
export function venueKey(projectId: string, ticketId: string | null): string {
  return `${projectId}:${ticketId ?? ""}`;
}

interface VenueState {
  byScope: Readonly<Record<string, VenueEntry>>;
  /**
   * Reads the venue again and replaces its entry. Concurrent reads of one
   * scope share a single read — two surfaces mounting on the same frame is the
   * shape that collision takes, and the tree cannot have moved between them.
   */
  refresh(projectId: string, ticketId: string | null): Promise<void>;
  /** {@link refresh}, unless this scope holds an answer already. */
  ensure(projectId: string, ticketId: string | null): Promise<void>;
  /**
   * Discards the reading for every scope of `ticketId` — or of EVERY ticket
   * when a change names none, which is what an untargeted broadcast means — and
   * disowns whatever was in flight for them. Synchronous on purpose: the stale
   * venue must leave the screen at the moment the checkout changed, not when
   * its replacement arrives.
   *
   * A project's own scope is never touched. Home's card is about the main
   * checkout, and no worktree of any ticket changes what is in that tree.
   */
  invalidateTickets(ticketId?: string): void;
  /**
   * Reads every scope that is waiting on nothing — discarded by
   * {@link invalidateTickets} and not yet re-read. Called once the ticket data
   * behind the change is current, so the new reading is of the checkout the
   * board now names.
   */
  refreshStale(): Promise<void>;
}

/** The scope one cache key names — what a re-read needs to ask main again. */
interface VenueScope {
  projectId: string;
  ticketId: string | null;
}

/** Factory so tests get isolated instances (the store module's own convention). */
export function createVenueStore() {
  /**
   * Reads in flight, per scope, each tagged with the revision it was started
   * under. Module-scope-per-store rather than store state: nothing renders from
   * it, and putting it in state would re-render every consumer twice per read
   * for a fact none of them show.
   */
  const inFlight = new Map<string, { revision: number; promise: Promise<void> }>();
  /** Every scope this store has read, so a discarded one can be read again. */
  const scopes = new Map<string, VenueScope>();
  /**
   * How many times each scope's checkout has changed identity. A reading is
   * adopted only at the revision it was taken under; anything older answers a
   * question about a tree that is no longer this scope's.
   */
  const revisions = new Map<string, number>();
  const revisionOf = (key: string): number => revisions.get(key) ?? 0;

  return create<VenueState>()((set, get) => ({
    byScope: {},

    refresh(projectId, ticketId) {
      const key = venueKey(projectId, ticketId);
      scopes.set(key, { projectId, ticketId });
      const existing = inFlight.get(key);
      if (existing !== undefined) return existing.promise;
      // Only the FIRST read announces itself as loading; a later one keeps the
      // reading already on screen until it is replaced, so a drawing never
      // blinks out to make room for the same drawing. A discarded scope is
      // already `loading` and stays there — there is nothing to keep.
      if (get().byScope[key] === undefined) {
        set((state) => ({ byScope: { ...state.byScope, [key]: { status: "loading" } } }));
      }
      const revision = revisionOf(key);
      const promise = read(projectId, ticketId)
        .then((entry) => {
          // The checkout moved under this read: its answer describes a tree this
          // scope has left, and putting it back on screen is the stale caption
          // VC-286 is about.
          if (revisionOf(key) !== revision) return;
          set((state) => ({ byScope: { ...state.byScope, [key]: entry } }));
        })
        .finally(() => {
          if (inFlight.get(key)?.revision === revision) inFlight.delete(key);
        });
      inFlight.set(key, { revision, promise });
      return promise;
    },

    ensure(projectId, ticketId) {
      const key = venueKey(projectId, ticketId);
      const entry = get().byScope[key];
      // `undefined` was never read and a discarded scope is waiting on nothing;
      // every other entry — including an error and a `resolving` — is an answer.
      if (entry !== undefined && !awaitingNothing(key, entry)) return Promise.resolve();
      return get().refresh(projectId, ticketId);
    },

    invalidateTickets(ticketId) {
      const discarded = [...scopes]
        .filter(([key, scope]) => {
          if (scope.ticketId === null) return false;
          if (ticketId !== undefined && scope.ticketId !== ticketId) return false;
          return get().byScope[key] !== undefined;
        })
        .map(([key]) => key);
      if (discarded.length === 0) return;
      for (const key of discarded) {
        revisions.set(key, revisionOf(key) + 1);
        // Disowned, not cancelled — a read already sent cannot be recalled. What
        // this ends is its claim on the scope: the next caller starts a read of
        // its own instead of being handed this one's answer, and the old read's
        // own cleanup can no longer delete the newer entry (it compares
        // revisions).
        inFlight.delete(key);
      }
      set((state) => ({
        byScope: {
          ...state.byScope,
          ...Object.fromEntries(discarded.map((key) => [key, { status: "loading" } as const])),
        },
      }));
    },

    async refreshStale() {
      const stale = [...scopes].filter(([key]) => {
        const entry = get().byScope[key];
        return entry !== undefined && awaitingNothing(key, entry);
      });
      await Promise.all(stale.map(([, scope]) => get().refresh(scope.projectId, scope.ticketId)));
    },
  }));

  /** A scope left `loading` with no read behind it — i.e. one that was discarded. */
  function awaitingNothing(key: string, entry: VenueEntry): boolean {
    return entry.status === "loading" && !inFlight.has(key);
  }
}

/** One read, with both failure shapes folded onto the same entry. */
async function read(projectId: string, ticketId: string | null): Promise<VenueEntry> {
  try {
    const result = await window.api.venue.snapshot(projectId, ticketId);
    if (!result.ok) return { status: "error", error: result.error };
    return result.reading.state === "measured"
      ? { status: "ready", venue: result.reading.venue }
      : { status: "resolving" };
  } catch (error) {
    return { status: "error", error: errorMessage(error) };
  }
}

export const useVenueStore = createVenueStore();
