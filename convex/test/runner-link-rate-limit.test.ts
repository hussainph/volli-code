import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import {
  RUNNER_HTTP_PATHS,
  newId,
  parseRunnerDeviceLinkStart,
  readRunnerHttpError,
  secretHash,
  type RunnerHostFacts,
} from "@volli/shared/cloud";

import { internal } from "../functions/_generated/api";
import {
  RATE_LIMIT_SWEEP_PAGE_SIZE,
  RUNNER_LINK_LIMITS,
  admit,
  networkOf,
  tokensAt,
} from "../functions/lib/runnerLinkRateLimit";
import schema from "../functions/schema";

const modules = import.meta.glob("../functions/**/*.ts");

const HOST: RunnerHostFacts = {
  hostname: "hetzner-1.example.com",
  platform: { os: "linux", distro: "debian 12", kernel: "6.1.0", arch: "x64", glibc: "2.36" },
  installMode: "system",
};

function setup() {
  return convexTest(schema, modules);
}
type T = ReturnType<typeof setup>;

/** One POST from `ip` as Convex sees it; `spoof` is a header the caller sets, which counts for nothing. */
async function post(t: T, ip: string | null, path: string, body: unknown, spoof?: string) {
  const response = await t.withRequestMetadata({ ip }).fetch(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(spoof === undefined ? {} : { "x-forwarded-for": spoof, "cf-connecting-ip": spoof }),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return {
    status: response.status,
    retryAfter: response.headers.get("retry-after"),
    body: (await response.json()) as unknown,
  };
}

const start = (t: T, ip: string | null, spoof?: string) =>
  post(t, ip, RUNNER_HTTP_PATHS.linkStart, { host: HOST }, spoof);
const poll = (t: T, ip: string, requestId: string, pollSecret: string) =>
  post(t, ip, RUNNER_HTTP_PATHS.linkPoll, { requestId, pollSecret });
const link = (t: T, ip: string, installToken: string) =>
  post(t, ip, RUNNER_HTTP_PATHS.link, { installToken, host: HOST, name: null });

function expectLimited(result: { status: number; retryAfter: string | null; body: unknown }) {
  expect(result.status).toBe(429);
  expect(readRunnerHttpError(result.body)).toEqual({
    code: "rate_limited",
    message: `Too many linking requests. Try again in ${result.retryAfter} s.`,
  });
}

const buckets = (t: T) => t.run((ctx) => ctx.db.query("runnerLinkRateLimits").collect());
const linkRequests = (t: T) => t.run((ctx) => ctx.db.query("runnerLinkRequests").collect());

afterEach(() => {
  vi.useRealTimers();
});

describe("networks", () => {
  test("an address is its IPv4 address or its IPv6 /64", () => {
    expect(networkOf(null)).toBe("unknown");
    expect(networkOf("  ")).toBe("unknown");
    expect(networkOf("203.0.113.7")).toBe("v4:203.0.113.7");
    expect(networkOf("::FFFF:203.0.113.7")).toBe("v4:203.0.113.7");
    expect(networkOf("2001:DB8:1:2:3:4:5:6")).toBe("v6:2001:db8:1:2::/64");
    expect(networkOf("2001:0db8:0001:0002::9")).toBe("v6:2001:db8:1:2::/64");
    expect(networkOf("::1")).toBe("v6:0:0:0:0::/64");
    expect(networkOf("fe80::")).toBe("v6:fe80:0:0:0::/64");
  });

  test("anything else is a network of its own", () => {
    for (const text of ["1::2::3", "1:2:3:4:5:6:7", "1:2:3:4:5:6:7:8::", "g::1", "localhost"]) {
      expect(networkOf(text)).toBe(`raw:${text}`);
    }
  });
});

describe("token buckets", () => {
  test("a missing bucket is full, and a bucket refills up to its capacity", () => {
    const policy = { capacity: 3, refillMs: 1_000 };
    expect(tokensAt(null, policy, 0)).toBe(3);
    expect(tokensAt({ tokens: 0, updatedAt: 0 }, policy, 1_500)).toBe(1.5);
    expect(tokensAt({ tokens: 2, updatedAt: 0 }, policy, 60_000)).toBe(3);
    // A row from a clock that ran ahead is not drained further.
    expect(tokensAt({ tokens: 1, updatedAt: 5_000 }, policy, 0)).toBe(1);
  });

  test("takes from every bucket or from none, and says when to come back", async () => {
    const t = setup();
    const wide = { key: "wide", policy: { capacity: 2, refillMs: 1_000 } };
    const narrow = { key: "narrow", policy: { capacity: 1, refillMs: 5_000 } };
    const both = [wide, narrow];
    await t.run(async (ctx) => {
      await expect(admit(ctx, both, 0)).resolves.toEqual({ ok: true });
      await expect(admit(ctx, both, 0)).resolves.toEqual({ ok: false, retryAfterMs: 5_000 });
      await expect(admit(ctx, both, 4_999)).resolves.toEqual({ ok: false, retryAfterMs: 1 });
    });
    // The refusals took nothing from the bucket that still had room.
    expect(
      (await buckets(t)).map(({ key, tokens, updatedAt, fullAt }) => ({
        key,
        tokens,
        updatedAt,
        fullAt,
      })),
    ).toEqual([
      { key: "wide", tokens: 1, updatedAt: 0, fullAt: 1_000 },
      { key: "narrow", tokens: 0, updatedAt: 0, fullAt: 5_000 },
    ]);
    await t.run(async (ctx) => {
      await expect(admit(ctx, both, 5_000)).resolves.toEqual({ ok: true });
    });
    expect((await buckets(t)).map(({ tokens }) => tokens)).toEqual([1, 0]);
  });
});

describe("POST /runner/link/start", () => {
  test("one network gets a few codes, then one a minute, whatever headers it sends", async () => {
    vi.useFakeTimers();
    const t = setup();
    const { capacity } = RUNNER_LINK_LIMITS.startPerNetwork;
    for (let n = 0; n < capacity; n += 1) {
      expect((await start(t, "203.0.113.7", `198.51.100.${n}`)).status).toBe(200);
    }
    const refused = await start(t, "203.0.113.7", "198.51.100.200");
    expectLimited(refused);
    expect(refused.retryAfter).toBe("60");
    expect(await linkRequests(t)).toHaveLength(capacity);
    // The same caller through its IPv4-mapped address is the same network.
    expectLimited(await start(t, "::ffff:203.0.113.7"));
    // Another network is not held back.
    expect((await start(t, "203.0.113.8")).status).toBe(200);

    vi.advanceTimersByTime(RUNNER_LINK_LIMITS.startPerNetwork.refillMs + 1_000);
    const again = await start(t, "203.0.113.7");
    expect(again.status).toBe(200);
    expect(parseRunnerDeviceLinkStart(again.body).userCode).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
    expectLimited(await start(t, "203.0.113.7"));
  });

  test("cycling addresses inside one IPv6 /64 gains nothing", async () => {
    const t = setup();
    const { capacity } = RUNNER_LINK_LIMITS.startPerNetwork;
    for (let n = 0; n < capacity; n += 1) {
      expect((await start(t, `2001:db8:1:2::${n.toString(16)}`)).status).toBe(200);
    }
    expectLimited(await start(t, "2001:db8:1:2:ffff:ffff:ffff:ffff"));
    expect((await start(t, "2001:db8:1:3::1")).status).toBe(200);
  });

  test("the deployment-wide bucket holds back every network, and a refusal writes nothing", async () => {
    vi.useFakeTimers();
    const t = setup();
    await t.run((ctx) =>
      ctx.db.insert("runnerLinkRateLimits", {
        key: "link_start:all",
        tokens: 0,
        updatedAt: Date.now(),
        fullAt: Date.now() + RUNNER_LINK_LIMITS.startGlobal.capacity * 2_000,
      }),
    );
    const refused = await start(t, "192.0.2.1");
    expectLimited(refused);
    expect(refused.retryAfter).toBe("2");
    expect(await buckets(t)).toHaveLength(1);
    expect(await linkRequests(t)).toEqual([]);
  });

  test("a malformed body is refused before it takes anything", async () => {
    const t = setup();
    for (let n = 0; n < 2 * RUNNER_LINK_LIMITS.startPerNetwork.capacity; n += 1) {
      expect((await post(t, "192.0.2.1", RUNNER_HTTP_PATHS.linkStart, "{nope")).status).toBe(400);
    }
    expect(await buckets(t)).toEqual([]);
    expect((await start(t, "192.0.2.1")).status).toBe(200);
  });

  test("no address at all is one shared network", async () => {
    const t = setup();
    for (let n = 0; n < RUNNER_LINK_LIMITS.startPerNetwork.capacity; n += 1) {
      expect((await start(t, null)).status).toBe(200);
    }
    expectLimited(await start(t, null));
  });
});

describe("POST /runner/link/poll", () => {
  async function started(t: T) {
    const result = await start(t, "203.0.113.7");
    return parseRunnerDeviceLinkStart(result.body);
  }

  test("the box polling at its interval is never held back", async () => {
    vi.useFakeTimers();
    const t = setup();
    const { requestId, pollSecret, intervalMs } = await started(t);
    for (let n = 0; n < 20; n += 1) {
      vi.advanceTimersByTime(intervalMs);
      const result = await poll(t, "203.0.113.7", requestId, pollSecret);
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ status: "pending" });
    }
  });

  test("rotating networks cannot hammer one request, right secret or wrong", async () => {
    vi.useFakeTimers();
    const t = setup();
    const { requestId, pollSecret } = await started(t);
    const { capacity, refillMs } = RUNNER_LINK_LIMITS.pollPerRequest;
    for (let n = 0; n < capacity; n += 1) {
      expect((await poll(t, `198.51.100.${n}`, requestId, `vrp_guess${n}`)).status).toBe(404);
    }
    // A fresh network, and the right secret: the request's bucket is empty all the same.
    const refused = await poll(t, "192.0.2.50", requestId, pollSecret);
    expectLimited(refused);
    expect(refused.retryAfter).toBe(String(refillMs / 1_000));
    vi.advanceTimersByTime(refillMs + 1_000);
    expect((await poll(t, "192.0.2.51", requestId, pollSecret)).body).toEqual({
      status: "pending",
    });
  });

  test("unknown request ids make no buckets of their own, and the network is held back first", async () => {
    vi.useFakeTimers();
    const t = setup();
    const { requestId, pollSecret } = await started(t);
    const before = (await buckets(t)).length;
    const { capacity } = RUNNER_LINK_LIMITS.pollPerNetwork;
    for (let n = 0; n < capacity; n += 1) {
      expect((await poll(t, "192.0.2.9", newId("runner"), "vrp_junk")).status).toBe(404);
    }
    // One network bucket and one global bucket, however many ids were made up.
    expect(await buckets(t)).toHaveLength(before + 2);
    // Refused at the network, a real request's own bucket is not touched.
    expectLimited(await poll(t, "192.0.2.9", requestId, pollSecret));
    expect(
      (await buckets(t)).filter(({ key }) => key === `link_poll:request:${requestId}`),
    ).toEqual([]);
    expect((await poll(t, "192.0.2.10", requestId, pollSecret)).status).toBe(200);
  });
});

/** A real install token whose creator is gone: every try is refused, but it names a row. */
async function deadToken(t: T): Promise<string> {
  const installToken = "vrt_dead_but_real";
  await t.run((ctx) =>
    ctx.db.insert("runnerInstallTokens", {
      id: newId("runner"),
      tokenHash: secretHash(installToken),
      createdByUserId: newId("user"),
      nameHint: null,
      defaultWorkspaceId: null,
      expiresAt: Date.now() + 60 * 60_000,
      usedAt: null,
      usedByRunnerId: null,
      revokedAt: null,
    }),
  );
  return installToken;
}

describe("POST /runner/link", () => {
  test("rotating networks cannot hammer one install token", async () => {
    vi.useFakeTimers();
    const t = setup();
    const installToken = await deadToken(t);
    const { capacity, refillMs } = RUNNER_LINK_LIMITS.linkPerToken;
    for (let n = 0; n < capacity; n += 1) {
      const result = await link(t, `198.51.100.${n}`, installToken);
      expect(readRunnerHttpError(result.body)?.code).toBe("invalid_install_token");
    }
    const refused = await link(t, "192.0.2.77", installToken);
    expectLimited(refused);
    expect(refused.retryAfter).toBe(String(refillMs / 1_000));
    vi.advanceTimersByTime(refillMs + 1_000);
    expect((await link(t, "192.0.2.78", installToken)).status).toBe(401);
  });

  test("made-up tokens make no buckets of their own; one network is held back", async () => {
    vi.useFakeTimers();
    const t = setup();
    const { capacity } = RUNNER_LINK_LIMITS.linkPerNetwork;
    for (let n = 0; n < capacity; n += 1) {
      expect((await link(t, "192.0.2.9", `vrt_junk${n}`)).status).toBe(401);
    }
    expect(await buckets(t)).toHaveLength(2);
    expectLimited(await link(t, "192.0.2.9", "vrt_junk_more"));
    expect((await link(t, "192.0.2.10", "vrt_junk_more")).status).toBe(401);
  });
});

test.each(["link", "poll"] as const)(
  "%s metadata allocation has a global ceiling",
  async (door) => {
    vi.useFakeTimers();
    const t = setup();
    const policy = door === "link" ? RUNNER_LINK_LIMITS.linkGlobal : RUNNER_LINK_LIMITS.pollGlobal;
    await t.run((ctx) =>
      ctx.db.insert("runnerLinkRateLimits", {
        key: door === "link" ? "link:all" : "link_poll:all",
        tokens: 0,
        updatedAt: Date.now(),
        fullAt: Date.now() + policy.capacity * policy.refillMs,
      }),
    );
    const result =
      door === "link"
        ? await link(t, "192.0.2.55", "vrt_junk")
        : await poll(t, "192.0.2.55", newId("runner"), "vrp_junk");
    expectLimited(result);
    expect(await buckets(t)).toHaveLength(1);
  },
);

describe("the bucket cleanup", () => {
  test("deletes refilled buckets only, and a deleted bucket answers as it would have", async () => {
    vi.useFakeTimers();
    const t = setup();
    expect((await start(t, "203.0.113.7")).status).toBe(200);
    await t.run((ctx) =>
      ctx.db.insert("runnerLinkRateLimits", {
        key: "stale",
        tokens: 4,
        updatedAt: 0,
        fullAt: 1,
      }),
    );
    await expect(t.mutation(internal.runnerLinkRateLimit.sweep, {})).resolves.toEqual({
      deleted: 1,
    });
    expect((await buckets(t)).map(({ key }) => key)).not.toContain("stale");

    vi.advanceTimersByTime(RUNNER_LINK_LIMITS.startGlobal.capacity * 2_000 + 1_000);
    await expect(t.mutation(internal.runnerLinkRateLimit.sweep, {})).resolves.toEqual({
      deleted: 2,
    });
    for (let n = 0; n < RUNNER_LINK_LIMITS.startPerNetwork.capacity; n += 1) {
      expect((await start(t, "203.0.113.7")).status).toBe(200);
    }
    expectLimited(await start(t, "203.0.113.7"));
  });

  test("a full page schedules the next one", async () => {
    vi.useFakeTimers();
    const t = setup();
    await t.run(async (ctx) => {
      for (let n = 0; n <= RATE_LIMIT_SWEEP_PAGE_SIZE; n += 1) {
        await ctx.db.insert("runnerLinkRateLimits", {
          key: `stale:${n}`,
          tokens: 1,
          updatedAt: 0,
          fullAt: 1,
        });
      }
    });
    await expect(t.mutation(internal.runnerLinkRateLimit.sweep, {})).resolves.toEqual({
      deleted: RATE_LIMIT_SWEEP_PAGE_SIZE,
    });
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    expect(await buckets(t)).toEqual([]);
  });
});
