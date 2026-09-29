import * as React from "react";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { ChatCircleIcon } from "@phosphor-icons/react/dist/csr/ChatCircle";
import { CheckCircleIcon } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { CircleIcon } from "@phosphor-icons/react/dist/csr/Circle";
import { CircleNotchIcon } from "@phosphor-icons/react/dist/csr/CircleNotch";
import { ClockCounterClockwiseIcon } from "@phosphor-icons/react/dist/csr/ClockCounterClockwise";
import { PaperPlaneTiltIcon } from "@phosphor-icons/react/dist/csr/PaperPlaneTilt";
import { QuestionIcon } from "@phosphor-icons/react/dist/csr/Question";
import { TicketIcon } from "@phosphor-icons/react/dist/csr/Ticket";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";

import { ModelMark } from "@renderer/components/models/model-identity";
import { SESSION_ACTIVITY_LABEL } from "@renderer/components/ui/session-activity-status";
import { Button } from "@renderer/components/ui/button";
import { Skeleton } from "@renderer/components/ui/skeleton";
import { Textarea } from "@renderer/components/ui/textarea";
import { cn } from "@renderer/lib/utils";
import { promptDraft } from "@volli/session-presentation";
import {
  draftAnswer,
  MESSAGE_PROMPT_ID,
  type PeekState,
  type PeekEvent,
} from "./session-peek-wireframe-model";
import type { PeekCopy, SummaryState } from "./session-peek-content";

export type FixtureState = "active" | "waiting" | "idle" | "failed";
export interface SessionFixture extends PeekCopy {
  rowId: string;
  sessionId: string;
  ticketId: string | null;
  ticketStage: string | null;
  recency: string;
  state: FixtureState;
  failure: string | null;
  model: { providerId: string; providerLabel: string; modelId: string; label: string };
  messages: readonly { role: "user" | "assistant"; text: string }[];
}

export const STATE_WORD: Record<FixtureState, string> = {
  active: SESSION_ACTIVITY_LABEL.working,
  waiting: SESSION_ACTIVITY_LABEL.waiting,
  idle: SESSION_ACTIVITY_LABEL.idle,
  // This fixture is a turn interrupted by an executor failure, not a deliberate stop.
  failed: SESSION_ACTIVITY_LABEL.interrupted,
};
const STATE_INK: Record<FixtureState, string> = {
  active: "text-positive",
  waiting: "text-attention",
  idle: "text-muted-foreground",
  failed: "text-destructive",
};

/** Provider identity never changes colour to encode status. The badge owns state. */
export function SessionGlyph({ fixture, state }: { fixture: SessionFixture; state: FixtureState }) {
  const State =
    state === "active"
      ? CircleNotchIcon
      : state === "waiting"
        ? QuestionIcon
        : state === "failed"
          ? WarningIcon
          : CircleIcon;
  return (
    <span
      role="img"
      aria-label={`${fixture.model.providerLabel} · ${STATE_WORD[state]}`}
      data-session-glyph={state}
      className="relative inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-muted/50"
    >
      <ModelMark
        model={fixture.model}
        providerLabel={fixture.model.providerLabel}
        by="provider"
        className="size-4"
      />
      <span
        aria-hidden
        className={cn("absolute -right-1 -bottom-1 rounded-full bg-popover p-px", STATE_INK[state])}
      >
        <State
          weight="bold"
          className={cn("size-3", state === "active" && "motion-safe:animate-spin")}
        />
      </span>
    </span>
  );
}

/*
 * THE CARD'S GRID. One set of numbers for every strip and block, so nothing in
 * the card keeps spacing of its own:
 *
 *   • A 12px INSET on every strip — header, blocks, notices, footer.
 *   • A 24px LEAD COLUMN, then 8px to the text: text starts 44px in,
 *     everywhere. The header's mark fills the column; a block's 16px icon
 *     centres in it on the block's first line; a ghost button's icon is pulled
 *     onto it, so an icon never floats off the column by its button's padding.
 *   • 12px between blocks and at the header's and body's edges; 8px inside a
 *     block (a question to its options) and on the thin strips (notices, the
 *     footer).
 *
 * The ticket card (`ticket-card.tsx`) is drawn on the same grid from these.
 */
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

/** Two lines for identity; full values remain available in the conversation overlay. */
function Identity({
  fixture,
  state,
  glyph,
  unread,
  pinned,
  onClose,
  onOpen,
}: {
  fixture: SessionFixture;
  state: FixtureState;
  glyph?: React.ReactNode;
  unread: boolean;
  pinned: boolean;
  onClose(): void;
  onOpen(): void;
}) {
  return (
    <header className={CARD_HEADER}>
      {glyph ?? <SessionGlyph fixture={fixture} state={state} />}
      <div className={CARD_HEADER_TEXT}>
        <p
          data-peek-session-title=""
          className="line-clamp-2 text-ui font-semibold text-foreground [overflow-wrap:anywhere]"
          title={fixture.sessionTitle}
        >
          {fixture.sessionTitle}
        </p>
        <span className="flex items-center gap-1.5 whitespace-nowrap text-ui text-muted-foreground tabular-nums">
          {unread ? (
            <>
              <span data-peek-unread="" className="inline-flex items-center gap-1.5 text-info">
                <span aria-hidden className="size-1.5 rounded-full bg-info" />
                Unread
              </span>
              <span aria-hidden>·</span>
            </>
          ) : null}
          <span>{fixture.recency}</span>
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

function TicketContext({ fixture }: { fixture: SessionFixture }) {
  if (fixture.ticketId === null) return null;
  return (
    <CardBlock icon={<TicketIcon className="size-4 text-muted-foreground" />}>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="rounded bg-muted px-1 font-mono text-label tracking-normal text-muted-foreground">
          {fixture.ticketId}
        </span>
        <span className="text-muted-foreground">{fixture.ticketStage}</span>
      </div>
      <p
        data-peek-ticket-title=""
        className="line-clamp-2 text-foreground [overflow-wrap:anywhere]"
        title={fixture.ticketTitle ?? undefined}
      >
        {fixture.ticketTitle}
      </p>
    </CardBlock>
  );
}

function Summary({
  fixture,
  summaryState,
}: {
  fixture: SessionFixture;
  summaryState: SummaryState;
}) {
  return (
    <CardBlock icon={<ClockCounterClockwiseIcon className="size-4 text-muted-foreground" />}>
      <div
        className="text-muted-foreground"
        data-summary-state={summaryState}
        aria-busy={summaryState === "loading"}
      >
        {summaryState === "loading" ? (
          <div
            role="status"
            aria-label="Generating summary"
            className="flex h-[100px] flex-col justify-around"
          >
            <Skeleton aria-hidden className="h-2 w-full" />
            <Skeleton aria-hidden className="h-2 w-[90%]" />
            <Skeleton aria-hidden className="h-2 w-full" />
            <Skeleton aria-hidden className="h-2 w-[90%]" />
            <Skeleton aria-hidden className="h-2 w-[65%]" />
          </div>
        ) : summaryState === "unavailable" ? (
          <p>Summary unavailable</p>
        ) : (
          <p data-peek-summary="" className="line-clamp-5 [overflow-wrap:anywhere]">
            {fixture.lastActivity}
          </p>
        )}
      </div>
    </CardBlock>
  );
}

function AnswerForm({
  fixture,
  state,
  dispatch,
  pendingQuestion,
}: {
  fixture: SessionFixture;
  state: PeekState;
  dispatch: React.Dispatch<PeekEvent>;
  pendingQuestion: boolean;
}) {
  const prompts = pendingQuestion ? (fixture.question?.prompts ?? []) : [];
  const prompt = prompts[state.questionIndex];
  const answer = draftAnswer(state.draft, prompts);
  const busy = state.send.kind === "sending" || state.send.kind === "sent";
  const errorId = state.send.kind === "failed" ? "peek-send-error" : undefined;
  const questionRef = React.useRef<HTMLFieldSetElement>(null);
  const previousPrompt = React.useRef(prompt?.id);
  React.useLayoutEffect(() => {
    // Next/Back live after the form in the tab order. Leave focus there and
    // Tab skips the arriving question entirely (Next is even disabled last).
    // Announce the new named group, then let Tab enter its first answer.
    if (previousPrompt.current !== prompt?.id && prompt !== undefined) {
      questionRef.current?.focus();
    }
    previousPrompt.current = prompt?.id;
  }, [prompt]);
  return (
    <form
      id="peek-reply-form"
      aria-label={`Reply to ${fixture.sessionTitle} (${fixture.ticketId ?? "Board"})`}
      className="flex flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        if (!pendingQuestion || state.questionIndex === prompts.length - 1) {
          dispatch({ type: "send", answer });
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          if (!pendingQuestion || state.questionIndex === prompts.length - 1) {
            dispatch({ type: "send", answer });
          }
        }
      }}
    >
      {pendingQuestion && prompt ? (
        <CardBlock icon={<QuestionIcon className="size-4 text-attention" />}>
          <fieldset
            key={prompt.id}
            ref={questionRef}
            tabIndex={-1}
            className="flex min-w-0 flex-col gap-2 outline-none"
            disabled={busy}
            aria-describedby={
              [prompt.detail ? "peek-question-detail" : null, errorId].filter(Boolean).join(" ") ||
              undefined
            }
          >
            <legend
              id="peek-question-label"
              data-peek-question=""
              className="pb-2 font-medium text-foreground [overflow-wrap:anywhere]"
            >
              {prompt.label}
            </legend>
            {prompts.length > 1 ? (
              <p className="text-muted-foreground tabular-nums">
                Question {state.questionIndex + 1} of {prompts.length}
              </p>
            ) : null}
            {prompt.detail ? (
              <p
                id="peek-question-detail"
                className="whitespace-pre-line text-muted-foreground [overflow-wrap:anywhere]"
              >
                {prompt.detail}
              </p>
            ) : null}
            {/* Options hang 8px into the gutter, so each radio sits on the text's edge. */}
            <div className="flex flex-col gap-0.5">
              {prompt.options.map((option, index) => (
                <label
                  key={option.id}
                  className={cn(
                    "-ml-2 flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-foreground focus-within:ring-2 focus-within:ring-ring/45",
                    promptDraft(state.draft, prompt.id).optionIds.includes(option.id)
                      ? "bg-accent"
                      : "hover:bg-muted/50",
                  )}
                >
                  <input
                    type={prompt.multiple ? "checkbox" : "radio"}
                    name={`peek-answer-${prompt.id}`}
                    aria-labelledby={`peek-option-${index}-label`}
                    aria-describedby={
                      option.description ? `peek-option-${index}-description` : undefined
                    }
                    className="mt-1 size-3 shrink-0 accent-primary"
                    checked={promptDraft(state.draft, prompt.id).optionIds.includes(option.id)}
                    onChange={() =>
                      dispatch({ type: "select-option", prompt, optionId: option.id })
                    }
                  />
                  <span className="flex min-w-0 flex-col [overflow-wrap:anywhere]">
                    <span id={`peek-option-${index}-label`}>{option.label}</span>
                    {option.description ? (
                      <span
                        id={`peek-option-${index}-description`}
                        className="whitespace-pre-line text-muted-foreground"
                      >
                        {option.description}
                      </span>
                    ) : null}
                  </span>
                </label>
              ))}
            </div>
            {prompt.custom ? (
              <Textarea
                aria-labelledby="peek-question-label"
                aria-describedby={
                  [prompt.detail ? "peek-question-detail" : null, errorId]
                    .filter(Boolean)
                    .join(" ") || undefined
                }
                rows={2}
                className="min-h-16 resize-y px-2 py-2 text-ui"
                placeholder="Your answer"
                value={promptDraft(state.draft, prompt.id).response}
                onFocus={() => dispatch({ type: "focus-field" })}
                onBlur={() => dispatch({ type: "blur-field" })}
                onChange={(event) =>
                  dispatch({ type: "type-other", promptId: prompt.id, text: event.target.value })
                }
              />
            ) : null}
          </fieldset>
        </CardBlock>
      ) : pendingQuestion ? null : (
        <CardBlock icon={null}>
          <Textarea
            aria-label={`Message to ${fixture.sessionTitle} (${fixture.ticketId ?? "Board"})`}
            aria-describedby={errorId}
            rows={2}
            className="min-h-16 resize-y px-2 py-2 text-ui"
            placeholder="Message"
            value={promptDraft(state.draft, MESSAGE_PROMPT_ID).response}
            disabled={busy}
            onFocus={() => dispatch({ type: "focus-field" })}
            onBlur={() => dispatch({ type: "blur-field" })}
            onChange={(event) =>
              dispatch({
                type: "type-other",
                promptId: MESSAGE_PROMPT_ID,
                text: event.target.value,
              })
            }
          />
        </CardBlock>
      )}
    </form>
  );
}

interface PeekPosition {
  left: number;
  top: number;
  maxHeight: number;
}
export const SessionPeekCard = React.forwardRef<
  HTMLDivElement,
  {
    fixture: SessionFixture;
    state: PeekState;
    position: PeekPosition;
    width: number;
    summaryState: SummaryState;
    dispatch: React.Dispatch<PeekEvent>;
    delivered: boolean;
    /** Replaces the provider+badge composite — the integration scratch draws the row's own mark. */
    glyph?: React.ReactNode;
    /** A strip above the header: a folder's pager, or the way back to its ticket. */
    accessory?: React.ReactNode;
    /** `false` where nothing can be sent — a closed terminal has no one to answer. */
    canReply?: boolean;
    /** `false` where there is no transcript to show — a terminal companion. */
    canViewConversation?: boolean;
    /** `false` where the ticket is already named above — a card reached through its folder. */
    showTicket?: boolean;
    /** Says "Unread" beside the age, in the row's own unread blue (VC-108). */
    unread?: boolean;
    onPin(): void;
    onOpen(): void;
    onLook(): void;
    onClose(): void;
    onPointerEnter(): void;
    onPointerLeave(): void;
  }
>(function SessionPeekCard(
  {
    fixture,
    state,
    position,
    width,
    summaryState,
    dispatch,
    delivered,
    glyph,
    accessory,
    canReply = true,
    canViewConversation = true,
    showTicket = true,
    unread = false,
    onPin,
    onOpen,
    onLook,
    onClose,
    onPointerEnter,
    onPointerLeave,
  },
  ref,
) {
  const pinned = state.pinned !== null;
  const pendingQuestion = fixture.question !== null && !delivered;
  const fixtureState = delivered && fixture.state === "waiting" ? "active" : fixture.state;
  const prompts = pendingQuestion ? (fixture.question?.prompts ?? []) : [];
  const answer = draftAnswer(state.draft, prompts);
  const sent = state.send.kind === "sent";
  const busy = state.send.kind === "sending" || sent;
  return (
    <div
      ref={ref}
      role={pinned ? "dialog" : "note"}
      aria-modal={pinned ? false : undefined}
      aria-label={
        pinned
          ? `${pendingQuestion ? "Answer" : "Message"} ${fixture.sessionTitle}`
          : `Peek at ${fixture.sessionTitle}, ${fixture.ticketId ?? "Board"}`
      }
      tabIndex={pinned ? -1 : undefined}
      data-peek-card=""
      style={{
        position: "fixed",
        left: position.left,
        top: position.top,
        width: `min(${width}px, calc(100vw - 16px))`,
        maxHeight: position.maxHeight,
        zIndex: 60,
      }}
      className="flex flex-col overflow-hidden rounded-xl border border-border bg-popover text-ui shadow-overlay outline-none"
      onPointerEnter={onPointerEnter}
      onPointerLeave={(event) => {
        if (!event.currentTarget.contains(document.activeElement)) onPointerLeave();
      }}
      onFocusCapture={onPointerEnter}
      onBlurCapture={(event) => {
        if (
          !(event.relatedTarget instanceof Node) ||
          !event.currentTarget.contains(event.relatedTarget)
        )
          onPointerLeave();
      }}
    >
      {accessory}
      <Identity
        fixture={fixture}
        state={fixtureState}
        glyph={glyph}
        unread={unread}
        pinned={pinned}
        onClose={onClose}
        onOpen={onOpen}
      />
      <div className={CARD_BODY}>
        {showTicket ? <TicketContext fixture={fixture} /> : null}
        {!pinned || !pendingQuestion ? (
          <Summary fixture={fixture} summaryState={summaryState} />
        ) : null}
        {fixture.failure === null ? null : (
          <CardBlock icon={<WarningIcon className="size-4" />} className="text-destructive">
            <p className="[overflow-wrap:anywhere]">{fixture.failure}</p>
          </CardBlock>
        )}
        {pendingQuestion && !pinned ? (
          <CardBlock icon={<QuestionIcon className="size-4 text-attention" />}>
            <p
              data-peek-question=""
              className="font-medium text-foreground [overflow-wrap:anywhere]"
            >
              {prompts[0]?.label}
            </p>
          </CardBlock>
        ) : null}
        {pinned && !sent ? (
          <AnswerForm
            fixture={fixture}
            state={state}
            dispatch={dispatch}
            pendingQuestion={pendingQuestion}
          />
        ) : null}
      </div>
      {/* Recovery and submission never scroll out of reach with long content. */}
      {state.send.kind === "failed" && pinned ? (
        <CardBlock
          role="alert"
          id="peek-send-error"
          icon={<WarningIcon className="size-4" />}
          className="shrink-0 border-t border-border bg-destructive/10 py-2 text-destructive"
        >
          <p className="[overflow-wrap:anywhere]">{state.send.reason}</p>
        </CardBlock>
      ) : null}
      {sent && pinned ? (
        <CardBlock
          role="status"
          icon={<CheckCircleIcon className="size-4" />}
          className="shrink-0 border-t border-border py-2 text-positive"
        >
          Sent
        </CardBlock>
      ) : null}
      {canViewConversation || canReply ? (
        <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border bg-muted/30 px-3 py-2">
          {canViewConversation ? (
            <Button
              data-view-conversation=""
              type="button"
              size="sm"
              variant="ghost"
              className={GHOST_ON_LEAD}
              onClick={onLook}
            >
              <ChatCircleIcon />
              View conversation
            </Button>
          ) : (
            <span aria-hidden />
          )}
          {!canReply ? null : pinned ? (
            <div className="flex items-center gap-2">
              {pendingQuestion && prompts.length > 1 ? (
                <>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={busy || state.questionIndex === 0}
                    onClick={() =>
                      dispatch({
                        type: "question-step",
                        index: state.questionIndex - 1,
                        count: prompts.length,
                      })
                    }
                  >
                    Back
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={busy || state.questionIndex === prompts.length - 1}
                    onClick={() =>
                      dispatch({
                        type: "question-step",
                        index: state.questionIndex + 1,
                        count: prompts.length,
                      })
                    }
                  >
                    Next
                  </Button>
                </>
              ) : null}
              <Button
                type="submit"
                form="peek-reply-form"
                size="sm"
                disabled={
                  answer === null ||
                  busy ||
                  (pendingQuestion && state.questionIndex !== prompts.length - 1)
                }
              >
                <PaperPlaneTiltIcon />
                {state.send.kind === "sending"
                  ? "Sending…"
                  : state.send.kind === "failed"
                    ? "Try again"
                    : "Send"}
              </Button>
            </div>
          ) : (
            <Button type="button" size="sm" variant="secondary" onClick={onPin}>
              {pendingQuestion ? <QuestionIcon /> : <PaperPlaneTiltIcon />}
              {pendingQuestion ? "Answer" : "Send"}
            </Button>
          )}
        </footer>
      ) : null}
    </div>
  );
});
