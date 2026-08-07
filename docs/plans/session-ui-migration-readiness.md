# Session UI migration readiness

Sessions 1–4 are landed. Chat is part of the production Session UI. Session 5
completes the remaining navigation seam. A chat that has no ticket must open
its own conversation from Sessions.

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
  is no longer present. Ticket-independent chats are durable and listed, but
  Sessions cannot host their conversation yet.

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

The implementation and proof for the first four sessions live in PRs
#170–#182 and `docs/plans/delta-frames.md`. Git history retains the audit trail
removed from this status page.

## Session 5

Session 5 owns ticket-independent chat hosting:

- Rename the Terminals navigation label to Sessions. Keep the `sessions` route
  key unchanged.
- Host chat tabs on Sessions using the ticket tab-strip interaction model.
- Key `useChatSessionsStore.openTabs` by surface owner id. Use the ticket id
  while the ticket remains on the board; otherwise use the project id. This UI
  host key does not rewrite the Session's durable ticket history.
- Offer Terminal and Chat from the scratch Sessions creation menu.
- Open the exact conversation when a sidebar row represents either a chat born
  without a ticket or a chat whose former ticket is gone. This includes rows
  shown by the Cleaned up filter.
- Update the affected navigation smokes, screenshots, accessibility text, and
  active-band menu locator.

Until this lands, ticket-independent chat rows remain durable and visible.
Selecting one opens Sessions without opening its conversation. In Session 4,
the Cleaned up filter controls visibility. Session 5 adds conversation hosting.

## Remaining risks

- `sessions.list` refolds every event for every Session behind a 10-second poll.
  Replace it with a cache or push projection before the cost becomes visible.
- Previous is unbounded, and exempt scratch Sessions can accumulate forever.
- A crashed adapter server can strand a live native binding.
