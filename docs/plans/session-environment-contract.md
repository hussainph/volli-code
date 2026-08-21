# The session environment contract

VC-94. What every Volli session gets on `PATH`, identically, and how an agent
discovers it without probing failures.

> **The contract itself now lives in [`AGENTS.md`](../../AGENTS.md) → "Session
> environment", which is what agents read.** This document is the investigation
> record behind it and the roadmap of what has not been built yet.
>
> **The four P0s landed 2026-08-20.** `0d8812d2` A1 (filter malformed `PATH`
> entries), `bdd52746` B1 (`volli identify` env block), `028c3719` B2 (doctor
> audits contract tools), `0b9210df` C3 (contract stated in `AGENTS.md` and
> `CLAUDE.md`), `8a76154e` follow-up coverage. Verified: the filter keeps 20 of
> this host's 21 login-`PATH` entries, dropping only `~/.dotnet/tools`, so
> `gh`/`node`/`npm`/`pnpm`/`vp` resolve again from the next app boot. 332 tests
> across the touched suites pass.
>
> **A2 landed 2026-08-21** (`0497a859`): one probe, one parser, the
> interactive/non-interactive split now an argument.
>
> **A3 landed 2026-08-21**: a second adoption pass, interactive, run once after
> the first window. The `.zshrc` gap — the last thing that let a structured
> session and a PTY session disagree — is closed.
>
> **A4 landed:** a live Session smoke now observes that agreement through both
> executors, including the `.zshrc` case.
>
> **B3–C2 landed:** `474f77de` makes Settings compare the Session and login
> `PATH`, `1be80aad` makes probe failures persistent app feedback, `f55777fa`
> runs the same report when a project is selected, and `937faa20` explains the
> known .NET `/etc/paths.d` defect without changing it.
>
> **Four improvements remain open** — marked ○ below. A5 and the two non-`PATH`
> bundle items want coordinating with VC-38, VC-109 and VC-70.

Investigated 2026-08-20 against `ca9fcccd`. Every claim below marked *measured*
was observed on the reporting host during the investigation session itself —
including the headline defect, which reproduced in the very session that was
sent to diagnose it.

## Summary

The environment is not inconsistent because it is undefined. It is inconsistent
because **the app asks the same question two different ways and believes both
answers.** One probe feeds what sessions actually run with; the other feeds
every screen that reports on it. They disagree on this host, and the screens are
the ones that are wrong — which is why the failure presents as "the agent can't
find `gh` even though Settings says it's fine," and why steering an agent to
"double-check" appears to help.

Underneath that sits a single-point-of-failure parsing rule: one malformed entry
anywhere in the user's `PATH` silently discards the entire recovery, and the
outcome is logged as if nothing happened.

## The measured root cause

The investigating session's own `PATH`, printed from inside it:

```
1  /Users/phalasiya/Library/Application Support/Volli Code/bin
2  /usr/bin
3  /bin
4  /usr/sbin
5  /sbin
```

That is exactly `binDir` + `BARE_LAUNCHD_PATH`
(`apps/desktop/src/main/login-shell-path.ts`). Tool visibility that follows from
it, measured:

| tool | resolves in session | actually installed at |
| --- | --- | --- |
| `git` | `/usr/bin/git` | `/opt/homebrew/bin/git` (Xcode CLT shim answered) |
| `gh` | **not found** | `/opt/homebrew/bin/gh` |
| `node` | **not found** | `/opt/homebrew/bin/node` |
| `npm` | **not found** | `/opt/homebrew/bin/npm` |
| `pnpm` | **not found** | `/opt/homebrew/bin/pnpm` |
| `brew` | **not found** | `/opt/homebrew/bin/brew` |

`git` present and `gh` absent is precisely the shape of the fabricated-PR scare
in the ticket: the agent can commit and branch, so it looks operational, but it
cannot open, inspect or merge a PR — and nothing tells it why.

The same root cause explains the third symptom in the brief. This repo's
pre-commit hook (`core.hooksPath` → `.vite-hooks/pre-commit`) runs `vp staged`.
`vp` sits at `~/.vite-plus/bin`, position 19 on the login `PATH` and absent from
the session's — so **every commit from a structured session fails the hook with
command-not-found**, which is the pre-commit failure that hit the release cut.
Three distinct reported incidents, one cause.

Note that `~/.vite-plus/bin` is exported from `.zshenv`, which *all* zsh
invocations read. It is therefore present even in the non-interactive probe.
Its absence from the session is not the `.zshrc` gap of the next section — it is
adoption failing outright.

### The chain, end to end

1. `/etc/paths.d/dotnet-cli-tools` contains the literal text `~/.dotnet/tools` —
   an unexpanded tilde, written there by Microsoft's .NET CLI installer. (The
   file also lacks a trailing newline. Both are upstream installer bugs, present
   on any Mac where the .NET SDK was installed, and not something Volli can
   assume away.)
2. `path_helper`, run from `/etc/zprofile`, appends that entry verbatim, so
   **every login shell on the host** carries a non-absolute `PATH` entry.
3. `parseLoginShellPathOutput` (`login-shell-path.ts`) accepts a `PATH` only if
   `value.split(":").every(e => e.length > 0 && isAbsolute(e))`. One bad entry
   out of 25 fails the predicate, so the whole string is discarded and the
   function returns `null`.
4. `resolveLoginShellPath` → `null`. `decideLoginPathAdoption(current, null)` →
   `{ kind: "kept" }`.
5. `process.env.PATH` in main stays as launchd handed it over: the bare four.
6. `SanitizedEnvExecutionEnv.exec`
   (`packages/agent-runtime/src/pi/execution-env.ts`) carries that `PATH`
   through to every structured session's shell tool, with `binDir` prepended.

Verified by running both parsers against this host's real login-shell output:

```
boot adoption (login-shell-path.ts) accepts : false   ← offending entry: "~/.dotnet/tools"
detection     (login-path.ts)       accepts : true
```

### Why the screens disagree with the sessions

`login-path.ts`'s `parseMarkedPath` rejects only on control characters. It has
no `isAbsolute` rule, so it accepts the same string the boot path threw away.
That module is what feeds harness detection, the Settings → CLI pane
(`cli-status.ts`) and `volli doctor`.

*(A2 deleted `login-path.ts`. Both probes now come out of
`login-shell-path.ts` through one parser, so this particular disagreement can
no longer be expressed.)*

So on this host, right now:

- **Detection, Settings, doctor** measure with `$SHELL -l -i` and a permissive
  parser → they see a rich, healthy `PATH` and report success.
- **Structured sessions** run with a `PATH` that a strict parser refused to
  build → they see four directories.

Nothing reconciles the two, and no check anywhere compares them. The
observability surface is not merely silent about the defect; it actively
contradicts it.

### A second, independent divergence

The two probes also use different shell flags, which is a separate source of
drift that would survive fixing the parser:

- `login-shell-path.ts` (boot adoption → structured sessions) spawns
  `$SHELL -l -c`. Non-interactive, so **zsh never reads `.zshrc`**.
- `login-path.ts` (detection) spawns `$SHELL -l -i -c`, and a PTY session spawns
  `$SHELL -l` onto a tty, which *is* interactive. Both read `.zshrc`.

Measured delta on this host — directories present under `-l -i` and absent under
`-l`:

```
~/.opencode/bin  ~/.fly/bin  ~/.bun/bin  ~/.antigravity/antigravity/bin
~/flutter/bin    /opt/homebrew/opt/ruby/bin
/opt/homebrew/lib/ruby/gems/4.0.0/bin
```

Seven toolchain directories. Anyone who installs via `nvm`, `bun`, `rbenv`,
`pyenv` or `mise` — all of which conventionally initialise in `.zshrc` — is
invisible to structured sessions even when adoption succeeds.

The existing comment in `login-shell-path.ts` acknowledges this gap and accepts
it deliberately, trading completeness for a boot that cannot hang on an
interactive rc prompt. That trade is defensible; what is not defensible is that
the resulting `PATH` is then presented as the environment, with no record that
it is a known-incomplete one.

*(A3 closed this. The boot probe is still non-interactive — that trade was
right and stands — but a second pass asks the interactive question once the
first window exists, merges what it finds, and `volli identify` now reports the
two passes as two fields rather than presenting the first as the whole
environment.)*

### A fourth divergence: the worktree itself

`PATH` is not the only thing that differs between sessions. Measured across the
worktree root for this project, `node_modules/` is **present in some worktrees
and absent in others** — absent in this one.

That is a second, independent way a session arrives unable to work. With no
`node_modules`, the pre-commit hook cannot resolve `vite-plus` and fails on any
commit, including a docs-only one; typecheck and tests cannot run either. The
agent's symptom is again a command failing for reasons it has no way to attribute
— and the natural repair (`pnpm install`) is a multi-minute cost it has no signal
to anticipate.

A session's environment contract therefore has to cover the *workspace* as well
as the shell: whether dependencies are installed, and if not, that the session
is told so up front. This is worth settling alongside VC-38's worktree lifecycle
work rather than separately — provisioning and pruning are the same question
asked at two ends.

## The contract

The acceptance criterion for this ticket is a written contract. Here it is —
stated as what *should* hold, with conformance marked as it stood at
investigation time and as it stands after the P0s.

The live, agent-facing statement of this contract is in `AGENTS.md`; the version
below is kept because the conformance column is the record of what was actually
wrong.

> **Every Volli session, of every kind, on every launch, starts with the same
> `PATH`: Volli's `binDir` first, followed by the union of the login shell's
> exported `PATH` and the host process's own, deduplicated in that order.**
>
> A session is told what that `PATH` is, which tools were found on it, and
> whether the resolution was complete or degraded — before it runs its first
> command.

| Clause | At investigation | After P0s |
| --- | --- | --- |
| `binDir` first | ✅ holds for both session kinds | ✅ |
| Login-shell `PATH` adopted | ❌ silently skipped when any entry is malformed | ✅ A1 |
| Same `PATH` for PTY and structured sessions | ❌ differ by `.zshrc` contents | ✅ A3 + A4 live Session proof |
| Degradation is recorded and surfaced | ❌ logged as `[volli] PATH kept`, indistinguishable from healthy | ✅ B3 shows the path diff; B4 persists probe failure in the app |
| Session can discover it without probing | ❌ `volli identify` carries no env fields | ✅ B1 + C3 |
| Workspace dependencies installed, or session told | ❌ `node_modules` present in some worktrees, absent in others | ◑ B1/C1 report it before work starts; ❌ A5 policy open |

Two further properties the contract should carry, from the rest of the bundle:

> **No session can reach a credential path that is able to prompt a GUI.**
> A session that cannot answer a prompt must never be offered one.
>
> **A session's scratch files land in a session-scoped directory, never in a
> shared checkout.**

## What is wrong, structurally

Six defects, in the order they should be fixed. The first is a live bug; the
rest are the design that let it stay invisible.

**1. All-or-nothing parsing.** `parseLoginShellPathOutput` discards 24 good
entries because of 1 bad one. A `PATH` is a list of independent directories;
there is no reason a bad member should invalidate its neighbours. *Filter the
bad entries and keep the rest.*

**2. Two probes, two parsers, no reconciliation.** *(Fixed by A2.)*
`login-path.ts` and `login-shell-path.ts` were near-duplicates (same marker,
same detached-spawn timeout hazard handling, same parse intent) that disagreed
on both flags and acceptance rules. Neither was authoritative. *One module, one
answer, with the interactive/non-interactive distinction as an explicit
parameter rather than a fork.*

**3. Degradation is unlogged and unstored.** `{ kind: "kept" }` is the correct
outcome for a healthy `pnpm dev` boot *and* the symptom of total adoption
failure, and both print `[volli] PATH kept`. Nothing distinguishes "kept because
the current PATH was already complete" from "kept because the probe returned
nothing." *Make the outcome a three-way — `adopted` / `already-complete` /
`probe-failed` — persist it, and surface the third.*

**4. `doctor` audits Volli, not the environment.** It has zero checks for
`gh`, `node`, `git`, or any tool an agent depends on — grep for them in
`packages/shared/src/doctor.ts` returns nothing. Every check is about Volli's
own shim, wrappers and shell chain. The doctor's own header argues checks must
be about *outcomes*; by its own standard, "can a session run `gh`?" is the
outcome that matters and it is unasked.

**5. Reporting measures a different environment than it describes.**
`cli-status.ts` reports whether `~/.local/bin` is on the *detection* `PATH`. No
screen reports the `PATH` a session actually receives. This is what makes the
failure mode so expensive: the instrument says healthy while the patient is not.

**6. Nothing tells an agent what it has.** `volli identify` returns project,
ticket, session, worktree, socket, version — and nothing about the environment.
`AGENTS.md` says nothing about tool availability. So an agent's only discovery
mechanism is to run a command and fail, which is exactly the "probing failures"
the ticket asks to eliminate — and the workaround it bred (baking
`/opt/homebrew/bin/gh` into kickoff prompts) hardcodes one host's layout into
prompts that outlive it.

## Refined improvements

Grouped by the four goals, ordered by value-per-unit-risk within each.
**✅ landed 2026-08-20** · **○ open**.

### A — Consistency across sessions and project folders

**✅ A1 · Filter malformed `PATH` entries instead of rejecting the list.**
(`0d8812d2`.) The `.every(...)` guard became a `.filter(...)`, keeping absolute
entries and dropping the rest, returning `null` only when nothing survives.
Empty entries are dropped too — to a shell they mean the current directory, and
a `PATH` that runs commands from the cwd is never safe to adopt. Regression test
carries this host's measured string verbatim.

**✅ A2 · Unify the two probes into one module.** (`0497a859`.) One resolver in
`login-shell-path.ts`, `probeLoginShellPath(probe, deps)`, where the differences
are a `LoginShellProbe` argument: `DETECTION_PROBE` (`-l -i`, 3000ms, 1MB,
believes a shell that exits nonzero) and `ADOPTION_PROBE` (`-l`, 4000ms, 64KB,
refuses one). Both call sites kept their flag choice; what they stopped having
is independent notions of what a valid `PATH` is. The boot-side merge moved to
`login-path-adoption.ts`, which is indifferent to how the answer was obtained.

One deliberate behaviour change: detection now applies A1's entry filter too, so
it no longer reports `~/.dotnet/tools` as part of this host's `PATH`. The
control-character rule that only detection had survives as part of the same
per-entry filter instead of voiding the whole list.

**✅ A3 · Close the `.zshrc` gap without risking the boot.** The boot probe
stays exactly where it is and stays non-interactive; `createLoginPathBootstrap`
gained a second pass, `applyInteractive()`, fired from the same
`did-finish-load` callback the first pass already used. It asks
`loginShellPath()` — the `DETECTION_PROBE` answer detection has already paid for
and cached — so on a normal boot it is a cache read, not a second shell, and it
puts that answer through the same additive union merge. Nothing waits on it: if
the interactive probe hangs its full 3s, the app is exactly as usable as it was
before this existed.

The two decisions A2 left, made:

**Provenance — two fields, not four more values.** `env.provenance` still means
what C3 taught it to mean and still carries exactly `adopted` /
`already-complete` / `probe-failed`, describing the boot pass. The second pass
reports on its own field, `env.interactiveProvenance`, in the same three words
plus `pending`. Two fields because the passes are independent and their answers
form a cross-product — a boot `probe-failed` followed by an interactive
`adopted` is an ordinary recovered host, and a single string could only name
that pair by inventing a compound vocabulary for every combination. `pending` is
the fourth answer only a second pass can give, and it is what makes a session
that asked before the pass distinguishable from one that asked after; identify
reads it synchronously and never awaits it, so a wedged `.zshrc` cannot cost an
agent its identity output. `AGENTS.md` and `CLAUDE.md` were updated in the same
commit.

One subtlety worth recording: the second pass decides its own outcome by
comparing the `PATH` strings it wrote, not by reusing
`decideLoginPathAdoption`'s verdict. By the second pass `binDir` is always
already leading and the union orders login entries first, so that verdict can
never return `already-complete` — it would have reported `adopted` on every
host, including the ones where the pass changed nothing.

**Exit stance — the forgiving one is accepted, on stated grounds.** The second
pass adopts from `DETECTION_PROBE`, which believes a shell that exits nonzero,
and that is the stance `ADOPTION_PROBE` refuses. Three reasons it is sound here
and not there, in decreasing order of weight. (1) *The second pass only adds.*
Boot adoption replaces — if its answer is short, the app runs short, which is
why it may not gamble. The second pass merges onto an already-adopted `PATH`
and removes nothing, so believing a degraded answer costs strictly less than
not asking. (2) *A dirty exit cannot mean a truncated `PATH`.* The marked value
is printed by `-c`, after the rc files, so a shell killed inside them prints no
marker and parses to `null` — the "killed, but it had printed something
plausible" case the strict stance fears presents as no answer, not as a
plausible subset. (3) *PTY equivalence is the goal.* A session PTY runs
`$SHELL -l` on a tty and takes whatever `PATH` the rc files leave, whatever the
shell later exits with; refusing an answer for a nonzero exit would make
structured sessions disagree with PTY sessions in exactly the way A3 exists to
stop. What the pass requires *instead* of a clean exit: that boot adoption has
already applied (sequenced, so `process.env.PATH` has one writer at a time and
a late boot resolve can never clobber the second pass), that the answer parsed
at all, and that the merge is the same additive `binDir`-first union.

What is deliberately *not* attempted: mutating a live session's environment.
A structured session's `exec` reads `process.env` per command
(`SanitizedEnvExecutionEnv`), so it picks the new directories up on its next
command; a PTY session's own shell read the same rc files itself at spawn, so it
never needed the pass. Nothing chases a session that already started.

**✅ A4 · Make PTY and structured sessions provably equal.**
`apps/desktop/e2e/session-env-parity-smoke.mjs` starts one terminal PTY Session
and one Agent Runtime Session against the same built app, then asserts that
`command -v` returns the same absolute path for a fixed tool list. Its scratch
`ZDOTDIR` contributes one fake executable in `.zprofile`, another in `.zshrc`,
and a literal `~/some/dir` entry; it waits for `identify` to leave
`env.interactiveProvenance: pending` before comparing. A pass therefore observes
both A1's per-entry filtering and A3's interactive adoption through real
executors rather than a replayed parser result.

**○ A5 · Decide and enforce a worktree provisioning policy.** (P1, with VC-38.)
B1 now *reports* whether dependencies are installed, which removes the surprise;
the policy question is still open.
Either install dependencies when a worktree is created, or link/share them, or
declare them absent in the contract so the session knows before its first
commit. Any of the three is better than the current per-worktree coin flip. The
cheapest first step is the declaration — B1's `env` block reporting
`dependencies: installed | absent` costs nothing and removes the surprise.

### B — Observability

**✅ B1 · Add an `env` block to `volli identify`.** (`bdd52746`; A3 added
`env.interactiveProvenance`.) Prints `env.path`, `env.provenance`,
`env.interactiveProvenance`, `env.tools.<tool>` per contract tool, and
`env.dependencies`, in both text and `--json`. `-` means measured and not found;
an absent block means the answering process had no env facts at all — the same
measured-versus-unmeasured discipline `doctor`'s `Observed<T>` already keeps.

**✅ B2 · Add tool checks to `doctor`.** (`028c3719`.) One check per contract
tool, with remedies that name the real cause — a `PATH` adoption failure rather
than a generic "install it".

**✅ B3 · Report the *session* `PATH` in Settings → CLI, beside the login one.**
(`474f77de`.) The pane now folds the two long values into a side-by-side
comparison: every missing directory is visible in full, shared-order drift is
loud, and the complete lists remain available without truncation. The pending
interactive pass is named as a transition rather than a false failure.

**✅ B4 · Surface probe failure as a user-visible event.** (`1be80aad`.) A
persistent, non-modal app notice appears for either failed PATH probe and routes
to Settings → CLI. It is deliberately not a toast (which can expire before the
first affected Session) or a modal (which would block a recoverable app).

### C — Install / onboard

**✅ C1 · Fold an environment check into project onboarding.** (`f55777fa`.)
Selecting a project — including immediately after it is added — asks the existing
Session environment report with that project root and names missing contract
tools or dependencies in the same persistent notice. This deliberately leaves
Configure's Git/repair pane to VC-109; the report and pure readiness fold are the
handoff seam, not a competing configuration surface.

**✅ C2 · Detect the specific upstream breakage and explain it.** (`937faa20`.)
Settings scans `/etc/paths.d` read-only for the literal `~/.dotnet/tools` value
Microsoft's .NET CLI installer commonly writes, names the exact file, and
explains that macOS appends it to every login PATH. Volli filters it so Sessions
remain usable, but does not modify the root-owned file or offer an auto-repair.

**✅ C3 · State the contract in `AGENTS.md`.** (`0b9210df`, also `CLAUDE.md`.)
States what a session can assume, points at `volli identify`, and instructs
agents to *report* a missing tool as an adoption failure rather than work around
it with an absolute path — the habit that produced the `/opt/homebrew/bin/gh`
kickoffs this ticket was raised over.

### D — Repair

**✅ D1 · Extend `doctor --fix` to re-run adoption.** The repair drops the
interactive probe cache after its installer work, asks fresh non-interactive
and interactive shells, and re-runs the same additive, bin-dir-first merge.
Its `Session PATH repair` report keeps the contract's `adopted` /
`already-complete` / `probe-failed` vocabulary, names every directory it added,
and states that only Sessions started afterwards receive the repaired PATH.

**✅ D2 · Make repair reachable from where the failure appears.** Contract-tool
remedies, the persistent Session-PATH notice, and the agent-facing contract now
name `volli doctor --fix` as the first recovery step. They retain the reporting
rule and state that it repairs only Sessions started after the command.

**○ D3 · Per-session degradation record.** (P2.) Persist the env provenance on the
session record so a post-mortem can answer "did this session have `gh`?" without
re-deriving it from a host that has since changed. This is what would have
resolved the fabricated-PR scare in minutes.

## The other two bundle items

Both were confirmed still-live. No-worktree guardrails remain at the original
exploration depth; credential detection below makes the known `osxkeychain`
hazard visible, but the product guarantee itself remains open.

**No-worktree guardrails.** The scratch droppings from VC-62 are still in the
main checkout: `GOAL.md`, `MISSION.md`, `NOTES.md`, and `.playwright-mcp/`
holding ~260 screenshots, page dumps and console logs. A `VOLLI_SCRATCH_DIR` in
the contract — session-scoped, outside any checkout — plus a warning on
no-worktree session start addresses the cause rather than the symptom. Worth
coordinating with VC-38, which is already looking at worktree lifecycle.

**Headless-safe credentials.** The interim fix is in place and is repo-local:
`.git/config` carries an empty `credential.helper` (resetting the inherited
chain) followed by `!/opt/homebrew/bin/gh auth git-credential`. Two problems
with leaving it there. It is scoped to this one repository, so every other
project a session touches still reaches `osxkeychain` and can still hang on a
GUI prompt. And it hardcodes `/opt/homebrew/bin/gh` — the same absolute-path
workaround this document exists to remove, which will break for any user whose
`gh` is elsewhere. Productizing via VC-70 should make the guarantee
project-independent and resolve `gh` through the contract rather than a literal
path.

**Detection landed (VC-94; detection only).** Settings → CLI now asks Git from
an in-scope project's root for its all-scope, origin-annotated
`credential.helper` values. This is deliberately `git config --includes --null
--show-scope --show-origin --get-all credential.helper`, not a read of one
config file: Git supplies the included sources in its own order, then the
detector applies an empty helper as the reset Git gives it. A surviving known
`osxkeychain` helper is reported with Git's system, global, or repo-local scope
and the exact origin Git named. The notice says that macOS can show a GUI prompt
and that a Session with no keyboard can hang on a fetch or push. It never invokes
a credential helper, writes Git configuration, or offers repair; user Git
configuration remains the user's.

This is **not** the headless-safe credential guarantee. It only diagnoses one
known GUI-capable helper in the chain it can read; it does not make an
interactive credential path unreachable. VC-70 (GitHub in Settings) and VC-45
(Volli holds the credential and Sessions request operations) remain the work
that must establish that product guarantee.

## Review fixes (2026-08-21)

A pre-PR code review of the branch (run live on the reporting host) found one
real detection gap and a set of edge/UX defects. All are fixed on the branch:

- **Apple Git's `unknown` scope no longer hides the osxkeychain hazard.**
  Measured: Apple Git-155 (`/usr/bin/git`) reports its Xcode-bundled
  gitconfig — the file that enables `osxkeychain` on a stock Mac — with scope
  `unknown`, which the detector silently dropped. Unclassified scopes are now
  reported as `unknown` with Git's own origin naming the file, and the case is
  pinned by test. Homebrew git reports `system` and was always caught.
- **The workspace walk stops at the repository boundary.** A stray
  `~/package.json` beside a `~/node_modules` could answer "installed" for a
  worktree that had neither; `.git` (file or directory) now bounds both the
  dependency walk and the new lockfile walk.
- **Tool resolution requires a regular file.** `access(X_OK)` alone passes
  for a directory, so a directory named `git` on a PATH entry counted as the
  tool. Both resolvers (`packages/cli`, main) now stat first.
- **The environment alert repairs its own UX debts.** The combined notice
  states the `volli doctor --fix` hint once instead of twice, drops backticks
  (they rendered literally), names the workspace's own install command from
  its lockfile instead of a hardcoded `pnpm install` (`workspaceInstallCommand`
  in `@volli/shared`; a bare manifest defaults to npm), re-measures when the
  window regains focus so a repaired fault stops wearing its alert, and can be
  dismissed per fault. The credential notice no longer ships internal ticket
  IDs as product copy.
- **`session-environment-alert-model.ts` joined the 100% coverage gate**, the
  same enrollment its sibling `cli-status-model.ts` already had.
- **`doctor`'s repair block is validated before rendering.** A malformed
  `pathRepair` now renders as no repair rather than a half-invented one.

## What I did not verify

- **Single-host evidence.** Every measurement is from one macOS host with one
  `.zshrc`. The `/etc/paths.d` defect is upstream and will be common, but the
  *proportion* of affected users is unmeasured.
- **The live proof is controlled, not a census of this host's toolchains.** A4
  observes one PTY and one Agent Runtime Session resolving the controlled
  `.zprofile` and `.zshrc` executables after a bare-PATH app boot, including a
  malformed literal-tilde entry. It does not claim that any particular real
  host tool such as `gh` is installed; `volli identify` remains the contract's
  per-host tool report.
- **Non-macOS and non-zsh hosts** were not considered at all.
- **A3's `already-complete` path is untested against a real host.** Every
  measurement here comes from a host whose `.zshrc` does add directories. A
  host where it adds none should log `PATH kept (interactive login shell adds
  nothing)`; that branch is unit-tested and not yet observed.
- **The suite is green.** `pnpm test` (which is `vp run -r test`) passes across
  every package — 286 files and 5691 tests in `@volli/desktop` alone, zero
  failures.

  An earlier draft of this document reported 88 collection failures on an
  `@renderer/...` import alias. That was an artifact of running bare `vp test`
  from the repo root, which uses only the root config; the alias is defined in
  `apps/desktop/vite.config.ts` and only applies when the runner is invoked per
  package. The repository's own scripts always do (`test`, `test:coverage`, and
  CI's `vp run -r test:coverage`). Recorded here because the failure mode is
  worth knowing: from the root, a wrong invocation produces a large,
  authoritative-looking wall of failures in files the change never touched —
  which is the same class of mistake as trusting a PATH probe that measured the
  wrong environment.
