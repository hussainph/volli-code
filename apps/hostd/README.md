# volli-hostd

The headless Volli host (VC-562, Volli Cloud M1). It composes
`@volli/host-core` with headless ports, opens and migrates the database, and
serves the agent Unix socket, so the `volli` CLI works against it unchanged.
No window, no Electron: `scripts/check-host-electron-imports.mjs` gates this
directory.

```sh
volli-hostd --data-dir /var/lib/volli-hostd [--socket <path>] [--operators <file>]
volli-hostd status --data-dir /var/lib/volli-hostd
sudo volli-hostd operator-token --for <login> | --revoke <login>
VOLLI_SOCKET=/var/lib/volli-hostd/volli.sock volli project list
```

## What it serves today

| Capability    | State         | Arrives with                                                                                            |
| ------------- | ------------- | ------------------------------------------------------------------------------------------------------- |
| `board`       | available     | The agent socket's verbs over the database: projects, tickets, comments, labels, conflicts, `identify`. |
| `sessions`    | available     | Shared Pi runtime, recovered Session commands and operator-only CLI `session start` (VC-622).           |
| `automations` | available     | Shared scheduler, armed arrivals and runner over the recovered Session facade (VC-622).                 |
| `terminals`   | `unavailable` | The host protocol's terminal streams (VC-568). node-pty already ships and loads.                        |
| `browser`     | `unavailable` | Standalone Chromium (VC-619).                                                                           |

Writes over the socket need an authenticated Session, or the person: an
operator at the host's shell holding a token root issued
([Operators](#operators)). That is how a fresh host's board gets its first
project (`volli project add`). Backup, retention, recovery and the maintenance loops move into host-core in
VC-618; hostd wires them once they land.

## Ports

| Port                                               | hostd passes                                                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `events`                                           | Drops each broadcast (no client is connected before M2); logs the topic at `debug`.              |
| `attention`                                        | `HEADLESS_ATTENTION` (every alert `unsupported`), plus an `info` line with its title.            |
| `power`, `connectivity`                            | `NO_POWER_EVENTS`, `ALWAYS_ONLINE`.                                                              |
| `client`, `trash`                                  | Absent: host-core refuses those requests with its typed errors.                                  |
| `log`                                              | The JSON logger.                                                                                 |
| `listOpenNativeBindings`, `observeScheduledResume` | The shared runtime's bindings and scheduled-resume observer, scoped to this host's remote venue. |

Policy: `onTransactionViolation: throwTransactionViolation` (VC-551: nobody
watches a server's log while a bug corrupts a transaction) and
`devDiagnostics: false`.

## Boot

In order; each refusal is logged as one JSON line and exits **78**
(`EX_CONFIG`), which the systemd unit does not restart:

1. **Data directory.** Created mode 0700 when absent. Refused when it is not a
   directory, when another user owns it (the key file's rule, one level up),
   or when every user can write it. Group-writable is a warning: with user
   private groups (the Debian and Ubuntu default) the group is the user alone.
   A `--socket` in a world-writable directory is a warning too.
2. **Another host.** Refused when another process holds the data directory's
   instance lock, whatever its `--socket`: an exclusive SQLite lock on
   `<data-dir>/hostd.lock`, atomic, held until stop, released by the kernel
   if the process dies. Two hosts never open one database.
3. **Secrets, eagerly, and never a refusal.** `fileSecretKey` loads lazily by
   design; a service cannot wait for the first Session to find a bad key. So
   hostd settles the key and the sealed store at boot, and a problem with
   either boots the host anyway (VC-641): losing the key never bricks a host.
   The status file's `credentials` says which, the log line
   `serving without saved credentials` carries the adapter's own sentence
   naming the fix, and stored secrets are neither used nor sealed over:

   | Condition                                                                                                                                                                          | `credentials.state`                    |
   | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
   | No sealed store, and a usable or absent key                                                                                                                                        | `empty`                                |
   | Sealed store opens                                                                                                                                                                 | `ready`                                |
   | Key missing, a different key, not one key line, unreadable by its owner (e.g. 0000); store sealed by the keychain or unreadable                                                    | `locked`                               |
   | Key file with group or other access (including 0044), owned by another user (told from its metadata when the open is denied), not a regular file; relative `VOLLI_SECRET_KEY_FILE` | `refused` (unsafe: never read for use) |
   | The key opens and the store does not authenticate                                                                                                                                  | `corrupt`                              |

   The key is checked first, so a malformed or unsafe key reports `locked` or
   `refused` even before anything is sealed.

   Put the key back or fix it, then restart. Or give the stored secrets up:
   [Credentials](#credentials).

4. **Operators.** The operator verifier file (`/etc/volli-hostd-operators`, or
   `--operators`) is refused when it is not a regular file, root does not own
   it or its directory, or its group or others can write either: whoever can
   write it can mint a person. Absent is fine: no operator token is accepted.
   An operator who shares hostd's uid is a warning (see the limitation below).
5. **The agent socket**, before the database, so a request that arrives
   during migrations waits for boot rather than being refused at connect. A
   live listener on the same path refuses this host. Under socket activation
   hostd serves the descriptor systemd passed instead (more than one is
   refused) and leaves the pathname to systemd.
6. **host-core** opens and migrates the database. A database that will not
   open is **not** a boot failure: hostd stays up in state `refusing`, every
   verb answers `DB_UNAVAILABLE` with the reason, and the status file carries
   the typed `databaseFailure`. That includes a database from a newer Volli
   (VC-602), which is left byte-identical.
7. **Session recovery**, before commands or `serving`: the shared assembly,
   facade and lifecycle reconcile this socket's remote venue, recover
   delegations and notices, then start Automations. Other hosts' and desktop's
   attachments are not closed by this host. A failed runtime startup settles
   waiting requests with `APP_UNREACHABLE`, drains what opened and exits 1.

## Session environment and model credentials

Sessions get the service's explicit `PATH`, with the artifact's `bin` first
(the shipped Node and `volli` CLI). hostd executes no login-shell rc files.
Provision project tools on that PATH in the systemd/launchd environment.
Model credentials belong to Pi: `PI_CODING_AGENT_DIR`, or `$HOME/.pi/agent`.
They are separate from Volli's sealed Session environment secrets and must
belong to the service user. A missing model or credential is a structured
start refusal, not a silent terminal fallback.

The frozen headless tool surface omits `ask_user`, `request_secret` and all
browser tools: there is no client to answer their cards and no browser port.
Background shells, MCP, Code Mode, Web Access and delegation use the shared
host services. Busy-worktree evidence includes active turns and every live
background-shell cwd, including a shell still terminating after detach; an
unreadable activity projection refuses automatic trim rather than deleting.

Locked/refused/corrupt saved secrets still permit secret-independent Sessions.
Their unavailable Session environment is reported in health; required named
secret lookup remains VC-642's service boundary, not a new hostd secret store.

## Operators

A person almost never uses the `volli` CLI: they work in the UI, and agents
use the CLI. On a headless host there is no UI yet, so the **operator token**
(VC-623) is the bootstrap and break-glass credential for the person at the
host's shell: register a project, create or move a ticket over SSH. It is the
M1 stand-in for a paired device; key-bound device credentials (the host
protocol's F5) may supersede it.

```sh
sudo volli-hostd operator-token --for alice      # issue (or reissue) alice's token
sudo usermod -aG volli alice                     # reach the socket; log in again
export VOLLI_SOCKET=/run/volli-hostd.sock        # as alice
volli project add ~/code/acme [--name Acme] [--dry-run]
volli ticket create --title "Fix auth" --project AC
volli session start AC-1 -m "Fix auth" --model anthropic/claude-opus-4-6
sudo volli-hostd operator-token --revoke alice   # revoke; holds from the next request
```

**The trust model.**

- **Root issues; nothing else can.** `operator-token` refuses to run except as
  root. It writes 256 random bits to `~alice/.config/volli/operator-token`
  (0600, in a 0700 directory, both alice's) through a child process running
  as alice, so root never follows a path alice controls. Only then does it
  record a **verifier** (the token's SHA-256) in `/etc/volli-hostd-operators`
  (root-owned, 0640, group `volli`). hostd keeps no plaintext and compares in
  constant time.
- **The service account can never become the person.** hostd and every
  Session it starts run as `volli`. That account cannot read alice's token
  file, cannot write the operators file (hostd refuses to boot if it could),
  and cannot run `operator-token`; `--for volli` is refused too, and so is any
  issue when the service account (`--service-user`, default `volli`) cannot
  be found to check against. No socket
  verb mints a token, and hostd removes `VOLLI_OPERATOR_TOKEN` from its own
  environment so no Session inherits one.
- **A Session's request is judged exactly as before.** The CLI never reads or
  sends an operator token when `VOLLI_SESSION` or `VOLLI_SESSION_TOKEN` is
  set, and the door ignores one that arrives beside either. A request with no
  token is still read-only.
- **A valid token is the person.** Its writes are attributed to `user`, the
  actor the app's own writes carry, and governed by each project's `user`
  policy. `project add` is the person's verb alone: no Session may run it,
  whatever a policy grants (`docs/plans/host-identity.md`, "Operator token").
  `session start` is likewise operator-only on the CLI: ordinary and
  Session-token callers retain `WRONG_DOOR`; the bound agent tool door is unchanged.
- **Revocation needs no restart.** hostd reads the operators file again for
  every request that presents a token, so `--revoke` (or deleting the line)
  holds from the next request. Reissuing replaces the old token.

The CLI reads `VOLLI_OPERATOR_TOKEN`, then the token file. Like ssh with a key,
it will not use a token file that another user owns or that group or others
can read, and says so on stderr.

**The socket, and why systemd binds it.** A token is a bearer secret, and the
CLI cannot authenticate the listener, so the socket's _name_ must be one the
service account cannot take over: otherwise any Session could rename the real
socket away, listen in its place and collect the next operator's token.
`volli-hostd.socket` therefore has systemd bind `/run/volli-hostd.sock` as
root, in root's `/run`, `root:volli` 0660, and pass it to hostd
(`LISTEN_FDS`); hostd serves that descriptor and never binds, renames or
removes the pathname. The `volli` group reaches it; group membership is reach,
not authority, since a caller without a token reads and never writes. On its
side, the CLI sends a token only to a socket owned by root or the caller,
through directories only root or the caller can write (sticky ones such as
`/tmp` excepted) and no symlink anyone else owns, judging every entry along
the path as typed and as resolved without following it; otherwise it warns
and sends none. Without socket activation hostd binds `<data-dir>/volli.sock`
itself at 0600, as before.

**Audit.** Every write that presented a valid token logs one line, refused or
not, naming the login, never the token:

```json
{
  "login": "alice",
  "cmd": "project.add",
  "ok": true,
  "code": null,
  "ts": "…",
  "level": "info",
  "msg": "operator write"
}
```

It does not carry the peer's `SO_PEERCRED` uid and pid: Node's `net` exposes
no peer credentials for a Unix socket, and reading them would take a native
addon. The token's login is the attribution, and the socket's group bounds who
could have connected.

**Limitation: one uid is one principal.** When the operator _is_ the account
hostd runs as (a foreground `volli-hostd` in your own shell, or the launchd
user agent), operator and Sessions are not separated: a Session can read the token file like any other
file its uid owns. hostd logs a warning at boot when an operator shares its
uid, or when it runs as root. Separation needs the systemd layout above.

## Health

hostd rewrites `<data-dir>/hostd-status.json` (atomically, mode 0600) at every
state change: `starting`, `serving`, `refusing`, `stopping`, `stopped`. It
holds paths, the pid, the version, the capabilities above and the database's
state. When the database did not open, that state includes the sentence every
verb answers with and the typed failure. `credentials` is the saved secrets'
status (`ready`, `empty`, `locked`, `refused` or `corrupt`, see [Boot](#boot))
with a typed reason and what it makes unavailable; never a key path or value:

```json
"credentials": { "state": "locked", "reason": "missing", "unavailable": ["session-env"] }
```

When the database did not open:

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
| 0    | `serving`     | Whatever `credentials` says: locked secrets are not down.    |
| 1    | `refusing`    | Up, but the database did not open: read `database`.          |
| 3    | `not-serving` | Stopped, starting, stopping, crashed, or socket unreachable. |

The host protocol (VC-564) carries the same facts to remote clients.

## Shutdown

`SIGTERM` or `SIGINT`:

1. Status `stopping`.
2. Refuse new commands, stop Automation/resume/watchdog producers and durable
   notice delivery; drain the shared Session runtime and background shells,
   then the MCP backstop and observability flush. Shell admission closes at
   drain, and every kill joins before SQLite closes.
3. Close the agent socket, waiting up to its 10 s request timeout for requests
   in flight, then wait up to 10 s for any execution still running. One that
   outlives that is abandoned and logged, and the stop is not clean.
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
  lib/probe-codemode.mjs executes the shipped sandbox worker and QuickJS wasm
  lib/node_modules/     `pnpm deploy --prod` of this package, from the lockfile
  share/systemd/volli-hostd.{service,socket}
  share/launchd/com.volli.hostd.plist
  MANIFEST.json  README.md  LICENSE
```

`package.json` `dependencies` are exactly what stays external: the natives and
jsdom. Everything else is a devDependency and bundled. `pnpm deploy --prod
--config.node-linker=hoisted` installs the externals flat, at the lockfile's
exact versions, and runs their install scripts on the build machine. Other
platforms' prebuilds are pruned; the probe then proves nothing needed went.
Code Mode's published worker package and `quickjs-wasi` are copied from the
lockfile-resolved install into `lib/node_modules`; the main bundle names their
worker/wasm paths explicitly and refuses an artifact missing either.

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

A second fresh container, as root, proves the operator token on the real
layout (`scripts/ci-operator-proof.sh`): root issues a token for a non-service
login, which registers a project and creates a ticket with the bundled CLI; a
token-less caller and a Session-token caller are refused; the `volli` account
can neither read the token nor run `operator-token`; revocation holds at once.

The build container also runs `session-runtime.integration.test.ts`: with
only the provider wire scripted, the built CLI starts a Session over the real
socket, its real `write` tool creates a file, `turn.completed` arrives and the
CLI reads the completed answer. No in-process `startSessionOperation` shortcut
counts as that proof.

The boot check unpacks the archive in a fresh container with no checkout and
no system Node on `PATH`, probes the natives, executes a Code Mode host call
through the shipped worker and wasm, boots against an empty data
directory, waits for `status` to report `serving`, lists projects through the
socket with the bundled CLI, sends `SIGTERM`, requires exit 0, status
`not-serving` (stopped), no socket and no WAL left, `PRAGMA integrity_check` =
`ok`, and that every log line is JSON.

## Running under systemd

`packaging/volli-hostd.service` (also `share/systemd/` in the artifact):

```sh
sudo useradd --system --create-home --home-dir /var/lib/volli-hostd --shell /bin/bash volli
sudo mkdir -p /opt/volli-hostd
sudo tar -xzf volli-hostd-*-linux-x64.tar.gz -C /opt/volli-hostd --strip-components=1 \
  --no-same-owner
sudo install -m 644 /opt/volli-hostd/share/systemd/volli-hostd.{service,socket} \
  /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now volli-hostd.socket volli-hostd
sudo -u volli /opt/volli-hostd/bin/volli-hostd status --data-dir /var/lib/volli-hostd
```

Then issue yourself an operator token and add a project ([Operators](#operators)).
The socket unit binds the agent socket at `/run/volli-hostd.sock`.

- **A dedicated service user** (`User=volli`). The key and the data belong to
  it; nothing runs as root.
- **The install is root's.** The archive records the CI builder's uid (1000),
  and `tar` run as root restores it, which would let whoever holds uid 1000 on
  the box rewrite `bin/node`. `--no-same-owner` makes every file root-owned;
  the service user can read and run them and cannot change them.
- **`StateDirectory=volli-hostd` with `StateDirectoryMode=0700`** and
  `UMask=0077`. The socket is elsewhere: **`volli-hostd.socket`** binds
  `/run/volli-hostd.sock` as root (`root:volli` 0660), so the `volli` group
  reaches the socket and nothing in the data directory, and no Session can
  replace it ([Operators](#operators)). The adapter checks only the key file, so a data directory
  others could write would let them rename the key or the store away (denial
  of service, not disclosure).
- **`RestartPreventExitStatus=78`**: a boot refusal waits for the operator.
- **Hardening** that leaves git, Node, node-pty and a shell working:
  `NoNewPrivileges`, `PrivateTmp`, `PrivateDevices`, `ProtectSystem=full`, the
  kernel and control-group protections, an empty `CapabilityBoundingSet=`,
  `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK`,
  `RestrictNamespaces=yes` and `SystemCallArchitectures=native`. Not
  `MemoryDenyWriteExecute` (V8's JIT).

### Credentials

When saved secrets are `locked` or `corrupt` and will not come back (the key
is gone for good), set them aside and start over, with hostd stopped and the
unit's `VOLLI_SECRET_KEY_FILE` in the environment:

```sh
sudo systemctl stop volli-hostd
sudo -u volli env VOLLI_SECRET_KEY_FILE=... /opt/volli-hostd/bin/volli-hostd \
  credentials reset --data-dir /var/lib/volli-hostd          # says what it found
sudo -u volli env VOLLI_SECRET_KEY_FILE=... /opt/volli-hostd/bin/volli-hostd \
  credentials reset --data-dir /var/lib/volli-hostd --yes    # sets it aside
sudo systemctl start volli-hostd
```

It refuses a data directory boot would refuse (another user's, or writable by
every user), and takes the instance lock, so it refuses while hostd runs. The
lock file it may leave, `hostd.lock`, is the one hostd itself creates and
keeps; it holds nothing. The move itself happens under the credential lock,
`host-credentials.lock` (VC-642), an empty file every process sharing the
store locks before it reads or writes saved secrets; it holds nothing either.
It does nothing when secrets open or there are none,
and refuses, even with `--yes`, while the key configuration is `refused`: a
reset cannot fix a relative `VOLLI_SECRET_KEY_FILE` or an unsafe key file, and
an environment typo must not move a store the right key opens.

Otherwise it moves `session-secrets.enc` to
`session-secrets.enc.locked-<time>-<random>` beside it. The move is not atomic;
it never overwrites, never deletes, and syncs the directory before removing the
old name, so a crash leaves the store under one name or both. If the directory
cannot be synced it says so. The archive is excluded from backups and stays
until you delete it. The printed, shell-quoted `mv` undoes the reset (with
hostd stopped, before anything is saved again). The next save seals under the
key file that is there, or a new one. It is never a socket verb.

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

## Upgrading and rolling back

**A box rolls back to its safety copy, not to the old binary.** (VC-633)

An upgrade is the new archive plus a restart. On the first open the new
build migrates the database, and before the migration commits it publishes
a verified copy of the database as it was: `<data-dir>/volli.db.backup-v<N>`,
where `N` is the schema the old build left. Retention keeps that copy.

- **Free space first.** A migration needs about twice the database free on the
  data directory's volume: a safety copy, then the rewrite (compaction is a
  full VACUUM). The host checks this with `statfs` before writing anything.
  When there isn't room, it stays up in `refusing`, every verb answers
  `DB_UNAVAILABLE`, and the log line says how much it needs, how much is free
  and that nothing was changed. Free the space and restart.
- **Why not just reinstall the old archive.** If the new build's migrations
  raised the database's floor (`raisesMinReader`), the old build refuses the
  file as "from a newer version of Volli" and leaves it untouched. If they
  didn't, the old build runs against a schema it doesn't know. That's allowed,
  and CI's N-1 lanes test it, but anything the newer build derives is stale
  until you upgrade again. Either way, only the safety copy is exactly the
  database the old build last wrote.
- **What a rollback loses.** Everything written since the upgrade: tickets,
  comments, Sessions and their history. If you need any of it, make a backup
  bundle with the new build before you roll back.

To roll back (systemd layout above; `N` from the file name):

```sh
sudo systemctl stop volli-hostd volli-hostd.socket
cd /var/lib/volli-hostd
# Set the migrated database aside. Never delete it; it is the only copy of what
# was written since the upgrade.
stamp=$(date +%Y%m%d-%H%M%S)
for f in volli.db volli.db-wal volli.db-shm; do
  [ -e "$f" ] && sudo -u volli mv "$f" "$f.rolled-back-$stamp"
done
# Copy the safety copy, don't move it: it stays the rollback point.
sudo -u volli cp volli.db.backup-vN volli.db
sudo -u volli sqlite3 volli.db 'PRAGMA integrity_check; PRAGMA user_version;'  # ok, N
# Reinstall the previous archive over /opt/volli-hostd (as in the install above),
# then start it.
sudo systemctl start volli-hostd.socket volli-hostd
sudo -u volli /opt/volli-hostd/bin/volli-hostd status --data-dir /var/lib/volli-hostd
```

Credential files (`host-credentials.*`, the secret key) are not in the
database and stay where they are. The old build reads its keys from the
database it was given.

## Running under launchd (macOS)

`packaging/com.volli.hostd.plist` is a user agent template: replace
`/Users/YOU` and the install path, then
`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.volli.hostd.plist`.
`launchctl bootout` sends `SIGTERM`. A user agent runs as you, so an operator
token there does not separate you from the host's Sessions
([Operators](#operators), the limitation). Never point hostd at the desktop app's
own data directory while the app runs: both would serve one database.

## Tests

`vp test run --coverage` from this directory: boot, refusals, a lost, wrong,
malformed or unsafe key and a corrupt secret store against real board and
Session history (`lost-key.test.ts`), the
newer-version database, shutdown faults, the status check, and the operator
token (issue, revoke, the verifier file's refusals, and an operator
registering a project and creating a ticket over the socket while token-less
and Session-token callers are refused), against real
data directories, the real host-core and a real socket, at 100% coverage of
`src/` except `main.ts` (the process shell, which CI's artifact boot drives).
