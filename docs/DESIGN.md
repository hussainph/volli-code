# Design language — spacing, width, typography

The app-wide layout and type system, settled in a design review (July 2026, decision #31 in
CONCEPT.md). Colors and motion tokens predate this doc and live in `globals.css` (see CLAUDE.md);
this doc covers the **spatial** language: how surfaces use width, where whitespace goes, and which
type step each kind of text sits on. `docs/BOARD-UI.md` is the board's feature-level spec; where it
states raw values, the tokens here are authoritative.

**The principle:** cohesion is structural, not disciplinary. Surfaces compose shared tokens and
primitives instead of hand-rolling containers and px values — a new surface is consistent by
default. Whitespace is deliberate: content draws the eye by sitting on a bounded measure, not by
filling every pixel (the Linear lesson — maximal width reads as noise, not as density).

## The two-tier surface model

Every surface declares which tier it is; the tiers may not be mixed ad hoc.

- **Tier A — reading surfaces.** Prose-like content someone reads or writes: the ticket Doc tab
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

**Responsiveness is the whitespace, not breakpoints:** `<ContentColumn>` is
`mx-auto w-full max-w-content px-gutter` — on wide windows the side margins grow; as the window
narrows they compress to the 24px gutter floor before text ever reflows.

## Layout primitives (`components/layout/`)

- **`<ContentColumn>`** — the Tier A measure column. Tier B surfaces must not wrap in it.
- **`<PageHeader>`** — the page-level header row (board header today): gutter-aligned,
  `py-3`, wrap-friendly. New surface headers compose it rather than re-deriving the row.

## The framed content surface

The main content area is a **floating card**: `rounded-xl`, hairline `border-border`, `m-2`
(8px) on the rail-dark backdrop (`--rail`), applied once on `SidebarInset` in `app-shell.tsx`.
Every page — the always-mounted sessions layer included — renders inside it, so the workspace
reads as an object with edges instead of an edge-to-edge slab. This amends the earlier flat
chrome-band treatment (decision #31); the chrome bar and workspace rail still form the dark "L",
which is now the backdrop the card floats on.

## Type scale — six steps

Named font-size tokens carry their paired line-height (and tracking where the size demands it),
so components never pick these per-surface. Two steps ride on Tailwind's stock utilities rather
than duplicating them under a second name:

| Step | Utility | Size / leading | Tracking | Use |
|---|---|---|---|---|
| label | `text-label` | 11px / 16px | +0.05em | UPPERCASE section labels, badges, field labels, monogram chips |
| meta | `text-xs` | 12px / 16px | 0 | timestamps, counts, event lines, hints |
| ui | `text-ui` | 13px / 20px | 0 | dense UI text: board cards/columns, list rows (BOARD-UI's "13px medium"), buttons |
| body | `text-sm` | 14px / 20px | 0 | prose, inputs, comments, menus |
| heading | `text-heading` | 18px / 26px | −0.01em | dialog titles, page/section headers |
| title | `text-title` | 24px / 30px | −0.02em | the ticket title; the largest text in the app |

Rules:
- **No arbitrary sizes.** `text-[13px]`-style literals are banned; if a real need falls between
  steps, the scale changes here first.
- `text-label` bakes in its wide tracking — don't stack `tracking-wide` on it. Uppercase is still
  applied per-use (`uppercase`), since label-size text isn't always caps.
- Markdown prose (ticket bodies, comments) is typeset by `typeset.css` (`--typeset-size: 0.875rem`,
  em-relative headings) — it's the body step's prose expression, not a separate scale.

## Controls — the pill scale

Buttons and control chips are pills (`rounded-full`, baked into `ui/button.tsx`); the filter/metadata
chip (`h-7` pill, `text-xs`, `border-border`) set the idiom and the button primitive follows it.
Heights come from the primitive's size variants — don't restate them per-use:

| Size | Height | Text | Use |
|---|---|---|---|
| `xs` / `icon-xs` | 20px | `text-xs` | inline row actions, hover affordances |
| `sm` / `icon-sm` | 24px | `text-ui` | dialog/footer actions (Create, Comment), toolbar buttons |
| `default` / `icon` | 28px | `text-ui` | standalone actions, chrome-band icons; matches the chip height |
| `lg` / `icon-lg` | 32px | `text-sm` | rare hero actions (empty states) |

`default` is the chip height on purpose: a default Button next to a filter chip reads as one family.
Nothing in the app should render a taller control than `lg`.

## Vertical rhythm (reading surfaces)

The ticket Doc tab is the reference implementation: generous air above the title (`pt-8` below the
tab strip), 24px title→body, `gap-8` (32px) between the body and the Activity section, Activity
separated by `border-t` + `pt-6`, and a deep `pb-16` tail so the last content never kisses the card
edge. Micro-spacing inside components stays on Tailwind's stock scale — the language governs
page-level rhythm, not every 4px.

## Alignment details worth keeping

- The body editor bleeds its hover block into the gutter (`-mx-3` + `px-3`) so body **text**
  left-aligns exactly with the title on the column edge (Notion-style). Boxed elements (comment
  cards, the composer) align their **borders** to the column edge instead.
- Terminals and the artifacts viewer are Tier B planes inside the ticket surface: full-bleed to
  the card edge (terminals) or gutter-aligned (artifacts), beneath the Tier A title.
