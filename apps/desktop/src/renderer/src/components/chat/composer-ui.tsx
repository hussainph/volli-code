/**
 * The Session composer.
 *
 * Three ideas, and the shape follows from them:
 *
 *  1. **One model pill, and only where the model is yours to pick.** Provider is
 *     a heading inside the popover and effort is a segment on the selected row,
 *     because neither is a decision you make on its own — you pick a model, and
 *     the other two qualify it. Codex's shape: two values, one caret. An
 *     executor that pins its own model renders no pill at all rather than a
 *     disabled one, on the same rule as the mode segment below: a control naming
 *     models the harness will drop is worse than no control.
 *  2. **Delivery is session state, not a control.** Idle, ⏎ sends. While a turn
 *     is live the submit glyph becomes Queue, ⏎ queues, ⌘⏎ steers without
 *     interrupting, and ⌫ on an empty box takes the newest queued message back.
 *     Stop appears beside submit only while there is something to stop.
 *
 * Fully controlled: it owns no session state, so the fixture gallery can put it
 * in any of its four states without a running adapter.
 */
import * as React from "react";
import {
  ArrowUpIcon,
  CaretUpDownIcon,
  CheckIcon,
  PencilSimpleIcon,
  QueueIcon,
  SquareIcon,
  XIcon,
} from "@phosphor-icons/react";

import {
  PromptInput,
  PromptInputBody,
  PromptInputCommand,
  PromptInputCommandEmpty,
  PromptInputCommandGroup,
  PromptInputCommandInput,
  PromptInputCommandItem,
  PromptInputCommandList,
  PromptInputFooter,
  PromptInputHeader,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@ai-elements/prompt-input";
import {
  composerIntent,
  takeQueued,
  unqueueLast,
  type ComposerIntent,
  type QueuedMessage,
} from "@renderer/chat/session-model";
import { Button } from "@renderer/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import { cn } from "@renderer/lib/utils";

export interface SessionComposerProps {
  value: string;
  onValueChange(value: string): void;
  /** Lets a decision elsewhere in the Session hand the cursor back to the reader. */
  textareaRef?: React.Ref<HTMLTextAreaElement>;
  models: readonly ComposerModel[];
  offersModelChoice?: boolean;
  selection: ComposerModelSelection;
  onSelectionChange(next: ComposerModelSelection): void;
  /** Model policy is immutable during an active turn. */
  modelChoiceDisabled?: boolean;
  /** A turn is live: submit becomes Queue and Stop joins it. */
  working: boolean;
  /** Something is attached and a model is chosen. False makes the box inert. */
  ready: boolean;
  queued: readonly QueuedMessage[];
  onQueuedChange(next: readonly QueuedMessage[]): void;
  onSubmit(text: string, intent: ComposerIntent): void;
  onStop(): void;
  className?: string;
}

export function SessionComposer({
  value,
  onValueChange,
  textareaRef,
  models,
  offersModelChoice = true,
  selection,
  onSelectionChange,
  modelChoiceDisabled = false,
  working,
  ready,
  queued,
  onQueuedChange,
  onSubmit,
  onStop,
  className,
}: SessionComposerProps) {
  const canSubmit = ready && value.trim().length > 0;

  const send = (intent: ComposerIntent) => {
    if (!canSubmit) return;
    onSubmit(value.trim(), intent);
  };

  const editQueued = (id: string) => {
    const taken = takeQueued(queued, id);
    if (!taken) return;
    onQueuedChange(taken.queue);
    // Prepending keeps whatever is already typed rather than trading one draft
    // for another — unqueue must never be a way to lose a sentence.
    onValueChange(value.trim().length > 0 ? `${taken.text}\n${value}` : taken.text);
  };

  return (
    <PromptInput
      className={cn(
        "pointer-events-auto border-border bg-card shadow-[var(--shadow-raised)]",
        className,
      )}
      onSubmit={() => send(composerIntent({ working, steer: false }))}
    >
      {queued.length > 0 ? (
        <PromptInputHeader className="flex-col items-stretch gap-0.5 border-b border-border/70">
          {queued.map((entry, index) => (
            <div key={entry.id} className="group flex min-w-0 items-center gap-2 text-xs">
              <span className="shrink-0 tabular-nums text-muted-foreground">{index + 1}</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{entry.text}</span>
              <span className="flex shrink-0 items-center opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Edit queued message"
                  onClick={() => editQueued(entry.id)}
                >
                  <PencilSimpleIcon className="size-3" />
                </Button>
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Remove queued message"
                  onClick={() => onQueuedChange(queued.filter((item) => item.id !== entry.id))}
                >
                  <XIcon className="size-3" />
                </Button>
              </span>
            </div>
          ))}
        </PromptInputHeader>
      ) : null}

      <PromptInputBody>
        <PromptInputTextarea
          ref={textareaRef}
          value={value}
          disabled={!ready}
          // A placeholder is not a name — it is gone the moment anyone types —
          // and this is the surface's primary input.
          aria-label="Message"
          placeholder="Ask, plan, or implement…"
          className="min-h-16 text-sm"
          onChange={(event) => onValueChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              // Steer bypasses the form entirely, so the enclosing ⏎ handler
              // never sees a keystroke that means something else.
              event.preventDefault();
              send("steer");
              return;
            }
            if (
              event.key === "Backspace" &&
              event.currentTarget.value === "" &&
              queued.length > 0
            ) {
              event.preventDefault();
              const taken = unqueueLast(queued);
              if (!taken) return;
              onQueuedChange(taken.queue);
              onValueChange(taken.text);
            }
          }}
        />
      </PromptInputBody>

      <PromptInputFooter className="border-t border-border/70 pt-2">
        <PromptInputTools className="min-w-0">
          {offersModelChoice ? (
            <ModelPill
              models={models}
              selection={selection}
              disabled={modelChoiceDisabled}
              onChange={onSelectionChange}
            />
          ) : null}
        </PromptInputTools>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {working ? (
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Stop" onClick={onStop}>
              <SquareIcon className="size-3.5" weight="fill" />
            </Button>
          ) : null}
          <PromptInputSubmit
            status="ready"
            disabled={!canSubmit}
            aria-label={working ? "Queue" : "Send"}
          >
            {working ? (
              <QueueIcon className="size-4" />
            ) : (
              <ArrowUpIcon className="size-4" weight="bold" />
            )}
          </PromptInputSubmit>
        </div>
      </PromptInputFooter>
    </PromptInput>
  );
}

/* ------------------------------------------------------------------- model */

/** `sonnet-4.5 · high` — two values, one caret. */
export interface ComposerModel {
  id: string;
  providerId: string;
  providerLabel: string;
  modelId: string;
  label: string;
  state: "available" | "authentication-required" | "unavailable";
  reasoningLevels: readonly string[];
}

export interface ComposerModelSelection {
  providerId: string;
  modelId: string;
  reasoningLevel: string;
}

export function modelPillLabel(
  models: readonly ComposerModel[],
  selection: ComposerModelSelection,
): string {
  const model = models.find(
    (candidate) =>
      candidate.providerId === selection.providerId && candidate.modelId === selection.modelId,
  );
  const name = model?.label ?? selection.modelId;
  if (!name) return "Model";
  return selection.reasoningLevel ? `${name} · ${selection.reasoningLevel}` : name;
}

function ModelPill({
  models,
  selection,
  disabled,
  onChange,
}: {
  models: readonly ComposerModel[];
  selection: ComposerModelSelection;
  disabled: boolean;
  onChange(next: ComposerModelSelection): void;
}) {
  const [open, setOpen] = React.useState(false);
  // First-appearance order: the catalog's own ordering is the harness's answer
  // to "which provider matters", and re-sorting it here would be our opinion.
  const providers = models.reduce<Array<{ id: string; label: string }>>((result, model) => {
    if (!result.some((provider) => provider.id === model.providerId)) {
      result.push({ id: model.providerId, label: model.providerLabel });
    }
    return result;
  }, []);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={disabled || models.length === 0}
          className="min-w-0 text-muted-foreground"
        >
          <span className="min-w-0 truncate">{modelPillLabel(models, selection)}</span>
          <CaretUpDownIcon className="size-3 shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-80 p-0">
        <PromptInputCommand>
          <PromptInputCommandInput placeholder="Model" />
          <PromptInputCommandList>
            <PromptInputCommandEmpty>No match</PromptInputCommandEmpty>
            {providers.map((provider) => (
              <PromptInputCommandGroup key={provider.id} heading={provider.label}>
                {models
                  .filter((model) => model.providerId === provider.id)
                  .map((model) => {
                    const selected =
                      model.providerId === selection.providerId &&
                      model.modelId === selection.modelId;
                    return (
                      <PromptInputCommandItem
                        key={model.id}
                        value={`${model.providerId} ${model.modelId} ${model.label}`}
                        disabled={model.state !== "available"}
                        onSelect={() => {
                          onChange({
                            ...selection,
                            providerId: model.providerId,
                            modelId: model.modelId,
                            reasoningLevel: model.reasoningLevels.includes(selection.reasoningLevel)
                              ? selection.reasoningLevel
                              : (model.reasoningLevels[0] ?? ""),
                          });
                          setOpen(false);
                        }}
                      >
                        <CheckIcon
                          className={cn("size-3.5 shrink-0", !selected && "invisible")}
                          weight="bold"
                        />
                        <span className="min-w-0 flex-1 truncate">
                          {model.label}
                          {model.state === "authentication-required" ? " — Sign in required" : null}
                          {model.state === "unavailable" ? " — Unavailable" : null}
                        </span>
                        {selected && model.reasoningLevels.length > 1 ? (
                          <EffortSegment
                            variants={model.reasoningLevels}
                            value={selection.reasoningLevel}
                            onChange={(reasoningLevel) =>
                              onChange({ ...selection, reasoningLevel })
                            }
                          />
                        ) : null}
                      </PromptInputCommandItem>
                    );
                  })}
              </PromptInputCommandGroup>
            ))}
          </PromptInputCommandList>
        </PromptInputCommand>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Effort rides the selected row: it qualifies one model rather than standing
 * beside it, and it must not close the popover — changing effort is a smaller
 * decision than changing model, so it stays in place for a second look.
 */
function EffortSegment({
  variants,
  value,
  onChange,
}: {
  variants: readonly string[];
  value: string;
  onChange(variant: string): void;
}) {
  return (
    <span className="flex shrink-0 items-center gap-0.5 rounded-full bg-muted p-0.5">
      {variants.map((variant) => (
        <button
          key={variant}
          type="button"
          aria-pressed={variant === value}
          onClick={(event) => {
            event.stopPropagation();
            onChange(variant);
          }}
          className={cn(
            "rounded-full px-2 py-0.5 text-xs transition-colors duration-150 ease-swift",
            variant === value
              ? "bg-background text-foreground shadow-[var(--shadow-raised)]"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {variant}
        </button>
      ))}
    </span>
  );
}
