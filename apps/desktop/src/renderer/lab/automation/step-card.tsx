/**
 * One step: one harness, one prompt, one session — shaped like a chat composer.
 *
 * ── WHY A COMPOSER ────────────────────────────────────────────────────────
 * Line up Cursor's chat box, Claude Code's, Warp's and the shadcn prompt-input.
 * Every one of them offers the same set of choices this card does — model,
 * effort, approvals, context, skills, send — and every one of them renders as
 * ONE thin row of small controls beneath a field that dominates the frame. The
 * field is the subject; everything else is a mark on its edge.
 *
 * The previous version had it exactly inverted: a five-button harness strip, a
 * labelled MODEL row, a labelled EFFORT row, a labelled APPROVALS row and a
 * command ribbon, all stacked ABOVE the prompt. Twelve controls to get to the
 * one thing you actually came to write. Nothing has been removed — the runtime
 * collapsed into a single trigger that states itself in a phrase, and the rest
 * moved into the overflow — but the card now reads the way the reference
 * composers read, because the thing being authored is prose.
 *
 * The field's placeholder does the teaching, which is also lifted: Cursor
 * writes "Plan, Build, / for skills, @ for context" straight into the empty
 * state rather than spending buttons on discovery.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * ── WHY NO COLLAPSED FACE ─────────────────────────────────────────────────
 * Steps used to have two sizes with exactly one open, because an expanded step
 * was 500px and three of them lost the shape of the automation. At this size
 * that problem is gone: a card is its prompt plus one row, so every step in an
 * automation fits on screen at once and the expand/collapse state — along with
 * "which one was open last", and its accent border — stops existing.
 * ──────────────────────────────────────────────────────────────────────────
 */
import * as React from "react";
import { CopyIcon } from "@phosphor-icons/react/dist/csr/Copy";
import { DotsThreeIcon } from "@phosphor-icons/react/dist/csr/DotsThree";
import { LockSimpleIcon } from "@phosphor-icons/react/dist/csr/LockSimple";
import { TrashIcon } from "@phosphor-icons/react/dist/csr/Trash";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";

import { Button } from "@renderer/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import { cn } from "@renderer/lib/utils";

import { ChipEditor, type ChipEditorHandle } from "./chip-editor";
import { ApprovalsPicker, RuntimePicker } from "./runtime-picker";
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

const SKILL_GROUPS: Array<{ source: Skill["source"]; label: string }> = [
  { source: "bundled", label: "Volli" },
  { source: "project", label: "This project" },
  { source: "user", label: "Your machine" },
];

/**
 * `APPENDED_CLI_NOTE`, verbatim and read-only, one click away.
 *
 * Icon only. The word "Appended" was on every card of every automation, saying
 * the same thing each time about a constant — nine identical lines of prose
 * that are read once while you are learning what prose mode is and never again.
 * The lock is the reminder; the popover is the answer.
 */
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

/**
 * Everything a step can do that is not "choose an agent" or "write the prompt".
 *
 * One button instead of five. Skills are grouped by {@link Skill.source} rather
 * than by harness: each vendor scans its own command directory with its own
 * escaping, so a per-harness table would need five adapters just to LIST files
 * — exactly the coupling a BYO-harness app exists to avoid. Skills are the open
 * format all of them read.
 */
function StepMenu({
  step,
  onChange,
  onInsert,
  onDuplicate,
  onRemove,
}: {
  step: AutomationStep;
  onChange: (step: AutomationStep) => void;
  onInsert: (snippet: string) => void;
  onDuplicate: (() => void) | null;
  onRemove: (() => void) | null;
}) {
  const placeholders = step.mode === "placeholders";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-xs" aria-label={`More for ${step.id}`}>
          <DotsThreeIcon weight="bold" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Insert skill</DropdownMenuSubTrigger>
          <DropdownMenuPortal>
            <DropdownMenuSubContent className="w-72">
              {SKILL_GROUPS.map((group, index) => {
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
            </DropdownMenuSubContent>
          </DropdownMenuPortal>
        </DropdownMenuSub>

        {/* Only reachable once placeholders is on, because in prose mode a chip
            is sent as literal braces — offering to insert one would be offering
            to make a mistake. */}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger disabled={!placeholders}>Insert context</DropdownMenuSubTrigger>
          <DropdownMenuPortal>
            <DropdownMenuSubContent className="w-72">
              {CONTEXT_CHIPS.map((chip) => (
                <DropdownMenuItem
                  key={chip.token}
                  onSelect={() => onInsert(`{{${chip.token}}}`)}
                  className="justify-between gap-6"
                >
                  <span className="font-mono">{chip.token}</span>
                  <span className="text-xs text-muted-foreground">{chip.resolves}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuPortal>
        </DropdownMenuSub>

        <DropdownMenuCheckboxItem
          checked={placeholders}
          onCheckedChange={(on) => onChange({ ...step, mode: on ? "placeholders" : "prose" })}
        >
          Resolve placeholders
        </DropdownMenuCheckboxItem>

        {onDuplicate === null && onRemove === null ? null : (
          <>
            <DropdownMenuSeparator />
            {onDuplicate === null ? null : (
              <DropdownMenuItem onSelect={onDuplicate}>
                <CopyIcon weight="fill" />
                Duplicate
              </DropdownMenuItem>
            )}
            {onRemove === null ? null : (
              <DropdownMenuItem variant="destructive" onSelect={onRemove}>
                <TrashIcon weight="fill" />
                Remove
              </DropdownMenuItem>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function StepCard({
  step,
  name,
  onChange,
  onDuplicate,
  onRemove,
}: {
  step: AutomationStep;
  /**
   * The `## heading` this step's prose lives under, editable in place — or null
   * on a one-step automation, where the file writes no headings and naming the
   * step would be naming something nothing will ever print.
   */
  name: React.ReactNode | null;
  onChange: (step: AutomationStep) => void;
  onDuplicate: (() => void) | null;
  onRemove: (() => void) | null;
}) {
  const editorRef = React.useRef<ChipEditorHandle>(null);
  const { mode, instructions } = step;
  const tokens = tokenizeInstructions(instructions, mode);
  const unverifiedSkills = tokens.filter((token) => token.kind === "skill" && !token.known).length;
  const strayPlaceholders = mode === "prose" && tokens.some((token) => token.kind === "chip");

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-border bg-card">
      {name === null ? null : (
        <div className="flex items-center gap-2 px-3 pt-2 pb-0.5">{name}</div>
      )}

      {/* Flush inside the card — no border of its own, because the card already
          is the field's edge and a second rule around the writing would make the
          prompt look like one more setting. */}
      <ChipEditor
        ref={editorRef}
        value={instructions}
        onChange={(value) => onChange({ ...step, instructions: value })}
        mode={mode}
        placeholder="What should this agent do? / for skills"
        // A min and a max, never a fixed height: the editor grows with what you
        // write and then scrolls inside itself rather than pushing the row below
        // off the page — the same bounded-growth rule the composer's body has.
        className="min-h-24 max-h-[32vh] rounded-none border-0 bg-transparent focus-within:border-transparent"
      />

      <div className="flex flex-wrap items-center gap-1 px-1.5 pb-1.5">
        <RuntimePicker
          runtime={step.runtime}
          onChange={(runtime) => onChange({ ...step, runtime })}
        />
        <ApprovalsPicker
          runtime={step.runtime}
          onChange={(runtime) => onChange({ ...step, runtime })}
        />
        <div className="ml-auto flex items-center gap-0.5">
          <AppendedContext />
          <StepMenu
            step={step}
            onChange={onChange}
            onInsert={(snippet) => editorRef.current?.insert(snippet)}
            onDuplicate={onDuplicate}
            onRemove={onRemove}
          />
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
              {"{{ }} is sent literally unless placeholders are resolved"}
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
