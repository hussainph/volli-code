# Design language — spacing, width, typography

This is a living description of the app-wide spatial and type language. Motion tokens live in
`globals.css`; **color tokens are generated** from the stored canvas and resolved appearance by
`@volli/shared`, and `globals.css` carries the generated default as its first-paint fallback — so
nothing here should ever hard-code a color. The code and generated tokens are authoritative when
this document drifts.

**The principle:** cohesion is structural, not disciplinary. Surfaces compose shared tokens and
primitives instead of hand-rolling containers and px values — a new surface is consistent by
default. Whitespace is deliberate: content draws the eye by sitting on a bounded measure, not by
filling every pixel (the Linear lesson — maximal width reads as noise, not as density).

## The two-tier surface model

Every surface declares which tier it is; the tiers may not be mixed ad hoc.

- **Tier A — reading surfaces.** Prose-like content someone reads or writes: the Ticket Body tab
  (title, description, activity, composer), empty states. These center on
  the canonical measure via `<ContentColumn>`; surrounding whitespace is the point.
- **Tier B — workbench surfaces.** Content that genuinely earns width: the kanban board, list
  view, artifacts viewer, terminals, and the Settings and Configure panes. These stay fluid edge-to-edge but align their horizontal edges
  to the page gutter so all surfaces share the same left/right rhythm.

  Settings and Configure are Tier B via `<WorkbenchColumn>` — still a centered column, but capped
  at `--container-workbench` rather than the reading measure. They read like preference forms, yet
  their tables carry a name AND a description AND provenance, and at 45rem the description
  truncated to a few words — the one column that tells two skills apart. Capped rather than fully
  fluid because an unbounded row parks a switch a foot from the label it answers to.

## Layout tokens (`globals.css` `@theme`)

| Token | Value | Utility | Meaning |
|---|---|---|---|
| `--container-content` | `45rem` (720px) | `max-w-content` | The canonical reading measure. Chosen over Linear's ~660px for code-heavy ticket markdown. |
| `--container-workbench` | `80rem` (1280px) | `max-w-workbench` | The Tier B ceiling, for surfaces that are columns but carry tables (Settings, Configure). |
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

**Thirteen recorded exceptions**, each because the ladder's fixed rungs cannot express a
measured piece of geometry rather than a value chosen locally. They are commented at their site;
do not re-collapse them without looking at the surface:

| Site | Value | Why |
|---|---|---|
| `ui/button.tsx` size variants | `px-2.5` · `px-3` · `px-3.5` | A control's inset is a function of its own height, and this is a four-rung height ladder (20/24/28/32) with only two rungs in range |
| `rail-panel-parts.tsx` `RAIL_PANEL_INSET` | `px-3` at narrow | The narrow step must be *smaller* than 16 and still an inset; 8 halves the edge. Collapsed, the variant became a silent no-op |
| `sidebar/session-band-row.tsx` | `mt-1.5` · `gap-0.5` · `gap-1.5` · `pt-0.5` | The first pair keeps the dot on the title cap height and binds the real title to its meta line. VC-383's shorter 14px/12px skeleton bars need the 2px top nudge and 6px join to occupy that measured two-line row before labels replace them |
| `board/ticket-card.tsx` | `px-3` | A dense card trades air for content: at `px-4` real titles truncate a word earlier |
| `browser/session-cursor.css` | chip `gap: 5px` · `padding: 0 7px` · `height: 20px` · action `height: 15px` | The Session cursor's label is a drawing at pointer scale, measured against a 16px arrow, not a control on the layout grid: at the ladder's next step the chip reads as a button beside the arrow rather than a name riding it. Its type and corners still take the `--text-label` and `--radius-sm` rungs |
| `globals.css` Monaco loading skeleton | `height: 14px` · `top: 12px` · `top: 36px` | The pseudo-elements meet Monaco's 12px source inset and its measured two-line placeholder drawing; 8/16/24px rungs move a bar before the host is replaced |
| `ui/list-row.tsx` `density="two-line"` | `py-1.5` | Two `text-ui` line boxes + 12 keeps the measured 52px two-line row; `py-2` grows every row of a dense list to 56 and orphans the `min-h-13` floor. Recorded against the Diffs page until the row became a primitive — it was a fact about the object, and the Files page's 56 was the drift |
| `ui/list-row.tsx` `ListRowSkeleton` | `gap-1.5` | Its 16px/14px bars need the 6px join to preserve the measured two-line placeholder footprint; `gap-2` changes that first paint before the labels replace it |
| `chat/transcript-skeleton.tsx` | `gap-1.5` | Its 14px assistant bars sit on a 20px top-to-top placeholder rhythm (14 + 6); `gap-2` makes the transcript's loading drawing taller before prose replaces it |
| `session-peek/session-peek-card.tsx` card grid | `p-3` · `px-3` · `py-3` · `gap-3` | The peek's 12px inset is `RAIL_PANEL_INSET`'s narrow rung measured onto a popover, and for the same reason that one is recorded: 8 halves the edge of a floating card, and 16 inside a 360px card costs a line of the five-line summary fold. The block rhythm is that one measure turned vertical — inset and rhythm are the same number, which is what makes the two peek cards read as one surface |
| `session-peek/session-peek-card.tsx` lead column | `pt-0.5` · `gap-0.5` · `gap-3.5` | The card's lead column is 24px + 8, so text starts 44px in everywhere. The 2px top nudge centres a 20px first line on that 24px mark and the 2px join binds the title to its own meta line (`sidebar/session-band-row.tsx`'s fact about the same two lines); the crumb's 14px is measured backwards from the 44px edge — a 12px glyph inside a `px-2` button pulled back 2px lands there at 14 and nowhere else |
| `session-peek/session-peek-card.tsx` ghost buttons | `-ml-1.5` · `-ml-0.5` | Optically aligning a ghost button's icon to the lead column is that control's own inset subtracted — 6px for `size="sm"`, 2px for `size="xs"`. A negative of another component's padding is a measurement of `ui/button.tsx`, not a rung any ladder can hold |
| `session-peek/ticket-peek-card.tsx` drill rows | `py-1.5` | A drill row is a two-line row (title + summary), so it takes the same 6px `ui/list-row.tsx` records for `density="two-line"`; the list's own 6px then meets it to make the card's measured 12px at the top and bottom edge. `py-2` on either half breaks the inset the header already sets |

**Responsiveness is the whitespace, not breakpoints:** `<ContentColumn>` is
`mx-auto w-full max-w-content px-gutter` — on wide windows the side margins grow; as the window
narrows they compress to the 24px gutter floor before text ever reflows.

## Layout primitives (`components/layout/`)

- **`<ContentColumn>`** — the Tier A measure column. Tier B surfaces must not wrap in it.
- **`<WorkbenchColumn>`** — the same column at the Tier B ceiling (`--container-workbench`), for a
  surface that needs width for tables but would look adrift edge-to-edge. Settings and Configure.
- **`<PageHeader>`** — the page-level header, and the only one: `title` (always the page's `h1`),
  optional `description`, optional right-parked `actions`, and `children` for controls that share
  the title's row and wrap with it. `py-4`, wrap-friendly, gaps `4`/`2`. One axis, `variant`,
  carries the tier: **`workbench`** (default) pays its own `px-gutter` and titles at `text-sm`, for
  a dense control row; **`reading`** adds no inset — it is mounted inside a `<ContentColumn>` that
  already owns one — and titles at `text-heading`, the masthead a step above the `text-sm` section
  titles under it. Board and both settings shells compose it; nothing re-derives a title row.

## The framed content surface

The main content area is a **floating card**: `rounded-xl`, hairline `border-border`, `m-2`
(8px) on the theme-derived rail backdrop (`--rail`), applied once on `SidebarInset` in
`app-shell.tsx`. Every page — the always-mounted sessions layer included — renders inside it, so
the workspace reads as an object with edges instead of an edge-to-edge slab. This amends the
earlier flat chrome-band treatment (decision #31); the chrome bar and workspace rail still form
the surrounding "L", whose color and contrast come from the active theme.

## Composer stack

Cards parked above the composer (questions, activity, picker suggestions) keep the quiet
`COMPOSER_STACK_SHELL` in `@volli/session-presentation`. They never replace the input.

### New-ticket composer

The writing canvas owns the space: title and description on the reading measure,
with Status, Priority and Labels below. Working-copy setup and Create more live
in **Options**, not beside every commit. Checkout and batch-entry selections
remain visible on the closed Options trigger.

The footer has **two commit buttons and a chooser**, welded into one pill.
**Create** is its own press — filing a ticket without starting work is the other
ordinary answer, not an advanced variant, and it is never hidden behind a caret.
Beside it the **primary** starts something: Create & start by default, or
Create & run for a saved Automation. Only the caret's menu is open-ended (chat,
or any of the project's Automations), and selection never submits.

`⌘/Ctrl+Enter` is plain Create — the unmodified chord for the unmodified action.
`⇧⌘/Ctrl+Enter` fires the primary, whatever the menu has selected, so no chord
badge is printed against a single menu row. Model and effort appear only for chat
kickoff; an Automation uses its saved Runtime. Launch mode is per-open and resets
when retargeting projects; the ticket draft itself still survives closing.

Create & start leaves the current workspace in place while the Session starts.
Create more only controls whether the composer resets for another ticket or
closes; opening the new ticket or Session is a separate, explicit action.

**Those three commits are why this tray folds early.** They take ~215px of the
settings' own line where a chat footer spends ~100px on one send key, so at the
dialog's own 36rem the model pill, the effort chip and the buttons no longer fit
on one line and the whole button group wrapped (VC-382). The tray marks its
container `data-composer-container="commit-tray"` and gives in three steps
instead:

| Tray | The run reads |
|---|---|
| ≥ 40rem (the expanded sheet) | two pills — model, then effort |
| 34–40rem (the dialog's own 36rem) | one pill, `Model · Effort` |
| < 34rem | one pill, the model alone |

The value never leaves the CONTROL, only the face: the trigger is still named
"Model and effort: … · Extra high" and its popover still opens on the slider. The
run is the row's elastic member (`basis-38`, the Add door plus the pill's own
116px floor), so the model name truncates and the commits never squash — a
wrapped tray is a layout accident wearing the shape of a decision, and the only
box that still earns one is narrower than this dialog can be.

**Staged files sit in a band of their own**, between the metadata chips and the
tray, hairline above and `py-2` inside it — the same inset on both edges, so the
thumbnails never touch the tray they sit on.

### Prompt chrome — writing sheet and control tray (VC-335)

The first pass unified controls but still looked like the old flat box. The follow-up makes
prompt writing a distinct object: an opaque writing sheet, a tinted lower tray, and a fine
accent edge that catches at opposing corners. `PROMPT_SURFACE` in `chat/composer-chrome.ts`
owns the shell; `globals.css` owns its material. Every color comes from generated theme tokens.
There is no backdrop blur, animated glow, or focus-triggered shell change.

This treatment reaches Session chat, New ticket, Automation instructions, command-prompt
creation, and ticket comments. Questions retain their quieter stacked-card
treatment.

| Piece | Rung | Says |
|---|---|---|
| Settings (model, effort) | `sm` — 24px, edged `bg-card` pills, muted ink; one combined control below 24rem (40rem in a commit tray), naming the model alone below 18rem (34rem there) | facts about the turn |
| Add / context | `icon-sm` — 24px; Add has a circular edge | secondary controls |
| Send / Queue | `icon-lg` — 32px, `rounded-control`, filled with a fine bevel | the primary key |
| Stop | `icon-lg` — 32px, `outline` | interrupt the turn |
| Text box at rest | `min-h-20`, `py-4`, content-grown | room for a short paragraph |
| Footer tray | `px-2 py-2`, tinted `--muted`, hairline top edge | separates writing from configuration |

**The tray is earned, not automatic.** It exists to divide writing from
configuration, so it appears only where there is configuration or a primary to
carry: chat (model, effort, send), ticket creation, ticket comments. A surface
whose only control is the `+` — Automation instructions, the command-prompt body
— keeps the shared shell and the shared door but draws no tinted band, because a
full-width tint holding one 24px button reads as a container someone forgot to
fill.

The send key is a deliberate exception to the action-pill silhouette: it shares the 12px control
radius, while settings remain pills. The shell takes `shadow-card`; dialogs keep `shadow-overlay`.
The chrome stays at one ink, so a resting composer never masquerades as disabled.

**`+` is the one door.** A menu, not a paperclip: Attach files… · Commands & skills `/` ·
Mention a file `@`, each row's trailing slot carrying the keystroke that makes the row unnecessary.
The two picker rows write the trigger at the caret through the picker stack's own binding, so the
list opens exactly as if typed. A surface that takes no files has no attach row; one with no picker
has no trigger rows; the New-ticket footer, whose editor completes `@` itself, keeps the `+` as a
one-press attach. The ticket Files rail keeps a paperclip — it is about files, not prompts.

**Chords live on hover.** Send says `⏎ · ⇧⏎`, Queue says `⏎ · ⌘⏎ steer`, in tooltips on the
control the chord replaces; never as a hint line under the box.

**Narrow, the row gives in order.** The composer is an `@container/composer`; below 24rem the
separate effort pill folds into the model control, whose face and popover then expose both values.
**Below 18rem the face keeps the model alone**: past that width the printed effort word is paid for
out of the model name (42px of name at the app's narrowest pane, against 83px without it), and the
value is still on the control — in its accessible name, and on the slider its popover opens to.
(A tray whose commits are buttons rather than one send key runs the same ladder wider: it folds at
40rem and drops the printed value at 34rem — see the New-ticket composer above. One rule, two
ladders, all four thresholds in `globals.css` beside the constants `composer-ui.tsx` measures the
portalled popover with.)
Within that control the tier gives before the model does — a qualifier must not outlive the thing
it qualifies, and the pill's one fact is the model this Session sends to. Wide, it truncates first;
through the fold it leaves the face entirely rather than clipping to a letter or two (`Ticket
Sess…`, then a bare `T` welded to the model name), and the full line stays in the accessible name
and at the head of the open list.
The rule is shared by Session chat, New-ticket kickoff, and one-off Automation runtime controls.
The context pill also drops its percent while keeping the ring. During a live turn, model and effort
are frozen, so that disabled combined control leaves the narrow tray entirely; the queued Steer
action keeps its icon and accessible name but drops its printed word. Add stays outside the omitted
group, and the context / Stop / Queue cluster never moves.

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

Three things are deliberately not on this ladder. The focus ring is `ring-ring/45` — one recipe,
spelled in `ui/button.tsx` and recorded in `ui/field-classes.ts`. The overlay wash is
**`--scrim`**, a generated token rather than a modifier: it is the shadow tiers' own ink (the
canvas's hue at the mode's shadow lightness) at 30% in light and 50% in dark, so a dialog dims the
window in the window's own color instead of the `bg-black/N` that turned a warm gradient to dirt.
Use `bg-scrim`; never hand-roll an overlay wash. And the split-view drop preview's ring is
`ring-primary/40` (`split/split-drop-zones.tsx`, one site): it must read above its own `/10` fill
mid-drag, where `/30` disappears on a busy canvas, yet stay under the focused pane's `/50` ring —
a prospective result may not outrank the pane actually in context, and at `/50` the two would be
the same ring saying two different things.

## Type scale — five steps

Named font-size tokens carry their paired line-height (and tracking where the size demands it),
so components never pick these per-surface. The body step rides on Tailwind's stock utility rather
than duplicating it under a second name:

| Step | Utility | Size / leading | Tracking | Use |
|---|---|---|---|---|
| label | `text-label` | 11px / 16px | +0.05em | UPPERCASE section labels, badges, field labels, monogram chips |
| ui | `text-ui` | 13px / 20px | 0 | **the single UI size**: board cards/columns, list rows, timestamps, counts, event lines, hints, buttons, menus |
| body | `text-sm` | 14px / 20px | 0 | prose, inputs, comments |
| heading | `text-heading` | 18px / 26px | −0.01em | dialog titles, reading-page mastheads, section headers |
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
- **Paragraphs read at `--leading-prose` (1.7), not at a step's paired leading.** The paired
  line-heights above are single-line rungs — right for an input or a row, dense for prose. Every
  rendered-markdown surface shares the one prose ratio: the chat transcript wears it as the
  `leading-prose` utility (on `MessageContent`), `typeset.css` reads `var(--leading-prose)`. A new
  prose surface takes this token; it does not pick its own ratio.

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

**A checkbox is the one control that is not a pill, and not a rung.** `ui/checkbox.tsx` is a
16px box whose corner is half the smallest rung (`calc(var(--radius-sm) / 2)`, 4px). Every rung
of the radius ladder is 8px or more, and at 16px that draws a circle — a radio button, which says
"one of these" about a control that means "any of these". The value is derived from the ladder
rather than written beside it, and it is recorded here because the token check cannot see an
inline style.

**Tabs ride the same rung.** `ui/tab-strip.tsx` is the one tab, at 28px / `text-ui` in both its
drawings — `variant="folder"` (rounded top corners, active tab bleeding `-mb-px` over the strip's
bottom border) and `variant="pill"` (rounded rectangle in a centred band). A tab is a place, not a
hero action; the two strips that sat at `h-8 text-sm` were reading at `lg`.

## Cursors — native, and one rule

The pointer stays native, and native means the arrow. The hand is reserved for **links that
leave the app** — a rendered `<a>` in prose, Document Mode's followable link. Nothing else: a
button, a row, or any control that answers a press shows the arrow. Tailwind v4 dropped the old
`cursor: pointer` from buttons and this app keeps it dropped (VC-381); a `cursor-pointer` in the
app UI is a bug, not a missing affordance.

Clickable rows that are not `<button>`s — tabs, menu rows, the palette and quick-open rows, the
transcript's tool rows, the answer and verdict rows — carry `cursor-default select-none`: the
arrow, so a row never shows the text caret, and no selection, so a press-drag across a row
answers the click instead of painting a selection. `MENU_ROW` has said this since the menus were
unified; `ui/tab-strip.tsx` was the one interactive row that never picked it up, which is why
every tab in the app hovered like a line of text. A `select-none` row that contains a real field
is the field's exception: `ui/inline-rename.tsx` hands selection back with `select-text`.

The deliberate exceptions, all already in the code:

| Surface | Cursor | Where |
|---|---|---|
| Links that leave the app | hand | the UA default on `<a>`; `.volli-md-link-open` for the editor's links |
| A drag in flight | `cursor-grabbing` | the board's lifted card, a tab being carried, the effort rail at `data-dragging` |
| A surface that is only a drag | `cursor-grab` | the board's canvas pan, automation lane cards |
| Resize handles | `cursor-col-resize` / `cursor-row-resize` | `sidebar/sidebar-resize-handle.tsx`, `ticket/rail-resize-handle.tsx`, `split/split-view-divider.tsx`, `sessions/session-split-layout.tsx` |
| Disabled controls | `cursor-not-allowed` | `ui/switch.tsx`, `ui/input.tsx`, `ui/textarea.tsx`, `ui/select.tsx`, `ui/command.tsx` |
| Text, and the controls that open onto it | I-beam | real fields (UA default); `cursor-text` on `ui/input-group.tsx`'s addon and `ticket/ticket-title.tsx`, where a press lands the caret |

Click-and-drag tiles — board cards, tabs before the drag engages — keep the arrow at rest: the
click is the primary answer, and the closed hand appears only once a drag is actually carrying
something. The UI lab (`renderer/lab/`) is a scratch space and is not held to this.

## Split view — panes, zones, and the empty pane (VC-202)

Both tabbed surfaces divide their plane into **panes** (`components/split/`). One grid draws the
split and unsplit cases, so the unsplit plane is not a special path: it is one pane, with none of
the chrome below.

| Mark | Treatment | Says |
|---|---|---|
| Focused pane | `ring-1 ring-primary/50 ring-inset` | the rail is reading THIS pane's front tab |
| Unfocused pane | `ring-1 ring-border/50 ring-inset` | a pane, and not the one in context |
| Divider | 6px grip, `bg-border` hairline → `bg-primary/70` on hover, 150ms | draggable, and where |
| Drop preview | `bg-primary/10` + `ring-1 ring-primary/40 ring-inset`, `rounded-md` | where the drop would land |

Neither ring is drawn while a surface has one pane: a ring around the only pane is chrome about a
choice nobody has made. Both are the terminal split's own vocabulary
(`sessions/session-split-layout.tsx`) because a split is the same act at two scopes — and splits
open **right or down only** in both, which is what keeps the permanent tab's pane in the top left
at the start of the main bar.

**The main bar splits with the plane (VC-333).** Panes along the top edge share
one bar height, divided at the same ratios and grip widths as their content.
Only a pane below a down split adds a lower tab strip, and only when it holds
tabs. Mixed trees follow that rule recursively. The surface-wide new-session
control and rail toggle stay once at the main bar's far right; the last segment
extends over an open rail without moving the pane dividers.

A pane is then one region drawn in two boxes, and the two boxes behave as one:
a press anywhere in a pane's segment of the bar focuses that pane exactly as a
press in its content does. The trailing actions cluster is the one exclusion —
it acts on the surface and opens into whichever pane is focused, so pressing it
never moves focus to the pane it happens to sit in. An empty top-edge segment
keeps its share of the bar so the seams stay aligned, but draws a plain band
rather than an empty named tablist.

**One seam, one announced grip.** A row split is draggable along its whole
height, bar and plane alike, but only the plane's grip is a `separator` in the
accessibility tree and the tab order. Two would announce two dividers and cost
two identical tab stops where the user sees one boundary.

**Drop zones draw the result, never the target.** A pane's content box is tiled by three regions —
a full-height column down the right edge, a strip along the bottom of what is left, and the centre
(each edge band the outer 25%, floor 48px). The regions themselves are invisible; what lights up is
the rectangle the drop would leave behind: the right half, the bottom half, or the whole pane for a
move. One preview element, so crossing from the centre into a band morphs the rectangle rather than
swapping two of them. Zones cover the content only — never the pane's own strip, where the same
drag means a reorder.

**Motion is the drag's, and only the drag's.** One always-mounted preview element carries the
whole budget: opacity and its four box properties, named exactly, 150ms `ease-out` — it fades in
where the pointer entered, morphs between zones, and never blinks; `motion-reduce` cancels it. A pane opened from the keyboard (`⌘\`, `⇧⌘\`) appears with **no animation at all** —
it is a chord pressed tens of times a day — and hands focus to its menu's first row.

**The empty pane is a menu, not a message.** Five rows at the `lg` rung (32px, the size this
document reserves for empty states) in a `w-72` column: New chat `⌘T`, New terminal `⌥⌘T`, New
browser, Open file… `⌘P`, Close pane. Icon, label, right-aligned chord hint in the menus' own `MENU_SHORTCUT`.
No heading, no explanation, and above all no "drag a tab here": each row is a verb, with a chord
beside it where one exists. Browser and Close pane have no chord.

## The ticket rail (VC-406)

The rail is the Ticket's hub, and its scope is the line that decides what goes on it: **everything
on the rail is true of the whole Ticket or its worktree; nothing on it is true of one chat in
particular.** What one chat is holding — its browser tabs, its subagents, its plan, its background
shells — belongs to the Activity Island above that chat's composer. So the rail's roster lists no
Subagent Session and the island lists no sibling chat; the two surfaces split one question by
scope rather than overlapping on it. A block that would only be true of the front chat is a block
in the wrong place.

**Four pages in one pill, and the pill is the only navigation the rail has.** Now, Diffs, Files,
Search (`TICKET_RAIL_MODES`), in that order, because it is a keyboard order as much as a visual one
and a page inserted in the middle moves every page after it under a reader's fingers. `Now` is the
hub; the other three are working surfaces over the worktree. Switching page never opens, closes or
retargets a main-view tab (`selectRailMode`). **One** of the two pinned footers is outside the
tabpanel: the worktree, which is true of the Ticket whichever page is up. Cost is Now's own and
sits inside Now — a spend figure under a folder listing is a fact about neither the folder nor the
file.

**Properties uses the app's own pickers, not the rail's own.** Status and Priority are the
dropdowns the board and the ticket header already open (`RAIL_CONTROL` on the trigger: the row's
**value**, sized to its label, never stretched) — so permissions, ordering, focus return and
mutation-failure feedback are the app's single implementation rather than a rail-local copy of it.
The only raised buttons left on Now are those two. **The row is not the target**: it is a glyph and
the control where the value goes, at 38px (a 28px trigger plus its padding) against the page's 36px
rows — a retained difference, not drift. **No field caption trails it**: the glyph says which field
the line is and the value says the rest, so a muted `Status` at the right edge was a third naming of
one thing, charged to the rail's width. The field name is not dropped, it moves — it rides the
control's own accessible name (`Status: Todo`), and the glyph goes `aria-hidden` so it is said once.
Labels are the one place a pill run survives, because a label *is* removable and addable: real
project labels, additive left to right, each with its own remove target, and a compact **+** door
(`Add label` for assistive technology) offering unapplied labels or creation of a new name.

**Now is ordered by where attention goes, most often first.** The first pass ordered it by kind —
what the Ticket *is*, what can be *run* on it, what is *happening* on it — and that put a
rarely-pressed list of Automations above the roster of live Sessions, which is the one block on the
page a person consults every few minutes and the most direct way to the right chat. Taxonomy beat
frequency; the comparison scratch drew the cost, and the order is by frequency now.

| # | Block | What it is | Object kind |
|---|---|---|---|
| 1 | Properties | status and priority as the app's own dropdowns, labels as an additive pill run | section |
| 2 | Sessions | the working set, one row per live Session, `+ Chat ▾` in the eyebrow; the record folded under the eyebrow's own label | section (folds) |
| 3 | Automations | what this Ticket can be made to run, height-capped | section |
| — | Usage | what it cost, at one row | pinned footer (folds) |
| — | Worktree | the branch and one fact about it; the repository card folded above | pinned footer (folds), **under every page** |

Properties opens because it is the header of the thing every block below is about, and because the
status it sets is what decides which Automation the block below marks Armed. Sessions is second
because it is read most. Automations closes the scroller because it is pressed least, and it is
still on the page because a Run is how a row *appears* in the roster above it.

**A roster splits on lifecycle, not on attachment.** A Session is durable, so closing its tab ends
nothing: the live rows are what someone could still go back to, and only what is *over* — stopped,
exited, a terminal whose PTY is gone — belongs to the record (`sessionActivityIsLive`). The row
that made the old rule visible was a Session **waiting** on a permission prompt, folded under the
record's caret because nothing happened to be attached to it. Within the live rows, whatever is
asking for a person sorts first and recency is the tiebreak (`sessionAttentionRank`); the record
stays strictly chronological, since nothing in it is asking. Past four rows — counted over both
halves — the roster earns a filter (`SESSION_ROSTER_FILTER_THRESHOLD`), and the filter reaches the
record: while there is a query, a match behind the fold is a row on the page. All three rules are
spelled once and read by both rails, so Home's roster and the Ticket's cannot drift.

**One object kind carries the page**: every block on Now is a *section* — an eyebrow row
(`RailSectionHeadingRow`: `text-label` caps at the left, at most one control at the right) over
rows at the rows' own `px-2`. Properties was a run of pills, the one block that was neither a
section nor a card — unmarked, bordered at rest where every row is borderless until hovered, two
facts to a line — and it is three rows now, in the roster's grammar even where the value it carries
is a control rather than a `ListRow`. *The card* (`RAIL_CARD_FRAME`, seamed rows inside one
`rounded-xl` frame) is the Diffs page's costume; Now draws none. The page stacks with **one
`gap-4`**, each block sets `gap-1` under its own eyebrow, and no block pays its own top padding —
the pill above already pays the page's top inset. An absent block then leaves no hole, and no block
can drift from its neighbours by carrying a different inset. **Home's rail obeys the same seam**,
the narrow step included: both rails read `RAIL_NARROW_MAX_WIDTH` (270px) against the one
`railWidth`, so a column dragged toward its 240px floor tightens to 12px gutters at either scope —
page blocks and pinned footers together, since the footers inset from the same group attribute.

**Rail scrolling never changes the content width.** Home and Ticket rail scroll containers hide
the scrollbar and reserve no gutter, while retaining ordinary wheel, touch and keyboard scrolling.
An accordion crossing the overflow threshold must not shift every row inward. This is scoped to
the rail, not a global change to editors, the sidebar or portalled menus.

**The rail has one fold, and the trigger never moves.** Three things open and close in place —
the roster's record under the Sessions eyebrow, the worktree body under its footer row, the cost
breakdown under its — and they are one object (`RailFold` / `RailFoldBody` / `RailFoldCaret`, a
measured `height` **transition**, 200ms on the strong `--ease-out`, the caret 150ms on the same
curve). A transition rather than the `collapsible-down/up` keyframes the accordion runs on because
a fold is pressed twice in a second: keyframes restart from their own zero, so an interrupted close
jumped back to full height, while a transition retargets from the height the body is **at**. A
keyboard press (`detail === 0`) and `prefers-reduced-motion`, read at the moment of the press, drop
the movement entirely — body and caret both — and a closing body is `inert` for the length of the
close, handing focus back to the trigger if it held any. A body that opens under an eyebrow grows
down into the scroller; a body that opens under a pinned row grows **up** into the room the
scroller gives back. Either way the thing the pointer is on stays under the pointer, and a second
press lands where the first did. The alternative for a footer — header above body, the row rising
by the body's height — reads conventionally and moves the target out from under the hand; it was
drawn and rejected. A fold is a **global preference** (`railFolds`), not a per-Ticket state: it is
how a person reads the rail. Every fold rests closed. *This is not the retired drawer*: nothing
bleeds past the section's inset, the closed state still shows the rows that matter, and only the
record folds.

**An eyebrow that folds keeps its label as the trigger.** `SESSIONS ›` closed, `SESSIONS ⌄` open,
the caret following the word so the eyebrow column stays one straight line down the page, and
`+ Chat ▾` still the row's one control at the right. The count of what is folded is in the
trigger's accessible name and nowhere on the face — the caret alone says there is more. A roster
with no record offers no fold; a caret opening onto nothing is a lie about the block.

**The worktree is a footer under every page.** It lived on Now, then on the Diffs page over the
files it commits, and each home was right about something: the worktree is true of the whole
Ticket, and the commit belongs beside its subject. A row pinned under the rail is both. It is the
branch and **one fact** about it (`worktree-glance-model.ts`), chosen by priority — fault, ready to
archive, checks failing, uncommitted, N to push, checks running, checks passed, up to date — in the
words the body's own rows use, so unfolding never contradicts the row. The dot is quiet for local
state (uncommitted work is the resting condition of a worktree an agent is in; a tone lit for it
would be lit always) and lit only where something outside the worktree has an opinion: CI. The
branch opens the identity popover as the card's first row always did; the fact opens the body —
state strip, CI row, the commit/push/PR split. Diffs is the change set alone. One worktree object,
in one place, reachable from every page.

**Usage is pinned, not stacked, and folds rather than pops.** It is the one block on Now that is
only ever read — the others are worked in — and a read-only fact stacked among acts has the worst
of both: it takes a turn in the reading order it does not need, and it scrolls out of sight
exactly when the roster above it has grown long enough to make the question interesting. It is a
sibling of the scroller, wearing a top rule rather than a card frame, because a footer's boundary
is with the page above it rather than around itself. Its body opens in the rail, not in a popover
— a popover is a window over the page that closes when the reader looks elsewhere — and **the body
is not the popover's body**: a popover had no height budget, and the full breakdown at ~400px
evicted Automations from the scroller. The body keeps what the row does not say: the bar, the
basis sentence, the cached share, the top model, the per-Session ranking.

**A block says what its read is doing in its own eyebrow, and never with a row.** A blank status
line is a hole in the page and a spinner over last-good rows is a lie about them, so read state is
drawn where the block is already named (`rail-read-feedback.ts`, `RailHeadingReadStatus` /
`RailReadFaultBody`): a first read in flight holds the rows' own box as skeletons, a landed read is
the only thing that may claim the block is empty, a refresh over rows already on screen marks the
eyebrow and leaves the rows, and a refresh that failed says so there while keeping the last
reading. Only a read that has nothing to show takes the body, and it carries the one action that
changes it — a retry scoped to that block, never to the app.

**Files and Search are one navigator at two scopes.** Files begins with the current directory,
not a second `Ticket files` / `Project files` title beneath an already-labelled Files tab. The
root or current path leads a compact row with New File and filter icons alongside; the path is
the way Up when inside a folder. The filter field appears below only while open, and read/retry
feedback occupies space only when needed. Below is one flat current-folder listing of one-line
36px rows: the second line each row used to carry was its parent path, which the header already
names.

The Ticket adds one **paperclip menu**, not a permanent Attachments heading or pill strip. The
menu lists attached files and carries attachment/removal actions where this host may mutate them;
a host-supplied read-only list stays read-only. It remains reachable across directory/filter
changes and without a worktree, including attachments that have no materialized file path.
Attachments belong to the Ticket, not the folder. Home has no paperclip because this scope has no
Ticket attachments. Referenced rows (`@path` from the Body, plus path-backed attachments) still
follow the listing on a Ticket and keep their folder beside the name. Search is the same page at
both scopes: find only, results grouped per file with the match quoted on its own line, and a click
previews the file and lands on the line.

**Diffs lets status icons speak.** Added, modified, deleted and the other change kinds keep their
semantic glyphs and accessible status names, not a repeated status word beside every filename.
Counts, rename provenance and the independent Updated marker remain: they say something the
status glyph does not.

**A navigator remembers where it was, per checkout.** The rail draws one page at a time, so a
glance at Now used to walk the listing back to the repository root and delete the words typed into
Search — and the words were the work. The folder, the filter and its query, and the search query
are remembered per scope for this run of the app (`files/navigator-scope-state.ts`), keyed by
project and ticket. It is plain data, bounded and ephemeral: nothing about the memory keeps a read,
a watch or a search alive behind an unmounted page.

**A list bounds itself by height, never by hiding rows.** The Automations block is the case: it
answers "what can I run here", so it draws every offered Automation as a row, with the current
column's armed record first and marked, and caps itself at `max-h-40` with its own scroller. A
project with thirty Automations therefore costs the same vertical space as one with three, and the
roster above it never moves. The alternative — one name on a button and the rest behind a caret —
bounds the height too, by refusing to answer the block's own question. A **first** read holds the
list's own height as skeleton rows; a re-read (the rail re-reads on arrival and on every planning
change) keeps the rows already on screen and puts the caveat in the eyebrow, because rows that were
true a second ago are worth more than a skeleton over them. What an unconfirmed read costs is the
*Run*, not the reading: the block never presses what it has not confirmed at the current planning
version.

**A row's right edge says one thing.** An automation row used to trail `Manual only · Doing`, and
at 300px the phrase cost the name half its width (`Review every b…`). The name is what a reader
presses, the qualifier is what they check: the right edge now says only the column (or `Armed`),
the switched-off fact moved into the bolt — `LightningSlash`; fill-vs-outline already said
armed-or-not, so one glyph says all three states — and the words moved into the row's title and
accessible name. The name keeps a `min-w-24` floor: a qualifier must not outlive the thing it
qualifies.

**Every act wears one costume, and a row is not an act.** `RAIL_CONTROL` (`outline`, the sidebar's
border, a `/30` wash, `shadow-raised`) is the recipe for every button a rail page presses — the
worktree footer's publish split, its `⋯`, its PR link. A control is sized to its label and parked
at the left, never stretched across the column. Everything else that is pressable is a `ListRow`,
and a row **opens the thing it names — it does not spend anything**. The Automation row is the case
that fixed the rule: its press used to *be* the launch, which made it the one place in the app
where a single click spent a Session on saved instructions that were not on screen. A press now
opens an anchored inspection beside the row (a non-modal popover: no scrim, light-dismiss, Escape)
carrying the three things a launch is decided from — the saved instructions, the model this
invocation runs on, and one explicit, labelled Run. Right-click opens the same inspection rather
than a second, differently-shaped menu; neither route starts anything by itself. Now itself has no
button any more: **Run once is gone** from the rail. Stripped to what it did, it minted a chat Session with a typed first
message, in the background, wearing the bolt — `+ Chat ▾` with a worse text box and a
Runs-history row named "Run once" — and the rail was its only host. Only saved records are run
from the rail; a one-off is a chat and typing. (This reverses VC-112's "One-time work" for this
surface; main still starts an Unbound Run for the CLI.)

**What a block does not draw.** Runs are Sessions, so they are listed once, in the roster, wearing
the bolt (`SessionProvenanceMark`) — never a second time under Automations. The usage footer's
face is the figure, the token count and a caret; the rest is one fold behind it, not lines on the
page.

**Session origin is a mark, never a second title (VC-517).** Every Session provenance mark is a
fixed, non-shrinking 12px bold-outline bolt in `text-primary`, without a pill, border or animation.
It prints no Automation name, even when a Session is renamed: the title owns the width, and the
full origin stays in the accessible label and the surface's peek or hover line. Existing slots
stay put — Active and palette rows trail the title, Previous and Ticket roster rows lead it,
tabs use their badge slot, and Home's roster trails the title. User-started and Session-started
work gains no glyph. This is provenance, not current state: armed/fill and switched-off/slash
remain the vocabulary of saved Automation records, whose names stay visible.

**Cost notation.** A hedged figure carries a small word *after* the money, a step down and muted
(`UsageCostFigure`): `$8.42 est.` for a catalogue estimate or a mixed basis, `$8.42 unverified`
for a basis Volli cannot vouch for, `$8.42+` when only part of the report was priced, bare only
when wholly provider-reported. The old tilde prefix read as the figure's own punctuation at hero
size; the trailing word reads as a qualifier at every size, and `unverified` is never spelled
`est.` because knowing a number and having computed it are different claims.

## Home's rail (VC-406)

Home's rail is the ticket rail one scope up, at the same width (`railWidth`) and in the same
language: one pill, one list row, one fold, footers pinned under the pages rather than stacked
inside them. **Three pages** (`HOME_RAIL_MODES`): Now, Files, Search — the Ticket's four minus
Diffs, which is a worktree's change set and Home has no worktree of its own.

**Now is the project's Board Session roster, and nothing else.** It was two pages — Now described
the Session in *front* while a Sessions page beside it listed the Sessions there *are*, which is
one question split across two tabs — and it is one block now, in the ticket roster's own grammar:
two-line rows (`text-ui` title over a `text-label` line of tone dot, state and age, inside
`ListRow`'s 52px `two-line` density), whatever is asking for a person first, the record folded
under `Earlier · N`, and one filter past four rows that searches **both** halves — a match in the
record is a row on the page rather than a row behind a caret.

**Liveness is the record's answer, not the attachment's.** A Board Session whose tab was closed
this morning is still a Session to go back to, and one blocked on a permission prompt is the first
row on the page; only what is over — stopped, or a terminal whose PTY is gone — folds into Earlier
(`sessionActivityIsLive`, `sessionAttentionRank`, shared with the Ticket roster so the two cannot
drift).

**Two footers under it, one of them under every page.** Cost is Now's alone (`HomeUsageRailFooter`)
— a spend figure under a folder listing is a fact about neither the folder nor the file. The **Main
checkout** (`home-rail-footer.tsx`) is under all three: one 42px row, edge-to-edge targets from the
rail's own gutters, the branch opening the identity and the fact opening the reading, folding
**upward** into the room the scroller gives back, on the Ticket rail's own `railFolds.worktree`
preference. It was the bottom half of a card on Now, which put "which tree am I about to change"
only on the page a reader was not on. It draws two read states rather than the grammar's four,
because the venue store keeps no pending flag beside its last-good reading: a first read, and a
read that failed.

**The Session-identity card is retired from the rail.** The model, tier, effort and activity of
whatever chat is in front were a second answer to what the tab and the composer's own pill already
say, and the block stood between the page's title and the roster the page exists for; the tree it
named is the footer above. `home-session-card.tsx` survives as a component with its own tests and
the `home-rail-now` scratch, mounted by no app surface — and it left two rules behind that every
rail still keeps.

**A model is drawn, never spelled.** The vendor's mark (`models/model-identity.tsx`, the one the
composer pill, the picker and Settings wear) leads the catalogue's name for it — "Claude Opus 4.1",
not `claude-opus-4-1`. A wire id on a product surface is a value nobody proof-read; it survives only
as the fallback for a selection the catalogue no longer lists, because a model we cannot name is
still the one a Session will send to. Usage's **By model** and **Top model** rows follow the same
rule (`UsageRowSubject`): names come from the full cached catalogue, not the available/unhidden
picker slice, because historical spend does not disappear when an account signs out or a model
is hidden. An absent catalogue entry keeps its recorded model id; costs, ordering and Session
labels do not change.

**In a rail, the mark says the account and the text does not.** The roomier surfaces append
"· Anthropic" where two signed-in providers ship one model name (`needsProvider`). A 240–300px row
cannot afford it: the term is what pushes the NAME into an ellipsis, so it costs more of the fact
than it adds. Marks are chosen by provider first, so the same model from two accounts already wears
two glyphs — the same answer, drawn rather than spelled. The words stay one hover or one focus away
in the reveal, which is also how a rail hands back any value it clipped (`ValueReveal`, VC-288),
where a picker's rows wrap instead.

**The words belong to the app, not to the surface.** Activity says what `SESSION_ACTIVITY_LABEL`
says and effort says what `effortLabel` says — both rosters' state lines included. A page that
keeps its own copy drifts: the retired card said "Ended" where every other surface says "Exited",
and printed the wire enum `xhigh` where the composer's own chip says "Extra high".

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

## Surface research — not an adopted production treatment (VC-617)

`pnpm lab` → `/lab/?clean#surface-materials` opens the **Surface** tuning scratch.
It composes real Button, Segmented, ListRow, Input, Textarea and Popover primitives,
with fixture-only interactions and a lab-only DialKit (MIT) editor. The additional gallery
covers Badge, Switch, Checkbox, Select, Accordion, TabStrip, ButtonGroup, Notice, StatusDot,
Spinner, Skeleton, InputGroup, Tooltip, DropdownMenu, ContextMenu, Dialog, SectionHeading,
Separator and PriorityIndicator. These are imported production components, not replicas;
local state exercises choices, navigation, loading/error feedback and floating surfaces.
Flat, Borrowed light, Modern Aqua, All glass and Sculpted Aqua are starting points,
not new app themes.

Preview and tuning controls have independent, keyboard-focusable scroll regions. Workspace /
Components jump buttons keep the gallery accessible without remounting either fixture.
On narrow windows the two bounded regions stack; the document itself does not scroll.
Gallery portals receive the same scoped theme and inspector finish, and register their actual
geometry with the shared lighting rig. The gallery work surface follows Work Pane dials.
Menu/dialog fixtures are non-modal so inspector tuning remains possible while they are open;
the dialog deliberately omits the production modal scrim. The Radix Select retains its own
modal interaction model. No fixture invokes app settings, stores or host mutations.

**macOS 27 reference study:** the separate Material Study switch preserves authored Surface /
Modern Aqua recipes. Clear, Balanced and Tinted are stops on a continuous Balance dial, coupling
face transmission (24% → 90% opacity), diffusion (6 → 22px blur) and a restrained neutral tint.
These are our authored approximation coefficients, not Apple's native values. Thin dark boundaries
and tight specular catches replace the broad Aqua bevel; glass stays on the toolbar and floating
fixtures, with opaque working content and an edge-to-edge quiet rail. Active / Inactive reduces
chrome sheen, rim and shadow without fading text. A local theme-derived backdrop provides a
repeatable diffusion test; it is not a desktop wallpaper capture. No pixel sampling, physical
lensing, HDR output or automatic content-aware contrast is claimed. Displacement is disabled
in this study. Surface-only DialKit groups are hidden, not reset; versions and Copy Study retain
the authored inputs, and Copy Study also includes resolved material values.

The continuum follows [Apple's macOS 27 release description](https://support.apple.com/en-us/127257),
not the separate regular/clear API variants explained in
[Meet Liquid Glass](https://developer.apple.com/videos/play/wwdc2025/219/).
[Apple's macOS 27 design kits](https://developer.apple.com/news/?id=e2lxw9l1) are available,
but no kit assets have been imported. Identical native screenshots and side-by-side calibration
remain pending; the study is reference-informed, not a fidelity score or native replica.

The working hypothesis is **one lighting grammar, multiple material responses**: quiet work
panes, satin controls, modern glass fixtures. Compare All glass against Sculpted Aqua rather
than assuming every surface should use the same finish. Inspector starts (glass / satin /
porcelain) vary the face sheen, bevel and elevation; Work Pane starts (opaque / frosted /
clear / sculpted) independently vary transmission and dimension. All use the same measured
spatial lighting, including broad, opposing lit/shaded bevels. The labels are visual research
profiles, not claims of physically simulated substances.

Face opacity, blur, tint, lift, bevel, sheen and radius are tunable without remounting the
reading surface or inspector. Canvas → Backdrop Detail adds a decorative grid/pools behind
the pane to make transmission visible. Opacity never dilutes text, but extreme transmission
can still reduce contrast; large-pane blur is a costlier experiment than edge/light movement.
All theme colours and canvas properties come from the production derivation, scoped onto
both the preview and its body portal; tuning never writes app settings or paints the root.
DialKit versions persist only in this browser. **Copy study** includes the authored canvas
and material/light-placement values; its colour pickers flatten alpha over neutral into opaque sRGB stops.

**Lighting follows placement, not a baked global shadow.** Move the K/R sources by pointer
or arrow keys, or move the fixture rail; real screen-space bounds (including the Radix portal)
and explicit surface heights determine distance falloff, lit edges and projected shadows.
A taller neighbour intersecting a centre ray attenuates the light. This is a cheap 2.5D
approximation, not ray tracing, physical refraction or global illumination. Angle resets the
source arrangement; Placement dials and browser-local versions retain the actual positions.

Bounds are cached and invalidated by resize, scroll, layout changes and portal repositioning.
Input is coalesced into one requested frame; there is no idle loop or React render during a
light drag (positions commit on release). Static gradient/shadow textures are reused through
**leaf-only transform/opacity** updates, without changing blur, gradient or shadow recipes.
During a pointer drag only the decorative leaves receive temporary layer-promotion hints,
removed on release/unmount. This makes lighting compositor-friendly; GPU allocation is
browser-dependent, not guaranteed. Backdrop blur/displacement remain extra rendering costs
and need profiling before adoption. With the lab running, `node apps/desktop/scripts/lab-surface-check.mjs`
(`--browser /path/to/chrome` to choose a browser) runs an isolated 90-step real drag,
asserts cached bounds / committed positions / field lifetime / dark and narrow layouts /
independent dial scrolling / real gallery interactions and scoped portal materials,
and reports Chrome paint, raster, main-thread and GPU-compositing evidence. Add
`--preset "All glass"` to measure the large transparent/blurred-pane treatment separately.

**Native Liquid Glass feasibility (research only):** the community
[electron-liquid-glass](https://github.com/Meridius-Labs/electron-liquid-glass) addon wraps
`NSGlassEffectView` behind Electron web content on macOS 26+. This is a native window
material, not a migration of SwiftUI controls into React DOM. Its private `unstable_*`
methods, incomplete view-management API, signing and inactive-window behaviour need a
separate review/spike; nothing native has been installed here. Electron documents a
[Swift/SwiftUI native bridge](https://www.electronjs.org/docs/latest/tutorial/native-code-and-electron-swift-macos),
but its proposed [first-class glass/region API](https://github.com/electron/electron/pull/50415)
was closed unmerged when researched. Built-in vibrancy is a different material. Our React
study remains a theme-derived approximation, not Apple's native compositor.

Blur, tint, rim lighting and lift are the portable experiment. The separately labelled
SVG backdrop displacement is noise distortion, **not physical refraction**, and may be
unsupported by a browser. Do not promote its CSS or dials into production without an
accessibility, browser/performance and light/dark/custom-canvas review. The app-wide audit
and centralized primitive adoption remain separate work, after the language is agreed.
