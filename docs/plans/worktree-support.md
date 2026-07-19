# Git Worktree Support — Creation Core

**Status**: settled (design review July 2026) · **Branch**: `feat/git-worktree-support` · **Decisions**: CONCEPT #38–#43 (amending #7, #13, #15, #18, #20)

A ticket *is* a terminal workspace; this plan makes that literally true. It ships the creation core of worktree-per-ticket (decision #4): the first session booted in a worktree-enabled ticket gets an isolated checkout, prepared and oriented, before its harness command runs. Everything downstream of creation — Done flow, retention, attachments, interrupts, automation — is consciously deferred to tracked issues (see the ledger at the bottom).

Research grounding: T3 Code, cmux, Vibe Kanban, Codex CLI (source-level), Claude Code / Conductor / Sculptor (docs). The sharpest borrowed lessons are cited inline.

## 1. The one-sentence model

Column moves are pure data; **session boot is the only thing that materializes execution state** (#38). `ensureTicketWorktree(ticketId)` is idempotent and single-flight; its callers today: ticket session creation (kickoff and `+`). Future automations (issue #79) may add callers; the seam does not change.

## 2. Module ownership (#42)

All of this lives in **one module**: `apps/desktop/src/main/worktree/`. It is the only place in the app that executes worktree git commands. Public interface, consumed by `pty.ts`, `data-ipc.ts`, and future callers:

- `ensure(ticketId) → WorktreeIdentity` — the pipeline in §3. Single-flight per ticket (in-flight call is joined, never duplicated).
- `remove(ticketId, opts)` — manual escape hatch; never force-removes dirty without the caller having confirmed.
- `getState(ticketId) → { identity, phase, disk }` — the *single composed answer*: persisted identity (DB) + transient phase + live disk check. Nobody joins DB + event log + stores by hand.
- `listBranches(projectId)` — backs the Details-rail base-branch picker.
- `sweepOrphans()` — §7, called once at startup.

Git execution: `execFileSync("git", args, { cwd })` behind an injectable `RunGit` seam (the established `project-base-branch.ts` pattern) — args as arrays, no shell, fully unit-testable. **Raw git CLI only, never libgit2/native bindings** (#40; Vibe Kanban observed libgit2 clobbering protections git refuses to skip, plus repo corruption).

Transient phase (`creating → copying → setting-up → ready | failed`) lives in an in-memory registry here, broadcast to the renderer over one IPC event channel, mirrored in a keyed store map (the `starting[ticketId]` pattern). **Never persisted** — on boot, truth is recomputed from disk.

## 3. The ensure pipeline

Triggered by ticket session creation, before the PTY spawns:

1. **Resolve identity** — branch `ticketBranchName(displayId, title)` (existing tested module); path `~/.volli/worktrees/<project-dirname>-<short-id>/<DISPLAY-ID>-<slug>/` (#40). Both stamped once; never renamed on title edits.
2. **Reconcile** (§4) — proactive collision matrix on `realpath`-canonicalized paths.
3. **Resolve base** (§5) and run `git worktree add` (`-b` for a new branch; without `-b` to reuse an existing ticket branch, never reset).
4. **Copy step** (§6) — `.worktreeinclude` + built-in defaults.
5. **Persist** — `updateTicketFieldsCommand` writes `worktree_path`/`branch`/`base_branch` (existing plumbing; emits the `worktree_changed` event). DB writes happen *outside* any long-running work — git runs first, the synchronous transaction records the result.
6. PTY spawns with `cwd` = worktree; **setup command** (§6) runs sentinel-gated; harness command follows on exit 0.

Failure at any stage: phase → `failed`, `toastError` with real stderr, a **`worktree_failed`** ticket event (`stage: create | copy | setup`, trimmed stderr), and the session **does not launch in the main checkout** — the worktree toggle is the only sanctioned path to the shared checkout (#38). Retry lives in the Details rail.

## 4. Reconciliation matrix (#40)

Checked before any `git worktree add`, canonicalized paths throughout:

| DB says | Disk says | Action |
|---|---|---|
| no worktree | target dir exists, unregistered | Friendly error + offered repair: prune, remove **only if git confirms an orphaned worktree** — never blind `rm -rf` |
| worktree at path | dir missing | Recreate at same path/branch; `worktree_changed` event |
| worktree at path | dir exists, git metadata stale | `git worktree prune` + re-register, retry once (Vibe Kanban) |
| — | branch checked out in main repo / another worktree | Hard fail, friendly message, no `--force` (T3's proactive check) |

## 5. Base resolution — deterministic, offline (#40)

`ticket.baseBranch` → `project.base_branch` → `detectProjectBaseBranch()`. Resolved from **local refs** (remote-tracking ref as fallback if no local branch); result stamped into `ticket.baseBranch` so the record is permanent. **No implicit `git fetch`, ever** — kickoff never waits on the network; a stale local base is the honest local-first semantic. (Fetch-first returns with the PR-review exploration, issue #82.)

## 6. Worktree prep (#41, amends #15)

**Copy step** — three layers:
1. Repo-root **`.worktreeinclude`** (gitignore syntax) — the de-facto standard Conductor and Claude Code independently converged on; one file drives all three tools.
2. **Built-in defaults**, applied even with no file: `.env*`, harness local settings (`.claude/settings.local.json`).
3. `!` negation in the file suppresses defaults.

Guards: every resolved path canonicalized and required inside the project root (tested against `../secret.txt`-style escapes — Vibe Kanban's guard); existing worktree files never overwritten; symlinks copied as files, never followed outside the root.

**Setup command** — per-project DB setting (`projects.setup_command`, migration 008). Typed into the session terminal (cmux #5032: never the pane's primary process) wrapped with a sentinel:

```
<setup command>; printf '\n__VOLLI_SETUP_DONE:%d__\n' $?
```

Main watches the existing PTY output tail for the sentinel. Exit 0 → harness command is written. Non-zero → stop: the terminal stays a live shell in the worktree with the failure visible, phase → `failed`, toast + event. No sentinel yet ≠ error (installs are slow; prompts happen) — phase stays `setting-up` until sentinel or user action. No setup configured → skip the phase. Visible + interactive + exit-code-aware + pane-safe, simultaneously — the combination neither T3 (untracked) nor Vibe Kanban (invisible) has.

**cwd = worktree.** Modern harnesses resolve linked worktrees through the shared `.git` for trust/settings; the copy defaults close the gitignored-local-config gap. No per-harness "work over there" flags.

**Orientation preamble** — the composed brief opens with, and the skill pack restates:

> You are working in an isolated git worktree at `<path>` on branch `<branch>` (branched from `<base>`). All work happens in the current directory. The main checkout at `<project path>` is reference-only — never modify it.

Agents must never "reorient" out of their worktree; the preamble makes the situation explicit rather than inferred.

## 7. Startup orphan sweep (#43)

Disk (`~/.volli/worktrees`) vs DB, canonicalized (including macOS `/private` aliasing — Vibe Kanban's footgun). Three tiers:

1. **Metadata**: `git worktree prune` per project — always safe.
2. **Clean orphans** (no DB row; empty `git status`; no commits unreachable from base/upstream): dir auto-removed, **branch retained**. A clean worktree dir is cache, not data — #16's no-destruction law holds.
3. **Dirty orphans**: never auto-removed. One toast; listed in Settings → Worktrees with explicit Reveal / Delete.

Dirty detection errs dirty: untracked files, sequencer state (merge/rebase/cherry-pick/bisect), unreachable commits, `git worktree lock` (respected absolutely), submodule drift, **any git failure or ambiguity**. Removal re-verifies cleanliness immediately before deleting. Startup-only in this PR; the periodic TTL sweep (issue #76) reuses these tiers.

## 8. Persistence, IPC, env

- **Migration 008**: `projects.setup_command TEXT` (nullable). **No new ticket columns** — identity columns shipped in 003; state is computed (#42).
- **Events**: `worktree_changed` (existing) + new `worktree_failed { stage, stderr }` in the `TicketEventPayload` union.
- **Preload**: new `api.worktree.*` (`ensure` is implicit via session create; `remove`, `getState`, `listBranches`) + phase-change event subscription; runtime-validated at the IPC boundary like every other channel.
- **CLI**: no new commands (decision #34 — the CLI never manages worktrees; observability is issue #80). Verify `ticket.show`/`ticket.brief` expose identity fields.
- **Env**: add `VOLLI_PROJECT_DIR` (main checkout absolute path) to ticket session env. Invariant restated: `VOLLI_ARTIFACTS_DIR` stays **main-repo-keyed** always (decision #33); worktree cwd never leaks into artifacts resolution.

## 9. UI deliverables

1. **Settings → per-project Worktrees section** (first real settings content beside base branch): setup-command field (DB-backed, `base_branch` precedent), effective copy-set display (defaults + file), create/edit `.worktreeinclude` affordance, dirty-orphan list (§7). Discoverability is the point: defaults just work; the file is there for power users.
2. **Session phase visibility**: pre-PTY work reuses the `starting[ticketId]` disabled-affordance; a `setup` state joins the session status chip vocabulary while the sentinel is pending. The terminal itself is the progress detail (#15's visibility).
3. **Ticket context menu: "Remove worktree…"** — `ConfirmCloseDialog` pattern; blocked with live sessions; the dialog states dirtiness explicitly (T3's silent force-removal is the anti-pattern). Filled Phosphor icon.
4. **Details rail**: `baseBranch` upgrades from free text to a **branch picker** (`listBranches`); a `failed` phase shows an inline notice + **Retry**.
5. Failure surfacing throughout via `writeThrough`/`toastError` + History events — never silent.

Deferred UI: composer base-branch chip, card branch/diff chips, drift indicator (issue #81); diff surfaces (issue #75).

## 10. Testing

- **Unit (main, `RunGit` injected)**: reconciliation matrix, base resolution chain, `.worktreeinclude` parsing + traversal guard, sentinel parser, dirty-detection rules (each rule, plus ambiguity→dirty), path canonicalization (incl. `/private` alias).
- **Unit (shared)**: `ticket-branch.ts` already covered; event payload type guards.
- **E2E**: one new smoke in its own file (`worktree-smoke.mjs`, per the established recipe): real temp git repo as project → kickoff ticket session → assert worktree on disk + branch + copy step + setup sentinel gating + `worktree_changed`/`worktree_failed` events; failure path asserts no main-checkout launch.
- CI: workflows now skip draft PRs entirely (`ready_for_review` in trigger types + draft gate on every job); this PR stays draft until review-ready.

## 11. Deferred-work ledger

| Deferred | Issue |
|---|---|
| Done flow: dirty gate, diff stat, commit-remaining, push + PR (#14) | [#75](https://github.com/hussainph/volli-code/issues/75) |
| Retention: PR-merge watch, Done-TTL sweep, archive branch/PR links (#16) | [#76](https://github.com/hussainph/volli-code/issues/76) |
| Attachment materialization (#19) | [#77](https://github.com/hussainph/volli-code/issues/77) |
| Backward-move interrupt + resume-on-re-entry (#20/#21) | [#78](https://github.com/hussainph/volli-code/issues/78) |
| Column automations system (user-configurable; revives #13) | [#79](https://github.com/hussainph/volli-code/issues/79) |
| CLI read-only worktree observability | [#80](https://github.com/hussainph/volli-code/issues/80) |
| Worktree UI polish (composer chip, card chips, drift) | [#81](https://github.com/hussainph/volli-code/issues/81) |
| Exploration: in-app PR review system | [#82](https://github.com/hussainph/volli-code/issues/82) |
