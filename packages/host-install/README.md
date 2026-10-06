# @volli/host-install

Add a host over SSH (VC-700, VC-615 flow 1). Electron-free: desktop main runs
it today; a CLI or a control plane can run it unchanged.

```
connect → probe → deliver → install → start → enroll → link
```

The step machine (`provision.ts`) is provider-neutral: a `HostProvider`
answers each step. SSH (`ssh-provider.ts`) is the first and only adapter:
deliver is an upload, link is an `ssh -L` tunnel. A bring-your-own-account
provider (a Fly Sprite, a Cloudflare container) would deliver an image and
link over its own route, plugging in without touching the engine.

Linux (systemd) and macOS (a launchd user agent, always as the person) are
both first-class branches of the probe and the SSH steps. Which targets a
build installs is `supportedTargets(pin, devTarballs)`: the release pin's
assets (VC-701's manifest carries linux and darwin, x64 and arm64), else the
dev tarballs' targets, read from their names. A Mac's checksums use `shasum`
where it has no `sha256sum`.

| Module                      | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ssh.ts`                    | The runner over the system `ssh`: the person's config, agent, ProxyJump and known_hosts apply. `BatchMode=yes`, `StrictHostKeyChecking=yes`, ControlMaster (its directory 0700 and this user's alone, a given one refused otherwise), no forwarding, no `LocalCommand`, never daemonized. Typed failures from ssh's own words. Unknown host keys are discovered with every auth method off and shown by fingerprint, one per key or no offer at all; accepted ones are appended to the person's known_hosts.                |
| `probe.ts`                  | One POSIX `sh` script: OS, arch, glibc, systemd, user manager, lingering, disk, memory, sudo, any hostd already there and its `status --json`. An answer cut short (no `end=ok`, a failed exit, a missing fact) is a failure, never partial facts.                                                                                                                                                                                                                                                                          |
| `artifact.ts`               | The exact-version tarball: the signed app's pin (VC-701) is the only trust root for a release download; with no release assets (dev, local and CI builds) only a local dev tarball.                                                                                                                                                                                                                                                                                                                                         |
| `provision.ts`              | The step machine: plain-JSON state, `advance` / `answer` / `retry`, upgrade and adopt, sudo passwords in memory only. `retry` drops every decision the retried steps' evidence answered, so it is asked again; a step that throws stops with `unexpected-state`.                                                                                                                                                                                                                                                            |
| `ssh-provider.ts`           | The SSH adapter. Deliver sends the tarball unless the box's copy matches the pin (`reused`: not sent again), then always extracts it afresh into a new `stage.XXXXXX` beside it, and only that tree is run and installed. Only staging older than an hour is ever removed, so another desktop's delivery awaiting its sudo password keeps its tree. Privileged commands run as root through one `sudo` whose password stdin never reaches the command (`sh -c 'exec … </dev/null'`); every hostd command reads `/dev/null`. |
| `failures.ts`               | Every failure and question, typed, with the lab's one line and one recovery.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `tunnel.ts`                 | `ssh -N -L` to the host's loopback listener, a stable local port, reconnect with backoff, `wake()` after sleep. Single-flight `start()`, cancelled by `close()` at any await; every ssh process it started is reaped (SIGTERM, then SIGKILL).                                                                                                                                                                                                                                                                               |
| `contract.ts` (`/contract`) | What hostd's management commands print. hostd compiles against it too.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

Every log line carries `component: "host-install"` and never a secret. The
box-side commands and their idempotency and adopt rules: `apps/hostd/README.md`,
"Managed install". The enrollment trust argument and the `vdc1` credential:
`docs/plans/host-protocol.md`, "Enrollment over SSH".
