# 04 — Reopen a long Session: bounded history, plan card, `/copy`, scroll up (VC-315)

## Sub-features
- **Bounded open.** The host returns only the newest window: 256 events **or** 512 KiB, whichever is hit first (`SESSION_HISTORY_WINDOW`, session-engine/src/session-runtime.ts:514). The client mounts the last 60 rows and reveals 40 at a time (components/chat/transcript-window.ts:33-36).
- **Scroll up / Show earlier.** A ghost button **Show earlier** sits above the rows whenever the client is holding rows it hasn't mounted or the host has older history (`hasEarlier`, chat-plane.tsx:2202, :2318-2328). A prefetch sentinel loads pages as you scroll near it. The reader's place is kept.
- **Plan card.** The Activity Island (group `Agent activity`) shows a plan cluster whose button is named `Plan <done>/<total> · <current step>` and expands to a card headed `Plan · d/t` (session-presentation/src/activity-island.ts:562-569). After a bounded open, the plan comes from the projection's `todoList` even if the plan call is above the window.
- **`/copy`.** Copies the current turn's reply, even if that reply is above the window (`currentTurnReply`, chat-plane.tsx:1137-1148). The toast reads `Copied last reply`. If there's no reply yet, it reads `No reply to copy yet`; mid-turn, `Wait for the reply to finish` (shared/src/composer-verb.ts:183-195).

## How to get to it (user POV)
1. Build a long chat (see 02). The quickest way is to queue many follow-ups behind one `[slow:5000]` turn (see 03); the host then releases them one per turn.
2. Close the chat tab with its **Close <label>** button (ui/tab-strip.tsx:1123). This disposes the client (stores/chat-sessions.ts:527-535, 690-697).
3. Reopen the chat from the sidebar (**Active**/**Previous** band rows, sidebar/active-sessions.tsx:1234,1281) or from ⌘K (button `Search tickets and sessions`).
4. The newest turns paint first. Scroll up, or press **Show earlier**, to page older turns in. Type `/copy` and press ↵.

## Driving it with volli-drive
```
# 1. Grow history. Repeat queue+Enter ~20× behind one slow turn, then wait for the last reply.
volli-drive act vd-xxxx --gen N --ref <Message> --kind type --text "[plan] start"   # plan turn first, own message
volli-drive act vd-xxxx --gen N --ref <Message> --kind press --key Enter
volli-drive wait vd-xxxx --text "fake-agent:"
volli-drive act vd-xxxx --gen N --ref <Message> --kind type --text "[slow:5000] hold"
volli-drive act vd-xxxx --gen N --ref <Message> --kind press --key Enter
# … type "msg 01".."msg 20" + Enter each while "Stop turn" is visible …
volli-drive wait vd-xxxx --text "fake-agent: msg 20" --timeout 120000
volli-drive state vd-xxxx sql "SELECT COUNT(*) FROM session_events WHERE session_id='<id>'"   # want > 256
# 2. Reopen.
volli-drive find vd-xxxx "Close <tab label>"      # e.g. "Close Chat"; read the label from the active tab first
volli-drive act vd-xxxx --gen N --ref eA --kind click
volli-drive find vd-xxxx "<session title>"        # sidebar row (or ⌘K palette result)
volli-drive act vd-xxxx --gen N --ref eB --kind click
# 3. Scroll up and page in.
volli-drive find vd-xxxx "Show earlier"
volli-drive act vd-xxxx --gen N --ref <log> --kind scroll --direction up
volli-drive act vd-xxxx --gen N --ref <Show earlier> --kind click
volli-drive find vd-xxxx "msg 01"                 # older turns now mounted
# 4. /copy
volli-drive act vd-xxxx --gen N --ref <Message> --kind type --text "/copy"
volli-drive act vd-xxxx --gen N --ref <Message> --kind press --key Escape   # close the "/" picker first
volli-drive act vd-xxxx --gen N --ref <Message> --kind press --key Enter
volli-drive wait vd-xxxx --text "Copied last reply"
```

## End state that proves it
- Visible:
  - Right after the reopen, the newest reply is on screen and **Show earlier** exists at the top.
  - After scrolling or clicking, `msg 01` is findable and the scroll position didn't jump to the bottom. Once you're scrolled away from the bottom, a `Scroll to latest` button appears (ui/ai-elements/conversation.tsx:278).
  - `/copy` shows the toast `Copied last reply`.
  - If the transcript has a plan: `find "Plan "` returns the island button.
- SQL. Size and digest columns: `session_events` migrations.ts:1853; the digest shape is in shared/src/session-ledger.ts:381-391.
```
volli-drive state vd-xxxx sql "SELECT COUNT(*) n, SUM(LENGTH(payload)) bytes FROM session_events WHERE session_id='<id>'"
# n > 256 proves the open was bounded (host window = 256 events / 512 KiB)
volli-drive state vd-xxxx sql "SELECT sequence, json_extract(payload,'$.digest.role'), json_extract(payload,'$.digest.reply') FROM session_events WHERE session_id='<id>' AND json_extract(payload,'$.kind')='transcript.referenced' ORDER BY sequence DESC LIMIT 4"
volli-drive state vd-xxxx sql "SELECT sequence FROM session_events WHERE session_id='<id>' AND json_extract(payload,'$.digest.todoList') IS NOT NULL ORDER BY sequence DESC LIMIT 1"
# plan present only if this returns a row
```
- CLI: `state cli session answer <short-id>` returns the same text that `/copy` copied (last reply).

## Gotchas
- UNVERIFIED: whether the fake model's `[plan]` mode emits a real `todo_write` tool call. The plan card **only** appears for a settled todo call (chat/use-island-plan.ts:11-23); a markdown "plan" in a reply is just prose. If the `todoList` query returns no rows, report the plan card as *not exercisable*. Don't count that as a failure.
- UNVERIFIED: how many events a fake turn writes. Measure `COUNT(*)` after one turn and scale. The other route is the byte bound: a few turns carrying 150 KB+ of text cross 512 KiB, if `act --kind type` can enter that much text.
- With the `/` picker open, ↵ stages the highlighted verb instead of running it. Press Escape first, as e2e/composer-verbs-smoke.mjs:124-137 does.
- `/copy` writes to `navigator.clipboard`. If the harness window isn't focused, Chromium may refuse, and the toast reads `Couldn't copy — the clipboard refused` (chat-plane.tsx:1241). UNVERIFIED in volli-drive.
- Switching tabs without closing keeps the client resident, so it does **not** exercise the bounded open. Close the tab.
- UNVERIFIED: whether ⌘R (menu `reload`, main/menu.ts:136) fires from a synthetic key press. If it does, a renderer reload is a stronger cold reopen.
- Returning to the bottom drops the pages you revealed (chat-plane.tsx:2000-2003). Re-snapshot before you look for older rows.
