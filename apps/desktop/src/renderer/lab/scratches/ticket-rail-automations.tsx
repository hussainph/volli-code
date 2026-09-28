/**
 * The ticket rail's Automations block (VC-129), at every state it has to
 * survive — redrawn for VC-406.
 *
 * The question this scratch answers: does the block read as ONE object under
 * its eyebrow, beside the Sessions block on the Now page — and do its rows
 * read as rows? The offer is a height-capped list: every column's Offered
 * work as a `ListRow`, this Ticket's own column first, the armed record
 * marked, a switched-off record wearing a slashed bolt, and nothing under the
 * rows (the rail's Run once was retired in VC-406's second pass — a one-off is
 * `+ Chat` and typing). What it replaces is a split button naming one
 * Automation with every other one behind a caret.
 *
 * Read it in this order:
 *   1. The three states — empty, armed, still reading — each with the Sessions
 *      block under it, because the two headers have to agree.
 *   2. Narrow — the same three at the 240px floor.
 *   3. The cap — a project with more Automations than the block will grow for.
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

export const title = "Ticket rail · Automations block (VC-406)";
export const note = "The capped offer list and its one button — beside the empty and unread states";

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
/** More Automations than the block will grow for — the cap's own case. */
const MANY: Project = { ...project, id: "prj-many", name: "Voltaic (a full board)" };

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

/**
 * Nine Automations across four columns. The point is the CAP: the block shows
 * about five rows and scrolls the rest, so this column is the same height as
 * the two-Automation one beside it and the Sessions roster under both sits at
 * the same y.
 */
const MANY_AUTOMATIONS: readonly Automation[] = (
  [
    ["Implement", "doing"],
    ["Write the tests first", "doing"],
    ["Sweep the diff for boundaries", "doing"],
    ["Triage", "todo"],
    ["Estimate", "todo"],
    ["Code review", "needs_review"],
    ["Check the migrations", "needs_review"],
    ["Merge the PR", "done"],
    ["Archive the worktree", "done"],
  ] as const
).map(([name, column], index) => ({
  id: `many-${index}`,
  projectId: MANY.id,
  name,
  instructions: "/run",
  trigger: { kind: "columns", columns: [column] },
  runtime: null,
  createdAt: NOW - index,
  updatedAt: NOW - index,
}));

const MANY_ARMINGS: readonly ColumnArming[] = [
  { projectId: MANY.id, status: "doing", automationId: "many-0", armedAt: NOW },
];

/** One Doing ticket, re-homed per project so each column's rail is that project's. */
const DOING = tickets.find((ticket) => ticket.status === "doing") ?? tickets[0]!;
function ticketIn(owner: Project): Ticket {
  return { ...DOING, id: `${owner.id}-ticket`, projectId: owner.id };
}

// ─── setup ──────────────────────────────────────────────────────────────────

export function seed(): void {
  useProjectsStore.setState({
    projects: [EMPTY, ARMED, READING, MANY],
    selectedProjectId: ARMED.id,
  });
  useWorkspaceStore.setState({ byProject: {} });
  // SEEDED AS ALREADY-READ, for every project but the cold-cache one. The rail
  // refuses to draw a row from a cache it has not confirmed at the current
  // planning version (VC-112/VC-373), and a scratch that left all four slices
  // cold showed three columns of "Reading automations…" — which is one state
  // drawn three times, not the three states this section is for. The doors
  // below still answer; this is the warm arrival they would produce.
  useAutomationsStore.setState({
    byProject: {
      [EMPTY.id]: [],
      [ARMED.id]: [...AUTOMATIONS],
      [MANY.id]: [...MANY_AUTOMATIONS],
    },
    armingByProject: {
      [EMPTY.id]: [],
      [ARMED.id]: [...ARMINGS],
      [MANY.id]: [...MANY_ARMINGS],
    },
    orderByProject: { [EMPTY.id]: [], [ARMED.id]: [], [MANY.id]: [] },
    runsByProject: {},
    enabledIds: ["automation-implement"],
    enablementRead: true,
    // The planning clock rests at 0 (`stores/board.ts`), so a slice marked at 0
    // is a slice read at the version the app is on. READING is deliberately
    // absent from every key here.
    railReadAt: {
      enablement: 0,
      "list:prj-empty": 0,
      "arming:prj-empty": 0,
      "order:prj-empty": 0,
      "list:prj-armed": 0,
      "arming:prj-armed": 0,
      "order:prj-armed": 0,
      "list:prj-many": 0,
      "arming:prj-many": 0,
      "order:prj-many": 0,
    },
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
            automations:
              input.projectId === ARMED.id
                ? AUTOMATIONS
                : input.projectId === MANY.id
                  ? MANY_AUTOMATIONS
                  : [],
          }),
    armings: (input: { projectId: string }) =>
      Promise.resolve({
        ok: true,
        armings:
          input.projectId === ARMED.id ? ARMINGS : input.projectId === MANY.id ? MANY_ARMINGS : [],
      }),
    enablement: () => Promise.resolve({ ok: true, enabledAutomationIds: ["automation-implement"] }),
    columnOrders: () => Promise.resolve({ ok: true, orders: [] }),
  },
};

// ─── the scratch ────────────────────────────────────────────────────────────

export default function TicketRailAutomationsScratch() {
  return (
    <TooltipProvider>
      <div className="flex flex-col gap-8">
        <Intro />

        <Group heading="1 · The three states, under the Sessions block">
          <div className="flex flex-wrap items-start gap-4">
            <Rail label="Nothing yet" owner={EMPTY} />
            <Rail label="Doing arms Implement" owner={ARMED} />
            <Rail label="Still reading" owner={READING} />
          </div>
          <Caption>
            The armed column is the one to read first: rows for every column&rsquo;s Offered work,
            this Ticket&rsquo;s own column at the top with its armed record marked, and nothing
            under them. A row runs what it names, and every row is a row &mdash; the Sessions roster
            under each block is built from the same{" "}
            <code className="font-mono text-ui">ListRow</code>, which is what makes the rule one
            rule. A record whose triggers are off wears a slashed bolt and says only its column at
            the right; the words are in its title. The still-reading column holds the list&rsquo;s
            own height as skeleton rows, so a re-read moves nothing under it. The empty column keeps
            its one quiet report; the page door sits beside the eyebrow at every state. Press it:
            that project&rsquo;s workspace nav flips to{" "}
            <code className="font-mono text-ui">automations</code>.
          </Caption>
          <Where />
        </Group>

        <Group heading="2 · The floor (240px)">
          <div className="flex flex-wrap items-start gap-4">
            <Rail label="Nothing yet" owner={EMPTY} width={RAIL_FLOOR} narrow />
            <Rail label="Doing arms Implement" owner={ARMED} width={RAIL_FLOOR} narrow />
          </div>
          <Caption>
            A row truncates its name rather than widening the column, and the name keeps a floor so
            the column word can never outlive it. The sentence wraps rather than truncating &mdash;
            it is a report, and a report cut short says less than nothing. The header row does not
            move: the door stays level with the eyebrow at both insets.
          </Caption>
        </Group>

        <Group heading="3 · The cap">
          <div className="flex flex-wrap items-start gap-4">
            <Rail label="Two automations" owner={ARMED} />
            <Rail label="Nine automations" owner={MANY} />
          </div>
          <Caption>
            Nine Automations do not make a block four and a half times taller than two do: the list
            stops at <code className="font-mono text-ui">max-h-40</code> and scrolls, so the
            Sessions heading under it cannot be pushed off the resting view by a project that
            arranges every lane. The cap is a CEILING, not a fixed height &mdash; a two-Automation
            project pays for two rows, which is why the column at the left is the shorter of the
            two. The other way to bound this block is a caret hiding eight of the nine, which bounds
            it by refusing to answer what the block is for.
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
        The Now page&rsquo;s Automations block: what this Ticket can be made to run, ABOVE the
        Sessions roster, because a Run is how a row appears in that roster (VC-406). The offer is a
        height-capped list of rows with one button under it, where it used to be one split button
        naming a single Automation with every other one behind a caret. The rail runs and never
        authors (VC-112). Every column is{" "}
        <code className="font-mono text-ui">TicketAutomationsPanel</code> over the real store, so
        what each row offers is the rail&rsquo;s decision, not this scratch&rsquo;s.
      </p>
    </div>
  );
}

/** Where the last door press went — read live off the store the door writes. */
function Where() {
  const navs = useWorkspaceStore((state) =>
    [EMPTY, ARMED, READING, MANY]
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
        className="group/rail flex shrink-0 flex-col gap-4 rounded-container border border-border bg-background py-4"
        data-narrow={narrow ? "true" : "false"}
        style={{ width }}
      >
        {/* The Now page's order (VC-406): Automations over the roster, since a
            Run is how a row appears in that roster. */}
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
