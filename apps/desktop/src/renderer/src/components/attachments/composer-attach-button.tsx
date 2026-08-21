/**
 * The composer's attach affordance (VC-50).
 *
 * A paperclip over a hidden `<input type="file">` rather than a native dialog
 * over IPC: the file input already gives us multi-select, the system picker,
 * and a keyboard-reachable button, and it hands back `File` objects that the
 * same code path handles whether they were picked, dropped or pasted.
 *
 * The only attach affordance on every composer that has one — chat, the ticket
 * Files panel, and the new-ticket composer (VC-115). The new-ticket footer used
 * to carry a second paperclip that searched the project file index and inserted
 * `@path`; it was removed because the description editor already completes `@`
 * against that same index, so the second icon bought a duplicate path to a
 * thing typing `@` does. A repository file attached here still resolves to an
 * `@` reference in main, so the two routes cannot disagree about what a
 * repository file is.
 */
import * as React from "react";
import { PaperclipIcon } from "@phosphor-icons/react/dist/csr/Paperclip";

import { Button } from "@renderer/components/ui/button";

export interface ComposerAttachButtonProps {
  onFiles: (files: readonly File[]) => void;
  /** The selected model takes no images, so say so instead of failing at send. */
  imagesUnsupported?: boolean;
  className?: string;
}

export function ComposerAttachButton({
  onFiles,
  imagesUnsupported = false,
  className,
}: ComposerAttachButtonProps): React.ReactElement {
  const inputRef = React.useRef<HTMLInputElement>(null);
  return (
    <>
      <Button
        type="button"
        size="xs"
        variant="ghost"
        aria-label="Attach files"
        title={imagesUnsupported ? "Attach files — this model cannot read images" : "Attach files"}
        className={className}
        onClick={() => inputRef.current?.click()}
      >
        <PaperclipIcon />
      </Button>
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(event) => {
          const picked = [...(event.target.files ?? [])];
          // Cleared before the handler runs, so picking the same file twice in
          // a row still fires `change` the second time.
          event.target.value = "";
          if (picked.length > 0) onFiles(picked);
        }}
      />
    </>
  );
}
