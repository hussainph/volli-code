/**
 * Which agent runs, on what model, how hard — as one control on one line.
 *
 * The studio can toggle between two craft faces so we can feel them in situ:
 *
 *   • `composer` — one phrase trigger ("Claude Code · opus · high") opening a
 *     dial panel. Closest to Cursor / Claude Code.
 *   • `pad` — harness marks as origin chips, effort as a weighted meter, model
 *     as a quiet field. Closer to the care in the theme canvas editor.
 *
 * TWO ABSENCES ARE LOAD-BEARING. cursor-agent has no effort flag (it rides in
 * the model string as `model[effort=high]`) and pi documents no approval or
 * sandbox mode at all. Both controls are ABSENT for those harnesses rather than
 * disabled, because a greyed control says "not now" where the truth is "not a
 * thing".
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

export type RuntimeCraft = "composer" | "pad";

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

function ModelField({
  runtime,
  onChange,
}: {
  runtime: AutomationRuntime;
  onChange: (runtime: AutomationRuntime) => void;
}) {
  const adapter = HARNESS_ADAPTERS[runtime.harnessId];
  const [open, setOpen] = React.useState(false);
  const [active, setActive] = React.useState(-1);
  const listId = React.useId();

  function commit(model: string) {
    onChange({ ...runtime, model });
    setOpen(false);
    setActive(-1);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      setOpen(false);
      setActive(-1);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      const step = event.key === "ArrowDown" ? 1 : -1;
      const count = adapter.models.length;
      setActive((current) => (current + step + count) % count);
      return;
    }
    if (event.key === "Enter" && open && active >= 0) {
      event.preventDefault();
      commit(adapter.models[active]);
    }
  }

  return (
    <div className="relative">
      <input
        value={runtime.model}
        onChange={(event) => onChange({ ...runtime, model: event.target.value })}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        onKeyDown={onKeyDown}
        spellCheck={false}
        aria-label="Model"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
        className={cn(
          "h-7 w-full rounded-md border border-border bg-transparent px-2 font-mono text-ui text-foreground",
          "outline-none focus-visible:border-ring",
        )}
      />
      {open ? (
        <ul
          id={listId}
          role="listbox"
          aria-label="Suggested models"
          className="absolute top-8 left-0 z-30 w-full overflow-hidden rounded-md border border-border bg-popover py-1 shadow-md"
        >
          {adapter.models.map((model, index) => (
            <li
              key={model}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              className={cn(
                "cursor-pointer px-2 py-1 font-mono text-label text-muted-foreground",
                "hover:bg-accent hover:text-foreground",
                index === active && "bg-accent text-foreground",
              )}
              onMouseDown={(event) => {
                event.preventDefault();
                commit(model);
              }}
              onClick={() => commit(model)}
            >
              {model}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Segmented effort — composer face. */
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
            "outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
            "aria-pressed:bg-accent aria-pressed:text-foreground",
            "active:scale-[0.97]",
          )}
        >
          {option.value}
        </button>
      ))}
    </div>
  );
}

/**
 * Effort as a weighted meter — pad face.
 *
 * Ordered values fill from the left; the selected stop is a lit cell, quieter
 * cells sit behind it. Same data as {@link ScaleControl}, different material.
 */
function EffortPad({
  axis,
  value,
  onChange,
}: {
  axis: RuntimeAxis;
  value: string | null;
  onChange: (value: string) => void;
}) {
  const selected = axis.options.findIndex((option) => option.value === value);

  return (
    <div
      role="radiogroup"
      aria-label="Effort"
      className="flex w-full items-stretch gap-1 rounded-lg bg-muted/40 p-1"
    >
      {axis.options.map((option, index) => {
        const on = index <= selected && selected >= 0;
        const current = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={current}
            onClick={() => onChange(option.value)}
            className={cn(
              "flex h-8 flex-1 cursor-pointer flex-col items-center justify-center rounded-md",
              "transition-[background-color,color,transform] duration-150 ease-out",
              "motion-reduce:transition-none active:scale-[0.97]",
              "outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
              on ? "bg-primary/20 text-primary-text" : "text-muted-foreground hover:text-foreground",
              current && "ring-1 ring-primary/50",
            )}
          >
            <span className="text-label font-medium tracking-tight">{option.value}</span>
          </button>
        );
      })}
    </div>
  );
}

function HarnessStrip({
  runtime,
  onChange,
}: {
  runtime: AutomationRuntime;
  onChange: (runtime: AutomationRuntime) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Harness"
      className="flex flex-wrap items-center gap-1 border-b border-border p-2"
    >
      {LAB_HARNESS_IDS.map((id) => {
        const on = id === runtime.harnessId;
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(defaultRuntime(id))}
            className={cn(
              "flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-label",
              "transition-[background-color,border-color,color,transform] duration-150 ease-out",
              "motion-reduce:transition-none active:scale-[0.97]",
              "outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
              on
                ? "border-primary/40 bg-primary/15 text-primary-text"
                : "border-border text-muted-foreground hover:text-foreground",
            )}
          >
            <HarnessMark harnessId={id} tinted={on} className="size-3.5" />
            {harnessLabelFor(id)}
          </button>
        );
      })}
    </div>
  );
}

function ComposerTrigger({
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
        <Button
          variant="ghost"
          size="xs"
          className="gap-1.5 active:scale-[0.97] transition-transform duration-100 ease-out"
        >
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
              onClick={() => onChange(defaultRuntime(id))}
              className={cn(
                "flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-ui",
                "text-muted-foreground transition-colors duration-150 ease-out motion-reduce:transition-none",
                "hover:bg-accent hover:text-foreground active:scale-[0.99]",
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

function PadTrigger({
  runtime,
  onChange,
}: {
  runtime: AutomationRuntime;
  onChange: (runtime: AutomationRuntime) => void;
}) {
  const adapter = HARNESS_ADAPTERS[runtime.harnessId];
  const summary = [harnessLabelFor(runtime.harnessId), runtime.effort]
    .filter((part): part is string => part !== null && part !== "")
    .join(" · ");

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          className="gap-1.5 border border-border/80 bg-muted/30 active:scale-[0.97] transition-[transform,background-color] duration-100 ease-out"
        >
          <HarnessMark harnessId={runtime.harnessId} tinted />
          <span className="text-foreground">{summary}</span>
          <CaretDownIcon weight="bold" className="size-3 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[22rem] p-0">
        <HarnessStrip runtime={runtime} onChange={onChange} />
        <div className="flex flex-col gap-2 p-2.5">
          <ModelField runtime={runtime} onChange={onChange} />
          {adapter.effort === null ? null : (
            <EffortPad
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

export function RuntimePicker({
  runtime,
  onChange,
  craft = "composer",
}: {
  runtime: AutomationRuntime;
  onChange: (runtime: AutomationRuntime) => void;
  craft?: RuntimeCraft;
}) {
  return craft === "pad" ? (
    <PadTrigger runtime={runtime} onChange={onChange} />
  ) : (
    <ComposerTrigger runtime={runtime} onChange={onChange} />
  );
}

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
        <Button
          variant="ghost"
          size="xs"
          className="gap-1.5 font-mono text-muted-foreground active:scale-[0.97] transition-transform duration-100 ease-out"
        >
          {runtime.approvals ?? <span className="font-sans italic">approvals</span>}
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
