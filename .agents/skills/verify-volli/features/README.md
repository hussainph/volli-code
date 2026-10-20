# verify-volli — feature map

These are maps for driving a live, isolated Volli dev build through `volli-drive`. Each file follows the same five sections: Sub-features, How to get to it (user POV), Driving it with volli-drive, End state that proves it, and Gotchas.

| # | Feature | File | One-line proof |
|---|---------|------|----------------|
| 01 | Board: create a ticket, move it to Todo | [01-board-create-and-move-ticket.md](01-board-create-and-move-ticket.md) | Card `DRV-<n>` sits in Todo, and `ticket_events` shows `created` then `status_changed` backlog→todo |
| 02 | Start a chat Session (ticket/project) and send | [02-session-start-and-send.md](02-session-start-and-send.md) | `fake-agent: hello drive` is visible, there's a `sessions` row with the right `role`, and `session answer` prints the reply |
| 03 | Queue a follow-up while a turn runs (VC-675) | [03-queue-follow-up.md](03-queue-follow-up.md) | The `Queued message:` row appears, then releases into a 2nd turn; `session_follow_up_queue.pending_count` goes 1→0 and a `follow-up:%` command is recorded |
| 04 | Reopen a long Session: bounded history, plan, `/copy`, scroll (VC-315) | [04-reopen-long-session.md](04-reopen-long-session.md) | More than 256 events, then reopen shows `Show earlier`, scrolling up mounts `msg 01`, and `/copy` toasts `Copied last reply` |
| 05 | Settings: toggle the `cloud` experimental flag | [05-settings-cloud-flag.md](05-settings-cloud-flag.md) | Switch `Volli Cloud (unstable)` is checked, and `app_state['volli:experimental-flags']` = `{"cloud":true}` |

## Conventions used in every file
- `vd-xxxx` is the instance id `launch` printed. `N` is the `generation:` from the latest snapshot. `eA`, `eB`, … are refs taken from the matching `find` output. `act` refuses a stale generation, so take the gen and ref from the most recent `find`/`snapshot`/`act`.
- Display ids are `DRV-<ticket_number>` (fixture `basic`, project `Drive Project`). SQL joins go through `projects.ticket_prefix='DRV'`.
- Session message **bodies are not in SQLite**. They live in gzipped transcript artifacts. In SQL you can only prove counts and digests (`session_events.payload`); read text with `state cli session answer|peek <short-id>`.
- Every label or table cited is anchored at `path:line` in the file where it appears. If a selector stops matching, grep that file first.
- `UNVERIFIED:` marks anything the code didn't settle. Confirm it on the live build and then remove the mark.

## Shared selectors (most-used)
| What | Accessible name / role | Source |
|------|------------------------|--------|
| Board create | button `New ticket`; column button `New` | board/board-header.tsx:185-191, board/board-column.tsx:540 |
| Nav | buttons `Home`, `Settings`; tablists `Home tabs`, `Ticket tabs` | sidebar/nav-list.tsx:21, sidebar/primary-sidebar.tsx:115, home/home-tab-strip.tsx:172, ticket/ticket-tabs.tsx:487 |
| Start chat | button `New chat` (⌘T) | sessions/new-session-control.tsx:262-263 |
| Composer | textbox `Message`; buttons `Send` / `Queue` / `Stop turn` | chat/composer-ui.tsx:910, :741, :711 |
| Palette | button `Search tickets and sessions` (⌘K) | chrome-bar.tsx:325-326 |

(Component paths are relative to `apps/desktop/src/renderer/src/components/`.)
