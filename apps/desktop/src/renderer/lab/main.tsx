/**
 * The UI lab — a browser-only scratchpad for battle-testing interactions and
 * product ideas *before* they become app features.
 *
 * Why it exists: the app's only "see it real" loop is `pnpm run build` plus an
 * Electron Playwright probe, which means a design's implications only become
 * visible once it is already a finished feature. The lab shortens that to an
 * HMR reload by mounting the app's real components, tokens and primitives in a
 * plain browser tab, with fixture data in place of the main process.
 *
 * How it stays honest — the lab imports the app, never the reverse:
 *
 *   • Tokens are the real ones. `globals.css` paints the shipped theme with no
 *     JS, so anything here is token-accurate by construction, not by copy.
 *   • Components are the real ones, imported from `@renderer/*`. A scratch that
 *     re-implements a card is measuring its own reimplementation, not the app.
 *   • Data is fake and the bridge is stubbed (see fake-api.ts) — that is the
 *     whole trade. Nothing in `src/renderer/src/` may import from this folder.
 *
 * What it deliberately cannot model: terminals (restty/WebGPU and node-pty need
 * the main process), native window chrome, and Electron's font rasterization.
 * Judge layout, interaction, state and motion here; confirm those three in the
 * real app.
 *
 * Run: `pnpm lab` (serves http://localhost:5174/lab/). Dev-server only — this
 * entry is not a build input and never ships. Add an idea by dropping one file
 * into `lab/scratches/`.
 */
import "@fontsource-variable/geist-mono/wght.css";
import "@fontsource-variable/mona-sans/wght.css";
import "@fontsource-variable/mona-sans/wght-italic.css";
// `globals.css` by way of lab.css, which additionally registers this folder as
// a Tailwind source — see the note there; importing globals.css directly leaves
// every lab-only utility silently ungenerated.
import "./lab.css";
import "@renderer/typeset.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { HighlighterWarmup } from "./chat/markdown-boundary";
import { installFakeApi } from "./fake-api";
import { LabShell } from "./shell";

// The floor: an all-stubs bridge, so anything reaching for `window.api` before
// a scratch is chosen finds a stub rather than an undefined global. The shell
// re-installs with the active scratch's own overrides on every activation.
installFakeApi();

// No theme bootstrap of its own any more. The app is painted from a canvas the
// generated `globals.css` blocks carry with no JS at all, so the lab renders the
// shipped default the moment the stylesheet lands — which is exactly what the
// app's own first paint does. The lab's `volli-lab:` theme and canvas keys went
// with the picker and the canvas scratch that owned them; a dev-tool preference
// that outlived its editor would just be a way to make the lab lie.

// Fetch the syntax highlighter now, with everything else. It is the one module
// this page loads LAZILY — Streamdown reaches for it the first time a fenced
// block renders — and the dev server answers an optimized-dep request with 504
// once its `?v=` hash has moved on, which it does on every re-optimization. A
// module fetched at boot is never asked for again; a module fetched an hour
// later is asking a server that has changed its mind. See markdown-boundary.tsx.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <HighlighterWarmup />
    <LabShell />
  </StrictMode>,
);
