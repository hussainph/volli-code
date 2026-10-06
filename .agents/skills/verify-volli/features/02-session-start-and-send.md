# 02 — Start a chat Session (Ticket or Project) and send a message

## Sub-features
- Ticket chat: open a ticket, then press **New chat** (⌘T) in the `Ticket tabs` strip. This opens a *provisional Draft* tab. No Session row exists until the first Send.
- Project chat: Home, then **New chat** in the `Home tabs` strip.
- Shortcut: in the New-ticket dialog, **Create & start** (⇧⌘↵) creates the ticket and starts its chat in one step (new-ticket/composer-launch.ts:25).
- Send: the `Message` textbox, then ↵ or the **Send** button. While the turn runs, **Stop turn** shows.

## How to get to it (user POV)
1. Board → open card `DRV-1` (see 01). Its ticket tab `DRV-1` comes to the front.
2. Press **New chat**. A tab (fallback label `Chat`, ticket-chat-tab.ts:19) opens, showing a composer with placeholder `Ask, plan, or implement…`.
3. Type `hello drive` and press ↵. The user bubble appears, **Stop turn** shows, then the reply `fake-agent: hello drive`.

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
- The first ticket Send creates a git worktree, so the turn takes longer to start. Give the `wait` 30s or more. Verified live: a message sent while the Session is still starting shows as **queued** (`Remove queued message: …`) and is released once it is ready — expected, not a bug.
- Verified live: the first message the model receives is wrapped in Volli's `<ticket …>` + `--- BEGIN TICKET BRIEF ---` / `--- BEGIN SESSION TOOLS ---` blocks. The fake provider echoes only the typed text (`spokenText`), so wait for `fake-agent: <your text>`; the transcript bubble shows only what you typed.
- The tab label is not stable: it starts as `Chat` and is retitled by auto-titling (shared/auto-title.ts), which also calls the fake model — so the title starts `fake-agent: …`. Find the tab by its position in `Ticket tabs`, not by its label.
- Assistant prose has no role or label of its own. Match on the text `fake-agent:`.
- Verified live: starting a chat did not move DRV-5 (it stayed in Todo); the worktree was created under the instance's scratch worktree home.
- `session_events` kinds after one ticket turn (verified): `session.created`, `model.selected`, `session.input.recorded`, `command.recorded`/`command.receipt.recorded`, `turn.started`, `turn.completed`, `usage.recorded`, `session.retitled`, `transcript.referenced`.
