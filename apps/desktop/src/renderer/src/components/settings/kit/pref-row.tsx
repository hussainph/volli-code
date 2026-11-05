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
import { type IconComponent as Icon } from "@renderer/components/ui/icon";

import { IdentityTile } from "@renderer/components/ui/identity-tile";
import { ListRow } from "@renderer/components/ui/list-row";
import { cn } from "@renderer/lib/utils";
import { AppGlyph, isAppName } from "./app-glyph";

export function PrefRow({
  label,
  icon: Icon,
  htmlFor,
  description,
  testId,
  children,
}: {
  label: string;
  icon?: Icon;
  htmlFor?: string;
  /**
   * The row's status or provenance ("Project override", "Inherited from
   * Ghostty"), its blocked reason, or its one-line trust boundary — never an
   * explanation of what the setting does; the label and control say that.
   * Nothing here may be a block element: it renders inside a `<p>`.
   */
  description?: React.ReactNode;
  /** @deprecated Controls are always centred on the complete label block. */
  align?: "center" | "start";
  testId?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      data-slot="pref-row"
      className={cn(
        "@container/pref-row flex min-h-16 flex-wrap justify-between gap-x-6 gap-y-2 border-t border-border/50 px-4 py-4 first:border-t-0",
        "items-center",
      )}
    >
      <div className="min-w-40 flex-1">
        <div className="flex items-center gap-2">
          {Icon ? <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" /> : null}
          <label htmlFor={htmlFor} data-slot="pref-row-label" className="block text-ui font-medium">
            {label}
          </label>
        </div>
        {description ? (
          <p className="mt-1 text-ui leading-5 text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <div className="flex max-w-full flex-wrap items-center gap-2">{children}</div>
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
      leading={
        leading ??
        (isAppName(name) ? (
          <IdentityTile>
            <AppGlyph name={name} />
          </IdentityTile>
        ) : undefined)
      }
      primary={name}
      primaryTrailing={badges}
      secondary={meta}
      actions={
        children ? (
          <div className="flex max-w-full flex-wrap items-center gap-2">{children}</div>
        ) : undefined
      }
      onActivate={onOpen ?? null}
      data-testid={testId}
      data-slot="pref-row"
    />
  );
}
