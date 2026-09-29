/** VC-329 review hub: shipping components over the same in-memory fixtures. */
import * as React from "react";
import { AutomationsPage } from "@renderer/components/automations/automations-page";
import { TicketAutomationsPanel } from "@renderer/components/automations/ticket-rail-automations";
import { Button } from "@renderer/components/ui/button";
import { Toaster } from "@renderer/components/ui/sonner";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import type { ApiOverrides } from "../fake-api";
import { createBoardMoveFixture } from "../board-move-fixture";
import { project, tickets } from "../fixtures";
import TicketKickoffScratch, { api as composerApi, seed as seedComposer } from "./ticket-kickoff";
import { api as automationApi, seed as seedAutomations } from "./automation-design-pass";

export const title = "Automation improvements · VC-329 review";
export const note =
  "Board arming and drag, simplified composer, persistent editor drafts, and cross-column ticket runs.";
export const viewport = "window" as const;

const boardMoves = createBoardMoveFixture(project.id, tickets);

export function seed(): void {
  seedComposer();
  seedAutomations();
  boardMoves.reset();
}

const previewOnly = async () => ({
  ok: false,
  error: "UI preview only — starting work requires the desktop app.",
});
export const api: ApiOverrides = {
  ...composerApi,
  ...automationApi,
  automations: {
    ...(automationApi.automations as Record<string, unknown>),
    runsForTicket: async () => ({ ok: true, runs: [] }),
    run: previewOnly,
    runForProject: previewOnly,
  },
  tickets: {
    ...((composerApi as ApiOverrides).tickets as Record<string, unknown>),
    create: previewOnly,
    move: boardMoves.move,
    moveMany: boardMoves.moveMany,
  },
};

const VIEWS = [
  {
    id: "board",
    label: "Board & composer",
    hint: "Open composer for the new launch selector and Options. Drag a ticket over Doing; hold ⌥ to expand the drop choices. Escape cancels.",
  },
  {
    id: "editor",
    label: "Automation editor",
    hint: "Select Implement, edit its instructions, then switch to Lanes and back to restore the draft. Column bolts and Automatic triggers are independently configurable.",
  },
  {
    id: "ticket",
    label: "Ticket sidebar",
    hint: "Current-column, other-column, and Any column automations are visible without opening a menu. The caret retains runtime overrides.",
  },
] as const;
type View = (typeof VIEWS)[number]["id"];
const example = tickets.find((ticket) => ticket.status === "doing")!;

export default function AutomationImprovementsScratch() {
  const [view, setView] = React.useState<View>(() => {
    const requested = new URLSearchParams(window.location.search).get("preview");
    return VIEWS.find((item) => item.id === requested)?.id ?? "board";
  });
  return (
    <TooltipProvider>
      <div className="flex h-full min-h-0 flex-col bg-background">
        <div className="flex shrink-0 flex-col gap-2 border-b border-border p-4 pr-64">
          <nav aria-label="VC-329 preview surfaces" className="flex flex-wrap items-center gap-2">
            {VIEWS.map((item) => (
              <Button
                key={item.id}
                variant={view === item.id ? "secondary" : "ghost"}
                aria-pressed={view === item.id}
                onClick={() => setView(item.id)}
              >
                {item.label}
              </Button>
            ))}
            <span className="text-label text-muted-foreground">Fixture data · no real Runs</span>
          </nav>
          <p className="text-ui text-muted-foreground">
            {VIEWS.find((item) => item.id === view)!.hint}
          </p>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {view === "board" ? <TicketKickoffScratch initialTickets={boardMoves.read()} /> : null}
          {view === "editor" ? <AutomationsPage /> : null}
          {view === "ticket" ? (
            <div className="flex h-full min-h-0">
              <main className="min-w-0 flex-1 px-gutter py-6">
                <div className="mx-auto flex max-w-content flex-col gap-4">
                  <span className="text-ui text-muted-foreground">
                    {project.ticketPrefix}-{example.ticketNumber} · Doing
                  </span>
                  <h1 className="text-title font-medium">{example.title}</h1>
                  <p className="text-sm leading-prose text-muted-foreground">
                    The sidebar is the shipping TicketAutomationsPanel. This ticket can run
                    Implement, Standards sweep, or Triage without moving to a different column.
                  </p>
                </div>
              </main>
              <aside
                aria-label="Ticket automation sidebar"
                className="w-80 shrink-0 border-l border-border pb-4"
              >
                <TicketAutomationsPanel projectId={project.id} ticket={example} />
              </aside>
            </div>
          ) : null}
        </div>
      </div>
      <Toaster />
    </TooltipProvider>
  );
}
