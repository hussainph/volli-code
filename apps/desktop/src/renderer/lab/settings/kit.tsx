/**
 * VC-111 — the settings design kit. **Third pass.**
 *
 * The second pass was reviewed for correctness and passed. Then it was asked
 * the question it had never been asked: *are these the right components?* The
 * answer was no — and not because better ones exist on npm, but because better
 * ones exist **in this repository**, and this file had quietly grown a second
 * design system beside the real one.
 *
 * WHAT THE LIBRARY PASS FOUND (`pick-ui-library`, whose first instruction is
 * "check what's already installed"):
 *
 *  - `ui/list-row.tsx` — five real surfaces draw rows through it. `ItemRow` was
 *    a sixth hand-rolled copy, and it had *already* re-made the mistake that
 *    file exists to prevent: its actions were inside the row's own flex target
 *    instead of a sibling, and it drew a hover fill on rows that activate
 *    nothing. `ItemRow` is now a thin arrangement over `ListRow`.
 *  - `ui/status-dot.tsx` — twelve surfaces, including the two settings pages
 *    being redesigned, get their status colour from one exhaustive map whose
 *    header says in as many words that its whole point is that "a surface can
 *    choose to draw a dot but cannot choose what the dot means". `Health` had
 *    invented a second map. It now delegates.
 *  - `ui/section-heading.tsx`, `ui/skeleton.tsx`, `ui/input-group.tsx` — three
 *    more primitives re-derived here by hand.
 *  - `ui/badge.tsx` has a `count` variant that is *bare muted mono, not a
 *    pill*, written for exactly the case the rail was using `secondary` for.
 *
 * The one object the app genuinely does not have is a **table** — `grep` finds
 * no `<table>` in the renderer at all. So `DataTable` below is new, built from
 * the same tokens.
 *
 * On virtualization: the curated pick is Virtuoso and it is *not* installed.
 * The threshold that justifies it is ~1,000 rows; a model catalogue is ~100 and
 * a skills folder ~200. A capped scroll container is correct at this size, so
 * the dependency is flagged and deliberately not added.
 *
 * THE PILL BUDGET. `ui/segmented.tsx` warns against "a second control
 * language", and `docs/DESIGN.md` reserves the pill for *a control that acts*.
 * Repeating a "This project" pill down every row of a list spends that shape on
 * a fact, not an action. Provenance is a **table column** now, filterable from
 * one control in the toolbar, and `Segmented` survives in exactly one place:
 * Light/Dark/Auto, which is a closed three-way with icons.
 *
 * THE PROSE BUDGET. Explanations that were paragraphs under a section are now
 * `InfoHint` — one `(i)` that opens on hover or focus. CLAUDE.md's rule is that
 * controls talk; a hint a reader summons is not the surface talking at them.
 *
 * ── THE RULES ─────────────────────────────────────────────────────────────
 *  1. Grouped, searchable rail; group labels carry the relationship.
 *  2. Scope is the surface. Settings is app-wide, Configure is this project.
 *     Divergence is marked once per row by `OverrideControl`, never by a mode.
 *  3. One section header grammar: icon · title · one action.
 *  4. A setting is a `PrefRow`. A collection of things is a `DataTable`.
 *  5. One save model, and it can refuse (`CommitField`).
 *  6. Status has three roles and three components: `Health` (is it working),
 *     `Provenance` (who set it), and a table column (where it came from).
 *  7. Every collection declares loading, error, empty and no-results.
 *  8. Widths come from `CONTROL_W`; nothing else sets one.
 *  9. Prefer the repo's primitive. If one exists, this file wraps it.
 * ──────────────────────────────────────────────────────────────────────────
 */
import * as React from "react";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowCounterClockwise";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { InfoIcon } from "@phosphor-icons/react/dist/csr/Info";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";

import { Badge } from "@renderer/components/ui/badge";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@renderer/components/ui/input-group";
import { ListRow } from "@renderer/components/ui/list-row";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import { SectionHeading } from "@renderer/components/ui/section-heading";
import { Skeleton } from "@renderer/components/ui/skeleton";
import { StatusDot, type StatusDotState } from "@renderer/components/ui/status-dot";
import { ContentColumn } from "@renderer/components/layout/content-column";
import { PageHeader } from "@renderer/components/layout/page-header";
import { cn } from "@renderer/lib/utils";

/* ========================================================================== */
/* Rule 8 — the width ladder                                                  */
/* ========================================================================== */

/**
 * Three widths, because the app's controls sit in a right-aligned column and a
 * column with eight widths in it is not a column. The second pass counted eight
 * ad-hoc `w-*` classes across two panes.
 */
export const CONTROL_W = {
  sm: "w-24",
  md: "w-44",
  lg: "w-64",
} as const;

export type ControlWidth = keyof typeof CONTROL_W;

/* ========================================================================== */
/* InfoHint — the prose budget                                                */
/* ========================================================================== */

/**
 * The `(i)`.
 *
 * This replaces every explanatory paragraph the last pass parked under a
 * section header. The rule it satisfies is CLAUDE.md's: a settings surface does
 * not lecture, but a value that resolves through layers genuinely is not
 * self-describing, and the honest resolution is to make the explanation
 * *available* rather than *unavoidable*.
 *
 * Opens on hover AND on focus AND on click, because a hover-only affordance is
 * unreachable by keyboard and invisible on a touchscreen. It is a real
 * `<button>` inside a `Popover` rather than a `Tooltip` so that a hint which
 * needs a link in it can have one.
 *
 * TWO THINGS THE FIRST DRAFT GOT WRONG, both caught by driving it:
 *
 *  1. It opened `side="bottom"` from a section header, which put the
 *     explanation directly on top of the rows it was explaining. A hint that
 *     covers its own subject is worse than no hint. It opens `top` now, and
 *     Radix flips it only when there is genuinely no room.
 *  2. Its panel swallowed the next click. A reader who opens a hint and then
 *     reaches for the control underneath had that first click eaten by the
 *     panel — which is exactly the click the hint just persuaded them to make.
 *     So the panel is `pointer-events-none` by default and behaves like a
 *     tooltip; `interactive` opts a hint back into being clickable, and only a
 *     hint with a link or a copyable value should ask for it.
 */
export function InfoHint({
  label,
  interactive = false,
  children,
  className,
}: {
  /** What this explains. Becomes the button's accessible name. */
  label: string;
  /** The panel holds something you can click. Costs you the click-through. */
  interactive?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const closeTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const cancelClose = () => {
    if (closeTimer.current !== undefined) clearTimeout(closeTimer.current);
  };
  // A small grace period, so travelling the gap between the button and the
  // panel does not dismiss the thing you are travelling towards.
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(false), 120);
  };

  React.useEffect(() => cancelClose, []);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={`About ${label}`}
        className={cn(
          "inline-flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/45 focus-visible:outline-none",
          className,
        )}
        onMouseEnter={() => {
          cancelClose();
          setOpen(true);
        }}
        onMouseLeave={scheduleClose}
        onFocus={() => setOpen(true)}
        onBlur={scheduleClose}
      >
        <InfoIcon className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        collisionPadding={12}
        className={cn(
          "w-auto max-w-64 p-2 text-ui text-muted-foreground",
          !interactive && "pointer-events-none",
        )}
        // An interactive panel must let focus in, or its link is unreachable by
        // keyboard: Tab from the trigger would skip straight past the panel.
        onOpenAutoFocus={interactive ? undefined : (event) => event.preventDefault()}
        onMouseEnter={interactive ? cancelClose : undefined}
        onMouseLeave={interactive ? scheduleClose : undefined}
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}

/* ========================================================================== */
/* Rule 1 — the shell                                                         */
/* ========================================================================== */

export interface PrefCategory {
  key: string;
  label: string;
  icon: PhosphorIcon;
  /** Extra search terms. Hand-maintained; see the doc's "still open". */
  keywords?: readonly string[];
  /** A count. `Badge variant="count"` — bare mono, deliberately not a pill. */
  count?: number;
  /** Something is wrong or waiting here. Drawn as a dot, said in the name. */
  attention?: { state: StatusDotState; label: string };
  content: React.ReactNode;
}

export interface PrefGroup {
  key: string;
  label: string;
  categories: readonly PrefCategory[];
}

export function PrefShell({
  surfaceLabel,
  groups,
  header,
  activeKey,
  onSelect,
}: {
  surfaceLabel: string;
  groups: readonly PrefGroup[];
  /** What sits above the search field — the project identity, on Configure. */
  header?: React.ReactNode;
  /**
   * Controlled, because the surface switch outside this component has to keep
   * a per-surface selection alive across a toggle.
   */
  activeKey: string;
  onSelect: (key: string) => void;
}) {
  const all = React.useMemo(() => groups.flatMap((group) => group.categories), [groups]);
  const active = activeKey;
  const setActive = onSelect;
  const [query, setQuery] = React.useState("");
  const scroller = React.useRef<HTMLDivElement>(null);

  const matches = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return null;
    return new Set(
      all
        .filter((category) =>
          [category.label, ...(category.keywords ?? [])].some((term) =>
            term.toLowerCase().includes(needle),
          ),
        )
        .map((category) => category.key),
    );
  }, [all, query]);

  const visible = groups
    .map((group) => ({
      ...group,
      categories: group.categories.filter((c) => matches === null || matches.has(c.key)),
    }))
    .filter((group) => group.categories.length > 0);

  // Rule: a pane switch starts at the top. The scroll container is explicit
  // rather than inferred, because `scrollIntoView` on a mounting child fights
  // the layout it is mounting into.
  React.useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [active]);

  const current = all.find((category) => category.key === active);

  return (
    // `w-full flex-1` is not decoration. Without it this root is a shrink-to-fit
    // flex item, and the entire surface collapses to the width of its widest
    // line — 670px in a 1400px window, jammed against the left edge, with every
    // table column starved. Which is exactly what it did.
    <div className="flex h-full min-h-0 w-full flex-1">
      <nav
        aria-label={`${surfaceLabel} categories`}
        className="flex w-52 shrink-0 flex-col gap-4 overflow-y-auto border-r border-border p-4"
      >
        {header}
        <InputGroup className="mx-1">
          <InputGroupAddon>
            <MagnifyingGlassIcon />
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            value={query}
            aria-label={`Search ${surfaceLabel.toLowerCase()}`}
            placeholder="Search"
            onChange={(event) => setQuery(event.target.value)}
          />
        </InputGroup>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {visible.map((group) => (
            <div key={group.key} className="pb-4">
              <SectionHeading as="p" className="px-2 pb-1">
                {group.label}
              </SectionHeading>
              {group.categories.map((category) => (
                <button
                  key={category.key}
                  type="button"
                  aria-current={category.key === active ? "page" : undefined}
                  onClick={() => setActive(category.key)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-ui transition-colors focus-visible:ring-2 focus-visible:ring-ring/45 focus-visible:outline-none",
                    category.key === active
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                  )}
                >
                  <category.icon className="size-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{category.label}</span>
                  {category.count === undefined ? null : (
                    <Badge variant="count">{category.count}</Badge>
                  )}
                  {category.attention ? (
                    <>
                      <StatusDot state={category.attention.state} />
                      {/* The dot is `aria-hidden` by construction, so the state
                          is said here instead of being dropped. */}
                      <span className="sr-only">{category.attention.label}</span>
                    </>
                  ) : null}
                </button>
              ))}
            </div>
          ))}
          {visible.length === 0 ? (
            <p className="px-2 py-6 text-center text-ui text-muted-foreground">Nothing matches.</p>
          ) : null}
          <p aria-live="polite" className="sr-only">
            {matches === null ? "" : `${matches.size} categories match`}
          </p>
        </div>
      </nav>

      <div ref={scroller} className="min-w-0 flex-1 overflow-y-auto">
        {/* Tier A, the same call the live settings shell makes: a pane is a
            reading surface, so it takes the canonical measure and the page
            gutter rather than a width of its own. */}
        <ContentColumn className="pb-4">
          <PageHeader variant="reading" title={current?.label ?? ""} />
          <div className="flex flex-col gap-6">{current?.content}</div>
        </ContentColumn>
      </div>
    </div>
  );
}

/* ========================================================================== */
/* Rule 3 — sections                                                          */
/* ========================================================================== */

/**
 * A section. Icon, title, at most one action.
 *
 * There is **no `description` prop**, and that is load-bearing: CLAUDE.md
 * forbids explanatory text under a section header, and an earlier pass added
 * thirteen of them. A rule you cannot express is a rule you cannot break — what
 * a section needs to say now goes in an `InfoHint` beside its title, which the
 * reader opens or ignores.
 */
export function PrefSection({
  title,
  icon: Icon,
  hint,
  action,
  children,
}: {
  title: string;
  icon?: PhosphorIcon;
  /** The `(i)`. A node, not a string, so it can carry a link. */
  hint?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  // One fill, no border, no internal rules. This is `SettingsSection`'s own
  // chrome, and departing from it was what turned the surface into a stack of
  // boxes inside boxes: a bordered card, holding a bordered table, holding a
  // bordered search field.
  return (
    <section className="rounded-lg bg-card px-4 py-4">
      {/* The rule under the header is DELIBERATE and drawn here.
          It used to appear by accident: `PrefRow`'s `first:border-t-0` never
          matched, because this header — not the first row — is the section's
          first child. Same pixels, but now the code says so, and the rows own
          only the rules between themselves. */}
      <div className="mb-2 flex items-start justify-between gap-4 border-b border-border/50 pb-2">
        <div className="flex min-w-0 items-center gap-2">
          {Icon ? <Icon className="size-4 shrink-0 text-muted-foreground" /> : null}
          <h2 className="min-w-0 truncate text-sm font-semibold">{title}</h2>
          {hint ? <InfoHint label={title}>{hint}</InfoHint> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/** A section action with a word on it. */
export function SectionAction({
  label,
  icon: Icon,
  onAct,
}: {
  label: string;
  icon?: PhosphorIcon;
  onAct?: () => void;
}) {
  return (
    <Button size="xs" variant="ghost" onClick={onAct}>
      {Icon ? <Icon /> : null}
      {label}
    </Button>
  );
}

/** A section action that is only a glyph. Its name lives in `aria-label`. */
export function SectionIconAction({
  label,
  icon: Icon = ArrowClockwiseIcon,
  onAct,
}: {
  label: string;
  icon?: PhosphorIcon;
  onAct?: () => void;
}) {
  return (
    <Button size="icon-xs" variant="ghost" aria-label={label} onClick={onAct}>
      <Icon />
    </Button>
  );
}

/* ========================================================================== */
/* Rule 4 — a setting is a row                                                */
/* ========================================================================== */

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
   * takes an irreversible action and CLAUDE.md's own carve-out applies. Two
   * uses in the whole prototype, both about automatic deletion.
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
        "relative flex justify-between gap-6 border-t border-border/50 py-4 first:border-t-0 first:pt-0 last:pb-0",
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
 * Now a thin arrangement over `ui/list-row.tsx` rather than a sixth hand-rolled
 * row. That file owns the branch this one kept getting wrong: actions must be a
 * *sibling* of the activation target (a button inside a button is not markup),
 * and a row that activates nothing must not draw a hover fill.
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

/* ========================================================================== */
/* Rule 2 — divergence, marked once                                           */
/* ========================================================================== */

/**
 * The one inheritance idiom, and it costs **zero pills**.
 *
 * The last pass put a `Segmented` "Inherit | Custom" pair on every scopeable
 * row — two pills and a value per row, a whole extra control language for a
 * fact. This is the affordance macOS and VS Code both settled on instead:
 *
 *   - Inheriting? The control simply shows the inherited value. Touching it
 *     overrides — no mode to enter first, which was always the redundant step,
 *     since choosing a value *is* the act of overriding.
 *   - Overridden? A revert button appears. That is the WHOLE signal.
 *
 * There used to be a second one: a 2px accent bar in `PrefRow`'s gutter. It
 * lasted exactly as long as it took someone to point at it and ask what it
 * was — which is the answer, because a 2px tick means "overridden" only to
 * whoever wrote it. It was also redundant. The revert button appears on
 * precisely the same rows, sits in the same scannable right-hand column, and
 * unlike a coloured mark it says what it is ("Reset Model to the app-wide
 * value, claude-opus-4.6") and does something about it.
 *
 * So the row is quiet until it has something to say, and the only thing that
 * says it is a control that is legible and actionable.
 */
export function OverrideControl({
  label,
  inheritedValue,
  overridden,
  onRevert,
  children,
}: {
  /** Names the revert button: "Use the app-wide Harness". */
  label: string;
  /** What Settings says. Shown in the revert button's tooltip-free label. */
  inheritedValue: string;
  overridden: boolean;
  onRevert: () => void;
  children: React.ReactNode;
}) {
  return (
    <>
      {children}
      {overridden ? (
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`Reset ${label} to the app-wide value, ${inheritedValue}`}
          onClick={onRevert}
        >
          <ArrowCounterClockwiseIcon />
        </Button>
      ) : (
        // Holds the column so the control does not shift left when a row
        // reverts. Same trick the model catalogue uses for un-reservable rows.
        <span aria-hidden className="size-5" />
      )}
    </>
  );
}

/**
 * The Settings-side counterpart: which projects have diverged.
 *
 * Takes the projects, not a count, so it can name them and link to each. A
 * hand-maintained "3 projects override this" is a number that goes stale and
 * cannot be clicked.
 */
export function OverrideNote({
  projects,
  onOpen,
}: {
  projects: readonly string[];
  onOpen: (project: string) => void;
}) {
  if (projects.length === 0) return null;
  return (
    <p className="flex flex-wrap items-center gap-1 text-ui text-muted-foreground">
      <span>Overridden in</span>
      {projects.map((project, index) => (
        <React.Fragment key={project}>
          <Button
            size="xs"
            variant="ghost"
            className="h-auto px-1 py-0 underline underline-offset-2"
            onClick={() => onOpen(project)}
          >
            {project}
          </Button>
          {index < projects.length - 1 ? <span>·</span> : null}
        </React.Fragment>
      ))}
    </p>
  );
}

/* ========================================================================== */
/* Rule 6 — status, three roles                                               */
/* ========================================================================== */

/**
 * Is this thing working?
 *
 * Delegates its colour to `ui/status-dot.tsx`, which is the app's single map
 * from state to hue. The previous pass had its own three-tone map — precisely
 * the drift StatusDot's header describes itself as existing to end, written
 * again one folder away.
 */
export function Health({ state, children }: { state: StatusDotState; children: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-ui text-muted-foreground">
      <StatusDot state={state} />
      {children}
    </span>
  );
}

/**
 * Who set this value — Volli, or the tool it reads from.
 *
 * Distinct from provenance-as-scope (project vs personal), which is a table
 * column now. One component, one meaning.
 */
export function Provenance({ mine, children }: { mine?: boolean; children: string }) {
  return (
    <span className={cn("text-ui", mine ? "text-primary-text" : "text-muted-foreground")}>
      {children}
    </span>
  );
}

/* ========================================================================== */
/* Rule 7 — collections declare their states                                  */
/* ========================================================================== */

export type AsyncState<T> =
  | { status: "loading" }
  | { status: "error"; message: string; onRetry: () => void }
  | { status: "ready"; data: T };

/** The skeleton a first read draws. Uses the repo's primitive. */
function LoadingRows({ rows = 3 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-2 py-4" aria-live="polite" aria-busy>
      <span className="sr-only">Loading…</span>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-8 w-full rounded-lg" />
      ))}
    </div>
  );
}

function ErrorRow({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex items-center gap-2 py-4 text-ui">
      <WarningIcon className="size-4 shrink-0 text-destructive" />
      <span className="min-w-0 flex-1 text-muted-foreground">{message}</span>
      <Button size="xs" variant="outline" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

export function Empty({ children }: { children: string }) {
  return <p className="py-6 text-center text-ui text-muted-foreground">{children}</p>;
}

/**
 * A section whose body is fetched.
 *
 * The vocabulary the first two passes were missing entirely: they drew only the
 * happy path, which is the 20% of a settings surface that is easy.
 */
export function AsyncSection<T>({
  title,
  icon,
  hint,
  action,
  state,
  isEmpty,
  empty,
  children,
}: {
  title: string;
  icon?: PhosphorIcon;
  hint?: React.ReactNode;
  action?: React.ReactNode;
  state: AsyncState<T>;
  isEmpty?: (data: T) => boolean;
  empty?: string;
  children: (data: T) => React.ReactNode;
}) {
  return (
    <PrefSection title={title} icon={icon} hint={hint} action={action}>
      {state.status === "loading" ? <LoadingRows /> : null}
      {state.status === "error" ? (
        <ErrorRow message={state.message} onRetry={state.onRetry} />
      ) : null}
      {state.status === "ready" ? (
        isEmpty?.(state.data) ? (
          <Empty>{empty ?? "Nothing here yet."}</Empty>
        ) : (
          children(state.data)
        )
      ) : null}
    </PrefSection>
  );
}

/* ========================================================================== */
/* DataTable — the one object the app didn't have                             */
/* ========================================================================== */

export interface Column<T> {
  key: string;
  header: string;
  /**
   * A CSS length or percentage — `8rem`, `40%`. **Not** a grid track.
   *
   * This said `minmax(0,1fr)` and three columns passed it. React drops it as
   * an invalid width, so the attribute reached the DOM empty and the column
   * sized by `table-layout: fixed`'s remainder rule instead. It LOOKED right,
   * which is the worst way for an API to be wrong.
   *
   * Omit to take the remaining space — that is the same behaviour, now
   * spelled. Two omitted columns split the remainder evenly; use percentages
   * when you want a ratio.
   */
  width?: string;
  align?: "start" | "end";
  /** Header text is hidden but still read. For an actions or toggle column. */
  headerHidden?: boolean;
  cell: (item: T) => React.ReactNode;
}

export interface TableFilter {
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
}

/**
 * A bounded, scrollable, sticky-headed table.
 *
 * WHY THIS EXISTS. Models, Skills, Commands, MCP servers and Plugins are all
 * *homogeneous collections with shared attributes* — and every one of them was
 * being drawn as an unbounded stack of two-line rows. Two things went wrong.
 * The page grew without limit, so a catalogue of a hundred models buried every
 * section under it and the rail's other categories became unreachable without a
 * long scroll. And the shared attributes had nowhere to live but the row, which
 * is what forced provenance into a repeated pill on every single line.
 *
 * A table fixes both at once: `rows` caps the height so the *page* stays
 * navigable while the *collection* scrolls inside its own box, and a column
 * turns a repeated pill into a quiet aligned word.
 *
 * NOT VIRTUALIZED, on purpose — but the headroom is smaller than I first
 * claimed. `MAX_SKILLS_PER_DIR` is 200 PER DIRECTORY (`main/skills.ts:47`) and
 * a project merges two of them, so 400 is reachable today, not the "couple of
 * hundred" this comment used to assert.
 *
 * `rows` caps what you SEE, not what renders: every row is in the DOM so the
 * scrollbar can be honest about the height. So `maxItems` caps what renders,
 * with a footer that says what it withheld. Search runs BEFORE the cap, so a
 * withheld row is always still reachable by typing its name — which is what
 * makes truncation safe rather than lossy.
 *
 * Past ~1,000 the answer is Virtuoso, not a bigger cap and not pagination.
 *
 * A REAL `<table>`, because this is tabular data and the semantics are free:
 * column headers announce with their cells, and `scope="col"` costs nothing.
 * The sticky header is `position: sticky` on the `<th>`s, which works inside an
 * `overflow-auto` ancestor without JS.
 */
export function DataTable<T>({
  items,
  keyOf,
  columns,
  search,
  placeholder = "Search",
  filter,
  rows = 8,
  maxItems = 500,
  empty,
  noResults = "Nothing matches.",
  label,
}: {
  items: readonly T[];
  keyOf: (item: T) => string;
  columns: readonly Column<T>[];
  /** The haystack. Omit for a table that isn't searchable. */
  search?: (item: T) => string;
  placeholder?: string;
  filter?: TableFilter;
  /** How many rows before it scrolls. */
  rows?: number;
  /** How many rows may render at once. The rest are withheld, and said so. */
  maxItems?: number;
  empty: string;
  noResults?: string;
  /** The table's accessible name. */
  label: string;
}) {
  const [query, setQuery] = React.useState("");

  const matched = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle || !search) return items;
    return items.filter((item) => search(item).toLowerCase().includes(needle));
  }, [items, query, search]);

  // Cap AFTER filtering, so narrowing the search always reaches a withheld row.
  const shown = matched.length > maxItems ? matched.slice(0, maxItems) : matched;
  const withheld = matched.length - shown.length;

  // 32px a row, PLUS the 28px sticky header, which lives inside the same scroll
  // box and would otherwise eat a row: `rows={8}` was showing seven.
  const maxBodyHeight = rows * 36 + 32;

  if (items.length === 0) return <Empty>{empty}</Empty>;

  return (
    <div className="flex flex-col gap-2">
      {search || filter ? (
        <div className="flex items-center gap-2">
          {search ? (
            <InputGroup className="min-w-0 flex-1">
              <InputGroupAddon>
                <MagnifyingGlassIcon />
              </InputGroupAddon>
              <InputGroupInput
                type="search"
                value={query}
                aria-label={placeholder}
                placeholder={placeholder}
                onChange={(event) => setQuery(event.target.value)}
              />
            </InputGroup>
          ) : (
            <div className="flex-1" />
          )}
          {/* ONE control replaces N pills. The provenance a reader wanted to
              scan for is now something they can filter to. */}
          {filter ? (
            <Select value={filter.value} onValueChange={filter.onChange}>
              <SelectTrigger size="sm" className={CONTROL_W.md} aria-label={filter.label}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {filter.options.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
        </div>
      ) : null}

      {/* NO FRAME. The section already is one; a bordered box in here was the
          second of three nested rounded rectangles, and the reason the surface
          read as boxes all the way down. The header hairline and the row
          hairlines are the whole structure a table needs. */}
      <div className="overflow-y-auto" style={{ maxHeight: maxBodyHeight }}>
        <table className="w-full border-collapse" style={{ tableLayout: "fixed" }}>
          <caption className="sr-only">{label}</caption>
          <colgroup>
            {columns.map((column) => (
              <col key={column.key} style={{ width: column.width }} />
            ))}
          </colgroup>
          <thead className="sticky top-0 z-10 bg-card">
            <tr>
              {columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  className={cn(
                    // `text-ui` in the mute, sentence case. The 11px uppercase
                    // eyebrow belongs to a section, not to a column, and using
                    // it here made eight rows of data look like a spreadsheet
                    // embedded in a settings page.
                    "h-8 border-b border-border/50 px-2 text-ui font-normal text-muted-foreground",
                    column.align === "end" ? "text-right" : "text-left",
                  )}
                >
                  <span className={column.headerHidden ? "sr-only" : undefined}>
                    {column.header}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((item) => (
              <tr
                key={keyOf(item)}
                className="border-t border-border/50 first:border-t-0 hover:bg-accent/40"
              >
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={cn(
                      "h-9 px-2 text-sm",
                      column.align === "end" ? "text-right" : "text-left",
                    )}
                  >
                    <div
                      className={cn(
                        "flex min-w-0 items-center gap-2",
                        column.align === "end" && "justify-end",
                      )}
                    >
                      {column.cell(item)}
                    </div>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length === 0 ? <Empty>{noResults}</Empty> : null}
      </div>
      {withheld > 0 ? (
        <p className="text-ui text-muted-foreground">
          Showing {shown.length} of {matched.length}. Search to narrow.
        </p>
      ) : null}
      <p aria-live="polite" className="sr-only">
        {query.trim() ? `${shown.length} of ${matched.length} shown` : ""}
      </p>
    </div>
  );
}

/**
 * A quiet, aligned word. What a repeated pill becomes inside a table.
 *
 * A string cell carries its own `title`, because a column narrow enough to be
 * scannable is narrow enough to truncate, and a truncated value the reader
 * cannot recover is worse than a wrapped one. This is the content itself on
 * hover — not a tutorial tooltip, which is what CLAUDE.md forbids.
 */
export function Cell({ children, muted }: { children: React.ReactNode; muted?: boolean }) {
  return (
    <span
      title={typeof children === "string" ? children : undefined}
      className={cn("min-w-0 truncate", muted && "text-muted-foreground")}
    >
      {children}
    </span>
  );
}

/* ========================================================================== */
/* Rule 5 — one save model, and it can refuse                                 */
/* ========================================================================== */

export type CommitResult = { ok: true; value?: string } | { ok: false; error: string };

/**
 * A text field that saves on blur, and can be told no.
 *
 * Everything on these surfaces saves on change; the exception is text, which
 * has no natural commit point until focus leaves. That made the first version
 * dangerous: it sent whatever string was in the box, so select-all-type-`1`
 * -click-away silently armed a one-day automatic folder deletion.
 *
 * So a commit is a *transaction*: validate locally, ask for confirmation where
 * the consequence is destructive, let the write refuse, show a refusal beside
 * the field it belongs to, and adopt whatever the write normalized the value
 * to. `Escape` abandons.
 */
export function CommitField({
  id,
  value,
  type = "text",
  width = "md",
  placeholder,
  disabled,
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
  /** Cheap local check. Return a message to refuse. */
  validate?: (next: string) => string | null;
  /** Last gate before a destructive write. Return false to abandon. */
  confirm?: (next: string) => boolean;
  onCommit: (next: string) => CommitResult | Promise<CommitResult>;
}) {
  // A refusal has to be announceable, so the association can never depend on
  // the caller having passed an id. It didn't: `aria-describedby` was gated on
  // `id`, so an id-less field showed its error and told a screen reader nothing.
  const autoId = React.useId();
  const fieldId = id ?? autoId;
  const errorId = `${fieldId}-error`;

  const [draft, setDraft] = React.useState(value);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const dirty = React.useRef(false);

  // Adopt an external change ONLY when the user is not mid-edit. The earlier
  // version had a bare dependency on `value`, so a background refresh wiped
  // whatever was half-typed.
  React.useEffect(() => {
    if (!dirty.current) setDraft(value);
  }, [value]);

  const commit = async () => {
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
    setTimeout(() => setSaved(false), 1600);
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

/* ========================================================================== */
/* About — a headline, and the faults actually present                        */
/* ========================================================================== */

export interface Fault {
  id: string;
  headline: string;
  detail: string;
  remedy?: { label: string; onAct: () => void };
}

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
  children?: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const detailsId = React.useId();

  return (
    <section className="rounded-lg bg-card px-4 py-4">
      <header className="flex items-center gap-2 py-1">
        <StatusDot state={healthy ? "ready" : "waiting"} size="md" />
        <h2 className="min-w-0 flex-1 text-ui font-medium">{headline}</h2>
        {actions}
      </header>

      {faults.length > 0 ? (
        <div className="mt-2 flex flex-col">
          {faults.map((fault) => (
            <div key={fault.id} className="flex items-start gap-4 border-t border-border/50 py-2">
              <div className="min-w-0 flex-1">
                <p className="text-ui">{fault.headline}</p>
                <p className="text-ui text-muted-foreground">{fault.detail}</p>
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
        <div className="mt-2 border-t border-border/50">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={detailsId}
            onClick={() => setOpen((current) => !current)}
            className="flex w-full items-center gap-1 py-2 text-ui text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/45 focus-visible:outline-none"
          >
            <CaretDownIcon className={cn("size-3.5 transition-transform", open && "rotate-180")} />
            {open ? "Hide details" : "Details"}
          </button>
          <div id={detailsId} hidden={!open} className="pb-2">
            {children}
          </div>
        </div>
      ) : null}
    </section>
  );
}

export function DetailLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-t border-border/50 py-2 first:border-t-0">
      <span className="text-ui text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-ui">{value}</span>
    </div>
  );
}
