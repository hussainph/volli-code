/**
 * VC-30 — hover-peek for sessions in the sidebars.
 *
 * **The question: what belongs in a card you never meant to open.** A peek is
 * read in the half-second between deciding to look and deciding to switch, so
 * every variant here is a different answer to "how much is worth showing before
 * showing more is just the chat again". Four bodies over one set of real rows:
 *
 *   • **A · Tail** — `volli session peek` made visual. Header, six compact
 *     `role · line · [tool]` entries, live text at the foot. No model, maximum
 *     density, nothing inferred.
 *   • **B · Brief** — a utility-model sentence first, at reading size, with the
 *     tail folded away behind a disclosure. Tests whether one generated line
 *     beats six literal ones.
 *   • **C · Mini-plane** — the chat, small: real message bodies, the real
 *     {@link InteractionCard} at the foot. Tests whether a peek can just be the
 *     surface it is peeking at.
 *   • **D · Errand** — content-adaptive. Waiting: the question is the entire
 *     card and nothing else is drawn. Working: a two-line status strip. Tests
 *     whether a peek should be one consistent thing at all.
 *
 * ── WHAT IS REAL HERE AND WHAT IS NOT ─────────────────────────────────────
 * REAL: the rows (`ActiveBandRow`/`PreviousBandRow`), the band membership and
 * the cleanup rules (`buildActiveSessionListing` over the lab's own measured
 * `sessionListingInput`), the rail's `ListRow`, the board cards behind the
 * card, the interaction card C and D answer with, and every token the peek is
 * drawn from.
 *
 * NOT REAL: the peek CONTENT. Tails, summaries and terminal lines are fixtures
 * ({@link SUBJECTS}) — deliberately, because what a peek should contain is
 * exactly the thing under review, and wiring a live read first would have us
 * judging latency instead of shape. Two of them are dishonest on purpose: the
 * summary on `chat-10a` is stale against its own tail, and the one on
 * `chat-9a` is confidently wrong. If B only reads well when the sentence is
 * right, B is not shippable — a real utility call will be stale or wrong some
 * of the time, and the tail underneath is the only thing that catches it.
 *
 * ── THE ORDER SWITCH IS NOT A SIDE QUEST ──────────────────────────────────
 * Turn `Activity` to `live` and leave `Order` on `recency`: rows re-sort under
 * the pointer while agents work, because the shipped comparator
 * (`active-session-listing.ts`, `a.group - b.group || b.recency - a.recency`)
 * reads `lastActivityAt`, and that bumps on every tool call and every streamed
 * message. Hover a row in that state and the row you are reading walks out from
 * under the card — which is the peek's worst failure, and it is not the peek's
 * bug. Switch `Order` to `promotion` for the proposed rule: a row rises only
 * when it ENTERS an active state, and then holds its rank until it leaves one.
 * Judge every variant with that switch on `promotion`; judge whether the fix is
 * needed with it on `recency`.
 *
 * The two rules are applied HERE, over the built band, rather than in the
 * builder — the scratch's job is to make the difference feel like something,
 * and the real change belongs in the pure model with its own tests.
 *
 * ── WHAT TO ACTUALLY LOOK AT ──────────────────────────────────────────────
 *   • **Travel.** Move down the band with the card open. `Timing: warm` opens
 *     the first card after 120ms and every later one at zero while the pointer
 *     stays inside the band. `instant` is 0ms always — cross the sidebar
 *     diagonally on the way to the board and count how many cards you did not
 *     ask for. That is the whole argument for a warm window.
 *   • **The fallback-title rows.** `chat-12a` is titled "Chat", like 45% of
 *     the real corpus (VC-69's measurement). Its kickoff line is the only thing
 *     that says which chat it is — check that it reads as identity and not as
 *     another line of transcript.
 *   • **Answering without arriving.** Peek `VC-14`'s waiting chat and answer
 *     it. In C and D that is the shipped card at 380px; in A and B it is a
 *     compact strip. One of those is right and the prototype is how we find
 *     out which.
 *   • **Height.** Nothing is allowed to push the card past 60vh. Watch the
 *     long tail on `chat-9a` and the tall question on `VC-11`.
 */
import * as React from "react";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { ChatCircleIcon } from "@phosphor-icons/react/dist/csr/ChatCircle";
import { SparkleIcon } from "@phosphor-icons/react/dist/csr/Sparkle";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { UserIcon } from "@phosphor-icons/react/dist/csr/User";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { RendererSessionInteraction } from "@volli/shared";

import { TicketCardContent } from "@renderer/components/board/ticket-card";
import { InteractionCard } from "@renderer/components/chat/interaction-ui";
import {
  buildActiveSessionListing,
  type ActiveSessionRow,
  type PreviousSessionRow,
} from "@renderer/components/sidebar/active-session-listing";
import { SessionBandHeader } from "@renderer/components/sidebar/session-band-header";
import { ActiveBandRow, PreviousBandRow } from "@renderer/components/sidebar/session-band-row";
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
export const note =
  "Four peek bodies over the real bands — hover timing and band ordering drivable";
export const viewport = "window";
export const seed = seedApp;
export const api = appApi;

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/* ------------------------------------------------------------------ content */

interface PeekTailEntry {
  ageMs: number;
  role: "user" | "assistant";
  text: string;
  tools?: readonly string[];
}

/**
 * A tail entry's key. Its age is what makes it unique within one subject — the
 * fixture gives every entry a distinct one — so the list needs no synthetic id
 * and no index (which would re-key every row the moment a tail grows at the
 * head, which is exactly how a live tail grows).
 */
function tailKey(entry: PeekTailEntry): string {
  return `${entry.role}:${entry.ageMs}`;
}

interface PeekSubject {
  kind: "chat" | "terminal";
  /** The line under the title, for a Session whose title says nothing (VC-69). */
  kickoff?: string;
  /** A utility-model sentence, cached on turn settle. Null where none has run. */
  summary?: string;
  /** How stale that sentence is — the fixture lies on two rows, on purpose. */
  summaryAgeMs?: number;
  tail?: readonly PeekTailEntry[];
  /** In-flight assistant text, drawn live under the tail. */
  streaming?: string;
  interaction?: RendererSessionInteraction;
  /** A live terminal's trailing output — read from the mounted engine (Q7). */
  lines?: readonly string[];
}

/** A question exactly as `ask_user` shapes one. */
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

/** A permission, on Volli's own three ids. */
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

/**
 * What each row's peek holds. Keyed by the listing row's own id — `chat:<id>`
 * for a chat, `session:<tabId>` for a live terminal (`active-session-listing.ts`).
 *
 * The corpus is uneven on purpose: two rows are waiting on a human, two are
 * mid-turn with text streaming, one is titled "Chat" and has to be identified
 * by its kickoff alone, one has a tail long enough to test the height cap, and
 * two carry summaries that must not be trusted.
 */
const SUBJECTS: Readonly<Record<string, PeekSubject>> = {
  // Waiting on a question — the errand the whole feature exists for.
  "chat:chat-14a": {
    kind: "chat",
    summary: "Found the debounce that drops decorations; wants to know how far to take the fix.",
    summaryAgeMs: 40 * SECOND,
    tail: [
      { ageMs: 6 * MINUTE, role: "user", text: "Decorations vanish when you scroll fast." },
      {
        ageMs: 5 * MINUTE,
        role: "assistant",
        text: "Reading the gutter's decoration cache.",
        tools: ["read", "grep"],
      },
      {
        ageMs: 3 * MINUTE,
        role: "assistant",
        text: "The 16ms debounce drops the trailing call, so the last frame never repaints.",
        tools: ["read"],
      },
      {
        ageMs: 2 * MINUTE,
        role: "assistant",
        text: "Two ways to fix it and they disagree about scroll cost.",
      },
    ],
    interaction: question(
      "ask-14a",
      "Should the gutter repaint on every scroll frame, or keep the debounce and flush it on scroll end?",
      [
        ["per-frame", "Repaint per frame", "Correct always; ~2ms per frame on a long file"],
        ["flush", "Keep the debounce, flush on scroll end", "Cheaper; one stale frame at 16ms"],
        ["measure", "Measure both first", "Costs a round trip before anything changes"],
      ],
    ),
  },
  // Waiting on a permission — the same card, the other vocabulary.
  "chat:chat-11a": {
    kind: "chat",
    summary: "Ready to write the resume seed; needs permission to touch the split-pane store.",
    summaryAgeMs: 2 * MINUTE,
    tail: [
      { ageMs: 12 * MINUTE, role: "user", text: "Pick the resume seed for a split pane." },
      {
        ageMs: 9 * MINUTE,
        role: "assistant",
        text: "The root pane's record is the only one with a durable id.",
        tools: ["read"],
      },
    ],
    interaction: permission(
      "perm-11a",
      "Write to session-split-layout.tsx?",
      "apps/desktop/src/renderer/src/components/sessions/session-split-layout.tsx",
    ),
  },
  // Titled "Chat" — 45% of the real corpus. The kickoff is the only identity.
  "chat:chat-12a": {
    kind: "chat",
    kickoff: "Why does the composer lose its draft when I switch projects?",
    summary: "Tracing the draft store's project key; has not changed anything yet.",
    summaryAgeMs: 25 * SECOND,
    tail: [
      {
        ageMs: 4 * MINUTE,
        role: "user",
        text: "Why does the composer lose its draft when I switch projects?",
      },
      {
        ageMs: 3 * MINUTE,
        role: "assistant",
        text: "Looking at how chat-drafts keys its entries.",
        tools: ["grep", "read"],
      },
    ],
    streaming: "The draft map is keyed by ticket id alone, so two projects holding the same",
  },
  // A summary that is STALE against its own tail — B has to survive this.
  "chat:chat-10a": {
    kind: "chat",
    summary: "Reproducing the hover-state regression.",
    summaryAgeMs: 14 * MINUTE,
    tail: [
      { ageMs: 20 * MINUTE, role: "user", text: "Summarize the hover-state regression." },
      {
        ageMs: 15 * MINUTE,
        role: "assistant",
        text: "Reproduced it on the list rows.",
        tools: ["read"],
      },
      {
        ageMs: 6 * MINUTE,
        role: "assistant",
        text: "Fixed: the fill was on the target, not the shell, so it un-tinted over the actions.",
        tools: ["edit"],
      },
      {
        ageMs: 4 * MINUTE,
        role: "assistant",
        text: "Tests pass. Writing the commit.",
        tools: ["bash"],
      },
    ],
  },
  // A summary that is WRONG, and a tail long enough to test the height cap.
  "chat:chat-9a": {
    kind: "chat",
    summary: "Comparing harness defaults and recommending the per-project one.",
    summaryAgeMs: 90 * SECOND,
    tail: [
      {
        ageMs: 40 * MINUTE,
        role: "user",
        text: "Compare per-project and global harness defaults.",
      },
      {
        ageMs: 38 * MINUTE,
        role: "assistant",
        text: "Reading the settings model.",
        tools: ["read"],
      },
      {
        ageMs: 32 * MINUTE,
        role: "assistant",
        text: "Per-project overrides global, null means inherit.",
        tools: ["read"],
      },
      {
        ageMs: 25 * MINUTE,
        role: "assistant",
        text: "The picker writes both on the same commit.",
        tools: ["grep"],
      },
      {
        ageMs: 18 * MINUTE,
        role: "assistant",
        text: "Found a third path that writes neither.",
        tools: ["read"],
      },
      {
        ageMs: 12 * MINUTE,
        role: "assistant",
        text: "That path is dead code from the adapter registry.",
        tools: ["grep"],
      },
      {
        ageMs: 5 * MINUTE,
        role: "assistant",
        text: "Recommending neither default changes — the bug is the dead path, not the precedence.",
      },
    ],
  },
  // Ticketless, working, streaming.
  "chat:chat-scratch-a": {
    kind: "chat",
    kickoff: "Scan the backlog and tell me what is stale.",
    tail: [
      { ageMs: 8 * MINUTE, role: "user", text: "Scan the backlog and tell me what is stale." },
      { ageMs: 5 * MINUTE, role: "assistant", text: "Reading 41 tickets.", tools: ["bash"] },
    ],
    streaming: "Eleven tickets have had no comment in 30 days. Of those, four are already",
  },
  // Live terminals — plain trailing output, no second terminal renderer (Q7).
  "session:ses-14b": {
    kind: "terminal",
    lines: [
      "  ✓ src/components/sidebar/active-session-listing.test.ts (34)",
      "  ✓ src/components/sidebar/session-band-row.test.tsx (12)",
      "  ❯ src/components/ticket/ticket-rail.test.tsx (8)",
      "    ✓ renders the Now page",
      "    × keeps the rail width across a reload",
      "",
      "  Test Files  1 failed | 2 passed (3)",
    ],
  },
  "session:ses-12b": {
    kind: "terminal",
    lines: [
      "$ pnpm typecheck",
      "> tsc --noEmit -p tsconfig.json && vp run -r typecheck",
      "",
      "packages/session-engine/src/transcript.ts:212:7 - error TS2322:",
      "  Type 'string | null' is not assignable to type 'string'.",
      "",
      "Found 1 error in 1 file.",
    ],
  },
  "session:ses-11b": {
    kind: "terminal",
    lines: [
      "$ git status --short",
      " M apps/desktop/src/renderer/src/components/sessions/session-split-layout.tsx",
      "?? apps/desktop/src/renderer/lab/scratches/session-peek.tsx",
    ],
  },
};

/** Rows with no fixture still peek — a header-only card is the honest floor. */
const EMPTY_SUBJECT: PeekSubject = { kind: "chat" };

/* -------------------------------------------------------------- peek chrome */

const PEEK_WIDTH = 380;
/** Nothing may push the card past this; every body scrolls inside it instead. */
const PEEK_MAX_HEIGHT = "60vh";

/** Where the card stands relative to the row it belongs to. */
type PeekSide = "right" | "left";

interface PeekAnchor {
  id: string;
  top: number;
  /** The row's own edge — the card is placed against it by {@link peekPosition}. */
  edge: number;
  side: PeekSide;
}

function peekPosition(anchor: PeekAnchor): { left: number; top: number } {
  const left = anchor.side === "right" ? anchor.edge + 8 : anchor.edge - PEEK_WIDTH - 8;
  const maxTop = window.innerHeight - 160;
  return { left, top: Math.max(8, Math.min(anchor.top, maxTop)) };
}

/** The card's own box: the overlay tier, the popover surface, one radius. */
const PEEK_SHELL =
  "pointer-events-auto flex flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-overlay";

/**
 * The header every body shares: what this Session is, where it lives, and what
 * it is doing. It is the ONLY part of the card that is the same in all four
 * variants — if a body needs its own header, that is a finding.
 */
function PeekHeader({ row, subject }: { row: PeekRow; subject: PeekSubject }) {
  const Glyph = subject.kind === "terminal" ? TerminalWindowIcon : ChatCircleIcon;
  return (
    <div className="flex items-start gap-2 px-3 pt-3 pb-2">
      <Glyph aria-hidden weight="bold" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-ui font-medium text-foreground">{row.title}</span>
        {/* The kickoff stands in for a title that says nothing. Quiet, and
            clipped to one line: it is identity, not transcript. */}
        {subject.kickoff !== undefined ? (
          <span className="truncate text-label text-muted-foreground">{subject.kickoff}</span>
        ) : null}
        <span className="flex min-w-0 items-center gap-1 text-label text-muted-foreground">
          <span className="font-mono tracking-normal">{row.identity}</span>
          <span aria-hidden>·</span>
          <span className="truncate">{row.stateLine}</span>
        </span>
      </div>
      <StatusDot state={row.state} className="mt-1" />
    </div>
  );
}

/** The card's foot: the one door out, in every variant. */
function PeekOpen() {
  return (
    <div className="flex items-center justify-end border-t border-border/70 px-3 py-1.5">
      <span className="flex items-center gap-1 text-label text-muted-foreground">
        Open
        <ArrowSquareOutIcon aria-hidden className="size-3" />
      </span>
    </div>
  );
}

/** One transcript line, the shape `volli session peek` prints. */
function TailLine({ entry }: { entry: PeekTailEntry }) {
  const Glyph = entry.role === "user" ? UserIcon : SparkleIcon;
  return (
    <li className="flex min-w-0 items-start gap-1.5">
      <Glyph
        aria-label={entry.role === "user" ? "You" : "Agent"}
        weight="bold"
        className={cn(
          "mt-0.5 size-3 shrink-0",
          entry.role === "user" ? "text-muted-foreground" : "text-primary",
        )}
      />
      <span className="min-w-0 flex-1 text-label leading-prose text-muted-foreground">
        <span className="text-foreground">{entry.text}</span>
        {entry.tools !== undefined
          ? entry.tools.map((tool) => (
              <span
                key={tool}
                className="ml-1 rounded-sm bg-muted px-1 font-mono text-label tracking-normal"
              >
                {tool}
              </span>
            ))
          : null}
      </span>
    </li>
  );
}

/** The in-flight assistant text, with the mark that says it is still arriving. */
function StreamingLine({ text }: { text: string }) {
  return (
    <p className="text-ui leading-prose text-foreground">
      {text}
      <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse rounded-xs bg-primary align-middle" />
    </p>
  );
}

/** A terminal's trailing output. Plain mono text — never a second renderer. */
function TerminalTail({ lines }: { lines: readonly string[] }) {
  return (
    <pre className="overflow-x-auto px-3 pb-2 font-mono text-label leading-prose whitespace-pre text-muted-foreground">
      {lines.join("\n")}
    </pre>
  );
}

/**
 * The compact answer strip — A and B's alternative to mounting the real card.
 *
 * One row per option, the label alone, no descriptions and no free-text box.
 * The bet is that a peek's answer is a choice rather than a composition; the
 * moment a reader wants to explain themselves they should be in the Session.
 * If this reads as a worse question than C's, the answer is that the shipped
 * card belongs in the peek and this strip should not exist.
 */
function AnswerStrip({
  interaction,
  answered,
  onAnswer,
}: {
  interaction: RendererSessionInteraction;
  answered: string | null;
  onAnswer(label: string): void;
}) {
  if (answered !== null) {
    return (
      <div className="border-t border-border/70 px-3 py-2">
        <p className="text-label text-muted-foreground">
          Sent: <span className="text-foreground">{answered}</span>
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1 border-t border-border/70 px-3 py-2">
      <p className="text-ui leading-prose font-medium text-pretty text-foreground">
        {interaction.title}
      </p>
      <div className="mt-1 flex flex-col gap-0.5">
        {interaction.options.map((option, index) => (
          <button
            key={option.id}
            type="button"
            onClick={() => onAnswer(option.label)}
            className="flex items-center gap-2 rounded-md px-1.5 py-1 text-left text-ui text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/45"
          >
            <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-muted font-mono text-label tabular-nums">
              {index + 1}
            </span>
            <span className="min-w-0 flex-1 truncate">{option.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- variants */

interface VariantProps {
  row: PeekRow;
  subject: PeekSubject;
  answered: string | null;
  onAnswer(label: string): void;
}

/** A · Tail — the CLI peek made visual. */
function TailPeek({ row, subject, answered, onAnswer }: VariantProps) {
  const tail = subject.tail ?? [];
  return (
    <>
      <PeekHeader row={row} subject={subject} />
      {subject.lines !== undefined ? <TerminalTail lines={subject.lines} /> : null}
      {tail.length > 0 ? (
        <ul className="flex min-h-0 flex-col gap-1.5 overflow-y-auto px-3 pb-2">
          {tail.map((entry) => (
            <TailLine key={tailKey(entry)} entry={entry} />
          ))}
        </ul>
      ) : null}
      {subject.streaming !== undefined ? (
        <div className="border-t border-border/70 px-3 py-2">
          <StreamingLine text={subject.streaming} />
        </div>
      ) : null}
      {subject.interaction !== undefined ? (
        <AnswerStrip interaction={subject.interaction} answered={answered} onAnswer={onAnswer} />
      ) : null}
      <PeekOpen />
    </>
  );
}

/** B · Brief — one generated sentence, with the evidence folded away. */
function BriefPeek({ row, subject, answered, onAnswer }: VariantProps) {
  const [open, setOpen] = React.useState(false);
  const tail = subject.tail ?? [];
  return (
    <>
      <PeekHeader row={row} subject={subject} />
      {subject.summary !== undefined ? (
        <div className="px-3 pb-2">
          <p className="text-sm leading-prose text-pretty text-foreground">{subject.summary}</p>
          {/* The sentence has to date itself. A summary cached on turn settle is
              stale by design, and a reader who cannot see how stale has no way
              to know whether to trust it over the tail below. */}
          <p className="mt-1 flex items-center gap-1 text-label text-muted-foreground">
            <SparkleIcon aria-hidden weight="bold" className="size-3" />
            Summarized {formatAge(subject.summaryAgeMs ?? 0)} ago
          </p>
        </div>
      ) : (
        <p className="px-3 pb-2 text-ui text-muted-foreground">No summary yet.</p>
      )}
      {subject.lines !== undefined ? <TerminalTail lines={subject.lines} /> : null}
      {tail.length > 0 ? (
        <div className="min-h-0 overflow-y-auto border-t border-border/70">
          <button
            type="button"
            onClick={() => setOpen((shown) => !shown)}
            aria-expanded={open}
            className="flex w-full items-center gap-1 px-3 py-1.5 text-left text-label text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/45"
          >
            <CaretDownIcon
              aria-hidden
              weight="bold"
              className={cn("size-3 transition-transform", !open && "-rotate-90")}
            />
            {tail.length} messages
          </button>
          {open ? (
            <ul className="flex flex-col gap-1.5 px-3 pb-2">
              {tail.map((entry) => (
                <TailLine key={tailKey(entry)} entry={entry} />
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {subject.streaming !== undefined ? (
        <div className="border-t border-border/70 px-3 py-2">
          <StreamingLine text={subject.streaming} />
        </div>
      ) : null}
      {subject.interaction !== undefined ? (
        <AnswerStrip interaction={subject.interaction} answered={answered} onAnswer={onAnswer} />
      ) : null}
      <PeekOpen />
    </>
  );
}

/** C · Mini-plane — the chat, small, with the shipped card at the foot. */
function MiniPlanePeek({ row, subject, answered, onAnswer }: VariantProps) {
  const tail = subject.tail ?? [];
  const recent = tail.slice(-2);
  return (
    <>
      <PeekHeader row={row} subject={subject} />
      {subject.lines !== undefined ? <TerminalTail lines={subject.lines} /> : null}
      <div className="flex min-h-0 flex-col gap-2 overflow-y-auto px-3 pb-2">
        {recent.map((entry) => (
          <div
            key={tailKey(entry)}
            className={cn(
              "flex min-w-0 flex-col gap-0.5 rounded-lg px-2 py-1.5",
              entry.role === "user" ? "bg-muted/60" : "bg-transparent",
            )}
          >
            <span className="text-label text-muted-foreground">
              {entry.role === "user" ? "You" : "Agent"}
            </span>
            <p className="text-ui leading-prose text-foreground">{entry.text}</p>
          </div>
        ))}
        {subject.streaming !== undefined ? (
          <div className="px-2">
            <StreamingLine text={subject.streaming} />
          </div>
        ) : null}
      </div>
      {/* The SHIPPED card, at 380px. Whether it fits is the question this
          variant exists to answer — it was drawn for a chat plane's foot. */}
      {subject.interaction !== undefined ? (
        <div className="border-t border-border/70 p-2">
          {answered === null ? (
            <InteractionCard
              interaction={subject.interaction}
              onResolve={(submission) => {
                const id = submission.resolution.optionIds[0];
                const chosen = subject.interaction?.options.find((option) => option.id === id);
                onAnswer(chosen?.label ?? "answer");
              }}
            />
          ) : (
            <p className="px-2 py-1 text-label text-muted-foreground">
              Sent: <span className="text-foreground">{answered}</span>
            </p>
          )}
        </div>
      ) : null}
      <PeekOpen />
    </>
  );
}

/**
 * D · Errand — the card is whatever the state needs and nothing else.
 *
 * Waiting: the question, full size, alone. Working: two lines. Idle: one. The
 * bet is that a peek's job changes completely with the row's state, and that a
 * uniform card is therefore always wrong for three of the four states.
 */
function ErrandPeek({ row, subject, answered, onAnswer }: VariantProps) {
  if (subject.interaction !== undefined) {
    return (
      <>
        <div className="flex items-center gap-2 px-3 pt-3 pb-1">
          <StatusDot state="waiting" />
          <span className="min-w-0 flex-1 truncate text-label text-muted-foreground">
            {row.identity} · {row.title}
          </span>
        </div>
        {answered === null ? (
          <div className="p-2">
            <InteractionCard
              interaction={subject.interaction}
              onResolve={(submission) => {
                const id = submission.resolution.optionIds[0];
                const chosen = subject.interaction?.options.find((option) => option.id === id);
                onAnswer(chosen?.label ?? "answer");
              }}
            />
          </div>
        ) : (
          <p className="px-3 py-3 text-ui text-muted-foreground">
            Sent: <span className="text-foreground">{answered}</span>
          </p>
        )}
      </>
    );
  }
  return (
    <>
      <PeekHeader row={row} subject={subject} />
      {subject.lines !== undefined ? <TerminalTail lines={subject.lines} /> : null}
      {subject.streaming !== undefined ? (
        <div className="px-3 pb-3">
          <StreamingLine text={subject.streaming} />
        </div>
      ) : subject.summary !== undefined ? (
        <p className="px-3 pb-3 text-ui leading-prose text-muted-foreground">{subject.summary}</p>
      ) : subject.tail !== undefined && subject.tail.length > 0 ? (
        <p className="px-3 pb-3 text-ui leading-prose text-muted-foreground">
          {subject.tail[subject.tail.length - 1]?.text}
        </p>
      ) : null}
    </>
  );
}

const VARIANTS = [
  { key: "A", name: "Tail", Body: TailPeek },
  { key: "B", name: "Brief", Body: BriefPeek },
  { key: "C", name: "Mini-plane", Body: MiniPlanePeek },
  { key: "D", name: "Errand", Body: ErrandPeek },
] as const;

type VariantKey = (typeof VARIANTS)[number]["key"];

/* -------------------------------------------------------------- hover model */

type TimingKey = "instant" | "warm" | "tooltip";

const TIMING: Record<TimingKey, { open: number; warm: number; label: string }> = {
  // True zero. Cross the band on the way somewhere else and count the cards.
  instant: { open: 0, warm: 0, label: "instant · 0ms" },
  // The recommendation: perceptually instant on the row you meant, free after.
  warm: { open: 120, warm: 300, label: "warm · 120ms then 0" },
  // What the native title attribute does today, for reference.
  tooltip: { open: 500, warm: 300, label: "tooltip · 500ms" },
};

/**
 * Dwell, warm window, and the two gestures that must never open a card.
 *
 * `pointerdown` closes and arms a suppression that lasts until the pointer
 * leaves the row: session rows are native drag sources
 * (`split-drag-source.tsx`), and a card opening under a drag is a card the
 * drag tears through. `edge-reveal.ts` made the same call for the same reason.
 */
function useHoverPeek(timing: TimingKey) {
  const [anchor, setAnchor] = React.useState<PeekAnchor | null>(null);
  const [held, setHeld] = React.useState(false);
  const openTimer = React.useRef<number | null>(null);
  const closeTimer = React.useRef<number | null>(null);
  const warmUntil = React.useRef(0);
  const suppressed = React.useRef(false);

  const clearTimers = React.useCallback(() => {
    if (openTimer.current !== null) window.clearTimeout(openTimer.current);
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    openTimer.current = null;
    closeTimer.current = null;
  }, []);

  const open = React.useCallback(
    (next: PeekAnchor) => {
      if (suppressed.current) return;
      clearTimers();
      const { open: delay } = TIMING[timing];
      const warm = Date.now() < warmUntil.current;
      const wait = warm ? 0 : delay;
      if (wait === 0) {
        setAnchor(next);
        return;
      }
      openTimer.current = window.setTimeout(() => setAnchor(next), wait);
    },
    [clearTimers, timing],
  );

  const close = React.useCallback(
    (immediate = false) => {
      clearTimers();
      // Held means something inside the card has focus — a half-typed answer
      // must not be thrown away because the pointer wandered (Q3).
      if (held && !immediate) return;
      const finish = () => {
        setAnchor((current) => {
          if (current !== null) warmUntil.current = Date.now() + TIMING[timing].warm;
          return null;
        });
      };
      if (immediate) {
        finish();
        return;
      }
      // The grace corridor: the pointer is allowed to cross the gap between the
      // row and the card without the card going out from under it.
      closeTimer.current = window.setTimeout(finish, 120);
    },
    [clearTimers, held, timing],
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

/** Everything a peek's header needs from whichever list the row came from. */
interface PeekRow {
  id: string;
  title: string;
  /** The ticket id, or the globe's stand-in for a Session that has none. */
  identity: string;
  state: StatusDotState;
  stateLine: string;
}

function activePeekRow(row: ActiveSessionRow): PeekRow {
  const needsYou = row.attention !== null;
  return {
    id: row.id,
    title: row.title,
    identity:
      row.ticket === null ? "No ticket" : `${project.ticketPrefix}-${row.ticket.ticketNumber}`,
    state: needsYou ? "waiting" : row.activity,
    stateLine: needsYou ? "Waiting for you" : row.activity === "working" ? "Working" : "Idle",
  };
}

function previousPeekRow(row: PreviousSessionRow): PeekRow {
  return {
    id: row.id,
    title: row.title,
    identity:
      row.ticket === null ? "No ticket" : `${project.ticketPrefix}-${row.ticket.ticketNumber}`,
    state: "exited",
    stateLine: "Ended",
  };
}

function formatAge(ms: number): string {
  if (ms < MINUTE) return `${Math.max(1, Math.round(ms / SECOND))}s`;
  return `${Math.round(ms / MINUTE)}m`;
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
    peek.open({
      id,
      top: rect.top,
      edge: side === "right" ? rect.right : rect.left,
      side,
    });
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
 * tool call bumps. `promotion` is the proposal: the instant a row last ENTERED
 * an active state, which nothing but a state change can move.
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
  const [variant, setVariant] = React.useState<VariantKey>("A");
  const [timing, setTiming] = React.useState<TimingKey>("warm");
  const [rule, setRule] = React.useState<OrderRule>("promotion");
  const [live, setLive] = React.useState(false);
  const [answered, setAnswered] = React.useState<Readonly<Record<string, string>>>({});
  const reducedMotion = useReducedMotion() ?? false;

  const listing = React.useMemo(
    () => buildActiveSessionListing({ ...sessionListingInput, now: NOW }),
    [],
  );

  // The two sort keys, kept apart so the switch is a real comparison: `recency`
  // is bumped by simulated agent output, `promotedAt` only by a state change.
  const [recency, setRecency] = React.useState<Readonly<Record<string, number>>>(() =>
    Object.fromEntries(listing.active.map((row) => [row.id, row.lastActivityAt ?? 0])),
  );
  const [promotedAt] = React.useState<Readonly<Record<string, number>>>(() =>
    Object.fromEntries(listing.active.map((row) => [row.id, row.lastActivityAt ?? 0])),
  );

  /**
   * Simulated agent output — the thing that makes the shipped band churn. Each
   * tick bumps ONE working row's recency, exactly as a tool call does.
   */
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

  const peek = useHoverPeek(timing);
  const activeIds = active.map((row) => row.id);
  const previousIds = listing.previous.slice(0, 8).map((row) => row.id);
  const railIds = active.slice(0, 4).map((row) => `rail:${row.id}`);

  const sidebarPointer = useRowPointer(activeIds, "right", peek);
  const previousPointer = useRowPointer(previousIds, "right", peek);
  const railPointer = useRowPointer(railIds, "left", peek);

  /**
   * The native `title` on every shipped row, removed (Q10).
   *
   * Two hovers describing the same row at two different delays is a fight, and
   * leaving it in would have us judging the peek against a tooltip that the
   * real feature deletes. The app does this by not passing `title` at all.
   */
  const stageRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    for (const node of stageRef.current?.querySelectorAll("[title]") ?? []) {
      node.removeAttribute("title");
    }
  });

  const rowsById = React.useMemo(() => {
    const map = new Map<string, PeekRow>();
    for (const row of active) map.set(row.id, activePeekRow(row));
    for (const row of listing.previous) map.set(row.id, previousPeekRow(row));
    for (const row of active) {
      const rail = activePeekRow(row);
      map.set(`rail:${row.id}`, rail);
    }
    return map;
  }, [active, listing.previous]);

  const anchor = peek.anchor;
  const peekRow = anchor === null ? null : (rowsById.get(anchor.id) ?? null);
  const subjectKey = anchor === null ? "" : anchor.id.replace(/^rail:/, "");
  const subject = SUBJECTS[subjectKey] ?? EMPTY_SUBJECT;
  const Body = VARIANTS.find((entry) => entry.key === variant)?.Body ?? TailPeek;
  const position = anchor === null ? null : peekPosition(anchor);

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
              {listing.previous.slice(0, 8).map((row) => (
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
      {/* Real cards, so the card is judged over content rather than over a
          grey box: a peek's shadow and translucency have to hold up against
          the board it covers. */}
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
          peek has to open on the OTHER side there — which is the whole reason
          it is in this scratch. */}
      <aside className="w-[300px] shrink-0 border-l border-border p-2">
        <p className="px-2 py-1 text-label uppercase tracking-normal text-muted-foreground">
          Sessions
        </p>
        <ul className="flex flex-col gap-1" {...railPointer}>
          {active.slice(0, 4).map((row) => {
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
            />
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* -------------------------------------------------------- controls */}
      <div className="fixed bottom-3 left-1/2 z-[9999] flex -translate-x-1/2 items-center gap-3 rounded-full border border-border bg-background/90 px-3 py-1.5 shadow-overlay backdrop-blur">
        <Choice<VariantKey>
          label="Variant"
          value={variant}
          options={VARIANTS.map((entry) => [entry.key, `${entry.key} · ${entry.name}`] as const)}
          onChange={setVariant}
        />
        <Choice<TimingKey>
          label="Timing"
          value={timing}
          options={(Object.keys(TIMING) as TimingKey[]).map(
            (key) => [key, TIMING[key].label] as const,
          )}
          onChange={setTiming}
        />
        <Choice<OrderRule>
          label="Order"
          value={rule}
          options={[
            ["recency", "recency (shipped)"],
            ["promotion", "promotion (proposed)"],
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
