/**
 * VC-30 — hover-peek for sessions in the sidebars.
 *
 * **The problem, stated as the user states it.** Someone is running a dozen
 * agents at once. The cost they actually pay is not reading — it is
 * RE-ENTRY: every glance at a row has to rebuild context that fell out of
 * their head three sessions ago. Three things fall out, in this order:
 *
 *   1. **Which ticket is this, and what stage is it at?** `VLT-14` is not a
 *      memorable name. A person with eleven live sessions cannot hold eleven
 *      ticket codes, and the row shows them nothing else.
 *   2. **What was this session asked to do, and where has it got to?** Scope
 *      first, progress second — progress with no scope is just noise.
 *   3. **Does it need me?** And if so, can I clear it from here.
 *
 * Everything below is built backwards from those three, which is why every
 * variant shares ONE header and differs only in the third zone:
 *
 *   • **Anchor** (fixed) — ticket title at reading size with the code demoted
 *     to a chip beside its status, then the session's own title and state
 *     underneath. This inverts the ROW's hierarchy on purpose: a row has 240px
 *     and must lead with the session, a card has 380px and can afford to lead
 *     with the thing the person actually forgot. The data is already on the
 *     row — `ActiveSessionRow.ticket` is a whole {@link Ticket}, title, status
 *     and all — so this costs one read and no new plumbing.
 *   • **Scope** (fixed) — the one durable sentence saying what this session
 *     was sent to do. It never churns, which is exactly why it belongs in a
 *     surface read in half a second.
 *   • **State** (the variable) — the only zone the variants disagree about.
 *
 * ── THE THREE BODIES ──────────────────────────────────────────────────────
 *   • **1 · Errand** — content-adaptive. A waiting session draws its decision
 *     and nothing else; a working one draws its current step and last moves; a
 *     finished one draws its outcome brief. The claim: a peek's shape should
 *     follow the only question worth asking about that state.
 *   • **2 · Brief** — uniform. Always one generated sentence, then two delta
 *     lines, then the decision if there is one. The claim: a predictable shape
 *     is worth more than a fitted one, because the eye learns where to land.
 *   • **3 · Glance** — minimal. Anchor, scope, one state sentence, and for a
 *     decision only its existence and shape. Everything else is one rung up.
 *     The claim: the card's job is to let you SKIP opening things, and a card
 *     that tries to be the chat has already lost.
 *
 * ── THE LADDER (and why rung 2 already exists) ────────────────────────────
 * `SubagentPeekDialog` (VC-269) is already exactly the second rung: a modal
 * over the current surface, read-only transcript, "Open as tab" to promote.
 * It is written against `IslandAgent` — `{id, label, state, promoted}` — which
 * a sidebar row maps onto in four lines, so this is reuse rather than a new
 * surface. That gives three rungs at three costs:
 *
 *       hover (0ms, free)  →  the card: is it mine to deal with?
 *       click "Look"       →  the dialog: the whole transcript, read-only
 *       "Open as tab"      →  full promotion, the way it works today
 *
 * The card is drawn here for real; the dialog is a GEOMETRY MOCK at the real
 * component's size (`h-[70vh] max-w-3xl`, title row, promote button), because
 * mounting the real one needs a live session client and the lab has no bridge.
 * Production reuses the component; this scratch only has to prove the rung
 * feels right. Note the card never steals focus and the row still navigates on
 * click — the ladder hangs off the CARD, not off the row.
 *
 * ── WHAT A SUMMARY IS FOR, AND WHEN IT IS A LIE ───────────────────────────
 * A generated sentence is only safe when the thing it summarizes has STOPPED
 * MOVING. So:
 *
 *   • **finished** → brief, generated once at turn end and frozen. This is
 *     also the answer to the long-final-message problem: agents write a wall
 *     of text before they stop, and rendering it verbatim in a 380px card is
 *     useless. Summarize it at the moment it lands (the `auto-title.ts`
 *     precedent: `completeUtility`, cheapest model, fire-and-forget, failure
 *     keeps the fallback) and the card shows three lines instead of thirty.
 *     Because the turn is over, the brief can never go stale.
 *   • **working** → NO summary. Anything generated mid-turn is stale the
 *     instant the agent does the next thing, and a confidently stale sentence
 *     is worse than no sentence. Show the live step instead; it is free.
 *   • **waiting** → NEVER summarize. You do not paraphrase a question you are
 *     asking someone to answer.
 *
 * Variant 2 breaks that rule on purpose — it summarizes working sessions too —
 * so the cost of the uniform shape is visible rather than argued about.
 *
 * ── THE TRUNCATION SAFETY RULE ────────────────────────────────────────────
 * Turn `Question` to `long` and hover the VLT-14 row. A real `ask_user` can
 * carry several paragraphs and six options with a line of description each;
 * none of that fits in 380px. The rule every variant obeys: **a peek may
 * truncate what it SHOWS, but it may never offer a decision it had to
 * truncate.** A clipped option list is a misinformed click, and an
 * irreversible one. When the decision does not fit, the card says so and
 * hands off to the dialog, where the whole thing is legible.
 *
 * ── WHAT IS REAL HERE AND WHAT IS NOT ─────────────────────────────────────
 * REAL: the rows, the band membership and cleanup rules
 * (`buildActiveSessionListing` over the lab's measured `sessionListingInput`),
 * the ticket records behind the anchor, the rail's `ListRow`, the board cards
 * the card floats over, the shipped {@link InteractionCard}, every token.
 *
 * NOT REAL: the peek CONTENT ({@link SUBJECTS}) — deliberately, because what a
 * peek should contain is the thing under review, and a live read would have us
 * judging latency instead of shape.
 *
 * ── THE ORDER SWITCH ──────────────────────────────────────────────────────
 * Set `Activity: live` with `Order: recency` and try to hover a working row:
 * it walks out from under the pointer, because the shipped comparator
 * (`active-session-listing.ts`: `a.group - b.group || b.recency - a.recency`)
 * keys on `lastActivityAt`, which every tool call bumps. `promotion` is the
 * rule this ticket lands: a row rises when it ENTERS an active state and holds
 * rank until it leaves one. Applied here over the built band rather than in
 * the builder — the real change belongs in the pure model with its own tests.
 */
import * as React from "react";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { ChatCircleIcon } from "@phosphor-icons/react/dist/csr/ChatCircle";
import { SparkleIcon } from "@phosphor-icons/react/dist/csr/Sparkle";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { TICKET_STATUS_LABELS, type RendererSessionInteraction, type Ticket } from "@volli/shared";

import { TicketCardContent } from "@renderer/components/board/ticket-card";
import { InteractionCard } from "@renderer/components/chat/interaction-ui";
import {
  buildActiveSessionListing,
  type ActiveSessionRow,
  type PreviousSessionRow,
} from "@renderer/components/sidebar/active-session-listing";
import { SessionBandHeader } from "@renderer/components/sidebar/session-band-header";
import { ActiveBandRow, PreviousBandRow } from "@renderer/components/sidebar/session-band-row";
import { Button } from "@renderer/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@renderer/components/ui/dialog";
import { ListRow } from "@renderer/components/ui/list-row";
import {
  Sidebar,
  SidebarGroup,
  SidebarMenu,
  SidebarProvider,
} from "@renderer/components/ui/sidebar";
import { StatusDot, type StatusDotState } from "@renderer/components/ui/status-dot";
import { cn } from "@renderer/lib/utils";

import { labels, NOW, project, sessionListingInput, ticketById } from "../fixtures";
import { appApi, seedApp } from "../seed";

export const title = "Session hover-peek (VC-30)";
export const note = "Three peek bodies over the real bands, plus the promote-to-dialog ladder";
export const viewport = "window";
export const seed = seedApp;
export const api = appApi;

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/* ------------------------------------------------------------------ content */

interface PeekStep {
  ageMs: number;
  text: string;
  tool?: string;
}

/** A step's key: its age is unique within a subject, so no index is needed. */
function stepKey(step: PeekStep): string {
  return `${step.ageMs}:${step.text.slice(0, 12)}`;
}

/**
 * What one row's peek knows.
 *
 * The split between `scope`, `brief` and `step` is the whole design: `scope`
 * is durable and set at birth, `brief` is frozen at turn end, `step` is live
 * and never summarized. Nothing here is both generated and moving.
 */
interface PeekSubject {
  kind: "chat" | "terminal";
  /** What this Session was sent to do. Durable — the kickoff, or the delegated task. */
  scope?: string;
  /** The live step, for a WORKING session only. Never generated, never cached. */
  step?: string;
  /** Recent moves, newest last. The delta a working session is judged by. */
  steps?: readonly PeekStep[];
  /** In-flight assistant text. */
  streaming?: string;
  /**
   * The outcome brief — generated ONCE at turn end from the final message, and
   * frozen, so it cannot go stale. Present only on a finished session.
   */
  brief?: string;
  /** What the turn actually touched; the fact that decides whether to review. */
  touched?: readonly string[];
  /**
   * The final message the brief was made from — a realistic wall of text. Only
   * the dialog ever draws it; that contrast is the point (Q4).
   */
  finalMessage?: string;
  /** Why a broken session stopped. Never summarized — the reason IS the payload. */
  failure?: string;
  interaction?: RendererSessionInteraction;
  /** A live terminal's trailing output. */
  lines?: readonly string[];
}

function question(
  id: string,
  ask: string,
  options: readonly (readonly [string, string, string | null])[],
): RendererSessionInteraction {
  return {
    id,
    attachmentId: `att-${id}`,
    kind: "question",
    title: ask,
    detail: null,
    options: options.map(([optionId, label, description]) => ({
      id: optionId,
      label,
      description,
    })),
    multiple: false,
    native: { id: null, detail: null },
  };
}

function permission(id: string, ask: string, detail: string): RendererSessionInteraction {
  return {
    id,
    attachmentId: `att-${id}`,
    kind: "permission",
    title: ask,
    detail,
    options: [
      { id: "allow", label: "Allow", description: null },
      { id: "allow-always", label: "Allow for this session", description: null },
      { id: "reject", label: "Reject", description: null },
    ],
    multiple: false,
    native: { id: null, detail: null },
  };
}

/** The short question — one line, three plain options. Answerable from a glance. */
const SHORT_QUESTION = question(
  "ask-14a",
  "Repaint the gutter on every scroll frame, or flush on scroll end?",
  [
    ["per-frame", "Repaint per frame", null],
    ["flush", "Flush on scroll end", null],
    ["measure", "Measure both first", null],
  ],
);

/**
 * The long question — several sentences and five options that each need a line
 * of their own. Nothing about this fits 380px, and the card must refuse to
 * offer it rather than clip it (see the truncation rule in the module doc).
 */
const LONG_QUESTION = question(
  "ask-14a",
  "The decoration cache is rebuilt on every scroll frame because the debounce drops its trailing call, and there are three places that could own the fix: the gutter's own cache, the scroll observer that feeds it, or the editor's decoration provider upstream of both. Each one trades correctness against frame cost differently, and two of them change behaviour for extensions that subscribe to decoration events. How do you want this fixed?",
  [
    [
      "per-frame",
      "Repaint per frame in the gutter",
      "Always correct, costs ~2ms per frame on a 4k-line file, and no extension sees a change.",
    ],
    [
      "flush",
      "Keep the debounce, flush on scroll end",
      "Cheapest option; leaves exactly one stale frame at the 16ms boundary, which is visible on a trackpad fling.",
    ],
    [
      "observer",
      "Move the trailing call into the scroll observer",
      "Fixes it for every consumer at once, but the observer currently has no notion of decoration lifetimes and would need one.",
    ],
    [
      "provider",
      "Fix it in the decoration provider upstream",
      "The most correct place and the largest change; alters the event ordering that two extensions already depend on.",
    ],
    [
      "measure",
      "Measure all three before choosing",
      "Costs a round trip and a benchmark harness before anything changes at all.",
    ],
  ],
);

/**
 * The corpus, keyed by the listing row's own id (`chat:<id>`, `session:<tabId>`).
 *
 * Uneven on purpose: two rows are waiting on a human, one is working with text
 * streaming, one is titled "Chat" so only its scope identifies it, one has
 * finished with a wall of text that only a brief can compress, and one is
 * broken.
 */
const SUBJECTS: Readonly<Record<string, PeekSubject>> = {
  // WAITING on a question — the errand the feature exists for.
  "chat:chat-14a": {
    kind: "chat",
    scope: "Find why inline diff decorations disappear during a fast scroll.",
    steps: [
      { ageMs: 5 * MINUTE, text: "Read the gutter's decoration cache", tool: "read" },
      { ageMs: 3 * MINUTE, text: "The 16ms debounce drops the trailing call", tool: "grep" },
      { ageMs: 2 * MINUTE, text: "Two fixes, and they disagree about frame cost" },
    ],
    interaction: SHORT_QUESTION,
  },
  // WAITING on a permission — same card, other vocabulary, and always short.
  "chat:chat-11a": {
    kind: "chat",
    scope: "Choose the seed a split pane resumes from after a relaunch.",
    steps: [
      { ageMs: 12 * MINUTE, text: "Only the root pane has a durable id", tool: "read" },
      { ageMs: 9 * MINUTE, text: "Ready to write the resume seed" },
    ],
    interaction: permission(
      "perm-11a",
      "Write to session-split-layout.tsx?",
      "apps/desktop/src/renderer/src/components/sessions/session-split-layout.tsx",
    ),
  },
  // WORKING, and titled "Chat" — 45% of the real corpus (VC-69's count). The
  // scope line is the ONLY thing that says which chat this is.
  "chat:chat-12a": {
    kind: "chat",
    scope: "Why does the composer lose its draft when I switch projects?",
    step: "Reading how chat-drafts keys its entries",
    steps: [
      { ageMs: 4 * MINUTE, text: "Found the draft map", tool: "grep" },
      { ageMs: 3 * MINUTE, text: "Keyed by ticket id alone", tool: "read" },
    ],
    streaming: "Two projects holding the same ticket number collide on one key, so the",
  },
  // FINISHED with a wall of text. The brief is the entire argument for Q4.
  "chat:chat-10a": {
    kind: "chat",
    scope: "Summarize the hover-state regression on the list rows.",
    brief:
      "Fixed. The hover fill was on the target, not the shell, so it un-tinted over the row's actions. Tests pass.",
    touched: ["list-row.tsx", "list-row.test.tsx"],
    finalMessage:
      "I've finished tracing and fixing the hover-state regression. The root cause was that the hover fill was being applied to the interactive target element rather than to the row shell that wraps it. Because the trailing actions are siblings of the target rather than children, the tinted background stopped at the target's boundary, which read as the row un-tinting wherever an action button sat — most visibly on rows with a trailing menu, and not at all on rows without one, which is why the earlier report looked intermittent.\n\nThe fix moves the fill to the shell and makes the target transparent, so the tint spans the whole row regardless of what is in the trailing slot. I also removed the `group-hover:` variant on the actions themselves, which was compensating for the old behaviour and would have double-tinted once the shell took over.\n\nI added a regression test that asserts the tint is present on the shell and absent on the target, and confirmed it fails against the previous implementation. The full suite passes: 34 files, 212 tests. No other component reads the class I moved, so the blast radius is this row only.",
  },
  // FINISHED and clean — nothing to review. The quietest a peek ever gets.
  "chat:chat-1a": {
    kind: "chat",
    scope: "Confirm the old migration path has no callers left.",
    brief: "Confirmed unreferenced. No callers outside its own tests; safe to delete.",
    touched: [],
    finalMessage:
      "I checked every reference to the legacy migration path. It is imported in exactly one place — its own test file — and nothing in the application or the packages calls it. It is safe to delete along with the test. I have not deleted anything, since you only asked me to confirm.",
  },
  // BROKEN. The reason is the payload; there is nothing to summarize.
  "chat:chat-9a": {
    kind: "chat",
    scope: "Compare per-project and global harness defaults.",
    failure: "Turn ended without a reply — the executor exited while the model was streaming.",
    steps: [
      { ageMs: 40 * MINUTE, text: "Read the settings model", tool: "read" },
      { ageMs: 32 * MINUTE, text: "Per-project overrides global", tool: "read" },
      { ageMs: 25 * MINUTE, text: "Found a third path that writes neither", tool: "grep" },
    ],
  },
  // Ticketless and working — the anchor has no ticket to lead with.
  "chat:chat-scratch-a": {
    kind: "chat",
    scope: "Scan the backlog and say what has gone stale.",
    step: "Reading 41 tickets",
    steps: [{ ageMs: 8 * MINUTE, text: "Listed the backlog", tool: "bash" }],
    streaming: "Eleven tickets have had no comment in 30 days. Of those, four are already",
  },
  // Live terminals — plain trailing output, never a second terminal renderer.
  "session:ses-14b": {
    kind: "terminal",
    scope: "Watch mode for the sidebar suite.",
    lines: [
      "  ✓ sidebar/active-session-listing.test.ts (34)",
      "  ✓ sidebar/session-band-row.test.tsx (12)",
      "  ❯ ticket/ticket-rail.test.tsx (8)",
      "    × keeps the rail width across a reload",
      "",
      "  Test Files  1 failed | 2 passed (3)",
    ],
  },
  "session:ses-12b": {
    kind: "terminal",
    scope: "Typecheck on demand.",
    lines: [
      "$ pnpm typecheck",
      "packages/session-engine/src/transcript.ts:212:7 - error TS2322:",
      "  Type 'string | null' is not assignable to type 'string'.",
      "",
      "Found 1 error in 1 file.",
    ],
  },
  "session:ses-11b": {
    kind: "terminal",
    scope: "Scratch shell in the worktree.",
    lines: [
      "$ git status --short",
      " M renderer/src/components/sessions/session-split-layout.tsx",
      "?? renderer/lab/scratches/session-peek.tsx",
    ],
  },
};

/** Rows with no fixture still peek — an anchor-only card is the honest floor. */
const EMPTY_SUBJECT: PeekSubject = { kind: "chat" };

/* ------------------------------------------------------------------- the box */

const PEEK_WIDTH = 380;
/** Nothing may push the card past this. A hover card that scrolls is a trap. */
const PEEK_MAX_HEIGHT = "60vh";

type PeekSide = "right" | "left";

interface PeekAnchor {
  id: string;
  top: number;
  edge: number;
  side: PeekSide;
}

function peekPosition(anchor: PeekAnchor): { left: number; top: number } {
  const left = anchor.side === "right" ? anchor.edge + 8 : anchor.edge - PEEK_WIDTH - 8;
  return { left, top: Math.max(8, anchor.top - 6) };
}

const PEEK_SHELL =
  "pointer-events-auto flex flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-overlay";

/* --------------------------------------------------------------- the anchor */

/**
 * Zone 1, identical in all three variants: which ticket, what stage, which
 * session, what state.
 *
 * The ticket TITLE leads and the code is demoted to a chip beside its status.
 * A row has to lead with the session because it has 240px and the session is
 * what you clicked; a card has 380px and can lead with the thing that actually
 * fell out of the person's head. For a ticketless Session the session's own
 * title takes the lead slot, since there is nothing above it.
 */
function PeekAnchorHeader({ row }: { row: PeekRow }) {
  return (
    <div className="flex flex-col gap-1.5 px-3 pt-3 pb-2">
      <div className="flex items-center gap-1.5">
        <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-label text-muted-foreground">
          {row.identity}
        </span>
        {row.ticketStatus === null ? null : (
          <span className="text-label text-muted-foreground">{row.ticketStatus}</span>
        )}
      </div>
      <p className="line-clamp-2 text-ui font-medium leading-snug text-foreground">{row.lead}</p>
      <div className="flex items-center gap-1.5 text-label text-muted-foreground">
        <StatusDot state={row.state} />
        <span className="min-w-0 truncate">{row.sub}</span>
        <span aria-hidden>·</span>
        <span className="shrink-0">{row.stateLine}</span>
      </div>
    </div>
  );
}

/** Zone 2: the durable errand. Never churns, so it is safe to read at a glance. */
function PeekScope({ scope }: { scope: string | undefined }) {
  if (scope === undefined) return null;
  return (
    <div className="mx-3 mb-2 border-l-2 border-border pl-2">
      <p className="line-clamp-2 text-label leading-snug text-muted-foreground">{scope}</p>
    </div>
  );
}

/** The foot: the two rungs up the ladder. */
function PeekFoot({ onLook }: { onLook: () => void }) {
  return (
    <div className="mt-auto flex items-center gap-1 border-t border-border px-2 py-1.5">
      <button
        type="button"
        onClick={onLook}
        className="rounded px-1.5 py-0.5 text-label text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        Look
      </button>
      <span className="ml-auto flex items-center gap-1 text-label text-muted-foreground">
        <ArrowSquareOutIcon className="size-3" />
        Open
      </span>
    </div>
  );
}

/* ---------------------------------------------------------------- the zones */

/** One recent move. Dense, past tense, one line, never wrapped. */
function StepLine({ step }: { step: PeekStep }) {
  return (
    <li className="flex min-w-0 items-baseline gap-1.5">
      <span className="min-w-0 flex-1 truncate text-label text-muted-foreground">{step.text}</span>
      {step.tool === undefined ? null : (
        <span className="shrink-0 rounded bg-muted px-1 font-mono text-label text-muted-foreground">
          {step.tool}
        </span>
      )}
    </li>
  );
}

/** What a WORKING session shows: the live step, the last moves, the live text. */
function WorkingZone({ subject, steps = 2 }: { subject: PeekSubject; steps?: number }) {
  const recent = (subject.steps ?? []).slice(-steps);
  return (
    <div className="flex flex-col gap-1.5 px-3 pb-2">
      {subject.step === undefined ? null : (
        <p className="flex items-center gap-1.5 text-ui text-foreground">
          <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary" aria-hidden />
          <span className="min-w-0 truncate">{subject.step}</span>
        </p>
      )}
      {recent.length === 0 ? null : (
        <ul className="flex flex-col gap-0.5">
          {recent.map((step) => (
            <StepLine key={stepKey(step)} step={step} />
          ))}
        </ul>
      )}
      {subject.streaming === undefined ? null : (
        <p className="line-clamp-3 text-label leading-snug text-foreground/80">
          {subject.streaming}
          <span className="ml-0.5 inline-block h-3 w-1 translate-y-0.5 bg-foreground/60" />
        </p>
      )}
    </div>
  );
}

/**
 * What a FINISHED session shows: the frozen brief, and what it touched.
 *
 * The brief is the answer to the long-final-message problem — see the module
 * doc. `touched` is here because it is the fact that decides whether the
 * outcome needs reviewing, and it is free.
 */
function BriefZone({ subject }: { subject: PeekSubject }) {
  return (
    <div className="flex flex-col gap-1.5 px-3 pb-2">
      <p className="flex gap-1.5 text-ui leading-snug text-foreground">
        <SparkleIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0">{subject.brief}</span>
      </p>
      {subject.touched === undefined || subject.touched.length === 0 ? null : (
        <p className="flex flex-wrap gap-1">
          {subject.touched.map((file) => (
            <span
              key={file}
              className="rounded bg-muted px-1 font-mono text-label text-muted-foreground"
            >
              {file}
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

/** What a BROKEN session shows. The reason, plainly; nothing is summarized. */
function FailureZone({ subject }: { subject: PeekSubject }) {
  return (
    <div className="px-3 pb-2">
      <p className="flex gap-1.5 text-ui leading-snug text-foreground">
        <WarningIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0">{subject.failure}</span>
      </p>
    </div>
  );
}

/** A terminal's trailing output. Clipped, never wrapped — wrapping lies about columns. */
function TerminalZone({ lines }: { lines: readonly string[] }) {
  return (
    <div className="mx-3 mb-2 overflow-hidden rounded bg-muted/60 px-2 py-1.5">
      {lines.slice(-6).map((line) => (
        <p key={line} className="truncate font-mono text-label leading-snug text-muted-foreground">
          {line === "" ? "\u00a0" : line}
        </p>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------- the decision */

/**
 * Whether this decision can be rendered WHOLE at 380px.
 *
 * The rule the module doc states: a peek may truncate what it shows, but it
 * may never offer a decision it had to truncate — a clipped option list is a
 * misinformed and irreversible click. The thresholds are deliberately
 * conservative; the cost of being wrong in one direction is a wasted rung, and
 * in the other it is a bad decision made on partial information.
 */
function decisionFits(interaction: RendererSessionInteraction): boolean {
  if (interaction.title.length > 120) return false;
  if (interaction.options.length > 4) return false;
  return interaction.options.every(
    (option) => option.label.length <= 44 && (option.description?.length ?? 0) <= 72,
  );
}

/**
 * The decision, answerable inline — it has been checked to fit.
 *
 * The RECEIPT is drawn here rather than by the card, because `InteractionCard`
 * has no resolved state of its own: in the chat the harness's verdict replaces
 * it, and there is no harness here. It stays after answering by decision — a
 * peek that forgets what you just told it reads as if the answer was lost.
 */
function DecisionZone({
  subject,
  answered,
  onAnswer,
}: {
  subject: PeekSubject;
  answered: string | null;
  onAnswer: (label: string) => void;
}) {
  const interaction = subject.interaction;
  if (interaction === undefined) return null;
  if (answered !== null) {
    return (
      <div className="border-t border-border px-3 py-2">
        <p className="text-label text-muted-foreground">
          Answered <span className="text-foreground">{answered}</span>
        </p>
      </div>
    );
  }
  return (
    <div className="border-t border-border px-3 py-2">
      <InteractionCard
        interaction={interaction}
        onResolve={(submission) => {
          const [chosen] = submission.resolution.optionIds;
          const option = interaction.options.find((entry) => entry.id === chosen);
          onAnswer(option?.label ?? "Answered");
          return Promise.resolve(true);
        }}
      />
    </div>
  );
}

/**
 * The decision that does NOT fit: its shape, its gist, and the rung that can
 * actually show it. No options are drawn, because drawing four of six is how
 * someone picks the wrong one.
 */
function DecisionHandoff({ subject, onLook }: { subject: PeekSubject; onLook: () => void }) {
  const interaction = subject.interaction;
  if (interaction === undefined) return null;
  const word = interaction.kind === "permission" ? "permission" : "question";
  return (
    <div className="flex flex-col gap-1.5 border-t border-border px-3 py-2">
      <p className="text-label text-muted-foreground">
        A {word} with {interaction.options.length} options
      </p>
      <p className="line-clamp-3 text-ui leading-snug text-foreground">{interaction.title}</p>
      <button
        type="button"
        onClick={onLook}
        className="self-start rounded bg-muted px-2 py-1 text-label text-foreground transition-colors hover:bg-muted/70"
      >
        Answer in overlay →
      </button>
    </div>
  );
}

/** The decision zone, either way — every variant routes through this. */
function Decision({
  subject,
  answered,
  onAnswer,
  onLook,
}: {
  subject: PeekSubject;
  answered: string | null;
  onAnswer: (label: string) => void;
  onLook: () => void;
}) {
  const interaction = subject.interaction;
  if (interaction === undefined) return null;
  return decisionFits(interaction) ? (
    <DecisionZone subject={subject} answered={answered} onAnswer={onAnswer} />
  ) : (
    <DecisionHandoff subject={subject} onLook={onLook} />
  );
}

/* -------------------------------------------------------------- the variants */

interface VariantProps {
  row: PeekRow;
  subject: PeekSubject;
  answered: string | null;
  onAnswer: (label: string) => void;
  onLook: () => void;
}

/**
 * 1 · Errand — the body follows the state.
 *
 * A waiting session draws its decision and NOTHING else: no steps, no brief,
 * no streaming text. The claim is that when a session is blocked on you, every
 * other fact on the card is a distraction from the one action available.
 */
function ErrandPeek({ row, subject, answered, onAnswer, onLook }: VariantProps) {
  const waiting = subject.interaction !== undefined;
  return (
    <>
      <PeekAnchorHeader row={row} />
      <PeekScope scope={subject.scope} />
      {waiting ? null : (
        <>
          {subject.lines !== undefined ? <TerminalZone lines={subject.lines} /> : null}
          {subject.failure !== undefined ? <FailureZone subject={subject} /> : null}
          {subject.brief !== undefined ? <BriefZone subject={subject} /> : null}
          {row.state === "working" ? <WorkingZone subject={subject} /> : null}
        </>
      )}
      <Decision subject={subject} answered={answered} onAnswer={onAnswer} onLook={onLook} />
      <PeekFoot onLook={onLook} />
    </>
  );
}

/**
 * 2 · Brief — one generated sentence always, whatever the state.
 *
 * Working sessions get a summary here too, which the module doc argues is a
 * lie waiting to happen. That is the point: the uniform shape's cost should be
 * visible. Hover the working rows and judge whether the predictability is
 * worth a sentence that is always one step behind.
 */
function BriefPeek({ row, subject, answered, onAnswer, onLook }: VariantProps) {
  const line =
    subject.brief ??
    subject.failure ??
    (subject.step === undefined ? undefined : `${subject.step}…`);
  return (
    <>
      <PeekAnchorHeader row={row} />
      <PeekScope scope={subject.scope} />
      {line === undefined ? null : (
        <div className="px-3 pb-2">
          <p className="flex gap-1.5 text-ui leading-snug text-foreground">
            <SparkleIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0">{line}</span>
          </p>
        </div>
      )}
      {subject.lines !== undefined ? <TerminalZone lines={subject.lines} /> : null}
      {subject.steps === undefined || subject.steps.length === 0 ? null : (
        <ul className="flex flex-col gap-0.5 px-3 pb-2">
          {subject.steps.slice(-2).map((step) => (
            <StepLine key={stepKey(step)} step={step} />
          ))}
        </ul>
      )}
      <Decision subject={subject} answered={answered} onAnswer={onAnswer} onLook={onLook} />
      <PeekFoot onLook={onLook} />
    </>
  );
}

/**
 * 3 · Glance — the smallest card that still answers "is this mine to deal with".
 *
 * One state sentence, and for a decision only its existence and shape. Never
 * answerable inline, by construction: this variant's whole claim is that the
 * card should make you SKIP opening things, and that answering is a rung up.
 */
function GlancePeek({ row, subject, onLook }: VariantProps) {
  const interaction = subject.interaction;
  const line =
    interaction !== undefined
      ? `Waiting on you — ${interaction.kind === "permission" ? "a permission" : `a question with ${interaction.options.length} options`}`
      : (subject.brief ??
        subject.failure ??
        (subject.step === undefined ? undefined : `${subject.step}…`));
  return (
    <>
      <PeekAnchorHeader row={row} />
      <PeekScope scope={subject.scope} />
      {line === undefined ? null : (
        <p className="line-clamp-3 px-3 pb-2 text-ui leading-snug text-foreground">{line}</p>
      )}
      <PeekFoot onLook={onLook} />
    </>
  );
}

const VARIANTS = [
  { key: "1", name: "Errand", Body: ErrandPeek },
  { key: "2", name: "Brief", Body: BriefPeek },
  { key: "3", name: "Glance", Body: GlancePeek },
] as const;

type VariantKey = (typeof VARIANTS)[number]["key"];

/* ----------------------------------------------------------------- the rung */

/**
 * Rung 2 — a GEOMETRY MOCK of `SubagentPeekDialog` (VC-269).
 *
 * Same box the real one draws (`h-[70vh] max-w-3xl`, a title row with the
 * state word and the promote button, a read-only body). Production reuses the
 * component itself: it is written against `IslandAgent` — `{id, label, state,
 * promoted}` — which a sidebar row maps onto directly. Mounting the real one
 * here would need a live session client, which the lab has no bridge for, and
 * the thing under review is whether the RUNG feels right, not whether the
 * transcript renders.
 *
 * The one real question this raises: the shipped dialog is read-only by
 * decision ("a peek is a look"). A long decision handed off from the card has
 * nowhere else to go, so either the dialog learns to answer, or the handoff
 * opens the session instead.
 */
function LookDialog({
  row,
  subject,
  open,
  onClose,
}: {
  row: PeekRow | null;
  subject: PeekSubject;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={open && row !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="flex h-[70vh] max-w-3xl flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
        {row === null ? null : (
          <>
            <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pr-12 pl-4">
              <DialogTitle className="min-w-0 truncate text-ui font-medium">{row.lead}</DialogTitle>
              <span className="shrink-0 text-ui text-muted-foreground">{row.stateLine}</span>
              <Button type="button" variant="ghost" size="sm" className="ml-auto shrink-0">
                <ArrowSquareOutIcon />
                Open as tab
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
              <div className="mx-auto flex max-w-2xl flex-col gap-4">
                <p className="text-label text-muted-foreground">
                  {row.identity} · {row.sub}
                </p>
                {subject.scope === undefined ? null : (
                  <p className="text-ui text-foreground">{subject.scope}</p>
                )}
                {subject.interaction === undefined ? null : (
                  <InteractionCard
                    interaction={subject.interaction}
                    onResolve={() => Promise.resolve(true)}
                  />
                )}
                {/* The wall of text the brief compressed — the Q4 contrast. */}
                {subject.finalMessage === undefined ? null : (
                  <div className="flex flex-col gap-3">
                    {subject.finalMessage.split("\n\n").map((para) => (
                      <p
                        key={para.slice(0, 24)}
                        className="text-ui leading-relaxed text-foreground"
                      >
                        {para}
                      </p>
                    ))}
                  </div>
                )}
                {subject.lines === undefined ? null : (
                  <pre className="overflow-x-auto rounded bg-muted px-3 py-2 font-mono text-label text-muted-foreground">
                    {subject.lines.join("\n")}
                  </pre>
                )}
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------------------------------------- hover model */

/**
 * Instant open, with the two gestures that must never open a card.
 *
 * Opening is 0ms by decision (the Chrome tab-peek feel). Closing keeps a 120ms
 * grace corridor so the pointer can cross the gap from row to card without the
 * card going out from under it. `pointerdown` closes and suppresses until the
 * pointer leaves the row: session rows are native drag sources
 * (`split-drag-source.tsx`), and a card opening under a drag is a card the
 * drag tears through. `edge-reveal.ts` made the same call for the same reason.
 */
function useHoverPeek() {
  const [anchor, setAnchor] = React.useState<PeekAnchor | null>(null);
  const [held, setHeld] = React.useState(false);
  const closeTimer = React.useRef<number | null>(null);
  const suppressed = React.useRef(false);

  const clearTimers = React.useCallback(() => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);

  const open = React.useCallback(
    (next: PeekAnchor) => {
      if (suppressed.current) return;
      clearTimers();
      setAnchor(next);
    },
    [clearTimers],
  );

  const close = React.useCallback(
    (immediate = false) => {
      clearTimers();
      // Held means something inside the card has focus — a half-made decision
      // must not be thrown away because the pointer wandered.
      if (held && !immediate) return;
      if (immediate) {
        setAnchor(null);
        return;
      }
      closeTimer.current = window.setTimeout(() => setAnchor(null), 120);
    },
    [clearTimers, held],
  );

  const suppress = React.useCallback(() => {
    suppressed.current = true;
    clearTimers();
    setAnchor(null);
  }, [clearTimers]);

  const release = React.useCallback(() => {
    suppressed.current = false;
  }, []);

  React.useEffect(() => clearTimers, [clearTimers]);

  return { anchor, open, close, suppress, release, held, setHeld };
}

/* ------------------------------------------------------------------- stage */

/** Everything the anchor needs, from whichever list the row came from. */
interface PeekRow {
  id: string;
  /** The headline: the ticket's title, or the session's own when there is no ticket. */
  lead: string;
  /** The line under it: the session's title, or its source when that IS the lead. */
  sub: string;
  /** The ticket chip, or the stand-in for a Session that has none. */
  identity: string;
  /** Where the ticket stands on the board; `null` for a ticketless Session. */
  ticketStatus: string | null;
  state: StatusDotState;
  stateLine: string;
}

function ticketChip(ticket: Ticket | null): string {
  return ticket === null ? "No ticket" : `${project.ticketPrefix}-${ticket.ticketNumber}`;
}

/** "What stage is it at" — the board's own word, not the raw status id. */
function ticketStage(ticket: Ticket | null): string | null {
  return ticket === null ? null : TICKET_STATUS_LABELS[ticket.status];
}

function activePeekRow(row: ActiveSessionRow): PeekRow {
  const needsYou = row.attention !== null || row.activity === "waiting";
  return {
    id: row.id,
    lead: row.ticket?.title ?? row.title,
    sub: row.ticket === null ? row.source : row.title,
    identity: ticketChip(row.ticket),
    ticketStatus: ticketStage(row.ticket),
    state: needsYou ? "waiting" : row.activity,
    stateLine: needsYou ? "Waiting for you" : row.activity === "working" ? "Working" : "Idle",
  };
}

function previousPeekRow(row: PreviousSessionRow): PeekRow {
  return {
    id: row.id,
    lead: row.ticket?.title ?? row.title,
    sub: row.ticket === null ? row.kind : row.title,
    identity: ticketChip(row.ticket),
    ticketStatus: ticketStage(row.ticket),
    state: "exited",
    stateLine: "Ended",
  };
}

/**
 * Which row the pointer is over, without wrapping rows in extra elements.
 *
 * The band's rows are `<li>` children of a `<ul>` the sidebar primitive owns,
 * so a wrapper div per row would be invalid markup inside a list. Resolving by
 * index off the closest `<li>` keeps the real DOM the real DOM.
 */
function useRowPointer(
  ids: readonly string[],
  side: PeekSide,
  peek: ReturnType<typeof useHoverPeek>,
) {
  const ref = React.useRef<HTMLUListElement>(null);

  const onPointerMove = (event: React.PointerEvent<HTMLUListElement>) => {
    const list = ref.current;
    if (list === null) return;
    const target = event.target as HTMLElement;
    const item = target.closest("li");
    if (item === null || item.parentElement !== list) return;
    const index = Array.prototype.indexOf.call(list.children, item);
    const id = ids[index];
    if (id === undefined) return;
    const rect = item.getBoundingClientRect();
    peek.open({ id, top: rect.top, edge: side === "right" ? rect.right : rect.left, side });
  };

  return {
    ref,
    onPointerMove,
    onPointerLeave: () => {
      peek.release();
      peek.close();
    },
    onPointerDown: peek.suppress,
  };
}

/**
 * The Active band under one of the two ordering rules.
 *
 * `recency` is the shipped comparator's key — `lastActivityAt`, which every
 * tool call bumps. `promotion` is the rule this ticket lands: the instant a
 * row last ENTERED an active state, which nothing but a state change moves.
 */
type OrderRule = "recency" | "promotion";

function orderActive(
  rows: readonly ActiveSessionRow[],
  rule: OrderRule,
  recency: Readonly<Record<string, number>>,
  promotedAt: Readonly<Record<string, number>>,
): readonly ActiveSessionRow[] {
  const key = rule === "recency" ? recency : promotedAt;
  return rows.toSorted(
    (a, b) => activeGroup(a) - activeGroup(b) || (key[b.id] ?? 0) - (key[a.id] ?? 0),
  );
}

/** The band's three tiers, unchanged by the switch — only the within-tier key moves. */
function activeGroup(row: ActiveSessionRow): number {
  return row.attention !== null || row.activity === "waiting"
    ? 0
    : row.activity === "working"
      ? 1
      : 2;
}

export default function SessionPeekScratch() {
  const [variant, setVariant] = React.useState<VariantKey>("1");
  const [rule, setRule] = React.useState<OrderRule>("promotion");
  const [live, setLive] = React.useState(false);
  const [longQuestion, setLongQuestion] = React.useState(false);
  const [answered, setAnswered] = React.useState<Readonly<Record<string, string>>>({});
  const [looking, setLooking] = React.useState<string | null>(null);
  const reducedMotion = useReducedMotion() ?? false;

  const listing = React.useMemo(
    () => buildActiveSessionListing({ ...sessionListingInput, now: NOW }),
    [],
  );

  // The two sort keys, kept apart so the switch is a real comparison.
  const [recency, setRecency] = React.useState<Readonly<Record<string, number>>>(() =>
    Object.fromEntries(listing.active.map((row) => [row.id, row.lastActivityAt ?? 0])),
  );
  const [promotedAt] = React.useState<Readonly<Record<string, number>>>(() =>
    Object.fromEntries(listing.active.map((row) => [row.id, row.lastActivityAt ?? 0])),
  );

  /** Simulated agent output: each tick bumps ONE working row, as a tool call does. */
  React.useEffect(() => {
    if (!live) return;
    const working = listing.active.filter(
      (row) => row.attention === null && row.activity === "working",
    );
    if (working.length === 0) return;
    const timer = window.setInterval(() => {
      const row = working[Math.floor(Math.random() * working.length)];
      if (row === undefined) return;
      setRecency((current) => ({ ...current, [row.id]: Date.now() }));
    }, 1100);
    return () => window.clearInterval(timer);
  }, [live, listing.active]);

  const active = React.useMemo(
    () => orderActive(listing.active, rule, recency, promotedAt),
    [listing.active, rule, recency, promotedAt],
  );

  const peek = useHoverPeek();
  const activeIds = active.map((row) => row.id);
  const previous = listing.previous.slice(0, 8);
  const previousIds = previous.map((row) => row.id);
  const rail = active.slice(0, 4);
  const railIds = rail.map((row) => `rail:${row.id}`);

  const sidebarPointer = useRowPointer(activeIds, "right", peek);
  const previousPointer = useRowPointer(previousIds, "right", peek);
  const railPointer = useRowPointer(railIds, "left", peek);

  /**
   * The native `title` on every shipped row, removed.
   *
   * Two hovers describing the same row at two different delays is a fight, and
   * leaving it in would have us judging the peek against a tooltip the real
   * feature deletes. The app does this by not passing `title` at all.
   */
  const stageRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    for (const node of stageRef.current?.querySelectorAll("[title]") ?? []) {
      node.removeAttribute("title");
    }
  });

  const rowsById = React.useMemo(() => {
    const map = new Map<string, PeekRow>();
    for (const row of active) {
      const peekRow = activePeekRow(row);
      map.set(row.id, peekRow);
      map.set(`rail:${row.id}`, peekRow);
    }
    for (const row of listing.previous) map.set(row.id, previousPeekRow(row));
    return map;
  }, [active, listing.previous]);

  const subjectOf = React.useCallback(
    (id: string): PeekSubject => {
      const key = id.replace(/^rail:/, "");
      const base = SUBJECTS[key] ?? EMPTY_SUBJECT;
      // The question-size switch, applied to the one flagship waiting row.
      if (key === "chat:chat-14a" && longQuestion) {
        return { ...base, interaction: LONG_QUESTION };
      }
      return base;
    },
    [longQuestion],
  );

  const anchor = peek.anchor;
  const peekRow = anchor === null ? null : (rowsById.get(anchor.id) ?? null);
  const subjectKey = anchor === null ? "" : anchor.id.replace(/^rail:/, "");
  const subject = anchor === null ? EMPTY_SUBJECT : subjectOf(anchor.id);
  const Body = VARIANTS.find((entry) => entry.key === variant)?.Body ?? ErrandPeek;
  const position = anchor === null ? null : peekPosition(anchor);

  const lookingRow = looking === null ? null : (rowsById.get(looking) ?? null);
  const lookingSubject = looking === null ? EMPTY_SUBJECT : subjectOf(looking);

  return (
    <div ref={stageRef} className="flex h-svh w-full bg-background">
      {/* ---------------------------------------------------- left sidebar */}
      <SidebarProvider
        className="min-h-0 w-fit"
        style={{ "--sidebar-width": "264px" } as React.CSSProperties}
      >
        <Sidebar collapsible="none" className="w-(--sidebar-width) border-r border-border py-2">
          <SidebarGroup className="gap-1 py-0">
            <SessionBandHeader label="Active" count={active.length} />
            <SidebarMenu {...sidebarPointer}>
              {active.map((row) => (
                <ActiveBandRow
                  key={row.id}
                  row={row}
                  projectId={project.id}
                  ticketPrefix={project.ticketPrefix}
                  now={NOW}
                  selected={false}
                  onSelect={() => undefined}
                />
              ))}
            </SidebarMenu>
          </SidebarGroup>
          <SidebarGroup className="mt-2 gap-1 py-0">
            <SessionBandHeader label="Previous" count={listing.previous.length} />
            <SidebarMenu {...previousPointer}>
              {previous.map((row) => (
                <PreviousBandRow
                  key={row.id}
                  row={row}
                  projectId={project.id}
                  ticketPrefix={project.ticketPrefix}
                  now={NOW}
                  selected={false}
                  onSelect={() => undefined}
                />
              ))}
            </SidebarMenu>
          </SidebarGroup>
        </Sidebar>
      </SidebarProvider>

      {/* ------------------------------------------------------ the middle */}
      {/* Real cards, so the peek is judged over content rather than over a
          grey box: its shadow and translucency have to hold up against the
          board it covers. */}
      <div className="min-w-0 flex-1 overflow-y-auto p-6">
        <div className="flex w-72 flex-col gap-2 rounded-lg bg-muted/30 p-2">
          <TicketCardContent
            ticketPrefix={project.ticketPrefix}
            projectLabels={labels}
            ticket={ticketById("tkt-14")}
            sessionActivity="waiting"
          />
          <TicketCardContent
            ticketPrefix={project.ticketPrefix}
            projectLabels={labels}
            ticket={ticketById("tkt-12")}
            sessionActivity="working"
          />
          <TicketCardContent
            ticketPrefix={project.ticketPrefix}
            projectLabels={labels}
            ticket={ticketById("tkt-11")}
          />
          <TicketCardContent
            ticketPrefix={project.ticketPrefix}
            projectLabels={labels}
            ticket={ticketById("tkt-9")}
          />
        </div>
      </div>

      {/* ------------------------------------------------------ right rail */}
      {/* The rail draws its own rows (`ticket-sessions-panel.tsx`), and the
          peek has to open on the OTHER side there. */}
      <aside className="w-[300px] shrink-0 border-l border-border p-2">
        <p className="px-2 py-1 text-label uppercase tracking-normal text-muted-foreground">
          Sessions
        </p>
        <ul className="flex flex-col gap-1" {...railPointer}>
          {rail.map((row) => {
            const peekRowValue = activePeekRow(row);
            return (
              <li key={row.id}>
                <ListRow
                  onActivate={() => undefined}
                  leading={
                    <ChatCircleIcon
                      aria-label="Chat"
                      className="size-4 shrink-0 text-muted-foreground"
                    />
                  }
                  primary={row.title}
                  trailing={
                    <span className="flex shrink-0 items-center gap-1 text-label text-muted-foreground">
                      <StatusDot state={peekRowValue.state} />
                      {peekRowValue.stateLine}
                    </span>
                  }
                />
              </li>
            );
          })}
        </ul>
      </aside>

      {/* ------------------------------------------------------- the card */}
      <AnimatePresence>
        {anchor !== null && peekRow !== null && position !== null ? (
          <motion.div
            key="peek"
            initial={
              reducedMotion
                ? { opacity: 0 }
                : { opacity: 0, scale: 0.98, x: position.left, y: position.top }
            }
            animate={{ opacity: 1, scale: 1, x: position.left, y: position.top }}
            exit={{ opacity: 0, scale: reducedMotion ? 1 : 0.98 }}
            transition={{
              duration: reducedMotion ? 0 : 0.15,
              ease: [0.32, 0.72, 0, 1],
              // Travel between rows is the move the eye follows; opening is not.
              x: { duration: reducedMotion ? 0 : 0.15, ease: [0.32, 0.72, 0, 1] },
              y: { duration: reducedMotion ? 0 : 0.15, ease: [0.32, 0.72, 0, 1] },
            }}
            style={{
              position: "fixed",
              left: 0,
              top: 0,
              width: PEEK_WIDTH,
              maxHeight: PEEK_MAX_HEIGHT,
              zIndex: 60,
            }}
            className={PEEK_SHELL}
            onPointerEnter={() => peek.open(anchor)}
            onPointerLeave={() => peek.close()}
            onFocusCapture={() => peek.setHeld(true)}
            onBlurCapture={() => peek.setHeld(false)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                peek.setHeld(false);
                peek.close(true);
              }
            }}
          >
            <Body
              row={peekRow}
              subject={subject}
              answered={answered[subjectKey] ?? null}
              onAnswer={(label) => setAnswered((current) => ({ ...current, [subjectKey]: label }))}
              onLook={() => {
                setLooking(anchor.id);
                peek.close(true);
              }}
            />
          </motion.div>
        ) : null}
      </AnimatePresence>

      <LookDialog
        row={lookingRow}
        subject={lookingSubject}
        open={looking !== null}
        onClose={() => setLooking(null)}
      />

      {/* -------------------------------------------------------- controls */}
      <div className="fixed bottom-3 left-1/2 z-[9999] flex -translate-x-1/2 items-center gap-3 rounded-full border border-border bg-background/90 px-3 py-1.5 shadow-overlay backdrop-blur">
        <Choice<VariantKey>
          label="Body"
          value={variant}
          options={VARIANTS.map((entry) => [entry.key, `${entry.key} · ${entry.name}`] as const)}
          onChange={setVariant}
        />
        <Choice<"short" | "long">
          label="Question"
          value={longQuestion ? "long" : "short"}
          options={[
            ["short", "short"],
            ["long", "long"],
          ]}
          onChange={(next) => setLongQuestion(next === "long")}
        />
        <Choice<OrderRule>
          label="Order"
          value={rule}
          options={[
            ["recency", "recency (shipped)"],
            ["promotion", "promotion (this ticket)"],
          ]}
          onChange={setRule}
        />
        <Choice<"still" | "live">
          label="Activity"
          value={live ? "live" : "still"}
          options={[
            ["still", "still"],
            ["live", "live"],
          ]}
          onChange={(next) => setLive(next === "live")}
        />
      </div>
    </div>
  );
}

/** The lab's own control, drawn so it can never be mistaken for the design. */
function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly (readonly [T, string])[];
  onChange(next: T): void;
}) {
  return (
    <label className="flex items-center gap-1.5 text-label text-muted-foreground">
      {label}
      <div className="inline-flex rounded-full border border-border p-0.5">
        {options.map(([key, name]) => (
          <button
            key={key}
            type="button"
            aria-pressed={key === value}
            onClick={() => onChange(key)}
            className={cn(
              "rounded-full px-2 py-0.5 text-label transition-colors",
              key === value
                ? "bg-sidebar-accent-veil text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {name}
          </button>
        ))}
      </div>
    </label>
  );
}
