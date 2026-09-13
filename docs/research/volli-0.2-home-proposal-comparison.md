# Volli 0.2 homepage proposal — reviewer's comparison guide

- **Compares:** the current live lander at `/` against a proposed 0.2 homepage
  at `/preview/home-0-2/`
- **Source of the proposal's brief:**
  [volli-0.2-automations-public-surface-audit.md](volli-0.2-automations-public-surface-audit.md)
- **Prepared from:** page and component source, plus the build and render checks
  listed under "Measured" below. Scores remain editorial.
- **Measured** (from `astro build` output at `09acc82e` + this proposal, and
  `astro preview` rendered headlessly):
  - JavaScript the built page references: `/` loads the React client
    (180,586 B), GSAP (69,587 B), the demo island (45,480 B), react-dom
    (11,035 B) and the accordion script (2,634 B) — about 309 KB raw, matching
    the audit's figure. `/preview/home-0-2/` carries one inline module of
    348 B and no external script.
  - `/preview/home-0-2/` renders without horizontal overflow at 390, 900 and
    1347 px wide; the storyboard is four-up above 1050 px, 2×2 to 700 px, and
    single-column below, with the ember connector turning vertical where
    frames stack.
  - With `prefers-reduced-motion: reduce` the storyboard shows every final
    state (drawn connectors, the new Run row) with no animation.
  - The sitemap built from this tree lists `/` and `/download/` only.
  - The accessibility tree exposes one `h1`, one `h2` per section, `h3` steps
    inside the storyboard, control strip, workflow and trust grids, and the
    hidden "on this machine: Review handoff" text on the Enabled switch.

This document helps a product owner decide whether the proposal is better than
the page it would replace. It uses the audit's vocabulary:

- **Fact** — read directly out of the source files linked below.
- **Assessment** — editorial judgment, not a measurement or a product fact.
- **Open item** — work the proposal does not do and must do before shipping.

## 1. How to compare

| | Current | Proposal |
| --- | --- | --- |
| Route | `/` | `/preview/home-0-2/` |
| Page | [index.astro](../../apps/website/src/pages/index.astro) | [preview/home-0-2.astro](../../apps/website/src/pages/preview/home-0-2.astro) |
| Proof component | [VolliDemo.tsx](../../apps/website/src/components/VolliDemo.tsx) (React + GSAP, `client:load`) | [AutomationStoryboard.astro](../../apps/website/src/components/AutomationStoryboard.astro) (static markup + one IntersectionObserver) |
| Second component | [LifecycleAccordion.astro](../../apps/website/src/components/LifecycleAccordion.astro) (GSAP) | none — the lifecycle is inlined as a still grid |
| Indexed | yes; in the sitemap | no; `noindex, nofollow` and excluded from the sitemap in [astro.config.mjs](../../apps/website/astro.config.mjs) |

Run both locally:

```bash
pnpm -C apps/website dev
# then open http://localhost:4321/ and http://localhost:4321/preview/home-0-2/
```

**Suggested order.**

1. **Desktop width, cold.** Read `/` top to bottom, then `/preview/home-0-2/`
   top to bottom. Do not read this guide's copy quotes first — the point is
   whether each page explains itself.
2. **Phone width.** Both pages are single-column at narrow widths; the
   proposal's storyboard, ways grid, control strip, and workflow grid all become
   vertical stacks, so the reading order becomes the argument's order.
3. **Reduced motion on** (System Settings → Accessibility → Display → Reduce
   motion). Fact: the current page's accordion calls `gsap.set(... clearProps)`
   instead of animating, and the storyboard adds `is-live` immediately and
   animates nothing. Check that both pages still say everything they need to.

The proposal deliberately carries a grey **Proposal** bar above the header
linking back to `/`. It is reviewer scaffolding and is listed for deletion in
§6.

## 2. Scorecard

Column 1 and 2 reproduce the audit's §"Launch-readiness scorecard". Column 3 is
my assessment of the proposal, from source, on the same five-point scale. Where
the proposal does not move a score, it says so.

| Dimension | Current (audit) | Proposal (assessment) |
| --- | --- | --- |
| Basic category clarity | **4/5** — "The workspace for parallel coding agents" is immediately legible. | **4/5, with a risk.** The category line survives, but as a caption under the CTA row (`.hero-category`), while the headline is now three clauses. Legibility is not obviously better; if the reviewer finds the new headline slower to parse, this is a 3/5. |
| Distinctiveness | **2/5** — accurate but increasingly generic. | **4/5.** The control model (per-Mac enablement, one armed Automation per column, deliberate moves, recorded skips) is copy no competitor page in §4 can truthfully run. |
| 0.2 feature currency | **1/5** — Automations absent from the homepage, called unavailable in docs. | **4/5 for this page; the release is still gated.** The page names 0.2, Automations, Triggers, Runs and Run history. It changes no docs, so `start/concepts.mdx` still contradicts it (§3.1), and the proposal's own "Read the docs" button points at the docs home. |
| Product proof | **2/5** — polished but illustrative, stale, does not prove the release feature. | **3/5, and capped there.** The storyboard shows the right four artifacts in the right order, but every panel is hand-built markup. There are no real screenshots and no native capture anywhere in the proposal; without one this dimension cannot honestly exceed ~3/5 (audit P0.7, P1.1). |
| Trust and control | **3/5** — alpha/platform honesty strong, Automation controls unexplained. | **4/5.** Six control statements plus a three-card local-first section; the remaining gap is that none of it is demonstrated in a real UI capture. |
| Website information architecture | **3/5** — easy to navigate, no feature/release destination, one story below the hero. | **4/5.** An `#automations` anchor in header, hero CTA and footer, a versioned release band, and five distinct sections below the hero. Still a two-route site with no `/automations/` page (audit §7.2 leaves that at P1). |
| Docs information architecture | **2/5** | **2/5 — unchanged.** The proposal touches no docs. |
| Visual craft | **4/5** — restrained, coherent, not yet ownable. | **Not assessable from source.** More rhythm exists in the markup (band, storyboard, three grids). Whether it is *ownable* is exactly what looking at the rendered page is for. |
| Conversion confidence | **3/5** — download and quickstart obvious; no release proof, use cases, or third-party trust signals. | **3/5 — unchanged.** More reasons to believe, but still zero third-party signal: no testimonials, no named users, no numbers. That is correct per audit §3.5, and it is also why this score does not move. |
| Overall 0.2 launch readiness | **2/5** | **3/5.** Homepage parity is solved; docs parity and real captures remain the blockers the audit named. |

## 3. Section by section

Proposal order, top to bottom. Copy is quoted exactly so the two pages can be
compared without opening them.

### Proposal note bar — *no counterpart*

> Proposal — A 0.2 homepage for side-by-side review. The live page is unchanged.
> [Open the current homepage]

Fact: reviewer scaffolding only; §6 lists its deletion.

### Header

- **Current:** Docs · Quickstart · GitHub · **Download**.
- **Proposal:** **Automations** · Docs · GitHub · **Download**. Quickstart moves
  into the hero's link row.
- **Answers:** §3.3 "There is no Automations anchor, feature route, 0.2 release
  route"; §7.1 step 1.
- **Trade:** the site's most-used learning link (Quickstart) leaves the header.

### Hero

**Current headline and lede**

> The workspace for parallel coding agents.
>
> Turn a rough idea into focused tasks yourself or with an agent. Run them in
> parallel and keep every chat, branch, and change in one place.

**Proposal headline and lede**

> Plan coding work. Run it in parallel. Automate the repeatable parts.
>
> Volli is a local-first macOS workspace for people and coding agents. Break
> work into tickets, give each task its own branch and context, and save
> repeated setup as an Automation you stay in control of.

- **Answers:** §1.3 master copy — the proposal's headline and lede are that
  block verbatim. §1.1: keep the category line as a descriptor, not the whole
  promise — it survives as a caption, "The workspace for parallel coding
  agents".
- **CTAs:** both pages lead with "Download for Apple silicon". The current
  secondary is "Read the quickstart"; the proposal's is "See what's new in 0.2"
  (anchors to `#automations`).
- **Both** open with the `Alpha · Apple silicon` pill above the headline.

### 0.2 release band — *absent from the current page*

> Volli 0.2 · Automations
>
> **Save how work starts.**
>
> Create an Automation once, then run it by hand, arm a board column with it,
> or put it on a schedule. Every Automation Run starts a fresh Session and
> leaves a history you can return to.

- **Answers:** §3.1 "the homepage has no release story"; §7.1 step 3. This is
  §1.3's campaign copy verbatim.
- Fact: the version string appears only here, which is what keeps the durable
  hero reusable after 0.3 (source comment states this intent).

### Storyboard proof — *current slot holds the interactive demo*

- **Current:** `<VolliDemo client:load />` — a five-column board (Backlog, Todo,
  Doing, Needs Review, Done) with draggable tickets and a ticket preview dialog.
  Fact: its nav rail renders **Home / Configure / Settings** only — the omission
  the audit calls out in §3.1.
- **Proposal:** four static panels with captions —
  **01 Save it once** ("A name, the Instructions, one Trigger, and a Runtime…"),
  **02 It fires only on a deliberate move** ("…a 3.5-second window opens with
  one control: Cancel. Tickets already sitting there are left alone."),
  **03 Every Run is a fresh Session** ("The Instructions land as the first
  message… A Run never wakes an old chat."),
  **04 The history stays connected** ("…A missed schedule is recorded with its
  reason — never replayed behind your back.").
- **Answers:** §6.3 visual grammar (saved setup → explicit Trigger → fresh Run →
  visible history); §3.4's five-step "strongest 0.2 proof" — the storyboard
  covers steps 1–5 as illustration, not as capture; §5.1 novelty budget.

### Three ways to start — *absent*

> **Three ways to start the same work.** Running by hand is always on the table.
> The other two depend on the saved Trigger and on the Automation being switched
> on for this Mac.

Cards: "Run it when you want" / "When a ticket lands in a column" / "Hourly,
daily, Mon–Fri, or weekly". Footnote: "Need it once? **Run once** sends one-time
Instructions from a ticket without saving an Automation at all."

- **Answers:** §7.1 step 5 exactly, including its caveat that manual running is
  universal while the other two depend on Trigger and per-Mac enablement.

### Control strip — *absent*

> **Automations remove repetitive setup, not the person.** Every switch that
> lets work start without you is local to this Mac and visible on the board.

Six items: Off by default on a new Mac · One armed Automation per column · Only
deliberate moves fire it · A fresh Session for every Run · Schedules need Volli
open · Skips are recorded, not replayed.

- **Answers:** §7.1 step 6 (all six lines, same order) and §1.4's guardrail —
  the heading is the audit's launch idea, stated as a limit rather than as
  autonomy.

### Workflow grid

- **Current:** `LifecycleAccordion` beside the headline **"From idea to reviewed
  code"** and three paragraphs of body copy. One of six items is open at a time;
  the other five are collapsed behind buttons.
- **Proposal:** the same headline, the same six item titles and descriptions,
  rendered as a numbered still grid with `FeatureGlyph` icons, under the
  standfirst "Automations start work; the board, the worktrees, and the review
  loop are where it happens."
- **Answers:** §7.1 step 7 — keep the core workflow so Automations do not
  swallow the product.
- **Trade:** all six steps are now visible at once (no click to discover); the
  current page's three prose paragraphs, including the Model Access link and the
  named TUIs in running text, are compressed into the grid.

### Local-first trust — *absent as a section*

Three cards: **"Your work stays on your Mac"** ("…live in local storage. Volli
itself needs no account."), **"Your models, your provider"** ("Model requests go
to the provider and account you configure in Model Access."), **"Open source,
Apache-2.0"**.

- **Answers:** §3.5 — trust facts today are split between the download page and
  the docs, and open source is "linked but not stated".

### Closing

- **Current:** the second CTA row inside the lifecycle section — Download +
  "View source on GitHub". Install guide, Release notes, and Report a problem
  live in the hero's link row.
- **Proposal:** **"Try the 0.2 alpha"** — "Apple silicon, macOS 12 or later.
  Expect rough edges and changes between builds — and say so when you hit one."
  Download + "Read the docs" + "View source", then Report a problem · Security.
- **Answers:** §7.1 step 9 (download, docs, source, issue).

### Footer

Both carry the same brand + link set; the proposal adds an `#automations` entry.

## 4. Claims check

### Safe claims the proposal makes (audit §9.2)

| §9.2 claim | Proposal sentence |
| --- | --- |
| Local-first macOS workspace for parallel coding agents | "Volli is a local-first macOS workspace for people and coding agents." + "The workspace for parallel coding agents" |
| Apple-silicon alpha; install docs say macOS 12.0+ | "Alpha · Apple silicon" and "Apple silicon, macOS 12 or later." |
| Volli needs no account; model access is the user's provider | "Volli itself needs no account." / "Model requests go to the provider and account you configure in Model Access." |
| An Automation saves Trigger, Instructions, Runtime | "A name, the Instructions, one Trigger, and a Runtime." |
| Every Automation can be run by hand | "Running by hand is always on the table." |
| Trigger is Nothing else / Ticket enters / On a schedule | The three cards: "By hand", "Ticket enters", "On a schedule" |
| Automatic triggering must be enabled on this machine | "A Trigger counts only where somebody switched the Automation on." |
| A column offers several, arms at most one | "A column can offer several and fires at most one." |
| Column → Ticket Session; schedule → Board Session | "A deliberate move opens a Ticket Session on that ticket." / "Each occurrence opens a Board Session for the project while Volli is open." |
| The app must be open for a scheduled Run | "A scheduled Run starts only while the app is running." |
| Fresh Session per Run, with history | "A Run never wakes an existing chat…" and "Each Run keeps its Automation, its target, and the model it actually resolved." |
| Skips recorded, not replayed | "A due time that passed is listed with its reason… the backlog never fires on its own." |
| Run once creates an Unbound Run | "**Run once** sends one-time Instructions from a ticket without saving an Automation at all." |
| Apache-2.0 source | "Open source, Apache-2.0" |

### Forbidden claims (audit §9.3)

Fact: none of the §9.3 claims appear in either file's visible copy. No sentence
calls Volli or its Automations autonomous; no sentence claims cross-machine
sync, retroactive arming, background schedules, replayed occurrences, resumed
Sessions, concurrent Runs on one ticket, CI validation, a stable/Intel/Windows
build, provider billing behavior, or any testimonial, time saving, or adoption
number. Several of the control-strip lines are the *negations* of §9.3 items.

### Borderline, stated honestly

1. **Illustrative company and tickets.** "Harbor", HB-27, HB-24, HB-32, and the
   branch `volli/HB-27-admin-audit-log` are invented, matching the convention
   the current demo already uses (its ticket set is the same Harbor board) and
   the app's own `volli/<DISPLAY-ID>-<slug>` branch shape.
   **Assessment:** low risk, and consistent with the live page.
2. **Model ids in the Run history row.** `claude-sonnet-4-5 · medium` and
   `gpt-5 · high` are there to make the "resolved model" fact legible (§2.3
   inspectability). **Assessment:** they do not state support, but two named
   vendors in a launch visual can be read as a provider promise, and §9.3 warns
   against generalising provider behavior. Options: keep them (most concrete),
   or show one pinned model and one inherited tier instead. Reviewer's call.
3. **"macOS 12 or later"** in the closing. The audit lists this as *the install
   docs' stated requirement*; the proposal states it as the requirement. Fine if
   the 0.2 install docs still say 12.0 — worth one check at ship time.
4. **Numbers and labels not in the audit.** "a 3.5-second window" (caption 02,
   with `3s` on the panel), the Runtime value "Deep", the schedule list "Hourly,
   every day, Mon–Fri, or weekly", "In the time zone you choose", and "a move
   from the volli CLI" are all more specific than anything §9.2 covers. Each
   was checked against current source: `ARMED_RUN_DELAY_MS = 3500` and the
   single Cancel control in
   [`armed-run-window.tsx`](../../apps/desktop/src/renderer/src/components/automations/armed-run-window.tsx);
   `TIER_ROW.deep.label === "Deep"` in
   [`model-access-policy.ts`](../../packages/shared/src/model-access-policy.ts);
   `AUTOMATION_SCHEDULE_PRESET_LABELS` (Hourly / Every day / Mon–Fri / Weekly)
   and the IANA `timeZone` field in
   [`automation-schedule.ts`](../../packages/shared/src/automation-schedule.ts);
   Deliberate moves arriving from the renderer and from `volli ticket move`
   (CONTEXT.md, "Deliberate move"). They still need one re-check against the
   packaged 0.2 build before shipping (§8.4: keep UI labels exact).
5. **Trigger label wording.** §9.1/§9.2 call the first Trigger "Nothing else";
   the storyboard's source comment says the app renders "Only when I run it";
   the page's card says "By hand". Not a false claim, but three names for one
   thing — pick the app's exact label.
6. **"Unbound Run" is not used.** The page describes the behavior without the
   canonical term. **Assessment:** acceptable for a homepage, since §9.1 governs
   vocabulary rather than banning plain language, but the docs guide should
   introduce the term.

## 5. What the proposal deliberately drops

**The interactive demo** ([VolliDemo.tsx](../../apps/website/src/components/VolliDemo.tsx)).
Rationale: audit §3.4 — it is bespoke React/GSAP UI rather than a release
capture, it teaches the old **Home / Configure** navigation, and it hydrates on
load for roughly **309 KB of raw JavaScript** across demo, React, GSAP, and
accordion chunks (the audit's figure, not a measured transfer size). §5.1: spend
the novelty budget on the new value.

**The lifecycle accordion**
([LifecycleAccordion.astro](../../apps/website/src/components/LifecycleAccordion.astro)).
Its six items survive as a still grid; the GSAP glyph choreography and the
disclosure interaction do not.

**What is lost, stated plainly:**

- **Tactility.** Dragging a ticket between columns is the one moment the current
  page lets a visitor *do* something. The storyboard is read, not touched.
- **The ticket preview dialog.** Clicking a card opens a focus-managed dialog
  with a scratchpad, a chat transcript, a review view, and a phase switcher —
  the closest thing the site has to showing the inside of a ticket. Nothing in
  the proposal replaces it.
- **Motion as reward.** The accordion's per-item glyph animations gave the
  second screen a reason to be clicked.
- **Board scale.** The demo shows five columns and eight tickets; the storyboard
  shows two columns.

## 6. Open items before this could ship

- [ ] Replace the storyboard panels with real 0.2 captures, or add one native
      clip beside them (audit P0.7, P1.1). Until then, "Product proof" stays ~3/5.
- [ ] Point "Read the docs" at `/guides/automations/` once that page exists
      (§8.1). Today `automationsDocsUrl` is the docs home — and the docs home's
      concepts page still says Automations are unavailable (§3.1). Shipping this
      page before the docs fix creates a visible contradiction.
- [ ] Verify every number and label named in §4.4–§4.5 above against the
      packaged 0.2 build.
- [ ] Regenerate the OG image for the new headline: `pnpm -C apps/website run og`
      (the proposal currently reuses `https://volli.app/og.png`, which carries
      the old headline).
- [ ] Delete the `.proposal-note` bar and its styles.
- [ ] Replace the preview metadata with production values: remove
      `noindex, nofollow`, add `<link rel="canonical">` and `og:url` (the
      proposal has neither), set the real `<title>`, `og:title`, `twitter:title`,
      `twitter:description` and `og:image:*` fields, and drop the `/preview/`
      sitemap exclusion in [astro.config.mjs](../../apps/website/astro.config.mjs)
      if the route moves to `/`.
- [ ] Run the website build and asset checks: `pnpm -C apps/website build`,
      `pnpm -C apps/website run brand:check`, `pnpm -C apps/website run og:check`.
- [ ] Test keyboard traversal, reduced motion, reduced transparency, and 200%
      zoom on the new sections (audit Phase 2).
- [ ] Measure JavaScript transfer and LCP for both routes and record the delta,
      rather than assuming the storyboard is cheaper (audit P1.5).
- [ ] Decide the fate of `VolliDemo` and `LifecycleAccordion`: kept elsewhere,
      rebuilt with the Automations nav row (audit P0.3), or deleted.

## 7. Decision prompts

Answer these after the walkthrough, not before:

1. Does the hero still read as a category in three seconds, with the category
   line demoted to a caption under the CTAs?
2. Is the storyboard understandable with the captions covered — do the four
   panels tell the story on their own?
3. Does the control strip make Automations feel *safer*, or merely more
   complicated? Would four items land better than six?
4. Is dropping the interactive demo a net loss at the top of the fold — and
   would a real capture change that answer?
5. Does "Save how work starts" read as a product upgrade or as a scheduler?
6. Is the still workflow grid enough to keep the core product visible, or does
   0.2 now dominate the page?
7. Would you rather ship the proposal's copy on the current page's structure —
   i.e. is the disagreement about words or about sections?
