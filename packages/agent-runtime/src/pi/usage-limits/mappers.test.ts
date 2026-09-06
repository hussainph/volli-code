import { describe, expect, it } from "vite-plus/test";

import { anthropicHeadersToUpdate, anthropicUsageFromEndpoint } from "./anthropic";
import { codexHeadersToUpdate, codexUsageFromEndpoint } from "./codex";
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

describe("headerUsageUpdate", () => {
  it("delegates to the mapper the provider owns and to nothing for anyone else", () => {
    expect(headerUsageUpdate("openai-codex", CODEX_HEADERS, NOW)?.windows).toHaveLength(2);
    expect(headerUsageUpdate("anthropic", ANTHROPIC_HEADERS, NOW)?.windows).toHaveLength(2);
    expect(headerUsageUpdate("openai", ANTHROPIC_HEADERS, NOW)).toBeNull();
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
