# Pi-native Ticket Session — Session 0 audit

**Checked:** 2026-08-08

**Branch:** `migrate/opencode-pi-audit`
**Decision record:** [pi-native-ticket-session.md](./pi-native-ticket-session.md)

This is the Session 0 implementation inventory. It records the current
OpenCode-backed production path and the smallest safe landing seam for the
singular Pi-backed Agent Runtime. It does not authorize Pi implementation or
OpenCode deletion by itself.

## Scope and measurement

The audit traced the local structured-chat path through Electron main, Session
Engine/RPC, preload, renderer chat state, settings/catalog, durable ledger and
artifacts, and packaged desktop smokes. Of 857 tracked `*.ts`, `*.tsx`, and
`*.mjs` files, a case-insensitive literal scan found 121 with `opencode` in
their contents. Under the explicit test/e2e classification of `*.test.*` or an
`/e2e/` path, 74 of 336 test/e2e files and 47 of the remaining 521 files are
direct hits. This is a dependency locator, not a claim that every hit is
structured-runtime debt; terminal compatibility, fixtures, comments, and
historical lab code are included. The concentrated adapter package is 10,942
tracked lines: 3,476 production, 7,424 tests/benchmark, and 42 configuration or
manifest lines.

The current structured producer is singular in practice: Electron registers
only `createOpenCodeNativeAdapter` in [main](../../apps/desktop/src/main/index.ts).
The generic registry, profile, and Runtime Catalog layers nevertheless make
that singular producer look like an extensible multi-harness platform.

### Documentation contradiction

`docs/ROADMAP.md` still describes a harness-agnostic meta-harness and
cross-harness continuity. It is ignored by `.gitignore` and absent from the
tracked tree, so Session 0 cannot safely correct it in this PR. Treat the
tracked Pi-native decision record, `CONTEXT.md`, `AGENTS.md`, and `CLAUDE.md` as
the authoritative migration direction until roadmap ownership is resolved.

## Exact production path

1. Ticket Chat calls `createChatSession`, which first commits `session.create`,
   seeds renderer state, connects its subscription, then attempts an executor
   attach in [chat-sessions.ts](../../apps/desktop/src/renderer/src/stores/chat-sessions.ts).
2. `ChatClient.attach` sends `adapter.attach` with the default OpenCode
   `adapterId` and `profileId`; `submit` later carries selected provider/model,
   variant, and agent fields in [client.ts](../../apps/desktop/src/renderer/src/chat/client.ts).
3. Electron main creates the SQLite-backed Session Engine, one OpenCode native
   adapter, a `NativeAdapterRegistry`, transcript artifact store, and a
   project-scoped Runtime Catalog hub in
   [main/index.ts](../../apps/desktop/src/main/index.ts) and
   [session-runtime/index.ts](../../apps/desktop/src/main/session-runtime/index.ts).
4. The Session Runtime persists `executor.start`, prepares the Ticket worktree,
   probes the selected native profile, attaches it, and commits observations in
   [session-runtime.ts](../../packages/session-engine/src/session-runtime.ts).
   OpenCode SSE is mapped by `@volli/opencode-adapter`; the Session Engine owns
   ordering, receipts, and the transient-overlay versus settled-artifact split.
5. The SQLite ledger stores Session rows, attachments, commands, events, and
   receipts; settled transcript artifacts are indexed on disk. The relevant
   schema lives in [migrations.ts](../../apps/desktop/src/main/db/migrations.ts)
   and persistence adapter in
   [sqlite-ledger.ts](../../apps/desktop/src/main/session-control/sqlite-ledger.ts).
6. Session RPC transports snapshots and ordered frames over preload IPC. The
   renderer projects settled events plus transient deltas into the resident chat
   store and existing transcript/activity/interaction components.
7. The same OpenCode adapter feeds Runtime Catalog discovery and its saved
   provider/model/agent preferences through
   [runtime-catalog.ts](../../apps/desktop/src/main/runtime-catalog.ts) and
   [session-rpc/index.ts](../../packages/session-rpc/src/index.ts). Settings
   owns exhaustive discovery; chat receives a bounded saved selection.
8. [session-chat-smoke.mjs](../../apps/desktop/e2e/session-chat-smoke.mjs)
   exercises the packaged desktop path against a fake OpenCode producer,
   including Ticket worktree binding, turn streaming, recovery, and relaunch.

## Disposition inventory

| Disposition | Keep or change | Basis |
| --- | --- | --- |
| Preserve | Session identity; command/receipt ordering; SQLite ledger; transcript artifacts; transient streaming overlay; RPC/preload transport; worktree preparation; Attachments/Runtime Brief; Change Sets; resident chat store, drafts, inline activity and interaction UI; terminal process residency | These are product invariants or useful client infrastructure independent of OpenCode. |
| Simplify | `NativeHarnessAdapter` and registry into one private runtime port; attachment native reference; recovery coordination; model/catalog projection; Settings navigation | Present contracts overgeneralize a single structured producer. |
| Replace | OpenCode host with `@volli/agent-runtime`; Runtime Catalog with sanitized Model Access; provider-shaped prompt/tool mapping; Plan/agent-mode presentation; permanent Session rail content | These encode OpenCode discovery or provider vocabulary rather than Volli semantics. |
| Delete after proof | `packages/opencode-adapter`; structured OpenCode process supervision, catalog wiring, chat defaults, test fixtures and fake OpenCode packaged smoke; structured profile/adapter selection; synthesized Plan dock and provider-shaped rail | Delete only after Pi proves create, stream, settle, and relaunch recovery. |
| Preserve separately | Terminal manifests, trust, wrappers, hooks, launch commands, CLI correlation, and honest terminal resume | These support explicit manual terminal companions and do not become structured fallbacks. |

The unreachable Session rail mode and production-dead renderer catalog projection
are safe cleanup candidates. Do not remove the active OpenCode model picker,
catalog/settings, Plan dock, adapter fields, or packaged OpenCode smoke before
the Pi path replaces their active behavior.

## Temporary Pi landing seam

`@volli/agent-runtime` is a Node-capable package with no Electron, DOM,
renderer, SQLite, or Pi types in its product contracts. Electron main hosts it
locally; a future worker can host the same package.

The existing coordinator may receive a private desktop facade for the first Pi
slice, but the facade has one fixed internal identity. It must not leak
registries, manifests, profiles, catalog selection, or capability parity through
Session RPC, persistence, or React. Runtime Brief, Authority Snapshot, tool
policy, delivery outcomes, and recovery reference become real product-owned
Agent Runtime inputs/outputs. At cutover the host, not React, attaches the sole
structured runtime.

## Schema and data policy

The durable Session ledger is retained. Existing OpenCode attachments and
transcripts may remain readable where cheap, but Pi never resumes an OpenCode
native identity or silently continues its conversation. A bounded explicit
development-data reset is acceptable if it produces a simpler schema; it must
be documented and must not touch unrelated Ticket, Project, worktree,
Attachment, Change Set, or terminal data. No compatibility layer is warranted
solely for pre-launch OpenCode structured data.

## Proof ladder

1. Deterministic Agent Runtime contract fixtures: pinned Pi input, no ambient
   extensions, command-before-delivery, semantic observations, and sanitized
   errors.
2. Session Engine and RPC/preload tests: receipt ordering, transient-versus-
   settled artifact behavior, recovery cursor, and serialization.
3. Desktop integration: Ticket worktree preparation, one runtime attachment,
   stream projection, Stop, failure Attention, and close/reopen.
4. Packaged Electron Pi smoke: create, submit, stream, settle, relaunch, and
   deduplicated recovery. Live paid inference remains manual and cost-reported.
5. Only then delete OpenCode structured runtime code and fake-producer smoke;
   terminal OpenCode remains an unrelated manual command.

## Freeze and resolved decisions

Session 0 freezes structured OpenCode feature-parity work. Audit work starts
from `eee39a4f` (`docs: define Pi-native agent runtime direction`) with no
Session 0 runtime implementation on this branch.

- Project and ticketless Sessions are not disabled. Their later product slice
  moves them to the singular runtime rather than retaining OpenCode forever.
- Ticket authority initially persists a durable `Auto` snapshot. The composer
  shows no fake authority control until a real inspect/change action exists.
- Pi owns credentials in the first slice. Authentication recovery is an
  explicit external/terminal Pi handoff plus Retry; scope an in-app connect flow
  immediately after that working handoff.
- External harnesses remain explicit terminal companions, never structured
  fallback adapters.

No unresolved product decision blocks Session 1. The next implementation work
is a fresh, bounded Pi Agent Runtime package slice; this audit does not combine
that work with cleanup.
