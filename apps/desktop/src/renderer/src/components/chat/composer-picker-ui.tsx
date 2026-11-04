/**
 * The composer's `/` and `@` picker, as a card in the composer stack.
 *
 * A card, not a popover, and that is the whole design. A popover is anchored to
 * a control you clicked; this is anchored to a caret that moves, and it opens
 * because of what you typed rather than what you pressed. So it takes the same
 * slot the ask-user card takes — full width, above the input, on the shared
 * {@link COMPOSER_STACK_SHELL} — without moving the input or delaying the keyboard.
 *
 * **Focus never leaves the textarea.** cmdk is driven from outside: no
 * `CommandInput`, a controlled `value`, and `shouldFilter={false}` because the
 * ranking is already done (`chat/composer-picker.ts` — the same `@` grammar the
 * editor's autocomplete uses). What cmdk is here for is what it is good at:
 * the listbox roles, the row primitives, and scrolling the active row into
 * view. Arrow keys are handled by the composer, which still owns the keystroke,
 * and a picker that stole focus would take ⏎ and ⌫ with it — two keys this
 * composer has already given other meanings.
 *
 * It never competes for the slot: an interaction card mounted means the picker
 * is closed, decided one level up in `SessionComposer`.
 */
import * as React from "react";
import { ArrowsClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowsClockwise";
import { ArrowsInLineVerticalIcon } from "@phosphor-icons/react/dist/csr/ArrowsInLineVertical";
import { MagicWandIcon } from "@phosphor-icons/react/dist/csr/MagicWand";
import { CpuIcon } from "@phosphor-icons/react/dist/csr/Cpu";
import { CopyIcon } from "@phosphor-icons/react/dist/csr/Copy";
import { FileIcon } from "@phosphor-icons/react/dist/csr/File";
import { GearIcon } from "@phosphor-icons/react/dist/csr/Gear";
import { NotePencilIcon } from "@phosphor-icons/react/dist/csr/NotePencil";
import { SignInIcon } from "@phosphor-icons/react/dist/csr/SignIn";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";

import {
  PromptInputCommand,
  PromptInputCommandEmpty,
  PromptInputCommandGroup,
  PromptInputCommandItem,
  PromptInputCommandList,
} from "@renderer/components/ui/ai-elements/prompt-input";
import { COMPOSER_STACK_SHELL } from "@volli/session-presentation";
import type { ComposerPickerMode, ComposerPickerRow } from "@renderer/chat/composer-picker";
import type { ComposerVerbName } from "@volli/shared";
import { cn } from "@renderer/lib/utils";

/** The group heading each mode files its rows under. Nouns, not sentences. */
const MODE_HEADING: Record<ComposerPickerMode, string> = {
  command: "Commands",
  file: "Files",
};

/**
 * Command mode leads with verbs, then iterates the headings carried by the
 * slash source registry. The picker does not keep a parallel list of command,
 * skill, MCP or plugin groups: a future adapter's first resolved row creates
 * its group here, in the same order ranking handed it to the keyboard.
 *
 * "Actions" remains separate because a verb RUNS something and every open
 * source row writes something, the distinction a reader needs before ⏎.
 */
function groupedRows(
  rows: readonly ComposerPickerRow[],
): readonly { heading: string; rows: readonly ComposerPickerRow[] }[] {
  const groups: { heading: string; rows: ComposerPickerRow[] }[] = [];
  const verbs = rows.filter((row) => row.kind === "verb");
  if (verbs.length > 0) groups.push({ heading: "Actions", rows: [...verbs] });
  for (const row of rows) {
    if (row.kind !== "command" && row.kind !== "skill") continue;
    const current = groups.find((group) => group.heading === row.heading);
    if (current === undefined) groups.push({ heading: row.heading, rows: [row] });
    else current.rows.push(row);
  }
  // A card showing nothing still needs one group to hang "No match" under.
  return groups.length > 0 ? groups : [{ heading: "Commands", rows: [] }];
}

/**
 * THE LIST, AND NOT THE TOKEN IT COMPLETES. This used to take the whole
 * `ComposerPickerState`, which meant it took `from`, `to` and `query` — three
 * numbers and a string that move on every keystroke and that nothing in here
 * draws. So the card re-rendered fifty `cmdk` rows per character to show the
 * fifty rows it was already showing. The token belongs to the code that writes
 * over it; a list needs a mode and its rows.
 *
 * Memoized on that, so the keystrokes whose ranking the composer deliberately
 * skipped cost this card nothing at all.
 */
export const ComposerPicker = React.memo(function ComposerPicker({
  mode,
  rows,
  active,
  onActiveChange,
  onSelect,
  className,
}: {
  /** The open picker's mode, or null for closed. Presence drives the animation. */
  mode: ComposerPickerMode | null;
  rows: readonly ComposerPickerRow[];
  /** The row the composer's arrow keys have moved to — cmdk's controlled value. */
  active: string;
  onActiveChange(value: string): void;
  onSelect(row: ComposerPickerRow): void;
  className?: string;
}) {
  // Caret-driven lists are keyboard interactions: open and close immediately.
  return mode === null ? null : (
    <div
      key={mode}
      data-slot="composer-picker"
      className={cn("pointer-events-auto overflow-hidden", COMPOSER_STACK_SHELL, className)}
    >
      <PromptInputCommand
        // The ranking already happened, in the same module the editor's
        // autocomplete ranks with. cmdk re-filtering it here would drop
        // subsequence matches that grammar deliberately kept.
        shouldFilter={false}
        value={active}
        onValueChange={onActiveChange}
        className="bg-transparent"
        // The textarea holds focus and forwards the keys; nothing in here
        // is a tab stop, and a click lands via the row's own handler.
        aria-label={MODE_HEADING[mode]}
      >
        <PromptInputCommandList className="max-h-64">
          <PromptInputCommandEmpty>No match</PromptInputCommandEmpty>
          {(mode === "command" ? groupedRows(rows) : [{ heading: MODE_HEADING[mode], rows }]).map(
            (group) => (
              <PromptInputCommandGroup key={group.heading} heading={group.heading}>
                {group.rows.map((row) => (
                  <PromptInputCommandItem
                    key={row.value}
                    value={row.value}
                    onSelect={() => onSelect(row)}
                    className="gap-2"
                  >
                    <RowIcon row={row} />
                    {/* `shrink-0` was here to keep the NAME whole while the
                          directory beside it gave — the right priority, and the
                          wrong mechanism. It is `flex: 0 0 auto` against a detail
                          that is already `flex: 1 1 0%`, so the directory yields
                          every pixel it has before this span is asked for
                          anything: the priority is in the two flex bases, not in
                          the shrink factor. What `shrink-0` added on top was a
                          name that could not truncate AT ALL — measured in a
                          265px composer (the app's own default at its 940px
                          window minimum), a 53-character filename ran 110px out
                          through the card's right edge, `truncate` and all. */}
                    <span className="min-w-0 truncate text-foreground">{row.label}</span>
                    {row.detail ? (
                      <span className="min-w-0 flex-1 truncate text-ui text-muted-foreground">
                        {row.detail}
                      </span>
                    ) : null}
                  </PromptInputCommandItem>
                ))}
              </PromptInputCommandGroup>
            ),
          )}
        </PromptInputCommandList>
      </PromptInputCommand>
    </div>
  );
});

/**
 * One glyph per verb, because the glyph names the ACT and not the category —
 * the category is already the group heading's job. Two arrows closing onto one
 * line is a history collapsed into a summary; a processor names model selection;
 * arrows in a circle re-read the disk. Skills carry a wand and authored
 * artifacts a writing glyph, distinct from files and terminal commands.
 *
 * A `Record` on the closed name union rather than a `switch`: add a verb and
 * this fails to compile naming the verb that has no glyph. The switch this
 * replaced could not do that — it sat inside an `if` in a function with more
 * to return, so a missing arm just fell through.
 */
const VERB_ICONS: Record<
  ComposerVerbName,
  React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>
> = {
  compact: ArrowsInLineVerticalIcon,
  copy: CopyIcon,
  model: CpuIcon,
  reload: ArrowsClockwiseIcon,
  settings: GearIcon,
  login: SignInIcon,
};

/**
 * Outline throughout — a scannable list is outline except for its own
 * exceptions, and this list has none: every row is the same kind of thing.
 * The artifact glyph differs from the file glyph because they ARE different
 * things, not because one is emphasised.
 */
function RowIcon({ row }: { row: ComposerPickerRow }) {
  if (row.kind === "verb") {
    const VerbIcon = VERB_ICONS[row.verb.name];
    return <VerbIcon aria-hidden className="size-4 shrink-0 text-foreground" />;
  }
  if (row.kind === "command")
    return <TerminalWindowIcon aria-hidden className="size-4 shrink-0 text-foreground" />;
  if (row.kind === "skill")
    return <MagicWandIcon aria-hidden className="size-4 shrink-0 text-foreground" />;
  return row.artifact ? (
    <NotePencilIcon aria-hidden className="size-4 shrink-0 text-foreground" />
  ) : (
    <FileIcon aria-hidden className="size-4 shrink-0 text-foreground" />
  );
}
