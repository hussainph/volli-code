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
| Glass | Navigation, inspectors, controls, menus and popovers | Translucent material; navigation samples canvas, writing glass shares the card-family tint |
| Paper | Board, transcript, ticket document and preference forms | Opaque neutral reading surface |

The reading paper stays **`#1e1e1e` in dark appearance and white in light appearance**,
independent of the canvas. Colour belongs to the objects around and on that reading plane:
raised cards, user bubbles, paper wells, under-page fills, controls, edges and muted icon ink
inherit the **first authored canvas stop's hue**, like the accent, not the mesh's `primaryIndex`.
Paper objects use `--surface-secondary` / `--surface-quaternary`: composite the neutral rung
on paper first, then tint the resulting face. Tinting near-white ink before a low-alpha wash
loses the object's visible chroma. Translucent `--fill-*` layers remain distinct for glass
and pressed overlays; they must not be replaced wholesale by opaque paper faces.
One neutral chroma budget is tuned per appearance (`ARC_TUNING.neutralTint`: .035 light /
.032 dark). Seed chroma and vibrancy modulate it; near-grey canvases stay near-grey. Rung
lightness stays independent of canvas luminance. Gamut mapping reduces chroma where needed,
never clips channels to force saturation. These are **pipeline values**, not literals to copy
into components.
Body text stays neutral and opaque; semantic hues and vendor artwork do not follow this tint.
Where a tint and fixed body ink cannot share a surface, the tint yields: writing glass sheds
only the chroma its body label needs under a 7.8% press fill over saturated backdrops, keeping
lightness and hue. The focus ring is also solved against navigation glass and the rail footer
wash, not only paper.

### Canvas sampling is a surface boolean

`GlassSurface tint` selects canvas-sampling navigation glass, not whether generated neutrals
carry colour. It remains a design-time material choice, not a user preference or a new theme axis.

| Surface | Tint | Implementation |
|---|---|---|
| Docked sidebar, inspector | On | `GlassSurface tint` / `.glass[data-tint="true"]` |
| Stationary pane peek | On | `.glass[data-tint="true"]`, live overlay |
| Ordinary menu, popover | Off by default | Shared floating primitive; `PopoverContent tint` opts in |
| Usage popover | On | Existing `PopoverContent tint` caller |
| Buttons, small controls | Off | Tinted generated face; `.glass-control`, no backdrop pass |
| Content paper | No sampling | Neutral opaque `.material-thick` / `.material-solid` |

Navigation glass retains the mock's 46% white / 52% dark neutral veil; ordinary
glass uses 56%. The pane tier has one measured 5.7px blur/tone chain, a static
1px horizontal rim and two soft shadows; no duplicate canvas, SVG or sheen.
Light tone is contrast .44174 / brightness 1.44847 / saturation 1.91139; dark
uses brightness 1.56971 / contrast .61490 / brightness .71240 / saturation 2.79074.
`GlassSurface tier="full"` opts bounded menus, popovers and the search capsule
into cached device-resolution displacement plus 0.4px post-lens reconstruction.
Maps are acquired only on mount/resize, never scroll; oversized overlays stay
pane-tier. At most 16 unused geometries are retained. Small controls use a cheap
inset shadow, never a masked gradient rim. No blur value animates. Glass over
paper, including the composer, uses the same tinted colour family as raised cards,
while the reading paper beneath stays neutral. It is not a duplicate mesh or a raw-accent wash. The composer's legacy `data-tint`
marker selects that writing veil; it does not paint a canvas behind the transcript.

The canvas retains authored hues in both appearances: default pools are 62% /
58% opaque over a neutral floor mixed with the primary at 22% / 26%. Vibrancy
changes opacity, not authored lightness. Grain belongs only to the canvas.

Pinned navigation and stationary peeks use the same optical recipe. Reveal and pin
keep that material unchanged; nested glass and hidden resident panes disable blur.
No blur covers a live terminal or native browser work plane. Reduced-transparency,
stronger-contrast and unsupported-filter fallbacks remain opaque. `--shadow-glass`
and `--shadow-glass-small` provide quiet lift.

### Overlays and scroll edges

All floating UI, including drag ghosts, portals through `ui/overlay-layer.ts` into the
body-level `volli-overlays` layer. It stays free of filters, transforms and containment.
A glass ancestor can establish a fixed-position containing block; raising z-index cannot
repair displaced collision geometry or clipped modals. Shared Radix wrappers retain focus,
scroll-lock, collision and nested Escape behaviour.

Glass over scrolling paper keeps the writing veil's card-family tint. Reuse the bounded source-list/Files edge fade and
transcript viewport mask, fading only cut edges. Reserve the composer's measured height in
content/scroll padding; latest-message controls get a clear band above it. A mask is not a
substitute for making covered text reachable.

### Accent, ink and contrast

- Accent is the **first authored canvas stop**, independent of the mesh's `primaryIndex`.
- `--flow` is a 120-degree gradient through the authored stops. One-stop canvases repeat that
  stop; the pipeline does not invent a second colour. Use flow for meters and large accent
  areas, not a hand-picked orange fill.
- Primary buttons are **tonal**: `--primary-text` accent ink on an accent tint with a same-hue
  sheen. `--accent-tint` is 10%, `--accent-selected` 18%. The legacy `--primary` opaque pair
  still exists; it is not the tonal label token.
- Colour earns its place on identity/state icons, selected and hover fills, prominent text
  and the board Session ring. Raised cards, user bubbles and paper wells carry the quieter
  generated neutral tint, not a raw accent fill. Reading paper and body ink remain neutral.
  Material washes use `--wash-ink`, with a glass-aware polarity on navigation, rather than
  borrowing body ink. Optical black occlusion and white specular light remain neutral.
- `--foreground` is body ink; `--muted-foreground` is opaque secondary;
  `--tertiary-foreground` is the third tier; `--label-ink` sits between body and secondary.
  Do not dilute reading ink with `/50`, `/70` or inherited opacity.
- Token tests hold secondary at **4.5:1** and tertiary at **3:1** on neutral paper, tinted under-page,
  raised cards, selected fills, controls and filtered writing-glass composites across the hue
  spectrum, near-grey/channel extremes, multiple vibrancies and both appearances. Ink yields
  lightness before contrast: a darker selection or a bright glass backdrop can compress the
  secondary hierarchy. The glass filter model is shared by the CSS writer and ink solver. Navigation glass has a separate opaque ink pair solved against its canvas peaks. Small meaningful text
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
| Session composer / user bubble | 24 / 18px corners; 608px composer column including 24px side gutters (560px face) / 420px bubble maximum |
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
navigation after 100ms intent, with no reserved space. The pane reveal/exit uses
170/110ms; the 100ms intent is a dwell, not an animation duration. Focus holds a peek;
Escape dismisses it. ⌘B pins instantly from the keyboard.
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
The project name uses the 13/20px UI rung with the display family and semibold weight.
Two-line primary rows are 46px, with a 20px identity tile and 2px row gaps.
Selected navigation is a neutral ink fill, not an accent outline. The Sessions/Files
choice is a fixed borderless icon row below Home/Automations: a 22px row with
24px targets and 14px glyphs, accent-selected ink, tooltips and arrow-key navigation.
The project header retains only name/key. The inspector keeps its regular
selected-label `ViewSwitcher` pill; Automations uses its text variant. Other choices,
including Board/List, keep compact native icon segments rather than adopting the
inspector's pill.
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
  `mx-auto w-full max-w-content px-gutter`, a 45rem / 720px measure. Ticket title,
  properties and document use `measure="document"`, a 37.5rem / 600px measure.
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
- Vendor/provider logomarks are identity, not interchangeable UI symbols. Preserve the real
  artwork and registry colours through `models/model-identity.tsx`, `SessionGlyph` and
  `ui/brand-marks.tsx`; generic fallbacks apply only when no registered mark exists. Removing
  decorative 3D icons does not remove logos. Keep semantic state badges separate. New vendored
  marks need verified upstream/licence provenance and notice coverage under the repository's
  generated-notices policy, including updated source entries and regenerated notices.
- Model/provider identity uses the catalogue's display name rather than a wire id when known.
  External-app identities can use `IdentityTile`: a centred 32px squircle. Centre marks vertically on two-line rows. Keep one
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
| Pane peek entrance / exit | `GLASS_MOTION.peekIn` / `peekOut` | 170 / 110ms; short translation and opacity |
| Pointer ticket-group disclosure | `GLASS_MOTION.disclosureIn` / `disclosureOut` | 200 / 160ms; sole disclosure-height exception |
| Pointer press | `--duration-press`, `--press-scale` | 120ms, .97 |

The spring tokens are sampled CSS `linear()` curves, not instructions to invent another JS
spring. Segmented's pointer thumb uses snappy; keyboard changes are immediate. Anchored
entrances retain the trigger origin; sheets enter centred. Exits are faster and fade rather
than shrinking away.

Both `prefers-reduced-motion` and the app's **Motion** switch disable foundation motion.
The switch stamps `html[data-motion="off"]`; duration tokens become zero and press scale one.
The shared `hooks/use-reduced-motion` hook and `prefersReducedMotion()` read **both** preferences.
Never import that hook from `motion/react`, which only knows the system preference. Existing
activity indicators keep readable static state under reduced motion. Unknown/programmatic,
keyboard and frequent input settle immediately, including scope repaint and pseudo-elements.
Only sidebar ticket-group disclosure owns measured height: 200ms open / 160ms close for a
pointer. Other RailFold bodies and carets settle instantly.

## Performance is part of the design

- Prefer `transform`, `opacity` and, when necessary, `clip-path`. Continuous pane push,
  actual tab-width cascades and sidebar ticket-group height are explicit layout exceptions,
  not permission for general layout animation. Both pane divider edges read one live
  width; expensive xterm/Monaco/native Browser resize is deferred until it settles.
- Keep backdrop-filter surfaces few and **never nested**. Take materials from primitives,
  not `backdrop-blur-*` at a call site. Native Browser pixels use a still while panes move.
- Material stays fully formed throughout every animation: never toggle backdrop filtering
  off during a push or reveal. Use one resident pane material and one width driver, not a
  second decorative glass shell or competing pour timeline. Duplicate backdrop glass can
  blur text twice or flash its base pose on cancellation. Suppress hover arming while the
  push owns that side; retain ownership through the closed endpoint so a withdrawn pane
  cannot fly back as a peek.
- Preserve virtualisation, memoisation, containment, bounded lists and stable component
  identity. Navigation must not incidentally unmount live terminals or Browser Tabs.
- Measure the interaction under comparable load. Read [performance-signals.md](performance-signals.md)
  for `volli perf` attribution and [performance-benchmark.md](performance-benchmark.md) for
  controlled comparisons. A short shared-machine run is not a performance claim.

### Interaction budgets

These are acceptance targets, not a claim that every existing path meets them. At 60Hz,
measure pane PUSH separately from overlay arrival:

- **Per push:** at most one renderer dropped presented frame, GPU-process busy p95 below
  8ms, covered-frame layout below 4ms, continuous 6px divider gutter. Keep the tail visible
  in evidence; do not compare only endpoints.
- **Arrival:** observed cold chrome within 100ms, warm p95 within one refresh (16.67ms at
  60Hz), zero warm renderer drops across 20 opens, and no renderer task above 50ms. Chrome
  visibility and input-ready are separate observations, not proof of first presented pixel.
- Record three fresh launches of one clean build for a cold/warm cohort, retaining failures.
  A 120Hz refresh budget is 8.33ms; a shared-machine 60Hz sample cannot certify it.

Use renderer `PipelineReporter STATE_DROPPED`, not rAF gaps or batched presentation timestamp
spacing, for drop counts. GPU-process `GPUTask` wall-span occupancy is not hardware utilization
or energy. Missing presentation/layer coverage is unavailable, never measured zero. Separate
frame capture from timing runs and report instrument overhead and unverified cases. The
[design verification reference](../.agents/skills/volli-design/VERIFICATION.md#performance-measurement)
defines the measurement and evidence checklist.

## Copy and feedback

Let controls talk. Labels are nouns; the control explains the choice. No eyebrows repeating a
heading, explanatory paragraphs below controls, tutorial tooltips or marketing adjectives.
Move genuinely necessary detail one interaction deeper, not into every resting row.

Exceptions are narrow: irreversible confirmations, a one-line trust boundary and a blocked
state with its one recovery action. Do not move unwanted prose into an information tooltip
just to satisfy a lint rule. Errors name the failed operation and recovery, not diagnostic
paths or measurements. Surface every requested mutation failure; keep last-good data during
refresh. Do not treat a person's deliberate setting as a fault.

Loading is a state, not punctuation: hold layout and use `Spinner` or `LoadingLabel`,
never skeleton rows/bars, “Loading…” / “Saving…” or a bare ellipsis as progress. An ellipsis on
“Open file…” still means another decision follows. Busy controls retain their accessible
name and disabled semantics. Empty, first-read, refreshing, failed and read-only states
remain distinct. A successful zero-result read alone is empty: pending reserves layout with
one real busy indicator, not an illustration or fabricated zero. Failed reads retain a
noun-specific reason and one recovery, including when the owning list uses silent Inline.

`EmptyState` supplies static, canvas-tinted compositions for Page and Panel placement,
with a short reason heading and at most one real action. Choose a composition by surface
structure (columns, tree, filed cards, connected plugs, book, lock/key, Session rows or search),
not the same icon-in-box fan everywhere. Theme-derived glow and a fading dot matrix stay
decorative, static and hidden from assistive technology; failed art is neutral. An optional
single instruction line earns its place only when the action does not already explain it.
Empty chats remain quiet; inline lists and pickers show no empty caption or illustration. Sidebar reuse takes
`EmptyStateScope tier="inline"`; failed reads remain visible and recoverable. Loading
never flashes a successful empty state, and retained rows survive a failed refresh.

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
stays reachable from its owning surface. Removing visual detail moves it one click deeper
into a real menu, disclosure or editor, never deletes capability. Compare default, hover,
focus-visible, pressed, selected, disabled, empty, loading, error, long names, many items,
drag and reduced-motion states against siblings.

UI work loads [.agents/skills/volli-design](../.agents/skills/volli-design/SKILL.md): establish
fidelity and the feature floor, inspect references, port components into page context, then
stress Empty / Normal / Extreme states before review. The approved mock sets composition;
AppKit informs intent/metrics where it is silent; explicit owner overrides win. Code and tests
remain authoritative for implemented behaviour. Cross-linked `volli-copy`,
`volli-design-references` and `verify-volli` cover wording, precedent and isolated live proof.

Every changed surface needs a main-floor audit: main behaviour/artwork → new behaviour/artwork
→ approved departure or regression → fix/evidence. Include brand marks, not just controls.
Stress zero/one/thousands, long and multilingual content, missing identities, narrow/wide,
light/dark/custom canvases and distinct pending/failed/empty states. Bound or virtualise views
without losing search, keyboard reach or omitted-count truth. Compare built main, candidate
and mock side by side in page context. For motion, inspect consecutive-frame pixels as well
as geometry; a one-frame ghost/slab can pass an endpoint test. See the design skill's
verification reference for capture, stress and performance measurement methods.

### Automated guardrails

CI's **Check design system** step runs token, copy and Glass checks, with their focused tests.
`check:design-tokens` enforces the existing utility ladder; `check:ui-copy` parses screen copy
and markup; `check:glass-design` covers icon-set imports, literal colours, geometry, materials and motion in
renderer TS/TSX/CSS. Tests, fixtures and browser-only lab experiments are excluded.
The clearly named shrinking allowlist records one file/rule pair with an occurrence ceiling:
new pairs or increased counts fail, and fixed pairs must be removed. It is migration debt,
not permission to copy an exception. Run both the linter and `vp check` locally.
