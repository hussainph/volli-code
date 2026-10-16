# 03 — Queue a follow-up while a turn runs, and see it release (VC-675)

## Sub-features
- While a turn is live, the submit button becomes **Queue**. ↵ queues, ⌘↵ steers, and ⌫ on an empty box takes back the newest queued message (composer-ui.tsx:22-25).
- Each queued row is a group `Queued message: <text>` with three controls: **Steer queued message: …**, **Remove queued message: …**, and **Queued message actions: …**, which opens a menu with **Edit message** (composer-ui.tsx:510-590).
- Since VC-675 the **host** owns the queue. It is durable in `session_follow_up_queue`. At each idle boundary the host releases *one* entry, as an ordinary `message.submit` (session-engine/src/session-runtime.ts:2117-2141).

## How to get to it (user POV)
1. Have a chat open (see 02) on the fake model.
2. Send a slow message. **Stop turn** appears and the submit button's name changes from `Send` to `Queue`.
3. Type a follow-up and press ↵. A row `Queued message: <text>` appears above the input and the box clears.
4. When the slow turn finishes, the row disappears. The follow-up shows up as a user bubble, a second turn runs, and its reply arrives.

## Driving it with volli-drive
```
volli-drive launch --fixture basic --model fake      # then open a chat as in 02
volli-drive act vd-xxxx --gen N --ref <Message> --kind type --text "[slow:15000] first"
volli-drive act vd-xxxx --gen N --ref <Message> --kind press --key Enter
volli-drive find vd-xxxx "Stop turn"                 # proves the turn is live (composer-ui.tsx:706-711)
volli-drive find vd-xxxx "Queue"                     # submit button is now "Queue" (composer-ui.tsx:741)
volli-drive act vd-xxxx --gen N --ref <Message> --kind type --text "second please"
volli-drive act vd-xxxx --gen N --ref <Message> --kind press --key Enter
volli-drive find vd-xxxx "Queued message: second please"   # role=group row
volli-drive state vd-xxxx sql "SELECT pending_count FROM session_follow_up_queue"   # → 1 while queued
volli-drive wait vd-xxxx --text "fake-agent: second please" --timeout 40000
volli-drive find vd-xxxx "Queued message:"           # → no matches once released
```
- Optional probes while the row is queued:
  - `Remove queued message: second please` should make the row disappear and leave `pending_count` at 0.
  - `Queued message actions: …` → `Edit message` should move the text back into `Message`.
  - `Steer queued message: …` should deliver the message into the live turn instead of waiting for it to end.

## End state that proves it
- Visible: there are no `Queued message:` groups. The transcript order is `[slow:15000] first`, then `fake-agent: [slow:15000] first`, then `second please`, then `fake-agent: second please`. Submit is `Send` again.
- SQL: the ledger drained and the release was delivered under its follow-up command id. Table: host-core/src/db/session-follow-up-migration.ts:2-9. Id format: `follow-up:<sessionId>:<commandId>` (session-engine/src/session-follow-ups.ts:51-53).
```
volli-drive state vd-xxxx sql "SELECT pending_count, json_extract(state,'$.revision') rev, json_array_length(json_extract(state,'$.entries')) n FROM session_follow_up_queue WHERE session_id='<id>'"
# → pending_count 0, n 0, rev ≥ 2
volli-drive state vd-xxxx sql "SELECT id FROM session_commands WHERE session_id='<id>' AND id LIKE 'follow-up:%' AND json_extract(intent,'$.kind')='message.submit'"
# → exactly one row. An extra 'follow-up:…:attach:N' row (kind adapter.attach) is legal
#   if no executor was live at release time (session-runtime.ts:2172-2185)
volli-drive state vd-xxxx sql "SELECT COUNT(*) FROM session_events WHERE session_id='<id>' AND json_extract(payload,'$.kind')='turn.completed'"
# → 2
```
- CLI: `state cli session answer <short-id>` should print `fake-agent: second please` as the final message.

## Gotchas
- Leave plenty of time. Every `act` returns a full snapshot, so typing and queueing take a few seconds. `[slow:5000]` is the documented knob. UNVERIFIED: whether other durations, like `15000`, are honored. If the turn settles before you press ↵, you've *sent* the message, not queued it: check that `Stop turn` is still visible first.
- Only one entry is released per idle boundary. With two queued messages, the second releases only after the first one's own turn completes.
- The queue is in the composer header of the **same** chat. Switching tabs doesn't release it, and closing the app doesn't lose it: the rows are durable.
- Steer is disabled once a row is `releasing` (composer-ui.tsx:529-531). Remove stays enabled, but the host may refuse it.
- Message text for the queued entry lives in `session_follow_up_queue.state` JSON (`$.entries[0].message.parts`) only while it is queued. After release the text is in transcript artifacts, not SQL.
- e2e reference flow: pi-ticket-chat-smoke.mjs:320-330 (`queueWhileWorking`) and :690-800 (edit and remove).
