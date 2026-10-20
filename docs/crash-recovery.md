# Recovering Sessions after a crash

A Session survives the loss of its executor process. Its identity, transcript,
model policy and ordered ledger are durable; the attachment is the temporary
binding to execution. Recovery never creates a replacement Session or rewrites
past events.

Sources: `packages/host-core/src/session-runtime/boot-recovery.ts` and
`packages/session-presentation/src/client.ts`.

## Boot reconciliation

The host reconciles Sessions whose turn was live when the previous process
ended. It must construct the services required by attachment resolution before
running that sweep, including browser and frozen-tool-surface resolvers.

When reconciliation cannot recover an attachment, it records the failure and
closes that attachment so the projection cannot falsely claim it is live.
An interrupted turn may carry `partial_turn_interrupted`; an attachment failure
may carry `adapter_unrecoverable`. History remains available in either case.

## Reattach an interrupted Session

Open the existing Session and use either action:

1. Type and send a message. The host reattaches before delivering it.
2. Press **Retry** on the **Session stopped** row. It uses the same attach door.

A fresh attachment is a new process binding on the same durable Session. Its
transcript, model policy and earlier history remain intact. Successful attach
retires attachment-failure Attention via `ATTACH_FAILURE_ATTENTION_KINDS` in
`packages/session-engine/src/session-runtime.ts`; no manual database editing
is needed.

## Recovery is not automatic bulk execution

Boot reconciliation makes durable state honest. It does not start every
interrupted executor at once: doing so can reproduce the load that caused a
crash. Reattachment is explicit, scoped to the Session the person wants to
continue. A closed view or dead process never defines Session lifetime.
