/**
 * Every state the always-mounted usage button has to survive (VC-376).
 *
 * The button is in the chrome band on every page, all day, so there is no such
 * thing as a state it "usually" is not in — a cold launch, an account that
 * signed out, six accounts at once and a provider answering 429 are all
 * on-screen states, and each one has to look deliberate rather than broken.
 * This file is that list, and the stage renders every candidate against all of
 * it rather than against a happy path.
 *
 * THE FIXTURES GO THROUGH THE REAL SORTER. Each state is a list of
 * `ModelAccessProvider` rows, exactly as a snapshot carries them, and is run
 * through `usageLimitAccounts` from the app — the same function the popover
 * uses. So the account the glyph reports and the account the popover opens are
 * the same account by construction, not by agreement, and a change to the
 * binding rule moves both at once.
 *
 * Everything is pinned to one fixed `now`, like its neighbour scratch: pace
 * feeds `usageTone`, so a fixture judged against a moving clock would drift
 * between amber and primary while nobody touched it.
 */

import type { ModelAccessProvider, UsageLimits, UsageWindow, UsageWindowKind } from "@volli/shared";

import {
  usageLimitAccounts,
  type UsageLimitAccount,
} from "@renderer/components/usage-limits/accounts";

import type { ReadingKind } from "./reading";

/** One moment, so every pace reading and every tone is exact. */
export const NOW = Date.parse("2026-03-01T12:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (ms: number): string => new Date(ms).toISOString();

function win(
  id: string,
  kind: UsageWindowKind,
  label: string,
  usedPercent: number,
  resetsInMs: number,
  windowDurationMins: number,
): UsageWindow {
  return { id, kind, label, usedPercent, resetsAt: iso(NOW + resetsInMs), windowDurationMins };
}

const SESSION_MINS = 300;
const WEEK_MINS = 10_080;
const MONTH_MINS = 31 * 1_440;

function limits(windows: readonly UsageWindow[], agoMs = 90_000): UsageLimits {
  return { checkedAt: NOW - agoMs, windows };
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

/** An API-key account: metered by invoice, never listed. */
const UNSUPPORTED: UsageLimits = {
  checkedAt: NOW - 60_000,
  windows: [],
  unavailable: { reason: "unsupported" },
};

/** One account's endpoint said nothing this time; the others still read. */
const PROBE_FAILED: UsageLimits = {
  checkedAt: NOW - 60_000,
  windows: [],
  unavailable: { reason: "probeFailed" },
};

/* ------------------------------------------------------------ the accounts */

/** Claude Code: a five-hour window and a weekly one. The two-window case. */
const anthropic = (session: number, weekly: number): ModelAccessProvider =>
  provider(
    "anthropic",
    "Anthropic",
    limits([
      win("five_hour", "session", "Session", session, 2 * HOUR + 13 * 60_000, SESSION_MINS),
      win("seven_day", "weekly", "Weekly", weekly, 6 * DAY + 23 * HOUR, WEEK_MINS),
    ]),
  );

/** Codex reports a session window and a weekly one. */
const codex = (session: number, weekly: number): ModelAccessProvider =>
  provider(
    "openai-codex",
    "OpenAI Codex",
    limits([
      win("session", "session", "Session", session, 45 * 60_000, SESSION_MINS),
      win("weekly", "weekly", "Weekly", weekly, 3 * DAY + 19 * HOUR, WEEK_MINS),
    ]),
  );

/** A seat whose only meter is monthly premium requests. The one-window case. */
const copilot = (monthly: number): ModelAccessProvider =>
  provider(
    "github-copilot",
    "GitHub Copilot",
    limits([
      win(
        "premium_interactions",
        "monthly",
        "Premium requests",
        monthly,
        30 * DAY + 12 * HOUR,
        MONTH_MINS,
      ),
    ]),
  );

/** OpenCode Go: session, weekly and monthly. The three-window case. */
const opencode = (session: number, weekly: number, monthly: number): ModelAccessProvider =>
  provider(
    "opencode-go",
    "OpenCode Go",
    limits([
      win("session", "session", "Session", session, 3 * HOUR + 40 * 60_000, SESSION_MINS),
      win("weekly", "weekly", "Weekly", weekly, 4 * DAY + 12 * HOUR, WEEK_MINS),
      win("monthly", "monthly", "Monthly", monthly, 12 * DAY + 4 * HOUR, MONTH_MINS),
    ]),
  );

/** xAI states one shared seven-day period. Another one-window account. */
const xai = (weekly: number): ModelAccessProvider =>
  provider(
    "xai",
    "xAI",
    limits([win("weekly", "weekly", "Weekly", weekly, 2 * DAY + 6 * HOUR, WEEK_MINS)]),
  );

/** Kimi: a five-hour span plus a plan counter whose length is not on the wire. */
const kimi = (session: number, plan: number): ModelAccessProvider =>
  provider(
    "kimi-coding",
    "Kimi For Coding",
    limits([
      win("session", "session", "Session", session, 1 * HOUR + 52 * 60_000, SESSION_MINS),
      // No `windowDurationMins`: this window cannot be placed in time, so it
      // has no pace and its tone comes from the amount alone.
      {
        id: "usage",
        kind: "other",
        label: "Plan",
        usedPercent: plan,
        resetsAt: iso(NOW + 4 * DAY),
      },
    ]),
  );

/* -------------------------------------------------------------- the states */

export interface IconState {
  id: string;
  name: string;
  /** What this state is here to catch. */
  note: string;
  kind: ReadingKind;
  accounts: readonly UsageLimitAccount[];
}

function state(
  id: string,
  name: string,
  note: string,
  providers: readonly ModelAccessProvider[],
  kind: ReadingKind = "read",
): IconState {
  return { id, name, note, kind, accounts: usageLimitAccounts(providers) };
}

export const STATES: readonly IconState[] = [
  state(
    "unread",
    "Nothing read yet",
    "The first frame after launch. Must not read as 0% left, and must not read as an error.",
    [],
    "unread",
  ),
  state(
    "failed",
    "Read failed",
    "The icon stays quiet — the popover already explains it. Same shape as unread, undashed.",
    [],
    "failed",
  ),
  state(
    "none",
    "No metered accounts",
    "API keys only, or nothing signed in. The button is still mounted and still has to look intentional.",
    [provider("mistral", "Mistral", UNSUPPORTED), provider("groq", "Groq")],
  ),
  state(
    "one-window",
    "One account, one window",
    "Copilot's monthly meter. The split ring has nothing to split — it must not imply a missing segment.",
    [copilot(31)],
  ),
  state(
    "two-windows",
    "One account, two windows",
    "Claude Code's session and weekly. The commonest real state.",
    [anthropic(37, 4)],
  ),
  state(
    "three-windows",
    "One account, three windows",
    "OpenCode Go. Three segments, three gaps — the most the ring can divide before it is a chart.",
    [opencode(22, 47, 58)],
  ),
  state(
    "two-accounts",
    "Two accounts",
    "Codex nearest to out, Claude behind it. One dot, or one inner arc.",
    [anthropic(37, 4), codex(49, 62)],
  ),
  state(
    "six-accounts",
    "Six accounts",
    "Everything that meters today. Dots cap at three; nested arcs cap at three and drop half the facts.",
    [anthropic(37, 4), codex(49, 62), copilot(69), kimi(63, 12), xai(41), opencode(22, 47, 58)],
  ),
  state(
    "attention",
    "Attention",
    "22% left on the binding window — amber, and the arc is a quarter of the circle.",
    [anthropic(78, 30), codex(49, 62)],
  ),
  state(
    "ahead-of-pace",
    "Ahead of pace",
    "39% left with 45% of the window to go: amber from PACE, not from the amount. The arc still looks roomy — the colour is doing the work alone here, which is the accessibility edge to check.",
    [anthropic(61, 12)],
  ),
  state(
    "critical",
    "Critical",
    "6% left. The arc is a stub — check it still reads as an arc and not as a speck of dust.",
    [anthropic(94, 61), codex(49, 62)],
  ),
  state(
    "spent",
    "Spent",
    "0% left, with time still on the clock. No arc at all — this is the state the thin quiet ring must not be confused with.",
    [anthropic(100, 71), codex(49, 62)],
  ),
  state(
    "all-critical",
    "Everything critical",
    "Apple's smudge, reproduced: six accounts all under a tenth. Check hardest here — can you still tell WHICH one is worst, and do the dots add anything but noise?",
    [anthropic(96, 92), codex(97, 94), copilot(95), kimi(93, 91), xai(98), opencode(96, 95, 93)],
  ),
  state(
    "mixed-failure",
    "One account unreadable",
    "Five read, one answered 429. The unreadable one contributes no dot and no tone — it is nothing to a glyph.",
    [anthropic(37, 4), codex(49, 62), provider("zai", "Z.ai", PROBE_FAILED)],
  ),
];

export const STATE_BY_ID = new Map(STATES.map((entry) => [entry.id, entry]));

/**
 * The walk the transition panel takes.
 *
 * Ordered to cross every boundary the drawing has to survive under its own
 * movement rather than between two page loads: nothing to something, one
 * window to two to three (the split ring re-laying itself out), one account to
 * six (dots arriving), healthy all the way down to spent, and out again to
 * nothing. If a variant only looks right in still frames, this is where it
 * shows.
 */
export const WALK: readonly string[] = [
  "unread",
  "one-window",
  "two-windows",
  "three-windows",
  "two-accounts",
  "six-accounts",
  "attention",
  "critical",
  "spent",
  "all-critical",
  "none",
];
