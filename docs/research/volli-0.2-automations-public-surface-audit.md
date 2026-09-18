# Volli 0.2 Automations public-surface audit

- **Audit baseline:** `09acc82e` (`v0.2.0-canary.9-3-g09acc82e`)
- **Release reference:** `v0.2.0-canary.9` at `14561a08`
- **Public surfaces observed:** [volli.app](https://volli.app/),
  [docs.volli.app](https://docs.volli.app/), and the public competitor/brand
  pages linked below
- **Research date:** 2026-09-13

This is a positioning, content, information-architecture, and visual-identity
audit for the 0.2 Automations release. It does not change the website or docs,
publish a release, or claim that unreleased behavior is available.

## How to read this audit

To keep product facts separate from editorial judgment:

- **Verified product fact** means the behavior is supported by the current
  product source, shared domain vocabulary, tests, or current public source.
- **Observed** means the statement describes a public page as it appeared during
  the audit. Competitor copy and metrics can change.
- **Interpretation** means an assessment, not a product fact.
- **Recommendation** means proposed launch work, not behavior that already
  ships.

## Executive diagnosis

Volli's product is ahead of its public story.

The current public surface establishes a local-first macOS workspace for
parallel coding agents, names the Apple-silicon alpha, leads with a download
path, and demonstrates the existing idea-to-review loop. It is more coherent
and trustworthy than it was at the alpha-launch baseline. The
single-channel download page, current metadata, sitemap, `robots.txt`, focused
navigation, and accessible interaction details are all strengths worth
preserving.

But the 0.2 release's defining addition is almost completely absent:

- The homepage contains no Automations language.
- The product demo renders **Home / Configure**, while the product now ships
  **Home / Automations / Configure**.
- The docs' only direct explanation says Automations are “in development” and
  “not available to configure yet.”
- The docs do not explain the distinction between Trigger, enablement, offering,
  and Arming—the control model that makes Automations credible rather than
  vague “autonomy.”
- There is no real product capture of the Automations page, an armed board move,
  a scheduled Run, a ticket-rail Run, or Run history.

The release therefore has two jobs, in this order:

1. **Restore factual parity.** A visitor must see the feature the app actually
   ships, and no public page may describe it as unavailable.
2. **Turn that parity into a position.** Volli should own the idea of a
   **local-first system of work for people and coding agents**, where repeated
   setup can be saved and triggered without giving up visible, machine-local
   control.

The opportunity is not to become another site that says “orchestrate agents.”
That phrase is already crowded. Volli can be more precise:

> Plan the work, run it in parallel, and save how repeated work starts.

The 0.2 launch idea should be:

> **Automations remove repetitive setup, not the person.**

That is both differentiated and supported by the product model.

## Launch-readiness scorecard

These scores are editorial assessments on a five-point scale, not test results.

| Dimension | Score | Diagnosis |
| --- | ---: | --- |
| Basic category clarity | 4/5 | “The workspace for parallel coding agents” is immediately legible. |
| Distinctiveness | 2/5 | The category phrase is accurate but increasingly generic; Volli's board, local-first control, and Automations model are not doing enough positioning work. |
| 0.2 feature currency | 1/5 | Automations are absent from the homepage and falsely described as unavailable in docs. |
| Product proof | 2/5 | The interactive board is polished, but it is illustrative, stale, and does not prove the release feature. |
| Trust and control | 3/5 | Alpha/platform honesty and local-data language are strong; machine-local Automation controls are not explained. |
| Website information architecture | 3/5 | The two-route site is easy to navigate, but it has no feature/release destination and only one substantive story below the hero. |
| Docs information architecture | 2/5 | Search, sidebar, Markdown mirrors, and `llms.txt` are strong; the 0.2 feature has no user path. |
| Visual craft | 4/5 | The site is restrained, coherent, responsive, and accessible in source. It is not yet visually ownable. |
| Conversion confidence | 3/5 | Download and quickstart are obvious. Visitors lack release proof, use cases, or third-party trust signals. |
| Overall 0.2 launch readiness | 2/5 | The platform is sound, but content parity and release proof are launch blockers. |

## 1. The position Volli should occupy

### 1.1 Current position

The current public category line is:

> The workspace for parallel coding agents.

Its supporting explanation is concrete: turn an idea into tasks, run those tasks
in parallel, and keep chats, branches, and changes together. This is materially
better than an abstract “AI development platform” claim.

The weakness is competitive compression. Conductor says it runs parallel coding
agents in isolated workspaces. T3 Code calls itself a control plane for coding
agents. Herdr says it is where coding agents live. All four products in this
research use some combination of **agents**, **parallel**, **orchestrate**,
**workspace**, and **control**.

**Recommendation:** Keep the current line as a category descriptor, not the
whole brand promise. Pair it with a more ownable lead sentence and a control
story only Volli can tell accurately.

### 1.2 Recommended messaging hierarchy

1. **Emotional outcome:** routine agent work no longer starts from a blank box.
2. **Category:** a local-first macOS workspace for parallel coding agents.
3. **Mechanism:** plan on a board; save Instructions, Trigger, and Runtime as an
   Automation; inspect each Run and Session.
4. **Control:** run by hand at any time; enable automatic triggering per Mac;
   each column can arm at most one Automation, and only a Deliberate-move
   arrival can fire it; skipped schedules are visible rather than silently
   replayed.
5. **Proof:** one real 0.2 workflow, shown from Automation authoring through Run
   history.

### 1.3 Recommended master copy

A durable, non-versioned homepage direction:

> **Plan coding work. Run it in parallel. Automate the repeatable parts.**
>
> Volli is a local-first macOS workspace for people and coding agents. Break work
> into tickets, give each task its own branch and context, and save repeated
> setup as an Automation you stay in control of.

A versioned 0.2 campaign direction:

> **Volli 0.2 · Automations**
>
> **Save how work starts.**
>
> Create an Automation once, then run it by hand, arm a board column with it, or
> put it on a schedule. Every Automation Run starts a fresh Session and leaves a
> history you can return to.

The first direction can remain after 0.2. The second should be a release band,
feature page, or launch module with a version attached; it should not make the
entire product sound like a scheduler.

### 1.4 Positioning guardrail

Do not describe Volli as “autonomous.” The product's strongest design decision
is the opposite: automation is bounded and inspectable.

- An Automation saves setup.
- Its Trigger says what can start it besides a person.
- Enablement, Arming, and rank are machine-local.
- Every Run owns a fresh Session.
- Missed scheduled occurrences are recorded and not replayed.
- A person can still run an Automation by hand when automatic triggering is
  off.

This is a premium-product story: calm, predictable leverage rather than maximum
agent spectacle.

## 2. What the current public surfaces do well

### 2.1 Website strengths

**Clear first screen.** The homepage puts the category, alpha status, supported
architecture, download CTA, quickstart, install guide, release notes, and issue
path before the product visual. See
[`index.astro`](../../apps/website/src/pages/index.astro#L46-L100).

**Honest availability.** “Alpha · Apple silicon” is prominent. The download page
uses one Alpha channel, explains prerelease risk, and resolves the current build
from GitHub Releases instead of hard-coding a version. See
[`download.astro`](../../apps/website/src/pages/download.astro#L60-L139) and
[`releases.ts`](../../apps/website/src/lib/releases.ts).

**Concrete workflow language.** “From idea to reviewed code” explains tasks,
chats, worktrees, branches, and review without leading on internal architecture.
The terminal is correctly framed as an optional companion, not the primary
experience. See
[`index.astro`](../../apps/website/src/pages/index.astro#L102-L147).

**Good public-surface hygiene.** Canonicals, Open Graph/Twitter metadata, social
images, theme color, sitemap generation, `robots.txt`, and working footer routes
are present. These were meaningful gaps in the earlier alpha audit.

**Accessible intent in source.** The page has a skip link, visible focus styles,
reduced-motion handling, reduced-transparency handling, and higher-contrast
adjustments. The interactive demo restores focus when its preview closes and
announces state changes.

**Coherent art direction.** Mona Sans, near-black surfaces, warm ember, restrained
hairlines, soft depth, and generous whitespace form a consistent system across
the website and docs. The site does not imitate the rainbow gradients common to
AI product launches.

### 2.2 Docs strengths

**Good basic orientation.** The docs explain local-first storage, no Volli
account, Model Access, Tickets, Sessions, and worktrees in plain language. The
homepage clearly separates getting started, working in Volli, and help.

**Strong document tooling.** Search is prominent; each page has a copy action;
Markdown mirrors and `/llms.txt` make the docs practical for coding-agent users.
The build deliberately fails when a content page is omitted from the `llms.txt`
index. See
[`llms.txt.ts`](../../apps/docs/src/pages/llms.txt.ts#L4-L68).

**Consistent visual system.** The docs reuse Volli's palette and type while
preserving familiar documentation structure. This is a good application of a
“novelty budget”: the docs are meant to be read, not decoded.

**Existing Automation provenance.** The board guide already states that ticket
history can attribute an event to an automation. This is a useful trust bridge
to the new feature.

### 2.3 Product strengths the launch should expose

These are verified from the current domain and renderer source:

- **A coherent saved object.** An Automation is a saved name, Trigger,
  Instructions, and Runtime—not a loose collection of toggles.
- **Manual and triggered starts.** Every Automation can run by hand. Beyond
  that, its one Trigger chooses Nothing else, a ticket entering named columns,
  or a schedule; only the latter two can start work automatically.
- **Clear target semantics.** A column-triggered Run opens a Ticket Session; a
  scheduled Run opens a Board Session for the project. The app must be open for
  a scheduled Run to start.
- **Safe defaults.** A new Automation's Trigger is “Nothing else”; automatic
  trigger behavior is off on a machine until somebody enables it.
- **Separate offering and firing.** A column can offer several Automations but
  arm at most one; only a Deliberate-move arrival can fire it.
- **Inspectability.** Runs retain their resolved model/reasoning and Session
  relationship; skipped schedule occurrences are recorded with a reason.
- **Fresh context.** Every Automation Run starts a fresh Session instead of
  silently waking stale context.
- **Flexible execution policy.** Runtime can inherit, name a model tier, or pin a
  model-and-reasoning pair. An unreadable stored Runtime is kept as invalid and
  refuses to run rather than silently becoming inheritance.
- **Explicit listing scope.** Ownership lists an Automation in one project or in
  all projects; it does not determine a Run's target.
- **Manual escape hatch.** The **Run once** UI action creates an **Unbound Run**
  without saving a new Automation.
- **Native board integration.** The ticket rail, card menu, board movement,
  Automations page, and command palette provide Run doors without duplicating
  the authoring form.

This is more thoughtful than the generic promise “automate your workflow.” The
public launch should show the design, not flatten it.

## 3. Where the current surfaces fall short

### 3.1 P0 factual gaps

#### The docs directly contradict the release

[`start/concepts.mdx`](../../apps/docs/src/content/docs/start/concepts.mdx#L107-L111)
says Automations are in development and unavailable to configure. The product
has a top-level Automations destination, a full editor, lanes, enablement,
Arming, Run history, ticket-rail controls, card-menu Run actions, scheduled
Triggers, and Run once.

This sentence cannot ship with a release that presents Automations as its
largest update.

#### The website demo teaches the old navigation

The real app defines **Home / Automations / Configure** in
[`nav-list.tsx`](../../apps/desktop/src/renderer/src/components/sidebar/nav-list.tsx).
The marketing demo renders Home and Configure only. Because the demo is the
largest artifact on the page, the omission communicates that Automations are
secondary or nonexistent.

#### The homepage has no release story

The homepage's lifecycle ends at review. No heading, paragraph, visual, CTA, or
metadata names 0.2 or Automations. Someone arriving from release coverage would
not find confirmation that they are on the right product page.

### 3.2 Documentation staleness beyond Automations

The 0.2 pass should not amplify adjacent statements that current source has
already disproved:

- **Storage:** The settings guide places retention under General and orphaned
  worktrees under a Worktrees pane. The product now has **Settings → Storage**,
  which unifies retention, running processes, build-artifact trimming, Pi
  session logs, orphan cleanup, and database/export controls. See
  [`storage-pane.tsx`](../../apps/desktop/src/renderer/src/components/settings/panes/storage-pane.tsx#L1-L122).
- **Compaction:** The guide says each visible model has a configurable reserve.
  Current product source explicitly retired per-model reserve controls; only the
  Automatic compaction switch remains. See
  [`model-access-settings.tsx`](../../apps/desktop/src/renderer/src/components/pages/model-access-settings.tsx#L22-L31)
  and
  [`compaction-policy.ts`](../../packages/shared/src/compaction-policy.ts#L9-L31).
- **Web Search credentials:** The guide says Brave and Exa keys are in the macOS
  keychain. Current source migrates legacy keys out of `safeStorage` and stores
  them in the profile's user-only Application Support database; the value is not
  returned to the renderer after save. See
  [`web/credential.ts`](../../apps/desktop/src/main/web/credential.ts#L1-L27).
- **Project Files:** The ticket-workspace guide refers to a project-level Files
  page. Project Files now open inside Home; there is no standalone Files nav
  destination.
- **Theming screenshot:** The theming guide still contains an explicit screenshot
  TODO.

These are release-trust defects, not merely documentation polish.

### 3.3 Information-architecture gaps

**Website:** The navigation offers Docs, Quickstart, GitHub, and Download. That
is enough for an alpha utility site, but not enough to launch a category-shaping
feature. There is no Automations anchor, feature route, 0.2 release route, FAQ,
or clear open-source/local-control summary.

**Docs:** The current tree contains 12 content pages plus the docs index. That is
a good restrained baseline, but Automations have no route through it. The docs
home cards, Concepts glossary, Board guide, Ticket workspace, Chats and
worktrees, Settings, keyboard reference, CLI reference, and Troubleshooting all
need some level of 0.2 integration.

**README/release surface:** The README is honest about alpha status and the
parallel-work lifecycle but does not mention Automations. GitHub is both the
source destination and release host, so this absence weakens the launch path for
visitors who bypass the website.

### 3.4 Product-proof gaps

The current product preview is bespoke React/GSAP UI rather than a release
capture. It proves that Volli has a board concept, but not that the desktop app
contains the exact 0.2 experience.

It also hydrates on page load. The website build emits approximately **309 KB of
raw JavaScript** across the demo, React client/runtime, GSAP, and lifecycle
accordion chunks. That is not a measured transfer-size or Core Web Vitals
result, but it is enough to justify a performance budget. An interaction this
expensive should prove a launch-critical behavior.

The strongest 0.2 proof would be one real native workflow:

1. Create an Automation with Instructions, Trigger, and Runtime.
2. Enable it on this Mac.
3. Arm it for a board column.
4. Move a ticket and show the cancellable delay.
5. Open the resulting fresh Session from Run history.

No current public visual shows any of those steps.

### 3.5 Trust and conversion gaps

**Trust is present but dispersed.** The download page explains local data and
model-provider requests, while the docs explain that Volli itself needs no
account. Neither the hero nor an Automations section turns these facts into one
memorable trust sentence.

**Open source is linked but not stated.** “View source on GitHub” is useful, but
competitors make the posture explicit. Volli can truthfully name its
Apache-2.0-licensed source without making it the whole brand.

**Provider posture is underexplained.** T3 Code makes “bring your own
subscription” a hero-level differentiator. Volli should clearly state that
Model Access uses accounts/providers the user configures and that Volli itself
needs no account. The exact billing behavior varies by provider and should not
be generalized beyond that.

**No borrowed credibility.** There are no testimonials, usage figures, named
users, awards, case studies, or reliability numbers. It is correct not to invent
them. For 0.2, real product evidence and transparent release notes should carry
trust until honest social proof exists.

## 4. Competitive landscape

Competitor claims below are observations from their public pages, not claims
Volli has independently validated.

| Product | Public category claim | Strongest proof pattern | Trust/CTA pattern | Lesson for Volli | Do not copy |
| --- | --- | --- | --- | --- | --- |
| [Herdr](https://herdr.dev/) | A runtime where coding agents keep running, distinct from manager apps | Live-feeling multipane terminal; architecture explanation; explicit [comparison matrix](https://herdr.dev/compare/) | Install command, source, funding signal, technical docs | Own a precise category boundary and explain what persists/where it runs | Terminal-native density or a runtime claim; Volli is a workspace and review system, not Herdr's runtime category |
| [Conductor (`conductor.build`)](https://www.conductor.build/) | Run parallel coding agents on a Mac in isolated workspaces | Workspace/branch/files/terminal/diff/review path, mostly proven through [docs](https://www.conductor.build/docs) | Direct Mac download, support/community, pricing and enterprise trust | State the outcome plainly and prove the full task-to-review loop | Generic “parallel agents in workspaces” as the only differentiator |
| [T3 Code](https://t3.codes/) | The open-source control plane for coding agents | Provider login commands, inline diff/PR artifact, real fork transcript | BYO subscription, source license, community metrics | Make open-source/provider posture explicit and turn claims into concrete UI artifacts | Founder-snark voice if it is not Volli's voice; unsupported community metrics |
| [Oh My Pi](https://omp.sh/) | A coding agent with the IDE wired in | Technical inventories, benchmarks, short capability clips, broad install matrix | Open source, install command, provider breadth | Use precise technical evidence where it matters; one short clip per job | A spec-sheet homepage; Volli's value is the system around agents, not one agent's tool count |

### 4.1 The whitespace

The four products cluster into three categories:

1. **Agent runtimes/harnesses:** where the agent process lives or how capable it
   is (Herdr, Oh My Pi).
2. **Parallel workspace managers:** isolated workspaces, branches, diffs, and
   review (Conductor).
3. **Agent control planes:** one interface across provider CLIs and clients (T3
   Code).

Volli overlaps the second and third categories but has an additional organizing
object: the **Ticket and board as durable work state**. Automations make that
system active: work can respond to intentional board movement or time while
retaining a Run/Session history.

A defensible position is therefore:

> **The local-first work system for people and coding agents.**

Use “workspace for parallel coding agents” immediately below it for category
clarity. Do not claim that Volli is the only product with parallelism,
worktrees, model choice, or automation.

### 4.2 A future comparison page

Herdr's comparison page succeeds because it compares architectures, concedes
where products pair well, and identifies one sorting question. Volli should not
rush into a hostile checklist for 0.2. Once the positioning is stable, an honest
comparison could sort products with these questions:

- Is the organizing object a terminal, workspace, thread, or durable ticket?
- Does it include planning and review, or only execution?
- Does repeated work have a saved record, explicit Trigger, and Run history?
- Which controls are local to one Mac?
- Does each automated invocation start fresh context?
- What survives when the UI or app closes?

Every row must be verified against current competitor behavior before
publication.

## 5. Premium Mac brand lessons

### 5.1 Arc and Dia: spend novelty on the new value

The Browser Company's Dia design essay describes a “Tuesday morning” test and a
“novelty budget”: familiar browser mechanics reduce learning cost so novelty can
be spent on Chat and Skills. See
[“The strategy behind Dia's design”](https://browsercompany.substack.com/p/the-strategy-behind-dias-design).

**Application to Volli:**

- Keep site navigation, docs, download, and forms familiar.
- Spend expressive motion and color on the moment an Automation becomes a Run.
- Do not redesign every surface to make 0.2 feel large.
- Explain the new concept with familiar nouns and one clear path.

The current docs already follow this principle. The homepage demo does not: it
spends substantial animation and JavaScript on a generic board interaction
while the novel 0.2 interaction is absent.

### 5.2 Things: calm confidence and “simply powerful” hierarchy

[Things](https://culturedcode.com/things/) leads with outcomes, restraint, and
native-product confidence. It lets the interface and long-term credibility carry
complexity instead of listing every option in the hero.

**Application to Volli:** Lead with “Save how work starts,” then reveal Trigger,
Runtime, Arming, schedules, skips, and Run history progressively. Do not put the
entire Automation glossary above the fold.

### 5.3 Raycast: pair feeling with evidence

[Raycast](https://www.raycast.com/) pairs an emotional promise (“never wasting
[time]”) with concrete interaction language, product breadth, named users, and a
reliability number.

**Application to Volli:** Pair “remove repetitive setup” with the actual saved
fields and Run artifact. Add metrics only after Volli has a reproducible way to
measure them; no invented time-saved or reliability claim belongs in 0.2.

### 5.4 Linear: make the product artifact the hero

[Linear](https://linear.app/) makes product objects—issues, agent activity,
plans, diffs, and code—the evidence behind system-level positioning.

**Application to Volli:** Show an Automation record, a ticket moving, the
cancellable firing state, and the Run's Session/history. A stylized lightning
bolt alone is branding; the connected artifacts are proof.

### 5.5 Nova and Panic: earn personality through details

[Nova](https://nova.app/) shows that a serious Mac developer tool can have a
recognizable voice and iconography without sacrificing clarity.

**Application to Volli:** Keep the calm dark system, but give the release a
specific visual signature: the lightning glyph, an Automation-to-Run line, and a
single warm “voltage” moment. Avoid adding a second gradient language or copying
Arc's cream/blue palette.

## 6. Visual-identity audit

### 6.1 What to preserve

- **Near-black canvas and ember accent.** They feel focused and mature.
- **Mona Sans with restrained weights.** The type is contemporary without
  becoming a display gimmick.
- **Hairlines, soft depth, and generous measure.** These feel closer to a native
  productivity tool than a crypto/AI landing page.
- **One obvious primary CTA.** The ember download button carries the hierarchy.
- **Small uppercase status labels.** “Alpha · Apple silicon” works as truthful
  microcopy, not decoration.
- **Dark-only web/docs coherence.** A dark-only brand surface is defensible; the
  app can still support appearance choice.

### 6.2 What feels generic

Dark canvas + white grotesk + orange CTA is polished but common among developer
tools. The current identity is primarily a palette, not yet a recognizable
visual grammar. Remove the logo and product name, and the hero could belong to
several adjacent products.

The page also has only two major storytelling gestures: a centered hero/demo and
a lifecycle accordion. There is not enough rhythm for a major release—no
versioned launch band, product-detail macro, real capture, trust strip, or
release-specific closing idea.

### 6.3 Recommended 0.2 visual grammar

Use one motif consistently:

> **Saved setup → explicit Trigger → fresh Run → visible history**

Represent it with a thin ember path or pulse connecting four real product
artifacts. The lightning icon marks the Automation/actor, but should not become a
generic electric background.

Recommended motion behavior:

- The saved record remains still.
- A Trigger creates one brief pulse.
- The pulse resolves into a new Run row/Session, rather than looping forever.
- Motion stops under reduced-motion preference and never carries essential
  information alone.
- Board-move proof should show the actual cancel window; decorative ambient mesh
  can remain secondary.

This uses the existing brand system while spending novelty exactly where 0.2 is
new.

## 7. Recommended website story and information architecture

### 7.1 Homepage sequence

1. **Header** — Brand; Automations anchor; Docs; GitHub; Download.
2. **Hero** — durable master promise; category descriptor; Alpha/Apple-silicon
   disclosure; Download; secondary “See Automations.”
3. **0.2 release band** — “Volli 0.2 · Automations / Save how work starts.”
4. **Real product proof** — short native capture or progressively enhanced
   storyboard of author → enable/arm → move/schedule → Run history.
5. **Ways to start** — Run by hand / Automatically when a ticket enters /
   Automatically on a schedule. State that manual running is universal, while
   the latter two depend on the saved Trigger and per-Mac enablement.
6. **Control strip** — Off by default on a new Mac / At most one armed Automation
   per column / Only Deliberate-move arrivals fire an armed Automation / Fresh
   Session per Run / The app must be open for a scheduled Run / Skips are
   recorded, not replayed.
7. **Core Volli workflow** — retain the idea → tasks → parallel Sessions → review
   story so Automations do not swallow the product.
8. **Local-first trust** — projects, tickets, Sessions, Automation settings, and
   worktrees live locally; model requests go to the configured provider; Volli
   itself needs no account.
9. **Open-source/alpha CTA** — Download; read 0.2 docs; inspect source; report an
   issue.

### 7.2 Whether to add `/automations/`

**P0:** An anchored homepage section is enough to restore launch parity quickly.

**P1:** Add a dedicated `/automations/` page if the homepage explanation becomes
compressed. It should be a product page, not a second docs guide:

- problem and outcome,
- one real use case,
- manual running plus the two automatic Trigger types,
- control/locality explanation,
- product proof,
- link to exact docs.

Do not add a generic “Features” megamenu for a two-page alpha site.

### 7.3 Example section copy

**Write it once.** Save the Instructions and Runtime you reach for repeatedly.

**Run it your way.** Start it by hand, arm a board column with it, or put it on a
schedule.

**Know what happened.** Every Automation Run starts a fresh Session. Run history
keeps the Automation, target, and resolved model connected.

**You switch it on.** Automatic triggering is local to this Mac. A new machine
starts with it off; running by hand still works.

## 8. Recommended docs architecture

### 8.1 Minimum 0.2 change

Add one task-oriented page at `guides/automations` and register it in both:

- the Starlight sidebar in
  [`apps/docs/astro.config.mjs`](../../apps/docs/astro.config.mjs#L79-L112), and
- `SECTIONS` in
  [`apps/docs/src/pages/llms.txt.ts`](../../apps/docs/src/pages/llms.txt.ts#L16-L40).

Suggested sidebar placement:

```text
Using Volli
  The board
  Automations
  Ticket workspace
  Chats and worktrees
  Settings
  Theming
```

### 8.2 Automations guide outline

1. **What an Automation saves** — name, Trigger, Instructions, Runtime.
2. **Create one** — Automations page is the only authoring surface; project vs
   global Ownership controls where the record is listed.
3. **Choose a Trigger** — Nothing else, Ticket enters, On a schedule.
4. **Understand targets** — column Trigger opens a Ticket Session; schedule opens
   a Board Session.
5. **Run by hand** — available regardless of enablement; Automations page, ticket
   rail, board card, and command palette doors.
6. **Enable automatic triggering** — machine-local switch; off by default.
7. **Offer versus arm** — a Trigger can offer an Automation in several columns;
   each column can arm at most one, and only a Deliberate-move arrival can fire
   it.
8. **Choose during a move** — Option-drag picker, digits 1–9, `0` Move only,
   armed item pinned to `1` when effective.
9. **Set Runtime** — inherit, tier, or exact model/reasoning pin.
10. **Use Instructions** — ordinary prose plus `/` Skills/templates and `@` file
    references, resolved when the Run starts.
11. **Run once and Unbound Runs** — introduce the UI action and the domain term:
    one-time Instructions without a saved Automation.
12. **Read history and skips** — open the Session; understand interrupted Runs;
    state directly that the app must be open for a scheduled Run to start and
    that missed occurrences are recorded and not replayed.
13. **Machine-locality and portability** — explain the record, enablement,
    Arming, and rank according to verified release behavior. Add a cross-machine
    Skill path only if its packaged-build UX is verified; make no file-layout
    promise.
14. **Troubleshoot** — Trigger configured but disabled, offered but not armed,
    ticket already in column, Run already in flight, invalid Runtime, app closed
    at schedule time, and recorded skip reasons.

### 8.3 Required updates to existing pages

| Page | Required 0.2 correction |
| --- | --- |
| Docs home | Add Automations to the hero journey and card grid; retain the broader workspace story. |
| Concepts | Replace the “in development” stub with canonical definitions for Automation, Trigger, Instructions, Runtime, Run, Unbound Run, Enabled automation, Armed automation, Offered list, and Option-drag picker. |
| Quickstart | Add one Automation after the reader completes a normal task manually; do not make first-run comprehension depend on Automations. |
| Board | Explain the armed-column exception, deliberate moves, offering vs Arming, Option-drag, digits, Move only, and the cancellable delay. Preserve the rule that Session signals do not advance ticket status. |
| Ticket workspace | Add the Automations rail, the **Run once** action and **Unbound Run** term, Run history, and Open Session path; correct Project Files wording. |
| Chats and worktrees | Explain that each Run owns a fresh Session and where column/schedule targets work. |
| Settings | Rewrite around current Models, Web Search, Integrations, and Storage; remove retired reserve/keychain/Worktrees-pane claims. Link to Automations for Runtime inheritance rather than duplicating its semantics. |
| CLI | State that the agent socket exposes no general Automation authoring commands; document the automation Actor in ticket events and only verbs present in the release CLI. |
| Keyboard shortcuts | Add the board picker's discoverable Option/digit interactions only after verifying them in the release candidate. |
| Troubleshooting | Add machine-local enablement/Arming, invalid Runtime, in-flight Run, and schedule-skip cases. |
| Theming | Resolve or explicitly defer the screenshot TODO. |

### 8.4 Documentation style

Use task language before vocabulary:

- Start with “Run this review whenever a ticket enters Needs Review.”
- Then explain why the Automation is offered, enabled, and armed.
- Put exact invariants in notes or reference tables.
- Use one screenshot per decision, not one screenshot per heading.
- Keep all UI labels exact and capitalized as the app presents them.

## 9. Terminology and claims ledger

### 9.1 Canonical terms

| Use | Meaning | Avoid |
| --- | --- | --- |
| **Automation** | A saved named way to start work: Trigger, Instructions, Runtime | recipe, preset, workflow, template, pipeline |
| **Trigger** | What starts an Automation besides a person | event, hook, condition |
| **Instructions** | The prompt an Automation sends when it opens its Session | prompt template, Ticket Body, Runtime Brief |
| **Runtime** | The Automation's execution policy | model alone, harness, agent |
| **Run** | One invocation and its record; it owns one fresh Session | job, task, session |
| **Unbound Run** | A one-time Run with its own Instructions and no Automation | ad-hoc/draft/one-shot automation |
| **Enabled automation** | An Automation switched on for automatic triggering on this machine | active, paused, archived, “on” without context |
| **Armed automation** | The one Automation a column fires on a deliberate arrival | default automation |
| **Offered list** | Automations a column presents for a deliberate move | automation menu, column automations |
| **Option-drag picker** | The expanded Offered list shown while Option is held during a drag | palette, radial menu, drag menu |
| **Session** | The durable conversation/terminal record a Run owns | Run |

The full canonical definitions live in
[`CONTEXT.md`](../../CONTEXT.md#L767-L878). Shared implementation types are in
[`automation.ts`](../../packages/shared/src/automation.ts#L1-L240).

### 9.2 Safe public claims

- Volli is a local-first macOS workspace for parallel coding agents.
- The alpha is for Apple-silicon Macs; the current install docs specify macOS
  12.0 or later.
- Volli itself needs no account; model access uses a provider/account the user
  configures.
- An Automation saves a Trigger, Instructions, and Runtime.
- Every Automation can be run by hand.
- A Trigger can be Nothing else, Ticket enters, or On a schedule.
- Automatic triggering must be enabled on this machine.
- A column can offer several Automations and arm at most one.
- A column Trigger starts a Ticket Session; a schedule starts a Board Session.
- The app must be open for a scheduled Run to start.
- Every Automation Run starts a fresh Session and keeps a history relationship
  to it.
- Scheduled skips are recorded and are not replayed automatically.
- The **Run once** action creates an Unbound Run, not a saved Automation.
- Volli's source is available under Apache-2.0.

### 9.3 Claims not to make

- That Automations are fully autonomous or remove the person.
- That enablement, Arming, or rank syncs to another Mac.
- That merely choosing a column Trigger arms it.
- That Arming applies retroactively to tickets already in a column.
- That schedules run while the app is closed or that missed occurrences replay.
- That a Run resumes or wakes an existing Session.
- That more than one Run can execute concurrently on the same ticket.
- That worktree sync waits for CI checks or validates correctness.
- That Volli resells tokens, absorbs provider charges, or supports every provider
  subscription in the same way.
- That an Intel, Windows, universal, or stable build exists.
- Exact Skill file-layout or cross-machine portability behavior until verified
  in the packaged 0.2 build.
- Testimonials, time savings, reliability percentages, or adoption numbers that
  have not been measured and sourced.

## 10. Prioritized recommendations

### P0 — release parity and truth

1. **Replace the false docs stub and publish an Automations guide.** Register it
   in the sidebar and `llms.txt` source.
2. **Put Automations on the homepage.** Add a versioned 0.2 section, one concise
   control statement, and a docs CTA. Do not replace the broader category story.
3. **Fix or replace the demo.** At minimum add the real Automations nav row. For
   launch quality, replace the generic board interaction with real release
   captures or an Automation-to-Run storyboard.
4. **Correct adjacent docs drift.** Storage, compaction, Web Search credential
   storage, Project Files, and the theming TODO must not undermine release
   confidence.
5. **Update the Board and Ticket workspace guides.** These are where users
   encounter offering, Arming, Run once, and Run history.
6. **Align every release entry point.** Website, docs home, README, GitHub release
   notes, download feed, tag, packaged app version, and screenshots must describe
   the same 0.2 build.
7. **Capture the release candidate.** Recapture Board and Ticket workspace with
   the Automations nav row; add Automations page, ticket rail, picker, and Run
   history evidence.

### P1 — make the story persuasive

1. Add a real 10–20 second native clip showing one end-to-end Automation.
2. Add a compact trust strip near the feature proof: local data, provider
   boundary, per-Mac opt-in, fresh Session per Run.
3. State open-source and provider-account posture plainly rather than relying on
   GitHub links to imply it.
4. Add an Automations troubleshooting path and verify keyboard interactions
   against the packaged release.
5. Change the interactive demo from `client:load` to progressive/later hydration
   if the static proof can carry the first screen; set and test a JavaScript/LCP
   budget rather than assuming the current weight is acceptable.
6. Give 0.2 user-facing release notes: outcome, walkthrough, supported platform,
   known limits, data/control model, upgrade path, and feedback route.
7. Add a dedicated `/automations/` product route only if the homepage module
   cannot hold the story cleanly.

### P2 — build durable differentiation

1. Publish honest use cases—review handoff, scheduled repository maintenance
   while Volli is open, recurring issue triage—using real Automations and
   clearly stated limits.
2. Collect named user proof after the release; use quotes and metrics only with
   permission and methodology.
3. Add a comparison page only after validating competitor behavior and Volli's
   category sentence with users.
4. Use short founder/engineer demos and changelog clips to humanize the product
   without turning the homepage into a corporate campaign.
5. Develop the Automation-to-Run motif into a reusable launch system for social
   cards, release notes, and docs diagrams.

## 11. Recommended delivery sequence

### Phase 1: truthful minimum

- Freeze the packaged 0.2 candidate and verify exact labels/interactions.
- Create the claims ledger from the final build.
- Correct the docs stub and adjacent contradictions.
- Add the Automations guide and cross-links.
- Add homepage release copy and correct demo navigation.
- Update README and user-facing release notes.

**Gate:** No public entry point says Automations are unavailable, and every
screenshot/nav capture matches the release candidate.

### Phase 2: product proof

- Capture the native Automation workflow.
- Add the control/trust strip.
- Replace or refocus the interactive demo.
- Test keyboard, touch, reduced motion, reduced transparency, zoom, and the
  packaged-download path.
- Measure JavaScript transfer, LCP, CLS, and interaction responsiveness.

**Gate:** The feature is understandable from one scroll and one docs guide,
without relying on a glossary or unsupported claim.

### Phase 3: launch and verify

- Publish the exact tag/artifact.
- Deploy website and docs together.
- Verify root, download, docs home, Automations guide, Markdown mirror,
  `llms.txt`, sitemap, release links, and issue/security paths in production.
- Check GitHub repository description/social preview and release notes manually.

**Gate:** Website, docs, README, GitHub release, and installed About/version agree
on product name, 0.2 version, architecture, maturity, and Automations behavior.

## 12. Acceptance checklist for VC-217

- [ ] Homepage names Automations and preserves the broader Volli story.
- [ ] Demo or release capture shows **Home / Automations / Configure**.
- [ ] No public copy says Automations are still in development.
- [ ] One task-oriented Automations guide ships and appears in sidebar,
      Markdown output, search, sitemap, and `llms.txt`.
- [ ] Concepts uses canonical terms and avoid-list discipline.
- [ ] Board explains Trigger vs offering vs Arming and deliberate-move behavior.
- [ ] Ticket workspace explains the Run once action, Unbound Runs, Run history,
      and Session reopening.
- [ ] Settings no longer claims per-model reserves, keychain storage, or the old
      Worktrees pane.
- [ ] Project Files are described as a Home surface, not standalone navigation.
- [ ] Screenshots come from the packaged 0.2 candidate.
- [ ] Release notes state platform, alpha status, known limits, data/provider
      boundary, and feedback path.
- [ ] No cross-machine, background-when-closed, retroactive, replay, CI, stable,
      or unsupported provider promise appears.
- [ ] Website and docs builds, release-resolution tests, brand asset checks, and
      production smoke tests pass.

## Sources

### Volli sources

- [`apps/website/src/pages/index.astro`](../../apps/website/src/pages/index.astro)
- [`apps/website/src/pages/download.astro`](../../apps/website/src/pages/download.astro)
- [`apps/website/src/components/VolliDemo.tsx`](../../apps/website/src/components/VolliDemo.tsx)
- [`apps/website/src/components/LifecycleAccordion.astro`](../../apps/website/src/components/LifecycleAccordion.astro)
- [`apps/docs/src/content/docs/index.mdx`](../../apps/docs/src/content/docs/index.mdx)
- [`apps/docs/src/content/docs/start/concepts.mdx`](../../apps/docs/src/content/docs/start/concepts.mdx)
- [`apps/docs/src/content/docs/guides/board.mdx`](../../apps/docs/src/content/docs/guides/board.mdx)
- [`apps/docs/src/content/docs/guides/settings.mdx`](../../apps/docs/src/content/docs/guides/settings.mdx)
- [`apps/docs/src/pages/llms.txt.ts`](../../apps/docs/src/pages/llms.txt.ts)
- [`packages/shared/src/automation.ts`](../../packages/shared/src/automation.ts)
- [`CONTEXT.md`](../../CONTEXT.md#L767-L878)
- [`apps/desktop/src/renderer/src/components/automations/automations-page.tsx`](../../apps/desktop/src/renderer/src/components/automations/automations-page.tsx)
- [`apps/desktop/src/renderer/src/components/automations/automation-editor.tsx`](../../apps/desktop/src/renderer/src/components/automations/automation-editor.tsx)
- [`apps/desktop/src/renderer/src/components/automations/automation-lanes.tsx`](../../apps/desktop/src/renderer/src/components/automations/automation-lanes.tsx)
- [`apps/desktop/src/renderer/src/components/automations/ticket-rail-automations.tsx`](../../apps/desktop/src/renderer/src/components/automations/ticket-rail-automations.tsx)
- [`apps/desktop/src/renderer/src/components/automations/armed-run-window.tsx`](../../apps/desktop/src/renderer/src/components/automations/armed-run-window.tsx)
- [`docs/plans/alpha-launch-public-surface-audit.md`](../plans/alpha-launch-public-surface-audit.md)

### External sources

- [Herdr homepage](https://herdr.dev/), [docs](https://herdr.dev/docs/), and
  [comparison](https://herdr.dev/compare/)
- [Conductor (`conductor.build`) homepage](https://www.conductor.build/) and
  [docs](https://www.conductor.build/docs)
- [T3 Code](https://t3.codes/)
- [Oh My Pi](https://omp.sh/)
- [Arc](https://arc.net/) and [Dia](https://www.diabrowser.com/)
- [The Browser Company: “The strategy behind Dia's design”](https://browsercompany.substack.com/p/the-strategy-behind-dias-design)
- [Things](https://culturedcode.com/things/)
- [Raycast](https://www.raycast.com/)
- [Linear](https://linear.app/)
- [Nova](https://nova.app/)
