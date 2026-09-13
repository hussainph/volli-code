# Volli 0.2 homepage proposal — reviewer's comparison guide

- **Compares:** the current live lander at `/` against a proposed 0.2 homepage at
  `/preview/home-0-2/`
- **Source of the proposal's brief:**
  [volli-0.2-automations-public-surface-audit.md](volli-0.2-automations-public-surface-audit.md)
- **Prepared from:** page and component source, plus the checks below; scores
  remain editorial. **Covers `eba2095b`** — the restructure that put the product
  first, two copy passes, six decorations. Earlier revisions of this guide
  described a version with no interactive demo and a six-fact control strip.
- **Measured** (raw bytes in `apps/website/dist/_astro` after
  `pnpm -C apps/website build`, plus `astro preview` rendered headlessly):
  - **Both** pages load the React client (180,586 B) and the demo island
    (45,480 B), which import GSAP (69,587 B) and react-dom (11,035 B); `/` also
    loads the accordion script (2,634 B). That is ≈309 KB raw for `/` and
    ≈306 KB raw for `/preview/home-0-2/` — the same cost, to within one small
    chunk. The proposal adds two inline modules: 516 B (storyboard observer +
    countdown) and 581 B (release-band beam observer + card spotlight). These are
    uncompressed bytes on disk, not transfer sizes.
  - No horizontal overflow at 390, 700, 900 or 1347 px. The storyboard is four-up
    above 1050 px, 2×2 to 700 px, single-column below, with the ember connector
    turning vertical where frames stack; the workspace grid steps 3 → 2
    (≤1050 px) → 1 (≤620 px); ways and trust step 3 → 1 (≤820 px).
  - Under `prefers-reduced-motion: reduce` the storyboard shows every final state
    (drawn connectors, the new Run row, the drain bar at its resting 14%), the
    headline clauses rest in place, and the band's beam never runs.
  - `astro check` reports 0 errors; `astro build` emits 3 routes; the sitemap
    lists `/` and `/download/` only; the proposal carries `noindex, nofollow`.
  - The accessibility tree exposes one `h1`, one `h2` per section, `h3` in the
    storyboard and workspace grid, `h4` in the ways cards, and the hidden "on this
    Mac for Review handoff" text on the Enabled switch.

This document helps a product owner decide whether the proposal is better than
the page it would replace. It uses the audit's vocabulary: **Fact** — read
directly out of the source files linked below; **Assessment** — editorial
judgment, not a measurement or a product fact; **Open item** — work the proposal
does not do and must do before shipping.

## 1. How to compare

| | Current | Proposal |
| --- | --- | --- |
| Route | `/` | `/preview/home-0-2/` |
| Page | [index.astro](../../apps/website/src/pages/index.astro) | [preview/home-0-2.astro](../../apps/website/src/pages/preview/home-0-2.astro) |
| Header nav | Docs · Quickstart · GitHub · **Download** | **Product** · **Automations** · Docs · GitHub · **Download** |
| Proof component | [VolliDemo.tsx](../../apps/website/src/components/VolliDemo.tsx) (React + GSAP, `client:load`) | the same `VolliDemo` island, in the same slot under the hero |
| Second proof | none | [AutomationStoryboard.astro](../../apps/website/src/components/AutomationStoryboard.astro) — static markup, one IntersectionObserver, no island |
| Lifecycle component | [LifecycleAccordion.astro](../../apps/website/src/components/LifecycleAccordion.astro) (GSAP, one item open at a time) | none — the six items are a still glyph grid in `#product` |
| New glyph | — | the `review` kind in [FeatureGlyph.astro](../../apps/website/src/components/FeatureGlyph.astro): base ticket → Change Set, changed line in ember |
| Indexed | yes; in the sitemap | no; `noindex, nofollow`, excluded from the sitemap in [astro.config.mjs](../../apps/website/astro.config.mjs) |

Fact: the proposal's order is hero → the interactive demo → `#product` (what the
workspace is made of) → `#automations` (the 0.2 release, as **one** section) →
trust → closing. An earlier revision ran three consecutive Automations sections
after the hero and demoted the core product to slot five; the owner judged that
over-indexed on Automations and reversed it.

```bash
pnpm -C apps/website dev
# then open http://localhost:4321/ and http://localhost:4321/preview/home-0-2/
```

**Suggested order.** (1) Desktop, cold: read `/`, then the proposal, without this
guide's quotes — the point is whether each page explains itself; reload once to
catch the headline entrance, which runs only on load. (2) Phone width: both are
single-column, so reading order becomes the argument's order, and the card
spotlight is gated to `(pointer: fine)` / `(hover: hover)` and absent by design.
(3) Reduced motion on: the accordion calls `gsap.set(... clearProps)` rather than
animating, the storyboard adds `is-live` at once and skips the countdown, and the
headline and beam are off in `home-0-2.css`. The grey **Proposal** bar above the
header is reviewer scaffolding, deleted per §6.

### 1.1 Where the six decorations come from

Fact: the proposal carries six visual decorations the live page does not. All are
plain CSS (plus the 581 B module that writes the spotlight's pointer
coordinates), add no dependency, and are off under `prefers-reduced-motion`. The
page reads identically without any of them.

| # | Decoration | Where | How |
| --- | --- | --- | --- |
| 1 | Headline clauses rise once behind masks, on load | hero `h1` | `hero-rise`, 720 ms, 110 ms stagger |
| 2 | Ember beam sweeps the pill's edge once when the band scrolls in | "New in Volli 0.2" | conic gradient, `@property --beam-angle`, masked ring |
| 3 | ~4% dot grain | storyboard panels, ways cards | static `radial-gradient` tile |
| 4 | Pointer-following spotlight: surface wash + border ring | ways cards | `--mx`/`--my` written by the page script |
| 5 | Run-row stagger in frame 04 | storyboard | older rows rise at 2950/3100 ms, the new row at 3350 ms |
| 6 | Live countdown in the armed-window chip | storyboard frame 02 | `3 → 2 → 1`, in step with the drain bar |

Fact: these are items 1–6 of the ranked shortlist in
[volli-0.2-home-ui-ideas.md](volli-0.2-home-ui-ideas.md) — the decision record for
them, which links its three sources
([Magic UI](volli-0.2-home-ui-ideas-magicui.md),
[Cult UI](volli-0.2-home-ui-ideas-cult-ui.md),
[`/pick-ui-library`](volli-0.2-home-ui-ideas-library-pick.md)). It recommended 1–3
first and 4–6 as a second step; the owner took the bundle. Items 7–10 (section-head
blur-fade, bento rhythm, typing Instructions, scroll-progress hairline) were not
taken. **Assessment:** since none carries information, each is a separate
keep/drop call, not a package (§7).

## 2. Scorecard

Columns 1 and 2 reproduce the audit's §"Launch-readiness scorecard". Column 3 is
my assessment of the proposal, from source, on the same scale.

| Dimension | Current (audit) | Proposal (assessment) |
| --- | --- | --- |
| Basic category clarity | **4/5** — "The workspace for parallel coding agents" is immediately legible. | **4/5, with a risk.** The category line survives as a caption above the hero's link row (`.hero-category`) while the headline is three clauses. Legibility is not obviously better; if the new headline reads slower, this is a 3/5. |
| Distinctiveness | **2/5** — accurate but increasingly generic. | **4/5.** The control model (per-Mac enablement, one armed automation per column, deliberate moves, recorded skips) is copy no competitor in audit §4 can truthfully run. |
| 0.2 feature currency | **1/5** — Automations absent from the homepage, called unavailable in docs. | **4/5 for this page; the release is still gated.** The page names 0.2, automations, triggers, runs and Run history. It changes no docs, so `start/concepts.mdx` still contradicts it, and "Read the docs" still lands on the docs home. |
| Product proof | **2/5** — polished but illustrative, stale, does not prove the release feature. | **3/5, capped.** There is more proof than before — the interactive board *and* a four-frame storyboard — but both are hand-built markup, with no capture anywhere (audit P0.7, P1.1). Restoring the demo also restores audit §3.1's defect: its nav rail renders **Home / Configure / Settings** and never shows Automations, on a page whose second half is about Automations. |
| Trust and control | **3/5** — alpha/platform honesty strong, Automation controls unexplained. | **4/5.** The control facts moved from a standalone six-item strip into the three ways cards and a one-paragraph closer, beside the three-card local-first section: fewer statements, each read where it is relevant. Still nothing demonstrated in a real capture. |
| Website information architecture | **3/5** — easy to navigate, no feature/release destination, one story below the hero. | **4/5.** `#product` and `#automations` in header and footer, a versioned release band, four distinct sections below the demo. Still a two-route site with no `/automations/` page (audit §7.2 leaves that at P1). |
| Docs information architecture | **2/5** | **2/5 — unchanged.** The proposal touches no docs. |
| Visual craft | **4/5** — restrained, coherent, not yet ownable. | **Not assessable from source.** The six decorations in §1.1 are the direct answer to audit §6.2's "not yet ownable"; whether they read as one material or as six effects is what looking at the rendered page is for. |
| Conversion confidence | **3/5** — download and quickstart obvious; no release proof, use cases, or third-party trust signals. | **3/5 — unchanged.** More reasons to believe, but zero third-party signal: no testimonials, named users or numbers. That is correct per audit §3.5, and it is why this score does not move. |
| Overall 0.2 launch readiness | **2/5** | **3/5.** Homepage parity is solved; docs parity and real captures remain the blockers the audit named. |

**The novelty-budget row, restated (audit §5.1).** The audit's complaint was that
the homepage spends its animation and JavaScript on a generic board interaction
while the novel 0.2 interaction is absent. An earlier revision answered by
deleting the demo; this one does not, so the JavaScript budget buys the same
generic board on both pages and the new value is carried by static markup below
it. **Assessment:** §5.1 is now a question of sequence, not spend. Read strictly,
the expensive artifact still proves the old thing; read beside audit §7.1 — which
keeps the core workflow at step 7 so "Automations do not swallow the product" — the
order is right. This is the biggest editorial disagreement in the proposal, and
§7.1 asks it directly.

## 3. Section by section

Proposal order, top to bottom. Copy is quoted exactly so the two pages can be
compared without opening them.

### Proposal note bar — *no counterpart*

> Proposal — A 0.2 homepage for side-by-side review. The live page is unchanged.
> [Open the current homepage]

Fact: reviewer scaffolding only; §6 lists its deletion.

### Header

Current: Docs · Quickstart · GitHub · **Download**. Proposal: **Product** ·
**Automations** · Docs · GitHub · **Download**, with Quickstart moved into the
hero's link row. **Answers** audit §3.3 ("no Automations anchor, feature route,
0.2 release route") and §7.1 step 1 — which asks for the Automations anchor only;
`#product` is the proposal's own addition, and exists because the page now has a
product section to point at. **Trade:** the site's most-used learning link leaves
the header.

### Hero

**Current**

> The workspace for parallel coding agents.
>
> Turn a rough idea into focused tasks yourself or with an agent. Run them in
> parallel and keep every chat, branch, and change in one place.

**Proposal**

> Plan coding work. Run it in parallel. Automate the repeatable parts.
>
> Volli is a local-first macOS workspace. Plan coding work as tickets on a board,
> then run coding agents in separate worktrees. Review each change. In 0.2, save
> repeated setup as an Automation.

**Answers** audit §1.3. Fact: the headline is §1.3 verbatim; the lede is **not** —
the copy passes replaced §1.3's "Break work into tickets, give each task its own
branch and context, and save repeated setup as an Automation you stay in control
of" with four shorter sentences naming the board, the worktrees, review, and 0.2.
§1.1's recommendation survives as the caption "The workspace for parallel coding
agents". Both pages lead with "Download for Apple silicon"; the current secondary
is "Read the quickstart", the proposal's "See what's new in 0.2" (anchors
`#automations`). Link row: current Install guide · Release notes · Report a
problem; proposal Quickstart · Install guide · Release notes, with "Report a
problem" moved to the closing. Both open with the `Alpha · Apple silicon` pill.
**Decoration 1** runs here.

### Interactive demo — *identical on both pages*

Fact: `<VolliDemo client:load />` inside `<section class="hero-shell">` — the same
component in the same slot on both routes: a five-column board (Backlog, Todo,
Doing, Needs Review, Done) with draggable tickets and a ticket preview dialog. Its
nav rail renders **Home / Configure / Settings** only, the omission the audit calls
out in §3.1; neither page fixes it. **Assessment:** this slot is not a
differentiator between the two pages, it is why they cost the same JavaScript, and
it is why the proposal's argument has to be won below the fold.

### Workspace — `#product`

Current: `LifecycleAccordion` beside **"From idea to reviewed code"** and three
paragraphs of body copy, one of six items open at a time. Proposal:

> One board. A worktree per ticket. You decide what moves.
>
> Each ticket has a brief, a chat you can come back to, and changes to review. The
> board keeps work visible as you move it.

over six numbered, glyph-led items: **Turn ideas into tasks** · **Run agents in
parallel** · **Give agents the tools they need** · **Review every change** ·
**Come back any time** · **Keep your TUI workflow**.

Fact: items 1, 2, 5 and 6 carry the accordion's vetted claims; 3 and 4 are new copy
(the agent's tool surface and the `volli` CLI; the Change Set review), and 4 uses
the new `review` glyph. **Answers** audit §7.1 step 7 — keep the core workflow so
Automations do not swallow the product — promoting it from step 7 to slot three.
**Trade:** all six items are visible at once, with no click to discover, and the
current page's three prose paragraphs are redistributed: Model Access into the
trust section, the named TUIs into item 6.

### 0.2 release band — *absent from the current page*

> New in Volli 0.2
>
> **Save how work starts.**
>
> An Automation saves the instructions, trigger, and runtime for repeated work.
> Run it by hand, arm a board column, or put it on a schedule. Each run opens a
> fresh Session.

**Answers** audit §3.1 "the homepage has no release story" and §7.1 step 3. Fact:
the title is §1.3's campaign line verbatim; the pill reads "New in Volli 0.2"
rather than §1.3's "Volli 0.2 · Automations", and the lede is a rewrite of §1.3's,
not a quotation. Fact: the version string appears only here, which keeps the
durable hero reusable after 0.3 (source comment states this intent).
**Decoration 2** runs here.

### Storyboard proof — *absent from the current page*

| Caption | Copy | Panel |
| --- | --- | --- |
| **01 Save the setup** | "An automation saves the instructions, trigger, and runtime for repeated work. With Enabled on for this Mac, its trigger can start a run." | the saved record: `Enabled` switch, Instructions, Ownership / Trigger / Runtime |
| **02 It fires only on a deliberate move** | "A deliberate move into an armed column opens a 3.5-second window. Cancel it there. Tickets already in the column are left alone." | two board columns and the armed-window chip, resting at `on HB-27 · 1s` with the drain bar at 14% |
| **03 Every run opens a fresh Session** | "The instructions are the first message, and the ticket's brief supplies the context." | a Session whose first turn is the Instructions, branch `volli/HB-27-admin-audit-log`, "Started by Automation · Review handoff" |
| **04 The history stays connected** | "Each run keeps its automation, target, model, and Session together. Scheduled skips record why they didn't start and never replay automatically." | two Run rows and one skip row offering a single `Run now` |

**Answers** audit §6.3's motif (saved setup → explicit trigger → fresh Run →
visible history) and §3.4's five-step "strongest 0.2 proof", as illustration
rather than capture. **Decorations 3, 5 and 6** run here; without JavaScript, or
with reduced motion on, the chip simply reads `1s` and nothing counts.

### Three ways to start — *absent from the current page*

> **Three ways to start the same work**

| Card | Heading | Body |
| --- | --- | --- |
| **By hand** | Run it when you want | "From the Automations page, a ticket rail, a board card, or the command palette. Running by hand doesn't depend on the trigger. Need it once? **Run once** makes an Unbound Run: one-time Instructions, nothing saved." |
| **Ticket enters** | When a ticket lands in a column | "Switch it to Enabled on this Mac and its trigger counts. Name columns in the trigger and arm one automation per column. Only a deliberate move — a drag, status change, or volli CLI move — fires it. Tickets already there and lifecycle moves don't start a run." |
| **On a schedule** | Hourly, Every day, Mon–Fri, or Weekly | "In the time zone you choose. Each occurrence opens a Session for the project only while Volli is open. Scheduled skips record why they didn't start. **Run now** starts one by hand; skipped occurrences never replay themselves." |

Closer:

> Automations remove repetitive setup, not the person. Automatic triggering is
> local to this Mac. Every run starts a fresh Session, and the history shows what
> happened.

**Answers** audit §7.1 step 5, including its caveat that manual running is universal
while the other two depend on the saved trigger and per-Mac enablement — **and**
§7.1 step 6, whose six control facts are folded into these cards and the closer
instead of standing as their own strip. §1.4's guardrail is the closer's first
sentence. **Decorations 3 and 4** run here. **Trade:** the control facts no longer
read as a checklist; they are present but distributed, so a skimmer meets them one
at a time rather than as one block of reassurance.

### Local-first trust — *absent as a section*

Under **"Local-first, by construction"**, three cards: **"Your work stays on your
Mac"** ("Projects, tickets, chats, and automations — including their switches on
this Mac — live in local storage. Each ticket's worktree is an ordinary Git
checkout on your disk. Volli itself needs no account."), **"Your models, your
provider"** ("Model requests go to the provider and account you configure in Model
Access. An automation's runtime sets its model and tier. Choose Deep, Fast, or
Default model.") and **"Open source, Apache-2.0"** ("Read the source or report a
problem. The alpha is available from GitHub Releases for Apple silicon Macs.").
**Answers** audit §3.5 — trust facts are split today between the download page and
the docs, and open source is "linked but not stated".

### Closing and footer

Current: the second CTA row inside the lifecycle section — Download + "View source
on GitHub". Proposal: **"Try the 0.2 alpha"** — "For Apple silicon Macs running
macOS 12 or later. This is an alpha; report problems you find." — then Download +
"Read the docs" + "View source", and Report a problem · Security. **Answers** audit
§7.1 step 9. Both footers carry the same brand + link set; the proposal adds
`#product` and `#automations`.

## 4. Claims check

### Safe claims the proposal makes (audit §9.2)

| §9.2 claim | Proposal sentence |
| --- | --- |
| Local-first macOS workspace for parallel coding agents | "Volli is a local-first macOS workspace." + the caption "The workspace for parallel coding agents" |
| Apple-silicon alpha; install docs say macOS 12.0+ | "Alpha · Apple silicon" and "For Apple silicon Macs running macOS 12 or later." |
| Volli needs no account; model access is the user's provider | "Volli itself needs no account." / "Model requests go to the provider and account you configure in Model Access." |
| An Automation saves Trigger, Instructions, Runtime | "An Automation saves the instructions, trigger, and runtime for repeated work." + the record panel's Instructions / Trigger / Runtime fields |
| Every Automation can be run by hand | "Running by hand doesn't depend on the trigger." |
| Trigger is Nothing else / Ticket enters / On a schedule | The three card labels: "By hand", "Ticket enters", "On a schedule" |
| Automatic triggering must be enabled on this machine | "Switch it to Enabled on this Mac and its trigger counts." / "Automatic triggering is local to this Mac." |
| A column offers several, arms at most one | "Name columns in the trigger and arm one automation per column." |
| Column → Ticket Session; schedule → Board Session | Frame 03 shows the Session on ticket HB-27; the schedule card says "Each occurrence opens a Session for the project". The two kinds are shown by scope, never named. |
| The app must be open for a scheduled Run | "…only while Volli is open." |
| Fresh Session per Run, with history | "Each run opens a fresh Session." / "Each run keeps its automation, target, model, and Session together." |
| Skips recorded, not replayed | "Scheduled skips record why they didn't start. **Run now** starts one by hand; skipped occurrences never replay themselves." |
| Run once creates an Unbound Run | "**Run once** makes an Unbound Run: one-time Instructions, nothing saved." |
| Apache-2.0 source | "Open source, Apache-2.0" |

**Assessment:** every §9.2 claim now has a sentence, and the two the earlier
revision only gestured at — Unbound Run, and the `Run now` affordance on a skipped
occurrence — are stated outright. Only the Ticket/Board Session distinction is
carried by picture rather than words.

### Forbidden claims (audit §9.3)

Fact: none of the §9.3 claims appear in either file's visible copy. No sentence
calls Volli or its automations autonomous; none claims cross-machine sync,
retroactive arming, background schedules, replayed occurrences, resumed Sessions,
concurrent Runs on one ticket, CI validation, a stable/Intel/Windows build,
provider billing behavior, or any testimonial, time saving or adoption number.
Several lines are the *negations* of §9.3 items: "Tickets already there and
lifecycle moves don't start a run", "skipped occurrences never replay themselves",
"Automations remove repetitive setup, not the person".

### Borderline, stated honestly

1. **Illustrative company and tickets.** "Harbor", HB-27, HB-24, HB-32 and the
   branch `volli/HB-27-admin-audit-log` are invented, matching the demo above (the
   same Harbor board) and the app's own `volli/<DISPLAY-ID>-<slug>` shape.
   **Assessment:** low risk, now literally consistent with the demo on the page.
2. **Model ids in the Run history row.** `claude-sonnet-4-5 · medium` and
   `gpt-5 · high` make the "resolved model" fact legible (audit §2.3).
   **Assessment:** unchanged — they do not state support, but two named vendors in
   a launch visual can be read as a provider promise, and §9.3 warns against
   generalising provider behavior. Keep them (most concrete), or show one pinned
   model and one inherited tier. Reviewer's call.
3. **"macOS 12 or later"** in the closing. The audit lists this as *the install
   docs' stated requirement*; the proposal states it as the requirement. Fine if
   the 0.2 install docs still say 12.0 — worth one check at ship time.
4. **Numbers and labels not in the audit:** "a 3.5-second window", the chip's
   resting `1s`, the Runtime value "Deep", the trust card's "Deep, Fast, or Default
   model", the schedule heading "Hourly, Every day, Mon–Fri, or Weekly", "In the
   time zone you choose", and "a drag, status change, or volli CLI move". Each was
   checked against current source: `ARMED_RUN_DELAY_MS = 3500` and the single Cancel
   control in
   [`armed-run-window.tsx`](../../apps/desktop/src/renderer/src/components/automations/armed-run-window.tsx);
   `TIER_ROW.deep.label === "Deep"` / `TIER_ROW.fast.label === "Fast"` in
   [`model-access-policy.ts`](../../packages/shared/src/model-access-policy.ts) with
   "Default model" the resting choice in
   [`ticket-rail-automations.tsx`](../../apps/desktop/src/renderer/src/components/automations/ticket-rail-automations.tsx);
   `AUTOMATION_SCHEDULE_PRESET_LABELS` and the IANA `timeZone` field in
   [`automation-schedule.ts`](../../packages/shared/src/automation-schedule.ts);
   "A human drag or explicit `volli` move, as opposed to a lifecycle-driven
   auto-move" ([CONTEXT.md](../../CONTEXT.md), "Deliberate move"), and for
   "status change" specifically: `moveTicket` is documented as "A Deliberate
   move this window makes" in
   [`stores/board.ts`](../../apps/desktop/src/renderer/src/stores/board.ts) and
   is what the ticket's status field calls in
   [`ticket-properties.tsx`](../../apps/desktop/src/renderer/src/components/ticket/ticket-properties.tsx),
   beside the board drop and the context menu.
   **Assessment:** the schedule heading now uses the app's four preset labels
   exactly, an improvement on the earlier "Hourly, daily, Mon–Fri, or weekly"; the
   chip's `1s` is a still frame of a countdown rather than a claim, coherent only
   because the drain bar rests at 14% beside it. All need one re-check against the
   packaged 0.2 build (audit §8.4: keep UI labels exact).
5. **Trigger label wording.** §9.1/§9.2 call the first Trigger "Nothing else"; the
   storyboard's source comment says the app renders "Only when I run it"; the card
   says "By hand". Not a false claim, but three names for one thing — pick the
   app's exact label.
6. **"Unbound Run" now appears on the page.** Fact: "**Run once** makes an Unbound
   Run: one-time Instructions, nothing saved." **Assessment:** this closes the
   previous revision's gap and matches §9.1's canonical term, but it is the page's
   one piece of glossary vocabulary introduced without being defined — met once, in
   a subordinate clause, with no docs page yet to link to. Keep it only if the
   Automations guide ships alongside.
7. **Capitalisation.** Fact: running text writes ticket, board, worktree, branch,
   agent, chat, automation, trigger and runtime lowercase, capitalising only UI
   names (`Enabled`, `Run now`, `Run once`, `Model Access`, `Unbound Run`,
   `Session`). **Assessment:** homepage voice, but a register split with the docs,
   which capitalise Automation, Trigger and Runtime as defined terms. Deliberate,
   not an error — confirm the owner wants it.

## 5. What the proposal deliberately drops

**The interactive demo is no longer dropped.** An earlier revision removed
`VolliDemo` on audit §3.4/§5.1 grounds; it is back, in the same slot as on `/`. The
tactility gap that revision opened is closed, and the JavaScript argument for the
change is gone (≈306 KB vs ≈309 KB raw). What remains true from the audit's
complaint is that the demo teaches the old **Home / Configure / Settings**
navigation (§3.1) and is not a release capture.

**The lifecycle accordion**
([LifecycleAccordion.astro](../../apps/website/src/components/LifecycleAccordion.astro)).
Its six items survive as a still glyph grid in `#product`; the component and its
2,634 B script do not. What is lost, stated plainly:

- **The click-to-reveal glyph animation.** Each accordion item drew its own
  `FeatureGlyph` when opened — lines extending, nodes landing, the ember core
  arriving last. In the still grid every glyph is drawn at rest, all at once. That
  choreography was the second screen's reason to be touched; nothing replaces it.
- **Progressive disclosure and connective prose.** One item at a time meant one
  idea at a time and a short section; six open at once is a denser, taller read.
  "From idea to reviewed code" argued the lifecycle in three paragraphs; the grid
  asserts it in six labelled cells.

**Assessment:** the spotlight (decoration 4) restores a hover reward, but on a
different surface and with no information behind it. Whether that is an even trade
for the accordion's disclosure is a judgment for the walkthrough, not a fact.

## 6. Open items before this could ship

- [ ] Replace or supplement the storyboard panels with real 0.2 captures (audit
      P0.7, P1.1). Until then "Product proof" stays ~3/5.
- [ ] Fix the demo's nav rail, which now sits on a page about Automations and
      renders Home / Configure / Settings only (audit §3.1, P0.3). Shipping without
      this ships the contradiction on one screen.
- [ ] Point "Read the docs" at `/guides/automations/` once that page exists (audit
      §8.1). Today `automationsDocsUrl` is the docs home, and the docs home's
      concepts page still says Automations are unavailable. Fact: the source
      comment says the constant exists so a reviewer does not land on a 404 — the
      `docs/guides/automations` 404 risk is deferred, not solved.
- [ ] Verify every number and label in §4.4 against the packaged 0.2 build, and
      decide whether "Unbound Run" stays without a docs destination (§4.6).
- [ ] Regenerate the OG image for the new headline: `pnpm -C apps/website run og`
      (the proposal reuses `https://volli.app/og.png`, which carries the old one),
      and delete the `.proposal-note` bar and its styles.
- [ ] Replace the preview metadata with production values: remove
      `noindex, nofollow`, add `<link rel="canonical">` and `og:url` (the proposal
      has neither), set the real `<title>`, `og:title`, `twitter:title`,
      `twitter:description` and `og:image:*` fields, and drop the `/preview/`
      sitemap exclusion in [astro.config.mjs](../../apps/website/astro.config.mjs)
      if the route moves to `/`.
- [ ] Run the website build and asset checks: `pnpm -C apps/website build`,
      `pnpm -C apps/website run brand:check`, `pnpm -C apps/website run og:check`.
- [ ] Test keyboard traversal, reduced motion, reduced transparency and 200% zoom
      on the new sections, including the six decorations (audit Phase 2).
- [ ] Measure JavaScript transfer and LCP for both routes; the raw-byte parity above
      is not a transfer or Core Web Vitals result (audit P1.5). Decide the fate of
      `LifecycleAccordion`: kept elsewhere, or deleted.

## 7. Decision prompts

Answer these after the walkthrough, not before.

1. **Order.** The page argues board first, Automations second. Right for a release
   whose headline feature is Automations, or does 0.2 start too far down the page?
   (The §2 novelty-budget disagreement.)
2. **H1.** The page ships "Plan coding work. Run it in parallel. Automate the
   repeatable parts." The copy pass proposed but did not apply an alternative:
   **"Plan coding work. Run it in parallel. Save the repeatable setup."** It avoids
   "automate" — the word audit §1.4's guardrail treats as inviting an autonomy
   reading — but drops the feature name from the hero. Ship which?
3. **Decorations, one at a time.** For each of the six in §1.1 — headline rise, band
   beam, dot grain, card spotlight, Run-row stagger, live countdown — keep or drop.
   None carries information; each is independently reversible. Which earn their
   place, and does the set read as one material or as six effects?
4. **Duplication.** The demo and the storyboard are both fake product UI, one above
   the other. Does the second read as more proof, or as more mockup?
5. **The still grid.** Is `#product` enough without the accordion's disclosure, or
   does losing the click cost more than the density gains?
6. **Control facts.** Distributed across the three cards and the closer rather than
   listed as a six-item strip: do Automations still feel *safer* read that way, or
   did the checklist do work the distributed version does not?
7. Does "Save how work starts" read as a product upgrade, or as a scheduler?
8. **Words or sections?** Would you rather ship the proposal's copy on the current
   page's structure — is the remaining disagreement about words or about sections?
