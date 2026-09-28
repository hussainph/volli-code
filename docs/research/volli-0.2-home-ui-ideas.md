# 0.2 homepage proposal — UI ideas, synthesised

Three surveys were run against the restructured proposal at `/preview/home-0-2/`
(hero → interactive board demo → six-item workspace grid → New in 0.2: Automations
with storyboard and three ways to start → trust → closing):

- [Magic UI](volli-0.2-home-ui-ideas-magicui.md) — 11 patterns shortlisted, 3 ranked
- [Cult UI](volli-0.2-home-ui-ideas-cult-ui.md) — 11 patterns shortlisted, 3 ranked
- [`/pick-ui-library` pass](volli-0.2-home-ui-ideas-library-pick.md) — task inventory, 0 adoptions

This page is the index and the decision record. Read the three for detail.

## 1. Where all three agree

- **Fact:** Magic UI and Cult UI are React + Tailwind v4 + `motion` copy-paste
  registries (MIT). The site is Astro + plain CSS with React islands, GSAP
  installed, and no Tailwind.
- **Assessment (unanimous):** add neither Tailwind nor `motion`, and vendor no
  component. Tailwind's preflight would fight `global.css`; `motion` would be a
  second animation engine beside GSAP against the audit's JS budget (§3.4/§5.1).
  Every pattern worth having is under 60 lines of plain CSS, sometimes with one
  IntersectionObserver — the same shape the storyboard already uses.
- **Assessment (unanimous):** the page's existing grammar is the constraint, not
  the problem — one-pass motion, resting styles as final keyframes, full content
  without JS, ember reserved for Automation meaning, the sunset mesh behind the
  product and never around it. Ideas add texture to that grammar; anything that
  loops, recolours, or moves proof back into a hydrated island is out.
- **Fact:** `/pick-ui-library` found no task on the page that a curated library
  serves better than plain CSS or the installed GSAP (`motion`, `dnd kit`,
  `base-ui`, `torph`, `shiki`, `NumberFlow`, `cmdk` all rejected with reasons).

## 2. Verification status

- **Fact:** neither Spark session had web tools. Magic UI claims were checked
  against the registry source (`apps/www/registry/`); Cult UI claims against
  `nolly-studio/cult-ui` source and search snippets, because `cult-ui.com`
  answered 429 to every fetch.
- **Fact:** a follow-up fetch of `magicui.design/docs/components/border-beam`
  returned the page title (client-rendered body); `cult-ui.com` still answered
  429. Treat Cult UI doc URLs as unverified until someone opens them in a
  browser.

## 3. Ranked shortlist (deduplicated across the surveys)

Cost: S = an afternoon, M = a day or two. All are plain-CSS/Astro ports; none add
a dependency; all must be off under `prefers-reduced-motion` except where noted
as static.

| # | Idea | Lands in | Source | Cost | Assessment |
| --- | --- | --- | --- | --- | --- |
| 1 | **Border beam** — one gradient dot travels the border ring once (`offset-path`), then stills | Automations release band (its lead surface) | Magic #1; Cult #9 | S | The one "voltage" moment the audit allows (§6.2). Zero JS. |
| 2 | **Hero masked line-reveal** — the three headline clauses rise once, in sequence, behind an overflow mask | Hero | Cult #1 | S | The only section with no designed entrance. One observer, real text nodes, no duplicates. The library pass says "a static promise must not move" — a one-time entrance is not rotation; keep it under 700 ms. |
| 3 | **Grain, not glow** — a dot/noise texture at 3–6 % on the storyboard panels and ways cards | Storyboard, ways cards | Cult #2/#3; Magic #8 | S | Static. Tactility without a new material or any motion. Trivially reversible. |
| 4 | **Spotlight cards** — cursor-centred radial highlight on the border and surface | Three ways to start | Magic #3 | S | Hover-only, `(pointer: fine)`-gated, ~15 lines of JS. Restores a hover reward now that the demo is the only interactive surface. |
| 5 | **Run-history stagger** — the three Run rows in frame 04 reveal newest-first with 150 ms delays | Storyboard frame 04 | Magic #6 | S | Chains off the existing `.is-live`; no timers. |
| 6 | **Real countdown** — the frame 02 chip counts 3.5 → 0 s in sync with the drain bar | Storyboard frame 02 | Cult #8 | S | Makes the cancellable window legible instead of asserted. ~20 lines of rAF in the existing script; announce once. |
| 7 | **Section-head blur-fade** — heads and card grids rise 8 px and unblur once in view | All section heads | Magic #5 | S | Page-wide rhythm. Pre-reveal state must remain legible without JS. |
| 8 | **Bento rhythm** — two of the six workspace cells span wider (parallel runs, review) | Workspace grid | Magic #10 | S | Layout only. DOM order stays reading order. |
| 9 | **Typing the Instructions** — frame 03 types the Instructions in once as the Session's first message | Storyboard frame 03 | Magic #7; Cult #7 | S–M | Demonstrates the mechanism instead of describing it. Risk: Cult's own no-go list flags typewriter effects as reading like an agent typing by itself (§9.3 autonomy). Mitigation: it is the Instructions arriving, not the agent's reply — keep the reply a plain fade. Decide with the owner. |
| 10 | **Scroll-progress hairline** — 2 px ember bar under the header | Global | Magic #9 | S | Scroll-linked, no autonomous motion. Marginal. |

Declined by the surveys and not carried here: expandable/accordion ways cards
(the page's rule is "no click to discover"), direction-aware tabs, family drawer,
dynamic-island morph (M–L for one tactile moment), hero video dialog (only with
real footage, audit P1.1), and everything in the surveys' §3 no-go lists
(counters, avatar circles, testimonial marquees, globes, particles, confetti,
gradient text, cursor hijacks, WebGL shaders).

## 4. Recommended bundle

**Assessment:** items 1–3 together are the right first step — one voltage moment,
one entrance, one texture — because each lands in a different section, none adds
JS beyond one observer, and all three are reversible in a single commit. Items 4–6
are the second step if the first reads well. Item 9 needs an owner decision.
