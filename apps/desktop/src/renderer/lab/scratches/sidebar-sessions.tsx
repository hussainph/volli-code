/**
 * The sidebar's Active Sessions navigator, driven through its real inputs.
 *
 * This is the surface that is hardest to *see* in the running app: its two
 * tiers are a function of ticket status, durable session records, and the
 * latest attention signal per ticket, so reaching any particular arrangement
 * means moving cards and starting agents until you get there. Here the
 * arrangement is a button.
 *
 * The scenarios change TICKET STATUS and nothing else, which is deliberate.
 * `buildActiveSessionListing` is the pure model that decides the tiers, and
 * driving it through its real input is what makes this scratch worth trusting
 * — a scratch that set the tier rows directly would be rendering my opinion of
 * the model's output instead of the model's output.
 *
 * Worth watching as you switch: every Doing ticket is guaranteed a row even
 * with no live session (it falls back to a bare "No live session" row), which
 * is the invariant that keeps the tier honest right after a relaunch has killed
 * every PTY.
 */
import * as React from "react";
import type { Ticket } from "@volli/shared";

import { ActiveSessions } from "@renderer/components/sidebar/active-sessions";
import { Sidebar, SidebarProvider } from "@renderer/components/ui/sidebar";
import { useBoardStore } from "@renderer/stores/board";
import { useSessionsStore, type SessionContainer } from "@renderer/stores/sessions";

import { project, signals, tickets } from "../fixtures";
import { appApi, seedApp } from "../seed";

export const title = "Sidebar · Active Sessions";
export const note = "The two attention tiers, driven through real ticket status";

/**
 * A container per signaled ticket, so the attention LABEL is reachable.
 *
 * The model only promotes a signal's reason ("Ready · PR opened") onto a row
 * when it can match the signal to a live tab; with nothing live, a Needs Review
 * ticket falls back to the flat "Needs review". Both are real states, but the
 * fallback is the only one the lab could otherwise ever show — so this seeds
 * the containers the signals in `fixtures.ts` name.
 *
 * Safe HERE and nowhere else: `SessionsLayer` mounts a terminal for every live
 * pane, and this scratch does not mount it. `seedApp` clears these containers
 * again on the way into any scratch that does.
 */
function seedSignaledContainers(): void {
  const byOwner: Record<string, SessionContainer> = {};
  for (const signal of signals) {
    if (signal.sessionId === null) continue;
    byOwner[signal.ticketId] = {
      tabs: [
        {
          sessionId: signal.sessionId,
          title: "Session 1",
          scope: { kind: "ticket", projectId: project.id, ticketId: signal.ticketId },
          layout: { kind: "pane", sessionId: signal.sessionId, exitCode: null },
          activePaneId: signal.sessionId,
        },
      ],
      activeSessionId: signal.sessionId,
    };
  }
  useSessionsStore.setState({ byOwner });
}

export function seed(): void {
  seedApp();
  seedSignaledContainers();
}

export const api = appApi;

/**
 * Each scenario is a rewrite of the fixture tickets' statuses — the one input
 * the tiers are actually derived from.
 */
const SCENARIOS: readonly { key: string; label: string; hint: string; apply(t: Ticket): Ticket }[] =
  [
    {
      key: "mixed",
      label: "Mixed",
      hint: "2 need you, 3 active — the ordinary working state",
      apply: (ticket) => ticket,
    },
    {
      key: "quiet",
      label: "Nothing active",
      hint: "Everything parked in Todo — the empty state",
      apply: (ticket) => ({ ...ticket, status: "todo" }),
    },
    {
      key: "swamped",
      label: "All need you",
      hint: "Six rows in one tier — does the list still scan?",
      apply: (ticket) => ({ ...ticket, status: "needs_review" }),
    },
    {
      key: "all-doing",
      label: "All running",
      hint: "Every ticket in Doing, most with no live session",
      apply: (ticket) => ({ ...ticket, status: "doing" }),
    },
  ];

export default function SidebarSessionsScratch() {
  const [scenarioKey, setScenarioKey] = React.useState("mixed");
  const scenario = SCENARIOS.find((entry) => entry.key === scenarioKey) ?? SCENARIOS[0]!;

  // Writing tickets during render rather than in an effect, for the same reason
  // the shell applies scratch setup during render: an effect would let the
  // sidebar paint one frame against the previous scenario's tickets.
  const applied = React.useRef<string | null>(null);
  if (applied.current !== scenarioKey) {
    applied.current = scenarioKey;
    useBoardStore.setState({
      ticketsByProject: { [project.id]: tickets.map((ticket) => scenario.apply(ticket)) },
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-2">
        {SCENARIOS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            onClick={() => setScenarioKey(entry.key)}
            aria-pressed={entry.key === scenarioKey}
            className="rounded-full border border-border px-3 py-1.5 text-ui text-muted-foreground transition-colors hover:text-foreground aria-pressed:border-primary aria-pressed:text-foreground"
          >
            {entry.label}
          </button>
        ))}
      </div>
      <p className="text-label text-muted-foreground">{scenario.hint}</p>

      {/* The sidebar primitives read `useSidebar()` and size against
          `--sidebar-width`, so they need a provider and a width to exist in.
          This is the minimum framing that gets there — the full two-tier
          arrangement lives in the App shell scratch, which uses the real one. */}
      <SidebarProvider
        className="min-h-0 w-fit"
        style={{ "--sidebar-width": "260px" } as React.CSSProperties}
      >
        <Sidebar collapsible="none" className="w-(--sidebar-width) rounded-xl border border-border">
          <ActiveSessions project={project} />
        </Sidebar>
      </SidebarProvider>
    </div>
  );
}
