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
 * else: never a token. A flag-off boot never reads it. A sign-in that joined a
 * Workspace with a team code adds `joinedWorkspaceId`, which the next cloud
 * launch opens once and then drops from the marker.
 *
 * **The relaunch.** Nothing hot-swaps a live window: signing in or out
 * restarts the app, through the normal quit path, so every quit gate asks
 * first (busy terminals, unsaved drafts). A gate that cancels leaves the
 * launch as it is ({@link createRelaunchController}).
 */
import { LOCAL_LAUNCH, type CloudLaunch } from "@volli/shared";

/** The `app_state` key the marker lives under (registered in `@volli/shared`'s app-state keys). */
export const CLOUD_LAUNCH_APP_STATE_KEY = "volli:cloud-launch";

/** What the marker says: who signed in, and the Workspace they just joined, if any. */
export interface LaunchMarker {
  readonly userId: string;
  readonly joinedWorkspaceId?: string;
}

/** The marker's stored form. */
export function encodeLaunchMarker(userId: string, joinedWorkspaceId?: string): string {
  return JSON.stringify(
    joinedWorkspaceId === undefined ? { userId } : { userId, joinedWorkspaceId },
  );
}

/** The marker in a stored value; anything that is not one reads as no marker (a local launch). */
export function decodeLaunchMarker(raw: string | undefined): LaunchMarker | null {
  if (raw === undefined) return null;
  try {
    const value = JSON.parse(raw) as { userId?: unknown; joinedWorkspaceId?: unknown } | null;
    const userId = value?.userId;
    if (typeof userId !== "string" || userId.length === 0) return null;
    const joined = value?.joinedWorkspaceId;
    // An unreadable joined Workspace is dropped, never the sign-in.
    return typeof joined === "string" && joined.length > 0
      ? { userId, joinedWorkspaceId: joined }
      : { userId };
  } catch {
    return null;
  }
}

/**
 * The launch's store: hosted Convex requires the cloud flag, a marker and
 * configured sign-in. A future supervised embedded deployment needs neither.
 * Otherwise SQLite. Flag-off preview launches read no hosted account marker.
 */
export function chooseProductStore(input: {
  readonly cloudFlag: boolean;
  readonly readMarker: () => LaunchMarker | null;
  readonly backendUrl: string | null;
  readonly siteUrl?: string | null;
  readonly signInConfigured: boolean;
  /** Future embedded-backend supervisor's ready descriptor, never a runtime environment override.
   * VC-938 must supply the local identity, token source and exact runtime CSP before using this.
   * The Convex store is independent of the cloud feature flag; this preview never supplies it.
   */
  readonly localDeployment?: {
    readonly userId: string;
    readonly backendUrl: string;
    readonly siteUrl: string;
  };
}): CloudLaunch {
  if (input.localDeployment !== undefined) {
    return { store: "cloud", deployment: "local", ...input.localDeployment };
  }
  if (!input.cloudFlag || input.backendUrl === null || !input.signInConfigured) {
    return LOCAL_LAUNCH;
  }
  const marker = input.readMarker();
  if (marker === null) return LOCAL_LAUNCH;
  return {
    store: "cloud",
    deployment: "cloud",
    userId: marker.userId,
    backendUrl: input.backendUrl,
    siteUrl: input.siteUrl ?? null,
    ...(marker.joinedWorkspaceId === undefined
      ? {}
      : { joinedWorkspaceId: marker.joinedWorkspaceId }),
  };
}

/** The one `app_state` row the marker is, as main reaches it. */
export interface LaunchMarkerRow {
  read(): string | undefined;
  write(value: string): void;
  remove(): void;
}

export interface LaunchMarkerStore {
  read(): LaunchMarker | null;
  /**
   * A sign-in completed for `userId`: the next launch is a cloud one.
   * `joinedWorkspaceId`: a string records the Workspace a team code joined;
   * `null` drops it (the launch opened it); absent keeps the one recorded for
   * the same person, so a later account check never loses it first.
   */
  write(userId: string, joinedWorkspaceId?: string | null): void;
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
    write(userId, joinedWorkspaceId) {
      attempt(
        "write",
        (live) => {
          const before = decodeLaunchMarker(live.read());
          const joined =
            joinedWorkspaceId === undefined
              ? before?.userId === userId
                ? before.joinedWorkspaceId
                : undefined
              : (joinedWorkspaceId ?? undefined);
          const value = encodeLaunchMarker(userId, joined);
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
