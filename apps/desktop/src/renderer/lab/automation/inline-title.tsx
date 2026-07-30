/**
 * Linear-style rename: reads as a title until you aim at it.
 *
 * The previous studio header was a permanently-chrome-free input that looked
 * like static text and offered no signal it was editable — so renaming felt
 * non-obvious. This keeps the calm silhouette and adds a hover pencil plus a
 * focus ring once you commit to editing.
 */
import * as React from "react";
import { PencilSimpleIcon } from "@phosphor-icons/react/dist/csr/PencilSimple";

import { cn } from "@renderer/lib/utils";

export function InlineTitle({
  value,
  onChange,
  onCommit,
  onCancel,
  placeholder,
  ariaLabel,
  mono = false,
  size = "title",
  invalid = false,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Blur / Enter — optional; live `onChange` is enough for the automation name. */
  onCommit?: () => void;
  /** Escape — revert a draft without committing. */
  onCancel?: () => void;
  placeholder: string;
  ariaLabel: string;
  mono?: boolean;
  size?: "title" | "step";
  invalid?: boolean;
  className?: string;
}) {
  const [focused, setFocused] = React.useState(false);
  const cancelling = React.useRef(false);

  return (
    <label
      className={cn(
        "group/title relative flex min-w-0 flex-1 items-center gap-1.5 rounded-md",
        "outline-none",
        focused && !invalid && "ring-[3px] ring-ring/50",
        invalid && "ring-[3px] ring-destructive/40",
        className,
      )}
    >
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          if (cancelling.current) {
            cancelling.current = false;
            return;
          }
          onCommit?.();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          }
          if (event.key === "Escape") {
            event.preventDefault();
            cancelling.current = true;
            onCancel?.();
            event.currentTarget.blur();
          }
        }}
        placeholder={placeholder}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        spellCheck={false}
        className={cn(
          "min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground/50",
          mono ? "font-mono" : "font-sans",
          size === "title"
            ? "px-1.5 py-0.5 text-base tracking-tight text-foreground"
            : "px-1 py-0.5 text-label text-muted-foreground",
          invalid && "text-destructive",
        )}
      />
      <PencilSimpleIcon
        weight="fill"
        aria-hidden
        className={cn(
          "mr-1 size-3.5 shrink-0 text-muted-foreground",
          "opacity-0 transition-opacity duration-150 ease-out motion-reduce:transition-none",
          "group-hover/title:opacity-70 group-focus-within/title:opacity-0",
          focused && "opacity-0",
        )}
      />
    </label>
  );
}

/**
 * Step id — draft locally so intermediate keystrokes do not re-key the React
 * list (the rename bug that put the caret at the end of every character).
 */
export function StepIdField({
  id,
  taken,
  onCommit,
}: {
  id: string;
  taken: Set<string>;
  onCommit: (next: string) => void;
}) {
  const [draft, setDraft] = React.useState(id);
  React.useEffect(() => setDraft(id), [id]);

  const trimmed = draft.trim();
  const invalid = trimmed === "" || (trimmed !== id && taken.has(trimmed));

  return (
    <InlineTitle
      value={draft}
      onChange={setDraft}
      placeholder="step-id"
      ariaLabel="Step name"
      mono
      size="step"
      invalid={invalid}
      onCommit={() => {
        if (invalid) {
          setDraft(id);
          return;
        }
        if (trimmed !== id) onCommit(trimmed);
      }}
      onCancel={() => setDraft(id)}
    />
  );
}
