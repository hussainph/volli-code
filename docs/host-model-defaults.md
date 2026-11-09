# Models on a host (maintenance)

Superseded host transport; do not extend. A paired device's HOST connection can
set hostd's defaults; a Workspace actor, operator token or agent cannot. The
separate `host.model-defaults` feature never widens frozen `model-access`.
Availability is validated by the host before changing defaults; the desktop
validates every response before IPC. An older host offers Re-add to update,
never a pending picker or a probe for ungranted operations.

The model ladder, Compaction, Code Mode and Catalog visibility are available;
Accounts and Decision models are not. Provider authentication stays in the
[dedicated sign-in flow](host-protocol.md#sign-ins-on-a-host-vc-702).

Definitions and compatibility evidence:
[feature table](../packages/host-protocol/src/features.ts),
[hostModels schema](../packages/session-rpc/src/index.ts),
[real-link tests](../apps/hostd/src/host-models.real-link.test.ts).
Output vocabularies remain closed; use the
[public schema gate](host-protocol.md#committed-schema-and-compatibility-gate-vc-669).
