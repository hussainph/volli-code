import * as React from "react";

import { cn } from "@renderer/lib/utils";

/**
 * A tiny controlled text field for double-click inline renaming, shared by the
 * global session tabs and the ticket session rail (and adoptable by the ticket
 * tab strip). Autofocuses and selects on mount; Enter/blur commit a trimmed,
 * changed, non-empty value; Escape cancels. It stops key/pointer events from
 * bubbling so the surrounding terminal shortcut handler, tab selection, and the
 * ticket detail's Escape-to-close never fire while editing.
 */
export function InlineRename({
  value,
  onCommit,
  onCancel,
  className,
  ariaLabel,
}: {
  value: string;
  onCommit(next: string): void;
  onCancel(): void;
  className?: string;
  ariaLabel?: string;
}) {
  const [draft, setDraft] = React.useState(value);
  const ref = React.useRef<HTMLInputElement>(null);
  // Guard against blur firing after an Enter/Escape already resolved the edit.
  const done = React.useRef(false);

  React.useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const commit = () => {
    if (done.current) return;
    done.current = true;
    const trimmed = draft.trim();
    if (trimmed.length === 0 || trimmed === value) onCancel();
    else onCommit(trimmed);
  };

  const cancel = () => {
    if (done.current) return;
    done.current = true;
    onCancel();
  };

  return (
    <input
      ref={ref}
      value={draft}
      aria-label={ariaLabel}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          cancel();
        }
      }}
      onBlur={commit}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      className={cn(
        "min-w-0 rounded-sm border border-primary/60 bg-background px-1 text-foreground outline-none",
        className,
      )}
    />
  );
}
