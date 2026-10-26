/**
 * The runner's backend link over a real WebSocket (`ConvexClient`) against
 * the pinned backend: runner-token auth through the token source, the
 * presence loop's mutations through the shared gate, and a forced
 * reconnect that keeps the runner online.
 */
import { randomUUID } from "node:crypto";

import { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { describe, expect, test } from "vite-plus/test";

import {
  convexBackendConnection,
  createBackendLink,
  createMutationGate,
  createRunnerLinkClient,
  createRunnerPresence,
  createRunnerTokenSource,
  linkWithInstallToken,
  runnerHostFacts,
  runnerPresenceBackend,
  type RunnerLink,
  type RunnerLinkStore,
} from "@volli/host-core/cloud-runner";

import { api } from "../functions/_generated/api";
import { connectBackend } from "../fixture/testing";
import { enrollBackendPreview } from "./preview-fixtures";

const backend = connectBackend();

function memoryStore(): RunnerLinkStore {
  let saved: RunnerLink | null = null;
  return {
    load: async () => saved,
    save: async (link) => void (saved = { ...link }),
    clear: async () => void (saved = null),
  };
}

const until = async (check: () => Promise<boolean>, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((done) => setTimeout(done, 50));
  }
};

describe("the runner's backend link on the pinned local backend", () => {
  test("a WebSocket link signs in with the runner token, beats, reconnects, and stops cleanly", async () => {
    const person = backend.client(`user:${randomUUID()}`);
    const { userId } = await person.mutation(api.accounts.ensureViewer, {});
    // The link below is this account's: its grant is what the runner rechecks.
    await enrollBackendPreview(backend, person, userId);
    const { installToken } = await person.action(api.runners.createInstallToken, {
      nameHint: "ws-box",
      defaultWorkspaceId: null,
    });
    const links = createRunnerLinkClient({ siteUrl: backend.siteUrl });
    const store = memoryStore();
    await linkWithInstallToken({
      client: links,
      store,
      host: runnerHostFacts("user"),
      installToken,
    });
    const tokens = createRunnerTokenSource({ client: links, store });

    const connect = convexBackendConnection(backend.url, { ConvexClient, makeFunctionReference });
    let connections = 0;
    const link = createBackendLink({
      connect: (token) => {
        connections += 1;
        return connect(token);
      },
      token: (options) => tokens.token(options),
      gate: createMutationGate(),
    });
    await until(async () => link.status.state === "connected");

    const presence = createRunnerPresence({
      backend: runnerPresenceBackend(link.call),
      bootId: randomUUID(),
      readLoad: () => ({
        activeSessions: 0,
        activeTurns: 0,
        queueDepth: 0,
        freeDiskMb: 1,
        freeMemMb: 1,
      }),
      readCapabilities: () => ({
        version: "0.3.0-ws",
        platform: { os: "linux", distro: null, kernel: null, arch: "x64", glibc: null },
        installMode: "user",
        capabilities: {
          v: 1,
          nodeVersion: process.versions.node,
          cpuCount: 1,
          memTotalMb: 1,
          git: null,
          docker: false,
          terminals: "unavailable",
          browser: { state: "unavailable", reason: "test" },
          maxConcurrentSessions: 1,
          tools: [],
        },
        localCredentials: [],
      }),
      timers: { setInterval: () => 0, clearInterval: () => {} },
    });
    await presence.start();
    expect(presence.connected).toBe(true);
    await expect(person.query(api.runners.list, {})).resolves.toEqual([
      expect.objectContaining({ name: "ws-box", status: "online", version: "0.3.0-ws" }),
    ]);

    // A forced replacement (as on wake) keeps working: the next beat goes over the new socket.
    link.reconnectNow();
    expect(connections).toBe(2);
    await presence.setState("draining");
    await until(async () => (await person.query(api.runners.list, {}))[0]?.status === "draining");

    await presence.stop();
    await expect(person.query(api.runners.list, {})).resolves.toEqual([
      expect.objectContaining({ status: "stopped" }),
    ]);
    await link.close();
  });
});
