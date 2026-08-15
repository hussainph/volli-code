/**
 * The app's one click-to-edit field.
 *
 * Four surfaces wrote this: the tab strip and the ticket session rail (both
 * through `sessions/inline-rename.tsx`, the survivor this file is), the
 * repository card's branch field (`ticket-repository-summary.tsx`'s
 * `InlineTextField`) and the ticket title (`ticket/ticket-title.tsx`). Three of
 * the four carried the same one-shot `done` ref and the fourth did not — which
 * is the reason this merge is a bug fix rather than a tidy-up. See THE GUARD.
 *
 * WHAT STAYS WITH THE CALLER: whether an edit is open, what starts one, and
 * what a commit writes. Every site owns a different `editing` flag — a tab
 * strip keys it by tab id, the rail by session id, the title by a local
 * boolean — and a primitive that owned the flag would have to own the trigger
 * too, which is an `h1`, a `<span>` and a padded button in the three cases.
 * This file owns the field: its size, its guard, and the events it swallows.
 *
 * THE GUARD. Enter commits and then blurs, and blur commits — so without a
 * one-shot latch a single Enter writes twice. The second write is not a no-op:
 * it re-reads the ORIGINAL `value` prop, which has not round-tripped through
 * the store yet, so the "unchanged" early return still sees a change and fires
 * again. `ticket-title.tsx` had exactly that hole. The latch lives here so no
 * site can be the one that forgets it, and it is per-mount: a site re-opens an
 * edit by mounting a fresh field, which is what all four already did.
 *
 * WHAT IT SWALLOWS, and why that is not defensive coding: a rename field sits
 * inside a terminal shortcut handler, a tab's selection click, a row's
 * double-click-to-rename, and the ticket detail's Escape-to-close. Every one of
 * those fires on a keystroke or a pointer press that is meant for the field.
 * `stopPropagation` on key, pointer, click and double-click is the contract,
 * not a workaround at one site.
 */
import * as React from "react";

import { Input } from "@renderer/components/ui/input";
import { cn } from "@renderer/lib/utils";

/**
 * The three things this field is, named by what it replaces rather than by
 * where it is used — `tab` and `row` were the same 20px chip with different
 * widths, and width is the caller's business.
 */
export type InlineRenameSize = "row" | "field" | "title";

/**
 * `row` and `title` are their own drawings, not text fields: one is a 20px chip
 * that replaces a label in place, the other is a seamless `h1` whose only cue
 * is the caret. `field` IS the app's text field, so it renders {@link Input}
 * rather than restating its border, radius, inset and lift — the one variant
 * that could drift from the primitive is the one that cannot, because it is it.
 */
const SIZE_CLASS: Record<Exclude<InlineRenameSize, "field">, string> = {
  // Height and type step belong to the primitive: the two strips that rename
  // had drifted to `h-5 w-40 text-ui` against `h-5 w-32 text-sm` before the
  // field was shared, and only the width was ever a decision.
  row: "h-5 rounded-sm border border-primary/50 bg-background px-1 text-ui",
  // No border, no fill, no ring — the input carries the heading's exact
  // typography so nothing shifts when you click into it.
  title: "w-full bg-transparent text-title font-semibold",
};

export function InlineRename({
  value,
  size = "row",
  mono = false,
  onCommit,
  onClear,
  onCancel,
  className,
  ariaLabel,
}: {
  value: string;
  size?: InlineRenameSize;
  /** The edited string is a name the machine chose — a branch, a path, a ref. */
  mono?: boolean;
  onCommit(next: string): void;
  /**
   * What an emptied field means, where empty is a legal value. Absent, empty
   * cancels — a tab, a session and a ticket must always have a title, so
   * clearing one is a mistake rather than an instruction. The repository card's
   * branch fields are the opposite: unset is the domain's own `null`, and
   * erasing the box is how you say so.
   */
  onClear?(): void;
  onCancel(): void;
  className?: string;
  ariaLabel?: string;
}) {
  const [draft, setDraft] = React.useState(value);
  const ref = React.useRef<HTMLInputElement>(null);
  const done = React.useRef(false);

  React.useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const commit = () => {
    if (done.current) return;
    done.current = true;
    const trimmed = draft.trim();
    if (trimmed.length === 0) {
      if (onClear) onClear();
      else onCancel();
    } else if (trimmed === value) onCancel();
    else onCommit(trimmed);
  };

  const cancel = () => {
    if (done.current) return;
    done.current = true;
    onCancel();
  };

  const shared = {
    ref,
    value: draft,
    "aria-label": ariaLabel,
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => setDraft(event.target.value),
    onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        commit();
      } else if (event.key === "Escape") {
        event.preventDefault();
        cancel();
      }
    },
    onBlur: commit,
    onPointerDown: (event: React.PointerEvent<HTMLInputElement>) => event.stopPropagation(),
    onClick: (event: React.MouseEvent<HTMLInputElement>) => event.stopPropagation(),
    onDoubleClick: (event: React.MouseEvent<HTMLInputElement>) => event.stopPropagation(),
  };

  if (size === "field") {
    return <Input {...shared} className={cn(mono && "font-mono", className)} />;
  }

  return (
    <input
      {...shared}
      className={cn(
        "min-w-0 text-foreground outline-none",
        SIZE_CLASS[size],
        mono && "font-mono",
        className,
      )}
    />
  );
}
