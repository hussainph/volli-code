/**
 * The composer's `+` (VC-335): everything a prompt can take besides words.
 *
 * Three rows, and the point is the two that are not "attach". The `/` and `@`
 * pickers open from what is typed, which is the right way to open them and
 * also invisible: nothing on the surface said the grammars existed, and the
 * first outside users found neither. The field converged on one answer —
 * OpenCode's `+` lists Attachments · Commands `/` · Context `@`, claude.ai's
 * lists files and `/` commands, Claude Code Desktop's lists files, skills and
 * connectors — a menu under one mark whose rows *are* the shortcut hints. The
 * trailing slot on each row carries the character that would have done the
 * same thing, so the menu teaches the keystroke that makes it unnecessary.
 *
 * A row writes the trigger at the caret through the picker stack's own
 * binding ({@link useComposerCaretBinding}), which is what makes the picker
 * open exactly as if the character had been typed: same token grammar, same
 * word-boundary rule, same list. No second path into the picker exists.
 *
 * What is offered depends on what the surface can do, never on a flag: no
 * `onFiles` and there is no attach row (the Automation Instructions box takes
 * no files); no caret binding and there are no trigger rows. Both absent and
 * the menu is nothing — a control with no rows is not a control.
 */
import * as React from "react";
import { AtIcon } from "@phosphor-icons/react/dist/csr/At";
import { PaperclipIcon } from "@phosphor-icons/react/dist/csr/Paperclip";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";

import {
  attachTitle,
  useFilePicker,
} from "@renderer/components/attachments/composer-attach-button";
import {
  COMPOSER_CONTROL_ICON_SIZE,
  COMPOSER_GLYPH_WEIGHT,
} from "@renderer/components/chat/composer-chrome";
import { useComposerCaretBinding } from "@renderer/components/chat/composer-caret";
import { Button } from "@renderer/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { cn } from "@renderer/lib/utils";

export interface ComposerAddMenuProps {
  /** Something was picked. Absent hides the attach row. */
  onFiles?: (files: readonly File[]) => void;
  /** The selected model takes no images; the attach row says so on hover. */
  imagesUnsupported?: boolean;
  /** The picker rows are offered only where a `/` or `@` would open one. */
  pickers?: boolean;
  className?: string;
}

/** A no-op picker, for the attach-less surface: the hook still has to run. */
const NO_FILES = (): void => undefined;

export function ComposerAddMenu({
  onFiles,
  imagesUnsupported = false,
  pickers = true,
  className,
}: ComposerAddMenuProps): React.ReactElement | null {
  const caret = useComposerCaretBinding();
  const picker = useFilePicker(onFiles ?? NO_FILES);
  const insert = pickers ? caret.insert : undefined;
  if (onFiles === undefined && insert === undefined) return null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size={COMPOSER_CONTROL_ICON_SIZE}
            variant="ghost"
            aria-label="Add to message"
            // The one thing worth saying on hover is the warning, and only
            // when it applies: a model that cannot see the screenshot about
            // to be attached.
            title={imagesUnsupported ? attachTitle(true) : undefined}
            // Open, the mark turns an eighth turn into an ×: the same glyph
            // saying "this closes it", on the compositor only. `rotate`, not
            // `transform`, in the transition list — Tailwind v4 compiles
            // `rotate-45` to the standalone property, the same trap
            // `ui/button.tsx` records for its press scale.
            className={cn(
              "text-muted-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground",
              "[&>svg]:transition-[rotate] [&>svg]:duration-150 [&>svg]:ease-out data-[state=open]:[&>svg]:rotate-45 motion-reduce:[&>svg]:transition-none",
              className,
            )}
          >
            <PlusIcon weight={COMPOSER_GLYPH_WEIGHT} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          side="top"
          className="w-56"
          // The textarea is where the caret goes next whichever row was
          // picked; Radix would hand focus back to the `+`, one Tab away from
          // where the person is about to type.
          onCloseAutoFocus={(event) => {
            if (insert === undefined) return;
            event.preventDefault();
            caret.focus();
          }}
        >
          {onFiles === undefined ? null : (
            <DropdownMenuItem onSelect={picker.open}>
              <PaperclipIcon />
              Attach files…
            </DropdownMenuItem>
          )}
          {onFiles !== undefined && insert !== undefined ? <DropdownMenuSeparator /> : null}
          {insert === undefined ? null : (
            <>
              <DropdownMenuItem onSelect={() => insert("/")}>
                <TerminalWindowIcon />
                Commands
                <DropdownMenuShortcut>/</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => insert("@")}>
                <AtIcon />
                Mention a file
                <DropdownMenuShortcut>@</DropdownMenuShortcut>
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {onFiles === undefined ? null : picker.input}
    </>
  );
}
