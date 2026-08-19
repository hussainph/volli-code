/**
 * Chart colour taken from the live canvas, and kept taking it (VC-55).
 *
 * Color tokens here are generated from a canvas and written onto
 * `document.documentElement` (CLAUDE.md), so a chart that reads them once is a
 * chart that keeps painting whichever appearance was live when it mounted. The
 * first streak grid did exactly that and drew dark-mode colours on light paper,
 * which reads as an inverted chart rather than as a staleness bug.
 *
 * THE SUBSCRIPTION IS THE POINT, not bookkeeping around it: `getComputedStyle`
 * samples the document once, and the two things that move underneath it are an
 * appearance (a class on the root) and a canvas (custom properties written
 * inline on the root). A `MutationObserver` over exactly those two attributes
 * sees both, and nothing else on the page can wake it.
 *
 * Deriving on every render rather than memoising: four colours of OKLCH
 * arithmetic is cheaper than a `useMemo` whose dependency — "the document
 * changed" — no linter can check, and which would silently go stale the first
 * time someone forgot to list the epoch.
 */
import * as React from "react";
import { hueFan, rampFromBackground } from "@volli/shared";

/** The stops the four intensity steps sit on, background → primary. */
const STREAK_STOPS = [0.12, 0.42, 0.72, 1];

/**
 * How far a peer series fans around the primary, in degrees of hue.
 *
 * Wide enough that five columns are told apart at a glance, narrow enough that
 * the widest pair still reads as the same family — a full circle would be five
 * unrelated colours and would stop looking themed at all.
 */
const SERIES_SPREAD = 70;

/** A token's current value on the document root, or `fallback` outside a DOM. */
function readToken(name: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value.length > 0 ? value : fallback;
}

/**
 * Ticks whenever the appearance or the canvas changes, so anything derived from
 * a token recomputes. The value itself is meaningless — re-rendering is the
 * whole product.
 */
export function useThemeEpoch(): number {
  const [epoch, setEpoch] = React.useState(0);
  React.useEffect(() => {
    const observer = new MutationObserver(() => setEpoch((value) => value + 1));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    return () => observer.disconnect();
  }, []);
  return epoch;
}

/**
 * Four intensity steps travelling from the page to the primary — an empty day
 * is the paper, a busy one is the accent.
 *
 * The fallbacks are the shipped dark canvas's own values, and they only ever
 * apply before the generated block lands (or in a test with no DOM); a wrong
 * colour for one frame beats a chart that throws.
 */
export function useStreakRamp(): string[] {
  useThemeEpoch();
  return rampFromBackground(
    readToken("--background", "#1a1210"),
    readToken("--primary", "#d37550"),
    STREAK_STOPS,
  );
}

/** `count` peer colours fanned off the live primary — for a series, not a scale. */
export function useSeriesColors(count: number): string[] {
  useThemeEpoch();
  return hueFan(readToken("--primary", "#d37550"), count, SERIES_SPREAD);
}
