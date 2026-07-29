/**
 * Which agent runs, on what model, how hard — as one control on one line.
 *
 * ── WHAT THIS REPLACES ────────────────────────────────────────────────────
 * `RuntimeBar` put all of this ABOVE the prompt as a labelled region: a strip
 * of five harness buttons with five logos and five names, then a MODEL row with
 * a 320px input, then an EFFORT row of five segments, then an APPROVALS row,
 * then the command ribbon. Around 180px of chrome on top of the writing, on
 * every step, always. Its defence was that an unattended run's cost and blast
 * radius are not annotations on a piece of writing.
 *
 * That defence is still right and the layout was still wrong, which every
 * shipped agent composer demonstrates: Cursor, Claude Code and Warp all carry
 * the same set of choices — model, effort, approvals, context, skills — and all
 * of them render it as one thin row of small controls UNDER the field, where
 * the biggest thing on screen is the thing you are writing. Cursor goes
 * furthest and collapses model-and-effort into a single trigger reading
 * "Cursor Grok 4.5 High".
 *
 * So: one trigger that states the whole runtime in a phrase, opening a panel
 * with the actual dials. Three visible controls per step instead of twelve, and
 * nothing is gone — it moved one click away, which for a value you set once per
 * automation and read on every glance is the right trade.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * TWO ABSENCES ARE LOAD-BEARING. cursor-agent has no effort flag (it rides in
 * the model string as `model[effort=high]`) and pi documents no approval or
 * sandbox mode at all. Both controls are ABSENT for those harnesses rather than
 * disabled, because a greyed control says "not now" where the truth is "not a
 * thing" — see `model.ts`'s adapter table, which is where that fact lives.
 */
import * as React from "react";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";

import { Button } from "@renderer/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import { cn } from "@renderer/lib/utils";

import { HarnessMark, harnessLabelFor } from "./harness-identity";
import {
  composeCommand,
  defaultRuntime,
  HARNESS_ADAPTERS,
  LAB_HARNESS_IDS,
  type AutomationRuntime,
  type RuntimeAxis,
} from "./model";

/**
 * The composed command, at the bottom of the panel where the choices are made.
 *
 * Every dial needs to answer "what does this actually do", and the honest
 * answer is a flag — a sentence under each control would be a paraphrase the
 * reader has to trust, where `--permission-mode acceptEdits` is the thing
 * itself, in a notation this app's entire audience already reads fluently. It
 * is also the only way to show that the five adapters spell the same three
 * ideas five different ways, which stops being a claim in a doc comment and
 * becomes something you watch happen when you click a different mark.
 */
function CommandRibbon({ runtime }: { runtime: AutomationRuntime }) {
  return (
    <div className="overflow-x-auto border-t border-border px-2.5 py-1.5">
      <code className="flex w-max items-baseline gap-x-1.5 whitespace-nowrap font-mono text-label">
        {composeCommand(runtime).map((part) => (
          <span key={part.flag} className="text-muted-foreground">
            {part.flag}
            {part.value === undefined ? null : (
              <span className="pl-1 text-foreground">{part.value}</span>
            )}
          </span>
        ))}
      </code>
    </div>
  );
}

/** Combobox, not a select: the suggestion list is a shortcut, the text is the truth. */
function ModelField({
  runtime,
  onChange,
}: {
  runtime: AutomationRuntime;
  onChange: (runtime: AutomationRuntime) => void;
}) {
  const adapter = HARNESS_ADAPTERS[runtime.harnessId];
  const [open, setOpen] = React.useState(false);

  return (
    <div className="relative">
      <input
        value={runtime.model}
        onChange={(event) => onChange({ ...runtime, model: event.target.value })}
        onFocus={() => setOpen(true)}
        // Blur is deferred a frame so a click on a suggestion lands before the
        // list unmounts underneath the pointer.
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        spellCheck={false}
        aria-label="Model"
        className={cn(
          "h-7 w-full rounded-md border border-border bg-transparent px-2 font-mono text-ui text-foreground",
          "outline-none focus-visible:border-ring",
        )}
      />
      {open ? (
        <ul className="absolute top-8 left-0 z-30 w-full overflow-hidden rounded-md border border-border bg-popover py-1 shadow-md">
          {adapter.models.map((model) => (
            <li key={model}>
              <button
                type="button"
                onMouseDown={() => onChange({ ...runtime, model })}
                className="w-full cursor-pointer px-2 py-1 text-left font-mono text-label text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                {model}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Effort is a segmented scale, because the values ARE ordered and the ordering
 * is the only thing that makes `xhigh` mean anything.
 */
function ScaleControl({
  axis,
  value,
  onChange,
}: {
  axis: RuntimeAxis;
  value: string | null;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex w-full items-center gap-0.5 rounded-md border border-border p-0.5">
      {axis.options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          aria-pressed={option.value === value}
          className={cn(
            "flex-1 cursor-pointer rounded px-1.5 py-0.5 text-label text-muted-foreground",
            "transition-[background-color,color] duration-150 ease-out",
            "hover:text-foreground motion-reduce:transition-none",
            "aria-pressed:bg-accent aria-pressed:text-foreground",
          )}
        >
          {option.value}
        </button>
      ))}
    </div>
  );
}

/** `Claude Code  opus-5 · high` — the whole runtime as a phrase you can read at a glance. */
export function RuntimePicker({
  runtime,
  onChange,
}: {
  runtime: AutomationRuntime;
  onChange: (runtime: AutomationRuntime) => void;
}) {
  const adapter = HARNESS_ADAPTERS[runtime.harnessId];
  const summary = [runtime.model, adapter.effort === null ? null : runtime.effort]
    .filter((part): part is string => part !== null && part !== "")
    .join(" · ");

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="xs" className="gap-1.5">
          <HarnessMark harnessId={runtime.harnessId} tinted />
          {harnessLabelFor(runtime.harnessId)}
          <span className="font-mono text-muted-foreground">{summary}</span>
          <CaretDownIcon weight="bold" className="size-3 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <div className="flex flex-col p-1">
          {LAB_HARNESS_IDS.map((id) => (
            <button
              key={id}
              type="button"
              // Switching harness cannot carry the old model, effort or approval
              // mode across — they are expressed in the previous adapter's
              // dialect, and three of the five don't even share a vocabulary.
              // Resetting to the new adapter's own defaults is the only honest
              // move; "same prompt, other harness" is served by duplicating the
              // step, not by a portable field.
              onClick={() => onChange(defaultRuntime(id))}
              className={cn(
                "flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-ui",
                "text-muted-foreground transition-colors duration-150 ease-out motion-reduce:transition-none",
                "hover:bg-accent hover:text-foreground",
                id === runtime.harnessId && "text-foreground",
              )}
            >
              <HarnessMark harnessId={id} tinted={id === runtime.harnessId} className="size-3.5" />
              {harnessLabelFor(id)}
              {id === runtime.harnessId ? (
                <CheckIcon weight="bold" aria-hidden className="ml-auto size-3 text-primary" />
              ) : null}
            </button>
          ))}
        </div>

        <div className="flex flex-col gap-1.5 border-t border-border p-2">
          <ModelField runtime={runtime} onChange={onChange} />
          {adapter.effort === null ? null : (
            <ScaleControl
              axis={adapter.effort}
              value={runtime.effort}
              onChange={(effort) => onChange({ ...runtime, effort })}
            />
          )}
        </div>

        <CommandRibbon runtime={runtime} />
      </PopoverContent>
    </Popover>
  );
}

/**
 * Approvals stays out on the row rather than inside the panel above.
 *
 * It is the one dial that decides what happens while nobody is watching, and
 * every other choice here is about quality or cost. A menu, not a scale:
 * `bypassPermissions` next to `acceptEdits` in a segmented row would imply a
 * progression that isn't there.
 */
export function ApprovalsPicker({
  runtime,
  onChange,
}: {
  runtime: AutomationRuntime;
  onChange: (runtime: AutomationRuntime) => void;
}) {
  const axis = HARNESS_ADAPTERS[runtime.harnessId].approvals;
  if (axis === null) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="xs" className="gap-1.5 font-mono text-muted-foreground">
          {runtime.approvals ?? axis.options[0].value}
          <CaretDownIcon weight="bold" className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup
          value={runtime.approvals ?? ""}
          onValueChange={(approvals) => onChange({ ...runtime, approvals })}
        >
          {axis.options.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value} className="font-mono">
              {option.value}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
