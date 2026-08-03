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
 *  - **At the foot**, in the composer's slot, for an interaction no row can
 *    hold — a question, or a permission the harness raised with no call. There
 *    is nothing to type while it waits, so the composer and the plan dock stand
 *    down and the card takes the whole surface. Stop rides along, because that
 *    is the exit the composer took with it.
 *
 * The old approval card took a `DynamicToolUIPart` and drew three hardcoded
 * buttons, so an option a harness declared could never reach the screen and an
 * interaction with no call could not be answered at all. This one is the real
 * interaction in both places, which is why it must not be forked into two.
 *
 * A request that asks several things shows one of them at a time, with a
 * counter and a step either way. Movement is free and submission is not: the
 * reader may answer in any order, and Submit waits for all of them because
 * OpenCode takes one `answers` array per request.
 *
 * A refusal is not always one of the options. A permission declares `reject`,
 * an id we mint; a question's option ids are the harness's own encoded values
 * and none of them can mean "no", so a refusal there is a control of the card's
 * and travels as the empty resolution.
 *
 * Decision logic lives in `interaction.ts`. Everything here is presentation
 * plus the two things only a mounted card can own: where focus is, and that
 * there is no gesture which throws a pending decision away.
 */
import * as React from "react";
import { CaretLeftIcon, CaretRightIcon, HandPalmIcon, SquareIcon } from "@phosphor-icons/react";
import type { SessionInteraction, SessionInteractionResolution } from "@volli/shared";

import { Button } from "@renderer/components/ui/button";
import { Textarea } from "@renderer/components/ui/textarea";
import { cn } from "@renderer/lib/utils";

import {
  canSubmitInteraction,
  describeInteractionResolution,
  emptyInteractionDraft,
  interactionCarousel,
  interactionQuestions,
  interactionResolution,
  needsOwnRefusal,
  optionPolarity,
  promptDraft,
  promptFieldRole,
  promptTakesText,
  refusalResolution,
  selectOption,
  setPromptResponse,
  type InteractionCarousel,
  type InteractionDraft,
  type InteractionFieldRole,
  type InteractionQuestion,
} from "./interaction";

/* ------------------------------------------------------------------- card */

const FIELD_PLACEHOLDER: Record<InteractionFieldRole, string> = {
  answer: "Your answer",
  note: "Note",
  redirection: "What to do instead",
};

export interface InteractionCardProps {
  interaction: SessionInteraction;
  onResolve(resolution: SessionInteractionResolution): void;
  /**
   * The turn's only other exit, at the mount where the composer is not on
   * screen to offer it. A card on a row leaves it off: the composer is still
   * there with its own, and two Stops in view are two different-looking ways to
   * do one thing.
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
  const questions = interactionQuestions(interaction);
  const carousel = interactionCarousel(interaction, draft, step);
  const asked = questions[carousel?.index ?? 0];
  const refusable = needsOwnRefusal(interaction);
  const submittable = canSubmitInteraction(interaction, draft) && !resolving;
  const own = React.useRef<HTMLFormElement>(null);

  // The composer this replaced held the focus. Taking it here keeps the
  // keyboard on the one thing that can move the turn forward instead of
  // dropping it on the document body when the composer unmounts.
  React.useEffect(() => {
    if (autoFocus) own.current?.focus();
  }, [autoFocus]);

  const submit = () => {
    if (!submittable) return;
    onResolve(interactionResolution(interaction, draft));
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
        // Nothing here dismisses the card. Escape is swallowed rather than left
        // to bubble: an ancestor closing on it would take the question off
        // screen while the turn is still waiting for its answer, and a decision
        // that vanished without being made is the deadlock this card exists to
        // remove. The exits are Submit and Stop, and both are buttons.
        if (event.key === "Escape") event.stopPropagation();
      }}
      className={cn(
        "pointer-events-auto mb-2 rounded-xl border border-primary/40 bg-card shadow-[var(--shadow-raised)] outline-none",
        className,
      )}
    >
      <div className="flex items-start gap-2 px-3 pt-2.5">
        <HandPalmIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-primary" weight="fill" />
        <div className="min-w-0 flex-1">
          <p className="text-sm leading-5 text-foreground">{interaction.title}</p>
          {interaction.detail ? (
            <p
              className="truncate font-mono text-xs text-muted-foreground"
              title={interaction.detail}
            >
              {interaction.detail}
            </p>
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
            disabled={resolving === true}
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
            which is the worst thing this footer could say. */}
        {onStop ? (
          <Button type="button" variant="ghost" size="sm" disabled={resolving} onClick={onStop}>
            <SquareIcon className="size-3.5" weight="fill" />
            Stop
          </Button>
        ) : null}
        {/* A refusal the harness did not declare an option for. It is a control
            rather than a row in the list because none of a question's option
            ids can mean "no" — they are the harness's own encoded values, and
            one labelled `reject` would otherwise refuse itself when chosen. It
            sends the empty resolution, so whatever was selected and abandoned
            goes with it rather than travelling alongside the refusal. */}
        {refusable ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="ml-auto"
            disabled={resolving}
            onClick={() => onResolve(refusalResolution(interaction))}
          >
            Reject
          </Button>
        ) : null}
        {/* Disabled rather than swapped for a spinner: the round trip is one
            HTTP reply and the harness's own verdict is what replaces the card,
            so a progress affordance would flash for less time than it reads.
            What matters is that a second click cannot land. */}
        <Button
          type="submit"
          size="sm"
          className={cn(!refusable && "ml-auto")}
          disabled={!submittable}
        >
          Submit
        </Button>
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
  disabled: boolean;
  onDraftChange(next: InteractionDraft): void;
  onSubmit(): void;
}) {
  const { prompt, label } = question;
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
            // one-time one beside it. Muting the label alone left the two rows
            // the same size and the same shape, which is what "identical
            // weight" looked like on screen; the secondary tier is a step down
            // the type scale as well.
            <label
              key={option.id}
              className={cn(
                "flex min-w-0 cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 transition-colors hover:bg-muted/40 has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-ring",
                polarity === "standing" ? "text-xs" : "text-sm",
              )}
            >
              <input
                type={prompt.multiple ? "checkbox" : "radio"}
                name={`${interaction.id}:${prompt.id}`}
                checked={checked}
                disabled={disabled}
                onChange={() => onDraftChange(selectOption(draft, prompt, option.id))}
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
              {option.description ? (
                <span className="min-w-0 truncate text-xs text-muted-foreground">
                  {option.description}
                </span>
              ) : null}
            </label>
          );
        })}
      </div>
      {promptTakesText(prompt) ? (
        <Textarea
          value={promptDraft(draft, prompt.id).response}
          disabled={disabled}
          placeholder={FIELD_PLACEHOLDER[promptFieldRole(prompt, draft)]}
          onChange={(event) =>
            onDraftChange(setPromptResponse(draft, prompt.id, event.currentTarget.value))
          }
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              onSubmit();
            }
          }}
          className="mt-1.5 min-h-9 resize-none rounded-md text-sm shadow-none"
        />
      ) : null}
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
      <HandPalmIcon
        aria-hidden
        className={cn(
          "size-3.5 shrink-0",
          receipt.verdict === "rejected" ? "text-muted-foreground" : "text-primary",
        )}
        weight="fill"
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
