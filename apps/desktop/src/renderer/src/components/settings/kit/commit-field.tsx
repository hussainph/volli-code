/**
 * A text field that saves on blur, and can be told no.
 *
 * ONE SAVE MODEL on these surfaces: everything saves on change. Text is the
 * exception, because it has no natural commit point until focus leaves — and
 * that is what made the naive version dangerous. It sent whatever string was
 * in the box, so select-all-type-`1`-click-away silently armed a one-day
 * automatic folder deletion.
 *
 * So a commit is a *transaction*: validate locally, ask for confirmation where
 * the consequence is destructive, let the write refuse, show the refusal
 * beside the field it belongs to, and adopt whatever the write normalised the
 * value to. `Escape` abandons; `Enter` commits.
 */
import * as React from "react";

import { Input } from "@renderer/components/ui/input";

import { CONTROL_W, type ControlWidth } from "./control-width";

export type CommitResult = { ok: true; value?: string } | { ok: false; error: string };

/** How long "Saved" stays up. Long enough to read, short enough not to linger. */
const SAVED_FLASH_MS = 1600;

export function CommitField({
  id,
  value,
  type = "text",
  width = "md",
  placeholder,
  disabled,
  ariaLabel,
  validate,
  confirm,
  onCommit,
}: {
  id?: string;
  value: string;
  type?: "text" | "password" | "number";
  width?: ControlWidth;
  placeholder?: string;
  disabled?: boolean;
  /** For a field whose `<label>` is not adjacent — a table cell, say. */
  ariaLabel?: string;
  /** Cheap local check. Return a message to refuse. */
  validate?: (next: string) => string | null;
  /** Last gate before a destructive write. Return false to abandon. */
  confirm?: (next: string) => boolean;
  onCommit: (next: string) => CommitResult | Promise<CommitResult>;
}) {
  // A refusal has to be announceable, so the association can never depend on
  // the caller having passed an id — an earlier version gated
  // `aria-describedby` on `id`, so an id-less field showed its error and told
  // a screen reader nothing.
  const autoId = React.useId();
  const fieldId = id ?? autoId;
  const errorId = `${fieldId}-error`;

  const [draft, setDraft] = React.useState(value);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const dirty = React.useRef(false);

  // Adopt an external change ONLY when the user is not mid-edit. A bare
  // dependency on `value` means a background refresh wipes whatever is
  // half-typed.
  React.useEffect(() => {
    if (!dirty.current) setDraft(value);
  }, [value]);

  React.useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), SAVED_FLASH_MS);
    return () => clearTimeout(timer);
  }, [saved]);

  const commit = async (): Promise<void> => {
    if (!dirty.current || busy) return;
    const next = draft;

    const local = validate?.(next) ?? null;
    if (local) {
      setError(local);
      return;
    }
    if (confirm && !confirm(next)) {
      setDraft(value);
      dirty.current = false;
      setError(null);
      return;
    }

    setBusy(true);
    const result = await onCommit(next);
    setBusy(false);

    if (!result.ok) {
      setError(result.error);
      return;
    }
    dirty.current = false;
    setError(null);
    if (result.value !== undefined) setDraft(result.value);
    setSaved(true);
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        {/* Rendered only when true. A permanently-present node with constant
            text is not something a live region can announce. */}
        {saved ? (
          <span aria-live="polite" className="text-ui text-muted-foreground">
            Saved
          </span>
        ) : null}
        <Input
          id={fieldId}
          type={type}
          value={draft}
          disabled={disabled || busy}
          placeholder={placeholder}
          aria-label={ariaLabel}
          aria-invalid={error !== null}
          aria-describedby={error ? errorId : undefined}
          className={CONTROL_W[width]}
          onChange={(event) => {
            dirty.current = true;
            setDraft(event.target.value);
            if (error) setError(null);
          }}
          onBlur={() => void commit()}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            }
            if (event.key === "Escape") {
              setDraft(value);
              dirty.current = false;
              setError(null);
            }
          }}
        />
      </div>
      {error ? (
        <p id={errorId} role="alert" className="text-ui text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
