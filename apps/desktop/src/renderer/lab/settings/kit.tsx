/**
 * VC-111 — the proposed settings grammar, as primitives.
 *
 * This is the actual proposal. The panes beside it are just content poured into
 * these shapes; if you disagree with the redesign, you disagree with something
 * in this file.
 *
 * Today both surfaces share `pages/settings-shell.tsx`, which gives them a
 * category rail, a section card and a row — and then every pane invents the
 * rest: four shapes of header action, four status vocabularies, two save
 * models, and a scope control that sits at three different heights within one
 * page of itself. So the shell is not the problem; the problem is that it stops
 * short of the decisions that actually drift.
 *
 * Six rules, each one closing a drift the audit found (docs/plans/settings-audit.md):
 *
 *  1. THE RAIL IS GROUPED. Eight flat categories is a list you read; three
 *     groups of three is a structure you learn. The groups are also where the
 *     answer to "why are there two of these pages" gets written down.
 *  2. SCOPE IS ONE CONTROL, IN ONE PLACE — the pane header, never a row and
 *     never a section action. `ScopeBar`. This is the whole fix for the
 *     Settings/Configure desync.
 *  3. ONE SECTION HEADER GRAMMAR: icon · title · description · one action slot,
 *     and the action is always an `icon-xs` ghost or an `xs outline` button.
 *  4. A SETTING IS A ROW; A THING IS AN ITEM. `PrefRow` is label→control.
 *     `ItemRow` is for repeated objects (a skill, a server, a model) and looks
 *     deliberately unlike a setting, because it is one.
 *  5. EVERYTHING SAVES ON CHANGE. There is no Save button in this kit. The
 *     three Input+Save rows in today's app become `CommitField`, which commits
 *     on blur and on Enter and says so quietly.
 *  6. STATUS HAS ONE VOCABULARY. `Health` for "is it working", `Badge` for
 *     identity, `Origin` for provenance. Three roles, three drawings, never
 *     swapped.
 *
 * Lab-only: no store, no bridge, local state throughout, so this file can be
 * read as a design document that happens to run.
 */
import * as React from "react";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";

import { Badge } from "@renderer/components/ui/badge";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { SectionHeading } from "@renderer/components/ui/section-heading";
import { Segmented } from "@renderer/components/ui/segmented";
import { StatusDot, type StatusDotState } from "@renderer/components/ui/status-dot";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { cn } from "@renderer/lib/utils";

/* -------------------------------------------------------------------------- */
/* The rail                                                                    */
/* -------------------------------------------------------------------------- */

export interface PrefCategory {
  key: string;
  label: string;
  icon: PhosphorIcon;
  /** Shown under the pane title. One line, or nothing. */
  description?: React.ReactNode;
  /** Words the search field matches beyond the label — the settings inside it. */
  keywords?: readonly string[];
  /** A count or a state worth seeing without entering the pane. */
  trailing?: React.ReactNode;
  content: React.ReactNode;
}

export interface PrefGroup {
  key: string;
  /** The eyebrow over the group. This is where "why two pages" gets answered. */
  label: string;
  categories: readonly PrefCategory[];
}

/**
 * The rail's search.
 *
 * Neither surface has one today, against ~45 controls. It filters CATEGORIES
 * rather than rows on purpose: a filtered list of rows torn out of their
 * sections is a result set nobody can act on, because half these settings only
 * mean anything next to the one above them. Matching a category on its
 * `keywords` gets you to the right pane, which is the job.
 */
function useCategoryFilter(groups: readonly PrefGroup[], query: string): readonly PrefGroup[] {
  return React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === "") return groups;
    return groups
      .map((group) => ({
        ...group,
        categories: group.categories.filter((category) =>
          [category.label, ...(category.keywords ?? [])].join(" ").toLowerCase().includes(needle),
        ),
      }))
      .filter((group) => group.categories.length > 0);
  }, [groups, query]);
}

/**
 * The two-pane preference surface: grouped rail, then one pane.
 *
 * `header` is the surface's own identity — the app for Settings, the project
 * for Configure. It sits above the search rather than inside the pane because
 * the thing being configured does not change as you move down the rail, and
 * today's Configure proves the alternative is worse: it titles its General
 * SECTION with the project's name, so the scope is announced by whichever
 * card happens to be first.
 */
export function PrefShell({
  header,
  groups,
  activeKey,
  onSelect,
}: {
  header: React.ReactNode;
  groups: readonly PrefGroup[];
  activeKey: string;
  onSelect(key: string): void;
}) {
  const [query, setQuery] = React.useState("");
  const filtered = useCategoryFilter(groups, query);
  const all = groups.flatMap((group) => group.categories);
  const active = all.find((category) => category.key === activeKey) ?? all[0] ?? null;

  return (
    <div className="flex min-h-0 flex-1">
      <nav
        aria-label="Settings categories"
        className="flex w-60 shrink-0 flex-col border-r border-border"
      >
        <div className="border-b border-border p-4">
          {header}
          <div className="relative mt-4">
            <MagnifyingGlassIcon
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search settings"
              aria-label="Search settings"
              className="pl-6"
            />
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
          {filtered.map((group) => (
            <div key={group.key} className="flex flex-col gap-1">
              <SectionHeading as="p" className="px-2 pb-1">
                {group.label}
              </SectionHeading>
              {group.categories.map((category) => {
                const isActive = active?.key === category.key;
                const Icon = category.icon;
                return (
                  <button
                    key={category.key}
                    type="button"
                    aria-current={isActive ? "page" : undefined}
                    onClick={() => onSelect(category.key)}
                    className={cn(
                      "flex items-center gap-2 rounded-md px-2 py-1 text-left text-ui transition-colors",
                      isActive
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                    )}
                  >
                    <Icon className="size-4 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{category.label}</span>
                    {category.trailing}
                  </button>
                );
              })}
            </div>
          ))}
          {filtered.length === 0 ? (
            <p className="px-2 text-ui text-muted-foreground">No settings match “{query}”.</p>
          ) : null}
        </div>
      </nav>

      <div className="min-w-0 flex-1 overflow-y-auto">
        {active ? (
          <div key={active.key} className="mx-auto w-full max-w-content px-gutter pb-16">
            <div className="pt-8 pb-4">
              <h1 className="text-heading font-semibold">{active.label}</h1>
              {active.description ? (
                <p className="mt-1 text-sm leading-6 text-muted-foreground">{active.description}</p>
              ) : null}
            </div>
            <div className="flex flex-col gap-4">{active.content}</div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Scope — rule 2                                                              */
/* -------------------------------------------------------------------------- */

export type Scope = "app" | "project";

/**
 * The scope control, and the reason this redesign exists.
 *
 * Today the same question is asked three ways within one page: Configure's App
 * theme puts Inherit/Custom on each ROW, its Terminal puts it in the SECTION
 * HEADER, and Settings puts it NOWHERE — so the app-wide pane cannot tell you
 * that the project you are looking at has overridden the thing you are editing.
 * One small "Project override" pill in one section is the entire current
 * signal.
 *
 * So: scope is a property of the PANE, it is stated once, at the top, and it
 * reads as a sentence — "Applies to · All projects | volli-code". Cursor's
 * Customize page filters by scope in exactly this position; Claude Code's
 * settings docs lead with a "who it affects" column. Both treat scope as the
 * frame around the settings, not as a decoration on each one.
 *
 * `overrides` is the honest half: when you are looking at All projects and the
 * selected project has overridden something in this pane, the bar says so and
 * offers the jump. That single line is what makes one surface able to replace
 * two.
 */
export function ScopeBar({
  scope,
  projectName,
  overrides = 0,
  onChange,
}: {
  scope: Scope;
  projectName: string;
  /** How many settings in THIS pane the project overrides. Only meaningful at app scope. */
  overrides?: number;
  onChange(next: Scope): void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-card px-4 py-2">
      <div className="flex items-center gap-2">
        <span className="text-ui text-muted-foreground">Applies to</span>
        <Segmented
          ariaLabel="Setting scope"
          value={scope}
          options={[
            { key: "app", label: "All projects" },
            { key: "project", label: projectName },
          ]}
          onChange={onChange}
        />
      </div>
      {scope === "app" && overrides > 0 ? (
        <button
          type="button"
          onClick={() => onChange("project")}
          className="flex items-center gap-1 text-ui text-muted-foreground transition-colors hover:text-foreground"
        >
          {overrides} overridden in {projectName}
          <CaretRightIcon className="size-3" />
        </button>
      ) : null}
      {scope === "project" ? (
        <span className="text-ui text-muted-foreground">
          Anything left on Inherit follows All projects.
        </span>
      ) : null}
    </div>
  );
}

/**
 * The per-row scope state, shown ONLY at project scope. Inherit is the absence
 * of a stored value, exactly as today's `projectCanvasChoice` treats it — the
 * word is a description of empty, never a stored marker.
 */
export function InheritToggle({
  inherited,
  inheritedValue,
  onChange,
}: {
  inherited: boolean;
  /** What All projects says, so Inherit is never a blank. */
  inheritedValue: React.ReactNode;
  onChange(inherit: boolean): void;
}) {
  return (
    <div className="flex items-center gap-2">
      {inherited ? (
        <span className="text-ui text-muted-foreground">
          Inheriting <span className="text-foreground">{inheritedValue}</span>
        </span>
      ) : null}
      <Segmented
        ariaLabel="Scope"
        value={inherited ? "inherit" : "custom"}
        options={[
          { key: "inherit", label: "Inherit" },
          { key: "custom", label: "Custom" },
        ]}
        onChange={(key) => onChange(key === "inherit")}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Sections and rows — rules 3 and 4                                           */
/* -------------------------------------------------------------------------- */

/**
 * A group of related settings.
 *
 * The header grammar is fixed: icon · title · description · ONE action. Today
 * the action slot holds an `icon-xs` ghost in two panes, an `icon-sm` ghost in
 * a third, an `xs outline` text button in a fourth and a whole `Segmented`
 * control in a fifth — five idioms for the top-right of a card. Here the slot
 * takes an action, and scope is not an action (rule 2), so it cannot land here.
 */
export function PrefSection({
  title,
  description,
  icon: Icon,
  action,
  children,
}: {
  title?: string;
  description?: React.ReactNode;
  icon?: PhosphorIcon;
  action?: React.ReactNode;
  children: React.ReactNode;
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
              <p className={cn("text-ui leading-5 text-muted-foreground", title && "mt-1")}>
                {description}
              </p>
            ) : null}
          </div>
          {action ? <div className="shrink-0">{action}</div> : null}
        </div>
      ) : null}
      <div>{children}</div>
    </section>
  );
}

/** The label's hover helper — kept from today's shell, unchanged. One thought, one hover. */
function RowHelp({ help }: { help: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={help}
          className="inline-flex cursor-help text-muted-foreground outline-hidden focus-visible:ring-2 focus-visible:ring-ring/45"
        >
          <span aria-hidden className="text-label">
            ⓘ
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-64">
        {help}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * ONE SETTING. Label (and only a label) on the left, its control on the right.
 *
 * `description` survives from today's row but is meant to be rare — CLAUDE.md's
 * copy rule is that the control is the explanation. It stays for the two cases
 * that earn it: a trust boundary (what a deletion takes) and a value whose
 * consequence is money or data.
 */
export function PrefRow({
  label,
  help,
  description,
  htmlFor,
  align = "center",
  children,
}: {
  label: string;
  help?: string;
  description?: React.ReactNode;
  htmlFor?: string;
  align?: "center" | "start";
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex justify-between gap-4 border-t border-border/50 py-2 first:border-t-0 first:pt-0 last:pb-0",
        align === "center" ? "items-center" : "items-start",
      )}
    >
      <div className="min-w-0 flex-1">
        <label className="block text-sm font-medium" htmlFor={htmlFor}>
          {help === undefined ? (
            label
          ) : (
            <span className="inline-flex items-center gap-1.5">
              {label}
              <RowHelp help={help} />
            </span>
          )}
        </label>
        {description ? (
          <p className="mt-1 text-ui leading-5 text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

/**
 * ONE THING, in a list of like things — a skill, an MCP server, a model, a
 * plugin.
 *
 * Deliberately not a `PrefRow`. Today Model Access renders forty models through
 * the settings row, so a model called "GPT-5.6 Luna" reads as a SETTING NAMED
 * "GPT-5.6 Luna", with two unlabelled controls to its right. An item has an
 * identity (icon, name, meta) and a state; a setting has a name and a value.
 * Drawing them the same is what makes that pane a wall.
 */
export function ItemRow({
  icon: Icon,
  name,
  meta,
  badges,
  children,
}: {
  icon?: PhosphorIcon;
  name: React.ReactNode;
  /** One quiet line: where it came from, what it costs, what it does. */
  meta?: React.ReactNode;
  badges?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-t border-border/50 py-2 first:border-t-0 first:pt-0 last:pb-0">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {Icon ? <Icon className="size-4 shrink-0 text-muted-foreground" /> : null}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-ui font-medium text-foreground">{name}</p>
            {badges}
          </div>
          {meta ? <p className="mt-1 truncate text-ui text-muted-foreground">{meta}</p> : null}
        </div>
      </div>
      {children ? <div className="flex shrink-0 items-center gap-2">{children}</div> : null}
    </div>
  );
}

/**
 * A section whose body is a searchable list of {@link ItemRow}s.
 *
 * Exists because three of the new panes (Skills, MCP, Models) are lists that
 * grow without bound, and today's answer to that is to render all of them.
 */
export function ItemList({
  placeholder,
  empty,
  children,
}: {
  placeholder: string;
  empty: string;
  children: readonly React.ReactElement[];
}) {
  const [query, setQuery] = React.useState("");
  const needle = query.trim().toLowerCase();
  const shown =
    needle === ""
      ? children
      : children.filter((child) =>
          String((child.props as { name?: unknown }).name ?? "")
            .toLowerCase()
            .includes(needle),
        );

  return (
    <>
      {children.length > 6 ? (
        <div className="pb-2">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={placeholder}
            aria-label={placeholder}
          />
        </div>
      ) : null}
      {shown.length === 0 ? (
        <p className="py-2 text-ui text-muted-foreground">{empty}</p>
      ) : (
        <div>{shown}</div>
      )}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Rule 5 — no Save buttons                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A text setting that commits on blur and on Enter.
 *
 * Replaces the five Input + `Save` pairs scattered across both surfaces today
 * (retention, base branch, setup command, web instance, web key). Those five
 * are the app's ONLY explicit-save controls; every switch, select, stepper and
 * theme picker beside them writes on change. A person cannot learn a rule with
 * five exceptions, so the exceptions go.
 *
 * The verdict is a two-second "Saved" rather than a toast: it belongs at the
 * field, and a toast for a value the user is still looking at is noise.
 */
export function CommitField({
  id,
  value,
  placeholder,
  width = "w-56",
  type = "text",
  onCommit,
}: {
  id?: string;
  value: string;
  placeholder?: string;
  width?: string;
  type?: "text" | "number" | "password";
  onCommit(next: string): void;
}) {
  const [draft, setDraft] = React.useState(value);
  const [saved, setSaved] = React.useState(false);
  const committed = React.useRef(value);

  React.useEffect(() => {
    setDraft(value);
    committed.current = value;
  }, [value]);

  const commit = (): void => {
    if (draft === committed.current) return;
    committed.current = draft;
    onCommit(draft);
    setSaved(true);
  };

  React.useEffect(() => {
    if (!saved) return;
    const timer = window.setTimeout(() => setSaved(false), 1600);
    return () => window.clearTimeout(timer);
  }, [saved]);

  return (
    <div className="flex items-center gap-2">
      <span
        aria-live="polite"
        className={cn(
          "text-ui text-muted-foreground transition-opacity duration-150",
          saved ? "opacity-100" : "opacity-0",
        )}
      >
        Saved
      </span>
      <Input
        id={id}
        type={type}
        value={draft}
        placeholder={placeholder}
        className={width}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") setDraft(committed.current);
        }}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Rule 6 — one status vocabulary                                              */
/* -------------------------------------------------------------------------- */

/**
 * "Is this working?" — the ONLY thing that gets a coloured dot.
 *
 * Today a dot means health in CLI, on/off in Web, and nothing at all in Model
 * Access, while provenance is a pill, origin is a `Badge`, and a stored key is
 * plain muted text. Four vocabularies for one column of a settings pane.
 *
 * Here: dot = health, `Badge` = identity, {@link Origin} = provenance. A
 * surface may pick which one it needs; it may not pick what the drawing means.
 */
export function Health({ state, children }: { state: StatusDotState; children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-2 text-ui text-foreground">
      <StatusDot state={state} />
      {children}
    </span>
  );
}

/** Where a value came from. Emphasised when Volli is the one that set it. */
export function Origin({ mine, children }: { mine?: boolean; children: React.ReactNode }) {
  return <Badge variant={mine ? "accent" : "outline"}>{children}</Badge>;
}

/* -------------------------------------------------------------------------- */
/* Diagnostics — "concise, no internals"                                       */
/* -------------------------------------------------------------------------- */

/**
 * The whole of diagnostics, in one line, with the internals behind a disclosure.
 *
 * Today CLI is a seven-row pane of `binDir`, socket paths, shell-chain booleans,
 * a legacy-path tri-state and a PATH comparison table — every one of it a fact
 * about our plumbing rather than about the user's machine. The brief for this
 * pass is "extremely concise, don't expose the user to internals", so the
 * default state is a sentence and a button; `Details` is there for the bug
 * report and is plain-language even when open.
 */
export function HealthSummary({
  state,
  headline,
  detail,
  actions,
  children,
}: {
  state: StatusDotState;
  headline: string;
  detail?: string;
  actions?: React.ReactNode;
  /** The internals. Closed by default, and never the first thing anyone reads. */
  children?: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="rounded-lg bg-card px-4 py-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-2">
          <StatusDot state={state} className="mt-1.5" />
          <div className="min-w-0">
            <p className="text-sm font-medium">{headline}</p>
            {detail ? <p className="mt-1 text-ui text-muted-foreground">{detail}</p> : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      </div>
      {children ? (
        <>
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            className="mt-2 flex items-center gap-1 text-ui text-muted-foreground transition-colors hover:text-foreground"
          >
            <CaretRightIcon
              className={cn("size-3 transition-transform duration-150", open && "rotate-90")}
            />
            {open ? "Hide details" : "Details"}
          </button>
          {open ? <div className="mt-2 border-t border-border/50 pt-2">{children}</div> : null}
        </>
      ) : null}
    </div>
  );
}

/** A plain-language fact inside `Details`. Not a path, not a boolean. */
export function DetailLine({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1">
      <span className="text-ui text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-ui text-foreground">{value}</span>
    </div>
  );
}

/** The one shape for a section's trailing action, so rule 3 has something to point at. */
export function SectionAction({
  label,
  icon: Icon,
  onClick,
}: {
  label: string;
  icon?: PhosphorIcon;
  onClick?: () => void;
}) {
  return (
    <Button size="xs" variant="outline" onClick={onClick}>
      {Icon ? <Icon /> : null}
      {label}
    </Button>
  );
}
