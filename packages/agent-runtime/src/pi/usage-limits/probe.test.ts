import type { AuthCheck, AuthResult } from "@earendil-works/pi-ai";
import type { UsageLimits } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import { UsageLimitsHolder } from "./holder";
import {
  chatgptAccountId,
  probeUsageLimits,
  retryAfterMillis,
  USAGE_PROBE_COOLDOWN_MS,
  USAGE_PROBE_FRESH_MS,
  UsageProbeSchedule,
  type UsageProbeFetch,
  type UsageProbeInput,
  type UsageProbeModels,
} from "./probe";

const NOW = Date.parse("2026-03-01T12:00:00Z");

const base64url = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

/** A Codex-shaped JWT whose payload names one ChatGPT account. Signature is noise. */
function codexToken(claims: Record<string, unknown>): string {
  return `${base64url({ alg: "RS256" })}.${base64url(claims)}.signature`;
}

const CODEX_TOKEN = codexToken({
  "https://api.openai.com/auth": { chatgpt_account_id: "acct_42" },
});

function models(
  check: AuthCheck | undefined,
  resolved: AuthResult | undefined | (() => Promise<AuthResult | undefined>),
): UsageProbeModels {
  return {
    checkAuth: async () => check,
    getAuth: (typeof resolved === "function" ? resolved : async () => resolved) as never,
  };
}

const oauth: AuthCheck = { type: "oauth", source: "OAuth" };
const apiKey: AuthCheck = { type: "api_key", source: "ANTHROPIC_API_KEY" };

interface Call {
  url: string;
  headers: Record<string, string>;
}

/** A fetch that records what it was asked and answers from a script. */
function scripted(answer: (call: Call) => Response | Promise<Response>): {
  fetch: UsageProbeFetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      const call = { url, headers: init.headers };
      calls.push(call);
      return answer(call);
    },
  };
}

const json = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

const ANTHROPIC_BODY = {
  five_hour: { utilization: 37, resets_at: "2026-03-01T14:00:00Z" },
  seven_day: { utilization: 4, resets_at: "2026-03-05T09:30:00Z" },
};
const CODEX_BODY = {
  plan_type: "plus",
  rate_limit: {
    primary_window: { used_percent: 49, limit_window_seconds: 18_000, reset_after_seconds: 7_200 },
    secondary_window: { used_percent: 62, limit_window_seconds: 604_800, reset_after_seconds: 1 },
  },
};

function input(overrides: Partial<UsageProbeInput> = {}): UsageProbeInput {
  return {
    providerId: "anthropic",
    models: models(oauth, { auth: { apiKey: "sk-ant-oat-token" }, source: "OAuth" }),
    fetch: scripted(() => json(ANTHROPIC_BODY)).fetch,
    signal: new AbortController().signal,
    now: () => NOW,
    schedule: new UsageProbeSchedule(),
    force: false,
    ...overrides,
  };
}

describe("probeUsageLimits", () => {
  it("has nothing to say for a provider with no usage endpoint", async () => {
    const { fetch, calls } = scripted(() => json({}));
    expect(await probeUsageLimits(input({ providerId: "openai", fetch }))).toEqual({
      kind: "none",
    });
    expect(calls).toEqual([]);
  });

  it("has nothing to say for a provider with no credential", async () => {
    const { fetch, calls } = scripted(() => json({}));
    const outcome = await probeUsageLimits(input({ models: models(undefined, undefined), fetch }));
    expect(outcome).toEqual({ kind: "none" });
    expect(calls).toEqual([]);
  });

  it("reports an API-key account unsupported without a request", async () => {
    const { fetch, calls } = scripted(() => json(ANTHROPIC_BODY));
    const outcome = await probeUsageLimits(
      input({ models: models(apiKey, { auth: { apiKey: "sk-ant-api" } }), fetch }),
    );
    expect(outcome).toEqual({
      kind: "read",
      limits: { checkedAt: NOW, windows: [], unavailable: { reason: "unsupported" } },
    });
    expect(calls).toEqual([]);
  });

  it("reads Anthropic's usage endpoint with the OAuth bearer and beta header", async () => {
    const { fetch, calls } = scripted(() => json(ANTHROPIC_BODY));
    const outcome = await probeUsageLimits(input({ fetch }));
    expect(calls).toEqual([
      {
        url: "https://api.anthropic.com/api/oauth/usage",
        headers: {
          authorization: "Bearer sk-ant-oat-token",
          accept: "application/json",
          "anthropic-beta": "oauth-2025-04-20",
        },
      },
    ]);
    expect(outcome.kind).toBe("read");
    const limits = (outcome as { limits: UsageLimits }).limits;
    expect(limits.unavailable).toBeUndefined();
    expect(limits.windows.map((window) => [window.id, window.usedPercent])).toEqual([
      ["five_hour", 37],
      ["seven_day", 4],
    ]);
  });

  it("reads Codex's usage endpoint with the account id the token carries", async () => {
    const { fetch, calls } = scripted(() => json(CODEX_BODY));
    const outcome = await probeUsageLimits(
      input({
        providerId: "openai-codex",
        models: models(oauth, { auth: { apiKey: CODEX_TOKEN }, source: "OAuth" }),
        fetch,
      }),
    );
    expect(calls[0]?.url).toBe("https://chatgpt.com/backend-api/wham/usage");
    expect(calls[0]?.headers["chatgpt-account-id"]).toBe("acct_42");
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${CODEX_TOKEN}`);
    const limits = (outcome as { limits: UsageLimits }).limits;
    expect(limits.windows.map((window) => window.id)).toEqual(["session", "weekly"]);
  });

  it("sends no account header when the token carries no account claim", async () => {
    const { fetch, calls } = scripted(() => json(CODEX_BODY));
    await probeUsageLimits(
      input({
        providerId: "openai-codex",
        models: models(oauth, { auth: { apiKey: "opaque" }, source: "OAuth" }),
        fetch,
      }),
    );
    expect(calls[0]?.headers).not.toHaveProperty("chatgpt-account-id");
  });

  it("uses Pi's resolved credential, so a refresh Pi performs is what is sent", async () => {
    const { fetch, calls } = scripted(() => json(ANTHROPIC_BODY));
    let resolutions = 0;
    await probeUsageLimits(
      input({
        models: models(oauth, async () => {
          resolutions++;
          return { auth: { apiKey: "refreshed-token" }, source: "OAuth" };
        }),
        fetch,
      }),
    );
    expect(resolutions).toBe(1);
    expect(calls[0]?.headers.authorization).toBe("Bearer refreshed-token");
  });

  it("reports a failed probe when the credential does not resolve to a token", async () => {
    const { fetch, calls } = scripted(() => json(ANTHROPIC_BODY));
    const outcome = await probeUsageLimits(
      input({ models: models(oauth, { auth: {}, source: "OAuth" }), fetch }),
    );
    expect(outcome).toEqual({
      kind: "read",
      limits: { checkedAt: NOW, windows: [], unavailable: { reason: "probeFailed" } },
    });
    expect(calls).toEqual([]);
    const rejected = await probeUsageLimits(
      input({
        models: models(oauth, async () => {
          throw new Error("refresh failed: token sk-ant-secret");
        }),
        fetch,
      }),
    );
    expect(JSON.stringify(rejected)).not.toContain("secret");
    expect(rejected).toMatchObject({
      kind: "read",
      limits: { unavailable: { reason: "probeFailed" } },
    });
  });

  it("reports a failed probe when the credential store itself cannot be read", async () => {
    const outcome = await probeUsageLimits(
      input({
        models: {
          checkAuth: async () => {
            throw new Error("auth.json unreadable");
          },
          getAuth: async () => undefined,
        },
      }),
    );
    expect(outcome).toEqual({
      kind: "read",
      limits: { checkedAt: NOW, windows: [], unavailable: { reason: "probeFailed" } },
    });
  });

  it("collapses a refused or malformed response to a failed probe, carrying no body text", async () => {
    const refused = await probeUsageLimits(
      input({
        fetch: scripted(
          () => new Response('{"error":"bad token sk-ant-oat-token"}', { status: 401 }),
        ).fetch,
      }),
    );
    expect(refused).toEqual({
      kind: "read",
      limits: { checkedAt: NOW, windows: [], unavailable: { reason: "probeFailed" } },
    });
    const html = await probeUsageLimits(
      input({ fetch: scripted(() => new Response("<html>", { status: 200 })).fetch }),
    );
    expect(html).toMatchObject({
      kind: "read",
      limits: { unavailable: { reason: "probeFailed" } },
    });
    const oversized = await probeUsageLimits(
      input({
        fetch: scripted(() => new Response(`{"pad":"${"x".repeat(70_000)}"}`, { status: 200 }))
          .fetch,
      }),
    );
    expect(oversized).toMatchObject({
      kind: "read",
      limits: { unavailable: { reason: "probeFailed" } },
    });
    const network = await probeUsageLimits(
      input({
        fetch: async () => {
          throw new TypeError("fetch failed");
        },
      }),
    );
    expect(network).toMatchObject({
      kind: "read",
      limits: { unavailable: { reason: "probeFailed" } },
    });
  });

  it("honours a 429 for Retry-After, then the default cooldown, and never retries inside", async () => {
    const schedule = new UsageProbeSchedule();
    const { fetch, calls } = scripted(
      () => new Response("", { status: 429, headers: { "retry-after": "120" } }),
    );
    const first = await probeUsageLimits(input({ fetch, schedule }));
    expect(first).toMatchObject({
      kind: "read",
      limits: { unavailable: { reason: "probeFailed" } },
    });
    expect(calls).toHaveLength(1);
    // Inside the stated two minutes nothing goes out — not even for a forced refresh.
    expect(await probeUsageLimits(input({ fetch, schedule, now: () => NOW + 119_000 }))).toEqual({
      kind: "held",
    });
    expect(
      await probeUsageLimits(input({ fetch, schedule, now: () => NOW + 119_000, force: true })),
    ).toEqual({ kind: "held" });
    expect(calls).toHaveLength(1);
    // Past it, the next inspection asks again.
    await probeUsageLimits(input({ fetch, schedule, now: () => NOW + 121_000 }));
    expect(calls).toHaveLength(2);
  });

  it("holds five minutes after a 429 with no Retry-After", async () => {
    const schedule = new UsageProbeSchedule();
    const { fetch, calls } = scripted(() => new Response("", { status: 429 }));
    await probeUsageLimits(input({ fetch, schedule }));
    await probeUsageLimits(
      input({ fetch, schedule, now: () => NOW + USAGE_PROBE_COOLDOWN_MS - 1 }),
    );
    expect(calls).toHaveLength(1);
    await probeUsageLimits(input({ fetch, schedule, now: () => NOW + USAGE_PROBE_COOLDOWN_MS }));
    expect(calls).toHaveLength(2);
  });

  it("trusts a good read for five minutes unless the inspection is an explicit refresh", async () => {
    const schedule = new UsageProbeSchedule();
    const { fetch, calls } = scripted(() => json(ANTHROPIC_BODY));
    await probeUsageLimits(input({ fetch, schedule }));
    expect(await probeUsageLimits(input({ fetch, schedule, now: () => NOW + 60_000 }))).toEqual({
      kind: "held",
    });
    expect(calls).toHaveLength(1);
    const forced = await probeUsageLimits(
      input({ fetch, schedule, now: () => NOW + 60_000, force: true }),
    );
    expect(forced.kind).toBe("read");
    expect(calls).toHaveLength(2);
    await probeUsageLimits(
      input({ fetch, schedule, now: () => NOW + 60_000 + USAGE_PROBE_FRESH_MS }),
    );
    expect(calls).toHaveLength(3);
  });

  it("does not treat a failed read as fresh", async () => {
    const schedule = new UsageProbeSchedule();
    const { fetch, calls } = scripted(() => json({ unexpected: true }));
    await probeUsageLimits(input({ fetch, schedule }));
    await probeUsageLimits(input({ fetch, schedule, now: () => NOW + 1_000 }));
    expect(calls).toHaveLength(2);
  });
});

describe("retryAfterMillis", () => {
  it("reads delay-seconds and an HTTP-date, clamped to an hour", () => {
    expect(retryAfterMillis("30", NOW)).toBe(30_000);
    expect(retryAfterMillis(new Date(NOW + 90_000).toUTCString(), NOW)).toBe(90_000);
    expect(retryAfterMillis("86400", NOW)).toBe(3_600_000);
  });

  it("reads nothing usable as no header", () => {
    expect(retryAfterMillis(null, NOW)).toBeUndefined();
    expect(retryAfterMillis("  ", NOW)).toBeUndefined();
    expect(retryAfterMillis("0", NOW)).toBeUndefined();
    expect(retryAfterMillis("soon", NOW)).toBeUndefined();
    expect(retryAfterMillis(new Date(NOW - 1_000).toUTCString(), NOW)).toBeUndefined();
  });
});

describe("chatgptAccountId", () => {
  it("reads the one claim off a Codex token", () => {
    expect(chatgptAccountId(CODEX_TOKEN)).toBe("acct_42");
  });

  it("reads nothing off anything that is not a token with that claim", () => {
    expect(chatgptAccountId("opaque")).toBeUndefined();
    expect(chatgptAccountId("a.b.c")).toBeUndefined();
    expect(chatgptAccountId(`h.${Buffer.from("42").toString("base64url")}.s`)).toBeUndefined();
    expect(chatgptAccountId(`h.${Buffer.from("[]").toString("base64url")}.s`)).toBeUndefined();
    expect(chatgptAccountId(codexToken({ sub: "user" }))).toBeUndefined();
    expect(chatgptAccountId(codexToken({ "https://api.openai.com/auth": "x" }))).toBeUndefined();
    expect(
      chatgptAccountId(codexToken({ "https://api.openai.com/auth": { chatgpt_account_id: "" } })),
    ).toBeUndefined();
  });
});

describe("UsageLimitsHolder", () => {
  const good: UsageLimits = {
    checkedAt: NOW,
    windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 37 }],
  };
  const failed: UsageLimits = {
    checkedAt: NOW + 1,
    windows: [],
    unavailable: { reason: "probeFailed" },
  };

  it("publishes a first sighting from the turn stream and tells its listeners", () => {
    const holder = new UsageLimitsHolder();
    const told: [string, UsageLimits | undefined][] = [];
    holder.subscribe((providerId, limits) => told.push([providerId, limits]));
    expect(holder.apply("anthropic", { observedAt: NOW, windows: good.windows })).toBe(true);
    expect(holder.get("anthropic")).toEqual(good);
    expect(told).toEqual([["anthropic", good]]);
  });

  it("is silent about an update that changes nothing", () => {
    const holder = new UsageLimitsHolder();
    holder.apply("anthropic", { observedAt: NOW, windows: good.windows });
    const told: unknown[] = [];
    holder.subscribe((...args) => told.push(args));
    expect(holder.apply("anthropic", { observedAt: NOW + 5, windows: good.windows })).toBe(false);
    expect(holder.apply("anthropic", { observedAt: NOW + 5, windows: [] })).toBe(false);
    expect(told).toEqual([]);
  });

  it("settles a read against what is held, keeping a good read over a failed probe", () => {
    const holder = new UsageLimitsHolder();
    expect(holder.settle("anthropic", { kind: "read", limits: good })).toBe(good);
    expect(holder.settle("anthropic", { kind: "read", limits: failed })).toBe(good);
    expect(holder.get("anthropic")).toBe(good);
  });

  it("answers a held probe with what is published, and clears on none", () => {
    const holder = new UsageLimitsHolder();
    const told: unknown[] = [];
    holder.subscribe((...args) => told.push(args));
    expect(holder.settle("anthropic", { kind: "held" })).toBeUndefined();
    holder.settle("anthropic", { kind: "read", limits: good });
    expect(holder.settle("anthropic", { kind: "held" })).toBe(good);
    expect(holder.settle("anthropic", { kind: "none" })).toBeUndefined();
    expect(holder.get("anthropic")).toBeUndefined();
    // A second `none` has nothing to clear and says nothing.
    holder.settle("anthropic", { kind: "none" });
    expect(told).toEqual([
      ["anthropic", good],
      ["anthropic", undefined],
    ]);
  });

  it("lets a listener leave, and survives one that throws", () => {
    const holder = new UsageLimitsHolder();
    const told: unknown[] = [];
    holder.subscribe(() => {
      throw new Error("listener bug");
    });
    const leave = holder.subscribe((...args) => told.push(args));
    holder.settle("anthropic", { kind: "read", limits: good });
    leave();
    holder.settle("anthropic", { kind: "none" });
    expect(told).toEqual([["anthropic", good]]);
  });
});
