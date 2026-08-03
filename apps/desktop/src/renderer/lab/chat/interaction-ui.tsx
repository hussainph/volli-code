/**
 * The interaction card, and the marker a gated tool row wears while it waits.
 *
 * One home for every interaction. A permission correlated to a tool call and a
 * question that was never correlated to anything are the same shape here: the
 * harness declares prompts, the card draws them, and the reader answers once.
 * The old approval card took a `DynamicToolUIPart` and drew three hardcoded
 * buttons, so an option a harness declared could never reach the screen and an
 * interaction with no call could not be answered at all.
 *
 * It stands in the composer's slot rather than in scrollback. While a turn is
 * waiting on an answer there is nothing to type — a composer under a blocking
 * question is an invitation to write into a void — so the card takes the whole
 * foot surface, and the plan dock and the blocked row stand down for it.
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
import { HandPalmIcon, SquareIcon } from "@phosphor-icons/react";
import type { SessionInteraction, SessionInteractionResolution } from "@volli/shared";

import { Button } from "@renderer/components/ui/button";
import { Textarea } from "@renderer/components/ui/textarea";
import { cn } from "@renderer/lib/utils";

import {
  canSubmitInteraction,
  describeInteractionResolution,
  emptyInteractionDraft,
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
  type InteractionDraft,
  type InteractionFieldRole,
} from "./interaction";

/* ------------------------------------------------------------------ focus */

/**
 * How a gated row points at the card holding its question.
 *
 * Null when nothing is pending, which is also what the fixture gallery
 * provides: the marker degrades to a plain word rather than a button that
 * would lead nowhere.
 */
const InteractionFocusContext = React.createContext<(() => void) | null>(null);

export function InteractionFocusProvider({
  focus,
  children,
}: React.PropsWithChildren<{ focus: (() => void) | null }>) {
  return (
    <InteractionFocusContext.Provider value={focus}>{children}</InteractionFocusContext.Provider>
  );
}

export function useInteractionFocus(): (() => void) | null {
  return React.useContext(InteractionFocusContext);
}

/**
 * The one thing a row waiting on a decision says.
 *
 * Machine register, in the meta column where every other row puts its receipt,
 * and in the attention tone — a gate is not a duration. Its glyph is already
 * distinct upstream: approval never shares one with running.
 */
export function GatedMarker() {
  const focus = useInteractionFocus();
  const label = "waiting on you";
  if (!focus) return <span className="shrink-0 font-mono text-xs text-primary">{label}</span>;
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        focus();
      }}
      className="shrink-0 rounded font-mono text-xs text-primary underline decoration-transparent decoration-dotted underline-offset-[3px] transition-colors hover:decoration-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      {label}
    </button>
  );
}

/* ------------------------------------------------------------------- card */

const FIELD_PLACEHOLDER: Record<InteractionFieldRole, string> = {
  answer: "Your answer",
  note: "Note",
  redirection: "What to do instead",
};

export interface InteractionCardProps {
  interaction: SessionInteraction;
  onResolve(resolution: SessionInteractionResolution): void;
  /** The turn's only other exit. It leaves with the composer, so it lands here. */
  onStop?(): void;
  /** A decision is in flight; the harness's own verdict is what clears the card. */
  resolving?: boolean;
  ref?: React.Ref<HTMLFormElement>;
  className?: string;
}

export function InteractionCard({
  interaction,
  onResolve,
  onStop,
  resolving,
  ref,
  className,
}: InteractionCardProps) {
  const [draft, setDraft] = React.useState<InteractionDraft>(() =>
    emptyInteractionDraft(interaction),
  );
  const questions = interactionQuestions(interaction);
  const refusable = needsOwnRefusal(interaction);
  const submittable = canSubmitInteraction(interaction, draft) && !resolving;
  const own = React.useRef<HTMLFormElement>(null);

  // The composer this replaced held the focus. Taking it here keeps the
  // keyboard on the one thing that can move the turn forward instead of
  // dropping it on the document body when the composer unmounts.
  React.useEffect(() => own.current?.focus(), []);

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
      </div>

      <div className="space-y-3 px-3 pt-2.5">
        {questions.map(({ prompt, label }) => (
          <fieldset key={prompt.id} className="min-w-0">
            {label ? (
              <legend className="mb-1 text-sm leading-5 text-foreground">{label}</legend>
            ) : null}
            <div className="flex flex-col">
              {prompt.options.map((option) => {
                const polarity = optionPolarity(option);
                const checked = promptDraft(draft, prompt.id).optionIds.includes(option.id);
                return (
                  <label
                    key={option.id}
                    className="flex min-w-0 cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-sm transition-colors hover:bg-muted/40 has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-ring"
                  >
                    <input
                      type={prompt.multiple ? "checkbox" : "radio"}
                      name={`${interaction.id}:${prompt.id}`}
                      checked={checked}
                      disabled={resolving}
                      onChange={() => setDraft(selectOption(draft, prompt, option.id))}
                      className="size-3.5 shrink-0 accent-primary outline-none"
                    />
                    {/* A standing grant is not a louder yes: it consents to
                        every future call of its kind, so it never carries the
                        same weight as the one-time one beside it. */}
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
                disabled={resolving}
                placeholder={FIELD_PLACEHOLDER[promptFieldRole(prompt, draft)]}
                onChange={(event) =>
                  setDraft(setPromptResponse(draft, prompt.id, event.currentTarget.value))
                }
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    submit();
                  }
                }}
                className="mt-1.5 min-h-9 resize-none rounded-md text-sm shadow-none"
              />
            ) : null}
          </fieldset>
        ))}
      </div>

      <div className="mt-2.5 flex items-center gap-1 border-t border-border/70 px-3 py-2">
        {onStop ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Stop"
            disabled={resolving}
            onClick={onStop}
          >
            <SquareIcon className="size-3.5" weight="fill" />
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
