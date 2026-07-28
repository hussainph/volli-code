# Arc theming — lab to app

The vivid canvas built in `apps/desktop/src/renderer/lab/arc/` replaces the seed-based
theming system wholesale. This is the plan for doing that in five stacked PRs.

Status: **plan**. The lab side is settled and committed (`6ae34ad`); nothing in
`apps/desktop/src/renderer/src/` has moved yet.

---

## 1. What ships

A **canvas** is what a user authors and saves:

```ts
type Canvas = {
  stops: Stop[];        // the gradient, hand-placed
  primaryIndex: number; // which stop seeds the token ladder
  vibrancy: number;     // chroma boost — also feeds the light ladder's tint gain
  grain: number;        // texture over the gradient
};
```

Everything else about the appearance is **settled** and no longer a setting. `ARC_SETTLED`
in `packages/shared/src/theme/canvas/settled.ts` holds the measured values — every dial as a
`{light, dark}` record, including the two whose modes currently agree, so a later retune is a
one-value edit rather than a signature change:

| setting | light | dark | what it buys |
| --- | --- | --- | --- |
| `lift` | +0.25 | −0.25 | sidebar ΔL ≈ 0.023 off the canvas, both modes |
| `cardTint` | 0.25 | 0.25 | card pulled a quarter of the way to the canvas |
| `surfaceSpread` | 0.943 | 0.627 | rail ΔL 0.0420 / 0.0197 |
| `textWeight` | 0.133 | 0.222 | secondary Lc 69.9 / 64.0, label 51% / 55% |
| `shadow` | 0.75 | 0.75 | — |
| seam | `shell` | `shell` | chrome pinned to the canvas, inner sidebar lifts |

The two lift values look opposed and are the same picture: dark's paper is the *darker*
end of its ladder, so the sidebar rises off the canvas either way.

### The pipeline

```
canvas.stops[primaryIndex] ──> seed hex + chroma (vibrancy)
                                      │
                                      ▼
                          generateThemeTokens()          ← survives, unchanged
                                      │  base ladder
                                      ▼
                    ARC_SETTLED dials, per resolved mode  ← the new stage
                                      │
                                      ▼
                    derived ThemeTokens (31) + veils (3)
                                      │
                                      ▼
                          applyThemeTokens(root)          ← survives, unchanged
```

Alongside the token set, the canvas also produces the gradient background, the
three-rung on-canvas ink ladder, the per-tier lift veils and the three shadow tiers —
all written as custom properties, exactly as `lab/arc/paint.ts` does today.

**`generateThemeTokens` is not deleted.** The dark path does not replace its ladder, it
*moves* it. What dies is the theme catalogue, theme identity, and seed selection.

---

## 2. Decisions

| # | Decision | Choice | Consequence |
| --- | --- | --- | --- |
| 1 | Premade themes | **None ship.** Ember is the built-in default only. | The 6 built-in slugs and everything keyed off them are deleted. |
| 2 | Authoring | **The stop editor ships** as a real feature; users save canvases. | New UI, new persistence, new IPC. |
| 3 | Vibrancy + grain | **Ship with the editor.** | Vibrancy is not cosmetic — it feeds the light ladder's tint gain, so it is a ladder input. |
| 4 | Appearance | **light / dark / auto, global + per-workspace.** | `class="dark"` gets unpinned. Resolution logic doubles. |
| 5 | Legibility | **Solve ink against the canvas; warn when a floor is physically unreachable.** No band clamp. | The old `canvasLayerBackground` read-time clamp is deleted. The editor gains a warning state. |
| 6 | Monaco editor theme | **Keep the separate picker.** | The lab's canvas-derived `arcEditorTheme` **does not port**. The editor is the one surface that will not match the canvas. Only the slug-keyed fallback dies; default becomes One Dark Pro. |
| 7 | Existing theme data | **Reset to Ember.** No seed→canvas conversion. | Migration drops the old rows rather than translating them. |

---

## 3. PR sequence

Stacked. Each is green on its own; the app keeps working throughout because the old
system is not removed until PR5.

### PR1 — the canvas model moves to `@volli/shared`

Port `lab/arc/{model,tokens,surfaces}.ts` to `packages/shared/src/theme/canvas/`, with
their tests. Pure code only — no DOM, no Electron, per the package's contract.
`paint.ts` does **not** move (it writes to `document`); it lands in PR3.

Additive. Nothing consumes it yet. The lab keeps working by importing from `@volli/shared`
instead of its local copy, which is also the proof the port is faithful.

**Done when:** the lab renders identically from the shared module, and the ported tests
pass unchanged apart from import paths.

### PR2 — persistence and IPC

| Item | Shape |
| --- | --- |
| Global canvas | `app_state` key `theme` — payload becomes a `Canvas`, not a `ThemeDefinition` |
| Saved canvases | new `canvases` table: `id`, `name`, `canvas` (JSON), `created_at`, `updated_at` |
| Global appearance | `app_state` key `appearance` — `"light" \| "dark" \| "auto"` |
| Per-workspace | migration **014** adds `projects.theme_canvas_id`, `projects.theme_appearance` |
| Migration 013's 4 columns | left dead (SQLite `DROP COLUMN` is not safe on older versions); stop reading them |
| IPC | replaces the 6 `volli:theme-file-*` channels with canvas CRUD on the same descriptor-table pattern |

The custom-themes-as-JSON-files layer (`shared/theme/custom-themes.ts`,
`main/theme-files.ts`) is **replaced by the table**, not ported. That deletes the slug
path-traversal boundary along with it — worth noting as a security surface that simply
stops existing.

**Export format — decided: version it.** `main/db/export.ts` emits `themeAppSlug` /
`themeSeed` per project in a durable external format. Rather than emit them forever as
dead `null`s, the export gains a version field and drops them, carrying
`themeCanvasId` / `themeAppearance` instead. The importer must accept the previous,
unversioned shape and treat a missing version as v1 — an export taken before this change
is the only kind that exists today, so refusing it would strand the owner's own backups.
Cover both directions with a test.

### PR3 — the paint path

- Port `paint.ts` into `renderer/src/theme/`.
- Rewrite `resolveActiveTheme` for the new shape: **workspace canvas > global canvas >
  Ember**, and independently **workspace appearance > global appearance > auto**.
- Unpin `class="dark"`; drive it from the resolved appearance.
- `watchSystemAppearance` moves out of the lab and becomes real.
- `windowBackgroundColor` in main runs the new pipeline so the window chrome matches
  first paint.
- Regenerate the `globals.css` literal fallback from the new pipeline at Ember.

**First paint — decided: `auto` stays the default, so the flash gets solved, not accepted.**
The CSS fallback can only describe one mode, so on a light system under `auto` first paint
would be dark-Ember and then flip. `globals.css` therefore gains a
`@media (prefers-color-scheme: light)` block holding the light-Ember token set alongside
the dark one.

Two consequences that must not be lost:

- **The new block is generated, exactly like the first.** It is `generateThemeTokens` at
  Ember run through the light ladder, pasted verbatim. The *regenerate, never hand-tune*
  rule in `CLAUDE.md` now covers two blocks, and both must be regenerated together — a
  hand-tuned light block that drifts from the dark one is the failure mode this rule exists
  to prevent.
- **The media query is a first-paint fallback only, not the appearance mechanism.** Once
  the renderer boots, the resolved appearance is authoritative and is written as inline
  custom properties that outrank it. A user on a light system who has explicitly chosen
  dark must not see a light flash on the way in, so the resolved mode has to be readable
  before first paint — persist it somewhere main can read at window construction and hand
  it to the renderer, rather than waiting on a store hydrate. `windowBackgroundColor`
  needs the same value for the same reason.

**Done when:** the app renders the canvas with no theme picker involved, in both modes,
and the terminal repaints through `applyThemeTokens`' existing choke point.

### PR4 — the canvas editor

The stop editor becomes a real surface, replacing `ThemePicker` on Settings → Appearance
and Configure → Appearance. Port the pad, orbs, swatches, stop count, vibrancy and grain
controls from `lab/scratches/canvas.tsx`.

Adds:
- Save / rename / duplicate / delete a canvas.
- Assign as global, or to this workspace.
- The appearance control (light / dark / auto), at both scopes.
- **The capped-contrast warning** (decision 5) — surfaced where a declared floor cannot be
  physically met by the chosen canvas.
- Live preview. Re-target the store's existing `preview` mechanism rather than inventing
  one; it was built for picker hover and does the same job here.

### PR5 — remove the old system

Only now. Full list in §4.

---

## 4. Deletions

| Area | Items |
| --- | --- |
| Catalogue | `renderer/src/theme/catalog.ts` (`BUILTIN_THEMES`, `mergeThemeCatalog`); `shared/theme/builtin-themes.ts` (all 4 exports) |
| Custom-theme files | `shared/theme/custom-themes.ts`; `main/theme-files.ts`; 6 `volli:theme-file-*` channels + guards + preload methods |
| Theme identity | `ThemeDefinition.name` / `.slug`; `PROJECT_TINT_SLUG`, `tintCache`, `tintedTheme`; `ProjectThemeOverride.appThemeSlug` / `.seed` |
| Auto-tint | `autoTintChoice`; `ProjectAppChoice`'s `auto-tint` and `theme` variants |
| Old canvas model | `ThemeCanvas`; all of `shared/theme/canvas.ts` (incl. the legibility band); `renderer/src/theme/canvas-layer.ts` |
| Picker UI | `ThemePicker`, `ThemePickerDialog`, `ThemeEditor`, `theme-picker-model.ts`, `theme-editor-model.ts`; chrome-bar "Change theme" wiring |
| Store | `customThemes`, `favorites`, `recents`, `saveCustomTheme`, `deleteCustomTheme`, `toggleFavorite`, `MAX_RECENT_THEMES`, the persist `partialize`, and the `app_state["volli:theme"]` row |
| Editor coupling | `APP_SLUG_TO_EDITOR_THEME` and the slug arm of `resolveEditorThemeId` |
| Grain (PNG path) | `grain-overlay.tsx`, `grain-128.png`, `scripts/generate-grain.mjs`, `grain.ts`, and their tests — the canvas draws grain as a gradient layer, not a tile |
| Docs | `apps/docs/.../guides/theming.mdx`, `assets/screenshots/theme-picker.png`, the `docs-shots.mjs` step that regenerates it |
| Tests | `catalog.test.ts`, `builtin-themes.test.ts`, `custom-themes.test.ts`, `theme-files.test.ts`, `canvas.test.ts`, `canvas-layer.test.ts`, `theme-picker*.test.*`, `theme-editor-model.test.ts`, grain tests |

## 5. Survives

| Item | Why |
| --- | --- |
| `shared/theme/color.ts` (all 16 exports) | Pure OKLCH/APCA math; the new ladder is built on it |
| `THEME_TOKEN_NAMES`, `ThemeTokens`, `HUE_LOCKED_TOKENS`, `isThemeTokenName` | Still the output contract |
| `generateThemeTokens`, `solveLightnessForContrast`, `neutralChroma`, `pickAccentLabel` | The base ladder both modes build on |
| `shared/theme/veil.ts` | The canvas re-solves veils per paint |
| `applyThemeTokens` + its `refreshTerminalTokenTheme` hook | The single DOM write and the terminal's repaint choke point |
| `scope-transition.ts` | The crossfade is scope-agnostic |
| `windowBackgroundColor` | Main still needs one `--background` hex |
| `app_state` table, `getAllAppState` / `setAppState` | Generic kv; the new payload rides it |
| Editor surface (`editor-themes.ts`, `monaco-theme.ts`, its IPC and kv) | Separate surface — decision 6 |
| Terminal surface (`ghostty-overlay.ts`, `theme-overlay.ts`) | Separate surface, untouched |
| `project-identity.ts` `PROJECT_COLORS` / `projectColor` | Project-tile palette, independent of theming |
| "Never persist resolved tokens" (`apply.ts:6-16`) | Architectural invariant the new system must also honour |

---

## 6. Tests

| Layer | Work |
| --- | --- |
| `@volli/shared` | Ported canvas tests come across as-is (PR1). Add golden-hex coverage for Ember at both modes so a ladder change fails loudly. |
| DB | Migration 014 up/down; canvas CRUD; the reset-to-Ember path from a database holding old slug rows. |
| Store | Rewrite `stores/theme.test.ts` for the new shape. The scope-resolution matrix doubles — canvas × appearance, global × workspace. |
| e2e | **`theming-smoke.mjs` (~1000 lines) is a rewrite, not a patch** — every case drives the picker that no longer exists. `canvas-shots.mjs` and `grain-smoke.mjs` die with the old canvas model. `editor-theme-smoke.mjs` needs its slug-mapping case removed. |
| Local-only | Desktop e2e do not run in CI. Run `theming-smoke`, `editor-theme-smoke` and `live-preview-smoke` locally before shipping each PR that touches the renderer. |

---

## 7. Known defects, to decide before or during the port

Both are pinned by tests in the lab, so neither can drift silently.

1. **A physically unreachable contrast floor.** At light's settled spread of 0.943,
   `--sidebar` lands at L 0.840, where even pure black scores **Lc 74.8 against a declared
   floor of 75**. This is a ceiling, not a solver bug. `lab.css` overrides that token with
   the canvas ink anyway, so the practical impact is nil — but the app must either do the
   same or accept the shortfall explicitly. Pinned by a test asserting the capped set is
   exactly `--sidebar-foreground`, shortfall under 0.5 Lc.

2. **`spreadCurve` is non-monotone above gain 2.0** (appendix § The non-monotone spread curve). It fades a rung's whole distance
   instead of integrating along it, so at light's settled gain of 2.509
   `--border-strong` ends up **ΔL 0.0063 lighter** than `--border-hover` — the ladder
   inverts between two adjacent rungs. Bounded by a test at < 0.01. Left alone
   deliberately: fixing the curve changes the map that 0.943 was chosen against, so it is
   a retune, not a port.

3. **A stale one-pixel rule.** `[data-slot="sidebar-inset"]`'s `margin-left: -1px` in
   `lab.css` was justified by a `--sidebar-width` "fractional-rounding tax" that does not
   exist. With the container's border zeroed, the two halves meet exactly, so it is now a
   pure 1px overlap. Harmless where the sidebar draws no right border; resolve it during
   the port rather than carrying the rationale over.

---

## 8. Risks

- **The e2e rewrite is the single largest piece of work outside the editor UI**, and it
  does not run in CI, so it will only fail locally. Budget for it explicitly.
- **Unpinning `class="dark"`** touches every surface that assumed dark. The light path is
  well-tested in the lab but has never run against the whole app.
- **Decision 6 leaves a visible seam**: the Monaco editor will not match the canvas. That
  is chosen, but it will look like a bug to anyone who did not read this document.
- **`ThemeDefinition` is a mixed type** — part generator input, part catalogue metadata.
  PR1 should split it rather than letting the catalogue fields survive as vestigial.

---

## Appendix — measured derivations

Where the numbers in `packages/shared/src/theme/canvas/` came from. The tables themselves
say what each value **is** and what it costs; this is the sweep, the probe and the
arrangement that lost — the record that makes a later retune an argument rather than a
guess. Every entry is pointed at from the source by name.

Unless stated otherwise, everything was measured on the ember default (`#e8652a`, one stop,
vibrancy 0.6) and then checked across the editor's other seeds.

### Light band

`ARC_TUNING.lightBand.min = 0.83`. At 0.66 the band produces a saturated mid-tone wall that
strands **both** candidate inks near Lc 50 — light scored 56.9, dark 42.1, neither readable.
0.80 is where the band turns genuinely pastel; the last 0.03 buys the few Lc the worst-case
ink score needs once the base fill is counted as a surface (it is: text sits on it wherever
no pool reaches, and a score that exempted it would be an average with extra steps).

### Lift: one mechanism, two signs

`ARC_TUNING.lift` is a signed amount rather than a mode because the two arrangements worth
comparing are the same arrangement with the sign turned over. Measured across seeds at
vibrancy 1, `--background` sits **above** the canvas in light (ember 0.780 → 0.949) and
**below** it in dark (0.276 → 0.176): the dark card is a well cut into a bright wash, not a
panel raised off a dim one.

So "toward paper" is a direction on the ladder, not on the lightness axis, and the same
target produces the frosted reading in both modes — what flips is the sign of the lightness
step. That is also why the sink target is derived (`awayFromPaper` in `elevation.ts`) rather
than declared: hardcoding "sink means darker" would send both signs the same way in dark,
where paper is already the darker end.

### Lift alphas

`ARC_TUNING.lift.liftAlpha` = `{ light: 0.7, dark: 0.5 }`, `sinkAlpha` = `{ light: 0.3,
dark: 0.12 }`.

**Light's 0.7 is high because the headroom is not fixed.** The distance between the canvas
and the paper closes as the canvas gets lighter, and at the top of the light band (a
near-white seed) it is barely 0.10 of lightness for both tiers to divide. At alpha 0.5 the
outer tier's share of that landed at ΔL 0.022 — inside the same invisible range the whole
mechanism exists to escape.

**Dark's 0.5 is lower for the opposite reason, and the number comes from matching what light
delivers rather than from taste.** The overlay composites in sRGB bytes, where the curve is
far steeper near black, so the same alpha buys much more lightness down there. Measured at
0.7 in dark: ember −0.072, a white seed −0.146 — against light's own 0.070–0.119 band across
the same seeds. 0.5 brings dark's top end (−0.101 on white) back inside it.

**What no alpha fixes is the spread across seeds in dark.** A dark blue seed puts the canvas
at L 0.205 with paper at 0.176, so the entire distance this arm can travel is 0.029 and every
setting is invisible. That is a property of that canvas rather than of this number — the fix
is vibrancy or a lighter seed, and the honest behaviour is a mechanism that runs out of room
rather than one that invents some.

**Sinking moves faster than lifting, which is why the two rows are not matched.** Sink walks
toward whatever ink is on the far side of the canvas from the paper: in light that is a dark
overlay on a pastel wash, in dark a near-white one on a dim wash, and both move lightness
faster than their lifting counterpart. At the settled lift, light reads the *lift* row
(+0.25, paper is the lighter end) and dark reads the *sink* row (−0.25, its paper is the
darker end) — and 0.12 against light's 0.7 is what makes those two walks the same length:
**+0.023 and +0.022** on the ember default.

### The frame, and the three arrangements it beat

`ARC_TUNING.lift.shares = [0, 1]` — the outer tier (chrome band, project rail) takes none of
the alpha and the inner sidebar takes all of it.

The settled window insets the sidebar+card unit and runs bare gradient all the way around it.
An outer tier with **any** share would therefore draw a hard edge along every wall of that
frame — chrome band against the 8px above the unit, project rail against the 8px beside it —
and that edge is the sharp chrome the arrangement exists to remove. The frame is meant to
read as one uninterrupted background with a single object floating in it; a lifted band
across its top says the frame has two parts.

Pinning the outer tier to the canvas is what Slack's arrangement actually rests on: its
search bar, workspace rail and the margin around the channel list are all one flat colour,
and the only thing that moves is the inner sidebar.

Three other arrangements were tried against this one — `continuous`, `inset` and `float` —
and each spent some of the alpha out in the frame. The frame is what survived; this row is
what it costs.

### Shadow rungs

`ARC_TUNING.shadow.color` = light `{ L: 0.32, C: 0.05 }`, dark `{ L: 0.06, C: 0.03 }`.

Shadows were originally light-only, on the argument that a near-black canvas has almost no
luminance left for a shadow to remove. The argument is sound and it was about the wrong
backdrop: it describes the **app's** dark theme, whose page sits at L 0.18, not this canvas,
which measures **L 0.21–0.44** across the seeds even in dark. There is real luminance there,
so a shadow buys something in both modes.

Both rungs sit below every canvas their mode can produce, which is the one thing the pair has
to get right. Light's 0.32 clears the light band's floor (0.78 on the darkest seed)
comfortably; reusing it in dark would put the shadow **above** a dim canvas (0.205 on a dark
blue seed) and the halo would glow instead of fall. 0.06 sits under the darkest canvas and
under the paper besides.

Where it bites is uneven in dark, and that is honest rather than fixable in this table:
`card` and `overlay` fall on the canvas and read clearly, while `raised` falls on `--card`
(L 0.20) where there genuinely is little left to remove. Dark signals in-card elevation by
making a surface lighter, which is the token ladder's job.

### The canvas ink ladder

`ARC_TUNING.ink.mutedTowardBase` = `{ min: 0.34, max: 0.2 }`, `mutedFloor = 48`.

**Why a lightness slide rather than a solved Lc floor.** The ink sits at whichever end of the
scale APCA's curve is compressed at. Measured on the ember default, a slide of 0.15 costs
**3.7 Lc in light** (62.4 → 58.7) and **21.3 in dark** (94.1 → 72.8) — the same perceptual
step, two wildly different numbers. Sliding gives one ladder that *looks* the same in both
modes; solving to matched Lc drops would give two that measure the same and look nothing
alike.

**Why the range is centred on 0.27 rather than the 0.15 it replaced.** 0.15 was tuned when
the slide was the only step under the ink; asking it to hold two tiers left both inside the
range where a ladder measures as a ladder and does not read as one. Swept on the running
sidebar at 0.20 / 0.25 / 0.30 / 0.35 / 0.40: 0.20 still crowds the title above it, 0.35 goes
soft, 0.40 is faint. The range spans that verdict, and the settled `textWeight` lands the
slide near its open end — 0.32 in light, 0.31 in dark.

**Why the floor is 48.** The canvas has nothing like the card's headroom: full ink measures
Lc 62.4 on the ember default against body copy's 90 on paper, so a slide that is comfortable
on one gradient can strand the bottom tier on the next. Swept across every swatch the editor
offers, both modes, three vibrancies and one/three stops: the head never drops under Lc 61.9,
and 48 is the floor that still leaves the hardest of those canvases **0.30 of slide** to
spend — enough for the full three rungs. It sits above APCA's 45 for large or bold text,
which is the relevant line for an 11px meta row that the sidebar also promotes to full ink on
hover.

What used to exercise the floor hardest was a strongly sunk canvas, where the veil darkened
the chrome until the head ink itself measured **Lc 37.6** and every rung collapsed onto it.
The settled lift no longer travels anywhere near that far; the floor stays because the seed
does not have to be one of the editor's.

### Surface spread

`ARC_SETTLED.surfaceSpread` = `{ light: 0.943, dark: 0.627 }`, solved for the one rung pair
the complaint was about: `--rail` under `--background`, the tab strip beneath a tab.

- light `0.943` → rail **ΔL 0.0420**. The band that rounds to 0.042 is spread 0.921–0.964.
- dark `0.627` → rail **ΔL 0.0197**, the closest the 8-bit rungs come to 0.020. Band
  0.571–0.683 — and the ceiling at spread 1 is only 0.0242, which is the other half of why
  the two numbers cannot be one.

Both were measured at `cardTint` 0.25 and nowhere else, because the gap is tint-dependent:
the mix pulls every rung toward one target, so the gaps scale by (1 − mix) and a spread
solved at a lower tint lands short.

**Why light needs a bigger correction.** Its rungs were mirrored from `generate.ts` step for
step, and perceptual step size is not symmetric about mid-grey. The dark ladder separates
`--rail` from `--background` by ΔL 0.020 near L 0.17 and it reads clearly; the same 0.020
near L 0.94 is a surface you have to hunt for. That is why the tab strip and the tab on it
were one shape in light mode, and why "UI elements in the inner space lose contrast" was a
report about every panel at once rather than about any one of them.

**Why the multiplier fades out with the drop.** A flat multiplier fixes the surfaces and
wrecks the bottom of the ladder in the same stroke — the border rungs are already far from
paper, so scaling them equally turns hairlines into rules and quietly delivers the heavier
borders that were explicitly not asked for. Fading it means the invisible rungs get the
correction and the working ones are left alone; `--border-strong`, the furthest, does not
move at all.

`DARK_LADDER.spread` is centred so 0.5 is a multiplier of exactly 1.0 — at that position the
ladder is the shipped dark one byte for byte, which is the anchor any later widening must
preserve. The settled 0.627 is gain 1.10: opened, not tightened, because `cardTint` compresses
the gaps and the spread is what buys them back.

### Copy weight

`ARC_SETTLED.textWeight` = `{ light: 0.133, dark: 0.222 }`. Per-mode because the ranges it
indexes start at each generator's own floor — 68 in light, 60 in dark — so one dial position
on two ranges that begin 8 Lc apart is two different asks. The number that was frozen is the
Lc; the weight is read back off it.

- light `0.133` → secondary **Lc 69.9** on `--card`, label **51%** of the way from secondary
  to body. The band satisfying both: 0.122–0.144.
- dark `0.222` → secondary **Lc 64.0**, label **55%**. Band: 0.211–0.233.

**The bug the light floors were raised to fix.** Measured on the shipped default before the
ranges existed, secondary copy scored Lc 60.3 on `--background` — its declared floor — but
**57.0 on `--card`**, which is the surface the ticket rail and every panel actually paint it
on. Two independent fixes: the floors moved, and the solve moved to `--card`. A token solved
against the lightest rung in the ladder is guaranteed to under-deliver on every rung beneath
it.

`LIGHT_FLOORS.secondary`'s ceiling of 82 is set by body, not by taste: body scores about
**84.6** on the card (its 90 is measured a rung up), so a secondary allowed past that would
end up darker than the copy it is subordinate to. Every range is centred so that `textWeight`
0.5 gives **90 / 85 / 75 on the card** — the arrangement that was chosen, and the anchor a
later adjustment should be checked against.

**Why both ranges start at the declared floor rather than centring on it.** Centring was the
first cut in dark, so that weight 0.5 would be a null. The sweep caught it: at weight 0 it
measured **Lc 50.5 against a declared 60**, and `THEME_CONTRAST_FLOORS` is a contract, so a
range whose lower half sits under it can only ever generate violations. Dark's secondary range
is a little wider than light's (18 Lc against 14) because APCA's curve is shallower at the
dark end — the same Lc step buys less visible change on a near-black page than on paper.

### The non-monotone spread curve

`spreadCurve` applies its faded multiplier to a rung's whole distance from paper rather than
integrating it along the way, which makes the map non-monotone once the gain passes 2.0.
Light's settled gain is **2.509**, so `--border-strong` — at the fade's far end, and by design
not moving at all — ends up **ΔL 0.0063 lighter** than `--border-hover`, which is still being
pushed. Measured on ember and never larger across the sweep.

Left rather than fixed, and bounded by a test at < 0.01 (`derive.test.ts`): two hairline
borders a hundredth of a lightness unit out of order, under a ladder whose visible surfaces
all sit above them and whose veil pairs do not involve either. Fixing the curve changes the
map that 0.943 was chosen against, so it is a retune, not a port. See §7.2.
