// @vitest-environment jsdom
/**
 * Every state the always-mounted button can be in, as the glyph draws it
 * (VC-376).
 *
 * The button is in the chrome band on every page all day, so there is no state
 * it "usually" is not in: a cold launch, an account that signed out, six
 * accounts at once and a provider answering 429 are all on-screen states, and
 * each one has to be a deliberate drawing rather than an accident of the code.
 *
 * WHAT THESE ASSERT IS THE SECOND CHANNEL, not the colour. Colour is the
 * verdict and it is never allowed to be the only signal, so what is checked
 * here is the geometry a person who cannot use colour reads instead: how much
 * of each bar is inked, which figures are printed, and the hairline ring that
 * separates "nothing measured" from "nothing left".
 */
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ModelAccessProvider, UsageLimits, UsageWindow, UsageWindowKind } from "@volli/shared";

import { usageLimitAccounts } from "./accounts";
import { usageIconReading, type UsageIconInput } from "./icon-reading";
import { UsageLimitsIcon } from "./usage-limits-icon";

const NOW = Date.parse("2026-03-01T12:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function win(
  id: string,
  kind: UsageWindowKind,
  label: string,
  usedPercent: number,
  resetsInMs = 2 * HOUR + 13 * 60_000,
  windowDurationMins = 300,
): UsageWindow {
  return {
    id,
    kind,
    label,
    usedPercent,
    resetsAt: new Date(NOW + resetsInMs).toISOString(),
    windowDurationMins,
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

/** Claude Code: a five-hour window and a weekly one. The commonest real state. */
const anthropic = (session: number, weekly: number): ModelAccessProvider =>
  provider(
    "anthropic",
    "Anthropic",
    limits(
      win("five_hour", "session", "Session", session),
      win("seven_day", "weekly", "Weekly", weekly, 6 * DAY, 10_080),
    ),
  );

/** A seat whose only meter is monthly premium requests. The one-window case. */
const copilot = (monthly: number): ModelAccessProvider =>
  provider(
    "github-copilot",
    "GitHub Copilot",
    limits(win("premium", "monthly", "Premium requests", monthly, 20 * DAY, 44_640)),
  );

/** An account with no mark of its own — half the metered providers. */
const opencode = (weekly: number): ModelAccessProvider =>
  provider(
    "opencode-go",
    "OpenCode Go",
    limits(win("weekly", "weekly", "Weekly", weekly, 4 * DAY, 10_080)),
  );

let container: HTMLElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

/**
 * One reading, drawn. A test that draws twice gets a fresh root each time —
 * these assert what one state LOOKS like, not what moving between two does.
 */
async function draw(input: UsageIconInput): Promise<HTMLElement> {
  if (root !== null) {
    await act(async () => root?.unmount());
    container?.remove();
    container = document.createElement("div");
    document.body.append(container);
  }
  root = createRoot(container!);
  await act(async () => {
    root?.render(
      <StrictMode>
        <UsageLimitsIcon reading={usageIconReading(input)} />
      </StrictMode>,
    );
  });
  return container!;
}

const read = async (...providers: readonly ModelAccessProvider[]): Promise<HTMLElement> =>
  draw({ kind: "read", accounts: usageLimitAccounts(providers), now: NOW });

/** The figures printed, top slot first. */
function figures(host: HTMLElement): string[] {
  return [...host.querySelectorAll("text")].map((node) => node.textContent ?? "");
}

/**
 * How full each bar is, 0–1, left side first.
 *
 * Read off the dash pattern rather than off a class, because LENGTH is the
 * signal — the thing that still reads when colour does not. Each side draws
 * its track first and its arc over it, and the track is the same sweep at
 * full, so the arc's inked length over its own track's is the share without
 * this test having to know the glyph's geometry.
 */
function bars(host: HTMLElement): number[] {
  const inked = [...host.querySelectorAll("circle")].map((node) =>
    Number((node.getAttribute("stroke-dasharray") ?? "0 1").split(" ")[0]),
  );
  const sides: number[] = [];
  for (let index = 0; index + 1 < inked.length; index += 2) {
    sides.push((inked[index + 1] ?? 0) / (inked[index] ?? 1));
  }
  return sides;
}

/** The two hairline states: a thin ring, dashed only before the first read. */
function quietRing(host: HTMLElement): { present: boolean; dashed: boolean } {
  const ring = host.querySelector("circle.stroke-current.text-muted-foreground\\/45");
  return {
    present: ring !== null,
    dashed: ring?.getAttribute("stroke-dasharray") !== null,
  };
}

describe("UsageLimitsIcon", () => {
  it("is a dashed hairline before anything has been read", async () => {
    // Must not read as 0% left, and must not read as an error.
    const host = await draw({ kind: "unread" });
    expect(quietRing(host)).toEqual({ present: true, dashed: true });
    expect(figures(host)).toEqual([]);
  });

  it("is the same hairline, undashed, when the read failed", async () => {
    // The popover explains it in words; the icon only has to stay quiet, and
    // has to be distinguishable from a launch that has not asked yet.
    expect(quietRing(await draw({ kind: "failed" }))).toEqual({ present: true, dashed: false });
  });

  it("is the same hairline when nothing is metered", async () => {
    // API keys only, or nothing signed in. The button is still mounted and
    // still has to look intentional.
    expect(quietRing(await read(provider("mistral", "Mistral")))).toEqual({
      present: true,
      dashed: false,
    });
  });

  it("prints both windows, short span on top, with the account's mark between", async () => {
    const host = await read(anthropic(37, 4));
    expect(figures(host)).toEqual(["63", "96"]);
    // Anthropic has a mark of its own, so the middle is its logo rather than a
    // letter — and it is drawn in `currentColor` under the muted token, never
    // the vendor's tint, because in this glyph colour means the verdict.
    const mark = host.querySelector("g.text-muted-foreground");
    expect(mark?.querySelector("path")).not.toBeNull();
    expect(quietRing(host).present).toBe(false);
  });

  it("falls back to a bare letter for a provider with no mark", async () => {
    const host = await read(opencode(53));
    expect(figures(host)).toContain("O");
  });

  it("gives each window its own bar, and mirrors a lone window onto both", async () => {
    // Two windows: the left bar is the top figure, the right bar the bottom
    // one. 63 and 96 are different, so the pair is deliberately asymmetric.
    const [left = 0, right = 0] = bars(await read(anthropic(37, 4)));
    expect(left).toBeCloseTo(0.63, 2);
    expect(right).toBeCloseTo(0.96, 2);

    // One window has no partner, so it carries both sides: an empty second
    // bar would read as a second window at zero.
    const [soloLeft = 0, soloRight = 0] = bars(await read(copilot(69)));
    expect(soloLeft).toBeCloseTo(0.31, 2);
    expect(soloRight).toBeCloseTo(0.31, 2);
  });

  it("draws a stub rather than nothing at the bottom of the scale", async () => {
    const host = await read(anthropic(94, 4));
    const [left = 0] = bars(host);
    expect(left).toBeCloseTo(0.06, 2);
    expect(figures(host)).toEqual(["6", "96"]);
  });

  it("draws no bar when a window is spent, and squares the cap so no speck is left", async () => {
    const host = await read(anthropic(100, 4));
    const [left = 1] = bars(host);
    expect(left).toBe(0);
    expect(figures(host)).toEqual(["0", "96"]);
    // A round cap on a zero-length dash still paints a dot: at the foot of a
    // spent bar that reads as dirt on the screen.
    const inked = [...host.querySelectorAll("circle")].filter((node) =>
      (node.getAttribute("stroke-dasharray") ?? "").startsWith("0 "),
    );
    expect(inked.every((node) => node.getAttribute("stroke-linecap") === "butt")).toBe(true);
  });

  it("prints no figure at 100%, where three digits would not fit", async () => {
    // A bar drawn full already says the only thing "100" would add.
    expect(figures(await read(anthropic(0, 0)))).toEqual([]);
  });

  it("reports the account closest to running out when several are metered", async () => {
    // Six accounts is a chart, not an icon: the glyph stays one account's
    // reading and the others are spoken in the name instead.
    const host = await read(anthropic(37, 4), copilot(69), opencode(53));
    expect(figures(host)).toEqual(["31"]);
    expect(bars(host)).toHaveLength(2);
  });

  it("keeps the reported window when an account meters three", async () => {
    const host = await read(
      provider(
        "opencode-go",
        "OpenCode Go",
        limits(
          win("session", "session", "Session", 22),
          win("weekly", "weekly", "Weekly", 47, 4 * DAY, 10_080),
          win("monthly", "monthly", "Monthly", 58, 12 * DAY, 44_640),
        ),
      ),
    );
    // The monthly binds at 42%; the session keeps the top slot because the
    // stack is ordered by family and never by value. The letter is drawn
    // before the figures, so it leads the list.
    expect(figures(host)).toEqual(["O", "78", "42"]);
  });

  it("ignores an account that answered 429 rather than drawing it as empty", async () => {
    const host = await read(
      anthropic(37, 4),
      provider("xai", "xAI", {
        checkedAt: NOW,
        windows: [],
        unavailable: { reason: "probeFailed" },
      }),
    );
    expect(figures(host)).toEqual(["63", "96"]);
  });

  it("turns its motion off under reduced motion, like the rest of the app", async () => {
    const host = await read(anthropic(37, 4));
    const moving = [...host.querySelectorAll("[class*='transition-']")];
    expect(moving.length).toBeGreaterThan(0);
    expect(
      moving.every((node) =>
        (node.getAttribute("class") ?? "").includes("motion-reduce:transition-none"),
      ),
    ).toBe(true);
  });

  it("is silent to a screen reader, because the button around it carries the name", async () => {
    const svg = (await read(anthropic(37, 4))).querySelector("svg");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.getAttribute("aria-label")).toBeNull();
  });
});
