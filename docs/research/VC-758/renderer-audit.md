# VC-758 renderer measurements

Baseline: `c0cfd4577` (worktree birth). Current main `795aec3f9`, including VC-753, is merged as `cf7cf0f91`; runtime and renderer checks are repeated on the integrated tree. Scripted mounted `ChatPlane` against deferred promotion and frozen transport/store inputs, not a drawn replacement. The pre-fix assertions were run before changing product code: `chat-plane.window.test.tsx`, 37/37 passed (including three assertions of the defects). Baseline focused model/window/composer suites: 202/202 passed.

| Path | Location | Baseline observation | Fix / regression |
|---|---|---|---|
| Send waiting for promotion, disk flush or IPC | `chat-plane.tsx` dispatch; `chat-drafts.ts` sending; `heldStrip` | Composer clears; sending copy is excluded from strip; no message anywhere. Deferred promotion asserted absence in mounted DOM. | Draw the held copy immediately in the transcript as Pending. Files stay with the copy. `VC-758 visible timeline regressions` and PendingMessage renderer cases. |
| Steering before acceptance | Same dispatch, `deliver(..., steer)` | Words disappear while the current step runs. | Pending · After the current step below Working. Host acceptance replaces the local copy by identity. |
| Follow-up queued behind a turn | `composer-ui.tsx` queue header | Words and controls, but no visible queue status. | Queued; Sending for a claimed release; Not sent for device recovery. Existing host cancel/edit rules and VC-753 recovery remain. |
| Receipt reaches renderer before queue/transcript snapshot | `ChatSessionClient.submit`, `chat-sessions.ts` enqueue, dispatch finish | Held copy is removed on receipt, although refreshed host projection is asynchronous. Message can disappear until it arrives. | Keep a non-editable accepted copy (Queued / Delivered) until a positive host queue or durable-message identity retires it. No timer or automatic resend. |
| Intent committed before executor accepts it | `command.recorded` transcript artifact | Ordinary user bubble does not distinguish commitment from delivery. | Pending until correlated turn start, runtime transcript observation, or accepted/completed receipt. Rejected receipt: Not delivered. Real JSON renderer codec tests in `message-delivery.test.ts`. Historical windows lacking proof retain their old appearance (no invented delivery footer). Unreconciled receipts say Delivery unconfirmed, never Delivered unless another positive runtime fact already proved consumption. |
| Turn opens before first transcript message | `chat-plane.tsx` empty branch | Working is inside ChatTranscript, but empty state bypasses it. Mounted DOM asserted no Working. | Use transcript tail whenever a turn, pending message or runtime blocker exists, even with no messages. |
| Between model/tool steps | `TurnRunningMark` | After first output the visible word becomes orbs only. | Visible Working through the whole open turn; tool output is not completion. |
| Transport error during a still-open turn | `working` lifecycle vs `turnActive` | Error lifecycle can suppress work mark while turn remains active. | Keep mark while lifecycle is working OR durable turnActive; only actual turn boundary retires it. |
| Before/between-step error | `sessionBlocker`, composer dock | Failure is only above the composer, outside conversation. Mounted DOM asserted dock ancestor. | Existing failure/retry row in transcript tail, including empty transcript. Setup/catalog/model controls stay in composer. No duplicate failure row. |
| Steering from an unsent recovery strip | `onSteerQueued` dispatch finish | Accepted words were dropped before the durable projection arrived. | Preserve the same non-editable accepted copy until host ownership arrives, as for an ordinary send. Mounted real-client deferred-receipt regression. |
| Ambiguous delivery receipt | `ChatSessionClient.submit`; `message-delivery.ts` | `unreconciled` was treated as successful delivery; the durable row later stayed Pending. | Recorded words remain; visible Delivery unconfirmed plus host explanation. Never automatically resend. Positive turn/consumption proof takes precedence over a later unknown receipt. Real-codec client and mounted row assertions. |
| Viewing older transcript while a runtime failure arrives | `ChatPlane` conversation navigation | Moving the blocker into the tail could put the explanation offscreen. | While detached, the existing latest-navigation slot names the failure and takes the reader to its timeline recovery. No second recovery row or automatic scrolling. Light/dark scrolled-up screenshots. |
| Streaming reply with pending durable steering | live-turn identity | Grouping a new user intent made it the last turn, potentially leaving the still-streaming reply non-live. | Choose the live turn from delivered rows; Working remains above the pending steer. |
| Expired sign-in / invalid configuration | `providerRecovery` | Settings and Retry compete for recovery. | One Open settings recovery. Dismiss remains a local view action, not recovery or a ledger mutation. |

## Boundaries

No row, Attention or queue vocabulary is written to the ledger. Labels and placement are renderer projections of existing facts. Optional local draft `delivery` / `deliveryAccepted` fields do not change the app_state envelope version: old readers ignore them and recover the same words/resources/files as unsent (their existing conservative hydration). The host follow-up queue remains sole delivery authority. An optional output-only `afterCurrentStep: true` hint names a claimed steer without exposing its target identity or adding a queue state; old readers retain the same payload/state and their existing Queued presentation. Definitive refusals use VC-753's existing blocked-delivery Attention, not the hint. No tool row, frozen Session tool array, migration, cloud flag or model prompt is changed here.

Screenshots use real ChatPlane components, captured and refreshed by visual-tier Sessions in light/dark on allowed lab ports (initial 5300; final 5368). Frozen pre-change components exist only during capture and are removed afterwards; the capture script documents how they are materialized from Git.

## Final integrated renderer checks

All focused tests used `--maxWorkers="$VOLLI_CONCURRENCY_HINT"` (1), with no coverage threshold lowered.

```sh
# apps/desktop
vp test run src/renderer/src/components/chat/chat-plane.test.tsx \
  src/renderer/src/components/chat/chat-plane.window.test.tsx \
  src/renderer/src/components/chat/composer-ui.test.tsx \
  src/renderer/src/stores/chat-drafts.test.ts \
  src/renderer/src/stores/chat-sessions.test.ts \
  src/renderer/src/components/chat/chat-plane-model.test.ts \
  --coverage --coverage.include=src/renderer/src/components/chat/chat-plane-model.ts \
  --maxWorkers="$VOLLI_CONCURRENCY_HINT" --testTimeout=20000
# PASS: 404 tests / 6 files; protected model 100% on all four axes.

# packages/session-presentation
vp test run src/message-delivery.test.ts src/session-model.test.ts \
  --coverage --coverage.include=src/message-delivery.ts --coverage.include=src/session-model.ts \
  --maxWorkers="$VOLLI_CONCURRENCY_HINT"
# PASS: 14 tests; both files 100% on all four axes.
vp test run src/wire.test.ts --coverage --coverage.include=src/wire.ts \
  --maxWorkers="$VOLLI_CONCURRENCY_HINT"
# PASS: 47 tests; wire.ts 100% on all four axes.

# packages/session-engine
vp test run src/session-follow-ups.test.ts --coverage --coverage.include=src/session-follow-ups.ts \
  --maxWorkers="$VOLLI_CONCURRENCY_HINT" --testTimeout=20000
# PASS: 94 tests; session-follow-ups.ts 100% on all four axes.

# packages/session-rpc
vp test run src/output-schema.test.ts --coverage --coverage.include=src/output-schema.ts \
  --maxWorkers="$VOLLI_CONCURRENCY_HINT"
# PASS: 49 tests; output-schema.ts 100% on all four axes.
```

The first integrated desktop run hit two existing 5-second history-window timeouts on the shared machine. It also caught an optional disabled prop returning undefined rather than false (corrected in product) and a new regression fixture mocking the store action instead of the resident real client (corrected to use the client and deferred RPC). The final full focused run above passed all 404 tests. jsdom's canvas-not-implemented notices remain informational; no test was skipped in the final run.

Final visual proof: 12 AFTER captures (including scrolled-up fault/navigation in both themes), zero browser page errors. BEFORE evidence remains unchanged. No local Electron was launched.
