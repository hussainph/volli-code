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
} from "../scratches/session-peek-wireframe-model";
import type { PeekCopy, SummaryState } from "../scratches/session-peek-content";

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

/** Two lines for identity; full values remain available in the conversation overlay. */
function Identity({
  fixture,
  state,
  glyph,
  pinned,
  onClose,
  onOpen,
}: {
  fixture: SessionFixture;
  state: FixtureState;
  glyph?: React.ReactNode;
  pinned: boolean;
  onClose(): void;
  onOpen(): void;
}) {
  return (
    <header className="flex shrink-0 items-start gap-2 border-b border-border p-4">
      {glyph ?? <SessionGlyph fixture={fixture} state={state} />}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p
          data-peek-session-title=""
          className="line-clamp-2 text-ui font-semibold text-foreground [overflow-wrap:anywhere]"
          title={fixture.sessionTitle}
        >
          {fixture.sessionTitle}
        </p>
        <span className="whitespace-nowrap text-ui text-muted-foreground tabular-nums">
          {fixture.recency}
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
    <div className="flex items-start gap-2 px-4 pt-4">
      <TicketIcon aria-hidden className="mt-1 size-4 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="rounded bg-muted px-1 font-mono text-label tracking-normal text-muted-foreground">
            {fixture.ticketId}
          </span>
          <span className="text-ui text-muted-foreground">{fixture.ticketStage}</span>
        </div>
        <p
          data-peek-ticket-title=""
          className="line-clamp-2 text-ui text-foreground [overflow-wrap:anywhere]"
          title={fixture.ticketTitle ?? undefined}
        >
          {fixture.ticketTitle}
        </p>
      </div>
    </div>
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
    <div className="flex items-start gap-2 px-4 py-4">
      <ClockCounterClockwiseIcon
        aria-hidden
        className="mt-1 size-4 shrink-0 text-muted-foreground"
      />
      <div
        className="min-w-0 flex-1 text-ui text-muted-foreground"
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
    </div>
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
      className={cn("flex flex-col gap-2 px-4 pb-4", pendingQuestion && "pt-4")}
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
        <fieldset
          key={prompt.id}
          ref={questionRef}
          tabIndex={-1}
          className="min-w-0 outline-none"
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
            <p className="pb-2 text-ui text-muted-foreground tabular-nums">
              Question {state.questionIndex + 1} of {prompts.length}
            </p>
          ) : null}
          {prompt.detail ? (
            <p
              id="peek-question-detail"
              className="pb-2 text-ui whitespace-pre-line text-muted-foreground [overflow-wrap:anywhere]"
            >
              {prompt.detail}
            </p>
          ) : null}
          <div className="flex flex-col gap-1">
            {prompt.options.map((option, index) => (
              <label
                key={option.id}
                className={cn(
                  "flex cursor-pointer items-start gap-2 rounded-md px-2 py-2 text-ui text-foreground focus-within:ring-2 focus-within:ring-ring/45",
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
                  onChange={() => dispatch({ type: "select-option", prompt, optionId: option.id })}
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
              className="mt-2 min-h-16 resize-y px-2 py-2 text-ui"
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
      ) : pendingQuestion ? null : (
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
            dispatch({ type: "type-other", promptId: MESSAGE_PROMPT_ID, text: event.target.value })
          }
        />
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
        pinned={pinned}
        onClose={onClose}
        onOpen={onOpen}
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
        {showTicket ? <TicketContext fixture={fixture} /> : null}
        {!pinned || !pendingQuestion ? (
          <Summary fixture={fixture} summaryState={summaryState} />
        ) : null}
        {fixture.failure === null ? null : (
          <div className="flex items-start gap-2 px-4 pb-4 text-destructive">
            <WarningIcon aria-hidden className="mt-1 size-4 shrink-0" />
            <p className="min-w-0 [overflow-wrap:anywhere]">{fixture.failure}</p>
          </div>
        )}
        {pendingQuestion && !pinned ? (
          <div className="flex items-start gap-2 px-4 pb-4">
            <QuestionIcon aria-hidden className="mt-1 size-4 shrink-0 text-attention" />
            <p
              data-peek-question=""
              className="min-w-0 font-medium text-foreground [overflow-wrap:anywhere]"
            >
              {prompts[0]?.label}
            </p>
          </div>
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
        <div
          role="alert"
          id="peek-send-error"
          className="flex shrink-0 items-start gap-2 border-t border-border bg-destructive/10 px-4 py-2 text-destructive"
        >
          <WarningIcon aria-hidden className="mt-1 size-4 shrink-0" />
          <p className="min-w-0 [overflow-wrap:anywhere]">{state.send.reason}</p>
        </div>
      ) : null}
      {sent && pinned ? (
        <div
          role="status"
          className="flex shrink-0 items-center gap-2 border-t border-border px-4 py-2 text-positive"
        >
          <CheckCircleIcon aria-hidden className="size-4" />
          Sent
        </div>
      ) : null}
      {canViewConversation || canReply ? (
        <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border bg-muted/30 px-4 py-2">
          {canViewConversation ? (
            <Button
              data-view-conversation=""
              type="button"
              size="sm"
              variant="ghost"
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
