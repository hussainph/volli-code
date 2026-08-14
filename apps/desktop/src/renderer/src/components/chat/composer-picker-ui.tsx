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
} from "@ai-elements/prompt-input";
import { COMPOSER_STACK_SHELL } from "@renderer/chat/composer-stack";
import type { ComposerPickerRow, ComposerPickerState } from "@renderer/chat/composer-picker";
import { cn } from "@renderer/lib/utils";

/** The group heading each mode files its rows under. Nouns, not sentences. */
const MODE_HEADING: Record<ComposerPickerState["mode"], string> = {
  command: "Commands",
  file: "Files",
};

export function ComposerPicker({
  state,
  active,
  onActiveChange,
  onSelect,
  className,
}: {
  /** The open picker, or null. Presence drives the whole animation. */
  state: ComposerPickerState | null;
  /** The row the composer's arrow keys have moved to — cmdk's controlled value. */
  active: string;
  onActiveChange(value: string): void;
  onSelect(row: ComposerPickerRow): void;
  className?: string;
}) {
  const reducedMotion = useReducedMotion() ?? false;
  // The exact recipe ComposerInteractionStack enters on — one contract for
  // everything that parks on the composer.
  const transition = {
    duration: reducedMotion ? 0.125 : 0.25,
    ease: [0.32, 0.72, 0, 1] as const,
  };
  const hidden = {
    opacity: 0,
    transform: reducedMotion ? "translateY(0)" : "translateY(8px)",
  };

  return (
    <AnimatePresence initial={false} mode="popLayout">
      {state ? (
        <motion.div
          // Keyed on the mode, not on the query: re-ranking rows as you type is
          // one list changing, and re-mounting it would replay the entrance on
          // every keystroke. Switching from `/` to `@` genuinely is a different
          // list, and that one should animate.
          key={state.mode}
          data-slot="composer-picker"
          layout={reducedMotion ? false : "position"}
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
            aria-label={MODE_HEADING[state.mode]}
          >
            <PromptInputCommandList className="max-h-64">
              <PromptInputCommandEmpty className="px-3 py-4 text-left text-sm text-muted-foreground">
                No match
              </PromptInputCommandEmpty>
              <PromptInputCommandGroup heading={MODE_HEADING[state.mode]}>
                {state.rows.map((row) => (
                  <PromptInputCommandItem
                    key={row.value}
                    value={row.value}
                    onSelect={() => onSelect(row)}
                    className="gap-2"
                  >
                    <RowIcon row={row} />
                    <span className="min-w-0 shrink-0 truncate text-foreground">{row.label}</span>
                    {row.detail ? (
                      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                        {row.detail}
                      </span>
                    ) : null}
                  </PromptInputCommandItem>
                ))}
              </PromptInputCommandGroup>
            </PromptInputCommandList>
          </PromptInputCommand>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

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
