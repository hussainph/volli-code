import { describe, expect, it, vi } from "vite-plus/test";

import { newId, type RunnerTokenGrant } from "@volli/shared/cloud";

import type { RunnerLink, RunnerLinkStore } from "./link";
import { RunnerHttpError, type RunnerLinkClient } from "./link-client";
import { createRunnerTokenSource } from "./token-source";

const RUNNER_ID = newId("runner");
const LINKED: RunnerLink = {
  runnerId: RUNNER_ID,
  name: "box",
  credential: "vrc_1",
  generation: 1,
};

function harness(options: { identity?: RunnerLink | null; saveFails?: boolean } = {}) {
  let identity = options.identity === undefined ? LINKED : options.identity;
  const log: string[] = [];
  let generation = identity?.generation ?? 0;
  let serverClock = 1_000_000;
  const answers: (() => Promise<RunnerTokenGrant>)[] = [];
  const store: RunnerLinkStore = {
    load: async () => identity,
    save: async (next) => {
      log.push(`save ${next.credential}`);
      if (options.saveFails) throw new Error("disk full");
      identity = next;
    },
    clear: async () => {},
  };
  const client: RunnerLinkClient = {
    link: vi.fn(),
    startDeviceLink: vi.fn(),
    pollDeviceLink: vi.fn(),
    exchange: vi.fn(async ({ credential }) => {
      log.push(`exchange ${credential}`);
      const answer = answers.shift();
      if (answer) return answer();
      generation += 1;
      return {
        token: `jwt-${generation}`,
        // A server clock far from the box's: only the lifetime matters.
        serverTime: serverClock,
        expiresAt: serverClock + 900_000,
        credential: `vrc_${generation}`,
        generation,
      };
    }),
  };
  let now = 0;
  const lost: string[] = [];
  const source = createRunnerTokenSource({
    client,
    store,
    now: () => now,
    onLinkLost: (reason) => lost.push(reason),
  });
  return {
    source,
    log,
    lost,
    answers,
    identity: () => identity,
    advance: (ms: number) => {
      now += ms;
      serverClock += ms;
    },
  };
}

describe("the runner token", () => {
  it("exchanges once, saves the rotated credential before handing out the token, and caches it", async () => {
    const h = harness();
    await expect(h.source.token()).resolves.toBe("jwt-2");
    expect(h.log).toEqual(["exchange vrc_1", "save vrc_2"]);
    expect(h.identity()).toEqual({ ...LINKED, credential: "vrc_2", generation: 2 });
    await expect(h.source.token()).resolves.toBe("jwt-2");
    expect(h.log).toHaveLength(2);
    expect(h.source.lost).toBeNull();
  });

  it("refreshes at two thirds of the lifetime, or when forced", async () => {
    const h = harness();
    await h.source.token();
    h.advance(599_999);
    await expect(h.source.token()).resolves.toBe("jwt-2");
    h.advance(1);
    await expect(h.source.token()).resolves.toBe("jwt-3");
    await expect(h.source.token({ forceRefreshToken: true })).resolves.toBe("jwt-4");
    expect(h.log.filter((line) => line.startsWith("exchange"))).toEqual([
      "exchange vrc_1",
      "exchange vrc_2",
      "exchange vrc_3",
    ]);
  });

  it("shares one exchange between concurrent callers", async () => {
    const h = harness();
    const [a, b] = await Promise.all([
      h.source.token(),
      h.source.token({ forceRefreshToken: true }),
    ]);
    expect([a, b]).toEqual(["jwt-2", "jwt-2"]);
    expect(h.log.filter((line) => line.startsWith("exchange"))).toHaveLength(1);
  });

  it("never hands out a token whose credential could not be saved", async () => {
    const h = harness({ saveFails: true });
    await expect(h.source.token()).rejects.toThrow("disk full");
    // The old credential is still the one on disk; the next try presents it again.
    await expect(h.source.token()).rejects.toThrow("disk full");
    expect(h.log.filter((line) => line.startsWith("exchange"))).toEqual([
      "exchange vrc_1",
      "exchange vrc_1",
    ]);
  });

  it("throws transient failures and recovers on the next call", async () => {
    const h = harness();
    h.answers.push(() => Promise.reject(new RunnerHttpError("unavailable", null, "offline")));
    await expect(h.source.token()).rejects.toThrow("offline");
    await expect(h.source.token()).resolves.toBe("jwt-2");
  });

  it("retains the credential through preview cutoff and recovers after a re-grant", async () => {
    const h = harness();
    h.answers.push(() =>
      Promise.reject(new RunnerHttpError("preview_access_required", 403, "preview")),
    );
    await expect(h.source.token()).rejects.toThrow("preview");
    expect(h.source.lost).toBeNull();
    expect(h.lost).toEqual([]);
    await expect(h.source.token()).resolves.toBe("jwt-2");
    expect(h.log.filter((line) => line.startsWith("exchange"))).toEqual([
      "exchange vrc_1",
      "exchange vrc_1",
    ]);
  });

  it("a revoked runner or a dead credential ends the link once, and answers null from then on", async () => {
    for (const code of ["revoked", "invalid_credential"] as const) {
      const h = harness();
      h.answers.push(() => Promise.reject(new RunnerHttpError(code, 403, code)));
      await expect(h.source.token()).resolves.toBeNull();
      await expect(h.source.token({ forceRefreshToken: true })).resolves.toBeNull();
      expect(h.lost).toEqual([code]);
      expect(h.source.lost).toBe(code);
      expect(h.log.filter((line) => line.startsWith("exchange"))).toHaveLength(1);
    }
  });

  it("an unlinked machine has no token", async () => {
    const h = harness({ identity: null });
    await expect(h.source.token()).resolves.toBeNull();
    expect(h.lost).toEqual(["unlinked"]);
  });

  it("uses the machine clock by default", async () => {
    const exchange = vi.fn(async () => ({
      token: "jwt",
      serverTime: 0,
      expiresAt: 900_000,
      credential: "vrc_2",
      generation: 2,
    }));
    const source = createRunnerTokenSource({
      client: { link: vi.fn(), startDeviceLink: vi.fn(), pollDeviceLink: vi.fn(), exchange },
      store: { load: async () => LINKED, save: async () => {}, clear: async () => {} },
    });
    await source.token();
    await source.token();
    expect(exchange).toHaveBeenCalledTimes(1);
  });
});
