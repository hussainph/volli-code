# `@volli/runner` — `volli-runner`

The Volli runner for a Linux box: Pi and a Session's tools on a machine you
own, linked outbound to Volli Cloud. It is the successor to `apps/hostd`,
which keeps shipping, frozen, until it retires. **No Electron**: the
repository's Electron-import guard (`scripts/check-host-electron-imports.mjs`)
holds this package to that.

This package is being built in steps. Today it links a box and reports its
status; the commands marked _not yet_ below answer exit 69 (`EX_UNAVAILABLE`)
with "not available in this build yet", so scripts and the installer can
rely on the command table now.

## Commands

| Command                                                                  | What it does                                                                                                                            |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `install --system\|--user`                                               | _not yet._ Put this release in place under systemd and link it.                                                                         |
| `uninstall [--keep-data\|--purge] [--yes]`                               | _not yet._ Remove the runner from this box.                                                                                             |
| `link [--token <vrt_…>] [--name <name>] [--server <url> [--site <url>]]` | Link this box to your Volli account (below).                                                                                            |
| `unlink`                                                                 | Forget this box's link. Refuses while the runner runs.                                                                                  |
| `run`                                                                    | Serve in the foreground until SIGTERM (systemd runs this). Exit 0 clean, 1 failed, 78 a boot to fix.                     |
| `status`                                                                 | One JSON report: the daemon's status file and liveness, and the link on disk. Exit 0 serving, 1 refusing, 3 not serving.                |
| `doctor`                                                                 | _not yet._ Check git, disk, network and model sign-ins.                                                                                 |
| `login [provider] [--api-key] [--status]` / `logout <provider>`          | Store, list or remove this runner's model sign-ins (below).                                                                             |
| `update [--now] [--to <version>]` / `update apply`                       | Show the update state; ask the runner to update now; `apply` is the update unit's entry (below).                                        |
| `logs [-f]`                                                              | _not yet._ The runner's log.                                                                                                            |
| `git-credential [--data-dir <dir>] <get\|store\|erase>`                  | Volli's git credential helper, run by git: asks the running runner over `<dataDir>/git-credential.sock` for the Session's GitHub token. |
| `version` (`--version`, `-v`)                                            | Print the version.                                                                                                                      |

`volli-runner help <command>` (or `<command> --help`) prints one command's
options. Every command that touches the box takes `--data-dir <dir>` and
`--config-dir <dir>`. Exit codes: 0 done, 1 refused or failed, 2 usage, 69
not in this build yet; `status` as above.

### Paths

| Install       | Data dir                                          | Config dir                                    |
| ------------- | ------------------------------------------------- | --------------------------------------------- |
| system (root) | `/var/lib/volli-runner`                           | `/etc/volli-runner`                           |
| user          | `$XDG_STATE_HOME/volli-runner` (`~/.local/state`) | `$XDG_CONFIG_HOME/volli-runner` (`~/.config`) |

The data dir holds the instance lock (`runner.lock`), the status file
(`runner-status.json`), the agent socket (`volli.sock`, mode 0600) and the
runner's machine state. The config dir holds the link and its key, never the
data dir, so a copied data dir or a backup does not carry the link.

### Linking

- **Install token** (`--token`, or `VOLLI_RUNNER_TOKEN`): the one-time token
  from Settings → Runners → Add a runner. One request, then the link is saved.
- **Device code** (no token): the box prints a code to enter in Settings →
  Runners → Link a runner, and waits until it is approved, declined or
  expired. Ctrl-C stops waiting (exit 130).
- **Server.** A release links to the Volli Cloud deployment it was built
  against (`VOLLI_BUILD_CONVEX_URL` / `VOLLI_BUILD_CONVEX_SITE_URL`, baked in
  by `vite.config.ts`). `--server <url>` (or `VOLLI_SERVER`) overrides it; a
  `*.convex.cloud` server's HTTP actions origin is the matching
  `*.convex.site`, and any other server (a local backend) names it with
  `--site <url>` (or `VOLLI_SERVER_SITE`). A development build has none baked
  and links only with `--server`.
- `--name` names the runner for an install token. A device-code runner is
  named after the box's hostname; rename it in Settings → Runners.
- An already linked box is refused: `unlink` first. The store also refuses to
  replace one runner's link with another's, should two `link`s race.

The link is `<configDir>/credential`, sealed (AES-256-GCM) under
`<configDir>/credential.key`, both mode 0600 (a config dir the first save creates is 0700)
(`src/link/file-store.ts`). It holds the runner id, its name, the rotating
refresh credential, its generation and the deployment it was linked to.
Saves are durable (temp file, fsync, rename, fsync the directory) and refuse
a generation that is not newer than the stored one, so a stale writer cannot
roll the credential back. A link file this build cannot open is an error that
names it, never "not linked".

### Model sign-ins

```sh
volli-runner login                          # list provider ids and sign-in methods
volli-runner login anthropic                # provider subscription/browser flow
volli-runner login anthropic --api-key      # hidden API-key prompt
volli-runner login --status                 # stored sign-ins, never their values
volli-runner logout anthropic               # remove this runner's stored sign-in
```

`--api-key` is a switch, not a key argument. Input is read without echo or
terminal history from the inherited terminal, or as lines on standard input
when piped. Never put a key in shell arguments or an environment variable for
this command. OAuth flows print the provider's device code, browser URL or
paste-code prompt. Follow its instructions; a loopback callback withdraws the
paste prompt if it wins. Port-1455 browser flows also print the
`ssh -L 1455:localhost:1455 <box>` forwarding tip. Ctrl-C cancels sign-in.

For a system installation, use `sudo volli-runner login ...`: the command
runs as the `volli` service account before opening credentials. A direct
invocation as that account also uses the system data/config directories,
even if sudo preserves the caller's `HOME`. All commands above accept the
usual `--data-dir` and `--config-dir` overrides.

The runner keeps Pi's opaque provider credentials in
`<dataDir>/host-credentials.enc`, sealed under
`<configDir>/session-secrets.key` (both owner-only). An explicit absolute
`VOLLI_SECRET_KEY_FILE` overrides that key path. The CLI never reads or
changes the person's `~/.pi/agent/auth.json`. Changes merge under the
inventory's credential lock; `pi-credentials.lock` also serializes Pi
refresh/login/logout across processes. The non-secret `model-device-id`
(and its lock file) supplies a stable installation id to Pi OAuth.

`--status` reports stored credentials, not a successful provider validation.
Logout removes only the stored credential; ambient provider credentials
remain unchanged. The daemon must compose `runnerModelAccess` from
`src/login/model-access.ts`, use its `runnerModelKeyPath` for other secret
stores too, and refresh its credential-availability report after changes.
Every store read reloads disk under the lock; no plaintext Pi auth file or
backend call is needed by login/logout.

## Updates

A runner under systemd keeps itself current (n3 §9); a foreground `run`
never updates itself, since nothing would restart it.

- **When.** Each heartbeat names a target (the runner's pin, else its
  channel's release) and a floor. With auto-update on, the runner updates to
  a newer target at an idle moment (no turn for a minute, waiting up to 6 h,
  then trying again an hour later). Below the floor, for Settings' **Update
  now** (a pin) and for `volli-runner update --now [--to <version>]`, it
  updates even with auto-update off and waits at most 30 minutes for running
  turns. Never a downgrade, never a release that already failed here.
- **Who.** The daemon decides and drains; it never installs. It writes a
  request (`<dataDir>/update/request.json`), which
  `volli-runner-update.path` turns into a run of
  `volli-runner-update.service`: the **installed** release's
  `volli-runner update apply`. In a system install that unit runs as root,
  because the releases are root's, and treats the request as untrusted; in a
  user install both are user units.
- **Stage.** The manifest comes from `<releaseOrigin>v<version>/volli-runner-manifest.json`
  and must be for that version. Every URL in it must sit under the release
  origin, and the tarball's size and SHA-256 must match. The release's
  Sigstore bundle must prove the manifest and tarball came from this
  repository's `release.yml` (`@refs/tags/v<version>` or `@refs/heads/main`),
  verified against Sigstore's public trust root (TUF, cached under the install
  root). The tarball is extracted beside the releases. It must carry a
  `MANIFEST.json` for that version, and is probed with its own `bin/node`
  (`probe-natives.cjs`, `probe-codemode.mjs`). It then becomes
  `releases/<version>-<revision>`.
- **Activate.** Once the daemon has drained, `current` moves to the new
  release in one rename and the runner restarts. For 2 minutes the unit's
  main process (systemd's `MainPID`) must end up reporting `online` at the new
  version, and systemd must not restart it 3 times. Otherwise `current` moves
  back to exactly the link it had, the runner restarts, and the release is
  recorded as bad. A bad release is not tried again unless
  `update --now --to <version>` names it. Data is never rolled back. An
  activation left unsettled (a reboot, a killed run) is settled by the update
  unit's run at boot, or when the runner wakes it after 15 minutes.
- **Which version.** A release's version is its own `MANIFEST.json`'s, never
  its directory name, so the installer's names and an absolute or relative
  `current` all read the same.
- **Reported.** Each outcome (`update_staged`, `update_applied`,
  `update_failed`, `rolled_back`) lands in the updater state and the daemon
  reports it to Volli once (`runnerUpdateReports.report`), where it becomes a
  runner event and the runner's update state in Settings.

| File                                    | Whose                     | What                                              |
| --------------------------------------- | ------------------------- | ------------------------------------------------- |
| `<installRoot>/releases/<v>`, `current` | the applier (root/system) | the releases, and the one that runs               |
| `<installRoot>/update-state.json`       | the applier               | staged, previous, bad releases, outcomes          |
| `<installRoot>/update.json`             | the installer             | `releaseOrigin`, `provenance` (`sha-only`: tests) |
| `<installRoot>/update-now.json`         | `update --now` (sudo)     | update now                                        |
| `<dataDir>/update/request.json`         | the daemon                | stage or activate one version (untrusted)         |
| `<dataDir>/update/reported.json`        | the daemon                | outcomes Volli has heard                          |

The install root is `/opt/volli-runner` (system) or
`$XDG_DATA_HOME/volli-runner` (user); `update` takes `--install-root`.

## Layout

```
src/
  main.ts           the process edge: argv, the live context, exit codes
  args.ts           argv → one registry entry (node:util parseArgs, strict)
  commands.ts       the command registry, its context, and the stubs
  commands/run.ts   `run`: the shell around host-core's headless runner
  link/             deployment (baked + --server), the sealed link file,
                    link and unlink
  update/           auto-update: policy, the daemon's agent, the applier
                    (stage, verify, activate, health, rollback), the update
                    units, and `update`
  git/              `git-credential`: the helper git runs in a Session,
                    asking the running runner (host-core's credential broker)
  shell/            the process shell, copied from apps/hostd and
                    parameterized by the daemon's identity (identity.ts):
                    boot errors, the instance lock, data-dir checks, logs,
                    eager secrets, the status file (status.ts) and what the
                    runner's says (runner-status.ts), whole-file and durable
                    writes, drain and stop (service.ts), runtime paths, paths,
                    the version, and `status`
  testing/          test support only (never imported by production code)
dev-bin/volli       the `volli` CLI launcher a source-booted runner puts on
                    its Sessions' PATH
e2e/                the BYO runner acceptance lane (ci-extended): a real
                    systemd box, a fake GitHub, a local release
                    (`e2e/README.md`). `node:test` files, outside Vitest
packaging/          volli-runner-update.{path,service}: the system rendering
                    of `src/update/units.ts`
```

### Adding a command

Each command is one `RunnerCommand` in `COMMANDS` (`src/commands.ts`): a
name, a summary, a usage line, its `parseArgs` options, and
`run(input, context)` resolving the exit code. Replace the command's stub
with an entry from its own module (`src/<area>/…`), keep the order (it is the
`--help` order), and reach the box only through `CommandContext`, which
`main.ts` builds live and tests replace (`src/testing/context.ts`).

### What `run` composes

`run` (`src/commands/run.ts`) boots the shell (`prepareDataDir` and
`warnOfSharedSocketDir`, `acquireInstanceLock(RUNNER, dataDir)` for the
process's life, `openHeadlessSecrets`, `installProcessLog`) under
`runService`, then `@volli/host-core/headless-runner`'s `startHeadlessRunner`
over the sealed link: host-core with headless ports, the cloud product store,
the Session runtime, the agent socket (`<dataDir>/volli.sock`, 0600) with the
cloud agent routes, and the outbound connection to the deployment the link
names (the Convex client is loaded only once linked). Every state change is
written to `runner-status.json` as a `RunnerStatus`. Unlinked, it serves only
its status and boots on once `link` saves a link. The runner's owner is read
from its first runner token and kept in `<dataDir>/runner-owner.json`, so a
restart while Volli Cloud is unreachable still recovers its Sessions. Its model
access is the sealed store `login` writes (`runnerModelAccess`, under the same
key as the Session secrets); a login or logout is re-reported to Volli Cloud
while it runs. The connection is host-core's headless lifecycle
(`createHeadlessRunner`): one token source per link, reconnects from 1 s to 60 s. The unit sets `VOLLI_RUNNER_SERVICE=1`, so the runner reports itself always on; a foreground `run` does not. SIGTERM reports `draining`, closes
the Session runtime (questions withdrawn, shells joined), reports `stopped`,
closes the socket and checkpoints SQLite. A failure after boot stops it and
exits 1; a boot an operator must fix (another runner on the data directory,
an unreadable link, a database that will not open) exits 78.

## Develop

```sh
pnpm --filter @volli/runner run build        # dist/runner.cjs
node apps/runner/dist/runner.cjs --help
vp test run                                  # from apps/runner
```

The bundle is one CommonJS file with every `@volli` package inside; what is
under `dependencies` (the natives, jsdom, which reads its own stylesheet from
beside itself, and the Sigstore verifier, which loads only when an update
verifies) stays external and resolves from `node_modules`. CI builds it on Linux and runs `status` against an empty box
(exit 3) in `Check + Build`; `Test (packages)` runs its suite at 100%
coverage.
