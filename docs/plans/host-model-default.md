# Models on a host (VC-729)

A paired Mac chooses a box's default models through its dedicated, device-authenticated
HOST connection. The client is not the source of truth: hostd validates availability
and stores defaults using the same Model Access service as local Sessions.

The additive `host.model-defaults` feature uses `hostModels.*` operations, separate
from the frozen `model-access` feature. It is never granted to Workspace connections;
only host-scoped device actors may call it. Operator tokens and agents cannot.
Main validates every answer against the public procedure output before renderer IPC.

Settings → Hosts and the host chip open **Models on <host>**. A remote Session with
no default offers the same recovery. An older host gets a named update state,
recovered through Re-add, rather than a pending picker.

## Scope and decisions to confirm

The box screen offers the existing six-row default-model ladder, Compaction,
Code Mode (including per-model pins) and Catalog visibility. Decision models and
Accounts are hidden; provider authentication has one door to **Sign-ins on
<host>**, whose main-owned flows never pass through the generic relay. Secrets,
web, harness settings and per-project overrides stay out of scope.

The feature also carries picker-view preferences to match the existing client
interface, but this screen has no picker-view control and the remote composer
still has no model picker. All new output vocabularies are closed, reusing the
existing Model Access schemas rather than widening them.

The cloud acceptance journey deploys only fake-provider network configuration.
It stores the API key and selects the default through production UI before starting
its remote Session; it no longer seeds the box's SQLite defaults.

## Verification

Focused protocol, hostd, main real-loopback and renderer tests, touched-package
typechecks, formatting/lint, host Electron-import guard and additive schema check
run locally. Desktop Electron journeys run only in CI. CI gate, CodeQL and cloud
acceptance must be green on the exact PR head before owner review/merge.
