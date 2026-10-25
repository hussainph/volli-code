import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { AccountAccessToken, AccountSnapshot } from "@volli/shared";

import {
  closeCloudClient,
  cloudSession,
  createTokenFetcher,
  createWaiter,
  followCloudSession,
  startCloudClient,
  type CloudClientDeps,
} from "./cloud-client";
import { createCloudLinkInputStore } from "@renderer/stores/cloud-link";

const LAUNCH = {
  store: "cloud",
  userId: "user-1",
  backendUrl: "http://127.0.0.1:3210",
} as const;

const clock = {
  now: () => Date.now(),
  setTimeout: (run: () => void, ms: number) => setTimeout(run, ms),
  clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (run: () => void, ms: number) => setInterval(run, ms),
  clearInterval: (handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>),
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  closeCloudClient();
  vi.useRealTimers();
});

function fetcher(answers: (AccountAccessToken | Error)[], closed = () => false) {
  const asked: boolean[] = [];
  const waits: number[] = [];
  const fetch = createTokenFetcher({
    ask: async (force) => {
      asked.push(force);
      const next = answers.shift()!;
      if (next instanceof Error) throw next;
      return next;
    },
    wait: async (ms) => {
      waits.push(ms);
    },
    closed,
    retryMs: 5_000,
  });
  return { fetch, asked, waits };
}

describe("the token fetcher (VC-889)", () => {
  it("answers a token, and null only when signed out", async () => {
    const token = fetcher([{ kind: "token", token: "jwt", expiresAt: 1 }]);
    await expect(token.fetch({ forceRefreshToken: true })).resolves.toBe("jwt");
    expect(token.asked).toEqual([true]);
    const out = fetcher([{ kind: "signed-out" }]);
    await expect(out.fetch({ forceRefreshToken: false })).resolves.toBeNull();
  });

  it("waits out unavailable and a failed call, never answering null for them", async () => {
    const { fetch, waits, asked } = fetcher([
      { kind: "unavailable", retryAfterMs: 2_000 },
      new Error("bridge closed"),
      { kind: "unavailable", retryAfterMs: 0 },
      { kind: "token", token: "back", expiresAt: 1 },
    ]);
    await expect(fetch({ forceRefreshToken: false })).resolves.toBe("back");
    expect(waits).toEqual([2_000, 5_000, 250]);
    expect(asked).toEqual([false, false, false, false]);
  });

  it("gives up with null only when the client closes, before or after an answer", async () => {
    let closed = true;
    const before = fetcher([], () => closed);
    await expect(before.fetch({ forceRefreshToken: false })).resolves.toBeNull();
    expect(before.asked).toEqual([]);
    closed = false;
    const after = createTokenFetcher({
      ask: async () => {
        closed = true;
        return { kind: "token", token: "late", expiresAt: 1 };
      },
      wait: async () => {},
      closed: () => closed,
      retryMs: 1,
    });
    await expect(after({ forceRefreshToken: false })).resolves.toBeNull();
  });

  it("wakes a wait early, and lets one end on its own", async () => {
    const waiter = createWaiter(clock);
    let woken = 0;
    void waiter.wait(60_000).then(() => woken++);
    void waiter.wait(60_000).then(() => woken++);
    waiter.wake();
    await Promise.resolve();
    expect(woken).toBe(2);
    let timed = false;
    void waiter.wait(1_000).then(() => {
      timed = true;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(timed).toBe(true);
  });
});

class FakeConvexClient {
  static made: FakeConvexClient[] = [];
  readonly address: string;
  readonly options: unknown;
  fetchToken: ((args: { forceRefreshToken: boolean }) => Promise<string | null>) | null = null;
  onAuth: ((authenticated: boolean) => void) | null = null;
  connection: (state: unknown) => void = () => {};
  setAuthCalls = 0;
  cleared = 0;
  closed = 0;
  stoppedConnection = false;
  constructor(address: string, options: unknown) {
    this.address = address;
    this.options = options;
    FakeConvexClient.made.push(this);
  }
  setAuth(fetch: FakeConvexClient["fetchToken"], onChange: (ok: boolean) => void) {
    this.setAuthCalls += 1;
    this.fetchToken = fetch;
    this.onAuth = onChange;
  }
  clearAuth() {
    this.cleared += 1;
  }
  connectionState() {
    return { isWebSocketConnected: false, hasEverConnected: false, inflightMutations: 0 };
  }
  subscribeToConnectionState(listener: (state: unknown) => void) {
    this.connection = listener;
    return () => {
      this.stoppedConnection = true;
    };
  }
  async close() {
    this.closed += 1;
  }
}

function harness(options: { firstSnapshot?: AccountSnapshot; online?: boolean } = {}): {
  deps: CloudClientDeps;
  inputs: ReturnType<typeof createCloudLinkInputStore>;
  emit(snapshot: AccountSnapshot): void;
  fire(type: "online" | "offline" | "pagehide"): void;
  unsubscribed: () => boolean;
  tokens: AccountAccessToken[];
} {
  const inputs = createCloudLinkInputStore();
  const listeners = new Map<string, Set<() => void>>();
  let onData: ((snapshot: AccountSnapshot) => void) | null = null;
  let unsubscribed = false;
  const tokens: AccountAccessToken[] = [];
  const deps: CloudClientDeps = {
    load: async () => ({
      ConvexReactClient: FakeConvexClient as never,
      api: {} as never,
    }),
    account: {
      accessToken: async () => tokens.shift() ?? { kind: "signed-out" },
      subscribe: (handlers) => {
        onData = handlers.onData;
        handlers.onError(new Error("ignored"));
        if (options.firstSnapshot !== undefined) handlers.onData(options.firstSnapshot);
        return {
          unsubscribe: () => {
            unsubscribed = true;
          },
        };
      },
    },
    window: {
      navigator: { onLine: options.online ?? true },
      addEventListener(type, listener) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(listener);
      },
      removeEventListener(type, listener) {
        listeners.get(type)?.delete(listener);
      },
    },
    inputs: inputs.getState(),
    clock,
    reportUnsavedWrites: vi.fn(),
  };
  return {
    deps,
    inputs,
    emit: (snapshot) => onData?.(snapshot),
    fire: (type) => {
      for (const listener of Array.from(listeners.get(type) ?? [])) listener();
    },
    unsubscribed: () => unsubscribed,
    tokens,
  };
}

const signedIn = (userId: string | null = "user-1"): AccountSnapshot => ({
  state: "signed-in",
  provider: "dev",
  signingInWith: null,
  account: { displayName: "D", email: null, userId, deletionPurgeAfter: null, backend: "synced" },
  failure: null,
});
const signedOut = (failure: string | null): AccountSnapshot => ({
  state: "signed-out",
  provider: "dev",
  signingInWith: null,
  account: null,
  failure,
});

describe("the cloud launch's client", () => {
  beforeEach(() => {
    FakeConvexClient.made = [];
  });

  it("makes one client with no unload warning, authenticates it, and publishes it", async () => {
    const h = harness();
    const seen: unknown[] = [];
    const stop = followCloudSession((session) => seen.push(session));
    h.tokens.push({ kind: "token", token: "jwt", expiresAt: 1 });
    const session = await startCloudClient(LAUNCH, h.deps);
    const client = FakeConvexClient.made[0]!;
    expect(client.address).toBe(LAUNCH.backendUrl);
    expect(client.options).toEqual({ unsavedChangesWarning: false, verbose: false });
    await expect(client.fetchToken!({ forceRefreshToken: true })).resolves.toBe("jwt");
    expect(cloudSession()).toBe(session);
    expect(seen).toEqual([session]);
    // A late follower hears the running session at once.
    const late: unknown[] = [];
    followCloudSession((value) => late.push(value))();
    expect(late).toEqual([session]);
    stop();
    expect(h.inputs.getState().input).toMatchObject({ client: "running", online: true });
    client.onAuth!(false);
    expect(h.inputs.getState().input.authenticated).toBe(false);
    client.connection({ isWebSocketConnected: true, hasEverConnected: true });
    expect(h.inputs.getState().input.connection).toMatchObject({ connected: true });
    // Unanswered writes reach main's quit gate when their count changes.
    client.connection({ isWebSocketConnected: true, inflightMutations: 2 });
    client.connection({ isWebSocketConnected: true, inflightMutations: 2 });
    expect(h.deps.reportUnsavedWrites).toHaveBeenCalledExactlyOnceWith(2);
    closeCloudClient();
    expect(h.deps.reportUnsavedWrites).toHaveBeenLastCalledWith(0);
  });

  it("follows the OS's online state and a wake from sleep", async () => {
    const h = harness({ online: false });
    await startCloudClient(LAUNCH, h.deps);
    expect(h.inputs.getState().input.online).toBe(false);
    h.fire("online");
    expect(h.inputs.getState().input.online).toBe(true);
    h.fire("offline");
    expect(h.inputs.getState().input.online).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.inputs.getState().input.resumedAt).toBeNull();
    // The process slept: the next tick arrives long after it was due.
    vi.setSystemTime(Date.now() + 60_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.inputs.getState().input.resumedAt).toBe(Date.now());
  });

  it("closes for good when the sign-out confirm closes it, and says so", async () => {
    const h = harness();
    const seen: unknown[] = [];
    followCloudSession((session) => seen.push(session));
    await startCloudClient(LAUNCH, h.deps);
    const client = FakeConvexClient.made[0]!;
    h.emit(signedIn());
    h.emit(signedOut(null));
    // The account signing out alone clears auth; the confirm closes the client.
    expect(client.closed).toBe(0);
    expect(client.cleared).toBe(1);
    closeCloudClient();
    expect(client.closed).toBe(1);
    expect(client.stoppedConnection).toBe(true);
    expect(h.unsubscribed()).toBe(true);
    expect(cloudSession()).toBeNull();
    expect(seen.at(-1)).toBeNull();
    expect(h.inputs.getState().input).toMatchObject({
      client: "closed",
      account: { state: "signed-out", backend: null, failure: null },
    });
    // Nothing after the close reaches the link, and closing again is a no-op.
    client.onAuth!(true);
    client.connection({ isWebSocketConnected: true });
    h.emit(signedIn());
    closeCloudClient();
    expect(h.inputs.getState().input.authenticated).toBeNull();
    expect(client.closed).toBe(1);
    await expect(client.fetchToken!({ forceRefreshToken: false })).resolves.toBeNull();
  });

  it("wakes a waiting token fetch for a real account change, not a repeated snapshot", async () => {
    const h = harness();
    let asks = 0;
    h.deps.account.accessToken = async () => {
      asks += 1;
      return { kind: "unavailable", retryAfterMs: 60_000 };
    };
    await startCloudClient(LAUNCH, h.deps);
    const client = FakeConvexClient.made[0]!;
    h.emit(signedIn());
    void client.fetchToken!({ forceRefreshToken: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(asks).toBe(1);
    h.emit(signedIn());
    await vi.advanceTimersByTimeAsync(0);
    expect(asks).toBe(1);
    h.emit({ ...signedIn(), account: { ...signedIn().account!, backend: "unreachable" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(asks).toBe(2);
  });

  it("waits for the person's id before restoring auth: someone else never gets the board", async () => {
    const h = harness();
    await startCloudClient(LAUNCH, h.deps);
    const client = FakeConvexClient.made[0]!;
    h.emit(signedOut("Your sign-in expired. Sign in again."));
    // A cancelled re-sign-in is still the same launch, waiting.
    h.emit(signedOut(null));
    expect(client.closed).toBe(0);
    h.emit(signedIn(null));
    expect(client.setAuthCalls).toBe(1);
    h.emit(signedIn("someone-else"));
    expect(client.setAuthCalls).toBe(1);
    expect(client.closed).toBe(1);
  });

  it("closes when someone else signs in, and on the window's unload", async () => {
    const h = harness();
    await startCloudClient(LAUNCH, h.deps);
    h.emit(signedIn("someone-else"));
    expect(FakeConvexClient.made[0]!.closed).toBe(1);

    const unload = harness();
    await startCloudClient(LAUNCH, unload.deps);
    unload.fire("pagehide");
    expect(FakeConvexClient.made[1]!.closed).toBe(1);
  });

  it("clears auth on an expired sign-in, and restores it when the same person signs in", async () => {
    const h = harness();
    await startCloudClient(LAUNCH, h.deps);
    const client = FakeConvexClient.made[0]!;
    h.emit({ ...signedIn(), state: "restoring", account: null });
    h.emit(signedIn(null));
    expect(client.setAuthCalls).toBe(1);
    h.emit(signedOut("Your sign-in expired. Sign in again."));
    h.emit(signedOut("Your sign-in expired. Sign in again."));
    expect(client.cleared).toBe(1);
    expect(client.closed).toBe(0);
    h.emit(signedIn());
    expect(client.setAuthCalls).toBe(2);
    h.emit(signedIn());
    expect(client.setAuthCalls).toBe(2);
  });

  it("closes the client a second start replaces, and one whose first snapshot ends it", async () => {
    const first = harness();
    await startCloudClient(LAUNCH, first.deps);
    const second = harness();
    await startCloudClient(LAUNCH, second.deps);
    expect(FakeConvexClient.made[0]!.closed).toBe(1);
    const ended = harness({ firstSnapshot: signedIn("someone-else") });
    const session = await startCloudClient(LAUNCH, ended.deps);
    expect(FakeConvexClient.made[2]!.closed).toBe(1);
    expect(ended.unsubscribed()).toBe(true);
    expect(cloudSession()).not.toBe(session);
  });
});
