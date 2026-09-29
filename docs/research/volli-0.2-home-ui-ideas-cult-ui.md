# Cult UI survey for the Volli 0.2 homepage

- **Scope:** patterns for the restructured proposal order — hero → `VolliDemo`
  board → six-item workspace grid → Automations band (`AutomationStoryboard` +
  ways-to-start) → trust → closing CTA.
- **Method:** Cult UI docs + registry source at `nolly-studio/cult-ui` (main,
  read 2026-09-13). **Fact:** `cult-ui.com` returned HTTP 429 to every docs
  fetch during this survey, so behavior below is from registry source and
  search snippets, not rendered doc pages. Doc URLs follow the confirmed
  `/docs/components/<slug>` pattern. Dep and size claims are from
  `registry/ui.ts` unless marked as estimates.

## 1. What Cult UI is

**Fact:** copy-paste registry (shadcn-style: `npx shadcn add @cult-ui/<name>`)
of animated React components built on Tailwind v4 + `motion/react`, MIT
licence. Not an npm package — each component vendors source plus its own deps.

**Fact:** per-component deps (`registry/ui.ts`): most animated pieces need
`motion`; some add `react-use-measure`, `vaul`, `@radix-ui/*`,
`class-variance-authority`, `lucide-react`; `shader-lens-blur` needs `three` +
`jotai`. The texture/edge/mask pieces need nothing.

**Assessment:** two consumption paths for this site (Astro + plain CSS, React
islands, no Tailwind, GSAP already installed):

- (a) **Port the CSS technique by hand (preferred).** Zero deps, zero
  JS-budget impact. The texture/edge/mask components are 10–60 lines of
  CSS with no JS at all.
- (b) **Ship as a React island.** React itself is free (already hydrated by
  `VolliDemo`), but each new dep bills the audit's JS budget (§3.4/§5.1: the
  live page's ~309 KB raw JS is already flagged; the proposal page is one
  348 B inline module — `motion` ≈ tens of KB min *estimate* would erase
  that win; `three` ≈ hundreds of KB, out of the question).

**Assessment:** do not add Tailwind to make copy-paste work. Tailwind v4
needs its PostCSS plugin + theme + preflight, and preflight's resets would
fight `global.css`'s hand-tuned base. Every pattern shortlisted below ports
to plain CSS.

**Assessment:** skip blocks/templates. Blocks are paywalled AI-agent patterns
(`pro.cult-ui.com`); templates are Next.js + Supabase starters. Nothing
there serves a static marketing page.

## 2. Shortlist

1. **TextAnimate (`calmInUp`)** — https://www.cult-ui.com/docs/components/text-animate.
   Masked per-line rise (line in `overflow: hidden` wrapper, `y: 200% → 0`,
   0.01 stagger, ~0.75 s soft ease), fired once in view. **Section:** hero
   headline. **Port (a):** split headline into 2–3 mask spans, CSS
   transform + opacity, one `IntersectionObserver` adding `.is-in` — the same
   shape as the storyboard's existing script. **Cost S.** Reduced-motion:
   final state by default, gate the observer behind `matchMedia`. Keep the
   real text nodes (no aria-hidden duplicates).
2. **TextureOverlay (dots/grid/noise)** — https://www.cult-ui.com/docs/components/texture-overlay.
   Pure-CSS `background-image` patterns (radial dots on an 8 px tile, linear
   grid on 12 px) on an absolute `pointer-events: none` layer.
   **Section:** storyboard panels + ways cards at 3–6 % opacity — tactility
   without a new material. **Port (a):** copy two declarations verbatim.
   **Cost S.** Decorative (`aria-hidden`), no motion.
3. **TextureCard** — https://www.cult-ui.com/docs/components/texture-card.
   Machined edge: four nested 1 px borders, each 1 px smaller radius, over a
   faint vertical gradient. **Section:** "three ways to start" cards — they
   are alternatives, so boxing is semantically right. **Port (a):** flatten
   to two nested borders at the existing 16 px radius; skip the gradient or
   keep it ≤ 4 % to respect the hairline grammar. **Cost S.**
4. **Expandable** — https://www.cult-ui.com/docs/components/expandable.
   Card with measured-height spring expansion plus fade/slide/blur presets.
   **Section:** ways-to-start cards (or workflow grid) — collapsed one-liner,
   expand for Trigger/enablement detail; holds the §1.4 detail without six
   more paragraphs. **Port (a):** the site already owns this technique —
   `.accordion-panel`'s `grid-template-rows: 0fr → 1fr` in `global.css`;
   reuse it with `<button aria-expanded>`. **Cost S** as port (M as island:
   `motion` + `react-use-measure`). Content stays in the DOM; reduced-motion
   is already instant globally.
5. **DynamicIsland** — https://www.cult-ui.com/docs/components/dynamic-island.
   Spring-morphing pill (width/border-radius presets, stiffness 400 /
   damping 30) swapping compact content for expanded views. **Section:**
   storyboard frame 02's 3.5 s cancel window already reads as an island —
   a click-to-expand "what happens if you don't cancel" would be the page's
   one tactile moment. **Implement (b) simplified:** CSS `max-width` /
   `border-radius` transition; the full Cult port (~700 lines of
   provider/reducer) is not worth vendoring. **Cost M** simplified (L full).
   Focusable trigger, `aria-expanded`, no auto-playing morph.
6. **FamilyDrawer** — https://www.cult-ui.com/docs/components/family-drawer.
   Bottom sheet (`vaul`) with named views, height animating to measured
   content (0.15–0.27 s by height delta). **Section:** mobile storyboard only
   (frames 01–04 as drawer views) — weak desktop fit; port only if the
   stacked storyboard tests crowded. **Port (a):** `<dialog>` + the
   grid-rows height trick, no `vaul`. **Cost M.** `showModal` gives focus
   trap and Esc for free.
7. **TerminalAnimation** — https://www.cult-ui.com/docs/components/terminal-animation.
   Typed command playback (~25–60 ms/char) + sequential line reveal with
   per-line delays, tabbed scenarios, `role="log"` / `aria-live="polite"`.
   **Section:** storyboard frame 03 (fresh Session), or a small strip proving
   CLI moves count as deliberate moves. Cheapest island here — deps are only
   Radix `slot` + `use-controllable-state`, no `motion`. **Cost M.**
   Reduced-motion/no-JS must render the full transcript statically; announce
   politely, pause when the tab is hidden.
8. **Timer** — https://www.cult-ui.com/docs/components/timer. Countdown pill,
   `role="timer"`, tabular-nums, rAF-driven (`cva` + `lucide` only).
   **Section:** frame 02's "3s" chip — a real 3.5 → 0 countdown synced to the
   storyboard's `is-live` pulse makes the cancellable window legible instead
   of asserted. **Port (a):** ~20 lines of rAF in the storyboard's existing
   script. **Cost S.** Announce once politely, not every tick; static
   "3.5 s window" under reduced-motion.
9. **BorderBeamButton** — https://www.cult-ui.com/docs/components/border-beam-button.
   Glow traveling the button border. **Section:** closing CTA primary only.
   **Port (a):** rotating conic-gradient via `@property --angle`, masked to
   the border; static ember glow under reduced-motion. **Cost S.**
   **Assessment:** marginal — the current CTA shadow already does this job
   statically; only if the closing needs more pull.
10. **DirectionAwareTabs** — https://www.cult-ui.com/docs/components/direction-aware-tabs.
    Tabs whose content slides in from the navigation direction (`motion` +
    `react-use-measure`). **Section:** possible alternative to ways-cards on
    narrow screens. **Assessment:** weak fit — the cards stack fine, and the
    proposal deliberately shows content without clicks. Only if vertical
    length tests too long. **Cost M.** Would need full `tablist` semantics
    (arrow keys) — audit Cult's demo before vendoring.
11. **GridBeam** — https://www.cult-ui.com/docs/components/grid-beam. Canvas
    grid with light pulses traveling rows/columns plus intersection blooms;
    ships a `sunset` palette. **Section:** none directly. It rhymes with the
    ember connector grammar, which is exactly why it is tempting and exactly
    why it is a no-go as shipped (see §3). Salvageable idea only: one static
    ember pulse dot on the existing storyboard connector (single CSS
    keyframe, ≤ 8 % alpha, runs once). **Cost S** for the salvage, L plus
    budget-busting for the component.

## 3. No-gos

- `shader-lens-blur` (`three` + `jotai`), `hero-dithering`
  (`@paper-design/shaders-react`): WebGL weight against the JS budget, and a
  second material language against the calm brand.
- `bg-animated-gradient`, `canvas-fractal-grid`,
  `bg-animated-fractal-dot-grid`: looping ambient motion — audit §6.3
  rejects ambient electric backgrounds, and storyboard motion is one-pass by
  design.
- `tweet-grid`, `logo-carousel`, `animated-number`: §9.3 forbids
  testimonials, adoption numbers, and time-saved figures — and there is
  nothing honest to count yet.
- `dock`, `three-d-carousel`, `sortable-list`: playful drag physics; the demo
  already owns drag, nothing to add.
- `typewriter`: implies an agent typing by itself — the autonomy language §9.3
  forbids; and it loops.
- `color-picker`, `choice-poll` / `feature-voting` / `vote-tally` /
  `poll-widget`, `popover-form`: fake controls with no backend (a poll with
  no votes, a form with scripted success) — dishonest on a page whose thesis
  is inspectability.
- `onboarding`, `feature-carousel`: the site rule is "let controls talk" — no
  wizards or tutorial tooltips.
- `gradient-heading`, `cosmic-button`, `metal-button`, `pixel-*`,
  `squiggle-arrow`, `distorted-glass`, `stripe-bg-guides`: each imports a
  second voice (rainbow gradients, pixel type, glass, hand-drawn) against
  Mona Sans + flat ember + hairlines.
- `side-panel`, `floating-panel`, `expandable-screen`, `morph-surface`,
  `hover-video-player` / `youtube-video-player`, `loading-carousel`: need
  video assets, autoplay, or full-screen takeovers the page has no job for.

## 4. Top 3

1. **Hero masked line-reveal** (TextAnimate `calmInUp` port) → hero.
   **Rationale:** the highest-leverage S-cost move available. The hero is
   currently the only section with no designed entrance; a one-shot masked
   rise on the three-clause headline gives the 0.2 page an opening gesture
   with zero deps, one observer, and the storyboard's already-proven
   reduced-motion discipline — and it touches no other section's grammar.
2. **Expandable ways-to-start** (Expandable port via the shipped grid-rows
   trick) → Automations band. **Rationale:** the three cards currently have
   nowhere to put Trigger/enablement caveats without growing into
   paragraphs; progressive disclosure keeps the band calm while holding the
   full §1.4 control detail one tap away, reuses a technique already on the
   page, and is natively accessible.
3. **Grain, not glow** (TextureOverlay dots at ~4 %) → storyboard panels.
   **Rationale:** the cheapest tactility on offer. It deepens the four proof
   panels against the page canvas without gradients, glow, or motion — zero
   risk to the claims ledger, the JS budget, or the connector-line grammar,
   and trivially reversible if it reads as noise.

## 5. What the current page already does well

- **Fact:** the storyboard's four artifacts joined by one ember path are the
  audit's §6.3 motif built literally; the `VolliDemo` sunset mesh stays
  behind the product, never around it. **Assessment:** recommendations above
  add entrances and surface detail — none of them should touch the
  connector line, the single ~8 % voltage wash, or the static-first proof.
- **Fact:** motion is one-pass (observer-added `is-live`), every final state
  renders without JS, and reduced-motion drops all of it. **Assessment:** any
  ported pattern must meet that bar, not the Cult default of looping springs.
- **Fact:** the proposal page ships ~348 B of JS against the live page's
  ~309 KB raw. **Assessment:** that delta is the budget argument for ports
  over islands throughout §2.
