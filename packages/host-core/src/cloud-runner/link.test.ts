import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { newId, RUNNER_LINK_REQUEST_TTL_MS, type RunnerDeviceLinkPoll } from "@volli/shared/cloud";

import {
  linkWithDeviceCode,
  linkWithInstallToken,
  type RunnerLink,
  type RunnerLinkStore,
} from "./link";
import { RunnerHttpError, type RunnerLinkClient } from "./link-client";

const HOST = {
  hostname: "box",
  platform: { os: "linux", distro: null, kernel: null, arch: "x64", glibc: null },
  installMode: "user" as const,
};
const GRANT = { runnerId: newId("runner"), name: "box", credential: "vrc_a", generation: 1 };

function memoryStore() {
  let saved: RunnerLink | null = null;
  const store: RunnerLinkStore = {
    load: async () => saved,
    save: async (identity) => {
      saved = identity;
    },
    clear: async () => {
      saved = null;
    },
  };
  return { store, saved: () => saved };
}

function deviceClient(polls: (RunnerDeviceLinkPoll | Error)[]): RunnerLinkClient {
  return {
    link: vi.fn(async () => GRANT),
    startDeviceLink: vi.fn(async () => ({
      requestId: "r",
      userCode: "BCDF-GHJK",
      pollSecret: "s",
      intervalMs: 1,
      expiresAt: 123,
    })),
    pollDeviceLink: vi.fn(async () => {
      const next = polls.shift()!;
      if (next instanceof Error) throw next;
      return next;
    }),
    exchange: vi.fn(),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("linking", () => {
  it("an install token links in one request and saves the identity", async () => {
    const { store, saved } = memoryStore();
    const client = deviceClient([]);
    await expect(
      linkWithInstallToken({ client, store, host: HOST, installToken: "vrt_x", name: "Box" }),
    ).resolves.toEqual(GRANT);
    expect(client.link).toHaveBeenCalledWith({ installToken: "vrt_x", host: HOST, name: "Box" });
    expect(saved()).toEqual(GRANT);
    await linkWithInstallToken({ client, store, host: HOST, installToken: "vrt_x" });
    expect(client.link).toHaveBeenLastCalledWith({ installToken: "vrt_x", host: HOST, name: null });
  });

  it("a device code is shown, polled at the interval through transient failures, and saved once approved", async () => {
    const { store, saved } = memoryStore();
    const client = deviceClient([
      { status: "pending" },
      new RunnerHttpError("unavailable", null, "down"),
      { status: "linked", grant: GRANT },
    ]);
    const shown: unknown[] = [];
    const sleeps: number[] = [];
    const outcome = await linkWithDeviceCode({
      client,
      store,
      host: HOST,
      showCode: (code, expiresAt) => shown.push([code, expiresAt]),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(outcome).toEqual({ status: "linked", link: GRANT });
    expect(shown).toEqual([["BCDF-GHJK", 123]]);
    // Never faster than the documented five seconds.
    expect(sleeps).toEqual([5000, 5000, 5000]);
    expect(saved()).toEqual(GRANT);
  });

  it("a denied or expired code links nothing; a hard failure is thrown", async () => {
    for (const status of ["denied", "expired"] as const) {
      const { store, saved } = memoryStore();
      const outcome = await linkWithDeviceCode({
        client: deviceClient([{ status }]),
        store,
        host: HOST,
        showCode: () => {},
        sleep: async () => {},
      });
      expect(outcome).toEqual({ status });
      expect(saved()).toBeNull();
    }
    await expect(
      linkWithDeviceCode({
        client: deviceClient([new RunnerHttpError("invalid_link_request", 404, "gone")]),
        store: memoryStore().store,
        host: HOST,
        showCode: () => {},
        sleep: async () => {},
      }),
    ).rejects.toThrow("gone");
  });

  it("gives up on its own clock when the backend cannot be reached until the code expires", async () => {
    let clock = 0;
    const client = deviceClient(
      Array.from({ length: 200 }, () => new RunnerHttpError("unavailable", null, "down")),
    );
    const outcome = await linkWithDeviceCode({
      client,
      store: memoryStore().store,
      host: HOST,
      showCode: () => {},
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    expect(outcome).toEqual({ status: "expired" });
    expect(clock).toBeGreaterThan(RUNNER_LINK_REQUEST_TTL_MS);
  });

  it("can be cancelled before or during a wait", async () => {
    const before = new AbortController();
    before.abort();
    await expect(
      linkWithDeviceCode({
        client: deviceClient([]),
        store: memoryStore().store,
        host: HOST,
        showCode: () => {},
        sleep: async () => {},
        signal: before.signal,
      }),
    ).resolves.toEqual({ status: "cancelled" });

    const during = new AbortController();
    await expect(
      linkWithDeviceCode({
        client: deviceClient([]),
        store: memoryStore().store,
        host: HOST,
        showCode: () => {},
        sleep: async () => during.abort(),
        signal: during.signal,
      }),
    ).resolves.toEqual({ status: "cancelled" });
  });

  it("waits on a real timer by default", async () => {
    vi.useFakeTimers();
    const pending = linkWithDeviceCode({
      client: deviceClient([{ status: "denied" }]),
      store: memoryStore().store,
      host: HOST,
      showCode: () => {},
    });
    await vi.advanceTimersByTimeAsync(5000);
    await expect(pending).resolves.toEqual({ status: "denied" });
  });
});
