# VC-758 renderer measurements

Baseline: `c0cfd4577` (worktree birth); runtime audit is repeated after merging current main/VC-753 before push. Scripted mounted `ChatPlane` against deferred promotion and frozen transport/store inputs, not a drawn replacement. The pre-fix assertions were run before changing product code: `chat-plane.window.test.tsx`, 37/37 passed (including three assertions of the defects). Baseline focused model/window/composer suites: 202/202 passed.

| Path | Location | Baseline observation | Fix / regression |
|---|---|---|---|
| Send waiting for promotion, disk flush or IPC | `chat-plane.tsx` dispatch; `chat-drafts.ts` sending; `heldStrip` | Composer clears; sending copy is excluded from strip; no message anywhere. Deferred promotion asserted absence in mounted DOM. | Draw the held copy immediately in the transcript as Pending. Files stay with the copy. `VC-758 visible timeline regressions` and PendingMessage renderer cases. |
| Steering before acceptance | Same dispatch, `deliver(..., steer)` | Words disappear while the current step runs. | Pending · After the current step below Working. Host acceptance replaces the local copy by identity. |
| Follow-up queued behind a turn | `composer-ui.tsx` queue header | Words and controls, but no visible queue status. | Queued; Sending for a claimed release; Not sent for device recovery. Existing host cancel/edit rules and VC-753 recovery remain. |
| Receipt reaches renderer before queue/transcript snapshot | `ChatSessionClient.submit`, `chat-sessions.ts` enqueue, dispatch finish | Held copy is removed on receipt, although refreshed host projection is asynchronous. Message can disappear until it arrives. | Keep a non-editable accepted copy (Queued / Delivered) until a positive host queue or durable-message identity retires it. No timer or automatic resend. |
| Intent committed before executor accepts it | `command.recorded` transcript artifact | Ordinary user bubble does not distinguish commitment from delivery. | Pending until correlated turn start, runtime transcript observation, or accepted/completed receipt. Rejected receipt: Not delivered. Real JSON renderer codec tests in `message-delivery.test.ts`. Historical windows lacking proof say Recorded rather than guessing Delivered. |
| Turn opens before first transcript message | `chat-plane.tsx` empty branch | Working is inside ChatTranscript, but empty state bypasses it. Mounted DOM asserted no Working. | Use transcript tail whenever a turn, pending message or runtime blocker exists, even with no messages. |
| Between model/tool steps | `TurnRunningMark` | After first output the visible word becomes orbs only. | Visible Working through the whole open turn; tool output is not completion. |
| Transport error during a still-open turn | `working` lifecycle vs `turnActive` | Error lifecycle can suppress work mark while turn remains active. | Keep mark while lifecycle is working OR durable turnActive; only actual turn boundary retires it. |
| Before/between-step error | `sessionBlocker`, composer dock | Failure is only above the composer, outside conversation. Mounted DOM asserted dock ancestor. | Existing failure/retry row in transcript tail, including empty transcript. Setup/catalog/model controls stay in composer. No duplicate failure row. |
| Expired sign-in / invalid configuration | `providerRecovery` | Settings and Retry compete for recovery. | One Open settings recovery. Dismiss remains a local view action, not recovery or a ledger mutation. |

## Boundaries

No row, Attention or queue vocabulary is written to the ledger. Labels and placement are renderer projections of existing facts. Optional local draft `delivery` / `deliveryAccepted` fields do not change the app_state envelope version: old readers ignore them and recover the same words/resources/files as unsent (their existing conservative hydration). The host follow-up queue remains sole delivery authority. No tool row, frozen Session tool array, migration, cloud flag or model prompt is changed here.

Screenshots use real ChatPlane components, captured by the visual-tier Session in light/dark on lab port 5300. Frozen pre-change components exist only during capture and are removed afterwards; the capture script documents how they are materialized from Git.
