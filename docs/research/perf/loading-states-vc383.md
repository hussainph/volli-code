# Hitches, beachballs and what the user looks at while waiting — VC-383

Scope: every place the app makes a person wait on a transition — opening a
ticket, switching projects, switching chat tabs, starting a Session — and the
two ways that wait goes wrong. The worst is the **beachball**: Electron main
runs the macOS event loop, so anything that blocks main for more than a second
freezes every window at once, whatever the renderer was doing. The lesser is
the **false empty**: a surface that has not been read yet drawing the sentence
for "there is nothing here".

Method: four read-only audits of the tree at `42b6b732` (main, after
VC-369/372/373/374 landed), one per layer — synchronous work on main, the
Session read path, the IPC read handlers and their SQL, and the renderer's
pending states — each claim cited to `file:line` and re-verified by hand before
anything was changed. The perf docs beside this one (`ipc-rpc-sqlite.md`,
`session-rpc-sqlite-vc355.md`, `architecture-simplifications.md`) cover the
read-path costs in more depth; this note is about what was still on the main
thread and what the person sees.

## What was found

### Synchronous git children on Electron main (the beachball)

VC-369 measured the shape: five serial `execFileSync` children gave the event
loop **zero turns for 1.6 s**. It moved the rail's status/diff reads off the
sync runner. These were still on it:

| Path | What ran sync | Reached by |
|---|---|---|
| `worktree/scan.ts` orphan scan | `worktree list` per project + 5 probes per orphan (`dirty.ts`) + `log -1` per orphan | every launch (after first paint) and every Settings → Storage visit; cost ∝ registered worktrees |
| `worktree/remove.ts` | the 5 dirty probes, `worktree list`, `git worktree remove` (deletes the whole checkout, `node_modules` and all, in one child), `rmSync` for a forgotten dir, `worktree prune` | "Remove worktree…" — **and unattended**: the retention reclaim fires it from a 60 s poll and on every window focus |
| `worktree/trim-sweep.ts` | `worktree list` per project | Settings trim scan / trim all |
| `worktree/commit.ts` | sequencer `rev-parse` + `status --porcelain` | the Done rail's commit and push |
| `harness-workspace.ts` | `ls-files` per workspace file + `rev-parse --git-common-dir` | **every terminal and Session start** |
| `project-base-branch.ts` | `symbolic-ref` + `branch --show-current` | adding a project |
| `worktree/cleanup.ts` | the same probes, plus `worktree remove` / `prune` | confirmed orphan cleanup |

### The Session read path

- **`session.snapshot` read one artifact per transcript event, serially.**
  Each is an lstat, a file read, a gunzip and a digest; a thousand-turn
  Session paid a thousand serial filesystem round trips before its chat could
  paint a message, with the disk idle most of that wall time
  (`packages/session-engine/src/session-runtime.ts` `snapshot`).
- **`sessions.list` folds every Session of a project inside one SQLite
  transaction**, on main, with no event-loop turn between them
  (`session-engine.ts` `listSessions` → `projectStoredSession` per row). The
  checkpoint row bounds each fold to a ≤64-event tail, and the renderer reads a
  project's listing once per run (`stores/project-sessions.ts` `ensure`), so it
  is one synchronous block per first visit, sized by Session count.
- The in-memory fold cache holds **8** Sessions (`PROJECTION_CACHE_LIMIT`),
  sized for "one or two open at a time".

### The IPC read handlers (all synchronous SQLite on main)

- **`data.bootstrap` runs wholesale on every `volli:data-changed`** — every
  live ticket of every project, `body` included, plus the label join — and every
  socket-originated mutation broadcasts one (an agent posting a comment per
  turn is a full re-bootstrap per turn). An 8 ms coalescer folds bursts; it does
  nothing for steady-state chatter from a dozen agents.
- `sessions.starts` scans every `sessions` row ever (no `created_at` index);
  `usage-report` with `scope: "all"` has no predicate at all; provenance's third
  query filters `ticket_events` on `json_extract` with no usable index.
- `ticket-events` and `comment-list` are indexed but unbounded per ticket.

### What the renderer drew while waiting

| Surface | Pending condition | Drew |
|---|---|---|
| Chat plane (`chat-plane.tsx`) | `projection === null`, snapshot in flight | the **empty state's venue drawing** — "nothing was ever said here" |
| Ticket rail Sessions panel | `byTicket[id] === undefined` | **"No active sessions"** |
| Sidebar Active / Previous bands | `listingState === "loading"` (tracked, never read) | **"No active sessions" / "Nothing yet"** |
| Home rail Sessions page | same store, same unread bit | **"No sessions yet"** |
| Ticket Activity feed | no cache entry (first open) | an empty `<ul>` — nothing at all |
| Body / File editor | Monaco runtime chunk loading | a bare box (128 px on the Body, the whole pane on a File) |
| Ticket Files / Changes panels, PR checks, Home Files | — | already `RailPanelSkeleton` (correct; the reference pattern) |
| Board | — | purely in-memory; no per-switch wait exists |

The brief's premise that chat tabs already had skeletons turned out to be the
one place the audit contradicted: the chat drew the empty state, which is worse
than blank, because it makes a claim.

## What changed

Five commits, in the order the risk ranks:

1. **`perf(worktree)` — off the main thread.** `scan.ts`, `remove.ts`,
   `trim-sweep.ts`, `commit.ts` and `harness-workspace.ts` run on the async
   runner; `remove.ts` uses `fs/promises`. `dirty.ts` states each §7 rule once
   as a probe and gains `isWorktreeDirtyAsync`; the confirmed cleanup keeps the
   sync driver on purpose (its no-await gate is the deletion lease's TOCTOU
   guard). Reads stay serial — the fix is that main keeps turning, as VC-369
   reasoned.
2. **`perf(session-engine)` — overlapped artifact reads.** `snapshot()` reads
   transcript artifacts through a worker pool over a shared cursor, at most
   `SNAPSHOT_ARTIFACT_READ_CONCURRENCY` (16) in flight, order preserved.
3. **`feat(chat)` — a transcript skeleton** while history is pending, gated on
   `projection === null && !provisional && sessionError === null`, in the
   transcript's own `ContentColumn`/`Message` geometry.
4. **`feat(sessions)` — listings hold their rows** until the read has
   answered: `ListRowSkeleton` beside `ListRow` (ticket panel, Home page) and
   `SessionBandRowSkeleton` beside the band row (sidebar). The heading's "+"
   stays live above a pending list.
5. **`feat(ticket)` — the Activity feed and the editors.** Two bunch rows'
   worth of the feed's line; and for Monaco, two pseudo-elements keyed on the
   `data-monaco-status="loading"` stamp (CSS rather than children, because the
   host is Monaco's mount point), with the stamp now on the host from the first
   frame.

Each loading state follows the same rule (`ic-methods`, responsive
performance): a skeleton holds **exactly the box its content will take**, in
the surface's own geometry, carries no words, and is shown only where the
surface can say the read is *pending* — never over a failure (the failure is
what shows), never over a Draft (its null projection is the truth).

## Deferred — with the reason, and the shape of the fix

These were found, judged out of this ticket's scope, and are left here so a
follow-up can pick one up without re-auditing.

| # | Finding | Why deferred | Fix shape |
|---|---|---|---|
| D1 | `data.bootstrap` on every `data-changed`, bodies included | A contract change on the renderer's recovery guarantee (`refreshPlanningData` is "always wholesale" by design) and on `useBoardStore.hydrate`'s identity semantics; needs its own measurement under a dozen agents | Scope the re-read to `change.projectId` when it is known; drop `body` from the roster and read it per open ticket; or carry the changed row on the broadcast so the renderer patches |
| D2 | `session.snapshot` replays the whole history per fresh open | The renderer already windows the DOM (`transcript-window.ts`); the wire and the fold do not. Pagination is a `session-rpc` procedure change with `session-presentation` on the other end | `session.projection` first, then a windowed frame read from the tail (`#readEvents` already takes `afterSequence`/`limit`) |
| D3 | `listSessions` folds N Sessions in one transaction | Per-session cost is bounded by the checkpoint; the block is per first visit. Splitting the transaction changes the ledger's serialization story | Per-session transactions with a yield between, or cache listing rows per `(sessionId, throughSequence)` and re-fold only the ones whose `MAX(sequence)` moved |
| D4 | `PROJECTION_CACHE_LIMIT = 8` | Needs a measurement with dozens of open tabs before choosing a number or an eviction key | Key eviction to "has an open tab" rather than pure LRU |
| D5 | `cleanup.ts` sync probes on the confirmed cleanup | Deliberate: the no-await gate between last look and delete is the lease's guarantee. User-confirmed and rare | A worker thread for the gate, or a modal progress surface that owns the freeze honestly |
| D6 | `volli:project-create` base-branch detect (2 sync spawns) | A rare click; the handler is invoked synchronously by dozens of fixtures | Swap to `detectProjectBaseBranchAsync` and make the handler async |
| D7 | `sessions.starts` unscoped scan; `usage-report` `scope: "all"`; provenance's `json_extract` filter | Settings / usage surfaces, not transition paths | `sessions(created_at)` index; bounded default window + keyset paging; materialize the session→ticket link on write |
| D8 | `chat-plane.tsx` `groupTurns` walks the full transcript per streamed frame | Self-documented trade; the transcript window slices the *rendered* rows after | Fold the grouping incrementally on the live turn only; bench on a long Session first |
| D9 | `theme/apply.ts` forced `getComputedStyle` per live terminal on a committed canvas change | Already skipped for transient paints; fires once per project switch into a project with its own canvas | Batch the terminal refreshes behind one style read |
| D10 | `useMaterializedAttachments` — inline images unresolved while the strip loads | Cosmetic, shared across chat/body/comments | A sized placeholder per image while `links === NONE` |
| D11 | Backup bundle build reads every blob and transcript synchronously and `gzipSync -9`s the archive | Rare; trigger wiring not found from the audit | Stream the bundle; async `readCanonicalBytes` already exists |

## Verification

- `apps/desktop` main suites for `worktree/{scan,remove,retention,trim-sweep,
  cleanup,dirty,publish,commit,sequencer}` and `harness-workspace`: 163 tests,
  green, with the scripted runner recording both seams into one call list so
  every call-count assertion held unchanged.
- `packages/session-engine`: 283 tests at the package's 100% coverage gate,
  including the bounded-window test that holds both edges of the bound.
- Renderer suites for the chat plane (4 files), the ticket Sessions panel (3),
  the sidebar, Home rail, Activity feed and both editors: green, each new
  loading state proven pending-then-settled against a read held open and then
  answered.
- `vp check` clean; `pnpm typecheck` clean; `generate-theme-css.mjs --check`
  up to date.
