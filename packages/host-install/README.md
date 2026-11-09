# @volli/host-install

> **Superseded.** SSH host installation and enrollment are maintenance-only
> compatibility surfaces, not the outbound Runner architecture. See
> [Workspace authority and offline](../../docs/BOUNDARIES.md#workspace-authority-and-offline).
> Retain these contracts while their callers exist; do not extend the host model.

The remaining desktop path provisions hostd over SSH; current outbound setup
is [volli-runner](../../apps/runner/README.md). Box-side install/upgrade/rollback
and enrollment commands remain in [hostd's operator manual](../../apps/hostd/README.md).

Implementation and failure contracts:

- [provision.ts](src/provision.ts): resumable connect → probe → deliver → install
  → start → enroll → link; retry invalidates decisions based on retried evidence.
- [ssh.ts](src/ssh.ts), [probe.ts](src/probe.ts), [tunnel.ts](src/tunnel.ts):
  system SSH, strict host-key checking, complete probe evidence and reaped children.
- [artifact.ts](src/artifact.ts), [ssh-provider.ts](src/ssh-provider.ts): exact
  pinned/checksummed artifact, fresh extraction, bounded staging cleanup.
- [remote-hosts.ts](src/remote-hosts.ts): registry, connection budgets, single-flight
  adds, cancellation and bounded shutdown; unreadable/newer registries stay read-only.
- [contract.ts](src/contract.ts): shared JSON management replies.
- [failures.ts](src/failures.ts): typed failures and the recovery each offers.

Device private keys never appear in views, snapshots or logs. Sudo passwords
stay in memory and reach only sudo's stdin; privileged commands read `/dev/null`,
not that password. Staging cleanup removes only directories older than one hour,
so another in-progress delivery keeps its extraction.

Every log line carries `component: "host-install"` and never a secret. The
box-side commands and their idempotency and adopt rules: `apps/hostd/README.md`,
"Managed install". Enrollment uses the short-lived `vdc1` credential
(`remote-hosts-device-key.ts`) over the SSH connection.

**Host keys.** Trusting a host adds its key to your `~/.ssh/known_hosts`
(the file your own `ssh` reads for that target), exactly as `ssh`'s own
prompt would. A changed key stops the connection until you remove the old
line (`ssh-keygen -R <host>`); Volli never replaces it for you.

**Device keys left behind.** Re-adding a host enrolls this Mac afresh; the
old enrollment stays on the box until you revoke it there
(`volli-hostd devices list --system`, then `volli-hostd devices revoke <deviceId> --system`,
or `--user` for a user install). A crash in the middle of an add can leave
that flow's key (`flow:<id>`) in the Mac's sealed inventory: the key store
cannot list its keys yet, so nothing collects it.
