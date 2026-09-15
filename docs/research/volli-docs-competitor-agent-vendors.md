# Competitor documentation study: coding-agent vendors

- **Research date:** 2026-09-15
- **Scope:** Claude Code, OpenAI Codex, Cursor, and Aider documentation surfaces, with emphasis on onboarding, permissions, unattended execution, reference quality, support, release communication, and agent-readability.
- **Method:** Read public documentation pages and indexes with absolute URLs; compared each surface with Volli's 14-page Astro Starlight set and the 0.2 Automation public-surface audit. Page facts are marked **[observed]**; recommendations and judgments are marked **[interpretation]**.
- **Canonical URL note:** OpenAI's requested `https://developers.openai.com/codex` pages redirected to the current `https://learn.chatgpt.com/codex` / `https://learn.chatgpt.com/docs` host. Cursor's `/docs/changelog` returned 404; its CLI changelog and versioned entries were reachable.

## Claude Code

### Onboard in the first 30 minutes

- **[observed]** The current canonical docs are at [code.claude.com/docs/en/](https://code.claude.com/docs/en/); the requested `docs.claude.com` search surface did not return pages, while the canonical host was reachable.
- **[observed]** [Quickstart](https://code.claude.com/docs/quickstart) puts prerequisites first: terminal, code project, and a Claude subscription, Console account, or supported cloud provider. It then orders install, `claude --version`, first login, `cd` into a project, first question, first edit, Git, and tests/common workflows.
- **[observed]** The path is eight numbered steps plus essential commands and next-step cards. It assumes a terminal, an existing project, Git familiarity for later steps, and an account or provider credential; it does not make the reader choose among advanced integrations before the first useful edit.
- **[interpretation]** Volli should preserve this shortest-path shape: name the installed-app and provider prerequisites before the first action, then defer Automations until after a successful attended Session.

### Explain trust and permissions

- **[observed]** [Configure permissions](https://code.claude.com/docs/en/permissions) uses a concrete table: file reads are allowed in working directories, Bash and edits ask by default, and WebFetch/WebSearch have their own approval behavior. It explains Manual, Plan, Auto, `dontAsk`, and bypass modes.
- **[observed]** It explicitly says permission rules are enforced by Claude Code, not by prompt instructions, and says bypass mode should be used only in isolated containers or VMs. Rules can be shared in `.claude/settings.json` or kept local in `.claude/settings.local.json`.
- **[observed]** [Hooks reference](https://code.claude.com/docs/en/hooks) documents lifecycle events, matchers, stdin JSON, outputs, exit codes, async hooks, HTTP, MCP, prompts, and subagents. Its good framing is: “Hooks are user-defined ... that execute automatically at specific points in Claude Code's lifecycle.”
- **[interpretation]** This separates *what the agent may do* (permissions) from *what the system should do at lifecycle boundaries* (hooks), a useful model for Volli's Enablement versus Arming.

### Document unattended execution without overpromising

- **[observed]** [GitHub Actions](https://code.claude.com/docs/en/github-actions) distinguishes interactive mode (waits for `@claude`) from automation mode (runs from an event with a `prompt`, without waiting for a mention). It requires repository permissions, secrets, checkout or API tools, and describes actor checks that reject unauthorized users and bot loops.
- **[observed]** The same page says scheduled workflows run on GitHub's default branch and public-repository schedules are disabled after 60 days without activity. It recommends least permissions, workflow timeouts, `--max-turns`, and concurrency controls; it warns not to commit API keys.
- **[observed]** [Overview](https://code.claude.com/docs/en/overview) now separates cloud Routines (continue when the computer is off), desktop scheduled tasks (run on the user's machine), and CLI `/loop`. This is a direct analogue for explaining Volli's “app must be open” limitation.
- **[interpretation]** Copy the explicit split between trigger, execution location, credentials, and limits. Volli should say that a schedule records a skipped occurrence rather than implying cloud-grade durability.

### Reference, troubleshooting, and release communication

- **[observed]** The docs link a full [CLI reference](https://code.claude.com/docs/en/cli-reference), [commands reference](https://code.claude.com/docs/en/commands), [settings](https://code.claude.com/docs/en/settings), [settings reference](https://code.claude.com/docs/en/settings-reference), tools reference, and permission/hook references. These are largely stable reference pages, with current-version behavior called out in prose.
- **[observed]** [Troubleshooting](https://code.claude.com/docs/en/troubleshooting) is a broad feature-oriented guide; installation has a separate error-indexed [troubleshoot-install](https://code.claude.com/docs/en/troubleshoot-install) page. This is stronger than one undifferentiated FAQ but not a strict error catalog.
- **[observed]** [Changelog](https://code.claude.com/docs/en/changelog) is generated from GitHub's `CHANGELOG.md`, shows version labels and dates, and says `claude --version` checks the installed version. Entries include features, fixes, security, and surface-specific notes.

### Make docs usable by agents

- **[observed]** Every fetched page points to [https://code.claude.com/docs/llms.txt](https://code.claude.com/docs/llms.txt), a complete documentation index. The docs also provide Markdown-friendly pages, exact code blocks, CLI references, and MCP/Agent SDK pages.
- **[interpretation]** Claude Code's index plus copyable Markdown is the best direct model for Volli's existing `llms.txt` and per-page Copy page control. Volli should keep its small index curated rather than reproduce the hundreds-page navigation.

## OpenAI Codex

### Onboard in the first 30 minutes

- **[observed]** The requested [developers.openai.com/codex](https://developers.openai.com/codex) and its quickstart redirected to current [ChatGPT Learn](https://learn.chatgpt.com/codex/quickstart). The current quickstart is surface-selective: sign in to ChatGPT, start a chat or project, choose where Codex should work, and send a first message; app and import paths are linked.
- **[observed]** For CLI users, [Codex CLI](https://developers.openai.com/codex/cli) and the [non-interactive-mode guide](https://learn.chatgpt.com/docs/non-interactive-mode) document `codex exec`, Git-repository requirements, auth, JSONL output, and explicit sandbox choices. The quickstart assumes a ChatGPT account or API key, while cloud setup adds GitHub connection and repository access.
- **[interpretation]** Codex's current split between ChatGPT onboarding and developer/CLI reference is powerful but potentially disorienting. Volli's one local macOS path should not branch until the first ticket is running.

### Explain trust and permissions

- **[observed]** [Permissions](https://learn.chatgpt.com/docs/permissions) labels permission profiles “Beta” and says they may change. Built-ins include `:read-only`, `:workspace`, and `:danger-full-access`; profiles combine filesystem and network rules, with narrower deny rules winning.
- **[observed]** The page clearly limits scope: permission profiles govern local command execution, not MCP, browser, connectors, Codex cloud, or service traffic. It notes that on macOS Codex uses Seatbelt and refuses to run when a selected policy cannot be enforced.
- **[observed]** The docs distinguish approval policy from sandbox boundaries and warn that enabling network does not start the network proxy. This is unusually precise trust documentation.

### Document unattended execution without overpromising

- **[observed]** [Codex cloud](https://learn.chatgpt.com/docs/cloud) says cloud tasks run in isolated environments, can run in parallel, and continue while the user works elsewhere or is away. It requires source-control connection and repository permissions, then returns a reviewable summary/diff/PR path.
- **[observed]** [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode) uses the exact framing: “By default, `codex exec` runs in a read-only sandbox. In automation, set the least permissions needed for the workflow.” It recommends `workspace-write` only for edits and `danger-full-access` only in controlled environments.
- **[observed]** CI guidance warns against job-level API keys when repository-controlled code runs, recommends the Codex GitHub Action, separates patch generation from PR write permissions, and uses output artifacts. These details keep “unattended” from meaning “unbounded.”
- **[interpretation]** Volli should borrow the sentence-level discipline: state the default, state the escalation, state where the run occurs, and state what a person reviews afterward.

### Reference, troubleshooting, and release communication

- **[observed]** The [CLI reference](https://developers.openai.com/codex/cli/reference) catalogs commands and flags in searchable tables and marks stable versus experimental options. The current redirect target may expose only developer-command navigation, so URL migration should be expected.
- **[observed]** [Slash commands](https://developers.openai.com/codex/cli/slash-commands), [configuration](https://learn.chatgpt.com/codex/reference/commands), and permission/configuration pages cover keyboard-first controls and settings. Versioning is visible in the [Codex changelog](https://developers.openai.com/codex/changelog), whose current canonical page is on `learn.chatgpt.com` and links GitHub releases.
- **[observed]** Troubleshooting is distributed across feature pages, security guidance, cloud environment setup, and CLI docs rather than presented as one symptom index. This is comprehensive at scale but makes discovery dependent on search.

### Make docs usable by agents

- **[observed]** The developer pages provide Markdown-like reference output, searchable tables, JSONL examples, schemas, GitHub links, and a changelog. MCP and SDK material are documented as extension surfaces.
- **[interpretation]** Codex demonstrates that agent-readability is not only `llms.txt`: deterministic examples, JSON output, explicit schemas, and stable flags are equally important for machine consumers.

## Cursor

### Onboard in the first 30 minutes

- **[observed]** [Cursor docs](https://cursor.com/docs) open with “Start here,” then link to a [Quickstart](https://cursor.com/docs/get-started/quickstart). The quickstart is short: install, sign in, choose a folder, ask Agent to explain the codebase, make one small change, review the diff, run existing checks, and use Plan Mode for larger work.
- **[observed]** It lists OS prerequisites and installation routes before the first project action. It assumes a local folder and account but postpones model, rules, MCP, and cloud-agent choices.
- **[interpretation]** This is the clearest 30-minute tutorial of the four: it establishes a safe first change and review loop before presenting autonomy. Volli's Quickstart already has the same shape and should retain it.

### Explain trust and permissions

- **[observed]** [Run Modes](https://cursor.com/docs/agent/security/run-modes) documents Auto-review, Allowlist, and Run Everything in a table showing what runs without asking, sandbox status, classifier use, and intended use. It says: “Auto-review is not a security boundary. The classifier can make mistakes.”
- **[observed]** It separates `permissions.json` (approval steering) from `sandbox.json` (filesystem/network reach), describes project and user scopes, and lists protections for browser use, file deletion, and external files.
- **[observed]** Cursor explicitly says “Cloud Agents do not use Run Modes” because they execute in dedicated machines and do not ask for approval. This prevents local-control language from being accidentally applied to cloud runs.

### Document unattended execution without overpromising

- **[observed]** [Cloud Agents](https://cursor.com/docs/cloud-agent) says agents run in isolated VMs, can run in parallel without the local machine online, clone a repository, use a separate branch, and return PR-ready artifacts. It names prerequisites: account-admin source-control connection, read-write repository access, environment setup, and paid plan.
- **[observed]** Limits and operational details are prominent: long-running is not available for multi-repo environments; secrets are injected only when an agent starts; Cloud Agents have separate billing and spend limits; a teammate's view is read-only unless follow-ups are enabled.
- **[observed]** Cloud hooks run only after a writable environment exists; local home-directory hooks are unavailable in cloud VMs. This is a strong example of documenting a non-obvious limitation beside the feature.
- **[interpretation]** Volli should put “app must be open,” “not retroactive,” “one armed Automation,” and “Run now is not replay” beside the schedule/column procedures, not bury them in troubleshooting.

### Reference, troubleshooting, and release communication

- **[observed]** Cursor has CLI [configuration](https://cursor.com/docs/cli/reference/configuration), [permissions](https://cursor.com/docs/cli/reference/permissions.md), [sandbox](https://cursor.com/docs/reference/sandbox.md), slash commands, and model/pricing references. Its config declares `version: 1`; only permissions are project-level for CLI settings.
- **[observed]** Cloud Agent troubleshooting is a symptom list (“Agent runs are not starting,” missing secrets, teammate access, Slack integration). The local Run Modes page embeds a troubleshooting path for missing classifier models.
- **[observed]** The docs home advertises Changelog, but [https://cursor.com/docs/changelog](https://cursor.com/docs/changelog) returned 404 on the observation date. The [CLI changelog](https://cursor.com/docs/cli/changelog) is reachable, dated by release, and includes security and behavior changes.

### Make docs usable by agents

- **[observed]** The quickstart and pages expose [https://cursor.com/docs/llms.txt](https://cursor.com/docs/llms.txt), absolute links, Markdown-style `.md` URLs, image alt text, and copyable JSON/config examples. The site also surfaces Learn pages separately from reference docs.
- **[interpretation]** A small Volli set should copy the stable `.md`/index principle and avoid duplicating Learn, product, enterprise, and cloud tracks until there are genuinely different readers.

## Aider

### Onboard in the first 30 minutes

- **[observed]** [Aider docs](https://aider.chat/docs/) are a large, explicit index. [Installation](https://aider.chat/docs/install.html) starts with Python 3.8–3.13, offers `aider-install`, then immediately shows `cd` into a codebase plus provider/model key examples. Optional installers and usage follow.
- **[observed]** The install page assumes users can obtain a provider key and choose a model; it offers DeepSeek, Anthropic, and OpenAI examples rather than hiding provider configuration. The docs then branch into usage, chat modes, Git, configuration, providers, and troubleshooting.
- **[interpretation]** This is efficient for a terminal-native, open-source audience but too choice-heavy for a first Volli run. Volli should keep provider setup in Model Access and reserve provider-specific setup for reference pages.

### Explain trust and permissions

- **[observed]** Aider's primary trust mechanism is explicit confirmation and Git reversibility rather than a sandbox policy. [Git integration](https://aider.chat/docs/git.html) says edits are committed with descriptive messages, `/undo` can reverse them, and dirty work is committed before new edits so existing changes are not lost.
- **[observed]** [Scripting](https://aider.chat/docs/scripting.html) exposes `--yes`, `--dry-run`, and auto-commit switches. Its Python API is explicitly “not officially supported or documented” and may change without backwards compatibility.
- **[interpretation]** The honest warning about the unsupported scripting API is a model for Volli: label guarantees and internal affordances separately; never imply that a convenient path is a supported automation contract.

### Document unattended execution without overpromising

- **[observed]** Aider supports one-shot `--message`, shell loops, Python calls, `--yes`, `--dry-run`, and automatic commits. It does not present a first-party scheduler or hosted background-run product in the docs reviewed.
- **[observed]** [Options reference](https://aider.chat/docs/config/options.html) lists defaults for `--auto-commits`, `--dirty-commits`, `--dry-run`, lint/test automation, analytics, and update checks. [Git integration](https://aider.chat/docs/git.html) explains the review/undo consequences of auto-commits.
- **[interpretation]** Aider's restraint is useful: document scripting as a composable command, state its defaults, and do not call it unattended orchestration when the user still owns the shell/CI scheduler.

### Reference, troubleshooting, and release communication

- **[observed]** Aider has a complete [options reference](https://aider.chat/docs/config/options.html), YAML config guide, provider/API-key pages, in-chat commands and [keybindings](https://aider.chat/docs/usage/commands.html). The options list includes environment-variable names and defaults, which is excellent reference ergonomics.
- **[observed]** [Troubleshooting](https://aider.chat/docs/troubleshooting.html) has a symptom/feature index with dedicated pages for edit errors, warnings, token limits, command-not-found, dependency versions, models, and support. This is the most discoverable troubleshooting structure in the set.
- **[observed]** [Release history](https://aider.chat/HISTORY.html) is a single long page with a main-branch section and version headings, contributor notes, and release-level changes. It is detailed but not a versioned docs-site navigation system.

### Make docs usable by agents

- **[observed]** Aider has a crawlable index, plain HTML-to-Markdown pages, copyable shell/YAML/Python, explicit CLI flags, and an in-chat `/copy-context` command. No dedicated `llms.txt`, MCP docs, or per-page copy control was observed in the reviewed index.
- **[interpretation]** Volli already exceeds Aider's agent-readability baseline through `llms.txt`, Pagefind, Markdown mirrors, and Copy page. Keep those, but add machine-stable examples for Automation state and Run outcomes.

## Cross-vendor patterns

- **[observed]** All four lead with a short first-use path, then branch into feature guides and references. The strongest paths make the first useful change reviewable before introducing unattended execution.
- **[observed]** Permissions are documented as a matrix or named modes, not as vague “safe” claims. Sandboxing, approval, network reach, credentials, and cloud/local execution are separate concepts.
- **[observed]** Every vendor states an unattended limit: GitHub actor/secret checks, Codex read-only default, Cursor cloud-environment boundaries, or Aider's shell/API ownership. Good copy names where execution occurs and who reviews output.
- **[observed]** Reference surfaces use tables, exact labels/flags, defaults, config paths, schemas, and version signals. Troubleshooting works best when symptoms have their own index and feature pages carry feature-specific failure conditions.
- **[observed]** Claude Code and Cursor expose `llms.txt`; Cursor and Claude expose Markdown-friendly pages; Codex emphasizes JSONL/schema output; Aider emphasizes CLI help, plain pages, and copy-context. MCP is documented as an integration surface by Claude, Codex, and Cursor.
- **[interpretation]** For 14 pages, Volli should optimize for one reader path, not imitate a vendor's product matrix. Its existing dark-only Starlight, search, Copy page, Markdown mirrors, and generated `llms.txt` are the right foundation.

## What Volli should adopt now / later / never

- **Now — Add one Automation concept/how-to path after Quickstart.** Explain saved Instructions, Trigger, Runtime, Enablement, Arming, and fresh Run/Session in reader order; cite [Claude quickstart](https://code.claude.com/docs/quickstart) and [Volli Automations](https://docs.volli.app/guides/automations/). **[interpretation]**
- **Now — Put prerequisites and limits beside each automatic trigger.** State that the app must be open, schedules do not replay, and column entry is deliberate/non-retroactive; cite [Cursor Cloud Agents](https://cursor.com/docs/cloud-agent) and [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode). **[interpretation]**
- **Now — Add an enablement/arming truth table.** Show manual Run, Enabled, Offered, armed column, schedule, and skipped occurrence outcomes; cite [Claude permissions](https://code.claude.com/docs/en/permissions) and [Cursor Run Modes](https://cursor.com/docs/agent/security/run-modes). **[interpretation]**
- **Now — Make troubleshooting symptom-first.** Add “Automation does not start,” “scheduled Run was skipped,” and “Runtime is unavailable” to the existing page, with exact UI labels; cite [Aider troubleshooting](https://aider.chat/docs/troubleshooting.html). **[interpretation]**
- **Now — Keep reference facts scannable and machine-readable.** Add a compact Automation state table, CLI limitations, keyboard shortcuts, defaults, and stable examples to `llms.txt`/Markdown mirrors; cite [Aider options](https://aider.chat/docs/config/options.html) and [Claude llms.txt](https://code.claude.com/docs/llms.txt). **[interpretation]**
- **Later — Add a versioned release-notes route tied to changed docs.** Keep release-specific behavior and migration notes separate from evergreen guides; cite [Claude changelog](https://code.claude.com/docs/en/changelog) and [Codex changelog](https://developers.openai.com/codex/changelog). **[interpretation]**
- **Later — Add richer machine integrations only when supported.** Consider a documented API/MCP or structured Run export after the local UI contract stabilizes; cite [Codex JSONL automation](https://learn.chatgpt.com/docs/non-interactive-mode) and [Claude MCP overview](https://code.claude.com/docs/en/overview). **[interpretation]**
- **Never — Do not promise autonomous, cloud-like execution for a local app.** Say what Volli does not do, preserve visible Run history, and keep the app-open constraint explicit; cite [Cursor Run Modes](https://cursor.com/docs/agent/security/run-modes) and [Codex cloud](https://learn.chatgpt.com/docs/cloud). **[interpretation]**
- **Never — Do not copy enterprise-scale navigation or provider matrices yet.** Keep one Quickstart, one Automations guide, one reference, and one troubleshooting index until reader tasks justify expansion; cite [Aider docs index](https://aider.chat/docs/) and [Cursor docs](https://cursor.com/docs). **[interpretation]**
