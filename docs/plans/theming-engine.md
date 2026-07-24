# Theming Engine — Terminal · Editor · App Surface

**Status**: design settled (exploration + grill session, July 2026) · **Branch**: `ui/theming-engine` · **Decisions**: proposed CONCEPT #66–#78 · **Implementation**: not started

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

**Today.** `src/main/ghostty-config.ts` reads the user's real config from both macOS locations, merges with ghostty's precedence, resolves the named theme's source, watches for edits, and broadcasts over IPC. It is strictly read-only. `src/renderer/src/terminal/appearance-model.ts` already implements `overlayGhosttyTheme(base, overlay)` and `resolveGhosttyThemeChoice`, falling back to a theme built from the app's design tokens. `restty` exports `listBuiltinThemeNames`, `getBuiltinTheme`, `getBuiltinThemeSource`, `isBuiltinThemeName` — **ghostty's full theme catalog is already in the bundle**. Verified present by name: Catppuccin Mocha, Dracula, Nord, One Dark, Solarized, Monokai.

**To build.**

- **Overlay files**, symmetric across scopes and both hand-editable:
  - global — `<userData>/volli/ghostty/config`
  - per project — `<userData>/volli/ghostty/projects/<prefix>.config`
- **Resolution chain**: user's real ghostty config → Volli global overlay → Volli project overlay. Same `overlayGhosttyTheme` merge at each step, so the semantics the user already knows hold at every layer.
- **Write path in main** — the first time Volli writes any config file. Must be atomic (write-temp + rename), must preserve hand-written keys and comments, and must never touch the user's own config.
- **Picker** over `listBuiltinThemeNames()` with true apply-then-revert preview (we render the terminal, so this is a real palette swap, not a sample panel).
- **Typography controls** — font family from the Local Font Access list already wired for restty, font size stepper.
- Settings rows label each value `Inherited from Ghostty` / `Set by Volli` with revert, plus "Open Ghostty config" and "Open Volli overlay".

---

## Surface 2 — Code editor (Monaco)

**Today — and a correction worth recording.** `monaco-theme.ts` synthesizes one theme from CSS variables with four rules (`comment`, `keyword`, `number`, `string`). Those are **theme rules over an inherited `vs-dark`**, not tokenizer rules: `monaco-runtime.ts` registers **no** custom Monarch tokenizer, so Monaco's full built-in grammars are already active. We are not crippling the tokenizer, we are under-specifying the theme. A cheap intermediate improvement therefore exists (a fuller rule set against Monaco's own token types) if shiki ever slips.

**Decision: `@shikijs/monaco` + shiki's JavaScript RegExp engine, fine-grained and lazy.**

Real TextMate grammars and real VS Code fidelity. `textmateThemeToMonacoTheme()` carries `theme.colors` through to `defineTheme`, so `editor.background`, gutter, selection and **`diffEditor.*`** all come from the theme JSON — the diff editor themes correctly for free, which matters given #48/#51.

| Path | Verdict |
|---|---|
| `@shikijs/monaco` + JS RegExp engine | **Chosen.** ~35 KB gz fixed (core + adapter + `oniguruma-to-es`), ~6 KB per theme, 1–16 KB per language, all dynamically importable. No WASM, no CSP change, no runtime fetch. |
| Same + Oniguruma WASM engine | Second choice. +210 KB gz for maximum grammar compatibility. Worth a ~30-line lazy fallback on a thrown grammar error. |
| `monaco-editor-textmate` + `vscode-textmate` | Rejected — abandoned (peer `monaco-textmate` last published 2019). |
| Theme-JSON → `IStandaloneThemeData` converters | Rejected as the destination — converts *colors* while the accuracy problem is *tokens*. Viable only as a stopgap. |
| `@codingame/monaco-vscode-api` | Rejected — 33.6 MB unpacked, requires replacing `monaco-editor` with their fork. Revisit only if we ever want to host real VS Code extensions. |

**Language workers are untouched.** `setTokensProvider` is orthogonal to `typescript.worker`; IntelliSense, hovers, diagnostics, folding and bracket matching are unaffected. (Shiki [#776](https://github.com/shikijs/shiki/issues/776) concerns `monaco-editor-core`, which ships no workers — we use full `monaco-editor@0.56`.)

**Traps to write into the implementation.**

- `shikiToMonaco` snapshots `getLoadedThemes()` and re-wraps `setTheme` on **every** call — calling it once per lazily-loaded theme stacks wrappers. Call it once; register later themes via the exported `textmateThemeToMonacoTheme()` + `defineTheme()`, or vendor the ~120 MIT lines and own one `themeMap`. Budget half a day.
- `createDiffEditor` is **not** patched. Always call `monaco.editor.setTheme(id)` explicitly instead of passing `theme` in diff-editor options.
- Import grammars as ES modules (`@shikijs/langs/*` are `.mjs`) so the bundler inlines them — no runtime `fetch()` under the custom app protocol (#65).
- Tune `tokenizeMaxLineLength` (default 20 000) and `tokenizeTimeLimit` (500 ms) so huge or minified files cannot stall the main thread.
- Shiki's per-token color→scope reverse lookup means the emitted scope *string* is arbitrary among same-colored scopes. Colors and font styles are correct; only matters if we ever write CSS against token classes.

**Licensing — resolve before bundling.**

- **Safe (MIT):** Catppuccin, Dracula, One Dark Pro, Nord, Rosé Pine, Ayu, Night Owl, GitHub themes, Vitesse, Cobalt2, Synthwave '84, Shades of Purple; Monokai / Solarized / Dark+ ship inside `microsoft/vscode` (MIT).
- **Flag:** **Tokyo Night** declares MIT in `package.json` but ships **no LICENSE file**. **Gruvbox** — unverified on both common sources; verify or drop.
- **Do not bundle:** **Monokai Pro** (paid). **Material Theme** — use only antfu's Apache-2.0 fork `antfu/vsc-material-theme`, never the original (Feb 2025 relicensing).
- Ship `THIRD-PARTY-NOTICES` with per-theme copyright lines. Theme *names* are brand marks; nominative use is fine, implying endorsement is not.

---

## Surface 3 — App surface

### Data model

```jsonc
{
  "name": "Ember",
  "seed": "#E8652A",          // hue + chroma; lightness is discarded
  "accent": null,             // null = follows seed; a hex unlocks it (#75)
  "grain": 0.35,
  "canvas": { "kind": "mesh", "stops": ["#2A1207", "#0D0D0D"] },
  "overrides": { "--border-strong": "#4A3227" }   // sparse; usually empty
}
```

### The generator

Pure function in `@volli/shared` — no DOM, fully unit-tested. Emits the **existing `globals.css` token names**, so nothing downstream changes.

1. **Parse** seed → OKLCH `(Ls, Cs, hs)`. Take **only** `hs` and a clamped `Cs`. A seed's lightness must never move the UI's lightness ladder.
2. **Clamp**: `h = hs`; `Caccent = clamp(Cs, 0.06, 0.20)`. A grey seed (`Cs < 0.02`) takes a neutral path with `Cn = 0`.
3. **Neutral chroma**: `Cn = clamp(Cs * 0.06, 0.004, 0.014)` — the muddy-black guard.
4. **Neutral ladder** at fixed `L` with a chroma multiplier `k`, gamut-mapping chroma down at constant `(L, h)` (never RGB-clipping, which shifts hue and lightness):

   | token | L | k | ember h=42 | blue h=255 |
   |---|---|---|---|---|
   | `--rail` | 0.155 | 0.8 | `#0f0b0a` | `#0a0c10` |
   | `--background` | 0.178 | 1.0 | `#15100e` | `#0e1116` |
   | `--card` | 0.200 | 1.1 | `#1b1412` | `#13161b` |
   | `--popover` | 0.218 | 1.1 | `#1f1916` | `#171a1f` |
   | `--secondary` / `--muted` | 0.226 | 1.2 | `#211a18` | `#181c22` |
   | `--accent` | 0.252 | 1.3 | `#28201d` | `#1e2228` |
   | `--border` / `--input` | 0.269 | 1.4 | `#2c2421` | `#22272d` |
   | `--border-hover` | 0.321 | 1.5 | `#3a312d` | `#2e343b` |
   | `--border-strong` | 0.349 | 1.5 | `#413834` | `#353b42` |

5. **Foregrounds — solve, don't guess.** Binary-search `L` at fixed `(h, C)` for an APCA target against `--background`: `--foreground` → **Lc ≥ 90**; `--muted-foreground` → **Lc ≥ 60**.
6. **Accent**: `--primary = oklch(0.661 Caccent h)`, gamut-mapped. `--ring = --primary`. **Ember `#E8652A` is an exact fixed point** — the current brand color falls out of the math.
7. **`--primary-foreground`**: whichever of white / `oklch(0.20 0.05 h)` scores higher APCA on `--primary`, requiring **Lc ≥ 60**. The white/black crossover is L ≈ 0.72.
8. **`--destructive`** stays hue-locked at h ≈ 23, plus the rest of the semantic escape list.
9. **Verify + repair**: assert every pair; on failure adjust **lightness only**, never chroma, and re-run.

**Clamps** (the unreadable-theme guards): neutral C ≤ 0.014 · accent C ∈ [0.06, 0.20] · all `L` values generator-owned constants · `--foreground` Lc ≥ 90 · `--muted-foreground` Lc ≥ 60 · `--primary-foreground` Lc ≥ 60 · `ΔL_oklch(border, background) ≥ 0.07` (APCA low-clips below Lc ~10, so **borders must be asserted in OKLCH ΔL, not APCA**) · `--destructive` hue frozen · grey-seed fallback.

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

- **Hard block when any terminal reports `backend === "webgl2"`.** Non-negotiable; readable today.
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

- **Global theme** → `app_state` kv (#29). **Project override** → columns on `projects`. Custom themes → one JSON file each under `<userData>/volli/themes/<slug>.json`, so "Open file" and "Reveal in Finder" work and a theme stays a shareable artifact (Slack's pasteable-string lesson).
- **Application**: the generator's output is written as CSS custom properties on `document.documentElement`. `globals.css` keeps its current values as the literal fallback. `index.html` stays `class="dark"`; `color-scheme: dark` stays pinned under #70.
- The main process duplicates `--background` as `BrowserWindow` `backgroundColor` (`"#111111"`, `src/main/index.ts:147`) — it must follow the resolved theme, or window edges flash the old color on resize and launch.
- **Preview is memory-only.** Moving through the picker applies to the live DOM and **writes nothing**; Enter commits, Escape restores the pre-preview theme. Terminal preview swaps restty's palette; editor preview calls `monaco.editor.setTheme`.
- Themes carry an `appearance` field so the picker can group and filter (Warp's failure to group by its own `details` field is a live user complaint).

---

## Staging

**PR 1 — Spine + terminal.** Generator + APCA/ΔL assertions in `@volli/shared`; CSS-variable application layer; main-process `backgroundColor` follow; persistence (global + project columns, resolved value never stored); the shared picker with live preview/revert, Favorites, Recent, tags, ⌘K entry; ghostty overlay files (global + per-project) with the atomic write path; terminal theme picker over restty's catalog; font family + size. Ships a complete vertical slice on a catalog that already exists.

**PR 2 — App engine + presets.** Theme editor (seed, accent unlock, grain, gradient canvas); the sparse override map; theme JSON files; Volli-original presets; Settings → Theme category.

**PR 3 — Editor.** `@shikijs/monaco` + JS RegExp engine, lazy grammars and themes; ~30 bundled themes with `THIRD-PARTY-NOTICES`; the `shikiToMonaco` single-call fix; explicit `setTheme` for diff editors. **Family presets become complete across all three surfaces here.**

**PR 4 — Per-project override.** Project → Configure → Appearance with inherit / custom / auto-tint-from-project-color; per-surface inherit toggles; the animated repaint on project switch.

**PR 5 — Canvas.** Curated images, custom image + scrim, Paper Shaders baked stills, then the gated live-animation toggle.

Per CLAUDE.md: branch + PR, never commit to `main`; `vp run -r typecheck` · `vp run -r test` · `vp check`; and **run the relevant `apps/desktop/e2e/*.mjs` smokes locally** — CI does not.

---

## Fold-ins and bugs found

- **`--muted-foreground: #9a9a9a` is APCA Lc 47 against `#111111`** — below the Lc 60 floor for non-body text. Should be ≈ `#b8b8b8` (OKLCH L 0.762). This ships today and is independent of theming; fix it in PR 1 as the generator's own target makes it inevitable anyway.
- **`--primary` as text on `--background` is Lc 41** — fine for large or bold text, not for body. Worth an audit of where the accent is currently used as body-sized text.
- Register any new type/color tokens as classGroups in `cn()` — `twMerge` silently drops unregistered tokens.

---

## Open questions

- **Do preset *families* need per-family hand-picked app seeds, or is deriving from the family's own accent good enough?** Recommendation: hand-pick for ~12 families; it is an afternoon and the quality difference is visible.
- **Light mode** — deliberately out of scope (#70). The generator is parameterized for it; shipping it is a separate design pass.
- **Does the ⌘K theme entry need a surface selector** (app / editor / terminal), or should it default to the app surface with the others reachable from Settings? Defer until the picker exists.
- **Sharing themes** — the file is already a shareable artifact. Whether to add explicit export/import, or a pasteable string (Slack's model), is deferred until anyone asks.

---

## Sources

Interaction and paradigm research: [Ghostty theme reference](https://ghostty.org/docs/config/reference#theme) · [`ghostty +list-themes`](https://ghostty-org-ghostty.mintlify.app/cli/list-themes) · [kitty themes kitten](https://sw.kovidgoyal.net/kitty/kittens/themes/) · [VS Code themes](https://code.visualstudio.com/docs/configure/themes) · [Zed themes](https://zed.dev/docs/themes) · [Warp custom themes](https://docs.warp.dev/terminal/appearance/custom-themes/) · [Arc Spaces](https://resources.arc.net/hc/en-us/articles/19228064149143-Spaces-Distinct-Browsing-Areas) · [Arc's derived CSS palette](https://ginger.wtf/posts/creating-a-theme-using-arc/) · [Slack themes](https://slack.com/help/articles/205166337-Change-your-Slack-theme) · [Trello accessible theming](https://www.atlassian.com/blog/atlassian-engineering/colorful-and-accessible-theming-in-trello) · [Linear themes](https://linear.app/changelog/2020-12-04-themes) · [Raycast themes](https://manual.raycast.com/themes)

Color science: [material-color-utilities](https://github.com/material-foundation/material-color-utilities/) · [Radix scale semantics](https://www.radix-ui.com/colors/docs/palette-composition/understanding-the-scale) · [Radix composing a palette](https://www.radix-ui.com/colors/docs/palette-composition/composing-a-palette) · [OKLCH vs HSL](https://evilmartians.com/chronicles/oklch-in-css-why-quit-rgb-hsl) · [Leonardo](https://github.com/adobe/leonardo-contrast-colors) · [APCA in a Nutshell](https://git.apcacontrast.com/documentation/APCA_in_a_Nutshell.html)

Editor pipeline: [shiki + Monaco](https://shiki.style/packages/monaco) · [shiki regex engines](https://shiki.style/guide/regex-engines) · [textmate-grammars-themes](https://github.com/shikijs/textmate-grammars-themes) · [Material Theme relicensing](https://biggo.com/news/202502260714_VS-Code-Material-Theme-License-Drama)

Shaders: [Paper Shaders](https://github.com/paper-design/shaders) · [MeshGradient performance thread](https://github.com/paper-design/shaders/issues/188) · [WebGL context eviction](https://issues.chromium.org/issues/40939743) · [Warp battery reports](https://github.com/warpdotdev/warp/issues/12571)
