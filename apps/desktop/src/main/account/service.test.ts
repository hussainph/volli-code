/**
 * The account service end to end: the real loopback listener, the real dev
 * issuer over HTTP, the real sealed inventory (file keyring, as harness mode
 * runs it). The browser is this test following the redirects; the backend is
 * a recording stand-in.
 */
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  ACCOUNT_TOKEN_RETRY_MS,
  UNCONFIGURED_ACCOUNT,
  isOperationUnavailable,
  type AccountSnapshot,
} from "@volli/shared";

import { BackendRefusedError, type AccountBackend, type BackendViewer } from "./backend";
import { devIssuerProvider } from "./dev-issuer";
import { ProviderRefusedError, type AccountProvider, type ProviderTokens } from "./provider";
import { ACCOUNT_CLOUD_OFF, createAccountService, type AccountServiceOptions } from "./service";
import { ACCOUNT_SESSION_PURPOSE, inventoryAccountSessionStore } from "./session-store";
import { tempInventory, testKeyPair } from "./test-support";

const VIEWER: BackendViewer = {
  previewAccess: "granted",
  previewAgreementAccepted: true,
  userId: "6b4c3a1e-2a9f-4c3e-9d1b-0f8e7d6c5b4a",
  displayName: "Dana from Volli",
  primaryEmail: "dana@example.com",
  status: "active",
  purgeAfter: null,
};

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** The system browser: follows the provider's redirect to the loopback listener. */
function browser() {
  const opened: string[] = [];
  const open = vi.fn(async (url: string) => {
    opened.push(url);
    const authorize = await fetch(url, { redirect: "manual" });
    const location = authorize.headers.get("location");
    if (location !== null) await fetch(location);
  });
  return { open, opened };
}

function backendStandIn(overrides: Partial<AccountBackend> = {}) {
  const standIn = {
    ensureViewer: vi.fn(async (_token: string): Promise<BackendViewer> => VIEWER),
    requestDeletion: vi.fn(async (_token: string): Promise<BackendViewer> => ({
      ...VIEWER,
      status: "deletion_pending",
      purgeAfter: 9_999,
    })),
    cancelDeletion: vi.fn(async (_token: string): Promise<BackendViewer> => VIEWER),
  } satisfies AccountBackend;
  if (overrides.ensureViewer) standIn.ensureViewer.mockImplementation(overrides.ensureViewer);
  return standIn;
}

function harness(
  options: {
    provider?: AccountProvider;
    backend?: AccountBackend | null;
    openBrowser?: AccountServiceOptions["openBrowser"];
    accessTtlSeconds?: number;
    enabled?: () => boolean;
    temp?: ReturnType<typeof tempInventory>;
    marker?: AccountServiceOptions["marker"];
  } = {},
) {
  const temp = options.temp ?? tempInventory();
  if (options.temp === undefined) cleanups.push(temp.dispose);
  const provider =
    options.provider ??
    devIssuerProvider({
      privateKeyPem: testKeyPair().privateKeyPem,
      displayName: "Dana",
      email: "dana@example.com",
      ...(options.accessTtlSeconds === undefined
        ? {}
        : { accessTtlSeconds: options.accessTtlSeconds }),
    });
  const web = browser();
  const backend = options.backend === undefined ? backendStandIn() : options.backend;
  const service = createAccountService({
    enabled: options.enabled ?? (() => true),
    provider,
    backend,
    store: inventoryAccountSessionStore(temp.inventory, async () => {}),
    openBrowser: options.openBrowser ?? web.open,
    ...(options.marker === undefined ? {} : { marker: options.marker }),
  });
  cleanups.push(() => service.dispose());
  const seen: AccountSnapshot[] = [];
  return {
    service,
    web,
    // The recording stand-in unless the test passed its own.
    backend: backend as ReturnType<typeof backendStandIn>,
    temp,
    provider,
    seen,
    watch: () => service.subscribe((s) => void seen.push(s)),
  };
}

/** A provider whose every answer the test scripts. */
function scriptedProvider(overrides: Partial<AccountProvider> = {}): AccountProvider {
  let issued = 0;
  const tokens = (): ProviderTokens => {
    issued += 1;
    return {
      accessToken: `access-${issued}`,
      refreshToken: `refresh-${issued}`,
      accessExpiresAt: Date.now() + 10 * 60_000,
      sessionId: "session_01",
      profile: { displayName: "Dana", email: "dana@example.com" },
    };
  };
  return {
    kind: "workos",
    authorizationUrl: async (request) => {
      const url = new URL(request.redirectUri);
      url.searchParams.set("code", "c");
      url.searchParams.set("state", request.state);
      return `http://127.0.0.1:1/never?next=${encodeURIComponent(url.toString())}`;
    },
    exchangeCode: async () => tokens(),
    refresh: async () => tokens(),
    logoutUrl: (sessionId) => `https://auth.example.test/logout?session_id=${sessionId}`,
    ...overrides,
  };
}

/** The browser for {@link scriptedProvider}: straight to the callback it names. */
const scriptedBrowser = vi.fn(async (url: string) => {
  const next = new URL(url).searchParams.get("next");
  if (next !== null) await fetch(next);
});

describe("the account service", () => {
  it("refuses everything while cloud is off, and answers an unconfigured build", async () => {
    const off = harness({ enabled: () => false });
    for (const call of [
      () => off.service.snapshot(),
      () => off.service.subscribe(() => {}),
      () => off.service.signIn("github"),
      () => off.service.cancelSignIn(),
      () => off.service.signOut(),
      () => off.service.requestDeletion(),
    ]) {
      const error = await (async () => call())().catch((caught: unknown) => caught);
      expect(isOperationUnavailable(error)).toBe(true);
      expect((error as Error).message).toBe(ACCOUNT_CLOUD_OFF);
    }

    const temp = tempInventory();
    cleanups.push(temp.dispose);
    const unconfigured = createAccountService({
      enabled: () => true,
      provider: null,
      backend: null,
      store: inventoryAccountSessionStore(temp.inventory, async () => {}),
      openBrowser: () => {},
    });
    expect(unconfigured.snapshot()).toEqual(UNCONFIGURED_ACCOUNT);
    await expect(unconfigured.signIn("github")).rejects.toThrow(
      "no Volli Cloud sign-in configured",
    );
    await expect(unconfigured.accessToken()).resolves.toBeNull();
  });

  it("signs in through the browser, seals the refresh token, and syncs the person", async () => {
    const { service, web, backend, temp, seen, watch } = harness();
    expect(service.snapshot()).toMatchObject({ state: "restoring", provider: "dev" });
    await service.settled();
    watch();
    expect(service.snapshot()).toEqual({
      state: "signed-out",
      provider: "dev",
      signingInWith: null,
      account: null,
      failure: null,
    });

    await service.signIn("github");
    await service.settled();

    expect(web.opened).toHaveLength(1);
    const authorize = new URL(web.opened[0]!);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(new URL(authorize.searchParams.get("redirect_uri")!).hostname).toBe("127.0.0.1");
    expect(seen.map((snapshot) => snapshot.state)).toEqual([
      "signed-out",
      "signing-in",
      "signed-in",
      "signed-in",
    ]);
    expect(seen[1]!.signingInWith).toBe("github");
    const snapshot = service.snapshot();
    expect(snapshot).toEqual({
      state: "signed-in",
      provider: "dev",
      signingInWith: null,
      account: {
        displayName: "Dana from Volli",
        email: "dana@example.com",
        userId: VIEWER.userId,
        deletionPurgeAfter: null,
        backend: "synced",
      },
      failure: null,
    });
    // The backend got a real access token; the window never sees one.
    const token = backend.ensureViewer.mock.calls[0]![0];
    expect(token.split(".")).toHaveLength(3);
    await expect(service.accessToken()).resolves.toBe(token);
    const sealed = temp.inventory.get("host-private", { purpose: ACCOUNT_SESSION_PURPOSE });
    expect(typeof sealed?.value).toBe("string");
    const { refreshToken } = JSON.parse(sealed!.value as string) as { refreshToken: string };
    for (const frame of seen) {
      expect(JSON.stringify(frame)).not.toContain(token);
      expect(JSON.stringify(frame)).not.toContain(refreshToken);
    }

    await expect(service.signIn("google")).rejects.toThrow("Already signed in");
  });

  it("restores the saved sign-in at the window's first ask, refreshing it", async () => {
    const key = testKeyPair();
    const temp = tempInventory();
    cleanups.push(temp.dispose);
    const provider = devIssuerProvider({ privateKeyPem: key.privateKeyPem });
    cleanups.push(() => provider.dispose?.());
    const first = harness({ provider, temp });
    first.service.snapshot();
    await first.service.settled();
    await first.service.signIn("google");
    await first.service.settled();
    const before = temp.inventory.get("host-private", { purpose: ACCOUNT_SESSION_PURPOSE })!;

    // The next launch: nothing read until the window asks.
    const backend = backendStandIn();
    const next = createAccountService({
      enabled: () => true,
      provider,
      backend,
      store: inventoryAccountSessionStore(temp.inventory, async () => {}),
      openBrowser: () => {},
    });
    expect(backend.ensureViewer).not.toHaveBeenCalled();
    expect(next.snapshot().state).toBe("restoring");
    await next.settled();
    expect(next.snapshot()).toMatchObject({
      state: "signed-in",
      account: { userId: VIEWER.userId, backend: "synced" },
    });
    expect(backend.ensureViewer).toHaveBeenCalledOnce();
    // The refresh rotated the sealed token.
    const after = temp.inventory.get("host-private", { purpose: ACCOUNT_SESSION_PURPOSE })!;
    expect(after.value).not.toBe(before.value);
  });

  it("refreshes an access token about to expire once, however many callers wait", async () => {
    const refresh = vi.fn(async () => ({
      accessToken: "fresh",
      refreshToken: "refresh-next",
      accessExpiresAt: Date.now() + 10 * 60_000,
      sessionId: null,
      profile: { displayName: null, email: null },
    }));
    const provider = scriptedProvider({
      exchangeCode: async () => ({
        accessToken: "short",
        refreshToken: "refresh-1",
        accessExpiresAt: Date.now() + 30_000,
        sessionId: "session_01",
        profile: { displayName: "Dana", email: null },
      }),
      refresh,
    });
    const { service, temp } = harness({ provider, openBrowser: scriptedBrowser, backend: null });
    service.snapshot();
    await service.settled();
    await service.signIn("github");
    await service.settled();
    expect(service.snapshot().account).toMatchObject({ backend: "none", userId: null });

    const tokens = await Promise.all([service.accessToken(), service.accessToken()]);
    expect(tokens).toEqual(["fresh", "fresh"]);
    expect(refresh).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledWith("refresh-1");
    await expect(service.accessToken()).resolves.toBe("fresh");
    expect(refresh).toHaveBeenCalledOnce();
    const sealed = JSON.parse(
      temp.inventory.get("host-private", { purpose: ACCOUNT_SESSION_PURPOSE })!.value as string,
    ) as { refreshToken: string; sessionId: string };
    // Rotated, and the provider session kept from the sign-in.
    expect(sealed).toMatchObject({ refreshToken: "refresh-next", sessionId: "session_01" });
  });

  // VC-889: the window's own Volli Cloud client asks for short-lived tokens.
  describe("the window's token", () => {
    it("answers signed-out with cloud off, unconfigured, or nobody signed in", async () => {
      const off = harness({ enabled: () => false });
      await expect(off.service.windowToken(false)).resolves.toEqual({ kind: "signed-out" });
      const unconfigured = createAccountService({
        enabled: () => true,
        provider: null,
        backend: null,
        store: inventoryAccountSessionStore(off.temp.inventory, async () => {}),
        openBrowser: () => {},
      });
      await expect(unconfigured.windowToken(true)).resolves.toEqual({ kind: "signed-out" });
      const nobody = harness({ provider: scriptedProvider(), openBrowser: scriptedBrowser });
      await expect(nobody.service.windowToken(false)).resolves.toEqual({ kind: "signed-out" });
    });

    it("answers the access token, and refreshes on force unless it just did", async () => {
      let now = 1_000_000;
      const refresh = vi.fn(async () => ({
        accessToken: `fresh-${refresh.mock.calls.length}`,
        refreshToken: `refresh-${refresh.mock.calls.length + 1}`,
        accessExpiresAt: now + 10 * 60_000,
        sessionId: null,
        profile: { displayName: null, email: null },
      }));
      const provider = scriptedProvider({
        exchangeCode: async () => ({
          accessToken: "first",
          refreshToken: "refresh-1",
          accessExpiresAt: now + 10 * 60_000,
          sessionId: null,
          profile: { displayName: "Dana", email: null },
        }),
        refresh,
      });
      const temp = tempInventory();
      cleanups.push(temp.dispose);
      const service = createAccountService({
        enabled: () => true,
        provider,
        backend: null,
        store: inventoryAccountSessionStore(temp.inventory, async () => {}),
        openBrowser: scriptedBrowser,
        now: () => now,
      });
      cleanups.push(() => service.dispose());
      service.snapshot();
      await service.settled();
      await service.signIn("github");
      await service.settled();

      const expiresAt = now + 10 * 60_000;
      await expect(service.windowToken(false)).resolves.toEqual({
        kind: "token",
        token: "first",
        expiresAt,
      });
      // The client's start asks cached then forced: the token just issued serves both.
      await expect(service.windowToken(true)).resolves.toMatchObject({ token: "first" });
      expect(refresh).not.toHaveBeenCalled();
      now += 31_000;
      await expect(service.windowToken(true)).resolves.toMatchObject({
        kind: "token",
        token: "fresh-1",
      });
      expect(refresh).toHaveBeenCalledOnce();
      await expect(service.windowToken(false)).resolves.toMatchObject({ token: "fresh-1" });
      expect(refresh).toHaveBeenCalledOnce();
    });

    it("answers unavailable offline, keeping the sign-in, and signed-out once it is refused", async () => {
      let refreshFails: Error = new Error("offline");
      const provider = scriptedProvider({
        exchangeCode: async () => ({
          accessToken: "expired",
          refreshToken: "refresh-1",
          accessExpiresAt: Date.now() - 1,
          sessionId: null,
          profile: { displayName: "Dana", email: null },
        }),
        refresh: async () => {
          throw refreshFails;
        },
      });
      const { service } = harness({ provider, openBrowser: scriptedBrowser });
      service.snapshot();
      await service.settled();
      await service.signIn("github");
      await service.settled();
      await expect(service.windowToken(false)).resolves.toEqual({
        kind: "unavailable",
        retryAfterMs: ACCOUNT_TOKEN_RETRY_MS,
      });
      await expect(service.windowToken(true)).resolves.toMatchObject({ kind: "unavailable" });
      expect(service.snapshot().state).toBe("signed-in");
      refreshFails = new ProviderRefusedError("Session has already ended.");
      await expect(service.windowToken(true)).resolves.toEqual({ kind: "signed-out" });
      expect(service.snapshot().state).toBe("signed-out");
    });
  });

  it("writes the launch marker once the backend answers, and clears it when signed out", async () => {
    const marker = { write: vi.fn(), clear: vi.fn() };
    const { service } = harness({ marker });
    service.snapshot();
    await service.settled();
    marker.clear.mockClear();
    await service.signIn("github");
    await service.settled();
    expect(marker.write).toHaveBeenCalledWith(VIEWER.userId);
    await service.signOut();
    expect(marker.clear).toHaveBeenCalled();
  });

  it("signs out when the provider refuses the refresh, and keeps the sign-in when offline", async () => {
    let refreshFails: Error = new Error("offline");
    const provider = scriptedProvider({
      exchangeCode: async () => ({
        accessToken: "expired",
        refreshToken: "refresh-1",
        accessExpiresAt: Date.now() - 1,
        sessionId: null,
        profile: { displayName: "Dana", email: null },
      }),
      refresh: async () => {
        throw refreshFails;
      },
    });
    const { service, temp } = harness({ provider, openBrowser: scriptedBrowser });
    service.snapshot();
    await service.settled();
    await service.signIn("github");
    await service.settled();
    // Offline: ensureViewer could not get a token; the sign-in is kept.
    expect(service.snapshot()).toMatchObject({
      state: "signed-in",
      account: { backend: "unreachable" },
      failure: "Couldn't reach Volli Cloud. Your sign-in is kept.",
    });
    await expect(service.accessToken()).rejects.toThrow("offline");
    expect(service.snapshot().state).toBe("signed-in");

    refreshFails = new ProviderRefusedError("Session has already ended.");
    await expect(service.accessToken()).resolves.toBeNull();
    expect(service.snapshot()).toMatchObject({
      state: "signed-out",
      account: null,
      failure: "Your sign-in expired. Sign in again.",
    });
    expect(temp.inventory.list("host-private")).toEqual([]);
  });

  it("restores signed in from the saved profile while offline", async () => {
    const temp = tempInventory();
    cleanups.push(temp.dispose);
    const first = harness({ provider: scriptedProvider(), openBrowser: scriptedBrowser, temp });
    first.service.snapshot();
    await first.service.settled();
    await first.service.signIn("github");
    await first.service.settled();

    const offline = harness({
      provider: scriptedProvider({
        refresh: async () => {
          throw new Error("offline");
        },
      }),
      temp,
    });
    offline.service.snapshot();
    await offline.service.settled();
    expect(offline.service.snapshot()).toMatchObject({
      state: "signed-in",
      account: {
        displayName: "Dana",
        email: "dana@example.com",
        userId: null,
        backend: "unreachable",
      },
      failure: "Couldn't reach Volli Cloud. Your sign-in is kept.",
    });
    expect(offline.backend!.ensureViewer).not.toHaveBeenCalled();
  });

  it("forgets a saved sign-in from another provider", async () => {
    const temp = tempInventory();
    cleanups.push(temp.dispose);
    const dev = harness({ temp });
    dev.service.snapshot();
    await dev.service.settled();
    await dev.service.signIn("github");
    await dev.service.settled();
    const workos = harness({ provider: scriptedProvider(), temp });
    workos.service.snapshot();
    await workos.service.settled();
    expect(workos.service.snapshot()).toMatchObject({ state: "signed-out", provider: "workos" });
    expect(temp.inventory.list("host-private")).toEqual([]);
  });

  it("ends a sign-in the person cancels, or the browser declines, without keeping anything", async () => {
    const { service, temp, seen, watch } = harness({ openBrowser: () => {} });
    service.snapshot();
    await service.settled();
    watch();
    await service.signIn("google");
    expect(service.snapshot()).toMatchObject({ state: "signing-in", signingInWith: "google" });
    service.cancelSignIn();
    await service.settled();
    expect(service.snapshot()).toMatchObject({ state: "signed-out", failure: null });
    expect(seen.map((s) => s.state)).toEqual(["signed-out", "signing-in", "signed-out"]);
    service.cancelSignIn();

    const declined = harness({
      provider: scriptedProvider({
        authorizationUrl: async (request) => {
          const url = new URL(request.redirectUri);
          url.searchParams.set("error", "access_denied");
          url.searchParams.set("state", request.state);
          return `http://127.0.0.1:1/never?next=${encodeURIComponent(url.toString())}`;
        },
      }),
      openBrowser: scriptedBrowser,
    });
    declined.service.snapshot();
    await declined.service.settled();
    await declined.service.signIn("github");
    await declined.service.settled();
    expect(declined.service.snapshot()).toMatchObject({
      state: "signed-out",
      failure: "Sign-in was declined in the browser.",
    });
    expect(temp.inventory.list("host-private")).toEqual([]);
  });

  it("reports a code the provider will not trade, and a browser that will not open", async () => {
    const refused = harness({
      provider: scriptedProvider({
        exchangeCode: async () => {
          throw new ProviderRefusedError("The sign-in provider refused the sign-in.");
        },
      }),
      openBrowser: scriptedBrowser,
    });
    refused.service.snapshot();
    await refused.service.settled();
    await refused.service.signIn("github");
    await refused.service.settled();
    expect(refused.service.snapshot()).toMatchObject({
      state: "signed-out",
      failure: "The sign-in provider refused the sign-in.",
    });

    const noBrowser = harness({
      provider: scriptedProvider(),
      openBrowser: () => {
        throw new Error("No browser.");
      },
    });
    noBrowser.service.snapshot();
    await noBrowser.service.settled();
    await expect(noBrowser.service.signIn("github")).rejects.toThrow("No browser.");
    await noBrowser.service.settled();
    expect(noBrowser.service.snapshot()).toMatchObject({
      state: "signed-out",
      failure: "Couldn't open the browser to sign in. Try again.",
    });

    const offline = harness({
      provider: scriptedProvider({
        exchangeCode: async () => {
          throw new Error("ECONNRESET at /some/path");
        },
      }),
      openBrowser: scriptedBrowser,
    });
    offline.service.snapshot();
    await offline.service.settled();
    await offline.service.signIn("github");
    await offline.service.settled();
    // A transport failure is named, not quoted.
    expect(offline.service.snapshot().failure).toBe(
      "Couldn't reach the sign-in provider. Try again.",
    );
  });

  it("signs out: forgets the tokens and the sealed record, and ends the provider's session", async () => {
    const opened: string[] = [];
    const { service, temp } = harness({
      provider: scriptedProvider(),
      openBrowser: async (url) => {
        opened.push(url);
        await scriptedBrowser(url);
      },
    });
    service.snapshot();
    await service.settled();
    await service.signIn("github");
    await service.settled();
    await service.signOut();
    expect(service.snapshot()).toMatchObject({ state: "signed-out", account: null, failure: null });
    await expect(service.accessToken()).resolves.toBeNull();
    expect(temp.inventory.list("host-private")).toEqual([]);
    expect(opened.at(-1)).toBe("https://auth.example.test/logout?session_id=session_01");
    // Signed out already: quiet.
    await service.signOut();
  });

  it("drops a refresh that a sign-out overtook", async () => {
    const gate = Promise.withResolvers<ProviderTokens>();
    const provider = scriptedProvider({
      exchangeCode: async () => ({
        accessToken: "expired",
        refreshToken: "refresh-1",
        accessExpiresAt: Date.now() - 1,
        sessionId: null,
        profile: { displayName: "Dana", email: null },
      }),
      refresh: () => gate.promise,
    });
    const { service, temp } = harness({ provider, openBrowser: scriptedBrowser, backend: null });
    service.snapshot();
    await service.settled();
    await service.signIn("github");
    await service.settled();
    const late = service.accessToken();
    await service.signOut();
    gate.resolve({
      accessToken: "late",
      refreshToken: "refresh-late",
      accessExpiresAt: Date.now() + 600_000,
      sessionId: null,
      profile: { displayName: null, email: null },
    });
    await expect(late).resolves.toBeNull();
    expect(service.snapshot().state).toBe("signed-out");
    expect(temp.inventory.list("host-private")).toEqual([]);
  });

  it("schedules and cancels the account's deletion through the backend", async () => {
    const { service, backend } = harness();
    service.snapshot();
    await service.settled();
    await expect(service.requestDeletion()).rejects.toThrow("Sign in to Volli first.");
    await service.signIn("github");
    await service.settled();

    await service.requestDeletion();
    expect(backend!.requestDeletion).toHaveBeenCalledOnce();
    expect(service.snapshot().account).toMatchObject({ deletionPurgeAfter: 9_999 });
    await service.cancelDeletion();
    expect(service.snapshot().account).toMatchObject({ deletionPurgeAfter: null });

    (backend as ReturnType<typeof backendStandIn>).requestDeletion.mockRejectedValueOnce(
      new BackendRefusedError("Make someone else an owner first.", "sole_owner"),
    );
    await expect(service.requestDeletion()).rejects.toThrow("Make someone else an owner first.");
  });

  it("needs a backend to delete, and keeps the sign-in when the backend is unreachable", async () => {
    const none = harness({ backend: null });
    none.service.snapshot();
    await none.service.settled();
    await none.service.signIn("github");
    await none.service.settled();
    await expect(none.service.requestDeletion()).rejects.toThrow("no Volli Cloud backend");

    const down = harness({
      backend: backendStandIn({
        ensureViewer: async () => {
          throw new Error("ECONNREFUSED");
        },
      }),
    });
    down.service.snapshot();
    await down.service.settled();
    await down.service.signIn("github");
    await down.service.settled();
    expect(down.service.snapshot()).toMatchObject({
      state: "signed-in",
      account: { displayName: "Dana", backend: "unreachable" },
      failure: "Couldn't reach Volli Cloud. Your sign-in is kept.",
    });
  });

  it("signs out an account the backend says is deleted", async () => {
    const { service, temp } = harness({
      backend: backendStandIn({
        ensureViewer: async () => {
          throw new BackendRefusedError("This account has been deleted.", "account_deleted");
        },
      }),
    });
    service.snapshot();
    await service.settled();
    await service.signIn("github");
    await service.settled();
    expect(service.snapshot()).toMatchObject({
      state: "signed-out",
      failure: "This account has been deleted.",
    });
    expect(temp.inventory.list("host-private")).toEqual([]);
  });

  it("refuses an unknown button, and a sign-in while restoring", async () => {
    const { service } = harness();
    service.snapshot();
    await expect(service.signIn("github")).rejects.toThrow("Still reading the saved sign-in");
    await service.settled();
    await expect(service.signIn("apple" as never)).rejects.toThrow("Unknown sign-in provider.");
  });
});

async function refusedSignIn(): Promise<BackendViewer> {
  throw new BackendRefusedError("Volli Cloud did not accept this sign-in.", "unauthenticated");
}

describe("the account service's epochs", () => {
  it("opens no browser for a sign-in cancelled before its URL was made", async () => {
    const url = Promise.withResolvers<string>();
    const open = vi.fn();
    const { service } = harness({
      provider: scriptedProvider({ authorizationUrl: () => url.promise }),
      openBrowser: open,
    });
    service.snapshot();
    await service.settled();
    const started = service.signIn("github");
    await vi.waitFor(() => expect(service.snapshot().state).toBe("signing-in"));
    service.cancelSignIn();
    expect(service.snapshot()).toMatchObject({ state: "signed-out", failure: null });
    url.resolve("http://127.0.0.1:1/never");
    await started;
    expect(open).not.toHaveBeenCalled();
  });

  it("drops a sign-in cancelled after the browser came back, and keeps nothing sealed", async () => {
    const exchange = Promise.withResolvers<ProviderTokens>();
    const { service, temp } = harness({
      provider: scriptedProvider({ exchangeCode: () => exchange.promise }),
      openBrowser: scriptedBrowser,
    });
    service.snapshot();
    await service.settled();
    await service.signIn("github");
    service.cancelSignIn();
    exchange.resolve({
      accessToken: "a",
      refreshToken: "r",
      accessExpiresAt: Date.now() + 600_000,
      sessionId: null,
      profile: { displayName: "Dana", email: null },
    });
    await service.settled();
    expect(service.snapshot().state).toBe("signed-out");
    expect(temp.inventory.list("host-private")).toEqual([]);
  });

  it("never leaves a sign-in sealed that a sign-out overtook while it was sealing", async () => {
    const temp = tempInventory();
    cleanups.push(temp.dispose);
    const real = inventoryAccountSessionStore(temp.inventory, async () => {});
    const sealing = Promise.withResolvers<void>();
    const reached = Promise.withResolvers<void>();
    const store = {
      ...real,
      save: async (...args: Parameters<typeof real.save>) => {
        const ref = await real.save(...args);
        reached.resolve();
        await sealing.promise;
        return ref;
      },
    };
    const service = createAccountService({
      enabled: () => true,
      provider: scriptedProvider(),
      backend: null,
      store,
      openBrowser: scriptedBrowser,
    });
    cleanups.push(() => service.dispose());
    service.snapshot();
    await service.settled();
    await service.signIn("github");
    await reached.promise;
    await service.signOut();
    sealing.resolve();
    await service.settled();
    expect(service.snapshot().state).toBe("signed-out");
    expect(temp.inventory.list("host-private")).toEqual([]);
  });

  it("replaces a sign-in in flight with a new one", async () => {
    const { service } = harness({ openBrowser: () => {} });
    service.snapshot();
    await service.settled();
    await service.signIn("github");
    await service.signIn("google");
    expect(service.snapshot()).toMatchObject({ state: "signing-in", signingInWith: "google" });
    service.cancelSignIn();
    await service.settled();
    expect(service.snapshot().state).toBe("signed-out");
  });

  it("says a refused sign-in is not accepted, apart from being offline, and retries on a new window", async () => {
    let answer: () => Promise<BackendViewer> = refusedSignIn;
    const { service } = harness({ backend: backendStandIn({ ensureViewer: () => answer() }) });
    service.snapshot();
    await service.settled();
    await service.signIn("github");
    await service.settled();
    expect(service.snapshot()).toMatchObject({
      account: { backend: "refused" },
      failure: "Volli Cloud didn't accept this sign-in. Sign out and sign in again.",
    });

    answer = async () => {
      throw new Error("offline");
    };
    service.subscribe(() => {});
    await service.settled();
    // Only an unreachable backend is retried on subscribe; refused waits for the person.
    expect(service.snapshot().account).toMatchObject({ backend: "refused" });
  });

  it("retries an unreachable backend when a window subscribes", async () => {
    let up = false;
    const { service } = harness({
      backend: backendStandIn({
        ensureViewer: async () => {
          if (!up) throw new Error("offline");
          return VIEWER;
        },
      }),
    });
    service.snapshot();
    await service.settled();
    await service.signIn("github");
    await service.settled();
    expect(service.snapshot().account).toMatchObject({ backend: "unreachable" });
    up = true;
    service.subscribe(() => {});
    await service.settled();
    expect(service.snapshot()).toMatchObject({
      account: { backend: "synced", userId: VIEWER.userId },
      failure: null,
    });
  });

  it("reads the saved sign-in for a main-side caller that asks for a token first", async () => {
    const temp = tempInventory();
    cleanups.push(temp.dispose);
    const provider = scriptedProvider();
    const first = harness({ provider, openBrowser: scriptedBrowser, temp });
    first.service.snapshot();
    await first.service.settled();
    await first.service.signIn("github");
    await first.service.settled();

    const next = harness({ provider, temp });
    await expect(next.service.accessToken()).resolves.toMatch(/^access-/u);
    const off = harness({ provider, temp, enabled: () => false });
    await expect(off.service.accessToken()).resolves.toBeNull();
  });

  it("keeps a dev sign-in across a relaunch of the app and its issuer", async () => {
    const temp = tempInventory();
    cleanups.push(temp.dispose);
    const key = testKeyPair();
    const before = devIssuerProvider({ privateKeyPem: key.privateKeyPem });
    const first = harness({ provider: before, temp });
    first.service.snapshot();
    await first.service.settled();
    await first.service.signIn("github");
    await first.service.settled();
    first.service.dispose();

    const after = devIssuerProvider({ privateKeyPem: key.privateKeyPem });
    const relaunched = harness({ provider: after, temp });
    relaunched.service.snapshot();
    await relaunched.service.settled();
    expect(relaunched.service.snapshot()).toMatchObject({
      state: "signed-in",
      failure: null,
      account: { backend: "synced" },
    });
  });
});

describe("preview enrollment", () => {
  it("keeps waitlisted sign-ins local and reports the waitlist, never a restart grant", async () => {
    const marker = { write: vi.fn(), clear: vi.fn() };
    const { service } = harness({
      marker,
      backend: backendStandIn({
        ensureViewer: async () => ({ ...VIEWER, previewAccess: "waitlisted" }),
      }),
    });
    expect(service.previewUserId()).toBeNull();
    await service.signIn("github");
    await service.settled();
    expect(service.snapshot()).toMatchObject({
      state: "signed-in",
      account: { backend: "refused" },
      failure: expect.stringContaining("waitlist"),
    });
    expect(service.previewUserId()).toBeNull();
    expect(marker.write).not.toHaveBeenCalled();
    expect(marker.clear).toHaveBeenCalled();
  });
  it("answers a fresh backend grant only until the sign-in ends", async () => {
    const { service } = harness();
    await service.signIn("github");
    await service.settled();
    expect(service.previewUserId()).toBe(VIEWER.userId);
    await service.signOut();
    expect(service.previewUserId()).toBeNull();
  });
});

it("passes an invite code only to this sign-in's backend call and surfaces a refused code", async () => {
  const backend = backendStandIn();
  const { service } = harness({ backend });
  await service.signIn("github", "preview-code-123456");
  await service.settled();
  expect(backend.ensureViewer).toHaveBeenCalledWith(
    expect.any(String),
    "preview-code-123456",
    undefined,
  );
  await service.signOut();
  backend.ensureViewer.mockRejectedValueOnce(
    new BackendRefusedError("This preview invite code is invalid.", "preview_waitlisted"),
  );
  await service.signIn("google", "invalid-code-123456");
  await service.settled();
  expect(service.snapshot()).toMatchObject({
    account: { backend: "refused" },
    failure: "This preview invite code is invalid.",
  });
  expect(service.previewUserId()).toBeNull();
});

it("keeps deletion and restoration answers behind the same preview gate", async () => {
  const backend = backendStandIn({
    ensureViewer: async () => ({ ...VIEWER, previewAccess: "waitlisted" }),
  });
  backend.requestDeletion.mockResolvedValue({
    ...VIEWER,
    previewAccess: "waitlisted",
    status: "deletion_pending",
    purgeAfter: 9999,
  });
  backend.cancelDeletion.mockResolvedValue({ ...VIEWER, previewAccess: "waitlisted" });
  const marker = { write: vi.fn(), clear: vi.fn() };
  const { service } = harness({ backend, marker });
  await service.signIn("github");
  await service.settled();
  await service.requestDeletion();
  expect(service.snapshot().account?.backend).toBe("synced");
  expect(service.snapshot().failure).toBeNull();
  await service.cancelDeletion();
  expect(service.snapshot()).toMatchObject({
    account: { backend: "refused" },
    failure: expect.stringContaining("waitlist"),
  });
  expect(service.previewUserId()).toBeNull();
  expect(marker.write).not.toHaveBeenCalled();
});

it("retries a transient backend failure with the same in-memory invite code", async () => {
  const backend = backendStandIn();
  backend.ensureViewer.mockRejectedValueOnce(new Error("offline"));
  const { service } = harness({ backend });
  await service.signIn("github", "preview-code-123456", "current-version");
  await service.settled();
  expect(service.snapshot().account?.backend).toBe("unreachable");
  const unsubscribe = service.subscribe(() => {});
  await service.settled();
  unsubscribe();
  expect(backend.ensureViewer).toHaveBeenNthCalledWith(
    2,
    expect.any(String),
    "preview-code-123456",
    "current-version",
  );
  expect(service.previewUserId()).toBe(VIEWER.userId);
});

it("sends explicit current-version acceptance only for enrollment, never for restored token refresh", async () => {
  const temp = tempInventory();
  cleanups.push(temp.dispose);
  const backend = backendStandIn();
  const provider = scriptedProvider();
  const first = harness({ provider, openBrowser: scriptedBrowser, temp, backend });
  await first.service.signIn("github", undefined, "current-version");
  await first.service.settled();
  expect(backend.ensureViewer).toHaveBeenCalledWith(
    expect.any(String),
    undefined,
    "current-version",
  );
  first.service.dispose();
  const nextBackend = backendStandIn({
    ensureViewer: async () => ({ ...VIEWER, previewAgreementAccepted: false }),
  });
  const next = harness({ provider, temp, backend: nextBackend });
  next.service.snapshot();
  await next.service.settled();
  expect(nextBackend.ensureViewer).toHaveBeenCalledWith(expect.any(String), undefined, undefined);
  expect(next.service.previewUserId()).toBeNull();
  expect(next.service.snapshot()).toMatchObject({
    account: { backend: "refused" },
    failure: expect.stringContaining("Preview Agreement"),
  });
});
