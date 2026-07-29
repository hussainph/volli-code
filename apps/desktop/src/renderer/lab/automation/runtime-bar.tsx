/**
 * Which agent runs, on what model, how hard, and what it is allowed to do
 * without asking.
 *
 * ── WHY THIS IS A SURFACE AND NOT A CHIP ROW ──────────────────────────────
 * This used to be four pills in a recessed `bg-muted` strip below the prompt,
 * on the reasoning that an Automation IS the writing and everything else is a
 * setting on it. That reasoning holds right up until the automation fires
 * unattended, which is the only way an automation ever fires: the prompt decides
 * what a run attempts, and THIS decides what it costs, how long it takes, and
 * whether it stalls forever on an approval prompt nobody is watching. Those are
 * not annotations on a piece of writing. They are the other half of the object.
 *
 * So it is a real region with its own labels, sitting at the top of the step
 * where a step's identity belongs — which is also what makes a two-step
 * automation readable, since "who runs this one" is the only thing that
 * distinguishes step 2 from step 1 at a glance.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * ── WHY THE COMMAND RIBBON ────────────────────────────────────────────────
 * Every dial here needs to answer "what does this actually do", and the honest
 * answer is a flag. A sentence under each control would be a paraphrase the
 * reader has to trust; `--permission-mode acceptEdits` is the thing itself, in a
 * notation this app's entire audience already reads fluently.
 *
 * It also does a job no prose could. The five adapters express the same three
 * ideas in five different dialects — `--effort high` / `-c
 * model_reasoning_effort=high` / `--variant high` / `--thinking high` / nothing
 * at all — and the ribbon is where that stops being a claim in a doc comment and
 * becomes something you watch happen when you click a different mark.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * TWO ABSENCES ARE LOAD-BEARING. cursor-agent has no effort flag (it rides in
 * the model string as `model[effort=high]`) and pi documents no approval or
 * sandbox mode at all. Both rows are ABSENT for those harnesses rather than
 * disabled, because a greyed control says "not now" where the truth is "not a
 * thing" — see `model.ts`'s adapter table, which is where that fact lives.
 */
import * as React from "react";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";

import { Button } from "@renderer/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { cn } from "@renderer/lib/utils";

import { HarnessMark, harnessLabelFor } from "./harness-identity";
import {
  composeCommand,
  defaultRuntime,
  HARNESS_ADAPTERS,
  LAB_HARNESS_IDS,
  type AutomationRuntime,
  type LabHarnessId,
  type RuntimeAxis,
} from "./model";

/** Label left, control right, so the labels form one scannable column. */
function Dial({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-7 items-center gap-3">
      <h4 className="w-20 shrink-0 font-mono text-label uppercase text-muted-foreground">
        {label}
      </h4>
      <div className="flex min-w-0 flex-1 items-center">{children}</div>
    </div>
  );
}

/**
 * The harness row: five marks, five names, all visible, one click each.
 *
 * A dropdown would be smaller and would be wrong. Choosing the harness is the
 * decision this whole region exists to make legible, and a closed menu shows one
 * answer where the point is that there are five — it also puts the fastest,
 * most-repeated action on this form behind an open-then-aim.
 */
function HarnessStrip({
  harnessId,
  onPick,
}: {
  harnessId: LabHarnessId;
  onPick: (harnessId: LabHarnessId) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {LAB_HARNESS_IDS.map((id) => (
        <button
          key={id}
          type="button"
          onClick={() => onPick(id)}
          aria-pressed={id === harnessId}
          className={cn(
            "flex items-center gap-1.5 rounded-md border border-transparent px-2 py-1 text-ui",
            "text-muted-foreground transition-[background-color,color,border-color] duration-150 ease-out",
            "hover:bg-accent hover:text-foreground motion-reduce:transition-none",
            "aria-pressed:border-border aria-pressed:bg-accent aria-pressed:text-foreground",
          )}
        >
          {/* Unpicked marks drop to currentColor so the row reads as one control
              with a selection, not five competing logos. */}
          <HarnessMark harnessId={id} tinted={id === harnessId} className="size-3.5" />
          {harnessLabelFor(id)}
        </button>
      ))}
    </div>
  );
}

/**
 * Effort: a segmented scale, because the values ARE ordered and the ordering is
 * the only thing that makes `xhigh` mean anything. Approvals gets a menu instead
 * — its values are a choice, not a scale, and `bypassPermissions` next to
 * `acceptEdits` in a segmented row would imply a progression that isn't there.
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
    <div className="flex w-fit items-center gap-0.5 rounded-md border border-border p-0.5">
      {axis.options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          aria-pressed={option.value === value}
          className={cn(
            "rounded px-2 py-0.5 text-label text-muted-foreground",
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

function ChoiceControl({
  axis,
  value,
  onChange,
}: {
  axis: RuntimeAxis;
  value: string | null;
  onChange: (value: string) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="xs" className="gap-1.5 border border-border font-mono">
          {value ?? axis.options[0].value}
          <CaretDownIcon weight="bold" className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup value={value ?? ""} onValueChange={onChange}>
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

/** Combobox, not a select: the suggestion list is a shortcut, the text is the truth. */
function ModelControl({
  runtime,
  onChange,
}: {
  runtime: AutomationRuntime;
  onChange: (runtime: AutomationRuntime) => void;
}) {
  const adapter = HARNESS_ADAPTERS[runtime.harnessId];
  const [open, setOpen] = React.useState(false);

  return (
    <div className="relative w-full max-w-80">
      <input
        value={runtime.model}
        onChange={(event) => onChange({ ...runtime, model: event.target.value })}
        onFocus={() => setOpen(true)}
        // Blur is deferred a frame so a click on a suggestion lands before the
        // list unmounts underneath the pointer.
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        spellCheck={false}
        aria-label="Model"
        className="h-7 w-full rounded-md border border-border bg-transparent px-2 font-mono text-ui text-foreground outline-none focus-visible:border-ring"
      />
      {open ? (
        <ul className="absolute top-8 left-0 z-30 w-full overflow-hidden rounded-md border border-border bg-popover py-1 shadow-md">
          {adapter.models.map((model) => (
            <li key={model}>
              <button
                type="button"
                onMouseDown={() => onChange({ ...runtime, model })}
                className="w-full px-2 py-1 text-left font-mono text-label text-muted-foreground hover:bg-accent hover:text-foreground"
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
 * The composed command. Flags recede, chosen values stay in foreground — so the
 * line reads as "these are your answers, in the notation that will be used",
 * rather than as a wall of mono.
 */
function CommandRibbon({ runtime }: { runtime: AutomationRuntime }) {
  const parts = composeCommand(runtime);
  return (
    <div className="overflow-x-auto rounded-md bg-muted/50 px-2 py-1">
      <code className="flex w-max items-baseline gap-x-1.5 whitespace-nowrap font-mono text-label">
        {parts.map((part) => (
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

export function RuntimeBar({
  runtime,
  onChange,
}: {
  runtime: AutomationRuntime;
  onChange: (runtime: AutomationRuntime) => void;
}) {
  const adapter = HARNESS_ADAPTERS[runtime.harnessId];

  return (
    <div className="flex flex-col gap-2 border-b border-border px-3 py-2.5">
      <HarnessStrip
        harnessId={runtime.harnessId}
        // Switching harness cannot carry the old model, effort or approval mode
        // across — they are expressed in the previous adapter's dialect, and
        // three of the five don't even share a vocabulary. Resetting to the new
        // adapter's own defaults is the only honest move; "same prompt, other
        // harness" is served by duplicating the step, not by a portable field.
        onPick={(harnessId) => onChange(defaultRuntime(harnessId))}
      />

      <div className="flex flex-col gap-1.5">
        <Dial label="Model">
          <ModelControl runtime={runtime} onChange={onChange} />
        </Dial>

        {adapter.effort === null ? null : (
          <Dial label={adapter.effort.label}>
            <ScaleControl
              axis={adapter.effort}
              value={runtime.effort}
              onChange={(effort) => onChange({ ...runtime, effort })}
            />
          </Dial>
        )}

        {adapter.approvals === null ? null : (
          <Dial label={adapter.approvals.label}>
            <ChoiceControl
              axis={adapter.approvals}
              value={runtime.approvals}
              onChange={(approvals) => onChange({ ...runtime, approvals })}
            />
          </Dial>
        )}
      </div>

      <CommandRibbon runtime={runtime} />
    </div>
  );
}
