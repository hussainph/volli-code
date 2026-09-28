# Volli docs vs. competitor docs — 0.2 review

- **Research date:** 2026-09-15
- **Reviewed surface:** `apps/docs` (14 pages, Astro Starlight, dark-only) **as it
  stands in this working tree** — commit `32317256` plus the uncommitted 0.2 docs
  pass from a concurrent VC-217 session (`apps/docs/astro.config.mjs`, eleven
  content pages, `llms.txt.ts`, and the new `guides/automations.mdx`). This
  review does not modify that pass.
- **Companion reports (raw findings):**
  [workspace tools A](volli-docs-competitor-conductor-herdr.md) ·
  [workspace tools B](volli-docs-competitor-t3-cmux-vibe-kanban.md) ·
  [agent vendors](volli-docs-competitor-agent-vendors.md) ·
  [docs mechanics](volli-docs-mechanics-benchmarks.md) ·
  [docs for coding agents](volli-docs-for-coding-agents.md)
- **Method:** a repo audit of every docs page against the
  [`google-developer-docs`](../../.agents/skills/google-developer-docs/SKILL.md)
  checklist; five GPT Luna subagent surveys of competitor and benchmark docs
  (one survey session was stopped before it wrote output and was re-run as two
  time-boxed sessions); direct source verification of every Volli defect claimed
  below; and direct fetch spot-checks of load-bearing competitor claims
  (Conductor `llms.txt`, Herdr `agent-guide.md`).

**How to read this document.** `[verified]` means the claim was checked against
this repository's source. `[observed]` means a public page was read on the
research date and can change. `[interpretation]` is an assessment.
`[recommendation]` is proposed work, not shipped behavior.

## Answer in brief

Yes — five improvements, in priority order. None of them is a redesign.

1. **Add a 0.2 release surface to the docs.** The larger competitors and every
   benchmark studied ship a dated changelog or release page — Claude Code,
   Codex, Cursor's CLI, Conductor (`changelog.md`), Supabase, Stripe, Raycast,
   Zed — while the smaller workspace tools studied (Herdr, T3 Code, cmux, Vibe
   Kanban, omp.sh) mostly do not. `docs.volli.app` has none and sends readers to
   GitHub Releases. One "What's new in 0.2" page closes the last factual gap for
   a release the homepage now advertises. `[recommendation]`

2. **Make the release screenshots true.** `ticket-workspace.png` predates the
   Automations rail panel: the page text says the **Now** rail shows Automations,
   and the panel renders unconditionally in source, but the image shows
   repository summary → properties → Sessions. The Automations guide carries no
   visual at all, and `board.png` cannot show an armed column because the
   lightning control is hover-revealed when unarmed. `[verified]`

3. **Fix five verified cross-reference defects** left by the current docs pass:
   two stale `Settings → CLI` paths, one stale retention path, an incomplete
   `volli help` topic list, and a "Every keyboard shortcut" page missing the
   surface split chords. `[verified]`

4. **Give Automations one "what runs when" table.** Claude Code, Codex, and
   Cursor document approval and unattended execution as matrices with limits
   stated beside the feature. Volli's guide states the same facts in prose and
   Asides, but never in one scannable place. `[observed]` `[interpretation]`

5. **Take the three cheap agent-readability upgrades** — a no-JS "View Markdown"
   link, `rel="alternate"`/`rel="describedby"` links, and a short "For agents"
   page — and defer `llms-full.txt` and an MCP endpoint until demand exists.
   `[observed]` `[recommendation]`

## What the docs already do better than most of the field

These are worth protecting; several competitors are weaker here.

- **Page-type discipline.** Quickstart is a clean tutorial (end state, one path,
  prerequisites, `Optional:` sections, next steps). CLI and Keyboard shortcuts
  are reference. Concepts is explanation. Most sampled competitors mix
  explanation, procedure, and marketing on one page — Conductor's Workflow page
  and Herdr's Agents page were both flagged for it. `[verified]` `[observed]`
- **Procedures that survive the checklist.** Location before action, one action
  per step, exact bold UI labels, commands in code font, code blocks under
  `Steps`. `[verified]`
- **Generated-from-source references.** `AgentVerbEffects`,
  `AgentErrorRecovery`, `AgentCapabilityChanges`, and `AgentOperatingModel`
  render from the same registry the CLI and skill pack use, so the reference
  cannot drift the way hand-written tables do. No sampled competitor was found
  doing this for its reference pages. `[verified]` `[observed]`
- **Docs-for-agents plumbing.** A generated `/llms.txt` that fails the build when
  a page is missing, a `text/markdown` mirror for every page, and a Copy page
  control. Conductor matches this and adds `llms-full.txt` and per-page Markdown
  (`/markdown/*`); Claude Code and Cursor publish their own `llms.txt`; Herdr
  ships a purpose-built agent guide; Aider, Vibe Kanban, T3 Code, and cmux have
  none of it. `[observed]` `[verified]`
- **Honest limits.** Alpha status, "moving a ticket does not start work", the
  automatic-starts notice in the Automations guide, and per-feature caveats match
  the best maturity practice found (Herdr's experimental handoff, cmux's restore
  limits, T3's blunt "expect bugs"). `[verified]` `[observed]`
- **Copy standards.** Second person, present tense, sentence case, no marketing
  inside procedures, one name per concept. This is the Google style baseline
  applied consistently. `[verified]`

The current pass also closes nearly all of the predecessor audit's docs items:
the Automations guide exists and is registered in the sidebar and `llms.txt`,
Concepts has canonical Automation terms, Quickstart gained an `Optional:`
Automations step, and Board, Ticket workspace, Chats and worktrees, Settings, and
Troubleshooting were updated for 0.2. `[verified]`

## Verified defects in the current tree

Concrete, source-checked, small.

| # | Defect | Evidence | Fix |
| --- | --- | --- | --- |
| 1 | `start/install.mdx:91` — "run Doctor in **Settings → CLI**" | No CLI pane exists: `settings/settings-groups.tsx` groups only Preferences, Services, and System, and `about-pane.tsx` records that CLI, Harness Runtimes, and the Doctor were absorbed into About | Point to **Settings → About** |
| 2 | `reference/troubleshooting.mdx:60-61` — same stale path, plus "Run **Doctor**" and "**Fix & Re-run**" | `about-pane.tsx` runs health checks on entry (there is no Run-Doctor control), and its buttons are **Fix** and **Re-check** | Rewrite the three sentences |
| 3 | `reference/troubleshooting.mdx:85` — Done worktree retention under **Settings → General** | `panes/general-pane.tsx`: "Retention used to live here and now lives in Storage"; the pane list confirms Storage | Point to **Settings → Storage** |
| 4 | `reference/cli.mdx:366` — `volli help` topics list has four entries | The CLI prints six: `concepts`, `changes`, `exit-codes`, `addressing`, `json`, `orchestration`; `start/concepts.mdx` and `reference/agent-capability-changes.mdx` both rely on the missing two | Add `concepts` and `changes` |
| 5 | `reference/keyboard-shortcuts.mdx` — description promises "Every keyboard shortcut", but the surface split chords are absent | `lib/split-shortcut.ts` defines `⌘\`, `⇧⌘\`, and `⌃⌘` + arrows; they are wired in `home/home-surface.tsx:383` and `ticket/ticket-detail.tsx:936` | Add a "Surface panes" table, or soften the claim |
| 6 | `guides/theming.mdx:17` — screenshot TODO for the canvas editor is still in the source | Source comment | Capture with the release-candidate shots |
| 7 | `ticket-workspace.png` predates the Automations rail panel, and no Automations visual exists in the docs | `ticket-workspace.mdx:19` documents Automations in the **Now** rail; `ticket/ticket-rail.tsx:182` renders the panel unconditionally; the image goes from properties straight to Sessions | Recapture from the packaged 0.2 candidate; add captures for the editor and an armed arrival/Run history |
| 8 | No release/what's-new page; all release communication is on GitHub Releases | Docs tree and website footer links | See P0-3 below |

Minor, from the checklist: `guides/board.mdx:139` writes "see
[Archiving](#archiving) below", a directional reference Google style asks writers
to avoid in favour of naming the control or section. `[verified]`

## What the surveys found, by theme

### Release communication

Claude Code publishes a dated changelog generated from `CHANGELOG.md` with
version labels and surface-specific notes. Codex has a changelog plus JSONL
examples and stable flag tables. Cursor's docs changelog returned 404 on the
research date while its CLI changelog is dated and includes security and behavior
changes — a reminder that a broken release surface is worse than a small one.
Conductor ships `changelog.md` beside `llms.txt` and `llms-full.txt`. Supabase and
Stripe label entry types and breaking changes; Raycast and Zed keep public
changelogs separate from the manual. `[observed]` (agent vendors, workspace tools
A/B, mechanics reports)

Lesson: a release page should be dated, name the affected area, mark
breaking/migration status, and link the guide that explains the behavior. It
should not live inside a how-to page. `[interpretation]` (mechanics report)

### Unattended execution without overpromising

The strongest vendors separate trigger, execution location, credentials, and
review. Claude Code splits cloud Routines (continues with the computer off),
desktop scheduled tasks (run on the user's machine), and CLI `/loop`; its GitHub
Actions page names actor checks, least permissions, `--max-turns`, concurrency,
and the 60-day inactivity cutoff for public-repo schedules. Codex says `codex
exec` defaults to a read-only sandbox and recommends the least permissions for
automation. Cursor states that Cloud Agents run in isolated VMs, do not use local
Run Modes, inject secrets only at start, and carry separate billing — and states
the multi-repo limitation beside the feature. `[observed]` (agent vendors report)

Volli's equivalents — the app must be open, schedules are presets with recorded
skips, enablement is per-Mac, arming is per-column and non-retroactive, **Run
now** is not a replay — are already documented. They are spread across Asides,
prose, and Troubleshooting rather than gathered where a reader decides to turn
automation on. `[verified]` `[interpretation]`

### Trust, permissions, and control

Claude Code documents permission rules as a table and separates what the agent
may do from lifecycle hooks. Codex labels permission profiles "Beta", scopes them
to local command execution, and notes that network enablement does not start the
proxy. Cursor separates `permissions.json` from `sandbox.json`, shows Run Modes
in a table, and says plainly that Auto-review is not a security boundary.
`[observed]` (agent vendors report)

Volli's model maps cleanly: Deliberate move → Offered → Armed → Enabled →
Runtime → fresh Session. A single matrix would make it legible the way those
tables do. `[interpretation]`

### Onboarding shape

The best first-run paths put prerequisites before the first action and reach a
reviewable change before introducing automation: Claude Code (prereqs → install
→ login → first edit → Git → tests), Cursor (install → sign in → one small
change → review the diff → run checks), Zed (open project → commands →
configure), Vibe Kanban (plan → isolated workspace → review → ship). Volli's
Quickstart already has this shape, including a safe first change and an
`Optional:` Automations step. Codex's ChatGPT/CLI/cloud split and Aider's
provider-choice density were flagged as things a small product should not
imitate. `[observed]` (agent vendors, workspace tools B, mechanics reports)

### Troubleshooting

Aider is the model: a symptom index with dedicated pages (edit errors, token
limits, dependency versions, models, support), plus a separate install
troubleshooter in Claude Code's docs. Conductor ships a troubleshooting page
beside an FAQ. Cursor puts a cloud-agent symptom list on the cloud page. Volli's
page is already symptom-first and the 0.2 pass added the first three Automation
cases; it should stay an index and grow per feature rather than per error code.
`[observed]` `[interpretation]` (agent vendors, workspace tools A, mechanics
reports)

### Agent readability

Full detail lives in the
[docs-for-agents report](volli-docs-for-coding-agents.md). In summary:
`llms.txt` is strongest as a curated index; per-page Markdown mirrors are the
convention (Vercel, Supabase, Mintlify, Conductor); `llms-full.txt` is a
convenience, not a default; MCP is worth hosting only for large, versioned, or
private corpora; and the convention recommends `rel="alternate"` and
`rel="describedby"` links. Herdr goes further with an `agent-guide.md` whose
rules tell agents not to invent flags — the same "don't guess, read the page"
discipline Volli's generated references already embody. `[observed]`

### Docs mechanics

From the [mechanics report](volli-docs-mechanics-benchmarks.md): keep the
three-group IA at 14 pages; make search keyboard-discoverable before adding
anything clever; keep shortcut and CLI facts in compact tables (Volli already
does); add dated release notes later; add per-page feedback only with an owner;
skip AI answers, version selectors, and extra navigation layers until there is
evidence they are needed. `[observed]` `[interpretation]`

### Scope lessons from the direct competitors

Conductor, Herdr, T3 Code, cmux, Vibe Kanban, and omp.sh all show that Volli's
differentiator is the durable ticket lifecycle plus saved Automations — not
terminal panes, provider matrices, or feature catalogs. Conductor's docs
taxonomy (Cloud, Enterprise, harness matrix) and Herdr's runtime comparison are
products of scope Volli does not have and should not manufacture. `[observed]`
`[interpretation]` (workspace tools A/B reports)

## Prioritized recommendations

Effort: S (under an hour), M (an afternoon), L (a dedicated pass).

### P0 — before the 0.2 surfaces ship

| # | Change | Effort | Touch points |
| --- | --- | --- | --- |
| 1 | Fix defects 1–5 in the table above | S | `start/install.mdx`, `reference/troubleshooting.mdx`, `reference/cli.mdx`, `reference/keyboard-shortcuts.mdx` |
| 2 | Recapture `ticket-workspace.png` from the packaged 0.2 candidate so it shows the Automations rail panel; add Automations captures (editor, armed arrival/Run history) with Google-style alt text naming screen, control, and state; resolve the theming TODO | M | `src/assets/screenshots/`, `guides/automations.mdx`, `guides/ticket-workspace.mdx`, `guides/theming.mdx` |
| 3 | Add `guides/whats-new-0-2.mdx`: date, what changed for the reader, the limits that apply, links to Automations, Board, Ticket workspace, and the release. Register it in the sidebar and in `llms.txt.ts` `SECTIONS`; link it from the docs home and the website release band | M | `astro.config.mjs`, `llms.txt.ts`, `index.mdx`, `apps/website/src/pages/index.astro` |
| 4 | Add one "what runs when" table to the Automations guide: manual Run / Offered / Armed / Enabled / Deliberate move / schedule / skipped occurrence → what starts, what does not, and where it is recorded | S | `guides/automations.mdx` |

### P1 — with or right after the release

| # | Change | Effort | Touch points |
| --- | --- | --- | --- |
| 5 | Agent-readability trio: a no-JS "View Markdown" link beside Copy page; `rel="alternate"` (Markdown) and `rel="describedby"` (`/llms.txt`) head links; a short `reference/for-agents.mdx` explaining how to fetch the index, page Markdown, and the CLI reference — registered in `SECTIONS` | S–M | `PageTitle.astro`, `astro.config.mjs`, new page |
| 6 | Troubleshooting: keep the symptom index; add an interrupted/in-flight Run case only after verifying the exact UI copy | S | `reference/troubleshooting.mdx` |
| 7 | Make the docs search affordance discoverable with a keyboard hint and check that the shortcut does not capture typing in code blocks; keep result context | S–M | Starlight search config, `css` |

### P2 — durable, on evidence

- `llms-full.txt` generated from the same collection **when a consumer asks**;
  a static `.well-known/ai-catalog.json` only after the core links are stable;
  no hosted MCP for a 14-page static site. `[recommendation]`
- Dated release notes as a practice once releases are regular; keep GitHub
  Releases as the artifact feed. `[recommendation]`
- A per-page "was this helpful" control only with an owner and a triage queue.
  `[recommendation]`
- Splitting the Settings reference into focused pages: the predecessor audit
  argues the single page will drift (and defects 2–3 are exactly that drift);
  the mechanics evidence says a 14-page set should not add hierarchy yet. A
  middle path: keep one page, add anchors, and re-verify every `Settings →`
  reference in the same change that moves a pane. `[interpretation]`

## Do not copy

- Conductor's Cloud/Enterprise/harness-matrix taxonomy — Volli has one structured
  runtime and no team surface. `[interpretation]`
- Herdr's runtime/terminal positioning and comparison page as a launch device;
  the predecessor audit already recommends waiting for a validated comparison.
  `[interpretation]`
- omp.sh's capability-catalog homepage and Aider's provider-choice density as a
  first-run path. `[observed]` `[interpretation]`
- T3 Code's repository-as-docs navigation. `[observed]`
- Versioned docs, AI search, or an MCP endpoint before there is a reader task
  they solve. `[interpretation]`
- Cross-platform shortcut rows or feature claims above the fold in procedures.
  `[interpretation]`

## Open decisions for the owner

1. **Where does release communication live** — a docs "What's new" page, a
   website release band, or both? Recommendation: page in docs, linked from the
   website; GitHub Releases stays the artifact feed.
2. **Does `llms-full.txt` ship now?** Recommendation: not yet.
3. **Who lands the P0 edits?** The docs pass in this working tree is another
   session's uncommitted work; this review deliberately did not touch it.

## Sources

### Volli sources (read during this review)

- `apps/docs/astro.config.mjs`, `apps/docs/src/pages/llms.txt.ts`,
  `apps/docs/src/pages/[...slug].md.ts`,
  `apps/docs/src/components/{PageTitle,Footer}.astro`
- `apps/docs/src/content/docs/**` (14 pages, working-tree state)
- `apps/desktop/src/renderer/src/lib/split-shortcut.ts`,
  `apps/desktop/src/renderer/src/lib/project-shortcut.ts`,
  `apps/desktop/src/renderer/src/components/settings/settings-groups.tsx`,
  `apps/desktop/src/renderer/src/components/settings/panes/about-pane.tsx`,
  `apps/desktop/src/renderer/src/components/settings/panes/general-pane.tsx`,
  `apps/desktop/src/renderer/src/components/board/column-arming.tsx`,
  `apps/desktop/src/renderer/src/components/ticket/ticket-rail.tsx`
- `apps/docs/src/assets/screenshots/{board,ticket-workspace}.png`
- `docs/research/volli-0.2-automations-public-surface-audit.md`,
  `docs/plans/alpha-launch-public-surface-audit.md`

### External sources (observed 2026-09-15)

- Conductor: <https://www.conductor.build/docs>, `/llms.txt`, `/llms-full.txt`,
  `/changelog.md`
- Herdr: <https://herdr.dev/docs/>, <https://herdr.dev/agent-guide.md>,
  <https://herdr.dev/compare/>
- Claude Code: <https://code.claude.com/docs/en/> (quickstart, permissions,
  hooks, github-actions, overview, cli-reference, troubleshooting, changelog)
- Codex: <https://developers.openai.com/codex>, <https://learn.chatgpt.com/docs/>
  (non-interactive-mode, permissions, cloud), Codex CLI reference and changelog
- Cursor: <https://cursor.com/docs>, run modes, cloud-agent, CLI changelog
  (docs changelog 404 on the research date), `llms.txt`
- Aider: <https://aider.chat/docs/>, troubleshooting, options, HISTORY
- T3 Code, cmux, Vibe Kanban, omp.sh — see the workspace-tools B report for the
  exact URLs read
- Benchmarks: <https://docs.stripe.com>, <https://linear.app/docs>,
  <https://manual.raycast.com>, <https://zed.dev/docs>, <https://supabase.com/docs>,
  <https://www.mintlify.com/docs>, <https://llmstxt.org/>, <https://vercel.com/llms.txt>
