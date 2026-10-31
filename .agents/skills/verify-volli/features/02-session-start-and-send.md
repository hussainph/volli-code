# 02 — Start a chat Session (Ticket or Project) and send a message

## Sub-features
- Ticket chat: open a ticket, then press **New chat** (⌘T) in the `Ticket tabs` strip. This opens a *provisional Draft* tab. No Session row exists until the first Send.
- Project chat: Home, then **New chat** in the `Home tabs` strip.
- Shortcut: in the New-ticket dialog, **Create & start** (⇧⌘↵) creates the ticket and starts its chat in one step (new-ticket/composer-launch.ts:25).
- Send: the `Message` textbox, then ↵ or the **Send** button. Any idle Send goes straight to a transcript bubble + **Working**, including an existing Session with history and no live executor while reattaching. While the turn runs, **Stop turn** shows.
- Enter during a running turn remains a queued follow-up (see 03), not an idle Send.

## How to get to it (user POV)
1. Board → open card `DRV-1` (see 01). Its ticket tab `DRV-1` comes to the front.
2. Press **New chat**. A tab (fallback label `Chat`, ticket-chat-tab.ts:19) opens, showing a composer with placeholder `Ask, plan, or implement…`.
3. Type `hello drive` and press ↵. The user bubble stays in the transcript and **Working** shows even while the Session is attaching, with no delivery tab or composer queue strip. Once the turn opens, **Stop turn** shows, then the reply `fake-agent: hello drive`.

## Driving it with volli-drive
PROVEN transcript (vd-1b7e41, VC-703) — a Ticket chat on DRV-5, from the board:
```
volli-drive act vd-x --gen 10 --ref f2e300 --kind press --key Enter     # focused card → opens ticket tab "DRV-5"
volli-drive act vd-x --gen 11 --ref f2e324 --kind click                 # the strip's button "New chat" (first match)
volli-drive act vd-x --gen 12 --ref f2e457 --kind type --text "hello drive"   # textbox "Message"
volli-drive act vd-x --gen 13 --ref f2e457 --kind press --key Enter
volli-drive wait vd-x --text "fake-agent: hello drive" --timeout 30000
volli-drive state vd-x sql "SELECT id, role FROM sessions"              # → role 'ticket'
volli-drive state vd-x cli session answer <short-id>                    # → final message: fake-agent: …
```
Mapped from code (alternatives):
```
volli-drive launch --fixture basic --model fake
volli-drive find vd-xxxx "DRV-1"                  # the card; click it, then press Enter (01)
volli-drive find vd-xxxx "New chat"               # button "New chat", aria-keyshortcuts Meta+T (sessions/new-session-control.tsx:262-263)
volli-drive act vd-xxxx --gen N --ref eA --kind click
volli-drive find vd-xxxx "Message"                # textbox "Message" (components/chat/composer-ui.tsx:910-912)
volli-drive act vd-xxxx --gen N --ref eB --kind type --text "hello drive"
volli-drive act vd-xxxx --gen N --ref eB --kind press --key Enter   # or click button "Send" (composer-ui.tsx:741)
volli-drive wait vd-xxxx --text "fake-agent: hello drive" --timeout 30000
volli-drive screenshot vd-xxxx --name ticket-chat
```
- Project variant: `find "Home"` (sidebar nav, sidebar/nav-list.tsx:21), then the Home strip's `New chat`. The rest is the same.
- The ticket screen has **two** `New chat` buttons: one in the strip and one in the rail's Sessions panel (e2e/lib/smoke-kit.mjs:1561-1584). Either starts a chat. Prefer the one next to tablist `Ticket tabs`.
- `Message` stays disabled until the composer is ready. If `type` is refused, `wait` and re-snapshot.

## Failed tool disclosure
Verified live (VC-970, `vd-de6e23`): a project chat sent through the composer, with
only the model HTTP boundary scripted to call the real `bash` tool
(`printf 'diagnostic line %s\\n' {1..80} >&2; exit 2`). The isolated instance used
`--model env` with the loopback fake provider's Azure environment, not real credentials.

- The failed bundle opens to a compact row with a failure glyph and **Show details**;
  diagnostics do not appear beneath the closed row.
- Click **Show details**: the command and stored error appear in monospace output
  frames. **Hide details** removes them again. This is a layout fix; the runtime's
  existing diagnostic shortening is unchanged.
- Host reads: `session peek` records `[bash]` between the user message and final
  reply; SQL records one `turn.started`, one `turn.completed`, and two
  `transcript.referenced` events. Doctor reported zero keychain violations.
- Evidence: snapshots 7–9 and screenshots `failed-collapsed`, `failed-expanded`,
  `failed-recollapsed`; snapshots 15–16 and `failed-light-collapsed` /
  `failed-light-expanded` cover light appearance after returning from Settings.
  All are in that instance's evidence directory. Failed Code Mode
  pictures retaining their error text are covered by the real-codec renderer test,
  not this live path.

## Idle reattach with existing history
Mapped follow-up path (not covered by the first-send live proof):
1. Open an existing Ticket or Project chat that has a completed turn and no live executor. Keep its previous user/assistant messages visible.
2. Type a new message in `Message` and press plain ↵ while no turn is running.
3. Capture immediately while attaching, after the host queue accepts the send, and as the new turn opens. The new bubble and **Working** must be visible at all three stages, with equal bounds; prior history remains in place. No **Sending…**, **Queued**, delivery tab, composer queue strip, empty-state flash, or normal attachment-pending blocker/Retry.
4. Wait for the fake reply. Verify a new `turn.started`/`turn.completed` pair and the new user/assistant transcript events on the same Session, using the SQL/CLI reads below. Real attachment or delivery failures must still surface recovery.

The current `volli-drive` CLI always launches a fresh isolated profile; it has no same-profile restart/relaunch command. Do not claim the stop-app → relaunch → reopen path was driven using a fresh `launch`. The Enter/window regression covers history plus a closed binding, queue-before-transcript delivery, and view remounts.

Browser-only presentation counterpart: `/lab/?clean&state=history-attaching#chat-waiting-states` seeds completed history, no live executor, and no active turn. **Advance handoff** exercises held-attaching → queued-attaching → durable-delivered without remounting the production `ChatPlane`. This is **Simulated wiring**, not proof of a live reattach or actual Enter dispatch. Retain the original `state=attaching` first-startup and `state=handoff` accepted→durable no-jump captures, in light and dark.

## End state that proves it
- Visible: the transcript (role `log`, ui/ai-elements/conversation.tsx:112) holds a user bubble `hello drive` and an assistant reply `fake-agent: hello drive`. **Stop turn** is gone and the submit button reads `Send` again.
- SQL: the Session, its turn, and (for a ticket) the worktree. Schema references: `sessions` migrations.ts:546-552 plus `role` at :1771 and `parent_session_id` at :1809; `session_events` at :1853.
```
volli-drive state vd-xxxx sql "SELECT s.id, s.role, s.ticket_id IS NOT NULL AS on_ticket, s.title FROM sessions s JOIN projects p ON p.id=s.project_id WHERE p.ticket_prefix='DRV' ORDER BY s.created_at DESC LIMIT 1"
# → role 'ticket' (or 'project' for a Home chat, ticket_id NULL)
volli-drive state vd-xxxx sql "SELECT json_extract(payload,'$.kind') k, json_extract(payload,'$.digest.role') r, COUNT(*) FROM session_events WHERE session_id='<id>' GROUP BY k, r"
# → includes session.created, turn.started, turn.completed, transcript.referenced/user ≥1, transcript.referenced/assistant ≥1
volli-drive state vd-xxxx sql "SELECT worktree_path, branch FROM tickets WHERE id=(SELECT ticket_id FROM sessions WHERE id='<id>')"
# ticket chat only: worktree stamped on first Send, branch like volli/DRV-1-<slug>
```
- CLI. Message bodies are *not* in SQL: they live in gzipped artifacts under `<userData>/session-transcripts` (host-core/src/session-runtime/transcript-artifacts.ts:459). Read them through the CLI:
```
volli-drive state vd-xxxx cli session list --project DRV --json     # short session id
volli-drive state vd-xxxx cli session answer <short-id>             # final message == "fake-agent: hello drive"
```

## Gotchas
- Opening **New chat** writes nothing durable. No `sessions` row and no worktree exist until the first Send (pi-ticket-chat-smoke.mjs:966-1000). Don't assert on SQL before you've sent.
- Every Session needs an app-wide default model (`DEFAULT_MODEL_REQUIRED`, host-core/src/session-runtime/sessions.ts:1137-1146). Without `--model fake`, Send fails with an error toast.
- The first ticket Send creates a git worktree, so the turn takes longer to start. Give the `wait` 30s or more. Verified live (VC-774, `vd-36e738`, ticket and project Drafts; light/dark captures): the first sent bubble stays in the transcript with **Working**, even before attachment finishes. No **Sending…**, **Queued**, or **Sends after this step** tab, no composer queue strip, no empty-state flash, and no attachment-pending blocker/Retry should appear. The same presentation contract applies to any plain Enter while idle, including a Session with history/no live executor (use the separate reattach path above; the first-send live evidence does not prove that path). The host may queue the message internally; that ownership handoff and the turn opening must not move the bubble or Working mark. Capture the attaching and turn-open states, not just the final reply. Queueing a follow-up behind an already running turn is unchanged (see 03).
- Verified live: the first message the model receives is wrapped in Volli's `<ticket …>` + `--- BEGIN TICKET BRIEF ---` / `--- BEGIN SESSION TOOLS ---` blocks. The fake provider echoes only the typed text (`spokenText`), so wait for `fake-agent: <your text>`; the transcript bubble shows only what you typed.
- The tab label is not stable: it starts as `Chat` and is retitled by auto-titling (shared/auto-title.ts), which also calls the fake model — so the title starts `fake-agent: …`. Find the tab by its position in `Ticket tabs`, not by its label.
- Assistant prose has no role or label of its own. Match on the text `fake-agent:`.
- Verified live: starting a chat did not move DRV-5 (it stayed in Todo); the worktree was created under the instance's scratch worktree home.
- `session_events` kinds after one ticket turn (verified): `session.created`, `model.selected`, `session.input.recorded`, `command.recorded`/`command.receipt.recorded`, `turn.started`, `turn.completed`, `usage.recorded`, `session.retitled`, `transcript.referenced`.
