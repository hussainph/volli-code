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
 * to every window, each renderer sends its pending writes and answers
 * `volli:client-state-flushed` once main has acknowledged them, and main
 * destroys the windows when every answer is in — or when the bound runs out,
 * because a wedged renderer must not keep a quit waiting forever. A window
 * that never answers is logged, and destroyed anyway.
 *
 * No Electron import: the windows are a port, so the whole barrier is tested
 * under plain Node.
 */

/** How long main waits for every renderer's ack before destroying regardless. */
export const CLIENT_STATE_FLUSH_TIMEOUT_MS = 1_000;

/** The one thing main needs of a window's renderer here. */
export interface FlushTarget {
  isDestroyed(): boolean;
  /** `webContents.send("volli:client-state-flush", requestId)`. */
  requestFlush(requestId: string): void;
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
  /** Renderers that did not answer inside the bound. */
  readonly unanswered: number;
}

export interface ClientStateFlush {
  /** Ask every live target to flush; resolves when all acked or the bound ran out. Never rejects. */
  flush(targets: readonly FlushTarget[], timeoutMs?: number): Promise<FlushOutcome>;
  /** One renderer's `volli:client-state-flushed`. Unknown or late ids are ignored. */
  acknowledge(requestId: unknown): void;
}

const realTimers = {
  setTimeout: (run: () => void, ms: number): unknown => setTimeout(run, ms),
  clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createClientStateFlush(ports: ClientStateFlushPorts): ClientStateFlush {
  const timers = ports.timers ?? realTimers;
  const log = ports.log ?? ((line: string) => console.warn(line));
  /** Request id → the ack it settles. */
  const waiting = new Map<string, () => void>();

  return {
    flush(targets, timeoutMs = CLIENT_STATE_FLUSH_TIMEOUT_MS) {
      const live = targets.filter((target) => !target.isDestroyed());
      if (live.length === 0) return Promise.resolve({ acked: 0, unanswered: 0 });
      return new Promise<FlushOutcome>((resolve) => {
        const ids: string[] = [];
        let acked = 0;
        let outstanding = live.length;
        let settled = false;
        let timer: unknown = null;
        // Called once: by the last answer (which clears the bound) or by the
        // bound (after which no answer is waited on any more).
        const finish = (): void => {
          settled = true;
          if (timer !== null) timers.clearTimeout(timer);
          for (const requestId of ids) waiting.delete(requestId);
          const unanswered = live.length - acked;
          if (unanswered > 0) {
            log(
              `[menu-bar] ${unanswered} window(s) did not confirm their drafts were saved; closing anyway`,
            );
          }
          resolve({ acked, unanswered });
        };
        const answered = (ok: boolean): void => {
          if (ok) acked += 1;
          outstanding -= 1;
          if (outstanding === 0) finish();
        };
        for (const target of live) {
          const requestId = ports.newRequestId();
          ids.push(requestId);
          waiting.set(requestId, () => answered(true));
          try {
            target.requestFlush(requestId);
          } catch (error) {
            // A renderer gone between the check and the send has nothing to flush.
            log(`[menu-bar] could not ask a window to flush: ${String(error)}`);
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
