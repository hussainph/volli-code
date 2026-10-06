# @volli/host-install

Add a host over SSH (VC-700, VC-615 flow 1). Electron-free: desktop main runs
it today; a CLI or a control plane can run it unchanged.

```
connect → probe → upload → install → start → enroll → tunnel
```

| Module                      | What                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ssh.ts`                    | The runner over the system `ssh`: the person's config, agent, ProxyJump and known_hosts apply. `BatchMode=yes`, `StrictHostKeyChecking=yes`, ControlMaster, no forwarding. Typed failures from ssh's own words. Unknown host keys are discovered with every auth method off and shown by fingerprint; accepted ones are appended to the person's known_hosts. |
| `probe.ts`                  | One POSIX `sh` script: OS, arch, glibc, systemd, user manager, lingering, disk, memory, sudo, any hostd already there and its `status --json`.                                                                                                                                                                                                                |
| `artifact.ts`               | The exact-version tarball: the signed app's pin (VC-701) is the only trust root for a release download; with no release assets (dev, local and CI builds) only a local dev tarball.                                                                                                                                                                           |
| `provision.ts`              | The step machine: plain-JSON state, `advance` / `answer` / `retry`, upgrade and adopt, sudo passwords in memory only.                                                                                                                                                                                                                                         |
| `failures.ts`               | Every failure and question, typed, with the lab's one line and one recovery.                                                                                                                                                                                                                                                                                  |
| `tunnel.ts`                 | `ssh -N -L` to the host's loopback listener, a stable local port, reconnect with backoff, `wake()` after sleep.                                                                                                                                                                                                                                               |
| `contract.ts` (`/contract`) | What hostd's management commands print. hostd compiles against it too.                                                                                                                                                                                                                                                                                        |

Every log line carries `component: "host-install"` and never a secret. The
box-side commands and their idempotency and adopt rules: `apps/hostd/README.md`,
"Managed install". The enrollment trust argument and the `vdc1` credential:
`docs/plans/host-protocol.md`, "Enrollment over SSH".
