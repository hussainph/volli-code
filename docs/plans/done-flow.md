# Done Flow — Diff Visibility, Commit Safety Net, Push + Draft PR

**Status**: settled (battle-test review July 2026) · **Branch**: `feat/done-flow` · **Issue**: [#75](https://github.com/hussainph/volli-code/issues/75) · **Decisions**: CONCEPT #44 (amending the #75 sketch; upholding #14, #38, #42)

Implements decision #14's safety net as **visibility + manual affordances in the ticket Details rail — a button, never a gate**. The Done-entry adaptive dialog sketched in issue #75 is consciously deferred: every researched tool (Vibe Kanban, Conductor, Codex, T3 Code, cmux) ships PR creation as an explicit user action, none intercepts a board gesture with a git modal, and #38 already made column moves pure data. If usage shows Done entries arriving dirty in practice, the prompt returns as a *user-configurable* automation in #79's vocabulary.

## Settled calls (battle-test Q&A, July 2026)

1. **No move interception.** `useBoardStore.moveTicket` is untouched. CLI moves to Done land as pure data (accepted bypass); the rail affordances serve both paths.
2. **Divergence: hard blockers only.** In-progress sequencer state blocks the one-click commit; a rejected (non-fast-forward) push surfaces typed. "Base moved ahead N commits" is info, never a blocker — GitHub merges diverged-base PRs natively.
3. **Fetch policy**: kickoff stays offline (#40 stands); the push flow — already a network moment — runs one targeted `git fetch origin <base>` first, best-effort. Failure degrades to stale-local info, never blocks.
4. **PR shape**: `gh pr create --draft`, title `<DISPLAY-ID>: <ticket title>`, body = ticket doc markdown + a footer line naming the Volli ticket. No session-summary composition (no structured concept exists yet).
5. **PR URL is durable truth**: `tickets.pr_url` column (migration; the foundation #76's merge-watch and #16's Archive need) + a `pr_opened` event for History.
6. **Commit convention**: one-click commit writes `chore(<DISPLAY-ID>): commit remaining work` — fixed, greppable, honest about its origin. The explicit exception to "the app never commits" (#14).
7. **Dirty predicate split**: `isWorktreeDirty` stays the *removal-safety* predicate (unpushed commits = dirty). The rail uses a finer query — `uncommitted` / `sequencerActive` / `aheadOfBase` / `behindBase` — so a fully-committed branch is never told to "commit remaining changes."
8. **Async execution for network verbs.** `RunGit` (`execFileSync`) never carries push/`gh` — a synchronous network call would freeze the main process. New injectable async runner seam (the `promisify(execFile)` pattern of `park.ts`/`agent-tools.ts`), same args-array/no-shell discipline, owned by `src/main/worktree/` (#42).

## Module contracts (`apps/desktop/src/main/worktree/`)

- `status.ts` — `getWorktreeStatus(git, { worktreePath, branch, baseBranch }) → { uncommitted: boolean; sequencerActive: boolean; aheadOfBase: number | null; behindBase: number | null }` (counts via `git rev-list --left-right --count`; nulls when base unknown).
- `diff.ts` — `diffStat(git, input, mode)` with two modes (Codex's split): `"working-tree"` (uncommitted vs HEAD, tracked **+ untracked** — `git diff --numstat` misses untracked; list them via `status --porcelain`) and `"merge-base"` (`git diff --numstat <base>...HEAD`). Returns the shared `DiffStat` shape.
- `commit.ts` — `commitRemaining(...)`: refuses when `sequencerActive`; `git add -A` + fixed-message commit; hook failures surface real stderr.
- `net.ts` — async runner seam + `fetchBase` (best-effort), `pushBranch` (`git push -u origin <branch>`, typed rejection), `ghCreateDraftPr` / `ghFindPr` with the typed failure taxonomy `not-installed | not-authenticated | no-remote | pr-exists | network | unknown` (Vibe Kanban's error-taxonomy model). Re-entry: an existing PR is detected and its URL returned, never an error dialog.

## Persistence, IPC, events

- Migration: `tickets.pr_url TEXT` (nullable); `Ticket.prUrl`.
- Events: `worktree_committed { message }`, `pr_opened { url }`; `WorktreeFailureStage` union extended with `commit | push | pr`.
- IPC: `volli:worktree-status`, `volli:worktree-diff`, `volli:worktree-commit`, `volli:worktree-push-pr` — each with a hand-written input guard (the `data-ipc.ts` pattern), preload methods under `api.worktree.*`. `push-pr` composes in main: fetch (best-effort) → push → find-existing-else-create-draft → persist `pr_url` + `pr_opened` + broadcast. Failures record `worktree_failed` with the new stages; renderer surfaces via `writeThrough`/`toastError` — never silent.

## UI (Details rail, worktree section of `ticket-properties.tsx`)

Lazy-loaded on drawer open (the `BaseBranchField` precedent), refreshed after every action:

- **Diff stat**: merge-base summary (files, +N −M) = "what would the PR contain"; a working-tree dirty line = "what the agent is doing right now"; ahead/behind info line.
- **Buttons** (conditional, filled-Phosphor per convention): dirty → **Commit remaining changes**; ahead with no `prUrl` → **Push & create draft PR**; `prUrl` set → **Open PR**.

## Testing

- Unit (injected `RunGit` / async-runner fakes, `scripted-git.ts` pattern): status query, both diff modes incl. untracked + binary files, commit refusal on sequencer state, push-rejection typing, each `gh` failure kind, PR-exists re-entry.
- E2E: `apps/desktop/e2e/done-flow-smoke.mjs` (own file, per recipe): temp repo + **local bare repo as `origin`** + **fake `gh` shim on PATH** (records argv, prints a canned PR URL) → boot ticket session → dirty the tree → rail commit → assert commit message/content → push + PR → assert bare-remote branch, `--draft` in shim log, `pr_url` in DB, `worktree_committed`/`pr_opened` events.

## Deferred

Done-entry prompt (→ #79, as a configurable automation) · full diff *views* (#75 follow-up if large) · composer/card chips + drift (#81) · merge-watch retention (#76).
