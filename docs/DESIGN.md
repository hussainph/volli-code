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
| Sidebar, inspector | On | `.glass[data-tint="true"]` or `.material-regular` |
| Ordinary menu, popover | Off by default | Shared floating primitive; `PopoverContent tint` opts in |
| Usage popover | On | Existing `PopoverContent tint` caller |
| Buttons, small controls | Off | `.glass-control`, no backdrop pass |
| Content paper | Never | `.material-thick` / `.material-solid` |

`.glass` and `.material-floating` use a 90% neutral veil and one backdrop pass.
Tinted glass adds viewport-aligned canvas sampling. `.material-regular` samples without a
permanent backdrop pass; thick/solid materials are opaque. Nested glass filters are disabled;
reduced-transparency, stronger-contrast and unsupported-filter fallbacks are opaque.
Glass faces are flat, not bevelled. `--shadow-glass` and `--shadow-glass-small` provide quiet
lift (light large shadow begins `0 4px 16px` at 5.5% black; dark has its own strength).

### Accent, ink and contrast

- Accent is the **first authored canvas stop**, independent of the mesh's `primaryIndex`.
- `--flow` is a 120-degree gradient through the authored stops. One-stop canvases repeat that
  stop; the pipeline does not invent a second colour. Use flow for meters and large accent
  areas, not a hand-picked orange fill.
- Primary buttons are **tonal**: `--primary-text` accent ink on an accent tint with a same-hue
  sheen. `--accent-tint` is 10%, `--accent-selected` 18%. The legacy `--primary` opaque pair
  still exists; it is not the tonal label token.
- Colour earns its place on identity/state icons, selected and hover fills, prominent text,
  the person's chat bubble and the board Session ring. Reading paper remains neutral.
- `--foreground` is body ink; `--muted-foreground` is opaque secondary;
  `--tertiary-foreground` is the third tier; `--label-ink` sits between body and secondary.
  Do not dilute reading ink with `/50`, `/70` or inherited opacity.
- Token tests hold secondary at **4.5:1** and tertiary at **3:1** on paper, under-page and
  bounding glass pools across multiple canvases and both appearances. Small meaningful text
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
| Push button | Regular 28px, r6; small 24px, r5; xs 20px, r4; large 36px capsule |
| Toolbar button | Circle with an icon, capsule with text |
| Menu / popover | `radius-menu` / `radius-container`: 12px |
| Menu item | `radius-menu-item`: 5px, 28px row, 4px menu inset |
| Sheet | `radius-sheet`: 14px |
| Floating content card | `radius-floating`: 20px; `--glass-gap`: 6px |
| Sidebar row | `radius-row`: 8px |
| Board card / column | `radius-card` / `radius-column`: 10 / 16px |

Control height and horizontal inset travel together through `CONTROL_SIZE`. Text buttons can
grow for wrapped labels; icon controls keep their square target. Radius aliases `sm/md/lg/xl`
resolve to menu-item/control/control/container, not stock Tailwind sizes. Circles and capsules
use `rounded-full`; zero-radius seams are legitimate resets.

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
| Pane edge continuity | `--duration-smooth`, `--spring-smooth` | 270ms; smooth model .2 / 0 |
| Drag/drop landing only | `--duration-bouncy`, `--spring-bouncy` | 380ms; bouncy model .3 / .22 |
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

- Animate only `transform`, `opacity` and, when necessary, `clip-path`. These avoid layout;
  `clip-path` is not a guarantee of free compositing. The existing tree/disclosure height
  transition is the deliberate layout exception, not permission for general layout animation.
- Keep backdrop-filter surfaces few and **never nested**. Take materials from primitives,
  not `backdrop-blur-*` at a call site. No blur over live terminal/browser work planes.
- During a pour/morph, set `data-glass-blur="off"` on the surface or ancestor, or
  `PopoverContent blur={false}`. Chrome does not clip backdrop filtering with `clip-path`.
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
lookalike. `Button`, `Input`, `Select`, `Segmented`, `ListRow`, `SectionHeading`, `Popover`,
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
