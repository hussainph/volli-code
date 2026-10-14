# PR #865 — review fix round

The owner requested three corrections after review of `73e436ef0`. No migration, event kind, frozen tool surface, model prompt or cloud behavior changes are needed.

## 1. Fatal attachment loss ends the live presentation turn

`packages/session-presentation/src/transcript.ts` treats both `attachment.closed` and `attachment.failed` as turn boundaries, clearing `turnActive` and incrementing `turnEpoch`. Counting the boundary matters when a turn opens and closes inside a single batch, or when the lifecycle is optimistic but the stream has not yet opened. Replayed frames remain ignored.

`transcript.test.ts` covers all close outcomes, an attachment failure without an open turn, same-batch open/close and duplicate replay. The mounted regression in `chat-plane.window.test.tsx` uses real Pi → adapter → SessionRuntime → SQLite/artifacts → RPC codecs → resident client → ChatPlane. A gated provider streams a code block; an injected fatal runtime observation writes Attention then `attachment.closed: failed`, with **no** `turn.interrupted`. It checks that Working disappears, the live turn and lifecycle retire, syntax rendering settles, the failure remains visible, and exactly one Retry is present.

## 2. Immediate sends expose opening acceptance

`ChatSessionClient.submit` requests the existing `settle: "opened"` boundary for immediate sends. `session-rpc/src/index.ts` preserves that optional field in its real command codec and renderer command type; previously the codec stripped it, silently restoring turn-settled behavior. The generated public schema adds the optional input only. Queue submissions keep host-owned queue settlement. The accepted receipt carries the submitted command identity; neither desktop nor peek guesses delivery from the neighboring turn events.

A real gated Pi-provider integration and a mounted ordinary Send regression prove that the prompt becomes Delivered **before** provider completion, appears above Working and the streaming reply, and is also Delivered in `session.peek`. After the gate releases, Working retires and the delivered words remain. Existing steering, queue and unreconciled delivery behavior is preserved.

## 3. Runtime-written N−1 fixtures

`n1-compatibility.test.ts` creates two head-written Sessions through real Pi/runtime/SQLite/artifact code: fatal Attention before attachment close, and deliberate Stop racing a normal provider finish. The latter checks the head sidecar contains interrupted observation provenance rather than completed, while the provider response still finished normally.

The N−1 child uses only the older checkout's database reader, engine, runtime and Pi adapter. It replays before attachment, attaches/reconciles, replays again, continues with a new message, retries the identical command, closes the host/database, then reads the cold history. Behavioral assertions check retained context/messages, one next provider request and accepted receipt, no duplicated user messages and no stranded queue. Rolling release/canary/base lanes remain, with fixed `v0.2.1` and `v0.2.2-canary.1` lanes added so newer tags cannot replace the explicit downgrade promise.

See `n1-fixround.md` for the older-checkout evidence and `screenshots.md` for refreshed light/dark captures. Screenshots are lab presentation evidence; real acceptance and fatal event provenance are established by the integration/mounted tests, not inferred from screenshots.

## Decisions

- Attachment retirement is a real ending boundary; an ordinary transport/subscription error without a durable close does not end the turn.
- Opening acceptance is delivery proof, not proof of completion. Working continues while Pi's actual turn is open.
- No uncertain message is automatically resent. The N−1 idempotency check retries the same accepted command identity.
- PR #865 remains unmerged for owner review.
- A second-opinion review found a false-delivered result under concurrent direct Pi-attachment calls, but its alleged client/host overlap did not reproduce: the real host admission tail holds Retry until the queued message opens durably, then rejects Retry as busy. `opened-race.test.ts` pins that real-host serialization; `opened-race.md` records both experiments and the bounded direct-attachment concurrency follow-up. No speculative production runtime fix or supervisor-steering redesign is included.

## 4. Quiet successful delivery (owner follow-up)

The desktop transcript now hides `Delivered` for both accepted held copies and durable user rows, and suppresses the generic `Recorded` fallback. Successful acceptance remains a model/peek fact, not a permanent transcript footer. Pending (including After the current step), Queued, Sending, Delivery unconfirmed and Not delivered remain explanatory labels; no runtime, client, receipt, queue or CLI semantics changed in this follow-up.

Static render tests pin all explanatory labels, quiet accepted send/steer copies (even before durable proof arrives), retained accepted queue ownership, and quiet durable Delivered/history rows. A mounted transition pins immediate Pending → quiet accepted held copy → one durable bubble with identical bubble markup and row classes. The actual gated Pi/runtime/SQLite/RPC ordinary Send regression still proves command-correlated delivery in the presentation model and peek before completion, now with no desktop footer. The lab adds light/dark browser geometry evidence for the held-to-durable handoff; it is seeded presentation evidence, not another runtime acceptance claim.

Exact local commands/results are in `validation.md`; exact verified head and CI/CodeQL links are posted on PR #865 and VC-758 at handoff.
