/**
 * What the two provider mappers have in common: reading a header map without
 * caring about case, turning a provider's epoch or ISO timestamp into the ISO
 * string the vocabulary carries, and naming a window by how long it is.
 *
 * Nothing here knows a provider. That is the point of the file — the Anthropic
 * and Codex mappers each know one wire format, and this is the part that would
 * otherwise be written twice and drift.
 */

import { clampPercent, formatDuration, type UsageWindowKind } from "@volli/shared";

/** A header map as `onResponse` hands it over: lowercase keys are typical, not guaranteed. */
export type HeaderMap = Readonly<Record<string, string>>;

/** A case-insensitive reader over one response's headers. */
export function headerReader(headers: HeaderMap): (name: string) => string | undefined {
  const lowered = new Map<string, string>();
  for (const [key, value] of Object.entries(headers)) lowered.set(key.toLowerCase(), value);
  return (name) => lowered.get(name.toLowerCase());
}

/** A JSON-style object, or nothing when the value is null, scalar, or an array. */
export function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A finite number, or nothing — a header is text and a body field is `unknown`. */
export function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** 0–100 from a source already in percent. */
export function percentOf(value: unknown): number | undefined {
  const parsed = finiteNumber(value);
  return parsed === undefined ? undefined : clampPercent(parsed);
}

/**
 * Epoch seconds as ISO 8601. Providers send resets as integer seconds since
 * the epoch; the vocabulary carries ISO so a renderer never has to guess the
 * unit. Zero and negatives read as "not stated", which is how Codex spells an
 * absent reset.
 */
export function epochSecondsToIso(value: unknown): string | undefined {
  const seconds = finiteNumber(value);
  if (seconds === undefined || seconds <= 0) return undefined;
  return new Date(Math.round(seconds * 1000)).toISOString();
}

/** An ISO timestamp the provider wrote, normalized — or nothing when it does not parse. */
export function isoTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

/** `now + seconds`, as ISO — for a source that says how long until the reset rather than when. */
export function secondsFromNowToIso(value: unknown, now: number): string | undefined {
  const seconds = finiteNumber(value);
  if (seconds === undefined || seconds <= 0) return undefined;
  return new Date(now + Math.round(seconds * 1000)).toISOString();
}

/** The identity a window takes from its length alone. */
export interface WindowShape {
  id: string;
  kind: UsageWindowKind;
  label: string;
}

/** Five hours: the session allowance both providers meter. */
export const SESSION_WINDOW_MINS = 300;
/** Seven days. */
export const WEEKLY_WINDOW_MINS = 10_080;
/** Thirty and thirty-one days — a monthly window in either calendar reading. */
const MONTHLY_WINDOW_MINS: ReadonlySet<number> = new Set([43_200, 44_640]);

/**
 * Names a window by its length, never by the slot the provider put it in.
 *
 * Codex has been seen placing a weekly window in `primary` for plans that
 * expose no session window at all; a mapper keyed on the slot would then draw a
 * weekly allowance on the session row. Duration is the one fact both of that
 * provider's sources state, so it is the id.
 */
export function windowShapeForMinutes(minutes: number): WindowShape {
  if (minutes === SESSION_WINDOW_MINS) return { id: "session", kind: "session", label: "Session" };
  if (minutes === WEEKLY_WINDOW_MINS) return { id: "weekly", kind: "weekly", label: "Weekly" };
  if (MONTHLY_WINDOW_MINS.has(minutes)) {
    return { id: "monthly", kind: "monthly", label: "Monthly" };
  }
  return {
    id: `window_${minutes}m`,
    kind: "other",
    label: formatDuration(minutes * 60_000),
  };
}
