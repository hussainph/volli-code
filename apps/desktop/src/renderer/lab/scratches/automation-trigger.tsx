/**
 * Firing an Automation — the three surfaces of #86, with the prototype-gated
 * one built four ways.
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
 *   • DRAG (#86c) — the open question. Four variants against the plan's stated
 *     constraints: no dwell and no debounce anywhere, name AND harness legible
 *     rather than bare numbers, drop targets identical to today, and the dragged
 *     card always naming what will run.
 *
 * Local state only — no stores, no bridge. Nothing here starts a session, and
 * the drop line at the bottom of the drag tab is the assertion in place of one.
 */
import * as React from "react";
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

import { HARNESS_ADAPTERS, SEEDED_AUTOMATIONS, type Automation } from "../automation/model";
import { useDragSim } from "../automation/use-drag-sim";
import { tickets } from "../fixtures";

export const title = "Automation · trigger";
export const note = "Arming, the in-ticket advance button, and four drag pickers (#86/#89)";

/** Digits stop here: an accelerator you have to look at your hand to use is not one. */
const MAX_ACCELERATORS = 4;

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

function harnessOf(automation: Automation): string {
  return HARNESS_ADAPTERS[automation.runtime.harnessId].label;
}

/* ------------------------------------------------------------------ in ticket */

type TicketState = "unarmed" | "armed" | "resumable";

const TICKET_STATE_NOTES: Record<TicketState, string> = {
  unarmed: "Target column has no armed Automation — a plain status change, exactly as today.",
  armed: "Target column is armed. The button names the move AND what will run.",
  resumable:
    "Same armed column, but this ticket has a session worth resuming — #89: resume wins, and a fresh Run stays one click away.",
};

/**
 * The in-ticket advance control (#86d), reusing #45's shipped split-button shape
 * — primary + chevron, corners squared between them, never a second row.
 *
 * The whole design bet is in the primary's LABEL. "Move to Needs Review · Code
 * Review" is one gesture that names two consequences, which is the only way a
 * single click can spend tokens without being a surprise (#20). If that label
 * stops fitting, the bet is off.
 */
function AdvanceButton({ state }: { state: TicketState }) {
  const target: TicketStatus = state === "unarmed" ? "todo" : "doing";
  const armed = state === "unarmed" ? null : automationById("atm-implement");
  const resuming = state === "resumable";

  const primaryLabel = resuming
    ? "Resume"
    : armed === null
      ? `Move to ${TICKET_STATUS_LABELS[target]}`
      : `Move to ${TICKET_STATUS_LABELS[target]} · ${armed.name}`;

  return (
    <div className="flex flex-col gap-2">
      <div className="inline-flex w-fit">
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
          <DropdownMenuContent align="start" className="w-72">
            {resuming ? (
              <>
                {/* The rarer intent, made cheap without making it the default. */}
                <DropdownMenuItem className="justify-between gap-6">
                  <span className="flex items-center gap-2">
                    <LightningIcon weight="fill" />
                    Start a fresh Run · Implement
                  </span>
                  <span className="text-xs text-muted-foreground">Claude Code</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            ) : null}
            {armed !== null ? (
              <DropdownMenuItem>
                <ArrowRightIcon />
                Move to {TICKET_STATUS_LABELS[target]} without running
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
            {/* "Run without moving" — the plan routes this through the session
                tab strip's new-session control; offering it here too is the
                thing to have an opinion about. */}
            <DropdownMenuLabel>Run without moving</DropdownMenuLabel>
            {offeredFor(target).map((automation) => (
              <DropdownMenuItem key={automation.id} className="justify-between gap-6">
                <span className="flex items-center gap-2">
                  <PlayIcon weight="fill" />
                  {automation.name}
                </span>
                <span className="text-xs text-muted-foreground">{harnessOf(automation)}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <p className="max-w-prose text-xs text-muted-foreground">{TICKET_STATE_NOTES[state]}</p>
    </div>
  );
}

function InTicketTab() {
  return (
    <div className="flex flex-col gap-6">
      {(["unarmed", "armed", "resumable"] as const).map((state) => (
        <section key={state} className="flex flex-col gap-2">
          <h3 className="font-mono text-label uppercase text-muted-foreground">{state}</h3>
          <AdvanceButton state={state} />
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
 * Column-header arming (#86b).
 *
 * The affordance has to carry two facts at once — that a column CAN be armed,
 * and what it is armed with — without turning the board header into a second
 * toolbar. The quiet dashed hint on an unarmed column is #88's discoverability
 * answer: seeded automations are useless if nobody learns that columns fire.
 */
function ArmingTab() {
  const [arming, setArming] = React.useState<Partial<Record<TicketStatus, string>>>(SEEDED_ARMING);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-2 overflow-x-auto pb-2">
        {TICKET_STATUSES.map((status) => {
          const armed = automationById(arming[status]);
          const offered = offeredFor(status);
          const count = tickets.filter((ticket) => ticket.status === status).length;

          return (
            <div key={status} className="flex w-56 shrink-0 flex-col rounded-lg bg-muted/40 p-2.5">
              <div className="flex items-center gap-2 pb-1">
                <span className="text-ui font-medium text-foreground">
                  {TICKET_STATUS_LABELS[status]}
                </span>
                <span className="font-mono text-xs text-muted-foreground">{count}</span>
              </div>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  {armed === null ? (
                    // Unarmed: dashed, muted, and honest about being an offer.
                    <button
                      type="button"
                      className="flex items-center gap-1.5 rounded-md border border-dashed border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:border-solid hover:text-foreground"
                    >
                      <LightningIcon />
                      Arm an automation
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="flex flex-col items-start gap-0.5 rounded-md border border-border bg-card px-2 py-1 text-left transition-colors hover:border-ring"
                    >
                      <span className="flex items-center gap-1.5 text-xs text-foreground">
                        <LightningIcon weight="fill" className="text-primary" />
                        {armed.name}
                      </span>
                      <span className="pl-4 text-xs text-muted-foreground">{harnessOf(armed)}</span>
                    </button>
                  )}
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-64">
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
                      <span className="text-xs text-muted-foreground">{harnessOf(automation)}</span>
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
            </div>
          );
        })}
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

type DragVariant = "held" | "always" | "card" | "column";

const DRAG_VARIANTS: { id: DragVariant; label: string; claim: string }[] = [
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
}: {
  ticket: Ticket;
  point: { x: number; y: number };
  automation: Automation | null;
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
        {automation === null ? "Move only" : `${automation.name} · ${harnessOf(automation)}`}
      </p>
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
        "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors",
        chosen ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      <LightningIcon
        weight={chosen ? "fill" : "regular"}
        className={chosen ? "text-primary" : ""}
      />
      <span className="truncate">{automation === null ? "Move only" : automation.name}</span>
      <span className="ml-auto shrink-0 text-muted-foreground">
        {automation === null ? "" : harnessOf(automation)}
      </span>
      {index < MAX_ACCELERATORS ? (
        <kbd className="shrink-0 rounded border border-border px-1 font-mono text-[10px] text-muted-foreground">
          {index + 1}
        </kbd>
      ) : null}
    </button>
  );
}

function DragTab() {
  const [variant, setVariant] = React.useState<DragVariant>("held");

  // "Move only" is index 0 in every palette. Making the no-Run choice the
  // default is what keeps a drag from ever silently spending tokens — the
  // accelerator has to be pressed to opt IN.
  const optionsFor = React.useCallback(
    (status: TicketStatus | null): (Automation | null)[] =>
      status === null ? [null] : [null, ...offeredFor(status)],
    [],
  );

  const drag = useDragSim(MAX_ACCELERATORS);
  const options = optionsFor(drag.hovered);
  const chosen = options[drag.chosenIndex] ?? null;
  const paletteVisible =
    drag.ticketId !== null &&
    drag.hovered !== null &&
    (variant === "always" || variant === "card" || drag.modifierHeld || variant === "column");
  const draggedTicket = tickets.find((ticket) => ticket.id === drag.ticketId) ?? null;

  const palette = (
    <div className="flex flex-col gap-px">
      {options.map((automation, index) => (
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
          <span className="text-xs text-muted-foreground">Board</span>
          {/* The header strip. It is never a drop target — it is a readout that
              happens to be clickable, which is why it lives in chrome the drag
              can't land on. */}
          {(variant === "held" || variant === "always") && paletteVisible ? (
            <div className="flex items-center gap-1">
              {options.map((automation, index) => (
                <button
                  key={automation?.id ?? "none"}
                  type="button"
                  onPointerEnter={() => drag.setChosenIndex(index)}
                  aria-pressed={index === drag.chosenIndex}
                  className={cn(
                    "flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs transition-colors",
                    index === drag.chosenIndex
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground",
                  )}
                >
                  <LightningIcon weight={index === drag.chosenIndex ? "fill" : "regular"} />
                  {automation === null ? "Move only" : automation.name}
                  <span className="text-muted-foreground">
                    {automation === null ? "" : harnessOf(automation)}
                  </span>
                  {index < MAX_ACCELERATORS ? (
                    <kbd className="rounded border border-border px-1 font-mono text-[10px]">
                      {index + 1}
                    </kbd>
                  ) : null}
                </button>
              ))}
            </div>
          ) : variant === "held" && drag.ticketId !== null ? (
            <span className="text-xs text-muted-foreground">Hold ⌥ to choose an automation</span>
          ) : null}
        </div>

        <div className="flex gap-2 overflow-x-auto p-2">
          {TICKET_STATUSES.map((status) => (
            <div
              key={status}
              data-lab-column={status}
              className={cn(
                "flex w-52 shrink-0 flex-col rounded-lg bg-muted/40 p-2 transition-colors",
                drag.hovered === status && "bg-accent/60 ring-1 ring-ring",
              )}
            >
              <div className="flex items-center gap-2 px-1 pb-1.5">
                <span className="text-ui font-medium text-foreground">
                  {TICKET_STATUS_LABELS[status]}
                </span>
              </div>

              {variant === "column" && paletteVisible && drag.hovered === status ? (
                <div className="mb-1.5 rounded-md border border-border bg-popover p-1">
                  {palette}
                </div>
              ) : null}

              <div className="flex flex-col gap-1.5">
                {tickets
                  .filter((ticket) => ticket.status === status)
                  .map((ticket) => (
                    <div
                      key={ticket.id}
                      onPointerDown={drag.start(ticket.id)}
                      className={cn(
                        "cursor-grab touch-none rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs text-foreground select-none",
                        drag.ticketId === ticket.id && "opacity-40",
                      )}
                    >
                      <span className="line-clamp-2">{ticket.title}</span>
                    </div>
                  ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {drag.lastDrop !== null ? (
        <p className="flex items-center gap-1.5 text-xs text-foreground">
          <LightningIcon weight="fill" className="text-primary" />
          Dropped in {TICKET_STATUS_LABELS[drag.lastDrop.status]} —{" "}
          {optionsFor(drag.lastDrop.status)[drag.lastDrop.automationIndex]?.name ??
            "moved without running"}
          . (Nothing started: the lab has no sessions.)
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          Drag a card. ⌥ reveals the palette in the first variant; 1–{MAX_ACCELERATORS} pick; Esc
          cancels.
        </p>
      )}

      {drag.ticketId !== null && draggedTicket !== null ? (
        <>
          <DragGhost ticket={draggedTicket} point={drag.point} automation={chosen} />
          {variant === "card" && paletteVisible ? (
            <div
              className="pointer-events-auto fixed z-[101] w-64 rounded-md border border-border bg-popover p-1 shadow-lg"
              style={{ left: drag.point.x - 24, top: drag.point.y + 44 }}
            >
              {palette}
            </div>
          ) : null}
        </>
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
