/**
 * When Sessions were started — the Streak visual's whole input (VC-55).
 *
 * Stamps rather than rows, and every project's rather than the selected one's:
 * the chart is a field of many, which is what a Project Session's scope IS, and
 * one project's Sessions would be a different (and much smaller) claim. The
 * window arithmetic lives in `@volli/shared`'s `session-streak.ts`; this store
 * holds only the fetch.
 *
 * READ ON EVERY MOUNT, not once per app run, because of WHEN this is drawn:
 * the empty chat is what you are looking at immediately after starting a
 * Session, so a cached answer would draw a streak that is missing the very
 * Session you just started. The read is one indexed scan of one integer column
 * — cheaper than the machinery that would keep a cache honest.
 *
 * The cache still earns its place between those reads: what it holds stays on
 * screen while the next read is in flight, so switching tabs and coming back
 * redraws the same grid rather than blinking through an empty one. Concurrent
 * reads are folded into one for the same reason a baseline fetch is elsewhere —
 * two surfaces mounting on one frame is the shape the collision takes.
 *
 * The error is kept rather than toasted (see `stores/venue.ts`): a chart that
 * cannot be drawn is a chart that does not appear, and a toast over a chat
 * someone is about to type in is the loudest thing on screen for the least
 * useful reason.
 */
import { create } from "zustand";
import { errorMessage } from "@volli/shared";

interface SessionStartsState {
  /** Ascending creation stamps, or `undefined` before the first read lands. */
  startedAt: readonly number[] | undefined;
  /** The last read's failure, or `null` once one succeeds. */
  error: string | null;
  /** Reads the window from `sinceMs`; concurrent calls share one read. */
  refresh(sinceMs: number): Promise<void>;
}

/** Factory so tests get isolated instances (the store module's own convention). */
export function createSessionStartsStore() {
  let inFlight: Promise<void> | null = null;

  return create<SessionStartsState>()((set) => ({
    startedAt: undefined,
    error: null,

    refresh(sinceMs) {
      if (inFlight !== null) return inFlight;
      const pending = read(sinceMs)
        .then((next) => {
          set(next);
        })
        .finally(() => {
          inFlight = null;
        });
      inFlight = pending;
      return pending;
    },
  }));
}

/** One read, with both failure shapes folded onto the same state patch. */
async function read(
  sinceMs: number,
): Promise<Pick<SessionStartsState, "startedAt" | "error"> | { error: string }> {
  try {
    const result = await window.api.sessions.starts(sinceMs);
    // A failed read leaves the previous stamps in place: the grid on screen is
    // still the truest thing anyone has.
    return result.ok ? { startedAt: result.startedAt, error: null } : { error: result.error };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

export const useSessionStartsStore = createSessionStartsStore();
