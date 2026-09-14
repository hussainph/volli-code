# Volli 0.2 homepage proposal — reviewer's comparison guide

- **Compares:** the current live lander at `/` against a proposed 0.2 homepage at
  `/preview/home-0-2/`
- **Source of the proposal's brief:**
  [volli-0.2-automations-public-surface-audit.md](volli-0.2-automations-public-surface-audit.md)
- **Prepared from:** page and component source, plus the checks below; scores
  remain editorial. **Covers `d091449f`** — round three, which returned the H1 to
  the live page's category line, demoted the release band to an ordinary section
  head, and turned the three ways to start into three lines. It supersedes
  `eba2095b` (product-first restructure, two copy passes, six decorations).
  Earlier revisions of this guide described a version with no interactive demo
  and a six-fact control strip.
- **Measured** (raw bytes in `apps/website/dist/_astro` after
  `pnpm -C apps/website build`, plus `astro preview` rendered headlessly through
  `playwright-core` at four widths):
  - **Both** pages load the React client (180,586 B) and the demo island
    (45,480 B), which import GSAP (69,587 B) and react-dom (11,035 B); `/` also
    loads the accordion script (2,634 B). That is ≈309 KB raw for `/` and
    ≈306 KB raw for `/preview/home-0-2/` — the same cost, to within one small
    chunk. The proposal adds two inline modules: 516 B (storyboard observer +
    countdown) and **297 B** (the release beam observer; it was 581 B before the
    card spotlight went). These are uncompressed bytes on disk, not transfer
    sizes.
  - No horizontal overflow at 390, 700, 900 or 1347 px — `scrollWidth` equals
    `clientWidth` at each. The storyboard is four-up above 1050 px, 2×2 to
    700 px, single-column at and below it, with the ember connector turning
    vertical where frames stack; the workspace grid steps 3 → 2 (≤1050 px) → 1
    (≤620 px); trust steps 3 → 1 (≤820 px); the ways list keeps its label column
    until 560 px, then stacks. The demo board scrolls horizontally inside its own
    container on narrow screens, as it does on `/`.
  - Under `prefers-reduced-motion: reduce` the storyboard shows every final state
    (drawn connectors, the new Run row, the drain bar at its resting 14%), the
    headline clauses rest in place (`animation-name: none`, opacity 1, no
    transform), and the beam never runs (`animation-name: none`, the section head
    never gains `is-live`).
  - With motion allowed, the beam arms only once the release head scrolls in
    (`is-live` absent on load, `beam-sweep` applied after), with no console
    errors.
  - `astro check` reports 0 errors; `astro build` emits 3 routes; the sitemap
    lists `/` and `/download/` only; the proposal carries `noindex, nofollow`.
  - The accessibility tree exposes one `h1`, one `h2` per section, and `h3` in
    the storyboard, workspace grid and trust cards — **no `h4` survives**, since
    the ways cards carried the only ones. It also exposes the hidden "on this
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

Fact: round three (`d091449f`) went further in the same direction. The release
section had kept a visual promotion the order no longer matched — a centred band
with its own glow and a 56 px title, which read as a second hero — and the three
ways to start were a card grid that mirrored `#product`'s. Both are now ordinary:
the band is a `.section-head` like every other, with the version as an eyebrow
pill, and the ways are three lines. **Assessment:** the page now has five
sections of one typographic weight, and "Automations are one section among five"
is true of the design and not only of the outline.

```bash
pnpm -C apps/website dev
# then open http://localhost:4321/ and http://localhost:4321/preview/home-0-2/
```

**Suggested order.** (1) Desktop, cold: read `/`, then the proposal, without this
guide's quotes — the point is whether each page explains itself; reload once to
catch the headline entrance, which runs only on load. (2) Phone width: both are
single-column, so reading order becomes the argument's order. (3) Reduced motion
on: the accordion calls `gsap.set(... clearProps)` rather than animating, the
storyboard adds `is-live` at once and skips the countdown, and the headline and
beam are off in `home-0-2.css`. The grey **Proposal** bar above the header is
reviewer scaffolding, deleted per §6 — as is the `<title>`, which currently reads
"Volli 0.2 homepage proposal | …".

### 1.1 Where the five decorations come from

Fact: the proposal carries five visual decorations the live page does not. All
are plain CSS (plus the 297 B module that arms the beam), add no dependency, and
are off under `prefers-reduced-motion`. The page reads identically without any of
them.

| # | Decoration | Where | How |
| --- | --- | --- | --- |
| 1 | Headline clauses rise once behind masks, on load | hero `h1` | `hero-rise`, 720 ms, 110 ms stagger |
| 2 | Ember beam sweeps the pill's edge once when the release head scrolls in | "New in 0.2" | conic gradient, `@property --beam-angle`, masked ring |
| 3 | ~4% dot grain | storyboard panels | static `radial-gradient` tile |
| 5 | Run-row stagger in frame 04 | storyboard | older rows rise at 2950/3100 ms, the new row at 3350 ms |
| 6 | Live countdown in the armed-window chip | storyboard frame 02 | `3 → 2 → 1`, in step with the drain bar |

Fact: **decoration 4, the pointer-following spotlight, is gone** with the ways
cards it lit, and the release band's radial glow went with the band. The numbering
above is kept so it still matches the shortlist. Decoration 3 now appears on the
storyboard panels only, where it was always the stronger of its two homes.

Fact: these are items 1–6 of the ranked shortlist in
[volli-0.2-home-ui-ideas.md](volli-0.2-home-ui-ideas.md) — the decision record for
them, which links its three sources
([Magic UI](volli-0.2-home-ui-ideas-magicui.md),
[Cult UI](volli-0.2-home-ui-ideas-cult-ui.md),
[`/pick-ui-library`](volli-0.2-home-ui-ideas-library-pick.md)). It recommended 1–3
first and 4–6 as a second step; the owner took the bundle, and round three gave
back the one that needed a card to sit on. Items 7–10 (section-head blur-fade,
bento rhythm, typing Instructions, scroll-progress hairline) were not taken.
**Assessment:** since none carries information, each is a separate keep/drop call,
not a package (§7).

## 2. Scorecard

Columns 1 and 2 reproduce the audit's §"Launch-readiness scorecard". Column 3 is
my assessment of the proposal, from source, on the same scale.

| Dimension | Current (audit) | Proposal (assessment) |
| --- | --- | --- |
| Basic category clarity | **4/5** — "The workspace for parallel coding agents" is immediately legible. | **4/5, risk resolved.** Round three put that exact line back in the `h1`, so both pages now lead with the same sentence and the proposal no longer argues its category twice. The three-clause headline and its `.hero-category` caption are both gone. What changes is the lede beneath it, not the category. |
| Distinctiveness | **2/5** — accurate but increasingly generic. | **4/5.** The control model (per-Mac enablement, one armed automation per column, deliberate moves, recorded skips) is copy no competitor in audit §4 can truthfully run. |
| 0.2 feature currency | **1/5** — Automations absent from the homepage, called unavailable in docs. | **4/5 for this page; the release is still gated.** The page names 0.2, automations, triggers, runs and Run history. It changes no docs, so `start/concepts.mdx` still contradicts it, and "Read the docs" still lands on the docs home. |
| Product proof | **2/5** — polished but illustrative, stale, does not prove the release feature. | **3/5, capped.** There is more proof than before — the interactive board *and* a four-frame storyboard — but both are hand-built markup, with no capture anywhere (audit P0.7, P1.1). Restoring the demo also restores audit §3.1's defect: its nav rail renders **Home / Configure / Settings** and never shows Automations, on a page whose second half is about Automations. |
| Trust and control | **3/5** — alpha/platform honesty strong, Automation controls unexplained. | **3/5, down from 4/5 at `eba2095b`.** The control facts are still present, but round three cut the closing paragraph that carried §1.4's guardrail ("Automations remove repetitive setup, not the person") and three of the explicit control sentences with the cards — see §4, which lists exactly what is no longer said. What remains is distributed across three lines and the storyboard. Still nothing demonstrated in a real capture. |
| Website information architecture | **3/5** — easy to navigate, no feature/release destination, one story below the hero. | **4/5.** `#product` and `#automations` in header and footer, a versioned release eyebrow, four distinct sections below the demo. Round three made those sections one weight, so the page reads as a list of equals rather than a hero and a banner. Still a two-route site with no `/automations/` page (audit §7.2 leaves that at P1). |
| Docs information architecture | **2/5** | **2/5 — unchanged.** The proposal touches no docs. |
| Visual craft | **4/5** — restrained, coherent, not yet ownable. | **Not assessable from source.** The five decorations in §1.1 are the direct answer to audit §6.2's "not yet ownable"; whether they read as one material or as five effects is what looking at the rendered page is for. Round three pulled the page back toward "restrained" — one section weight, no glow, no hover light — which may help coherence and may cost ownability. |
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

> The workspace for parallel coding agents.
>
> Coding agents work your tickets in parallel, each in its own worktree. You
> review every change. Local-first, on your Mac.

Fact: **the headline is now identical to `/`**, set as two masked clauses so it
can still rise on load. Round three reverted audit §1.3's "Plan coding work. Run
it in parallel. Automate the repeatable parts." and deleted the `.hero-category`
caption that had carried §1.1's line beneath it; keeping both meant the hero
stated its category twice. The `.hero-headline--proposal` measure override went
with them, so the clauses now break at the shared 20ch measure exactly as `/`
does. **Assessment:** the only remaining hero difference is the lede — the
comparison here is between two sentences of lede, not between two headlines, which
makes decision prompt 2 much narrower than it was.

Fact: the lede no longer names 0.2 or the word "Automation"; the release is
announced by the secondary CTA and the section below. Both pages lead with
"Download for Apple silicon"; the current secondary is "Read the quickstart", the
proposal's "See what's new in 0.2" (anchors `#automations`). Link row: current
Install guide · Release notes · Report a problem; proposal Quickstart · Install
guide · Release notes, with "Report a problem" moved to the closing. Both open
with the `Alpha · Apple silicon` pill. **Decoration 1** runs here.

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

> One board. A worktree per ticket.
>
> Each ticket has a brief, a chat you can come back to, and changes to review.

over six numbered, glyph-led items: **Turn ideas into tasks** · **Run agents in
parallel** · **Real tools for agents** · **Review every change** · **Come back any
time** · **Keep your TUI workflow**.

Fact: round three cut the head's third clause ("You decide what moves.") and the
lede's second sentence ("The board keeps work visible as you move it."), and
renamed item 3 from "Give agents the tools they need". **Assessment:** "You decide
what moves" was the page's clearest statement of human control outside the
Automations section; losing it is part of the §4 pattern, not only a trim.

Fact: items 1, 2, 5 and 6 carry the accordion's vetted claims; 3 and 4 are new copy
(the agent's tool surface and the `volli` CLI; the Change Set review), and 4 uses
the new `review` glyph. **Answers** audit §7.1 step 7 — keep the core workflow so
Automations do not swallow the product — promoting it from step 7 to slot three.
**Trade:** all six items are visible at once, with no click to discover, and the
current page's three prose paragraphs are redistributed: Model Access into the
trust section, the named TUIs into item 6.

### 0.2 release head — *absent from the current page*

> New in 0.2
>
> **Save how work starts.**
>
> Save the instructions, trigger, and runtime once. Run it by hand, arm a board
> column, or put it on a schedule. Each run opens a fresh Session.

**Answers** audit §3.1 "the homepage has no release story" and §7.1 step 3. Fact:
the title is §1.3's campaign line verbatim; the pill reads "New in 0.2" — round
three dropped the word "Volli" from it — rather than §1.3's "Volli 0.2 ·
Automations", and the lede is a rewrite of §1.3's, not a quotation. Fact: the
version string appears only here, which keeps the durable hero reusable after 0.3
(source comment states this intent).

Fact: this was a `.release-band` — centred, its own radial glow, a
`clamp(40px, 4.4vw, 56px)` title, 52 px of padding beneath it. It is now the same
`.section-head` the other four sections use, with the pill as an eyebrow above a
left-aligned `h2`; the glow is deleted and the title inherits the standard
`h2` size. **Decoration 2** still runs here, now armed by `[data-release-head]`.
**Assessment:** this is the single biggest visual change in round three and the
main thing to judge — whether the release still arrives with enough occasion, or
whether it now slides past as one more section.

### Storyboard proof — *absent from the current page*

All four captions were rewritten in round three; the panels are unchanged.

| Caption | Copy | Panel |
| --- | --- | --- |
| **01 Save the setup** | "Instructions, trigger, and runtime, saved once. Enabled on this Mac lets the trigger count." | the saved record: `Enabled` switch, Instructions, Ownership / Trigger / Runtime |
| **02 Only on a deliberate move** | "Dropping a ticket into an armed column opens a 3.5-second window with one control: Cancel. Tickets already there are left alone." | two board columns and the armed-window chip, resting at `on HB-27 · 1s` with the drain bar at 14% |
| **03 A fresh Session per run** | "The instructions are its first message; the ticket's brief is the context." | a Session whose first turn is the Instructions, branch `volli/HB-27-admin-audit-log`, "Started by Automation · Review handoff" |
| **04 One connected history** | "Each run keeps its automation, target, model, and Session. Skips are recorded with a reason, never replayed." | two Run rows and one skip row offering a single `Run now` |

Fact: caption 02 now names the Cancel control explicitly ("with one control:
Cancel"), which the previous wording only implied, and — with the ways list — is
now the only place the page says a deliberate move is required. Caption 01 is the
page's one remaining statement that automatic triggering depends on per-Mac
enablement. Fact: the storyboard's panel minimum narrowed from 300 px to 260 px
so four frames still fit the section's measure.

**Answers** audit §6.3's motif (saved setup → explicit trigger → fresh Run →
visible history) and §3.4's five-step "strongest 0.2 proof", as illustration
rather than capture. **Decorations 3, 5 and 6** run here; without JavaScript, or
with reduced motion on, the chip simply reads `1s` and nothing counts.

### Three ways to start — *absent from the current page*

Fact: at `eba2095b` this was a subheaded three-card grid ("Three ways to start the
same work") with an `h4` per card and a closing paragraph. Round three made it
three lines in a `ul`, with no subhead, no headings and no closer — a label column
and a sentence each.

| Line | Body |
| --- | --- |
| **By hand** | "From the Automations page, a ticket, or the command palette. **Run once** sends one-time Instructions without saving anything." |
| **Ticket enters** | "Arm one automation per column, on this Mac. Only a deliberate move — a drag, a status change, or a volli CLI move — fires it. Tickets already there are left alone." |
| **On a schedule** | "Hourly, Every day, Mon–Fri, or Weekly, in your time zone, while Volli is open. Skips are recorded with a reason, never replayed." |

**Answers** audit §7.1 step 5 and, partly, §7.1 step 6. **Fact: four statements
left the page with the cards and the closer, and §4 shows which §9.2 claims they
were carrying:**

1. "Running by hand doesn't depend on the trigger." — §7.1 step 5's explicit
   caveat that manual running is universal while the other two depend on the
   saved trigger and per-Mac enablement.
2. "Each occurrence opens a Session **for the project**" — the only words that
   distinguished a schedule's Board Session from a column's Ticket Session.
3. "Tickets already there **and lifecycle moves** don't start a run." — the
   lifecycle-move negation; the "already there" half survives.
4. The whole closer, including §1.4's guardrail "Automations remove repetitive
   setup, not the person" and "Automatic triggering is local to this Mac."

Fact: "Unbound Run" is also gone — "**Run once** sends one-time Instructions
without saving anything" states the behaviour without the term. That resolves
§4.6 below in the direction it recommended, since no docs page defines the term
yet.

**Decoration 3** no longer runs here and **decoration 4** is deleted. **Trade:**
the section is much quieter and no longer competes with `#product`'s grid, but the
control model is now carried by two storyboard captions and three half-sentences.
**Assessment:** items 1 and 4 are worth arguing about before this ships; a
reassurance a skimmer never meets is not a reassurance, and §1.4's guardrail was
the one sentence on the page written specifically against an autonomy reading.

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
on GitHub". Proposal: **"Try the alpha"** — "Apple silicon, macOS 12 or later.
Report the problems you find." — then Download + "Read the docs" + "View source",
and Report a problem · Security. **Answers** audit §7.1 step 9. Both footers carry
the same brand + link set; the proposal adds `#product` and `#automations`.

Fact: round three cut "0.2" from this heading and compressed the platform line.
The page's remaining mentions of the version are the eyebrow "New in 0.2", the
hero's "See what's new in 0.2" CTA and the scaffolding `<title>`. Fact: "This is
an alpha" is gone from the closing, though the hero's `Alpha · Apple silicon` pill
still says it.

## 4. Claims check

### Safe claims the proposal makes (audit §9.2)

Checked against `d091449f`. ✓ fully stated · ◑ partly stated · ✗ no longer on the
page.

| §9.2 claim | | Proposal sentence |
| --- | --- | --- |
| Local-first macOS workspace for parallel coding agents | ✓ | The `h1` "The workspace for parallel coding agents." + "Local-first, on your Mac." |
| Apple-silicon alpha; install docs say macOS 12.0+ | ✓ | "Alpha · Apple silicon" and "Apple silicon, macOS 12 or later." |
| Volli needs no account; model access is the user's provider | ✓ | "Volli itself needs no account." / "Model requests go to the provider and account you configure in Model Access." |
| An Automation saves Trigger, Instructions, Runtime | ✓ | "Save the instructions, trigger, and runtime once." + frame 01 + the record panel's fields |
| Every Automation can be run by hand | ◑ | "By hand — From the Automations page, a ticket, or the command palette." **The clause that it does not depend on the trigger is gone**, so a reader is told where to run it by hand, not that it always works. |
| Trigger is Nothing else / Ticket enters / On a schedule | ✓ | The three labels: "By hand", "Ticket enters", "On a schedule" |
| Automatic triggering must be enabled on this machine | ✓ | Frame 01: "Enabled on this Mac lets the trigger count." + "Arm one automation per column, on this Mac." (the closer's "Automatic triggering is local to this Mac" is gone; frame 01 now carries this alone) |
| A column offers several, arms at most one | ✓ | "Arm one automation per column" |
| Column → Ticket Session; schedule → Board Session | ✗ | Frame 03 still shows a Session on ticket HB-27, but "Each occurrence opens a Session **for the project**" was cut. Nothing now indicates a schedule's Session has a different scope. |
| The app must be open for a scheduled Run | ✓ | "…while Volli is open." |
| Fresh Session per Run, with history | ✓ | "Each run opens a fresh Session." / "Each run keeps its automation, target, model, and Session." |
| Skips recorded, not replayed | ✓ | "Skips are recorded with a reason, never replayed." (in both frame 04 and the schedule line; the `Run now` affordance is now shown in the panel but no longer stated in prose) |
| Run once creates an Unbound Run | ◑ | "**Run once** sends one-time Instructions without saving anything." The behaviour is stated; **the term "Unbound Run" is no longer used** — see §4.6. |
| Apache-2.0 source | ✓ | "Open source, Apache-2.0" |

**Assessment:** eleven of fourteen claims are stated outright, two partly, one not
at all. Round three traded claim coverage for quiet: every loss in this table came
from deleting the ways cards and their closer, not from a decision about any of
these claims individually. Two are worth restoring in a line each — that running
by hand always works, and that a schedule's Session belongs to the project — and
the "Unbound Run" omission is a defensible answer to §4.6 rather than a gap.

### Forbidden claims (audit §9.3)

Fact: none of the §9.3 claims appear in either file's visible copy. No sentence
calls Volli or its automations autonomous; none claims cross-machine sync,
retroactive arming, background schedules, replayed occurrences, resumed Sessions,
concurrent Runs on one ticket, CI validation, a stable/Intel/Windows build,
provider billing behavior, or any testimonial, time saving or adoption number.
Two negations of §9.3 items survive round three: "Tickets already there are left
alone" and "Skips are recorded with a reason, never replayed".

**Assessment — changed at `d091449f`.** The page still makes no forbidden claim,
which is the test that matters. But it no longer *denies* one either: "Automations
remove repetitive setup, not the person" and the lifecycle-move negation were both
cut, and `#product` lost "You decide what moves." The safest sentences on the page
were the ones written against an autonomy reading, and they were the easiest to cut
because they read as reassurance rather than information. Compliance with §9.3 is
unchanged; the posture §1.4 asked for is thinner.

### Borderline, stated honestly

1. **Illustrative company and tickets.** "Harbor", HB-27, HB-24, HB-32 and the
   branch `volli/HB-27-admin-audit-log` are invented, matching the demo above (the
   same Harbor board) and the app's own `volli/<DISPLAY-ID>-<slug>` shape.
   **Assessment:** low risk, now literally consistent with the demo on the page.
2. **Model names in the Run history row — changed, and worth one check.** Round
   three replaced the raw ids `claude-sonnet-4-5 · medium` and `gpt-5 · high` with
   display names: **`Claude Sonnet 4.5 · medium`** and **`GPT-5 · high`**. Fact:
   model labels are not hardcoded in this repo — they arrive from the provider
   catalogue at runtime, and the app stores only `providerId`/`modelId`/
   `reasoningLevel` (see the automation run fixtures). So no label can be confirmed
   from source alone. Fact: every example label the repo does contain is a
   versioned display name — `Claude Sonnet 4.5`, `GPT-5.6 Luna`, `GPT-5.3 Codex`,
   `GPT-5.3 Codex Spark` — and a bare `GPT-5` matches none of them.
   **Assessment:** as ids, both strings were plainly identifiers and carried no
   claim about a label; as display names they assert what the app prints, and one
   of the two looks like a vendor's marketing name rather than a catalogue entry.
   That is what audit §8.4 ("keep UI labels exact") is about. Either finish the
   change against a real 0.2 catalogue, or revert both to ids. The older concern
   stands too: two named vendors in a launch visual can be read as a provider
   promise, and §9.3 warns against generalising provider behavior.
3. **"macOS 12 or later"** in the closing. The audit lists this as *the install
   docs' stated requirement*; the proposal states it as the requirement, and round
   three compressed it to the fragment "Apple silicon, macOS 12 or later." Fine if
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
   storyboard's source comment says the app renders "Only when I run it"; the page
   says "By hand". Not a false claim, but three names for one thing — pick the
   app's exact label. Unchanged by round three.
6. **"Unbound Run" has been removed again.** Fact: the line now reads "**Run
   once** sends one-time Instructions without saving anything" — the behaviour
   §9.2 asks for, without §9.1's canonical term. **Assessment:** this takes the
   option the previous revision of this guide recommended ("keep it only if the
   Automations guide ships alongside"), and it is the right call while the docs
   destination does not exist. Revisit when `/guides/automations/` ships: the term
   should appear on the page the first time there is somewhere to define it.
7. **Capitalisation.** Fact: running text writes ticket, board, worktree, branch,
   agent, chat, automation, trigger and runtime lowercase, capitalising only UI
   names (`Enabled`, `Run now`, `Run once`, `Model Access`, `Session`) — with
   `Instructions` capitalised in the ways list and the storyboard because it names
   the field. `Unbound Run` has left the page (§4.6). **Assessment:** homepage
   voice, but a register split with the docs, which capitalise Automation, Trigger
   and Runtime as defined terms. Deliberate, not an error — confirm the owner
   wants it.

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

**Assessment:** at `eba2095b` the card spotlight (decoration 4) at least restored a
hover reward, on a different surface and with no information behind it. Round
three removed that too, so the page now has **no hover-reactive surface at all**
where the live page had a click-reactive one. Whether the density gain is worth
both is a judgment for the walkthrough, not a fact.

**Round three additionally drops** (all detailed in §3 and §4): the release band
and its glow, the three ways cards with their `h4`s and dot grain, the pointer
spotlight, the closing control paragraph, four claim-bearing statements, the term
"Unbound Run", the `.hero-category` caption, the three-clause headline, and
"You decide what moves." from `#product`. **Assessment:** each cut is individually
reasonable and the page is calmer and shorter for them; the pattern worth
reviewing is that the majority of what went was *reassurance about control*, which
is the one thing audit §1.4 asked this release's copy to be careful about.

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
- [ ] Verify every number and label in §4.4 against the packaged 0.2 build.
- [ ] **Settle the two Run-history model names (§4.2)** against a running 0.2
      build, since labels come from the provider catalogue and not from source:
      either use two real catalogue labels or revert both to ids. `GPT-5` matches
      no example label in the repo.
- [ ] **Decide whether to restore the four control statements round three cut
      (§3, §4).** In priority order: §1.4's guardrail ("Automations remove
      repetitive setup, not the person"), that running by hand does not depend on
      the trigger, that a schedule's Session belongs to the project, and that
      lifecycle moves do not start a run. Each is one clause; the question is
      whether the quieter section can afford them.
- [ ] Delete the `.proposal-note` bar and its styles. Fact: the OG image no longer
      needs regenerating for the headline — round three restored the live `h1`, so
      `https://volli.app/og.png` matches again; confirm with
      `pnpm -C apps/website run og:check` rather than assuming.
- [ ] Replace the preview metadata with production values: remove
      `noindex, nofollow`, add `<link rel="canonical">` and `og:url` (the proposal
      has neither), set the real `<title>`, `og:title`, `twitter:title`,
      `twitter:description` and `og:image:*` fields, and drop the `/preview/`
      sitemap exclusion in [astro.config.mjs](../../apps/website/astro.config.mjs)
      if the route moves to `/`. Fact: the `<title>` currently announces itself as
      a proposal ("Volli 0.2 homepage proposal | …") and `og:title` does not.
- [ ] Run the website build and asset checks: `pnpm -C apps/website build`,
      `pnpm -C apps/website run brand:check`, `pnpm -C apps/website run og:check`.
- [ ] Test keyboard traversal, reduced transparency and 200% zoom on the new
      sections (audit Phase 2). Reduced motion and the responsive steps are
      measured above and pass; these three are not.
- [ ] Measure JavaScript transfer and LCP for both routes; the raw-byte parity above
      is not a transfer or Core Web Vitals result (audit P1.5). Decide the fate of
      `LifecycleAccordion`: kept elsewhere, or deleted.

## 7. Decision prompts

Answer these after the walkthrough, not before.

1. **Order.** The page argues board first, Automations second. Right for a release
   whose headline feature is Automations, or does 0.2 start too far down the page?
   (The §2 novelty-budget disagreement.)
2. **H1 — answered, confirm it.** Round three shipped the live page's "The
   workspace for parallel coding agents.", dropping both audit §1.3's three-clause
   headline and the alternative the copy pass floated. The hero is now identical to
   `/` except for its lede. Confirm that is the intent, and if so the open question
   shrinks to: does the lede — "Coding agents work your tickets in parallel, each
   in its own worktree. You review every change. Local-first, on your Mac." — beat
   the live one? Note it is the first hero in three revisions not to mention 0.2.
3. **Decorations, one at a time.** Five remain (§1.1) — headline rise, release-head
   beam, dot grain, Run-row stagger, live countdown. None carries information; each
   is independently reversible. Which earn their place, and does the set read as one
   material or as five effects? The spotlight is already gone; nothing on the page
   now responds to hover (§5).
4. **Duplication.** The demo and the storyboard are both fake product UI, one above
   the other. Does the second read as more proof, or as more mockup?
5. **The still grid.** Is `#product` enough without the accordion's disclosure, or
   does losing the click cost more than the density gains?
6. **Control facts — the sharpest question in this revision.** They were a six-item
   strip, then three cards plus a closer, and are now three half-sentences and two
   storyboard captions, with §1.4's guardrail deleted (§4). Do Automations still
   feel *safe* read that way? §6 lists the four clauses that would restore them;
   the cost of taking them back is a longer, busier section.
7. **Occasion.** The release is now typographically identical to every other
   section (§3). Does 0.2 still arrive as an event, or did demoting the band take
   the announcement with it? Does "Save how work starts" read as a product upgrade,
   or as a scheduler?
8. **Words or sections?** Would you rather ship the proposal's copy on the current
   page's structure — is the remaining disagreement about words or about sections?
   Round three narrowed this: with the same `h1` on both pages and the release
   demoted to an ordinary section, the structural gap between `/` and the proposal
   is smaller than it has been at any point in this ticket.
