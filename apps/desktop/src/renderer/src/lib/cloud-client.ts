/**
 * The window's Volli Cloud client (VC-889): one Convex React client, made
 * once at boot and only in a cloud launch. It reads the board straight from
 * the backend, so main never proxies board data (ruling 4).
 *
 * **Its token.** The client asks main for a short-lived access token
 * (`account.accessToken`) whenever it connects or its token is about to
 * expire; the refresh token never leaves main. The answer decides what the
 * client does ({@link createTokenFetcher}):
 *
 * - a token: used;
 * - signed out: `null`, so the client clears its auth;
 * - unavailable (offline): **never `null`**, which would clear auth and turn
 *   every cached board query into an error. It waits instead, backing off as
 *   main asks and waking early when the OS comes back online or the account
 *   changes, and gives up only when the client closes. While it waits the
 *   client's socket is paused; the board it already holds stays on screen,
 *   read-only.
 *
 * **Its end.** One client per process: signing in or out relaunches the app,
 * so nothing from one account survives into the next by construction. A
 * sign-out the person chose closes the client before the restart
 * ({@link closeCloudClient}, from the sign-out confirm), and so does a
 * different person signing in: its cache and token go with it. Any other end
 * of the sign-in (it expired, or was never restored) clears its auth until
 * the same person signs in again.
 *
 * **What the link reads.** It feeds `stores/cloud-link.ts`'s inputs: the
 * connection, the auth, the account, the OS's online state, and a wake from
 * sleep.
 */
import type { AccountAccessToken, AccountSnapshot, CloudLaunch } from "@volli/shared";
import type { ConvexReactClient } from "convex/react";

import { sessionRpcClient } from "@renderer/lib/session-rpc-ipc-link";
import {
  readConnection,
  useCloudLinkInputs,
  wokeBetween,
  type CloudLinkInputState,
} from "@renderer/stores/cloud-link";

/** The backend's generated function references. */
export type CloudApi = typeof import("@volli/convex/api").api;

/** What the board reads of the client: Convex's React client, narrowed. */
export type CloudClient = Pick<
  ConvexReactClient,
  | "watchQuery"
  | "query"
  | "mutation"
  | "connectionState"
  | "subscribeToConnectionState"
  | "setAuth"
  | "clearAuth"
  | "close"
>;

/** A running client and the references it is called with. */
export interface CloudSession {
  readonly client: CloudClient;
  readonly api: CloudApi;
}

/** The clock the client glue waits on; injectable for tests. */
export interface CloudClock {
  now(): number;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(run: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const SYSTEM_CLOCK: CloudClock = {
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (run, ms) => setInterval(run, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/** A wait that ends early on {@link Waiter.wake}, or on close. */
export interface Waiter {
  wait(ms: number): Promise<void>;
  wake(): void;
}

export function createWaiter(clock: Pick<CloudClock, "setTimeout" | "clearTimeout">): Waiter {
  const waiting = new Set<() => void>();
  return {
    wait(ms) {
      return new Promise((resolve) => {
        const done = () => {
          clock.clearTimeout(handle);
          waiting.delete(done);
          resolve();
        };
        const handle = clock.setTimeout(done, ms);
        waiting.add(done);
      });
    },
    wake() {
      for (const done of Array.from(waiting)) done();
    },
  };
}

/**
 * The client's `fetchToken`: main's answer, with `unavailable` waited out
 * rather than reported as signed out (module comment). A call that fails in
 * transit is `unavailable` too. Once the client closes there is nothing to
 * keep: `null`, never a rejection nobody would catch.
 */
export function createTokenFetcher(deps: {
  ask(force: boolean): Promise<AccountAccessToken>;
  wait(ms: number): Promise<void>;
  closed(): boolean;
  retryMs: number;
}): (args: { forceRefreshToken: boolean }) => Promise<string | null> {
  return async ({ forceRefreshToken }) => {
    for (;;) {
      if (deps.closed()) return null;
      let answer: AccountAccessToken;
      try {
        answer = await deps.ask(forceRefreshToken);
      } catch {
        answer = { kind: "unavailable", retryAfterMs: deps.retryMs };
      }
      if (deps.closed()) return null;
      if (answer.kind === "token") return answer.token;
      if (answer.kind === "signed-out") return null;
      await deps.wait(Math.max(answer.retryAfterMs, 250));
    }
  };
}

/** The account doors the client uses, over the desktop bridge. */
export interface CloudAccountDoor {
  accessToken(force: boolean): Promise<AccountAccessToken>;
  subscribe(handlers: { onData(snapshot: AccountSnapshot): void; onError(error: unknown): void }): {
    unsubscribe(): void;
  };
}

/** Everything {@link startCloudClient} reaches outside itself. */
export interface CloudClientDeps {
  load(): Promise<{
    ConvexReactClient: new (
      address: string,
      options: { unsavedChangesWarning: boolean; verbose: boolean },
    ) => CloudClient;
    api: CloudApi;
  }>;
  account: CloudAccountDoor;
  window: {
    readonly navigator: { readonly onLine: boolean };
    addEventListener(type: "online" | "offline" | "pagehide", listener: () => void): void;
    removeEventListener(type: "online" | "offline" | "pagehide", listener: () => void): void;
  };
  inputs: Pick<CloudLinkInputState, "update">;
  clock: CloudClock;
  /** Tells main's quit gate how many board writes are still unanswered (§7.8). */
  reportUnsavedWrites(count: number): void;
}

function defaultDeps(): CloudClientDeps {
  return {
    load: () => import("./cloud-runtime"),
    account: {
      accessToken: (force) => sessionRpcClient().account.accessToken.query({ force }),
      subscribe: (handlers) => sessionRpcClient().account.subscribe.subscribe(undefined, handlers),
    },
    window,
    inputs: useCloudLinkInputs.getState(),
    clock: SYSTEM_CLOCK,
    reportUnsavedWrites: (count) => {
      // Background bookkeeping nobody waits on: a failed report is logged, and
      // the next change reports the whole count again.
      sessionRpcClient()
        .cloud.reportUnsavedWrites.mutate({ count })
        .catch((error: unknown) => {
          console.warn("[volli] couldn't report unsaved board writes:", error);
        });
    },
  };
}

const NOTHING = (): void => {};

/** How often the wake detector ticks. */
const WAKE_TICK_MS = 5_000;

/** How long `unavailable` waits when the transport itself failed. */
const TOKEN_RETRY_MS = 5_000;

let session: CloudSession | null = null;
let closeActive: (() => void) | null = null;
const sessionListeners = new Set<(session: CloudSession | null) => void>();

/** The running client, or `null`: a local launch, still starting, or closed. */
export function cloudSession(): CloudSession | null {
  return session;
}

/**
 * Calls `listener` with the session now if there is one, then whenever it
 * starts or closes (with `null`). The board source and the Workspace follower
 * are its callers.
 */
export function followCloudSession(listener: (session: CloudSession | null) => void): () => void {
  sessionListeners.add(listener);
  if (session !== null) listener(session);
  return () => {
    sessionListeners.delete(listener);
  };
}

function publish(next: CloudSession | null): void {
  session = next;
  for (const listener of Array.from(sessionListeners)) listener(next);
}

/** Closes the running client, if any: its cache and token go with it. */
export function closeCloudClient(): void {
  closeActive?.();
}

/**
 * Makes the cloud launch's one client and follows what the link reads. Boot
 * calls it once, in a cloud launch only; a second call closes the first.
 */
export async function startCloudClient(
  launch: Extract<CloudLaunch, { store: "cloud" }>,
  deps: CloudClientDeps = defaultDeps(),
): Promise<CloudSession> {
  closeActive?.();
  const { inputs, clock } = deps;
  inputs.update({ client: "starting", online: deps.window.navigator.onLine });
  const runtime = await deps.load();
  const client = new runtime.ConvexReactClient(launch.backendUrl, {
    // Its `beforeunload` hook would cancel a window close in Electron with no
    // dialog; the quit gate asks about unsaved board writes instead.
    unsavedChangesWarning: false,
    verbose: false,
  });
  let closed = false;
  const waiter = createWaiter(clock);
  const fetchToken = createTokenFetcher({
    ask: (force) => deps.account.accessToken(force),
    wait: (ms) => waiter.wait(ms),
    closed: () => closed,
    retryMs: TOKEN_RETRY_MS,
  });
  const authenticate = () =>
    client.setAuth(fetchToken, (authenticated) => {
      if (!closed) inputs.update({ authenticated });
    });
  authenticate();

  let reportedWrites = 0;
  const reportWrites = (count: number) => {
    if (count === reportedWrites) return;
    reportedWrites = count;
    deps.reportUnsavedWrites(count);
  };
  const stopConnection = client.subscribeToConnectionState((state) => {
    if (closed) return;
    const connection = readConnection(state);
    inputs.update({ connection });
    reportWrites(connection.inflightMutations);
  });
  inputs.update({ client: "running", connection: readConnection(client.connectionState()) });

  const online = () => {
    inputs.update({ online: true });
    waiter.wake();
  };
  const offline = () => inputs.update({ online: false });
  deps.window.addEventListener("online", online);
  deps.window.addEventListener("offline", offline);

  let lastTick = clock.now();
  const ticker = clock.setInterval(() => {
    const now = clock.now();
    if (wokeBetween(lastTick, now, WAKE_TICK_MS)) {
      inputs.update({ resumedAt: now });
      waiter.wake();
    }
    lastTick = now;
  }, WAKE_TICK_MS);

  // Cleared once the sign-in ends; the same person signing in again restores it.
  let authCleared = false;
  let stopAccount: () => void = NOTHING;
  let lastAccount: { state: string; backend: string | null } | null = null;
  const account = deps.account.subscribe({
    onData(snapshot) {
      if (closed) return;
      const signedIn = snapshot.account;
      const backend = signedIn?.backend ?? null;
      inputs.update({
        account: { state: snapshot.state, backend, failure: snapshot.failure },
      });
      // A token wait wakes for a real change, not for every repeat of the same snapshot.
      if (lastAccount?.state !== snapshot.state || lastAccount.backend !== backend) waiter.wake();
      lastAccount = { state: snapshot.state, backend };
      if (snapshot.state === "signed-out") {
        // Main's token door answers signed-out now; the board stays on screen,
        // read-only, until the person signs in again or the window restarts
        // (a chosen sign-out closes this client itself, `closeCloudClient`).
        if (!authCleared) {
          authCleared = true;
          client.clearAuth();
        }
        return;
      }
      if (snapshot.state !== "signed-in" || signedIn === null || signedIn.userId === null) return;
      if (signedIn.userId !== launch.userId) {
        // Someone else: this process never shows a second account's board.
        close();
        return;
      }
      if (authCleared) {
        authCleared = false;
        authenticate();
      }
    },
    onError() {
      // The stream ending says nothing about the sign-in; the link keeps the last word.
    },
  });
  // A first snapshot delivered during the call may already have closed the client.
  if (closed) account.unsubscribe();
  else stopAccount = () => account.unsubscribe();

  function close(): void {
    if (closed) return;
    closed = true;
    closeActive = null;
    waiter.wake();
    stopConnection();
    stopAccount();
    clock.clearInterval(ticker);
    deps.window.removeEventListener("online", online);
    deps.window.removeEventListener("offline", offline);
    deps.window.removeEventListener("pagehide", close);
    inputs.update({ client: "closed" });
    // Its writes go with it: nothing is left for the quit gate to ask about.
    reportWrites(0);
    publish(null);
    void client.close();
  }
  const started: CloudSession = { client, api: runtime.api };
  if (closed) return started;
  closeActive = close;
  deps.window.addEventListener("pagehide", close);
  publish(started);
  return started;
}
