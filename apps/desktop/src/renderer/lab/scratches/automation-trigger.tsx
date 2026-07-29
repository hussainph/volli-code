/**
 * Firing an Automation — the three surfaces of #86.
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
 *   • COLUMN DEFAULTS (#86b, #88) — a column holds at most one default
 *     Automation, set from the bolt in its corner.
 *   • DRAG (#86c) — a plain drop has NO palette at all: it runs whichever
 *     Automation the target COLUMN has as its default (the same concept
 *     `ArmingTab` models — this tab shares its `arming` state with it), and a
 *     column without one is a perfectly good target that says so quietly
 *     rather than running nothing silently. Bare digits `1`–`9`, scoped to whichever
 *     column the pointer is over, still override that default — the same
 *     digit twice clears back to it. Holding ⌥ GROWS that column's list into
 *     large landing targets in place; letting go shrinks it back. The card
 *     tracks the cursor the whole way and never stops, but it SHRINKS to a
 *     one-line badge over a column, because the payload and the menu cannot
 *     both own the same square inch and the payload is not the thing being
 *     read. See {@link DragGhost} for the two attempts that came before it.
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
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@renderer/components/ui/tooltip";
import { cn } from "@renderer/lib/utils";

import { HarnessMark, HarnessTag, HarnessTrail } from "../automation/harness-identity";
import {
  harnessTrail,
  SEEDED_AUTOMATIONS,
  triggerColumns,
  type Automation,
} from "../automation/model";
import { useDragSim, type AutomationTarget } from "../automation/use-drag-sim";
import { project, ticketById, tickets } from "../fixtures";

export const title = "Automation · trigger";
export const note = "Column defaults, the in-ticket advance button, and the drag picker (#86/#89)";

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

/** Which automations may be offered for a column — the trigger's own columns. */
function offeredFor(status: TicketStatus): Automation[] {
  return SEEDED_AUTOMATIONS.filter((automation) => {
    const columns = triggerColumns(automation.trigger);
    return columns === "any" || columns.includes(status);
  });
}

/**
 * Which agent(s) an Automation would start.
 *
 * One harness names itself. Two or more only fit as marks — and this component
 * exists because multi-step automations broke an assumption all three of these
 * surfaces were making: each of them rendered ONE harness and silently dropped
 * every step after the first. Naming that here rather than at six call sites is
 * also how the next surface to grow this problem gets it right for free.
 */
function AutomationHarness({
  automation,
  className,
}: {
  automation: Automation;
  className?: string;
}) {
  const trail = harnessTrail(automation);
  if (trail.length === 1) return <HarnessTag harnessId={trail[0]} className={className} />;
  return <HarnessTrail harnessIds={trail} className={className} />;
}

/**
 * The initial arming for THIS LAB ONLY — three columns pre-armed so the drag
 * picker (Change 1) has something to demonstrate the moment the tab opens.
 * The real product ships every seeded Automation UNARMED: seeded-and-armed
 * would spend tokens on someone's very first drag, which is exactly the
 * surprise the automation-only-de-escalates rule (#20) exists to prevent.
 *
 * Shared between the Arming and Drag tabs (lifted to `AutomationTriggerScratch`)
 * so dropping a card in the Drag tab and re-arming a column from the Arming tab
 * are provably the same piece of state, not two mocks that happen to agree.
 */
const LAB_PREARMED_ARMING: Partial<Record<TicketStatus, string>> = {
  todo: "atm-grill",
  doing: "atm-implement",
  needs_review: "atm-review",
};

function automationById(id: string | undefined): Automation | null {
  return SEEDED_AUTOMATIONS.find((automation) => automation.id === id) ?? null;
}

/**
 * What actually fires for `status`, given the column's own arming and any
 * override chosen this drag. `overrideIndex` is the hook's own tri-state:
 * `undefined` (nothing overrode the default), `null` (explicit "Move only"),
 * or an index into `offeredFor(status)`. This is the one place that tri-state
 * turns into a real `Automation | null` — the hook itself never needs to know
 * what an Automation is.
 */
function resolveAutomation(
  status: TicketStatus,
  arming: Partial<Record<TicketStatus, string>>,
  overrideIndex: number | null | undefined,
): Automation | null {
  if (overrideIndex === undefined) return automationById(arming[status]);
  if (overrideIndex === null) return null;
  return offeredFor(status)[overrideIndex] ?? null;
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
  /** Keep the move, cancel the run. */
  onCancelRun: () => void;
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
          {/* Two outcomes, because there are two mistakes. "Undo" reverts the
              MOVE — the same thing the column header's bulk control does, hence
              the shared `onUndo`. "Don't run" keeps the move and cancels only
              the run, which is the one you want when the column's default fired
              on a move you did mean to make.

              In flow at the bottom, NOT floated over the corner. Two pills need
              168px of a 192px card, which left the ticket ref reading "VLT-" —
              and the ref is the identity, the one thing on a card that may
              never be occluded. A row that briefly makes the card taller costs
              3.5s of layout; a covered ref costs you knowing which ticket you
              are about to cancel.

              `stopPropagation` on pointer-down keeps either click from being
              read as the start of a new drag by the card's own handler. */}
          <div className="mt-1.5 flex items-center justify-end gap-1">
            <button
              type="button"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={armed.onCancelRun}
              className="flex items-center gap-1 rounded-full border border-border bg-popover px-1.5 py-px text-label text-muted-foreground transition-colors hover:border-ring hover:text-foreground"
            >
              <XIcon weight="bold" />
              Don&rsquo;t run
            </button>
            <button
              type="button"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={armed.onUndo}
              className="flex items-center gap-1 rounded-full border border-border bg-popover px-1.5 py-px text-label text-muted-foreground transition-colors hover:border-ring hover:text-foreground"
            >
              <ArrowCounterClockwiseIcon weight="fill" />
              Undo
            </button>
          </div>
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

/**
 * Names the three specimens below. These are exhibit labels, not copy — they
 * distinguish three otherwise near-identical mocks, and they replaced a caption
 * under each one that said the same thing in a sentence.
 */
const TICKET_STATE_LABELS: Record<TicketState, string> = {
  unarmed: "No column default",
  armed: "Column default",
  resumable: "Session to resume",
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
            aria-label="More options"
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
                <AutomationHarness automation={armed} className="text-xs" />
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          ) : null}
          {armed !== null ? (
            <DropdownMenuItem>
              <ArrowRightIcon weight="fill" />
              Move without running
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
              <AutomationHarness automation={automation} className="text-xs" />
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
          <h3 className="font-mono text-label uppercase text-muted-foreground">
            {TICKET_STATE_LABELS[state]}
          </h3>
          <MockTicketHeader ticket={HEADER_TICKET} state={state} />
        </section>
      ))}
    </div>
  );
}

/* --------------------------------------------------------------------- arming */

/**
 * The column-header arm control (#86b) — one component, used identically in the
 * Arming and Drag tabs.
 *
 * Change 1's whole premise is "the column header already says what it runs, so
 * the drag no longer re-asks" — a premise that only holds if the control that
 * says it is the SAME control in both places. If the Drag tab grew its own
 * lookalike, the two tabs would be testing different products again, exactly
 * the thing `BoardCard` already exists to prevent one level down.
 */
/**
 * Choosing a column's default Automation — a lightning bolt in the column's
 * top-right corner, and nothing else.
 *
 * This replaced a small card sitting under the column header that named the
 * chosen Automation and its harness. Two things were wrong with it. It read as
 * a piece of CONTENT — a card, in a column full of cards, that was not a ticket
 * — and it spent two lines of vertical space, permanently, on a fact that
 * matters at exactly two moments: when you set it, and when you are dragging
 * something into the column. The second moment now has its own answer (the
 * hovered column lists what it can run), so at rest a single icon carries it.
 *
 * ── ON THE WORD "ARM" ─────────────────────────────────────────────────────
 * The plan calls this arming, and every label here used to say so. Nobody talks
 * like that: it is writing code, not loading a weapon. The domain word is now
 * DEFAULT — a column has a default Automation, you select it, you clear it. The
 * internal identifiers below still say `arm` in places; those are follow-on
 * renames, not user-visible copy, and none of them reach a screen.
 * ──────────────────────────────────────────────────────────────────────────
 */
function ColumnDefaultControl({
  status,
  armed,
  offered,
  onArm,
  onDisarm,
}: {
  status: TicketStatus;
  armed: Automation | null;
  offered: Automation[];
  onArm: (automationId: string) => void;
  onDisarm: () => void;
}) {
  const chosen = armed !== null;
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={
                chosen ? `Default automation: ${armed.name}` : "Select default automation"
              }
              className={cn(
                "ml-auto flex size-5 shrink-0 items-center justify-center rounded-md transition-colors duration-150 ease-out",
                chosen
                  ? "text-primary hover:bg-accent"
                  : "text-muted-foreground/50 hover:bg-accent hover:text-foreground",
              )}
            >
              <LightningIcon weight={chosen ? "fill" : "regular"} />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        {/* The tooltip is the only place the chosen Automation is named at
            rest, so when one IS chosen it must name it rather than repeat the
            verb — "Select default automation" over a column that already has
            one tells you nothing you can act on. */}
        <TooltipContent side="top">
          {chosen ? (
            <span className="flex items-center gap-1.5">
              Default: {armed.name}
              <HarnessTrail harnessIds={harnessTrail(armed)} />
            </span>
          ) : (
            "Select default automation"
          )}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>Default for {TICKET_STATUS_LABELS[status]}</DropdownMenuLabel>
        {offered.map((automation) => (
          <DropdownMenuItem
            key={automation.id}
            onSelect={() => onArm(automation.id)}
            className="justify-between gap-6"
          >
            <span className="flex items-center gap-1.5">
              {armed?.id === automation.id ? (
                <LightningIcon weight="fill" className="text-primary" />
              ) : null}
              {automation.name}
            </span>
            <AutomationHarness automation={automation} className="text-xs" />
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        {/* In-situ creation (#86a): authoring must never require a trip to settings. */}
        <DropdownMenuItem>
          <PlusIcon weight="fill" />
          New automation…
        </DropdownMenuItem>
        {chosen ? (
          <DropdownMenuItem onSelect={onDisarm}>
            <XIcon weight="fill" />
            Clear default
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

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
function ArmingTab({
  arming,
  onArm,
  onDisarm,
}: {
  arming: Partial<Record<TicketStatus, string>>;
  onArm: (status: TicketStatus, automationId: string) => void;
  onDisarm: (status: TicketStatus) => void;
}) {
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
                  <ColumnDefaultControl
                    status={status}
                    armed={armed}
                    offered={offered}
                    onArm={(id) => onArm(status, id)}
                    onDisarm={() => onDisarm(status)}
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  {inColumn.map((ticket) => (
                    <BoardCard key={ticket.id} ticket={ticket} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------- drag */

/** Every field a Move summary needs to read as a real statement of what a drop will do — never blank, even when nothing will run. */
function MoveSummary({
  origin,
  destination,
  automation,
  compact = false,
}: {
  origin: TicketStatus;
  destination: TicketStatus | null;
  automation: Automation | null;
  compact?: boolean;
}) {
  return (
    <p
      className={cn(
        "flex flex-wrap items-center gap-x-1.5 gap-y-0.5",
        compact ? "text-label" : "text-xs",
      )}
    >
      <span className="text-muted-foreground">{TICKET_STATUS_LABELS[origin]}</span>
      <ArrowRightIcon className="shrink-0 text-muted-foreground" />
      {destination === null ? (
        <span className="text-muted-foreground">…</span>
      ) : (
        <span className="font-medium text-foreground">{TICKET_STATUS_LABELS[destination]}</span>
      )}
      <span
        className={cn(
          "flex items-center gap-1",
          automation === null ? "text-muted-foreground" : "text-primary-text",
        )}
      >
        <LightningIcon weight={automation === null ? "regular" : "fill"} />
        {automation === null ? "No automation" : automation.name}
        {automation !== null ? <HarnessTrail harnessIds={harnessTrail(automation)} /> : null}
      </span>
    </p>
  );
}

/**
 * The dragged card's own label. Always names the ticket by REF first — never
 * truncated, per the owner's note that the ref is the identity and the title is
 * the only part allowed to give way — and the move it is about to make, via
 * {@link MoveSummary}, so the summary reads as a real statement even when
 * nothing will run.
 *
 * ── THE TWO SIZES, AND WHY ────────────────────────────────────────────────
 * A drag has two halves and they want opposite things. Nearly everywhere there
 * is nothing underneath worth reading, and the card should be a card: full
 * width, tilted, the title legible, obviously the object you picked up. Standing
 * ON the automation panel is the exception — there a list is asking to be read,
 * and 256×123 of opaque card is the single worst thing that could be sitting on
 * top of it.
 *
 * The trigger is the PANEL, not the column. Anywhere else inside a column there
 * is nothing but the column's own cards underneath, which are not targets and
 * not being read, so the card has no reason to give anything up.
 *
 * Both attempts to fix that by moving something failed. Parking the card in the
 * column header took the drag away from the hand. Sliding the list in front of
 * the card kept the drag but buried the ticket. Neither is a real fix, because
 * the two are competing for one square inch of screen and only one of them can
 * have it.
 *
 * So the CARD gives way, and it gives way by shrinking rather than by moving:
 * over a column it becomes one line — ref, the move, what will run — hung off
 * the cursor like a drag badge. It still tracks the pointer exactly, so nothing
 * is taken away; it just stops being the biggest thing on screen at the exact
 * moment it stops being the thing you are reading. This is what every drag that
 * has ever had to cross a menu does: Figma drops to a line, Trello to a
 * placeholder, Finder to a badge. The payload goes quiet over the target.
 *
 * The title is what the compact form drops, because the ref is the identity —
 * the one thing that may never be elided — and the title is the only part
 * allowed to give way.
 * ──────────────────────────────────────────────────────────────────────────
 */
function DragGhost({
  ticket,
  origin,
  destination,
  point,
  automation,
  onList,
}: {
  ticket: Ticket;
  origin: TicketStatus;
  destination: TicketStatus | null;
  point: { x: number; y: number };
  automation: Automation | null;
  /** Pointer is standing on the automation panel — the only place the card is in the way. */
  onList: boolean;
}) {
  // One line, and ABOVE the panel rather than behind it. Small enough now that
  // being on top costs the list a sliver of one row, where the full card cost
  // it the whole panel.
  if (onList) {
    return (
      <div
        className="pointer-events-none fixed z-[160] flex w-fit max-w-72 items-center gap-2 rounded-md border border-border bg-card py-1 pr-2 pl-2.5 shadow-lg"
        // Hung down-and-right off the pointer, the way a drag badge is: the
        // cursor tip stays clear, and everything above and left of the hand —
        // which is where the rows you are choosing between live — stays visible.
        style={{ left: point.x + 14, top: point.y + 14 }}
      >
        <span className="shrink-0 font-mono text-label text-muted-foreground">
          {ticketRef(ticket)}
        </span>
        <MoveSummary origin={origin} destination={destination} automation={automation} compact />
      </div>
    );
  }
  return (
    <div
      className="pointer-events-none fixed z-[100] w-64 rotate-2 rounded-lg border border-border bg-card px-3 py-2 shadow-lg"
      style={{ left: point.x - 24, top: point.y - 18 }}
    >
      <p className="font-mono text-label text-muted-foreground">{ticketRef(ticket)}</p>
      <p className="line-clamp-2 text-sm text-foreground">{ticket.title}</p>
      <div className="pt-1">
        <MoveSummary origin={origin} destination={destination} automation={automation} />
      </div>
    </div>
  );
}

/**
 * What a column can run, shown inside the column itself — compact while you are
 * merely over it, grown into real landing targets while ⌥ is held.
 *
 * The two states are the same rows at two sizes rather than two components, so
 * ⌥ reads as the list GROWING rather than as one control being swapped for
 * another. That distinction is the whole reason the digits stay meaningful:
 * `2` picks the same thing whether or not the row is currently big enough to
 * drop onto.
 *
 * Collapsed rows are deliberately NOT pointer targets. They are ~22px, which is
 * the needle-in-a-haystack size that made the previous design bad to aim at, and
 * offering them as targets anyway would be inviting the miss. Collapsed, the
 * keyboard drives; expanded, the pointer does.
 */
function ColumnAutomationList({
  status,
  cell,
  setCell,
  arming,
  digitSelection,
  expanded,
}: {
  status: TicketStatus;
  cell: AutomationTarget | null;
  setCell: (cell: AutomationTarget) => void;
  arming: Partial<Record<TicketStatus, string>>;
  digitSelection: AutomationTarget | null;
  expanded: boolean;
}) {
  const offered = offeredFor(status);
  const armed = automationById(arming[status]);

  if (offered.length === 0) {
    return (
      /* Not helper text: with no rows there is nothing on screen at all, and a
         blank panel would read as a list that failed to load. */
      <p className="mb-2 rounded-md border border-dashed border-border px-2 py-1.5 text-label text-muted-foreground">
        Nothing to run here
      </p>
    );
  }

  /**
   * Which row is lit. While ⌥ is open the picker cell owns it; otherwise it is
   * whatever the digits chose, and failing that the column's own default —
   * because a plain release runs the default, so the default is what is
   * currently "selected" whether or not anyone touched a key.
   */
  const activeIndex =
    expanded && cell !== null
      ? cell.index
      : digitSelection !== null && digitSelection.status === status
        ? digitSelection.index
        : offered.findIndex((automation) => automation.id === armed?.id) === -1
          ? null
          : offered.findIndex((automation) => automation.id === armed?.id);

  return (
    <div
      // Hit-tested by `useDragSim` so the dragged card knows when it is standing
      // on the panel specifically. Must stay on the container, not the rows:
      // collapsed rows are `pointer-events-none`, so the container is what the
      // hit test actually lands on.
      data-lab-automation-list
      className={cn(
        // A real panel, not a bare stack of rows: it sits on top of the column's
        // own cards, so it needs its own surface to be read against. The
        // dragged card no longer competes with it — see {@link DragGhost},
        // which shrinks to a one-line badge the moment it is over a column.
        "relative z-[130] mb-2 flex flex-col rounded-lg border border-border bg-popover shadow-md",
        "transition-[gap,padding] duration-150 ease-out",
        expanded ? "gap-1.5 p-1.5" : "gap-px p-1",
      )}
    >
      {offered.map((automation, index) => {
        const chosen = activeIndex === index;
        return (
          <button
            key={automation.id}
            type="button"
            // Only a grown row accepts the pointer. See the component doc.
            //
            // `pointermove`, NOT `pointerenter`: the column grows UNDER a
            // stationary cursor, so whichever row happens to land beneath the
            // pointer fires `pointerenter` immediately and steals the
            // selection — the user never moved, the interface moved. That
            // silently replaced the column's default with "Move only" roughly
            // every time, which is the one substitution this whole layer exists
            // to prevent. `pointermove` fires only on real movement, so the
            // preselected choice survives until a hand actually changes it.
            onPointerMove={
              expanded
                ? () => {
                    if (cell?.index !== index) setCell({ status, index });
                  }
                : undefined
            }
            tabIndex={-1}
            aria-pressed={chosen}
            className={cn(
              "flex items-center gap-2 rounded-md border border-transparent text-left transition-[background-color,border-color,color,padding] duration-150 ease-out",
              expanded ? "px-2.5 py-2 text-xs" : "px-1.5 py-0.5 text-label",
              expanded ? "" : "pointer-events-none",
              chosen
                ? expanded
                  ? "border-ring bg-accent text-foreground"
                  : "text-foreground"
                : "text-muted-foreground",
            )}
          >
            <kbd
              className={cn(
                "shrink-0 rounded border font-mono",
                chosen ? "border-primary text-primary" : "border-border text-muted-foreground",
                "px-1 text-label",
              )}
            >
              {index + 1}
            </kbd>
            <span className={cn("min-w-0 flex-1 truncate", expanded && "font-medium")}>
              {automation.name}
            </span>
            {/* Expanded only. Collapsed, the lit row already says what a plain
                release runs, and the word cost "Grill the ticket" its last four
                characters. Expanded it earns its width: a digit can move the
                highlight off the default, and then the two facts differ. */}
            {expanded && armed?.id === automation.id ? (
              <span className="shrink-0 text-label text-primary">default</span>
            ) : null}
            {/* Marks, never the full `HarnessTag`, at either size. Spelling out
                "Claude Code" on every row cost the NAME its width — the one
                thing being chosen truncated to "Impleme…" so the harness could
                be written out three times identically. A multi-step automation
                gets one mark per harness, which is also the only warning on this
                surface that a single release is about to start two sessions. */}
            <span className="flex shrink-0 items-center gap-0.5">
              {harnessTrail(automation).map((harnessId) => (
                <HarnessMark
                  key={harnessId}
                  harnessId={harnessId}
                  className={expanded ? "size-3.5" : undefined}
                />
              ))}
            </span>
          </button>
        );
      })}
      <button
        type="button"
        onPointerMove={
          expanded
            ? () => {
                if (cell?.index !== null) setCell({ status, index: null });
              }
            : undefined
        }
        tabIndex={-1}
        aria-pressed={activeIndex === null}
        className={cn(
          "flex items-center gap-2 rounded-md border text-left transition-[background-color,border-color,color,padding] duration-150 ease-out",
          expanded ? "px-2.5 py-2 text-xs" : "pointer-events-none px-1.5 py-0.5 text-label",
          activeIndex === null
            ? "border-solid border-ring bg-accent text-foreground"
            : "border-dashed border-border text-muted-foreground",
        )}
      >
        {/* Carries a digit like every other row, because it IS one: `0`, the
            key that runs nothing. Without it this row was reachable only by
            opening the ⌥ picker and aiming at it, which made "move the ticket
            and start nothing" the most expensive gesture on the board. */}
        <kbd
          className={cn(
            "shrink-0 rounded border font-mono",
            activeIndex === null ? "border-primary text-primary" : "border-border",
            "px-1 text-label",
          )}
        >
          0
        </kbd>
        Move only
      </button>
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

function DragTab({
  arming,
  onArm,
  onDisarm,
}: {
  arming: Partial<Record<TicketStatus, string>>;
  onArm: (status: TicketStatus, automationId: string) => void;
  onDisarm: (status: TicketStatus) => void;
}) {
  const automationCountFor = React.useCallback(
    (status: TicketStatus) => offeredFor(status).length,
    [],
  );

  /**
   * Where a column's default sits in its own offered list — the hook deals only
   * in indices, and `arming` lives here. Returns null when the column has no
   * default, which is also "Move only", and correctly so: with no default, a
   * plain release and an immediately-released picker both run nothing.
   */
  const defaultIndexFor = React.useCallback(
    (status: TicketStatus) => {
      const defaultId = arming[status];
      if (defaultId === undefined) return null;
      const index = offeredFor(status).findIndex((automation) => automation.id === defaultId);
      return index === -1 ? null : index;
    },
    [arming],
  );

  const drag = useDragSim({ automationCountFor, defaultIndexFor });

  const draggedTicket = tickets.find((ticket) => ticket.id === drag.ticketId) ?? null;

  // The baseline layer's resolved automation — what a release RIGHT NOW would
  // arm, over whichever column the pointer is actually over. `null` when the
  // pointer is over the gutter, matching the ghost's own honesty about that.
  const chosen: Automation | null =
    drag.hovered === null
      ? null
      : resolveAutomation(
          drag.hovered,
          arming,
          drag.digitSelection !== null && drag.digitSelection.status === drag.hovered
            ? drag.digitSelection.index
            : undefined,
        );

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
   * The other half of the escape hatch, for the drop you have already made.
   *
   * `0` handles the case where you knew before you released. This handles the
   * one where you did not: it keeps the move and cancels only the run. Without
   * it the sole way out of an unwanted Run was Undo, which also throws away the
   * move you did want — so the cost of a column default firing when you did not
   * mean it was doing the whole drag again.
   *
   * The entry survives with `automation: null` rather than being deleted: the
   * ticket really is in the destination column now, and deleting the entry
   * would send the card back to its fixture column.
   */
  const cancelRun = React.useCallback((ticketId: string) => {
    const timeoutId = armTimers.current.get(ticketId);
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
      armTimers.current.delete(ticketId);
    }
    setMoves((current) => {
      const entry = current[ticketId];
      if (entry === undefined) return current;
      return { ...current, [ticketId]: { ...entry, automation: null, phase: "fired" } };
    });
  }, []);

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

  /**
   * Read by the drop effect below, and deliberately NOT depended on by it.
   *
   * The effect is a one-shot reaction to a NEW drop, but its body needs the
   * default in force and the release point — both of which change for reasons
   * that have nothing to do with a drop happening. With them in the dependency
   * list, changing a column's default from the bolt while a drop was still
   * armed re-entered the effect on the SAME `lastDrop`: it recomputed the
   * automation from the new default and overwrote the armed entry, and worse,
   * recomputed `fromStatus` as `current[...]?.toStatus` — the destination — so
   * Undo stopped returning the card to the column it came from.
   *
   * Refs assigned during render are set before any effect in the same commit
   * runs, so the effect still sees this render's values.
   */
  const armingRef = React.useRef(arming);
  armingRef.current = arming;
  const releasePointRef = React.useRef(drag.point);
  releasePointRef.current = drag.point;

  React.useEffect(() => {
    const drop = drag.lastDrop;
    if (drop === null) {
      // Starting a new drag clears `lastDrop`, which is also the right moment to
      // drop a confirmation still on screen: it describes the previous drag.
      setConfirmation(null);
      return;
    }
    const automation = resolveAutomation(drop.status, armingRef.current, drop.overrideIndex);
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
        x: releasePointRef.current.x,
        y: releasePointRef.current.y,
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
  }, [drag.lastDrop, scheduleFire]);

  const dragActive = drag.ticketId !== null && draggedTicket !== null && drag.origin !== null;

  // What the ghost says it is about to do. While ⌥ is open the picker cell owns
  // both facts, because the pointer may have wandered off the column the picker
  // belongs to and the picker, not the pointer, is what a release would obey.
  const ghostDestination: TicketStatus | null =
    drag.pickerOpen && drag.pickerCell !== null ? drag.pickerCell.status : drag.hovered;
  const ghostAutomation: Automation | null =
    drag.pickerOpen && drag.pickerCell !== null
      ? resolveAutomation(drag.pickerCell.status, arming, drag.pickerCell.index)
      : chosen;

  // A single narrowed handle for the three bottom-level renders below, so
  // `drag.origin`'s nullability only has to be proven once instead of cast
  // away at each call site.
  const activeDrag =
    draggedTicket !== null && drag.origin !== null
      ? { ticket: draggedTicket, origin: drag.origin }
      : null;

  return (
    <div className="flex flex-col gap-3">
      {/* The board. Drop targets are the columns and only the columns, in every
          shape — the plan forbids the picker from adding or subdividing one. */}
      <div className="relative overflow-hidden rounded-xl border border-border bg-background">
        <div className="flex gap-2 overflow-x-auto p-2">
          {TICKET_STATUSES.map((status) => {
            // Real count for the bulk-undo control (requirement 2, surface
            // two) — every ticket still ARMED (not yet fired) that landed in
            // THIS column, regardless of which column it came from.
            const armedInColumn = Object.values(moves).filter(
              (entry) =>
                entry.automation !== null && entry.phase === "armed" && entry.toStatus === status,
            ).length;
            const armed = automationById(arming[status]);
            const offered = offeredFor(status);

            const isExpandTarget =
              dragActive && drag.pickerOpen && drag.pickerCell?.status === status;
            const isExpandOther =
              dragActive && drag.pickerOpen && drag.pickerCell?.status !== status;

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
                  "flex shrink-0 flex-col rounded-lg bg-muted/40 p-2 transition-[background-color,box-shadow,width,opacity] duration-150 ease-out",
                  isExpandTarget ? "w-72" : "w-52",
                  isExpandOther && "opacity-50",
                  drag.hovered === status && !drag.pickerOpen && "bg-accent/60 ring-1 ring-ring",
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
                  {/* Same control as `ArmingTab`, same `arming` state — a bolt
                      in the corner rather than a card under the header. */}
                  <ColumnDefaultControl
                    status={status}
                    armed={armed}
                    offered={offered}
                    onArm={(id) => onArm(status, id)}
                    onDisarm={() => onDisarm(status)}
                  />
                </div>

                {/* ONE list, two sizes.
                    Hovering a column mid-drag shows everything it can run, in a
                    compact form, with the digit that picks each. Holding ⌥ grows
                    the SAME rows into landing targets you can drop onto, and
                    releasing ⌥ shrinks them back. Rendering two different
                    components for the two states was the earlier mistake: the
                    collapsed one was a read-only legend and the expanded one a
                    grid, so ⌥ appeared to replace the list rather than resize
                    it, and the digits looked like they belonged to a different
                    control than the targets. */}
                {dragActive && (isExpandTarget || (!drag.pickerOpen && drag.hovered === status)) ? (
                  <ColumnAutomationList
                    status={status}
                    cell={isExpandTarget ? drag.pickerCell : null}
                    setCell={drag.setPickerCell}
                    arming={arming}
                    digitSelection={drag.digitSelection}
                    expanded={isExpandTarget}
                  />
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
                              onCancelRun: () => cancelRun(ticket.id),
                            }
                          : undefined;
                      return (
                        <BoardCard
                          key={ticket.id}
                          ticket={ticket}
                          dimmed={drag.ticketId === ticket.id}
                          onPointerDown={drag.start(ticket.id, effectiveStatus(ticket))}
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
            <LightningIcon weight="regular" className="text-muted-foreground" />
            <span>Moved to {TICKET_STATUS_LABELS[confirmation.status]}</span>
          </p>
          {/* The confirmation is the only thing standing between this prototype
              and someone believing a Run started. It says so every time. */}
          <p className="pt-0.5 text-label text-muted-foreground">The lab starts nothing.</p>
        </div>
      ) : null}

      {/* Under the hand for the whole gesture, everywhere, with no state in
          which it stops tracking the cursor — a full card until it is standing
          on the automation panel, one line while it is. It carries the ticket
          and the move it is making, and nothing else: the keys are not written
          on the card you are holding. */}
      {activeDrag !== null ? (
        <DragGhost
          ticket={activeDrag.ticket}
          origin={activeDrag.origin}
          destination={ghostDestination}
          point={drag.point}
          automation={ghostAutomation}
          onList={drag.overList}
        />
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------- scratch */

const TAB_OPTIONS = [
  { id: "ticket", label: "In ticket" },
  { id: "arming", label: "Column defaults" },
  { id: "drag", label: "Drag picker" },
] as const;

export default function AutomationTriggerScratch() {
  const [tab, setTab] = React.useState<(typeof TAB_OPTIONS)[number]["id"]>("ticket");

  // Lifted here, not owned by either tab, so arming a column from the Arming
  // tab and arming it by dropping a card in the Drag tab are provably the same
  // piece of state — see `LAB_PREARMED_ARMING`.
  const [arming, setArming] =
    React.useState<Partial<Record<TicketStatus, string>>>(LAB_PREARMED_ARMING);

  const armColumn = React.useCallback((status: TicketStatus, automationId: string) => {
    setArming((current) => ({ ...current, [status]: automationId }));
  }, []);
  const disarmColumn = React.useCallback((status: TicketStatus) => {
    setArming((current) => {
      const next = { ...current };
      delete next[status];
      return next;
    });
  }, []);

  return (
    // `delayDuration={0}`: the bolt is a small, unlabelled icon and its tooltip
    // is the ONLY place a column's default is named at rest. A hover delay on
    // the sole carrier of a fact is a delay on reading the interface.
    <TooltipProvider delayDuration={0}>
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
          {TAB_OPTIONS.map((option) => (
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
        {tab === "ticket" ? <InTicketTab /> : null}
        {tab === "arming" ? (
          <ArmingTab arming={arming} onArm={armColumn} onDisarm={disarmColumn} />
        ) : null}
        {tab === "drag" ? (
          <DragTab arming={arming} onArm={armColumn} onDisarm={disarmColumn} />
        ) : null}
      </div>
    </TooltipProvider>
  );
}
