/**
 * VC-111 — the proposed settings grammar, as primitives. **Second pass**, after
 * an independent review tore the first one apart
 * (docs/plans/settings-redesign-review.md).
 *
 * The first pass closed four drifts and opened five, because it had no
 * vocabulary for what every real pane in this app actually is: asynchronous,
 * failable, and empty before it is full. It also invented a pane-level scope
 * MODE that lied about any row it could not scope. Both are fixed here.
 *
 * ── THE RULES ─────────────────────────────────────────────────────────────
 *
 *  1. THE RAIL IS GROUPED AND SEARCHABLE. Group labels are where the
 *     Settings-vs-Configure relationship is written down.
 *
 *  2. SCOPE IS THE SURFACE, NOT A MODE. **Settings panes are always app-wide.
 *     Configure panes are always this project.** There is no scope switch,
 *     because a pane-level switch claims every row in the pane is scopeable and
 *     most are not (review §1.2a/b). A Configure row that can defer to the
 *     app-wide value carries {@link InheritControl} — ONE idiom, everywhere,
 *     always naming the value it inherits. Settings shows {@link OverrideNote},
 *     which is information, not a control.
 *
 *  3. ONE SECTION HEADER GRAMMAR: icon · title · one action. Two legal action
 *     shapes and a primitive for each ({@link SectionAction},
 *     {@link SectionIconAction}) so neither gets hand-rolled.
 *
 *  4. A SETTING IS A ROW; A THING IS AN ITEM. {@link PrefRow} is label→control.
 *     {@link ItemRow} is a skill/server/model.
 *
 *  5. ONE SAVE MODEL, AND IT CAN REFUSE. Controls save on change.
 *     {@link CommitField} validates before writing, can be refused by the
 *     write, shows the refusal BESIDE the field, and only says "Saved" once
 *     something was. A setting that is destructive or expensive takes
 *     `confirm` and asks first.
 *
 *  6. ONE STATUS VOCABULARY, THREE ROLES, THREE COMPONENTS.
 *     {@link Health} = is it working. {@link Tier} = which layer it came from.
 *     {@link Provenance} = who set this value. The first pass used one `Origin`
 *     component with a boolean that meant "Volli set it" in Settings and "this
 *     project" in Configure — one prop, two meanings, which is the drift this
 *     rule exists to forbid.
 *
 *  7. EVERY PANE DECLARES ITS STATES. {@link AsyncSection} takes
 *     loading/error/empty/ready and there is no other way to draw them, so a
 *     pane cannot invent a fifth. This is the rule the first pass was missing
 *     entirely, and it governs the 80% of a settings surface that is state.
 *
 *  8. WIDTHS COME FROM A LADDER. {@link CONTROL_W}. The first pass used eight
 *     ad-hoc Tailwind widths and left a ragged right edge.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * COPY RULE. CLAUDE.md: "let controls talk — do not add `description` on
 * sections/rows, tutorial tooltips, or paragraphs under controls unless the
 * user asked." The first pass added thirteen section descriptions and two new
 * tooltips, including to a pane carrying an explicit handoff note asking nobody
 * to do that. `PrefSection` therefore has NO `description` prop at all: the
 * only prose slots left are `PrefRow.description` (documented as a trust
 * boundary exception) and `PrefRow.help`.
 *
 * Lab-only: local state, no store, no bridge.
 */
import * as React from "react";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import { ArrowsClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowsClockwise";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { InfoIcon } from "@phosphor-icons/react/dist/csr/Info";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";

import { ContentColumn } from "@renderer/components/layout/content-column";
import { PageHeader } from "@renderer/components/layout/page-header";
import { Badge } from "@renderer/components/ui/badge";
import { Button } from "@renderer/components/ui/button";
import { EMPTY_INLINE } from "@renderer/components/ui/empty-classes";
import { Input } from "@renderer/components/ui/input";
import { Notice } from "@renderer/components/ui/notice";
import { SectionHeading } from "@renderer/components/ui/section-heading";
import { Segmented } from "@renderer/components/ui/segmented";
import { Spinner } from "@renderer/components/ui/spinner";
import { StatusDot, type StatusDotState } from "@renderer/components/ui/status-dot";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { cn } from "@renderer/lib/utils";

/**
 * Rule 8 — the control-width ladder.
 *
 * Three rungs, chosen from what the real controls need: a number or a short
 * enum, a path or a branch name, a model identifier with its provider. The
 * first pass shipped `w-72 w-56 w-48 w-40 w-32 w-24 w-20 w-10` across two files
 * with nothing governing the right edge.
 */
export const CONTROL_W = {
  /** Numbers, short enums, steppers. */
  sm: "w-24",
  /** Branch names, commands, hostnames, app pickers. */
  md: "w-56",
  /** Model identifiers — "claude-sonnet-4.6 · Anthropic" and longer. */
  lg: "w-72",
} as const;

export type ControlWidth = keyof typeof CONTROL_W;

/* -------------------------------------------------------------------------- */
/* Rule 1 — the rail                                                           */
/* -------------------------------------------------------------------------- */

export interface PrefCategory {
  key: string;
  label: string;
  icon: PhosphorIcon;
  /**
   * Words the search matches beyond the label.
   *
   * Hand-maintained, and the review is right that this rots (§1.6): the first
   * pass advertised "reasoning" on a pane with no reasoning control. The real
   * fix is to derive it from the rows at build time; until the panes are real
   * components rather than fixtures, the mitigation is that this list is
   * asserted against the pane's rendered labels in `kit.test.ts`.
   */
  keywords?: readonly string[];
  /**
   * A count worth seeing without entering the pane.
   *
   * A `Badge` reads fine as part of the button's accessible name ("Skills 7").
   * A coloured dot does not ("MCP Servers 1 failing"), which is why state is
   * carried by {@link PrefCategory.attention} instead — it renders the dot
   * `aria-hidden` AND appends a real text suffix, so the signal survives for a
   * screen reader rather than being deleted for one (review §4.4).
   */
  trailing?: React.ReactNode;
  /** One word appended to the rail button's name when the pane needs attention. */
  attention?: { tone: "primary" | "destructive"; label: string };
  content: React.ReactNode;
}

export interface PrefGroup {
  key: string;
  label: string;
  categories: readonly PrefCategory[];
}

function useCategoryFilter(groups: readonly PrefGroup[], query: string) {
  return React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === "") return { groups, total: groups.flatMap((g) => g.categories).length };
    const filtered = groups
      .map((group) => ({
        ...group,
        categories: group.categories.filter((category) =>
          [category.label, ...(category.keywords ?? [])].join(" ").toLowerCase().includes(needle),
        ),
      }))
      .filter((group) => group.categories.length > 0);
    return { groups: filtered, total: filtered.flatMap((g) => g.categories).length };
  }, [groups, query]);
}

export function PrefShell({
  surfaceLabel,
  header,
  groups,
  activeKey,
  onSelect,
}: {
  /** Names the rail's landmark, so two preference surfaces are distinguishable. */
  surfaceLabel: string;
  header: React.ReactNode;
  groups: readonly PrefGroup[];
  activeKey: string;
  onSelect(key: string): void;
}) {
  const [query, setQuery] = React.useState("");
  const { groups: filtered, total } = useCategoryFilter(groups, query);
  const all = groups.flatMap((group) => group.categories);
  const active = all.find((category) => category.key === activeKey) ?? all[0] ?? null;

  // Review §4.7: the pane's inner div was keyed but the SCROLL CONTAINER was
  // the unkeyed parent, so leaving a scrolled Models pane for a short one
  // landed on blank space. The scroller is reset explicitly on entry.
  const scroller = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [active?.key]);

  return (
    <div className="flex min-h-0 flex-1">
      <nav aria-label={surfaceLabel} className="flex w-60 shrink-0 flex-col border-r border-border">
        <div className="border-b border-border p-4">
          {header}
          <div className="relative mt-4">
            <MagnifyingGlassIcon
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              // `search` rather than `text`: it gets the platform's clear
              // affordance and Escape-to-clear for free, which review §2.12
              // asked for and a bare text input does not have.
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search"
              aria-label={`Search ${surfaceLabel}`}
              className="pl-6"
            />
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
          {/* Review §4.8 — the result count was never announced. */}
          <p aria-live="polite" className="sr-only">
            {query.trim() === "" ? "" : `${total} ${total === 1 ? "result" : "results"}`}
          </p>
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
                    {category.attention ? (
                      <>
                        <span
                          aria-hidden
                          className={cn(
                            "size-1.5 shrink-0 rounded-full",
                            category.attention.tone === "primary" ? "bg-primary" : "bg-destructive",
                          )}
                        />
                        <span className="sr-only">{category.attention.label}</span>
                      </>
                    ) : null}
                    {category.trailing}
                  </button>
                );
              })}
            </div>
          ))}
          {filtered.length === 0 ? (
            <p className="px-2 text-ui text-muted-foreground">No settings match.</p>
          ) : null}
        </div>
      </nav>

      <div ref={scroller} className="min-w-0 flex-1 overflow-y-auto">
        {active ? (
          // Review §5.2: the first pass inlined `mx-auto w-full max-w-content
          // px-gutter` and a hand-rolled <h1>, which is ContentColumn and
          // PageHeader copied as strings — the exact failure DESIGN.md's
          // opening principle names, in the file arguing for cohesion.
          <ContentColumn className="pb-16">
            <PageHeader variant="reading" title={active.label} />
            <div key={active.key} className="flex flex-col gap-4">
              {active.content}
            </div>
          </ContentColumn>
        ) : null}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Rule 2 — inheritance, one idiom                                             */
/* -------------------------------------------------------------------------- */

/**
 * A Configure row that may defer to the app-wide value.
 *
 * THE ONE INHERITANCE IDIOM. The first pass had three — a `Segmented` in
 * Appearance, a "Same as Project chats" option inside a `Select` in Models, and
 * a "Same as Settings — …" option inside a different `Select` in Sessions —
 * while its own rule said scope lives in exactly one place (review §1.1, §1.3).
 * Anything that inherits now looks like this, on every surface.
 *
 * Inherit is the ABSENCE of a stored value, never a stored marker, matching
 * `projectCanvasChoice`'s existing treatment. `inheritedValue` is required
 * rather than optional: an Inherit state that does not name what it inherits is
 * the blank-looking-like-unconfigured problem the app already solved once.
 *
 * `ariaLabel` is required for the same reason — the first pass hardcoded
 * `"Scope"`, so a pane with three of these announced three identical groups,
 * regressing from today's "Canvas scope" / "Terminal theme scope" (review §4.2).
 */
export function InheritControl({
  ariaLabel,
  inherited,
  inheritedValue,
  onChange,
  children,
}: {
  ariaLabel: string;
  inherited: boolean;
  /** What the app-wide setting says. Shown whenever this row is inheriting. */
  inheritedValue: React.ReactNode;
  onChange(inherit: boolean): void;
  /** The control itself, rendered only when this row is NOT inheriting. */
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      {inherited ? (
        <span className="text-ui text-muted-foreground">
          <span className="text-foreground">{inheritedValue}</span>
        </span>
      ) : (
        children
      )}
      <Segmented
        ariaLabel={ariaLabel}
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

/**
 * Settings' half of the same fact: this app-wide value is overridden somewhere.
 *
 * INFORMATION, NOT A MODE. The first pass put a two-option `Segmented` at the
 * top of the pane that swapped its whole contents — which hid every row that
 * could not be scoped, silently mis-framed the ones it kept, could not express
 * a twelfth project's override, took a hand-maintained integer that nothing
 * derived, and had no state for "no project selected" (review §1.2 a–f).
 *
 * This takes the projects themselves, so the count cannot drift from the list,
 * and it names them — which is the question "3 overridden" could not answer.
 */
export function OverrideNote({
  projects,
  onOpen,
}: {
  /** Every project overriding something in THIS pane. Empty renders nothing. */
  projects: readonly string[];
  onOpen(project: string): void;
}) {
  if (projects.length === 0) return null;
  const shown = projects.slice(0, 3);
  return (
    <p className="text-ui text-muted-foreground">
      Overridden in{" "}
      {shown.map((project, index) => (
        <React.Fragment key={project}>
          {index > 0 ? ", " : ""}
          <button
            type="button"
            onClick={() => onOpen(project)}
            // `max-w-48` + truncate: a 60-character monorepo folder name blew
            // the first pass's scope control out of the 720px measure, because
            // it rendered the raw project name into a Segmented label that has
            // no truncation (review §1.2f).
            className="max-w-48 truncate align-bottom text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground"
          >
            {project}
          </button>
        </React.Fragment>
      ))}
      {projects.length > shown.length ? ` and ${projects.length - shown.length} more` : ""}.
    </p>
  );
}

/* -------------------------------------------------------------------------- */
/* Rules 3 and 4 — sections, rows, items                                       */
/* -------------------------------------------------------------------------- */

/**
 * A group of related settings.
 *
 * NO `description` PROP. CLAUDE.md forbids section descriptions outright, and
 * the first pass added thirteen of them. Removing the prop is what makes the
 * rule enforceable rather than aspirational — a pane cannot add helper text
 * here because there is nowhere to put it.
 */
export function PrefSection({
  title,
  icon: Icon,
  action,
  children,
}: {
  title?: string;
  icon?: PhosphorIcon;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  const hasHeader = title !== undefined || action !== undefined;
  return (
    <section className="rounded-lg bg-card px-4 py-2">
      {hasHeader ? (
        <div className="mb-2 flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-2">
            {Icon ? <Icon className="size-4 shrink-0 text-muted-foreground" /> : null}
            {title ? <h2 className="truncate text-sm font-semibold">{title}</h2> : null}
          </div>
          {action ? <div className="shrink-0">{action}</div> : null}
        </div>
      ) : null}
      <div>{children}</div>
    </section>
  );
}

/** Rule 3, shape one: a named action. */
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

/**
 * Rule 3, shape two: a glyph-only action — refresh, and nothing else so far.
 *
 * A primitive rather than a convention, because the first pass named two legal
 * shapes and shipped one, which guaranteed the other would be hand-rolled at
 * every call site (review §1.6).
 */
export function SectionIconAction({
  label,
  icon: Icon = ArrowsClockwiseIcon,
  busy = false,
  onClick,
}: {
  label: string;
  icon?: PhosphorIcon;
  busy?: boolean;
  onClick?: () => void;
}) {
  return (
    <Button size="icon-xs" variant="ghost" aria-label={label} disabled={busy} onClick={onClick}>
      <Icon className={busy ? "animate-spin" : undefined} />
    </Button>
  );
}

/**
 * The label's hover helper.
 *
 * OUTSIDE the `<label>`, unlike today's shell and unlike the first pass, which
 * inherited the bug and then claimed to have fixed the drift: a button nested
 * inside a `<label htmlFor>` forwards its activation to the labelled control,
 * so pressing "what is this?" next to a Switch TOGGLES THE SWITCH (review §4.5).
 *
 * A real `InfoIcon`, not the `ⓘ` character the first pass substituted — a
 * unicode glyph sits outside the Phosphor weight/size language and renders
 * differently on every fallback font (review §4.6).
 */
function RowHelp({ help }: { help: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={help}
          className="inline-flex cursor-help text-muted-foreground outline-hidden focus-visible:ring-2 focus-visible:ring-ring/45"
        >
          <InfoIcon aria-hidden className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-64">
        {help}
      </TooltipContent>
    </Tooltip>
  );
}

export function PrefRow({
  label,
  help,
  description,
  htmlFor,
  align = "center",
  testId,
  children,
}: {
  label: string;
  help?: string;
  /** Trust boundaries only — what a deletion takes, what a value costs. */
  description?: React.ReactNode;
  htmlFor?: string;
  align?: "center" | "start";
  /**
   * Kept from `SettingsRow`. The first pass dropped it, which breaks fifteen
   * references across `model-access-settings.test.tsx`,
   * `appearance-settings.test.tsx` and `e2e/canvas-theming-smoke.mjs` — a
   * migration cost the proposal never mentioned (review §2.11).
   */
  testId?: string;
  children: React.ReactNode;
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
        {/* The label and its helper are SIBLINGS — see RowHelp. */}
        <div className="flex items-center gap-1.5">
          <label className="block text-sm font-medium" htmlFor={htmlFor}>
            {label}
          </label>
          {help === undefined ? null : <RowHelp help={help} />}
        </div>
        {description ? (
          <p className="mt-1 text-ui leading-5 text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

export function ItemRow({
  icon: Icon,
  name,
  meta,
  badges,
  testId,
  children,
}: {
  icon?: PhosphorIcon;
  name: string;
  meta?: React.ReactNode;
  badges?: React.ReactNode;
  testId?: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      className="flex items-center justify-between gap-4 border-t border-border/50 py-2 first:border-t-0 first:pt-0 last:pb-0"
    >
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

/* -------------------------------------------------------------------------- */
/* Rule 7 — every pane declares its states                                     */
/* -------------------------------------------------------------------------- */

/** What a pane's data can be. `empty` is NOT `ready` with nothing in it — see below. */
export type AsyncState<T> =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: T };

/**
 * A section whose body depends on a read that can fail.
 *
 * THE PRIMITIVE THE FIRST PASS DID NOT HAVE. Every real settings pane in this
 * app — worktrees, CLI, web access, model access, project appearance — renders
 * a loading line, a `Notice` with a Retry, and an empty state, and the first
 * kit had no vocabulary for any of it. So each pane would have invented its
 * own, which is exactly the drift the rules exist to stop (review §1.6).
 *
 * `empty` and `noResults` are separate slots on purpose: a project with no
 * skills at all and a search that matched nothing are different answers, and
 * the first pass rendered "No skills match." for both (review §2.4).
 */
export function AsyncSection<T>({
  title,
  icon,
  action,
  state,
  isEmpty,
  empty,
  onRetry,
  children,
}: {
  title?: string;
  icon?: PhosphorIcon;
  action?: React.ReactNode;
  state: AsyncState<T>;
  /** Whether ready data is the genuinely-nothing case. */
  isEmpty?(data: T): boolean;
  /** One line for the genuinely-nothing case. */
  empty?: string;
  onRetry?(): void;
  children(data: T): React.ReactNode;
}) {
  return (
    <PrefSection title={title} icon={icon} action={action}>
      {state.status === "loading" ? (
        <p className={cn(EMPTY_INLINE, "flex items-center gap-2")}>
          <Spinner className="size-3.5" />
          Loading…
        </p>
      ) : state.status === "error" ? (
        // A read that FAILED and a read that found nothing are not the same
        // answer — `settings-page.tsx` learned this the hard way and says so.
        // The recovery lives here rather than in a toast, for the same reason.
        <Notice
          announce
          tone="error"
          icon={WarningIcon}
          title="Couldn't load this"
          detail={state.message}
          actions={
            onRetry ? (
              <Button size="xs" variant="outline" onClick={onRetry}>
                <ArrowsClockwiseIcon />
                Retry
              </Button>
            ) : undefined
          }
        />
      ) : isEmpty?.(state.data) ? (
        <p className={EMPTY_INLINE}>{empty ?? "Nothing here yet."}</p>
      ) : (
        children(state.data)
      )}
    </PrefSection>
  );
}

/**
 * A searchable list of like things.
 *
 * TAKES DATA AND A RENDERER, never children. The first pass typed `children` as
 * `ReactElement[]` and filtered by reaching into `child.props.name`, which
 * breaks on a single child, a fragment, a conditional, a nested map, or any
 * wrapper — and returned `"[object Object]"` for the `ReactNode` name its own
 * `ItemRow` allowed (review §3.1).
 *
 * `search` extracts the haystack, so a model row can match on its PROVIDER as
 * well as its name. That is not a nicety: `model-access-settings.tsx` documents
 * that eight providers ship a model called exactly "GPT-5.6 Luna", so a filter
 * over names alone cannot tell two rows apart (review §2.5).
 */
export function ItemList<T>({
  items,
  search,
  keyOf,
  placeholder,
  noResults = "Nothing matches.",
  /**
   * Always show the field. The first pass hid it under `children.length > 6` —
   * a magic threshold that hides search on the seven-item list you want to
   * search and shows it on the one you do not (review §3.2).
   */
  render,
}: {
  items: readonly T[];
  search(item: T): string;
  keyOf(item: T): string;
  placeholder: string;
  noResults?: string;
  render(item: T): React.ReactNode;
}) {
  const [query, setQuery] = React.useState("");
  const needle = query.trim().toLowerCase();
  const shown =
    needle === "" ? items : items.filter((item) => search(item).toLowerCase().includes(needle));

  return (
    <>
      <div className="pb-2">
        <Input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={placeholder}
          aria-label={placeholder}
        />
      </div>
      <p aria-live="polite" className="sr-only">
        {needle === "" ? "" : `${shown.length} of ${items.length} shown`}
      </p>
      {shown.length === 0 ? (
        <p className={EMPTY_INLINE}>{noResults}</p>
      ) : (
        <div>
          {shown.map((item) => (
            <React.Fragment key={keyOf(item)}>{render(item)}</React.Fragment>
          ))}
        </div>
      )}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Rule 5 — one save model, and it can refuse                                  */
/* -------------------------------------------------------------------------- */

export type CommitResult = { ok: true; value?: string } | { ok: false; error: string };

/**
 * A text setting that commits on blur and on Enter — and can be told no.
 *
 * The first pass got the principle right and the primitive wrong. It sent the
 * raw string on blur with no validation, no disabled state and no error slot,
 * which for the retention TTL means select-all-type-`1`-click-away silently
 * commits a one-day window on the setting that AUTOMATICALLY DELETES WORKTREE
 * FOLDERS. Today that field validates, disables while saving, toasts a refusal
 * and reflects main's clamped value back (review §1.5).
 *
 * So this one:
 *  - runs `validate` BEFORE writing and refuses locally, holding the draft;
 *  - takes an async `onCommit` returning a {@link CommitResult}, so a refusal
 *    from main lands BESIDE THE FIELD — which is where `web-access-settings.tsx`
 *    deliberately puts its endpoint-policy refusals, and a decision this would
 *    otherwise have regressed into a toast;
 *  - adopts a `value` the write hands back (a clamped number, a normalised URL);
 *  - says "Saved" only after something was saved. The first pass showed it the
 *    moment the draft differed, so a FAILED write read as success — against
 *    CLAUDE.md's "surface every failed mutation" (review §5.4).
 *  - renders the verdict CONDITIONALLY. An `aria-live` region whose text is the
 *    constant "Saved" can never announce, because live regions fire on content
 *    change; and at `opacity-0` it stays in the accessibility tree, so every
 *    field on the page read "Saved" permanently (review §4.1).
 *  - does not clobber an in-progress edit: `value` is adopted only while the
 *    field is idle, so a background refresh mid-typing cannot wipe the draft.
 *
 * `confirm` is the escape hatch for a setting that is destructive or expensive.
 */
export function CommitField({
  id,
  value,
  placeholder,
  width = "md",
  type = "text",
  disabled = false,
  validate,
  confirm,
  onCommit,
}: {
  id?: string;
  value: string;
  placeholder?: string;
  width?: ControlWidth;
  type?: "text" | "number" | "password";
  disabled?: boolean;
  /** Local refusal, before any write. Return a sentence to reject. */
  validate?(next: string): string | null;
  /** Asked before writing. Return false to abandon. */
  confirm?(next: string): boolean | Promise<boolean>;
  onCommit(next: string): Promise<CommitResult> | CommitResult;
}) {
  const [draft, setDraft] = React.useState(value);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const committed = React.useRef(value);
  const dirty = draft !== committed.current;

  React.useEffect(() => {
    // Adopt an externally-changed value ONLY when the user is not mid-edit.
    if (dirty || busy) return;
    setDraft(value);
    committed.current = value;
  }, [value, dirty, busy]);

  React.useEffect(() => {
    if (!saved) return;
    const timer = window.setTimeout(() => setSaved(false), 1800);
    return () => window.clearTimeout(timer);
  }, [saved]);

  async function commit(): Promise<void> {
    if (!dirty || busy) return;
    const refusal = validate?.(draft) ?? null;
    if (refusal !== null) {
      setError(refusal);
      return;
    }
    if (confirm && !(await confirm(draft))) {
      setDraft(committed.current);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await onCommit(draft);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const stored = result.value ?? draft;
      committed.current = stored;
      setDraft(stored);
      setSaved(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        {/* Conditional, so the live region has content to announce. */}
        {saved ? (
          <span aria-live="polite" className="text-ui text-muted-foreground">
            Saved
          </span>
        ) : null}
        <Input
          id={id}
          type={type}
          value={draft}
          placeholder={placeholder}
          disabled={disabled || busy}
          aria-invalid={error !== null}
          aria-errormessage={error !== null && id ? `${id}-error` : undefined}
          className={CONTROL_W[width]}
          onChange={(event) => {
            setDraft(event.target.value);
            if (error !== null) setError(null);
          }}
          onBlur={() => void commit()}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              setDraft(committed.current);
              setError(null);
            }
          }}
        />
      </div>
      {error !== null ? (
        <p id={id ? `${id}-error` : undefined} className="text-ui text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Rule 6 — one status vocabulary, three roles, three components               */
/* -------------------------------------------------------------------------- */

/** Is it working? The only thing that gets a coloured dot. */
export function Health({ state, children }: { state: StatusDotState; children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-2 text-ui text-foreground">
      <StatusDot state={state} />
      {children}
    </span>
  );
}

/**
 * Which LAYER a thing came from — this project, or your personal directory.
 *
 * Its own component rather than a boolean on a shared one. The first pass had a
 * single `Origin` whose `mine` prop meant "Volli set this value" in Settings
 * and "this project owns this item" in Configure: one prop, two meanings, which
 * is precisely the drift rule 6 forbids (review §1.6).
 */
export function Tier({ scope }: { scope: "project" | "personal" }) {
  return (
    <Badge variant={scope === "project" ? "accent" : "outline"}>
      {scope === "project" ? "This project" : "Personal"}
    </Badge>
  );
}

/** Who set a VALUE — the Ghostty chain's provenance chip and nothing else. */
export function Provenance({ mine, children }: { mine?: boolean; children: React.ReactNode }) {
  return <Badge variant={mine ? "accent" : "outline"}>{children}</Badge>;
}

/* -------------------------------------------------------------------------- */
/* Diagnostics — concise, but not lossy                                        */
/* -------------------------------------------------------------------------- */

/** One thing that is wrong, and the one thing to do about it. */
export interface Fault {
  id: string;
  headline: string;
  detail?: string;
  remedy?: { label: string; onAct(): void };
}

/**
 * The health surface: one headline, then the faults that are ACTUALLY PRESENT,
 * each with its own remedy.
 *
 * The first pass collapsed CLI + Harness + Doctor into "one sentence, one
 * button", and the review found nine things that loses — four link states with
 * four different remedies, `installSuppressed`'s reinstall path, Doctor's
 * per-check remedies and its `--fix`, the legacy path a user is told to delete
 * but never shown, `SessionPathComparison`'s `pending` tri-state, and the
 * project-scoped credential-helper read (review §1.4). "One sentence over a
 * four-state link and an N-check report" is a lossy cast, not concision.
 *
 * This is the shape `cli-status-model.ts` already implies: on a healthy machine
 * it IS one sentence, because `faults` is empty — which is the case the brief
 * was written about. On a broken one it grows a row per real problem and keeps
 * every remedy the model already computes.
 */
export function HealthPanel({
  healthy,
  headline,
  faults,
  actions,
  children,
}: {
  healthy: boolean;
  headline: string;
  faults: readonly Fault[];
  actions?: React.ReactNode;
  /** Plain-language facts, behind a disclosure. Never the first thing read. */
  children?: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const detailsId = React.useId();
  return (
    <div className="rounded-lg bg-card px-4 py-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-2">
          <StatusDot state={healthy ? "ready" : "waiting"} className="mt-1" />
          <p className="min-w-0 text-sm font-medium">{headline}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      </div>

      {faults.length > 0 ? (
        <div className="mt-2 flex flex-col gap-2 border-t border-border/50 pt-2">
          {faults.map((fault) => (
            <div key={fault.id} className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-ui text-foreground">{fault.headline}</p>
                {fault.detail ? (
                  <p className="mt-1 text-ui text-muted-foreground">{fault.detail}</p>
                ) : null}
              </div>
              {fault.remedy ? (
                <Button size="xs" variant="outline" onClick={fault.remedy.onAct}>
                  {fault.remedy.label}
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {children ? (
        <>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={detailsId}
            onClick={() => setOpen((value) => !value)}
            className="mt-2 flex items-center gap-1 text-ui text-muted-foreground transition-colors hover:text-foreground"
          >
            <CaretRightIcon
              aria-hidden
              className={cn("size-3 transition-transform duration-150", open && "rotate-90")}
            />
            {open ? "Hide details" : "Details"}
          </button>
          {open ? (
            <div id={detailsId} className="mt-2 border-t border-border/50 pt-2">
              {children}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/**
 * A plain-language fact inside `Details`.
 *
 * `title` on the value, because the first pass truncated it with no hover — so
 * five harnesses rendered as an ellipsis and nothing else (review §1.4.7).
 */
export function DetailLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1">
      <span className="shrink-0 text-ui text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-ui text-foreground" title={value}>
        {value}
      </span>
    </div>
  );
}
