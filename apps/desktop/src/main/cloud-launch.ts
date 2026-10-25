/**
 * Which product store this launch of the app uses (VC-889), decided once by
 * main before the window opens and fixed for the life of the process.
 *
 * - **`local`**: this Mac's own database, exactly as the app has always been.
 *   Every flag-off launch, and every launch with no signed-in marker or no
 *   configured backend.
 * - **`cloud`**: the signed-in person's Workspaces on Volli Cloud. The window
 *   reads its board from the backend with its own client; this Mac's local
 *   projects are not shown until the person signs out.
 *
 * **The marker.** One non-secret `app_state` row, {@link CLOUD_LAUNCH_APP_STATE_KEY}
 * = `{userId}`: written when a sign-in completes (the backend answered for the
 * person), removed when the sign-in ends. It is the store decision and nothing
 * else: never a token. A flag-off boot never reads it.
 *
 * **The relaunch.** Nothing hot-swaps a live window: signing in or out
 * restarts the app, through the normal quit path, so every quit gate asks
 * first (busy terminals, unsaved drafts). A gate that cancels leaves the
 * launch as it is ({@link createRelaunchController}).
 */
import { LOCAL_LAUNCH, type CloudLaunch } from "@volli/shared";

/** The `app_state` key the marker lives under (registered in `@volli/shared`'s app-state keys). */
export const CLOUD_LAUNCH_APP_STATE_KEY = "volli:cloud-launch";

/** What the marker says: who signed in. */
export interface LaunchMarker {
  readonly userId: string;
}

/** The marker's stored form. */
export function encodeLaunchMarker(userId: string): string {
  return JSON.stringify({ userId });
}

/** The marker in a stored value; anything that is not one reads as no marker (a local launch). */
export function decodeLaunchMarker(raw: string | undefined): LaunchMarker | null {
  if (raw === undefined) return null;
  try {
    const userId = (JSON.parse(raw) as { userId?: unknown } | null)?.userId;
    return typeof userId === "string" && userId.length > 0 ? { userId } : null;
  } catch {
    return null;
  }
}

/**
 * The launch's store: `cloud` only with the flag on, a marker present, and a
 * backend and a sign-in configured (with no sign-in there would be no way to
 * sign out of it); `local` otherwise. The marker is read only then, so a
 * flag-off boot touches nothing of Volli Cloud's.
 */
export function chooseProductStore(input: {
  readonly cloudFlag: boolean;
  readonly readMarker: () => LaunchMarker | null;
  readonly backendUrl: string | null;
  readonly signInConfigured: boolean;
}): CloudLaunch {
  if (!input.cloudFlag || input.backendUrl === null || !input.signInConfigured) {
    return LOCAL_LAUNCH;
  }
  const marker = input.readMarker();
  if (marker === null) return LOCAL_LAUNCH;
  return { store: "cloud", userId: marker.userId, backendUrl: input.backendUrl };
}

/** The one `app_state` row the marker is, as main reaches it. */
export interface LaunchMarkerRow {
  read(): string | undefined;
  write(value: string): void;
  remove(): void;
}

export interface LaunchMarkerStore {
  read(): LaunchMarker | null;
  /** A sign-in completed for `userId`: the next launch is a cloud one. */
  write(userId: string): void;
  /** The sign-in ended: the next launch is a local one. */
  clear(): void;
}

/**
 * The marker over its row. A row that cannot be read or written (a degraded
 * database) is logged and reads as no marker: the app then launches local,
 * which always works.
 */
export function launchMarkerStore(
  row: () => LaunchMarkerRow | null,
  log: { warn(message: string, fields?: Record<string, unknown>): void },
): LaunchMarkerStore {
  const attempt = <T>(what: string, run: (live: LaunchMarkerRow) => T, fallback: T): T => {
    const live = row();
    if (live === null) return fallback;
    try {
      return run(live);
    } catch (error) {
      log.warn(`could not ${what} the Volli Cloud launch marker`, { error });
      return fallback;
    }
  };
  return {
    read: () => attempt("read", (live) => decodeLaunchMarker(live.read()), null),
    write(userId) {
      attempt(
        "write",
        (live) => {
          const value = encodeLaunchMarker(userId);
          if (live.read() !== value) live.write(value);
        },
        undefined,
      );
    },
    clear() {
      attempt(
        "clear",
        (live) => {
          if (live.read() !== undefined) live.remove();
        },
        undefined,
      );
    },
  };
}

/** `app`, as the relaunch reaches it. */
export interface RelaunchLifecycle {
  /** Asks to quit through the normal path: every `before-quit` gate asks first. */
  quit(): void;
  /** Starts a new process once this one exits. */
  relaunch(): void;
}

export interface RelaunchController {
  /** Restart the app into the store the account now chooses. A second request while one waits is the same request. */
  request(): void;
  /** Whether a restart is waiting on the quit gates now. */
  pending(): boolean;
  /** The quit was accepted: the next process starts. */
  quitAccepted(): void;
  /** A gate cancelled the quit: the launch stays exactly as it is. */
  quitRefused(): void;
}

/**
 * The restart: an ordinary quit, which the gates may cancel, followed by a
 * new process only once the quit is accepted. Never `app.relaunch()` up front:
 * Electron would keep that request and honour it on whatever quit came next,
 * long after the person cancelled this one.
 */
export function createRelaunchController(
  app: RelaunchLifecycle,
  live?: {
    turns(): number;
    subscribe(listener: () => void): () => void;
    choose(turns: number): "wait" | "now" | "cancel";
    setInterval?(run: () => void): unknown;
    clearInterval?(handle: unknown): void;
  },
): RelaunchController {
  let requested = false;
  let waiting = false;
  let unsubscribe: (() => void) | null = null;
  let poll: unknown = null;
  const clear = () => {
    waiting = false;
    unsubscribe?.();
    unsubscribe = null;
    if (poll !== null) {
      if (live?.clearInterval !== undefined) live.clearInterval(poll);
      else clearInterval(poll as ReturnType<typeof setInterval>);
      poll = null;
    }
  };
  const quit = () => {
    clear();
    requested = true;
    app.quit();
  };
  return {
    request() {
      if (requested || waiting) return;
      const turns = live?.turns() ?? 0;
      if (turns > 0 && live !== undefined) {
        const answer = live.choose(turns);
        if (answer === "cancel") return;
        if (answer === "wait") {
          waiting = true;
          const check = () => {
            if (waiting && live.turns() === 0) quit();
          };
          const off = live.subscribe(check);
          // A primed subscription may already have observed zero.
          if (!waiting) {
            off();
            return;
          }
          unsubscribe = off;
          // Live bindings can close without a fold; keep the same fallback
          // as menu-bar mode's live-work feed. No work is started by this clock.
          poll =
            live.setInterval === undefined ? setInterval(check, 1_000) : live.setInterval(check);
          check();
          return;
        }
      }
      quit();
    },
    pending: () => requested,
    quitAccepted() {
      if (!requested) return;
      requested = false;
      app.relaunch();
    },
    quitRefused() {
      clear();
      requested = false;
    },
  };
}
