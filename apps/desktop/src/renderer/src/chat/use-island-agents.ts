/**
 * The subagent feed for the Activity Island (VC-269).
 *
 * One of the island's four feeds, beside `use-island-tabs.ts` and shaped like
 * it: the slice of the model that is the agents cluster, the three verbs its
 * card can call, and the announcements the now channel makes about them.
 * `useActivityIsland` spreads it; nothing else reads it.
 *
 * WHICH ROWS ARE CHILDREN. The project's Session listing
 * (`stores/project-sessions.ts`), matched on the chat record's OWN fields —
 * `parentSessionId === sessionId` and `isSubagentSession` — and deliberately
 * not on `childSessionIds`, the provenance helper the Browser Tab feed uses.
 * Provenance reads "started by a person" for every ticketless Session
 * (`readSessionProvenance` returns `PERSON_STARTED` when `ticketId === null`),
 * so a Board or Home chat's subagents would never appear through it; the
 * record fields are right for every parent. (The tab feed still walks
 * provenance — a pre-existing gap, not this feed's to close.) `role` is the
 * second filter because `parentSessionId` is also set for a `session_start`
 * child (VC-183), which is a full peer Session and not a subagent.
 *
 * WHAT A ROW SAYS. Its label is the record's title — `delegate-session.ts`
 * already derived it from the task at birth and `chatSessionRecord` never
 * leaves it empty — and its state is projected from `activity` and `outcome`
 * by {@link islandAgentState}, which is where the two folds the ticket ruled
 * on live. `progress` is 0: indeterminate, by decision; the arc orbits on
 * its own and `agentStateWord` prints a word for it.
 *
 * THE NOW CHANNEL IS A DIFF, exactly as the tab feed's is: the listing is a
 * push cache with no history, so "delegated" and "done" are what changed
 * between two readings, held in a ref. The first reading after the listing
 * hydrates is the baseline and announces nothing — every child that already
 * existed would otherwise flash as newly delegated a beat after mount.
 *
 * THE VERBS ARE DOORS THE MOUNT SUPPLIES. Peek and promote go where
 * `ChatPlane` says (VC-270's precedent: the mount decides the destination,
 * the feed only calls it). Stop is a request to main — `sessions.stop`, the
 * person's door — and its refusal surfaces the way every failed mutation
 * does; the "Stopped" flash itself comes back through the diff when the row
 * moves, so the card's confirmation is the real transition and not a hope.
 */
import * as React from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";

import { errorMessage, isSubagentSession } from "@volli/shared";
import type { ChatSessionRecord } from "@volli/shared";
import type {
  ActivityIslandActions,
  ActivityIslandModel,
  IslandAgent,
} from "@volli/session-presentation";

import { toastError } from "@renderer/lib/toast";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import {
  useProjectSessionsStore,
  type ProjectSessionRows,
} from "@renderer/stores/project-sessions";
import type { IslandFlashPush } from "./use-island-flash";
import type { ChatSessionsStore } from "./use-session-controller";

/* ------------------------------------------------------------ the projection */

/** The subagents of one Session, in listing order — see the module doc for why not provenance. */
export function subagentsOf(
  rows: ProjectSessionRows | undefined,
  sessionId: string,
): readonly ChatSessionRecord[] {
  if (rows === undefined) return NO_RECORDS;
  return rows.chat.filter(
    (record) => record.parentSessionId === sessionId && isSubagentSession(record),
  );
}

/** What a row is called when its title is nothing but whitespace — the one gap upstream leaves. */
const UNTITLED_SUBAGENT = "Subagent";

export function islandAgentLabel(record: Pick<ChatSessionRecord, "title">): string {
  const title = record.title.trim();
  return title.length > 0 ? title : UNTITLED_SUBAGENT;
}

/**
 * The chip's five states from the two facts a row carries.
 *
 * `stopped`, `working` and `waiting` are the record's own words. The one the
 * record does not say directly:
 *
 *  • `idle` is `done` or `failed` by `outcome` (VC-269 ruling): a turn that
 *    completed is done; one that was interrupted or whose executor failed is
 *    failed. `outcome === null` on an idle row is the NEWBORN case (fix-first,
 *    review c5714a22): a child sits `idle` for one beat between its row
 *    appearing and its first `turn.started` landing, before any turn has ever
 *    ended — that is "not finished yet", not "done", so it reads `working`
 *    rather than lying that a freshly delegated helper already finished.
 */
export function islandAgentState(
  record: Pick<ChatSessionRecord, "activity" | "outcome">,
): IslandAgent["state"] {
  switch (record.activity) {
    case "stopped":
      return "stopped";
    case "working":
      return "working";
    // THE CHIP DRAWS THE WAIT (VC-279 follow-up). VC-269 folded it into
    // `working` on the reading that a VC-9 child holds no `ask_user`, so its
    // waits are narrow runtime trips nobody is being asked about. Two of the
    // three reasons a chat can wait are not that: `permission` and `auth` are
    // errands only a person clears, and the child stops dead until they do.
    // While a child still had a listing row that was survivable, because the
    // navigator asked on its behalf. It has none since VC-279, and this
    // cluster is the addressee `sessionWaitAudience` names, so folding here
    // would leave a stalled child announced by nothing at all: no row, no
    // ring, no notification (`run-attention.ts` notifies no Session a Run does
    // not own). The peek overlay still holds WHICH errand it is.
    case "waiting":
      return "waiting";
    case "idle":
      if (record.outcome === null) return "working";
      return record.outcome === "interrupted" || record.outcome === "failed" ? "failed" : "done";
  }
}

export function islandAgentOf(record: ChatSessionRecord, promoted: boolean): IslandAgent {
  return {
    id: record.sessionId,
    label: islandAgentLabel(record),
    // Indeterminate by decision — see the module doc.
    progress: 0,
    state: islandAgentState(record),
    promoted,
  };
}

/* ------------------------------------------------------------------ the feed */

export interface IslandAgentsFeed {
  model: Pick<ActivityIslandModel, "agents">;
  actions: Pick<ActivityIslandActions, "peekAgent" | "promoteAgent" | "stopAgent">;
}

/** Where the two promotions go — the MOUNT's decision (VC-270's precedent). */
export interface IslandAgentsDeps {
  /** Opens a child in the peek overlay. Omitted means the verb opens nowhere. */
  peekSession?: (sessionId: string) => void;
  /** Opens (or focuses) a child as a full tab — the host's own `onOpenSession`. */
  openSession?: (sessionId: string) => void;
  /** The UI lab's own chat-sessions store, whose `openTabs` says what is promoted. */
  store?: ChatSessionsStore;
}

const NO_RECORDS: readonly ChatSessionRecord[] = [];
const NO_AGENTS: readonly IslandAgent[] = [];
const NO_TABS: readonly string[] = [];

/**
 * The event word for a state a row has just reached; `null` for one the channel
 * does not announce.
 *
 * `Needs you` is the one word here that is not a report of something finished,
 * and it is the reason the map is no longer named for endings. A child that
 * has stopped on a permission or a credential is the only state on this card a
 * person can do anything about, and this cluster is the only surface that will
 * ever say so (VC-279: no row, no ring, no notification). An announcement is
 * cheap and a stalled delegation is not.
 */
const STATE_EVENT: Record<IslandAgent["state"], string | null> = {
  working: null,
  waiting: "Needs you",
  done: "Done",
  failed: "Failed",
  stopped: "Stopped",
};

/**
 * The announcements between two readings of the listing, in the order they
 * are pushed — latest wins in the channel, so the last child to change is the
 * one announced.
 */
function diffAgents(
  previous: ReadonlyMap<string, IslandAgent["state"]>,
  agents: readonly IslandAgent[],
  flash: IslandFlashPush,
): Map<string, IslandAgent["state"]> {
  const next = new Map<string, IslandAgent["state"]>();
  for (const agent of agents) {
    const before = previous.get(agent.id);
    if (before === undefined) {
      flash("Delegated", agent.label);
    } else if (before !== agent.state) {
      const event = STATE_EVENT[agent.state];
      if (event !== null) flash(event, agent.label);
    }
    next.set(agent.id, agent.state);
  }
  return next;
}

export function useIslandAgents(
  sessionId: string,
  projectId: string,
  flash: IslandFlashPush,
  deps: IslandAgentsDeps = {},
): IslandAgentsFeed {
  const rows = useProjectSessionsStore((state) => state.byProject[projectId]);
  // The listing having arrived is the baseline — the store holds no entry
  // for a project it has not fetched, and drops pushes for one, so
  // `undefined` is exactly "not hydrated" (see `ChatBrowserTabs.listed`).
  const listed = rows !== undefined;
  const records = React.useMemo(() => subagentsOf(rows, sessionId), [rows, sessionId]);
  // Promoted = the child has a tab open under ANY owner. The card's label
  // reads it ("Open as tab" / "Focus tab"); the host's door open-or-focuses
  // either way, so the verb does not need to know.
  const store = deps.store ?? useChatSessionsStore;
  const openTabs = useStore(
    store,
    useShallow((state) => (records.length === 0 ? NO_TABS : Object.values(state.openTabs).flat())),
  );
  const agents = React.useMemo<readonly IslandAgent[]>(
    () =>
      records.length === 0
        ? NO_AGENTS
        : records.map((record) => islandAgentOf(record, openTabs.includes(record.sessionId))),
    [openTabs, records],
  );

  const seen = React.useRef<Map<string, IslandAgent["state"]> | null>(null);
  React.useEffect(() => {
    if (!listed) return;
    if (seen.current === null) {
      seen.current = new Map(agents.map((agent) => [agent.id, agent.state]));
      return;
    }
    seen.current = diffAgents(seen.current, agents, flash);
  }, [agents, flash, listed]);

  const { peekSession, openSession } = deps;
  const labelOf = React.useCallback(
    (id: string) => agents.find((agent) => agent.id === id)?.label ?? UNTITLED_SUBAGENT,
    [agents],
  );
  const actions = React.useMemo<IslandAgentsFeed["actions"]>(
    () => ({
      peekAgent: (id) => peekSession?.(id),
      promoteAgent: (id) => openSession?.(id),
      // A request to main, by id, as the person. The label is read at PRESS
      // time for the same reason the tab feed reads its host then: by the
      // time a refusal lands the row may have moved. Fire-and-forget from
      // the row's handler; the refusal is a toast plus the channel's word.
      stopAgent: (id) => {
        const label = labelOf(id);
        /* v8 ignore next -- the lab has no bridge, and no subagents to stop through one. */
        const api = typeof window === "undefined" ? undefined : window.api?.sessions;
        if (api === undefined) return;
        void (async () => {
          try {
            const result = await api.stop({ sessionId: id });
            if (!result.ok) {
              toastError(`Could not stop subagent: ${result.error}`);
              flash("Stop refused", label);
            } else if (result.failures.length > 0) {
              // The stop fact is durable; the runtime acts that failed are
              // reported, never hidden (`supervise-session.ts`).
              toastError(`Stopped ${label}, but: ${result.failures.join(" ")}`);
            }
          } catch (reason) {
            toastError(`Could not stop subagent: ${errorMessage(reason)}`);
            flash("Stop refused", label);
          }
        })();
      },
    }),
    [flash, labelOf, openSession, peekSession],
  );

  return React.useMemo(() => ({ model: { agents }, actions }), [agents, actions]);
}
