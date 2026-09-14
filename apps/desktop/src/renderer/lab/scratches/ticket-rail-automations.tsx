/**
 * The ticket rail's Automations block (VC-129), at every state it has to
 * survive — redrawn for VC-257.
 *
 * The question this scratch answers: does the block read as ONE object under
 * its eyebrow, beside the Sessions block that follows it on the Now page? The
 * shipped drawing put a text link reading "Automations" two lines under the
 * heading AUTOMATIONS whenever the project listed nothing. That empty-state
 * door is in the header row now, at the rung the Sessions header keeps its own
 * control, and the empty state is a single quiet line. Populated and unread
 * states keep their prior scope: neither gains a new page door.
 *
 * Read it in this order:
 *   1. The three states — empty, armed, still reading — each with the Sessions
 *      block under it, because the two headers have to agree.
 *   2. Narrow — the same three at the 240px floor.
 *
 * Every column is the SHIPPING component over the shipping store: the fixtures
 * below are what `volli:automations` doors return, so what is on screen is
 * what the rail decides — never a mock-up of it. Press the empty column's door;
 * the caption under section 1 says where it went.
 */
import * as React from "react";
import type { Automation, ColumnArming, Project, Ticket } from "@volli/shared";

import { TicketAutomationsPanel } from "@renderer/components/automations/ticket-rail-automations";
import { TicketSessionsPanel } from "@renderer/components/ticket/ticket-sessions-panel";
import { SectionHeading } from "@renderer/components/ui/section-heading";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { useAutomationsStore } from "@renderer/stores/automations";
import { useProjectsStore } from "@renderer/stores/projects";
import { useWorkspaceStore } from "@renderer/stores/workspace";

import type { ApiOverrides } from "../fake-api";
import { NOW, project, tickets } from "../fixtures";
import { appApi } from "../seed";

export const title = "Ticket rail · Automations block (VC-257)";
export const note =
  "The empty-state header door and one-line report — beside populated and unread states";

/** The rail's two widths, from `stores/ui.ts`. */
const RAIL_DEFAULT = 300;
const RAIL_FLOOR = 240;

// ─── fixtures ───────────────────────────────────────────────────────────────

/**
 * Three projects, because the Automations store keys its list by project and
 * the rail reads THIS project's — one column per state is one project per
 * state. Same prefix and tickets throughout; only what the project lists
 * differs.
 */
const EMPTY: Project = { ...project, id: "prj-empty", name: "Voltaic (nothing yet)" };
const ARMED: Project = { ...project, id: "prj-armed", name: "Voltaic" };
const READING: Project = { ...project, id: "prj-reading", name: "Voltaic (cold cache)" };

const AUTOMATIONS: readonly Automation[] = [
  {
    id: "automation-implement",
    projectId: ARMED.id,
    name: "Implement",
    instructions: "/implement\nWork the ticket through verification.",
    trigger: { kind: "columns", columns: ["doing"] },
    runtime: null,
    createdAt: NOW - 4_000,
    updatedAt: NOW - 1_000,
  },
  {
    id: "automation-review",
    projectId: ARMED.id,
    name: "Review every boundary in this ticket's diff",
    instructions: "/code-review",
    trigger: { kind: "columns", columns: ["doing", "needs_review"] },
    runtime: null,
    createdAt: NOW - 3_000,
    updatedAt: NOW - 1_000,
  },
];

const ARMINGS: readonly ColumnArming[] = [
  { projectId: ARMED.id, status: "doing", automationId: "automation-implement", armedAt: NOW },
];

/** One Doing ticket, re-homed per project so each column's rail is that project's. */
const DOING = tickets.find((ticket) => ticket.status === "doing") ?? tickets[0]!;
function ticketIn(owner: Project): Ticket {
  return { ...DOING, id: `${owner.id}-ticket`, projectId: owner.id };
}

// ─── setup ──────────────────────────────────────────────────────────────────

export function seed(): void {
  useProjectsStore.setState({ projects: [EMPTY, ARMED, READING], selectedProjectId: ARMED.id });
  useWorkspaceStore.setState({ byProject: {} });
  useAutomationsStore.setState({
    byProject: {},
    armingByProject: {},
    orderByProject: {},
    runsByProject: {},
    runsByTicket: {},
    enabledIds: [],
    enablementRead: false,
    editor: null,
  });
}

export const api: ApiOverrides = {
  ...appApi,
  automations: {
    // The cold-cache column's read never lands, which is the honest way to
    // hold the rail at "Reading automations…" for as long as it is looked at.
    list: (input: { projectId: string }) =>
      input.projectId === READING.id
        ? new Promise(() => {})
        : Promise.resolve({
            ok: true,
            automations: input.projectId === ARMED.id ? AUTOMATIONS : [],
          }),
    armings: (input: { projectId: string }) =>
      Promise.resolve({ ok: true, armings: input.projectId === ARMED.id ? ARMINGS : [] }),
    enablement: () => Promise.resolve({ ok: true, enabledAutomationIds: ["automation-implement"] }),
    columnOrders: () => Promise.resolve({ ok: true, orders: [] }),
    runsForTicket: () => Promise.resolve({ ok: true, runs: [] }),
  },
};

// ─── the scratch ────────────────────────────────────────────────────────────

export default function TicketRailAutomationsScratch() {
  return (
    <TooltipProvider>
      <div className="flex flex-col gap-8">
        <Intro />

        <Group heading="1 · The three states, over the Sessions block">
          <div className="flex flex-wrap items-start gap-4">
            <Rail label="Nothing yet" owner={EMPTY} />
            <Rail label="Doing arms Implement" owner={ARMED} />
            <Rail label="Still reading" owner={READING} />
          </div>
          <Caption>
            The empty column has one eyebrow, one page door beside it, and one report under the Run
            button. Press the door: that project&rsquo;s workspace nav flips to{" "}
            <code className="font-mono text-ui">automations</code>. The armed and unread columns do
            not gain a new page door; VC-257 moves the existing empty-state control rather than
            expanding its behavior. Read the Sessions header under each block too &mdash; the
            heading rows are the same drawing, and should look it.
          </Caption>
          <Where />
        </Group>

        <Group heading="2 · The floor (240px)">
          <div className="flex flex-wrap items-start gap-4">
            <Rail label="Nothing yet" owner={EMPTY} width={RAIL_FLOOR} narrow />
            <Rail label="Doing arms Implement" owner={ARMED} width={RAIL_FLOOR} narrow />
          </div>
          <Caption>
            The split button truncates its label rather than pushing the caret off the edge, and the
            sentence wraps rather than truncating &mdash; it is a report, and a report cut short
            says less than nothing. The empty state&rsquo;s header row does not move: its door stays
            level with the eyebrow at both insets.
          </Caption>
        </Group>
      </div>
    </TooltipProvider>
  );
}

function Intro() {
  return (
    <div className="flex flex-col gap-2">
      <SectionHeading as="h2">What this is for</SectionHeading>
      <p className="max-w-content text-ui leading-prose text-muted-foreground">
        The Now page&rsquo;s Automations block, between what a ticket cost and who is working on it.
        The rail runs and never authors (VC-112). Its empty-state door used to be a text link under
        the report, reading &ldquo;Automations&rdquo; two lines beneath the heading AUTOMATIONS.
        That same door now sits in the empty state&rsquo;s heading row; no other state gains one.
        Every column is <code className="font-mono text-ui">TicketAutomationsPanel</code> over the
        real store, so what each button offers is the rail&rsquo;s decision, not this
        scratch&rsquo;s.
      </p>
    </div>
  );
}

/** Where the last door press went — read live off the store the door writes. */
function Where() {
  const navs = useWorkspaceStore((state) =>
    [EMPTY, ARMED, READING]
      .map((owner) => `${owner.name}: ${state.byProject[owner.id]?.nav ?? "home"}`)
      .join(" · "),
  );
  return <p className="font-mono text-ui text-muted-foreground">{navs}</p>;
}

function Group({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <SectionHeading as="h2">{heading}</SectionHeading>
      {children}
    </section>
  );
}

function Caption({ children }: { children: React.ReactNode }) {
  return <p className="max-w-content text-ui leading-prose text-muted-foreground">{children}</p>;
}

/**
 * A rail-width column on the rail's own backdrop, holding the two blocks as
 * the Now page stacks them.
 *
 * `group/rail` plus `data-narrow` is the real contract — `rail-panel-parts.tsx`
 * drives its narrow inset off exactly this. Vertical padding only, for the
 * reason the usage scratch gives: a horizontal inset here would stack on the
 * blocks' own and draw everything 32px narrower than the rail really does.
 */
function Rail({
  label,
  owner,
  width = RAIL_DEFAULT,
  narrow = false,
}: {
  label: string;
  owner: Project;
  width?: number;
  narrow?: boolean;
}) {
  const ticket = React.useMemo(() => ticketIn(owner), [owner]);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-label font-medium uppercase text-muted-foreground">{label}</p>
      <div
        className="group/rail flex shrink-0 flex-col rounded-container border border-border bg-background pb-4"
        data-narrow={narrow ? "true" : "false"}
        style={{ width }}
      >
        <TicketAutomationsPanel projectId={owner.id} ticket={ticket} />
        <TicketSessionsPanel
          projectId={owner.id}
          ticketId={ticket.id}
          creating={false}
          onNewSession={() => {}}
          onNewChat={() => {}}
          onActivateSession={() => {}}
          onActivateChat={() => {}}
        />
      </div>
    </div>
  );
}
