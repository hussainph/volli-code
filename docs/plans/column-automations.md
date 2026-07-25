# Column Automations — Configured Sessions, Triggered by Board Moves

Decision #38 deferred every column-entry effect to "a future user-configurable column-automations
system," #39 said that system "defines its own trigger vocabulary," and #44/#45 parked the Done-entry
dialog and opt-in auto-commit in the same place. This is that system.

The framing that governs every decision below: **an Automation removes the repetitive setup, not the
person.** It saves the work of composing a prompt and picking a harness, model, and effort — so that
starting well-configured agent work is one gesture instead of a ritual. It is not an unattended job
runner. The user is expected to be inside the session it opens, and the v1 scope is cut accordingly:
Volli asserts that it *launched* a session, and nothing more.

Vocabulary — Automation, Armed automation, Run, Outcome, Instructions, Context chip, Runtime — is
defined in `CONTEXT.md` and is not restated here.

## Settled decisions

| #  | Decision | Alternatives rejected | Rationale |
|----|----------|----------------------|-----------|
| 79 | **An Automation is one object with four parts — Trigger, Instructions, Runtime, Outcome — at global or project scope.** Global ones appear in every project; project ones only in theirs. The four parts are authored on one page and are not separately addressable objects. Invoking one by hand is always possible regardless of Trigger, because the Trigger field describes only unattended firing. | A trigger-less "recipe" plus a separate trigger object (every manual invocation becomes a fiction — firing a trigger you didn't mean); column-owned automations (the same prompt can't be reused across columns or projects); Cursor's fused trigger+instructions (Cursor only runs unattended in the cloud and has no manual-invocation case) | One object matches how the work is actually thought about, and the global/project split mirrors the real division between a personal habit ("TDD on Sol") and a repo-specific rule ("check this codebase's type boundaries"). |
| 80 | **Columns are armed; automations are not self-firing.** A column holds at most one armed Automation. A plain drop into an armed column fires it; a plain drop into an unarmed column is a pure status change, exactly as today. Arming is per-project, is **not retroactive** (it governs tickets that arrive afterwards, never those already sitting there), and in v1 fires only on a **Deliberate move**. | A per-automation `autoFire` flag (needs a validation rule to prevent two automations claiming one column; arming on the column makes it structural); a picker on every drop (taxes the common path); firing when exactly one automation matches (silently changes behaviour when you add a second) | Arming on the column gives the binding an obvious home in the UI and makes "at most one" impossible to violate. Restricting to Deliberate moves preserves #20 — no Run is ever born from another Run. |
| 81 | **Runtime pins a harness; model and effort are adapter-owned and overridable at invoke time.** Instructions are written in one harness's dialect and do not port, so the harness is fixed. Each adapter declares its own runtime schema and how to apply it — flag, config argument, model slug, prompt keyword, or env var — and validates an opaque blob; adapters also expose an optional ordered effort scale so an invoke-time dial has one uniform thing to bind to. Model is a combobox with suggestions, never a closed enum. Forking an Automation for a different model is done by **duplicating** it. | A normalised cross-harness effort enum (asserts equivalences that don't hold: Codex takes `-c model_reasoning_effort`, opencode folds it into the model slug, Cursor bakes it into the slug, and Claude Code has no effort flag at all — only thinking keywords or `MAX_THINKING_TOKENS`); curated closed model enums (model names churn far faster than app releases); raw CLI args only (no affordance to build UI on) | Only the adapter can know its own dialect. Duplication produces two visibly distinct things rather than one thing with hidden variance. |
| 82 | **Instructions are a seeded template of prose, Context chips, and harness commands; references are live, never copied.** A new Automation arrives pre-seeded so the ticket's context is present without configuration, and chips (`{{brief}}`, `{{change_set}}`, `{{comments}}`, `{{pr}}`, `{{branch}}`) can be moved, demoted, or removed deliberately — a review automation needs the Change Set with the Ticket Body demoted, which a fixed sandwich cannot express. The `/` picker has three tiers: scanned from disk, a curated per-adapter list of built-ins, and free text that is never blocked (an unrecognised token renders as prose with a quiet unverified affordance). A skill that later disappears is a **Dangling Reference**, reusing #63/#64's existing treatment. | A fixed Instructions-then-Brief sandwich (a review automation can't demote the body or reach the Change Set); no seeding (the ticket silently missing from the prompt is a footgun); disk-only scanning (`/code-review` and `/review` are compiled into their binaries and appear nowhere on disk — the most useful commands would be silently omitted); importing copies of skills (drifts invisibly from the skill you maintain, which is worse than breaking visibly) | The editor already ships `@file` reference chips, and the glossary already names the failure mode for a reference that stops resolving. Both are reused rather than reinvented. |
| 83 | **A Run is provenance: one invocation, one Session, one snapshot.** A Run records which Automation and Runtime produced a Session, snapshotting the resolved runtime and the **rendered prompt** at launch so that editing or deleting an Automation never rewrites history. A ticket has at most one Run in flight. Runs are durable rows with an explicit state; one whose Session died is surfaced as interrupted with one-click resume, and never restarts itself. Hand-started sessions belong to no Run. | Reviving the primary session (#39 deleted it); ticket-scoped last-writer-wins outcomes (two Runs racing to resolve contradictory Outcomes is incoherent); auto-resume on relaunch (spending tokens without a human act, contra #20); referencing the Automation without snapshotting (a `ticket_event` is append-only and "never rewritten" — history that mutates when you edit a prompt is a lie) | This restores #13's lifecycle hook point without restoring the primary session: the Session isn't special, the contract it was born with is. |
| 84 | **v1 asserts launch only.** No completion detection, no Outcome resolution, no chaining, no parsing of harness output. The Outcome concept and its column exist, unset. Tickets leave Doing because you moved them. Volli reports only failures it genuinely owns — provisioning, `setup_command` exit code, a harness binary missing from `PATH`, unresolved references — plus one cheap signal: a Session that exits within seconds of launch is flagged "ended immediately" using the `sessions.exit_code` already persisted. | Stop-hook completion (Stop fires after *every* turn, per #13); explicit `volli session done` as the sole mechanism (#13 rejected relying on agent obedience alone); adapter-shipped regex matchers for fatal output (maintaining regexes against vendor output, in four dialects); non-interactive print mode (forfeits the live interruptible terminal the product is built on) | Completion detection is where all the harness-specific fragility lives, and without chaining or scheduling there is almost nothing to spend it on. The user is in the session; the terminal is the report. |
| 85 | **Bulk invocation fires everything at once; only worktree provisioning is capped.** Concurrent `ensure` pipelines are limited because the contention is disk and `setup_command`, not model calls. Nothing else waits, and there is no queue. The ticket's `uses_worktree` always wins over the Automation, and `setup_command` always runs, upholding #41's sentinel gate. | A run queue with a concurrency limit (Volli deciding how the user spends their own money); a confirmation dialog over some count; letting an Automation declare that it needs no worktree or no setup (column scope or an automation flag silently controlling filesystem semantics, and a worktree that exists in a never-set-up state needing a new persisted bit) | The goal is to be the best place to parallelise agentic work. A user firing fifty sessions understands the cost; capping provisioning is invisible to them and prevents fifty simultaneous installs. |
| 86 | **Four surfaces, and dragging is not the primary one.** (a) A top-level **Automations** nav item beside Board · Terminals · Files · Configure, hosting both scopes behind a User/Project switcher, with in-situ creation from the arming menu so authoring never requires a trip to settings. (b) Column-header arming. (c) On the board, drag **never changes drop targets**; the automation is an orthogonal channel and the dragged card names what will run. (d) Inside a ticket, an adaptive split button in the header reusing #45's shipped pattern, whose primary names the move *and* the automation ("Move to Needs Review · Code Review"), with the session tab strip's new-session control as the secondary "run without moving" path. Firing never navigates. | Splitting the page across Configure and the Settings overlay (recreates the burial the design is reacting to); expanding a column into drop bands on hover (fights traversal — Backlog → Doing crosses Todo, the most ordinary path on the board); a floating slot overlay (small targets requiring aim mid-drag); a post-drop picker modal (feedback should be continuous during a gesture, not arrive after it); ⌘K only (undiscoverable); an Automations block in the Details rail (that rail is status; this is the ticket's main action) | The ticket-centric modality is the common one, and it has no column to drop into — so the in-ticket control, not the drag, is the primary entry point. |
| 87 | **Ticket body writes get real optimistic concurrency, mode-aware.** `row_version` is enforced with `WHERE row_version = ?` and `rowVersion` is exposed on the domain ticket (`mapTicket` currently drops it). Relative CLI mutations (`--append`, `--edit`) re-read and re-apply on mismatch, because they remain correct against newer text. Absolute writes (`--replace`, the editor's whole-body autosave) fail with a typed conflict, handled by the "Changed elsewhere" banner `TicketBodyEditor` already has. | Propose-and-accept diffs (crowds the workspace, adds a decision per turn, and encodes distrust of the agent's involvement); failing every path loudly (agents hit spurious errors on appends that were never in conflict); guarding only the editor; serialising all body writes | A Todo grill session is the one flow where a human and an agent edit the same field concurrently, and `row_version` is currently incremented but never checked — both paths end in last-write-wins. The human-facing half of the fix already exists and is only advisory. |
| 88 | **Seeded, unarmed Automations plus an explicit create surface.** A small set of real, editable Automations — roughly one per lifecycle stage — is seeded on first launch, all unarmed, alongside a create affordance. Column headers show a quiet "arm an automation" hint so the trigger stays discoverable. | An empty state (authoring a prompt, harness, model, effort and commands before learning whether the feature is useful is a steep first step); a template gallery with nothing instantiated; seeded *and* armed (spends tokens on someone's first drag — the surprise #20 exists to prevent) | Editing beats authoring from scratch, and the seeds are where the product's mild opinion about the lifecycle lives. |
| 89 | **Resume wins over arming (upholds #21).** A Deliberate move into an armed column starts a Run only when the ticket has **no resumable session**. If one exists, #21's resume behaviour is unchanged and no Run is created. Both stay one click apart on the in-ticket advance button: `Resume` as the primary, `Start a fresh Run` in the chevron. | Arming always winning (Needs Review → Doing is the most common bounce on the board, and #21 exists precisely because that is when the agent's context matters most — starting fresh there is agent amnesia at the worst possible moment); a per-Automation resume-or-fresh flag (asks the author to predict a runtime condition they cannot see); prompting on every such move (a modal for a 90%-obvious answer, which #21 already rejected once) | This is barely a special case: an Automation exists to *set up* work, and work already set up and mid-context does not need setting up again. Keeping the fresh Run one click away makes the rarer intent cheap without making it the default. |

### Derived rules (adopted, not separately debated)

- A Run whose ticket is dragged out from under it is interrupted by the existing `interruptOnBackwardMove`
  path, and its Outcome is voided rather than applied later — a Deliberate move wins (#20).
- Invoking from a menu does not move the ticket. The drag offers automations scoped to the **target**
  column; the context menu offers those scoped to the ticket's **current** column; `any`-scoped
  automations appear everywhere.
- Authoring an Automation for a harness that isn't installed is allowed, with a warning. Detection
  governs what runs, not what can be written.
- Backlog intake needs no new feature. A scratch session with the user's own Sentry/GitHub/PostHog MCP
  servers calling `volli ticket create` already works by design (#34).

## Data model

New tables, migration 14+. Nothing here changes existing ticket or session semantics.

```sql
CREATE TABLE automations (
  id            TEXT PRIMARY KEY,
  project_id    TEXT REFERENCES projects(id) ON DELETE CASCADE,  -- NULL = global scope
  name          TEXT NOT NULL,
  column_scope  TEXT NOT NULL,          -- 'any' | JSON array of TicketStatus
  instructions  TEXT NOT NULL,          -- markdown with chips and command references
  harness_id    TEXT NOT NULL,
  runtime       TEXT NOT NULL,          -- opaque JSON, validated by that harness's adapter
  outcome       TEXT,                   -- JSON; always NULL in v1 (#84)
  sort_order    INTEGER NOT NULL,
  row_version   INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE column_arming (
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status        TEXT NOT NULL,          -- TicketStatus
  automation_id TEXT REFERENCES automations(id) ON DELETE SET NULL,
  PRIMARY KEY (project_id, status)      -- one armed Automation per column, structurally
);

CREATE TABLE runs (
  id              TEXT PRIMARY KEY,
  ticket_id       TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  automation_id   TEXT REFERENCES automations(id) ON DELETE SET NULL,
  session_id      TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  -- snapshot (#83): history must survive editing or deleting the Automation
  automation_name TEXT NOT NULL,
  harness_id      TEXT NOT NULL,
  runtime         TEXT NOT NULL,
  rendered_prompt TEXT NOT NULL,
  outcome         TEXT,
  state           TEXT NOT NULL,        -- pending|provisioning|running|interrupted|ended|failed
  invoked_by      TEXT NOT NULL,        -- arm|drag|menu|advance|palette
  created_at      INTEGER NOT NULL,
  ended_at        INTEGER
);
```

Also required, without a schema change: enforce `WHERE row_version = ?` in `updateTicketFields`, carry
`rowVersion` through `mapTicket` and `TicketUpdateInput`, and add `run_started` / `run_interrupted` /
`run_ended` to `TICKET_EVENT_KINDS`.

Pure domain code — column scope resolution, which automations are offered where, arming validity, Run
state transitions — belongs in `@volli/shared` and is unit-tested there. The renderer only observes it.

## Composition

At launch the Instructions template is rendered by resolving its chips against live ticket state, and
the result is passed to `buildHarnessCommand` in place of today's `composeTicketPrompt` output. The
`{{brief}}` chip resolves to the existing Runtime Brief (#62) — orientation preamble, Ticket Body,
attachment paths, reference manifest, CLI paragraph — so briefs and automations compose rather than
compete. The rendered string is snapshotted onto the Run before the PTY is spawned.

## Staging

1. Domain model in `@volli/shared` + migration + repos + IPC. No UI.
2. The Automations page, both scopes, with the seeded set (#88). Manual invocation from the ticket
   context menu only.
3. Column arming + plain-drop firing on a Deliberate move (#80), with Runs and card state.
4. The in-ticket adaptive advance split button (#86d) — the primary entry point.
5. `row_version` enforcement (#87), independently shippable and worth doing early.

## Deferred

### Hook coverage (researched July 2026)

Findings for whenever completion detection is picked back up. The headline confirms #13 and justifies
#84: **every harness's turn-end signal means "the agent yielded the loop," not "the work is done."**

| | Turn-end hook | Project-scoped | Session id | Notes |
|---|---|---|---|---|
| Claude Code | `Stop` (+ `StopFailure`), distinct from `SessionEnd` | `.claude/settings.json` | `session_id` on stdin JSON, plus `transcript_path` and `last_assistant_message` | Richest waiting-on-human signal: `Notification` matchers include `agent_needs_input` and `agent_completed`, alongside `PermissionRequest`. `AskUserQuestion` has open reports of waiting silently without firing one. |
| Codex | `Stop`, distinct from `SessionEnd` | `<proj>/.codex/hooks.json` — **only once the project directory is trusted**; untrusted hooks need `/hooks` review first | `session_id` and `turn_id` | The trust gate is a real obstacle for installing hooks into a freshly created worktree, which is exactly what #38/#41 do. Only approval-oriented `PermissionRequest`; no `Notification` equivalent. |
| opencode | `session.idle` | `.opencode/plugins/` | Not documented as a stable field on every event | **No `hooks.json` at all** — it is a JS/TS in-process plugin API. The adapter must ship and install a plugin, not render a config file, which breaks the "adapters generate hook configs" assumption in the core loop. Volli already writes `~/.config/opencode/command/volli.md`, so it has a foothold. |
| Cursor CLI | `stop`, with `status: completed \| aborted \| error` | `.cursor/hooks.json` | `conversation_id` | IDE documentation is not CLI parity. Staff confirm `stop`, `sessionStart`, `postToolUse` and the shell/file hooks work locally; `afterAgentResponse` and `afterAgentThought` do not fire, and cloud lifecycle hooks reportedly don't either. |

Consequences: Claude Code and Codex are the viable first targets for the when/which split (Stop says
*when* control came back, an explicit `volli session done` / `blocked` says *which* Outcome arm applies).
opencode needs a plugin adapter rather than a rendered config. Codex needs its trust gate solved before
worktree-scoped hooks are usable. Distinguishing "done" from "asking you a question" is partial on every
harness, so the Outcome's third arm — ended without signalling — is not an edge case but the common path.

### Everything else

Completion detection, Outcome arms, and chaining (a per-automation "on any entry" arm mode plus a cycle
guard is the sketched shape); scheduling, which attaches as a start condition on a Run rather than a new
subsystem; the cross-harness usage picture (5-hour, weekly, monthly and API budgets in one place, with
scheduling that respects them) — its own concept, needing per-harness usage telemetry no adapter reads
today; and the Done automation for conflict and CI work, which stops at "ready to merge" because Volli
never merges and the rail keeps the deterministic git verbs (#44/#45). #76's merge-watch already reads
`mergeStateStatus` and `statusCheckRollup`, so that automation's trigger conditions are already computed.

## Open questions

- **The drag picker is prototype-gated.** It must satisfy: no dwell and no debounce anywhere on the
  path; automation **name and harness** legible rather than bare numbers; drop targets identical to
  today; the dragged card always naming what will run. Sketched direction is a palette in the board
  header strip (never a drop target) while a modifier is held, with digits as an accelerator capped at
  what one hand can reach. Build three or four variants side by side rather than arguing further.
- **The Automations page layout** — same, better designed than debated.
- **Harness hook coverage** is now researched (July 2026) and constrains the deferred work rather than
  v1. See "Hook coverage" under Deferred.
- The human half of Needs Review depends on full diff views, still deferred; the Details rail shows only
  a merge-base diff stat today.
