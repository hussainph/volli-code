/**
 * Rolling many Sessions' metered operations up into one answer.
 *
 * The arithmetic lives here, in one place, and not in SQL. A storage adapter's
 * job is SELECTING the right rows cheaply — that is what the projection's
 * indexes are for, and it is the actual problem, since the alternative was
 * reading every transcript artifact on disk. Deciding what a mixed basis means
 * or when a total is only partial is domain judgement, and a second copy of it
 * written in `SUM(...)` and `CASE WHEN` would be a second opinion about the
 * same money, disagreeing with {@link summarizeSessionUsage} the first time
 * either changed.
 *
 * Grouping is one dimension per report on purpose. Filters compose and a caller
 * that wants two dimensions can ask twice and join; an arbitrary cube would be
 * an interface nobody can read a total off.
 */

import { EMPTY_SESSION_USAGE_SUMMARY, summarizeSessionUsage } from "./session-usage";
import type { SessionUsage, SessionUsageSummary } from "./session-usage";

/**
 * One metered operation with the attribution a cross-Session report needs.
 *
 * `ticketId` is what the operation was spent ON, recorded when it was spent.
 * It is deliberately not re-derived from the Session's live row: deleting a
 * Ticket sets that column null, and a report that read it live would quietly
 * move a deleted Ticket's whole bill into unticketed Project spend.
 */
export interface SessionUsageEntry extends SessionUsage {
  sessionId: string;
  projectId: string;
  ticketId: string | null;
  /** Epoch milliseconds, from the Session Event that recorded the operation. */
  occurredAt: number;
}

/** Which dimension a report is broken down along. One per report. */
export type SessionUsageGrouping = "ticket" | "session" | "model" | "day";

export interface SessionUsageReportQuery {
  /** Absent means one total and no breakdown. */
  groupBy?: SessionUsageGrouping;
}

export interface SessionUsageGroup {
  /**
   * What this group is: a Ticket id, a Session id, `provider/model`, or a UTC
   * day as `YYYY-MM-DD`. Null is a real key — unticketed Project spend — and
   * never an absence, because dropping it would make the groups add up to less
   * than the total printed above them.
   */
  key: string | null;
  usage: SessionUsageSummary;
}

export interface SessionUsageReport {
  total: SessionUsageSummary;
  /** Ordered by known cost, descending. Empty when no grouping was asked for. */
  groups: readonly SessionUsageGroup[];
  /**
   * Sessions that recorded at least one metered operation.
   *
   * Kept apart from any count of Sessions that exist. A manual terminal
   * companion runs models Volli never mediated, so it has no usage to report;
   * counting it here would make an honest gap look like a cheap Session.
   */
  meteredSessionCount: number;
}

export function reportSessionUsage(
  entries: readonly SessionUsageEntry[],
  query: SessionUsageReportQuery,
): SessionUsageReport {
  const meteredSessionIds = new Set<string>();
  for (const entry of entries) meteredSessionIds.add(entry.sessionId);
  const total = entries.length === 0 ? EMPTY_SESSION_USAGE_SUMMARY : summarizeSessionUsage(entries);
  return {
    total,
    groups: query.groupBy === undefined ? [] : groupUsage(entries, query.groupBy),
    meteredSessionCount: meteredSessionIds.size,
  };
}

function groupUsage(
  entries: readonly SessionUsageEntry[],
  groupBy: SessionUsageGrouping,
): readonly SessionUsageGroup[] {
  // Keyed by a string even where the group key is null, because a Map keyed by
  // `string | null` and a JSON key are two different notions of the same group.
  const collected = new Map<string, { key: string | null; entries: SessionUsageEntry[] }>();
  for (const entry of entries) {
    const key = groupKey(entry, groupBy);
    const bucket = collected.get(String(key)) ?? { key, entries: [] };
    bucket.entries.push(entry);
    collected.set(String(key), bucket);
  }
  return [...collected.values()]
    .map((bucket) => ({ key: bucket.key, usage: summarizeSessionUsage(bucket.entries) }))
    .toSorted((left, right) => (right.usage.knownCostUsd ?? 0) - (left.usage.knownCostUsd ?? 0));
}

function groupKey(entry: SessionUsageEntry, groupBy: SessionUsageGrouping): string | null {
  switch (groupBy) {
    case "ticket":
      return entry.ticketId;
    case "session":
      return entry.sessionId;
    case "model":
      return `${entry.providerId}/${entry.modelId}`;
    case "day":
      return utcDay(entry.occurredAt);
  }
}

/**
 * The UTC day an operation happened on.
 *
 * UTC rather than the reader's zone, so the same report is the same report
 * wherever it is read and a stored bucket does not move when a laptop crosses
 * a border. A surface may relabel the interval for a person; it must not
 * silently re-cut it.
 */
function utcDay(occurredAt: number): string {
  return new Date(occurredAt).toISOString().slice(0, 10);
}
