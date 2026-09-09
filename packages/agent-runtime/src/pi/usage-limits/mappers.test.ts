import { describe, expect, it } from "vite-plus/test";

import { anthropicHeadersToUpdate, anthropicUsageFromEndpoint } from "./anthropic";
import { codexHeadersToUpdate, codexUsageFromEndpoint } from "./codex";
import { kimiUsageFromEndpoint } from "./kimi";
import { githubCopilotUsageFromEndpoint } from "./github-copilot";
import { xaiUsageFromEndpoint } from "./xai";
import { opencodeGoUsageFromEndpoint } from "./opencode-go";
import { headerUsageUpdate } from "./passive";
import {
  epochSecondsToIso,
  finiteNumber,
  isoTimestamp,
  percentOf,
  secondsFromNowToIso,
  windowShapeForMinutes,
} from "./windows";

const NOW = Date.parse("2026-03-01T12:00:00Z");
const RESET_5H = Date.parse("2026-03-01T14:00:00Z");
const RESET_7D = Date.parse("2026-03-05T09:30:00Z");
const iso = (ms: number): string => new Date(ms).toISOString();
const epochSeconds = (ms: number): string => String(Math.floor(ms / 1000));

// --- Anthropic ---------------------------------------------------------------

/** Headers as pi-ai's `headersToRecord` hands them over: lowercase keys. */
const ANTHROPIC_HEADERS = {
  "content-type": "application/json",
  "anthropic-ratelimit-unified-5h-utilization": "0.37",
  "anthropic-ratelimit-unified-5h-reset": epochSeconds(RESET_5H),
  "anthropic-ratelimit-unified-5h-status": "allowed",
  "anthropic-ratelimit-unified-7d-utilization": "0.04",
  "anthropic-ratelimit-unified-7d-reset": epochSeconds(RESET_7D),
  "anthropic-ratelimit-unified-7d-status": "allowed",
  "anthropic-ratelimit-unified-status": "allowed",
  "request-id": "req_x",
};

describe("anthropicHeadersToUpdate", () => {
  it("maps the unified 5h and 7d headers to the endpoint's window ids", () => {
    expect(anthropicHeadersToUpdate(ANTHROPIC_HEADERS, NOW)).toEqual({
      observedAt: NOW,
      windows: [
        {
          id: "five_hour",
          kind: "session",
          label: "Session",
          usedPercent: 37,
          resetsAt: iso(RESET_5H),
          windowDurationMins: 300,
        },
        {
          id: "seven_day",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 4,
          resetsAt: iso(RESET_7D),
          windowDurationMins: 10_080,
        },
      ],
    });
  });

  it("scales the 0–1 fraction to percent and clamps a fraction past one", () => {
    const update = anthropicHeadersToUpdate(
      { "anthropic-ratelimit-unified-5h-utilization": "1.2" },
      NOW,
    );
    expect(update?.windows).toEqual([
      {
        id: "five_hour",
        kind: "session",
        label: "Session",
        usedPercent: 100,
        windowDurationMins: 300,
      },
    ]);
  });

  it("carries a model-scoped weekly window under the endpoint's key, after the account-wide one", () => {
    const update = anthropicHeadersToUpdate(
      {
        "anthropic-ratelimit-unified-7d-opus-utilization": "0.5",
        "anthropic-ratelimit-unified-7d-opus-reset": epochSeconds(RESET_7D),
        "anthropic-ratelimit-unified-7d-sonnet-4-utilization": "0.25",
        "anthropic-ratelimit-unified-7d-utilization": "0.04",
      },
      NOW,
    );
    expect(update?.windows.map((window) => [window.id, window.label, window.usedPercent])).toEqual([
      ["seven_day", "Weekly", 4],
      ["seven_day_opus", "Weekly · Opus", 50],
      ["seven_day_sonnet_4", "Weekly · Sonnet 4", 25],
    ]);
    expect(update?.windows[1]?.resetsAt).toBe(iso(RESET_7D));
    expect(update?.windows[2]).not.toHaveProperty("resetsAt");
  });

  it("reads header names in any case", () => {
    const update = anthropicHeadersToUpdate(
      { "Anthropic-RateLimit-Unified-5H-Utilization": "0.1" },
      NOW,
    );
    expect(update?.windows[0]?.usedPercent).toBeCloseTo(10);
  });

  it("skips a window with a reset but no utilization, and says nothing when no window remains", () => {
    expect(
      anthropicHeadersToUpdate(
        {
          "anthropic-ratelimit-unified-5h-reset": epochSeconds(RESET_5H),
          "anthropic-ratelimit-unified-7d-utilization": "nope",
          "anthropic-ratelimit-unified-status": "allowed",
        },
        NOW,
      ),
    ).toBeNull();
    expect(anthropicHeadersToUpdate({ "content-type": "text/plain" }, NOW)).toBeNull();
  });

  it("ignores unrelated headers under the same prefix", () => {
    expect(
      anthropicHeadersToUpdate(
        {
          "anthropic-ratelimit-unified-representative-claim": "five_hour",
          "anthropic-ratelimit-unified-fallback-percentage": "0.5",
        },
        NOW,
      ),
    ).toBeNull();
  });
});

describe("anthropicUsageFromEndpoint", () => {
  const body = {
    five_hour: { utilization: 37, resets_at: "2026-03-01T14:00:00+00:00" },
    seven_day: { utilization: 4, resets_at: "2026-03-05T09:30:00+00:00" },
    seven_day_opus: { utilization: 12, resets_at: null },
    seven_day_sonnet: { utilization: 3, resets_at: "not a timestamp" },
    seven_day_oauth_apps: null,
    extra_usage: { is_enabled: false, monthly_limit: null },
  };

  it("reads the endpoint's windows under their own keys, normalizing the reset to ISO", () => {
    expect(anthropicUsageFromEndpoint(body, NOW)).toEqual({
      checkedAt: NOW,
      windows: [
        {
          id: "five_hour",
          kind: "session",
          label: "Session",
          usedPercent: 37,
          resetsAt: iso(RESET_5H),
          windowDurationMins: 300,
        },
        {
          id: "seven_day",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 4,
          resetsAt: iso(RESET_7D),
          windowDurationMins: 10_080,
        },
        {
          id: "seven_day_opus",
          kind: "weekly",
          label: "Weekly · Opus",
          usedPercent: 12,
          windowDurationMins: 10_080,
        },
        {
          id: "seven_day_sonnet",
          kind: "weekly",
          label: "Weekly · Sonnet",
          usedPercent: 3,
          windowDurationMins: 10_080,
        },
      ],
    });
  });

  it("uses the same ids the header path uses, so the two land on one row", () => {
    const fromHeaders = anthropicHeadersToUpdate(ANTHROPIC_HEADERS, NOW);
    const fromEndpoint = anthropicUsageFromEndpoint(body, NOW);
    expect(fromHeaders?.windows.map((window) => window.id)).toEqual(
      fromEndpoint.windows.slice(0, 2).map((window) => window.id),
    );
  });

  it("clamps a utilization the provider reports past the window", () => {
    const limits = anthropicUsageFromEndpoint({ five_hour: { utilization: 104 } }, NOW);
    expect(limits.windows[0]?.usedPercent).toBe(100);
  });

  it("reports a failed probe for a body that is not the shape expected", () => {
    const failed = { checkedAt: NOW, windows: [], unavailable: { reason: "probeFailed" } };
    expect(anthropicUsageFromEndpoint(null, NOW)).toEqual(failed);
    expect(anthropicUsageFromEndpoint([body], NOW)).toEqual(failed);
    expect(anthropicUsageFromEndpoint("<html>", NOW)).toEqual(failed);
    expect(anthropicUsageFromEndpoint({ five_hour: { utilization: "n/a" } }, NOW)).toEqual(failed);
    expect(anthropicUsageFromEndpoint({ extra_usage: {} }, NOW)).toEqual(failed);
  });
});

// --- Codex -------------------------------------------------------------------

const CODEX_HEADERS = {
  "content-type": "text/event-stream",
  "x-codex-primary-used-percent": "49",
  "x-codex-primary-window-minutes": "300",
  "x-codex-primary-reset-at": epochSeconds(RESET_5H),
  "x-codex-secondary-used-percent": "62",
  "x-codex-secondary-window-minutes": "10080",
  "x-codex-secondary-reset-at": epochSeconds(RESET_7D),
  "x-codex-plan-type": "plus",
};

describe("codexHeadersToUpdate", () => {
  it("maps both slots to windows named by their length", () => {
    expect(codexHeadersToUpdate(CODEX_HEADERS, NOW)).toEqual({
      observedAt: NOW,
      windows: [
        {
          id: "session",
          kind: "session",
          label: "Session",
          usedPercent: 49,
          resetsAt: iso(RESET_5H),
          windowDurationMins: 300,
        },
        {
          id: "weekly",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 62,
          resetsAt: iso(RESET_7D),
          windowDurationMins: 10_080,
        },
      ],
    });
  });

  it("names a weekly window in the primary slot weekly, not session", () => {
    const update = codexHeadersToUpdate(
      {
        "x-codex-primary-used-percent": "30",
        "x-codex-primary-window-minutes": "10080",
      },
      NOW,
    );
    expect(update?.windows.map((window) => window.id)).toEqual(["weekly"]);
  });

  it("falls back to reset-after-seconds when no reset-at is stated", () => {
    const update = codexHeadersToUpdate(
      {
        "x-codex-primary-used-percent": "30",
        "x-codex-primary-window-minutes": "300",
        "x-codex-primary-reset-after-seconds": "600",
      },
      NOW,
    );
    expect(update?.windows[0]?.resetsAt).toBe(iso(NOW + 600_000));
  });

  it("skips a slot whose length is not stated rather than guessing from the slot", () => {
    expect(codexHeadersToUpdate({ "x-codex-primary-used-percent": "30" }, NOW)).toBeNull();
    expect(
      codexHeadersToUpdate(
        { "x-codex-primary-used-percent": "30", "x-codex-primary-window-minutes": "0" },
        NOW,
      ),
    ).toBeNull();
  });

  it("says nothing for a response with no codex headers", () => {
    expect(codexHeadersToUpdate({ "content-type": "text/event-stream" }, NOW)).toBeNull();
  });
});

describe("codexUsageFromEndpoint", () => {
  const body = {
    plan_type: "plus",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: {
        used_percent: 49,
        limit_window_seconds: 18_000,
        reset_after_seconds: 7_200,
        reset_at: Math.floor(RESET_5H / 1000),
      },
      secondary_window: {
        used_percent: 62,
        limit_window_seconds: 604_800,
        reset_after_seconds: 340_200,
      },
    },
    credits: { has_credits: false, unlimited: false, balance: "0" },
  };

  it("reads both windows, preferring reset_at and falling back to reset_after_seconds", () => {
    expect(codexUsageFromEndpoint(body, NOW)).toEqual({
      checkedAt: NOW,
      windows: [
        {
          id: "session",
          kind: "session",
          label: "Session",
          usedPercent: 49,
          resetsAt: iso(RESET_5H),
          windowDurationMins: 300,
        },
        {
          id: "weekly",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 62,
          resetsAt: iso(NOW + 340_200_000),
          windowDurationMins: 10_080,
        },
      ],
    });
  });

  it("uses the same ids the header path uses", () => {
    expect(codexHeadersToUpdate(CODEX_HEADERS, NOW)?.windows.map((window) => window.id)).toEqual(
      codexUsageFromEndpoint(body, NOW).windows.map((window) => window.id),
    );
  });

  it("classifies a lone weekly primary window as weekly", () => {
    const limits = codexUsageFromEndpoint(
      { rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 604_800 } } },
      NOW,
    );
    expect(limits.windows.map((window) => window.id)).toEqual(["weekly"]);
    expect(limits.windows[0]).not.toHaveProperty("resetsAt");
  });

  it("reports a failed probe when the body names no window", () => {
    const failed = { checkedAt: NOW, windows: [], unavailable: { reason: "probeFailed" } };
    expect(codexUsageFromEndpoint(undefined, NOW)).toEqual(failed);
    expect(codexUsageFromEndpoint([], NOW)).toEqual(failed);
    expect(codexUsageFromEndpoint({ plan_type: "free" }, NOW)).toEqual(failed);
    expect(codexUsageFromEndpoint({ rate_limit: null }, NOW)).toEqual(failed);
    expect(codexUsageFromEndpoint({ rate_limit: { primary_window: null } }, NOW)).toEqual(failed);
    expect(
      codexUsageFromEndpoint(
        { rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 0 } } },
        NOW,
      ),
    ).toEqual(failed);
  });
});

// --- OpenCode Go -------------------------------------------------------------

/** The route as it serves from `dev`: three named windows, ISO resets. */
const OPENCODE_GO_BODY = {
  usage: {
    rolling: { status: "ok", percent: 4, resetsAt: "2026-03-01T16:27:38.287Z" },
    weekly: { status: "ok", percent: 3, resetsAt: "2026-03-08T00:00:00.287Z" },
    monthly: { status: "ok", percent: 1, resetsAt: "2026-03-13T06:06:01.287Z" },
  },
};

describe("opencodeGoUsageFromEndpoint", () => {
  it("reads the three named windows in order, with fixed lengths for the two that have one", () => {
    expect(opencodeGoUsageFromEndpoint(OPENCODE_GO_BODY, NOW)).toEqual({
      checkedAt: NOW,
      windows: [
        {
          id: "session",
          kind: "session",
          label: "Session",
          usedPercent: 4,
          resetsAt: "2026-03-01T16:27:38.287Z",
          windowDurationMins: 300,
        },
        {
          id: "weekly",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 3,
          resetsAt: "2026-03-08T00:00:00.287Z",
          windowDurationMins: 10_080,
        },
        {
          id: "monthly",
          kind: "monthly",
          label: "Monthly",
          usedPercent: 1,
          resetsAt: "2026-03-13T06:06:01.287Z",
          // 13 Feb → 13 Mar 2026: 28 days.
          windowDurationMins: 28 * 1_440,
        },
      ],
    });
  });

  it("gives the monthly window the length of the calendar month ending at its reset", () => {
    const monthly = (resetsAt: string) =>
      opencodeGoUsageFromEndpoint({ usage: { monthly: { percent: 1, resetsAt } } }, NOW).windows[0]
        ?.windowDurationMins;
    expect(monthly("2026-08-13T06:06:01Z")).toBe(31 * 1_440);
    expect(monthly("2026-05-01T00:00:00Z")).toBe(30 * 1_440);
    // No reset, no length: the row still draws, without a hairline.
    expect(
      opencodeGoUsageFromEndpoint({ usage: { monthly: { percent: 1 } } }, NOW).windows[0],
    ).toEqual({ id: "monthly", kind: "monthly", label: "Monthly", usedPercent: 1 });
  });

  it("reads rate-limited as nothing left, whatever percent rides beside it", () => {
    const limits = opencodeGoUsageFromEndpoint(
      {
        usage: {
          rolling: { status: "rate-limited", percent: 97, resetsAt: "2026-03-01T13:00:00Z" },
        },
      },
      NOW,
    );
    expect(limits.windows[0]?.usedPercent).toBe(100);
  });

  it("skips a window the body omits or cannot state, and clamps one past the bar", () => {
    const limits = opencodeGoUsageFromEndpoint(
      {
        usage: {
          rolling: { status: "ok", percent: 130 },
          weekly: { status: "ok" },
          monthly: null,
        },
      },
      NOW,
    );
    expect(limits.windows.map((window) => window.id)).toEqual(["session"]);
    expect(limits.windows[0]?.usedPercent).toBe(100);
  });

  it("reports a failed probe for a body that is not the route's shape", () => {
    const failed = { checkedAt: NOW, windows: [], unavailable: { reason: "probeFailed" } };
    expect(opencodeGoUsageFromEndpoint(undefined, NOW)).toEqual(failed);
    expect(opencodeGoUsageFromEndpoint([], NOW)).toEqual(failed);
    expect(opencodeGoUsageFromEndpoint({ usage: null }, NOW)).toEqual(failed);
    expect(opencodeGoUsageFromEndpoint({ usage: {} }, NOW)).toEqual(failed);
    // The pull request's draft shape, which the route never served.
    expect(
      opencodeGoUsageFromEndpoint(
        { rollingUsage: { status: "ok", usagePercent: 4, resetInSec: 3_600 } },
        NOW,
      ),
    ).toEqual(failed);
  });
});

// --- Kimi Code ---------------------------------------------------------------

/**
 * `/coding/v1/usages` as the endpoint serves it: protobuf-flavoured JSON, so
 * every count arrives as a STRING and the time unit wears its enum prefix.
 */
const KIMI_BODY = {
  usage: { limit: "1000", remaining: "380", resetTime: "2026-03-05T09:30:00.416717Z" },
  limits: [
    {
      window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
      detail: { limit: "1200", remaining: "756", resetTime: "2026-03-01T14:00:00.416717Z" },
    },
  ],
};

describe("kimiUsageFromEndpoint", () => {
  it("reads the plan window and the rate-limit window whose length the body states", () => {
    expect(kimiUsageFromEndpoint(KIMI_BODY, NOW)).toEqual({
      checkedAt: NOW,
      windows: [
        {
          id: "session",
          kind: "session",
          label: "Session",
          // 1200 − 756 of 1200.
          usedPercent: 37,
          // Kimi states resets to the MICROSECOND; the vocabulary carries
          // milliseconds, so the tail is dropped rather than rounded.
          resetsAt: "2026-03-01T14:00:00.416Z",
          windowDurationMins: 300,
        },
        {
          id: "weekly",
          kind: "weekly",
          label: "Weekly",
          // 1000 − 380 of 1000.
          usedPercent: 62,
          resetsAt: "2026-03-05T09:30:00.416Z",
          windowDurationMins: 10_080,
        },
      ],
    });
  });

  it("reads a spend the body states as `used` rather than as what is left", () => {
    const limits = kimiUsageFromEndpoint(
      { usage: { limit: "200", used: "50", resetTime: iso(RESET_7D) } },
      NOW,
    );
    expect(limits.windows).toEqual([
      {
        id: "weekly",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 25,
        resetsAt: iso(RESET_7D),
        windowDurationMins: 10_080,
      },
    ]);
  });

  it("names a rate-limit window by the length it states, in whatever unit it states it", () => {
    const inDays = kimiUsageFromEndpoint(
      {
        limits: [
          {
            window: { duration: 7, timeUnit: "TIME_UNIT_DAY" },
            detail: { limit: 100, remaining: 90 },
          },
          {
            window: { duration: 12, timeUnit: "TIME_UNIT_HOUR" },
            detail: { limit: 100, remaining: 40 },
          },
        ],
      },
      NOW,
    );
    expect(inDays.windows).toEqual([
      { id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 10, windowDurationMins: 10_080 },
      {
        id: "window_720m",
        kind: "other",
        label: "12h",
        usedPercent: 60,
        windowDurationMins: 720,
      },
    ]);
  });

  it("keeps the binding one when two entries meter the same length", () => {
    // Standard and HighSpeed are two tiers of one membership, so one span can
    // arrive twice. Two rows with one id is not a row a person can read, and
    // the one that stops a turn first is the one worth drawing.
    const limits = kimiUsageFromEndpoint(
      {
        limits: [
          {
            window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
            detail: { limit: 100, remaining: 80, resetTime: iso(RESET_5H) },
          },
          {
            window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
            detail: { limit: 100, remaining: 5 },
          },
          // A third, laxer reading of the same span must not win it back.
          {
            window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
            detail: { limit: 100, remaining: 99 },
          },
        ],
      },
      NOW,
    );
    expect(limits.windows).toEqual([
      {
        id: "session",
        kind: "session",
        label: "Session",
        usedPercent: 95,
        windowDurationMins: 300,
      },
    ]);
  });

  it("skips an entry whose length or counts it cannot read, and the monthly freeze flag", () => {
    const limits = kimiUsageFromEndpoint(
      {
        usage: { limit: "1000", remaining: "380", resetTime: iso(RESET_7D) },
        limits: [
          null,
          { window: null, detail: {} },
          { window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" }, detail: null },
          // A unit this build does not know, and a duration that is not one.
          { window: { duration: 3, timeUnit: "TIME_UNIT_FORTNIGHT" }, detail: { limit: 1 } },
          { window: { duration: 0, timeUnit: "TIME_UNIT_MINUTE" }, detail: { limit: 1 } },
          { window: { duration: 300 }, detail: { limit: 1 } },
          // A window nothing can be spent from is not a window.
          {
            window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
            detail: { limit: 0, remaining: 0 },
          },
          // Neither `remaining` nor `used`: a limit with no reading.
          { window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" }, detail: { limit: 100 } },
        ],
        // The monthly membership cap: `remaining` is sticky, so the only fact
        // in it is a boolean, and this vocabulary carries shares.
        totalQuota: { limit: "100", used: "1", remaining: "99" },
      },
      NOW,
    );
    expect(limits.windows.map((window) => window.id)).toEqual(["weekly"]);
  });

  it("holds an overspent window at a full bar", () => {
    const limits = kimiUsageFromEndpoint({ usage: { limit: 100, remaining: -20 } }, NOW);
    expect(limits.windows[0]?.usedPercent).toBe(100);
    expect(limits.windows[0]).not.toHaveProperty("resetsAt");
  });

  it("reports a failed probe when the body names no usable window", () => {
    const failed = { checkedAt: NOW, windows: [], unavailable: { reason: "probeFailed" } };
    expect(kimiUsageFromEndpoint(undefined, NOW)).toEqual(failed);
    expect(kimiUsageFromEndpoint([], NOW)).toEqual(failed);
    expect(kimiUsageFromEndpoint({}, NOW)).toEqual(failed);
    expect(kimiUsageFromEndpoint({ usage: null, limits: null }, NOW)).toEqual(failed);
    expect(kimiUsageFromEndpoint({ usage: { limit: "0" } }, NOW)).toEqual(failed);
    expect(kimiUsageFromEndpoint({ totalQuota: { used: "1" } }, NOW)).toEqual(failed);
  });
});

// --- GitHub Copilot ----------------------------------------------------------

/** `/copilot_internal/user` for a paid seat: three classes, two of them unlimited. */
const COPILOT_BODY = {
  copilot_plan: "individual_pro",
  access_type_sku: "plus_monthly_subscriber_quota",
  quota_reset_date: "2026-04-01",
  quota_snapshots: {
    chat: {
      entitlement: 0,
      percent_remaining: 100,
      quota_id: "chat",
      remaining: 0,
      unlimited: true,
    },
    completions: {
      entitlement: 0,
      percent_remaining: 100,
      quota_id: "completions",
      remaining: 0,
      unlimited: true,
    },
    premium_interactions: {
      entitlement: 300,
      overage_count: 0,
      overage_permitted: false,
      percent_remaining: 31.17,
      quota_id: "premium_interactions",
      quota_remaining: 93.5,
      remaining: 93,
      unlimited: false,
    },
  },
};

describe("githubCopilotUsageFromEndpoint", () => {
  it("draws the metered class and skips the ones the plan does not meter", () => {
    expect(githubCopilotUsageFromEndpoint(COPILOT_BODY, NOW)).toEqual({
      checkedAt: NOW,
      windows: [
        {
          id: "premium_interactions",
          kind: "monthly",
          label: "Premium requests",
          // The endpoint states what is LEFT; the vocabulary carries what is spent.
          usedPercent: 68.83,
          resetsAt: "2026-04-01T00:00:00.000Z",
          // 1 Mar → 1 Apr: the calendar month that ends at the reset.
          windowDurationMins: 31 * 1_440,
        },
      ],
    });
  });

  it("draws every class a seat really meters, in the order they matter", () => {
    const limits = githubCopilotUsageFromEndpoint(
      {
        quota_reset_date: "2026-03-01",
        quota_snapshots: {
          completions: { percent_remaining: 12, unlimited: false },
          chat: { percent_remaining: 40, unlimited: false },
          premium_interactions: { percent_remaining: 0, unlimited: false },
        },
      },
      NOW,
    );
    expect(limits.windows.map((window) => [window.id, window.label, window.usedPercent])).toEqual([
      ["premium_interactions", "Premium requests", 100],
      ["chat", "Chat", 60],
      ["completions", "Completions", 88],
    ]);
    // 1 Feb → 1 Mar 2026: a 28-day month, not a fixed 30.
    expect(limits.windows[0]?.windowDurationMins).toBe(28 * 1_440);
  });

  it("keeps a window whose reset the body does not state, without a length", () => {
    const limits = githubCopilotUsageFromEndpoint(
      { quota_snapshots: { premium_interactions: { percent_remaining: 50 } } },
      NOW,
    );
    expect(limits.windows).toEqual([
      {
        id: "premium_interactions",
        kind: "monthly",
        label: "Premium requests",
        usedPercent: 50,
      },
    ]);
  });

  it("reports a failed probe when no class is both present and metered", () => {
    const failed = { checkedAt: NOW, windows: [], unavailable: { reason: "probeFailed" } };
    expect(githubCopilotUsageFromEndpoint(undefined, NOW)).toEqual(failed);
    expect(githubCopilotUsageFromEndpoint([], NOW)).toEqual(failed);
    expect(githubCopilotUsageFromEndpoint({ copilot_plan: "individual" }, NOW)).toEqual(failed);
    expect(githubCopilotUsageFromEndpoint({ quota_snapshots: null }, NOW)).toEqual(failed);
    expect(githubCopilotUsageFromEndpoint({ quota_snapshots: {} }, NOW)).toEqual(failed);
    expect(
      githubCopilotUsageFromEndpoint({ quota_snapshots: { premium_interactions: null } }, NOW),
    ).toEqual(failed);
    // Every class unlimited: a seat with nothing to meter, not a failed read
    // of one — but there is no window to draw either way.
    expect(
      githubCopilotUsageFromEndpoint(
        {
          quota_snapshots: {
            chat: { percent_remaining: 100, unlimited: true },
            completions: { percent_remaining: 100, unlimited: true },
          },
        },
        NOW,
      ),
    ).toEqual(failed);
    // A class with no percentage at all.
    expect(
      githubCopilotUsageFromEndpoint(
        { quota_snapshots: { premium_interactions: { entitlement: 300 } } },
        NOW,
      ),
    ).toEqual(failed);
    // The free-seat shape, which states counts and no percentages.
    expect(
      githubCopilotUsageFromEndpoint(
        {
          copilot_plan: "individual",
          access_type_sku: "free_limited_copilot",
          limited_user_quotas: { chat: 410, completions: 4_000 },
          limited_user_reset_date: "2026-03-11",
        },
        NOW,
      ),
    ).toEqual(failed);
  });
});

// --- xAI ---------------------------------------------------------------------

/** `/v1/billing?format=credits`: the shared pool grok.com's own meter shows. */
const XAI_BODY = {
  config: {
    currentPeriod: {
      type: "USAGE_PERIOD_TYPE_WEEKLY",
      start: "2026-02-26T09:30:00.885620+00:00",
      end: "2026-03-05T09:30:00.885620+00:00",
    },
    creditUsagePercent: 75,
    productUsage: [
      { product: "GrokBuild", usagePercent: 54 },
      { product: "Api", usagePercent: 21 },
    ],
    isUnifiedBillingUser: true,
    prepaidBalance: { val: 0 },
  },
};

describe("xaiUsageFromEndpoint", () => {
  it("reads the combined pool as one window, named by the length its period states", () => {
    expect(xaiUsageFromEndpoint(XAI_BODY, NOW)).toEqual({
      checkedAt: NOW,
      windows: [
        {
          id: "weekly",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 75,
          resetsAt: "2026-03-05T09:30:00.885Z",
          windowDurationMins: 10_080,
        },
      ],
    });
  });

  it("reads a period with the share omitted as nothing spent", () => {
    // Protobuf drops a field at its default, so an untouched account sends no
    // `creditUsagePercent` at all rather than a zero.
    const limits = xaiUsageFromEndpoint(
      {
        config: {
          currentPeriod: {
            type: "USAGE_PERIOD_TYPE_WEEKLY",
            start: "2026-02-26T09:30:00Z",
            end: "2026-03-05T09:30:00Z",
          },
        },
      },
      NOW,
    );
    expect(limits.windows).toEqual([
      {
        id: "weekly",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 0,
        resetsAt: iso(RESET_7D),
        windowDurationMins: 10_080,
      },
    ]);
  });

  it("names the window by the length of the period, not by the enum beside it", () => {
    const limits = xaiUsageFromEndpoint(
      {
        config: {
          // A month of days under a name that says otherwise: the length is
          // the fact the ids are keyed on.
          currentPeriod: {
            type: "USAGE_PERIOD_TYPE_WEEKLY",
            start: "2026-02-01T00:00:00Z",
            end: "2026-03-03T00:00:00Z",
          },
          creditUsagePercent: 12.5,
        },
      },
      NOW,
    );
    expect(limits.windows).toEqual([
      {
        id: "monthly",
        kind: "monthly",
        label: "Monthly",
        usedPercent: 12.5,
        resetsAt: "2026-03-03T00:00:00.000Z",
        windowDurationMins: 43_200,
      },
    ]);
  });

  it("reports a failed probe when no period is stated", () => {
    const failed = { checkedAt: NOW, windows: [], unavailable: { reason: "probeFailed" } };
    expect(xaiUsageFromEndpoint(undefined, NOW)).toEqual(failed);
    expect(xaiUsageFromEndpoint([], NOW)).toEqual(failed);
    expect(xaiUsageFromEndpoint({ config: null }, NOW)).toEqual(failed);
    expect(xaiUsageFromEndpoint({ config: {} }, NOW)).toEqual(failed);
    expect(xaiUsageFromEndpoint({ config: { currentPeriod: null } }, NOW)).toEqual(failed);
    // The dollar-allowance shape the same route serves without `?format=credits`:
    // a credit balance, which this vocabulary does not carry.
    expect(
      xaiUsageFromEndpoint(
        { config: { monthlyLimit: { val: 15_000 }, used: { val: 2_931 } } },
        NOW,
      ),
    ).toEqual(failed);
    expect(
      xaiUsageFromEndpoint({ config: { currentPeriod: { start: "2026-02-26T09:30:00Z" } } }, NOW),
    ).toEqual(failed);
    // A period that ends before it starts places nothing.
    expect(
      xaiUsageFromEndpoint(
        {
          config: {
            currentPeriod: { start: "2026-03-05T09:30:00Z", end: "2026-02-26T09:30:00Z" },
          },
        },
        NOW,
      ),
    ).toEqual(failed);
  });
});

describe("headerUsageUpdate", () => {
  it("delegates to the mapper the provider owns and to nothing for anyone else", () => {
    expect(headerUsageUpdate("openai-codex", CODEX_HEADERS, NOW)?.windows).toHaveLength(2);
    expect(headerUsageUpdate("anthropic", ANTHROPIC_HEADERS, NOW)?.windows).toHaveLength(2);
    expect(headerUsageUpdate("openai", ANTHROPIC_HEADERS, NOW)).toBeNull();
    // Go puts nothing on a turn's response: on-demand only.
    expect(headerUsageUpdate("opencode-go", ANTHROPIC_HEADERS, NOW)).toBeNull();
  });
});

describe("value readers", () => {
  it("reads a finite number from a number, a numeric string, and nothing else", () => {
    expect(finiteNumber(37)).toBe(37);
    expect(finiteNumber(" 0.5 ")).toBe(0.5);
    expect(finiteNumber(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(finiteNumber(Number.NaN)).toBeUndefined();
    expect(finiteNumber("")).toBeUndefined();
    expect(finiteNumber("   ")).toBeUndefined();
    expect(finiteNumber("nope")).toBeUndefined();
    expect(finiteNumber(null)).toBeUndefined();
    expect(finiteNumber(undefined)).toBeUndefined();
    expect(finiteNumber(true)).toBeUndefined();
    expect(percentOf("140")).toBe(100);
    expect(percentOf(null)).toBeUndefined();
  });

  it("turns epoch seconds into ISO, and refuses what is not a positive number", () => {
    expect(epochSecondsToIso(Math.floor(RESET_5H / 1000))).toBe(iso(RESET_5H));
    expect(epochSecondsToIso("0")).toBeUndefined();
    expect(epochSecondsToIso(-1)).toBeUndefined();
    expect(epochSecondsToIso(null)).toBeUndefined();
    expect(secondsFromNowToIso(600, NOW)).toBe(iso(NOW + 600_000));
    expect(secondsFromNowToIso("0", NOW)).toBeUndefined();
    expect(secondsFromNowToIso(null, NOW)).toBeUndefined();
  });

  it("normalizes an ISO timestamp the provider wrote, and drops one that does not parse", () => {
    expect(isoTimestamp("2026-03-01T14:00:00+00:00")).toBe(iso(RESET_5H));
    expect(isoTimestamp("tomorrow")).toBeUndefined();
    expect(isoTimestamp(0)).toBeUndefined();
    expect(isoTimestamp(null)).toBeUndefined();
  });
});

describe("windowShapeForMinutes", () => {
  it("names the three lengths a subscription meters and describes any other by its length", () => {
    expect(windowShapeForMinutes(300)).toEqual({
      id: "session",
      kind: "session",
      label: "Session",
    });
    expect(windowShapeForMinutes(10_080)).toEqual({
      id: "weekly",
      kind: "weekly",
      label: "Weekly",
    });
    expect(windowShapeForMinutes(43_200)).toEqual({
      id: "monthly",
      kind: "monthly",
      label: "Monthly",
    });
    expect(windowShapeForMinutes(44_640)).toEqual({
      id: "monthly",
      kind: "monthly",
      label: "Monthly",
    });
    expect(windowShapeForMinutes(720)).toEqual({ id: "window_720m", kind: "other", label: "12h" });
  });
});
