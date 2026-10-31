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

| Command                                                                  | What it does                                                                                                             |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `install --system\|--user`                                               | _not yet._ Put this release in place under systemd and link it.                                                          |
| `uninstall [--keep-data\|--purge] [--yes]`                               | _not yet._ Remove the runner from this box.                                                                              |
| `link [--token <vrt_…>] [--name <name>] [--server <url> [--site <url>]]` | Link this box to your Volli account (below).                                                                             |
| `unlink`                                                                 | Forget this box's link. Refuses while the runner runs.                                                                   |
| `run`                                                                    | _not yet._ Serve in the foreground.                                                                                      |
| `status`                                                                 | One JSON report: the daemon's status file and liveness, and the link on disk. Exit 0 serving, 1 refusing, 3 not serving. |
| `doctor`                                                                 | _not yet._ Check git, disk, network and model sign-ins.                                                                  |
| `login <provider>` / `logout <provider>`                                 | _not yet._ Model sign-in on this box.                                                                                    |
| `update`                                                                 | _not yet._ Update to the release Volli Cloud asks for.                                                                   |
| `logs [-f]`                                                              | _not yet._ The runner's log.                                                                                             |
| `git-credential <get\|store\|erase>`                                     | _not yet._ Volli's git credential helper, run by git.                                                                    |
| `version` (`--version`, `-v`)                                            | Print the version.                                                                                                       |

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
- `--name` names the runner for an install token; a device code's name is
  chosen in Volli when it is approved.
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

## Layout

```
src/
  main.ts           the process edge: argv, the live context, exit codes
  args.ts           argv → one registry entry (node:util parseArgs, strict)
  commands.ts       the command registry, its context, and the stubs
  link/             deployment (baked + --server), the sealed link file,
                    link and unlink
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
```

### Adding a command

Each command is one `RunnerCommand` in `COMMANDS` (`src/commands.ts`): a
name, a summary, a usage line, its `parseArgs` options, and
`run(input, context)` resolving the exit code. Replace the command's stub
with an entry from its own module (`src/<area>/…`), keep the order (it is the
`--help` order), and reach the box only through `CommandContext`, which
`main.ts` builds live and tests replace (`src/testing/context.ts`).

### What `run` composes

`run` is not built yet. The shell holds what it boots with: `prepareDataDir`
and `warnOfSharedSocketDir`, `acquireInstanceLock(RUNNER, dataDir)`,
`openHeadlessSecrets` and `logCredentials`, `installProcessLog` and
`routeConsole`, `writeStatus(RUNNER, …)` with a `RunnerStatus` (state
`unlinked` until it holds a link), `runnerRuntimePaths`, and `runService`
with `drain` for signals, the shutdown deadline and the exit codes (78 for a
boot refusal). Unlinked, it serves nothing but `status`.

## Develop

```sh
pnpm --filter @volli/runner run build        # dist/runner.cjs
node apps/runner/dist/runner.cjs --help
vp test run                                  # from apps/runner
```

The bundle is one CommonJS file with every `@volli` package inside; the
natives under `dependencies` (better-sqlite3) stay external and resolve from
`node_modules`. CI builds it on Linux and runs `status` against an empty box
(exit 3) in `Check + Build`; `Test (packages)` runs its suite at 100%
coverage.
