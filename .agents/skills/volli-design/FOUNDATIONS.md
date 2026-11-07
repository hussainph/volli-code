# Foundation decisions

Read the [material](../../../docs/DESIGN.md#three-layers),
[geometry](../../../docs/DESIGN.md#geometry) and
[type](../../../docs/DESIGN.md#type-and-symbols) tables before selecting values.
Those tables describe the production tokens; use the tokens rather than copying their numbers.

## Materials: choose by what is behind the object

- **Canvas** owns the frame, title bar, rail and gutters. Preserve authored hues in both
  appearances; grain belongs here. Accent follows the first authored stop; `--flow` carries
  large accent areas. Persist canvas/appearance, never resolved paint.
- **Paper** holds reading and work: documents, board, transcript, preference forms. Use
  `PaperSurface` or the shared opaque material, not a more opaque version of navigation glass.
  Reading paper stays neutral: `#1e1e1e` dark / white light, emitted by the generator.
  Raised cards, user bubbles, paper wells, controls, borders and muted icon ink carry the
  first canvas stop's generated neutral tint. Paper objects use `--surface-secondary` or
  `--surface-quaternary`: tint the final neutral composite, not ink diluted to near-grey
  by a low alpha. Keep translucent `--fill-*` overlays for glass and pressed states;
  `--wash-ink` is material paint, never body text. Put personality into objects, not paper;
  lightness remains a reading ladder, not the canvas's luminance. Body text stays neutral,
  semantics keep their hues, vendor marks keep their artwork. Primary actions stay tonal.
- **Pane glass** is the default `GlassSurface`: modest blur/tone, quiet rim and shadow.
  Docked navigation and stationary peeks share this recipe. Tint samples canvas; navigation
  over canvas uses `tint`. Glass above paper, including the composer, uses a writing veil
  from the same tinted card family over neutral paper, never a raw-accent wash or duplicate canvas.
  The `tint` boolean selects canvas sampling; it does not switch generated neutral colour off.
  Contrast wins over tint: writing glass yields chroma, never body-ink contrast, and the
  generated ring clears 3:1 on navigation glass as well as paper.
- **Full glass** is an explicit bounded-overlay choice: cached device-resolution lensing,
  with post-displacement reconstruction. Menus/popovers and the search capsule have existing
  callers; do not spread refraction to every control or large pane. Read `ui/glass-optics.ts`
  before changing geometry, caching or filters. Oversized shapes keep the pane fallback.
- **Small controls** use their shared face/inset edge, not another backdrop pass or masked rim.
  Nested glass disables sampling; compose surfaces so that this fallback is not an accidental
  substitute for the intended material. Opaque accessibility/unsupported-filter fallbacks
  must preserve readable hierarchy.

Neutral colour is derived in the shared canvas generator with one chroma budget per
appearance. Never author resolved colours or store new theme axes. Compare warm/cool/purple,
saturated green, near-grey and extreme custom canvases in both appearances and at low/high
vibrancy. Test actual filtered/composited glass and selected/hover fills, not opaque paper
alone. Preserve AA secondary ink (4.5:1), tertiary/non-text ink (3:1), and neutral body ink;
let the ink hierarchy compress when a difficult backdrop needs it.

Keep one resident glass owner during pane movement. A second decorative blurred shell can
blur live text twice, double tint, or flash its unanimated base pose when cancelled. Optimise
without changing the approved material; reducing blur or increasing opacity needs visual review.

For pixelated displacement, inspect unscaled and enlarged crops at the actual DPR. Map
resolution and 8-bit displacement amplitude are different limits. The shared recipe's small
**0.4px post-lens reconstruction blur** softens quantisation; increasing map resolution alone
is not a cure. Keep that fix in the optical primitive, not a page-local blur or heavier frost.

## Floating and scrolling surfaces

Portal every overlay, including drag ghosts and custom floating UI, through `ui/overlay-layer.ts`
to the body-level `volli-overlays` layer. Glass/filter/transform/contain ancestors can turn fixed
positioning into local positioning: a larger z-index cannot fix clipped modals or displaced
collision rectangles. Use the existing Radix wrappers; preserve focus, scroll locks, nested
Escape and outside-click semantics. The overlay layer itself stays free of containment/filters.

At scrolling edges, reuse the source-list/Files fade or the bounded transcript viewport mask.
Fade only cut edges. Reserve measured composer height in content and scroll padding; the
latest-message affordance needs its own clear band. A fade does not make covered text reachable.
Test the true bottom and mid-scroll positions, not a long screenshot assumed to be at bottom.

## Controls, type and rhythm

- Choose `CONTROL_SIZE` in `ui/field-classes.ts` and `ControlShapeProvider` context in
  `ui/control-shape.tsx`. The DESIGN control-size table pairs height, inset and radius.
  Mini/xs/sm content buttons are rounded; default/lg are capsules. Search stays capsule;
  ordinary fields stay rounded. Toolbar image-only controls are circles, text controls
  capsules; sheet button normalisation does not turn every sheet field into a pill.
- Toolbar band/control metrics are separate from regular content sizes. Dense accessory
  chrome uses borderless toolbar actions; bezels identify real content actions. Read
  `ui/button.tsx` and current title-bar callers before changing them.
- Use `Segmented` for compact choices, `ViewSwitcher` for the inspector selected-label pill
  or existing text variant, and `TabStrip` for document/session capsules. Keep each existing
  family's scope; one good pill is not a universal toggle redesign.
- Use the five type rungs and `SectionHeading`. Space Mono serves code/keys, not ordinary
  labels. Regular reading, medium controls, semibold titles; improve hierarchy and whitespace
  before shrinking text or weakening ink. Secondary ink is already contrast-solved: no opacity
  dilution. Check small meaningful text at 4.5:1 and control/focus boundaries at 3:1.
- Reading uses `ContentColumn`, ticket document measure where appropriate; width-consuming
  work uses `WorkbenchColumn`/gutter. Let container width, not just viewport width, choose
  master/detail presentation. Use the shared spacing rhythm and one leading ink axis.
  Dense means bounded and scannable, not smaller type or cramped hit targets.

## Symbols and identity are separate systems

Use semantic exports from `ui/icon.tsx`; vendor glyph imports stay inside that seam. The
shipped set is MIT Hugeicons free Stroke Rounded: outline at 1.5 stroke, **bold equivalent**
2.25 at ≤12px or deliberate heavier strokes. Preserve sizes and accessible naming. The generic
fill rule means a local active/error exception, never generic emphasis; this outline set has
no fill variant. Use state ink/selected background instead of faking fill or importing a solid
set. Duotone is outside the system. Context-menu actions retain neighbouring seam icons.

Provider, harness, OS and sign-in **logomarks are identity**, not semantic UI symbols. Preserve
`ModelMark`/`providerMark`, `SessionGlyph` and `ui/brand-marks.tsx` artwork and registry colours.
Badges describe state separately. A missing registry entry may use a fallback; a known vendor
must not become a generic chat, terminal, pointer or globe. Centre marks on two-line rows.

Before vendoring a mark, verify its exact upstream drawing, version/source, redistribution
licence and required notice. Follow the repository notice policy: declare desktop-owned
sources in `apps/desktop/notices/sources.json`, retain licence text, then regenerate with
`node scripts/generate-third-party-notices.mjs` and check with `--check`. Package-owned
vendored material uses that package's `volli.notices`. Update stale coverage descriptions as
well as generated output. Record provenance even where a permissive licence needs no notice;
unknown rights stay unresolved. Reference screenshots grant no asset redistribution rights.
