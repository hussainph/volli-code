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
 */
import { create } from "zustand";
import { errorMessage, type VenueSnapshot } from "@volli/shared";

/** What is known about one venue right now. */
export type VenueEntry =
  | { status: "loading" }
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
  /** {@link refresh}, unless this scope has already been read. */
  ensure(projectId: string, ticketId: string | null): Promise<void>;
}

/** Factory so tests get isolated instances (the store module's own convention). */
export function createVenueStore() {
  /**
   * Reads in flight, per scope. Module-scope-per-store rather than store state:
   * nothing renders from it, and putting it in state would re-render every
   * consumer twice per read for a fact none of them show.
   */
  const inFlight = new Map<string, Promise<void>>();

  return create<VenueState>()((set, get) => ({
    byScope: {},

    refresh(projectId, ticketId) {
      const key = venueKey(projectId, ticketId);
      const existing = inFlight.get(key);
      if (existing !== undefined) return existing;
      // Only the FIRST read announces itself as loading; a later one keeps the
      // reading already on screen until it is replaced, so a drawing never
      // blinks out to make room for the same drawing.
      if (get().byScope[key] === undefined) {
        set((state) => ({ byScope: { ...state.byScope, [key]: { status: "loading" } } }));
      }
      const pending = read(projectId, ticketId)
        .then((entry) => {
          set((state) => ({ byScope: { ...state.byScope, [key]: entry } }));
        })
        .finally(() => inFlight.delete(key));
      inFlight.set(key, pending);
      return pending;
    },

    ensure(projectId, ticketId) {
      if (get().byScope[venueKey(projectId, ticketId)] !== undefined) return Promise.resolve();
      return get().refresh(projectId, ticketId);
    },
  }));
}

/** One read, with both failure shapes folded onto the same entry. */
async function read(projectId: string, ticketId: string | null): Promise<VenueEntry> {
  try {
    const result = await window.api.venue.snapshot(projectId, ticketId);
    return result.ok
      ? { status: "ready", venue: result.venue }
      : { status: "error", error: result.error };
  } catch (error) {
    return { status: "error", error: errorMessage(error) };
  }
}

export const useVenueStore = createVenueStore();
