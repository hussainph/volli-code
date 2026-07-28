/**
 * Firing an Automation — the three surfaces of #86, with the prototype-gated
 * one built five ways.
 *
 * The plan is explicit that dragging is NOT the primary path (#86): the common
 * modality is ticket-centric, and a ticket open in front of you has no column to
 * drop into. So this scratch is ordered the way the feature is meant to be used
 * — In ticket first, then Arming, then the Drag picker last — and the ordering
 * is itself part of what is being judged. If the drag picker is the only tab you
 * find yourself opening, the plan's claim about the primary path is wrong.
 *
 *   • IN TICKET (#86d, #89) — one adaptive split button, reusing the shipped
 *     #45 pattern from `ticket-properties.tsx`. Three states, and the third is
 *     the interesting one: a ticket with a resumable session RESUMES rather
 *     than starting a Run, because an Automation exists to set work up and work
 *     already mid-context does not need setting up again.
 *   • ARMING (#86b, #88) — a column holds at most one armed Automation, and an
 *     unarmed column says so quietly rather than saying nothing.
 *   • DRAG (#86c) — the open question. Five variants against the plan's stated
 *     constraints: no dwell and no debounce anywhere, name AND harness legible
 *     rather than bare numbers, drop targets identical to today, and the dragged
 *     card always naming what will run. The default tab, Hybrid, replaces the
 *     ⌥-gated palette's numbering with unmodified digits (index 0 was "Move
 *     only" before; now "move only" is simply what a release without a digit
 *     does) and adds a second, sticky ⌥ overlay for reaching a column the
 *     pointer isn't near — see `use-drag-sim`'s module doc for how the two
 *     tiers are kept from touching the other four variants' own state.
 *
 * Every surface here is drawn INSIDE the chrome it will really live in — a mock
 * ticket header, a real board with real cards. A control judged on an empty page
 * is judged against a page nobody will ever see: the advance button's whole bet
 * is that "Move to Needs Review · Code review" reads at a glance while sitting
 * next to a ticket title competing for the same line, and three bare buttons on
 * white cannot test that.
 *
 * Motion is deliberately confined to APPEARANCE. Nothing in this file may delay
 * or gate a response — no dwell, no debounce, no transition standing between the
 * pointer and what it is aiming at. The transitions are property-listed rather
 * than `transition-all` for exactly that reason: a floating palette that tracks
 * the cursor must animate its opacity and never its position, or it trails the
 * hand that is steering it.
 *
 * One deviation from the house `transition-[opacity,transform]` string, and it
 * is a bug fix rather than a preference: Tailwind v4 compiles `scale-*` and
 * `translate-*` to the standalone `scale` and `translate` properties, not to
 * `transform` — which is why its own `transition-transform` expands to
 * `transform, translate, scale, rotate`. A property list naming only `transform`
 * therefore animates the opacity and snaps the scale, and the fade is
 * convincing enough that nobody notices the half that never ran. Worth checking
 * the shipped `board-column.tsx` against the same thing.
 *
 * Local state only — no stores, no bridge. Nothing here starts a session, and
 * the drop confirmation says so at the moment it would otherwise be believed.
 */
import * as React from "react";
import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowCounterClockwise";
import { ArrowRightIcon } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { LightningIcon } from "@phosphor-icons/react/dist/csr/Lightning";
import { PlayIcon } from "@phosphor-icons/react/dist/csr/Play";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import {
  TICKET_STATUS_LABELS,
  TICKET_STATUSES,
  type Ticket,
  type TicketStatus,
} from "@volli/shared";

import { Button } from "@renderer/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { cn } from "@renderer/lib/utils";

import { HarnessMark, HarnessTag } from "../automation/harness-identity";
import { SEEDED_AUTOMATIONS, type Automation } from "../automation/model";
import { useDragSim, type OverlayCell } from "../automation/use-drag-sim";
import { project, ticketById, tickets } from "../fixtures";

export const title = "Automation · trigger";
export const note = "Arming, the in-ticket advance button, and five drag pickers (#86/#89)";

/** Digits stop here: an accelerator you have to look at your hand to use is not one. */
const MAX_ACCELERATORS = 4;

/**
 * How long a drop confirmation stays before it starts leaving, and how long the
 * leaving itself takes. Short enough that a second drop never queues behind the
 * first, long enough to be read by someone whose eyes were on the card.
 *
 * Only used for a "Move only" drop now — see {@link TIMING} for the drop that
 * carries an Automation, which no longer confirms-and-forgets.
 */
const CONFIRM_HOLD_MS = 1500;
const CONFIRM_LEAVE_MS = 200;

/**
 * The arm → undo → fire → active storyboard.
 *
 * Today's drop fires an Automation the instant it lands, and that is exactly
 * the shape of bug this file's own module doc warns against: a slipped
 * mouse-down-plus-move is an OS-level accident, and it must never be able to
 * launch a paid agent on its own. So a drop that carries an Automation ARMS
 * instead of firing, and only fires once a window passes undisturbed.
 *
 *   0ms  card lands in the column, ARMED. Progress bar begins filling at the
 *        card's bottom edge. Undo is available on the card and in the column
 *        header.
 * 3500ms FIRES. Progress bar completes and leaves. The card's border begins a
 *        looping pulse in the primary theme colour — the standing signifier
 *        that this card has at least one agentic session in progress. The
 *        pulse does not stop; it means "live", not "finishing".
 *
 * `ARM_MS` is the one number that matters; `PULSE_LOOP_MS` is an independent
 * cosmetic period for the standing signifier and carries no safety meaning.
 */
const TIMING = {
  ARM_MS: 3500,
  PULSE_LOOP_MS: 2600,
} as const;

/**
 * The arm/fire visuals, in one `<style>` block rather than `globals.css` — this
 * file is lab-only and must not touch app-wide CSS. Durations are interpolated
 * from {@link TIMING} rather than restated, so the constant stays the single
 * source of truth for both the JS timer and the CSS animation it narrates.
 *
 * Two techniques, one per phase:
 *
 * - The progress bar is a plain `width` keyframe — a JS-driven per-frame width
 *   would be both janky and a second source of truth for a number that only
 *   matters once (when it hits 100%).
 * - The pulse is a rotating `conic-gradient` behind a padding+mask "ring",
 *   animated through `@property` so the angle interpolates smoothly instead of
 *   snapping between keyframes (unregistered custom properties don't tween).
 *   It reads as a highlight travelling the perimeter, not a plain opacity
 *   breath — and because it is a `::after` laid outside the card's own box
 *   (negative `inset`) rather than a real `border`, turning it on never
 *   changes the card's layout or metrics.
 *
 * `prefers-reduced-motion` turns the smooth fill into a stepped one (still a
 * CSS animation, just chunkier) and the rotating pulse into a steady ring —
 * the 3.5s safety window and the "this card is live" signifier both survive,
 * only the motion is removed.
 */
const ARM_STYLE = `
@property --lab-arm-angle {
  syntax: '<angle>';
  inherits: false;
  initial-value: 0deg;
}
@keyframes lab-arm-fill {
  from { width: 0%; }
  to { width: 100%; }
}
@keyframes lab-arm-spin {
  to { --lab-arm-angle: 360deg; }
}
.lab-arm-progress {
  animation: lab-arm-fill ${TIMING.ARM_MS}ms linear forwards;
}
.lab-arm-pulse {
  position: relative;
}
.lab-arm-pulse::after {
  content: "";
  position: absolute;
  inset: -2px;
  border-radius: inherit;
  padding: 1.5px;
  background: conic-gradient(
    from var(--lab-arm-angle),
    transparent 0deg,
    var(--primary) 70deg,
    transparent 150deg,
    transparent 360deg
  );
  -webkit-mask:
    linear-gradient(#000 0 0) content-box,
    linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
  animation: lab-arm-spin ${TIMING.PULSE_LOOP_MS}ms linear infinite;
  pointer-events: none;
}
@media (prefers-reduced-motion: reduce) {
  .lab-arm-progress {
    animation-timing-function: steps(7, jump-end);
  }
  .lab-arm-pulse::after {
    animation: none;
    background: var(--primary);
    opacity: 0.6;
  }
}
`;

/** Which automations may be offered for a column (#79's `columnScope`). */
function offeredFor(status: TicketStatus): Automation[] {
  return SEEDED_AUTOMATIONS.filter(
    (automation) => automation.columnScope === "any" || automation.columnScope.includes(status),
  );
}

/** The initial arming: one Automation per column, matching the seeded set — but see #88. */
const SEEDED_ARMING: Partial<Record<TicketStatus, string>> = {};

function automationById(id: string | undefined): Automation | null {
  return SEEDED_AUTOMATIONS.find((automation) => automation.id === id) ?? null;
}

/** `VLT-14`. Built from the project rather than stored, exactly as the app does it. */
function ticketRef(ticket: Ticket): string {
  return `${project.ticketPrefix}-${ticket.ticketNumber}`;
}

/* ------------------------------------------------------------------- fragments */

function StatusChip({ status }: { status: TicketStatus }) {
  return (
    <span className="rounded-full border border-border px-1.5 py-px text-label text-muted-foreground">
      {TICKET_STATUS_LABELS[status]}
    </span>
  );
}

/** What {@link BoardCard} renders while a dropped Automation is armed or firing — see {@link TIMING}. */
interface ArmedChrome {
  automation: Automation;
  phase: "armed" | "fired";
  onUndo: () => void;
}

/**
 * One board card, shared by the Arming and Drag tabs.
 *
 * Shared rather than duplicated because the two tabs are meant to be the SAME
 * board seen twice — if arming looks like a different product from dragging, the
 * comparison between the two trigger surfaces is measuring the mock, not the
 * design.
 */
function BoardCard({
  ticket,
  dimmed = false,
  onPointerDown,
  armed,
}: {
  ticket: Ticket;
  dimmed?: boolean;
  onPointerDown?: (event: React.PointerEvent) => void;
  armed?: ArmedChrome;
}) {
  return (
    <div
      onPointerDown={onPointerDown}
      className={cn(
        "relative rounded-lg border border-border bg-card px-2.5 py-1.5 select-none",
        onPointerDown !== undefined && "cursor-grab touch-none",
        dimmed && "opacity-40",
        // Room reserved for the progress strip so it never sits over the title.
        armed?.phase === "armed" && "pb-3",
        armed?.phase === "fired" && "lab-arm-pulse",
      )}
    >
      <p className="font-mono text-label text-muted-foreground">{ticketRef(ticket)}</p>
      <p className="line-clamp-2 text-xs text-foreground">{ticket.title}</p>

      {armed !== undefined && armed.phase === "armed" ? (
        <>
          {/* On-card undo (requirement 2, surface one): reverts the MOVE, not
              merely the automation, which is why it calls the same `onUndo`
              the column header's bulk control does. `stopPropagation` on
              pointer-down keeps this click from being read as the start of a
              new drag by the card's own `onPointerDown`. */}
          <button
            type="button"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={armed.onUndo}
            className="absolute right-1.5 top-1.5 flex items-center gap-1 rounded-full border border-border bg-popover px-1.5 py-px text-label text-muted-foreground transition-colors hover:border-ring hover:text-foreground"
          >
            <ArrowCounterClockwiseIcon weight="fill" />
            Undo
          </button>
          <span
            aria-hidden
            className="lab-arm-progress absolute inset-x-0 bottom-0 h-[3px] rounded-b-lg bg-primary"
          />
        </>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ in ticket */

type TicketState = "unarmed" | "armed" | "resumable";

const TICKET_STATE_NOTES: Record<TicketState, string> = {
  unarmed: "Target column has no armed Automation — a plain status change, exactly as today.",
  armed: "Target column is armed. The button names the move AND what will run.",
  resumable:
    "Same armed column, but this ticket has a session worth resuming — #89: resume wins, and a fresh Run stays one click away.",
};

/** The ticket the header mock is built around — Doing, so the move it offers is the real next one. */
const HEADER_TICKET = ticketById("tkt-14");

/**
 * One target column for all three states, deliberately.
 *
 * The three states differ in what is ARMED and whether a session exists; if the
 * destination moved too, the labels would differ for two reasons at once and the
 * comparison would be worthless. Needs Review is also the honest hard case: its
 * armed Automation is `Code review`, which is the longest primary label the bet
 * has to survive.
 */
const ADVANCE_TARGET: TicketStatus = "needs_review";

/**
 * The in-ticket advance control (#86d), reusing #45's shipped split-button shape
 * — primary + chevron, corners squared between them, never a second row.
 *
 * The whole design bet is in the primary's LABEL. "Move to Needs Review · Code
 * review" is one gesture that names two consequences, which is the only way a
 * single click can spend tokens without being a surprise (#20). If that label
 * stops fitting, the bet is off.
 */
function AdvanceButton({ state }: { state: TicketState }) {
  const armed = state === "unarmed" ? null : automationById("atm-review");
  const resuming = state === "resumable";

  const primaryLabel = resuming
    ? "Resume"
    : armed === null
      ? `Move to ${TICKET_STATUS_LABELS[ADVANCE_TARGET]}`
      : `Move to ${TICKET_STATUS_LABELS[ADVANCE_TARGET]} · ${armed.name}`;

  return (
    <div className="inline-flex w-fit shrink-0">
      <Button variant="outline" size="xs" className="rounded-r-none">
        {resuming ? (
          <PlayIcon weight="fill" />
        ) : armed !== null ? (
          <LightningIcon weight="fill" />
        ) : (
          <ArrowRightIcon />
        )}
        {primaryLabel}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="icon-xs"
            aria-label="More ways to advance this ticket"
            className="-ml-px rounded-l-none"
          >
            <CaretDownIcon weight="bold" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-80">
          {resuming && armed !== null ? (
            <>
              {/* The rarer intent, made cheap without making it the default. */}
              <DropdownMenuItem className="justify-between gap-6">
                <span className="flex items-center gap-2">
                  <LightningIcon weight="fill" />
                  Start a fresh Run · {armed.name}
                </span>
                <HarnessTag harnessId={armed.runtime.harnessId} className="text-xs" />
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          ) : null}
          {armed !== null ? (
            <DropdownMenuItem>
              <ArrowRightIcon />
              Move to {TICKET_STATUS_LABELS[ADVANCE_TARGET]} without running
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
          {/* "Run without moving" — the plan routes this through the session
              tab strip's new-session control; offering it here too is the
              thing to have an opinion about. */}
          <DropdownMenuLabel>Run without moving</DropdownMenuLabel>
          {offeredFor(ADVANCE_TARGET).map((automation) => (
            <DropdownMenuItem key={automation.id} className="justify-between gap-6">
              <span className="flex items-center gap-2">
                <PlayIcon weight="fill" />
                {automation.name}
              </span>
              <HarnessTag harnessId={automation.runtime.harnessId} className="text-xs" />
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/**
 * Enough ticket header to judge the control by: identity in mono, the title it
 * has to share a line with, current status, and the advance control pinned right
 * where the app puts its header actions.
 *
 * Not a faithful port of the shipped header — a mock that chases every detail
 * starts collecting review comments about the mock. It carries exactly the four
 * things that compete with the button for space and attention.
 */
function MockTicketHeader({ ticket, state }: { ticket: Ticket; state: TicketState }) {
  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <span className="font-mono text-xs text-muted-foreground">{ticketRef(ticket)}</span>
        <StatusChip status={ticket.status} />
        {ticket.labels.map((label) => (
          <span key={label} className="text-label text-muted-foreground">
            {label}
          </span>
        ))}
      </div>
      <div className="flex items-center gap-4 px-3 py-2.5">
        <h4 className="min-w-0 flex-1 truncate text-ui font-medium text-foreground">
          {ticket.title}
        </h4>
        <AdvanceButton state={state} />
      </div>
    </div>
  );
}

/**
 * Three stacked headers rather than one header with a state switcher.
 *
 * The thing under review is label LENGTH — whether the armed label still reads
 * as one phrase when the title is pushing back. Lengths are only comparable when
 * they are on screen together; a switcher makes you hold the previous label in
 * memory and compare against a remembered one, which is exactly the judgement
 * people get wrong.
 */
function InTicketTab() {
  return (
    <div className="flex flex-col gap-6">
      {(["unarmed", "armed", "resumable"] as const).map((state) => (
        <section key={state} className="flex flex-col gap-1.5">
          <h3 className="font-mono text-label uppercase text-muted-foreground">{state}</h3>
          <MockTicketHeader ticket={HEADER_TICKET} state={state} />
          <p className="max-w-prose text-xs text-muted-foreground">{TICKET_STATE_NOTES[state]}</p>
        </section>
      ))}
      <p className="max-w-prose border-t border-border pt-4 text-xs text-muted-foreground">
        Firing never navigates. The button is in the ticket header you are already looking at, and
        the session it opens appears in this ticket's own tab strip — so the one gesture that spends
        tokens never also moves you somewhere else.
      </p>
    </div>
  );
}

/* --------------------------------------------------------------------- arming */

/**
 * Column-header arming (#86b), against a populated board.
 *
 * The affordance has to carry two facts at once — that a column CAN be armed,
 * and what it is armed with — without turning the board header into a second
 * toolbar. The cards are here because that "without" is the whole test: an
 * arming control that looks calm above an empty column can still be the loudest
 * thing on a board with work in it.
 *
 * The quiet dashed hint on an unarmed column is #88's discoverability answer:
 * seeded automations are useless if nobody learns that columns fire.
 */
function ArmingTab() {
  const [arming, setArming] = React.useState<Partial<Record<TicketStatus, string>>>(SEEDED_ARMING);

  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-hidden rounded-xl border border-border bg-background">
        <div className="flex gap-2 overflow-x-auto p-2">
          {TICKET_STATUSES.map((status) => {
            const armed = automationById(arming[status]);
            const offered = offeredFor(status);
            const inColumn = tickets.filter((ticket) => ticket.status === status);

            return (
              <div key={status} className="flex w-52 shrink-0 flex-col rounded-lg bg-muted/40 p-2">
                <div className="flex items-center gap-2 px-1 pb-1.5">
                  <span className="text-ui font-medium text-foreground">
                    {TICKET_STATUS_LABELS[status]}
                  </span>
                  <span className="font-mono text-xs text-muted-foreground">{inColumn.length}</span>
                </div>

                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    {armed === null ? (
                      // Unarmed: dashed, muted, and honest about being an offer.
                      //
                      // The `key` is load-bearing, not decoration: both branches
                      // are <button>, so React reuses the DOM node and the
                      // element is never "newly added" — which is the condition
                      // @starting-style animates on. Without distinct keys,
                      // arming a column swaps its contents with no transition at
                      // all and the `starting:` classes look broken.
                      <button
                        key="unarmed"
                        type="button"
                        className="flex items-center gap-1.5 rounded-md border border-dashed border-border px-2 py-1 text-xs text-muted-foreground transition-[color,border-color,opacity,transform,translate,scale] duration-150 ease-out hover:border-solid hover:text-foreground starting:scale-[0.98] starting:opacity-0 motion-reduce:starting:scale-100"
                      >
                        <LightningIcon />
                        Arm an automation
                      </button>
                    ) : (
                      <button
                        key="armed"
                        type="button"
                        className="flex flex-col items-start gap-0.5 rounded-md border border-border bg-card px-2 py-1 text-left transition-[color,border-color,opacity,transform,translate,scale] duration-150 ease-out hover:border-ring starting:scale-[0.98] starting:opacity-0 motion-reduce:starting:scale-100"
                      >
                        <span className="flex items-center gap-1.5 text-xs text-foreground">
                          <LightningIcon weight="fill" className="text-primary" />
                          {armed.name}
                        </span>
                        <HarnessTag
                          harnessId={armed.runtime.harnessId}
                          className="pl-0.5 text-xs"
                        />
                      </button>
                    )}
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-72">
                    <DropdownMenuLabel>
                      Fires when a ticket is moved into {TICKET_STATUS_LABELS[status]}
                    </DropdownMenuLabel>
                    {offered.map((automation) => (
                      <DropdownMenuItem
                        key={automation.id}
                        onSelect={() =>
                          setArming((current) => ({ ...current, [status]: automation.id }))
                        }
                        className="justify-between gap-6"
                      >
                        <span>{automation.name}</span>
                        <HarnessTag harnessId={automation.runtime.harnessId} className="text-xs" />
                      </DropdownMenuItem>
                    ))}
                    <DropdownMenuSeparator />
                    {/* In-situ creation (#86a): authoring must never require a trip to settings. */}
                    <DropdownMenuItem>New automation for this column…</DropdownMenuItem>
                    {armed !== null ? (
                      <DropdownMenuItem
                        onSelect={() =>
                          setArming((current) => {
                            const next = { ...current };
                            delete next[status];
                            return next;
                          })
                        }
                      >
                        <XIcon />
                        Disarm
                      </DropdownMenuItem>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>

                <div className="flex flex-col gap-1.5 pt-2">
                  {inColumn.map((ticket) => (
                    <BoardCard key={ticket.id} ticket={ticket} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <p className="max-w-prose text-xs text-muted-foreground">
        At most one per column, structurally — arming is a property of the column, so two
        automations claiming one column is not a state that can be reached. Arming is not
        retroactive: it governs tickets that arrive afterwards, never the{" "}
        {tickets.filter((t) => t.status === "doing").length} already sitting in Doing.
      </p>
    </div>
  );
}

/* ----------------------------------------------------------------------- drag */

type DragVariant = "hybrid" | "held" | "always" | "card" | "column";

const DRAG_VARIANTS: { id: DragVariant; label: string; claim: string }[] = [
  {
    id: "hybrid",
    label: "Hybrid · digits + ⌥ overlay",
    claim:
      "No palette to reveal at all: 1–9 arm an automation in whichever column the pointer is already over, no modifier needed. ⌥ is reserved for the rarer case — reaching a column that's scrolled away or far from the pointer — where it opens a sticky overlay of every column × automation as a target you can hover or arrow-key to, and release commits whichever cell is lit.",
  },
  {
    id: "held",
    label: "Header palette · ⌥ held",
    claim:
      "The plan's sketched direction. The strip is out of the way until asked for, so the ordinary drop stays untaxed — but it costs a modifier mid-drag, which is the thing to actually test with your hand.",
  },
  {
    id: "always",
    label: "Header palette · always",
    claim:
      "The same strip, with the modifier removed. Tests whether ⌥ was load-bearing or merely cautious: everything is visible the whole drag, at the cost of the board shouting on every ordinary move.",
  },
  {
    id: "card",
    label: "Attached to the card",
    claim:
      "The palette rides under the dragged card, so the names are where the eye already is. Nothing to travel to — but it occludes the board exactly where you are aiming.",
  },
  {
    id: "column",
    label: "Under the hovered column",
    claim:
      "The list appears beneath the hovered column header only. Strongest spatial link between automation and destination; the weakness is that it moves every time you cross a column.",
  },
];

/** The dragged card's own label — constant across variants, because the plan requires it. */
function DragGhost({
  ticket,
  point,
  automation,
  hint,
}: {
  ticket: Ticket;
  point: { x: number; y: number };
  automation: Automation | null;
  /** The hybrid variant's discoverability line — undefined everywhere else. */
  hint?: string;
}) {
  return (
    <div
      className="pointer-events-none fixed z-[100] w-64 rotate-2 rounded-lg border border-border bg-card px-3 py-2 shadow-lg"
      style={{ left: point.x - 24, top: point.y - 18 }}
    >
      <p className="line-clamp-2 text-sm text-foreground">{ticket.title}</p>
      {/* "The dragged card always names what will run" — including when the
          answer is nothing, which is the case that stops a silent Run. */}
      <p
        className={cn(
          "flex items-center gap-1.5 pt-1 text-xs",
          automation === null ? "text-muted-foreground" : "text-primary-text",
        )}
      >
        <LightningIcon weight={automation === null ? "regular" : "fill"} />
        {automation === null ? (
          "Move only"
        ) : (
          <>
            {automation.name}
            <HarnessTag harnessId={automation.runtime.harnessId} />
          </>
        )}
      </p>
      {/* A status line, not a tooltip — quiet on purpose. Bare digits are
          otherwise invisible until someone happens to press one. */}
      {hint !== undefined ? <p className="pt-1 text-label text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/** One row of the palette, in every variant — name leads, harness follows, digit last. */
function PaletteRow({
  automation,
  index,
  chosen,
  onChoose,
}: {
  automation: Automation | null;
  index: number;
  chosen: boolean;
  onChoose: () => void;
}) {
  return (
    <button
      type="button"
      onPointerUp={onChoose}
      onPointerEnter={onChoose}
      aria-pressed={chosen}
      className={cn(
        // 100ms, not 150: this one is on the selection path, and selection
        // feedback that eases in slowly reads as a laggy click even though the
        // state changed on the same frame as the pointer event.
        "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors duration-100 ease-out",
        chosen ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {/* Two marks, two different facts: the bolt means "a Run will start", the
          harness mark means "and this is who runs it". Collapsing them into one
          glyph would lose the distinction the palette exists to make. */}
      <LightningIcon
        weight={chosen ? "fill" : "regular"}
        className={chosen ? "text-primary" : ""}
      />
      <span className="truncate">{automation === null ? "Move only" : automation.name}</span>
      <span className="ml-auto shrink-0">
        {automation === null ? null : <HarnessTag harnessId={automation.runtime.harnessId} />}
      </span>
      {index < MAX_ACCELERATORS ? (
        <kbd className="shrink-0 rounded border border-border px-1 font-mono text-[10px] text-muted-foreground">
          {index + 1}
        </kbd>
      ) : null}
    </button>
  );
}

/**
 * Hybrid tier 2: the ⌥ overlay. Every column, side by side, each offering its
 * automations plus an explicit "Move only" as large hover targets — the whole
 * point being that the pointer's real position on the board underneath stops
 * mattering, so a column scrolled out of view is exactly as reachable as the
 * one already under the cursor.
 *
 * Cells only ever get `onPointerEnter`, never a click handler: the mouse
 * button that would click is already held down driving the drag, so hover is
 * the only gesture available to the pointer here. The keyboard path (arrows +
 * digits) lives entirely in `use-drag-sim`, since it has to share one
 * `overlayCell` with this hover path rather than keeping a second copy of it.
 */
function HybridOverlay({
  overlayCell,
  setOverlayCell,
}: {
  overlayCell: OverlayCell | null;
  setOverlayCell: (cell: OverlayCell) => void;
}) {
  return (
    <div className="fixed inset-0 z-[150] flex items-center justify-center bg-background/85 p-6 backdrop-blur-sm">
      <div className="flex max-h-full flex-col gap-2">
        <p className="text-center text-xs text-muted-foreground">
          Hover, or ←/→ · ↑/↓ · 1–9, to pick a target — release to commit it, Esc to go back
        </p>
        <div className="flex gap-2 overflow-x-auto">
          {TICKET_STATUSES.map((status) => {
            const offered = offeredFor(status);
            const columnActive = overlayCell?.status === status;
            const moveOnlyChosen = columnActive && overlayCell?.index === null;

            return (
              <div
                key={status}
                className={cn(
                  "flex w-48 shrink-0 flex-col gap-px rounded-lg border border-border bg-card p-2 transition-[background-color,box-shadow] duration-150 ease-out",
                  columnActive && "border-ring ring-1 ring-ring",
                )}
              >
                <p className="px-1 pb-1 text-ui font-medium text-foreground">
                  {TICKET_STATUS_LABELS[status]}
                </p>
                {/* The explicit "move only, arm nothing" target — reachable
                    here even though the pointer isn't expressing it by simply
                    being elsewhere, which is the whole reason it has to be a
                    real row rather than an absence. */}
                <button
                  type="button"
                  onPointerEnter={() => setOverlayCell({ status, index: null })}
                  aria-pressed={moveOnlyChosen}
                  className={cn(
                    "flex items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs transition-colors duration-100 ease-out",
                    moveOnlyChosen ? "bg-accent text-foreground" : "text-muted-foreground",
                  )}
                >
                  <LightningIcon weight={moveOnlyChosen ? "fill" : "regular"} />
                  Move only
                </button>
                {offered.map((automation, index) => {
                  const chosenCell = columnActive && overlayCell?.index === index;
                  return (
                    <button
                      key={automation.id}
                      type="button"
                      onPointerEnter={() => setOverlayCell({ status, index })}
                      aria-pressed={chosenCell}
                      className={cn(
                        "flex items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs transition-colors duration-100 ease-out",
                        chosenCell ? "bg-accent text-foreground" : "text-muted-foreground",
                      )}
                    >
                      {/* The digit the hint above promises. Without it "1–9" is a
                          claim the overlay never backs up, and the mapping has to
                          be counted rather than read. */}
                      <span
                        className={cn(
                          "w-3 shrink-0 text-center font-mono text-label tabular-nums",
                          chosenCell ? "text-primary" : "text-muted-foreground/70",
                        )}
                      >
                        {index + 1}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{automation.name}</span>
                      {/* The MARK, not the full tag. Repeating "Claude Code" down
                          every row cost ~70px each and truncated the automation
                          NAME to "Imple…" — the harness is context, the name is
                          the thing being chosen, and the glyph was built to carry
                          identity without the label precisely for rows like this. */}
                      <HarnessMark
                        harnessId={automation.runtime.harnessId}
                        className="ml-auto size-3.5"
                      />
                    </button>
                  );
                })}
                {offered.length === 0 ? (
                  // A column offering nothing is still a legitimate target —
                  // it has to be reachable and say so, not just fall silent.
                  <p className="px-2 py-1 text-label text-muted-foreground">
                    No automations offered here
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** What a completed drop resolved to, captured where the pointer released it. */
interface DropConfirmation {
  /** A fresh key per drop, so dropping twice into the same column replays the entrance. */
  key: number;
  x: number;
  y: number;
  status: TicketStatus;
  automation: Automation | null;
}

/**
 * Where one ticket sits after a real (simulated) drop, and — when the drop
 * carried an Automation — where it is in the arm→fire storyboard.
 *
 * `automation: null` is a plain move: no agent to arm or fire, so it relocates
 * once and carries no `phase` chrome ever after. Only an automation-bearing
 * move goes through `"armed"` → `"fired"`, and only `"armed"` is undoable —
 * `"fired"` already happened.
 */
interface MoveEntry {
  /** The column the card returns to on Undo — not necessarily its ORIGINAL column, see `undoMove`. */
  fromStatus: TicketStatus;
  toStatus: TicketStatus;
  automation: Automation | null;
  phase: "armed" | "fired";
}

function DragTab() {
  const [variant, setVariant] = React.useState<DragVariant>("hybrid");

  // "Move only" is index 0 in every palette. Making the no-Run choice the
  // default is what keeps a drag from ever silently spending tokens — the
  // accelerator has to be pressed to opt IN.
  const optionsFor = React.useCallback(
    (status: TicketStatus | null): (Automation | null)[] =>
      status === null ? [null] : [null, ...offeredFor(status)],
    [],
  );

  // Hybrid-only: how many automations (excluding "move only") a column offers
  // — `use-drag-sim` needs this as a plain count to validate a digit and to
  // clamp ⌥-overlay navigation, without the hook having to know about
  // `Automation` objects at all.
  const automationCountFor = React.useCallback(
    (status: TicketStatus) => offeredFor(status).length,
    [],
  );

  const drag = useDragSim({
    legacyOptionCount: MAX_ACCELERATORS,
    hybrid: variant === "hybrid",
    automationCountFor,
  });

  // The truthful set: what a release RIGHT NOW would offer. Over no column that
  // is "Move only" and nothing else, which is what keeps the ghost honest when
  // the pointer wanders into the gutter.
  const options = optionsFor(drag.hovered);

  // What the ghost names as "what will run". The legacy variants read
  // `chosenIndex` (unchanged); the hybrid variant has its own two-tier
  // resolution — the ⌥ overlay's highlighted cell wins while it's open
  // (release commits THAT, not whatever the pointer is over), otherwise the
  // bare-digit selection if it's still bound to the hovered column, otherwise
  // "move only".
  let chosen: Automation | null = null;
  if (variant === "hybrid") {
    if (drag.overlayOpen && drag.overlayCell !== null) {
      const cell = drag.overlayCell;
      chosen = cell.index === null ? null : (offeredFor(cell.status)[cell.index] ?? null);
    } else if (drag.digitSelection !== null && drag.digitSelection.status === drag.hovered) {
      const selection = drag.digitSelection;
      chosen = offeredFor(selection.status)[selection.index] ?? null;
    }
  } else {
    chosen = options[drag.chosenIndex] ?? null;
  }

  // The displayed set, which lags the truthful one by exactly one column-exit.
  // A palette fading out after you leave a column would otherwise re-render as
  // the single "Move only" row on its way out — a content flicker in the corner
  // of your eye that looks like the palette changed its mind. Written during
  // render (like `use-drag-sim`'s own listener ref) because it is a cache of
  // this render's inputs, not state anything reacts to.
  const lastHovered = React.useRef<TicketStatus | null>(null);
  if (drag.hovered !== null) lastHovered.current = drag.hovered;
  const paletteOptions = optionsFor(drag.hovered ?? lastHovered.current);

  const paletteVisible =
    drag.ticketId !== null &&
    drag.hovered !== null &&
    (variant === "always" || variant === "card" || drag.modifierHeld || variant === "column");
  const draggedTicket = tickets.find((ticket) => ticket.id === drag.ticketId) ?? null;

  // Feedback belongs where the eye already is. A line at the bottom of the page
  // is a result nobody reads, because at the moment of release you are looking
  // at the column you just released over.
  const [confirmation, setConfirmation] = React.useState<DropConfirmation | null>(null);
  const [confirmationLeaving, setConfirmationLeaving] = React.useState(false);

  // The arm→fire storyboard's state, one entry per ticket that has ever moved
  // this session. A plain `Record`, not `Map`, so it composes with `setState`
  // the same way every other piece of local state here does.
  const [moves, setMoves] = React.useState<Record<string, MoveEntry>>({});
  // The one `window.setTimeout` per armed ticket, keyed so a second drop of the
  // SAME card (re-armed before it fires) replaces rather than races its timer,
  // and so Undo can cancel the fire it is pre-empting.
  const armTimers = React.useRef<Map<string, number>>(new Map());

  React.useEffect(
    () => () => {
      for (const id of armTimers.current.values()) window.clearTimeout(id);
      armTimers.current.clear();
    },
    [],
  );

  /** Where a ticket actually sits — its last simulated drop, or its fixture status if it has never moved. */
  const effectiveStatus = React.useCallback(
    (ticket: Ticket): TicketStatus => moves[ticket.id]?.toStatus ?? ticket.status,
    [moves],
  );

  const scheduleFire = React.useCallback((ticketId: string) => {
    const existing = armTimers.current.get(ticketId);
    if (existing !== undefined) window.clearTimeout(existing);
    const timeoutId = window.setTimeout(() => {
      armTimers.current.delete(ticketId);
      setMoves((current) => {
        const entry = current[ticketId];
        // Guard against a fire landing after Undo already deleted the entry,
        // or after some later re-arm replaced it.
        if (entry === undefined || entry.phase !== "armed") return current;
        return { ...current, [ticketId]: { ...entry, phase: "fired" } };
      });
    }, TIMING.ARM_MS);
    armTimers.current.set(ticketId, timeoutId);
  }, []);

  /**
   * Reverts one ticket's move by landing it at ITS ENTRY's `fromStatus` — not
   * necessarily the ticket's original fixture column. A card dropped once,
   * then re-dragged and dropped again before the first drop resolved, has a
   * `fromStatus` that is already a mid-flight column; undoing the SECOND drop
   * must land it there, not teleport it past that back to where it started
   * the whole session. When `fromStatus` and the true original agree (the
   * ordinary, single-drop case) this collapses to plain deletion.
   *
   * Mutates the draft record in place — callers always pass a fresh shallow
   * copy from inside a `setMoves` updater, never `current` itself.
   */
  const revertEntry = React.useCallback((ticketId: string, draft: Record<string, MoveEntry>) => {
    const timeoutId = armTimers.current.get(ticketId);
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
      armTimers.current.delete(ticketId);
    }
    const entry = draft[ticketId];
    if (entry === undefined) return;
    const original = tickets.find((candidate) => candidate.id === ticketId)?.status;
    if (original !== undefined && entry.fromStatus === original) {
      delete draft[ticketId];
    } else {
      draft[ticketId] = {
        fromStatus: entry.fromStatus,
        toStatus: entry.fromStatus,
        automation: null,
        phase: "fired",
      };
    }
  }, []);

  /**
   * Undo surface one (on the card): reverts the MOVE, returning the ticket to
   * where it came from — not merely cancelling the Automation and leaving the
   * card sitting in the destination column. Only reachable while `phase ===
   * "armed"`; once fired, this ticket's row disappears from the button.
   */
  const undoMove = React.useCallback(
    (ticketId: string) => {
      setMoves((current) => {
        const next = { ...current };
        revertEntry(ticketId, next);
        return next;
      });
    },
    [revertEntry],
  );

  /**
   * Undo surface two (column header): reverts EVERY still-armed card that
   * landed in this column at once — the multi-card drop case, where the
   * header is the only place a bulk revert can live. Fired cards are left
   * alone; they already ran.
   */
  const undoColumn = React.useCallback(
    (status: TicketStatus) => {
      setMoves((current) => {
        const next = { ...current };
        for (const [ticketId, entry] of Object.entries(current)) {
          if (entry.phase !== "armed" || entry.toStatus !== status) continue;
          revertEntry(ticketId, next);
        }
        return next;
      });
    },
    [revertEntry],
  );

  React.useEffect(() => {
    const drop = drag.lastDrop;
    if (drop === null) {
      // Starting a new drag clears `lastDrop`, which is also the right moment to
      // drop a confirmation still on screen: it describes the previous drag.
      setConfirmation(null);
      return;
    }
    const automation = optionsFor(drop.status)[drop.automationIndex] ?? null;
    const droppedTicket = tickets.find((candidate) => candidate.id === drop.ticketId);
    if (droppedTicket === undefined) return;

    setMoves((current) => ({
      ...current,
      [drop.ticketId]: {
        fromStatus: current[drop.ticketId]?.toStatus ?? droppedTicket.status,
        toStatus: drop.status,
        automation,
        // A plain move has nothing to arm, so it is born "fired" — that phase
        // only means "not undoable here", since `automation === null` already
        // hides every piece of arm/fire chrome on the card.
        phase: automation === null ? "fired" : "armed",
      },
    }));

    if (automation === null) {
      // Nothing to arm: relocate immediately and keep the old quick toast.
      setConfirmation({
        key: Date.now(),
        // `use-drag-sim` reports the pointer on every move and does not touch it
        // on release, so this is the release point — no need to widen the hook's
        // contract to carry a coordinate it already has.
        x: drag.point.x,
        y: drag.point.y,
        status: drop.status,
        automation: null,
      });
      setConfirmationLeaving(false);
      const fade = window.setTimeout(() => setConfirmationLeaving(true), CONFIRM_HOLD_MS);
      const clear = window.setTimeout(
        () => setConfirmation(null),
        CONFIRM_HOLD_MS + CONFIRM_LEAVE_MS,
      );
      return () => {
        window.clearTimeout(fade);
        window.clearTimeout(clear);
      };
    }

    // An Automation is riding this drop: ARM rather than fire (see TIMING).
    // The card itself narrates the rest — no toast competes with it.
    setConfirmation(null);
    scheduleFire(drop.ticketId);
    return undefined;
  }, [drag.lastDrop, drag.point, optionsFor, scheduleFire]);

  const palette = (
    <div className="flex flex-col gap-px">
      {paletteOptions.map((automation, index) => (
        <PaletteRow
          key={automation?.id ?? "none"}
          automation={automation}
          index={index}
          chosen={index === drag.chosenIndex}
          onChoose={() => drag.setChosenIndex(index)}
        />
      ))}
    </div>
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1">
        {DRAG_VARIANTS.map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => setVariant(option.id)}
            aria-pressed={option.id === variant}
            className="rounded-full px-2.5 py-0.5 text-label text-muted-foreground transition-colors hover:text-foreground aria-pressed:bg-accent aria-pressed:text-foreground"
          >
            {option.label}
          </button>
        ))}
      </div>
      <p className="max-w-prose text-xs text-muted-foreground">
        {DRAG_VARIANTS.find((option) => option.id === variant)?.claim}
      </p>

      {/* The board. Drop targets are the columns and only the columns, in every
          variant — the plan forbids the picker from adding or subdividing one. */}
      <div className="relative overflow-hidden rounded-xl border border-border bg-background">
        <div className="flex h-8 items-center gap-3 border-b border-border px-3">
          <span className="shrink-0 text-xs text-muted-foreground">Board</span>
          {/* The header strip. It is never a drop target — it is a readout that
              happens to be clickable, which is why it lives in chrome the drag
              can't land on.

              Mounted for the whole drag and merely faded, rather than mounted
              and unmounted: it lives in fixed-height chrome, so keeping it
              costs no layout, and it buys a real exit transition — releasing ⌥
              fades the strip out instead of blinking it away. */}
          {(variant === "held" || variant === "always") && drag.ticketId !== null ? (
            <div className="relative flex min-w-0 flex-1 items-center">
              <div
                className={cn(
                  "flex items-center gap-1 transition-[opacity,transform,translate,scale] duration-150 ease-out",
                  paletteVisible
                    ? "opacity-100"
                    : "pointer-events-none scale-[0.98] opacity-0 motion-reduce:scale-100",
                )}
              >
                {paletteOptions.map((automation, index) => (
                  <button
                    key={automation?.id ?? "none"}
                    type="button"
                    onPointerEnter={() => drag.setChosenIndex(index)}
                    aria-pressed={index === drag.chosenIndex}
                    className={cn(
                      "flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs transition-colors duration-100 ease-out",
                      index === drag.chosenIndex
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground",
                    )}
                  >
                    <LightningIcon weight={index === drag.chosenIndex ? "fill" : "regular"} />
                    {automation === null ? "Move only" : automation.name}
                    {automation === null ? null : (
                      <HarnessTag harnessId={automation.runtime.harnessId} />
                    )}
                    {index < MAX_ACCELERATORS ? (
                      <kbd className="rounded border border-border px-1 font-mono text-[10px]">
                        {index + 1}
                      </kbd>
                    ) : null}
                  </button>
                ))}
              </div>
              {variant === "held" ? (
                <span
                  className={cn(
                    "pointer-events-none absolute left-0 text-xs whitespace-nowrap text-muted-foreground transition-opacity duration-150 ease-out",
                    paletteVisible ? "opacity-0" : "opacity-100",
                  )}
                >
                  Hold ⌥ to choose an automation
                </span>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="flex gap-2 overflow-x-auto p-2">
          {TICKET_STATUSES.map((status) => {
            // Real count for the bulk-undo control (requirement 2, surface
            // two) — every ticket still ARMED (not yet fired) that landed in
            // THIS column, regardless of which column it came from.
            const armedInColumn = Object.values(moves).filter(
              (entry) =>
                entry.automation !== null && entry.phase === "armed" && entry.toStatus === status,
            ).length;

            return (
              <div
                key={status}
                data-lab-column={status}
                className={cn(
                  // The ring is a box-shadow, which `transition-colors` does not
                  // cover — which is why the highlight used to snap on and the
                  // background used to ease. 150ms is appearance only: the hit
                  // test that decides the drop already happened on the move
                  // event that triggered this class change.
                  "flex w-52 shrink-0 flex-col rounded-lg bg-muted/40 p-2 transition-[background-color,box-shadow] duration-150 ease-out",
                  drag.hovered === status && "bg-accent/60 ring-1 ring-ring",
                )}
              >
                <div className="flex items-center gap-2 px-1 pb-1.5">
                  <span className="text-ui font-medium text-foreground">
                    {TICKET_STATUS_LABELS[status]}
                  </span>
                  {armedInColumn > 0 ? (
                    // Shown for one armed card too, not just the bulk case:
                    // the header is a second, deliberate surface for the SAME
                    // action as the on-card Undo, so it has to stay coherent
                    // whether it is undoing one move or several — hence the
                    // singular wording rather than hiding at count 1.
                    <button
                      type="button"
                      onClick={() => undoColumn(status)}
                      className="ml-auto flex shrink-0 items-center gap-1 rounded-full px-1.5 py-px text-label text-muted-foreground transition-colors hover:text-foreground"
                    >
                      <ArrowCounterClockwiseIcon weight="fill" />
                      {armedInColumn === 1 ? "Undo move" : `Undo ${armedInColumn} moves`}
                    </button>
                  ) : null}
                </div>

                {/* Enter-only, unlike the other two variants. This palette sits in
                    the column's flow, so an exiting copy would hold the layout
                    open under a column you have already left — pushing cards
                    around the exact region you are aiming at. Instant removal is
                    the calmer of the two. */}
                {variant === "column" && paletteVisible && drag.hovered === status ? (
                  <div className="mb-1.5 rounded-md border border-border bg-popover p-1 transition-[opacity,transform,translate,scale] duration-150 ease-out starting:scale-[0.98] starting:opacity-0 motion-reduce:starting:scale-100">
                    {palette}
                  </div>
                ) : null}

                {/* Hybrid tier 1's legend — read-only, digits are keyboard-only.
                    Shown for the hovered column only, so re-entering a
                    different column visibly swaps the list (and the reset
                    the module doc promises) rather than silently carrying a
                    stale selection over. */}
                {variant === "hybrid" &&
                !drag.overlayOpen &&
                drag.hovered === status &&
                drag.ticketId !== null ? (
                  <div className="mb-1.5 flex flex-col gap-px rounded-md border border-border bg-popover p-1">
                    <p className="flex items-center gap-1.5 px-1 py-0.5 text-xs text-muted-foreground">
                      <LightningIcon />
                      Move only
                      <span className="ml-auto text-label">default</span>
                    </p>
                    {offeredFor(status).map((automation, index) => {
                      const isChosen =
                        drag.digitSelection !== null &&
                        drag.digitSelection.status === status &&
                        drag.digitSelection.index === index;
                      return (
                        <p
                          key={automation.id}
                          className={cn(
                            "flex items-center gap-1.5 rounded px-1 py-0.5 text-xs",
                            isChosen ? "bg-accent text-foreground" : "text-muted-foreground",
                          )}
                        >
                          <LightningIcon
                            weight={isChosen ? "fill" : "regular"}
                            className={isChosen ? "text-primary" : ""}
                          />
                          <span className="truncate">{automation.name}</span>
                          <span className="ml-auto shrink-0">
                            <HarnessTag
                              harnessId={automation.runtime.harnessId}
                              className="text-xs"
                            />
                          </span>
                          <kbd className="shrink-0 rounded border border-border px-1 font-mono text-[10px] text-muted-foreground">
                            {index + 1}
                          </kbd>
                        </p>
                      );
                    })}
                  </div>
                ) : null}

                <div className="flex flex-col gap-1.5">
                  {tickets
                    .filter((ticket) => effectiveStatus(ticket) === status)
                    .map((ticket) => {
                      const move = moves[ticket.id];
                      const armedChrome: ArmedChrome | undefined =
                        move !== undefined && move.automation !== null
                          ? {
                              automation: move.automation,
                              phase: move.phase,
                              onUndo: () => undoMove(ticket.id),
                            }
                          : undefined;
                      return (
                        <BoardCard
                          key={ticket.id}
                          ticket={ticket}
                          dimmed={drag.ticketId === ticket.id}
                          onPointerDown={drag.start(ticket.id)}
                          armed={armedChrome}
                        />
                      );
                    })}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        {variant === "hybrid"
          ? "Drag a card. 1–9 (no modifier) arms an automation in whichever column the pointer is over; the same digit again clears it. ⌥ opens an overlay of every column × automation to hover or arrow-key through — release commits its highlighted cell. Esc closes the overlay first, then cancels the drag."
          : `Drag a card. ⌥ reveals the palette in the ⌥-held variant; 1–${MAX_ACCELERATORS} pick; Esc cancels.`}{" "}
        Dropping a card that names an Automation ARMS it for {(TIMING.ARM_MS / 1000).toFixed(1)}s
        before it fires — Undo on the card or "Undo moves" in the column header reverts the move
        itself. Once fired, the pulsing border means a session is (simulated as) running; the lab
        still starts nothing for real.
      </p>

      {confirmation !== null ? (
        <div
          key={confirmation.key}
          className={cn(
            // Centred on the release point and lifted clear of it, so it reads
            // as "this landed here" rather than as a notification that happens
            // to be nearby. The x-translate is the centring; the y-axis is left
            // free for the animation to use.
            "pointer-events-none fixed z-[110] w-64 -translate-x-1/2 rounded-lg border border-border bg-popover px-3 py-2 shadow-lg",
            "transition-[opacity,transform,translate,scale] duration-200 ease-out starting:translate-y-1 starting:opacity-0 motion-reduce:starting:translate-y-0",
            confirmationLeaving && "-translate-y-1 opacity-0 motion-reduce:transition-none",
          )}
          style={{ left: confirmation.x, top: confirmation.y - 56 }}
        >
          {/* Wraps rather than truncates, and the harness tag is what falls to a
              second line when it must. An earlier version truncated this row,
              which ate the AUTOMATION NAME — the one fact the confirmation
              exists to deliver. Nothing here may be elided; two lines is fine. */}
          <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-foreground">
            <LightningIcon
              weight={confirmation.automation === null ? "regular" : "fill"}
              className={
                confirmation.automation === null ? "text-muted-foreground" : "text-primary"
              }
            />
            <span>
              Moved to {TICKET_STATUS_LABELS[confirmation.status]}
              {confirmation.automation === null ? "" : ` · ${confirmation.automation.name}`}
            </span>
            {confirmation.automation === null ? null : (
              <HarnessTag harnessId={confirmation.automation.runtime.harnessId} />
            )}
          </p>
          {/* The confirmation is the only thing standing between this prototype
              and someone believing a Run started. It says so every time. */}
          <p className="pt-0.5 text-label text-muted-foreground">
            Nothing started — the lab has no sessions.
          </p>
        </div>
      ) : null}

      {drag.ticketId !== null && draggedTicket !== null ? (
        <>
          <DragGhost
            ticket={draggedTicket}
            point={drag.point}
            automation={chosen}
            hint={variant === "hybrid" ? "1–9 to arm · ⌥ for all columns" : undefined}
          />
          {variant === "card" ? (
            // Only opacity and transform are transitioned. `left`/`top` update
            // every pointer move and must stay untransitioned, or the palette
            // trails the hand steering it — the one place where "add some
            // motion" would have become a delay.
            <div
              className={cn(
                "fixed z-[101] w-64 rounded-md border border-border bg-popover p-1 shadow-lg transition-[opacity,transform,translate,scale] duration-150 ease-out",
                paletteVisible
                  ? "pointer-events-auto opacity-100"
                  : "pointer-events-none scale-[0.98] opacity-0 motion-reduce:scale-100",
              )}
              style={{ left: drag.point.x - 24, top: drag.point.y + 44 }}
            >
              {palette}
            </div>
          ) : null}
        </>
      ) : null}

      {/* Tier 2, mounted only while it's open — see `HybridOverlay`'s own doc
          for why hover here never needs a click. */}
      {variant === "hybrid" && drag.overlayOpen ? (
        <HybridOverlay overlayCell={drag.overlayCell} setOverlayCell={drag.setOverlayCell} />
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------- scratch */

const TABS = [
  { id: "ticket", label: "In ticket", render: () => <InTicketTab /> },
  { id: "arming", label: "Arming", render: () => <ArmingTab /> },
  { id: "drag", label: "Drag picker", render: () => <DragTab /> },
] as const;

export default function AutomationTriggerScratch() {
  const [tab, setTab] = React.useState<(typeof TABS)[number]["id"]>("ticket");

  return (
    <div className="flex flex-col gap-4">
      {/* Keyframes and `@property` for the arm→fire storyboard, tied to TIMING so
          the CSS can never drift from the timer that drives it.

          This lives at the SCRATCH root, not inside a tab. It was originally
          nested in the drag-picker section, which meant the Arming tab rendered
          armed cards carrying `.lab-arm-progress` and `.lab-arm-pulse` with no
          keyframes defined anywhere in the document — the bar sat empty and the
          ring never turned. Both tabs share `BoardCard`, so anything it needs
          has to be mounted for as long as any tab that uses it. */}
      <style>{ARM_STYLE}</style>
      <div className="flex items-center gap-1">
        {TABS.map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => setTab(option.id)}
            aria-pressed={option.id === tab}
            className="rounded-full px-3 py-1 text-ui text-muted-foreground transition-colors hover:text-foreground aria-pressed:bg-accent aria-pressed:text-foreground"
          >
            {option.label}
          </button>
        ))}
      </div>
      {TABS.find((option) => option.id === tab)?.render()}
    </div>
  );
}
