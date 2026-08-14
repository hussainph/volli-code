/**
 * The interaction card.
 *
 * One component, two mount points. A permission correlated to a tool call and a
 * question that was never correlated to anything are the same shape here: the
 * harness declares prompts, the card draws them, and the reader answers once.
 * Where it *stands* is the only difference, and it is the caller's to decide:
 *
 *  - **On the row**, under the call it gates, in the transcript. A decision
 *    belongs where it happened, beside the command and its detail. The composer
 *    stays: the turn is blocked, but the reader's place in the conversation is
 *    not, and the card is not standing in the composer's slot.
 *  - **At the foot**, stacked *above* the composer, for an interaction no row
 *    can hold — a question, or a permission the harness raised with no call.
 *    The composer stays: a follow-up can still be typed (or queued) while the
 *    card waits. Stop rides the card as well as the composer, because
 *    withdrawing the question is not the same act as interrupting the turn.
 *
 * The old approval card took a `DynamicToolUIPart` and drew three hardcoded
 * buttons, so an option a harness declared could never reach the screen and an
 * interaction with no call could not be answered at all. This one is the real
 * interaction in both places, which is why it must not be forked into two.
 *
 * A request that asks several things shows one of them at a time, with a
 * counter and a step either way. Movement is free and submission is not: the
 * reader may answer in any order, and Submit waits for all of them because a
 * resolution carries one `answers` array.
 *
 * A refusal is not always one of the options. A permission declares `reject`,
 * an id we mint; a question's option ids are the harness's own encoded values
 * and none of them can mean "no", so a refusal there is a control of the card's
 * and travels as the empty resolution.
 *
 * Every question has a box, and saying "none of these work" is never gated on a
 * harness capability — only *how the words travel* is, and how much of the card
 * the box costs before anyone wants it. Both are `interaction.ts`'s decisions
 * (`promptTextCarrier`, `promptFieldOpen`), not this file's.
 *
 * Decision logic lives in `interaction.ts`. Everything here is presentation
 * plus the four things only a mounted card can own: where focus is, that the
 * reader asked for a box that was not already open, that the last decision did
 * not land, and which keys this surface can act on. No gesture here throws a
 * pending decision away: the card is left, never dismissed.
 */
import * as React from "react";
import {
  CaretLeftIcon,
  CaretRightIcon,
  HandPalmIcon,
  SquareIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import type { SessionInteraction, SessionInteractionResolution } from "@volli/shared";

import {
  describeInteractionResolution,
  emptyInteractionDraft,
  interactionCarousel,
  interactionQuestions,
  interactionRedirected,
  interactionSubmission,
  interactionSubmitLabel,
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
   * The turn's only other exit, at the mount where the composer is not on
   * screen to offer it — as a control and as Escape, which is the same act by
   * keyboard. A card on a row leaves it off: the composer is still there with
   * its own, and two Stops in view are two different-looking ways to do one
   * thing.
   */
  onStop?(): void;
  /** A decision is in flight; the harness's own verdict is what clears the card. */
  resolving?: boolean;
  /**
   * Whether the card takes the keyboard as it mounts. True where it replaced
   * the composer, which held the focus; false on a row, where the composer
   * still has it and a card appearing mid-turn would swallow a keystroke the
   * reader was aiming somewhere else.
   */
  autoFocus?: boolean;
  ref?: React.Ref<HTMLFormElement>;
  className?: string;
}

export function InteractionCard({
  interaction,
  onResolve,
  onStop,
  resolving,
  autoFocus,
  ref,
  className,
}: InteractionCardProps) {
  const [draft, setDraft] = React.useState<InteractionDraft>(() =>
    emptyInteractionDraft(interaction),
  );
  const [step, setStep] = React.useState(0);
  // The decision that did not land. `resolving` says one is in flight and the
  // harness's own verdict is what clears the card, so the only state left
  // unrepresented was the round trip that came back with nothing: the card
  // re-enabled itself and looked exactly like one nobody had pressed.
  const [failed, setFailed] = React.useState(false);
  const questions = interactionQuestions(interaction);
  const carousel = interactionCarousel(interaction, draft, step);
  const asked = questions[carousel?.index ?? 0];
  const refusable = needsOwnRefusal(interaction);
  const submission = interactionSubmission(interaction, draft);
  const submittable = submission !== null && !resolving;
  const own = React.useRef<HTMLFormElement>(null);

  // The composer stays mounted under this card. Taking focus here still
  // keeps the keyboard on the thing that can move the turn forward — the
  // question — instead of leaving it in the textarea behind.
  //
  // On the first answerable control, not on the form. Focusing the form left
  // the caret on a `tabIndex={-1}` element, so the first keystroke after the
  // card mounted did nothing and the keyboard path to a one-word decision was
  // Tab, then an arrow, then Enter. Read off the DOM rather than threaded down
  // as a ref, because which control comes first is a fact about what the
  // harness declared — options, or nothing but a box — and the query answers
  // that without every question shape having to say so.
  //
  // Focus is not selection: an unchecked radio stays unchecked when it takes
  // focus, so nothing here preselects a verdict.
  //
  // Re-seated whenever the card is showing a *different* interaction. Both
  // mounts key on the id today, so this usually runs once on a fresh tree — but
  // a caller that reuses the component leaves an answered question's focus
  // sitting on the next one's controls, and the effect must not depend on a
  // convention outside the file.
  React.useEffect(() => {
    if (!autoFocus) return;
    const form = own.current;
    const first = form?.querySelector<HTMLElement>("input:not(:disabled), textarea:not(:disabled)");
    (first ?? form)?.focus();
  }, [autoFocus, interaction.id]);

  // One door out for both controls, so a refusal that never reached the harness
  // reports itself the same way a submitted answer does. The flag clears on the
  // attempt rather than on the next keystroke: what it says is that the last
  // thing pressed did not land, and that stays true while it is being retried.
  const send = (sending: InteractionSubmission) => {
    setFailed(false);
    const landing = onResolve(sending);
    if (!(landing instanceof Promise)) return;
    void landing.then(
      (landed) => setFailed(landed === false),
      () => setFailed(true),
    );
  };

  // Takes the draft rather than reading it, because the card can send on the
  // click that answers it — and the state that click set is not on `draft` yet.
  const submit = (next: InteractionDraft = draft) => {
    if (resolving) return;
    const sending = next === draft ? submission : interactionSubmission(interaction, next);
    if (sending) send(sending);
  };

  return (
    <form
      ref={mergeRefs(own, ref)}
      tabIndex={-1}
      aria-label={interaction.title}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        // Escape ends the turn; it never dismisses the question, which outlives
        // the turn and leaves the projection only when it is answered or
        // withdrawn. So it does exactly what Stop does, and only where this card
        // has a Stop — at the foot, where withdrawing the question is its own
        // exit next to the composer that still owns interrupt.
        //
        // Where there is none, the key is left to bubble. Swallowing it there
        // meant a card on a row absorbed the one gesture that interrupts from
        // anywhere and offered nothing back: the composer beside it still owns
        // the exit, and a key claimed by a surface that cannot act on it is a
        // key that does nothing.
        if (!onStop) return;
        // Never mid-word: Escape closes an IME's candidate window, and taking
        // that keystroke would end the turn under someone who was typing.
        if (event.nativeEvent.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        if (!resolving) onStop();
      }}
      className={cn(
        "pointer-events-auto overflow-hidden outline-none",
        COMPOSER_STACK_SHELL,
        className,
      )}
    >
      <div className="flex items-start gap-2 px-3 pt-2.5">
        {/* The card's palm, the footer's Warning and the Stop square are the
            only filled glyphs the chat surface has left: an interaction is the
            exception in a transcript that is otherwise outline throughout. */}
        <HandPalmIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-primary" weight="fill" />
        <div className="min-w-0 flex-1">
          <p className="text-sm leading-5 text-foreground">{interaction.title}</p>
          {/* The object of the decision, not a caption on it. This is the
              command or the path being authorized, and at the foot mount it is
              the only place the subject appears at all — truncated to one
              muted line it was the dimmest thing on a card whose whole purpose
              is to show it. Machine text stays mono and `text-xs`; what
              changes is the ink and that it is readable in full, the way the
              scrollable `pre` this card replaced showed it. */}
          {interaction.detail ? (
            <pre className="mt-0.5 max-h-32 overflow-y-auto font-mono text-xs whitespace-pre-wrap break-words text-foreground">
              {interaction.detail}
            </pre>
          ) : null}
        </div>
        {carousel ? (
          <InteractionSteps carousel={carousel} disabled={resolving} onStep={setStep} />
        ) : null}
      </div>

      <div className="px-3 pt-2.5">
        {asked ? (
          <InteractionQuestionFields
            key={asked.prompt.id}
            interaction={interaction}
            question={asked}
            draft={draft}
            disabled={resolving}
            onDraftChange={setDraft}
            onSubmit={submit}
          />
        ) : null}
      </div>

      <div className="mt-2.5 flex items-center gap-1 border-t border-border/70 px-3 py-2">
        {/* Worded, not a bare glyph. Stop is the composer's control, and it
            reads there because it stands beside Send in a row of controls; a
            naked square in the bottom-left corner of a *blocking* card reads as
            a checkbox you have to tick before the card will let you submit,
            which is the worst thing this footer could say.

            Ghost and muted, because Stop is not an answer. It reads at the
            weight of the exit it is — below the verdict beside it, which is
            what the card actually asked for. Two controls at one weight said an
            interrupt and a refusal were the same kind of act. */}
        {onStop ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            disabled={resolving}
            onClick={onStop}
          >
            <SquareIcon className="size-3.5" weight="fill" />
            Stop
          </Button>
        ) : null}
        {/* The decision that never reached the harness. Two words and the ink
            that says which kind of state it is: the controls are live again and
            pressing one is the retry, so there is nothing here to explain. At
            the foot mount a session blocker says it too; on a row there is
            nothing else on screen that would. */}
        {failed ? (
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-destructive">
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
              other half of the same decision, and above Stop because it is one. */}
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
      {label ? <legend className="mb-1 text-sm leading-5 text-foreground">{label}</legend> : null}
      <div className="flex flex-col">
        {prompt.options.map((option) => {
          const polarity = optionPolarity(option);
          const checked = promptDraft(draft, prompt.id).optionIds.includes(option.id);
          return (
            // A standing grant is not a louder yes: it consents to every future
            // call of its kind, so it must never carry the same weight as the
            // one-time one beside it. The down-weighting is ink, not size —
            // a smaller row is a smaller *hit target* for a live control, it
            // sits below the control floor of the pill scale, and it left the
            // options in one list at two different heights.
            <label
              key={option.id}
              className={cn(
                "flex min-w-0 cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-sm transition-colors hover:bg-muted/40 has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-ring",
                superseded && "opacity-50",
              )}
            >
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
                className={cn(
                  "size-3.5 shrink-0 accent-primary outline-none",
                  polarity === "standing" && "opacity-70",
                )}
              />
              <span
                className={cn(
                  "min-w-0 truncate",
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
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  {option.description}
                </span>
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
            "mt-1.5 min-h-9 resize-none rounded-md text-sm shadow-none",
            wordsDropped && "opacity-50",
          )}
        />
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="mt-1 ml-0.5 text-muted-foreground"
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

/* ----------------------------------------------------------------- shared */

/** The card owns focus; a caller may still want a handle on the same node. */
function mergeRefs<T>(own: React.RefObject<T | null>, forwarded: React.Ref<T> | undefined) {
  return (node: T | null) => {
    own.current = node;
    if (typeof forwarded === "function") forwarded(node);
    else if (forwarded) forwarded.current = node;
  };
}
