# Magic UI survey — surface and motion ideas for the Volli 0.2 homepage

- **Survey date:** 2026-09-13. **Against:** Magic UI source at `main` (llms.txt index, `apps/www/registry/registry-ui.ts` dependency metadata, `apps/www/package.json`, `LICENSE.md`, and eight component sources under `apps/www/registry/magicui/`).
- **Method note.** Fact: the Magic UI docs pages are client-rendered and return no readable text to a fetcher, so every behavior claim below is verified against the registry source rather than the marketing copy. Doc URLs are given per component for human follow-up.
- **Proposal baseline.** Fact: `home-0-2.astro` as read has no `VolliDemo` and orders sections hero → release band → ways → controls → workflow → trust → closing. This document designs against the final order stated in the brief (hero → `VolliDemo` island → workspace-made-of grid → Automations band + storyboard + ways cards → trust → closing CTA), not the file as read.

## 1. What Magic UI is

- **Fact — stack.** React 19 + Tailwind CSS v4 + `motion` v12 (imported as `motion/react`) on a Next.js docs site (`apps/www/package.json`: `react 19.1.1`, `tailwindcss ^4.1.13`, `motion ^12.23.12`, `next ^15`, `shadcn 3.3.1` as a dev tool). Roughly 80 components.
- **Fact — licence.** MIT (`LICENSE.md`: "Magic UI", full MIT text). Porting patterns or vendoring files into the site is permitted with the copyright notice preserved.
- **Fact — consumption.** Copy-paste via the shadcn CLI against Magic UI's registry (`registry.json`, `components.json`, `shadcn build` publishes to `public/r`). Components arrive as local source files, not a versioned package: each registry entry lists the npm `dependencies` the CLI auto-installs (e.g. Magic Card → `motion, next-themes`; Globe → `cobe, motion`; Tweet Card → `react-tweet`; Code Comparison → `shiki, next-themes`; Confetti → `canvas-confetti`; Bento Grid → `@radix-ui/react-icons` + a shadcn `button`). Entries with no `dependencies` key are CSS/React only — but "CSS-only" still means Tailwind utilities plus keyframes shipped as Tailwind v4 `@theme` tokens, so nothing pastes directly into plain CSS.
- **Fact — this site has none of that stack.** `apps/website/package.json` installs React, GSAP, and Astro only: no Tailwind, no shadcn, no motion/framer.
- **Assessment — do not add Tailwind.** Cost would be the `@tailwindcss/vite` plugin, a preflight reset fighting `global.css` hand-rolled base styles, and two styling systems to maintain — for ports that each run under 40 lines of plain CSS. Copy-pasted utility markup would also violate the repo's plain-CSS rule on sight.
- **Assessment — do not add motion.** It would be a second animation engine beside GSAP (already paid for: ~69 KB raw in the current build per the comparison doc), widening exactly the JS budget the audit caps (§3.4/§5.1). Every motion usage in the shortlist below is replaceable by CSS keyframes, an IntersectionObserver, SMIL, or GSAP inside the existing island. `next-themes` is irrelevant (dark-only site); `cn()` is a one-line `clsx`-less join.
- **Assessment — vendoring caveat.** Copied code freezes at copy time; upstream fixes do not flow. Keep ports small, owned, and restated in this repo's voice rather than vendored verbatim.

## 2. Shortlist — patterns that fit the brand

All ports are option (a), plain CSS/Astro, unless noted. Costs: S = an afternoon, M = a day or two.

### 1. Border Beam — https://magicui.design/docs/components/border-beam

- **Fact:** an absolutely-positioned overlay with a transparent border, masked with `mask-composite: intersect` of `padding-box`/`border-box` so only the border ring shows; a small gradient square travels the ring via CSS `offset-path: rect(…)` with `offset-distance` animated 0→100%.
- **Section:** the Automations release band (frame the band's lead surface) or the closing Download CTA — the page's single "voltage" moment (audit §6.2/§6.3).
- **Implement:** same markup in plain CSS; `@keyframes beam { to { offset-distance: 100% } }`, gradient `var(--ember) → transparent`, `animation-iteration-count: 1` with fill-forwards for a one-pass sweep (or slow infinite, 6–8 s, on one element only).
- **Cost S. Motion:** overlay `aria-hidden`; under `prefers-reduced-motion` hide it and keep the hairline border.

### 2. Animated Beam — https://magicui.design/docs/components/animated-beam

- **Fact:** an SVG path measured between two element refs (ResizeObserver) with the pulse drawn as a second path stroked by a `linearGradient` whose `x1`/`x2` animate across.
- **Section:** storyboard connector grammar v2 (evolve the existing `.story-link` hairlines), or a small Trigger → Run diagram inside the release band.
- **Implement:** layout here is static, so hard-code the `viewBox` path — no measuring, no motion. Animate the gradient with SMIL `<animate attributeName="x1" …/>` (zero JS) or a GSAP attr tween inside an island; `repeat: 1`, ember stops.
- **Cost S (SMIL) / M (island). Motion:** `aria-hidden` SVG; reduced-motion falls back to a static gradient or the plain hairline.

### 3. Magic Card spotlight — https://magicui.design/docs/components/magic-card

- **Fact:** `pointermove` feeds motion values; a cursor-centred `radial-gradient` is painted into the `border-box` layer (border spotlight) plus an inner glow. Registry deps are `motion, next-themes`; both are droppable here.
- **Section:** the three "ways to start" cards (and, if wanted, the trust cards).
- **Implement:** ~15 lines of vanilla JS setting `--mx`/`--my` per card; border via `background: radial-gradient(…) border-box, <solid> padding-box`; skip the springs (direct set; optionally smooth with `@property` transitions). Gate the listener on `(pointer: fine)`.
- **Cost S. Motion:** hover-only decoration; touch/keyboard users get today's static cards unchanged; do not attach the listener under reduced-motion.

### 4. Shine Border — https://magicui.design/docs/components/shine-border

- **Fact:** zero-dependency. A `content-box`/`padding-box` double mask (`mask-composite: exclude`) cuts a border ring; a 300%-sized gradient drifts behind it via `background-position` keyframes.
- **Section:** exactly one of: the release-version pill edge, the storyboard's `is-new` Run row, or the armed-column outline. It is the animated cousin of washes the page already has — repetition would cheapen both.
- **Implement:** copy the `shine` keyframes verbatim into plain CSS; ember-tinted stops.
- **Cost S. Motion:** slow it (≥10 s period) and switch it off under reduced-motion.

### 5. Blur Fade stagger — https://magicui.design/docs/components/blur-fade

- **Fact:** `useInView({ once: true })` flips variants (`y` offset, opacity, `blur(6px)` → 0).
- **Section:** every `.section-head` block plus the way/trust card grids — the page-wide entrance rhythm.
- **Implement:** the site already owns this pattern (storyboard observer). IO adds `.is-in` once; CSS transitions `transform`/`opacity`/`filter` ~450 ms `var(--ease-out)`; stagger with a `--d` custom-property delay. Keep offsets ≤8 px, blur ≤6 px.
- **Cost S. Motion:** `global.css` already kills transitions under reduced-motion; ensure the pre-reveal state is legible if JS never runs.

### 6. Animated List sequence — https://magicui.design/docs/components/animated-list

- **Fact:** a timer steps an index and each notification springs in via `AnimatePresence`. The mechanism (staggered one-pass reveal) is what matters, not the timers.
- **Section:** storyboard frame 04 — the three Run/skip rows reveal newest-first in sequence rather than all at once.
- **Implement:** no timers, no motion: chain `transition-delay: 0/150/300ms` off the existing `.is-live` class the storyboard observer already adds.
- **Cost S. Motion:** all rows are in the markup; reduced-motion shows everything immediately.

### 7. Terminal sequence + Typing Animation — https://magicui.design/docs/components/terminal, https://magicui.design/docs/components/typing-animation

- **Fact:** `Terminal` reveals child lines in order once in view; `TypingAnimation` appends characters on a ~60 ms interval. Both start on view; both are plain React state under the motion types.
- **Section:** storyboard frame 03 — the Instructions paragraph types in as the Session's first message, then the agent reply fades. This panel currently *describes* the 0.2 mechanism ("Instructions land as the first message"); typing it *demonstrates* it.
- **Implement:** full text stays in the HTML; a ~20-line IO-gated script clears and retypes at ~20 ms/char once, then reveals the reply. No-JS and reduced-motion readers see the complete text with nothing missing.
- **Cost S. Motion:** keep the finished text in the DOM (no `aria-live` on decorative re-typing); honour reduced-motion by skipping the interval.

### 8. Dot Pattern, static only — https://magicui.design/docs/components/dot-pattern

- **Fact:** an SVG circle grid sized to its container; the `glow` mode animates every dot through motion — skip it. Without glow the component is markup, not behavior.
- **Section:** hero backdrop and/or release band, under or beside the existing ember wash.
- **Implement:** inline `<svg aria-hidden>` with a `<pattern>` of 1 px circles at ~5% alpha, faded with `mask-image: radial-gradient(…)`. Zero JS. (Grid Pattern is the same family; dots read quieter.)
- **Cost S. Motion:** none — it is static texture.

### 9. Scroll Progress hairline — https://magicui.design/docs/components/scroll-progress

- **Fact:** `useScroll()` drives `scaleX` on a fixed 1 px gradient bar. Trivially portable.
- **Section:** global — a 2 px ember `scaleX` bar pinned to the viewport top (or directly under the header).
- **Implement:** passive scroll listener, rAF-throttled, writes only `transform`. Recolour: Magic's own bar is a purple-pink-orange gradient — use ember fading to transparent.
- **Cost S. Motion:** scroll-linked, so no autonomous movement; still disable under reduced-motion for consistency with the site's posture.

### 10. Bento rhythm — https://magicui.design/docs/components/bento-grid

- **Fact:** a layout pattern, not an effect: CSS grid with spanning feature cells. Its only registry dep is icons.
- **Section:** the "what the workspace is made of" six-item grid — let two cells span (e.g. parallel runs, review) and keep four compact, instead of a uniform 3×2.
- **Implement:** pure CSS grid; DOM order stays the reading order regardless of spans.
- **Cost S. Motion:** none.

### 11. Hero Video Dialog — https://magicui.design/docs/components/hero-video-dialog

- **Fact:** a thumbnail with a play affordance opens the video in a modal dialog (motion is incidental).
- **Section:** release band, beside the storyboard — but only as the home for the audit's P1.1 ask: one real 10–20 s native Automation clip.
- **Implement:** Astro markup + dialog with focus trap, ESC close, and a poster fallback. **Gated: do not build this for an illustration** — without real footage it adds chrome and subtracts nothing.
- **Cost M. Motion:** standard dialog reduced-motion behavior (no enter animation, immediate open state).

## 3. Explicit no-gos

- **Fact — claim conflicts (audit §9.3 bans testimonials, adoption numbers, time-saved figures, autonomy language):** Number Ticker (count-ups imply measured metrics); Avatar Circles (implies a user base); Tweet / Client Tweet Cards (testimonials by construction — plus `react-tweet` fetches from the X network at runtime); Marquee used as a logo/testimonial wall (nothing honest to loop, and infinite motion fights the calm); Dotted Map (implies a global footprint); Icon Cloud (implies integration breadth); Animated Circular Progress Bar (percentages imply measured reliability); Globe (`cobe` WebGL + motion — heaviest dep on this list, and a spinning globe behind "local-first" is a contradiction).
- **Fact — spectacle vs calm (§1.4, §6.3 — one pass, then stillness):** Confetti / Cool Mode; Sparkles Text; Meteors / Particles / Flickering Grid / Retro Grid / Warp Background / Light Rays / Floating 3D Particles (ambient loops); Aurora / Animated Gradient Text / Neon Gradient Card / Rainbow / Pulsating buttons (a second colour language and shouty CTAs against the one-ember-button system); Text Reveal (a 200 vh sticky scroll-jack for what must be quickly-read facts); Scroll-based Velocity; Dock (dock chrome inside a Mac app's own page reads as parody); Comic / Morphing / Word Rotate headline tricks (rotating promises read as instability — the headline is the durable promise); Hyper Text scramble; Spinning Text; Dia Text Reveal sweep; Orbiting Circles (orbiting-agent imagery is exactly the autonomy spectacle §9.3 forbids); Ripple (another design system's metaphor); Highlighter (hand-drawn marker voice plus a `rough-notation` dep — not Volli's register).
- **Fact — wrong proof or heavy deps:** Code Comparison (`shiki` bundle; implies diff-proof claims the storyboard already makes honestly); Safari / iPhone / Android mockups (wrong-platform device frames — the site shows the Mac app directly); File Tree (no structure story to tell); Lens / Pointer / Smooth Cursor (cursor hijacking, hostile to touch and assistive tech).

## 4. Top 3 recommendations

1. **Border Beam (plain-CSS port) → the Automations release band.** The audit allows exactly one "voltage" moment and the band already carries a static ember wash; a one-pass beam around the band's lead surface makes 0.2 feel electric without adding a colour language, a motion system, or a byte of JS. It extends the connector-line grammar instead of inventing a new one, and it disappears cleanly under reduced-motion.
2. **Terminal typing pattern → storyboard frame 03.** The storyboard's weakest panel is the one that must prove the release mechanism ("the Instructions land as the first message"); typing that line in once demonstrates it instead of describing it. Full text in markup keeps no-JS and reduced-motion readers whole, and the ~20-line script drags in no dependency.
3. **Magic Card spotlight → the "ways to start" cards.** With the draggable demo sitting below the hero in the final order, the page needs a small hover reward somewhere above the fold of the consideration scroll; a cursor spotlight on the three choice-cards restores tactility that never fires on touch or keyboard and degrades to today's static cards. Pointer-gated, reduced-motion-safe, no dependency.

## 5. What the current page already does well — do not undo

- **Fact:** the storyboard's resting styles are also its animations' last keyframes, the pulse runs once (~3.85 s, spinner excepted), connectors are sized from the shared `--story-gap` token, and every final state (drawn connectors, new Run row) renders with no JS.
- **Fact:** the proof costs one 348 B inline module against the live page's ~309 KB of demo/React/GSAP/accordion JavaScript (comparison doc §1), and reduced-motion shows everything statically.
- **Fact:** ember is reserved for Automation meaning (armed column, cancel window, new Run) — the accent still signifies.
- **Assessment:** every recommendation above adds texture to this grammar (beam, spotlight, typing, stagger) rather than replacing it. Anything that would re-loop the page, re-colour it, or move proof back into a hydrated island spends the novelty budget the audit allocated to the Automation-to-Run moment (§5.1) — decline those.
