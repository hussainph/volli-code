/**
 * The automation beats (VC-127 · VC-128 · VC-132 · VC-184 · VC-241), as two
 * shots over one board so the cut between them is a jump in time, not place.
 *
 *   picker — three selected cards (multi-select, VC-184) are dragged from Todo
 *            over Doing; ⌥ grows the column's Offered list into drop targets
 *            (VC-132), "Implement" — the column's armed default — is lit, and
 *            the stack lands.
 *   armed  — the three countdown windows (VC-128: one per arrival, Cancel is
 *            the only control) drain; when they close, the three cards' rings
 *            go working, and one goes waiting (VC-241).
 *
 * Real components: `TicketCardContent` (cards + session rings),
 * `ColumnOfferedPanel`, `ArmedRunWindows` over `useArmedRunStore`, the board's
 * `Badge`. The drag itself is drawn from scene time rather than performed
 * through dnd-kit: a scripted pointer inside a 3D scene is not something
 * dnd-kit's measuring can follow, and the frames would not be deterministic.
 * Rigs: scripts/film/shots/{picker,armed}.mjs.
 */
import * as React from "react";
import { Surface } from "@webprodigies/flute";
import {
  NO_AUTOMATION_TRIGGER,
  TICKET_STATUS_LABELS,
  type Automation,
  type PendingArmedRun,
  type Ticket,
  type TicketStatus,
} from "@volli/shared";

import { ArmedRunWindows } from "@renderer/components/automations/armed-run-window";
import { useArmedRunStore } from "@renderer/components/automations/armed-run";
import { ColumnOfferedPanel } from "@renderer/components/board/column-offered-panel";
import { TicketCardContent } from "@renderer/components/board/ticket-card";
import type { TicketSessionActivity } from "@renderer/components/board/board-session-activity";
import { Badge } from "@renderer/components/ui/badge";

import { ATLAS, ATLAS_LABELS, atlasTicket } from "../kit/atlas";
import { ease, mix, progress } from "../kit/clock";
import {
  FORMAT_SIZE,
  FrameLayer,
  Supers,
  useFilm,
  useFilmWallClock,
  Vignette,
  type Cue,
  type Format,
} from "../kit/film";

// ---- layout (world px; the rigs mirror these) --------------------------------

export const BOARD = { columnWidth: 288, gap: 20, top: -300, header: 44, pitch: 118, slot: 110 };
const STATUSES: TicketStatus[] = ["todo", "doing", "needs_review"];
const WIDTH = STATUSES.length * BOARD.columnWidth + (STATUSES.length - 1) * BOARD.gap;
const columnLeft = (index: number) => index * (BOARD.columnWidth + BOARD.gap) - WIDTH / 2;

const T = (title: number, number: number, status: TicketStatus, row: number) =>
  atlasTicket(title, number, status, row);

/** The three that move, in the order they sit in the stack. */
const MOVERS: Ticket[] = [T(2, 9712, "todo", 1), T(8, 9709, "todo", 2), T(13, 9705, "todo", 3)];
const TODO: Ticket[] = [
  T(0, 9716, "todo", 0),
  ...MOVERS,
  T(20, 9701, "todo", 4),
  T(5, 9698, "todo", 5),
];
const DOING: Ticket[] = [
  T(9, 9648, "doing", 0),
  T(19, 9644, "doing", 1),
  T(14, 9640, "doing", 2),
  T(22, 9637, "doing", 3),
];
const REVIEW: Ticket[] = [
  T(4, 9593, "needs_review", 0),
  T(15, 9590, "needs_review", 1),
  T(10, 9586, "needs_review", 2),
  T(17, 9581, "needs_review", 3),
];

const NOW = 1_790_000_000_000;
const automation = (id: string, name: string, columns: TicketStatus[] | null): Automation => ({
  id,
  projectId: ATLAS.id,
  name,
  instructions: "",
  trigger: columns === null ? NO_AUTOMATION_TRIGGER : { kind: "columns", columns },
  runtime: null,
  createdAt: NOW,
  updatedAt: NOW,
});
const OFFERED: Automation[] = [
  automation("automation-implement", "Implement", ["doing"]),
  automation("automation-standards", "Standards sweep", ["doing", "needs_review"]),
  automation("automation-triage", "Triage", null),
];

// ---- pieces -------------------------------------------------------------------

function Card({
  ticket,
  selected = false,
  activity = null,
  faded = 0,
}: {
  ticket: Ticket;
  selected?: boolean;
  activity?: TicketSessionActivity | null;
  faded?: number;
}) {
  return (
    <div className="flex-none [&>*]:h-full" style={{ height: BOARD.slot, opacity: 1 - faded }}>
      <TicketCardContent
        ticket={ticket}
        ticketPrefix={ATLAS.ticketPrefix}
        projectLabels={ATLAS_LABELS}
        selected={selected}
        sessionActivity={activity}
      />
    </div>
  );
}

function Column({
  index,
  count,
  children,
  stage,
}: {
  index: number;
  count: number;
  children: React.ReactNode;
  stage: { width: number; height: number };
}) {
  const status = STATUSES[index];
  return (
    <Surface
      id={`auto-col-${index}`}
      style={{
        position: "absolute",
        left: stage.width / 2 + columnLeft(index),
        top: stage.height / 2 + BOARD.top,
        width: BOARD.columnWidth,
      }}
      content={
        <div className="flex w-72 flex-col rounded-lg bg-muted/30 px-2 pb-2">
          <div className="flex items-center gap-2 px-2 pt-2 pb-2" style={{ height: BOARD.header }}>
            <span className="text-ui font-medium text-foreground">
              {TICKET_STATUS_LABELS[status]}
            </span>
            <Badge variant="count">{count}</Badge>
          </div>
          <div className="flex flex-col gap-2">{children}</div>
        </div>
      }
    />
  );
}

// ---- picker -------------------------------------------------------------------

export const PICKER = { lift: 0, over: 820, option: 980, drop: 1760, duration: 2600 };

export function PickerShot({ format }: { format: Format }) {
  const t = useFilm();
  const stage = FORMAT_SIZE[format];
  const dropped = t >= PICKER.drop;
  useFilmWallClock(t, NOW);
  useArmedWindows(dropped ? ARMED.window - (t - PICKER.drop) : null);
  // The stack's path: from its slots in Todo to the top of Doing's list.
  const travel = progress(t, PICKER.lift, PICKER.over, (x) => ease.outCubic(x) * 0.85 + x * 0.15);
  const settle = progress(t, PICKER.over, PICKER.drop - 60, ease.inOutCubic);
  const land = progress(t, PICKER.drop - 160, PICKER.drop, ease.inCubic);
  const from = { x: columnLeft(0) + 14, y: BOARD.top + BOARD.header + BOARD.pitch - 30 };
  const over = { x: columnLeft(1) + 40, y: BOARD.top + BOARD.header + 150 };
  const rest = { x: columnLeft(1) + 30, y: BOARD.top + BOARD.header + 196 };
  const x = mix(mix(from.x, over.x, travel), rest.x, settle);
  const y = mix(mix(from.y, over.y, travel), rest.y, settle);
  const tilt = mix(-4, -2.5, travel) * (1 - land);
  const expanded = t >= PICKER.option;
  const panelIn = progress(t, PICKER.over - 360, PICKER.over - 200);
  const cues: Cue[] = [
    {
      at: 220,
      until: 2480,
      lines: ["Drop tickets in.", "Pick what runs."],
      size: "large",
      ...(format === "portrait" ? { place: "upper" as const } : {}),
    },
  ];
  return (
    <>
      <Column index={0} count={dropped ? 3 : 6} stage={stage}>
        {TODO.map((ticket) => {
          const moving = MOVERS.includes(ticket);
          if (moving && dropped) return null;
          return (
            <Card key={ticket.id} ticket={ticket} faded={moving ? 0.72 : 0} selected={moving} />
          );
        })}
      </Column>
      <Column index={1} count={dropped ? 7 : 4} stage={stage}>
        {dropped ? MOVERS.map((ticket) => <Card key={ticket.id} ticket={ticket} selected />) : null}
        {DOING.map((ticket) => (
          <Card key={ticket.id} ticket={ticket} />
        ))}
      </Column>
      <Column index={2} count={REVIEW.length} stage={stage}>
        {REVIEW.map((ticket) => (
          <Card key={ticket.id} ticket={ticket} />
        ))}
      </Column>
      {/* The Offered list floats over Doing's cards, as the board draws it. */}
      <Surface
        id="auto-offered"
        transform={{ z: 30 }}
        style={{
          position: "absolute",
          left: stage.width / 2 + columnLeft(1) + 8,
          top: stage.height / 2 + BOARD.top + BOARD.header,
          width: BOARD.columnWidth - 16,
        }}
        content={
          <div style={{ opacity: dropped ? 0 : panelIn }}>
            <ColumnOfferedPanel
              rows={OFFERED}
              expanded={expanded}
              highlighted={0}
              armedId="automation-implement"
            />
          </div>
        }
      />
      <ArmedWindowsSurface stage={stage} />
      {/* The held stack: three selected cards, lifted off the board. */}
      <Surface
        id="auto-stack"
        transform={{ z: 110 }}
        // The Surface itself travels (its box clips what it holds), in the
        // board's plane; the rig lifts it off the board in depth.
        style={{
          position: "absolute",
          left: stage.width / 2 + x,
          top: stage.height / 2 + y,
          width: BOARD.columnWidth,
        }}
        content={
          <div
            style={{
              opacity: dropped ? 0 : 1,
              transform: `rotate(${tilt}deg)`,
              transformOrigin: "20% 20%",
            }}
          >
            <div className="relative w-72" style={{ height: BOARD.slot + 14 }}>
              {[2, 1, 0].map((layer) => (
                <div
                  key={layer}
                  className="absolute inset-x-0 top-0 rounded-lg shadow-overlay"
                  style={{
                    transform: `translate(${layer * 7}px, ${layer * 7}px)`,
                    zIndex: 3 - layer,
                  }}
                >
                  <Card ticket={MOVERS[layer]} selected />
                </div>
              ))}
              <span className="absolute -top-2.5 -right-2.5 z-10 flex size-6 items-center justify-center rounded-full bg-primary text-label font-medium text-primary-foreground shadow-raised">
                3
              </span>
            </div>
          </div>
        }
      />
      <FrameLayer format={format}>
        <Vignette strength={0.5} />
        <Supers cues={cues} t={t} format={format} />
      </FrameLayer>
    </>
  );
}

// ---- armed --------------------------------------------------------------------

/** Scene time the three windows close (their `startAt`), and the ring beats. */
export const ARMED = { close: 1850, working: 1900, waiting: 2380, duration: 2800, window: 3500 };

/**
 * Seeds the three countdown windows so they read `untilClose` ms from their
 * start (or closes them when it is null). The windows read Date.now() on
 * their own frame loop; the shot pins Date.now() to the scene clock
 * (`useFilmWallClock`), so both sides agree on every frame.
 */
function useArmedWindows(untilClose: number | null) {
  React.useLayoutEffect(() => {
    if (untilClose === null || untilClose <= 0) {
      useArmedRunStore.setState({ pending: {} });
      return;
    }
    const startAt = Date.now() + untilClose;
    const pending: Record<string, PendingArmedRun> = {};
    MOVERS.forEach((ticket, index) => {
      const id = `arrival-${ticket.id}`;
      pending[id] = {
        id,
        ticketId: ticket.id,
        projectId: ATLAS.id,
        ticketDisplayId: `${ATLAS.ticketPrefix}-${ticket.ticketNumber}`,
        automationId: "automation-implement",
        automationName: "Implement",
        status: "doing",
        origin: "armed",
        // Staggered by the few ms a three-card drop takes, newest last.
        openedAt: startAt - ARMED.window + index,
        startAt: startAt + index,
      };
    });
    useArmedRunStore.setState({ pending });
  }, [untilClose]);
  React.useEffect(() => () => useArmedRunStore.setState({ pending: {} }), []);
}

/** The windows float in front of the board at the foot of Doing; `fixed`
 *  inside a Surface pins to the Surface's own box. */
function ArmedWindowsSurface({
  stage,
  settled = false,
}: {
  stage: { width: number; height: number };
  settled?: boolean;
}) {
  return (
    <Surface
      id="auto-armed"
      transform={{ z: 140 }}
      style={{
        position: "absolute",
        left: stage.width / 2 + columnLeft(1) - 60,
        top: stage.height / 2 + BOARD.top + BOARD.header + 3 * BOARD.pitch + 20,
        width: 408,
        height: 190,
      }}
      content={
        <div
          className="relative h-[190px] w-[408px]"
          // Layout containment makes this box the containing block for the
          // windows' `fixed` root, without forcing a separately rastered layer.
          style={{ contain: "layout paint" }}
          data-film-settled={settled || undefined}
        >
          <ArmedRunWindows />
        </div>
      }
    />
  );
}

export function ArmedShot({ format }: { format: Format }) {
  const t = useFilm();
  const stage = FORMAT_SIZE[format];
  useFilmWallClock(t, NOW);
  useArmedWindows(t < ARMED.close ? ARMED.close - t : null);
  const activity = (index: number): TicketSessionActivity | null => {
    if (t < ARMED.working + index * 70) return null;
    return index === 1 && t >= ARMED.waiting ? "waiting" : "working";
  };
  const cues: Cue[] = [
    {
      at: 180,
      until: 2680,
      lines: ["Save how", "work starts."],
      size: "large",
      ...(format === "portrait" ? { place: "upper" as const } : {}),
    },
  ];
  return (
    <>
      {/* Todo is off to the left of this framing: left out, so the super sits on void. */}
      <Column index={1} count={7} stage={stage}>
        {MOVERS.map((ticket, index) => (
          <Card
            key={ticket.id}
            ticket={ticket}
            selected={t < ARMED.working}
            activity={activity(index)}
          />
        ))}
        {DOING.map((ticket) => (
          <Card key={ticket.id} ticket={ticket} />
        ))}
      </Column>
      <Column index={2} count={REVIEW.length} stage={stage}>
        {REVIEW.map((ticket) => (
          <Card key={ticket.id} ticket={ticket} />
        ))}
      </Column>
      <ArmedWindowsSurface stage={stage} settled />
      <FrameLayer format={format}>
        <Vignette strength={0.5} />
        <Supers cues={cues} t={t} format={format} />
      </FrameLayer>
    </>
  );
}
