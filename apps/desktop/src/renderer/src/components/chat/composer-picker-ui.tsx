/**
 * The composer's `/` and `@` picker, as a card in the composer stack.
 *
 * A card, not a popover, and that is the whole design. A popover is anchored to
 * a control you clicked; this is anchored to a caret that moves, and it opens
 * because of what you typed rather than what you pressed. So it takes the same
 * slot the ask-user card takes — full width, above the input, on the shared
 * {@link COMPOSER_STACK_SHELL} — and enters on the same motion, because a
 * reader who has seen one of them arrive has learned how this surface behaves.
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
import { FileIcon } from "@phosphor-icons/react/dist/csr/File";
import { NoteIcon } from "@phosphor-icons/react/dist/csr/Note";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

import {
  PromptInputCommand,
  PromptInputCommandEmpty,
  PromptInputCommandGroup,
  PromptInputCommandItem,
  PromptInputCommandList,
} from "@renderer/components/ui/ai-elements/prompt-input";
import { COMPOSER_STACK_SHELL } from "@renderer/chat/composer-stack";
import type { ComposerPickerMode, ComposerPickerRow } from "@renderer/chat/composer-picker";
import { cn } from "@renderer/lib/utils";

/** The group heading each mode files its rows under. Nouns, not sentences. */
const MODE_HEADING: Record<ComposerPickerMode, string> = {
  command: "Commands",
  file: "Files",
};

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
  const reducedMotion = useReducedMotion() ?? false;
  // The exact recipe ComposerInteractionStack enters on — one contract for
  // everything that parks on the composer. Opacity and an 8px rise, and nothing
  // else: no `layout`, here or on any ancestor. This card mounts *inside* the
  // composer, so a layout prop would take the composer into Framer's projection
  // tree and FLIP it on every keystroke that opens or closes this list — see
  // `ComposerInteractionStack`. The card never needs measuring anyway; it enters
  // from nothing and leaves to nothing, in a slot the stack already owns.
  const transition = {
    duration: reducedMotion ? 0.125 : 0.25,
    ease: [0.32, 0.72, 0, 1] as const,
  };
  const hidden = {
    opacity: 0,
    transform: reducedMotion ? "translateY(0)" : "translateY(8px)",
  };

  return (
    // Sync, for the reason `ComposerInteractionStack` spells out: a popped card
    // has no projection parent left to hold it in place, so it would drop out of
    // frame instead of fading where it stood. In flow, the list leaves from its
    // own slot — and on a `/`→`@` switch the two lists overlap for one
    // transition, growing the stack upward and never touching the input.
    <AnimatePresence initial={false}>
      {mode === null ? null : (
        <motion.div
          // Keyed on the mode, not on the query: re-ranking rows as you type is
          // one list changing, and re-mounting it would replay the entrance on
          // every keystroke. Switching from `/` to `@` genuinely is a different
          // list, and that one should animate.
          key={mode}
          data-slot="composer-picker"
          initial={hidden}
          animate={{ opacity: 1, transform: "translateY(0)" }}
          exit={hidden}
          transition={transition}
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
              <PromptInputCommandGroup heading={MODE_HEADING[mode]}>
                {rows.map((row) => (
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
            </PromptInputCommandList>
          </PromptInputCommand>
        </motion.div>
      )}
    </AnimatePresence>
  );
});

/**
 * Outline throughout — a scannable list is outline except for its own
 * exceptions, and this list has none: every row is the same kind of thing.
 * The artifact glyph differs from the file glyph because they ARE different
 * things, not because one is emphasised.
 */
function RowIcon({ row }: { row: ComposerPickerRow }) {
  if (row.kind === "command") return <TerminalWindowIcon className="size-3.5 shrink-0" />;
  return row.artifact ? (
    <NoteIcon className="size-3.5 shrink-0" />
  ) : (
    <FileIcon className="size-3.5 shrink-0" />
  );
}
