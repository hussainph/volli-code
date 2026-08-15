# Design language — spacing, width, typography

This is a living description of the app-wide spatial and type language. Motion tokens live in
`globals.css`; **color tokens are generated** from a theme seed by `@volli/shared`, and
`globals.css` carries the generated default as its first-paint fallback — so nothing here should
ever hard-code a color. The code and generated tokens are authoritative when this document drifts.

**The principle:** cohesion is structural, not disciplinary. Surfaces compose shared tokens and
primitives instead of hand-rolling containers and px values — a new surface is consistent by
default. Whitespace is deliberate: content draws the eye by sitting on a bounded measure, not by
filling every pixel (the Linear lesson — maximal width reads as noise, not as density).

## The two-tier surface model

Every surface declares which tier it is; the tiers may not be mixed ad hoc.

- **Tier A — reading surfaces.** Prose-like content someone reads or writes: the Ticket Body tab
  (title, description, activity, composer), Settings when it's built, empty states. These center on
  the canonical measure via `<ContentColumn>`; surrounding whitespace is the point.
- **Tier B — workbench surfaces.** Content that genuinely earns width: the kanban board, list
  view, artifacts viewer, terminals. These stay fluid edge-to-edge but align their horizontal edges
  to the page gutter so all surfaces share the same left/right rhythm.

## Layout tokens (`globals.css` `@theme`)

| Token | Value | Utility | Meaning |
|---|---|---|---|
| `--container-content` | `45rem` (720px) | `max-w-content` | The canonical reading measure. Chosen over Linear's ~660px for code-heavy ticket markdown. |
| `--spacing-gutter` | `1.5rem` (24px) | `px-gutter` etc. | The unified page-edge padding every surface aligns to. |

## Spacing — five steps

One ladder for every inset, gap and stack in the app, page rhythm included:

| Step | px | Role |
|---|---|---|
| `0` | 0 | flush |
| `1` | 4 | icon↔label gaps, hairline insets, tight stacks |
| `2` | 8 | **the default** inset and the default gap |
| `4` | 16 | component padding, row rhythm |
| `6` | 24 | the gutter (`--spacing-gutter`) |

Above the ladder there is **page rhythm only** — `pt-5` (20px) on dense workbench tops (chat
plane, ticket detail), `pt-8` (32px) on roomy reading surfaces, `pb-16` (64px) — and below it
`px` (1px), which is hairline alignment (`-mb-px` covering a border), not spacing. Nothing else:
the half-steps (`0.5` `1.5` `2.5` `3.5`) and the orphans (`3` `7` `10`)
are gone, and a new one is a change argued here rather than a value picked in a component.

**Five recorded exceptions**, each because the ladder's 8px gaps cannot express something finer
that is measured rather than chosen. They are commented at their site; do not re-collapse them
without looking at the surface:

| Site | Value | Why |
|---|---|---|
| `ui/button.tsx` size variants | `px-2.5` · `px-3` · `px-3.5` | A control's inset is a function of its own height, and this is a four-rung height ladder (20/24/28/32) with only two rungs in range |
| `rail-panel-parts.tsx` `RAIL_PANEL_INSET` | `px-3` at narrow | The narrow step must be *smaller* than 16 and still an inset; 8 halves the edge. Collapsed, the variant became a silent no-op |
| `sidebar/session-band-row.tsx` | `mt-1.5` · `gap-0.5` | Optical alignment to the title's cap height, and the 2px that binds a title to its meta line |
| `board/ticket-card.tsx` | `px-3` | A dense card trades air for content: at `px-4` real titles truncate a word earlier |
| `ticket-changes-panel.tsx` change rows | `py-1.5` | Two `text-ui` line boxes + 12 keeps the measured 52px two-line row; `py-2` grows every row of a dense list to 56 and orphans the `min-h-13` floor |

**Responsiveness is the whitespace, not breakpoints:** `<ContentColumn>` is
`mx-auto w-full max-w-content px-gutter` — on wide windows the side margins grow; as the window
narrows they compress to the 24px gutter floor before text ever reflows.

## Layout primitives (`components/layout/`)

- **`<ContentColumn>`** — the Tier A measure column. Tier B surfaces must not wrap in it.
- **`<PageHeader>`** — the page-level header row (board header today): gutter-aligned,
  `py-4`, wrap-friendly. New surface headers compose it rather than re-deriving the row.

## The framed content surface

The main content area is a **floating card**: `rounded-xl`, hairline `border-border`, `m-2`
(8px) on the rail-dark backdrop (`--rail`), applied once on `SidebarInset` in `app-shell.tsx`.
Every page — the always-mounted sessions layer included — renders inside it, so the workspace
reads as an object with edges instead of an edge-to-edge slab. This amends the earlier flat
chrome-band treatment (decision #31); the chrome bar and workspace rail still form the dark "L",
which is now the backdrop the card floats on.

## Composer stack

The Session composer and anything parked on it (ask-user questions; later, plans and subagent
activity) share one shell: `rounded-container`, hairline `border-border`, `bg-card`,
`shadow-raised` (`COMPOSER_STACK_SHELL` in `chat/composer-stack.ts`). Overlays stack **above** the
composer and never replace it — the input stays so a follow-up can be typed while a question or a
run is live.

## Elevation — three tiers

One shadow per role, generated from the canvas so the halo is tinted to the window rather than
neutral black. Stock `shadow-xs`…`shadow-2xl` are banned by
`apps/desktop/scripts/check-design-tokens.mjs`; `shadow-none` stays legal as a reset.

| Utility | Role |
| --- | --- |
| `shadow-raised` | On a surface: controls, fields, chips, the active tab in a strip, a board card in its column |
| `shadow-card` | A pane or a sheet of paper: the floating/inset sidebar, a tile dragged off the board |
| `shadow-overlay` | Portals to the body and floats over the whole window: menus, select, popover, hover card, dialogs, sheet, tooltip, the ⌘K palette |

## Alpha — four steps, and a token for the scrim

A translucent token inherits the temperature of whatever is under it, which is why the app leans on
`bg-x/N` so heavily. What it does not need is twenty weights: `/45` beside `/50` beside `/55` is
not a decision anyone can defend or repeat.

| Step | Role |
|---|---|
| `/10` | a wash — the faintest fill that still reads as a surface (materials over the canvas, tinted row backgrounds) |
| `/30` | a quiet edge, a disabled state, a resting hairline fill |
| `/50` | half-present — hover fills on quiet surfaces, dimmed panes |
| `/70` | strongly present but still transparent — secondary hovers, muted ink |
| `/90` | the one rung above: a fill declaring itself *slightly* translucent (`hover:bg-primary/90`). Not a wash, and not on the wash ladder |

Two things are deliberately not on this ladder. The focus ring is `ring-ring/45` — one recipe,
spelled in `ui/button.tsx` and recorded in `ui/field-classes.ts`. And the overlay wash is
**`--scrim`**, a generated token rather than a modifier: it is the shadow tiers' own ink (the
canvas's hue at the mode's shadow lightness) at 30% in light and 50% in dark, so a dialog dims the
window in the window's own color instead of the `bg-black/N` that turned a warm gradient to dirt.
Use `bg-scrim`; never hand-roll an overlay wash.

## Type scale — five steps

Named font-size tokens carry their paired line-height (and tracking where the size demands it),
so components never pick these per-surface. The body step rides on Tailwind's stock utility rather
than duplicating it under a second name:

| Step | Utility | Size / leading | Tracking | Use |
|---|---|---|---|---|
| label | `text-label` | 11px / 16px | +0.05em | UPPERCASE section labels, badges, field labels, monogram chips |
| ui | `text-ui` | 13px / 20px | 0 | **the single UI size**: board cards/columns, list rows, timestamps, counts, event lines, hints, buttons, menus |
| body | `text-sm` | 14px / 20px | 0 | prose, inputs, comments |
| heading | `text-heading` | 18px / 26px | −0.01em | dialog titles, page/section headers |
| title | `text-title` | 24px / 30px | −0.02em | the ticket title; the largest text in the app |

Rules:
- **No arbitrary sizes.** `text-[13px]`-style literals are banned; if a real need falls between
  steps, the scale changes here first.
- **No `text-xs` and no `text-base`.** Both are stock Tailwind sizes off this scale, and both are
  banned by `apps/desktop/scripts/check-design-tokens.mjs`. 12px was a rung between `text-label`
  and `text-ui` that carried timestamps and counts; it is folded into `text-ui`. If something must
  read smaller than 13px, `text-label` is the only rung below — and it is a *treatment* (caps,
  wide tracking), so a site that needs neither is a scale change argued here, not a new value.
- `text-label` bakes in its wide tracking — don't stack `tracking-wide` on it. Uppercase is still
  applied per-use (`uppercase`), since label-size text isn't always caps.
- Markdown prose (ticket bodies, comments) is typeset by `typeset.css`, whose sizes are **derived
  from this table** rather than from `em` multiples — a rendered `<h2>` in a ticket is
  `--text-heading` exactly, because a dialog title beside it is. Same for Document Mode
  (`editor/document-mode.css`), the editable twin of that surface.

## Controls — the pill scale

Buttons and control chips are pills (`rounded-full`, baked into `ui/button.tsx`); the filter/metadata
chip (`h-7` pill, `text-ui`, `border-border`) set the idiom and the button primitive follows it.
Heights come from the primitive's size variants — don't restate them per-use:

| Size | Height | Text | Use |
|---|---|---|---|
| `xs` / `icon-xs` | 20px | `text-ui` | inline row actions, hover affordances |
| `sm` / `icon-sm` | 24px | `text-ui` | dialog/footer actions (Create, Comment), toolbar buttons |
| `default` / `icon` | 28px | `text-ui` | standalone actions, chrome-band icons; matches the chip height |
| `lg` / `icon-lg` | 32px | `text-sm` | rare hero actions (empty states) |

`default` is the chip height on purpose: a default Button next to a filter chip reads as one family.
Nothing in the app should render a taller control than `lg`.

## Vertical rhythm (reading surfaces)

The Ticket Body tab is the reference implementation: generous air above the title (`pt-8` below the
tab strip), 24px title→body, `gap-8` (32px) between the body and the Activity section, Activity
separated by `border-t` + `pt-6`, and a deep `pb-16` tail so the last content never kisses the card
edge. Micro-spacing inside components rides the same five steps as everything else — the language
governs every 4px, because sixteen distinct steps is what governing only the page produced.

## Alignment details worth keeping

- The body editor bleeds its hover block into the gutter (`-mx-4` + `px-4`) so body **text**
  left-aligns exactly with the title on the column edge (Notion-style). Boxed elements (comment
  cards, the composer) align their **borders** to the column edge instead.
- Terminals, file editors, and diffs are Tier B planes inside the ticket surface: full-bleed to
  the card edge (terminals) or gutter-aligned where the workbench benefits from it.
