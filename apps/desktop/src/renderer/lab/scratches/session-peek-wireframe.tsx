/**
 * VC-30 — interactive lab based on hover-peek-wireframe.excalidraw.
 *
 * Hover reads without moving focus. Answer/Send explicitly hold a recipient
 * and reveal the reply form; "pin" is only the controller's internal name.
 * The original sketch remains available at #session-peek.
 *
 * This scratch owns timers and geometry. session-peek/card.tsx owns the card;
 * the pure reducer next door owns dwell, persistence, send and dismissal rules.
 * The conversation overlay reads separate source-message fixtures, never the
 * generated summary. Opening it preserves an unfinished reply and closing it
 * returns focus to the originating card (or row after a completed send).
 *
 * No IPC. Sessions, summaries, conversation, sends and navigation are fixtures.
 * Undo deletes a local fixture delivery; it cannot recall a real command. Its
 * 5-second receipt outlives the card's 2-second confirmation. A real integration
 * still needs freshness, cancellation and delivery guarantees from the runtime.
 */
import * as React from "react";
import { clamp, positionPeek, type PeekPosition } from "../session-peek/geometry";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { CheckCircleIcon } from "@phosphor-icons/react/dist/csr/CheckCircle";

import { PeekConversation } from "../session-peek/conversation";
import {
  SessionPeekCard,
  SessionGlyph,
  STATE_WORD,
  type SessionFixture,
  type FixtureState,
} from "../session-peek/card";
import {
  stressCopy,
  CONTENT_LIMITS_NOTE,
  type TextCase,
  type SummaryState,
} from "./session-peek-content";

import { Button } from "@renderer/components/ui/button";
import { ListRow } from "@renderer/components/ui/list-row";
import { Notice } from "@renderer/components/ui/notice";
import {
  Sidebar,
  SidebarGroup,
  SidebarMenu,
  SidebarProvider,
} from "@renderer/components/ui/sidebar";
import { cn } from "@renderer/lib/utils";

import {
  CONFIRMATION_MS,
  DEFAULT_DWELL,
  DWELL_CHOICES,
  GRACE_MS,
  initialPeekState,
  peekReducer,
  UNDO_MS,
  type DwellMs,
  type PeekSurface,
  type PeekTarget,
  type SendOutcome,
} from "./session-peek-wireframe-model";

export const title = "Session peek · Excalidraw v2";
export const note = "Session summaries, answers and a conversation overlay in both sidebars";
export const viewport = "window";

/* ------------------------------------------------------------------ fixtures */

const QUESTION_OPTIONS = [
  { id: "redis", label: "Redis", description: "Fast, adds a dependency" },
  { id: "postgres", label: "Postgres", description: "Slower, no new infra" },
];

/** Variations over the shared per-prompt contract, not a claim about every harness. */
type QuestionCase = "custom" | "choices" | "multiple" | "steps" | "freeform";
const BASE_PROMPT = {
  id: "cache",
  label: "Which cache backend should the indexer use?",
  detail: null,
  options: QUESTION_OPTIONS,
  multiple: false,
  custom: true,
};
const QUESTION_CASES: Record<QuestionCase, SessionFixture["question"]> = {
  custom: { prompts: [BASE_PROMPT] },
  choices: { prompts: [{ ...BASE_PROMPT, custom: false }] },
  multiple: {
    prompts: [
      {
        ...BASE_PROMPT,
        multiple: true,
        custom: false,
        label: "Which backends should we evaluate?",
      },
    ],
  },
  steps: {
    prompts: [
      { ...BASE_PROMPT, custom: false },
      {
        id: "rollout",
        label: "How should we roll this out?",
        detail: "The indexer runs in three regions.",
        options: [
          { id: "staged", label: "Staged rollout", description: "Start with one indexer" },
          { id: "all", label: "All at once", description: "Switch every indexer" },
        ],
        multiple: false,
        custom: true,
      },
    ],
  },
  freeform: {
    prompts: [
      {
        ...BASE_PROMPT,
        id: "approach",
        label: "What approach should we take?",
        options: [],
        custom: true,
      },
    ],
  },
};

const FIXTURES: readonly SessionFixture[] = [
  {
    rowId: "session-1",
    model: {
      providerId: "anthropic",
      providerLabel: "Anthropic",
      modelId: "claude-opus-5",
      label: "Opus 5",
    },
    messages: [
      {
        role: "user",
        text: "Build a preview for sessions in the sidebar. Keep the current workspace open while I check another session.",
      },
      {
        role: "assistant",
        text: "The hover controller now waits until the pointer rests on a row. I moved the close timer onto the shared card so crossing the gap does not dismiss it. Next I am checking the ticket rail so the same card can open on its left side.",
      },
    ],
    sessionTitle: "Session 1",
    sessionId: "ses-7f3a91",
    ticketId: "VC-200",
    ticketTitle: "Hover-peek for sessions in the sidebars",
    ticketStage: "Doing",
    recency: "2m ago",
    state: "active",
    lastActivity:
      "Wired the dwell timer to the Active band and moved the close grace onto the card; now reading how the rail positions its own rows before touching the shared peek.",
    question: null,
    failure: null,
  },
  {
    rowId: "session-2",
    model: {
      providerId: "openai-codex",
      providerLabel: "OpenAI",
      modelId: "gpt-6-sol",
      label: "GPT 6 Sol",
    },
    messages: [
      {
        role: "user",
        text: "Choose a cache backend for the search indexer. Compare operational cost and query latency before adding infrastructure.",
      },
      {
        role: "assistant",
        text: "I traced the indexer read path and compared the two options. Redis would keep frequently read index entries in memory, but we would need another service to deploy, monitor, back up and reconnect to.\n\nPostgres is already deployed. An indexed cache table would be slower on hot reads but fits the existing migration and backup process. I have not added either dependency or changed the schema.",
      },
      {
        role: "assistant",
        text: "Which cache backend should the indexer use?",
      },
    ],
    sessionTitle: "Session 2",
    sessionId: "ses-2c4d08",
    ticketId: "VC-201",
    ticketTitle: "Choose a cache backend for the indexer",
    ticketStage: "Doing",
    recency: "40s ago",
    state: "waiting",
    // Keep the work, summary and pending question about the same decision.
    lastActivity:
      "Compared Redis with the existing Postgres deployment. Redis is faster on hot reads; Postgres avoids a new service. No dependencies or schema changes yet.",
    question: QUESTION_CASES.custom,
    failure: null,
  },
  {
    rowId: "session-3",
    model: {
      providerId: "google",
      providerLabel: "Google",
      modelId: "gemini-2.5-pro",
      label: "Gemini 2.5 Pro",
    },
    messages: [
      {
        role: "user",
        text: "Review stale tickets and report candidates to close. Do not close any tickets yet.",
      },
      {
        role: "assistant",
        text: "Eleven backlog tickets have no comment in the last thirty days. Four have a merged pull request linked in their activity. I recorded the candidates for review and left every ticket unchanged.",
      },
    ],
    sessionTitle: "Session 3",
    sessionId: "ses-91be44",
    ticketId: null,
    ticketTitle: null,
    ticketStage: null,
    recency: "22m ago",
    state: "idle",
    lastActivity:
      "Found eleven stale backlog tickets, including four with merged PRs. Saved the candidates for review; no tickets were closed.",
    question: null,
    failure: null,
  },
  {
    rowId: "session-4",
    model: {
      providerId: "anthropic",
      providerLabel: "Anthropic",
      modelId: "claude-opus-5",
      label: "Opus 5",
    },
    messages: [
      {
        role: "user",
        text: "Investigate why terminal resume loses scrollback. Trace the restore path before editing.",
      },
      {
        role: "assistant",
        text: "The resume seed contains the expected pane identifier. The restored pane is registered before its scrollback offsets are applied. I was comparing the saved offsets with the first viewport resize when the executor connection ended.",
      },
    ],
    sessionTitle: "Session 4",
    sessionId: "ses-55a7c2",
    ticketId: "VC-123",
    ticketTitle: "Terminal resume loses its scrollback",
    ticketStage: "Needs Review",
    recency: "1h ago",
    state: "failed",
    lastActivity:
      "Read the resume seed and the pane registry, then compared both against the recorded scrollback offsets before the turn ended mid-stream with nothing written.",
    question: null,
    failure: "Turn ended without a reply — the executor exited while the model was streaming.",
  },
];

const PROVIDER_MODELS = Object.fromEntries(
  FIXTURES.map((fixture) => [fixture.model.providerId, fixture.model]),
);

/** A ticketless Session's stand-in, matching the sketch's "Board · 22m ago" row. */
const NO_TICKET_SOURCE = "Board";

function rowSubtitle(fixture: SessionFixture): string {
  return `${fixture.ticketId ?? NO_TICKET_SOURCE} · ${fixture.recency}`;
}

/* ------------------------------------------------------------- lab notes */

/** Prototype mechanics and the remaining difference from the sketch. */
const HOVER_MECHANICS: readonly string[] = [
  "opens after ~400 ms, pointer at rest — passing through a row never opens it",
  "cursor can travel row → card; this lab uses a 300 ms grace bridge (the sketch proposes a safe polygon)",
  "Esc · click-away · list scroll also close it",
  "one peek at a time; ~1 s suppression after close",
  "production target: snapshot ≤30 s stale + live status; fixtures here are static",
  "no terminal screenshots or live video",
  "setting: hover peek on/off · compact mode (title + ticket ID + status) for a quieter sidebar",
  "peek never steals focus — the row keeps it",
];

/** Keyboard routes and scope. */
const KEYBOARD_SCOPE: readonly string[] = [
  "J/K or ↑/↓ steps rows; one peek follows focus",
  "keyboard path: focus a row → peek after ~200–300 ms, or press Space to open / pin it",
  "Enter still opens the session — the peek is never the only route to anything",
  "WCAG 1.4.13: dismissable (Esc) · hoverable (bridge) · persistent (never vanishes while you read or type)",
  "the reply field makes it a non-modal dialog (ARIA), not a tooltip",
  "same rows + peek in the right in-ticket sidebar; board tickets reuse it later",
];

/** The sketch's confirmation panel, with this file's answer to its 2s/5s conflict. */
const CONFIRMATION_NOTES: readonly string[] = [
  "sidebar state flips: Waiting for you → Working",
  "peek stays ~2 s with this confirmation, then closes",
  "Undo (5 s) if you misclicked — moved onto a receipt strip so it outlives the peek",
  "retryable send failure keeps the reply and recovery action visible",
  "the answer also shows up in the session transcript",
];

const STILL_TO_DECIDE =
  "Default hover delay (300 / 400 / 500 ms)?  ·  compact vs full as the default  ·  how stale may the summary be (≤30 s?)  ·  same peek on board tickets now or later?  ·  anything different in the right sidebar?";

/* --------------------------------------------------------------- the geometry */

const PEEK_WIDTH = 360;
/* ------------------------------------------------------------------- the row */

type RowDensity = "full" | "compact";

/**
 * One sidebar row, in either list.
 *
 * `data-peek-row` is how the pointer handler resolves a row without wrapping
 * every entry in an extra element — the lists are `<ul>`/`<li>` owned by the
 * sidebar primitive, and a div per row would be invalid markup inside one.
 */
function SessionRow({
  fixture,
  surface,
  density,
  delivered,
  onOpenSession,
}: {
  fixture: SessionFixture;
  surface: PeekSurface;
  density: RowDensity;
  /** A sent answer flips the row, which is the only thing a send changes out here. */
  delivered: boolean;
  onOpenSession: () => void;
}) {
  const state: FixtureState = delivered && fixture.state === "waiting" ? "active" : fixture.state;
  return (
    <li data-peek-row={fixture.rowId} data-peek-surface={surface}>
      <ListRow
        // Click and Enter both land here. The peek is never the only route to a
        // session, and a row that opened nothing would be a lie the pointer tells.
        onActivate={onOpenSession}
        density={density === "full" ? "two-line" : "row"}
        leading={<SessionGlyph fixture={fixture} state={state} />}
        primary={
          <span
            data-session-row-title=""
            className={cn(
              "min-w-0 flex-1 truncate text-ui",
              density === "compact" ? "font-semibold" : "font-medium",
            )}
          >
            {fixture.sessionTitle}
          </span>
        }
        secondary={density === "full" ? rowSubtitle(fixture) : undefined}
        primaryTrailing={
          density === "compact" ? (
            <span className="shrink-0 font-mono text-label tracking-normal text-muted-foreground">
              {fixture.ticketId ?? "Board"}
            </span>
          ) : undefined
        }
      />
    </li>
  );
}

const CAPTION = "text-label text-muted-foreground uppercase";

/* ---------------------------------------------------------------- lab chrome */

/** The lab's own control, drawn so it can never be mistaken for the design. */
function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  value: T;
  options: readonly (readonly [T, string])[];
  onChange: (next: T) => void;
  disabled?: boolean;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-2">
      <span className="text-label text-muted-foreground uppercase">{label}</span>
      <div className="flex flex-wrap gap-1">
        {options.map(([key, name]) => (
          <Button
            key={key}
            type="button"
            size="xs"
            variant={key === value ? "secondary" : "ghost"}
            aria-pressed={key === value}
            disabled={disabled}
            onClick={() => onChange(key)}
          >
            {name}
          </Button>
        ))}
      </div>
    </div>
  );
}

function Bullets({ heading, items }: { heading: string; items: readonly string[] }) {
  return (
    <section className="flex flex-col gap-1.5 rounded-xl border border-dashed border-border p-3">
      <h2 className="text-ui font-medium text-foreground">{heading}</h2>
      <ul className="flex flex-col gap-1">
        {items.map((item) => (
          <li key={item} className="flex gap-1.5 text-ui text-muted-foreground">
            <span aria-hidden>•</span>
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* --------------------------------------------------------------- the machine */

/* ----------------------------------------------------------------- the stage */

export default function SessionPeekWireframeScratch() {
  const [state, dispatch] = React.useReducer(peekReducer, initialPeekState);
  const [dwell, setDwell] = React.useState<DwellMs>(DEFAULT_DWELL);
  const [density, setDensity] = React.useState<RowDensity>("full");
  const [hoverEnabled, setHoverEnabled] = React.useState(true);
  const [outcome, setOutcome] = React.useState<SendOutcome>("success");
  const [textCase, setTextCase] = React.useState<TextCase>("normal");
  const [summaryState, setSummaryState] = React.useState<SummaryState>("ready");
  const [questionCase, setQuestionCase] = React.useState<QuestionCase>("custom");
  const [cardWidth, setCardWidth] = React.useState(PEEK_WIDTH);
  const [provider, setProvider] = React.useState("mixed");
  const [looking, setLooking] = React.useState<string | null>(null);
  const fixtures = React.useMemo(
    () =>
      FIXTURES.map((fixture) =>
        stressCopy(
          {
            ...fixture,
            model: PROVIDER_MODELS[provider] ?? fixture.model,
            question:
              fixture.rowId === "session-2" ? QUESTION_CASES[questionCase] : fixture.question,
          },
          textCase,
        ),
      ),
    [textCase, provider, questionCase],
  );
  const fixtureByRow = React.useMemo(
    () => new Map(fixtures.map((fixture) => [fixture.rowId, fixture])),
    [fixtures],
  );
  const [position, setPosition] = React.useState<PeekPosition | null>(null);
  const [cardHeight, setCardHeight] = React.useState(0);
  /** The receipt that outlives the peek, so Undo is reachable for its full window. */
  const [receipt, setReceipt] = React.useState<{
    rowId: string;
    answer: string;
    at: number;
  } | null>(null);
  const [undoLeft, setUndoLeft] = React.useState(0);

  const cardRef = React.useRef<HTMLDivElement | null>(null);
  const dwellTimer = React.useRef<number | null>(null);
  const graceTimer = React.useRef<number | null>(null);

  const shown = state.shown;
  const pinnedRowId = state.pinned?.rowId ?? null;
  const shownFixture = shown === null ? null : (fixtureByRow.get(shown.rowId) ?? null);
  const lookingFixture = looking === null ? null : (fixtureByRow.get(looking) ?? null);

  /* ---------------------------------------------------------------- timers */

  const clearDwell = React.useCallback(() => {
    if (dwellTimer.current !== null) window.clearTimeout(dwellTimer.current);
    dwellTimer.current = null;
  }, []);

  const clearGrace = React.useCallback(() => {
    if (graceTimer.current !== null) window.clearTimeout(graceTimer.current);
    graceTimer.current = null;
  }, []);

  /**
   * Arm the dwell for one row, cancelling whatever was armed.
   *
   * This is "passing through a row never opens it": the sweep re-arms on every
   * new row, so only the row the pointer comes to rest on ever fires.
   */
  const armDwell = React.useCallback(
    (target: PeekTarget, delay: number = dwell) => {
      clearDwell();
      dwellTimer.current = window.setTimeout(() => {
        dispatch({ type: "dwell-elapsed", target, now: Date.now() });
      }, delay);
    },
    [clearDwell, dwell],
  );

  /** The bridge: closing waits out the gap between row and card. */
  const armGrace = React.useCallback(() => {
    clearGrace();
    graceTimer.current = window.setTimeout(() => {
      dispatch({ type: "grace-elapsed" });
    }, GRACE_MS);
  }, [clearGrace]);

  React.useEffect(
    () => () => {
      clearDwell();
      clearGrace();
    },
    [clearDwell, clearGrace],
  );

  /* ------------------------------------------------------- pointer handlers */

  const rowPointerMove = React.useCallback(
    (surface: PeekSurface) => (event: React.PointerEvent<HTMLElement>) => {
      if (!hoverEnabled || looking !== null) return;
      const row = (event.target as HTMLElement).closest<HTMLElement>("[data-peek-row]");
      const rowId = row?.dataset.peekRow;
      if (rowId === undefined) return;
      clearGrace();
      const target: PeekTarget = { rowId, surface };
      if (state.hovered?.rowId !== rowId || state.hovered.surface !== surface) {
        dispatch({ type: "hover-row", target });
      }
      // Dwell means pointer AT REST, not merely time spent inside a tall row.
      if (state.shown?.rowId !== rowId || state.shown.surface !== surface) armDwell(target);
    },
    [armDwell, clearGrace, hoverEnabled, state.hovered, state.shown, looking],
  );

  const rowPointerLeave = React.useCallback(() => {
    if (looking !== null) return;
    clearDwell();
    dispatch({ type: "hover-leave-row" });
    armGrace();
  }, [armGrace, clearDwell, looking]);

  /* ------------------------------------------------ dismissal: away & scroll */

  React.useEffect(() => {
    if (shown === null || looking !== null) return;
    const onPointerDown = (event: PointerEvent) => {
      const node = event.target as HTMLElement | null;
      if (node === null) return;
      // The lab's own control bar is exempt: fighting the controls that change
      // the thing under review is not a finding about the design.
      if (
        node.closest(
          '[data-peek-card], [data-peek-row], [data-lab-controls], [data-slot="dialog-overlay"], [data-slot="dialog-content"]',
        ) !== null
      )
        return;
      dispatch({ type: "dismiss", reason: "click-away", now: Date.now() });
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [shown, looking]);

  const onListScroll = React.useCallback(() => {
    dispatch({ type: "dismiss", reason: "list-scroll", now: Date.now() });
  }, []);

  /* ----------------------------------------------------- keyboard: the rules */

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (looking !== null) return;
      if (event.key === "Escape") {
        clearDwell();
        clearGrace();
        // A reducer focus label is not DOM focus. Move out of the field only
        // on Escape; clicking elsewhere must never pull focus back here.
        if (state.focus === "field") {
          cardRef.current?.focus();
          return;
        }
        dispatch({ type: "escape", now: Date.now() });
        return;
      }
      // ⌘. pins whatever the peek is currently showing — the pointer path's
      // way into answering without moving the hand to a button.
      if (event.key === "." && (event.metaKey || event.ctrlKey) && shown !== null) {
        event.preventDefault();
        dispatch({ type: "pin", target: shown });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [shown, state.focus, clearDwell, clearGrace, looking]);

  /**
   * Row stepping, Space, and R — scoped to the list they happen in.
   *
   * Space is intercepted rather than allowed through: the row is a `<button>`,
   * so an un-prevented Space would ALSO activate it and open the session behind
   * the peek it just asked for.
   */
  const onListKeyDown = React.useCallback(
    (surface: PeekSurface) => (event: React.KeyboardEvent<HTMLElement>) => {
      const list = event.currentTarget;
      const rows = [...list.querySelectorAll<HTMLElement>("[data-peek-row]")];
      const activeRow = (event.target as HTMLElement).closest<HTMLElement>("[data-peek-row]");
      const index = activeRow === null ? -1 : rows.indexOf(activeRow);
      const rowId = activeRow?.dataset.peekRow;

      const step = (delta: number) => {
        event.preventDefault();
        const next = rows[clamp(index + delta, 0, rows.length - 1)];
        next?.querySelector<HTMLElement>("button")?.focus();
        // The list's focus handler arms the keyboard dwell for every route
        // into a row — Tab, arrow keys, or J/K.
      };

      if (event.key === "ArrowDown" || event.key === "j") return step(1);
      if (event.key === "ArrowUp" || event.key === "k") return step(-1);
      if (rowId === undefined) return;
      const target: PeekTarget = { rowId, surface };

      if (event.key === " ") {
        event.preventDefault();
        clearDwell();
        // Space opens; Space again on an open peek pins it.
        if (state.shown?.rowId === rowId && state.shown.surface === surface) {
          dispatch({ type: "pin", target });
        } else {
          dispatch({ type: "hover-row", target });
          dispatch({ type: "open-now", target, now: Date.now() });
        }
        return;
      }
      if (event.key === "r" || event.key === "R") {
        event.preventDefault();
        clearDwell();
        dispatch({ type: "hover-row", target });
        dispatch({ type: "pin", target });
      }
    },
    [clearDwell, state.shown],
  );

  /* ------------------------------------------------------ focus, in and out */

  /** The row a pin took focus from, so unpinning can hand it back. */
  const focusReturn = React.useRef<HTMLElement | null>(null);

  React.useEffect(() => {
    const target = state.pinned;
    if (target === null) return;
    // A pointer pin came from a card button, not the row. Resolve the source
    // explicitly so keyboard and pointer pins have the same return path.
    focusReturn.current = document.querySelector<HTMLElement>(
      `[data-peek-row="${target.rowId}"][data-peek-surface="${target.surface}"] button`,
    );
    cardRef.current?.focus();
  }, [state.pinned]);

  React.useEffect(() => {
    if (pinnedRowId !== null) return;
    const row = focusReturn.current;
    focusReturn.current = null;
    if (row === null) return;
    if (state.focus === "row" || document.activeElement === document.body) {
      row.focus();
      clearDwell();
    }
  }, [pinnedRowId, state.focus, clearDwell]);

  /* -------------------------------------------------------- send simulation */

  React.useEffect(() => {
    if (state.send.kind !== "sending") return;
    // A plausible round trip, so "Sending…" is visible. No IPC: the outcome is
    // whatever the lab control says.
    const timer = window.setTimeout(() => {
      dispatch({
        type: "send-settled",
        outcome,
        now: Date.now(),
        reason:
          outcome === "failure" ? "Couldn’t send. Your reply is saved here; try again." : undefined,
      });
    }, 450);
    return () => window.clearTimeout(timer);
  }, [state.send.kind, outcome]);

  const sentAt = state.send.kind === "sent" ? state.send.at : null;
  const sentAnswer = state.send.kind === "sent" ? state.send.answer : null;

  /** The confirmation holds the peek for ~2s; the receipt then carries Undo. */
  React.useEffect(() => {
    if (sentAt === null || sentAnswer === null || pinnedRowId === null) return;
    setReceipt({ rowId: pinnedRowId, answer: sentAnswer, at: sentAt });
    const timer = window.setTimeout(
      () => dispatch({ type: "confirmation-elapsed" }),
      CONFIRMATION_MS,
    );
    return () => window.clearTimeout(timer);
  }, [sentAt, sentAnswer, pinnedRowId]);

  React.useEffect(() => {
    if (receipt === null) return;
    const tick = () => {
      const left = Math.ceil((receipt.at + UNDO_MS - Date.now()) / 1000);
      if (left <= 0) {
        setReceipt(null);
        setUndoLeft(0);
        return;
      }
      setUndoLeft(left);
    };
    tick();
    const timer = window.setInterval(tick, 250);
    return () => window.clearInterval(timer);
  }, [receipt]);

  /** "Open session" is a simulation; say so and clear it. */
  React.useEffect(() => {
    if (state.opened === null) return;
    const timer = window.setTimeout(() => dispatch({ type: "clear-opened" }), 2400);
    return () => window.clearTimeout(timer);
  }, [state.opened]);

  /* ------------------------------------------------------------- geometry */

  const measure = React.useCallback(() => {
    if (shown === null) {
      setPosition(null);
      return;
    }
    const row = document.querySelector<HTMLElement>(
      `[data-peek-row="${shown.rowId}"][data-peek-surface="${shown.surface}"]`,
    );
    if (row === null) return;
    setPosition(
      positionPeek(
        row.getBoundingClientRect(),
        shown.surface,
        cardHeight,
        {
          width: window.innerWidth,
          height: window.innerHeight,
        },
        cardWidth,
      ),
    );
  }, [shown, cardHeight, cardWidth]);

  React.useLayoutEffect(measure, [measure]);

  React.useEffect(() => {
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);

  /** Measure the border box before paint; observing a clipped content box loses 2px. */
  const hasCard = shown !== null && position !== null && looking === null;
  React.useLayoutEffect(() => {
    const card = cardRef.current;
    if (card === null) {
      setCardHeight(0);
      return;
    }
    // Measured once either way, then observed where an observer exists — jsdom
    // ships none, and `ui/tab-strip.tsx` guards the same call for the same
    // reason: a surface that threw on mount without one would be untestable.
    setCardHeight(card.getBoundingClientRect().height);
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(() => {
      setCardHeight(card.getBoundingClientRect().height);
    });
    observer.observe(card);
    return () => observer.disconnect();
  }, [shown, pinnedRowId, state.send.kind, hasCard]);

  /* ------------------------------------------------------------------ view */

  const pin = React.useCallback((target: PeekTarget) => {
    dispatch({ type: "pin", target });
  }, []);

  const rowProps = (surface: PeekSurface) => ({
    onPointerMove: rowPointerMove(surface),
    onPointerLeave: rowPointerLeave,
    onKeyDown: onListKeyDown(surface),
    onFocusCapture: (event: React.FocusEvent<HTMLElement>) => {
      const rowId = (event.target as HTMLElement).closest<HTMLElement>("[data-peek-row]")?.dataset
        .peekRow;
      if (rowId === undefined || looking !== null) return;
      clearGrace();
      const target: PeekTarget = { rowId, surface };
      dispatch({ type: "hover-row", target });
      armDwell(target, 250);
    },
    onBlurCapture: (event: React.FocusEvent<HTMLElement>) => {
      if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))
        return;
      clearDwell();
      dispatch({ type: "hover-leave-row" });
      armGrace();
    },
  });

  const deliveredFor = (rowId: string) => state.delivered[rowId] !== undefined;
  const previewFixture = shownFixture ?? fixtures[1]!;
  const overlayReturn = React.useRef<HTMLElement | null>(null);
  const look = (rowId: string) => {
    overlayReturn.current = document.querySelector<HTMLElement>(
      `[data-peek-row="${rowId}"][data-peek-surface="${shown?.surface ?? "nav"}"] button`,
    );
    clearDwell();
    clearGrace();
    setLooking(rowId);
  };

  return (
    <div className="flex h-svh w-full flex-col overflow-y-auto bg-background text-foreground lg:flex-row lg:overflow-hidden">
      {/* ------------------------------------------------- 1 · left nav sidebar */}
      <SidebarProvider
        className="min-h-0 w-full shrink-0 lg:w-fit"
        style={{ "--sidebar-width": "280px" } as React.CSSProperties}
      >
        <Sidebar
          collapsible="none"
          className="w-full border-r border-border py-2 lg:w-(--sidebar-width)"
        >
          <SidebarGroup className="gap-1 py-0">
            <p className={cn(CAPTION, "px-2 py-1")}>Left nav sidebar</p>
            {/* The scroll container is the list, because a list scroll is one of
                the three gestures that close an unpinned peek. */}
            <div className="max-h-[320px] overflow-y-auto" onScroll={onListScroll}>
              <SidebarMenu {...rowProps("nav")}>
                {fixtures.map((fixture) => (
                  <SessionRow
                    key={fixture.rowId}
                    fixture={fixture}
                    surface="nav"
                    density={density}
                    delivered={deliveredFor(fixture.rowId)}
                    onOpenSession={() => dispatch({ type: "open-session", rowId: fixture.rowId })}
                  />
                ))}
              </SidebarMenu>
            </div>
          </SidebarGroup>
        </Sidebar>
      </SidebarProvider>

      {/* ------------------------------------------------------ the middle: notes */}
      <div className="min-w-0 shrink-0 p-4 lg:flex-1 lg:overflow-y-auto lg:p-6">
        <div className="flex max-w-[760px] flex-col gap-4">
          <header className="flex flex-col gap-1">
            <h1 className="text-heading text-foreground">Session peek</h1>
            <p className="text-ui text-muted-foreground">
              Lab translation of <span className="font-mono">hover-peek-wireframe.excalidraw</span>.
              Four fixture sessions, no backend: sending, opening a session, the badge flip and the
              transcript line below are all simulations, and Undo removes a fixture entry rather
              than recalling anything.{" "}
              <a
                className="text-primary-text underline-offset-4 hover:underline"
                href="#session-peek"
              >
                v1 scratch for comparison →
              </a>
            </p>
          </header>

          <div
            data-lab-controls=""
            className="flex flex-col gap-4 rounded-xl border border-border p-4"
          >
            <h2 className="text-ui font-medium">Test cases</h2>
            <div className="flex flex-wrap items-center gap-4">
              <Choice<`${DwellMs}`>
                label="Dwell"
                value={`${dwell}`}
                options={DWELL_CHOICES.map((ms) => [`${ms}`, `${ms}ms`] as const)}
                onChange={(next) => setDwell(Number(next) as DwellMs)}
              />
              <Choice<RowDensity>
                label="Rows"
                value={density}
                options={[
                  ["full", "full"],
                  ["compact", "compact"],
                ]}
                onChange={setDensity}
              />
              <Choice<"on" | "off">
                label="Hover"
                value={hoverEnabled ? "on" : "off"}
                options={[
                  ["on", "on"],
                  ["off", "off (keyboard)"],
                ]}
                onChange={(next) => {
                  clearDwell();
                  setHoverEnabled(next === "on");
                  if (next === "off") {
                    dispatch({ type: "hover-leave-row" });
                    dispatch({ type: "dismiss", reason: "click-away", now: Date.now() });
                  }
                }}
              />
              <Choice<SendOutcome>
                label="Send"
                value={outcome}
                options={[
                  ["success", "succeeds"],
                  ["failure", "fails"],
                ]}
                onChange={setOutcome}
              />
              <Choice<TextCase>
                label="Text"
                value={textCase}
                options={[
                  ["normal", "normal"],
                  ["long", "long"],
                  ["extreme", "extreme"],
                  ["unbroken", "unbroken"],
                ]}
                onChange={setTextCase}
              />
              <Choice<QuestionCase>
                label="Question"
                value={questionCase}
                disabled={state.send.kind === "sending" || state.send.kind === "sent"}
                options={[
                  ["custom", "custom"],
                  ["choices", "choices only"],
                  ["multiple", "multiple"],
                  ["steps", "two steps"],
                  ["freeform", "freeform"],
                ]}
                onChange={(next) => {
                  dispatch({ type: "fixture-question-changed" });
                  setQuestionCase(next);
                }}
              />
              <Choice<SummaryState>
                label="Summary"
                value={summaryState}
                options={[
                  ["ready", "ready"],
                  ["loading", "loading"],
                  ["unavailable", "unavailable"],
                ]}
                onChange={setSummaryState}
              />
              <Choice<"280" | "360" | "420">
                label="Card"
                value={`${cardWidth}` as "280" | "360" | "420"}
                options={[
                  ["280", "280px"],
                  ["360", "360px"],
                  ["420", "420px"],
                ]}
                onChange={(value) => setCardWidth(Number(value))}
              />
              <Choice<string>
                label="Provider"
                value={provider}
                options={[
                  ["mixed", "mixed"],
                  ["anthropic", "Anthropic"],
                  ["openai-codex", "OpenAI"],
                  ["google", "Google"],
                ]}
                onChange={setProvider}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              {fixtures.map((fixture) => (
                <Button
                  key={fixture.rowId}
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    const target: PeekTarget = { rowId: fixture.rowId, surface: "nav" };
                    dispatch({ type: "hover-row", target });
                    dispatch({ type: "open-now", target, now: Date.now() });
                  }}
                >
                  {STATE_WORD[fixture.state]}
                </Button>
              ))}
            </div>
            <p className="text-ui text-muted-foreground tabular-nums" data-text-lengths="">
              Session {previewFixture.sessionTitle.length} · ticket{" "}
              {previewFixture.ticketTitle?.length ?? 0} · summary{" "}
              {previewFixture.lastActivity.length} · question{" "}
              {previewFixture.question?.prompts[0]?.label.length ?? 0} chars
            </p>
            <p className="text-ui text-muted-foreground">{CONTENT_LIMITS_NOTE}</p>
          </div>

          <details className="text-ui">
            <summary className="cursor-pointer text-muted-foreground">Interaction notes</summary>
            <div className="flex flex-col gap-2 pt-2">
              <Bullets heading="Hover mechanics" items={HOVER_MECHANICS} />
              <Bullets heading="Sweep, keyboard & scope" items={KEYBOARD_SCOPE} />
              <Bullets heading="After a send (simulated)" items={CONFIRMATION_NOTES} />
            </div>
          </details>

          <section className="flex flex-col gap-2 rounded-xl border border-border p-3">
            <h2 className="text-ui font-medium text-foreground">Session transcript (lab mock)</h2>
            <p className="text-ui text-muted-foreground">
              Written only by a Send — hovering, pinning, selecting an option and typing all leave
              this empty.
            </p>
            {Object.keys(state.delivered).length === 0 ? (
              <p className="text-ui text-muted-foreground">Nothing delivered yet.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {Object.entries(state.delivered).map(([rowId, entry]) => (
                  <li key={rowId} className="flex gap-1.5 text-ui text-foreground">
                    <span className="font-mono text-muted-foreground">
                      {fixtureByRow.get(rowId)?.sessionTitle ?? rowId}
                    </span>
                    <span>→ “{entry.answer}”</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="flex flex-col gap-1.5 rounded-xl border border-dashed border-border p-3">
            <h2 className="text-ui font-medium text-foreground">Still to decide</h2>
            <p className="text-ui text-muted-foreground">{STILL_TO_DECIDE}</p>
          </section>
        </div>
      </div>

      {/* --------------------------------------- the right in-ticket rail */}
      {/* Same rows, same peek, opening the other way — the sketch's "same rows +
          peek in the right in-ticket sidebar". */}
      <aside className="w-full shrink-0 border-l border-border p-2 lg:w-[280px]">
        <p className={cn(CAPTION, "px-2 py-1")}>Right rail · state gallery</p>
        <div className="max-h-[320px] overflow-y-auto" onScroll={onListScroll}>
          <ul className="flex flex-col gap-1" {...rowProps("rail")}>
            {fixtures.map((fixture) => (
              <SessionRow
                key={fixture.rowId}
                fixture={fixture}
                surface="rail"
                density={density}
                delivered={deliveredFor(fixture.rowId)}
                onOpenSession={() => dispatch({ type: "open-session", rowId: fixture.rowId })}
              />
            ))}
          </ul>
        </div>
      </aside>

      {/* ----------------------------------------------------------- the peek */}
      {shown !== null && shownFixture !== null && position !== null && looking === null ? (
        <SessionPeekCard
          ref={cardRef}
          fixture={shownFixture}
          state={state}
          position={position}
          width={cardWidth}
          summaryState={summaryState}
          dispatch={dispatch}
          delivered={deliveredFor(shownFixture.rowId)}
          onPin={() => pin(shown)}
          onOpen={() => dispatch({ type: "open-session", rowId: shownFixture.rowId })}
          onLook={() => look(shownFixture.rowId)}
          onClose={() => dispatch({ type: "escape", now: Date.now() })}
          onPointerEnter={() => {
            clearGrace();
            dispatch({ type: "card-enter" });
          }}
          onPointerLeave={() => {
            dispatch({ type: "card-leave" });
            armGrace();
          }}
        />
      ) : null}

      <PeekConversation
        fixture={lookingFixture}
        answer={lookingFixture === null ? undefined : state.delivered[lookingFixture.rowId]?.answer}
        outcome={outcome}
        onClose={() => setLooking(null)}
        onOpen={() => {
          if (lookingFixture === null) return;
          dispatch({ type: "open-session", rowId: lookingFixture.rowId });
          setLooking(null);
        }}
        returnFocus={() => {
          queueMicrotask(clearDwell);
          return (
            cardRef.current?.querySelector<HTMLButtonElement>("[data-view-conversation]") ??
            overlayReturn.current
          );
        }}
      />

      {/* ------------------------------------------------- the Undo receipt */}
      {/* Off the peek on purpose: the peek closes at ~2s and this holds the full
          5s window the sketch promises. It is also where the honest label about
          Undo belongs — nothing was sent, so nothing is being recalled. */}
      {receipt === null ? null : (
        <div
          role="status"
          className="fixed right-4 bottom-14 z-[70] w-[360px] max-w-[calc(100vw-32px)]"
        >
          <Notice
            tone="neutral"
            icon={CheckCircleIcon}
            layout="stack"
            title={`Sent to ${FIXTURES.find((fixture) => fixture.rowId === receipt.rowId)?.sessionTitle ?? receipt.rowId}`}
            detail={`Simulation · ${undoLeft}s to undo`}
            actions={
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => {
                  dispatch({ type: "undo", rowId: receipt.rowId });
                  setReceipt(null);
                }}
              >
                Undo
              </Button>
            }
          />
        </div>
      )}

      {/* ------------------------------------- "Open session" is a simulation */}
      {state.opened === null ? null : (
        <div className="fixed top-3 left-1/2 z-[70] -translate-x-1/2">
          <Notice
            tone="neutral"
            icon={ArrowSquareOutIcon}
            title={`Lab: would open ${fixtureByRow.get(state.opened)?.sessionTitle ?? state.opened}`}
            detail="No navigation here — the scratch has no session to open."
          />
        </div>
      )}
    </div>
  );
}
