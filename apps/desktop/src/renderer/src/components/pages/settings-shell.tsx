import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import { useState, type ReactNode } from "react";

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
}: {
  title: string;
  categories: readonly SettingsCategory[];
}) {
  const [activeKey, setActiveKey] = useState(() => categories[0]?.key ?? "");
  const active = categories.find((category) => category.key === activeKey) ?? categories[0] ?? null;

  return (
    <div className="flex min-h-0 flex-1">
      <nav
        aria-label={`${title} categories`}
        className="flex w-52 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border p-3"
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
                "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-ui transition-colors",
                isActive
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground",
              )}
            >
              <Icon weight="fill" className="size-4 shrink-0" />
              <span className="truncate">{label}</span>
            </button>
          );
        })}
      </nav>

      <div className="min-w-0 flex-1 overflow-y-auto">
        {active ? (
          <div className="mx-auto w-full max-w-2xl px-8 py-7">
            <SettingsPaneHeader title={active.label} description={active.description} />
            <div className="flex flex-col gap-6">{active.content}</div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The pane's top title row: the active category name plus an optional one-line description. */
export function SettingsPaneHeader({
  title,
  description,
}: {
  title: string;
  description?: ReactNode;
}) {
  return (
    <header className="mb-6">
      <h1 className="text-heading font-semibold">{title}</h1>
      {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
    </header>
  );
}

/**
 * A labeled card grouping related settings rows: an optional heading (with an
 * optional leading icon and a right-aligned `action`), an optional description,
 * and the rows themselves.
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
    <section className="rounded-lg border border-border bg-card/50 p-5">
      {hasHeader ? (
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            {title ? (
              <div className="flex items-center gap-2">
                {Icon ? <Icon weight="fill" className="size-4 text-muted-foreground" /> : null}
                <h2 className="text-sm font-semibold">{title}</h2>
              </div>
            ) : null}
            {description ? (
              <p
                className={cn(
                  "text-xs leading-5 text-muted-foreground",
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
      {children}
    </section>
  );
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
  children,
}: {
  label: string;
  description?: ReactNode;
  htmlFor?: string;
  align?: "center" | "start";
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex justify-between gap-6 border-t border-border/60 py-4 first:border-t-0 first:pt-0 last:pb-0",
        align === "center" ? "items-center" : "items-start",
      )}
    >
      <div className="min-w-0 flex-1">
        <label className="block text-sm font-medium" htmlFor={htmlFor}>
          {label}
        </label>
        {description ? (
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}
