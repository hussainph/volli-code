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
  shortSessionId,
  type SessionListingRow,
  type SessionUsageReport,
  type SessionUsageScope,
} from "@volli/shared";

import { ProjectUsageBlock } from "@renderer/components/usage/project-usage-block";
import { SessionUsageFacts } from "@renderer/components/usage/session-usage-facts";
import { TicketUsageBlock } from "@renderer/components/usage/ticket-usage-block";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
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
 * One rollup, kept fresh across settles.
 *
 * `ensure` on mount so a surface that is already cached paints without a
 * flicker; `refresh` on every later settle so the figure follows the work. The
 * first settle after mount does re-read once redundantly — the alternative is
 * tracking a previous value to detect the edge, which buys one saved indexed
 * read for a piece of state that can go stale.
 */
function useUsageReport(query: UsageQuery): SessionUsageReport | null {
  const key = usageKey(query.scope, query.windowMs, query.groupBy);
  const entry = useUsageStore((state) => state.byQuery[key]);
  const settleSignal = useSettleSignal();
  const mounted = React.useRef(false);

  React.useEffect(() => {
    const store = useUsageStore.getState();
    if (!mounted.current) {
      mounted.current = true;
      void store.ensure(query);
      return;
    }
    void store.refresh(query);
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
 * The Session in front, as three more facts in Home's Session block.
 *
 * Renders nothing when the preference is off, when nothing has been metered, or
 * for a Session that is not a chat — see `session-usage-facts.tsx` for why an
 * unmetered Session is silent rather than dashed.
 */
export function SessionUsageRailFacts({ sessionId }: { sessionId: string }) {
  const costVisible = useCostVisible();
  const scope = React.useMemo<SessionUsageScope>(
    () => ({ kind: "session", sessionId }),
    [sessionId],
  );
  const report = useUsageReport({ scope });
  if (!costVisible || report === null) return null;
  return <SessionUsageFacts summary={report.total} />;
}

/**
 * The project rollup, with its own window control.
 *
 * The window is session-local rather than persisted. It is a question someone
 * asks ("what has the last week cost?"), not a standing preference like the
 * rail's page or the diff layout — and 30d is the answer worth opening on every
 * time, because a project's all-time total only grows and stops being a number
 * anyone can act on.
 */
export function ProjectUsageRailBlock({ projectId }: { projectId: string }) {
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
  const sessionCount = useChatSessionsStore((state) => Object.keys(state.sessions).length);

  if (!costVisible || report === null) return null;
  return (
    <ProjectUsageBlock
      summary={report.total}
      models={groupRows(report, modelLabel)}
      // The durable Session count is the roster's to know, not the usage
      // projection's — a Session that never called a model leaves no row here.
      // Falling back to the metered count would hide exactly the gap the two
      // numbers exist to show, so the larger of the two is the honest floor.
      sessionCount={Math.max(sessionCount, report.meteredSessionCount)}
      meteredSessionCount={report.meteredSessionCount}
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
  return (
    <TicketUsageBlock
      summary={bySession.total}
      sessions={groupRows(bySession, (key) => sessionLabel(key, roster))}
      topModelLabel={topModel === undefined ? null : modelLabel(topModel.key)}
    />
  );
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
