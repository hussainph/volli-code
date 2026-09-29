/**
 * The Doc tab's Activity feed cache: a ticket's events and comments, kept
 * across tab flips (VC-373).
 *
 * ── WHY IT EXISTS ─────────────────────────────────────────────────────────
 * The feed is rendered inside the Body tab (`ticket-body-panel.tsx`) and only
 * the ACTIVE tab renders (`ticket-detail.tsx`), so every Doc → file/chat → Doc
 * flip unmounted the feed and its local state went with it. The remount then
 * spent `tickets.events` + `comments.list` again to paint a list that had not
 * changed — two indexed reads per flip, on the one surface a person crosses
 * most while working a ticket.
 *
 * The data is cacheable because nothing moves it behind the renderer's back:
 * every mutation (this app's own composer, the CLI, an agent) either lands
 * through the feed's own refetch or arrives as a planning refresh
 * (`stores/board.ts` `lastPlanningChange`), the same signal the feed already
 * listened to. An entry therefore carries the planning VERSION it was read at,
 * and a mount paints from it only while that version still holds — a flip is
 * free, a change during the flip is not missed.
 *
 * ── WHY A VERSION AND NOT A LISTENER ──────────────────────────────────────
 * A change that arrives while the feed is UNMOUNTED cannot reach a component
 * effect, which is exactly the case a cache has to survive. Tagging entries
 * with the planning version lets a later mount answer "has anything happened
 * since I read this?" without holding a subscription of its own, and the
 * conservative direction of a version STOP is deliberate: a planning refresh
 * that provably targeted another ticket is folded in WITHOUT a refetch
 * (`noteVersion`, called from the mounted feed), while one whose scope cannot
 * be ruled out forces a single re-read the next time the feed is on screen.
 */
import { create } from "zustand";
import { errorMessage, type TicketComment, type TicketEvent } from "@volli/shared";

import { toastError } from "@renderer/lib/toast";

/** One ticket's last landed activity, and the planning version it was read at. */
export interface TicketActivity {
  events: readonly TicketEvent[];
  comments: readonly TicketComment[];
  /** `lastPlanningChange.version` when this entry was read. */
  version: number;
}

/** Whether one ticket's activity baseline is still on its way, usable, or unavailable. */
export type TicketActivityListingState = "loading" | "loaded" | "failed";

export interface TicketActivityState {
  /** ticketId → the feed's last landed read. */
  byTicket: Readonly<Record<string, TicketActivity>>;
  /** The baseline outcome per ticket; absent means no read has been requested. */
  listingState: Readonly<Record<string, TicketActivityListingState>>;
  /** The latest failed baseline's detail, cleared when a read starts or lands. */
  listingError: Readonly<Record<string, string | null>>;
  /**
   * Re-reads the events and comments that form the activity feed.
   *
   * `planningVersion` is the version this request reads under. A newer version,
   * or a successful comment write asking for `force`, supersedes an older read
   * rather than letting its late answer replace newer activity.
   */
  refresh(ticketId: string, planningVersion: number, force?: boolean): Promise<void>;
  /**
   * {@link refresh}, but only while this ticket lacks an activity entry current
   * for `planningVersion`. A failed read is intentionally not warm: a later
   * mount can try it again, while concurrent callers share the one read.
   */
  ensure(ticketId: string, planningVersion: number): Promise<void>;
  /**
   * Records what main answered with — the feed's own reads, and its optimistic
   * comment row while the authoritative re-read is in flight. Written whether
   * or not the ticket had an entry: this cache is filled by the feed itself,
   * not by a baseline fetch every consumer shares.
   */
  apply(ticketId: string, activity: TicketActivity): void;
  /**
   * Advances an existing entry to a NEWER planning version without re-reading
   * it, for a change that provably did not touch this ticket
   * (`planningChangeAffects`). Keeping the watermark current is what lets the
   * next remount tell "nothing I care about moved" from "something might
   * have". A ticket with no entry needs no watermark.
   */
  noteVersion(ticketId: string, version: number): void;
}

interface ActivityRead {
  planningVersion: number;
  revision: number;
  promise: Promise<void>;
}

/** One full baseline read, with both failure shapes folded onto one result. */
async function readActivity(
  ticketId: string,
): Promise<{ ok: true; activity: Omit<TicketActivity, "version"> } | { ok: false; error: string }> {
  try {
    const [events, comments] = await Promise.all([
      window.api.tickets.events({ ticketId }),
      window.api.comments.list({ ticketId }),
    ]);
    if (!events.ok) return { ok: false, error: events.error };
    if (!comments.ok) return { ok: false, error: comments.error };
    return { ok: true, activity: { events: events.events, comments: comments.comments } };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/** Factory so tests get isolated instances (the store module's own convention). */
export function createTicketActivityStore() {
  /**
   * Baseline reads in flight, per ticket. This is deliberately not Zustand
   * state: no drawing needs a second render merely because a request started,
   * and a Doc mount plus a planning refresh on the same frame must share it.
   */
  const inFlight = new Map<string, ActivityRead>();
  /**
   * A later planning version or forced post-comment read disowns an earlier
   * promise. IPC cannot retract that older request, but it must never be able
   * to land after the read that superseded it (VC-383).
   */
  const revisions = new Map<string, number>();
  const nextRevision = (ticketId: string): number => {
    const revision = (revisions.get(ticketId) ?? 0) + 1;
    revisions.set(ticketId, revision);
    return revision;
  };

  return create<TicketActivityState>()((set, get) => ({
    byTicket: {},
    listingState: {},
    listingError: {},

    refresh(ticketId, planningVersion, force = false) {
      const current = inFlight.get(ticketId);
      if (current !== undefined && !force && current.planningVersion === planningVersion) {
        return current.promise;
      }
      const revision = nextRevision(ticketId);
      // VC-383 makes this a durable UI fact: no entry means never read,
      // `loading` owns the skeleton, `loaded` earns the empty sentence, and
      // `failed` is a concise failure line instead of a forever-pulsing row.
      // Keeping it here means a future client receives the same model rather
      // than reverse-engineering request state from a missing cache entry.
      set((state) => ({
        listingState: { ...state.listingState, [ticketId]: "loading" },
        listingError: { ...state.listingError, [ticketId]: null },
      }));
      const promise = readActivity(ticketId)
        .then((result) => {
          // A newer planning change or forced re-read has already claimed this
          // ticket. Its older answer describes a moment the feed has left.
          if (revisions.get(ticketId) !== revision) return;
          if (!result.ok) {
            toastError(`Couldn't load activity: ${result.error}`);
            set((state) => ({
              listingState: { ...state.listingState, [ticketId]: "failed" },
              listingError: { ...state.listingError, [ticketId]: result.error },
            }));
            return;
          }
          get().apply(ticketId, { ...result.activity, version: planningVersion });
        })
        .finally(() => {
          if (inFlight.get(ticketId)?.revision === revision) inFlight.delete(ticketId);
        });
      inFlight.set(ticketId, { planningVersion, revision, promise });
      return promise;
    },

    ensure(ticketId, planningVersion) {
      const entry = get().byTicket[ticketId];
      // A failed baseline is not an empty answer. Let the next surface retry,
      // but never create an automatic retry loop while the same one is mounted.
      if (
        get().listingState[ticketId] === "loaded" &&
        entry !== undefined &&
        entry.version === planningVersion
      ) {
        return Promise.resolve();
      }
      return get().refresh(ticketId, planningVersion);
    },

    apply(ticketId, activity) {
      set((state) => ({
        byTicket: { ...state.byTicket, [ticketId]: activity },
        listingState: { ...state.listingState, [ticketId]: "loaded" },
        listingError: { ...state.listingError, [ticketId]: null },
      }));
    },

    noteVersion(ticketId, version) {
      set((state) => {
        const entry = state.byTicket[ticketId];
        // No entry, or already current: nothing to advance. The no-op keeps
        // the entry's identity, so a subscriber does not re-render for a
        // version it already carried.
        if (entry === undefined || entry.version === version) return state;
        return {
          byTicket: {
            ...state.byTicket,
            [ticketId]: { events: entry.events, comments: entry.comments, version },
          },
        };
      });
    },
  }));
}

export const useTicketActivityStore = createTicketActivityStore();
