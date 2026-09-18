# Competitor docs study: Conductor and Herdr

- Research date: 2026-09-15
- Scope: Public docs for Conductor and Herdr, with each index and 2–4 relevant pages; Herdr's requested comparison page included.
- Method: Bounded manual reading on 2026-09-15. Page facts are [observed]; recommendations and checklist assessments are [interpretation].

## Conductor

### IA and starting point

- [observed] The index starts with an Introduction at https://www.conductor.build/docs, which points readers to “Get started” and a workflow before reference pages. Its linked IA is grouped into Get Started, Cloud, Concepts, How-to Guides, Reference, Security, and Troubleshooting. The machine-readable index is also exposed at https://www.conductor.build/llms.txt.
- [observed] The most relevant concept pages were Isolated workspaces (https://www.conductor.build/docs/concepts/workspaces-and-branches), Workflow (https://www.conductor.build/docs/concepts/workflow), Parallel agents (https://www.conductor.build/docs/concepts/parallel-agents), and Agent modes (https://www.conductor.build/docs/concepts/agent-modes). [interpretation] A first-time reader has a sensible path: introduction → first workspace (linked from the concepts) → workflow.

### Explaining the hard concepts

- [observed] Isolated workspaces defines Project, Repository, Workspace, Branch, Working tree, and Running environment in a table, then explains Git worktrees, separate processes, review, and the explicit limit that isolation “is development isolation, not a security boundary.”
- [observed] Parallel agents makes the central decision explicit: multiple workspaces for independent work versus multiple agents in one shared workspace, with a decision table and examples. Workflow carries the tutorial-ish operating model: one workspace per shippable unit, then verify, review, checks, PR, merge, and archive.
- [observed] Review is concrete in Workflow: Diff Viewer, inline comments, agent Review action, Checks tab, conflict resolution, PR creation, and merge gates. Automatic/unattended runs are not a central concept on these pages; setup/run scripts and Spotlight testing appear in the index at https://www.conductor.build/llms.txt, but were not read in this bounded pass.
- [observed] Agent modes is an explanatory concept page for Plan Mode, Fast Mode, reasoning controls, personalities, and goals. It says controls are session-level, distinguishes planning from implementation, and explains when speed is appropriate.

### Releases, honesty, and agent readability

- [observed] The llms index links a changelog at https://www.conductor.build/changelog.md and a full markdown mirror at https://www.conductor.build/llms-full.txt; this is a strong discoverability affordance, though changelog contents were not read.
- [observed] The reviewed pages do not label the product alpha/beta or enumerate a general known-limit list. They do name important limits: workspace isolation is not a security boundary; a branch can only be checked out in one workspace; provider credentials and setup vary by harness. [interpretation] This is useful operational honesty but not a prominent maturity statement.
- [observed] Exact UI labels and shortcuts are given (“New workspace”, “Diff Viewer”, “Checks tab”, “Review”, Command+Shift+N/D/P), and the docs use task-oriented headings. [interpretation] The index and llms.txt are unusually agent-readable, but the observed docs do not advertise a per-page copy/markdown control.

### Checklist misses and takeaways

- [interpretation] Google checklist failure: several concept pages combine explanation, decision guidance, and procedural steps (for example Workflow covers decomposition through archive), weakening one reader/one dominant page type. Failure: mixed page type rather than a clean tutorial/how-to boundary.
- [interpretation] Google checklist failure: “automatic/unattended runs” is not explained as a first-class category concept in the sampled entry path; the reader must infer it from scripts/reference pages. Failure: prerequisite/category coverage gap.
- [interpretation] Copy: model the workspace vocabulary table plus the independent-vs-shared decision table; it gives readers a durable mental model before UI steps.
- [interpretation] Do not copy: avoid making one broad Workflow page carry decomposition, execution, review, merge, and archive; split Volli’s automation tutorial from automation reference.
- [observed] Conductor’s sampled pages consistently use second-person imperative language (“Use”, “Create”, “Open”) and expose exact product labels before describing the action.
- [observed] Its docs distinguish concepts from reference in navigation, even where individual concept pages still mix explanation and procedure.

## Herdr

### IA and starting point

- [observed] The docs index at https://herdr.dev/docs/ opens with a mouse-first promise, a Quick start (https://herdr.dev/docs/quick-start/), then branches to Concepts, Keybindings, Agents, Connecting machines, Session state, Configuration, API, Plugins, and Marketplace. It also supplies an agent onboarding prompt and an explicit guide at https://herdr.dev/agent-guide.md.
- [observed] The bounded relevant pages were Quick start, Agents (https://herdr.dev/docs/agents/), Session state (https://herdr.dev/docs/session-state/), and Compare (https://herdr.dev/compare/). [interpretation] This is a clear start for a terminal-multiplexer audience: install → run `herdr` → create workspace → start an agent → detach/reattach.

### Explaining the hard concepts

- [observed] Quick start defines a workspace as a project-level container for tabs, panes, and agents, explains automatic agent detection and semantic states (working, blocked, done, idle), and gives mouse and keyboard paths. Session state distinguishes detach/reattach, server restart, pane history, native agent restore, and experimental live handoff in a capability table.
- [observed] Agents explains parallel agents as real terminal panes with logs and processes intact; it documents detection authorities, lifecycle hooks versus screen manifests, strict blocked detection, unsupported-agent behavior, and diagnostic commands. It is reference-heavy but unusually candid about misclassification (“idle” fallback) and wrapper/VM limits.
- [observed] Compare positions Herdr as a runtime plus clients, contrasts it with manager apps including Conductor, and says worktree/diff review “pairs with it” rather than being its core. Thus parallel workspaces and review are adjacent integrations, not a native worktree workflow. Automatic/unattended runs are represented as persistent processes and API/CLI control, not a trigger/schedule feature.

### Releases, honesty, and agent readability

- [observed] No changelog or release page was exposed by the reviewed docs index or comparison page. The index does expose API, plugins, and marketplace surfaces; Marketplace says listing launches in the future. [interpretation] Release discovery is weaker than Conductor’s explicit llms link.
- [observed] Maturity honesty is strong: live handoff is called experimental/opt-in; screen detection can misclassify new prompts as idle; unsupported agents run but may lack rich state; pane history is off by default because output may contain secrets. [interpretation] These caveats appear beside the feature they qualify, which is good practice.
- [observed] Agent-readability is first-class: the index offers an agent prompt, https://herdr.dev/agent-guide.md is a purpose-built guide, and the guide links canonical docs. The docs provide copyable commands, but no observed llms.txt or per-page markdown mirror/copy control.

### Checklist misses and takeaways

- [interpretation] Google checklist failure: the Agents page is a dense reference plus troubleshooting guide, with long implementation details before the short user task. Failure: dominant page type and progressive disclosure.
- [interpretation] Google checklist failure: the comparison page uses a broad competitive matrix and marketing positioning rather than a task heading/base-verb flow. Failure: task headings and one-reader/one-goal fit for a new user.
- [interpretation] Copy: provide an agent-facing onboarding guide and put persistence limits beside each restore mode; this reduces invented commands and builds trust.
- [interpretation] Do not copy: do not frame Volli’s category primarily as a runtime/terminal comparison. Volli’s differentiator is durable ticket/worktree orchestration plus saved automations, so lead with the user’s workflow.
- [observed] Herdr’s Quick start places prerequisites and the stop/detach distinction directly next to the first commands, reducing ambiguity about what keeps running.
- [observed] Herdr’s agent guide explicitly tells agents where canonical documentation lives and warns them not to invent flags or keybindings.
- [interpretation] This is especially relevant to Volli’s Automation docs: explain the safe operating boundary before showing schedules or unattended execution.

## What Volli should learn

- [interpretation] Define one compact vocabulary model early (ticket, workspace/worktree, Session, Automation, run) and reuse exact labels everywhere.
- [interpretation] Add a decision guide for when to run one agent versus parallel tickets, then a separate how-to for creating and running an Automation.
- [interpretation] Put review gates and failure/permission behavior in the main workflow, not only in reference pages.
- [interpretation] Make unattended behavior explicit: trigger types, prerequisites, schedule semantics, cancellation, logs, and what happens when an agent is blocked.
- [interpretation] Publish an agent-readable entry point (llms.txt or markdown index) and an agent onboarding guide, while retaining human task pages.
- [interpretation] State maturity and non-goals beside risky features; copy Herdr’s concrete caveats and Conductor’s explicit security-boundary warning.
- [interpretation] Treat each Automation trigger as a distinct how-to: manual run, column entry, and schedule have different prerequisites and observability.
- [interpretation] Add a compact troubleshooting path for blocked, failed, cancelled, and still-running agent sessions.
- [observed] Both competitors make persistence legible, but they mean different things: Conductor persists isolated workspace context; Herdr persists terminal processes and agent sessions.
- [interpretation] Volli should name that distinction rather than borrowing “session” or “workspace” without a product-specific definition.
- [observed] Neither sampled competitor provides a single page that combines category explanation, release notes, maturity status, and automation semantics.
- [interpretation] A small release page plus stable reference pages could make Volli’s 0.2 feature boundary easier to evaluate.
- [interpretation] Keep UI labels exact and put prerequisites before every Automation procedure, especially permissions, repository state, and runtime availability.
- [interpretation] Keep the release page factual: distinguish shipped behavior from roadmap ideas and link each claim to the relevant reference.
