# Runbook: a Volli host on an Ubuntu box (M1)

This is how to stand up `volli-hostd` on a fresh Ubuntu server and run the M1
demo over SSH with the `volli` CLI:

1. Register a small test repository.
2. Create a Ticket.
3. Start a Session with a real model.
4. Disconnect while the agent works.
5. Come back to a finished Session whose branch was pushed.

It is written for a Hetzner CX box (x86-64, 4 vCPU, 8 GB) on Ubuntu 24.04,
and it works the same on any systemd distribution with glibc 2.36 or later.
Commands marked `box$` run on the box as your own login (here `alice`); `sudo`
is shown where root is needed. Commands marked `mac$` run on your own machine.

Desktop is not involved. Nothing here touches your Mac's Volli profile, its
Keychain items or its `~/.pi/agent/auth.json`.

The reference for every hostd behavior named here is
[`apps/hostd/README.md`](../../apps/hostd/README.md). This page is the order to
do things in.

## What you need ready

| What                    | Detail                                                                                                                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The box                 | Ubuntu 24.04 x86-64, SSH as a login with `sudo`. 2 GB free disk is plenty.                                                                                                                |
| The hostd artifact      | `volli-hostd-<version>-linux-x64.tar.gz` and its `.sha256`: the `volli-hostd-linux-x64` artifact of a green CI run on `main` (or a PR you want to try).                                    |
| A small test repository | On GitHub (or any git host), **not** a Mac-only project: a README and a source file or two is enough. The agent will push one branch to it.                                                 |
| Push credentials        | A **deploy key with write access** to that one repository (made on the box below), or a fine-grained token limited to it with Contents: read and write.                                    |
| A model sign-in         | An API key for one provider (simplest), or an OAuth sign-in made **for the box** (see [Model sign-in](#5-sign-in-to-a-model-provider)). Not a copy of your Mac's `auth.json`.               |

## 1. Prepare the box

```sh
box$ sudo apt-get update && sudo apt-get install -y git jq ca-certificates
box$ ldd --version | head -1        # glibc 2.39 on 24.04; the artifact needs 2.36+
```

hostd brings its own Node; do not install one for it. `git` is what Sessions
commit and push with, and `jq` only reads the logs.

**Optional: Tailscale, for SSH only.** If you would rather not expose port 22,
install Tailscale (`curl -fsSL https://tailscale.com/install.sh | sh`, then
`sudo tailscale up --ssh`) and SSH to the box's tailnet name. hostd listens on
nothing but a Unix socket, so there is no port to open for it. Attaching the
desktop app to this host is M2; in M1 you drive it over SSH.

## 2. Install the artifact

Download it from the CI run (on your Mac, with `gh`), copy it over and check
it:

```sh
mac$ gh run download <run-id> -R hussainph/volli-code -n volli-hostd-linux-x64 -D hostd-artifact
mac$ scp hostd-artifact/volli-hostd-* box:
box$ sha256sum -c volli-hostd-*-linux-x64.tar.gz.sha256        # must print: OK
```

Install it root-owned. `--no-same-owner` matters: the archive records the CI
builder's uid, and without it whoever holds that uid on the box could rewrite
`bin/node`.

```sh
box$ sudo mkdir -p /opt/volli-hostd
box$ sudo tar -xzf volli-hostd-*-linux-x64.tar.gz -C /opt/volli-hostd \
       --strip-components=1 --no-same-owner
box$ sudo /opt/volli-hostd/bin/node /opt/volli-hostd/lib/probe-natives.cjs   # natives load
box$ sudo ln -sf /opt/volli-hostd/bin/volli /opt/volli-hostd/bin/volli-hostd /usr/local/bin/
box$ volli-hostd --version
```

## 3. The service user, the `volli` group and you

hostd and every Session it starts run as one unprivileged account, `volli`.
Its home is the data directory, `/var/lib/volli-hostd`.

```sh
box$ sudo useradd --system --create-home --home-dir /var/lib/volli-hostd --shell /bin/bash volli
box$ sudo chmod 700 /var/lib/volli-hostd
box$ sudo usermod -aG volli alice          # you: reach the socket
```

Log out and back in so the group applies (`id` lists `volli`). The group gives
you the socket and nothing in the data directory, which stays `0700`.

**What lives where**, because `HOME` is the data directory:

| Path                                       | What                                                                 |
| ------------------------------------------ | -------------------------------------------------------------------- |
| `/var/lib/volli-hostd/volli.db`            | The board and the Session ledger (SQLite, WAL).                      |
| `/var/lib/volli-hostd/pi-sessions/`        | Session transcripts.                                                 |
| `/var/lib/volli-hostd/hostd-status.json`   | Health, read by `volli-hostd status`.                                |
| `/var/lib/volli-hostd/.pi/agent/auth.json` | The model sign-in (Pi's, step 5).                                    |
| `/var/lib/volli-hostd/.ssh/`               | The push key (step 6).                                               |
| `/var/lib/volli-hostd/.volli/worktrees/`   | Ticket worktrees: `<repo>-<id>/<TICKET>-<slug>`, one branch each.    |
| `/srv/volli/<repo>`                        | The project checkouts you register (step 6).                         |
| `/run/volli-hostd.sock`                    | The agent socket, bound by systemd as root (`root:volli 0660`).      |

Nothing hostd or a Session needs lives under `/home`, so the unit sets
`ProtectHome=yes`: hostd and every agent cannot see `/home`, `/root` or
`/run/user` at all, which also keeps your operator token out of their reach
twice over. **So do not register a project under your own home directory**:
hostd would answer that the folder does not exist. Keep checkouts in
`/srv/volli`.

A copy of `/var/lib/volli-hostd` carries the model sign-in and the push key,
and the secret key too if it is at its default path (step 4). Never sync it
anywhere less trusted than the box itself.

## 4. The systemd units, and the secret key

```sh
box$ sudo install -m 644 /opt/volli-hostd/share/systemd/volli-hostd.service \
       /opt/volli-hostd/share/systemd/volli-hostd.socket /etc/systemd/system/
```

The units are templates that already fit this layout: `User=volli`,
`StateDirectory=volli-hostd` with `StateDirectoryMode=0700`, `UMask=0077`, the
socket at `/run/volli-hostd.sock` (`root:volli 0660`), and
`RestartPreventExitStatus=78` (a boot refusal waits for you rather than
looping).

**The secret key** seals Session environment secrets (`docs/secrets.md`,
"Headless hosts"). The M1 demo saves none, so you may skip this and let hostd
create the key at `/var/lib/volli-hostd/session-secrets.key` the first time one
is saved. If the data directory is ever copied anywhere, keep the key off it:

```sh
box$ (umask 077 && openssl rand -base64 32 > key)          # private from its first byte
box$ sudo install -d -o volli -g volli -m 700 /etc/volli-hostd
box$ sudo install -o volli -g volli -m 600 key /etc/volli-hostd/session-secrets.key
box$ shred -u key
box$ sudo systemctl edit volli-hostd       # add the two lines below, save
[Service]
Environment=VOLLI_SECRET_KEY_FILE=/etc/volli-hostd/session-secrets.key
```

A drop-in survives upgrades that replace the unit file. Owner `volli` and mode
`600` are not optional: hostd refuses a key another user owns or that group or
others can read (`refused`), and so does not use `LoadCredential=`.

Start it:

```sh
box$ sudo systemctl daemon-reload
box$ sudo systemctl enable --now volli-hostd.socket volli-hostd
box$ sudo -u volli volli-hostd status --data-dir /var/lib/volli-hostd | jq '{verdict, state: .status.state, capabilities: .status.capabilities, credentials: .status.credentials}'
```

Success is `"verdict": "serving"` with `board`, `sessions` and `automations`
`available` (terminals and browser are `unavailable` in M1), and credentials
`empty` (or `ready`).

## 5. Sign in to a model provider

Sessions run on Pi, which reads its sign-ins from
`$HOME/.pi/agent/auth.json` of the account hostd runs as:
`/var/lib/volli-hostd/.pi/agent/auth.json`. It is separate from Volli's sealed
secrets, and it must belong to `volli` and be private to it.

**An API key (simplest).** For Anthropic:

```sh
box$ sudo -u volli install -d -m 700 /var/lib/volli-hostd/.pi /var/lib/volli-hostd/.pi/agent
box$ sudo -u volli sh -c 'umask 077; cat > /var/lib/volli-hostd/.pi/agent/auth.json' <<'EOF'
{ "anthropic": { "type": "api_key", "key": "sk-ant-..." } }
EOF
```

The key is the provider id from `volli model list` (`anthropic`, `openai`, …).

**Or an OAuth sign-in made for the box.** Do not copy your Mac's
`~/.pi/agent/auth.json`: both machines would then refresh one grant, and the
first refresh on either logs the other out (your desktop included). Make a
separate grant instead, on your Mac, in an empty folder:

```sh
mac$ mkdir -m 700 box-login && cd box-login
mac$ npx -y @earendil-works/pi-ai@1.0.0 login anthropic      # opens a browser; writes ./auth.json
mac$ scp auth.json box:
box$ sudo -u volli install -d -m 700 /var/lib/volli-hostd/.pi /var/lib/volli-hostd/.pi/agent
box$ sudo install -o volli -g volli -m 600 auth.json /var/lib/volli-hostd/.pi/agent/auth.json && shred -u auth.json
mac$ rm -P auth.json
```

No restart is needed: Pi reads the file when a Session asks. Check it once
`VOLLI_SOCKET` is set (step 7; reads need only the group):

```sh
box$ volli model list | head -20        # your provider: "available", with its models
```

## 6. Git: the push key and the checkout

The agent commits and pushes as `volli`, with `volli`'s git identity and key.

```sh
box$ sudo -u volli -H git config --global user.name "Volli on box"
box$ sudo -u volli -H git config --global user.email "you+volli-box@example.com"
box$ sudo -u volli -H install -d -m 700 /var/lib/volli-hostd/.ssh
box$ sudo -u volli -H ssh-keygen -t ed25519 -N "" -C "volli@box" -f /var/lib/volli-hostd/.ssh/id_ed25519
box$ sudo cat /var/lib/volli-hostd/.ssh/id_ed25519.pub
```

Add that public key to the test repository as a **deploy key with write
access** (GitHub: the repository's Settings → Deploy keys → Add, tick "Allow
write access"). It reaches that one repository and nothing else.

Then clone it, as `volli`, into `/srv/volli`:

```sh
box$ sudo install -d -o volli -g volli -m 750 /srv/volli
box$ sudo -u volli -H env GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=accept-new" \
       git clone git@github.com:<you>/<test-repo>.git /srv/volli/<test-repo>
box$ sudo -u volli -H git -C /srv/volli/<test-repo> push --dry-run origin HEAD   # must not ask for anything
```

The clone records GitHub's host key in `volli`'s `known_hosts`, so the agent's
push later is not stopped by a prompt nobody can answer.

**A fine-grained token instead**, over HTTPS: limit it to this repository with
Contents read and write, clone `https://github.com/<you>/<test-repo>.git`, and
store it for `volli` only:

```sh
box$ sudo -u volli -H git config --global credential.helper store
box$ sudo -u volli -H sh -c 'umask 077; printf "https://x-access-token:%s@github.com\n" "<token>" > ~/.git-credentials'
```

Use `sudo -u volli -H git -C /srv/volli/<test-repo> …` whenever you look at the
checkout yourself: as `alice`, git refuses a repository another user owns
("dubious ownership").

## 7. Your operator token

On a fresh host the board is empty and there is no UI. An operator token makes
you, at the box's shell, the person: you can register projects, create Tickets
and start Sessions. Root issues it, the service account cannot.

```sh
box$ sudo volli-hostd operator-token --for alice
box$ echo 'export VOLLI_SOCKET=/run/volli-hostd.sock' >> ~/.bashrc && . ~/.bashrc
box$ volli project list            # reads work for anyone in the group
```

The token is in `~/.config/volli/operator-token` (`0600`, yours). hostd reads
the operators file on every request that carries a token, so no restart is
needed; its boot line `no operators file` only means none existed yet. The CLI
sends it only to a socket root owns, which `/run/volli-hostd.sock` is.
`sudo volli-hostd operator-token --revoke alice` revokes it from the next
request.

## 8. The demo

Register the repository and create a Ticket:

```sh
box$ volli project add /srv/volli/<test-repo> --name Demo
box$ volli ticket create --project Demo --title "Add a greeting" \
       --body "Add GREETING.md with one friendly line." --status doing
```

`project add` prints the project with its prefix (here `DE`), its path and its
base branch; `ticket create` prints `DE-1`.

Pick a model from `volli model list` and start the Session. The kickoff says
what done means, push and the signal included:

```sh
box$ volli session start DE-1 --model anthropic/claude-sonnet-4-5 --title "Box demo" \
       -m "Add GREETING.md with one friendly line. Commit it, push your branch with 'git push -u origin HEAD', then run 'volli session done --reason pushed'."
```

It answers at once with the Session's short id and `ready`: the Session exists,
its worktree is cut, and the first turn is running on the box. Look in once:

```sh
box$ volli session peek <id>          # the chat's tail: what the agent is doing now
```

**Now disconnect** while it works: close the terminal, or type `~.` at the
start of a line to drop SSH. Nothing on the box depends on your connection;
the CLI only ever asked and returned.

**Come back** a few minutes later with a new SSH session:

```sh
box$ volli session list --project Demo  # the Session, now idle
box$ volli session answer <id>          # state: completed, and the agent's final message
box$ volli session peek <id> --lines 30 # the turn: [write], [bash] … and the final message
box$ volli session show <id>            # who started it, model, cost
box$ volli ticket events DE-1           # created, session_started, worktree_changed
box$ volli ticket show DE-1 --json | jq '{worktreePath, branch}'
box$ sudo -u volli -H git -C /srv/volli/<test-repo> ls-remote origin 'volli/*'   # the pushed branch
```

The dry run's answers, for comparison (the Session id differs):

```text
$ volli session list --project Demo
da2f9efc  chat  idle  last 1s  DE-1  anthropic/claude-sonnet-4-5 · medium  ~<$0.01  75  Box demo
$ volli session answer da2f9efc
da2f9efc  completed  ticket  turns 1  Box demo
…final message: Added GREETING.md, committed, pushed the branch and signalled done.
$ sudo -u volli -H git -C /srv/volli/demo ls-remote origin 'volli/*'
7ae4cc3067e94a9d63d049404c8b76cc39b97bdc	refs/heads/volli/DE-1-add-a-greeting
```

Success is all of:

- `session answer` says `completed`.
- The branch `volli/DE-1-add-a-greeting` is on the remote (also on GitHub's
  branch list), with a commit adding `GREETING.md` by "Volli on box".
- The agent's `volli session done` worked: run *inside* the Session, it
  reaches this host's socket and prints `<id>  done`. The signal is recorded in
  the Session's ledger (the Linux smoke asserts it), but in M1 no CLI read
  prints it back to you: look for it in the agent's final message, or in a
  Ticket comment holding its todo list when it kept one.

Record the result on VC-541.

## Troubleshooting

**Logs** are one JSON object per line:

```sh
box$ sudo journalctl -u volli-hostd -o cat | jq -rR 'fromjson? | [.ts, .level, .msg] | @tsv'
box$ sudo journalctl -u volli-hostd -o cat -f | jq -cR 'fromjson? | select(.level != "debug")'
box$ systemctl status volli-hostd volli-hostd.socket
```

`VOLLI_HOSTD_LOG_LEVEL=debug` in a drop-in adds per-event lines.

**CLI error codes.** Read the code, not the generic "next" line (it is
written for the desktop app; on a box there is no `volli app launch`).

| Code                  | On this box it means                                                                                                                                                                                                                                            |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_UNREACHABLE` (3) | The CLI could not talk to hostd. `VOLLI_SOCKET` is unset or wrong (`echo $VOLLI_SOCKET`), hostd is not running (`systemctl status volli-hostd`, `volli-hostd status`), or you are not in the `volli` group yet (`id`; log in again after `usermod`).                     |
| `WRONG_DOOR`          | The verb is not one the shell runs for this caller. For `session start` it means no operator token was sent: the token file is missing, or not `0600` and yours (the CLI says why on stderr), or `VOLLI_SESSION`/`VOLLI_SESSION_TOKEN` are set in your shell.        |
| `FORBIDDEN_ACTOR`     | A write without a valid operator token: not issued, revoked, or not sent (see stderr). Reads still work.                                                                                                                                                          |
| `DB_UNAVAILABLE`      | hostd is up but its database did not open (`refusing`). `volli-hostd status` carries the reason, for instance a database from a newer Volli after a downgrade.                                                                                                      |
| `INVALID_REQUEST` on `project add` | The folder does not exist **for hostd**: under `/home` (hidden by `ProtectHome=yes`), or not readable by `volli`.                                                                                                                                     |

**A Session that will not start.** A missing model or credential is a refusal
naming it, not a silent fallback: check `volli model list` (is the provider
`available`?) and the owner and mode of `auth.json` (`volli`, `600`).

**A push that failed** shows in `volli session peek <id>` or the answer. As
`volli`: `sudo -u volli ssh -T git@github.com` (a deploy key answers with the
repository's name), and the `push --dry-run` from step 6.

**Saved credentials** (`credentials` in `volli-hostd status`). None of these
stop the board or secret-independent Sessions, such as this demo:

| State     | Meaning and fix                                                                                                                                                                                          |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `empty`   | Nothing sealed yet. Normal for the demo.                                                                                                                                                                 |
| `ready`   | Sealed secrets open.                                                                                                                                                                                     |
| `locked`  | The key is missing, a different key, malformed or unreadable by `volli`. Put the right key back and restart.                                                                                             |
| `refused` | The key file is unsafe: group or other access, another owner, not a regular file, or a relative `VOLLI_SECRET_KEY_FILE`. Fix with `install -o volli -g volli -m 600` and restart. hostd never reads it. |
| `corrupt` | The key opens, the store does not authenticate.                                                                                                                                                          |

When the key is gone for good (`locked` or `corrupt` will not come back), set
the stored secrets aside and start over, with hostd stopped and the unit's
`VOLLI_SECRET_KEY_FILE` in the environment (omit it if you never set one):

```sh
box$ sudo systemctl stop volli-hostd.socket volli-hostd
box$ sudo -u volli env VOLLI_SECRET_KEY_FILE=/etc/volli-hostd/session-secrets.key \
       volli-hostd credentials reset --data-dir /var/lib/volli-hostd          # says what it found
box$ sudo -u volli env VOLLI_SECRET_KEY_FILE=/etc/volli-hostd/session-secrets.key \
       volli-hostd credentials reset --data-dir /var/lib/volli-hostd --yes    # sets it aside
box$ sudo systemctl start volli-hostd.socket volli-hostd
```

It moves the store aside (never deletes it) and prints the `mv` that undoes
it. `refused` cannot be reset: fix the key file instead.

**Exit 78** in `systemctl status`: a boot refusal (data directory another user
owns or can write, another hostd on the same data directory, an unsafe
operators file). The first error line in the journal names it and the fix;
systemd will not restart until you fix it and `systemctl start` again.

## Backups

**What exists today:** nothing automatic. hostd does not yet run the backup,
retention and maintenance loops desktop has (VC-618); they come to hostd with
VC-627, together with the `volli-backup` bundle (VC-283, `docs/backup-bundle.md`)
on this host. Until then, take a cold copy with hostd stopped, so SQLite's WAL
is folded in:

```sh
box$ sudo systemctl stop volli-hostd.socket volli-hostd
box$ sudo tar -C /var/lib -czf /root/volli-hostd-$(date +%F).tar.gz volli-hostd
box$ sudo systemctl start volli-hostd.socket volli-hostd
```

Stop the socket too: while it listens, any `volli` call starts hostd again in
the middle of the copy.

It is as sensitive as the box: it holds the model sign-in, the push key and,
at its default path, the secret key. It also holds the Ticket worktrees, so
unpushed work is in it. Keep it root-only (`/root` is `0700`), and to restore,
stop hostd and untar it back in place. The demo itself needs no backup.

## Upgrades

hostd migrates its database forward at boot, and a database from a newer Volli
refuses to open in an older one (left untouched, state `refusing`). So take
the cold copy above first, then:

```sh
box$ sha256sum -c volli-hostd-*-linux-x64.tar.gz.sha256
box$ sudo systemctl stop volli-hostd.socket volli-hostd
box$ sudo rm -rf /opt/volli-hostd.old && sudo mv /opt/volli-hostd /opt/volli-hostd.old
box$ sudo mkdir /opt/volli-hostd && sudo tar -xzf volli-hostd-*-linux-x64.tar.gz \
       -C /opt/volli-hostd --strip-components=1 --no-same-owner
box$ sudo install -m 644 /opt/volli-hostd/share/systemd/volli-hostd.service \
       /opt/volli-hostd/share/systemd/volli-hostd.socket /etc/systemd/system/
box$ sudo systemctl daemon-reload && sudo systemctl restart volli-hostd.socket volli-hostd
box$ sudo -u volli volli-hostd status --data-dir /var/lib/volli-hostd | jq .verdict
```

Your drop-ins (`systemctl edit`) stay. To roll back, put
`/opt/volli-hostd.old` back and restore the cold copy if the new version had
migrated the database.

## Running in the foreground

For a quick look without systemd (it is not the supported layout: hostd runs
as you, so your operator token does not separate you from its Sessions), run
it under `umask 077`, or `volli.db` is created world-readable. Steps 1–3, 5
(your own `~/.pi/agent/auth.json`) and 7 still apply: you need the `volli`
group even here, because hostd, now running as you, reads
`/etc/volli-hostd-operators` (`root:volli 0640`) to accept your token.

```sh
box$ (umask 077 && volli-hostd --data-dir ~/volli-hostd-data)
box$ VOLLI_SOCKET=~/volli-hostd-data/volli.sock volli project list
```

From a source checkout instead of the artifact, see "Running from source" in
`apps/hostd/README.md`.

## What M1 does not cover

- Attaching the desktop app (or a phone) to this host: M2.
- Terminals and the browser tools: `unavailable` (VC-568, VC-619).
- Automatic backups and maintenance: VC-627.
- Soaking the stricter sandboxing (`SystemCallFilter=@system-service`,
  `ProtectSystem=strict`, `ProtectProc=invisible`, `PrivateIPC=yes`) against
  real Sessions and terminals: after VC-568.
