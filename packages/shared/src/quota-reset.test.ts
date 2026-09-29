import { describe, expect, it } from "vite-plus/test";

import { QUOTA_RESET_HORIZON_MS, quotaResetInstant } from "./quota-reset";
import type { UsageWindow } from "./usage-limits";

// The ledger's own sentences (CLAUDE.md asks for the real text): these are the
// Attention details the Pi runtime recorded on this machine.
const ZAI_PLAIN =
  "429: Usage limit reached for 5 hour. Your limit will reset at 2026-09-10 04:24:36";
const ZAI_ENVELOPE =
  '429: {"code":"1308","message":"Usage limit reached for 5 hour. Your limit will reset at 2026-08-22 11:16:11"}';
const CODEX_WS = "Codex error: The usage limit has been reached";
const CODEX_SSE = "You have hit your ChatGPT usage limit (prolite plan). Try again in ~7670 min.";
const ANTHROPIC_EXTRA =
  "400 You're out of extra usage. Add more at claude.ai/settings/usage and keep going.";
const CONSOLE_GO =
  "OpenAI API error (429): Error from provider (Console Go): Upstream request failed: [rate_limit_exceeded] Output token rate limit exceeded. Please retry after a brief wait.";

/** The first refusal the ledger holds for each Z.ai family. */
const ZAI_PLAIN_SEEN = Date.parse("2026-09-09T17:58:51Z");
const ZAI_ENVELOPE_SEEN = Date.parse("2026-08-21T22:58:15Z");

function window(overrides: Partial<UsageWindow>): UsageWindow {
  return {
    id: "session",
    kind: "session",
    label: "Session",
    usedPercent: 100,
    resetsAt: "2026-09-06T14:00:00.000Z",
    ...overrides,
  };
}

describe("quotaResetInstant", () => {
  it("reads Z.ai's zoneless reset as China Standard Time", () => {
    expect(
      quotaResetInstant({ providerId: "zai", message: ZAI_PLAIN, observedAt: ZAI_PLAIN_SEEN }),
    ).toBe(Date.parse("2026-09-09T20:24:36Z"));
    // The JSON envelope an older build kept around the same sentence.
    expect(
      quotaResetInstant({
        providerId: "zai",
        message: ZAI_ENVELOPE,
        observedAt: ZAI_ENVELOPE_SEEN,
      }),
    ).toBe(Date.parse("2026-08-22T03:16:11Z"));
  });

  it("refuses a zoneless reset from a provider whose zone was never measured", () => {
    for (const providerId of ["zai-coding-cn", "anthropic", "openai"]) {
      expect(
        quotaResetInstant({ providerId, message: ZAI_PLAIN, observedAt: ZAI_PLAIN_SEEN }),
      ).toBeNull();
    }
  });

  it("reads a reset that states its own zone from any provider", () => {
    const observedAt = Date.parse("2026-09-09T12:00:00Z");
    const read = (message: string) =>
      quotaResetInstant({ providerId: "unknown", message, observedAt });
    expect(read("Usage limit reached. Your limit will reset at 2026-09-09T14:00:00Z")).toBe(
      Date.parse("2026-09-09T14:00:00Z"),
    );
    expect(read("Quota spent; resets at 2026-09-09 20:30:00+08:00")).toBe(
      Date.parse("2026-09-09T12:30:00Z"),
    );
    expect(read("quota: reset at 2026-09-09 09:30:00.250 -0530")).toBe(
      Date.parse("2026-09-09T15:00:00Z"),
    );
  });

  it("counts pi-ai's relative Codex wait from the failure, rounded up a minute", () => {
    const observedAt = Date.parse("2026-09-09T18:47:07Z");
    expect(quotaResetInstant({ providerId: "openai-codex", message: CODEX_SSE, observedAt })).toBe(
      observedAt + 7671 * 60_000,
    );
  });

  it("falls back to the provider's spent windows when the failure names no time", () => {
    const observedAt = Date.parse("2026-09-06T09:50:34Z");
    expect(
      quotaResetInstant({
        providerId: "openai-codex",
        message: CODEX_WS,
        observedAt,
        windows: [
          // Spent, and the latest: the turn cannot run until this one is back.
          window({ id: "weekly", resetsAt: "2026-09-08T00:00:00.000Z" }),
          window({ resetsAt: "2026-09-06T14:00:00.000Z" }),
          // Not spent, however late it resets.
          window({ id: "monthly", usedPercent: 40, resetsAt: "2026-09-30T00:00:00.000Z" }),
          // Spent, but its reset is unknown, unreadable, or already behind.
          window({ id: "a", resetsAt: undefined }),
          window({ id: "b", resetsAt: "not a time" }),
          window({ id: "c", resetsAt: "2026-09-06T09:00:00.000Z" }),
        ],
      }),
    ).toBe(Date.parse("2026-09-08T00:00:00.000Z"));
  });

  it("says nothing for a usage limit with no time and no spent window", () => {
    const observedAt = Date.parse("2026-09-06T09:50:34Z");
    expect(quotaResetInstant({ providerId: "openai-codex", message: CODEX_WS, observedAt })).toBe(
      null,
    );
    expect(
      quotaResetInstant({
        providerId: "openai-codex",
        message: CODEX_WS,
        observedAt,
        windows: [window({ usedPercent: 99 })],
      }),
    ).toBeNull();
  });

  it("never offers a time for billing, however spent the windows look", () => {
    expect(
      quotaResetInstant({
        providerId: "anthropic",
        message: ANTHROPIC_EXTRA,
        observedAt: 0,
        windows: [window({ resetsAt: "1970-01-01T05:00:00.000Z" })],
      }),
    ).toBeNull();
  });

  it("does not read a rate limit as a quota, even with a spent window or a stated wait", () => {
    expect(
      quotaResetInstant({
        providerId: "opencode-go",
        message: CONSOLE_GO,
        observedAt: 0,
        windows: [window({ resetsAt: "1970-01-01T05:00:00.000Z" })],
      }),
    ).toBeNull();
    expect(
      quotaResetInstant({
        providerId: "openai-codex",
        message: "429 Too many requests. Try again in ~2 min.",
        observedAt: 0,
      }),
    ).toBeNull();
  });

  it("refuses a reset at or before the failure, or implausibly far past it", () => {
    const after = Date.parse("2026-09-10T00:00:00Z");
    expect(quotaResetInstant({ providerId: "zai", message: ZAI_PLAIN, observedAt: after })).toBe(
      null,
    );
    expect(
      quotaResetInstant({
        providerId: "zai",
        message: ZAI_PLAIN,
        observedAt: Date.parse("2026-09-09T20:24:36Z"),
      }),
    ).toBeNull();
    expect(
      quotaResetInstant({
        providerId: "zai",
        message: ZAI_PLAIN,
        observedAt: Date.parse("2026-09-09T20:24:36Z") - QUOTA_RESET_HORIZON_MS - 1,
      }),
    ).toBeNull();
    // A wait so long it overflows is not a reset either.
    expect(
      quotaResetInstant({
        providerId: "openai-codex",
        message: `You have hit your ChatGPT usage limit. Try again in ~${"9".repeat(400)} min.`,
        observedAt: 0,
      }),
    ).toBeNull();
  });
});
