# Volli 0.2 documentation audit

## Scope and method

Compared the public documentation of Conductor, Vibe Kanban, cmux, Cursor,
T3 Code, and Linear with Volli's documentation at the start of this pass.
Competitor pages and navigation sources were read through web fetches; this is
an editorial comparison, not a usability study or a feature-parity claim.

Volli's starting tree had 15 public pages. The body text of the board and
Automations pages was about 1,700 words each. The CLI page also rendered large
registry-generated sections that a source word count does not capture.

The pass uses the `product-docs` and `google-developer-docs` skills: one reader
job and dominant content type per page; prerequisites before actions; exact UI
labels; supported claims checked against code; a separate voice review.

## Comparison

| Product | Observed structure | Useful practice for Volli | Caution |
| --- | --- | --- | --- |
| Conductor | Get Started, Concepts, task-oriented how-tos, Reference, Security, Troubleshooting | Separate the shipping workflow from configuration lookup; explain environment and permission boundaries beside setup | Its cloud and repository model differs from Volli's local ticket model |
| Vibe Kanban | Getting started, Workspaces, Cloud, Settings, Integrations, Help | Document the consequences of archive, delete, and worktree cleanup; give review and publishing their own guides | Avoid duplicated MCP entry points with competing instructions |
| cmux | Workspace concepts, agent and automation topics, CLI and configuration reference, feature-local restore guidance | State exactly what restore preserves and what needs manual recovery | Its quickstart concentrates on installation and terminal use; that is too narrow for Volli's first coding task |
| Cursor | Focused agent, worktree, and review pages | Separate worktree setup examples and review controls from the interface overview | Do not borrow cloud-agent claims or treat a worktree as a permissions sandbox |
| T3 Code | Repository-hosted user topics, separate internal docs and runbooks | Give provider/PATH setup failures and source-control recovery concrete remedies | No published docs site was identified; use individual pages rather than its whole collection as a completeness bar |
| Linear | A short conceptual model linked to deeper object pages | Keep the introductory glossary small and link to actions | A tracker does not need Volli's execution, local-process, or recovery contracts |

### Sources read

- Conductor: [index](https://www.conductor.build/llms.txt),
  [installation](https://www.conductor.build/docs/installation),
  [first workspace](https://www.conductor.build/docs/first-workspace),
  [workflow](https://www.conductor.build/docs/concepts/workflow),
  [scripts](https://www.conductor.build/docs/reference/scripts),
  [troubleshooting](https://www.conductor.build/docs/troubleshooting/issues).
- Vibe Kanban: [navigation source](https://github.com/BloopAI/vibe-kanban/blob/main/docs/docs.json),
  [index](https://www.vibekanban.com/docs/llms.txt),
  [getting started](https://www.vibekanban.com/docs/getting-started),
  [workspace lifecycle](https://vibekanban.com/docs/workspaces/managing-workspaces),
  [local troubleshooting](https://vibekanban.com/docs/troubleshooting),
  [cloud troubleshooting](https://vibekanban.com/docs/cloud/troubleshooting).
- cmux: [navigation source](https://github.com/manaflow-ai/cmux/blob/main/web/app/%5Blocale%5D/components/docs-nav-items.ts),
  [getting started](https://cmux.com/docs/getting-started),
  [concepts](https://cmux.com/docs/concepts), [CLI](https://cmux.com/docs/api),
  [configuration](https://cmux.com/docs/configuration),
  [restore](https://cmux.com/docs/session-restore),
  [remote tmux](https://cmux.com/docs/remote-tmux).
  Its indexed cloud troubleshooting page returned 404 during research.
- Cursor: [Agents Window](https://cursor.com/docs/agent/agents-window),
  [worktrees](https://cursor.com/docs/configuration/worktrees),
  [Agent Review](https://cursor.com/docs/agent/agent-review).
- T3 Code: [docs index](https://github.com/pingdotgg/t3code/blob/main/docs/README.md),
  [install](https://github.com/pingdotgg/t3code/blob/main/docs/user/install.md),
  [welcome wizard](https://github.com/pingdotgg/t3code/blob/main/docs/user/welcome-wizard.md),
  [threads](https://github.com/pingdotgg/t3code/blob/main/docs/user/thread-sidebar.md),
  [source control](https://github.com/pingdotgg/t3code/blob/main/docs/user/source-control.md),
  [remote access](https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md).
- Linear: [conceptual model](https://linear.app/docs/conceptual-model).
- Google: [procedures](https://developers.google.com/style/procedures),
  [headings](https://developers.google.com/style/headings),
  [style highlights](https://developers.google.com/style/highlights).

## Volli findings

1. **Mixed page jobs.** Board configuration, ticket metadata, comments,
   lifecycle behavior, archiving, and cleanup shared one page. Automations
   combined an explanation, four procedures, model policy, drag controls, and
   recovery. Splitting by outcome is more useful than imposing a word limit.
2. **Release notes carried permanent instructions.** Browser Tabs, the Activity
   Island, MCP, split view, model tiers, usage windows, and crash recovery had
   little or no dedicated evergreen guidance.
3. **The first-task tutorial skipped model setup and used stale labels.** It
   referred to a Chats rail and Changes view. The current controls are
   **Now → Sessions** and **Diffs**. Selecting Chat opens a draft; first send
   creates the Session and prepares execution.
4. **Privacy and backup claims were too broad.** Installation said nothing
   except model requests leaves the machine. Search, browser, remote MCP,
   GitHub, updates, and optional telemetry also use the network. Settings
   called the JSON export a backup even though it cannot restore a profile
   and omits attachment and transcript files.
5. **The beginner glossary included executor internals.** Commands, receipts,
   attachment mechanics, and generated agent vocabulary interrupted the user
   terminology. Agent guidance belongs in a separate reference.
6. **Copied generated pages lost their content.** Markdown mirrors left empty
   component tags for command effects, refusal guidance, and capability
   changes. These need expansion from the same shared data as HTML.
7. **A screenshot contradicted the current product.** The ticket-workspace
   screenshot shows the retired Run once control. Remove it from published
   guides until a current capture is available; do not fix this by relabeling
   the alt text.
8. **Navigation had two hand-maintained lists.** The sidebar and llms.txt each
   declared all pages. One shared definition removes a source of drift.

## Page contracts and splits

All user guides assume a developer working in their own local repository.
Agent reference pages assume someone writing or debugging instructions for a
Volli Session.

| Starting page or gap | Page contract after the pass |
| --- | --- |
| Install | How-to: install and connect a provider; source development moves to its own page |
| Quickstart | Tutorial: create a small ticket, send the first instruction, and inspect its change; link to publishing |
| Concepts | Reference: understand unfamiliar user-visible terms; agent internals move out |
| Board | Explanation: understand columns and how task state differs from Session activity |
| Ticket metadata and archive | How-to: edit a brief, set properties, discuss, archive, and restore a ticket |
| Chats and worktrees | Explanation: choose execution scope and understand branch/setup/copy behavior |
| Sessions | How-to: start, send, interrupt, return to, and recover a conversation |
| Review | How-to: inspect, test, commit, push, and open a draft PR |
| Cleanup | How-to: remove checkout state while retaining the branch and ticket history |
| Browser Tabs | How-to: inspect a page, watch the agent, and take or return control |
| Split view | How-to: arrange workspace tabs and focus panes |
| Terminal companions | How-to: explicitly open a shell or external TUI in the correct checkout |
| Automations | Explanation: saved Instructions, Trigger, Runtime, and fresh Run |
| Automation creation | How-to: save a manual workflow with a chosen Runtime |
| Manual Runs | How-to: run a saved workflow and inspect its history |
| Column triggers | How-to: enable, offer, arm, and cancel ticket-arrival Runs |
| Scheduled Runs | How-to: configure a preset and handle missed occurrences |
| Models | Configuration guide: connect a provider, choose defaults/tiers, and distinguish usage measurements |
| MCP | How-to: connect a supported server, select tools, and understand Session/tool lifetime |
| Skills and commands | How-to: reuse instructions and templates without confusing them with tool grants |
| Authority | Explanation/reference: understand posture and attachment policy before relying on enforcement |
| Settings | Reference: locate app-wide and project-specific controls; link to procedures |
| Storage | How-to: inspect cleanup candidates and distinguish JSON export from backups |
| Data and privacy | Reference: storage locations and feature-specific outbound requests |
| CLI | Reference: separate setup/addressing, command syntax, effects, and refusal recovery |

The tree now has 38 public pages, including the home page. All 15 existing
routes remain. Moved Board, Automation, and CLI sections retain their old
fragment IDs beside links to the canonical task pages.

The shared navigation groups pages by Get started, Tickets and code, Run
agents, Automations, Configure Volli, Reference, and Releases. No
competitor-specific terminology or marketing copy is imported.

## Product checks

The implementation and tests resolved several ambiguities in older copy:

- Drafts create a durable Session on first send, not when you open **Chat**.
- Explicit ticket moves can start a cancellable Run when an enabled Automation
  is armed for the destination. Moving from **Doing** or **Needs Review** to
  **Backlog**, **Todo**, or **Done** interrupts live Ticket Sessions. Moving
  between the two active columns does not.
- A chat's explicit model choice takes priority over **Configure → Sessions**,
  which takes priority over the app-wide defaults. Named tiers use the
  app-wide tier instead of that project override.
- MCP tool identities stay with the Session. Re-adding a deleted server by
  name does not repair the identity an old Session recorded.
- Authority Observe records the policy, not individual decisions. Worktrees
  and Authority are not a process sandbox.
- JSON export cannot restore a profile and omits transcript and attachment
  files. No supported backup-bundle creation or restore control is exposed.

Under `apps/desktop/src`, primary sources included
`main/session-runtime/sessions.ts`, `renderer/src/stores/chat-sessions.ts`,
`renderer/src/stores/chat-drafts.ts`, `main/index.ts`,
`packages/host-core/src/automations/pending-armed-runs.ts`, `main/mcp/session-host.ts`,
`main/worktree/include.ts`, and `data-export-copy.ts`, plus shared model policy
and ticket tests. The shared Verb Registry's
public effects descriptions were corrected for armed arrivals and the
Activity Island so HTML, command help, and copied Markdown agree.

## Verification

- `pnpm --config.verify-deps-before-run=warn -C apps/docs run build`, with
  `PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=warn` and
  `npm_config_verify_deps_before_run=warn`: passed. Astro reported zero errors,
  warnings, and hints. The build produced all 38 docs pages and their Markdown
  mirrors; local links, anchors, headings, Copy page targets, llms.txt, and font
  notices passed.
- `node apps/docs/scripts/check-docs.mjs --self-test` and
  `node apps/docs/scripts/check-docs.mjs`: passed after adding retained-fragment
  checks and a slashless-link regression case.
- In `packages/shared`, `vp test run src/verb-registry.test.ts
  src/agent-tool-surface.test.ts src/authority-config.test.ts --coverage
  --coverage.include=src/verb-registry.ts --maxWorkers
  "$VOLLI_CONCURRENCY_HINT"`: 164 tests passed; the modified registry reached
  100% statement, branch, function, and line coverage. `pnpm -C packages/shared
  run typecheck` passed.
- Focused `vp fmt` and `vp lint`: passed for the six docs code files and two
  shared registry files, with zero lint warnings or errors. The root's `docs`
  ignore skips docs code too, so formatting used bare filenames over stdin
  and lint used temporary source copies outside that ignored path. The copies
  were removed. Curated prose received a voice scan and `git diff --check`,
  which passed.
- Local browser smoke: the home page, generated command-effects reference,
  and column-Automation guide rendered with the expected navigation and
  headings. No console errors were recorded. The command-effects Markdown
  endpoint returned HTTP 200 with the expanded content. **Copy page** reported
  **Copy failed** in the tool browser; the embedded Browser Tab host denies
  page permissions (`main/browser/tab-host.ts`). A normal-browser clipboard
  check remains unverified.

The initial build attempted a workspace dependency refresh and failed in the
unrelated desktop `node-pty` postinstall. The docs-only build used the installed
dependencies and passed. The current lockfile diff matches the concurrent
website removal of GSAP; it was preserved rather than reset.

## Follow-up work

- Capture a current ticket-workspace screenshot before reintroducing it.
- The Configure worktree-copy hint says `.worktreeinclude` replaces defaults;
  `main/worktree/include.ts` layers file patterns over defaults. Documentation
  follows the implementation. Resolve this UI inconsistency separately.
- The shared agent primer in `packages/shared/src/agent-product.ts` still
  describes plain chats as durable immediately. Its CLI/managed-skill
  projection needs a separate correction; the user docs follow the current
  draft-promotion implementation.
- Validate navigation with new users. This pass verifies product facts and
  links; it does not establish findability through observed user testing.
- Backup-bundle creation and restore have main-process implementation but no
  app control. Do not document them as a supported user workflow yet.
