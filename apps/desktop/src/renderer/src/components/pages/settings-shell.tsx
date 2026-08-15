import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import { useState, type ReactNode } from "react";

import { ContentColumn } from "@renderer/components/layout/content-column";
import { PageHeader } from "@renderer/components/layout/page-header";
import { cn } from "@renderer/lib/utils";

/** One selectable category in a settings surface: its rail row plus the pane it renders. */
export interface SettingsCategory {
  /** Stable id used for the local active-category selection. */
  key: string;
  /** Rail row label; also the pane header title. */
  label: string;
  icon: PhosphorIcon;
  /** Optional one-line explainer under the pane header. */
  description?: ReactNode;
  /**
   * The pane body — a stack of {@link SettingsSection}s. Built eagerly as an
   * element by the caller, but only the active category is ever mounted, so a
   * category's data fetch/effects run on entry and tear down on leave.
   */
  content: ReactNode;
}

/**
 * The shared grouped-settings layout, used by both the app-wide Settings
 * overlay and the per-project Configure page (docs/DESIGN.md two-pane pattern):
 * a fixed left category rail + a scrollable right pane showing the active
 * category. The active category is local state defaulting to the first — no
 * router, no global flag — and switching unmounts the previous pane.
 */
export function SettingsShell({
  title,
  categories,
  initialCategoryKey,
}: {
  title: string;
  categories: readonly SettingsCategory[];
  initialCategoryKey?: string;
}) {
  const [activeKey, setActiveKey] = useState(
    () =>
      categories.find((category) => category.key === initialCategoryKey)?.key ??
      categories[0]?.key ??
      "",
  );
  const active = categories.find((category) => category.key === activeKey) ?? categories[0] ?? null;

  return (
    <div className="flex min-h-0 flex-1">
      <nav
        aria-label={`${title} categories`}
        className="flex w-52 shrink-0 flex-col gap-1 overflow-y-auto border-r border-border p-4"
      >
        <p className="px-2 pb-2 pt-1 text-label uppercase text-muted-foreground">{title}</p>
        {categories.map(({ key, label, icon: Icon }) => {
          const isActive = active?.key === key;
          return (
            <button
              key={key}
              type="button"
              aria-current={isActive ? "page" : undefined}
              onClick={() => setActiveKey(key)}
              className={cn(
                "flex items-center gap-2 rounded-md px-2 py-1 text-left text-ui transition-colors",
                isActive
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
            >
              <Icon className="size-4 shrink-0" />
              <span className="truncate">{label}</span>
            </button>
          );
        })}
      </nav>

      <div className="min-w-0 flex-1 overflow-y-auto">
        {active ? (
          // Tier A: a settings pane is a reading surface, so it takes the app's
          // canonical measure and page gutter rather than a width and an inset
          // of its own (docs/DESIGN.md). The column pads only its tail — the
          // header owns the rhythm above and below itself.
          <ContentColumn className="pb-4">
            <PageHeader variant="reading" title={active.label} description={active.description} />
            <div className="flex flex-col gap-4">{active.content}</div>
          </ContentColumn>
        ) : null}
      </div>
    </div>
  );
}

/**
 * A labeled card grouping related settings rows: an optional heading (with an
 * optional leading icon and a right-aligned `action`), an optional description,
 * and the rows themselves.
 *
 * The **fill alone** carries the grouping — no frame. This card already sits
 * inside the app shell's framed content card, and a border here made every pane
 * a box inside a box. `bg-card` at full strength rather than `/50` for the same
 * reason the border went: at half strength the card/background delta is ~2 in
 * each channel, so a section without its frame would have stopped reading as a
 * surface at all.
 *
 * The inset is asymmetric on purpose: 16px horizontal is the component rung
 * every other row-bearing surface uses, and 8px vertical is the same step the
 * rows inside space themselves by — so every vertical gap in a section, edge to
 * header to row to row, is one 8px step.
 */
export function SettingsSection({
  title,
  description,
  icon: Icon,
  action,
  children,
}: {
  title?: string;
  description?: ReactNode;
  icon?: PhosphorIcon;
  action?: ReactNode;
  children: ReactNode;
}) {
  const hasHeader = title !== undefined || description !== undefined || action !== undefined;
  return (
    <section className="rounded-lg bg-card px-4 py-2">
      {hasHeader ? (
        <div className="mb-2 flex items-start justify-between gap-4">
          <div className="min-w-0">
            {title ? (
              <div className="flex items-center gap-2">
                {Icon ? <Icon className="size-4 text-muted-foreground" /> : null}
                <h2 className="text-sm font-semibold">{title}</h2>
              </div>
            ) : null}
            {description ? (
              <p
                className={cn(
                  "text-ui leading-5 text-muted-foreground",
                  title ? "mt-1" : undefined,
                )}
              >
                {description}
              </p>
            ) : null}
          </div>
          {action ? <div className="shrink-0">{action}</div> : null}
        </div>
      ) : null}
      {/* Rows live in their own wrapper so SettingsRow's `first:`/`last:` divider
          rules actually match. Without it the header div is the section's
          :first-child, so the first row still drew a stray top hairline. */}
      <div>{children}</div>
    </section>
  );
}

/**
 * The quiet one-liner an inheriting surface shows instead of a control it isn't
 * using — what a section whose scope is set to Inherit says in place of the
 * picker it has handed back to the app-wide choice.
 *
 * Here rather than beside its one caller: Configure's Appearance category draws
 * it from four sections that inherit independently — canvas, mode, editor theme,
 * terminal theme — and the whole point of the idiom is that every inheriting
 * section looks the same.
 */
export function InheritNote({ children }: { children: ReactNode }) {
  return <p className="text-ui leading-5 text-muted-foreground">{children}</p>;
}

/**
 * A single setting: label + optional description on the left, its control on
 * the right. Rows stacked inside a {@link SettingsSection} are separated by a
 * hairline divider (suppressed on the first row). `align="start"` top-aligns
 * the control for multi-line controls; the default centers it.
 */
export function SettingsRow({
  label,
  description,
  htmlFor,
  align = "center",
  testId,
  children,
}: {
  label: string;
  description?: ReactNode;
  htmlFor?: string;
  align?: "center" | "start";
  /**
   * Addresses one row when its label cannot. Model Access lists forty provider
   * rows of identical shape, and a probe that reached one of them by filtering
   * the DOM for its label text would be matching the section, the row and the
   * label all at once.
   */
  testId?: string;
  children: ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      className={cn(
        "flex justify-between gap-4 border-t border-border/50 py-2 first:border-t-0 first:pt-0 last:pb-0",
        align === "center" ? "items-center" : "items-start",
      )}
    >
      <div className="min-w-0 flex-1">
        <label className="block text-sm font-medium" htmlFor={htmlFor}>
          {label}
        </label>
        {description ? (
          <p className="mt-1 text-ui leading-5 text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}
