import { describe, expect, it } from "vite-plus/test";
import type { ModelAccessProvider, UsageLimits, UsageWindow, UsageWindowKind } from "@volli/shared";

import { usageLimitAccounts } from "./accounts";
import { usageIconLabel, usageIconReading, usageIconWindows } from "./icon-reading";
import type { UsagePin } from "./usage-pin";

const NOW = Date.parse("2026-03-01T12:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SESSION_MINS = 300;
const WEEK_MINS = 10_080;

function win(
  id: string,
  kind: UsageWindowKind,
  label: string,
  usedPercent: number,
  // Two thirds of the way through a five-hour window, so a session fixture is
  // ahead of pace above 60% used and comfortably under it below.
  resetsInMs = 2 * HOUR + 13 * 60_000,
  windowDurationMins: number | undefined = SESSION_MINS,
): UsageWindow {
  return {
    id,
    kind,
    label,
    usedPercent,
    resetsAt: new Date(NOW + resetsInMs).toISOString(),
    ...(windowDurationMins === undefined ? {} : { windowDurationMins }),
  };
}

function provider(id: string, label: string, usageLimits?: UsageLimits): ModelAccessProvider {
  return {
    id,
    label,
    state: "available",
    accountLabel: null,
    billingSource: "subscription",
    recovery: null,
    signIn: [],
    hasStoredCredential: true,
    ...(usageLimits === undefined ? {} : { usageLimits }),
  };
}

const limits = (...windows: UsageWindow[]): UsageLimits => ({ checkedAt: NOW, windows });

/** The fixtures go through the real sorter, so the glyph and the rows agree. */
function read(...providers: readonly ModelAccessProvider[]) {
  return readPinned(null, ...providers);
}

function readPinned(pin: UsagePin | null, ...providers: readonly ModelAccessProvider[]) {
  return usageIconReading({ kind: "read", accounts: usageLimitAccounts(providers), now: NOW }, pin);
}

/** OpenCode Go's shape: three spans at once, the only account with more than two. */
const openCodeGo = (session: number, weekly: number, monthly: number): ModelAccessProvider =>
  provider(
    "opencode-go",
    "OpenCode Go",
    limits(
      win("session", "session", "Session", session),
      win("weekly", "weekly", "Weekly", weekly, 4 * DAY, WEEK_MINS),
      win("monthly", "monthly", "Monthly", monthly, 12 * DAY, 44_640),
    ),
  );

/** Claude Code's shape: a five-hour window and a weekly one. */
const anthropic = (session: number, weekly: number): ModelAccessProvider =>
  provider(
    "anthropic",
    "Anthropic",
    limits(
      win("five_hour", "session", "Session", session),
      win("seven_day", "weekly", "Weekly", weekly, 6 * DAY, WEEK_MINS),
    ),
  );

/** A seat whose only meter is monthly premium requests. The one-window case. */
const copilot = (monthly: number): ModelAccessProvider =>
  provider(
    "github-copilot",
    "GitHub Copilot",
    limits(win("premium", "monthly", "Premium requests", monthly, 20 * DAY, 44_640)),
  );

/** Another one-window account, kept barely touched so it never leads. */
const xai = (weekly: number): ModelAccessProvider =>
  provider("xai", "xAI", limits(win("weekly", "weekly", "Weekly", weekly, 6 * DAY, WEEK_MINS)));

describe("usageIconReading", () => {
  it("has nothing to draw before anything has been read", () => {
    const reading = usageIconReading({ kind: "unread" });
    expect(reading).toEqual({
      kind: "unread",
      lead: null,
      reported: null,
      pinned: [],
      others: [],
    });
    // The glyph tells these two apart by a dash, so the reading has to as well.
    expect(usageIconReading({ kind: "failed" }).kind).toBe("failed");
  });

  it("reports the account closest to running out, and counts the rest", () => {
    // Anthropic is listed first and is the healthier account: the lead comes
    // from `accounts.ts`'s own sort, never from the order they arrived in.
    const reading = read(anthropic(37, 4), copilot(69));

    expect(reading.lead?.label).toBe("GitHub Copilot");
    expect(reading.reported?.id).toBe("premium");
    expect(reading.reported?.remaining).toBe(31);
    expect(reading.others.map((account) => account.label)).toEqual(["Anthropic"]);
  });

  it("reports the window that binds the lead, not its first one", () => {
    // 63% left on the session, 96% on the weekly: the session binds, and it is
    // what the popover's collapsed row states too.
    const reading = read(anthropic(37, 4));
    expect(reading.reported?.id).toBe("five_hour");
    expect(reading.reported?.remaining).toBe(63);
  });

  it("orders windows by family, never by value, so a slot means one thing", () => {
    // The weekly has more left than the session, so a value sort would put it
    // second; family order keeps the short span on top whatever the numbers do.
    const reading = read(anthropic(63, 4));
    expect(reading.lead?.windows.map((window) => window.id)).toEqual(["five_hour", "seven_day"]);

    const other = read(
      provider(
        "opencode-go",
        "OpenCode Go",
        limits(
          win("monthly", "monthly", "Monthly", 42, 12 * DAY, 44_640),
          win("plan", "other", "Plan", 10, 4 * DAY, undefined),
          win("session", "session", "Session", 22),
          win("weekly", "weekly", "Weekly", 47, 4 * DAY, WEEK_MINS),
        ),
      ),
    );
    expect(other.lead?.windows.map((window) => window.kind)).toEqual([
      "session",
      "weekly",
      "monthly",
      "other",
    ]);
  });

  it("takes the same figure and the same verdict the popover's rows print", () => {
    // 6.4% left rounds to 6 in both places; a glyph drawn from the unrounded
    // number beside a row that says 6% is the surface disagreeing with itself.
    const reading = read(anthropic(93.6, 4));
    expect(reading.reported?.remaining).toBe(6);
    expect(reading.reported?.tone).toBe("critical");

    // Amber from PACE alone: 39% left with 44% of the window still to run.
    const paced = read(anthropic(61, 4));
    const session = paced.lead?.windows[0];
    expect(session?.remaining).toBe(39);
    expect(session?.pace).toBe("ahead");
    expect(session?.tone).toBe("attention");
  });

  it("has no pace for a window that cannot be placed in time", () => {
    const reading = read(
      provider(
        "kimi-coding",
        "Kimi For Coding",
        limits(win("usage", "other", "Plan", 30, 0, undefined)),
      ),
    );
    expect(reading.reported?.pace).toBeNull();
    expect(reading.reported?.tone).toBe("normal");
  });

  it("drops an account whose own read failed rather than drawing a zero", () => {
    const reading = read(
      anthropic(37, 4),
      provider("xai", "xAI", {
        checkedAt: NOW,
        windows: [],
        unavailable: { reason: "probeFailed" },
      }),
    );
    expect(reading.lead?.label).toBe("Anthropic");
    // It is still a row in the popover, where a line can explain it. It is
    // nothing to a glyph, so it is not one of the others either.
    expect(reading.others).toEqual([]);
  });

  it("is empty when the read succeeded and nothing is metered", () => {
    const reading = usageIconReading({ kind: "read", accounts: [], now: NOW });
    expect(reading).toEqual({
      kind: "read",
      lead: null,
      reported: null,
      pinned: [],
      others: [],
    });
  });
});

describe("usageIconWindows", () => {
  it("prints one window in the top slot", () => {
    expect(usageIconWindows(read(copilot(69))).map((window) => window.id)).toEqual(["premium"]);
  });

  it("prints both when there are two", () => {
    expect(usageIconWindows(read(anthropic(37, 4))).map((window) => window.id)).toEqual([
      "five_hour",
      "seven_day",
    ]);
  });

  it("keeps the reported window when an account reports three", () => {
    const three = openCodeGo;

    // The monthly binds: it must be one of the two, and the other slot goes to
    // the next window by family order rather than by which number is worse.
    const binding = usageIconWindows(read(three(22, 47, 58)));
    expect(binding.map((window) => window.id)).toEqual(["session", "monthly"]);
    // Family order survives: the kept pair is never re-sorted by value.
    expect(binding.map((window) => window.kind)).toEqual(["session", "monthly"]);

    // When the session binds, the pair is the first two.
    expect(usageIconWindows(read(three(95, 10, 5))).map((window) => window.id)).toEqual([
      "session",
      "weekly",
    ]);
  });

  it("falls back to the first two when the reported window is not among them", () => {
    const reading = read(anthropic(37, 4));
    expect(
      usageIconWindows({
        ...reading,
        lead:
          reading.lead === null
            ? null
            : {
                ...reading.lead,
                windows: [
                  ...reading.lead.windows,
                  {
                    id: "third",
                    kind: "monthly",
                    label: "Monthly",
                    remaining: 50,
                    tone: "normal",
                    pace: null,
                  },
                ],
              },
        reported: null,
      }).map((window) => window.id),
    ).toEqual(["five_hour", "seven_day"]);
  });

  it("has nothing to print with no lead", () => {
    expect(usageIconWindows(usageIconReading({ kind: "unread" }))).toEqual([]);
  });

  it("prints both pinned windows of three, even when a third binds", () => {
    // The monthly binds and would take a slot unpinned; two pins fill both.
    const pin = { providerId: "opencode-go", windowIds: ["weekly", "session"] };
    expect(
      usageIconWindows(readPinned(pin, openCodeGo(22, 47, 58))).map((window) => window.id),
    ).toEqual(["session", "weekly"]);
  });

  it("gives one pin a slot and the next window by family order the other", () => {
    const pin = { providerId: "opencode-go", windowIds: ["monthly"] };
    // Session binds here; the pinned monthly still shows, beside the reported
    // window — which is now the pinned one — and the first by family order.
    expect(
      usageIconWindows(readPinned(pin, openCodeGo(95, 10, 5))).map((window) => window.id),
    ).toEqual(["session", "monthly"]);
  });
});

describe("usageIconReading with a pin", () => {
  it("reports the pinned account even when another is nearer to running out", () => {
    const pin = { providerId: "anthropic", windowIds: ["five_hour"] };
    const reading = readPinned(pin, anthropic(37, 4), copilot(97));

    expect(reading.lead?.label).toBe("Anthropic");
    expect(reading.reported?.id).toBe("five_hour");
    expect(reading.pinned.map((window) => window.id)).toEqual(["five_hour"]);
    // The account the sort would have chosen is still counted, not lost.
    expect(reading.others.map((other) => other.label)).toEqual(["GitHub Copilot"]);
    // A lens, not a fact: the account's own binding window is untouched.
    expect(reading.lead?.binding?.id).toBe("five_hour");
  });

  it("reports the pinned window rather than the account's binding one", () => {
    // The session is 90% used and binds; pinning the weekly makes the weekly
    // the one the name leads with.
    const reading = readPinned(
      { providerId: "anthropic", windowIds: ["seven_day"] },
      anthropic(90, 4),
    );
    expect(reading.lead?.binding?.id).toBe("five_hour");
    expect(reading.reported?.id).toBe("seven_day");
  });

  it("reports whichever of two pinned windows has least left", () => {
    const reading = readPinned(
      { providerId: "opencode-go", windowIds: ["weekly", "session"] },
      openCodeGo(22, 47, 58),
    );
    // Family order, whatever order they were pinned in.
    expect(reading.pinned.map((window) => window.id)).toEqual(["session", "weekly"]);
    expect(reading.reported?.id).toBe("weekly");

    // And the session when it is the one lower.
    const sessionLower = readPinned(
      { providerId: "opencode-go", windowIds: ["weekly", "session"] },
      openCodeGo(90, 10, 5),
    );
    expect(sessionLower.reported?.id).toBe("session");
  });

  it("falls back to the sort when the pinned account is not metered", () => {
    const reading = readPinned(
      { providerId: "openai-codex", windowIds: ["primary"] },
      anthropic(37, 4),
      copilot(97),
    );
    expect(reading.lead?.label).toBe("GitHub Copilot");
    expect(reading.pinned).toEqual([]);
  });

  it("falls back to the sort when the pinned window is no longer reported", () => {
    const reading = readPinned(
      { providerId: "anthropic", windowIds: ["opus_weekly"] },
      anthropic(37, 4),
      copilot(97),
    );
    expect(reading.lead?.label).toBe("GitHub Copilot");
    expect(reading.pinned).toEqual([]);
  });

  it("honours the half of a pin that still resolves", () => {
    const reading = readPinned(
      { providerId: "anthropic", windowIds: ["opus_weekly", "seven_day"] },
      anthropic(37, 4),
      copilot(97),
    );
    expect(reading.lead?.label).toBe("Anthropic");
    expect(reading.pinned.map((window) => window.id)).toEqual(["seven_day"]);
  });

  it("means nothing before anything has been read", () => {
    const pin = { providerId: "anthropic", windowIds: ["five_hour"] };
    expect(usageIconReading({ kind: "unread" }, pin).pinned).toEqual([]);
  });
});

describe("usageIconLabel", () => {
  it("keeps a stable head so the control is still findable by name", () => {
    expect(usageIconLabel(usageIconReading({ kind: "unread" }))).toBe("Usage limits");
    expect(usageIconLabel(usageIconReading({ kind: "failed" }))).toBe("Usage limits, not read");
    expect(usageIconLabel(usageIconReading({ kind: "read", accounts: [], now: NOW }))).toBe(
      "Usage limits, none metered",
    );
    for (const name of [
      usageIconLabel(read(anthropic(37, 4))),
      usageIconLabel(read(anthropic(61, 4), copilot(69))),
    ]) {
      expect(name.startsWith("Usage limits")).toBe(true);
    }
  });

  it("says the reading, the pace it cannot draw, and how many more are metered", () => {
    expect(usageIconLabel(read(anthropic(37, 4)))).toBe(
      "Usage limits, 63% left on Anthropic Session",
    );
    // Pace is spoken because this drawing has no room to draw it, and amber
    // alone is not a signal a screen reader or a colour-blind eye can use.
    expect(usageIconLabel(read(anthropic(61, 4), xai(1)))).toBe(
      "Usage limits, 39% left on Anthropic Session, ahead of pace, 1 more metered",
    );
  });

  it("says when the glyph is pinned, since then it may not be the nearest", () => {
    expect(
      usageIconLabel(
        readPinned(
          { providerId: "anthropic", windowIds: ["five_hour"] },
          anthropic(37, 4),
          copilot(97),
        ),
      ),
    ).toBe("Usage limits, 63% left on Anthropic Session, pinned, 1 more metered");
  });

  it("says none metered when the lead has no window to report", () => {
    const reading = read(anthropic(37, 4));
    expect(usageIconLabel({ ...reading, reported: null })).toBe("Usage limits, none metered");
  });
});
