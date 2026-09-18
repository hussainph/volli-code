# Competitor documentation study: T3 Code, cmux, Vibe Kanban, and Oh My Pi

- **Research date:** 2026-09-15
- **Scope:** Public documentation for T3 Code, cmux, Vibe Kanban, and Oh My Pi; information architecture, hard concepts, release practice, maturity honesty, and agent readability.
- **Method:** Read up to three public pages per product; page evidence is marked [observed], judgments are marked [interpretation].

## T3 Code

- **Docs IA (2026-09-15):** [observed] The product site (https://t3.codes/) is a concise positioning/install page; the repository README (https://github.com/pingdotgg/t3code) is the real entry point and explicitly points first-time readers to `docs/user/install.md` (https://github.com/pingdotgg/t3code/blob/main/docs/user/install.md). User docs are task-grouped (install, permissions, shortcuts, projects, remote, source control, background service), with internals separate. [interpretation] This is a clear one-reader/one-goal start, though repo navigation is less discoverable than a docs site.
- **Hard concepts:** [observed] The README names one thread per agent and links permission modes, remote access, background service, and source-control docs; install requires an authenticated provider. [interpretation] It explains parallel work mainly as “threads,” but does not foreground worktree isolation, review flow, or unattended/scheduled runs.
- **Releases and honesty:** [observed] It links GitHub Releases and package-manager installs, and says “We are very very early… Expect bugs” and contributions are mostly closed. [interpretation] That blunt maturity statement is valuable; release notes were not inspected here.
- **Agent readability:** [observed] Exact commands, provider login commands, platform/runtime prerequisites, UI labels such as **Settings → Providers**, and direct deep links make the setup actionable.
- **Copy / avoid:** [interpretation] Copy the prerequisite-first install page and explicit provider matrix. Avoid leading with social proof and animated marketing; task headings and a first-run goal should dominate.
- **Documentation gap:** [interpretation] Add a first-run page that turns “thread” into a concrete parallel-work example, including isolation and review boundaries.
- **Sources reviewed:** [observed] https://t3.codes/ · https://github.com/pingdotgg/t3code · https://github.com/pingdotgg/t3code/blob/main/docs/user/install.md

## cmux

- **Docs IA (2026-09-15):** [observed] The README (https://github.com/manaflow-ai/cmux) is a feature tour plus install/FAQ/reference; the dedicated docs site starts at https://cmux.com/docs/getting-started and links focused pages for session restore, API, browser automation, notifications, SSH, and integrations. The getting-started page leads with install, verify, CLI setup, update behavior, restore limits, and requirements. [interpretation] The path from first launch to automation is unusually direct.
- **Hard concepts:** [observed] README examples show vertical tabs, splits, git/PR metadata, notification rings, agent hooks, remote SSH, native session resume, and a socket API; the getting-started page states that arbitrary live process state is not checkpointed. [interpretation] It explains attention management and automation well, but is a terminal primitive rather than a worktree/review workflow.
- **Releases and honesty:** [observed] DMG installs auto-update via Sparkle; the README distinguishes stable from a nightly app built from `main`, and calls iOS “beta.” [interpretation] Separate stable/nightly and explicit restore limits are strong release/maturity signals; no changelog page was reviewed.
- **Agent readability:** [observed] Copyable commands (`brew install --cask cmux`, `cmux notify`, `cmux list-workspaces`), exact shortcuts, API links, and named UI paths reduce ambiguity.
- **Copy / avoid:** [interpretation] Copy the verify-install checklist and plainly documented failure boundaries. Avoid making users assemble a workflow from primitives when Volli can provide an opinionated ticket-to-review path.
- **Documentation gap:** [interpretation] Add a single “run an agent task” tutorial alongside the excellent primitive/API reference, so users need not design their own orchestration.
- **Sources reviewed:** [observed] https://github.com/manaflow-ai/cmux · https://cmux.com/docs/getting-started

## Vibe Kanban

- **Docs IA (2026-09-15):** [observed] The repository README (https://github.com/BloopAI/vibe-kanban) is a compact product/quickstart page that sends readers to the hosted docs at https://vibekanban.com/docs; that docs index describes planning, workspace execution, and review. It also links supported-agent and self-hosting guides. [interpretation] The first-time path is “run `npx vibe-kanban`, then plan/review,” with product concepts grouped around the kanban lifecycle.
- **Hard concepts:** [observed] README promises one workspace with an agent, branch, terminal, and dev server; it also names diff review, inline comments, browser preview, PR creation/merge, and ten-plus agent options. [interpretation] This is the clearest competitor framing of isolation plus human review, but unattended/scheduled operation is not prominent in the pages read.
- **Releases and honesty:** [observed] The README documents local development (Rust/Node/pnpm), runtime/build environment variables, cleanup controls, reverse-proxy origins, and self-hosting. [interpretation] Operational detail signals maturity, but no changelog/release practice was visible in the inspected pages.
- **Agent readability:** [observed] `npx vibe-kanban`, explicit prerequisites, named UI path **Settings → Editor Integration**, and environment-variable tables are machine- and human-scannable.
- **Copy / avoid:** [interpretation] Copy the lifecycle promise—plan, execute in an isolated workspace, review, ship—and show the branch/dev-server boundary. Avoid broad “10X” positioning as a substitute for a first task.
- **Documentation gap:** [interpretation] Make unattended execution and its safety/approval model a first-class guide if the product supports it; it was not prominent in the inspected pages.
- **Sources reviewed:** [observed] https://github.com/BloopAI/vibe-kanban · https://vibekanban.com/docs

## Oh My Pi

- **Docs IA (2026-09-15):** [observed] The product site https://omp.sh/ and https://omp.sh/docs were reachable but rendered only the title “a coding agent with the IDE wired in”; the repository README (https://github.com/can1357/oh-my-pi) is therefore the usable documentation surface. It is a long capability catalog with install methods, CLI completion, feature explanations, provider setup, and links into `docs/`. [interpretation] It is powerful but not a calm first-time task path.
- **Hard concepts:** [observed] The README describes isolated worktrees and typed results for `task`, Agent Hub steering/termination, reviewer/advisor roles, persistent memory, collaboration links, and review commands. [interpretation] It covers parallel and unattended-adjacent operation deeply, but concepts are introduced as a feature stream rather than a guided workflow.
- **Releases and honesty:** [observed] README offers curl, Homebrew, Bun, Nix, and pinned mise installs; it identifies the project as a Pi fork, says PR access is a trial, and makes large performance/capability claims. [interpretation] Fork lineage and contribution policy are honest; release/changelog practice was not evident in the inspected pages, and headline benchmarks need methodology before docs should repeat them.
- **Agent readability:** [observed] Exact commands, generated shell-completion instructions, explicit provider/auth tables, stable internal URLs, and links to focused docs (for example https://github.com/can1357/oh-my-pi/blob/main/docs/context-files.md) serve agents and operators well.
- **Copy / avoid:** [interpretation] Copy the explicit isolation/reviewer semantics and command examples. Avoid a giant feature inventory as the homepage; use one task-oriented “first 15 minutes” route with progressive disclosure.
- **Documentation gap:** [interpretation] The public site did not expose the README’s detail in this observation; a stable, navigable docs index would improve first-time and agent retrieval.
- **Sources reviewed:** [observed] https://omp.sh/ · https://omp.sh/docs · https://github.com/can1357/oh-my-pi

## Reading limits

- [observed] This was a documentation-surface study, not a product usability test or feature verification exercise.
- [observed] Each product was limited to the public pages named in its Sources reviewed line; no repository crawl was performed.
- [observed] Release notes, star counts, pricing, and claims not visible on those pages were intentionally omitted.
- [interpretation] “Not prominent” means absent from the inspected documentation path, not proof that the product lacks the capability.

## Cross-product comparison

- [observed] T3 Code and Vibe Kanban both make installation and provider prerequisites explicit; cmux does the same for its CLI and app lifecycle.
- [observed] Vibe Kanban is the most direct about branch/workspace/review flow; Oh My Pi is the most detailed about subagent control and tool semantics.
- [observed] cmux documents restore boundaries more plainly than the others; T3 Code documents provider/environment boundaries especially well.
- [observed] Oh My Pi’s public homepage was sparse during this observation, while its repository README contained the deepest feature detail.
- [interpretation] Volli’s differentiator should be the durable ticket lifecycle, not another generic agent terminal or feature catalog.
- [interpretation] Automation docs should distinguish manual runs, column-entry triggers, and schedules, with permissions and failure behavior beside each.
- [interpretation] Review is a concept readers need before automation: show what an agent changed, what can be approved, and how a run resumes.
- [interpretation] Every competitor leaves an opportunity to state whether “parallel” means panes, threads, branches, worktrees, or independent sessions.
- [interpretation] A short glossary would prevent those terms from collapsing into one vague promise.
- [observed] No inspected source supplied a complete competitor-wide changelog comparison; release evidence above is limited to links and update statements visible on the read pages.

## What Volli should learn

- [interpretation] Make the first page answer one goal: create or run one ticket, then show the exact next action with UI labels and commands.
- [interpretation] Explain isolation as a concrete lifecycle—ticket → worktree/branch → agent run → diff review → PR—not as a vague promise of parallelism.
- [interpretation] Publish honest boundaries beside setup: what survives relaunch, what runs unattended, and which automation triggers are unavailable or risky.
- [interpretation] Use copyable commands, prerequisite matrices, supported-agent tables, and stable deep links as agent-readable affordances.
- [interpretation] Keep release status visible: stable/nightly or beta labels, a changelog link, and explicit maturity notes beat social-proof claims.
- [interpretation] Prefer a task-oriented docs IA over a capability catalog; put advanced automation, APIs, and internals after the first successful run.
