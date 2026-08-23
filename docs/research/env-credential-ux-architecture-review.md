# Git + environment setup: architecture and UX review

**Date:** 2026-08 · **Prompted by:** recurring macOS keychain prompts for "Volli auth
details" and the red "Sessions aren't ready for {project}" banner appearing on
freshly-added workspaces.

This is a diagnosis of both complaints against the actual code paths, measured on this
machine, plus a survey of how t3code, the Codex app (ChatGPT desktop), opencode, and
Conductor handle the same problems. Recommendations at the end, ordered by
effort-to-relief ratio.

---

## Part 1 — The keychain prompts

### What is actually happening (verified on this machine)

The only thing in Volli that touches the macOS Keychain is Electron's `safeStorage`,
and the only secrets behind it are the **optional web-search API keys** (Brave/Exa) —
`apps/desktop/src/main/web/credential.ts`. Verified state on this machine:

- Login keychain contains a generic-password item **"Volli Code Safe Storage"**
  (created 2026-08-18) — the key Chromium derives `safeStorage`'s cipher from.
- `web_access_settings` has `provider = exa`, and a 51-byte ciphertext sits in the
  `secrets` table under `web-access.exa.api-key`.

Because a keyed provider is configured, `WebAccessSettings.resolve()` runs on **every
structured Session attach** (`resolveWebPorts` in `main/index.ts`), and each call does
`state()` → `read()` → `safeStorage.decryptString()` → **a Keychain access**. Settings
opens do the same via `view()` → `isEncryptionAvailable()`.

macOS binds a keychain item's ACL to the **code identity of the binary that created
it**. Any process whose signature doesn't satisfy that ACL gets the "Volli Code wants
to access key 'Volli Code Safe Storage' in your keychain" dialog. On a machine that
runs a rotating cast of binaries — `pnpm dev`/`pnpm start` (the npm-dist Electron
binary), local `release/` builds, the auto-updated `/Applications` copy — the ACL
match keeps breaking, so the prompt keeps coming back. This is a known failure class
for electron-builder apps (identical public reports exist for other apps: locally
rebuilt app → different cdhash → "X Safe Storage" prompt on every launch). Normal
users of a stable, Developer-ID-signed release mostly never see it; developers and
early alpha users on churning builds see it constantly. Related but *not* the cause
here: Electron 42.0 had a regression where merely importing `electron` touched the
keychain at app-ready (electron#50419); we're on 43.4.0, which has the lazy-init fix.

### The irony worth stating plainly

Volli's **actually sensitive** credentials — the Anthropic/OpenAI/OpenRouter OAuth
tokens — live in Pi's plaintext `~/.pi/agent/auth.json` (0600, by design: "Pi owns
provider credentials", `packages/agent-runtime/src/pi/models.ts`). The keychain
ceremony guards only two optional search keys. The threat model already accepts
plaintext-on-disk for the crown jewels, so the keychain buys near-zero marginal
security while generating the single scariest OS-level interruption the app has.

### How the comparison apps handle credentials

| App | Model credentials | OS keychain? |
| --- | --- | --- |
| **opencode** | plaintext `~/.local/share/opencode/auth.json` (0600) | No (open feature request for opt-in keyring) |
| **Codex CLI/app** | `~/.codex/auth.json` file by default; OS keyring is opt-in config | Not by default |
| **t3code** | stores none — delegates entirely to the agent CLIs (Claude Code, Codex, opencode…) each with their own auth | No |
| **Volli (pi)** | plaintext `~/.pi/agent/auth.json` — same pattern as the above | Only for the 2 web-search keys |

The field consensus for local-first agent tools is: **0600 file, no keychain**, or
delegate to a CLI that already made that choice. Volli is already 90% on that
consensus; the web-search keys are the odd remainder.

### Recommendations (keychain)

1. **R1 — Drop `safeStorage` for the web-search keys.** Store them the way every peer
   (and Volli's own pi auth) stores secrets: a 0600 file under `userData` (or keep the
   `secrets` table and store plaintext — the DB file already lives in the user-only
   `Application Support` dir). This deletes the keychain prompt *category*, the
   three-state `SecretState` ("unreadable" stops being possible), the
   `SecretUnavailableError` surfaces, and the "keychain unavailable" error copy in Web
   Access settings. One migration: on first run, decrypt-if-possible and rewrite;
   if undecryptable, mark the key absent and let Settings ask for a re-paste (the copy
   for that already exists).
2. **R2 — If keeping `safeStorage`, stop touching it per-attach.** Decrypt once,
   lazily, on the first Session that actually gets web tools; cache the plaintext in
   main's memory for the process lifetime (it already transits memory on every attach
   today, so this concedes nothing). Never call `isEncryptionAvailable()` in `view()`
   unless a key exists or the user is editing one — today merely opening Settings can
   create the keychain item and start the whole cycle.
3. **R3 — Keep git credentials fully delegated** (already true: helpers, `gh`, SSH are
   the user's own config; Volli only *reads* `credential.helper` for diagnostics).
   Nothing to build here — see Part 2 for what to do with the diagnostic's copy.

R1 is the recommendation. R2 is the fallback if plaintext-at-rest is unacceptable —
but then the same argument must eventually move pi's auth.json into the keychain,
which nobody in this product category does.

---

## Part 2 — The "Sessions aren't ready" banner and the error-surface budget

### What actually fires it (verified against the reported case)

`sessionEnvironmentAlert` (`renderer/components/session-environment-alert-model.ts`)
renders a **red, error-toned** notice above the board when, for the selected project:

- either login-PATH probe failed ("Sessions couldn't read your login PATH…"), or
- any of the fixed census `git, gh, node, pnpm` is missing from the Session PATH, or
- an enclosing `package.json` exists with no `node_modules` → "Dependencies are not
  installed. Run npm install before starting a Session."

The reported case is real and reproducible: `~/Desktop/harbor` is a brand-new scaffold
(git repo, `package.json`, `src/`, no `node_modules`). Adding it as a project selects
it, the alert model measures it, and the user's first impression of a new workspace is
a red warning titled "Sessions aren't ready." Dismissal is keyed to the exact alert
string and held in component state, so it returns on relaunch and on every wording
variation.

### Why this is the wrong shape (not just the wrong color)

1. **It reports a normal state as a fault.** No `node_modules` in a fresh checkout is
   the *expected* state of the world — Codex's own docs treat it as a troubleshooting
   topic, not a pre-flight failure. Nothing is broken; there is simply a step nobody
   has run yet.
2. **It tells a human to do something the product is built to do.** Volli is an agent
   app with a working setup-command pipeline (`worktree/setup.ts` types the command
   into the Session PTY with a completion sentinel). The agent itself can run
   `npm install` in its first turn. Today the *one party who never learns* the
   dependency fact is the agent: the structured-session prompt carries no environment
   block (only `volli identify` exposes it, if the agent thinks to ask).
3. **The census is Volli-repo bias.** `gh` and `pnpm` are required *for developing
   Volli*; they are not universal. A Python or Go project — or any repo whose owner
   never uses the PR buttons — wears the red banner forever. Meanwhile the code
   already knows better: `workspaceInstallCommand` picks npm/yarn/pnpm/bun by
   lockfile, and the `GhResult` taxonomy already classifies `not-installed` /
   `not-authenticated` at the moment a `gh` verb actually runs.
4. **The remedy is a CLI incantation.** "Run volli doctor --fix" as the first-run
   answer is internal vocabulary ("login-shell passes", "PATH adoption",
   "provenance") leaking into onboarding copy.

### How the comparison apps handle it

- **Codex app:** no pre-flight environment banner. Worktree gaps are solved by *doing*
  — "local environments" run configured setup steps when a worktree is created, and
  `.worktreeinclude` carries ignored files. Missing-deps guidance lives in a
  troubleshooting doc, consulted after something fails.
- **Conductor:** a setup script attached to the project runs automatically at
  workspace creation, with progress shown *in the workspace*. "Not ready" is a
  transient setup phase, not a warning.
- **t3code:** worktrees are opt-in per thread; there is no environment audit surface
  at all. Errors surface when an operation fails.
- **Everyone:** git/`gh`/auth failures surface at the point of use (push, PR create),
  with the tool's own stderr — which Volli *also* does, well, in `worktree/net.ts`.

Nobody in the field ships a proactive "your machine may be broken" banner on folder
open. The pattern is: **defaults that make it moot, actions instead of diagnoses,
diagnostics behind a door for whoever goes looking.**

### Recommendations (error surfaces)

4. **R4 — Retire the dependency banner; give the fact to the agent.** Put the
   `SessionEnvReport` facts (missing deps + the lockfile-derived install command) into
   the structured Session's context so the first turn can just run the install. The
   product already measured everything it needs; it is telling the wrong audience.
5. **R5 — Where a human surface is still wanted, make it an offer, not an alarm.** A
   neutral-toned, one-line affordance on the fresh project: "Dependencies aren't
   installed — Run `npm install` / Set a setup command / Ignore." Executes through the
   existing PTY sentinel machinery. This is the Conductor/Codex shape: the state's
   remedy *is* the surface.
6. **R6 — Shrink the census to what the project implies.** `git` when the folder is a
   repo; `node` + the lockfile's package manager only when a lockfile says so; `gh`
   never pre-flight — its absence is already classified beautifully at the moment a PR
   button is pressed (VC-70's Settings surface is the right *config* home for GitHub,
   not a launch banner).
7. **R7 — Reserve the launch-wide red banner for the one real app-level fault** (both
   PATH probes failed *and* a needed tool is consequently unresolvable), reword it in
   plain language, put a "Fix now" button on it (run the adoption pass again —
   `doctor --fix` behind a button, not a sentence), and persist dismissal in the DB.
8. **R8 — Demote the osxkeychain credential-helper notice.** `osxkeychain` is the
   *stock* macOS git setup; warning about the default trains users to ignore warnings.
   Show it only after a git network operation actually hangs or fails, as the
   explanation attached to that failure — the same point-of-use pattern as R6.

### What is *not* over-engineered (keep it)

- **The worktree machinery.** `git worktree add` + `.worktreeinclude` (the exact
  convention Codex and Conductor share) + setup command in the PTY + typed failure
  taxonomies. This is squarely the field-standard architecture; peers converged on
  the same design.
- **The PATH adoption itself.** Finder-launched apps genuinely inherit launchd's bare
  PATH; VS Code runs the same login-shell resolution dance. The machinery is sound —
  what needs to change is that its *vocabulary* (passes, provenance, probes) stays in
  Settings → CLI and `volli doctor` for whoever opens that door, and never in
  first-run copy.
- **Point-of-use error taxonomies** (`GhResult`, `WorktreeResult`, non-fast-forward
  vs no-remote push classification). This is where "surface every error" belongs, and
  it is already done well.

---

## Suggested sequencing

| Order | Item | Effort | Relief |
| --- | --- | --- | --- |
| 1 | R4 + R5: banner → agent context + neutral offer | S–M | Kills the scary first-run moment |
| 2 | R6: lockfile-aware census; drop `gh`/`pnpm` pre-flight | S | Kills the permanent banner on non-JS repos |
| 3 | R1: web-search keys out of `safeStorage` (file/DB, 0600) | M | Kills the keychain prompt category |
| 4 | R7 + R8: one calm app-fault banner; osxkeychain notice → point-of-use | S | Coherent error budget |

Board fits: VC-109 (git onboarding hardening) is the natural owner of R5–R7's
Configure-side surface; VC-111 (Settings redesign) should inherit the "diagnostics
behind a door" framing; VC-70 (GitHub in Settings) is R6's `gh` config home.

Tickets cut from this review: **VC-156** (R4+R5), **VC-157** (R6), **VC-158** (R1),
**VC-159** (R7+R8).

---

## Part 3 — The bias audit: what was built for Volli, and what is agnostic

Follow-up question: how much tooling exists specifically because of worries about
Volli's own repo/dev loop, and how project-agnostic is the rest of the wiring?
Surveyed module by module; line counts exclude tests.

### Category 1 — Built because of Volli's own incidents (and shaped like Volli)

The environment-diagnosis complex is **~3,400 lines** (probe/adoption:
`login-shell-path` 401, `login-path-adoption` 380, shell chains 250;
reporting/diagnosis: `doctor` 413, `session-env` shared+main 330, `cli-status` +
`cli-doctor` + `system-path-diagnostics` 300, `credential-helper-diagnostics` 131,
renderer surfaces ~930). For contrast, the entire worktree core — the actual
product machinery — is ~6,000 lines.

Within that complex, two very different things are fused:

- **A universal-problem core (~1,100 lines).** Finder-launched Mac apps really do
  inherit launchd's bare PATH; the two-pass login-shell probe and adoption solve a
  problem every peer (VS Code included) also solves. Keep.
- **An incident-response layer (~2,300 lines)** whose shape is Volli's own history,
  not a general requirement. The evidence is in the sources themselves:
  - `SESSION_ENV_TOOLS = [git, gh, node, pnpm]` is Volli's exact toolchain — pnpm
    workspace, gh-driven PR flow — and the doc comment says so: "`node` and `pnpm`
    for **the pre-commit hook** and every Node project." That's *our* pre-commit hook.
  - `doctor.ts` opens with "This exists because of a specific failure" (the wrapper
    PATH-position outage) and one check is titled "The check that would have caught
    the outage."
  - `credential-helper-diagnostics.ts` exists because *our* Sessions hit osxkeychain
    prompts — the same anxiety this review started from, answered with a warning
    surface instead of a venue change.
  - `db-open-failure.ts` remedy copy says "`nvm use` reads the repo's .nvmrc,
    re-run `pnpm install`" — an error message whose audience is Volli's own
    developers, shipped to users.

  The dynamic to name: **each dev-loop incident was answered with a new detector and
  a new user-facing surface**, and because the incidents happened in Volli's repo,
  the detectors encode Volli's toolchain as "ready."

### Category 2 — JS-ecosystem bias (wider than Volli, still not agnostic)

- **Dependency readiness is package.json/node_modules-only.** Python (pyproject,
  .venv), Rust, Go, Ruby, JVM all measure as `null` ("no workspace") — benign
  silence, but it means the entire dependencies feature only exists for JS.
  `workspaceInstallCommand` likewise maps only JS lockfiles.
- **`DEFAULT_PRUNED_DIRS = [node_modules]`** (worktree include copy-walk): a Python
  `.venv/` or Rust `target/` is walked in full — the VC-16 perf lesson will be
  re-learned per ecosystem.
- **`volli-fs`**: `FALLBACK_SKIP_DIRS = {.git, node_modules, .volli}` and the dir
  watcher filters only `node_modules` — `.venv`/`target` can flood the 20k file-index
  cap and the watcher on non-JS repos.
- The census requiring `node`/`pnpm` universally (VC-157 fixes).

### Category 3 — Machine bias (the founder's setup, not the repo)

- **zsh-only shell chain** (`shell.supported = zsh`); fish gets the setup-command
  sentinel but no PATH chain; bash none. Honest about it in Settings — acceptable as
  staged support, worth knowing it's a bias.
- **Ghostty theming integration** (~500 lines): reads the user's Ghostty config to
  theme the in-app terminal. Degrades gracefully; founder-machine tuned.
- **GitHub-only PR rail** via `gh` (field-common — Codex/Conductor are equally
  GitHub-first — but GitLab/Bitbucket users get push/fetch and no PR affordances).
- macOS arm64-only: explicit, documented decision.

### Category 4 — Genuinely agnostic (most of the wiring, and it's good)

- Worktree pipeline (identity, ensure, reconcile, prune-retry, phases): pure git,
  zero repo assumptions.
- `.worktreeinclude` engine: gitignore semantics, the field-standard convention.
  Defaults `.env*` (universal) and `.claude/settings.local.json` (harness-domain,
  appropriate for an agent app).
- **`projects.setup_command`**: per-project, typed into the PTY with a shell-aware
  sentinel (POSIX + fish). This *is* the correct ecosystem-agnostic answer to
  dependencies — it exists and works; the UX just never offers it (VC-156's fix).
- Base branch via `origin/HEAD`; push/fetch failure classification on git's own
  stderr; board/ticket/session engine; blob store; transcripts; harness
  wrapper/skill installation for claude-code/codex/cursor/opencode.
- Session prompts: verified free of toolchain assumptions (no pnpm/vitest anywhere
  in prompt assembly).

### Reading of the whole

The deep infrastructure is agnostic; the bias lives almost entirely in the **policy
layer** — the constants and copy that decide what counts as "ready," which tools
matter, and what the remedy sentence says. That is cheap to fix (VC-156–159 cover
most of it) and cheap to prevent:

1. **Don't expand detection per-ecosystem** — route facts to the agent (R4). The
   agent already knows how to install a Python or Rust project; a detector table
   would be more Volli-style pre-flight machinery.
2. **One cheap follow-up worth cutting later:** widen the prune/skip dir sets (or
   respect .gitignore in the fallback walks) so non-JS repos don't pay walk/watch
   costs — `include.ts`, `volli-fs.ts`.
3. **A litmus test for future surfaces:** *would this ship unchanged if Volli were a
   Rust repo hosted on GitLab, developed in fish?* If no, it's policy — and policy
   needs a project-implied source (lockfile, remote, `$SHELL`) instead of a constant
   born from our own toolchain.
4. **Incident rule of thumb:** a dev-loop incident earns a *detector* only if its
   failure mode is universal; otherwise it earns a line in `volli doctor` — never a
   launch surface.
