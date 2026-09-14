# Recovering Sessions stranded by a crash

A Session whose executor process died is **not lost**. Its transcript, its
model policy and its whole ledger are durable; only the binding to a process is
over. This note is about the Sessions stranded by the boot-ordering defect
fixed in VC-367, and about what a person does with one.

Source: `apps/desktop/src/main/session-runtime/boot-recovery.ts`,
`packages/session-presentation/src/client.ts`.

## What went wrong

Boot recovery reconciles every Session whose turn was live when the prior
process died. Reconciling rehydrates the structured attachment, which resolves
the Session's tool surface, which reaches `resolveBrowserPort` — and the
Browser host used to be built several hundred lines *after* the sweep ran. So
that resolver found `null` and threw, on every pass:

```
adapter_unrecoverable    "Recovery failed: The Browser host is not ready; retry the attachment."
partial_turn_interrupted "The prior desktop process ended while this turn was active."
```

The reconcile path could not succeed at boot. Not intermittently, not only
under load — structurally, on every crash, for every Session with a live turn.

Recovery handled the throw correctly: it recorded the failure and force-closed
the attachment so nothing projected as falsely live. That guard is why this
degraded instead of corrupting, and it is unchanged.

## Finding the Sessions this happened to

Read-only, against a copy of nothing — `-readonly` opens the live profile
without writing to it:

```sh
sqlite3 -readonly ~/Library/Application\ Support/Volli\ Code/volli.db "
SELECT substr(s.id,1,8) AS session,
       COALESCE(s.title,'(untitled)') AS title,
       datetime(e.occurred_at/1000,'unixepoch','localtime') AS stranded_at
FROM session_events e
JOIN sessions s ON s.id = e.session_id
WHERE json_extract(e.payload,'\$.kind') = 'attention.raised'
  AND json_extract(e.payload,'\$.attention.detail')
      LIKE '%Browser host is not ready%'
ORDER BY e.occurred_at DESC;"
```

Every row is a Session whose turn was interrupted and whose attachment was
force-closed. The sidebar already renders each of them as **interrupted**
rather than idle, so they are findable in the app without this query.

## Getting one back

Two doors, both of which open a fresh attachment on the existing Session. The
transcript, the history and the model policy all survive; a new attachment is a
new binding, never a new Session.

1. **Type a message and send it.** Since VC-367 this reattaches the Session and
   then delivers the message. Before it, the message went into a queue that
   nothing was coming to drain — the composer looked like it had accepted the
   words and the Session simply never started.
2. **Press Retry** on the "Session stopped" row. It calls the same attach door.

A successful attach retires the `adapter_unrecoverable` Attention
(`ATTACH_FAILURE_ATTENTION_KINDS` in `packages/session-engine/src/session-runtime.ts`),
so the blocker clears itself once the Session is back. Nothing has to be edited
by hand, and no durable event is ever rewritten.

## Why there is no automatic reattach at boot

A sweep that reattached every stranded Session at launch would start one
executor process per Session, all at once, at the least forgiving moment there
is. That is the load pattern that produced the crash in the first place — the
reporting profile was at load average 15–17 on 8 cores with roughly 30 Sessions
and subagents live (see VC-366 for the per-Session process cost). Recovering
from a load crash by recreating the load is not recovery.

So reattachment stays a person's act, on the Session they actually want back,
through either door above. The boot sweep's job is narrower and unchanged: make
the durable state honest, so nothing projects as live that is not.
