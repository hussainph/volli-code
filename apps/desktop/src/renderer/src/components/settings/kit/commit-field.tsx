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

import { ChevronUpIcon, ChevronDownIcon } from "@renderer/components/ui/icon";

import { Input } from "@renderer/components/ui/input";
import { cn } from "@renderer/lib/utils";

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
  suffix,
  step = 1,
  min,
  max,
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
  /**
   * The unit the number in the box counts in, drawn beside it.
   *
   * Inside the control rather than in the row's label or its `(i)`, because a
   * bare `3` is not a setting anyone can read: VC-285 found two authority
   * thresholds whose units lived only in a popover and in the revert button's
   * accessible name. It joins the field's `aria-describedby` so the unit is
   * announced with the value rather than being visual-only.
   */
  suffix?: string;
  /** Numeric quantities accept typed values, arrow keys and explicit up/down presses. */
  step?: number;
  min?: number;
  max?: number;
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
  const unitId = `${fieldId}-unit`;

  const [draft, setDraft] = React.useState(value);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const dirty = React.useRef(false);
  const committing = React.useRef(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  // Existing unit-bearing fields predate the number prop. Keep their API while
  // giving actual quantities a stepper; branch/path/password fields remain text.
  const quantity =
    type === "number" || (type === "text" && !!suffix && /^-?\d+(\.\d+)?$/.test(value));

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

  const commit = async (next = draft): Promise<void> => {
    if (!dirty.current || committing.current) return;

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

    committing.current = true;
    setBusy(true);
    let result: CommitResult;
    try {
      result = await onCommit(next);
    } catch (cause) {
      result = {
        ok: false,
        error: cause instanceof Error ? cause.message : "Couldn't save this preference.",
      };
    } finally {
      committing.current = false;
      setBusy(false);
    }

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
        <div
          className="relative"
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) void commit();
          }}
        >
          <Input
            ref={inputRef}
            id={fieldId}
            type={quantity ? "number" : type}
            step={quantity ? step : undefined}
            min={min}
            max={max}
            value={draft}
            disabled={disabled || busy}
            placeholder={placeholder}
            aria-label={ariaLabel}
            aria-invalid={error !== null}
            aria-describedby={
              [error ? errorId : null, suffix ? unitId : null].filter(Boolean).join(" ") ||
              undefined
            }
            className={cn(
              CONTROL_W[width],
              quantity &&
                "pr-6 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none",
            )}
            onChange={(event) => {
              dirty.current = true;
              setDraft(event.target.value);
              if (error) setError(null);
            }}
            onKeyDown={(event) => {
              // Never mid-word: an IME's Enter and Escape are its own.
              if (event.nativeEvent.isComposing) return;
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
          {quantity ? (
            <div className="absolute inset-y-0 right-0 flex w-6 flex-col border-l border-border-strong">
              {([1, -1] as const).map((direction) => {
                const Icon = direction === 1 ? ChevronUpIcon : ChevronDownIcon;
                const atLimit =
                  draft.trim() !== "" &&
                  (direction === 1
                    ? max !== undefined && Number(draft) >= max
                    : min !== undefined && Number(draft) <= min);
                return (
                  <button
                    key={direction}
                    type="button"
                    aria-label={`${direction === 1 ? "Increase" : "Decrease"} ${ariaLabel ?? suffix ?? "value"}`}
                    disabled={disabled || busy || atLimit}
                    className="flex min-h-0 flex-1 items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
                    onClick={() => {
                      const field = inputRef.current;
                      if (!field || committing.current) return;
                      // Use the browser's step/bounds arithmetic without mutating
                      // React's controlled node (a declined confirmation must restore it).
                      const stepped = field.cloneNode() as HTMLInputElement;
                      stepped.value = draft;
                      if (direction === 1) stepped.stepUp();
                      else stepped.stepDown();
                      const next = stepped.value;
                      dirty.current = true;
                      setDraft(next);
                      void commit(next);
                    }}
                  >
                    <Icon aria-hidden strokeWidth={2.25} className="size-3" />
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
        {/* Dims with the field it belongs to: a live unit beside a dead number
            would read as the control being half on. */}
        {suffix ? (
          <span
            id={unitId}
            className={cn(
              "text-ui whitespace-nowrap text-muted-foreground",
              (disabled || busy) && "opacity-50",
            )}
          >
            {suffix}
          </span>
        ) : null}
      </div>
      {error ? (
        <p id={errorId} role="alert" className="text-ui text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
