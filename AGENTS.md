# Volli

A macOS app for planning and running coding sessions: Electron, React, TypeScript. A task board, isolated ticket worktrees, durable local history, Pi-backed structured chat, and embedded terminal harnesses. Structured execution uses one Agent Runtime; TUI harnesses are manual terminal companions, never structured execution surfaces.

Volli is moving to **Volli Cloud** (behind the `cloud` experimental flag): accounts, shared Workspaces, board and Session history in a Convex backend, agents on **Runners**. Today the code still runs on local SQLite and the host process. Rules are written as **target + transition**: what new code must do now, and what stays true until migration.

`CONTEXT.md` is the domain glossary; `docs/DESIGN.md` is the visual language. Code and tests are authoritative for current behavior; never infer it from a contract or glossary entry alone.

Reference, read when the task touches it: [repo map](docs/development/repo-map.md) · [detailed conventions](docs/development/conventions.md) · [CI lanes](docs/development/ci.md) · [smoke tests](docs/development/smoke-tests.md) · [session environment](docs/development/session-environment.md) · [boundaries](docs/BOUNDARIES.md) · [Linux host](docs/development/host-linux.md).

## Structure

Full descriptions: `docs/development/repo-map.md`.

- `apps/desktop/src/main/` — Electron main host. **The only place Electron APIs run.**
- `apps/desktop/src/preload/` — typed `contextBridge` API; the only door between renderer and main.
- `apps/desktop/src/renderer/` — React UI + Zustand stores. **No Node imports.** `renderer/lab/` is the UI lab (`pnpm lab`): UI state and flows only, never backend behavior; imports the app, never the reverse.
- `packages/shared/` — pure, unit-tested domain code and the Agent Runtime port. **No Electron/Node/DOM imports.**
- `packages/session-engine/` — Session commands, durable projections, runtime-observation translation. **No transport/Node APIs.**
- `packages/session-rpc/` — thin tRPC Session edge.
- `packages/host-core/` — the host's services without Electron (`createHostCore`): SQLite, worktrees, Session runtime wiring, MCP, Code Mode, Automations, agent socket, pty supervisor, browser, maintenance. **No Electron imports.**
- `packages/agent-runtime/` — the executor boundary, Pi implementation, guards, prompt assembly, model access, web tools.
- `packages/cli/` — the agent-facing `volli` CLI.
- `convex/` — the Volli Cloud backend. **Never runs the agent loop. No Electron imports.** Every public function requires an identity. See its `README.md`.
- `apps/runner/` — `volli-runner`, the outbound runner; successor to `apps/hostd`. **No Electron.**
- `apps/gateway/` — the Model gateway Worker. **No Electron imports.**
- `packages/font-notices/` — font licence notices for the websites. Pure; **no Electron/Node/DOM imports.**
- **Superseded, fixes only:** `packages/host-protocol/`, `packages/host-install/`, `apps/hostd/`. Build nothing new on them.

## Conventions

Sessions and history:

- A Session is durable and owns identity and ordered history before any executor attaches. Processes, terminal panes and views never own Session lifetime.
- Commands are explicit user intent: persist intent before delivery; acceptance is idempotent and observable through durable receipts.
- Events are immutable facts. Durable history is canonical (today the SQLite ledger; under Cloud the backend's accepted ledger, which assigns final order).
- **Session Events are exhaustive on write, tolerant on read.** A new kind must fail to compile until every writer handles it; reading history drops only an unrecognised `kind`. A malformed field inside a known kind is corruption and fails loudly.
- **A durable id derivation is frozen the moment it ships.** `session_events.id`, Attention ids and the transcript artifact digest are re-derived and deduped by exact string, so changing one duplicates history silently. Keep the old string and comment that it is durable.
- A Session starts with one root Agent Thread; each Thread has at most one live Thread Binding. Branches and Generation Attempts preserve edits without rewriting history.
- Resume, terminal recreation, and history navigation are distinct semantics.
- Retry transient transport failures without duplicating accepted work. Auth, permission, configuration and quota failures require explicit user recovery.
- Hooks and terminal markers are compatibility evidence for TUI adapters, not Session truth.

Runtime:

- **Pi is the only agent loop** (`@volli/agent-runtime`). No SDK/ACP adapters, capability-parity work or provider-shaped product semantics. The executor slot can hold more runtimes, but registering a second one, or letting anyone choose one, is its own owner-approved ticket. No profiles; no caller picks a runtime. Terminals are manual companions, never silent structured fallbacks. Detail: `conventions.md`.
- **Electron main is a host, not the product API.** New domain surfaces take command/projection shape with IPC as dumb transport (`docs/BOUNDARIES.md`).

Data and UI:

- **Store rule.** Today domain data lives in SQLite behind `@volli/host-core`; renderer stores hydrate at boot and write through semantic preload commands. No renderer-side persistence, no localStorage. Target: Convex for board, Session and planning state as each area is ported. Never add board or Session tables to SQLite for cloud work; new local tables hold machine state only. Detail: `conventions.md`.
- Ticket rules and all auto-move logic: pure, tested TS in `@volli/shared`; the UI only observes.
- Terminal access goes through the `TerminalEngine` seam: node-pty stays in the host, xterm.js in the renderer, and the user's Ghostty config is the appearance source. Run `pnpm -C apps/desktop run rebuild:native` after every install.
- Live terminals must never be unmounted incidentally (e.g. selecting a card).
- **Ship no third-party terminal themes**, not even excerpts. Themes come from the user's machine; the fallback palette derives from design tokens (`renderer/src/terminal/appearance.ts`). CI enforces it (`check-vendored-themes.mjs`).
- **UI work loads `.agents/skills/volli-design/SKILL.md`** before feature design, implementation or visual review; `docs/DESIGN.md` is the Volli Glass spec.
- **UI copy: let controls talk.** No `description` on `SettingsSection`/`SettingsRow`, no tutorial tooltips or explanatory paragraphs unless asked. Labels are nouns. Exceptions: irreversible confirms, one-line trust boundaries, blocked states with one recovery action. Module comments carry architecture; UI strings don't repeat them.
- **Color tokens are generated, not authored**, from a stored canvas and appearance. Regenerate `globals.css` with `node apps/desktop/scripts/generate-theme-css.mjs`; never hand-tune it. New color tokens go in `THEME_TOKEN_NAMES`/`CANVAS_TOKEN_NAMES`. Never persist resolved tokens. Every surface must hold up across canvases in light and dark. Detail: `conventions.md`.
- Spacing, width and type follow `docs/DESIGN.md`: no arbitrary `text-[Npx]`.
- Every context-menu action carries an icon from the shared set via the shared primitive.
- **Icons use the shared semantic seam** (`components/ui/icon.tsx`), backed only by Hugeicons free Stroke Rounded (MIT). Outline stroke is 1.5; ≤12px and deliberate heavier symbols use 2.25. Mark active/error exceptions with accent/destructive ink or selected backgrounds, never fake fill. No direct vendor imports outside the seam; never Pro, bulk, solid or `duotone`. Detail: `conventions.md`.
- **Surface every failed mutation; never swallow errors.** The one exception is background work no one asked for (e.g. auto-titling), which logs and keeps its fallback. Errors are for failed operations, not for user choices we disagree with. Fault surfaces show the problem and one fixing action, and keep diagnostics in the support report.
- **The shipped licence notice is generated.** Regenerate `apps/desktop/THIRD-PARTY-NOTICES` with `node scripts/generate-third-party-notices.mjs` after any production dependency change; CI's `check:notices` fails on drift. Detail: `conventions.md`.

Workflow:

- Ticket branches: `volli/<DISPLAY-ID>-<slug>`. Changes go through branch + commit + PR; never commit directly to `main`.
- Strict TypeScript; no `any` at module boundaries.
- **Resolve clear in-scope issues**: stale docs, unsupported claims, TODOs your change answers. Ask only when ambiguity changes the work or an action is destructive, outward-facing, or needs authorization.

## Commands

- `pnpm dev` — full dev loop. `pnpm run build` then `pnpm start` runs the built app. `pnpm lab` — UI lab on :5174.
- `vp check` (= `vp fmt` + `vp lint`) · `pnpm typecheck` · `pnpm test`. `vp` is the Vite+ toolchain CLI.
- `vp run -r test:coverage` is a separate 100% gate on protected surfaces; CI runs it, agents do not.
- `pnpm install` for deps; `pnpm run ensure:electron` (`apps/desktop`) prefetches Electron.
- Search with `rg`, not `grep -r` or `find` (it honours `.gitignore`). Without `rg`, use `git grep -n`.

## CI is the gate

CI owns the full suite, coverage thresholds and smoke lanes; `CI gate` sums every required check. Which lane runs what: `docs/development/ci.md`. Core e2e is `board`, `composer-basics`, `terminal`, `worktree`, `agent-cli-roundtrip`, `database-recovery`, and `canvas-theming` (`-smoke.mjs` filenames); the CLI journey includes raw socket checks and the composer journey includes Session RPC checks. This machine runs many Sessions at once, so local runs stay small:

- **Before pushing:** `vp check`, typecheck each touched package (`vp run --filter <package> typecheck`; `vp exec tsc --noEmit -p tsconfig.json` for root), and only the test files you touched or that directly cover your change (`vp test run path/to/file.test.ts` from that package). For a file on a protected coverage list: `vp test run <its test> --coverage --coverage.include=<the file>`.
- **Renderer pre-push gates:** also run `vp run --filter @volli/desktop check:design-tokens` and `vp run --filter @volli/desktop check:glass-design`; `vp check` does not run these source guards. When changing CSS tokens, run `vp run --filter @volli/desktop check:theme-css` too.
- **Never run locally** a full suite (`pnpm test`, `vp run -r test`), full coverage, or the smoke matrix (`run-smokes.mjs`) unless the ticket is about them.
- **Push once**, when the work is done. Every push restarts CI.
- **Watch CI without `sleep` loops**: one blocking `gh pr checks <pr> --watch --fail-fast`. On red, read only the failing log (`gh run view <run-id> --log-failed`), fix that, push once.
- **Hand off at PR-open**: move the ticket to review and name the PR. If CI goes red later, fix it on the same branch.
- **Merge only on request and on green**: `gh pr merge <pr> --merge --match-head-commit <sha>`. Never `--auto`.
- **Red main**: the same step failing on two unrelated PRs is a `main` breakage. Say so in the ticket; don't fix it in your diff.
- **Extended at release**: release runs `ci-extended.yml` on the exact shipped commit and requires success before tagging, signing or publishing, unless `require_green=false` is explicitly chosen. A red extended run at release blocks the release: ticket it and fix it on its own branch, don't re-run until green. Extended does not run on main pushes or nightly; path-filtered lane-definition PRs and manual dispatch remain. Dispatching a risky branch (`gh workflow run ci-extended.yml --ref <branch>`) is an exception, not a routine pre-merge requirement. New `*-smoke.mjs` files join the extended lane automatically.
- Smoke retries, quarantine and consolidation follow `docs/development/smoke-tests.md`. Never delete smoke coverage without maintainer approval.

## Session environment

Every session starts with Volli's bin dir on `PATH`, then the login shell's `PATH`. Run `volli identify` first rather than probing for tools: its `env` block reports where each tool resolves, which ones this project requires (`env.requiredTools`), whether dependencies are installed (run `pnpm install` if not; a structured Session's first Turn Reminder says so too), and the two `PATH` passes (`env.provenance`, `env.interactiveProvenance`: `adopted` / `already-complete` / `probe-failed`, or `pending`). A tool reported `-` that isn't in `env.requiredTools` is one the project never runs, not a fault. A tool installed but missing is an adoption failure: run `volli doctor --fix` (affects new Sessions only), and report it if it stays missing rather than using absolute paths.

`VOLLI_CONCURRENCY_HINT` is this Session's job budget. Volli writes it into the variables common toolchains read (`MAKEFLAGS`, `CARGO_BUILD_JOBS`, `VITEST_MAX_WORKERS`, …) and never overwrites one your shell exported. Pass it by hand to tools that read none (`--maxWorkers=$VOLLI_CONCURRENCY_HINT`). A budget only ever lowers a project's own cap, never raises it. Full contract: `docs/development/session-environment.md`.

## Foundations

- **Data**: today SQLite (main-process-owned) plus transcripts on disk. Target: Convex for live state, R2 for bulk history, SQLite for runner-local state.
- **Terminal companions**: keep the manifest registry, exact-hash trust, wrappers, hooks, CLI correlation and honest resume where they help manual terminal use. No generic structured-adapter machinery beyond the executor slot.
- **Execution**: one Working copy per ticket per machine, shared by that machine's Sessions.
- **Git belongs to the user.** Volli never auto-commits or pushes. Agents push only when asked or when the project's ship behaviour says so. A Session on another runner starts from what is pushed.
- **Board**: Backlog · Todo · Doing · Needs Review · Done. Explicit moves win; automation only de-escalates and never destroys data. Archive worktrees instead of deleting them.

## Volli Cloud

Target: no host process. Convex is the single authority for Workspaces, Members, projects, board, Session ledger, attention and config; the agent loop runs on the runner.

- **Flag-off is unchanged.** Cloud work stays behind `cloud`; the local product keeps working without sign-in and receives bug fixes only until it moves to an embedded backend. Local mode is permanent.
- **Rules live once**: in `convex/`, or in the pure `decide…` functions shared from `@volli/shared/cloud` (clients may run them optimistically; the backend wins). Unported areas keep their rules in `@volli/shared`/host-core, never a second copy in the renderer or runner.
- **The agent loop runs where the tools run**: Pi on the runner, never in Convex functions or actions.
- **Each durable fact is its own mutation** through the runner's ordered Retry buffer: crash-safe, idempotent by `commandId`, never awaited by the agent. Streamed text goes in short chunks; terminals and screencasts use a separate relay, never database documents. Measure before optimizing.
- **No `electron` imports** in runner code or any package the runner composes.
- **Ids stay ours**: UUIDs, event format and object-storage keys are independent of Convex `_id`s.
- **Credentials follow the caller, never borrowed.** API and Workspace keys stay in the Model gateway; runners get short-lived Runner tokens; subscriptions never leave the person's machine; agents hold no backend credential (`docs/BOUNDARIES.md`).
- **Don't extend superseded surfaces**: host protocol, host identity/enrollment, SSH host install, checkout leases/epochs, checkpoint refs, hostd operator surfaces.
- **Vocabulary**: Workspace, Member, Runner, Volli Cloud runner, Place, Working copy (`CONTEXT.md`).

## Compatibility and public contributions

- **Frozen Sessions stay frozen.** A Session's birth tool surface, Code Mode declaration and system prompt never change within a warm-cache epoch; additions are recorded facts that land at a cold turn, compaction or model switch. Never rename or remove existing names; credentials never enter the durable shape. Detail: `conventions.md`.
- **N−1 compatibility is required.** Previous release, latest canary and base builds must open the data and attach and replay Sessions. Degrade gracefully and visibly; never silently lose a tool, card or frame. Add real-codec compatibility tests when writing data older builds read, and assert behavior, not an old build's exact decoded shape.
- **Migrations are expand-only and N−1-safe.** Compatibility floor: 58. Take the next number from the registry; no migration without a data requirement; expand → switch → contract, testing older readers before contracting.
- **Public protocol changes are additive only.** Run `pnpm check:protocol-schema --base origin/main`; regenerate schemas with the generator, never by hand, and declare every new output enum's openness. Bridges and catalog operations share one handler and policy boundary; promote a bridge into the public catalog before a second Client uses it.
- **Experimental flags preserve flag-off behavior.** With `cloud` off, expose no cloud product surfaces. Detail: `conventions.md`.
- **Every new export has a production caller.** Tests and lab simulations don't count. Name the production call path, or record the exact wiring a receiving task owes, before depending on an unwired seam. Label lab simulations **Simulated wiring**.
- **Test process and wire boundaries through the real codec or transport**, not an instantly completing fake.
- **This repository is public.** Don't commit internal plans, research, PR screenshots, strategy or business material. PR descriptions and comments describe behavior, not internal history. Attach visual evidence to the PR instead of committing it. CI rejects `docs/plans/` and `docs/research/`.
- `CLAUDE.md` is a symlink to this file; edit `AGENTS.md`. Tool-specific local permissions don't belong here.
