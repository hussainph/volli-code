/**
 * When a provider's spent allowance comes back, read off the failure that
 * reported it — or nothing, when the failure does not say so unambiguously.
 *
 * A quota failure ends a turn with an Attention the person has to recover from
 * (CLAUDE.md: quota failures require explicit user recovery). What this module
 * adds is the one fact that turns "come back later and press Retry" into a
 * choice that can be made now: the instant the allowance resets. It is read at
 * the moment the failure is reported, by the runtime that saw it, and carried
 * on the Attention — so a relaunch, a renderer and the host's timer all read
 * the same instant rather than each re-parsing provider prose.
 *
 * **It never guesses.** Four sources, and each is only trusted as far as it
 * goes:
 *
 * 1. **A time with a zone** (`…reset at 2026-09-10T04:24:36+08:00`, or `Z`) —
 *    unambiguous from any provider.
 * 2. **A zoneless wall-clock time from a provider whose zone is known.** Z.ai's
 *    coding plan writes `Usage limit reached for 5 hour. Your limit will reset
 *    at 2026-09-10 04:24:36` with no zone. It is China Standard Time (UTC+8,
 *    no DST), measured rather than assumed — see {@link PROVIDER_WALL_CLOCK_OFFSET_MINUTES}.
 *    From any provider NOT in that table the same sentence yields nothing: a
 *    zoneless time read in the wrong zone schedules a resume hours early or
 *    late, and "early" spends a turn arriving at the same refusal.
 * 3. **A relative wait the provider computed from a structured reset.** pi-ai
 *    turns the Codex backend's `resets_at` into `Try again in ~N min.`; that N
 *    is measured from the moment the failure was reported, so it is read
 *    against `observedAt` and rounded UP by a minute (pi-ai rounds to nearest).
 * 4. **The provider's own usage windows**, from the response headers or usage
 *    endpoint the Model Access meter already reads (`UsageLimitsHolder`) — for
 *    a failure that says "usage limit" and carries no time at all, which is
 *    what the Codex WebSocket transport sends. Only a window reported fully
 *    spent (≥ 100%) with a future reset counts, and when several are spent the
 *    LATEST reset wins, because the turn cannot run until every one of them
 *    has come back.
 *
 * **Billing is never time-bound.** "You're out of extra usage. Add more at …"
 * and its relatives are answered by paying, not by waiting, so they yield
 * nothing even when a window happens to be spent.
 *
 * An instant at or before `observedAt`, or implausibly far away, also yields
 * nothing: both mean the sentence was not the reset it looked like.
 */
import type { UsageWindow } from "./usage-limits";

/**
 * The zone a provider's zoneless reset timestamps are written in, as minutes
 * east of UTC. Adding a provider here is a claim about its wall clock and
 * needs the same kind of evidence the entry below carries.
 *
 * `zai` (api.z.ai coding plan, code 1308): UTC+8. Measured against this
 * machine's own Session ledger, twice:
 *
 *  - Failures from 2026-08-21 22:58Z through 2026-08-22 01:46Z all said
 *    `reset at 2026-08-22 11:16:11`. Read as UTC+8 that is 03:16:11Z — 4h18m
 *    after the first refusal, inside the plan's 5-hour window. Read as UTC it
 *    is 12h18m later, and as the machine's local zone (UTC+3) 9h18m later —
 *    neither fits a 5-hour window.
 *  - Failures from 2026-09-09 17:58Z said `reset at 2026-09-10 04:24:36`
 *    (UTC+8 → 20:24:36Z). Two `zai` Sessions then completed turns at 20:35Z
 *    and 20:36Z — after the UTC+8 instant, five hours before the local-zone
 *    one — with no refusal in between.
 *
 * `zai-coding-cn` (open.bigmodel.cn) is the same operator and very likely the
 * same clock, but nothing on this machine has measured it, so it stays out.
 */
export const PROVIDER_WALL_CLOCK_OFFSET_MINUTES: Readonly<Record<string, number>> = {
  zai: 8 * 60,
};

/** Past this, a parsed instant is a misreading rather than a reset. */
export const QUOTA_RESET_HORIZON_MS = 35 * 24 * 60 * 60_000;

/** Paid-for allowance: answered by a purchase, never by a wait. */
const BILLING_SIGNAL =
  /(extra usage|add more at|billing|insufficient[ _]quota|credit balance|available balance|out of budget|payment|upgrade your plan)/i;

/** A failure that is about a spent allowance at all. */
const USAGE_LIMIT_SIGNAL = /(usage limit|limit will reset|quota)/i;

/** `reset at <date> <time>` with an optional zone, and the separator either way. */
const RESET_AT =
  /reset(?:s)? at (\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?/i;

/** pi-ai's own sentence for a Codex reset it read from `resets_at`. */
const TRY_AGAIN_IN_MINUTES = /try again in ~?(\d+) ?min/i;

export interface QuotaResetInput {
  /** The Pi provider id that refused the request — the key of the zone table. */
  providerId: string;
  /** The failure's own (sanitized) sentence. */
  message: string;
  /** When the failure was reported, epoch ms. Relative waits count from here. */
  observedAt: number;
  /** The provider's usage windows as last read, when there are any. */
  windows?: readonly UsageWindow[];
}

/**
 * The instant, epoch ms, at which the refused allowance is back — or `null`
 * when the failure is not a time-bound quota, or does not say when.
 */
export function quotaResetInstant(input: QuotaResetInput): number | null {
  const { message, observedAt } = input;
  // A failure has to be ABOUT a spent allowance before any time in it is read:
  // "try again in 2 min" from a rate limit is a wait, not a reset to schedule.
  if (BILLING_SIGNAL.test(message) || !USAGE_LIMIT_SIGNAL.test(message)) return null;
  const stated = statedReset(input);
  if (stated !== undefined) return plausible(stated, observedAt);
  return plausible(spentWindowReset(input.windows ?? [], observedAt), observedAt);
}

/**
 * The instant the sentence itself states, `null` when it states one that
 * cannot be placed (a zoneless time from a provider whose zone is unknown),
 * or `undefined` when it states none — which is what lets the window reading
 * fill in only for a failure that said nothing.
 */
function statedReset(input: QuotaResetInput): number | null | undefined {
  const at = RESET_AT.exec(input.message);
  if (at !== null) {
    const [, year, month, day, hour, minute, second, zone] = at;
    const wall = Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
    );
    if (zone !== undefined) return wall - zoneOffsetMinutes(zone) * 60_000;
    const offset = PROVIDER_WALL_CLOCK_OFFSET_MINUTES[input.providerId];
    return offset === undefined ? null : wall - offset * 60_000;
  }
  const inMinutes = TRY_AGAIN_IN_MINUTES.exec(input.message);
  if (inMinutes !== null) return input.observedAt + (Number(inMinutes[1]) + 1) * 60_000;
  return undefined;
}

/** `Z`, `+08:00`, `-0530` → minutes east of UTC. */
function zoneOffsetMinutes(zone: string): number {
  if (zone.toUpperCase() === "Z") return 0;
  const digits = zone.slice(1).replace(":", "");
  const minutes = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2));
  return zone.startsWith("-") ? -minutes : minutes;
}

/** The latest reset among the windows reported fully spent, still in the future. */
function spentWindowReset(windows: readonly UsageWindow[], observedAt: number): number | null {
  let latest: number | null = null;
  for (const window of windows) {
    if (window.usedPercent < 100 || window.resetsAt === undefined) continue;
    const resetsAt = Date.parse(window.resetsAt);
    if (Number.isNaN(resetsAt) || resetsAt <= observedAt) continue;
    latest = latest === null ? resetsAt : Math.max(latest, resetsAt);
  }
  return latest;
}

function plausible(instant: number | null, observedAt: number): number | null {
  // An absurd `~N min` overflows to Infinity, which the horizon refuses too.
  if (instant === null || instant <= observedAt || instant - observedAt > QUOTA_RESET_HORIZON_MS)
    return null;
  return Math.round(instant);
}
