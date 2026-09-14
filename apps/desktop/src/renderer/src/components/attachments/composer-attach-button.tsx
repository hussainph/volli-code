/**
 * The attach affordance (VC-50), and the file picker behind it.
 *
 * A hidden `<input type="file">` rather than a native dialog over IPC: the
 * file input already gives us multi-select, the system picker, and a
 * keyboard-reachable button, and it hands back `File` objects that the same
 * code path handles whether they were picked, dropped or pasted.
 *
 * Two drawings of one act. {@link ComposerAttachButton} is the direct button —
 * one press, one dialog — for a surface whose only "add" is a file: the
 * New-ticket footer, whose description editor completes `@` on its own, and
 * the ticket Files rail, where it sits beside New file and reads as a
 * paperclip because that rail is about files rather than about a prompt.
 * The Session composer's `+` is `chat/composer-add-menu.tsx`, which opens a
 * menu over this same picker because it has two more things to offer.
 *
 * The new-ticket footer used to carry a second paperclip that searched the
 * project file index and inserted `@path`; it was removed because the
 * description editor already completes `@` against that same index (VC-115).
 * A repository file attached here still resolves to an `@` reference in main,
 * so the two routes cannot disagree about what a repository file is.
 */
import * as React from "react";
import { PaperclipIcon } from "@phosphor-icons/react/dist/csr/Paperclip";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";

import {
  COMPOSER_CONTROL_ICON_SIZE,
  COMPOSER_GLYPH_WEIGHT,
} from "@renderer/components/chat/composer-chrome";
import { Button } from "@renderer/components/ui/button";

/**
 * The picker, as a hook: the hidden input to mount and the call that opens
 * it. Shared by the direct button and the composer's `+` menu so both hand
 * back files through one `change` path.
 */
export function useFilePicker(onFiles: (files: readonly File[]) => void): {
  input: React.ReactElement;
  open(): void;
} {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const open = React.useCallback(() => inputRef.current?.click(), []);
  const input = (
    <input
      ref={inputRef}
      type="file"
      multiple
      className="hidden"
      // The hook tests drive this picker's `change` path directly (jsdom has
      // no file dialog), and the ai-elements `PromptInput` renders its own
      // hidden file input for its local attachment context — so this one
      // carries its own hook rather than being found by type alone.
      data-composer-file-picker
      onChange={(event) => {
        const picked = [...(event.target.files ?? [])];
        // Cleared before the handler runs, so picking the same file twice in
        // a row still fires `change` the second time.
        event.target.value = "";
        if (picked.length > 0) onFiles(picked);
      }}
    />
  );
  return { input, open };
}

/** What the attach control says on hover, and what it warns where it must. */
export function attachTitle(imagesUnsupported: boolean): string {
  return imagesUnsupported ? "Attach files (this model cannot read images)" : "Attach files";
}

export interface ComposerAttachButtonProps {
  onFiles: (files: readonly File[]) => void;
  /** The selected model takes no images, so say so instead of failing at send. */
  imagesUnsupported?: boolean;
  /**
   * `plus` is a prompt surface's "add" — the field's convention, and the same
   * mark the Session composer's menu opens on. `paperclip` is for a place
   * that is about files rather than prompts (the ticket Files rail).
   */
  glyph?: "plus" | "paperclip";
  className?: string;
}

export function ComposerAttachButton({
  onFiles,
  imagesUnsupported = false,
  glyph = "plus",
  className,
}: ComposerAttachButtonProps): React.ReactElement {
  const picker = useFilePicker(onFiles);
  const Glyph = glyph === "plus" ? PlusIcon : PaperclipIcon;
  return (
    <>
      <Button
        type="button"
        size={COMPOSER_CONTROL_ICON_SIZE}
        variant="ghost"
        aria-label="Attach files"
        title={attachTitle(imagesUnsupported)}
        className={className}
        onClick={picker.open}
      >
        <Glyph weight={COMPOSER_GLYPH_WEIGHT} />
      </Button>
      {picker.input}
    </>
  );
}
