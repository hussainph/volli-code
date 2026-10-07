/**
 * Flush-and-ack before a window is destroyed without an unload (VC-577).
 *
 * Menu-bar mode closes every window with `BrowserWindow.destroy()`, because
 * the quit's own unsaved-drafts and busy-terminal confirms have already
 * answered and a window `close` would ask them again. `destroy()` fires
 * neither `beforeunload` nor `unload`, and the renderer's client-local store
 * (`app-state-storage.ts`) debounces its writes by 200 ms and flushes them on
 * `beforeunload` — so a composer draft typed just before ⌘Q would exist only
 * in a renderer that is about to go.
 *
 * So main asks first: it pushes `volli:client-state-flush` with a request id
 * to every window, and each renderer sends its pending writes, waits for its
 * in-order write chain (the LATEST value, even behind an older write's slow
 * ack), and answers `volli:client-state-flushed`. Each target hears its own
 * ack through {@link FlushTarget.onAcked} — at once, and even after the
 * caller's bound has run out — so the two callers can choose differently:
 *
 * - **Menu-bar entry** is not power-off. It destroys a window only from its
 *   ack. Past {@link MENU_BAR_FLUSH_OVERDUE_MS} it logs and keeps the window
 *   hidden; a window is never destroyed unflushed.
 * - **System shutdown** must not stall power-off. Its accepted quit joins the
 *   flush and waits at most {@link SHUTDOWN_FLUSH_TIMEOUT_MS} before exiting.
 *
 * No Electron import: the windows are a port, so the whole barrier is tested
 * under plain Node.
 */
import { hostLogger } from "@volli/host-core/log";

/** Menu-bar entry: past this with no ack, log and keep the window hidden (never destroyed). */
export const MENU_BAR_FLUSH_OVERDUE_MS = 10_000;

/** System shutdown: the longest the accepted quit waits for renderers before exiting. */
export const SHUTDOWN_FLUSH_TIMEOUT_MS = 2_000;

/** The one thing main needs of a window's renderer here. */
export interface FlushTarget {
  isDestroyed(): boolean;
  /** `webContents.send("volli:client-state-flush", requestId)`. */
  requestFlush(requestId: string): void;
  /** This renderer acked: every pending write reached main. Called once, even after the bound. */
  onAcked?(): void;
}

export interface ClientStateFlushPorts {
  newRequestId(): string;
  timers?: {
    setTimeout(run: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  };
  log?: (line: string) => void;
}

export interface FlushOutcome {
  readonly acked: number;
  /** Renderers that had not answered when the bound ran out. */
  readonly unanswered: number;
}

export interface ClientStateFlush {
  /**
   * Ask every live target to flush; resolves when all acked or `timeoutMs`
   * ran out, whichever is first. Never rejects. A target's late ack still
   * reaches its {@link FlushTarget.onAcked}.
   */
  flush(targets: readonly FlushTarget[], timeoutMs: number): Promise<FlushOutcome>;
  /** One renderer's `volli:client-state-flushed`. Unknown or repeated ids are ignored. */
  acknowledge(requestId: unknown): void;
}

const realTimers = {
  setTimeout: (run: () => void, ms: number): unknown => setTimeout(run, ms),
  clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createClientStateFlush(ports: ClientStateFlushPorts): ClientStateFlush {
  const timers = ports.timers ?? realTimers;
  const log = ports.log ?? ((line: string) => hostLogger("client-state").warn(line));
  /** Request id → what its ack settles. Kept past the bound, so a late ack still lands. */
  const waiting = new Map<string, () => void>();

  return {
    flush(targets, timeoutMs) {
      const live = targets.filter((target) => !target.isDestroyed());
      if (live.length === 0) return Promise.resolve({ acked: 0, unanswered: 0 });
      return new Promise<FlushOutcome>((resolve) => {
        let acked = 0;
        let outstanding = live.length;
        let settled = false;
        let timer: unknown = null;
        // Called once: by the last answer (which clears the bound) or by the
        // bound (after which answers only reach their targets).
        const finish = (): void => {
          settled = true;
          if (timer !== null) timers.clearTimeout(timer);
          const unanswered = live.length - acked;
          if (unanswered > 0) {
            log(
              `[client-state] ${unanswered} window(s) had not confirmed their drafts were saved after ${timeoutMs}ms`,
            );
          }
          resolve({ acked, unanswered });
        };
        const answered = (ok: boolean): void => {
          if (settled) return;
          if (ok) acked += 1;
          outstanding -= 1;
          if (outstanding === 0) finish();
        };
        for (const target of live) {
          const requestId = ports.newRequestId();
          waiting.set(requestId, () => {
            target.onAcked?.();
            answered(true);
          });
          try {
            target.requestFlush(requestId);
          } catch (error) {
            // A renderer gone between the check and the send has nothing to flush.
            log(`[client-state] could not ask a window to flush: ${String(error)}`);
            waiting.delete(requestId);
            answered(false);
          }
        }
        if (!settled) timer = timers.setTimeout(finish, timeoutMs);
      });
    },
    acknowledge(requestId) {
      if (typeof requestId !== "string") return;
      const settle = waiting.get(requestId);
      if (settle === undefined) return;
      waiting.delete(requestId);
      settle();
    },
  };
}
