/**
 * The node-canvas question, asked properly.
 *
 * ── WHY THIS IS NOT AN n8n CANVAS ─────────────────────────────────────────
 * n8n, Make, Gumloop, Retool and Zapier all hand you an empty 2D plane because
 * they have no topology of their own. Zapier connects Stripe to Slack; there is
 * no graph until you draw one, so the canvas is not a visualisation, it IS the
 * program. Volli is the opposite case: the topology is fixed, five nodes long,
 * and every ticket already walks it. Backlog → Todo → Doing → Needs Review →
 * Done is the graph. Handing someone a blank plane and asking them to draw it
 * again would be asking them to retype a constant.
 *
 * The survey splits exactly along that line. Every product with a fixed
 * pipeline — Linear, Jira, Trello, Notion, Height — expresses automation as a
 * form, a sentence, or a vertical trigger→condition→action chain, and none of
 * them has ever shipped a canvas. Jira, the most rule-heavy of them, branches
 * by nesting chain segments rather than by drawing edges. The one board-adjacent
 * product that IS a canvas, Lindy, has no board.
 *
 * So this scratch does not let you place nodes. The five columns ARE the lanes,
 * in board order, and an automation is placed by naming where on that spine it
 * attaches. The map is the board with automations where tickets would be —
 * which is the only version of "node canvas" that is about Volli rather than
 * about node canvases.
 *
 * ── THE FINDING THIS SCRATCH EXISTS TO SHOW ───────────────────────────────
 * Load it on `Board only` and count the edges. There are none. Every v1
 * automation is triggered by a human moving a card, so nothing an automation
 * does is the cause of anything another automation does, and a graph with no
 * edges is a list with extra pixels and a scroll direction. The five lanes are
 * five buckets.
 *
 * Now flip to `Board + session`. Two chained automations appear, triggered by
 * `session-ends` and `checks-pass` — the two unbuilt kinds already sitting
 * disabled in the form's picker — and the edges have something real to point
 * at. THAT is when Volli becomes a graph: not when automations get more steps,
 * but when one automation's completion becomes another's trigger.
 *
 * Which dates the decision, and the date is corroborated from the other side.
 * Zapier is retiring its linear step editor for a flow diagram right now, and
 * the reason it gives is branching: paths were hard to follow in a list. That
 * is the real trigger condition for going visual, and v1 Volli has no branches
 * at all — one trigger, one straight run, no conditions, no fan-in.
 *
 * ── WHAT THE MAP EARNS EVEN AT ZERO EDGES ─────────────────────────────────
 * Two things the form cannot do, both about the SET rather than about one
 * automation:
 *
 *   1. Coverage at a glance — Needs Review starts two paid sessions and Backlog
 *      starts none. In the form's index that is five rows you have to read and
 *      hold in your head; here it is a silhouette. This is the one place the
 *      survey found an actual gap rather than a pattern to copy: not one of the
 *      five pipeline products can show you what fires on a given column without
 *      opening every rule and checking. Even Jira makes you do that.
 *   2. Retargeting by dragging a node into another lane. Changing which column
 *      fires an automation is a spatial edit, and the form makes you open the
 *      automation, find the trigger card, and toggle two pills.
 *
 * Neither is authoring. Note what happens when you click a node: the inspector
 * is the form, unchanged. That is not a shortcut, it is the one thing all five
 * canvas products agree on — configuration never lives on the node face, and
 * Zapier moved its own from a modal to a side panel specifically to keep the
 * flow visible while you edit. Prompts are prose and flags are flags, and
 * neither gets better inside a 216px node.
 * ──────────────────────────────────────────────────────────────────────────
 */
import * as React from "react";
import { ArrowsClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowsClockwise";
import { CheckCircleIcon } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { ClockIcon } from "@phosphor-icons/react/dist/csr/Clock";
import { LightningIcon } from "@phosphor-icons/react/dist/csr/Lightning";
import { TrayArrowDownIcon } from "@phosphor-icons/react/dist/csr/TrayArrowDown";
import { TICKET_STATUS_LABELS, TICKET_STATUSES, type TicketStatus } from "@volli/shared";

import { cn } from "@renderer/lib/utils";

import { HarnessMark } from "../automation/harness-identity";
import { StepCard } from "../automation/step-card";
import { TriggerCard } from "../automation/trigger-card";
import {
  harnessTrail,
  SEEDED_AUTOMATIONS,
  triggerSummary,
  type Automation,
  type AutomationStep,
  type Trigger,
} from "../automation/model";

export const title = "Automation · map";
export const note = "Is a node graph better than the form? Count the edges.";
export const viewport = "window" as const;

/* ------------------------------------------------------------- vocabulary */

/**
 * The map's own trigger kinds, on top of the shipped three.
 *
 * These are `session-ends` and `checks-pass` from `TRIGGER_KINDS`, the two the
 * form renders disabled. They are extended HERE rather than in `model.ts` on
 * purpose: the form has no way to express "after that automation", and giving
 * it one would mean designing a picker that lists automations, which is a
 * different piece of work. Keeping the extension local means the form stays
 * honest about what it cannot say, and the gap stays visible.
 */
type ChainedTrigger =
  | { kind: "session-ends"; after: string }
  | { kind: "checks-pass"; after: string };

type MapTrigger = Trigger | ChainedTrigger;

interface MapAutomation extends Omit<Automation, "trigger"> {
  trigger: MapTrigger;
}

function isChained(trigger: MapTrigger): trigger is ChainedTrigger {
  return trigger.kind === "session-ends" || trigger.kind === "checks-pass";
}

/**
 * The lane an automation hangs in.
 *
 * A chained automation names no column — that is the whole point of it — so it
 * inherits the column of whatever it waits on, walked back until something
 * names one. Which is not a layout convenience, it is the truth about when it
 * runs: the implement session ending does not move the ticket, and checks going
 * green do not move the ticket, so every link in that chain fires while the
 * card is still sitting in Doing.
 *
 * That is worth staring at on the `Board + session` toggle. The multi-column
 * flow — do the thing, wait for green, then review — is not multi-column at
 * all. It is a vertical chain inside one lane, and it stays there until
 * something moves the card, which under `automation only ever de-escalates` is
 * still a person.
 */
function laneOf(automation: MapAutomation, all: MapAutomation[]): TicketStatus | null {
  // Indexed rather than re-scanned per hop, which also keeps the walk's type
  // acyclic: `Map.get` takes a string whatever the trigger turns out to be,
  // where `all.find(a => a.id === trigger.after)` makes the loop variable's
  // type depend on itself and TypeScript gives up and infers `any`.
  const byId = new Map<string, MapAutomation>(all.map((item) => [item.id, item]));
  const seen = new Set<string>();
  let node: MapAutomation | undefined = automation;

  while (node !== undefined && !seen.has(node.id)) {
    seen.add(node.id);
    const trigger: MapTrigger = node.trigger;
    if (trigger.kind === "manual") return null;
    if (!isChained(trigger)) return trigger.columns[0] ?? null;
    node = byId.get(trigger.after);
  }
  return null;
}

function stepFor(base: AutomationStep, id: string, instructions: string): AutomationStep {
  return { ...base, id, instructions };
}

/**
 * The v1 five, plus the two that only exist once a session can trigger
 * something. The chained pair is deliberately the user's own example — go to
 * Doing, do the thing, and when the checks come back green, review it — so the
 * map is judged against the flow it was proposed for rather than an invented
 * one.
 */
const CHAINED: MapAutomation[] = [
  {
    id: "atm-selfcheck",
    scope: "project",
    name: "Fix what CI caught",
    trigger: { kind: "session-ends", after: "atm-implement" },
    steps: [
      stepFor(
        SEEDED_AUTOMATIONS[1].steps[0],
        "step-selfcheck",
        "The implementation session just ended. Run the project's checks, and if anything is red, fix it and run them again.\n\nIf it is red for a reason you cannot fix without a decision, stop and say which decision.",
      ),
    ],
  },
  {
    id: "atm-gate",
    scope: "project",
    name: "Review once green",
    trigger: { kind: "checks-pass", after: "atm-selfcheck" },
    steps: [
      stepFor(
        SEEDED_AUTOMATIONS[2].steps[0],
        "step-gate",
        "Checks are green, which says nothing about whether this is right. Review the change against the ticket it claims to implement.",
      ),
    ],
  },
];

const V1_AUTOMATIONS: MapAutomation[] = SEEDED_AUTOMATIONS;

/* ----------------------------------------------------------------- layout */

/**
 * Fixed geometry, in px, shared by the lanes and by the SVG that draws over
 * them. Measuring the DOM would be more flexible and would also mean the edges
 * are one frame behind every drag; a graph whose lanes are a known width can
 * compute both from the same six numbers.
 */
const LAYOUT = {
  laneWidth: 216,
  laneGap: 14,
  headerHeight: 34,
  nodeHeight: 62,
  // Wide enough that a connector between two stacked nodes reads as a
  // connector. At the 8px this started on, the arrowhead landed in the seam
  // between two cards and the chain looked like two cards touching.
  nodeGap: 22,
  railPadding: 16,
} as const;

function laneX(index: number): number {
  return index * (LAYOUT.laneWidth + LAYOUT.laneGap);
}

function nodeY(index: number): number {
  return LAYOUT.headerHeight + 10 + index * (LAYOUT.nodeHeight + LAYOUT.nodeGap);
}

/** Where the lanes actually put each automation, so the edges can find them. */
type Placement = Map<string, { x: number; y: number }>;

/* ------------------------------------------------------------------ nodes */

const CHAINED_ICON = {
  "session-ends": ArrowsClockwiseIcon,
  "checks-pass": CheckCircleIcon,
} as const;

function MapNode({
  automation,
  selected,
  dragging,
  onSelect,
  onDragStart,
}: {
  automation: MapAutomation;
  selected: boolean;
  dragging: boolean;
  onSelect: () => void;
  onDragStart: (event: React.PointerEvent) => void;
}) {
  const trail = harnessTrail(automation as Automation);
  const chained = isChained(automation.trigger);
  const ChainIcon = chained
    ? CHAINED_ICON[automation.trigger.kind as ChainedTrigger["kind"]]
    : null;

  return (
    <button
      type="button"
      onClick={onSelect}
      onPointerDown={onDragStart}
      aria-pressed={selected}
      style={{ height: LAYOUT.nodeHeight }}
      className={cn(
        "flex w-full flex-col justify-between rounded-lg border bg-card px-2.5 py-2 text-left",
        "transition-[border-color,background-color,box-shadow] duration-150 ease-out",
        "hover:border-muted-foreground/40 motion-reduce:transition-none",
        selected ? "border-primary/60 bg-primary/10" : "border-border",
        // The node under the pointer keeps its place in the lane and a copy
        // follows the cursor, so the lane never reflows mid-drag and you are
        // aiming at a layout that is standing still.
        dragging && "opacity-40",
      )}
    >
      <span className="flex items-center gap-1.5">
        {ChainIcon === null ? null : (
          <ChainIcon weight="fill" aria-hidden className="size-3 shrink-0 text-muted-foreground" />
        )}
        <span className="truncate text-ui text-foreground">{automation.name}</span>
      </span>
      <span className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1">
          {trail.map((harnessId) => (
            <HarnessMark key={harnessId} harnessId={harnessId} labelled />
          ))}
        </span>
        <span className="text-label text-muted-foreground">
          {automation.steps.length === 1 ? "1 step" : `${automation.steps.length} steps`}
        </span>
      </span>
    </button>
  );
}

/**
 * Everything that fires without a column: run-by-hand today, schedule and
 * inbound events later.
 *
 * Drawn beside the rail rather than in it, because these are the only triggers
 * whose job may be to CREATE a ticket — a scheduled automation does not react
 * to a column, it enters the board. A lane for them would claim they fire
 * somewhere on the spine, and they fire before it. This is also the gutter the
 * "meta-level, downstream" automations land in, so it is sized for company.
 */
function OffBoardGutter({
  automations,
  selectedId,
  onSelect,
}: {
  automations: MapAutomation[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const unbuilt = [
    { icon: ClockIcon, label: "Schedule" },
    { icon: TrayArrowDownIcon, label: "Inbound event" },
  ];
  return (
    <div
      style={{ width: 184 }}
      className="flex shrink-0 flex-col gap-2 border-r border-dashed border-border pr-4"
    >
      <p
        style={{ height: LAYOUT.headerHeight }}
        className="flex items-center text-label text-muted-foreground uppercase"
      >
        Off board
      </p>
      {automations.map((automation) => (
        <MapNode
          key={automation.id}
          automation={automation}
          selected={automation.id === selectedId}
          dragging={false}
          onSelect={() => onSelect(automation.id)}
          onDragStart={() => {}}
        />
      ))}
      {unbuilt.map(({ icon: RowIcon, label }) => (
        <div
          key={label}
          style={{ height: LAYOUT.nodeHeight }}
          className="flex items-center gap-2 rounded-lg border border-dashed border-border px-2.5 text-ui text-muted-foreground"
        >
          <RowIcon aria-hidden className="size-3.5 shrink-0" />
          {label}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ edges */

/**
 * One curve per chained automation, from the node that finishes to the node
 * that waits. Drawn under the nodes rather than over them, so a curve passing
 * behind a lane never sits on top of a name.
 */
function EdgeLayer({
  automations,
  placement,
  width,
  height,
}: {
  automations: MapAutomation[];
  placement: Placement;
  width: number;
  height: number;
}) {
  const edges = automations.flatMap((automation) => {
    if (!isChained(automation.trigger)) return [];
    const from = placement.get(automation.trigger.after);
    const to = placement.get(automation.id);
    if (from === undefined || to === undefined) return [];
    return [{ id: automation.id, from, to }];
  });

  if (edges.length === 0) return null;

  return (
    <svg
      aria-hidden
      width={width}
      height={height}
      className="pointer-events-none absolute inset-0 overflow-visible"
    >
      <defs>
        <marker id="map-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
          <path d="M0 0 L6 3 L0 6 Z" className="fill-primary/70" />
        </marker>
      </defs>
      {edges.map(({ id, from, to }) => {
        // Out of the bottom of the source, into the top of the target. The
        // control points are vertical so the curve leaves and arrives square,
        // which is what makes a bundle of them legible when they overlap.
        const x1 = from.x + LAYOUT.laneWidth / 2;
        const y1 = from.y + LAYOUT.nodeHeight;
        const x2 = to.x + LAYOUT.laneWidth / 2;
        const y2 = to.y;
        const bend = Math.max(28, Math.abs(y2 - y1) / 2);
        return (
          <path
            key={id}
            d={`M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}`}
            fill="none"
            strokeWidth={1.5}
            markerEnd="url(#map-arrow)"
            className="stroke-primary/70"
          />
        );
      })}
    </svg>
  );
}

/* -------------------------------------------------------------- inspector */

/** What the form has no picker for — read-only here, and deliberately so. */
function ChainedTriggerCard({
  trigger,
  automations,
}: {
  trigger: ChainedTrigger;
  automations: MapAutomation[];
}) {
  const source = automations.find((automation) => automation.id === trigger.after);
  const ChainIcon = CHAINED_ICON[trigger.kind];
  return (
    <div className="flex items-center gap-2 rounded-lg border border-dashed border-border bg-card px-3 py-2.5">
      <ChainIcon weight="fill" aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="text-ui text-foreground">
        {trigger.kind === "session-ends" ? "Session ends" : "Checks pass"}
      </span>
      <span className="truncate text-ui text-muted-foreground">
        {source === undefined ? trigger.after : source.name}
      </span>
    </div>
  );
}

function Inspector({
  automation,
  automations,
  onChange,
}: {
  automation: MapAutomation | null;
  automations: MapAutomation[];
  onChange: (automation: MapAutomation) => void;
}) {
  // Nothing selected renders NOTHING, not an empty panel. The map's one claim
  // over the form is that you can see the whole set at once, and a permanent
  // 30rem placeholder would spend a third of the window denying it.
  if (automation === null) return null;

  return (
    <aside className="flex w-[30rem] min-w-0 shrink-0 flex-col gap-3 overflow-y-auto border-l border-border p-4">
      <input
        value={automation.name}
        onChange={(event) => onChange({ ...automation, name: event.target.value })}
        className="bg-transparent text-heading text-foreground outline-none placeholder:text-muted-foreground"
        placeholder="Name"
      />

      {isChained(automation.trigger) ? (
        <ChainedTriggerCard trigger={automation.trigger} automations={automations} />
      ) : (
        <TriggerCard
          trigger={automation.trigger}
          onChange={(trigger) => onChange({ ...automation, trigger })}
        />
      )}

      {automation.steps.map((step, index) => (
        <StepCard
          key={step.id}
          step={step}
          onChange={(next) =>
            onChange({
              ...automation,
              steps: automation.steps.map((item, at) => (at === index ? next : item)),
            })
          }
          onDuplicate={null}
          onRemove={null}
        />
      ))}
    </aside>
  );
}

/* ----------------------------------------------------------------- scratch */

type DragState = { id: string; pointerX: number; pointerY: number } | null;

export default function AutomationMapScratch() {
  const [chained, setChained] = React.useState(false);
  const [automations, setAutomations] = React.useState<MapAutomation[]>(V1_AUTOMATIONS);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [drag, setDrag] = React.useState<DragState>(null);
  const lanesRef = React.useRef<HTMLDivElement>(null);

  function setChainedMode(on: boolean) {
    setChained(on);
    setAutomations(on ? [...V1_AUTOMATIONS, ...CHAINED] : V1_AUTOMATIONS);
    if (!on) setSelectedId((current) => (CHAINED.some((a) => a.id === current) ? null : current));
  }

  // Lanes hold the automations that resolve to them, in the board's own column
  // order. A chained automation resolves to the lane of what it waits on, so a
  // chain renders as a stack inside one lane rather than as a walk across them.
  const lanes = TICKET_STATUSES.map((status) => ({
    status,
    automations: automations.filter((automation) => laneOf(automation, automations) === status),
  }));
  const offBoard = automations.filter((automation) => laneOf(automation, automations) === null);

  const placement: Placement = new Map();
  lanes.forEach((lane, laneIndex) => {
    lane.automations.forEach((automation, index) => {
      placement.set(automation.id, { x: laneX(laneIndex), y: nodeY(index) });
    });
  });

  const railWidth = laneX(TICKET_STATUSES.length) - LAYOUT.laneGap;
  const deepest = Math.max(...lanes.map((lane) => lane.automations.length), 1);
  const railHeight = nodeY(deepest) + LAYOUT.railPadding;

  /**
   * Which lane the pointer is over. Measured off the lane box rather than
   * computed from the rail's padding plus the gutter's width plus two margins —
   * that sum is four numbers that have to agree with the stylesheet, and the
   * element already knows where it is.
   */
  function laneAt(clientX: number): TicketStatus | null {
    const box = lanesRef.current;
    if (box === null) return null;
    const local = clientX - box.getBoundingClientRect().left;
    if (local < 0) return null;
    const index = Math.floor(local / (LAYOUT.laneWidth + LAYOUT.laneGap));
    return TICKET_STATUSES[index] ?? null;
  }

  React.useEffect(() => {
    if (drag === null) return;

    function move(event: PointerEvent) {
      setDrag((current) =>
        current === null ? null : { ...current, pointerX: event.clientX, pointerY: event.clientY },
      );
    }

    function up(event: PointerEvent) {
      const status = laneAt(event.clientX);
      const id = drag?.id;
      setDrag(null);
      if (status === null || id === undefined) return;
      setAutomations((current) =>
        current.map((automation) => {
          if (automation.id !== id) return automation;
          if (isChained(automation.trigger)) return automation;
          return { ...automation, trigger: { kind: "enters-column", columns: [status] } };
        }),
      );
    }

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [drag]);

  const dragged = drag === null ? null : (automations.find((a) => a.id === drag.id) ?? null);
  const hoveredLane = drag === null ? null : laneAt(drag.pointerX);
  const selected = automations.find((automation) => automation.id === selectedId) ?? null;

  return (
    <div className="flex h-svh flex-col bg-background text-foreground">
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2.5">
        <LightningIcon weight="fill" aria-hidden className="size-3.5 text-muted-foreground" />
        <h1 className="text-ui text-foreground">Automations</h1>
        <div className="ml-auto flex items-center gap-0.5 rounded-md border border-border p-0.5">
          {[
            { on: false, label: "Board only" },
            { on: true, label: "Board + session" },
          ].map((option) => (
            <button
              key={option.label}
              type="button"
              onClick={() => setChainedMode(option.on)}
              aria-pressed={chained === option.on}
              className={cn(
                "rounded px-2 py-0.5 text-label text-muted-foreground",
                "transition-colors duration-150 ease-out motion-reduce:transition-none",
                "hover:text-foreground aria-pressed:bg-primary/15 aria-pressed:text-primary-text",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-auto">
          <div className="flex" style={{ padding: LAYOUT.railPadding }}>
            <OffBoardGutter
              automations={offBoard}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />

            <div
              ref={lanesRef}
              className="relative ml-4"
              style={{ width: railWidth, height: railHeight }}
            >
              <EdgeLayer
                automations={automations}
                placement={placement}
                width={railWidth}
                height={railHeight}
              />

              {lanes.map((lane, laneIndex) => (
                <div
                  key={lane.status}
                  style={{ left: laneX(laneIndex), width: LAYOUT.laneWidth }}
                  className="absolute top-0 bottom-0"
                >
                  <div
                    style={{ height: LAYOUT.headerHeight }}
                    className={cn(
                      "flex items-center rounded-md px-2 text-label uppercase",
                      "transition-colors duration-150 ease-out motion-reduce:transition-none",
                      hoveredLane === lane.status
                        ? "bg-primary/15 text-primary-text"
                        : "text-muted-foreground",
                    )}
                  >
                    {TICKET_STATUS_LABELS[lane.status]}
                    <span className="ml-auto tabular-nums">{lane.automations.length || ""}</span>
                  </div>

                  {/* The lane's empty body is a drop target, and its dashed
                      edge is the only thing that says so — a lane with no
                      automations and no border reads as margin. */}
                  <div
                    className={cn(
                      "absolute inset-x-0 rounded-lg border border-dashed",
                      "transition-colors duration-150 ease-out motion-reduce:transition-none",
                      hoveredLane === lane.status ? "border-primary/50" : "border-transparent",
                    )}
                    style={{ top: LAYOUT.headerHeight + 4, bottom: 0 }}
                  />

                  {lane.automations.map((automation, index) => (
                    <div
                      key={automation.id}
                      className="absolute inset-x-0"
                      style={{ top: nodeY(index) }}
                    >
                      <MapNode
                        automation={automation}
                        selected={automation.id === selectedId}
                        dragging={drag?.id === automation.id}
                        onSelect={() => setSelectedId(automation.id)}
                        onDragStart={(event) => {
                          if (isChained(automation.trigger)) return;
                          setDrag({
                            id: automation.id,
                            pointerX: event.clientX,
                            pointerY: event.clientY,
                          });
                        }}
                      />
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>

        <Inspector
          automation={selected}
          automations={automations}
          onChange={(next) =>
            setAutomations((current) =>
              current.map((automation) => (automation.id === next.id ? next : automation)),
            )
          }
        />
      </div>

      {/* The dragged copy, fixed to the pointer and outside every scroll
          container, so it is not clipped by the rail it started in. */}
      {dragged === null || drag === null ? null : (
        <div
          className="pointer-events-none fixed z-50"
          style={{
            left: drag.pointerX - LAYOUT.laneWidth / 2,
            top: drag.pointerY - LAYOUT.nodeHeight / 2,
            width: LAYOUT.laneWidth,
          }}
        >
          <div className="rounded-lg border border-primary/60 bg-card px-2.5 py-2 shadow-lg">
            <p className="truncate text-ui text-foreground">{dragged.name}</p>
            <p className="text-label text-muted-foreground">
              {triggerSummary(dragged.trigger as Trigger)}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
