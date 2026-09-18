# 0.2 homepage: UI-library picks per task

- **Page:** `/preview/home-0-2/` ([home-0-2.astro](../../apps/website/src/pages/preview/home-0-2.astro),
  [home-0-2.css](../../apps/website/src/styles/home-0-2.css)) against the final section order
  (hero → `VolliDemo` island → six-item grid → Automations release band + storyboard + ways cards →
  trust → closing CTA). Fact: the checked-out preview does not yet embed `VolliDemo`; only the
  `FeatureGlyph` `review` kind has landed. This note covers the final order, so it stays valid
  after the restructure.
- **Method:** the `pick-ui-library` skill process — task first, `package.json` first, one pick per
  task, off-list stated explicitly. Its "a simple hover or fade doesn't need motion" rule decides
  most rows below.
- **Installed (Fact,** [package.json](../../apps/website/package.json)): Astro 7.2.8,
  `@astrojs/react` 6.0.4, React 19, GSAP 3.15, Mona Sans. No Tailwind, no `motion`, none of the
  other curated libraries. OG cards render via Chromium (`scripts/generate-og-image.mjs`), not Satori.
- **Budget (Fact,** from [the comparison](volli-0.2-home-proposal-comparison.md), raw bytes not
  transfer): proposal ships one 348 B inline module and no external script; `/` ships ~309 KB
  (React client 180,586 B + GSAP 69,587 B + demo island 45,480 B + react-dom 11,035 B + accordion
  2,634 B). Restoring the demo island restores ~that cost, so every library below lands on top of
  ~309 KB, not 348 B.
- **Verification:** Fact — this session has no web tools, so every KB/licence figure for a library
  is marked **unverified** and cited from memory of the library's own site, not checked.

## 1. Task inventory and picks

| # | Task (section) | Pick | Worth adding? | Cost if added |
| --- | --- | --- | --- | --- |
| 1 | Hero three-clause headline reveal | plain CSS (or nothing — the page currently reveals nothing and reads fine) | No. Assessment: `torph` (curated: animated text) is for rotating/typewriter text; a static promise headline must not move. | — |
| 2 | CTA / link hovers (all sections) | plain CSS — the 160–180 ms transitions `global.css` already owns | No addition. | — |
| 3 | Ticket drag across columns (`VolliDemo`) | curated: `dnd kit` (accessible drag primitives) — **verdict: keep the hand-rolled pointer + GSAP Flip code** | No. Assessment: the custom code already handles pointer capture, drop targets, live-region announcements, and reduced-motion for an illustrative fake board; a kit means re-verifying all of that to save no bytes. | Unverified: extra React-tree dep + KB on top of ~309 KB; a11y model to re-prove. |
| 4 | Ticket preview dialog open/close + focus trap (`VolliDemo`) | curated: `motion` (enter/exit) or `base-ui` (Dialog) — **verdict: keep GSAP + hand-rolled focus** | No. Assessment: GSAP is installed and does scale/blur/fade today; `motion` duplicates it, and `base-ui` Dialog for one piece of scenery is a dependency for a fake dialog. | Unverified: `motion` ~tens of KB; `base-ui` similar; both overlap installed GSAP. |
| 5 | Preview phase-switch crossfade, chat "Working…" spinner | plain CSS | No addition. | — |
| 6 | Command palette in the demo | curated: `cmdk` — **not applicable** | No. Fact: the demo has no palette (copy mentions one only). Do not invent a task to justify a dep. | — |
| 7 | `FeatureGlyph` line draw on scroll/hover (six-item grid) | plain CSS (`stroke-dashoffset` + the storyboard's existing IntersectionObserver pattern) | No addition. Assessment: draw-once line art is the textbook plain-CSS case. | — |
| 8 | Release-band glow, storyboard connector draw, countdown drain, turn rise, new-Run highlight | plain CSS keyframes, fire-once via one observer (today: 348 B) | No addition. Assessment: this is the skill's exact "doesn't need motion" case — sequenced but fire-once, with resting styles as final keyframes and full content without JS. | `motion` here would replace ~0 B of JS with unverified tens of KB. |
| 9 | Instructions-block tokens (`` /code-review ``, `` @CONTEXT.md ``) | plain `<code>` styling — **not `shiki`** | No. Assessment: `shiki` (curated: syntax highlighting) needs a code block and a grammar; two inline tokens need neither. A grammar engine + theme for two tokens is pure weight. | — |
| 10 | Any number to animate | **none — do not add `NumberFlow`** | No. Fact: the page has no counters, and audit §9.3 forbids testimonials, adoption numbers, and time-saved figures — `NumberFlow` (curated: animated numbers) has nothing true to count. | — |
| 11 | Toasts, OTP, charts, long lists, shared state, class variants, theme switching, 3D globe, control panel | `Sonner`, `input-otp`, `recharts`/`Liveline`, `Virtuoso`, `zustand`, `clsx`/`cva`, `next-themes`, `Cobe`, `Leva` — **all not applicable** | No. Fact: the page has none of these tasks. | — |
| 12 | OG image generation | curated: `Satori` — **verdict: keep the Chromium script** | No. Assessment: the script exists so cards use the real Mona Sans; Satori would trade that fidelity for hermetic builds. Off-list churn with visible downside. | — |
| 13 | Replacing GSAP with `motion` demo-wide | **verdict: churn, do not do it** | No. Assessment: GSAP + Flip already covers `motion`'s headline feature (layout animation) in the one place the page uses it. A rewrite saves nothing measurable and re-opens reduced-motion and focus behavior the demo already got right. | Rewrite risk; unverified KB delta either way. |

## 2. Recommendations

**Adopt nothing new for launch.** The three nearest candidates, ranked by closeness, all lose —
stated here so the decision is reviewable rather than implicit:

1. **`motion` for the demo island (rejected).** Would land in `VolliDemo.tsx` + accordion, replacing
   GSAP enter/exit and Flip. Loses because GSAP is installed, already drives the drag physics and
   dialog choreography, and the storyboard half of the page needs no JS animation library at all.
2. **`dnd kit` for ticket drag (rejected).** Would land in `VolliDemo.tsx`. Loses because the board
   is illustrative scenery with bespoke pointer + announcement behavior; the kit re-proves a11y for
   zero visitor gain.
3. **`base-ui` Dialog for the ticket preview (deferred, not for launch).** Would land in
   `VolliDemo.tsx` if the preview ever becomes real UI rather than a demo. Loses today for the same
   scenery reason; revisit only if the dialog grows real interactions.

## 3. Keep as plain CSS (explicit)

Hero reveal (if any), all hovers, glyph line draws, storyboard sequencing + connector draw +
countdown drain + turns rise + new-Run wash, both spinners, `<code>` tokens, card hovers, section
reveals. Everything on this page except the restored demo island ships its motion as CSS keyframes /
transitions gated on `prefers-reduced-motion`, which the site already honors in `global.css`,
`AutomationStoryboard.css`, and `VolliDemo.css`.

## 4. Open items

- Re-check this note after the restructure lands if the final page adds a task not listed here
  (e.g. a real ⌘K palette would reopen the `cmdk` row).
- KB/licence figures above are unverified (no web tools in this session); verify from npm before
  quoting them anywhere public.
