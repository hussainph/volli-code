# volli-hostd

The headless Volli host (VC-562, Volli Cloud M1). It composes
`@volli/host-core` with headless ports, opens and migrates the database, and
serves the agent Unix socket, so the `volli` CLI works against it unchanged.
No window, no Electron: `scripts/check-host-electron-imports.mjs` gates this
directory.

```sh
volli-hostd --data-dir /var/lib/volli-hostd [--socket <path>]
volli-hostd status --data-dir /var/lib/volli-hostd
VOLLI_SOCKET=/var/lib/volli-hostd/volli.sock volli project list
```

## What it serves today

| Capability    | State         | Arrives with                                                                                            |
| ------------- | ------------- | ------------------------------------------------------------------------------------------------------- |
| `board`       | available     | The agent socket's verbs over the database: projects, tickets, comments, labels, conflicts, `identify`. |
| `sessions`    | `unavailable` | VC-622. Session verbs answer `APP_UNREACHABLE`, as desktop's do when its runtime did not come up.       |
| `automations` | `unavailable` | VC-622 (the scheduler starts Sessions).                                                                 |
| `terminals`   | `unavailable` | The host protocol's terminal streams (VC-568). node-pty already ships and loads.                        |
| `browser`     | `unavailable` | Standalone Chromium (VC-619).                                                                           |

Writes over the socket need an authenticated Session, so an operator's CLI is
read-only for now, and there is no verb to register a project yet: VC-623.
Backup, retention, recovery and the maintenance loops move into host-core in
VC-618; hostd wires them once they land.

## Ports

| Port                                               | hostd passes                                                                          |
| -------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `events`                                           | Drops each broadcast (no client is connected before M2); logs the topic at `debug`.   |
| `attention`                                        | `HEADLESS_ATTENTION` (every alert `unsupported`), plus an `info` line with its title. |
| `power`, `connectivity`                            | `NO_POWER_EVENTS`, `ALWAYS_ONLINE`.                                                   |
| `client`, `trash`                                  | Absent: host-core refuses those requests with its typed errors.                       |
| `log`                                              | The JSON logger.                                                                      |
| `listOpenNativeBindings`, `observeScheduledResume` | Nothing bound, nothing to resume (no runtime yet).                                    |

Policy: `onTransactionViolation: throwTransactionViolation` (VC-551: nobody
watches a server's log while a bug corrupts a transaction) and
`devDiagnostics: false`.

## Boot

In order; each refusal is logged as one JSON line and exits **78**
(`EX_CONFIG`), which the systemd unit does not restart:

1. **Data directory.** Created mode 0700 when absent. Refused when it is not a
   directory or when every user can write it. Group-writable is a warning:
   with user private groups (the Debian and Ubuntu default) the group is the
   user alone.
2. **Another host.** Refused when another process holds the data directory's
   instance lock, whatever its `--socket`: an exclusive SQLite lock on
   `<data-dir>/hostd.lock`, atomic, held until stop, released by the kernel
   if the process dies. Two hosts never open one database.
3. **Secrets, eagerly.** `fileSecretKey` loads lazily by design; a service
   cannot wait for the first Session to find a bad key. A relative
   `VOLLI_SECRET_KEY_FILE`, a key file with group or other access, owned by
   another user, not a file or not one key line, or sealed secrets whose key is
   missing or different: each refuses boot with the adapter's own sentence.
4. **The agent socket**, before the database, so a request that arrives
   during migrations waits for boot rather than being refused at connect. A
   live listener on the same path refuses this host.
5. **host-core** opens and migrates the database. A database that will not
   open is **not** a boot failure: hostd stays up in state `refusing`, every
   verb answers `DB_UNAVAILABLE` with the reason, and the status file carries
   the typed `databaseFailure`. That includes a database from a newer Volli
   (VC-602), which is left byte-identical.

## Health

hostd rewrites `<data-dir>/hostd-status.json` (atomically, mode 0600) at every
state change: `starting`, `serving`, `refusing`, `stopping`, `stopped`. It
holds paths, the pid, the version, the capabilities above and the database's
state. When the database did not open, that state includes the sentence every
verb answers with and the typed failure:

```json
"database": {
  "ok": false,
  "path": "/var/lib/volli-hostd/volli.db",
  "error": "This database was created by a newer version of Volli. Nothing was changed. Update Volli, or restore an older backup.",
  "failure": { "kind": "newer-version", "schemaVersion": 61, "supportedVersion": 60, "minReaderVersion": 61 }
}
```

`volli-hostd status --data-dir <dir>` prints the record as JSON with a verdict,
believing it only when its pid is alive and its socket accepts a connection:

| Exit | Verdict       | Meaning                                                      |
| ---- | ------------- | ------------------------------------------------------------ |
| 0    | `serving`     |                                                              |
| 1    | `refusing`    | Up, but the database did not open: read `database`.          |
| 3    | `not-serving` | Stopped, starting, stopping, crashed, or socket unreachable. |

The host protocol (VC-564) carries the same facts to remote clients.

## Shutdown

`SIGTERM` or `SIGINT`:

1. Status `stopping`.
2. Close the agent socket: refuse new connections and wait up to its 10 s
   request timeout for the requests in flight.
3. Wait up to 10 s more for any execution still running. One that outlives
   that is abandoned and logged, and the stop is not clean.
4. Stop the Session activity watch's flush timer.
5. `PRAGMA wal_checkpoint(TRUNCATE)`, then close the database. The WAL is
   folded in and removed.
6. Release the instance lock; status `stopped`; exit 0, or 1 if anything did
   not drain or close cleanly.

A signal during boot waits for boot, then stops what it opened. A second
signal exits 1 at once. A stop that has not finished 30 s after it was asked
for exits 1, even if boot never finished. An uncaught exception or unhandled
rejection, before or during a stop, runs the same stop and exits 1, so the
supervisor restarts it.

## Logs

One JSON object per line on stdout: `ts` (ISO 8601), `level`, `msg`, and
fields. `console.*` from host-core is routed through the same logger.
`VOLLI_HOSTD_LOG_LEVEL` is `debug`, `info` (default), `warn` or `error`. No line
carries a key, a secret or a request payload.

```sh
journalctl -u volli-hostd -o cat | jq -r '[.ts, .level, .msg] | @tsv'
```

## Packaging

**Decision: a pinned Node beside a bundled `dist` and its native
`node_modules`, not a Node single executable application (SEA).**

- **SEA buys nothing with these natives.** A SEA blob holds one script; it
  cannot `dlopen` a `.node` file from inside itself. better-sqlite3, node-pty
  and sharp would still be extracted to disk, sharp loads libvips by path
  relative to its package, and ripgrep is an executable, not an addon. A SEA
  build would still ship a directory, plus an extract-at-startup step.
- **Some JavaScript cannot be inlined either.** jsdom reads files relative to
  its own package at module load (desktop keeps it external for the same
  reason), and Code Mode's worker and `quickjs.wasm` are reached by path. A SEA
  entry can only `require` built-ins without a `createRequire` workaround.
- **One more toolchain for no gain.** SEA needs a blob, `postject` and, on
  macOS, re-signing per platform.

So the artifact is:

```
volli-hostd-<version>-linux-x64/
  bin/node              Node, copied from the digest-pinned host image (= .nvmrc)
  bin/volli-hostd       sh launcher: exec bin/node lib/hostd/hostd.cjs
  bin/volli             sh launcher for the volli CLI bundle
  lib/hostd/            hostd.cjs and its chunks: hostd, every @volli package
                        and pure-JS dependencies, bundled by `vp pack`
  lib/volli.cjs         the CLI bundle (packages/cli)
  lib/probe-natives.cjs loads and exercises every native under bin/node
  lib/node_modules/     `pnpm deploy --prod` of this package, from the lockfile
  share/systemd/volli-hostd.service
  share/launchd/com.volli.hostd.plist
  MANIFEST.json  README.md  LICENSE
```

`package.json` `dependencies` are exactly what stays external: the natives and
jsdom. Everything else is a devDependency and bundled. `pnpm deploy --prod
--config.node-linker=hoisted` installs the externals flat, at the lockfile's
exact versions, and runs their install scripts on the build machine. Other
platforms' prebuilds are pruned; the probe then proves nothing needed went.

### Natives (linux-x64)

| Package         | Version | Where the linux-x64 binary comes from                                                    |
| --------------- | ------- | ---------------------------------------------------------------------------------------- |
| better-sqlite3  | 13.0.3  | Its own bundled N-API prebuild, `prebuilds/linux-x64.node`.                              |
| node-pty        | 1.1.0   | Compiled from source by its install script in the host image (no Linux prebuild); N-API. |
| sharp           | 0.35.4  | The `@img/sharp-linux-x64` and `@img/sharp-libvips-linux-x64` optional packages (glibc). |
| @vscode/ripgrep | 1.18.0  | The `@vscode/ripgrep-linux-x64` optional package's `bin/rg`.                             |

All four are already in the lockfile, so the platform packages pnpm picks on
Linux add no lockfile entries. They are built in `.devcontainer/host/Dockerfile`
(Debian bookworm, glibc 2.36), so it needs glibc 2.36 or later: Ubuntu 24.04,
the owner's box, qualifies.
`MANIFEST.json` records the versions; `bin/node lib/probe-natives.cjs` checks a
box before you start the service.

The artifact bundles third-party code. It is a CI artifact for dogfooding, not
a release: a distributed hostd needs its own generated notice, like desktop's
`THIRD-PARTY-NOTICES`.

### Building it

CI's `Build (host container)` job builds and boots it on every host change
and uploads `volli-hostd-linux-x64`. Locally, from the repository root:

```sh
docker build -f .devcontainer/host/Dockerfile -t volli-host-dev .
mkdir -p .tmp/hostd && chmod 777 .tmp/hostd
docker run --rm -v "$PWD:/src:ro" -v "$PWD/.tmp/hostd:/out" volli-host-dev \
  bash /src/apps/hostd/scripts/ci-build-artifact.sh
docker run --rm -i -v "$PWD/.tmp/hostd:/out:ro" volli-host-dev \
  bash -s < apps/hostd/scripts/ci-boot-artifact.sh
```

On an Apple Silicon Mac that builds `linux-arm64`, which exercises the same
scripts. A macOS arm64 artifact is VC-624.

The boot check unpacks the archive in a fresh container with no checkout and
no system Node on `PATH`, probes the natives, boots against an empty data
directory, waits for `status` to report `serving`, lists projects through the
socket with the bundled CLI, sends `SIGTERM`, requires exit 0, status
`not-serving` (stopped), no socket and no WAL left, `PRAGMA integrity_check` =
`ok`, and that every log line is JSON.

## Running under systemd

`packaging/volli-hostd.service` (also `share/systemd/` in the artifact):

```sh
sudo useradd --system --create-home --home-dir /var/lib/volli-hostd --shell /bin/bash volli
sudo mkdir -p /opt/volli-hostd
sudo tar -xzf volli-hostd-*-linux-x64.tar.gz -C /opt/volli-hostd --strip-components=1
sudo install -m 644 /opt/volli-hostd/share/systemd/volli-hostd.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now volli-hostd
sudo -u volli /opt/volli-hostd/bin/volli-hostd status --data-dir /var/lib/volli-hostd
```

- **A dedicated service user** (`User=volli`). The key and the data belong to
  it; nothing runs as root.
- **`StateDirectory=volli-hostd` with `StateDirectoryMode=0700`** and
  `UMask=0077`. The adapter checks only the key file, so a data directory
  others could write would let them rename the key or the store away (denial
  of service, not disclosure).
- **`RestartPreventExitStatus=78`**: a boot refusal waits for the operator.
- **Hardening** that leaves git, Node and a shell working: `NoNewPrivileges`,
  `PrivateTmp`, `PrivateDevices`, `ProtectSystem=full`, the kernel and
  control-group protections. Not `MemoryDenyWriteExecute` (V8's JIT).

### The secret key

By default the key is created at `/var/lib/volli-hostd/session-secrets.key`
the first time a Project or Always secret is saved. To keep it out of the data
directory (so a copy of the data directory does not carry it), provision it
yourself and point `VOLLI_SECRET_KEY_FILE` at it:

```sh
(umask 077 && openssl rand -base64 32 > key)   # private from its first byte
sudo install -d -o volli -g volli -m 700 /etc/volli-hostd
sudo install -o volli -g volli -m 600 key /etc/volli-hostd/session-secrets.key
shred -u key
# then uncomment Environment=VOLLI_SECRET_KEY_FILE=... in the unit
```

`install -o volli -m 600` matters: hostd, like ssh with a private key, refuses
a key file owned by another user or readable by group or others.

**Do not use `LoadCredential=` for it.** systemd writes credential files owned
by root, and recent versions grant the service user read access through an
ACL, which shows up as group permission bits. hostd refuses both, by design:
the key must belong to the user hostd runs as and to nobody else.

On a filesystem that cannot make hard links (some FUSE, s3fs and container
volumes), hostd cannot create the key atomically and says so with
`no-hard-links`. Create it by hand instead, as above or with
`(umask 077 && openssl rand -base64 32 > key)`; creation only runs when the
file is absent. See `docs/secrets.md`, "Headless hosts".

## Running under launchd (macOS)

`packaging/com.volli.hostd.plist` is a user agent template: replace
`/Users/YOU` and the install path, then
`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.volli.hostd.plist`.
`launchctl bootout` sends `SIGTERM`. Never point hostd at the desktop app's
own data directory while the app runs: both would serve one database.

## Tests

`vp test run --coverage` from this directory: boot, refusals, the
newer-version database, shutdown faults and the status check, against real
data directories, the real host-core and a real socket, at 100% coverage of
`src/` except `main.ts` (the process shell, which CI's artifact boot drives).
