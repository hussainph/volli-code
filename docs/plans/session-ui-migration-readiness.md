# Session UI migration readiness

> **Runtime direction superseded since 2026-08-10.** The OpenCode runtime this
> document plans continuation for was removed in Session 7; see
> [`pi-native-ticket-session.md`](pi-native-ticket-session.md). The
> landed-state evidence below remains useful, but native adapter selection and
> OpenCode continuation are not the target product architecture.

Sessions 1–5 are landed. Chat is part of the production Session UI, and a chat
that has no ticket opens its own conversation from Sessions.

OpenCode surface parity is outside this plan. See
`docs/plans/opencode-surface-audit.md` for that work.

## Current model

- Terminal and chat adapters share one durable Session identity and ledger.
- Local durable history is canonical. Streaming state is a transient overlay
  that settles into the ledger and transcript artifacts.
- Chat subscriptions survive view unmounts. Durable Sessions and drafts
  rehydrate after app relaunches.
- A chat stays in its ticket tabs while that ticket remains on the board. A chat
  is ticket-independent when it was born without a ticket or its former ticket
  is no longer present. Ticket-independent chats host their conversation on
  Sessions, keyed by the project.

## Landed

- Runtime discovery and settings are project-aware, with explicit native
  adapter selection and no silent terminal fallback.
- Delta frames keep streaming transient while preserving durable settle points.
- Chat creation uses the owner-keyed boot guard and persists the Session before
  adapter attachment.
- Drafts and chat titles persist across relaunch.
- The sidebar lists durable Sessions and does not infer placeholder rows from
  ticket status. A row is selected only when its own tab or pane is in front.
- Destructive worktree actions account for live terminal and native bindings.

- Session 5: the Terminals navigation label is Sessions (route key unchanged),
  the scratch surface hosts chat tabs beside terminals with one Terminal/Chat
  creation menu, `useChatSessionsStore.openTabs` keys by surface owner (ticket
  id while the ticket is on the board, project id otherwise — the UI host key
  never rewrites durable ticket history), and a sidebar row for a
  ticket-independent chat — including rows the Cleaned up filter reveals —
  opens its exact conversation on Sessions.

The implementation and proof for the first four sessions live in PRs
#170–#182 and `docs/plans/delta-frames.md`; Session 5's proof is
`apps/desktop/e2e/sessions-chat-host-smoke.mjs`. Git history retains the audit
trail removed from this status page.

## Remaining risks

- `sessions.list` refolds every event for every Session behind a 10-second poll.
  Replace it with a cache or push projection before the cost becomes visible.
  Visible today as sidebar titles lagging a chat's auto-retitle.
- Previous is unbounded, and exempt scratch Sessions can accumulate forever.
- A crashed adapter server can strand a live native binding, and chat
  attachments have no boot-recovery path after a relaunch — only terminals
  recover theirs.
