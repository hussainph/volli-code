/**
 * One step: one harness, one prompt, one session — shaped like a chat composer.
 *
 * Skills live on `/` (inline at the caret). Duplicate and Remove sit on a hover
 * strip — the corner `⋯` that used to bury both is gone. Runtime craft has two
 * faces the studio can toggle between; see {@link RuntimePicker}.
 */
import * as React from "react";
import { CopyIcon } from "@phosphor-icons/react/dist/csr/Copy";
import { LockSimpleIcon } from "@phosphor-icons/react/dist/csr/LockSimple";
import { TrashIcon } from "@phosphor-icons/react/dist/csr/Trash";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";

import { Button } from "@renderer/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import { cn } from "@renderer/lib/utils";

import { ChipEditor } from "./chip-editor";
import { ApprovalsPicker, RuntimePicker, type RuntimeCraft } from "./runtime-picker";
import { tokenizeInstructions, APPENDED_CLI_NOTE, type AutomationStep } from "./model";

/**
 * The house entrance transition, in one place because it is used on several
 * state changes and they should not drift apart. It only fires on mount, so
 * every caller earns it by keying the element on the state that changed — which
 * is also what stops it firing while you type.
 */
export const ENTER_CLASS =
  "transition-[opacity,transform,translate,scale] duration-200 ease-out starting:opacity-0 motion-reduce:transition-none";

function AppendedContext() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Context appended to every prompt"
          className="text-muted-foreground"
        >
          <LockSimpleIcon weight="fill" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[30rem]">
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap font-mono text-xs leading-relaxed text-foreground">
          {APPENDED_CLI_NOTE}
        </pre>
      </PopoverContent>
    </Popover>
  );
}

export function StepCard({
  step,
  name,
  craft,
  onChange,
  onDuplicate,
  onRemove,
}: {
  step: AutomationStep;
  name: React.ReactNode | null;
  craft: RuntimeCraft;
  onChange: (step: AutomationStep) => void;
  onDuplicate: (() => void) | null;
  onRemove: (() => void) | null;
}) {
  const { instructions } = step;
  const tokens = tokenizeInstructions(instructions);
  const unverifiedSkills = tokens.filter((token) => token.kind === "skill" && !token.known).length;
  const strayBraces = tokens.some((token) => token.kind === "brace");

  return (
    <div className="group/step flex flex-col overflow-hidden rounded-xl border border-border bg-card">
      {name === null && onDuplicate === null && onRemove === null ? null : (
        <div className="flex items-center gap-2 px-3 pt-2 pb-0.5">
          {name}
          <div
            className={cn(
              "ml-auto flex items-center gap-0.5",
              "opacity-0 transition-opacity duration-150 ease-out motion-reduce:transition-none",
              "group-hover/step:opacity-100 group-focus-within/step:opacity-100",
            )}
          >
            {onDuplicate === null ? null : (
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Duplicate ${step.id}`}
                onClick={onDuplicate}
                className="text-muted-foreground"
              >
                <CopyIcon weight="fill" />
              </Button>
            )}
            {onRemove === null ? null : (
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Remove ${step.id}`}
                onClick={onRemove}
                className="text-muted-foreground hover:text-destructive"
              >
                <TrashIcon weight="fill" />
              </Button>
            )}
          </div>
        </div>
      )}

      <ChipEditor
        value={instructions}
        onChange={(value) => onChange({ ...step, instructions: value })}
        placeholder="What should this agent do? / for skills"
        className="min-h-24 max-h-[32vh] rounded-none border-0 bg-transparent focus-within:border-transparent"
      />

      <div className="flex flex-wrap items-center gap-1 px-1.5 pb-1.5">
        <RuntimePicker
          craft={craft}
          runtime={step.runtime}
          onChange={(runtime) => onChange({ ...step, runtime })}
        />
        <ApprovalsPicker
          runtime={step.runtime}
          onChange={(runtime) => onChange({ ...step, runtime })}
        />
        <div className="ml-auto">
          <AppendedContext />
        </div>
      </div>

      {strayBraces || unverifiedSkills > 0 ? (
        <div className="flex flex-col gap-1 border-t border-border bg-muted/30 px-3 py-1.5">
          {strayBraces ? (
            <p
              className={cn(
                "flex items-center gap-1.5 text-label text-muted-foreground",
                ENTER_CLASS,
              )}
            >
              <WarningIcon className="size-3.5 shrink-0" />
              {"{{ }} is sent to the agent literally — write it in prose instead"}
            </p>
          ) : null}
          {unverifiedSkills > 0 ? (
            <p
              className={cn(
                "flex items-center gap-1.5 text-label text-muted-foreground",
                ENTER_CLASS,
              )}
            >
              <WarningIcon className="size-3.5 shrink-0" />
              {unverifiedSkills === 1 ? "1 skill" : `${unverifiedSkills} skills`} Volli can&rsquo;t
              see — sent as written
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
