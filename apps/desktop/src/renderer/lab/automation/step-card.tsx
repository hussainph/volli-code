/**
 * One step: one harness, one prompt, one session.
 *
 * The card is the unit the automation is a list of. v1 produces exactly one and
 * has to look like a form rather than like a workflow builder collapsed to n=1,
 * which is why nothing here numbers itself, and why the duplicate/remove actions
 * only exist once there is more than one step to disambiguate.
 *
 * ── WHERE THE APPENDED CONTEXT WENT ───────────────────────────────────────
 * {@link APPENDED_CLI_NOTE} used to sit open beneath the editor, welded to it,
 * on the argument that an author must see exactly what the agent was told before
 * deciding how much of it to repeat. That argument is right about the need and
 * wrong about the frequency: it is read once, while you are learning what prose
 * mode even is, and after that it is nine identical lines of chrome on every
 * view of every automation forever. It is a popover now — one click from the
 * editor's own toolbar, verbatim, still not editable.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * The mode control is a switch rather than a menu. A menu of two implies two
 * peers you must choose between; the truth is that prose is the door and
 * placeholders is an escape hatch you turn on for the rare prompt that has to
 * control ordering. A switch says exactly that, and it says it in one click
 * instead of two.
 */
import * as React from "react";
import { CopyIcon } from "@phosphor-icons/react/dist/csr/Copy";
import { LockSimpleIcon } from "@phosphor-icons/react/dist/csr/LockSimple";
import { TrashIcon } from "@phosphor-icons/react/dist/csr/Trash";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";

import { Button } from "@renderer/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import { Switch } from "@renderer/components/ui/switch";
import { cn } from "@renderer/lib/utils";

import { ChipEditor, type ChipEditorHandle } from "./chip-editor";
import { RuntimeBar } from "./runtime-bar";
import {
  APPENDED_CLI_NOTE,
  CONTEXT_CHIPS,
  SKILLS,
  tokenizeInstructions,
  type AutomationStep,
  type Skill,
} from "./model";

/**
 * The house entrance transition, in one place because it is used on several
 * state changes and they should not drift apart. It only fires on mount, so
 * every caller earns it by keying the element on the state that changed — which
 * is also what stops it firing while you type.
 */
export const ENTER_CLASS =
  "transition-[opacity,transform,translate,scale] duration-200 ease-out starting:opacity-0 motion-reduce:transition-none";

/**
 * Skills, grouped by {@link Skill.source} rather than by harness. Each vendor
 * scans its own command directory with its own escaping, so a per-harness table
 * would need five adapters just to LIST files — exactly the coupling a
 * BYO-harness app exists to avoid. Skills are the open format all of them read.
 */
function SkillPicker({ onInsert }: { onInsert: (snippet: string) => void }) {
  const groups: Array<{ source: Skill["source"]; label: string }> = [
    { source: "bundled", label: "Volli" },
    { source: "project", label: "This project" },
    { source: "user", label: "Your machine" },
  ];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="xs" className="font-mono text-muted-foreground">
          /Skill
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        {groups.map((group, index) => {
          const skills = SKILLS.filter((skill) => skill.source === group.source);
          if (skills.length === 0) return null;
          return (
            <React.Fragment key={group.source}>
              {index > 0 ? <DropdownMenuSeparator /> : null}
              <DropdownMenuLabel>{group.label}</DropdownMenuLabel>
              {skills.map((skill) => (
                <DropdownMenuItem
                  key={skill.name}
                  onSelect={() => onInsert(skill.name)}
                  className="justify-between gap-6"
                >
                  <span className="font-mono">{skill.name}</span>
                  <span className="text-xs text-muted-foreground">{skill.detail}</span>
                </DropdownMenuItem>
              ))}
            </React.Fragment>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** `APPENDED_CLI_NOTE`, verbatim and read-only, one click away. */
function AppendedContext() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="xs" className="text-muted-foreground">
          <LockSimpleIcon weight="fill" />
          Appended
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
  onChange,
  onDuplicate,
  onRemove,
}: {
  step: AutomationStep;
  onChange: (step: AutomationStep) => void;
  /** Both null on a single-step automation — there is nothing to disambiguate. */
  onDuplicate: (() => void) | null;
  onRemove: (() => void) | null;
}) {
  const editorRef = React.useRef<ChipEditorHandle>(null);
  const { mode, instructions } = step;
  const tokens = tokenizeInstructions(instructions, mode);
  const unverifiedSkills = tokens.filter((token) => token.kind === "skill" && !token.known).length;
  const strayPlaceholders = mode === "prose" && tokens.some((token) => token.kind === "chip");

  function insert(snippet: string) {
    editorRef.current?.insert(snippet);
  }

  return (
    <div className="relative flex flex-col overflow-hidden rounded-lg border border-border bg-card">
      <RuntimeBar runtime={step.runtime} onChange={(runtime) => onChange({ ...step, runtime })} />

      {onDuplicate === null || onRemove === null ? null : (
        <div className="absolute top-2 right-2 flex items-center gap-0.5">
          <Button variant="ghost" size="icon-xs" aria-label="Duplicate step" onClick={onDuplicate}>
            <CopyIcon />
          </Button>
          <Button variant="ghost" size="icon-xs" aria-label="Remove step" onClick={onRemove}>
            <TrashIcon />
          </Button>
        </div>
      )}

      {/* The editor sits flush inside the card — no border of its own, because
          the card already is the field's edge and a second rule around the
          writing would make the prompt look like one more setting. */}
      <ChipEditor
        ref={editorRef}
        value={instructions}
        onChange={(value) => onChange({ ...step, instructions: value })}
        mode={mode}
        // A min and a max, never a fixed height: the editor grows with what you
        // write and then scrolls inside itself rather than pushing the toolbar
        // off the page — the same bounded-growth rule the composer's body has.
        className="min-h-40 max-h-[38vh] rounded-none border-0 bg-transparent focus-within:border-transparent"
      />

      <div className="flex flex-wrap items-center gap-1.5 border-t border-border px-2 py-1.5">
        <SkillPicker onInsert={insert} />

        {mode === "placeholders"
          ? CONTEXT_CHIPS.map((chip) => (
              <button
                key={chip.token}
                type="button"
                title={`Resolves to ${chip.resolves}`}
                onClick={() => insert(`{{${chip.token}}}`)}
                className="rounded-full border border-dashed border-border px-2 py-0.5 font-mono text-label text-muted-foreground transition-colors hover:border-solid hover:text-foreground"
              >
                {chip.label}
              </button>
            ))
          : null}

        <div className="ml-auto flex items-center gap-3">
          <AppendedContext />
          <label className="flex cursor-pointer items-center gap-1.5 text-label text-muted-foreground">
            Placeholders
            <Switch
              checked={mode === "placeholders"}
              onCheckedChange={(on) => onChange({ ...step, mode: on ? "placeholders" : "prose" })}
              aria-label="Placeholders"
            />
          </label>
        </div>
      </div>

      {/* Both notes can be true at once, so they stack rather than compete for
          one slot — and they sit last, because appearing and disappearing as you
          type must not shift the buttons you are aiming at. */}
      {strayPlaceholders || unverifiedSkills > 0 ? (
        <div className="flex flex-col gap-1 border-t border-border bg-muted/30 px-3 py-1.5">
          {strayPlaceholders ? (
            <p
              className={cn(
                "flex items-center gap-1.5 text-label text-muted-foreground",
                ENTER_CLASS,
              )}
            >
              <WarningIcon className="size-3.5 shrink-0" />
              {"{{ }} is sent literally unless Placeholders is on"}
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
