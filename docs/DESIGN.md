# Volli Glass

The visual language for Volli's desktop. Code is authoritative: generated colour lives in
`packages/shared/src/theme/`; geometry, materials and motion in renderer `globals.css`;
controls in `components/ui/`. This spec describes those foundations and the rules for adopting
them. Existing surfaces are migrated incrementally; a rule is not a claim that every caller
already follows it.

## Three layers

| Layer | Job | Treatment |
|---|---|---|
| Canvas | Window frame, title bar, rail and gutters | The person's positioned colour stops, vibrancy and grain |
| Glass | Navigation, inspectors, controls, menus and popovers | Clear neutral material; optionally samples the canvas |
| Paper | Board, transcript, ticket document and preference forms | Opaque neutral reading surface |

Paper does not inherit the canvas hue. The pipeline emits white / `#1e1e1e` paper and
`#f6f6f6` / `#282828` under-page neutrals in light / dark appearance. These are **pipeline
values**, not literals to copy into components. Use semantic variables.

### Tint is a surface boolean

Tint is a design-time material choice, not a user preference or a new theme axis.

| Surface | Tint | Implementation |
|---|---|---|
| Docked sidebar, inspector | On | `GlassSurface tint` / `.glass[data-tint="true"]` |
| Stationary pane peek | On | `.glass[data-tint="true"]`, live overlay |
| Ordinary menu, popover | Off by default | Shared floating primitive; `PopoverContent tint` opts in |
| Usage popover | On | Existing `PopoverContent tint` caller |
| Buttons, small controls | Off | `.glass-control`, no backdrop pass |
| Content paper | Never | `.material-thick` / `.material-solid` |

Navigation glass retains the mock's 46% white / 52% dark neutral veil; ordinary
glass uses 56%. The pane tier has one measured 5.7px blur/tone chain, a static
1px horizontal rim and two soft shadows; no duplicate canvas, SVG or sheen.
Light tone is contrast .44174 / brightness 1.44847 / saturation 1.91139; dark
uses brightness 1.56971 / contrast .61490 / brightness .71240 / saturation 2.79074.
`GlassSurface tier="full"` opts bounded menus, popovers and the search capsule
into cached device-resolution displacement plus 0.4px post-lens reconstruction.
Maps are acquired only on mount/resize, never scroll; oversized overlays stay
pane-tier. At most 16 unused geometries are retained. Small controls use a cheap
inset shadow, never a masked gradient rim. No blur value animates. The composer
sits on opaque paper: its boolean tint uses the first authored hue mixed into
the same 46/52% veil, not a second mesh masquerading as a backdrop.

The canvas retains authored hues in both appearances: default pools are 62% /
58% opaque over a neutral floor mixed with the primary at 22% / 26%. Vibrancy
changes opacity, not authored lightness. Grain belongs only to the canvas.

Pinned navigation and stationary peeks use the same optical recipe. Reveal, pin
and pour keep that material unchanged; nested glass and hidden resident panes disable blur.
No blur covers a live terminal or native browser work plane. Reduced-transparency,
stronger-contrast and unsupported-filter fallbacks remain opaque. `--shadow-glass`
and `--shadow-glass-small` provide quiet lift.

### Accent, ink and contrast

- Accent is the **first authored canvas stop**, independent of the mesh's `primaryIndex`.
- `--flow` is a 120-degree gradient through the authored stops. One-stop canvases repeat that
  stop; the pipeline does not invent a second colour. Use flow for meters and large accent
  areas, not a hand-picked orange fill.
- Primary buttons are **tonal**: `--primary-text` accent ink on an accent tint with a same-hue
  sheen. `--accent-tint` is 10%, `--accent-selected` 18%. The legacy `--primary` opaque pair
  still exists; it is not the tonal label token.
- Colour earns its place on identity/state icons, selected and hover fills, prominent text,
  the person's chat bubble and the board Session ring. Reading paper and user message bubbles remain neutral.
- `--foreground` is body ink; `--muted-foreground` is opaque secondary;
  `--tertiary-foreground` is the third tier; `--label-ink` sits between body and secondary.
  Do not dilute reading ink with `/50`, `/70` or inherited opacity.
- Token tests hold secondary at **4.5:1** and tertiary at **3:1** on paper, under-page and
  neutral material pools across multiple canvases and both appearances. Navigation glass has a separate opaque ink pair solved against its canvas peaks. Small meaningful text
  still needs AA 4.5:1: use secondary, not tertiary, for it. Tonal labels are tested against
  their stronger selected tint. Consumer opacity and arbitrary underlying content are not
  covered by a token guarantee.

Colour tokens are generated, never authored in renderer components. Add new names to
`THEME_TOKEN_NAMES` / `CANVAS_TOKEN_NAMES`, then regenerate **both** fallback blocks with
`node apps/desktop/scripts/generate-theme-css.mjs`. Persist canvas and appearance, never the
resolved token set.

## Geometry

Use tokens and primitives, not a locally measured lookalike.

| Object | Geometry |
|---|---|
| Control heights | `control-mini/xs/sm/default/lg`: 16 / 20 / 24 / 28 / 36px |
| Small control corners | `control-mini/small/control`: 4 / 5 / 6px |
| Push button | xs 20px r5; small 24px r6; default 28px and large 36px capsules |
| Forced rounded / text field | 16/20/24/28/36px: r4/5/6/7/9 |
| Toolbar button | Circle with an icon, capsule with text |
| Menu / popover | `radius-menu` / `radius-container`: 12px |
| Menu item | `radius-menu-item`: 5px, 28px row, 4px menu inset |
| Sheet | `radius-sheet`: 14px |
| Floating content card | `radius-floating`: 20px; `--glass-gap`: 6px |
| Sidebar row | `radius-row`: 8px |
| Board card / column | `radius-card` / `radius-column`: 10 / 16px; 236px columns |
| Session composer / user bubble | 24 / 18px corners; 560 / 420px maximum widths |
| Window toolbar | 46px band; 30px glass controls and search |
| Sidebar | 236px default; symmetric 10px row-fill inset, then 8px to ink |
| Inspector | Independent 272px glass card, sibling of the paper perimeter |

Control height and horizontal inset travel together through `CONTROL_SIZE`. Text buttons can
grow for wrapped labels; icon controls keep their square target. Radius aliases `sm/md/lg/xl`
resolve to menu-item/control/control/container, not stock Tailwind sizes. Circles and capsules
use `rounded-full`; zero-radius seams are legitimate resets.

### Border shape follows context

`Button`, `Segmented`, `SelectTrigger` and `Input` take `shape="auto | capsule |
rounded | circle"`. `ControlShapeProvider` supplies toolbar, content, sheet,
popover or sidebar context, including across portals. Explicit shape wins the
auto decision. Search is a capsule at every size; text fields elsewhere stay
rounded. Content, glass, sidebar and popover controls use rounded rectangles at
16/20/24px and capsules at 28/36px. Native toolbar material normalizes items to
28px capsules (square image-only actions are circles); natural alert/sheet
presentation normalizes buttons to 28px capsules, not fields or choices. The
approved title bar keeps its 30px mock pills and the composer keeps its pills.
Explicit shapes remain caller overrides, unlike AppKit's toolbar material which
can override a requested border shape. Shape is separate from tint/material.
A segmented thumb is always filled and follows its track's shape. Fused groups
retain square internal seams.

### Navigation anatomy

The canvas owns the title bar, project rail and 6px gutters. Navigation, paper and
inspector are independent rounded cards. Back/forward and one inner-sidebar toggle form
one leading toolbar group; search is window-centred, usage sits beside it and the
inspector toggle stays at the far right. Pinning changes reserved space, never
ownership or lifetime of the inspector's live subtree. Project tiles summon unpinned
navigation after 100ms intent, with 100ms reveal / 120ms exit and no reserved space.
Focus holds a peek; Escape dismisses it. ⌘B pins instantly from the keyboard.
Rail visibility is in the layout context menu and ⌘⇧S, not a duplicate sidebar glyph.
A hidden rail folds into the Projects and Workspaces menu with selection, reorder,
context actions, add and Workspace switching intact.

Tabs follow Rex: wide capsules on a neutral glass track, a lighter filled selected
capsule, leading identity, title alone and close; Board is icon-only. A grouped
chip's hover card shows its existing items as two-line rows, with existing liveness
at the trailing edge. Its context menu, pane selection, dragging, rename, close and
ungroup behaviour are unchanged. Tab selection has no transition. Pointer opens
and closes cascade actual widths on the shared critical spring, never scale text.
After a pointer close the remaining widths hold until exit or one second idle;
window/pane resizing, keyboard operations and reduced motion are immediate. One `+`
inside the trough opens the anchored Chat / Terminal / Browser chooser; the inspector
uses the same chooser. Direct ⌘T / ⌥⌘T keep existing project/ticket/pane scope,
cloud keeps Chat only, and the Runner picker stays with the control.

Sidebar header, rows, section names and footer share an 18px leading ink inset.
The project name is a measured 15/20px display title, not a new general-purpose type rung.
Two-line primary rows are 46px, with a 20px identity tile and 2px row gaps.
Selected navigation is a neutral ink fill, not an accent outline. The Sessions/Files
choice uses `ViewSwitcher size="small"`, a quiet 24px pill with 14px glyphs,
trailing-aligned in the fixed project header. It falls back to icon-only in a
header narrower than 220px. The inspector keeps its regular pill; Automations
uses its text variant. Other choices, including Board/List, keep compact native
icon segments rather than adopting the inspector's pill.
Home and Automations stay fixed; Active/Previous headings scroll with their list.
Bands, ticket disclosures (32px) and Session rows (46px Active / 32px Previous)
share one flat presentation model with stable keys and offsets. Expanded ticket
children are plain rows, not inset cards. This model is viewport-ready; windowing
and off-window focus routing are separate work.

The empty chat has no title or working-copy chips: a 26×7 practice-history matrix,
three equal-column Sessions / active days / day streak metrics, Session overview
and the anchored composer. The object caps at 640px; the project overview retains
Streak / Board / Venue, while a ticket's overview retains Venue only. Before a
successful history read, show only the composer: no placeholder, skeleton or false zero.

A draft's attachments use one count token opening a bounded manager; the composer
never grows with attachment count. Inspector labels show two bounded pills and a
`+N` searchable editor. Sessions and Automations own independent overflow so their
headings cannot be buried by metadata. Board label pills are neutral; colour stays
in label editors and pickers. A card's animated live ring is separate from its
neutral selection border. Renderer scroll thumbs are trackless and visible only
on scroll or hover.

### Measure and rhythm

- **Tier A, reading:** Ticket body, prose and reading empty states use `<ContentColumn>`:
  `mx-auto w-full max-w-content px-gutter`, a 45rem / 720px measure.
- **Tier B, workbench:** Board, terminals, editors and diffs earn width; align workbench
  edges to the `gutter` token (24px). Settings uses `<WorkbenchColumn>`, capped
  at 80rem / 1280px. Do not put workbenches inside the reading measure.
- `<PageHeader>` owns the single page `h1`, optional actions and wrap-friendly title row.
  Its `reading` variant sits inside the reading column; `workbench` owns its gutter.
- Base spacing is 0 / 4 / 8 / 16 / 24px. Default gap and inset: 8px. Page rhythm may use
  32px above a reading title and 64px at its tail. Measured object geometry (menu padding,
  control insets, two-line row skeletons, pointer drawings) belongs in its primitive, not
  in a growing list of page-specific exceptions.
- Responsiveness first compresses outer whitespace to the gutter; it is not a collection
  of arbitrary breakpoints. Text and title align; boxed composer borders align to the
  column edge. Keep terminal and editor planes full-width where their work needs it.

## Type and symbols

**Settings › Appearance › Style** offers macOS (default, `system-ui` / `-apple-system`) and
Modern (Mona Sans). Project style can inherit or override. Space Mono 400/700 is the app's
monospace; terminals retain the person's Ghostty font.

| Rung | Utility | Size / line height | Job |
|---|---|---|---|
| Label | `text-label` | 11 / 16px | Compact metadata, not section eyebrows |
| UI | `text-ui` | 13 / 20px | Controls, lists, menu rows |
| Body | `text-sm` | 14 / 20px | Prose, inputs, comments |
| Heading | `text-heading` | 18 / 26px | Reading headings |
| Title | `text-title` | 24 / 30px | Reading titles |

No sixth 12px rung and no arbitrary `text-[Npx]`. Use regular for reading, medium for controls,
semibold for titles. Section names use sentence-case `SectionHeading`, not tracked uppercase.

Hugeicons free Stroke Rounded (MIT) is the symbol baseline, behind the semantic
`components/ui/icon.tsx` seam. Import a concept (`SearchIcon`, `BoardIcon`) or use
`<Icon name="search" />`; vendor imports belong only in the seam. Its 24-unit drawing uses
stroke 1.5, stepping to 2.25 for ≤12px symbols and deliberate heavier strokes. Existing
sizes stay unchanged. Mark a local active/error exception through accent/destructive ink
or its existing selected background, never a fake fill. No Pro, bulk, solid or `duotone`.

- Every **context-menu action** carries its neighbouring icon from the shared set through the shared
  primitive. Plain menus need not add decorative icons to every row.
- Prefer a familiar icon over redundant text in cramped chrome, but keep its accessible name,
  tooltip, keyboard shortcut and focus treatment.
- Model/provider identity uses the shared vendor mark (`models/model-identity.tsx`), with the
  catalogue's display name rather than a wire id when known. External-app identities can use
  `IdentityTile`: a centred 32px squircle. Centre marks vertically on two-line rows. Keep one
  cohesive identity treatment, not an unrelated badge drawing per surface.
- Board state is the accent Session ring, not a second provider mark or a “Working” caption.

## Motion

Motion communicates continuity, never makes a person wait. Keyboard-triggered changes and
100+/day interactions (command palette, tab cycling, list navigation, row hover) are immediate.
Do not add entrances to them because a pointer path happens to animate.

| Job / frequency | Shared tokens | Current value |
|---|---|---|
| Occasional pointer selection / default spring | `--duration-snappy`, `--spring-snappy` | 225ms; snappy model .24 / .1 |
| Pane edge / tab width continuity | `--duration-smooth`, `--spring-smooth` | ≤270ms; .20s response, critical damping |
| Drag/drop landing only | `--duration-bouncy`, `--spring-bouncy` | 240ms; .20s response, damping .8 |
| Menu / popover entrance | `--duration-menu-in`, `--ease-out` | 160ms; cubic-bezier(.23,1,.32,1) |
| Menu / popover exit | `--duration-menu-out`, `--ease-out` | 110ms, fade only |
| Sheet entrance / exit | `--duration-sheet` / `--duration-menu-out` | 220 / 110ms |
| Pointer press | `--duration-press`, `--press-scale` | 120ms, .97 |

The spring tokens are sampled CSS `linear()` curves, not instructions to invent another JS
spring. Segmented's pointer thumb uses snappy; keyboard changes are immediate. Anchored
entrances retain the trigger origin; sheets enter centred. Exits are faster and fade rather
than shrinking away.

Both `prefers-reduced-motion` and the app's **Motion** switch disable foundation motion.
The switch stamps `html[data-motion="off"]`; duration tokens become zero and press scale one.
The shared `hooks/use-reduced-motion` hook and `prefersReducedMotion()` read **both** preferences.
Never import that hook from `motion/react`, which only knows the system preference. Existing
activity indicators have separate lifetimes; audit them rather than assuming every legacy
animation has migrated to the foundation tokens.

## Performance is part of the design

- Prefer `transform`, `opacity` and, when necessary, `clip-path`. Continuous pane push,
  actual tab-width cascades and tree/disclosure height are explicit layout exceptions,
  not permission for general layout animation. Both pane divider edges read one live
  width; expensive xterm/Monaco/native Browser resize is deferred until it settles.
- Keep backdrop-filter surfaces few and **never nested**. Take materials from primitives,
  not `backdrop-blur-*` at a call site. Native Browser pixels use a still while panes move.
- Material stays fully formed throughout every animation: never toggle backdrop filtering
  off during a pour or reveal. A pour is decorative, never a scaled live content subtree.
  Suppress pointer re-entry while morphing; a closing pane must not immediately peek again.
- Preserve virtualisation, memoisation, containment, bounded lists and stable component
  identity. Navigation must not incidentally unmount live terminals or Browser Tabs.
- Measure the interaction under comparable load. Read [performance-signals.md](performance-signals.md)
  for `volli perf` attribution and [performance-benchmark.md](performance-benchmark.md) for
  controlled comparisons. A short shared-machine run is not a performance claim.

## Copy and feedback

Let controls talk. Labels are nouns; the control explains the choice. No eyebrows repeating a
heading, explanatory paragraphs below controls, tutorial tooltips or marketing adjectives.
Move genuinely necessary detail one interaction deeper, not into every resting row.

Exceptions are narrow: irreversible confirmations, a one-line trust boundary and a blocked
state with its one recovery action. Do not move unwanted prose into an information tooltip
just to satisfy a lint rule. Errors name the failed operation and recovery, not diagnostic
paths or measurements. Surface every requested mutation failure; keep last-good data during
refresh. Do not treat a person's deliberate setting as a fault.

Loading is a state, not punctuation: use `Spinner`, `LoadingLabel` or geometry-preserving
skeletons, never “Loading…” / “Saving…” or a bare ellipsis as progress. An ellipsis on
“Open file…” still means another decision follows. Busy controls retain their accessible
name and disabled semantics. Empty, first-read, refreshing, failed and read-only states
remain distinct.

## Compose, preserve, verify

**Simplify through primitives.** If a shared primitive fits, adopt it and delete the custom
implementation. Extend one primitive when a real capability is missing; never fork a local
lookalike. `GlassSurface`, `PaperSurface`, `Button`, `Input`, `Select`, `Segmented`, `ListRow`, `SectionHeading`, `Popover`, `HoverCard`,
menus, sheets, `Progress` and `IdentityTile` carry the family resemblance.

Primitives are **open-source-ready**: no app state, domain or host imports; React/Radix, UI
peers and class utilities only. Theme through CSS variables, not an app store. Layout and
feature composition live outside them.

A redesign preserves **feature parity**: every action, state, affordance, permission boundary,
shortcut, accessible name, focus return, tooltip, drag target and empty/loading/error path
stays reachable from the same place. Removing visual detail means disclosing it, not deleting
capability. Compare default, hover, focus-visible, pressed, selected, disabled, empty, loading,
error, long names, many items, drag and reduced-motion states against siblings.

UI work loads [.agents/skills/volli-design](../.agents/skills/volli-design/SKILL.md): zoom out,
choose principles and a proven reference, then design. Verify in the live app with
`verify-volli`, across light/dark and materially different canvases, not screenshots alone.

### Automated guardrails

CI's **Check design system** step runs token, copy and Glass checks, with their focused tests.
`check:design-tokens` enforces the existing utility ladder; `check:ui-copy` parses screen copy
and markup; `check:glass-design` covers icon-set imports, literal colours, geometry, materials and motion in
renderer TS/TSX/CSS. Tests, fixtures and browser-only lab experiments are excluded.
The clearly named shrinking allowlist records one file/rule pair with an occurrence ceiling:
new pairs or increased counts fail, and fixed pairs must be removed. It is migration debt,
not permission to copy an exception. Run both the linter and `vp check` locally.
