/**
 * The interaction card.
 *
 * Two mount points, and one fork — but not on the axis it looks like. A
 * permission correlated to a tool call and a question that was never correlated
 * to anything mount the same way, so *where a card stands* never chooses a
 * component. It is the caller's to decide:
 *
 *  - **On the row**, under the call it gates, in the transcript. A decision
 *    belongs where it happened, beside the command and its detail. The composer
 *    stays: the turn is blocked, but the reader's place in the conversation is
 *    not, and the card is not standing in the composer's slot.
 *  - **At the foot**, stacked *above* the composer, for an interaction no row
 *    can hold — a question, or a permission the harness raised with no call.
 *    The composer stays: a follow-up can still be typed (or queued) while the
 *    card waits. Cancel request rides the card because withdrawing the question
 *    is not the same act as the composer's Stop turn.
 *
 * The old approval card took a `DynamicToolUIPart` and drew three hardcoded
 * buttons, so an option a harness declared could never reach the screen and an
 * interaction with no call could not be answered at all. Both cards below are
 * the real interaction in both places, which is why neither is forked by mount.
 *
 * **What forks is what is being asked.** {@link isAskUserInteraction} separates
 * them, and `kind` alone does not:
 *
 *  - {@link DecisionCard} — a *verdict*. A permission, or the escalation stored
 *    as a question that still offers a declared yes and no. Every option stands
 *    in view at once and is weighted against its neighbours, because choosing
 *    between them is the whole act; several questions step through a counter.
 *  - {@link QuestionCard} — an *answer*. Option ids are the harness's own
 *    encoded values, so there is no verdict to weight and no list to read
 *    against itself — one question at a time, rows that answer on the click,
 *    and a box beside them wherever the harness said words can be read back.
 *
 * A refusal is not always one of the options. A permission declares `reject`,
 * an id we mint; an ask-user question's ids can none of them mean "no", so a
 * refusal there is a control of the card's and travels as the empty resolution.
 * It is on every ask-user card, box or no box: saying "none of these work" is
 * never gated on a harness capability.
 *
 * What *is* the harness's to gate is whether words can travel at all, and how
 * much of a card an empty box costs before anyone wants it. Both are
 * `interaction.ts`'s decisions (`askFieldOpen`, `promptFieldOpen`,
 * `promptTextCarrier`), not this file's.
 *
 * Decision logic lives in `interaction.ts`. Everything here is presentation
 * plus the handful of things only a mounted card can own: whether a text answer
 * takes focus, that the reader asked for a box that was not already open, that
 * the last decision did not land, where focus goes when the step changes, and
 * which keys this surface can act on. No gesture here throws a pending decision
 * away: the card is left, never dismissed.
 */
import * as React from "react";
import {
  ArrowRightIcon,
  CaretLeftIcon,
  CheckIcon,
  CaretRightIcon,
  HandPalmIcon,
  WarningIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import type {
  SessionInteraction,
  SessionInteractionOption,
  SessionInteractionResolution,
} from "@volli/shared";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

import {
  askFieldOpen,
  describeInteractionResolution,
  emptyInteractionDraft,
  interactionAdvance,
  interactionCarousel,
  interactionQuestions,
  interactionRedirected,
  interactionStep,
  interactionSubmission,
  interactionSubmitLabel,
  isAskUserInteraction,
  needsOwnRefusal,
  optionPolarity,
  optionSubmitsOnSelect,
  promptDraft,
  promptFieldOpen,
  promptFieldRole,
  promptResponseSuperseded,
  refusalSubmission,
  selectOption,
  setPromptResponse,
  type InteractionCarousel,
  type InteractionDraft,
  type InteractionFieldRole,
  type InteractionQuestion,
  type InteractionStep,
  type InteractionSubmission,
} from "@renderer/chat/interaction";
import { COMPOSER_STACK_SHELL } from "@renderer/chat/composer-stack";
import { Button } from "@renderer/components/ui/button";
import { Textarea } from "@renderer/components/ui/textarea";
import { cn } from "@renderer/lib/utils";

/* ------------------------------------------------------------------- card */

/** Inside the box, where a sentence is a prompt rather than a name. */
const FIELD_PLACEHOLDER: Record<InteractionFieldRole, string> = {
  answer: "Your answer",
  note: "Note",
  redirection: "What to do instead",
};

/**
 * On the control that opens it, where a sentence is not. "What to do instead" is
 * the box asking; a button wearing it reads as an instruction to the reader
 * rather than the name of the thing one press away. One string cannot do both
 * jobs — the placeholder is the question, this is the noun.
 */
const FIELD_LABEL: Record<InteractionFieldRole, string> = {
  answer: "Answer",
  note: "Note",
  redirection: "Instructions",
};

/**
 * One answer row, on either card.
 *
 * Shared as a string rather than as a component, because the two rows are not
 * the same element and must not be: a question's row is a button this card
 * drives itself, a verdict's is a label over a native input whose group
 * semantics the browser owns. What they *are* differs; how they read must not,
 * so the target, the wash and the rhythm live in one place where they cannot
 * drift apart a class at a time.
 */
const OPTION_ROW =
  "group flex min-w-0 cursor-pointer items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors outline-none";

/** The disc at the head of a row: a numeral on one card, a tick on the other. */
const OPTION_MARK =
  "flex size-5 shrink-0 items-center justify-center rounded-full text-xs tabular-nums transition-colors";

/**
 * The row's own verb, on the row that is one press from a decision.
 *
 * Only where the click really is the whole act — `optionSubmitsOnSelect` on a
 * verdict, a single choice on a question — so it is the affordance telling the
 * truth about the gesture rather than decoration that appears on every row.
 *
 * `focus` is the caller's because the two cards focus differently: a question's
 * row is itself the focusable control, a verdict's row focuses the input beside
 * this glyph. Ink is `foreground`, never the accent — the accent on this card
 * means *chosen*, and this is the act, not the answer.
 */
function AnswerArrow({ focus }: { focus: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "ml-auto flex size-5 shrink-0 items-center justify-center rounded-full bg-foreground text-background opacity-0 transition-opacity duration-150 group-hover:opacity-100 motion-reduce:transition-none",
        focus,
      )}
    >
      <ArrowRightIcon className="size-3" weight="bold" />
    </span>
  );
}

/**
 * A stable, non-focusable announcement point for the request above a composer.
 * It stays mounted while the pending value changes so assistive technology
 * observes changed text instead of depending on a live region and its content
 * appearing in the same commit.
 */
export function PendingInteractionAnnouncement({
  interaction,
}: {
  interaction: SessionInteraction | null;
}) {
  return (
    <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {interaction ? `Request pending: ${interaction.title}` : ""}
    </span>
  );
}

export interface InteractionCardProps {
  interaction: SessionInteraction;
  /**
   * Where the decision goes, and — where the caller can say — whether it landed.
   * A handler that returns nothing is taken at its word; one that returns a
   * promise is awaited, and `false` or a rejection is what puts the card back
   * with the failure on it. Without that, a decision the harness never heard
   * left the card looking answered and said nothing anywhere near it.
   */
  onResolve(submission: InteractionSubmission): void | Promise<boolean | void>;
  /**
   * Withdraws this durable request, as a control and as Escape. A card on a row
   * leaves it off because only the co-mounted foot offers request withdrawal.
   * This is deliberately distinct from the composer's turn-only interrupt.
   */
  onWithdraw?(): void;
  /** A decision is in flight; the harness's own verdict is what clears the card. */
  resolving?: boolean;
  ref?: React.Ref<HTMLFormElement>;
  className?: string;
}

/**
 * Which card this request wants. The two are one component to every caller —
 * the mount decides where a card stands, never which one it is.
 */
export function InteractionCard(props: InteractionCardProps) {
  return isAskUserInteraction(props.interaction) ? (
    <QuestionCard {...props} />
  ) : (
    <DecisionCard {...props} />
  );
}

/**
 * The decision that did not land, and the one door out that reports it.
 *
 * `resolving` says a decision is in flight and the harness's own verdict is
 * what clears the card, so the only state left unrepresented was the round trip
 * that came back with nothing: the card re-enabled itself and looked exactly
 * like one nobody had pressed. Shared, so a refusal that never reached the
 * harness reports itself the same way a submitted answer does on either card.
 *
 * The flag clears on the attempt rather than on the next keystroke: what it
 * says is that the last thing pressed did not land, and that stays true while
 * it is being retried.
 */
function useDelivery(onResolve: InteractionCardProps["onResolve"]) {
  const [failed, setFailed] = React.useState(false);
  const send = (sending: InteractionSubmission) => {
    setFailed(false);
    const landing = onResolve(sending);
    if (!(landing instanceof Promise)) return;
    void landing.then(
      (landed) => setFailed(landed === false),
      () => setFailed(true),
    );
  };
  return { failed, send };
}

/**
 * Escape ends the turn; it never dismisses the question, which outlives the
 * turn and leaves the projection only when it is answered or withdrawn. So it
 * does exactly what Cancel request does, and only where a card offers
 * withdrawal — at the foot, next to the composer that still owns turn-only
 * interrupt.
 *
 * Where there is none, the key is left to bubble. Swallowing it there meant a
 * card on a row absorbed the one gesture that interrupts from anywhere and
 * offered nothing back: the composer beside it still owns the exit, and a key
 * claimed by a surface that cannot act on it is a key that does nothing.
 */
function withdrawOnEscape(
  onWithdraw: (() => void) | undefined,
  resolving: boolean | undefined,
): React.KeyboardEventHandler<HTMLFormElement> {
  return (event) => {
    if (event.key !== "Escape") return;
    if (!onWithdraw) return;
    // Mid-resolve the card cannot withdraw, and a key it cannot act on is a
    // key it must not claim — the rule this function opens with. Left to
    // bubble, the composer's own interrupt still owns the exit.
    if (resolving) return;
    // Never mid-word: Escape closes an IME's candidate window, and taking that
    // keystroke would end the turn under someone who was typing.
    if (event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    onWithdraw();
  };
}

/**
 * A request that asks for a verdict: a permission, or the escalation stored as
 * a question that still offers a declared yes and no.
 *
 * A request that asks several things shows one of them at a time, with a
 * counter and a step either way. Movement is free and submission is not: the
 * reader may answer in any order, and Submit waits for all of them because a
 * resolution carries one `answers` array.
 */
function DecisionCard({
  interaction,
  onResolve,
  onWithdraw,
  resolving,
  ref,
  className,
}: InteractionCardProps) {
  const [draft, setDraft] = React.useState<InteractionDraft>(() =>
    emptyInteractionDraft(interaction),
  );
  const [step, setStep] = React.useState(0);
  const { failed, send } = useDelivery(onResolve);
  const reducedMotion = useReducedMotion() ?? false;
  const questions = interactionQuestions(interaction);
  const carousel = interactionCarousel(interaction, draft, step);
  const asked = questions[carousel?.index ?? 0];
  const refusable = needsOwnRefusal(interaction);
  const submission = interactionSubmission(interaction, draft);
  const submittable = submission !== null && !resolving;

  // Takes the draft rather than reading it, because the card can send on the
  // click that answers it — and the state that click set is not on `draft` yet.
  const submit = (next: InteractionDraft = draft) => {
    if (resolving) return;
    const sending = next === draft ? submission : interactionSubmission(interaction, next);
    if (sending) send(sending);
  };

  return (
    <form
      ref={ref}
      tabIndex={-1}
      aria-label={interaction.title}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      onKeyDown={withdrawOnEscape(onWithdraw, resolving)}
      className={cn(
        "pointer-events-auto overflow-hidden outline-none",
        COMPOSER_STACK_SHELL,
        className,
      )}
    >
      <div className="flex items-start gap-2 px-3 pt-3">
        {/* The card's palm and the footer's Warning are the
            only filled glyphs the chat surface has left: an interaction is the
            exception in a transcript that is otherwise outline throughout. */}
        <HandPalmIcon aria-hidden className="mt-1 size-4 shrink-0 text-primary" weight="fill" />
        <div className="min-w-0 flex-1">
          {/* The ask, at the size the ask-user card asks at. What is being
              authorized is the largest thing on the card in both places — the
              two are one family and the reader is doing the same kind of work. */}
          <p className="text-heading text-balance text-foreground">{interaction.title}</p>
          {/* The object of the decision, not a caption on it. This is the
              command or the path being authorized, and at the foot mount it is
              the only place the subject appears at all — truncated to one
              muted line it was the dimmest thing on a card whose whole purpose
              is to show it. Machine text stays mono and `text-xs`; what
              changes is the ink and that it is readable in full, the way the
              scrollable `pre` this card replaced showed it. */}
          {interaction.detail ? (
            <pre className="mt-1 max-h-32 overflow-y-auto font-mono text-xs whitespace-pre-wrap break-words text-foreground">
              {interaction.detail}
            </pre>
          ) : null}
        </div>
        {carousel ? (
          <InteractionSteps carousel={carousel} disabled={resolving} onStep={setStep} />
        ) : null}
      </div>

      {/* The same cross-fade the ask-user card steps with. A permission that
          asked one thing never sees it; one that asked several is walked
          through the same way, by the carousel it already had. */}
      <div className="px-3 pt-2">
        <AnimatePresence initial={false} mode="popLayout">
          {asked ? (
            <motion.div
              key={asked.prompt.id}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: reducedMotion ? 0.1 : 0.18, ease: [0.32, 0.72, 0, 1] }}
            >
              <InteractionQuestionFields
                interaction={interaction}
                question={asked}
                draft={draft}
                disabled={resolving}
                onDraftChange={setDraft}
                onSubmit={submit}
              />
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>

      <div className="mt-1.5 flex items-center gap-1 border-t border-border/70 px-3 py-2">
        {/* Worded, not a bare glyph. Cancel request is not the composer's Stop
            turn: it withdraws the durable interaction as well as interrupting
            the turn that asked it.

            Ghost and muted, because withdrawal is not an answer. It reads at the
            weight of the exit it is — below the verdict beside it, which is
            what the card actually asked for. Two controls at one weight said an
            interrupt and a refusal were the same kind of act. */}
        {onWithdraw ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            disabled={resolving}
            onClick={onWithdraw}
          >
            <XCircleIcon className="size-3.5" />
            Cancel request
          </Button>
        ) : null}
        {/* The decision that never reached the harness. Two words and the ink
            that says which kind of state it is: the controls are live again and
            pressing one is the retry, so there is nothing here to explain. At
            the foot mount a session blocker says it too; on a row there is
            nothing else on screen that would. */}
        {failed ? (
          <span role="alert" className="flex min-w-0 items-center gap-1.5 text-xs text-destructive">
            <WarningIcon aria-hidden className="size-3.5 shrink-0" weight="fill" />
            <span className="min-w-0 truncate">Not delivered</span>
          </span>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {/* A refusal the harness did not declare an option for. It is a
              control rather than a row in the list because none of a question's
              option ids can mean "no" — they are the harness's own encoded
              values, and one labelled `reject` would otherwise refuse itself
              when chosen. It sends the empty resolution, so whatever was
              selected and abandoned goes with it rather than travelling
              alongside the refusal.

              Outlined: it stands beside the primary control because it is the
              other half of the same decision, and above withdrawal because it is one. */}
          {refusable ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={resolving}
              onClick={() => send(refusalSubmission(interaction, draft))}
            >
              Reject
            </Button>
          ) : null}
          {/* Disabled rather than swapped for a spinner: the round trip is one
              HTTP reply and the harness's own verdict is what replaces the
              card, so a progress affordance would flash for less time than it
              reads. What matters is that a second click cannot land.

              The label is `interactionSubmitLabel`'s, not the word "Submit": a
              dimmed control saying "Submit" is the same word before and after
              the thing it is waiting for, so on a single question — where there
              is no counter to say what is left — the gate said nothing at all.
              Naming the act, and then the verdict, is the gate and the receipt
              in one control, with no line of prose under it. */}
          <Button type="submit" size="sm" disabled={!submittable}>
            {interactionSubmitLabel(interaction, draft)}
          </Button>
        </div>
      </div>
    </form>
  );
}

/* --------------------------------------------------------- the ask-user card */

/**
 * A request that asks for an answer, one question at a time.
 *
 * The flow, not the list, is the surface. A verdict card puts every option in
 * view because choosing between them is the act; here the ids are the harness's
 * own encoded values, so there is nothing to weigh a row against and no reason
 * to hold three questions on screen at once. What matters instead is momentum:
 * the row *is* the control, one click answers and advances, and the counter
 * says how much is left without a sentence saying so.
 *
 * Three things this card owns that `interaction.ts` cannot:
 *
 *  - **Where focus goes on a step.** Only when the reader is already driving the
 *    card. Mounting never takes focus: the composer is still there, still
 *    focused, and a request that appears under someone's hands must not swallow
 *    the word they were typing.
 *  - **That a press was blocked.** `promptRequirement` says what is missing;
 *    that the reader pressed at all, and that editing clears it, is state.
 *  - **Which keys answer.** A numeral is the row's name, so pressing it is
 *    pressing the row; arrows move and choose without committing; Enter is the
 *    commit. The always-open box takes Enter as its own commit only where the
 *    options beside it mean plain Enter is not a newline anyone wanted.
 */
function QuestionCard({
  interaction,
  onResolve,
  onWithdraw,
  resolving,
  ref,
  className,
}: InteractionCardProps) {
  const [draft, setDraft] = React.useState<InteractionDraft>(() =>
    emptyInteractionDraft(interaction),
  );
  const [index, setIndex] = React.useState(0);
  // Which way the next step travels, so the pair sliding past each other agree.
  const [direction, setDirection] = React.useState(1);
  // What the last press was waiting for, cleared by the edit that answers it.
  const [blocked, setBlocked] = React.useState<string | null>(null);
  const { failed, send } = useDelivery(onResolve);
  const reducedMotion = useReducedMotion() ?? false;
  const stageRef = React.useRef<HTMLDivElement>(null);
  // Set by the reader's own navigation, so an arriving step takes focus and a
  // mounting card never does.
  const stepped = React.useRef(false);
  const step = interactionStep(interaction, draft, index);
  const refusable = needsOwnRefusal(interaction);
  const askedId = step?.question.prompt.id ?? "";

  // Both cards in the AnimatePresence are mounted while one leaves, so the entry
  // is matched by the prompt it belongs to rather than by document order — the
  // outgoing step's controls are still in the tree and still match the attribute.
  React.useLayoutEffect(() => {
    if (!stepped.current) return;
    stepped.current = false;
    const entries = stageRef.current?.querySelectorAll<HTMLElement>("[data-step-entry]") ?? [];
    for (const entry of entries) {
      if (entry.dataset.stepEntry !== askedId) continue;
      entry.focus();
      return;
    }
  }, [askedId]);

  const go = (next: number, notice: string | null = null) => {
    stepped.current = true;
    setDirection(next >= index ? 1 : -1);
    setIndex(next);
    setBlocked(notice);
  };

  /**
   * Forward, and at the end of the walk, out. What a press means is
   * {@link interactionAdvance}'s; what is left here is where it puts the reader.
   *
   * Takes the draft rather than reading it, because the click that answers a
   * single-choice question also advances it — and the state that click set is
   * one render away.
   */
  const advance = (from: InteractionDraft = draft) => {
    if (resolving) return;
    const next = interactionAdvance(interaction, from, index);
    if (next === null) return;
    if (next.kind === "send") {
      setBlocked(null);
      send(next.submission);
      return;
    }
    if (next.kind === "step") {
      go(next.at);
      return;
    }
    // Blocked where the reader already is: say so and leave focus on the control
    // they pressed. Blocked somewhere else — a question stepped past — is a move,
    // and the notice travels with it.
    if (next.at === step?.index) setBlocked(next.requirement);
    else go(next.at, next.requirement);
  };

  /** The click, and the numeral that is the row's name. */
  const choose = (option: SessionInteractionOption) => {
    if (resolving || !step) return;
    const { prompt } = step.question;
    const next = selectOption(draft, prompt, option.id);
    setDraft(next);
    setBlocked(null);
    // Several answers accumulate, and the reader says when the question is
    // done; one answer is done the moment it is given.
    if (prompt.multiple) return;
    advance(next);
  };

  /** Arrowed onto, which chooses without committing — the radio's own reading. */
  const mark = (option: SessionInteractionOption) => {
    if (resolving || !step) return;
    setDraft(selectOption(draft, step.question.prompt, option.id));
    setBlocked(null);
  };

  const write = (response: string) => {
    if (!step) return;
    setDraft(setPromptResponse(draft, step.question.prompt.id, response));
    setBlocked(null);
  };

  const transition = {
    duration: reducedMotion ? 0.12 : 0.22,
    ease: [0.32, 0.72, 0, 1] as const,
  } as const;
  const offset = reducedMotion ? 0 : 10;

  return (
    <form
      ref={ref}
      tabIndex={-1}
      aria-label={interaction.title}
      onSubmit={(event) => {
        event.preventDefault();
        advance();
      }}
      onKeyDown={withdrawOnEscape(onWithdraw, resolving)}
      className={cn(
        "pointer-events-auto overflow-hidden outline-none",
        COMPOSER_STACK_SHELL,
        className,
      )}
    >
      {step ? (
        // `layout` on the frame and `popLayout` inside it: the leaving step is
        // taken out of flow the moment it starts, so the arriving one alone sets
        // the height and the frame tweens to it instead of the card jumping a
        // question's worth of rows.
        <motion.div ref={stageRef} layout={!reducedMotion} transition={transition}>
          <AnimatePresence initial={false} mode="popLayout">
            <motion.div
              key={step.question.prompt.id}
              initial={{ opacity: 0, transform: `translateX(${direction * offset}px)` }}
              animate={{ opacity: 1, transform: "translateX(0px)" }}
              exit={{ opacity: 0, transform: `translateX(${direction * -offset}px)` }}
              transition={transition}
              className="px-3 pt-3"
            >
              <QuestionStep
                step={step}
                interaction={interaction}
                draft={draft}
                disabled={resolving}
                onBack={() => go(step.index - 1)}
                onChoose={choose}
                onMark={mark}
                onWrite={write}
                onAdvance={() => advance()}
              />
            </motion.div>
          </AnimatePresence>
        </motion.div>
      ) : null}

      <div
        className={cn(
          "flex items-center gap-1 px-3 py-2",
          // No rule under nothing: a request that declares no questions is all
          // footer, and the line would be drawing the top edge of the card.
          step && "mt-1.5 border-t border-border/70",
        )}
      >
        {onWithdraw ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            disabled={resolving}
            onClick={onWithdraw}
          >
            <XCircleIcon className="size-3.5" />
            Cancel request
          </Button>
        ) : null}
        {/* One notice slot, left-aligned, for the two things that stop a press
            landing: the decision that never reached the harness, and the
            question that has nothing to send yet. Delivery wins — it is about
            the card as a whole, and it outlives the edit that clears the other.
            An alert, because focus stays on the pressed control when the block
            is at the current step — without a live region the press is
            rejected silently to anyone not looking at the footer. */}
        {failed || blocked ? (
          <span role="alert" className="flex min-w-0 items-center gap-1.5 text-xs text-destructive">
            <WarningIcon aria-hidden className="size-3.5 shrink-0" weight="fill" />
            <span className="min-w-0 truncate">{failed ? "Not delivered" : blocked}</span>
          </span>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {/* Movement, not an answer: a resolution carries one `answers` array,
              so there is no partial one to send and nothing durable a skip
              could write. It steps past the question and leaves it unanswered,
              and Submit still waits for it — which is why the last question has
              no Skip, and why a blocked Submit walks back to what was passed. */}
          {step?.skippable ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              disabled={resolving}
              onClick={() => go(step.index + 1)}
            >
              Skip
              <ArrowRightIcon className="size-3.5" />
            </Button>
          ) : null}
          {/* The refusal none of the harness's own ids can carry. Outlined: it
              stands beside the control that answers because it is the other half
              of the same decision, and above withdrawal because it is one. */}
          {refusable ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={resolving}
              onClick={() => send(refusalSubmission(interaction, draft))}
            >
              Reject
            </Button>
          ) : null}
          {/* Live rather than gated, unlike the verdict card's. There the press
              is the grant and a stray one is the thing to prevent; here it is a
              step in a walk, and a control that goes quietly dead says less than
              one that answers what it is waiting for. */}
          {step?.advanceLabel ? (
            <Button type="submit" size="sm" disabled={resolving}>
              {step.advanceLabel}
            </Button>
          ) : null}
        </div>
      </div>
    </form>
  );
}

/**
 * One question: where the reader is, what is being asked, and the rows.
 *
 * The counter and the heading ride *inside* the animated step rather than above
 * it, because they are the question as much as the options are — a title that
 * stayed put while its own options slid away read as a new question arriving
 * under an old one's headline.
 */
function QuestionStep({
  step,
  interaction,
  draft,
  disabled,
  onBack,
  onChoose,
  onMark,
  onWrite,
  onAdvance,
}: {
  step: InteractionStep;
  interaction: SessionInteraction;
  draft: InteractionDraft;
  disabled?: boolean;
  onBack(): void;
  onChoose(option: SessionInteractionOption): void;
  onMark(option: SessionInteractionOption): void;
  onWrite(response: string): void;
  onAdvance(): void;
}) {
  const { prompt } = step.question;
  const headingId = React.useId();
  const fieldRef = React.useRef<HTMLTextAreaElement>(null);
  const rows = React.useRef<(HTMLButtonElement | null)[]>([]);
  // Words that only a following message can carry contradict every option on
  // the card — not only the ones beside them — because the refusal they send is
  // one empty resolution for the whole request. Dimming says so, instead of
  // leaving ticked answers live and discarding them at submit.
  const superseded = interactionRedirected(interaction, draft);
  const wordsDropped = promptResponseSuperseded(interaction, prompt, draft);
  const written = promptDraft(draft, prompt.id).response;
  const chosen = promptDraft(draft, prompt.id).optionIds;
  const fieldRole = promptFieldRole(prompt, draft);
  // The harness's call, not the card's: `custom` is what says a written answer
  // can be read back at all. Refusing is never gated on it — that is the
  // card's own Reject, and it stands whether or not there is a box here.
  const fieldOpen = askFieldOpen(prompt);
  // Roving, the radio group's own rule: the chosen row is the tab stop, and
  // where nothing is chosen yet the first one is.
  const tabbable = Math.max(
    prompt.options.findIndex((option) => chosen.includes(option.id)),
    0,
  );
  const alone = prompt.options.length === 0;

  const move = (from: number, delta: number) => {
    const count = prompt.options.length;
    const next = (((from + delta) % count) + count) % count;
    rows.current[next]?.focus();
    const option = prompt.options[next];
    // A radio chooses as it is arrowed onto; a checkbox is toggled deliberately,
    // so here the arrow only carries focus.
    if (option && !prompt.multiple) onMark(option);
  };

  return (
    <fieldset className="min-w-0" disabled={disabled}>
      {step.count > 1 ? (
        <div className="mb-1 flex items-center gap-1">
          <span className="text-xs text-muted-foreground tabular-nums">
            Question {step.index + 1} of {step.count}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="ml-auto"
            aria-label="Previous question"
            disabled={step.first}
            onClick={onBack}
          >
            <CaretLeftIcon className="size-3" />
          </Button>
        </div>
      ) : null}
      {/* A paragraph carrying the group's name, not a heading: the card sits
          inside a transcript with an outline of its own, and the request's
          identity is already on the form and in the live region. */}
      <p id={headingId} className="text-heading text-balance text-foreground">
        {step.heading}
      </p>
      {interaction.detail ? (
        <pre className="mt-1 max-h-32 overflow-y-auto font-mono text-xs whitespace-pre-wrap break-words text-foreground">
          {interaction.detail}
        </pre>
      ) : null}

      {alone ? null : (
        <div
          role={prompt.multiple ? "group" : "radiogroup"}
          aria-labelledby={headingId}
          className="-mx-2 mt-3 flex flex-col"
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            const forward = event.key === "ArrowDown" || event.key === "ArrowRight";
            const back = event.key === "ArrowUp" || event.key === "ArrowLeft";
            if (forward || back) {
              event.preventDefault();
              const focused = rows.current.findIndex((row) => row === document.activeElement);
              move(focused < 0 ? (forward ? -1 : 0) : focused, forward ? 1 : -1);
              return;
            }
            if (event.key === "Enter") {
              event.preventDefault();
              // On a focused row, Enter is that row's own activation — which
              // the preventDefault above just cancelled, so it is re-issued
              // here. Space already activates the row natively; the two commit
              // keys must agree, and "Choose an option" while an option is
              // focused is the disagreement this closes.
              const focused = rows.current.find((row) => row === document.activeElement);
              if (focused) {
                focused.click();
                return;
              }
              onAdvance();
              return;
            }
            // The numeral beside a row is its name, so typing it is pressing it
            // — and the one past the last row is the box, which is a row here
            // too and answers to its number the same way.
            const digit = Number.parseInt(event.key, 10);
            if (Number.isNaN(digit) || digit < 1) return;
            const option = prompt.options[digit - 1];
            if (option) {
              event.preventDefault();
              onChoose(option);
              return;
            }
            if (fieldOpen && digit === prompt.options.length + 1) {
              event.preventDefault();
              fieldRef.current?.focus();
            }
          }}
        >
          {prompt.options.map((option, position) => {
            const checked = chosen.includes(option.id);
            return (
              <button
                key={option.id}
                ref={(node) => {
                  rows.current[position] = node;
                }}
                type="button"
                role={prompt.multiple ? "checkbox" : "radio"}
                aria-checked={checked}
                tabIndex={prompt.multiple || position === tabbable ? 0 : -1}
                data-step-entry={position === 0 ? prompt.id : undefined}
                disabled={superseded}
                onClick={() => onChoose(option)}
                className={cn(
                  OPTION_ROW,
                  "hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:ring-1 focus-visible:ring-ring",
                  checked && "bg-muted/70",
                  superseded && "cursor-default opacity-50",
                  step.layout === "stacked" && "items-start",
                )}
              >
                <OptionChip
                  position={position + 1}
                  checked={checked}
                  outlined={prompt.multiple}
                  className={step.layout === "stacked" ? "mt-px" : undefined}
                />
                <span
                  className={cn(
                    "flex min-w-0 flex-1",
                    step.layout === "stacked" ? "flex-col gap-0.5" : "items-baseline gap-1.5",
                  )}
                >
                  <span
                    className={cn(
                      "min-w-0 text-ui font-medium text-foreground",
                      step.layout === "stacked" ? "text-balance" : "truncate",
                    )}
                  >
                    {option.label}
                  </span>
                  {/* Inline, `flex-1` and not a second `auto` basis: two
                      truncating siblings shrink in proportion to their content,
                      so a long description ate the label it exists to explain.
                      Stacked, it has the row to itself and wraps — which is the
                      whole reason that layout exists. */}
                  {option.description ? (
                    <span
                      className={cn(
                        "min-w-0 text-ui text-muted-foreground",
                        step.layout === "stacked" ? "text-pretty" : "flex-1 truncate",
                      )}
                    >
                      {option.description}
                    </span>
                  ) : null}
                </span>
                {/* The row's own verb, and only on the row that is one press
                    from an answer: a single choice sends on the click, so the
                    numeral it replaces is standing where the act is. */}
                {prompt.multiple ? null : <AnswerArrow focus="group-focus-visible:opacity-100" />}
              </button>
            );
          })}
        </div>
      )}

      {fieldOpen ? (
        <div
          className={cn(
            "flex min-w-0 items-start gap-2.5 rounded-lg",
            // Beside options it is the last row of the same list, and it wears
            // the row's own padding and number. Alone it is the answer, and a
            // field is what an answer is typed into.
            alone ? "mt-3" : "-mx-2 mt-0.5 px-2 py-2",
          )}
        >
          {alone ? null : (
            <OptionChip
              position={prompt.options.length + 1}
              checked={written.trim().length > 0}
              outlined={false}
              className="mt-1"
            />
          )}
          <Textarea
            ref={fieldRef}
            value={written}
            data-step-entry={alone ? prompt.id : undefined}
            // A placeholder is not a name: it leaves the box unnamed to AT, and
            // it is gone the moment anyone types into it. Alone, the question
            // itself is the name — there is nothing else the box could be.
            aria-label={alone ? undefined : FIELD_LABEL[fieldRole]}
            aria-labelledby={alone ? headingId : undefined}
            placeholder={FIELD_PLACEHOLDER[fieldRole]}
            onChange={(event) => onWrite(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key !== "Enter") return;
              if (event.metaKey || event.ctrlKey) {
                event.preventDefault();
                onAdvance();
                return;
              }
              // Shift is always the newline. Plain Enter is one too where the
              // box is the whole answer — a paragraph is what that question
              // wants — and the commit there is ⌘⏎. Beside options the box is
              // one row of a list nothing else is typed into, so Enter sends.
              if (event.shiftKey || alone) return;
              event.preventDefault();
              onAdvance();
            }}
            className={cn(
              "min-h-9 resize-none text-ui md:text-ui shadow-none",
              alone
                ? "rounded-md"
                : "min-h-6 rounded-none border-0 bg-transparent px-0 py-0 focus-visible:ring-0 dark:bg-transparent",
              wordsDropped && "opacity-50",
            )}
          />
        </div>
      ) : null}
    </fieldset>
  );
}

/**
 * The row's number, and what has become of it.
 *
 * One glyph doing three jobs: it names the row for the key that presses it, it
 * is the box a multiple-choice row is ticked in, and filled it is the answer
 * given. Accent for the fill rather than plain ink, because on this card a
 * filled chip means *chosen* and the card's other filled disc — the arrow — is
 * the act, not the answer.
 */
function OptionChip({
  position,
  checked,
  outlined,
  className,
}: {
  position: number;
  checked: boolean;
  outlined: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        OPTION_MARK,
        outlined && !checked && "border border-muted-foreground/40",
        checked ? "bg-primary font-medium text-primary-foreground" : "text-muted-foreground",
        className,
      )}
    >
      {position}
    </span>
  );
}

/**
 * The occasional request drawer and the composer it comes from.
 *
 * Presence lives here rather than at each mount so the real plane and the Lab
 * exercise one motion contract. The composer remains mounted throughout: its
 * focused textarea keeps focus while the request enters, exits or is replaced.
 */
export function ComposerInteractionStack({
  interaction,
  resolving,
  onResolve,
  onWithdraw,
  children,
  className,
}: React.PropsWithChildren<{
  interaction: SessionInteraction | null;
  resolving?: boolean;
  onResolve(
    interactionId: string,
    submission: InteractionSubmission,
  ): void | Promise<boolean | void>;
  onWithdraw?(interactionId: string): void;
  className?: string;
}>) {
  const reducedMotion = useReducedMotion() ?? false;
  const drawerRef = React.useRef<HTMLFormElement>(null);
  const originRef = React.useRef<HTMLDivElement>(null);
  const restoreComposerFocus = React.useRef(false);
  const transition = {
    duration: reducedMotion ? 0.125 : 0.25,
    ease: [0.32, 0.72, 0, 1] as const,
  };
  const hidden = {
    opacity: 0,
    transform: reducedMotion ? "translateY(0)" : "translateY(8px)",
  };

  React.useLayoutEffect(() => {
    if (restoreComposerFocus.current) {
      restoreComposerFocus.current = false;
      originRef.current?.querySelector<HTMLElement>("textarea:not([disabled])")?.focus();
    }

    // Layout-effect cleanup runs before React removes or replaces the form, so
    // it can still tell whether the departing request owned focus. Only that
    // case restores the persistent composer; an externally resolved request
    // must not pull focus away from somewhere else.
    const drawer = drawerRef.current;
    return () => {
      restoreComposerFocus.current = drawer !== null && drawer.contains(document.activeElement);
    };
  }, [interaction?.id]);

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <PendingInteractionAnnouncement interaction={interaction} />
      <AnimatePresence initial={false} mode="popLayout">
        {interaction ? (
          <motion.div
            key={interaction.id}
            data-slot="composer-interaction-drawer"
            layout={reducedMotion ? false : "position"}
            initial={hidden}
            animate={{ opacity: 1, transform: "translateY(0)" }}
            exit={hidden}
            transition={transition}
          >
            <InteractionCard
              ref={drawerRef}
              interaction={interaction}
              resolving={resolving}
              onResolve={(submission) => onResolve(interaction.id, submission)}
              onWithdraw={onWithdraw ? () => onWithdraw(interaction.id) : undefined}
            />
          </motion.div>
        ) : null}
      </AnimatePresence>
      <motion.div
        ref={originRef}
        data-slot="composer-interaction-origin"
        layout={reducedMotion ? false : "position"}
        transition={transition}
      >
        {children}
      </motion.div>
    </div>
  );
}

/* -------------------------------------------------------------- questions */

/**
 * One question's options and its one text field.
 *
 * Keyed on the prompt at the call site, so stepping through a carousel mounts a
 * fresh set of inputs rather than re-labelling the last one's — which is what
 * keeps a radio group's `name` honest and stops the browser carrying a checked
 * state across two questions that merely sat at the same index.
 */
function InteractionQuestionFields({
  interaction,
  question,
  draft,
  disabled,
  onDraftChange,
  onSubmit,
}: {
  interaction: SessionInteraction;
  question: InteractionQuestion;
  draft: InteractionDraft;
  disabled?: boolean;
  onDraftChange(next: InteractionDraft): void;
  /**
   * Takes the draft the caller wants sent, because a click that answers the
   * card also submits it and that draft is one render ahead of this one.
   */
  onSubmit(next?: InteractionDraft): void;
}) {
  const { prompt, label } = question;
  // Words that only a following message can carry contradict every option on
  // the card — not only the ones beside them — because the refusal they send is
  // one empty resolution for the whole request. Dimming says so, instead of
  // leaving three ticked answers live and discarding them at submit.
  const superseded = interactionRedirected(interaction, draft);
  // The redirection is made of this box's words wherever nothing else can carry
  // them, so that box stays undimmed and live: clearing it is how a reader takes
  // the card back. An answer or a note goes with the refusal like any selection.
  const wordsDropped = promptResponseSuperseded(interaction, prompt, draft);
  const written = promptDraft(draft, prompt.id).response;
  // The one thing only a mounted card can own: the reader asked for the box.
  // Whether it stands open on its own is `promptFieldOpen`'s call, and text
  // already written keeps it open across a step away and back — the draft is
  // what survives the remount, not this flag.
  const [revealed, setRevealed] = React.useState(false);
  const fieldRole = promptFieldRole(prompt, draft);
  const fieldOpen = promptFieldOpen(prompt, draft) || revealed || written.length > 0;
  return (
    <fieldset className="min-w-0">
      {label ? <legend className="mb-1 text-ui font-medium text-foreground">{label}</legend> : null}
      {/* Bled into the card's padding so the marks line up under the ask above
          them, the way the ask-user card's numerals do. */}
      <div className="-mx-2 flex flex-col">
        {prompt.options.map((option) => {
          const polarity = optionPolarity(option);
          const checked = promptDraft(draft, prompt.id).optionIds.includes(option.id);
          return (
            // A standing grant is not a louder yes: it consents to every future
            // call of its kind, so it must never carry the same weight as the
            // one-time one beside it. The down-weighting is ink, not size —
            // a smaller row is a smaller *hit target* for a live control, it
            // sits below the control floor of the pill scale, and it left the
            // options in one list at two different heights. It is also not a
            // second click: costing one taught nobody anything the ink had not
            // already said (`optionSubmitsOnSelect`).
            <label
              key={option.id}
              className={cn(
                OPTION_ROW,
                "hover:bg-muted/40 has-[:focus-visible]:bg-muted/40 has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-ring",
                checked && "bg-muted/70",
                superseded && "cursor-default opacity-50",
              )}
            >
              {/* The native input still owns the group: its `name`, its arrow
                  keys, its label association. Only the drawing moves out here,
                  onto a disc the size of the ask-user card's numeral — a 14px
                  system radio beside an 18px ask read as a different component
                  rather than as the same one asking a different question. */}
              <input
                type={prompt.multiple ? "checkbox" : "radio"}
                name={`${interaction.id}:${prompt.id}`}
                checked={checked}
                disabled={disabled || superseded}
                onChange={() => {
                  const next = selectOption(draft, prompt, option.id);
                  onDraftChange(next);
                  // One question, one verdict, nothing else to say: the click
                  // is the whole decision, so it sends. `optionSubmitsOnSelect`
                  // owns which clicks those are.
                  if (optionSubmitsOnSelect(interaction, prompt, option, draft)) onSubmit(next);
                }}
                className="peer sr-only"
              />
              <span
                aria-hidden
                className={cn(
                  OPTION_MARK,
                  checked
                    ? "bg-primary text-primary-foreground"
                    : "border border-muted-foreground/40",
                  // The same 70% the native input wore, on the mark that
                  // replaced it: ink, and only ink.
                  polarity === "standing" && "opacity-70",
                )}
              >
                {checked ? <CheckIcon className="size-3" weight="bold" /> : null}
              </span>
              <span
                className={cn(
                  "min-w-0 truncate text-ui font-medium",
                  polarity === "standing" ? "text-muted-foreground" : "text-foreground",
                )}
              >
                {option.label}
              </span>
              {/* `flex-1` and not a second `auto` basis: two truncating
                  siblings shrink in proportion to their content, so a long
                  description ate the label it exists to explain. At basis zero
                  the label takes the width it needs and the description fills
                  whatever is left. */}
              {option.description ? (
                <span className="min-w-0 flex-1 truncate text-ui text-muted-foreground">
                  {option.description}
                </span>
              ) : null}
              {optionSubmitsOnSelect(interaction, prompt, option, draft) ? (
                <AnswerArrow focus="peer-focus-visible:opacity-100" />
              ) : null}
            </label>
          );
        })}
      </div>
      {/* That a reader can say "none of these work" is not conditional on a
          harness capability, and where the words reach the harness is
          `promptTextCarrier`'s business — this is only whether the box is
          already open or one press away. Open, it is the tallest thing on the
          card, which is the wrong shape for a permission: three declared
          verdicts are the whole of the ordinary case and nobody types. The
          placeholder is the only label either form needs — the control talks. */}
      {fieldOpen ? (
        <Textarea
          autoFocus={revealed}
          value={written}
          disabled={disabled}
          // A placeholder is not a name: it leaves the box unnamed to AT, and
          // it is gone the moment anyone types into it.
          aria-label={FIELD_LABEL[fieldRole]}
          placeholder={FIELD_PLACEHOLDER[fieldRole]}
          onChange={(event) =>
            onDraftChange(setPromptResponse(draft, prompt.id, event.currentTarget.value))
          }
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              onSubmit();
            }
          }}
          className={cn(
            "mt-2 min-h-9 resize-none rounded-md text-ui shadow-none md:text-ui",
            wordsDropped && "opacity-50",
          )}
        />
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="-ml-2 mt-1 text-muted-foreground"
          disabled={disabled}
          onClick={() => setRevealed(true)}
        >
          {FIELD_LABEL[fieldRole]}
        </Button>
      )}
    </fieldset>
  );
}

/**
 * The counter and the two steps, and nothing else.
 *
 * A number, not a sentence: `2 of 3` is the whole report. It dims while the
 * question in view has nothing to send, so stepping through a request tells the
 * reader what Submit is still waiting on without a line of prose saying so.
 */
function InteractionSteps({
  carousel,
  disabled,
  onStep,
}: {
  carousel: InteractionCarousel;
  disabled?: boolean;
  onStep(index: number): void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="Previous question"
        disabled={disabled || !carousel.hasPrevious}
        onClick={() => onStep(carousel.index - 1)}
      >
        <CaretLeftIcon className="size-3" />
      </Button>
      <span
        className={cn(
          "shrink-0 font-mono text-xs tabular-nums",
          carousel.answered[carousel.index] ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {carousel.index + 1} of {carousel.count}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="Next question"
        disabled={disabled || !carousel.hasNext}
        onClick={() => onStep(carousel.index + 1)}
      >
        <CaretRightIcon className="size-3" />
      </Button>
    </div>
  );
}

/* ---------------------------------------------------------------- receipt */

/**
 * What a resolved interaction leaves at the point in the transcript where it
 * was answered — the same one-line shape a gated tool row leaves, so the
 * transcript stays an honest record of what was authorized whether or not a
 * call was involved.
 */
export function InteractionReceiptLine({
  interaction,
  resolution,
}: {
  interaction: SessionInteraction;
  resolution: SessionInteractionResolution;
}) {
  const receipt = describeInteractionResolution(interaction, resolution);
  return (
    <div className="not-prose flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      {/* Outline: the card that asked wore the filled palm, and this is the
          line it leaves behind once the decision is made. Ink still separates
          the two verdicts; weight is not asked to say it a second time. */}
      <HandPalmIcon
        aria-hidden
        className={cn(
          "size-3.5 shrink-0",
          receipt.verdict === "rejected" ? "text-muted-foreground" : "text-primary",
        )}
      />
      <span className="shrink-0">{receipt.lead}</span>
      <code className="min-w-0 truncate font-mono text-xs text-foreground">{receipt.subject}</code>
      {receipt.trailer ? <span className="shrink-0">{receipt.trailer}</span> : null}
    </div>
  );
}
