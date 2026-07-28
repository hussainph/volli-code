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
in `lab/arc/model.ts` holds the measured values, per mode where the modes disagree:

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

2. **`spreadCurve` is non-monotone above gain 2.0.** It fades a rung's whole distance
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
