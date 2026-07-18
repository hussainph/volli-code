# The `volli` CLI + skill pack

Grilled and settled 2026-07-18. This doc is the decision record **and** the
implementation contract for the agent-facing CLI (CONCEPT #6, #13, #18) and the
harness skill pack that ships with it. It expands the five-command sketch in
CONCEPT's "The `volli` CLI" section into the full v1 surface. Hook-config
generation and lifecycle auto-moves stay in the loop milestone — the commands
they will call ship here; nothing calls them yet.

Three research passes back this spec (agent-friendly CLI conventions; the
Agent Skills spec + per-harness install matrix; worktree paradigms across
T3 Code / cmux / Vibe Kanban / Codex / Claude Code). Findings are folded in
where they changed a decision; the worktree pass only feeds Future Work.

## Decisions

1. **The agent surface, not "the app's API."** The CLI exposes: full read of
   the planning layer and session history; full write of the planning layer
   (create/update/move/comment/label/archive tickets); session lifecycle
   signals (`session done|blocked`); read-only observation of other sessions
   (`session peek`); native notifications. Excluded by design: deleting
   archived tickets (the one destructive act stays human, CONCEPT #16),
   adding/removing projects, app settings (none exist yet; revisit when they
   do), and driving another session's terminal. An orchestrating agent
   influences other agents *through the board* — move their ticket, comment on
   it — never by reaching into their PTYs.
2. **Moves are moves.** A CLI `ticket move` carries identical semantics to a
   human drag, including whatever automation is attached to the destination
   column now or later (when the loop lands, an agent moving a ticket to Doing
   boots another agent). Guardrails are *visibility, not caps*: agent-initiated
   entry into Doing fires a native notification, and every event is attributed
   (decision 8). Restraint is soft-enforced through skill norms (read before
   write, don't chain-spawn), not hard limits. CONCEPT #20's staleness rule
   generalizes: **deliberate moves** (human drag or explicit CLI move) win over
   trailing lifecycle events.
3. **Addressing: display IDs are the only ticket handles.** Input and output;
   UUIDs never cross the socket boundary in either direction. Sessions are
   addressed by the short ids `session list` prints. Context resolves by a
   strict ladder — explicit flag → environment (`VOLLI_SESSION`,
   `VOLLI_TICKET`, `VOLLI_SOCKET`) → cwd inference (walk up; registered
   project folder or one of its worktrees) → hard error naming all three
   mechanisms. Never guess.
4. **Ticket prefixes become workspace-unique** (Linear team-key model),
   enforced as readable validation at project create/edit — no DB constraint
   migration (existing DBs may hold dupes; the CLI's never-guess error handles
   the residue by listing candidates). Payoff: a display ID unambiguously
   names one ticket *anywhere*, so `--project` is only needed for listing and
   creating. Project names stay non-unique labels; ambiguous `--project` by
   name errors with candidates (name, prefix, path) and accepts a path as the
   always-unique fallback.
5. **Cross-project gets the full agent surface.** `--project` reaches any
   registered project for reads *and* writes (file a ticket where it belongs).
   The orchestration skill carries the norm "work your own board unless
   instructed."
6. **Output contract** (validated against clig.dev, gh, and 2025–26
   agent-CLI writing):
   - stdout is data; stderr is everything else.
   - TTY stdout → concise human-pretty text. Non-TTY stdout → plain, stable,
     uncolored, untruncated text *automatically* (the flag is not the only
     trigger). `NO_COLOR` respected.
   - `--json` on every command — a parallel code path over the socket's JSON,
     not munged pretty-print. `ticket brief` honors it too
     (`{"prompt": "..."}`); its bare stdout is the raw composed prompt.
   - Errors: one actionable sentence prefixed with a stable machine-matchable
     code — `error[TICKET_NOT_FOUND]`, `error[AMBIGUOUS_PROJECT]`,
     `error[BODY_MATCH_FAILED]`, `error[APP_UNREACHABLE]`, … Fixed vocabulary,
     documented in `volli help exit-codes`.
   - Exit codes: `0` ok · `1` failure · `2` usage · `3` app unreachable
     (retryable infra class, kept distinct so hooks/scripts branch without
     parsing stderr).
7. **Runtime and distribution.** `volli` is a tiny shell shim exec'ing the
   app's own bundled Electron with `ELECTRON_RUN_AS_NODE=1` against a thin
   client bundle — no system Node dependency, no second runtime shipped. The
   app (re)generates the shim into `<userData>/bin/` on boot with absolute
   paths baked, so it always matches the installed app. Reach:
   - **Volli-spawned sessions**: `<userData>/bin` is prepended to PATH in the
     PTY env alongside `VOLLI_SESSION` / `VOLLI_TICKET` / `VOLLI_SOCKET` /
     `VOLLI_ARTIFACTS_DIR`. Zero setup.
   - **Outside Volli**: first-launch consent moment offers to symlink the shim
     into `/usr/local/bin` (admin prompt, VS Code's `code` pattern) — with an
     explanation of why, and defer/decline honored (re-runnable from the app
     menu). Startup budget: shim → first byte of output well under ~100ms.
8. **Socket + actors.** `<userData>/volli.sock`, mode 0600. One-shot
   newline-delimited JSON: `{v: 1, cmd, args, ctx}` → one Result-shaped
   response. All validation, resolution, event-writing happen server-side in
   main — the CLI is a dumb pipe, so every future consumer (UI, daemon, cloud)
   sits behind the same choke point. No credentials ever cross it. Every
   mutation writes its ticket event in the same transaction with an **actor**:
   `user` (app UI, or CLI with no session env) · `session` (explicit CLI
   command from a Volli-spawned session — the app records *the door, not the
   keyboard*; payload carries session id + its ticket) · `automation`
   (lifecycle results: `session done|blocked`, future auto-moves). The UI
   phrases attribution as "via VC-9's session," never claiming to know who
   typed.
9. **No implicit app launch.** A dead socket → `error[APP_UNREACHABLE]`, exit
   3. Recovery is the explicit `volli app launch`: blocks until the socket
   accepts (kills the boot race), idempotent no-op when already running, fires
   an in-app toast ("Volli launched by an agent via the CLI"). The skill
   teaches the loop: *exit 3 → `volli app launch` → retry*. Hooks and plain
   reads can never resurrect the app as a side effect.
10. **Edit-shaped body mutation.** `ticket update` supports `--body`/
    `--body-file` (replace), `--append` (add a section), and
    `--edit <old> <new>` (exact-match replacement; errors
    `BODY_MATCH_FAILED` when the old text is missing or not unique — the
    Edit-tool paradigm agents already know, doubling as an implicit conflict
    guard: stale reads fail loudly instead of clobbering). Skills teach
    read-before-write on top.
11. **Worktree default on, opt-out for all.** `ticket create` accepts
    execution config (`--harness`, `--base`, `--no-worktree`). A human-only
    flag is unenforceable (the socket can't know who's typing), so the flag
    exists for everyone; the orchestration skill carries "don't opt out of
    isolation unless instructed." Base branch is a **pinned project setting**
    (auto-detected at project add, editable in one obvious place; `--base`
    overrides per ticket) — `git worktree add` branches from any ref, so the
    root checkout's state never matters to automation.
12. **Skill pack: one hub-and-spoke skill, global-only install.**
    - Structure: `volli/SKILL.md` (the hub/router, a few hundred tokens) +
      `cli.md` (full command surface, examples-first) + `orchestration.md`
      (norms) + `custom/` (**user-owned, never touched by updates** — the
      boundary the future automation surface walks through).
    - Install (consent-gated, bundled into the same first-launch moment as the
      PATH symlink; detected harnesses only): one canonical real copy at
      `~/.agents/skills/volli/` (the cross-tool location Codex, Cursor, and
      OpenCode all read) + a symlink at `~/.claude/skills/volli` for Claude
      Code (which reads only its own dirs). Two install targets total.
    - Harnesses without lazy-loading skills get a condensed **fenced section**
      (`<!-- volli:begin v=N --> … <!-- volli:end -->`) in their global
      instructions file; the machinery is file-agnostic (`AGENTS.md`,
      `CLAUDE.md`, `~/.codex/AGENTS.md`, …) and adapters choose targets.
      Markers present → replace inside only; absent → append a new block;
      never edit outside markers; byte-identical → skip the write. Claude Code
      does **not** read AGENTS.md (confirmed against current docs) — it gets
      the full skill instead, which is strictly better.
    - Refresh on app update rewrites managed files only, **hash-guarded**: the
      installer records content hashes at install; a user-edited managed file
      is never silently overwritten (warn + diff instead). `custom/` is never
      read or written by the installer. Uninstall removes exactly the managed
      files, symlink, and fenced blocks. Install/refresh/uninstall are
      idempotent.
    - Slash entry points where the harness has a real mechanism: Claude Code
      skills are already `/volli`; OpenCode gets a command file. **Codex gets
      no prompt file** — custom prompts are deprecated in favor of skills
      (`$volli` mention / `/skills` picker); building one would target a
      mechanism being walked back.
    - **Guaranteed invocation inside Volli sessions**: the composed brief
      itself instructs loading the `volli` skill — description-matching is
      only load-bearing *outside* Volli, where dormancy is the goal. Skill
      descriptions self-scope ("Use when working in a Volli-tracked project or
      a Volli terminal session…").
    - Authoring rules (acceptance criteria, from the Agent Skills spec +
      Pocock): third-person `description` = *what it does* + "Use when …"
      trigger contexts, key use case first; SKILL.md body < 500 lines;
      references one level deep from SKILL.md; every line passes the no-op
      test (no "be thorough" filler); gerund-free short name `volli` (product
      name trumps the gerund convention here).
13. **Harness adapter architecture: shared core + thin per-harness modules.**
    Everything shared (skill content, fenced-section machinery, install-plan
    building, brief wiring, env contract) lives in one shared core. A
    per-harness module contains *only* that harness's deltas — paths, slash
    mechanism, hook format (future), detection rule — as pure descriptors and
    functions returning **declarative install plans**; a single main-process
    executor applies plans to disk. `harness-command.ts` (launch templates)
    folds into this interface rather than remaining a parallel mechanism.
    Industry-wide upgrades land once, in the core; per-harness evolution
    touches one file.
14. **One PR** on `feat/volli-cli`. Deferred to the loop milestone: hook
    generation and auto-move wiring. Deferred further (Future Work): worktree
    CLI integration, session summarization, `--turns` peek, automation
    building.

## v1 command surface

Columns accept `backlog | todo | doing | needs-review | done` (`review` is an
alias for `needs-review`). `<id>` is always a display ID.

| Command | Contract |
|---|---|
| `volli identify` | Print resolved context: project, ticket, session, worktree path, socket, app version. The agent's "where am I" — mirrors cmux's `identify`. Works degraded (env-only) when the socket is down. |
| `volli board [--project <p>]` | Composite snapshot: columns × tickets (id, title, labels, priority, badge). The token-efficient single read. |
| `volli ticket list [--status <col>] [--label <l>] [--priority <pr>] [--project <p>] [--limit <n>]` | Filterable list; plain columns `VC-12  Doing  Fix login flow  [bug]`. |
| `volli ticket show <id> [--events <n>] [--comments <n>]` | Detail block: fields, body, recent events + comments (defaults small). |
| `volli ticket events <id> [--limit <n>]` | Append-only history slice. |
| `volli ticket create --title <t> [--body <b>\|--body-file <f>] [--label <l>]… [--priority <pr>] [--status <col>] [--project <p>] [--harness <h>] [--base <branch>] [--no-worktree]` | Labels get-or-create by name. Default status Backlog. Returns the new display ID first. |
| `volli ticket update <id> [--title <t>] [--body <b>\|--body-file <f>] [--append <text>] [--edit <old> <new>] [--priority <pr>] [--add-label <l>]… [--remove-label <l>]… [--harness <h>] [--base <branch>]` | Body modes per decision 10; `--edit` fails `BODY_MATCH_FAILED` on missing/non-unique match. |
| `volli ticket move <id> --to <col>` | Deliberate move, full automation semantics (decision 2). |
| `volli ticket comment <id> -m <msg>\|--file <f>` | Appends a comment event. |
| `volli ticket archive <id>` | Reversible by design (CONCEPT #16); no delete exists. |
| `volli ticket brief <id>` | Raw composed prompt on stdout; `--json` wraps as `{"prompt"}`. |
| `volli project list` | Name, prefix, path, ticket counts. |
| `volli label list [--project <p>]` | Read-only; label mutation is get-or-create via ticket flags only. |
| `volli session list [--project <p>] [--ticket <id>]` | Short id, kind (ticket/scratch), status, ticket, age. |
| `volli session peek <sid> [--lines <n>]` | Snapshot observation: last N output lines + status. Conservative default (~60); the skill warns that slurping sessions pollutes the caller's own context. |
| `volli session done [--reason <r>]` / `volli session blocked [--reason <r>]` | Hook-called (future); env-inferred session; actor `automation`. Reason becomes the Needs Review badge (CONCEPT #13) when the loop lands. |
| `volli notify -m <msg> [--title <t>]` | Native notification (attention-aware rules apply when the loop lands). |
| `volli app launch [--timeout <s>]` | Decision 9. |
| `volli help [<topic>]` | Examples-first. Topics: `json`, `exit-codes`, `addressing`, `orchestration`. |

## Implementation contract

### `packages/cli` (new, `@volli/cli`)

- Thin by construction: argv parsing (dependency-light), context assembly
  (env + cwd), one socket round-trip, renderers (pretty / plain / json), exit
  mapping. No domain logic, no DB access, strict TS, unit-tested renderers
  and parser.
- Built as a single JS bundle. The app generates `<userData>/bin/volli` (shim:
  `ELECTRON_RUN_AS_NODE=1 exec <app Electron> <bundle> "$@"`) on every boot;
  dev mode points at the workspace's Electron. The global install symlinks
  this same shim.

### Main process

- `src/main/agent-socket.ts`: `net.Server` on `<userData>/volli.sock`
  (unlink-on-boot, 0600), NDJSON framing, request router.
- **One command layer, two doors**: the socket router and the existing
  `data-ipc.ts` handlers call the same extracted command functions (create/
  update/move/comment/…) — no duplicated mutation logic. Commands gain an
  `actor` parameter; IPC passes `user`, socket resolves per decision 8.
- **Renderer refresh**: socket-originated mutations broadcast a
  `volli:data-changed` IPC event (entity-scoped payload); renderer stores
  apply it. The board updates live as agents work it.
- Prefix-uniqueness validation in project create/update (shared validator in
  `@volli/shared`), surfaced in the project UI with a readable message.
- PTY spawn env gains `VOLLI_SESSION`, `VOLLI_SOCKET`, and the PATH prepend
  (`volli-dir.ts` env helpers extend the CONCEPT #33 contract).
- `src/main/harness-install.ts`: the install-plan executor (writes, symlinks,
  fenced-section merges, hash records) + first-launch consent wiring +
  uninstall.

### `packages/shared`

- `agent-surface.ts`: socket request/response types, error-code vocabulary,
  column tokens, context-resolution rules (pure, tested).
- `harness/`: the adapter core (decision 13) — `HarnessAdapter` descriptors,
  install-plan types, fenced-section functions, skill-content assembly;
  per-harness modules (`claude-code.ts`, `codex.ts`, `opencode.ts`,
  `generic.ts`). `harness-command.ts` folds in.
- Skill markdown sources live with the adapter core and are bundled into the
  app as resources.

### Tests (acceptance criteria)

- Shared unit: resolution ladder; **collision battery** (similar project
  names, duplicate prefixes, prefix-vs-name confusion — the readable-error
  guarantees); `--edit` match semantics; fenced-section merge (present /
  absent / user-content preservation / byte-identical skip); install-plan
  generation per harness; hash-guard decisions.
- Main integration: socket round-trip against a temp DB (create → move →
  comment → board), actor attribution + event transactionality, degraded-DB
  error path, socket permissions.
- e2e (Playwright `_electron`, per the live-smoke recipe): app boots socket;
  real CLI against the running app; PATH + env injection inside a spawned
  PTY; installer idempotency against a fake `$HOME`; first-launch consent
  flow; renderer board reflects a socket-driven move.

## Future work (recorded, not in this PR)

- **The loop** (next milestone): adapters generate hook configs calling
  `session done|blocked`; auto-moves + attention-aware notifications wire up;
  the reason badge lands.
- **Automations as skills**: user customization of the skill pack (`custom/`)
  is the intended automation-authoring surface — column-transition behavior
  expressed in an industry-standard format instead of a bespoke builder UI. A
  `volli-automations` spoke joins the pack when this lands; the CLI is the
  execution vehicle.
- **Worktree integration**: location ratified 2026-07-18 —
  `<userData>/worktrees/<project-id>/<TICKET-ID>-<slug>/` (T3 Code, Vibe
  Kanban, and Codex Desktop all place worktrees outside the repo; in-repo
  `.volli/worktrees/` risks electron-builder glob sweep, the git
  embedded-repo footgun, and scanner noise — Claude Code is the lone in-repo
  outlier and documents the costs). One caveat travels with the ratification:
  an app-data worktree is invisible to origin until pushed, so in a
  multi-device life, unpushed ticket branches are stranded on one machine.
  The worktree milestone must make unpushed work *visible* (card indicator,
  akin to the behind-base indicator) and make early branch push cheap or
  automatic; the full multi-device answer is Personal Cloud's (roadmap
  phase 3), but no ticket's work may silently live only in one device's
  `userData`. Adopt `.worktreeinclude` (the
  Claude Code/Codex-converged convention) for copying gitignored files,
  refining CONCEPT #15's copy-globs; per-project setup command runs with
  `VOLLI_PROJECT_ROOT`/`VOLLI_WORKTREE_PATH` injected (T3 Code's pattern).
  Worktree ops stay host-owned; agents self-locate via `volli identify`. No
  `volli worktree create/remove` unless a real need appears.
- **Session summarization → comments**: harness-assisted session summaries
  posted into ticket comment history, so orchestrators read summaries instead
  of raw output. Needs per-harness finagling; `session peek --turns <n>`
  (transcript-parsed) arrives with the deep adapters.
- **App settings surface** over the CLI: revisit when settings exist.
