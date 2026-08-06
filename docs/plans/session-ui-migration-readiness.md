# Session UI migration readiness

Whether the lab chat surface is mature enough to become the app's real Session
UI, and what stands between here and there. The answer is now: it was, and it
did — sessions 1–3 of the approved four-session order are landed, and the chat
surface lives in the app. The audit trail that produced this plan lives in this
file's git history.

Not the OpenCode-parity backlog; `opencode-surface-audit.md` owns that, and
the answer there is deliberately no.

## Where it stands

Migration 018 settled the foundation before the audit began: terminal and
structured paths are one Session identity in one ledger. A chat Session is a
second adapter on that identity, not a second notion of session.

1. **Transport + harness settings — shipped** (PRs #170/#171). Runtime
   Catalog over IPC, `projectId` routing through a per-directory hub,
   `api.sessionRpc` preload door, multi-harness settings with a validated
   per-harness binary override, login-shell PATH proven under a bare-PATH
   launch. The named seam — discovery per-project, persistence global — closed
   in session 4 (PR #181): migration 019, `projectId` as the scope on
   `inspect`/`save`/`resolve`/`clear`, and the Configure → Runtime surface.
2. **Delta frames — shipped** (`docs/plans/delta-frames.md` is the record).
   Streaming is a transient overlay over durable settle-point snapshots;
   wire 19.63× → 2.55×, artifact writes and ledger events per answer
   397 → 1, fence churn 33,309 → 689.
3. **The move — shipped** (`session/chat-move`). The chat surface is the
   app's: pure core in `src/renderer/src/chat/` and components in
   `components/chat/`, all pure `.ts` coverage-enrolled at 100%. The
   resident core replaces the lab controller: a per-sessionId store
   (`stores/chat-sessions.ts`) plus a client registry
   (`chat/registry.ts` / `chat/client.ts`) that owns the subscription, so
   streaming survives view unmounts; reconnect hands the tracked id back as
   `lastEventId` alongside `afterSequence` (both, deliberately — each covers
   a gap the other has); re-attach after failure keeps the durable id with
   `continuity: "fresh"`. A chat Session is a ticket tab
   (`kind: "chat"`, tab id `chat:<sessionId>`), opened from the tab
   strip's "+" menu (Terminal / Chat), adopted lazily on activation and
   after relaunch. The Session listing is a discriminated
   `SessionListingRow` union — terminal rows byte-identical to before, chat
   rows honest about what they are — decided once in `data-ipc.ts`; the
   sidebar and ticket rail name chat Sessions and count them live. The lab
   scratch survives as a thin shell over the app's own components; scenarios
   stay lab-only, passed through the executor parameter.

Hardening that landed with the move, found by live use and a hands-on drive:
the ticket worktree is materialized at attach through the same `ensure`
pipeline the terminal uses (`SessionLocationResolver.prepare`, attach-only —
`resolve` stays cheap for every other command, and the binding persists the
directory `prepare` returned, never the pre-materialization read; a third
verb, `reaffirm`, later closed the gap that left — a checkout deleted under an
open attachment is put back at the same path before the next turn); the
adapter repeats OpenCode's `error.data.message` in attention detail while
keeping bodies and headers redacted; the blocker renders the cause, not just
the headline; a new assistant message id counts as turn-start evidence, so a
missed `busy` event (an SSE reconnect gap) can no longer wedge a Session
working and silently drop a turn's durable settle.

Proof: `e2e/session-chat-smoke.mjs` drives the built app through binary
override → model enable → "+" → Chat → prompt → streamed answer → settle →
second turn → relaunch, asserting both answers come back from the durable
transcript with no live adapter, and the worktree exists on disk. The fake
OpenCode server (`e2e/lib/fake-opencode-server.mjs`) speaks the adapter's
real wire contract, including `session.status` busy.

## Settled decisions

Settled 2026-08-04/05; do not reopen.

1. **Coverage: the pure `.ts` chat modules enrolled with the move — done.**
   `.tsx` stays excluded; the correctness core (store, client, registry,
   transcript fold, wire validators) is where transport, lifecycle and
   delivery live, and all of it is behind the 100% gate.
2. **Mermaid stays; math is gone.** The remaining bundle lever is the
   duplicated Shiki grammar/theme set (82 chunk names in two copies);
   the +192 KiB gzip on the eager boot chunk is the number that matters.
3. **The frame shape landed inside migration prep — done.** See
   `delta-frames.md`.

## Not blockers — recorded so they are not re-filed

- **Virtualization.** Measured clean to 500 turns. A "when", not an "if".
- ~~**A live-but-idle chat sorts and dots as concluded** in Active Sessions
  while its label reads "Chat · Live"~~ — settled by the two-band sidebar: a
  chat row now draws its activity, dot and sort position from
  `ChatSessionRecord.activity`.
- **`prepare` skips the terminal path's containment guard** (defense-in-depth
  against a hand-edited `worktree_path`); the module comment doesn't
  overclaim it.
- **The CLI socket lists terminal sessions only** — deliberate; its verbs
  are terminal-shaped.
- Deferred and genuinely post-migration: dead vendored `ai-elements`
  exports (~1,500 lines, `code-block.tsx` 522 of them); `lucide-react`
  drift; a shared segmented-pill primitive; duration tokens; a crashed
  `opencode serve` stranding live bindings; `PROJECTION_CACHE_LIMIT = 8`
  thrashing past 8 live sessions.

## Session 4 — shipped (2026-08-06, stacked PRs #180/#181/#182)

- **#180** — one creation seam: chat boots through `session-create.ts`'s owner
  guard (landing gated on the create, never the attach); listing rows carry
  real `activity`/`lastActivityAt`; drafts survive relaunch
  (`stores/chat-drafts.ts`, one capped blob); chat rename everywhere
  (`chat/rename.ts` — the optimistic writes are load-bearing).
- **#181** — per-project runtime pickers, end to end (see item 1 above).
- **#182** — the two-band sidebar. Pure core in `active-session-listing.ts`:
  Active (waiting pinned by owner decision · working · quiet ≤30 min) and
  Previous (one-line rows, passive cleanup —
  archived/gone ticket, Done ≥1h and predates-column-move via
  `volli:ticket-status-entries`, >7 d; born-ticketless exempt, orphans not;
  everything reachable under the "Cleaned up" filter item). Every row is a
  Session: the rule that guaranteed one row per Doing/Needs-Review ticket is
  gone, because it filled Active with ticket titles while the real Sessions sat
  below in Previous — the board is where a ticket's status lives, and Active
  showing nothing is the honest answer to nothing running. A row is selected
  only when its own tab is the one in front of you: selection used to fall back
  to "its ticket is open", which lit every row a ticket had at once. That
  fallback existed because chat rows carried no target at all — they carry their
  `chat:<sessionId>` tab id now, so the chat you are in is the one that lights,
  and clicking a chat row opens the conversation instead of the Ticket Body.
  Chats auto-title from their first delivered message. The lab scratch imports
  the shipped band components, so the prototype cannot drift.

## Session 5 owns

- **Terminals → Sessions**: nav label rename (routing key `sessions` stays),
  the page hosts chats (adopt the ticket tab-strip pattern, not `SessionTabs`),
  scratch-chat creation ("+" → Terminal | Chat; `bootChatSession` scratch scope
  already works), `useChatSessionsStore.openTabs` rekeyed ticketId → ownerId
  (`active-sessions.tsx` already tolerates the new key). A ticketless sidebar
  row currently lands on the page, not in its Session — that is the seam.
- The 5 nav-label smokes (`terminal-smoke` ×4 clicks + 2 DOM predicates,
  `park-smoke`, `memory-smoke`, `ghostty-config-smoke`), `docs-shots.mjs`
  recapture + `ticket-workspace.mdx` band alt-text, and
  `ticket-detail-smoke.mjs:920`'s page-wide menu-button locator (scope it to
  the active band like board-smoke's warning comment says).
- Known bills, flagged in review, deliberately unpaid: `sessions.list` folds
  every event of every session and is now behind a 10 s poll (wants a push
  channel or a cache; the code comment names it); Previous has no cap or
  virtualization, and exempt scratch Sessions accumulate forever; the
  lab/app duplicate of the filter mapping.
