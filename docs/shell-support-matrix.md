# Shell support matrix

**What this is:** the honest state of Volli's shell support, and what a user whose
login shell is not zsh actually experiences. Recorded for VC-160 item 4, which is a
verification, not a build: full fish/bash PATH-chain support is out of scope, and
nothing here proposes a new UI surface.

**Verified:** 2026-08, against this checkout — code read end to end for each row, plus
live probes on this host (macOS, zsh login shell, bash 3.2 present, fish not
installed). Rows marked _(read only)_ could not be executed here.

## The matrix

| Capability | zsh | bash | fish | other |
| --- | --- | --- | --- | --- |
| PTY session spawns your login shell (`resolveShell`: `$SHELL -l`) | yes | yes | yes | yes |
| Login-PATH probe (`printf <marker>; printenv PATH` under `-l`/`-l -i`) | yes | yes ✔ live | yes _(read only)_ | any POSIX-ish shell |
| Both PATH adoption passes (boot + post-window interactive) | yes | yes | yes | yes |
| Volli's `bin/` prepended into the session env at spawn | yes | yes | yes | yes |
| Volli's `bin/` re-asserted **after** your shell startup (the `ZDOTDIR` chain) | yes | **no** | **no** | no |
| Typing a harness's own name hits Volli's wrapper | yes | **no** — launched-wrapped only | **no** — launched-wrapped only | no |
| `~/.local/bin` added to the login PATH (managed `~/.zprofile` block) | written when needed | **not written** | **not written** | not written |
| Setup-command completion sentinel (`worktree/setup.ts`) | POSIX form ✔ live | POSIX form ✔ live | `begin; …; end; … $status` _(read only, unit-tested)_ | POSIX form |
| Structured (Pi) session commands | shell-independent — always `/bin/bash` | same | same | same |

`printenv` and the marker were chosen for exactly this reason: `echo $PATH` would join
fish's list-valued `$PATH` with spaces, and `printenv` prints what any shell *exports*
(`login-shell-path.ts`). The sentinel wrapper is likewise shell-aware, because the
POSIX `( … ); … $?` form is a parse error in fish (`worktree/setup.ts`).

Why the chain is zsh-only, rather than merely unfinished: `ZDOTDIR` is a hook that runs
*after* arbitrary user startup without editing a user file — VS Code's mechanism, for
the same reason. bash and fish reach no equivalent without reimplementing their login
semantics (`packages/shared/src/harness/shell-init.ts`). A session on those shells is
launched-wrapped by absolute path; it just cannot intercept a hand-typed command.

## What a fish or bash user is told

Nothing states or implies that their *shell* is a problem: no banner, toast or dialog
names it, and everything below is either a neutral statement of fact or lives behind a
door the user opened. One warn-tone row is reachable for these users, but it is about
the login `PATH` rather than the shell — see [The one rough edge found](#the-one-rough-edge-found).

- **Settings → CLI, "Shell chain" row:** `muted` tone, `"fish — zsh only for now"`.
  Muted is the pane's vocabulary for true-but-unactionable; it is not a warning, and it
  does not put the section into its needs-attention state
  (`cli-status-model.ts`: `shellRow`, `cliNeedsAttention`).
- **`volli doctor` / the pane's Run Doctor button:** the `shell-init` check reports
  `warn` — "this shell has no post-startup hook Volli can use, so only Volli-started
  agents are wrapped" (`packages/shared/src/doctor.ts`). Doctor runs only when asked,
  by the CLI or by an explicit button press. This is the venue the bias audit
  prescribes for a limitation like this one.
- **Dotfiles:** nothing is written. The `~/.zprofile` PATH block is guarded on the
  login shell being zsh (`index.ts`, `installAgentToolsQuietly`), and the removal
  dialog omits the PATH sentence on hosts where no such line can exist, rather than
  promising to remove work that never happened.
- **The session-environment alert and the PATH probe:** shell-name-independent. The
  probe answers for bash and fish, so neither shell produces the "couldn't read your
  login PATH" arm.
- **Inside Volli's own terminals**, `volli` and the harness wrappers resolve for every
  shell: the PATH prepend is part of the spawned environment, not the chain.

## The one rough edge found

For a non-zsh user whose login PATH does not already include `~/.local/bin`, Settings →
CLI shows **"Volli on login PATH — Missing"** with `warn` tone, and the pane's Fix &
Re-run (`volli doctor --fix`) cannot clear it: the repair deliberately writes no profile
for a shell whose profile Volli does not manage. The row is *true* — `volli` really is
not typeable in their own terminal until they add the directory themselves — but its
remedy is invisible, so the honest fix is one line of copy naming the shell, not a new
mechanism.

That copy lives in the Settings → CLI surfaces, which VC-159 is editing, so VC-160 left
it alone and recorded it as a ticket comment instead. Everything inside Volli's own
sessions works for these users regardless.

## Deliberately not built

Full fish/bash PATH chains. The alternative to `ZDOTDIR` is writing the user's own
startup files (`~/.bash_profile`, `~/.config/fish/config.fish`) and re-asserting from
there — a mechanism with a different safety story than "read the user's dotfiles, never
write them". Worth its own ticket if fish or bash users ask; not worth inventing ahead
of that. The matrix above is what "staged support" currently means, stated so the next
person does not have to re-derive it from nine modules.
