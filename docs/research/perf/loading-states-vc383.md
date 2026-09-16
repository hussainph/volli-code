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

## What the review pass changed

A four-axis review of the above found that the rule in the paragraph before
this one was **stated but not held**, and that the branch's headline claim was
untested. Five commits answer it.

1. **"Never over a failure" was true of one surface in five.** The Chat plane
   gated on `sessionError`; nothing else could see a failure at all. The ticket
   roster and the Activity feed inferred *pending* from a MISSING cache entry,
   and neither store wrote one when the read was refused — so a failed read
   left the skeleton pulsing forever, a worse hang than the freeze it replaced.
   The sidebar bands and the Home Sessions page had the opposite fault: the
   project store has recorded `failed` since the push channel landed and
   neither surface read it, so a refused listing fell through to "No active
   sessions" — the false empty this whole note is about.

   The fix is the shape the project store already had: the baseline's outcome
   is DATA beside the rows (`loading | loaded | failed`, with the detail), not
   an inference each component redoes in JSX. That also answers the review's
   architecture finding — four private request-state protocols in desktop JSX
   are four things a future non-Electron client would have to reinvent. The
   Activity feed's baseline read moved into its store with it, being the last
   of the five still living in a component.

2. **The move off `execFileSync` was unprovable.** `scripted-git.ts` recorded
   both runners into one call list and `WorktreeDeps.gitAsync` was optional
   with a fallback to the real runner, so reverting `remove.ts` to the sync
   seam passed 70 of 71 tests and reverting `scan.ts` passed 25 of 25. The
   seam is required now, the fixture records each runner separately, and the
   same mutations fail six tests.

3. **`remove()` ran unleased.** The window pre-dates this branch — `remove`
   already awaited `releaseAgentSites` between the dirty gate and the delete —
   but item 1 of "What changed" widened it from one yield to nine, and the
   retention reclaim drives it from a 60 s poll and every window focus. It
   takes the deletion lease before its first await now.

4. **The snapshot pool did not stop on failure**, and its ordering test could
   not fail: every fake read awaited the same microtask, so completion order
   always matched issue order and a `push`-based implementation passed. Both
   fixed.

5. **Four off-ladder spacing values were spent without being recorded**, and
   the Monaco placeholder hand-rolled the skeleton primitive's fill, radius and
   motion gate in raw CSS — a third copy of a recipe that existed because the
   first two drifted. One `--skeleton-*` recipe now; the four values are in
   `docs/DESIGN.md`'s exception table, which goes from six entries to nine.

## Deferred — with the reason, and the shape of the fix

These were found, judged out of this ticket's scope, and are left here so a
follow-up can pick one up without re-auditing.

| # | Finding | Why deferred | Fix shape |
|---|---|---|---|
| D1 → **VC-387** | `data.bootstrap` on every `data-changed`, bodies included | A contract change on the renderer's recovery guarantee (`refreshPlanningData` is "always wholesale" by design) and on `useBoardStore.hydrate`'s identity semantics; needs its own measurement under a dozen agents | Scope the re-read to `change.projectId` when it is known; drop `body` from the roster and read it per open ticket; or carry the changed row on the broadcast so the renderer patches |
| D2 | `session.snapshot` replays the whole history per fresh open | The renderer already windows the DOM (`transcript-window.ts`); the wire and the fold do not. Pagination is a `session-rpc` procedure change with `session-presentation` on the other end | `session.projection` first, then a windowed frame read from the tail (`#readEvents` already takes `afterSequence`/`limit`) |
| D3 → **VC-388** (with D4) | `listSessions` folds N Sessions in one transaction | Per-session cost is bounded by the checkpoint; the block is per first visit. Splitting the transaction changes the ledger's serialization story | Per-session transactions with a yield between, or cache listing rows per `(sessionId, throughSequence)` and re-fold only the ones whose `MAX(sequence)` moved |
| D4 → **VC-388** | `PROJECTION_CACHE_LIMIT = 8` | Needs a measurement with dozens of open tabs before choosing a number or an eviction key | Key eviction to "has an open tab" rather than pure LRU |
| D5 | `cleanup.ts` sync probes on the confirmed cleanup | Deliberate: the no-await gate between last look and delete is the lease's guarantee. User-confirmed and rare | A worker thread for the gate, or a modal progress surface that owns the freeze honestly |
| D6 | `volli:project-create` base-branch detect (2 sync spawns) | A rare click; the handler is invoked synchronously by dozens of fixtures | Swap to `detectProjectBaseBranchAsync` and make the handler async |
| D7 | `sessions.starts` unscoped scan; `usage-report` `scope: "all"`; provenance's `json_extract` filter | Settings / usage surfaces, not transition paths | `sessions(created_at)` index; bounded default window + keyset paging; materialize the session→ticket link on write |
| D8 | `chat-plane.tsx` `groupTurns` walks the full transcript per streamed frame | Self-documented trade; the transcript window slices the *rendered* rows after | Fold the grouping incrementally on the live turn only; bench on a long Session first |
| D9 | `theme/apply.ts` forced `getComputedStyle` per live terminal on a committed canvas change | Already skipped for transient paints; fires once per project switch into a project with its own canvas | Batch the terminal refreshes behind one style read |
| D10 | `useMaterializedAttachments` — inline images unresolved while the strip loads | Cosmetic, shared across chat/body/comments | A sized placeholder per image while `links === NONE` |
| D11 | Backup bundle build reads every blob and transcript synchronously and `gzipSync -9`s the archive | Rare; trigger wiring not found from the audit | Stream the bundle; async `readCanonicalBytes` already exists |

One finding from the review is NOT deferred-with-a-ticket and belongs here
instead: the sync runner was also implicit admission control. It serialized
every main-process git caller by construction, and the async runner has no
aggregate bound — dozens of Session starts, a launch scan and a reclaim can now
each hold a child at once. Tracked as **VC-389**.

## Verification

- Whole repository: `pnpm test` — **9,965 desktop tests green**, plus every
  package's own suite; `pnpm run typecheck` clean; `vp check` clean;
  `check-design-tokens.mjs` clean.
- Coverage gates: `apps/desktop` and `packages/session-engine` both at **100%**
  statements, branches, functions and lines.
- The claims above are held by MUTATION, not by a green suite. Each was proved
  by breaking the production code and watching the right test fail, then
  restoring it:
  - dropping each surface's failure arm fails exactly that surface's test and
    nothing else (four surfaces, four failures);
  - reverting `remove.ts` and `scan.ts` to the sync seam fails six tests, where
    before the review it failed one;
  - replacing the snapshot pool's positional slot write with `push` fails the
    ordering test, where before it passed.
- The earlier draft of this section claimed each loading state was "proven
  pending-then-settled against a read held open and then answered". That was
  true of the Chat plane and not of the Home rail or either editor. It is true
  of every surface now.
