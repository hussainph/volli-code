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
> interactive/non-interactive split now an argument. A3 (the `.zshrc` gap) is
> what still lets two sessions differ.
>
> **Twelve improvements remain open** — marked ○ below. A5 and the two
> non-`PATH` bundle items want coordinating with VC-38, VC-109 and VC-70.

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
| Same `PATH` for PTY and structured sessions | ❌ differ by `.zshrc` contents | ❌ A3 open |
| Degradation is recorded and surfaced | ❌ logged as `[volli] PATH kept`, indistinguishable from healthy | ◑ provenance reported by B1/B2; ❌ B4 open |
| Session can discover it without probing | ❌ `volli identify` carries no env fields | ✅ B1 + C3 |
| Workspace dependencies installed, or session told | ❌ `node_modules` present in some worktrees, absent in others | ◑ reported by B1; ❌ A5 policy open |

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

**○ A3 · Close the `.zshrc` gap without risking the boot.** (P1.) *Deliberately
excluded from the P0 pass: it changes probe semantics and wants its own
verification.* Keep the
non-interactive probe on the boot path — that trade is right — but run the
interactive probe once, off the critical path, after the first window loads, and
adopt any additional entries it finds. Sessions started in the first ~2s get
today's answer; every session after gets the complete one. Record which of the
two answered.

A2 left the seam: the post-window interactive probe is `loginShellPath()`, which
detection has already paid for and cached, and `login-path-adoption.ts` takes
any answer through the same merge — so closing the gap needs no second shell and
no second notion of the truth. What it does need is a decision about the
provenance the second pass reports, and about `DETECTION_PROBE`'s more forgiving
exit stance being trusted with a `PATH` mutation.

**○ A4 · Make PTY and structured sessions provably equal.** (P2.) An e2e that
starts one of each and asserts `command -v` agrees for a fixed tool list.
`agent-pty-env-smoke.mjs` and `bare-path-env-smoke.mjs` already establish the
harness for this; what is missing is the *comparison* between kinds.

**○ A5 · Decide and enforce a worktree provisioning policy.** (P1, with VC-38.)
B1 now *reports* whether dependencies are installed, which removes the surprise;
the policy question is still open.
Either install dependencies when a worktree is created, or link/share them, or
declare them absent in the contract so the session knows before its first
commit. Any of the three is better than the current per-worktree coin flip. The
cheapest first step is the declaration — B1's `env` block reporting
`dependencies: installed | absent` costs nothing and removes the surprise.

### B — Observability

**✅ B1 · Add an `env` block to `volli identify`.** (`bdd52746`.) Prints
`env.path`, `env.provenance`, `env.tools.<tool>` per contract tool, and
`env.dependencies`, in both text and `--json`. `-` means measured and not found;
an absent block means the answering process had no env facts at all — the same
measured-versus-unmeasured discipline `doctor`'s `Observed<T>` already keeps.

**✅ B2 · Add tool checks to `doctor`.** (`028c3719`.) One check per contract
tool, with remedies that name the real cause — a `PATH` adoption failure rather
than a generic "install it".

**○ B3 · Report the *session* `PATH` in Settings → CLI, beside the login one.**
(P1.) Two rows, and an explicit warning when they diverge. The divergence is the
bug; a pane that cannot show it cannot be trusted to report health. This is the
VC-52 extension the ticket asks for.

**○ B4 · Surface probe failure as a user-visible event.** (P1.) B1/B2 make it
*askable*; it is still not *pushed*. When adoption
fails, the user should learn it from the app, not from an agent's
command-not-found three hours later.

### C — Install / onboard

**○ C1 · Fold an environment check into project onboarding.** (P1, converges
with VC-109.) When a repo is added, run the contract check and show what is missing
*before* the first session runs. VC-109 already proposes a Configure tab for git
and `gh`; the tool contract belongs in the same pane rather than a second one.

**○ C2 · Detect the specific upstream breakages and offer the fix.** (P2.) A1
now *survives* the malformed entry; nothing yet *tells* the user their
`/etc/paths.d` is broken. A
malformed `/etc/paths.d/*` entry is detectable, common, and repairable with a
one-line explanation of what wrote it. Detect-and-explain is worth more here
than auto-repair, since the file is root-owned and outside Volli's authority.

**✅ C3 · State the contract in `AGENTS.md`.** (`0b9210df`, also `CLAUDE.md`.)
States what a session can assume, points at `volli identify`, and instructs
agents to *report* a missing tool as an adoption failure rather than work around
it with an absolute path — the habit that produced the `/opt/homebrew/bin/gh`
kickoffs this ticket was raised over.

### D — Repair

**○ D1 · Extend `doctor --fix` to re-run adoption.** (P1.) The repair path today
rebuilds Volli's own shim, wrappers and shell chain. It cannot fix a `PATH`,
because nothing models the `PATH` as repairable state. Once A1 and B2 land, the
fix is `resetLoginShellPathCache()` + re-probe + re-adopt, which is already
idempotent by construction.

**○ D2 · Make repair reachable from where the failure appears.** (P2.) An agent
that hits command-not-found should be able to run one documented command and
recover, rather than escalating to the user.

**○ D3 · Per-session degradation record.** (P2.) Persist the env provenance on the
session record so a post-mortem can answer "did this session have `gh`?" without
re-deriving it from a host that has since changed. This is what would have
resolved the fabricated-PR scare in minutes.

## The other two bundle items

Both were confirmed still-live, but neither was investigated to the same depth;
the environment defect consumed the budget and is the prerequisite for one of
them.

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

## What I did not verify

- **Single-host evidence.** Every measurement is from one macOS host with one
  `.zshrc`. The `/etc/paths.d` defect is upstream and will be common, but the
  *proportion* of affected users is unmeasured.
- **PTY-side completeness is inferred, not observed.** I could not spawn a Volli
  PTY from inside this session. The claim that PTY sessions see the richer
  `PATH` follows from `resolveShell` spawning `$SHELL -l` onto a tty plus the
  measured `-l -i` output — sound, but not directly observed end to end. A4
  would close this.
- **Non-macOS and non-zsh hosts** were not considered at all.
- **The fix is not yet observed in a live session.** A1 is verified by unit test
  and by replaying this host's real login-shell output through the new parser
  (20 of 21 entries kept). Adoption itself runs at app boot, so confirmation
  that a session actually resolves `gh` waits on the next restart.
- **The suite is green.** `pnpm test` (which is `vp run -r test`) passes across
  every package — 286 files and 5678 tests in `@volli/desktop` alone, zero
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
