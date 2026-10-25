import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { BackendLink, RunnerPresence } from "@volli/host-core/cloud-runner";
import { runnerConnector, type RunnerConnection, type RunnerConnectionDeps } from "./connection";

let connection: RunnerConnection | undefined;
afterEach(async () => {
  await connection?.close();
  connection = undefined;
});

describe("the shared Mac runner connection", () => {
  it("hands the same link, presence and per-boot id to cloud sync without a second connection or beat loop", async () => {
    const close = vi.fn(async () => {});
    const mutation = vi.fn(async (name: string) =>
      name === "runners:heartbeat"
        ? {
            serverTime: 1,
            status: "online",
            targetVersion: null,
            minVersion: null,
            autoUpdate: { enabled: true, channel: "stable", pinnedVersion: null },
          }
        : undefined,
    );
    const connect = vi.fn(() => ({
      mutation,
      isConnected: () => true,
      onUpdate: () => () => {},
      onConnectionChange: () => () => {},
      close,
    }));
    let shared:
      | {
          link: BackendLink;
          presence: RunnerPresence;
          bootId: string;
          runnerId: string;
          runnerToken(): Promise<string | null>;
        }
      | undefined;
    let startPresence: ReturnType<typeof vi.spyOn>;
    const start = vi.fn(() => {
      void shared!.presence.start();
    });
    const suspend = vi.fn();
    const resume = vi.fn(async () => {});
    const stop = vi.fn(async () => {
      await shared!.presence.stop();
      await shared!.link.close();
    });
    const sync: NonNullable<RunnerConnectionDeps["sync"]> = (parts) => {
      shared = parts;
      startPresence = vi.spyOn(parts.presence, "start");
      return {
        start,
        stop,
        close: async () => {
          await parts.link.close();
          await parts.presence.stop();
        },
        waiting: () => 12,
        suspend,
        resume,
      };
    };
    connection = runnerConnector({
      siteUrl: "http://127.0.0.1:1",
      connect,
      bootId: "boot-id",
      sync,
      readLoad: () => ({
        activeSessions: 0,
        activeTurns: 0,
        queueDepth: 0,
        freeDiskMb: 1,
        freeMemMb: 1,
      }),
      readCapabilities: () => ({
        version: "0.3.0",
        platform: { os: "darwin", arch: "arm64", distro: null, kernel: null, glibc: null },
        installMode: "app",
        capabilities: {
          v: 1,
          nodeVersion: "24",
          cpuCount: 1,
          memTotalMb: 1,
          git: null,
          docker: false,
          terminals: "unavailable",
          browser: { state: "unavailable", reason: "none" },
          maxConcurrentSessions: 1,
          tools: [],
        },
        localCredentials: [],
      }),
      log: { warn: vi.fn() },
    })({
      runnerId: "runner-id",
      store: { load: async () => null, save: async () => {}, clear: async () => {} },
      onLost: vi.fn(),
      onChange: vi.fn(),
    });
    connection.start();
    await vi.waitFor(() => expect(connection!.beating).toBe(true));
    expect(connect).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(startPresence!).toHaveBeenCalledTimes(1);
    expect(shared).toMatchObject({ bootId: "boot-id", runnerId: "runner-id" });
    expect(await shared!.runnerToken()).toBeNull();
    expect(mutation).toHaveBeenCalledWith(
      "runners:heartbeat",
      expect.objectContaining({ bootId: "boot-id" }),
    );
    expect(connection.waitingFacts).toBe(12);
    await connection.power.suspend();
    expect(suspend).toHaveBeenCalledOnce();
    await connection.power.resume();
    expect(resume).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledTimes(1); // Wake replaced the sleeping connection.
    await connection.stop();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(2);
    connection = undefined;
  });
});
