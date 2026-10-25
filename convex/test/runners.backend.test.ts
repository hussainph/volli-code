/**
 * A runner's whole registration against the real pinned backend, driven by
 * the runner-side client in `@volli/host-core/cloud-runner`: link with an
 * install token and with a device code, exchange the credential for a real
 * runner token (signed inside the backend, verified by its auth config),
 * heartbeat and report with that token, and get cut off for reusing a
 * credential.
 */
import { randomUUID } from "node:crypto";

import { ConvexHttpClient } from "convex/browser";
import { describe, expect, test } from "vite-plus/test";

import {
  createRunnerLinkClient,
  createRunnerPresence,
  createRunnerTokenSource,
  linkWithDeviceCode,
  linkWithInstallToken,
  probeRunnerCapabilities,
  runnerHostFacts,
  runnerPresenceBackend,
  type RunnerLink,
  type RunnerLinkStore,
} from "@volli/host-core/cloud-runner";
import { makeFunctionReference } from "convex/server";

import { api } from "../functions/_generated/api";
import { connectBackend } from "../fixture/testing";

const backend = connectBackend();
const subject = () => `user:${randomUUID()}`;

function memoryStore(): RunnerLinkStore & { current(): RunnerLink | null } {
  let saved: RunnerLink | null = null;
  return {
    load: async () => saved,
    save: async (identity) => {
      saved = { ...identity };
    },
    clear: async () => {
      saved = null;
    },
    current: () => saved,
  };
}

async function person() {
  const client = backend.client(subject());
  await client.mutation(api.accounts.ensureViewer, {});
  return client;
}

/** A Convex client authenticated as the runner, through its token source. */
async function runnerClient(token: string | null) {
  const client = new ConvexHttpClient(backend.url);
  if (token === null) throw new Error("no runner token");
  client.setAuth(token);
  return client;
}

const linkClient = createRunnerLinkClient({ siteUrl: backend.siteUrl });
const host = runnerHostFacts("user");

describe("runner registration on the pinned local backend", () => {
  test("install token → credential → runner token → heartbeat and capabilities → online in Settings", async () => {
    const alice = await person();
    const { installToken, installTokenId } = await alice.action(api.runners.createInstallToken, {
      nameHint: null,
      defaultWorkspaceId: null,
    });
    const store = memoryStore();
    const identity = await linkWithInstallToken({ client: linkClient, store, host, installToken });
    expect(store.current()?.credential).toBe(identity.credential);
    await expect(
      alice.query(api.runners.installTokenStatus, { installTokenId }),
    ).resolves.toMatchObject({
      state: "used",
      runner: { id: identity.runnerId, status: "offline" },
    });

    const tokens = createRunnerTokenSource({ client: linkClient, store });
    const token = await tokens.token();
    // The rotated credential is what the box holds now.
    expect(store.current()?.credential).not.toBe(identity.credential);
    expect(store.current()?.generation).toBe(2);

    const runner = await runnerClient(token);
    const presence = createRunnerPresence({
      backend: runnerPresenceBackend((name, args) =>
        runner.mutation(makeFunctionReference<"mutation">(name), args),
      ),
      bootId: randomUUID(),
      readLoad: () => ({
        activeSessions: 0,
        activeTurns: 0,
        queueDepth: 0,
        freeDiskMb: 1,
        freeMemMb: 1,
      }),
      readCapabilities: () =>
        probeRunnerCapabilities({
          version: "0.3.0-test",
          installMode: "user",
          terminals: false,
          browser: { state: "unavailable", reason: "not composed" },
          docker: false,
          maxConcurrentSessions: 2,
          tools: [],
          localCredentials: [],
        }),
      timers: { setInterval: () => 0, clearInterval: () => {} },
    });
    await presence.start();
    expect(presence.connected).toBe(true);

    const listed = await alice.query(api.runners.list, {});
    expect(listed).toEqual([
      expect.objectContaining({ id: identity.runnerId, status: "online", version: "0.3.0-test" }),
    ]);

    await presence.stop();
    await expect(alice.query(api.runners.list, {})).resolves.toEqual([
      expect.objectContaining({ status: "stopped" }),
    ]);

    // A person's token is not a runner's, and a runner's is not a person's.
    await expect(
      alice.mutation(api.runners.heartbeat, {
        bootId: "b",
        load: { activeSessions: 0, activeTurns: 0, queueDepth: 0, freeDiskMb: 1, freeMemMb: 1 },
      }),
    ).rejects.toMatchObject({ data: { code: "not_a_runner" } });
    await expect(runner.mutation(api.accounts.ensureViewer, {})).rejects.toMatchObject({
      data: { code: "not_a_person" },
    });
  });

  test("a device code approved in Settings links the box", async () => {
    const alice = await person();
    const store = memoryStore();
    const outcome = await linkWithDeviceCode({
      client: linkClient,
      store,
      host,
      // The person types the code, sees which machine asks, and approves it.
      showCode: (userCode) => {
        void (async () => {
          const preview = await alice.mutation(api.runners.previewLink, { userCode });
          if (!preview.ok) throw new Error(`preview failed: ${preview.code}`);
          expect(preview.hostname).toBe(host.hostname);
          await alice.mutation(api.runners.decideLink, {
            requestId: preview.requestId,
            userCode,
            decision: "approve",
          });
        })();
      },
      sleep: (ms) => new Promise((done) => setTimeout(done, Math.min(ms, 200))),
    });
    expect(outcome.status).toBe("linked");
    const listed = await alice.query(api.runners.list, {});
    expect(listed).toEqual([
      expect.objectContaining({
        linkedVia: "device_code",
        kind: host.platform.os === "darwin" ? "mac" : "linux",
      }),
    ]);
  });

  test("a copied credential used after the box rotated revokes the runner; the token source reports it", async () => {
    const alice = await person();
    const { installToken } = await alice.action(api.runners.createInstallToken, {
      nameHint: "copied",
      defaultWorkspaceId: null,
    });
    const store = memoryStore();
    const linked = await linkWithInstallToken({ client: linkClient, store, host, installToken });
    const copy = { ...linked };

    const box = createRunnerTokenSource({ client: linkClient, store });
    const runner = await runnerClient(await box.token());
    await runner.mutation(api.runners.heartbeat, {
      bootId: "b",
      load: { activeSessions: 0, activeTurns: 0, queueDepth: 0, freeDiskMb: 1, freeMemMb: 1 },
    });

    const thiefStore = memoryStore();
    await thiefStore.save(copy);
    const lost: string[] = [];
    const thief = createRunnerTokenSource({
      client: linkClient,
      store: thiefStore,
      onLinkLost: (reason) => lost.push(reason),
    });
    await expect(thief.token()).resolves.toBeNull();
    expect(lost).toEqual(["revoked"]);

    await expect(alice.query(api.runners.list, {})).resolves.toEqual([
      expect.objectContaining({
        id: linked.runnerId,
        status: "revoked",
        statusReason: "credential_reuse",
      }),
    ]);
    // The box's live token stops at once, not when it expires.
    await expect(
      runner.mutation(api.runners.heartbeat, {
        bootId: "b",
        load: { activeSessions: 0, activeTurns: 0, queueDepth: 0, freeDiskMb: 1, freeMemMb: 1 },
      }),
    ).rejects.toMatchObject({ data: { code: "revoked" } });
    await expect(box.token({ forceRefreshToken: true })).resolves.toBeNull();
  });
});
