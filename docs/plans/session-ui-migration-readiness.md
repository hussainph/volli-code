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
   launch. The named seam for session 4's per-project pickers — **discovery is
   per-project, persistence stayed global** — is now closed on the storage
   side: migration 019 adds `projects.runtime_preferences`, an adapter-keyed
   JSON override of `volli:runtime-preferences:<adapterId>` where `NULL` means
   inherit, and `projectId` travels into `inspect`/`save`/`resolve` as the
   scope (presence IS the scope) beside `clear`. What remains is the UI.
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
directory `prepare` returned, never the pre-materialization read); the
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

## The remaining plan

Session 4 has started: chat creation now funnels through `session-create.ts`'s
owner guard, per-Session drafts persist (`stores/chat-drafts.ts`), chat Sessions
rename from the tab strip and the rail (`chat/rename.ts`), and the sidebar's
session list is two bands — Active and Previous — with passive cleanup and a
chat/terminal filter on Previous. Still outstanding: the Terminals→Sessions nav
rename and Sessions-page chat hosting (a ticketless row lands on the page, not
in its Session); the per-project runtime pickers themselves — storage, catalog
and RPC are in place (see the seam above), so what is left is the Configure
surface that reads `preferencesOrigin` and sends `clear`.
