---
name: volli-design
description: Design or change any Volli desktop UI. Load before feature design, component restyling, visual review or interaction changes; compose the Volli Glass foundations and verify feature parity in the live app.
---

# Design with Volli Glass

Read [docs/DESIGN.md](../../../docs/DESIGN.md) first. Read the relevant production primitives,
`globals.css` and existing callers; code, not a mock, answers what is implemented.

## Method: zoom out → principles → design

1. **Zoom out.** Identify where the surface lives, its scope, why people use it, how often,
   what decision it informs, and its neighbours. Inventory the existing controls and states
   before editing. A beautiful isolated component can still be the wrong object here.
2. **Principles.** Choose canvas/glass/paper, reading/workbench, density, hierarchy and motion
   by purpose and frequency. Consult Apple HIG and a proven native reference. Adopt the
   reference's useful pattern rather than reinventing its ornament. Name the reference in
   review evidence; do not copy third-party assets without redistribution rights.
3. **Design.** Compose shared primitives. Delete custom code only when the primitive genuinely
   replaces it. If it cannot, extend the shared contract or surface the missing decision;
   do not fork a locally themed button or picker. Keep navigation and capabilities familiar.
4. **Verify.** Test interactions and parity, not only the resting screenshot. Compare siblings
   and measure the affected interaction if motion, blur or large lists changed.

## Which primitive?

| Job | Use | Avoid |
|---|---|---|
| Canvas-bearing navigation | `GlassSurface tint`; independent paper via `PaperSurface` | Static opaque imitation of glass |
| Primary action | `Button` default, tonal | Solid hand-picked accent fill |
| Regular action | `Button` outline / secondary | Page-local control recipe |
| Chrome action | `Button variant="toolbar"` | Text-only pseudo-button with no name |
| Inspector value picker | `Button` / `SelectTrigger variant="inspector"` | Heavy outlined pop-ups, double chevrons |
| Exclusive view choice | `Segmented` | Separate custom active pills |
| Search | `Input variant="search"`; `.search-capsule` for compound search | Another outline/radius recipe |
| Navigation or inspection row | `ListRow`, appropriate density | A full-width commit disguised as a row |
| Section name | `SectionHeading` | Uppercase eyebrow |
| Anchored details | `PopoverContent`, `tint` / `blur` props | Call-site backdrop filter |
| Commands / context actions | Shared menu; context-menu action icons | Native `<select>` or custom menu focus logic |
| Confirmation / modal work | Shared dialog / sheet | A second modal and scrim implementation |
| Reading / wide form | `ContentColumn` / `WorkbenchColumn`, `PageHeader` | A reading measure around a board or terminal |
| UI symbol | Semantic icons from `components/ui/icon.tsx` | Direct vendor imports, Pro/bulk/solid/duotone |
| Progress / app identity | `Progress` / `IdentityTile` | Another gradient meter or logo tile |

Primitives have no app/domain/host imports and take their theme from CSS variables. Keep
app stores and mutations in the composition layer. Use `ControlShapeProvider` for toolbar/content/sheet/popover/sidebar context and `shape` for an explicit capsule, rounded rectangle or circle. Dense regular controls are not a mandate to square off toolbar or sheet actions.
Use `CONTROL_SIZE`, radius and ink tokens;
never invent numeric text sizes, transition durations, easings or colour literals.

## Symbols

Use only the MIT Hugeicons free Stroke Rounded set through the semantic icon seam.
Keep caller sizes and accessible names/hidden semantics. Stroke 1.5 is the baseline on
its 24-unit drawing; ≤12px symbols and deliberate heavier strokes use 2.25. Active/error
exceptions use accent/destructive ink or the existing selected background, not fake fill.
Never Pro, bulk, solid or duotone. Context-menu actions always carry a neighbouring shared
symbol. Provider/brand marks and identity tiles retain their own drawings.

## Tint decision

| Surface | Tint? |
|---|---|
| Sidebar / inspector glass | Yes |
| Menu / popover | No by default; opt in only for a canvas-bearing surface (Usage does) |
| Small controls / buttons | No; no backdrop pass |
| Reading paper | Never |

Tint is a per-surface boolean, not a new Settings control. Pinned navigation uses the
same 24px/1.8 optical glass as stationary peeks, never a 90% opaque substitute.
Never nest backdrop filters.
Turn blur off during a morph (`data-glass-blur="off"`, or `blur={false}`). Paper remains neutral;
accent is the first canvas stop. Use `--flow` for large accent areas and meters, tonal for the
primary action. Do not reduce secondary ink opacity: its contrast floor belongs to the token.

## Motion by frequency

| Interaction | Motion |
|---|---|
| Keyboard navigation, command palette, tab cycling, 100+/day rows | None |
| Occasional pointer selection | Snappy: `--duration-snappy` / `--spring-snappy` (225ms) |
| Pane edge continuity | Smooth: `--duration-smooth` / `--spring-smooth` (270ms) |
| Drag landing only | Bouncy: `--duration-bouncy` / `--spring-bouncy` (380ms) |
| Menu / popover | 160ms in, 110ms out; shared ease-out, anchored entrance, fade exit |
| Sheet | 220ms in, 110ms out |
| Pointer press | `--duration-press`, `--press-scale` (120ms, .97) |

Use the tokens, not these numbers at a call site. Animate transform/opacity (clip-path only
when needed), not layout; retain the existing disclosure-height exception. Import
`useReducedMotion` / `prefersReducedMotion` from the shared hook, **not** `motion/react`.
Tabs follow Rex capsules and grouped-item hover lists; behaviour stays with the existing tab model.
Verify both the system preference and the app Motion setting. Do not add perpetual decoration.
Read `docs/performance-signals.md` before changing renderer performance characteristics.

## Parity checklist

For each touched component, record the old path → new path for:

- [ ] Every action, menu item, disclosure, tooltip, badge and shortcut
- [ ] Permission/read-only paths and mutation failures with recovery
- [ ] Default, hover, focus-visible, pressed, selected and disabled states
- [ ] Empty, first load, refresh, error and last-good data
- [ ] Long names, truncation/reveal, overflow, many items and narrow panes
- [ ] Keyboard order, accessible names, focus return and drag/drop targets
- [ ] Reduced motion, app Motion off, and material accessibility fallbacks
- [ ] No incidental unmount of live terminal/browser/session views

Cut redundant visual detail by moving it one interaction deeper, never by removing capability.
No eyebrows or explanatory settings copy. Labels are nouns; prefer familiar icons with names.
No loading ellipses. Keep identity marks centred on two-line rows; context-menu actions keep icons.

## Evidence and checks

- Compare **light and dark**, and materially different canvases (warm, cool, very light and
  dark stops), including actual interactive states. A default-theme snapshot is insufficient.
- Load and follow [verify-volli](../verify-volli/SKILL.md). Launch only its isolated,
  keychain-free build. Snapshot → one action → fresh snapshot; prove side effects through
  host SQL/CLI where relevant. Keep screenshots and transcript outside tracked source.
  Check console/doctor and stop only the instance you launched.
- Run focused tests for changed contracts, package typecheck, `vp check`, and
  `vp run --filter @volli/desktop check:ui-copy` / `check:glass-design`.
  Remove fixed file/rule entries from the shrinking allowlist; do not regenerate migration debt.
- Report what you actually verified, retained capabilities, evidence paths and unresolved
  decisions. Do not call a lab simulation live wiring or a screenshot a full parity audit.
