/**
 * The two row shapes, and the line between them.
 *
 * A SETTING is a {@link PrefRow}: a label on the left, its control on the
 * right, hairline-separated from its neighbours. A THING IN A LIST is an
 * {@link ItemRow}: a name, a meta line, and actions. Getting these confused is
 * what produced the surface this redesign replaces — settings drawn as list
 * entries, list entries drawn as settings, and no way to scan either.
 */
import type * as React from "react";

import { ListRow } from "@renderer/components/ui/list-row";
import { cn } from "@renderer/lib/utils";

import { InfoHint } from "./info-hint";

export function PrefRow({
  label,
  htmlFor,
  hint,
  description,
  align = "center",
  testId,
  children,
}: {
  label: string;
  htmlFor?: string;
  /** The `(i)`. Preferred over `description` everywhere. */
  hint?: React.ReactNode;
  /**
   * Prose under the label. **Reserved for trust boundaries** — where the app
   * takes an irreversible action, which is CLAUDE.md's own carve-out. Two uses
   * on both surfaces combined, both about automatic deletion. If you are
   * reaching for this to explain a control, you want `hint`.
   */
  description?: string;
  align?: "center" | "start";
  testId?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      className={cn(
        "flex justify-between gap-6 border-t border-border/50 py-4 first:border-t-0 first:pt-0 last:pb-0",
        align === "center" ? "items-center" : "items-start",
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1">
          {/* The hint is a SIBLING of the label, never a child: a `<button>`
              inside a `<label htmlFor>` toggles the control it names. */}
          <label htmlFor={htmlFor} className="block text-sm font-medium">
            {label}
          </label>
          {hint ? <InfoHint label={label}>{hint}</InfoHint> : null}
        </div>
        {description ? (
          <p className="mt-1 text-ui leading-5 text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

/**
 * A thing in a list, as opposed to a setting.
 *
 * A thin arrangement over `ui/list-row.tsx` rather than a sixth hand-rolled
 * row. That file owns the branch this one kept getting wrong: actions must be
 * a *sibling* of the activation target (a button inside a button is not
 * markup), and a row that activates nothing must not draw a hover fill.
 */
export function ItemRow({
  name,
  meta,
  leading,
  badges,
  onOpen,
  testId,
  children,
}: {
  name: React.ReactNode;
  meta?: string;
  leading?: React.ReactNode;
  badges?: React.ReactNode;
  onOpen?: () => void;
  testId?: string;
  children?: React.ReactNode;
}) {
  return (
    <ListRow
      density={meta ? "two-line" : "row"}
      leading={leading}
      primary={name}
      primaryTrailing={badges}
      secondary={meta}
      actions={
        children ? <div className="flex shrink-0 items-center gap-2">{children}</div> : undefined
      }
      onActivate={onOpen ?? null}
      data-testid={testId}
    />
  );
}
