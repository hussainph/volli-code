/**
 * Harness and model stay decoupled on the composer row; effort lives inside
 * the model popover — a stepped, weighted rail, not a native range dumped on
 * the prompt.
 *
 * The row reads `Claude Code` · `opus-5 · high` · `plan`. Opening the model
 * control reveals a small composer: a model field with suggestions, then the
 * effort rail underneath. Harnesses with no effort dial omit the rail.
 *
 * Hovering harness or model peeks the composed launch *below* the control so
 * it never covers the prompt the author is writing. Today that peek is a CLI
 * string; a GUI runtime later only changes the spelling inside.
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
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
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

const PEEK_CONTENT =
  "border border-border bg-popover px-2.5 py-2 text-popover-foreground shadow-md";

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
        <TooltipContent side="bottom" align="start" sideOffset={8} className={PEEK_CONTENT}>
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
            <HarnessMark harnessId={id} tinted={id === runtime.harnessId} className="size-3.5" />
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

/* ---------------------------------------------------------- effort rail */

/**
 * A stepped, weighted effort rail.
 *
 * Not a native `<input type="range">`. Each stop is a visible notch; the fill
 * thickens and heats (canvas `--primary-text`) as it climbs, so the control
 * has mass rather than just a position. Pointer scrub snaps to the nearest
 * stop; keyboard arrows step one notch.
 *
 * ─────────────────────────────────────────────────────────
 * ANIMATION STORYBOARD
 *
 *    0ms   thumb press → scale 0.97
 *  drag    fill + heat track pointer 1:1, snap preview on nearest stop
 * release  spring settle onto the stop (CSS ease-out 160ms)
 * ─────────────────────────────────────────────────────────
 */
function EffortRail({
  axis,
  value,
  onChange,
}: {
  axis: RuntimeAxis;
  value: string | null;
  onChange: (value: string) => void;
}) {
  const trackRef = React.useRef<HTMLDivElement>(null);
  const index = Math.max(
    0,
    axis.options.findIndex((option) => option.value === value),
  );
  const max = Math.max(1, axis.options.length - 1);
  const t = index / max;
  const [dragging, setDragging] = React.useState(false);

  function indexFromClientX(clientX: number): number {
    const track = trackRef.current;
    if (track === null) return index;
    const rect = track.getBoundingClientRect();
    const x = Math.min(Math.max(clientX - rect.left, 0), rect.width);
    return Math.round((x / rect.width) * max);
  }

  function commitFromPointer(clientX: number) {
    onChange(axis.options[indexFromClientX(clientX)].value);
  }

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
    commitFromPointer(event.clientX);
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!dragging) return;
    commitFromPointer(event.clientX);
  }

  function onPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    if (!dragging) return;
    setDragging(false);
    commitFromPointer(event.clientX);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Already released.
    }
  }

  // Heat climbs with the stop — quiet ember at low, full primary-text at max.
  const heat = 32 + t * 68;
  const fillColor = `color-mix(in oklab, var(--primary-text) ${heat}%, var(--border-strong))`;
  // Track thickness also climbs a little — weight, not just colour.
  const fillHeight = 4 + t * 4;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-label text-muted-foreground">{axis.label}</span>
        <span className="font-mono text-label text-foreground">{value ?? "—"}</span>
      </div>

      <div
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label={axis.label}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={index}
        aria-valuetext={value ?? undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => setDragging(false)}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight" || event.key === "ArrowUp") {
            event.preventDefault();
            onChange(axis.options[Math.min(index + 1, max)].value);
          }
          if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
            event.preventDefault();
            onChange(axis.options[Math.max(index - 1, 0)].value);
          }
          if (event.key === "Home") {
            event.preventDefault();
            onChange(axis.options[0].value);
          }
          if (event.key === "End") {
            event.preventDefault();
            onChange(axis.options[max].value);
          }
        }}
        className={cn(
          "relative flex h-8 cursor-pointer items-center outline-none",
          "focus-visible:ring-[3px] focus-visible:ring-ring/50 rounded-md",
        )}
      >
        {/* Groove */}
        <span aria-hidden className="absolute inset-x-0 h-1 rounded-full bg-border-strong/80" />

        {/* Weighted fill — thickens and heats as effort climbs */}
        <span
          aria-hidden
          className={cn(
            "absolute left-0 rounded-full",
            "transition-[width,height,background-color] duration-150 ease-out",
            "motion-reduce:transition-none",
            dragging && "transition-none",
          )}
          style={{
            width: `${t * 100}%`,
            height: fillHeight,
            background: fillColor,
            boxShadow:
              t > 0.55 ? `0 0 12px color-mix(in oklab, ${fillColor} 45%, transparent)` : undefined,
          }}
        />

        {/* Step notches */}
        {axis.options.map((option, at) => {
          const on = at <= index;
          const left = (at / max) * 100;
          return (
            <span
              key={option.value}
              aria-hidden
              className={cn(
                "absolute top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full",
                "transition-colors duration-150 ease-out motion-reduce:transition-none",
                on ? "bg-primary-foreground/90" : "bg-muted-foreground/45",
              )}
              style={{ left: `${left}%` }}
            />
          );
        })}

        {/* Thumb */}
        <span
          aria-hidden
          className={cn(
            "absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full",
            "border-2 border-background shadow-md",
            "transition-[left,transform,background-color] duration-150 ease-out",
            "motion-reduce:transition-none",
            dragging && "scale-[0.97] transition-none",
          )}
          style={{
            left: `${t * 100}%`,
            background: fillColor,
          }}
        />
      </div>

      <div className="flex justify-between font-mono text-[10px] tracking-wide text-muted-foreground/70 uppercase">
        <span>{axis.options[0]?.value}</span>
        <span>{axis.options[max]?.value}</span>
      </div>
    </div>
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
  const draftRef = React.useRef<HTMLInputElement>(null);

  const summary = [runtime.model, adapter.effort === null ? null : runtime.effort]
    .filter((part): part is string => part !== null && part !== "")
    .join(" · ");

  function pickModel(model: string) {
    onChange({ ...runtime, model });
    setActive(-1);
    // Stay open — author may still want to tune effort. Focus returns to field.
    requestAnimationFrame(() => draftRef.current?.focus());
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      setActive(-1);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      const count = adapter.models.length;
      setActive((current) => (current + step + count) % count);
      return;
    }
    if (event.key === "Enter" && active >= 0) {
      event.preventDefault();
      pickModel(adapter.models[active]);
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="xs"
              className="gap-1.5 font-mono active:scale-[0.97] transition-transform duration-100 ease-out"
            >
              <span className="text-foreground">{summary || "model"}</span>
              <CaretDownIcon weight="bold" className="size-3 text-muted-foreground" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="start" sideOffset={8} className={PEEK_CONTENT}>
          <CommandPeek runtime={runtime} />
        </TooltipContent>
      </Tooltip>

      <PopoverContent
        align="start"
        side="bottom"
        sideOffset={8}
        className="w-[20rem] p-0"
        // Keep focus on the model field; don't steal it for the effort rail.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          draftRef.current?.focus();
        }}
      >
        {/* Composer layout: field dominates, dials sit under it. */}
        <div className="flex flex-col">
          <div className="border-b border-border px-2.5 pt-2.5 pb-2">
            <input
              ref={draftRef}
              value={runtime.model}
              onChange={(event) => onChange({ ...runtime, model: event.target.value })}
              onKeyDown={onKeyDown}
              spellCheck={false}
              aria-label="Model"
              role="combobox"
              aria-expanded
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
              placeholder="Model"
              className={cn(
                "h-8 w-full rounded-md bg-transparent px-1.5 font-mono text-ui text-foreground",
                "outline-none placeholder:text-muted-foreground",
                "focus-visible:ring-[3px] focus-visible:ring-ring/50",
              )}
            />
          </div>

          <ul
            id={listId}
            role="listbox"
            aria-label="Suggested models"
            className="max-h-40 overflow-y-auto py-1"
          >
            {adapter.models.map((model, index) => {
              const selected = model === runtime.model;
              return (
                <li key={model} role="option" aria-selected={selected || index === active}>
                  <button
                    type="button"
                    id={`${listId}-${index}`}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => pickModel(model)}
                    className={cn(
                      "flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left font-mono text-label",
                      "transition-colors duration-100 ease-out motion-reduce:transition-none",
                      "active:scale-[0.99]",
                      index === active || selected
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">{model}</span>
                    {selected ? (
                      <CheckIcon weight="bold" aria-hidden className="size-3 text-primary" />
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>

          {adapter.effort === null ? null : (
            <div className="border-t border-border px-3 py-3">
              <EffortRail
                axis={adapter.effort}
                value={runtime.effort}
                onChange={(effort) => onChange({ ...runtime, effort })}
              />
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
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
  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex flex-wrap items-center gap-0.5">
        <HarnessPicker runtime={runtime} onChange={onChange} />
        <ModelPicker runtime={runtime} onChange={onChange} />
      </div>
    </TooltipProvider>
  );
}
