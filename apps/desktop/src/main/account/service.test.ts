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
import { SourceIconCache } from "../../../../../packages/host-core/src/source-icons/cache";
import { SourceIconRefiner } from "../../../../../packages/host-core/src/source-icons/refiner";
import type { StoredSourceIcon } from "../../../../../packages/host-core/src/source-icons/storage";

const ICON_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/6ZkAAAAASUVORK5CYII=",
  "base64",
);
const ICON_ORIGIN = "https://source.example.com";

const VIEWER: BackendViewer = {
  previewAccess: "granted",
  previewAgreementAccepted: true,
  userId: "6b4c3a1e-2a9f-4c3e-9d1b-0f8e7d6c5b4a",
  displayName: "Dana from Volli",
  primaryEmail: "dana@example.com",
  status: "active",
  purgeAfter: null,
  joinedWorkspaceId: null,
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
    now?: () => number;
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
    ...(options.now === undefined ? {} : { now: options.now }),
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
  it("source icon epochs are non-restoring and change across same-account revocation", async () => {
    const off = harness({ enabled: () => false });
    expect(off.service.sourceIconEpoch()).toBe(off.service.sourceIconEpoch());
    expect(off.backend.ensureViewer).not.toHaveBeenCalled();
    expect(off.web.open).not.toHaveBeenCalled();
    const live = harness({ provider: scriptedProvider(), openBrowser: scriptedBrowser });
    const first = live.service.sourceIconEpoch();
    await live.service.signIn("github");
    const signedIn = live.service.sourceIconEpoch();
    expect(signedIn).not.toBe(first);
    await live.service.signOut();
    expect(live.service.sourceIconEpoch()).not.toBe(signedIn);
    await live.service.signIn("github");
    expect(live.service.sourceIconEpoch()).not.toBe(signedIn);
  });
  it("keeps source icon ownership unresolved through saved-account/backend restoration without starting it", async () => {
    const first = harness({ provider: scriptedProvider(), openBrowser: scriptedBrowser });
    await first.service.signIn("github");
    await first.service.settled();
    const owner = first.service.sourceIconOwner();
    const backendGate = Promise.withResolvers<BackendViewer>();
    const backend = backendStandIn({ ensureViewer: () => backendGate.promise });
    const store = inventoryAccountSessionStore(first.temp.inventory, async () => {});
    const load = vi.spyOn(store, "load");
    const next = createAccountService({
      enabled: () => true,
      provider: scriptedProvider(),
      backend,
      store,
      openBrowser: () => {},
    });
    cleanups.push(() => next.dispose());
    const changed = vi.fn();
    const stop = next.watchSourceIconAuthority(changed);
    try {
      const initialGeneration = next.sourceIconRevocation();
      expect(next.sourceIconRestoring()).toBe(false); // untouched Account is known local mode
      expect(next.sourceIconOwner()).not.toBeNull();
      expect(next.sourceIconEpoch()).not.toBeNull();
      expect(load).not.toHaveBeenCalled(); // decoration getters/listeners never restore credentials
      next.snapshot();
      const savedId = "00000000-0000-4000-8000-000000000003";
      const cache = new SourceIconCache({
        authorityForSession: () => next.sourceIconEpoch(),
        persistentAuthorityForSession: () => next.sourceIconOwner(),
        restorationPendingForSession: () => next.sourceIconRestoring(),
        revocationGeneration: () => next.sourceIconRevocation(),
        persistence: {
          load: async () => [
            {
              id: savedId,
              sessionId: "session",
              authority: owner!,
              origin: ICON_ORIGIN,
              expiresAt: Date.now() + 60_000,
              bytes: ICON_PNG,
            },
          ],
          save: () => {},
        },
      });
      const stopCache = next.watchSourceIconAuthority(() => cache.invalidate());
      cleanups.push(() => {
        stopCache();
        cache.close();
      });
      await cache.hydrated;
      expect(cache.picture("session", savedId).data).toBeNull();
      await vi.waitFor(() => expect(backend.ensureViewer).toHaveBeenCalledOnce());
      expect(next.sourceIconRestoring()).toBe(true);
      expect(next.sourceIconOwner()).toBeNull();
      expect(next.sourceIconEpoch()).toBeNull();
      backendGate.resolve(VIEWER);
      await next.settled();
      expect(next.sourceIconRestoring()).toBe(false);
      expect(next.sourceIconOwner()).toBe(owner);
      expect(next.sourceIconEpoch()).not.toBeNull();
      expect(next.sourceIconRevocation()).toBe(initialGeneration); // initial restore is not a refusal
      expect(cache.picture("session", savedId).data).not.toBeNull();
      expect(changed).toHaveBeenCalled();
      stop();
      changed.mockClear();
      await next.signOut();
      expect(next.sourceIconOwner()).not.toBe(owner);
      expect(changed).not.toHaveBeenCalled();
    } finally {
      backendGate.resolve(VIEWER);
      stop();
      await next.settled();
    }
  });

  it("resumes a known icon watch across temporary same-grant uncertainty but never across refusal ABA", async () => {
    let now = Date.now();
    const provider = scriptedProvider();
    const refresh = vi.fn(provider.refresh);
    const h = harness({
      provider: { ...provider, refresh },
      now: () => now,
      openBrowser: scriptedBrowser,
    });
    await h.service.signIn("github");
    await h.service.settled();
    const grant = h.service.sourceIconEpoch()!;
    const generation = h.service.sourceIconRevocation();
    const owner = h.service.sourceIconOwner();
    const cache = new SourceIconCache({
      authorityForSession: () => h.service.sourceIconEpoch(),
      persistentAuthorityForSession: () => h.service.sourceIconOwner(),
      restorationPendingForSession: () => h.service.sourceIconRestoring(),
      revocationGeneration: () => h.service.sourceIconRevocation(),
    });
    const stopAuthority = h.service.watchSourceIconAuthority(() => cache.invalidate());
    const emit = vi.fn();
    const stopWatch = cache.watch({ sessionId: "session", origins: [ICON_ORIGIN] }, emit);
    cleanups.push(() => {
      stopAuthority();
      stopWatch();
      cache.close();
    });
    const id = cache.put("session", grant, ICON_ORIGIN, ICON_PNG)!;
    expect(emit.mock.calls.at(-1)![0].icons[0].pictureId).toBe(id);
    now += 20 * 60_000;
    refresh.mockRejectedValueOnce(new Error("temporarily offline"));
    await expect(h.service.accessToken()).rejects.toThrow("temporarily offline");
    expect(h.service.sourceIconRestoring()).toBe(true);
    expect(h.service.sourceIconRevocation()).toBe(generation);
    expect(h.service.sourceIconEpoch()).toBeNull();
    expect(emit.mock.calls.at(-1)![0].icons[0].pictureId).toBeNull();
    expect(cache.picture("session", id).data).toBeNull();
    await h.service.cancelDeletion();
    expect(h.service.sourceIconEpoch()).toBe(grant);
    expect(h.service.sourceIconOwner()).toBe(owner);
    expect(h.service.sourceIconRevocation()).toBe(generation);
    expect(emit.mock.calls.at(-1)![0].icons[0].pictureId).toBe(id); // SAME subscription, SAME grant
    h.backend.cancelDeletion.mockResolvedValueOnce({ ...VIEWER, previewAccess: "waitlisted" });
    await h.service.cancelDeletion();
    expect(h.service.sourceIconRestoring()).toBe(false);
    expect(h.service.sourceIconEpoch()).toBeNull();
    const refusedGeneration = h.service.sourceIconRevocation();
    expect(refusedGeneration).not.toBe(generation);
    await h.service.cancelDeletion(); // same viewer and provider Session, without auth sign-out/sign-in
    expect(h.service.sourceIconOwner()).toBe(owner);
    expect(h.service.sourceIconRevocation()).toBe(refusedGeneration);
    expect(h.service.sourceIconEpoch()).not.toBe(grant);
    expect(cache.picture("session", id).data).toBeNull();
    const count = emit.mock.calls.length;
    cache.put("session", h.service.sourceIconEpoch()!, ICON_ORIGIN, ICON_PNG);
    expect(emit).toHaveBeenCalledTimes(count); // definitive refusal terminated the old watch
    expect(emit.mock.calls.at(-1)![0].icons[0].pictureId).toBeNull();
  });

  it.each([
    ["foreground completion", "policy refusal"],
    ["acquisition", "policy refusal"],
    ["foreground completion", "backend refusal"],
    ["acquisition", "backend refusal"],
    ["foreground completion", "requestDeletion refusal"],
    ["acquisition", "requestDeletion refusal"],
    ["foreground completion", "cancelDeletion refusal"],
    ["acquisition", "cancelDeletion refusal"],
  ] as const)(
    "rejects an icon %s held across %s and same-owner recovery",
    async (phase, refusal) => {
      let now = Date.now();
      const provider = scriptedProvider();
      const refresh = vi.fn(provider.refresh);
      const h = harness({
        provider: { ...provider, refresh },
        now: () => now,
        openBrowser: scriptedBrowser,
      });
      await h.service.signIn("github");
      await h.service.settled();
      const oldGrant = h.service.sourceIconEpoch()!;
      const owner = h.service.sourceIconOwner();
      const cache = new SourceIconCache({
        authorityForSession: () => h.service.sourceIconEpoch(),
        persistentAuthorityForSession: () => h.service.sourceIconOwner(),
        restorationPendingForSession: () => h.service.sourceIconRestoring(),
        revocationGeneration: () => h.service.sourceIconRevocation(),
      });
      const stop = h.service.watchSourceIconAuthority(() => cache.invalidate());
      const priorPicture = cache.put("session", oldGrant, "https://prior.example.com", ICON_PNG)!;
      expect(cache.picture("session", priorPicture).data).not.toBeNull();
      const gate = Promise.withResolvers<{ bytes: Uint8Array; mime: "image/png" } | null>();
      // Queue/authority boundary only. Real transport and decoder tests remain separate.
      const acquire = vi.fn(() => gate.promise);
      const decode = vi.fn(async () => Uint8Array.from(ICON_PNG));
      const refiner = new SourceIconRefiner({ cache, acquire, decode, log: () => {} });
      cleanups.push(async () => {
        gate.resolve(null);
        refiner.close();
        await refiner.settled();
        stop();
        cache.close();
      });
      const signal = new AbortController().signal;
      const candidate = { origin: ICON_ORIGIN, url: `${ICON_ORIGIN}/icon` };
      const completion = refiner.beginRead("session", signal)!;
      if (phase === "acquisition") {
        completion(candidate, signal);
        await vi.waitFor(() => expect(acquire).toHaveBeenCalledOnce());
        refiner.beginRead("session", signal)!(
          { origin: "https://queued.example.com", url: "https://queued.example.com/icon" },
          signal,
        );
      }
      if (refusal === "requestDeletion refusal" || refusal === "cancelDeletion refusal") {
        const mutation =
          refusal === "requestDeletion refusal" ? "requestDeletion" : "cancelDeletion";
        const before = h.service.snapshot();
        const error = new BackendRefusedError(
          "Sign-in refused by account mutation",
          "unauthenticated",
        );
        h.backend[mutation].mockRejectedValueOnce(error);
        await expect(h.service[mutation]()).rejects.toBe(error);
        expect(h.service.snapshot()).toEqual(before); // no canonical auth/snapshot rewrite on failed mutation
      } else if (refusal === "backend refusal") {
        now += 20 * 60_000;
        refresh.mockRejectedValueOnce(new Error("temporarily offline"));
        await expect(h.service.accessToken()).rejects.toThrow("temporarily offline");
        h.backend.ensureViewer.mockRejectedValueOnce(
          new BackendRefusedError("Sign-in refused", "unauthenticated"),
        );
        const stopAccount = h.service.subscribe(() => {}); // real offline-recovery syncViewer path
        await h.service.settled();
        stopAccount();
      } else {
        h.backend.cancelDeletion.mockResolvedValueOnce({ ...VIEWER, previewAccess: "waitlisted" });
        await h.service.cancelDeletion();
      }
      expect(h.service.sourceIconRestoring()).toBe(false);
      expect(h.service.sourceIconEpoch()).toBeNull();
      expect(cache.picture("session", priorPicture).data).toBeNull();
      expect(cache.put("session", oldGrant, "https://prior.example.com", ICON_PNG)).toBeNull();
      await h.service.cancelDeletion();
      expect(h.service.sourceIconOwner()).toBe(owner);
      expect(h.service.sourceIconEpoch()).not.toBe(oldGrant);
      expect(cache.picture("session", priorPicture).data).toBeNull();
      if (phase === "foreground completion") completion(candidate, signal);
      gate.resolve({ bytes: ICON_PNG, mime: "image/png" });
      await refiner.settled();
      // Let any old queued job reach its own grant check, not just the active job's settlement.
      await new Promise<void>((resolve) => setImmediate(resolve));
      await refiner.settled();
      expect(acquire).toHaveBeenCalledTimes(phase === "acquisition" ? 1 : 0);
      expect(decode).not.toHaveBeenCalled();
      expect(cache.has("session", h.service.sourceIconEpoch()!, ICON_ORIGIN)).toBe(false);
      refiner.beginRead("session", signal)!(candidate, signal);
      await vi.waitFor(() =>
        expect(cache.has("session", h.service.sourceIconEpoch()!, ICON_ORIGIN)).toBe(true),
      );
      expect(acquire).toHaveBeenCalledTimes(phase === "acquisition" ? 2 : 1);
    },
  );

  it.each(["requestDeletion", "cancelDeletion"] as const)(
    "keeps current account B decoration when an old account A %s rejects",
    async (mutation) => {
      const h = harness({ provider: scriptedProvider(), openBrowser: scriptedBrowser });
      await h.service.signIn("github");
      await h.service.settled();
      const pending = Promise.withResolvers<never>();
      const error = new BackendRefusedError("Old account refused", "unauthenticated");
      h.backend[mutation].mockImplementationOnce(() => pending.promise);
      const outcome = h.service[mutation]().catch((caught: unknown) => caught);
      cleanups.push(async () => {
        pending.reject(error);
        await outcome;
      });
      await vi.waitFor(() => expect(h.backend[mutation]).toHaveBeenCalledOnce());
      await h.service.signOut();
      h.backend.ensureViewer.mockResolvedValueOnce({ ...VIEWER, userId: "account-b" });
      await h.service.signIn("github");
      await h.service.settled();
      const before = h.service.snapshot();
      expect(before.account?.userId).toBe("account-b");
      const grant = h.service.sourceIconEpoch()!;
      const generation = h.service.sourceIconRevocation();
      const cache = new SourceIconCache({
        authorityForSession: () => h.service.sourceIconEpoch(),
        persistentAuthorityForSession: () => h.service.sourceIconOwner(),
        restorationPendingForSession: () => h.service.sourceIconRestoring(),
        revocationGeneration: () => h.service.sourceIconRevocation(),
      });
      const changed = vi.fn(() => cache.invalidate());
      const stop = h.service.watchSourceIconAuthority(changed);
      cleanups.push(() => {
        stop();
        cache.close();
      });
      const picture = cache.put("session-b", grant, ICON_ORIGIN, ICON_PNG)!;
      pending.reject(error);
      expect(await outcome).toBe(error);
      expect(h.service.snapshot()).toEqual(before);
      expect(h.service.sourceIconEpoch()).toBe(grant);
      expect(h.service.sourceIconRevocation()).toBe(generation);
      expect(changed).not.toHaveBeenCalled();
      expect(cache.picture("session-b", picture).data).not.toBeNull();
    },
  );

  it.each(["requestDeletion", "cancelDeletion"] as const)(
    "preserves decoration and the original %s failure for transient/business-rule errors",
    async (mutation) => {
      const h = harness({ provider: scriptedProvider(), openBrowser: scriptedBrowser });
      await h.service.signIn("github");
      await h.service.settled();
      const before = h.service.snapshot();
      const grant = h.service.sourceIconEpoch()!;
      const generation = h.service.sourceIconRevocation();
      const cache = new SourceIconCache({
        authorityForSession: () => h.service.sourceIconEpoch(),
        persistentAuthorityForSession: () => h.service.sourceIconOwner(),
        restorationPendingForSession: () => h.service.sourceIconRestoring(),
        revocationGeneration: () => h.service.sourceIconRevocation(),
      });
      const changed = vi.fn(() => cache.invalidate());
      const stop = h.service.watchSourceIconAuthority(changed);
      cleanups.push(() => {
        stop();
        cache.close();
      });
      const picture = cache.put("session", grant, ICON_ORIGIN, ICON_PNG)!;
      for (const error of [
        new Error("temporarily offline"),
        new BackendRefusedError("Still an owner", "sole_owner"),
        new BackendRefusedError("Purge already started", "purge_started"),
        new BackendRefusedError("No typed authorization refusal", null),
      ]) {
        h.backend[mutation].mockRejectedValueOnce(error);
        await expect(h.service[mutation]()).rejects.toBe(error);
        expect(h.service.snapshot()).toEqual(before);
        expect(h.service.sourceIconEpoch()).toBe(grant);
        expect(h.service.sourceIconRevocation()).toBe(generation);
        expect(changed).not.toHaveBeenCalled();
        expect(cache.picture("session", picture).data).not.toBeNull();
      }
      // The same mutation can subsequently succeed without inventing a sign-in transition.
      await h.service[mutation]();
      expect(h.service.sourceIconEpoch()).toBe(grant);
      expect(h.service.sourceIconRevocation()).toBe(generation);
      expect(cache.picture("session", picture).data).not.toBeNull();
      expect(h.service.snapshot().account?.deletionPurgeAfter).toBe(
        mutation === "requestDeletion" ? 9_999 : null,
      );
    },
  );

  it.each(["requestDeletion", "cancelDeletion"] as const)(
    "revokes decoration for current-epoch account authorization refusals from %s without changing auth snapshots",
    async (mutation) => {
      const h = harness({ provider: scriptedProvider(), openBrowser: scriptedBrowser });
      await h.service.signIn("github");
      await h.service.settled();
      const cache = new SourceIconCache({
        authorityForSession: () => h.service.sourceIconEpoch(),
        persistentAuthorityForSession: () => h.service.sourceIconOwner(),
        restorationPendingForSession: () => h.service.sourceIconRestoring(),
        revocationGeneration: () => h.service.sourceIconRevocation(),
      });
      const stop = h.service.watchSourceIconAuthority(() => cache.invalidate());
      cleanups.push(() => {
        stop();
        cache.close();
      });
      for (const code of [
        "account_deleted",
        "no_viewer",
        "identity_conflict",
        "not_a_person",
        "account_deletion_pending",
        "forbidden",
        "suspended",
      ]) {
        const before = h.service.snapshot();
        const grant = h.service.sourceIconEpoch()!;
        const generation = h.service.sourceIconRevocation();
        const picture = cache.put("session", grant, ICON_ORIGIN, ICON_PNG)!;
        const error = new BackendRefusedError(`Account refusal: ${code}`, code);
        h.backend[mutation].mockRejectedValueOnce(error);
        await expect(h.service[mutation]()).rejects.toBe(error);
        expect(h.service.snapshot()).toEqual(before);
        expect(h.service.sourceIconEpoch()).toBeNull();
        expect(h.service.sourceIconRevocation()).not.toBe(generation);
        expect(cache.picture("session", picture).data).toBeNull();
        expect(cache.put("session", grant, ICON_ORIGIN, ICON_PNG)).toBeNull();
        await h.service.cancelDeletion();
        expect(h.service.sourceIconEpoch()).not.toBe(grant);
        expect(cache.picture("session", picture).data).toBeNull();
        expect(
          cache.put("session", h.service.sourceIconEpoch()!, ICON_ORIGIN, ICON_PNG),
        ).not.toBeNull();
      }
    },
  );

  it("retains refusal evidence during pending icon hydration without discarding unrelated new live writes", async () => {
    const h = harness({ provider: scriptedProvider(), openBrowser: scriptedBrowser });
    await h.service.signIn("github");
    await h.service.settled();
    const owner = h.service.sourceIconOwner()!;
    const oldId = "00000000-0000-4000-8000-000000000001";
    const newId = "00000000-0000-4000-8000-000000000002";
    const load = Promise.withResolvers<StoredSourceIcon[]>();
    const save = vi.fn();
    const cache = new SourceIconCache({
      createId: () => newId,
      authorityForSession: () => h.service.sourceIconEpoch(),
      persistentAuthorityForSession: () => h.service.sourceIconOwner(),
      restorationPendingForSession: () => h.service.sourceIconRestoring(),
      revocationGeneration: () => h.service.sourceIconRevocation(),
      persistence: { load: () => load.promise, save },
    });
    const stop = h.service.watchSourceIconAuthority(() => cache.invalidate());
    cleanups.push(async () => {
      load.resolve([]);
      await cache.hydrated;
      stop();
      cache.close();
    });
    h.backend.cancelDeletion.mockResolvedValueOnce({ ...VIEWER, previewAccess: "waitlisted" });
    await h.service.cancelDeletion(); // no loaded rows exist to invalidate yet
    await h.service.cancelDeletion(); // same stable owner is now authorised again
    expect(h.service.sourceIconOwner()).toBe(owner);
    const live = cache.put(
      "other-session",
      h.service.sourceIconEpoch()!,
      "https://new.example.com",
      ICON_PNG,
    );
    expect(live).toBe(newId);
    expect(save).not.toHaveBeenCalled();
    load.resolve([
      {
        id: oldId,
        sessionId: "session",
        authority: owner,
        origin: ICON_ORIGIN,
        expiresAt: Date.now() + 60_000,
        bytes: ICON_PNG,
      },
    ]);
    await cache.hydrated;
    expect(cache.picture("session", oldId).data).toBeNull();
    expect(cache.picture("other-session", newId).data).not.toBeNull();
    expect(save).toHaveBeenLastCalledWith([
      {
        id: newId,
        sessionId: "other-session",
        authority: owner,
        origin: "https://new.example.com",
        expiresAt: expect.any(Number),
        bytes: Uint8Array.from(ICON_PNG),
      },
    ]); // no live generation or grant is serialized
  });

  it("source icon owner hashes distinguish accounts even when their local epochs and provider session ids coincide", async () => {
    const one = harness({ provider: scriptedProvider(), openBrowser: scriptedBrowser });
    const two = harness({
      provider: scriptedProvider(),
      openBrowser: scriptedBrowser,
      backend: backendStandIn({
        ensureViewer: async () => ({ ...VIEWER, userId: "different-account" }),
      }),
    });
    await one.service.signIn("github");
    await two.service.signIn("github");
    expect(one.service.sourceIconOwner()).toMatch(/^[a-f0-9]{64}$/);
    expect(one.service.sourceIconOwner()).not.toBe(two.service.sourceIconOwner());
    expect(one.service.sourceIconEpoch()).not.toBe(two.service.sourceIconEpoch());
  });

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

it("records a Workspace a team code joined for the next launch, and keeps it across later checks", async () => {
  const backend = backendStandIn();
  backend.ensureViewer.mockResolvedValueOnce({ ...VIEWER, joinedWorkspaceId: "team" });
  const marker = { write: vi.fn(), clear: vi.fn() };
  const { service } = harness({ backend, marker });
  await service.signIn("github", "team-code-1234567890", "current-version");
  await service.settled();
  expect(marker.write).toHaveBeenLastCalledWith(VIEWER.userId, "team");
  // A later answer names no join: the marker store keeps the recorded one.
  await service.cancelDeletion();
  expect(marker.write).toHaveBeenLastCalledWith(VIEWER.userId);
});

it("surfaces a team code that cannot be joined with, and never resends it", async () => {
  for (const code of ["invite_invalid", "invite_expired", "invite_email_mismatch", "suspended"]) {
    const backend = backendStandIn();
    backend.ensureViewer.mockRejectedValueOnce(new BackendRefusedError(`Refused: ${code}.`, code));
    const marker = { write: vi.fn(), clear: vi.fn() };
    const { service } = harness({ backend, marker });
    await service.signIn("github", "team-code-1234567890", "current-version");
    await service.settled();
    expect(service.snapshot()).toMatchObject({
      account: { backend: "refused" },
      failure: `Refused: ${code}.`,
    });
    expect(service.previewUserId()).toBeNull();
    expect(service.sourceIconRestoring()).toBe(false); // refusal is not startup uncertainty
    expect(service.sourceIconOwner()).toBeNull();
    expect(service.sourceIconEpoch()).toBeNull();
    expect(marker.write).not.toHaveBeenCalled();
    service.subscribe(() => {});
    await service.settled();
    // A refused sign-in is not retried: the backend said why, and the person acts on it.
    expect(backend.ensureViewer).toHaveBeenCalledOnce();
    await service.signOut();
  }
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

it("shows the typed outdated-agreement message without granting cloud access", async () => {
  const marker = { write: vi.fn(), clear: vi.fn() };
  const message = "Update Volli to accept the current Preview Agreement.";
  const { service } = harness({
    marker,
    backend: backendStandIn({
      ensureViewer: async () => {
        throw new BackendRefusedError(message, "preview_agreement_required");
      },
    }),
  });
  await service.signIn("github", undefined, "preview-0.3-2026-10-25");
  await service.settled();
  expect(service.snapshot()).toMatchObject({
    state: "signed-in",
    account: { backend: "refused", userId: null },
    failure: message,
  });
  expect(service.previewUserId()).toBeNull();
  expect(marker.write).not.toHaveBeenCalled();
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
