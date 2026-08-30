/**
 * The usage blocks, connected to the ledger and to the reader's preference.
 *
 * WHY THIS FILE EXISTS AT ALL. The blocks beside it are pure over a
 * `SessionUsageSummary`, which is what lets the UI lab mount the real
 * components against fixture operations instead of a reimplementation of them.
 * Reaching into a store from inside those would end that — the lab would need a
 * seeded ledger to draw a card. So the store read, the window state and the
 * preference gate live here, and the drawings stay props-in.
 *
 * NOTHING HERE POLLS. Usage changes when a turn settles, and the renderer
 * already learns that from the Session stream — so a settle is what re-reads.
 * A timer would spend an indexed read every few seconds to be told nothing
 * happened, on a surface whose whole argument is that spend should be cheap to
 * watch.
 */
import * as React from "react";

import {
  EMPTY_SESSION_USAGE_SUMMARY,
  shortSessionId,
  type SessionListingRow,
  type SessionUsageReport,
  type SessionUsageScope,
} from "@volli/shared";

import { HomeUsageBlock } from "@renderer/components/usage/home-usage-block";
import { TicketUsageBlock } from "@renderer/components/usage/ticket-usage-block";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useProjectSessionsStore } from "@renderer/stores/project-sessions";
import { useTicketSessionRecordsStore } from "@renderer/stores/ticket-session-records";
import { useUiStore } from "@renderer/stores/ui";
import { USAGE_WINDOW_MS, useUsageStore, usageKey, type UsageQuery } from "@renderer/stores/usage";
import type { UsageGroupRow, UsageWindow } from "@renderer/usage/usage-format";

/**
 * A value that changes whenever any chat Session's lifecycle moves.
 *
 * Deliberately BROAD rather than per-Session. A settle changes the Session's
 * own rollup, its Ticket's and its project's at once, so a block would have to
 * know every id that could affect it to watch precisely — and the Ticket card,
 * which aggregates a roster that can grow while it is on screen, cannot know
 * them all. One signal over every lifecycle is a handful of characters to
 * compare and costs an indexed read only when something genuinely moved.
 *
 * A joined string rather than an object so zustand's `Object.is` comparison
 * actually holds it steady between unrelated renders.
 */
function useSettleSignal(): string {
  return useChatSessionsStore((state) =>
    Object.values(state.sessions)
      .map((slice) => slice.lifecycle)
      .join(","),
  );
}

/**
 * One rollup, kept fresh across settles AND across remounts.
 *
 * ALWAYS `refresh`, never `ensure`. A rail is unmounted whenever the reader
 * changes page, collapses it or switches Session — and work goes on settling
 * while it is gone. `ensure` returns immediately for any cached answer and
 * nothing in production invalidates the cache, so a rail that came back would
 * show whatever the figure was when it left, indefinitely, with no signal that
 * it was stale. That is worse than a slow number: it is a wrong one that looks
 * settled.
 *
 * Refreshing costs nothing visible, because `refresh` keeps the cached entry on
 * screen and only announces `loading` when there is nothing to show yet. So a
 * remount paints the old figure immediately and replaces it when the read
 * lands — no flicker, and no lie.
 *
 * `null` IS A QUERY. Home's card reports the Session in front, and there is
 * routinely no Session in front — the Board tab, a file tab, a terminal. A
 * conditional hook is not available to express that, and a placeholder scope
 * would spend an indexed read announcing that nothing is selected, so the
 * absent case travels as a null query that reads nothing and answers null.
 */
function useUsageReport(query: UsageQuery | null): SessionUsageReport | null {
  const key = query === null ? null : usageKey(query.scope, query.windowMs, query.groupBy);
  const entry = useUsageStore((state) => (key === null ? undefined : state.byQuery[key]));
  const settleSignal = useSettleSignal();

  React.useEffect(() => {
    if (query === null) return;
    void useUsageStore.getState().refresh(query);
    // `key` stands for the whole query — it is derived from every field of it,
    // so depending on the object as well would re-read on each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, settleSignal]);

  return entry?.status === "ready" ? entry.report : null;
}

/** Whether the reader wants cost on screen at all (Settings → Appearance → Display). */
function useCostVisible(): boolean {
  return useUiStore((state) => state.costVisible);
}

/**
 * Home's usage card: the project rollup, the Session in front, and the window
 * control they are read through.
 *
 * ONE COMPONENT FOR BOTH SCOPES since VC-203. They used to be two exports
 * mounted a section apart, which is why they could drift into two different
 * drawings of the same kind of number — see `home-usage-block.tsx` for what that
 * looked like on screen. Reading both here also lets the card decide as a whole
 * whether it has anything to say.
 *
 * The window is session-local rather than persisted. It is a question someone
 * asks ("what has the last week cost?"), not a standing preference like the
 * rail's page or the diff layout — and 30d is the answer worth opening on every
 * time, because a project's all-time total only grows and stops being a number
 * anyone can act on.
 */
export function HomeUsageRailCard({
  projectId,
  sessionId,
}: {
  projectId: string;
  /** The chat Session in front, or `null` for the Board, a file tab or a terminal. */
  sessionId: string | null;
}) {
  const costVisible = useCostVisible();
  const [window, setWindow] = React.useState<UsageWindow>("30d");
  const scope = React.useMemo<SessionUsageScope>(
    () => ({ kind: "project", projectId }),
    [projectId],
  );
  const report = useUsageReport({
    scope,
    windowMs: USAGE_WINDOW_MS[window],
    groupBy: "model",
  });
  // THROUGH THE SAME WINDOW as the project above it, and that is a correctness
  // requirement rather than a preference. The card draws this Session as a row
  // UNDER the project figure, which is a claim that it is part of that figure —
  // so an unwindowed row could report more than the total it sits beneath (a
  // long-lived Session read at 7d), or a cost under "No metered model calls
  // yet". Everything inside one card answers through one lens; the lens is named
  // on the heading, two lines up, where the reader set it.
  const sessionScope = React.useMemo<SessionUsageScope | null>(
    () => (sessionId === null ? null : { kind: "session", sessionId }),
    [sessionId],
  );
  const sessionReport = useUsageReport(
    sessionScope === null ? null : { scope: sessionScope, windowMs: USAGE_WINDOW_MS[window] },
  );
  // THE DURABLE PER-PROJECT LISTING, not the open chat tabs. `38 sessions · 24
  // metered` only means anything if the first number counts this project's
  // Sessions and all of them: the resident chat slices are keyed by whatever
  // is open in the window, which drops every closed and terminal Session and
  // counts other projects' as well. The same rows the sidebar's bands and ⌘K
  // read, so the count agrees with what a reader can see.
  const ensureProjectSessions = useProjectSessionsStore((state) => state.ensure);
  React.useEffect(() => {
    void ensureProjectSessions(projectId);
  }, [projectId, ensureProjectSessions]);
  const sessionCount = useProjectSessionsStore((state) => {
    const rows = state.byProject[projectId];
    return rows === undefined ? 0 : rows.terminal.length + rows.chat.length;
  });

  if (!costVisible || report === null) return null;
  return (
    <HomeUsageBlock
      summary={report.total}
      models={groupRows(report, modelLabel)}
      // The larger of the two, because the listing can lag a Session that has
      // just been created while its first turn is already metered. Never the
      // metered count alone — that would hide exactly the gap the two numbers
      // exist to show, and make an honest gap look like a cheap project.
      sessionCount={Math.max(sessionCount, report.meteredSessionCount)}
      meteredSessionCount={report.meteredSessionCount}
      // The block renders no row for a Session that metered nothing, so a
      // terminal companion and a chat before its first reply both stay silent
      // rather than dashed — the distinction `formatUsageCost` keeps between
      // `null` and `"—"`.
      session={sessionReport?.total ?? null}
      window={window}
      onWindowChange={setWindow}
    />
  );
}

/** What a Ticket cost, and which of its Sessions spent it. */
export function TicketUsageRailBlock({ ticketId }: { ticketId: string }) {
  const costVisible = useCostVisible();
  const scope = React.useMemo<SessionUsageScope>(() => ({ kind: "ticket", ticketId }), [ticketId]);
  const bySession = useUsageReport({ scope, groupBy: "session" });
  const byModel = useUsageReport({ scope, groupBy: "model" });
  // The DURABLE roster, not the open tabs: a Ticket's breakdown routinely names
  // Sessions that were closed weeks ago, and reading titles off the tab strip
  // would render every one of those as a bare id.
  const roster = useTicketSessionRecordsStore((state) => state.byTicket[ticketId]);

  if (!costVisible || bySession === null) return null;
  const topModel = byModel?.groups[0];
  const sessions = ticketSessionRows(bySession, roster);
  return (
    <TicketUsageBlock
      summary={bySession.total}
      sessions={sessions}
      topModelLabel={topModel === undefined ? null : modelLabel(topModel.key)}
    />
  );
}

/**
 * Every Session on this Ticket, metered or not — the union of the roster and
 * the report's groups.
 *
 * THE ROSTER IS NOT JUST A SOURCE OF LABELS. Passing only the metered groups
 * would drop every manual terminal companion and every chat that never reached
 * a model, which is the majority of Sessions on a Ticket someone has been
 * poking at — and the card's own count would then say "2 sessions" about a
 * Ticket with six. An unmetered Session appears at `—`, which reads as
 * unmeasured rather than free and is exactly the gap a reader needs to see:
 * it is where the spend Volli never mediated went.
 *
 * A metered group the roster no longer holds is kept too, at the bottom by
 * cost order. Its Session has been deleted; the money it spent has not.
 */
function ticketSessionRows(
  report: SessionUsageReport,
  roster: readonly SessionListingRow[] | undefined,
): readonly UsageGroupRow[] {
  const metered = groupRows(report, (key) => sessionLabel(key, roster));
  const meteredKeys = new Set(report.groups.map((group) => group.key));
  const unmetered = (roster ?? [])
    .map((row) => rowSessionId(row))
    .filter((sessionId) => !meteredKeys.has(sessionId))
    .map((sessionId) => ({
      key: sessionId,
      label: sessionLabel(sessionId, roster),
      usage: EMPTY_SESSION_USAGE_SUMMARY,
    }));
  // After the metered rows rather than interleaved: the list is ordered by what
  // things cost, and every row here cost an amount nobody can compare.
  return [...metered, ...unmetered];
}

/** A report's groups as display rows, already ordered by known cost. */
function groupRows(
  report: SessionUsageReport,
  label: (key: string | null) => string,
): readonly UsageGroupRow[] {
  return report.groups.map((group) => ({
    // `null` is a real group — unticketed spend, or a Session the roster no
    // longer holds — so it needs a stable key rather than being dropped.
    key: group.key ?? "\u0000none",
    label: label(group.key),
    usage: group.usage,
  }));
}

/**
 * `anthropic/claude-opus-4-1` → `claude-opus-4-1`.
 *
 * The provider prefix is dropped rather than prettified: at a rail's width the
 * model is the part that distinguishes two rows, and a catalogue of display
 * names would be a second copy of something that moves with every provider
 * release. The full id stays available in the ledger.
 */
function modelLabel(key: string | null): string {
  if (key === null) return "Unknown model";
  const slash = key.indexOf("/");
  return slash === -1 ? key : key.slice(slash + 1);
}

/**
 * A Session id resolved to its title, or its short id when the roster does not
 * hold it.
 *
 * `shortSessionId` is the app's own stable human-facing identifier, so a
 * Session whose title never landed still reads as the same thing the CLI and
 * the sidebar would call it.
 */
function sessionLabel(
  key: string | null,
  roster: readonly SessionListingRow[] | undefined,
): string {
  if (key === null) return "Unattributed";
  const title = roster?.find((row) => rowSessionId(row) === key)?.record.title;
  return title !== undefined && title !== "" ? title : `Session ${shortSessionId(key)}`;
}

/**
 * A listing row's Session id, whichever arm it is.
 *
 * The two records spell it differently (`SessionRecord.id` against
 * `ChatSessionRecord.sessionId`), so the union has to be narrowed rather than
 * read through. Spelled once here because getting it wrong silently yields no
 * match, which renders as a bare id rather than as an error.
 */
function rowSessionId(row: SessionListingRow): string {
  return row.kind === "terminal" ? row.record.id : row.record.sessionId;
}
