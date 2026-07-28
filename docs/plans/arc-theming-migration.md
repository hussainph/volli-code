# Arc theming — lab to app

The vivid canvas built in `apps/desktop/src/renderer/lab/arc/` replaces the seed-based
theming system wholesale. This is the plan for doing that.

Status: **in progress**, on one branch rather than five stacked PRs — the owner asked
for the whole migration in one go. The section numbering below still describes the
work in the original order because the commits follow it.

**A validation pass found four of this document's calls wrong.** They are corrected in
place and marked ⚠︎ **superseded** where the original reasoning is worth keeping. The
short version: the export decision rested on an importer that does not exist, the
first-paint decision rested on a CSS mechanism that cannot express the setting, the e2e
rewrite is about a third the size feared, and one "defect" claim is only true at zoom 1.

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
| 2 | Authoring | **The stop editor ships** as a real feature. **One canvas per scope, edited in place** — no named library. | New UI, new persistence, new IPC. ⚠︎ *Superseded in part:* "users save canvases" implied a `canvases` table with save/rename/duplicate/delete. Rejected — Arc itself does not work that way (a Space has one theme you edit), and a library buys a whole management surface for a capability nobody asked for. Migration 014 is two nullable columns on `projects`, not a table. |
| 3 | Vibrancy + grain | **Ship with the editor.** | Vibrancy is not cosmetic — it feeds the light ladder's tint gain, so it is a ladder input. |
| 4 | Appearance | **light / dark / auto, global + per-workspace.** | `class="dark"` gets unpinned. Resolution logic doubles. |
| 5 | Legibility | **Solve ink against the canvas; warn when a floor is physically unreachable.** No band clamp. | The old `canvasLayerBackground` read-time clamp is deleted. The editor gains a warning state. |
| 6 | Monaco editor theme | **Keep the separate picker.** | The lab's canvas-derived `arcEditorTheme` **does not port**. The editor is the one surface that will not match the canvas. Only the slug-keyed fallback dies; default becomes One Dark Pro. |
| 7 | Existing theme data | **Reset to Ember.** No seed→canvas conversion. | The two systems share the `theme` kv key through the transition and each one's payload fails the other's guard, so the reset falls out of the guards rather than needing conversion code. The user's `<userData>/volli/themes/*.json` files are **left on disk**, orphaned — inert, and deleting a user's authored work to tidy up is not a trade this migration gets to make. |
| 8 | Export format | **Do nothing.** ⚠︎ *Reverses the original call.* | The premise was false: `export.ts:5` — "Export only: there is deliberately no import/restore path here." There is no importer to keep compatible, and the document already carries `format` plus a live `schemaVersion` off `PRAGMA user_version`, which becomes 14 for free. Worse, `export.test.ts:257` derives from `PRAGMA table_info('projects')` and requires every column to have an exported field — so "leave 013's columns dead but drop them from the export" was the one option that test forbids. Keep emitting them; add the two new fields. |
| 9 | First paint | **Preload stamps the mode class.** ⚠︎ *Replaces the media-query fallback.* | `@media (prefers-color-scheme: light)` knows the *system*, not the *setting* — a user on a light Mac who chose dark gets a light first paint and a flip, the same flash from the other side. An inline `<script>` is silently blocked by CSP (`index.html:15` has no `'unsafe-inline'`). Preload runs before any page script and main hands it the resolved mode via `additionalArguments`, so it honours an explicit choice, which the media query cannot. |
| 10 | Light mode | **Ships now**, reversing #70's deferral. | The engine's light half is built and tuned; what was never exercised is the app. The terminal is therefore **not** the untouched surface §5 claims — `ghostty-config.ts` always took the `dark:` half of a `light:X,dark:Y` pair, and `terminal/appearance.ts`'s 16-entry fallback palette is hand-tuned for near-black and fails *silently* under light, because the tokens parse either way. |

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
| Global appearance | `app_state` key `appearance` — `"light" \| "dark" \| "auto"` |
| First-paint hint | `app_state` key `first-paint` — `{appearance, background}`, see below |
| Per-workspace | migration **014** adds `projects.theme_canvas` (JSON) and `projects.theme_appearance`, both nullable and independently overridable |
| Migration 013's 4 columns | left dead (SQLite `DROP COLUMN` is not safe on older versions); stop reading them |
| IPC | replaces the 6 `volli:theme-file-*` channels with five **write** channels on the same descriptor-table pattern — reads already ride `volli:data-bootstrap` |

⚠︎ *Superseded:* there is **no `canvases` table** (decision 2) and no `theme_canvas_id`
— a workspace stores its canvas inline, because there is nothing for an id to point at.

The custom-themes-as-JSON-files layer (`shared/theme/custom-themes.ts`,
`main/theme-files.ts`) is **replaced by the columns**, not ported. That deletes the slug
path-traversal boundary along with it — worth noting as a security surface that simply
stops existing. It outlives PR2 in practice: the renderer's picker calls all six channels,
so they die with the picker, not with the storage.

**Export format — decided: nothing to do.** See decision 8. Keep emitting 013's four
fields (a test requires it while the columns exist), add `themeCanvas` / `themeAppearance`
as raw stored strings, and write no version field and no importer.

**The first-paint hint.** Main must set the window background and the mode class before
the renderer boots, and per-workspace scoping (decision 4) means it cannot derive them:
the active workspace lives inside a Zustand persist envelope that `app-state-repo.ts`
deliberately never parses. So the renderer writes back what it actually resolved, and main
reads that one row synchronously at window construction. It is a **hint** — the
`{canvas, appearance}` pair stays authoritative — and one enum plus one hex is not a
resolved token set, so the rule against persisting those is intact.

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

⚠︎ *The mechanism is superseded — see decision 9.* The original call was a
`@media (prefers-color-scheme: light)` block in `globals.css`. It cannot work: that query
knows the **system**, not the **setting**, so a user on a light Mac who explicitly chose
dark gets a light first paint and then a flip — the same flash, arriving from the other
side. And the obvious repair, an inline `<script>` that stamps the class, is silently
blocked by CSP (`index.html:15` carries no `'unsafe-inline'` in `script-src`).

**What ships instead:** preload stamps the class. Preload runs before any page script, and
main has already read the resolved mode out of the `first-paint` hint synchronously at
window construction and passed it in `additionalArguments`. Main sets
`BrowserWindow.backgroundColor` from the same hint, so the window edge is right before the
document paints anything. No media query, no CSP change, and it honours an explicit
choice.

Two consequences that must not be lost:

- **`globals.css` carries two blocks and both are generated** — `:root, :root.dark` and
  `:root.light`. The *regenerate, never hand-tune* rule in `CLAUDE.md` now covers both, and
  they must be regenerated together: a light block that drifts from the dark one is exactly
  the failure that rule exists to prevent. Both must also carry the **canvas** tokens
  (`--canvas`, the ink rungs, the lift veils, the shadow tiers), or first paint shows a
  gradient with no lift, ink or shadows.
- **Neither block is the appearance mechanism.** Once the renderer boots, the resolved
  appearance is authoritative and is written as inline custom properties that outrank both.
  The blocks exist only for the frames before that.

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

### Also dies — missing from the list above

The audit found nine items the original table assigned to neither list. Every one of them
would have compiled after the deletions and been wrong.

| Item | Why it was missed |
| --- | --- |
| `renderer/src/theme/theme-canvas.tsx` + its test | Imports `nextCanvasLayers` from `canvas-layer.ts`; on no list |
| `components/app-shell.tsx:11,12,60,64,214` | Imports `canvasBackground`, reads `.grain`/`.canvas` off the theme. If those fields survive as vestigial, `GrainOverlay` keeps painting a PNG tile **over** the new gradient grain — double grain, no failure |
| `shared/theme/persistence.ts` + `persistence.test.ts` | Owns **both** the dying theme payload and the *surviving* editor kv. Must be split, not deleted — `main/db/theme-repo.ts:18-26` imports five of its exports |
| `shared/theme/definition.ts` | Holds `DEFAULT_THEME`, which Ember-as-default and `window-theme.ts:29` both depend on. §4 deletes `builtin-themes.ts` but `DEFAULT_THEME` was never there |
| `command-palette.tsx:27,34,95-106` | The "Change theme" entry lives here, **not** in `chrome-bar.tsx` as the Picker UI row claims — `chrome-bar.tsx:42,93,95` only holds dialog state |
| `editor-theme-catalog.test.ts:57-99` | Slug-mapping cases; only the e2e counterpart was called out |
| `theme/apply.test.ts:150-235` | Tint/slug-resolve cases |
| `components/theme/project-appearance-model.test.ts`, `editor-settings-model.test.ts` | Auto-tint and `appThemeSlug` cases |
| `globals.css:283-302`, `:174` | The canvas-fade keyframes half of `canvas-layer`, and `html { color-scheme: dark }` |

Plus three dark-only assumptions outside the theming code entirely, live because
decision 10 ships light: `shared/ghostty-config.ts:46`, `terminal/appearance.ts:28-56`,
`components/ui/sonner.tsx:14`. And `renderer/index.html:2-3` and `AGENTS.md:31`, which
both assert the pin as policy.

## 5. Survives

| Item | Why |
| --- | --- |
| `shared/theme/color.ts` (all 16 exports) | Pure OKLCH/APCA math; the new ladder is built on it |
| `THEME_TOKEN_NAMES`, `ThemeTokens`, `HUE_LOCKED_TOKENS`, `isThemeTokenName` | Still the output contract |
| `generateThemeTokens`, `solveLightnessForContrast`, `neutralChroma`, `pickAccentLabel` | The base ladder both modes build on. ⚠︎ **Not "unchanged"** — it takes a `ThemeDefinition`, a type §4 guts. §8 is right that the type must be split; §1 and §5 are wrong. It reads only `seed`, `accent` and `overrides`, so a three-field input type is a faithful narrowing |
| `shared/theme/veil.ts` | The canvas re-solves veils per paint |
| `applyThemeTokens` + its `refreshTerminalTokenTheme` hook | The single DOM write and the terminal's repaint choke point |
| `scope-transition.ts` | The crossfade is scope-agnostic — ⚠︎ but `shouldEaseScopeRepaint` is keyed on projectId alone, so a light↔dark flip has no scope change and would **hard-cut**. Extend the trigger |
| `windowBackgroundColor` | Main still needs one hex — ⚠︎ but it now returns the canvas's **base fill**, not `--background`: with a canvas armed, the card's rung is no longer what Chromium paints at the window edge |
| `app_state` table, `getAllAppState` / `setAppState` | Generic kv; the new payload rides it. ⚠︎ There is no delete verb — removing the stale `volli:theme` row needed a new `deleteAppState` |
| Editor surface (`editor-themes.ts`, `monaco-theme.ts`, its IPC and kv) | Separate surface — decision 6 |
| Terminal surface (`ghostty-overlay.ts`, `theme-overlay.ts`) | ⚠︎ **Not untouched** once light ships — see decision 10 |
| `project-identity.ts` `PROJECT_COLORS` / `projectColor` | Project-tile palette, independent of theming |
| "Never persist resolved tokens" (`apply.ts:6-16`) | Architectural invariant the new system must also honour |

---

## 6. Tests

| Layer | Work |
| --- | --- |
| `@volli/shared` | Ported canvas tests come across as-is (PR1). Add golden-hex coverage for Ember at both modes so a ladder change fails loudly. |
| DB | Migration 014 **up only** — ⚠︎ this runner has no down-migrations (`interface Migration` is `{version, name, sql}`); the original "up/down" row asked for something that does not exist. Plus the reset-to-Ember path from a database holding old slug rows. |
| Store | Rewrite `stores/theme.test.ts` for the new shape. The scope-resolution matrix doubles — canvas × appearance, global × workspace. |
| e2e | ⚠︎ **Not the rewrite this row feared.** Of `theming-smoke.mjs`'s 27 cases (1174 lines, not ~1000), only **7** are picker choreography. Ten assert ghostty-overlay non-mutation and relaunch persistence — surfaces §5 says survive untouched — and ten are scope precedence. It is a new harness around mostly-intact assertions: seed a saved `Canvas` instead of a theme file, enter through the editor instead of `ThemePicker`. `canvas-shots.mjs` (452) and `grain-smoke.mjs` (197) do die with the old canvas model. `editor-theme-smoke.mjs` (287) needs only its case 5 pruned. |
| Local-only | Desktop e2e do not run in CI. Run `theming-smoke` and `editor-theme-smoke` locally before shipping. ⚠︎ `live-preview-smoke.mjs` is **not** a theme smoke — it is 273 lines of Document Mode markdown reveal rules and contains neither "theme" nor "canvas". |

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
   `lab.css` was justified by a `--sidebar-width` "fractional-rounding tax". Zeroing the
   container's `border-right-width` (`lab.css:423-424`) was the real 1px source, so the
   rule is now a pure overlap and should go.

   ⚠︎ But the stated reason is wrong: fractional widths **are** reachable.
   `sidebar-resize-handle.tsx:46` sets the width from `(clientX - startX) / uiScale`, so
   any zoom ≠ 1 produces a non-integer. Drop the rule to 0, but verify at a **zoomed,
   dragged** sidebar rather than assuming integrality.

---

## 8. Risks

- ⚠︎ **The e2e rewrite was over-estimated** — see §6. It is a new harness around
  assertions that mostly survive, not 27 net-new cases. It still does not run in CI, so it
  will only ever fail locally, which is the part of this risk that stands.
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
