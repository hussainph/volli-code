# volli-drive: unprivileged localhost SSH fixture (VC-703 / VC-700)

## Result

**The bundled macOS sshd runs successfully without root or Remote Login.** The
prototype connected as the current user using scratch-only credentials and
returned `ok\nDarwin\n`. It started no hostd, installed no services, and changed
no user SSH files, keychain settings, Remote Login settings, or system files.

This proves an SSH transport fixture, **not the complete Add a host flow**.
VC-700's researched provisioning stack is Linux/systemd-only, and its current
probe invokes `sudo -n true` even on Darwin. Under this spike's rules, do not
run that probe unchanged against this Mac.

Owned deliverables:

- `apps/desktop/e2e/volli-drive/lib/sshd-fixture.mjs`
- `apps/desktop/e2e/volli-drive/lib/sshd-fixture.test.mjs`
- this document

## What the product actually does

### Which source was researched

At this worktree's starting HEAD, `packages/host-install` and the Add a host
bridge/UI are not present. `git log --all --oneline --grep='VC-700\|SSH\|ssh'`
found the in-flight stack. Read it with `git show`, without checking out or
editing another worktree:

- `7224c18ef`: VC-700 PR 1a, hostd managed install/start/enroll/status.
- `cc7b850c2`: VC-700 PR 1b, system SSH provisioning/tunnel package.
- `c7615bffe`: stack merge; the ticket reports PRs #801 and #802 and says the
  pairing/UI follow-ups wait for VC-608.

Line references to `packages/host-install` below mean the `cc7b850c2` tree,
not files already shipped in this worktree. Existing release files are from
this worktree. `volli ticket show VC-700` confirms the intended flow uses the
person's own SSH config and agent, then Linux system/user service installation.

### Client SSH and trust

- `packages/host-install/src/ssh.ts:115–136,200–247`: Node `spawn` invokes the
  system `ssh` via PATH, not an SSH library. `sshPath`, `spawn`, and `controlDir`
  are injected options. The live spawn inherits the environment.
- No `-F` is passed: ordinary invocations honor the person's SSH config,
  IdentityFile, agent, ProxyJump and known_hosts. Runner options add BatchMode,
  strict host-key checking, connection/alive timeouts, no agent/X11 forwarding,
  cleared configured port forwarding, and a ControlMaster socket. Disabling
  agent *forwarding* does not disable local agent authentication.
- `target.ts:1–50`: destination can be `user@host`, `user@host:port`, or a config
  alias; `targetArgs` emits `-p <port> -- <destination>`. This fixture can be
  addressed as `phalasiya@127.0.0.1:<port>` on the measured machine. Do not put
  SSH flags in the text field. `sshConfigHosts` parses supplied config text;
  harness UI integration must supply scratch config or suppress real discovery.
- `ssh.ts:266–317`: unknown-host discovery disables all authentication and
  agents, writes offered host keys to a temporary known_hosts using
  `StrictHostKeyChecking=accept-new`, and fingerprints with `ssh-keygen -l`.
  It still reads ordinary SSH config; ProxyJump may authenticate separately.
- `ssh.ts:325–350`: accepting host keys runs `ssh -G`, reads the resolved first
  UserKnownHostsFile, then appends accepted entries there. Its fallback is the
  person's `~/.ssh/known_hosts`; therefore isolate this path too.
- `tunnel.ts`: the tunnel is a separate `ssh -N -T -L
  127.0.0.1:<local>:127.0.0.1:<remote>` process, with its own sshPath/spawn seam,
  strict checking, no multiplexing, alive checks and reconnect backoff. Policy
  injection into command execution alone does not isolate the tunnel.

### Bootstrap, services, and supported targets

- `probe.ts:61–95` runs one POSIX shell script for kernel/arch, `/etc/os-release`,
  systemd user manager, lingering, glibc, free space, memory, sudo and existing
  hostd status. **It includes `sudo -n true` at line 81** (and additional sudo
  calls when checking a system hostd). This research did not execute the probe.
- `probe.ts:170–175` maps only Linux x86_64/amd64 and aarch64/arm64.
  `provision.ts:394–409` rejects non-Linux as `unsupported-system`, missing
  systemd as `no-systemd`, and old glibc. Merely enabling another supported
  target does not remove those checks.
- `artifact.ts`: tarball must exactly match the desktop version and signed
  app's hostd-release pin SHA256. Missing/empty pin permits only an explicit
  development tarball checked against its local sidecar, not release fallback.
  The default dev supported-target list contains only `linux-x64`; release
  support is derived from pin assets (Linux x64 and arm64).
- `provision.ts:474–549`: tarball is uploaded through **ssh stdin to `cat`**,
  not scp or sftp, to `$HOME/.cache/volli-hostd/<tarball>.part`, verified with
  `sha256sum`, renamed, unpacked with GNU-style tar options, and version-checked.
- PR 1a's `apps/hostd/src/install.ts` writes systemd units and invokes systemctl;
  system mode creates a dedicated `volli` account using useradd. User mode
  shares the login account. `start.ts` requires a systemd user manager and
  lingering; provisioning can request sudo to enable lingering. Enroll trusts
  the desktop's device public key and returns host identity/listen information;
  system-mode enrollment executes as the service account over sudo.
- `.github/workflows/release.yml:270–330` builds hostd only on native Linux x64
  and arm64 runners. `scripts/hostd-release-manifest.mjs:27–60` requires exactly
  those two Linux assets; Darwin is not published or accepted by this manifest.
- Important distinction: hostd itself supports macOS, and
  `apps/hostd/scripts/package.mjs:71–73` uses `process.platform/process.arch`
  rather than hard-coding Linux. Its archive includes a launchd template;
  `apps/hostd/README.md:797–804` documents manual macOS user-agent placement.
  That is **not** implemented Darwin managed provisioning or a published
  Darwin release. No Darwin hostd build was attempted here.

## Fixture design and implemented lifecycle

`startSshdFixture({ dir })` returns `{ host, port, user, identityFile,
knownHostsFile, sshArgs, stop }`. A caller supplies a fresh 0700 directory and
removes it only after stopping its SSH clients and `stop()`.

The implementation:

1. Rejects root/non-macOS and unreviewed login shells; requires a non-symlink,
   current-user-owned 0700 directory. Generates two Ed25519 key pairs with
   `/usr/bin/ssh-keygen -t ed25519 -N '' -f <scratch>/<key>` and bounded execution.
   Files are reserved exclusively so pre-existing files are never overwritten.
2. Copies only the client public key into a 0600 authorized_keys. Pre-seeds a
   0600 known_hosts with the actual generated host public key:
   `[127.0.0.1]:<port> ssh-ed25519 <public-key>`. No keyscan, TOFU or real agent.
3. Obtains an ephemeral port by briefly binding `127.0.0.1:0`, then closes the
   allocator. sshd binds only IPv4 loopback; a port allocation race is a startup
   failure, not an excuse to change settings or bind more broadly.
4. Checks config using `/usr/sbin/sshd -t -f <scratch>/sshd_config -p <port>`,
   then starts `/usr/sbin/sshd -D -e -f <scratch>/sshd_config -p <port>`.
5. Waits at most 10 seconds for sshd's loopback listening log, retains bounded
   stderr, and fails with the actual exit/error. No privileged fallback.
6. `stop()` signals only its own ChildProcess PID, waits 2 seconds, and if
   necessary signals that same process with SIGKILL and waits another 2 seconds.
   It is idempotent. Startup failure also calls stop. Callers own all client/
   tunnel processes separately and must drain them before stopping the server;
   a master PID is not a kill-by-name broom for arbitrary session children.

Representative config (the implementation adds further explicit limits):

```text
ListenAddress 127.0.0.1
HostKey <scratch>/host_ed25519
AuthorizedKeysFile <scratch>/authorized_keys
PidFile <scratch>/sshd.pid
UsePAM no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AuthenticationMethods publickey
StrictModes yes
AllowUsers <current-user>
PermitRootLogin no
PermitUserEnvironment no
PermitUserRC no
HostbasedAuthentication no
UseDNS no
AllowAgentForwarding no
X11Forwarding no
AllowTcpForwarding local
PermitOpen 127.0.0.1:*
GatewayPorts no
PermitTunnel no
PermitTTY no
Subsystem sftp /usr/libexec/sftp-server
SetEnv HOME=<scratch> ZDOTDIR=<scratch>
```

`/usr/libexec/sftp-server` exists and is executable on this Mac, although the
positive test does not exercise SFTP. `internal-sftp` is another possible choice;
VC-700's present upload doesn't need either subsystem.

### Permissions and non-root limitations

The installed `man sshd` documents explicit host keys for non-root execution;
`man sshd_config` states that UsePAM=yes prevents running sshd as non-root. We
use a scratch HostKey, UsePAM=no and the unchanged built-in privilege-separation
behavior. There is no attempt to disable privilege separation, create/change
`/var/empty`, or change the daemon's user. A non-root daemon cannot become another
account or install services as root. AllowUsers restricts this fixture to the
account it already runs as.

StrictModes remains **yes** and passed here. Scratch directory/key ownership
and all relevant path components must satisfy OpenSSH's checks. If another
location fails those checks, report its exact error rather than chmodding the
person's directories or disabling safety checks. Private keys/config/authorized
keys/known_hosts are 0600; the test's mkdtemp directory is 0700.

This is account-level transport isolation, not filesystem/process isolation.
An arbitrary remote command still has the current user's authority. SetEnv HOME
and ZDOTDIR keep ordinary writes and the current zsh's user startup files in the
scratch tree; PermitUserRC=no and PermitUserEnvironment=no prevent SSH user rc
and environment file reads. System shell startup policy still applies. Never
point the fixture at the live desktop profile or send arbitrary bootstrap scripts.

### Client isolation

Always spawn `/usr/bin/ssh` with `sshArgs` **and** `scratchSshEnv()`:

```text
-F /dev/null
-i <scratch>/client_ed25519
-o IdentitiesOnly=yes
-o IdentityAgent=none
-o UseKeychain=no
-o AddKeysToAgent=no
-o UserKnownHostsFile=<scratch>/known_hosts
-o GlobalKnownHostsFile=/dev/null
-o StrictHostKeyChecking=yes
-o BatchMode=yes
-o ConnectTimeout=5
-o ForwardAgent=no
-o ForwardX11=no
-o ControlMaster=no
-o ControlPath=none
-T -p <port> -- <current-user>@127.0.0.1
```

The environment helper removes SSH_AUTH_SOCK and SSH_AGENT_PID. `-F /dev/null`
prevents both user config and system client config from supplying identities,
agents, ProxyCommand/ProxyJump, or hooks. IdentityAgent=none additionally stops
an agent path from being consulted. Explicit IdentityFile excludes default
identity files; UseKeychain=no/AddKeysToAgent=no prevent Apple keychain/key-agent
integration. Scratch-only trust plus GlobalKnownHostsFile=/dev/null excludes
system host trust too. Merely changing HOME is **not** sufficient to isolate
OpenSSH's passwd-derived user SSH paths.

## Pointing the application at this fixture

There is no existing end-to-end desktop `VOLLI_SSH_*` environment switch in the
researched stack. The package-level sshPath/spawn seams make an adapter cheap;
this spike did not modify product code or wire a desktop flow.

For a pretrusted positive connection test:

- Enter `<fixture.user>@127.0.0.1:<fixture.port>`.
- Supply one harness-only SSH policy to **every** systemSsh, tunnel,
  discoverHostKeys and acceptHostKeys call. A spawn adapter can invoke the real
  `/usr/bin/ssh`, prepend scratch-only options, and explicitly unset agent env;
  injected controlDir must be a short, owned scratch path (macOS socket limit).
- Alternatively, generate a private scratch client config with IdentityFile,
  IdentityAgent=none, IdentitiesOnly=yes, UserKnownHostsFile, global trust disabled,
  UseKeychain=no and AddKeysToAgent=no. An sshPath wrapper may exec `/usr/bin/ssh
  -F <scratch>/client_config "$@"` with the agent env removed. It must never read
  or generate config under the person's real SSH directory.
- Ensure the config-picker and known-host acceptance code share that policy;
  passing a different HOME alone does not suffice. Keep product/device keys,
  artifacts, control sockets and hostd data separate from the person's profile.
- **Do not execute the current full probe on this Mac**: even the designed
  unsupported-system stop happens *after* the remote script's sudo checks.
  Use connect plus a minimal `uname -s; uname -m` diagnostic, or implement an
  OS-first, no-sudo probe before enabling this fixture for the whole flow.

OpenSSH generally takes the first command-line value for an option. A wrapper
that blindly prepends fixed UserKnownHostsFile/StrictHostKeyChecking options
will defeat discovery's per-call temporary trust file and accept-new mode.
For unknown/changed-host tests, use a policy-aware adapter or scratch `-F`
config that preserves those intentional per-call options, constrains their
paths to scratch, and never permits fallback to the person's known_hosts.
The prototype pre-seeds trust and does **not** claim to test discovery/acceptance.

## What VC-700 needs for a real macOS target

1. Shared explicit SSH invocation policy at desktop composition, including
   config selection, identity/agent policy, trust path, environment, discovery,
   acceptance, tunnel and short control-directory lifecycle. Normal product
   mode may retain the person's settings; harness mode must opt into scratch.
2. OS-first probing with Darwin facts (`sw_vers`, uname arm64/x86_64, platform
   disk/memory), no Linux/glibc/systemd checks on Darwin, and **no sudo at all**
   in this fixture mode. Surface unsupported OS before Linux-only probes.
3. Darwin arm64/x64 hostd artifacts built and native-boot-tested at the exact
   desktop version, then extend the release manifest generator, desktop copier,
   pin/target validation and published asset set. A local Darwin dev tarball is
   possible in principle, but was not built or verified here.
4. Darwin upload verification/unpacking (`shasum -a 256` or another explicit
   portable digest tool; compatible BSD tar flags), plus scratch-configurable
   cache/data/install roots rather than the login account's default locations.
5. A Darwin managed lifecycle adapter: user LaunchAgent installation/start/
   status/adoption/upgrade rather than systemctl/useradd/lingering, with the
   account-sharing state visible. The existing plist is only a template.
   **For this harness use a foreground unmanaged hostd owned by the harness and
   stopped by its PID, not launchctl**: this task's no-service-settings boundary
   does not authorize testing a real LaunchAgent lifecycle.
6. Then run real hostd enrollment and its loopback SSH tunnel with a disposable
   device identity/profile. Until that exists, cover Linux bootstrap in its
   authorized Linux environment and use this fixture only for transport and
   explicit Darwin refusal tests after making the probe safe.

## Exact verification

Measured client: `OpenSSH_10.2p1, LibreSSL 3.3.6`; Node: `v24.18.0`; current
account: `phalasiya`; shell: `/bin/zsh`. The fixture's successful session reported
Darwin. No Remote Login/keychain/service-manager command was run.

```sh
node --check apps/desktop/e2e/volli-drive/lib/sshd-fixture.mjs
node --check apps/desktop/e2e/volli-drive/lib/sshd-fixture.test.mjs
node --test --test-concurrency="$VOLLI_CONCURRENCY_HINT" apps/desktop/e2e/volli-drive/lib/sshd-fixture.test.mjs
```

The syntax checks exited 0 with no output. With VOLLI_CONCURRENCY_HINT=1, the
prototype's initial run exited 0 and printed:

```text
scratch-only ssh output: "ok\nDarwin\n"
✔ unprivileged loopback sshd accepts only scratch client credentials (320.029167ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 511.781125
```

After adding the explicit high-port guard and widening the outer test deadline
so it exceeds the sum of all bounded subprocess deadlines, a second run of the
same test command also exited 0: 1 passed, 0 failed, output `"ok\nDarwin\n"`,
213.140666 ms total. Both syntax checks passed again.

`vp fmt apps/desktop/e2e/volli-drive/lib/sshd-fixture.mjs
apps/desktop/e2e/volli-drive/lib/sshd-fixture.test.mjs
docs/research/volli-drive-sshd-fixture.md --write --threads
"$VOLLI_CONCURRENCY_HINT"` exited 0 and formatted the two JS files (Markdown
was not processed by this formatter). `git diff --check` exited 0. A scoped Node
readdir check of the fixture's lib directory reported **0 remaining fixture
scratch directories** after the run.

The test awaited its SSH command, stopped sshd (twice to check idempotence),
and removed its exact scratch directory in the registered cleanup. No app
Add a host UI test, Linux provisioning test, Darwin hostd build, privileged
service installation, or keychain audit was performed.
