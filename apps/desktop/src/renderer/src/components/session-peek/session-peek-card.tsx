/**
 * VC-30 — the Session peek's card: what a row says when you rest on it.
 *
 * Ported from the approved lab card (`lab/session-peek/card.tsx`) with its grid
 * and its behaviour intact, and with the fixture era left behind:
 *
 *   • ONE GRID, stated once and shared with the ticket card. A 12px inset on
 *     every strip; a 24px lead column, then 8px to the text, so text starts
 *     44px in everywhere; 12px between blocks, 8px inside one and on the thin
 *     strips. Nothing in the card keeps spacing of its own.
 *   • THE ANSWER FORM IS THE SHIPPED ONE. The lab re-implemented radios, custom
 *     text and a pager; production mounts `InteractionCard`
 *     (`components/chat/interaction-ui.tsx`), which already owns multi-prompt
 *     questions, redirection, refusal and the submission latch that makes
 *     "exactly one of them happens" true (plan §1.3, §0.6).
 *   • NO UNDO, in any form (plan §3.2, amendment A4). Send is the composer's
 *     Send: one press, `Sending…`, then `Sent` for ~2s and the card closes; a
 *     failure keeps the words with a `Try again`.
 *   • A PEEK NEVER READS (D6). There is no read side effect anywhere in this
 *     file: it says `Unread` and leaves the dot alone. Only opening, replying,
 *     viewing the conversation, `U` or the row's menu clears it.
 *
 * The summary is never prose we invented: it is `peekSummaryOf` over the
 * durable tail (plan §3.1), `Summary unavailable` when the fold gave nothing
 * readable, and a count when some of the tail could not be read at all.
 */
import * as React from "react";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { CaretLeftIcon } from "@phosphor-icons/react/dist/csr/CaretLeft";
import { ChatCircleIcon } from "@phosphor-icons/react/dist/csr/ChatCircle";
import { CheckCircleIcon } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { ClockCounterClockwiseIcon } from "@phosphor-icons/react/dist/csr/ClockCounterClockwise";
import { InfoIcon } from "@phosphor-icons/react/dist/csr/Info";
import { PaperPlaneTiltIcon } from "@phosphor-icons/react/dist/csr/PaperPlaneTilt";
import { QuestionIcon } from "@phosphor-icons/react/dist/csr/Question";
import { TicketIcon } from "@phosphor-icons/react/dist/csr/Ticket";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import {
  displayTicketId,
  peekSummaryOf,
  readInteractionPrompts,
  sessionProvenanceHoverLine,
  TICKET_STATUS_LABELS,
  type SessionPeekContent,
} from "@volli/shared";
import type { InteractionSubmission } from "@volli/session-presentation";

import { InteractionCard } from "@renderer/components/chat/interaction-ui";
import { SessionGlyph } from "@renderer/components/sessions/session-glyph";
import { Button } from "@renderer/components/ui/button";
import { Skeleton } from "@renderer/components/ui/skeleton";
import { Textarea } from "@renderer/components/ui/textarea";
import { relativeTime } from "@renderer/lib/relative-time";
import { cn } from "@renderer/lib/utils";

import { PEEK_CONFIRMATION_MS } from "./peek-machine";
import type { PeekPosition } from "./peek-geometry";
import type { SessionPeekRow } from "./use-session-peek";

/* ------------------------------------------------------------- the card grid */

/** The frame both cards share: fixed, clamped by the controller, one bridge. */
export function peekFrameStyle(position: PeekPosition, width: number): React.CSSProperties {
  return {
    position: "fixed",
    left: position.left,
    top: position.top,
    width: `min(${width}px, calc(100vw - 16px))`,
    maxHeight: position.maxHeight,
    zIndex: 60,
  };
}

export const PEEK_FRAME =
  "flex flex-col overflow-hidden rounded-xl border border-border bg-popover text-ui shadow-overlay outline-none";
export const CARD_HEADER = "flex shrink-0 items-start gap-2 border-b border-border p-3";
/** The header's text column: 2px down, so a 20px first line centres on the 24px mark. */
export const CARD_HEADER_TEXT = "flex min-w-0 flex-1 flex-col gap-0.5 pt-0.5";
export const CARD_BODY =
  "flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain py-3";
/** A ghost button's icon, pulled 6px left onto the lead column's centre. */
export const GHOST_ON_LEAD = "-ml-1.5";

/** A block: its icon in the lead column on the first line of text, the text at 44px. */
export function CardBlock({
  icon,
  className,
  children,
  ...rest
}: React.HTMLAttributes<HTMLDivElement> & { icon: React.ReactNode }) {
  return (
    <div className={cn("flex items-start gap-2 px-3", className)} {...rest}>
      <span aria-hidden className="flex h-5 w-6 shrink-0 items-center justify-center">
        {icon}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/**
 * The strip a drilled card wears on top: the way back to the folder's ticket.
 *
 * It names the folder, so a card reached from one never pretends it was reached
 * from a row. On the card's grid: the crumb's glyph centres on the lead column
 * (the button's own 8px padding, pulled back 2px) and its label starts on the
 * text's 44px edge.
 */
export function FolderStrip({ ticketLabel, onBack }: { ticketLabel: string; onBack?: () => void }) {
  const crumb = "-ml-0.5 gap-3.5 px-2";
  return (
    <div
      data-peek-strip=""
      className="flex shrink-0 items-center gap-1 border-b border-border bg-muted/30 px-3 py-1 text-muted-foreground"
    >
      {onBack === undefined ? (
        <span className={cn("inline-flex h-5 items-center", crumb)}>
          <TicketIcon aria-hidden className="size-3" />
          <span className="font-mono text-label tracking-normal">{ticketLabel}</span>
        </span>
      ) : (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          aria-label={`Back to ${ticketLabel}`}
          className={crumb}
          onClick={onBack}
        >
          <CaretLeftIcon />
          <span className="font-mono text-label tracking-normal">{ticketLabel}</span>
        </Button>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- the pieces */

/** Two lines for identity; the full values stay in the conversation overlay. */
function Identity({
  row,
  age,
  pinned,
  onClose,
  onOpen,
}: {
  row: SessionPeekRow;
  age: string;
  pinned: boolean;
  onClose(): void;
  onOpen(): void;
}) {
  return (
    <header className={CARD_HEADER}>
      <SessionGlyph
        providerId={row.providerId}
        providerLabel={row.providerLabel}
        state={row.state}
        kind={row.kind}
        name={row.providerLabel}
        size="card"
        surface="popover"
      />
      <div className={CARD_HEADER_TEXT}>
        <p
          data-peek-session-title=""
          className="line-clamp-2 text-ui font-semibold text-foreground [overflow-wrap:anywhere]"
          title={row.title}
        >
          {row.title}
        </p>
        <span className="flex items-center gap-1.5 whitespace-nowrap text-ui text-muted-foreground tabular-nums">
          {row.unread ? (
            <>
              <span data-peek-unread="" className="inline-flex items-center gap-1.5 text-info">
                <span aria-hidden className="size-1.5 rounded-full bg-info" />
                Unread
              </span>
              {age === "" ? null : <span aria-hidden>·</span>}
            </>
          ) : null}
          {age === "" ? null : <span>{age}</span>}
        </span>
      </div>
      <Button size="icon-sm" variant="ghost" aria-label="Open session" onClick={onOpen}>
        <ArrowSquareOutIcon />
      </Button>
      {pinned ? (
        <Button size="icon-sm" variant="ghost" aria-label="Close reply" onClick={onClose}>
          <XIcon />
        </Button>
      ) : null}
    </header>
  );
}

function TicketContext({ row, ticketPrefix }: { row: SessionPeekRow; ticketPrefix: string }) {
  const ticket = row.ticket;
  if (ticket === null) return null;
  return (
    <CardBlock icon={<TicketIcon className="size-4 text-muted-foreground" />}>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="rounded-sm bg-muted px-1 font-mono text-label tracking-normal text-muted-foreground">
          {displayTicketId(ticketPrefix, ticket.ticketNumber)}
        </span>
        <span className="text-muted-foreground">{TICKET_STATUS_LABELS[ticket.status]}</span>
      </div>
      <p
        data-peek-ticket-title=""
        className="line-clamp-2 text-foreground [overflow-wrap:anywhere]"
        title={ticket.title}
      >
        {ticket.title}
      </p>
    </CardBlock>
  );
}

/**
 * What the row's native `title` used to carry (D1): which model or harness this
 * Session runs, and who started it. Dropping the attribute is what makes the
 * peek possible, so the card owes the reader both facts.
 */
function IdentityLine({ row }: { row: SessionPeekRow }) {
  // `ModelSelection` carries ids and a reasoning level, never a display label
  // (`@volli/shared/agent-runtime.ts`), so the model is said by its id beside
  // the vendor the mark already draws.
  const runs =
    row.model === null ? row.providerLabel : `${row.providerLabel} · ${row.model.modelId}`;
  const started = sessionProvenanceHoverLine(row.provenance);
  const line = [runs, started].filter((part) => part !== null && part !== "").join(" · ");
  if (line === "") return null;
  return (
    <CardBlock icon={<InfoIcon className="size-4 text-muted-foreground" />}>
      <p data-peek-identity="" className="text-muted-foreground [overflow-wrap:anywhere]">
        {line}
      </p>
    </CardBlock>
  );
}

function Summary({
  content,
  loading,
  failed,
}: {
  content: SessionPeekContent | null;
  loading: boolean;
  failed: boolean;
}) {
  const summary = content === null ? null : peekSummaryOf(content.entries);
  const state = loading ? "loading" : summary === null || failed ? "unavailable" : "ready";
  return (
    <CardBlock icon={<ClockCounterClockwiseIcon className="size-4 text-muted-foreground" />}>
      <div className="text-muted-foreground" data-summary-state={state} aria-busy={loading}>
        {state === "loading" ? (
          <div role="status" aria-label="Reading the session" className="flex flex-col gap-2">
            <Skeleton aria-hidden className="h-2 w-full" />
            <Skeleton aria-hidden className="h-2 w-[90%]" />
            <Skeleton aria-hidden className="h-2 w-[65%]" />
          </div>
        ) : state === "unavailable" ? (
          <p>Summary unavailable</p>
        ) : (
          <p data-peek-summary="" className="line-clamp-5 [overflow-wrap:anywhere]">
            {summary}
          </p>
        )}
      </div>
    </CardBlock>
  );
}

/* ----------------------------------------------------------------- the card */

type SendState =
  | { readonly kind: "idle" }
  | { readonly kind: "sending" }
  | { readonly kind: "sent" }
  | { readonly kind: "failed" };

export interface SessionPeekCardProps {
  row: SessionPeekRow;
  ticketPrefix: string;
  /** For the age line; the same clock the rows are drawn with. */
  now: number;
  /** `null` while the first pull is in flight. */
  content: SessionPeekContent | null;
  loading: boolean;
  failed: boolean;
  position: PeekPosition;
  cardWidth: number;
  pinned: boolean;
  /** The `← VLT-14` strip for a card reached by drilling a folder. */
  back?: { ticketLabel: string; onBack(): void };
  /** `false` for a terminal companion and for a folder drill: nobody to answer. */
  canReply: boolean;
  onPin(): void;
  onClose(): void;
  onOpen(): void;
  onViewConversation(): void;
  /** `false` when the question is no longer the one being asked (§3.3). */
  onAnswer(interactionId: string, submission: InteractionSubmission): Promise<boolean>;
  onSend(text: string): Promise<boolean>;
  /** The card's half of the row→card bridge. */
  onPointerEnter?(): void;
  onPointerLeave?(): void;
  ref?: React.Ref<HTMLDivElement>;
}

export function SessionPeekCard({
  row,
  ticketPrefix,
  now,
  content,
  loading,
  failed,
  position,
  cardWidth,
  pinned,
  back,
  canReply,
  onPin,
  onClose,
  onOpen,
  onViewConversation,
  onAnswer,
  onSend,
  onPointerEnter,
  onPointerLeave,
  ref,
}: SessionPeekCardProps): React.ReactElement {
  const [message, setMessage] = React.useState("");
  const [send, setSend] = React.useState<SendState>({ kind: "idle" });
  const [refused, setRefused] = React.useState(false);

  // A terminal companion has no transcript fold and no interactions (§3.5), so
  // its card is identity, ticket, state and `Open session` — nothing else.
  const transcript = row.kind === "chat";
  const question = transcript ? (content?.question ?? null) : null;
  const age = row.at === null ? "" : relativeTime(row.at, now);
  const unreadable = content?.unreadable ?? 0;

  /** The confirmation holds the card for ~2s, then it closes. No Undo (§3.2). */
  React.useEffect(() => {
    if (send.kind !== "sent") return;
    const timer = window.setTimeout(onClose, PEEK_CONFIRMATION_MS);
    return () => window.clearTimeout(timer);
  }, [send.kind, onClose]);

  const submitMessage = (event: React.FormEvent) => {
    event.preventDefault();
    if (message.trim() === "" || send.kind === "sending" || send.kind === "sent") return;
    setSend({ kind: "sending" });
    void onSend(message.trim()).then(
      (delivered) => setSend(delivered ? { kind: "sent" } : { kind: "failed" }),
      () => setSend({ kind: "failed" }),
    );
  };

  const answer = (submission: InteractionSubmission): Promise<boolean> => {
    if (question === null) return Promise.resolve(false);
    return onAnswer(question.id, submission).then((landed) => {
      setRefused(!landed);
      return landed;
    });
  };

  return (
    <div
      ref={ref}
      role={pinned ? "dialog" : "note"}
      aria-modal={pinned ? false : undefined}
      aria-label={
        pinned ? `${question === null ? "Message" : "Answer"} ${row.title}` : `Peek at ${row.title}`
      }
      tabIndex={pinned ? -1 : undefined}
      data-peek-card=""
      data-peek-subject="session"
      style={peekFrameStyle(position, cardWidth)}
      className={PEEK_FRAME}
      onPointerEnter={onPointerEnter}
      // Focus inside holds the card open, so a reader who has pressed into it is
      // not dropped by a stray pointer.
      onPointerLeave={(event) => {
        if (!event.currentTarget.contains(document.activeElement)) onPointerLeave?.();
      }}
      onFocusCapture={onPointerEnter}
      onBlurCapture={(event) => {
        if (
          !(event.relatedTarget instanceof Node) ||
          !event.currentTarget.contains(event.relatedTarget)
        )
          onPointerLeave?.();
      }}
    >
      {back === undefined ? null : (
        <FolderStrip ticketLabel={back.ticketLabel} onBack={back.onBack} />
      )}
      <Identity row={row} age={age} pinned={pinned} onClose={onClose} onOpen={onOpen} />
      <div className={CARD_BODY}>
        {/* A drilled card's ticket is already named by the strip above it. */}
        {back === undefined ? <TicketContext row={row} ticketPrefix={ticketPrefix} /> : null}
        <IdentityLine row={row} />
        {transcript && !(pinned && question !== null) ? (
          <Summary content={content} loading={loading} failed={failed} />
        ) : null}
        {unreadable > 0 ? (
          <CardBlock icon={<WarningIcon className="size-4 text-muted-foreground" />}>
            <p data-peek-unreadable="" className="text-muted-foreground">
              Some messages could not be read
            </p>
          </CardBlock>
        ) : null}
        {question !== null && !pinned ? (
          <CardBlock icon={<QuestionIcon className="size-4 text-attention" />}>
            <p
              data-peek-question=""
              className="font-medium text-foreground [overflow-wrap:anywhere]"
            >
              {readInteractionPrompts(question)[0]?.label ?? question.title}
            </p>
          </CardBlock>
        ) : null}
        {pinned && canReply ? (
          question === null ? (
            <CardBlock icon={null}>
              <form id="peek-reply-form" onSubmit={submitMessage}>
                <Textarea
                  aria-label={`Message to ${row.title}`}
                  rows={2}
                  className="min-h-16 resize-y px-2 py-2 text-ui"
                  placeholder="Message"
                  value={message}
                  disabled={send.kind === "sending" || send.kind === "sent"}
                  onChange={(event) => setMessage(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                      submitMessage(event);
                    }
                  }}
                />
              </form>
            </CardBlock>
          ) : (
            <div className="px-3">
              <InteractionCard interaction={question} onResolve={answer} />
            </div>
          )
        ) : null}
      </div>
      {/* Recovery and confirmation never scroll out of reach with long content. */}
      {refused ? (
        <CardBlock
          role="alert"
          icon={<WarningIcon className="size-4" />}
          className="shrink-0 border-t border-border bg-destructive/10 py-2 text-destructive"
        >
          <p data-peek-refused="">That question was already answered.</p>
        </CardBlock>
      ) : null}
      {send.kind === "failed" ? (
        <CardBlock
          role="alert"
          icon={<WarningIcon className="size-4" />}
          className="shrink-0 border-t border-border bg-destructive/10 py-2 text-destructive"
        >
          <p data-peek-send-error="">Couldn’t send. Your message is here; try again.</p>
        </CardBlock>
      ) : null}
      {send.kind === "sent" ? (
        <CardBlock
          role="status"
          icon={<CheckCircleIcon className="size-4" />}
          className="shrink-0 border-t border-border py-2 text-positive"
        >
          Sent
        </CardBlock>
      ) : null}
      {transcript || canReply ? (
        <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border bg-muted/30 px-3 py-2">
          {transcript ? (
            <Button
              data-view-conversation=""
              type="button"
              size="sm"
              variant="ghost"
              className={GHOST_ON_LEAD}
              onClick={onViewConversation}
            >
              <ChatCircleIcon />
              View conversation
            </Button>
          ) : (
            <span aria-hidden />
          )}
          {!canReply ? null : pinned ? (
            // A pinned question is answered by the shipped card's own controls;
            // only a message has a Send of its own here.
            question !== null ? null : (
              <Button
                type="submit"
                form="peek-reply-form"
                size="sm"
                disabled={message.trim() === "" || send.kind === "sending" || send.kind === "sent"}
              >
                <PaperPlaneTiltIcon />
                {send.kind === "sending"
                  ? "Sending…"
                  : send.kind === "failed"
                    ? "Try again"
                    : "Send"}
              </Button>
            )
          ) : (
            <Button type="button" size="sm" variant="secondary" onClick={onPin}>
              {question === null ? <PaperPlaneTiltIcon /> : <QuestionIcon />}
              {question === null ? "Send" : "Answer"}
            </Button>
          )}
        </footer>
      ) : null}
    </div>
  );
}
