/**
 * Harness, model, effort — as three separate controls on the composer row.
 *
 * Decoupled on purpose: a model slug is not owned by one harness (the same
 * `claude-opus-5` string is a legal suggestion under Claude Code, opencode and
 * pi), so fusing them into one "Claude Code · opus · high" phrase made the
 * wrong thing atomic. Switching harness keeps the model; effort and approvals
 * remap onto the new adapter's vocabulary.
 *
 * Effort is a weighted slider painted with the canvas accent (`--primary` /
 * `--primary-text`), the same material language as the theme editor's vibrancy
 * track — not a row of pills. Harnesses that expose no effort dial omit it.
 *
 * Hovering the harness or model control peeks the composed invocation. Today
 * that is a CLI string; if the runtime becomes a GUI later, the same hover
 * still answers "what will this actually launch" — only the spelling inside
 * the popover changes.
 */
import * as React from "react";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";

import { Button } from "@renderer/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@renderer/components/ui/tooltip";
import { cn } from "@renderer/lib/utils";

import { HarnessMark, harnessLabelFor } from "./harness-identity";
import {
  composeCommand,
  HARNESS_ADAPTERS,
  LAB_HARNESS_IDS,
  switchHarness,
  type AutomationRuntime,
  type RuntimeAxis,
} from "./model";

/* ----------------------------------------------------------- command peek */

function CommandPeek({ runtime }: { runtime: AutomationRuntime }) {
  return (
    <div className="flex max-w-[22rem] flex-col gap-1.5">
      <span className="flex items-center gap-1.5 text-label text-muted-foreground">
        <TerminalWindowIcon weight="fill" className="size-3.5" />
        Launches
      </span>
      <code className="flex flex-wrap items-baseline gap-x-1.5 font-mono text-label leading-relaxed">
        {composeCommand(runtime).map((part) => (
          <span key={`${part.flag}:${part.value ?? ""}`} className="text-muted-foreground">
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

/** Hover shows the composed launch; click still opens the control. */
function WithCommandPeek({
  runtime,
  children,
}: {
  runtime: AutomationRuntime;
  children: React.ReactElement;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent
        side="top"
        align="start"
        // Wide enough for a flag line; delay is on the provider.
        className="border border-border bg-popover px-2.5 py-2 text-popover-foreground shadow-md"
      >
        <CommandPeek runtime={runtime} />
      </TooltipContent>
    </Tooltip>
  );
}

/* ---------------------------------------------------------------- harness */

function HarnessPicker({
  runtime,
  onChange,
}: {
  runtime: AutomationRuntime;
  onChange: (runtime: AutomationRuntime) => void;
}) {
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="xs"
              className="gap-1.5 active:scale-[0.97] transition-transform duration-100 ease-out"
            >
              <HarnessMark harnessId={runtime.harnessId} tinted />
              {harnessLabelFor(runtime.harnessId)}
              <CaretDownIcon weight="bold" className="size-3 text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          align="start"
          className="border border-border bg-popover px-2.5 py-2 text-popover-foreground shadow-md"
        >
          <CommandPeek runtime={runtime} />
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" className="w-48">
        {LAB_HARNESS_IDS.map((id) => (
          <DropdownMenuItem
            key={id}
            onSelect={() => onChange(switchHarness(runtime, id))}
            className={cn(id === runtime.harnessId && "text-foreground")}
          >
            <HarnessMark
              harnessId={id}
              tinted={id === runtime.harnessId}
              className="size-3.5"
            />
            {harnessLabelFor(id)}
            {id === runtime.harnessId ? (
              <CheckIcon weight="bold" aria-hidden className="ml-auto size-3 text-primary" />
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* ------------------------------------------------------------------ model */

function ModelPicker({
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
    <WithCommandPeek runtime={runtime}>
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
            "h-7 w-[11.5rem] rounded-md border border-transparent bg-transparent px-2 font-mono text-ui text-foreground",
            "hover:border-border focus-visible:border-ring",
            "outline-none transition-[border-color] duration-150 ease-out motion-reduce:transition-none",
          )}
        />
        {open ? (
          <ul
            id={listId}
            role="listbox"
            aria-label="Suggested models"
            className="absolute top-8 left-0 z-30 w-full min-w-[14rem] overflow-hidden rounded-md border border-border bg-popover py-1 shadow-md"
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
    </WithCommandPeek>
  );
}

/* ----------------------------------------------------------------- effort */

/**
 * Discrete stops on the adapter's scale, as a weighted track.
 *
 * Fill share and accent weight both climb with the stop — low effort is a quiet
 * ember hairline, max is the full `--primary-text` punch from the canvas. The
 * house `input[type=range]` rule paints the track from `--primary` and
 * `--slider-fill`; this control remaps `--primary` locally so the weight can
 * move without inventing a second slider skin.
 */
function EffortSlider({
  axis,
  value,
  onChange,
}: {
  axis: RuntimeAxis;
  value: string | null;
  onChange: (value: string) => void;
}) {
  const index = Math.max(
    0,
    axis.options.findIndex((option) => option.value === value),
  );
  const max = Math.max(1, axis.options.length - 1);
  const fill = (index / max) * 100;
  // 28% → 100% of primary-text mixed over the groove — never fully cold, never
  // a neon scream at the low end.
  const heat = 28 + (fill / 100) * 72;

  return (
    <div className="flex min-w-[8.5rem] items-center gap-2 px-1">
      <input
        type="range"
        min={0}
        max={max}
        step={1}
        value={index}
        aria-label={axis.label}
        aria-valuetext={value ?? undefined}
        onChange={(event) => onChange(axis.options[Number(event.target.value)].value)}
        style={
          {
            "--slider-fill": `${fill}%`,
            "--primary": `color-mix(in oklab, var(--primary-text) ${heat}%, var(--border-strong))`,
          } as React.CSSProperties
        }
        className="w-28"
      />
      <span className="w-11 shrink-0 font-mono text-label text-muted-foreground tabular-nums">
        {value ?? "—"}
      </span>
    </div>
  );
}

/* ---------------------------------------------------------------- approvals */

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

/* ----------------------------------------------------------------- export */

export function RuntimePicker({
  runtime,
  onChange,
}: {
  runtime: AutomationRuntime;
  onChange: (runtime: AutomationRuntime) => void;
}) {
  const effort = HARNESS_ADAPTERS[runtime.harnessId].effort;

  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex flex-wrap items-center gap-0.5">
        <HarnessPicker runtime={runtime} onChange={onChange} />
        <ModelPicker runtime={runtime} onChange={onChange} />
        {effort === null ? null : (
          <EffortSlider
            axis={effort}
            value={runtime.effort}
            onChange={(next) => onChange({ ...runtime, effort: next })}
          />
        )}
      </div>
    </TooltipProvider>
  );
}
