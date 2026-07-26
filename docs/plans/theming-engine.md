# Theming Engine — Terminal · Editor · App Surface

**Status**: design settled (exploration + grill session, July 2026) · **Branch**: `ui/theming-engine` · **Decisions**: CONCEPT #66–#78, recorded here (the log carries a pointer row) · **Implementation**: **PR 1 shipped** (#119) — spine + terminal surface; PRs 2–5 open and **re-scoped against the code in a July 2026 validation pass** (see § Staging)

Volli gets one theming system spanning three surfaces: the **terminal** (restty/Ghostty), the **code editor** (Monaco), and the **app surface** (chrome, rail, board canvas). The app surface is an Arc-style generative engine — you pick a color, the token set is derived — and a **Project** may override any surface, so appearance becomes an ambient "which project am I in" signal.

This document is the settled record of the design conversation plus the research that grounded it. The research was expensive; it is banked here so no future session re-derives it.

> **Vocabulary.** Per `CONTEXT.md`, a **Project** is a tracked codebase folder; *workspace* is explicitly avoided for it (a **Ticket workspace** is a different, narrower thing). The exploration used "per-workspace theming" informally — everywhere below it means **per-project**.

---

## Settled decisions

Each row was decided explicitly with the owner. "Owner call" marks the two where the owner overruled or improved the recommendation.

| # | Decision | Alternatives rejected | Rationale |
|---|----------|----------------------|-----------|
| 66 | **Three independent surfaces + preset bundles.** Each surface has its own picker and its own source of truth. On top, a **preset** is a named bundle that sets all three at once; overriding one surface afterwards is expected and sticky. | One theme definition owning all three (VS Code model); strict Arc split with no bundle concept | Cohesion without coupling. The terminal's base truth lives in a file Volli does not own (#27), so a single unified theme object cannot be authoritative for all three. A bundle gives the one-click "everything matches" moment without pretending the three surfaces share one owner. |
| 67 | **Terminal: Volli writes a layered overlay, never the user's Ghostty config.** The real Ghostty config stays the read-only base; Volli owns overlay files *in Ghostty's own `key = value` format*, layered with the precedence `overlayGhosttyTheme` already implements. Settings labels every value `Inherited from Ghostty` or `Set by Volli` with one-click revert, and offers to open both files. Presets only ever touch the overlay. | Surgically rewriting `~/.config/ghostty/config` in place (the literal reading of #27); read-only status quo with preview only | #27's warning was against *an app-native terminal settings schema* — an overlay in ghostty's own format layered by ghostty's own rules is not a second schema, it is one more layer, which ghostty itself supports via `config-file` includes and multi-location precedence. Decisive: with #66's presets, writing the real config would silently restyle **Ghostty.app and cmux** because the user clicked a swatch in Volli. kitty independently converged on this exact design (`current-theme.conf` + auto-`include` + commenting out conflicting keys) for the same reason. |
| 68 | **Terminal settings UI = theme + typography; the overlay file takes any key.** The UI exposes a theme picker, font family (via the Local Font Access list already wired for restty), and font size. The overlay file accepts any ghostty key, hand-written, and Volli honors it. | Theme picker only (ghostty's own philosophy: the config file *is* the interface); a full appearance form over every parsed key | The three knobs people actually reach for, without Volli becoming a GUI for a schema ghostty owns and evolves. The file keeps full power available without the UI having to track ghostty's key set. |
| 69 | **A Project may override all three surfaces; inherit by default, per surface.** Resolution is always global → project, **per surface, never per token**, so what is overridden is always obvious. *(Owner call — overruling the recommendation of app-surface-only.)* | App surface only; app surface + terminal background tint with the editor locked global | The owner wants the override to be the same capability as the global setting, just scoped. **Recorded objection, deliberately overruled:** a per-project *editor* theme trades reading speed for signal — syntax colors are a learned language, and unlike chrome you look directly at them. Revisit only if it actually hurts in dogfood; do not relitigate on principle. |
| 70 | **Dark spine, expressive canvas.** Surfaces stay dark; the seed tints the neutral ladder and drives the accent. A separate **canvas layer** behind the framed content card (#31) may be a gradient, mesh, or image. The generator is built lightness-parameterized in OKLCH so a light mode later is new preset data, not a rewrite. | Full light + dark from day one; dark-only pure tint with no canvas layer | A light mode is a genuine design pass (accent contrast, shadow-vs-border language, icon weights, the dot-grid empty state, dynamic `color-scheme` and main-process window background), orthogonal to this work and large enough to sink it. Measured: only **31 hardcoded color sites across 6 files** exist in the renderer, so the *mechanical* cost of light mode is small — it is the judgement that is expensive. Parameterizing now keeps the door open at ~zero cost. |
| 71 | **A theme is `{seed, accent?, grain, canvas}` plus an optional sparse token-override map.** The generator produces the full token set; shipped presets may override the two or three tokens where taste beats math. The theme is a plain file, openable in any editor. | Pure generation with no overrides; a curated hand-authored catalog plus a separate custom-tint generator | Strictly more capable than pure generation at near-zero cost (the override map is usually empty), and it gives the app surface the same "UI for the common case, file for full power" story as the terminal. Two code paths for curated-vs-custom would guarantee the custom path never reaches the curated quality bar. |
| 72 | **Per-project theming is off by default; "Custom" opens with auto-tint pre-selected.** Projects inherit the global theme until deliberately configured. When the user picks *Custom*, the first and pre-selected option is **Auto-tint from this project's color**, derived from the `colorIndex` the project already carries. *(Owner call — better than any option offered.)* | On by default for every project; off by default with no derived option; auto but accent-only | Discovery yields the delightful thing for free without imposing it. Nobody with a strong preference is forced into a look they did not choose, and nobody who opens the panel has to invent a color to get value. |
| 73 | **One picker component, used everywhere.** Searchable, with **Favorites** and **Recent** pinned above **All**, semantic tag chips, live preview as the selection moves, star-to-favorite, and a row `⋯` menu for Duplicate / Rename / Delete / Open file. Invoked identically from global Settings, a project's Configure, and ⌘K. Saving is explicit. | A dedicated visual gallery page plus a quick picker; a settings-only list | The library is the primary interface and the config file is the escape hatch, never the reverse — nobody should *have* to open a file to re-find a theme they liked. One component learned once, three entry points. A gallery is a whole extra surface to design and keep in sync, and splits management across two places. |
| 74 | **Canvas: derived gradients + curated images + your own, with an automatic scrim; cards stay opaque.** Any user image gets a scrim tuned so text on the canvas stays legible. | Gradients and grain only, no images; the full Trello pipeline (per-image luminance analysis driving adaptive text tokens) | This is the owner's Trello reference, reachable without Trello's contrast machinery: our cards are already opaque and #31's framed content card already separates canvas from content, so the only exposure is text drawn directly on canvas — which a fixed scrim solves. |
| 75 | **One seed drives everything; the accent is unlockable.** By default one color input: its hue tints the neutrals at C ≤ 0.014 and drives the accent at C 0.06–0.20. A disclosure unlocks a second, independent accent hue. | One seed, always, with no unlock (strict Arc); two always-visible peer pickers | Because the algorithm separates *hue* from *chroma*, a single seed genuinely yields subtle near-black chrome **and** a punchy accent — one knob covers the 90% case with guaranteed harmony. The unlock exists for the one thing a single seed cannot express: cool grey chrome with a warm accent. |
| 76 | **Presets are theme families that exist in all three catalogs, plus Volli originals.** ~10–12 families (Catppuccin, Tokyo Night, Rosé Pine, Nord, Gruvbox, Dracula, One Dark, Ayu, Solarized, …) each setting the ghostty theme, the shiki theme, and a hand-picked app seed from that family's palette; alongside Volli originals (Ember, Midnight). | Volli-original presets only; no shipped bundles at all | Ghostty's bundled catalog and shiki's overlap heavily by family, so three-surface coverage costs almost no authoring. Developers already identify with a family — "Catppuccin Mocha" in one click is the moment the app feels designed rather than assembled. An empty library on first run never produces that moment. |
| 77 | **Paper Shaders ship as baked stills by default; live animation is opt-in and hard-gated.** Everyone gets the shader library as canvas options, seeded with their theme colors, rendered once at theme-apply time and the GL context disposed. Live animation is a **global-only** toggle (never per-project) behind every guard in [§ Shader guards](#shader-guards). | Live animation as an ordinary option with a "GPU heavy" tooltip; baked stills only, no animation ever | A tooltip is adequate for battery and inadequate for **evicting a live terminal's WebGL context** (see [§ The context-eviction finding](#the-context-eviction-finding)) — users cannot connect a GPU warning to a session that dies twenty minutes later. Baking gets the full Paper aesthetic at zero ongoing cost, so the default path carries no risk at all. |
| 78 | **Ship order: spine first, proved on the cheapest surface.** Generator + token pipeline + persistence + picker land together and are wired to the terminal, whose catalog already exists; the app engine then lands into a proven harness. | Delight-first (app engine leads); three parallel per-surface tracks after a foundation PR | The smallest complete vertical slice validates preview/revert/persistence/overlay-write for near-zero design cost. Building the harness and making the hardest visual judgement calls simultaneously is how both end up mediocre. |

### Derived rules (adopted, not separately debated)

- **Never persist the resolved theme.** `{global theme, project override}` is authoritative; the active theme is derived at render time. VS Code's most-complained-about theming bug is auto-switching writing the *resolved* theme back into the user's setting, overwriting their intent ([#196119](https://github.com/microsoft/vscode/issues/196119), [#126823](https://github.com/microsoft/vscode/issues/126823)).
- **Hue-locked semantic escape list.** `--destructive`, diff add/remove colors, the eight `PROJECT_COLORS`, and label colors **never** follow the seed. Arc needs no such list because its chrome carries no semantic color; ours does. Without it, a red seed makes *delete* indistinguishable from *primary* and a green seed makes diffs unreadable.
- **Color is never the only identity signal.** Linear ships custom global themes and deliberately allows *zero* per-team theming; its context signal is the issue-key prefix. We already have display-ID prefixes (`VC-12`) and project tiles — the tint augments them, never replaces them, so the cue survives colorblindness, screenshots, and users who turn tinting off.
- **Lightness is generator-owned.** The user picks hue and chroma; every `L` in the ladder is a constant in the generator. This is what makes an unreadable theme structurally impossible rather than merely discouraged.
- **The transition carries the signal.** Animate the chrome repaint on project switch. Arc's cross-fade is what makes the color *mean* something — a static color is decoration, a changing one is a notification.

---

## Surface 1 — Terminal

**Before PR 1.** `src/main/ghostty-config.ts` read the user's real config from both macOS locations, merged with ghostty's precedence, resolved the named theme's source, watched for edits, and broadcast over IPC — strictly read-only. It still never writes that file; PR 1 added Volli's own overlay layers on top, and the watch now covers those too, so a hand-edit to an overlay re-themes live terminals exactly like an edit to the real config does. `src/renderer/src/terminal/appearance-model.ts` already implements `overlayGhosttyTheme(base, overlay)` and `resolveGhosttyThemeChoice`, falling back to a theme built from the app's design tokens. `restty` exports `listBuiltinThemeNames`, `getBuiltinTheme`, `getBuiltinThemeSource`, `isBuiltinThemeName` — **ghostty's full theme catalog is already in the bundle**. Verified present by name: Catppuccin Mocha, Dracula, Nord, One Dark, Solarized, Monokai.

**Built in PR 1.**

- **Overlay files**, symmetric across scopes and both hand-editable (`packages/shared/src/theme/ghostty-overlay.ts`):
  - global — `<userData>/volli/ghostty/config`
  - per project — `<userData>/volli/ghostty/projects/<prefix>.config`, the prefix validated with the app's own `isValidPrefix` so a traversal segment is structurally unrepresentable
- **Resolution chain**: user's real ghostty config → Volli global overlay → Volli project overlay, merged with the same last-wins semantics ghostty applies to its own two config locations. The payload carries a per-key `provenance` map, so Settings labels each row without the renderer re-deriving it by diffing layers.
- **Write path in main** (`apps/desktop/src/main/theme-overlay.ts`) — atomic (temp file + same-directory rename), preserves hand-written keys, comments and blank lines, and refuses any path outside `<userData>/volli/ghostty/` **before any filesystem call**. The IPC request names a *scope*, never a path.
- **Picker** over `listBuiltinThemeNames()` with true apply-then-revert preview.
- **Typography controls** — font family from the Local Font Access list, font size stepper.
- Settings rows label each value `Inherited from Ghostty` / `Set by Volli` with revert, plus "Open Ghostty config" and "Open Volli overlay" (using paths that are valid before the file exists).

---

## Surface 2 — Code editor (Monaco)

**Today — and a correction worth recording.** `monaco-theme.ts` synthesizes one theme from CSS variables with four rules (`comment`, `keyword`, `number`, `string`). Those are **theme rules over an inherited `vs-dark`**, not tokenizer rules: `monaco-runtime.ts` registers **no** custom Monarch tokenizer, so Monaco's full built-in grammars are already active. We are not crippling the tokenizer, we are under-specifying the theme. A cheap intermediate improvement therefore exists (a fuller rule set against Monaco's own token types) if shiki ever slips.

**Decision: `@shikijs/monaco` + shiki's JavaScript RegExp engine, fine-grained and lazy.** Bootstrap loads only the default catalog theme and empty langs; late langs/themes bind through a thin MIT-vendored adapter that owns one `themeMap`/`colorMap` and exposes `registerLanguage` / `defineTheme`.

Real TextMate grammars and real VS Code fidelity. `textmateThemeToMonacoTheme()` carries `theme.colors` through to `defineTheme`, so `editor.background`, gutter, selection and **`diffEditor.*`** all come from the theme JSON — the diff editor themes correctly for free, which matters given #48/#51.

| Path | Verdict |
|---|---|
| `@shikijs/monaco` + JS RegExp engine | **Chosen.** ~35 KB gz fixed (core + adapter + `oniguruma-to-es`), ~6 KB per theme, 1–16 KB per language, all dynamically importable. No WASM, no CSP change, no runtime fetch. |
| Same + Oniguruma WASM engine | Second choice. +210 KB gz for maximum grammar compatibility. Worth a ~30-line lazy fallback on a thrown grammar error. |
| `monaco-editor-textmate` + `vscode-textmate` | Rejected — abandoned (peer `monaco-textmate` last published 2019). |
| Theme-JSON → `IStandaloneThemeData` converters | Rejected as the destination — converts *colors* while the accuracy problem is *tokens*. Viable only as a stopgap. |
| `@codingame/monaco-vscode-api` | Rejected — 33.6 MB unpacked, requires replacing `monaco-editor` with their fork. Revisit only if we ever want to host real VS Code extensions. |

**Language workers are untouched.** `setTokensProvider` is orthogonal to `typescript.worker`; IntelliSense, hovers, diagnostics, folding and bracket matching are unaffected. (Shiki [#776](https://github.com/shikijs/shiki/issues/776) concerns `monaco-editor-core`, which ships no workers — we use full `monaco-editor@0.56`.)

**Traps to write into the implementation.** Re-verified against the published `dist/index.mjs` of **`shiki@4.3.1` / `@shikijs/monaco@4.3.1`** (both MIT; the adapter is 9 KB unpacked). Both traps below are still live at that version.

- `shikiToMonaco` builds a fresh local `themeMap` and re-wraps `setTheme` on **every** call — calling it once per lazily-loaded theme stacks wrappers. Call it once; register later themes via the exported `textmateThemeToMonacoTheme()` + `defineTheme()`, or vendor the ~120 MIT lines and own one `themeMap`. Budget half a day. **If you vendor, preserve its `monaco.editor.create` patch** — file editors pass a catalog `theme` in create options and depend on that patch to route through shiki's `setTheme`.
- `createDiffEditor` is **not** patched. Never pass `theme` in diff-editor construction options. Before `createDiffEditor`, call `applyMonacoThemeForDiffEditor(monaco)` from `monaco-theme.ts` (#109 / #122) — it `setTheme`s the active catalog id (pending refresh / `DEFAULT_EDITOR_THEME_ID`); never `"volli-dark"`.
- Import grammars as ES modules (`@shikijs/langs/*` are `.mjs`) so the bundler inlines them. *Nuance found while validating:* the renderer CSP is `default-src 'self'` with no network origins, so external fetch is already impossible — but `volli-app://bundle` is registered `supportFetchAPI` **without** `bypassCSP`, so a *same-origin* fetch would technically succeed. The real reason for static imports is bundling and `base: "./"` correctness, not a hard block (#65). Monaco's own workers are already bundled via Vite `?worker`, not fetched.
- Tune `tokenizeMaxLineLength` (default 20 000) and `tokenizeTimeLimit` (500 ms) so huge or minified files cannot stall the main thread.
- Shiki's per-token color→scope reverse lookup means the emitted scope *string* is arbitrary among same-colored scopes. Colors and font styles are correct; only matters if we ever write CSS against token classes.

**Licensing — resolve before bundling.**

- **Safe (MIT):** Catppuccin, Dracula, One Dark Pro, Nord, Rosé Pine, Ayu, Night Owl, GitHub themes, Vitesse, Cobalt2, Synthwave '84, Shades of Purple; Monokai / Solarized / Dark+ ship inside `microsoft/vscode` (MIT).
- ~~**Flag:** Tokyo Night declares MIT but ships no LICENSE file; Gruvbox unverified~~ — **both resolved, and the whole audit is now automatable.** `shikijs/textmate-grammars-themes` ships `packages/tm-themes/NOTICE` (1597 lines) carrying per-theme SPDX identifiers and license URLs: **Tokyo Night is MIT** with a real `LICENSE.txt`, and **Gruvbox** (jdinhify) is **MIT**, © 2017 JD. Generate `THIRD-PARTY-NOTICES` from that upstream file rather than re-auditing by hand.
- **Do not bundle:** **Monokai Pro** (paid). **Material Theme** — use only antfu's Apache-2.0 fork `antfu/vsc-material-theme`, never the original (Feb 2025 relicensing).
- Ship `THIRD-PARTY-NOTICES` with per-theme copyright lines. Theme *names* are brand marks; nominative use is fine, implying endorsement is not.

---

## Surface 3 — App surface

### Data model

As shipped — `ThemeDefinition` in `packages/shared/src/theme/definition.ts`:

```jsonc
{
  "name": "Ember",
  "slug": "ember",            // stable identity in persistence + the file name
  "seed": "#e8652a",          // hue + chroma; lightness is discarded
  "accent": null,             // null = follows seed; a hex unlocks it (#75)
  "grain": 0.35,
  "canvas": { "kind": "solid" },   // or { kind: "gradient" | "mesh", stops: [...] }
  "overrides": {},            // sparse token map; usually empty
  "appearance": "dark"        // lets the picker group and filter
}
```

### The generator

Pure function in `@volli/shared` — no DOM, fully unit-tested. Emits the **existing `globals.css` token names**, so nothing downstream changes.

1. **Parse** seed → OKLCH `(Ls, Cs, hs)`. Take **only** `hs` and a clamped `Cs`. A seed's lightness must never move the UI's lightness ladder.
2. **Clamp**: `h = hs`; `Caccent = clamp(Cs, 0.06, 0.20)`. A grey seed (`Cs < 0.02`) takes a neutral path with `Cn = 0`.
3. **Neutral chroma**: `Cn = clamp(Cs * 0.06, 0.004, 0.014)` — the muddy-black guard.
4. **Neutral ladder** at fixed `L` with a chroma multiplier `k`, gamut-mapping chroma down at constant `(L, h)` (never RGB-clipping, which shifts hue and lightness):

   The ember column below is the generator's **actual shipped output**, not a hand-computed estimate; the original estimates matched it exactly on three rungs and within one 8-bit step everywhere else.

   | token | L | k | ember (shipped) |
   |---|---|---|---|
   | `--rail` | 0.155 | 0.8 | `#0f0b09` |
   | `--background` | 0.178 | 1.0 | `#15100e` |
   | `--card` / `--sidebar` | 0.200 | 1.1 | `#1b1412` |
   | `--popover` | 0.218 | 1.1 | `#1f1816` |
   | `--secondary` / `--muted` | 0.226 | 1.2 | `#211a17` |
   | `--accent` / `--sidebar-accent` | 0.252 | 1.3 | `#28201d` |
   | `--sidebar-border` | 0.255 | 1.4 | `#29211d` |
   | `--border` / `--input` | 0.269 | 1.4 | `#2d2421` |
   | `--border-hover` | 0.321 | 1.5 | `#3b312d` |
   | `--border-strong` | 0.349 | 1.5 | `#423834` |

5. **Foregrounds — solve, don't guess.** Binary-search `L` at fixed `(h, C)` for an APCA target against its own surface: `--foreground` → **Lc ≥ 90** and `--muted-foreground` → **Lc ≥ 60**, both against `--background`; `--sidebar-foreground` → **Lc ≥ 75** against `--sidebar` (dimmer than `--foreground`, as it ships today). `--card-foreground`, `--popover-foreground`, `--secondary-foreground`, `--accent-foreground` and `--sidebar-accent-foreground` alias `--foreground`.
6. **Accent**: `--primary = oklch(0.661 Caccent h)`, gamut-mapped. `--ring = --primary`. **Ember `#E8652A` is an exact fixed point** — the current brand color falls out of the math. `--primary-text` is the *same* `(h, Caccent)` re-solved by step 5's search to **Lc ≥ 60** on `--background`, because 0.661 is the lightness a button fill needs and it leaves the accent at Lc 41 as body copy. Fills and icons take `--primary`; anything you read takes `--primary-text`.
7. **`--primary-foreground`**: whichever of white / `oklch(0.20 0.05 h)` scores higher APCA on `--primary`, requiring **Lc ≥ 60**. The white/black crossover is L ≈ 0.72.
8. **`--destructive`** stays hue-locked at h ≈ 23, plus the rest of the semantic escape list.
9. **Verify + repair**: assert every pair; on failure adjust **lightness only**, never chroma, and re-run.

**Clamps** (the unreadable-theme guards): neutral C ≤ 0.014 · accent C ∈ [0.06, 0.20] · all `L` values generator-owned constants · `--foreground` Lc ≥ 90 · `--muted-foreground` Lc ≥ 60 · `--primary-foreground` Lc ≥ 60 · `--primary-text` Lc ≥ 60 · `ΔL_oklch(border, background) ≥ 0.07` (APCA low-clips below Lc ~10, so **borders must be asserted in OKLCH ΔL, not APCA**) · `--destructive` hue frozen · grey-seed fallback.

**Tests.** Property test over 360 hues × 5 chromas (every asserted pair meets its floor; every color in sRGB; `L` never perturbed by hue; token set complete against the `globals.css` key list) · monotonicity of the ladder with ΔL ≥ 0.015 between adjacent surfaces · golden test that `generate('#E8652A')` reproduces ember exactly · clamp tests (`#FF0000` → C 0.20, `#808080` → grey path, near-black seed still yields Lc ≥ 90) · determinism and idempotence · **verify APCA against a second implementation (`apca-w3`)**, never the generator's own math.

### Grain

Tiled 128–256px PNG/WebP noise (~2–6 KB), `background-repeat`, opacity 0.015–0.035. **Not** a live SVG `feTurbulence` filter on a large element — rasterize once (build-time, or offscreen canvas) so the compositor never re-runs the filter. One fixed overlay with `pointer-events: none`, `contain: strict`, `will-change: transform` so it becomes its own composited layer and never invalidates on scroll. **Never above text** — noise interacting with subpixel/greyscale AA makes body copy shimmer. Skip entirely behind restty's canvas and Monaco.

### Canvas + shaders

Derived gradients (≤ 3 stops, matching Arc's own ceiling) · curated built-in images · custom image with automatic scrim · Paper Shaders.

**Paper Shaders**: Apache-2.0, zero runtime deps, **WebGL2**, React optional, currently **v0.0.77 — pin exactly**. `colors` takes our theme seed directly. `speed={0}` renders with **no RAF loop**, and `frame` selects which frame. Default path: render one frame to an offscreen canvas, `toDataURL()`, **dispose the context**, use as a CSS background image.

#### The context-eviction finding

Chrome caps live WebGL contexts at **~16 and evicts the *oldest*** on overflow ([crbug 40939743](https://issues.chromium.org/issues/40939743)). `restty-engine.ts` runs `renderer: "auto"` and records the winner in `this.backend` (`"webgpu" | "webgl2"`). On WebGPU, `gpu-session.ts` shares **one** device across all sessions — no pressure. On the **WebGL2 fallback**, every terminal holds its own context, so a full-window shader is +1, and the context Chrome kills is the oldest: statistically the user's primary working session. Our device-loss recovery would mask it just well enough that nobody traces the dead terminal back to the theme picker.

#### Shader guards

Live animation requires **all** of these simultaneously:

- **Hard block when any terminal reports `backend === "webgl2"`.** Non-negotiable — but **not readable today**, contrary to what this section first claimed. `restty-engine.ts` records `backend` privately and types it `string | null` rather than the `"webgpu" | "webgl2"` union; it is absent from the `TerminalEngine` interface; and the registry exports only `getOrCreateEngine` / `getEngine` / `disposeEngine` — no enumeration, no count, no change event (and the backend resolves *asynchronously* after mount, so a change event is required, not optional). That seam is renderer-internal, needs no IPC, and is PR 5's first commit rather than an afterthought.
- Auto-degrade to the baked still above N live GPU contexts (start at 8) — degrade, never error.
- `prefers-reduced-motion` forces the baked still, no exceptions.
- `minPixelRatio: 1` and `maxPixelCount` well under the 8.3M default (the library ships `minPixelRatio: 2`, i.e. double-resolution, by default).
- No grain params on animated shaders — the maintainer's own guidance is that grain defeats resolution reduction.
- Pause on `document.hidden` (free via Electron occlusion tracking with default `backgroundThrottling`) **and** on window blur.
- Permanently revert to the baked still on any `webglcontextlost`; never re-acquire.
- **Global only, never per-project** — per-project shader canvases would recreate a GL context on every project switch, exactly the churn that produces leaks and eviction.

Tooltip copy names the real tradeoff: *"Animated backgrounds run continuously on the GPU your terminals share. On battery, or with many sessions open, Volli will automatically switch back to a still frame."*

---

## Persistence, application, IPC

- **Global theme** → `app_state` kv (#29), key `theme`. **Project override** → four nullable per-surface columns on `projects` (migration 13). *Still to build (PR 2):* custom themes as one JSON file each under `<userData>/volli/themes/<slug>.json`, so "Open file" and "Reveal in Finder" work and a theme stays a shareable artifact (Slack's pasteable-string lesson).
- **Application**: the generator's output is written as CSS custom properties on `document.documentElement`. `globals.css` **authors the generated Ember set** as the literal first-paint fallback — regenerate it, never hand-tune it. `index.html` stays `class="dark"`; `color-scheme: dark` stays pinned under #70.
- The main process runs the **same generator** over the same stored theme for `BrowserWindow` `backgroundColor`, rather than duplicating a literal — so the two cannot drift, and window edges no longer flash the old color on resize and launch.
- **Preview is memory-only.** Moving through the picker applies to the live DOM and **writes nothing**; Enter commits, Escape restores the pre-preview theme. Terminal preview swaps restty's palette; editor preview calls `monaco.editor.setTheme`.
- Themes carry an `appearance` field so the picker can group and filter (Warp's failure to group by its own `details` field is a live user complaint).

---

## Staging

**PR 1 — Spine + terminal. ✅ Shipped.** Generator + APCA/ΔL assertions in `@volli/shared`; CSS-variable application layer; main-process `backgroundColor` follow; persistence (global `app_state` + project columns via migration 13, resolved value never stored); the shared picker with live preview/revert, Favorites, Recent, tags, ⌘K entry; ghostty overlay files (global + per-project) with the atomic write path; terminal theme picker over restty's catalog; font family + size.

Landed with 891 shared + 1778 desktop tests at 100% coverage in both packages, and `apps/desktop/e2e/theming-smoke.mjs` — 11 checks against the real app covering the golden token set, the contrast floors read back out of the live DOM, preview/revert/commit, overlay persistence across relaunch, and the invariant that the user's own ghostty config is byte-identical afterwards.

> **Re-scoped by the post-PR-1 validation pass (July 2026).** PR 1 landed more than its own staging line promised, so PRs 2 and 4 below are smaller than first written and PR 5 is larger. The bullets are what is *genuinely* unbuilt, verified against the code. Each remaining PR is tracked as an issue carrying the same scope, so the work is followable without opening this document: **PR 2 → #121 · PR 3 → #122 · PR 4 → #123 · PR 5 → #124.**

**PR 2 — App engine + presets.** *(#121)* *Already shipped in PR 1, contrary to the original line:* the sparse override map (`generate.ts` applies it last, after verify/repair, and `isTokenOverrideMap` guards it at the storage boundary), the Volli originals — six of them: Ember, Midnight, Moss, Iris, Rose, Graphite — and the Settings → Appearance category that already hosts the picker. Accent unlock is generator-complete too; only its disclosure control is missing. **What remains:** the theme **editor** UI (seed input, accent-unlock disclosure, grain slider); custom themes as one JSON file each under `<userData>/volli/themes/<slug>.json`, behind a new IPC verb and a path guard mirroring `theme-overlay.ts`'s, feeding `ThemePicker`'s already-declared but never-supplied `themes` prop; the `⋯` row actions (Duplicate / Rename / Delete / Open file), which no host wires today so the menu never appears; and actually *rendering* `grain`, which is persisted and read by nothing.

**PR 3 — Editor.** *(#122)* `shiki` + `@shikijs/monaco` (both `4.3.1`, MIT) with the JS RegExp engine; lazy grammars and themes as static `.mjs` ES-module imports; bundled themes with a `THIRD-PARTY-NOTICES` generated from `tm-themes`' upstream `NOTICE`; the `shikiToMonaco` single-call fix; explicit `setTheme` for diff editors. **Family presets become complete across all three surfaces here.** Two gaps PR 1 opened fold in: nothing consumes the already-persisted `editorThemeId` / `theme_editor_id` / `ActiveTheme.editor`, and `applyThemeTokens` refreshes only the terminal — so a theme switch leaves Monaco on the old palette until relaunch. Both legs belong at that same choke point.

**PR 4 — Per-project override.** *(#123)* *Already shipped in PR 1:* the entire data half — migration 13's four columns, the repo layer, IPC, the preload verb, and `resolveActiveTheme` including auto-tint memoization. **What remains is wiring and UI**, starting with a live defect: `hydrate()` is called with no `projectId` and project selection never notifies the theme store, so `projectOverride` is `null` in every real session and the whole per-project path is dead code today. Then: Configure → Appearance as a third category; a project-scope entry point for `ThemePicker` (which hardcodes the global scope and is never called otherwise); the inherit / custom / auto-tint tri-state that finally *writes* a seed derived from `projectColor(colorIndex)`; setters for the terminal and editor surfaces plus a clear-to-inherit action; consumers for `ActiveTheme.terminal` / `.editor`, which are resolved and dropped; and the animated repaint on project switch.

**PR 5 — Canvas.** *(#124)* The canvas layer itself, seed-derived gradient and mesh, the Appearance control; then curated images, custom image + scrim, Paper Shaders baked stills (`@paper-design/shaders` is still at `0.0.77`, so the exact pin holds and it is not yet a dependency), then the gated live-animation toggle. `theme.canvas` was typed, validated and persisted with no reader.

> **Re-scoped again by the validation pass against `1efa45d`.** Two of the three "blocking groundwork" items were already done and the line above no longer claims them. **The static-asset pipeline exists**, inherited from #125: `apps/desktop/src/renderer/src/assets/` module-graph imports (not `public/`, which breaks under `base: "./"` plus the custom protocol once packaged), `assetsInlineLimit: 0`, served over `volli-app://bundle/`. Note `img-src` in `renderer/index.html` is `'self' data:` — **no `blob:`** — which matters only once a shader bake produces a blob URL. **`prefers-reduced-motion` exists too**: `hooks/use-reduced-motion.ts`, a `useSyncExternalStore` hook over one module-shared `MediaQueryList`, already consumed by `board.tsx` and `ticket-card.tsx`; reuse it rather than inventing a second primitive. (The scope crossfade is not a JS reduced-motion path — its 120ms collapse is a pure `globals.css` media query, and the canvas layer inherits it.) The shader guard's plumbing is genuinely the remaining groundwork, and it ships as **PR A** below. The work then split in two: **PR A** `feat/terminal-gpu-backend-seam` — the typed backend union on the `TerminalEngine` interface, a backend-change subscription, registry enumeration and one derived selector, so the future guard imports a seam rather than the registry (counting rule: WebGPU engines share one device via `gpu-session.ts`'s module-global singleton, so any number of them is **1** context, WebGL2 engines are **1 each**, and an unresolved backend counts as a pending conservative context but never asserts `anyWebgl2` — degrading on a maybe is cheap, hard-blocking on a maybe is not). **PR B** `ui/theming-pr5-canvas` — the layer element, the derivation, the storage-boundary cap, the Background control, tests and a smoke. Curated images + scrim, and Paper Shaders + the eight guards, become follow-up issues.

Per CLAUDE.md: branch + PR, never commit to `main`; `vp run -r typecheck` · `vp run -r test` · `vp check`; and **run the relevant `apps/desktop/e2e/*.mjs` smokes locally** — CI does not.

---

## Fold-ins and bugs found

- ~~**`--muted-foreground: #9a9a9a` is APCA Lc 47 against `#111111`**~~ — **fixed in PR 1.** The generator solves it to `#b9b0ad` at exactly Lc 60. (The prediction of OKLCH L 0.762 was almost exact; the solver lands at 0.7636.)
- ~~**`--primary` as text on `--background` is Lc 41**~~ — **fixed in PR 2** by a second generated accent lightness, `--primary-text`, solved to Lc 60 on `--background` by the same binary search as `--foreground`/`--muted-foreground`. Ember lands on `#ff966c` (Lc 60.14 against `--primary`'s 41.39). All seven audited body-sized sites moved onto it — `typeset.css:96` (`.typeset a`, every markdown body link), `archive-dialog.tsx:93`, `ticket-properties.tsx:851`, `button.tsx:19` (the `link` variant), `appearance-settings.tsx:145`, `live-preview.ts:391`, `file-refs.ts:345/348/350` — while icon uses of `text-primary` stayed as they were. Measured over the 360×5 sweep: worst case Lc 60.0001 (seed `#bf558e`), so **the "adjust lightness only" repair of step 9 never fires here** — white on a near-black ladder always clears Lc 60, so the solve cannot fail the way `--primary-foreground`'s can. The token stays a recognisable tint of the accent rather than drifting toward white: L 0.741–0.786 across the sweep, hue within 2.19° of `--primary`. On the lighter surfaces the same copy also lands on it holds 59.57 (`--card`) / 59.10 (`--popover`) / 58.87 (`--secondary`).
- Register any new type/color tokens as classGroups in `cn()` — `twMerge` silently drops unregistered tokens. **`--primary-text` needed no registration, and this was verified rather than assumed**: `@theme inline`'s `--color-primary-text` yields `text-primary-text`, which tailwind-merge's *default* `text-color` group already claims — so it correctly overrides an earlier text color and correctly leaves a `text-ui`/`text-label` font size alone. `lib/utils.test.ts` pins both directions, because the failure mode is silent.

---

## Corrections found while implementing PR 1

The spec above was accurate enough to build from almost verbatim. Four places needed a judgement call; they are recorded here so the next session does not re-derive them, and the resolutions are the shipped behavior.

- **The ladder and the monotonicity test contradict each other.** § Tests asks for ΔL ≥ 0.015 between adjacent surfaces, but the ladder puts `--popover` at 0.218 and `--secondary` at 0.226 — a step of 0.008. **The ladder wins**: it is given explicitly with worked hexes for two hues, and it reproduces what shipped before (`#1a1a1a`/`#1c1c1c` are likewise 2/255 apart). The floor is enforced between surfaces that actually *stack* (rail → background → card → popover) and between every state/edge token and `--background`. `--popover` and `--secondary` never touch: one is a floating surface, the other a control fill. Relatedly, `--accent` (0.252) and `--sidebar-border` (0.255) are below one 8-bit step apart, so the assertion is **non-decreasing**, not strictly increasing — an inversion is the real bug.
- **`--primary-foreground` Lc ≥ 60 is unreachable at some hues.** On a saturated mid-green, white tops out at Lc 59.98 and the dark candidate at 49.4 — *no* label clears the floor. Step 9's "adjust lightness only" is the resolution: the accent's own lightness moves, never its hue or chroma (the two things the user chose). Measured, this fires for **6 seeds in 1800** and never moves more than ΔL 0.0035 — about one 8-bit step. Ember is untouched.
- **The white/dark label choice has no dark branch at the shipped lightness.** `PRIMARY_LIGHTNESS` (0.661) sits below the white/dark crossover (L ≈ 0.72), so white wins at **every** hue and chroma — 0 of 1800 sampled. The repair search is therefore downward-only, with L 0 as a known-legible bound. `pickAccentLabel` is exported and tested in both directions anyway: the dark branch is not dead code, it is what keeps step 7 correct for a light-mode ladder under #70.
- **"Never persist a `--` key" is the wrong formulation of the storage rule.** A theme's sparse `overrides` map is *authored intent* (#71) and legitimately contains token keys. The rule is "never persist the **resolved** set", enforced structurally: `serializeGlobalTheme` rebuilds the payload field by field, so no caller can smuggle a resolved set into storage.

Two smaller facts worth keeping: APCA 0.1.9 gives **107.88 Lc white-on-black / 106.04 black-on-white** (the asymmetry is real, and older reference values circulate); and culori's `clampChroma` is not a cusp finder — it accepts a clipped color once ΔE is small — so the gamut cross-check bisects against culori's converter instead.

## Open questions

- **Do preset *families* need per-family hand-picked app seeds, or is deriving from the family's own accent good enough?** Recommendation: hand-pick for ~12 families; it is an afternoon and the quality difference is visible.
- **Light mode** — deliberately out of scope (#70). The generator is parameterized for it; shipping it is a separate design pass.
- ~~**Does the ⌘K theme entry need a surface selector**~~ — **answered in PR 1 by building it**: ⌘K's *Change theme…* opens the app-surface picker, with the terminal (and later the editor) reachable from Settings → Appearance. No selector was needed; revisit only if the editor surface makes the single entry feel ambiguous.
- **Sharing themes** — the file is already a shareable artifact. Whether to add explicit export/import, or a pasteable string (Slack's model), is deferred until anyone asks.

### Raised by the post-PR-1 validation pass

Four were put to the owner and answered; they are settled and should not be relitigated. The rest still block their PR.

**Answered (July 2026):**

- **The canvas boundary is PR 5, entirely.** PR 2 ships `grain` only. The canvas layer element has one owner, and PR 5 has to build both it and the static-asset pipeline regardless — splitting it would build the layer twice. *(Grain still establishes the asset pipeline first, in PR 2.)*

**Answered (July 2026, PR 5):**

- **The canvas mounts full-window, in the Arc arrangement.** One root-level layer beneath everything: the ChromeBar and the sidebar/rail give up their opaque `--rail` fill and become transparent over it, and only `SidebarInset` stays fully opaque. `kind: "solid"` paints a flat fill of the token the backdrop painted before, so the app is **pixel-identical** until someone picks gradient or mesh. The literal reading of "behind the framed content card" was rejected: against today's shell it would have put the layer on the backdrop row *with the sidebar still opaque*, making the entire expressive layer visible only as the 8px `m-2` gutter — and leaving #74's scrim with nothing to protect. In the Arc arrangement the sidebar's nav labels **are** the text drawn directly on canvas, which is exactly the exposure #74 describes. The mechanism that makes it survivable is a new generated token family, the **veil**: for a token `T` over a base `B`, the generator solves the color that at α 0.10 composites to `T` byte-exactly, so a surface keeps its *relative* rung over any stop instead of a fixed absolute one. Two veils deep, never more — Apple's rule that a light translucent surface never sits on another. Grain does **not** move onto this layer; see `DEFAULT_THEME`'s comment for why the canvas turned out to be the worst place for texture rather than the best.
- **Persist derived `stops`, and clamp on read.** `ThemeCanvas` already persists them and changing that would be a migration for no gain — and per #71 authored intent is a thing themes are allowed to carry. The band (`L ∈ [0.105, 0.170]`, `C ≤ Cn × 1.6` ramping with `L`, hue from the seed) is enforced by clamping **on read**, in the one function that turns a canvas into CSS, which is what makes it non-bypassable regardless of what a hand-edited or shared theme file contains. A shared theme file can therefore differ from what the seed alone would generate; that is intended. Separately, the three-stop ceiling is now enforced where it was only ever documented — `isThemeCanvas`, at the storage boundary — because a fourth stop has no position to sit at and would otherwise be dropped in silence.
- **Two PRs this pass; images and shaders spin out.** See the PR 5 staging note above for the split and the GPU-context counting rule.
- **Images: full #74 — a bundled curated set *plus* a custom user image under `<userData>`.** Recorded now so the follow-up issue starts from a decision. The bundled half rides the existing `assets/` pipeline; the custom half is a genuinely new app-protocol and CSP surface, since `resolvePackagedRendererAsset()` is today a read-only view of the bundled renderer root. Which curated images ship is the owner's pick, not the implementer's.
- **The per-project ghostty overlay file is the source of truth for the terminal surface**, at every scope. It is hand-editable, live-watched and in ghostty's own format, so a hand-edit re-themes live terminals — which is exactly #67/#68. `projects.theme_terminal_name` is therefore redundant: leave it unread and drop it in a later migration rather than teaching two writers to share one file.
- **The Lc 41 fix is a generated `--primary-text` token**, solved to Lc 60 against `--background` by the same binary search that already solves `--foreground` and `--muted-foreground` (step 5). It fixes all seven sites at once and keeps the constraint in the generator rather than in review discipline. Lands in PR 2, with the required `THEME_TOKEN_NAMES` entry and `cn()` classGroup registration.
- **Ship order holds: PR 2 next.** PR 4's *Custom* path reuses PR 2's seed editor, so inverting them would build that control twice.

**Still open:**

- **PR 2 — does editing a built-in theme force a Duplicate first, or mutate in place?** The `onDuplicate` row action implies the former. *Assumed for implementation:* duplicate-on-edit for built-ins; built-ins stay immutable.
- **PR 3 — how many themes ship, and which?** 132 exist upstream; this document says ~30 while #76 says 10–12 families. At ~6 KB gz each, 30 static imports is ~180 KB gz, so the answer also decides bundled-vs-lazy.
- **PR 3 — is the diff editor in scope?** There are zero `createDiffEditor` call sites today, so the trap above is purely prophylactic; it may belong with #48/#51 instead.
- **PR 3 — where does the editor's theme picker live?** Settings → Appearance beside the terminal picker, or a third ⌘K surface. `theme-picker.tsx:47` deliberately left the seam open.
- ~~**PR 5 — which curated images ship**, and is the backend-exposure groundwork its own PR?~~ — **half answered above**: the backend exposure is its own PR (PR A), and images are the full #74 set. Which images, specifically, is still open and belongs to the images follow-up issue.

---

## Sources

Interaction and paradigm research: [Ghostty theme reference](https://ghostty.org/docs/config/reference#theme) · [`ghostty +list-themes`](https://ghostty-org-ghostty.mintlify.app/cli/list-themes) · [kitty themes kitten](https://sw.kovidgoyal.net/kitty/kittens/themes/) · [VS Code themes](https://code.visualstudio.com/docs/configure/themes) · [Zed themes](https://zed.dev/docs/themes) · [Warp custom themes](https://docs.warp.dev/terminal/appearance/custom-themes/) · [Arc Spaces](https://resources.arc.net/hc/en-us/articles/19228064149143-Spaces-Distinct-Browsing-Areas) · [Arc's derived CSS palette](https://ginger.wtf/posts/creating-a-theme-using-arc/) · [Slack themes](https://slack.com/help/articles/205166337-Change-your-Slack-theme) · [Trello accessible theming](https://www.atlassian.com/blog/atlassian-engineering/colorful-and-accessible-theming-in-trello) · [Linear themes](https://linear.app/changelog/2020-12-04-themes) · [Raycast themes](https://manual.raycast.com/themes)

Color science: [material-color-utilities](https://github.com/material-foundation/material-color-utilities/) · [Radix scale semantics](https://www.radix-ui.com/colors/docs/palette-composition/understanding-the-scale) · [Radix composing a palette](https://www.radix-ui.com/colors/docs/palette-composition/composing-a-palette) · [OKLCH vs HSL](https://evilmartians.com/chronicles/oklch-in-css-why-quit-rgb-hsl) · [Leonardo](https://github.com/adobe/leonardo-contrast-colors) · [APCA in a Nutshell](https://git.apcacontrast.com/documentation/APCA_in_a_Nutshell.html)

Editor pipeline: [shiki + Monaco](https://shiki.style/packages/monaco) · [shiki regex engines](https://shiki.style/guide/regex-engines) · [textmate-grammars-themes](https://github.com/shikijs/textmate-grammars-themes) · [Material Theme relicensing](https://biggo.com/news/202502260714_VS-Code-Material-Theme-License-Drama)

Shaders: [Paper Shaders](https://github.com/paper-design/shaders) · [MeshGradient performance thread](https://github.com/paper-design/shaders/issues/188) · [WebGL context eviction](https://issues.chromium.org/issues/40939743) · [Warp battery reports](https://github.com/warpdotdev/warp/issues/12571)
