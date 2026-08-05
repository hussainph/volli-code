# Session UI migration readiness

Whether the lab chat surface is mature enough to become the app's real Session
UI, and what stands between here and there. This is the current plan and its
standing decisions; the audit trail that produced it — the original 2026-08-04
five-pass audit, the revalidation's eight corrections, and the blocker
taxonomy — lives in this file's git history and is superseded by what follows.

Not the OpenCode-parity backlog; `opencode-surface-audit.md` owns that, and
the answer there is deliberately no.

## Where it stands

The foundation question that could have sunk the migration was answered by
migration 018 before the audit began: the terminal path and the structured
path are one Session identity in one ledger
(`apps/desktop/src/main/db/migrations.ts`). A chat Session is a second
adapter on that identity, not a second notion of session. The schema does not
change.

Landed since, in the approved four-session order:

1. **Transport + harness settings — shipped** (PRs #170/#171,
   `session/transport-edge`). The Runtime Catalog routes over IPC with
   `projectId` as the routing key through a per-directory hub; the preload
   door is `api.sessionRpc` with the terminating tRPC link in
   `renderer/src/lib/session-rpc-ipc-link.ts`; the settings page is a
   multi-harness surface with a validated per-harness binary override; the
   `opencode serve` child gets the login-shell PATH via `resolveEnv`, proven
   under a launchd-like bare PATH (`e2e/opencode-env-smoke.mjs`). One seam
   stays named for the per-project pickers session: **discovery is
   per-project, persistence stayed global** — a second writer of
   `volli:runtime-preferences:<adapterId>` must scope the row or the save.
2. **Delta frames — shipped** (`session/delta-frames`;
   `docs/plans/delta-frames.md` is the record, contract and numbers both).
   Streaming is a transient delta overlay over durable settle-point
   snapshots; ledger, artifact schema, and cursor semantics unchanged. The
   probes are checked in with ceilings asserted: wire amplification
   19.63× → 2.55×, artifact writes and ledger events per streamed answer
   397 → 1, and the fenced-code churn fixed at its real root cause (a
   components-prop identity remounting every block per chunk) —
   33,309 → 689 mutations per streamed message. An end-to-end integration
   test drives scripted SSE through the real adapter, runtime, subscription,
   and renderer fold.

## What still gates the file move

- A resident structured-Session tab/store model and controller lifecycle
  tests. `useSessionController(sessionId)` instead of the lab's
  create-on-mount hook; `session.create` + `adapter.attach` become a store
  action returning a sessionId; transcript / queued composer / selection live
  in a per-sessionId store slice outside React, copying
  `terminal/registry.ts`. The app tab model is terminal-shaped today and
  needs a discriminated tab model or a separate resident registry.
- A discriminated Session listing DTO. A structured Session is honestly
  *absent* from the legacy terminal endpoints (`terminalSessionRecord`
  returns null for it) — absent is not visible, and the sidebar cannot name
  what it cannot see.
- An explicit post-provider-failure continuity contract. The lab controller
  already re-attaches on the same durable id as a fresh provider
  conversation; the store action must keep that shape and its honesty.
- The reconnecting client. Resume from a cursor over IPC is deliberately not
  built in the transport — every tracked id already rides out as the result
  id, and the consumer that hands one back as `input.lastEventId` is the
  chat controller's job. Not a bug to re-file.
- Decomposing `chat-session.tsx` (scratch scaffolding out, ~280 lines of
  pure logic already extracted) and de-labbing the controller (three lab
  imports, a hardcoded title, a scenario branch, the `labDiagnostics`
  effect).
- Coverage enrollment with the move (decision 1 below) and a packaged
  Session-chat smoke alongside it.

Session 4 after the move: creation surfaces funneling through `bootSession`
and the sidebar going chat-first with a chat/terminal filter.

## Settled decisions

Settled 2026-08-04/05; do not reopen.

1. **Coverage: enroll the pure `.ts` chat modules with the move.** Repo
   convention holds — `.tsx` stays excluded. The debt is ~5 files dominated
   by `session-controller.ts`, which is where transport, lifecycle and
   delivery correctness live; nothing about the move enrolls it
   automatically, so it must be added to the allowlist explicitly.
2. **Mermaid stays; math is gone.** The remaining bundle lever is the
   duplicated Shiki grammar and theme set (82 chunk names in two copies,
   including grammars `renderer/src/editor/shiki-langs.ts` deliberately
   curated out). Dedupe against that list; the +192 KiB gzip on the eager
   boot chunk is the number that matters.
3. **The frame shape landed inside migration prep — done.** See
   `delta-frames.md`. The adapter's exact-object part-mapping churn was the
   priced-in cost and has been paid.

## Not blockers — recorded so they are not re-filed

- **Virtualization.** Measured clean to 500 turns; a realistic all-day
  session is fine. A "when", not an "if", and not this migration.
- **Composer latency** — sub-millisecond under token flood with live
  highlighting.
- **Subscription fan-out** — one `setState` per paint; the per-delta cost
  that used to sit upstream of it was the thing delta frames removed.
- **Lint/type debt** — none; the lab has no exemptions anywhere.
- **Deps** — everything the chat needs is already in `dependencies`; the
  `@ai-elements/*` alias is wired in both configs.
- **twMerge, tokens, copy, a11y** — the four custom font-size tokens are
  registered; one dead hex fallback; no helper text; two small a11y gaps
  (`interaction-ui.tsx` unlabeled textarea, `chat-session.tsx` title-only
  detail).
- **The one-way lab rule holds** — zero imports of `renderer/lab` from
  `renderer/src` or `preload`.
- **`lab/lab.css` is not stale** and `createSessionRecord` has a test-fixture
  caller — both were checked and survived; do not re-file either as a fix.
- Deferred and genuinely post-migration: `ai-elements/code-block.tsx` (dead,
  522 lines) and ~1,500 lines of unreferenced vendored exports;
  `lucide-react` drift; a shared segmented-pill primitive; duration tokens;
  a crashed `opencode serve` stranding live bindings;
  `PROJECTION_CACHE_LIMIT = 8` thrashing past 8 live sessions.

## The remaining plan

Workstream 2 — the controller reshape — then the move, which is a file move
plus wiring once the gates above are true. Two things land *alongside* the
move rather than after it, because they are wrong the moment a chat Session
exists in the app: the discriminated Session listing, and coverage
enrollment.
