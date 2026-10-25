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

A reconcile can fail on either side of rebuilding the binding. A rebuilt
executor replays its own record first, so the end of the lost turn may already
be on the ledger when a later step fails. The sweep therefore reads the Session
again. If the turn has ended and the runtime still holds the binding, the
attachment stays open and the turn counts as recovered, so restart resume can
continue it. In every other case the host raises its `:boot-recovery`
Attention and closes the attachment. A turn still open on a rebuilt binding is
closed, not reconciled again. That close leaves the rebuilt binding held by the
runtime until shutdown.

Each close records its reason in `provenance.source.detail.bootRecovery`:
`binding_unrecoverable` (the executor could not be rebuilt), `reconcile_failed`
(it was rebuilt but did not record the turn's end), or `not_rebuildable` (a
terminal companion or a retired runtime). The record also keeps the error's
class name and code, but never its message. The host log line
`failed to recover attachment` (a warning, `recovered an attachment whose
reconcile failed`, when the turn was kept) has the same reason and the redacted
error. The
support report's **Boot recovery** line counts this launch's recovered turns,
closed attachments and each kind of failure.

A turn whose `turn.interrupted` has an `occurredAt` well before its
`recordedAt` was recorded by the boot's own replay, not by the prior process.

## Restart resume

When the executor's own recovery rebuilds the attachment of a turn the prior
process left open, the host may continue that turn without the person typing
anything. It goes through the same `executor.retry` door as **Retry**, under a
frozen command id (`restartResumeCommandId` in `@volli/shared`), so the
executor resumes from the point the turn was answering and the person's message
is never sent again. The decision is `restartResumeVerdict` in
`@volli/session-engine`; `packages/host-core/src/session-runtime/restart-resume.ts`
performs it after the follow-up queue has been released.

A turn continues on its own only when all of these hold:

- **It is safe.** The executor reports a settled point: the conversation ends on
  a user message, or on tool results that answered every call. A tool call
  without a result (a command, a write or a browser action the process died
  inside) has unknown side effects, and so does a question nobody answered.
- **It is a plain process loss.** The warning on the attachment is the
  executor's own recovery sentence, not a diagnosis such as withheld history.
  A turn whose reply had already finished, and lost only its end marker, raises
  no warning at all: nothing is left to resume.
- **It is still wanted.** Nobody continued this Session, and no other Session on
  its Ticket was picked up, after the prior process was last known alive. No
  Stop was recorded for the turn. The loss is less than twelve hours old. The
  interrupted turn was not itself a restart resume, so each loss gets one
  automatic attempt, never a loop.
- **Nothing else holds it.** No turn is running or about to start, and the
  attachment the recovery rebuilt is still the live one. The engine checks this
  again when it records the command.

At most two resumed turns run at once, and each Session is judged when a slot
frees, against its state at that moment. While a resumed turn runs, its
interruption row reads **Resumed after restart**. A skipped turn raises nothing
new: the existing **Turn interrupted** row offers **Resume** while its
attachment is live, and the skip reason goes to the host log
(`restart-resume`). Resuming a turn whose tool call was cut short answers that
call as cut short, so the model sees that its effects are unknown and is not
told it ran. A message answers the warning; a Retry keeps it until the resumed
turn settles.

Builds before this one read a restart resume's retry as a person's act: their
scheduled resume on the same Session or Ticket skips as continued or
superseded rather than running alongside it.

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
crash. A restart resume continues only turns whose attachment recovery already
rebuilt, a few at a time. Reattaching a closed attachment is explicit, scoped
to the Session the person wants to continue. A closed view or dead process
never defines Session lifetime.
