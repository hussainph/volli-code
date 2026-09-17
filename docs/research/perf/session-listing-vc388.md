# Listing a project's Session roster (VC-388, VC-392)

Split out of VC-383's audit (`loading-states-vc383.md`, deferred items D3 and
D4). VC-383 put a skeleton over the block this describes; this measures the
block itself and removes it. VC-392 then measured what the same IPC handler
pays **after** the fold — see "The handler's tail" below.

Harness: `apps/desktop/e2e/bench/session-listing-vc388.mjs`. Unlike
`session-rpc-sqlite-bench.mjs` it needs no existing database — the roster is
built through the production engine, so every event, receipt and checkpoint row
takes the path the app writes.

```
node --expose-gc apps/desktop/e2e/bench/session-listing-vc388.mjs \
  --sessions 60 --events 150 --repeats 7

# the provenance arms scale with Tickets and their history, not only Sessions
node --expose-gc apps/desktop/e2e/bench/session-listing-vc388.mjs \
  --sessions 240 --events 20 --repeats 5 --tickets 40 --ticket-events 300
```

Machine: Apple Silicon, better-sqlite3 on WAL, `synchronous = NORMAL`.

## What is being measured

**Not the total.** The number this ticket is about is `eventLoopMaxMs` — the
longest single stretch the host could not run a timer, answer IPC or paint. A
listing that takes longer overall but never blocks for more than a frame is the
better one, and that is the entire trade here.

The harness watches the loop with `monitorEventLoopDelay` around each arm.

### A fixture caveat worth knowing

`submit` does **not** refresh the projection checkpoint — only `observe` does.
So a roster built from `submit` alone starts with zero checkpoint rows, and
every fold is a full-log fold rather than the ≤64-event tail the design
intends. The harness measures that case once (`uncheckpointed`), then seeds
checkpoints exactly as a durable runtime boundary would, and every arm after
that is the realistic bounded-tail case.

Without seeding, the first run of this benchmark measures something the ticket
was not about.

## Roster fold: before and after

60 Sessions × 453 events each, checkpoints seeded (largest checkpoint row
54,685 bytes):

| arm | folds? | p50 | p95 | longest block |
|---|---|---|---|---|
| one transaction, no yield (the old shape) | no — reads checkpoint + tail only | 12.5 ms | 14.4 ms | **15.7 ms** |
| chunked + yielding, cold | yes (`listSessions`) | 13.1 ms | — | **3.6 ms** |
| chunked + yielding, warm (fold cache) | yes (`listSessions`) | 3.9 ms | 16.8 ms | 4.5 ms |
| chunked + yielding, warm, cache defeated | yes (`listSessions`) | 16.3 ms | 21.3 ms | 6.0 ms |
| no checkpoint rows at all | yes (`listSessions`) | 52.5 ms | 66.2 ms | 19.3 ms |

**Read the `folds?` column before comparing rows.** The three `listSessions`
arms run the shipped code, which projects each Session from its checkpoint
and tail. The "old shape" arm does not: it re-reads the checkpoint row and
the tail inside one transaction and stops there, so its number is the old
code's *read* cost without the old code's *fold* cost. The real pre-VC-388
block was therefore longer than 15.7 ms, not shorter — the comparison
understates the improvement rather than overstating it, but it is not the
like-for-like it looks like. (Flagged in review; re-measuring the old arm
through `projectStoredSession` on a quiet machine is the honest fix, and it is
listed under "Still open".)

The old shape's 15.7 ms is a dropped frame at 60 Hz, and it grows with the
roster — the fold is O(Sessions) with nothing in between. The chunked shape's
block is bounded by the chunk, not by the roster.

## Chunk size × yield primitive

This is the sweep that set both constants. Same roster, memo defeated, each
pairing measured through the same transaction verb. **Like the "old shape"
arm above, this sweep reads each Session's checkpoint and tail but does not
fold them** — it isolates the cost of the chunk boundary and the yield
primitive, which is what it was choosing between. Its chunk-8 `setImmediate`
row (3.6 ms) agrees with the shipped listing's cold block (3.6 ms, which does
fold), so the conclusion holds; the absolute numbers are a floor.

| primitive | chunk | p50 | longest block |
|---|---|---|---|
| `setImmediate` | 1 | 14.3 ms | 2.1 ms |
| `setImmediate` | 2 | 13.0 ms | 2.0 ms |
| `setImmediate` | 4 | 13.4 ms | 2.7 ms |
| **`setImmediate`** | **8** | **12.5 ms** | **3.6 ms** |
| `setImmediate` | 16 | 12.7 ms | 8.6 ms |
| `setImmediate` | 32 | 12.3 ms | 8.2 ms |
| `setImmediate` | 60 (whole roster) | 12.7 ms | 15.2 ms |
| `setTimeout(0)` | 1 | **84.3 ms** | 2.8 ms |
| `setTimeout(0)` | 2 | 61.3 ms | 15.1 ms |
| `setTimeout(0)` | 4 | 35.5 ms | 20.6 ms |
| **`setTimeout(0)`** | **8** | **21.5 ms** | **9.8 ms** |
| `setTimeout(0)` | 16 | 16.3 ms | 5.8 ms |
| `setTimeout(0)` | 60 | 13.1 ms | 15.3 ms |

Two results, and they pull in opposite directions:

1. **Total time is nearly flat across chunk sizes** on a good primitive — 12.3
   to 14.3 ms whether the roster is folded in one transaction or sixty. The
   per-transaction cost of `BEGIN IMMEDIATE`/`COMMIT` on a read-only
   transaction is small enough to disappear into the noise. So a fine chunk
   buys its much shorter block almost for free. On this axis alone, chunk 1
   wins: 2.1 ms versus 15.2 ms.

2. **The yield primitive is not free.** Node clamps `setTimeout(0)` to a
   millisecond; the clamp is paid once per chunk and has nothing to do with the
   work. At chunk 1 that is 59 clamped timers and it takes the listing from
   14.3 ms to **84.3 ms** — six times slower, to save 0.7 ms of blocking.

So the primitive was fixed first: the desktop composition root injects
`setImmediate` through `SessionEnginePorts.yieldToHost` (the engine owns no
Node API, so its own default is the portable `setTimeout(0)`). Then the chunk was
chosen for robustness rather than for the optimum — **8** is the size whose
longest block stays inside a frame on *both* primitives (3.6 ms with
`setImmediate`, 9.8 ms without). A host with a coarse timer degrades instead of
falling off a cliff, which chunk 1 does not.

A browser host has no `setImmediate`; `MessageChannel` is the no-clamp spelling
there, and `SessionEnginePorts.yieldToHost` is the seam for it.

## The handler's tail: provenance (VC-392)

Everything above stops at `engine.listSessions()`. The renderer's handler does
not:

```ts
sessions: sessionListingRows(sessions, provenanceOfSession, liveAttachmentIds()),
```

`readSessionProvenance` was up to three synchronous statements per Session, one
of them an index seek on `ticket_events_ticket (ticket_id, created_at)` whose
`json_extract(payload, '$.sessionId')` comparison then ran over that Ticket's
launch events. The fold above it yields every eight Sessions; this map did not
yield at all, so after VC-388 it was **the** unbroken block in the handler. On
the owner's 1,438-Session fleet the handler ran p50 ≈ 2.1 s with a longest
single stall of 135–187 ms, and that stall was this tail (ticket comment,
2026-09-16).

The harness now has the whole handler. Two new arms isolate the tail over an
already-folded roster (`provenanceTail*`) and two run the handler end to end
with a cold engine (`handler*`), which is a first visit to a project. The
fixture grew the records provenance is actually read out of: Tickets with real
timelines, a `session_started` event per Ticket Session (person, parent Session
and Automation actors), a completed Run every tenth Session, a pre-insert mint
intent every twentieth, and a Board Session every seventh.

Machine: Apple Silicon, one bench at a time on an otherwise quiet machine.
These numbers replace an earlier set taken at load average 7–13; the ratios
were the same, the absolutes were roughly three times larger.

| roster | arm | p50 | p95 | longest block |
|---|---|---|---|---|
| 60 Sessions, 8 Tickets, 532 Ticket events | tail, per Session | 4.6 ms | 5.1 ms | **7.1 ms** |
| | tail, batched | 1.2 ms | 1.4 ms | **3.1 ms** |
| 240 Sessions, 40 Tickets, 12,206 Ticket events | tail, per Session | 13.9 ms | 15.8 ms | **18.5 ms** |
| | tail, batched | 3.0 ms | 4.8 ms | **6.4 ms** |
| | whole handler, per Session | 76.4 ms | 95.3 ms | **18.5 ms** |
| | whole handler, batched | 67.2 ms | 73.0 ms | **5.3 ms** |
| 1,000 Sessions, 200 Tickets, 60,858 Ticket events | tail, per Session | 47.2 ms | 50.1 ms | **51.4 ms** |
| | tail, batched | 9.5 ms | 10.7 ms | **13.5 ms** |
| | whole handler, per Session | 266.9 ms | 539.6 ms | **314.8 ms** |
| | whole handler, batched | 234.5 ms | 264.9 ms | **26.3 ms** |

Read the middle block first: at 240 Sessions the handler's longest block is
**18.5 ms with the per-Session read and 5.3 ms with the batched one**, while
the fold's own cold block in the same run is 6.0 ms. That is the ticket's claim
measured — the tail was the block, not the fold — and it is the claim removed.
At 1,000 Sessions the handler's longest block falls from 314.8 ms to 26.3 ms.

### What the batch is

`readSessionProvenances(db, queries[])` asks each durable source once for every
Session that still needs it, in the same precedence the single reader used: the
completed Run, the pre-insert mint marker, the Ticket's `session_started`
event, then the parent Session's title and its renames. **Five statements for a
roster of any size**, against up to three per Session — pinned two ways, by a
unit test that asserts 9 Sessions and 49 Sessions cost the same number of
statements, and by a `data-ipc.test.ts` test that counts them through the real
IPC handler.

The set is passed as one JSON array through `json_each` rather than a generated
`IN (?,?,?)`. Two reasons, both structural: the SQL text is then identical for
every roster size, so `prepared`'s per-handle cache holds one statement per
stage instead of one per arity, and no roster can reach SQLite's
bound-parameter limit. The same idiom is already in `tickets-repo.ts` and
`sequence-cursor.ts`. `EXPLAIN QUERY PLAN` shows each stage as a
`SEARCH … USING INDEX` driven from the list.

Most of the win is stage 3. A worked Ticket's roster used to ask for that
Ticket's launch events once per Session on it; now each Ticket is read once.
That is why the arms scale with `--tickets × --ticket-events` and not only with
`--sessions`.

### What a batch of one costs

The single reader is the batch with one Session in it, so this is the push
channel's bill. It is the same order of work, but it is **not the same work**,
and an earlier draft of this note claimed it was. Stages 1, 2, 4 and 5 are
single indexed seeks either way. Stage 3 is not: the old query carried
`LIMIT 1` and matched the Session id in SQL, so it stopped at the matching
row, while the batch reads every launch event on the Ticket and picks the
winner in memory.

Measured on a Ticket with 5,000 events of which 40 are launches:

| where the Session's own launch event sits | old single read | batch of one |
|---|---|---|
| first | 0.0011 ms | 0.33 ms |
| middle | 0.16 ms | 0.33 ms |
| last | 0.70 ms | 0.33 ms |

So: the same on average, flat instead of sloped, and the early rows are no
longer free. For `activity-watch.ts`, which reads one Session per flush, that
is a wash. It is written down because "the stages short-circuit the same way"
was wrong, not because it costs anything.

### Which row wins

The queries carry no `ORDER BY`; the reader ranks candidates in memory on
`(created_at, id)` instead. The reader this replaced left the choice to
whichever row SQLite returned first under `LIMIT 1` — stable in practice,
undefined on paper. The earliest Run and the earliest launch event are now the
answer by construction, because the question is who STARTED a Session. The one
stage that takes the LAST record is the parent's renames, because the question
there is what the parent is called now.

### A parent's name, as it reads now

`sessions.title` is the fold's SEED, not its answer: the row is written once at
mint, and a rename is a `session.retitled` fact on the Session's own ledger
(`foldSession` in `@volli/shared`). A parent read from the row alone therefore
kept the name it was born with, while the same listing drew that parent under
its current one — so a delegated Session's tooltip could name an orchestrator
nobody could find in the list. Stage 5 replays the same rule the fold does, for
the parents only: `session_event_sequence (session_id, kind, sequence)` makes
it a seek per parent, and a parent has a handful of renames at most. A rename
to `null` is a real projected title and wins over the minted one.

### The fetch/push agreement

The constraint the ticket names: the push channel (`activity-watch.ts`) reads
provenance for one Session at a time, deliberately, so a push and a fetch never
disagree about who started a Session — the renderer applies a push as a
whole-row upsert, so a disagreement would change a Session's mark the moment it
did anything.

It is held by construction rather than by care: `readSessionProvenance` **is**
`readSessionProvenances` with a batch of one, so there is one implementation of
the question in the process. Two tests hold it from both ends —
`readSessionProvenances` answers a mixed roster exactly as the single reader
answers each row, and `volli:session-list` returns rows that equal the ones the
real push channel publishes for the same Sessions.

### What the bench measures, and what pins it there

The bench cannot invoke `volli:session-list` itself: the handler registers
against Electron's `ipcMain`, and this harness runs in plain Node. It measures
`sessionListingRowsForRoster` — the function `data-ipc.ts` calls — rather than
re-assembling the handler's body here, because a re-assembly drifts from the
handler with nothing to notice. The other half of that arrangement is in
`data-ipc.test.ts`: a test that drives the REAL handler and counts the
provenance statements it executes, so the handler cannot quietly stop calling
the function this file times.


## Cache entry weights

Held-heap after a forced GC, divided by rows. Two roster shapes, because the
spread is what matters for sizing a bound:

| entry | ordinary Session (27 events) | extreme Session (453 events) |
|---|---|---|
| engine listing-fold row | 5.6 KB | 79.8 KB |
| runtime `ProjectedHistory` | 17.4 KB | 272.5 KB |

The runtime entry is heavier because it retains the events it folded from, not
just the fold.

The extreme column is deliberately unrealistic: 450 events carrying 150
commands and their receipts, which accumulate in the projection's arrays. A
real Session of that age has a handful of commands.

**`SESSION_LISTING_CACHE_LIMIT = 256`** — sized to clear plausible rosters
rather than to a memory budget, because a limit *below* a roster is worse than
no cache at all: every listing would evict its own earliest entries before
reaching its last row and pay a full fold plus the bookkeeping. It has to clear
several rosters at once, since `pty/manager.ts` lists every project's Sessions
to compute a concurrency budget. Ceiling is ~1.4 MB in the shape a real roster
has, ~20 MB in a shape that needs 256 extreme Sessions to reach.

## Protecting a shared row (VC-393)

The cache's value is that it hands the SAME projection to every caller while
the entry stands. That is also its hazard: one mutating caller would rewrite
every later read of that Session, and neither a sequence change nor the
`sameSession` comparison would dislodge the damage. VC-393 asked for the fix to
be chosen by measuring the candidates against the entry weights above rather
than by arguing about them.

Harness: `packages/session-engine/src/listing-cache-cost.bench.test.ts`
(`pnpm -C packages/session-engine test`). Same two roster shapes as the weights
table — an ordinary Session of 27 events and the deliberately extreme one of
453. Medians of five runs, per row, Apple Silicon:

| candidate | ordinary (5.6 KB, 47 nodes) | extreme (79.8 KB, 615 nodes) |
|---|---|---|
| freeze in place | 13 µs | 108 µs |
| **copy and freeze** | **23 µs** | **176 µs** |
| copy on read | 30 µs | 451 µs |
| *(in-memory fold, for scale)* | *13 µs* | *30 µs* |

The fold row is the in-memory fold alone. A real listing also reads and decodes
a checkpoint row, so the number this is actually spent against is the 13.1 ms
cold listing above — about 218 µs per Session — not the 13–30 µs here.

**Freezing in place is the cheapest and it is the one that is wrong.**
`foldSessionProjection` copies CONTAINERS and re-uses their ELEMENTS: it seeds
`commands`, `receipts`, `attachments`, `attention` and `interactions` from the
base checkpoint's own objects, then pushes the very objects it read out of the
event payloads (`commands.push(event.payload.command)`). Freezing that graph
reaches back through it and freezes whatever the ledger handed over. It is
harmless today only because every ledger here answers reads with fresh objects
— the in-memory one clones, the SQLite one decodes each row — and `SessionLedger`
never promises that. A conforming implementation that cached its decoded reads,
such as the decoded-event LRU `ipc-rpc-sqlite.md` contemplates, would find its
rows frozen by a mere listing. That is a correctness fault, not a cost, so no
timing redeems it.

**Copy-on-read is correct and is the one the cache cannot afford.** It is
dearer per walk, and — unlike the other two — it is paid once per row per
LISTING rather than once per FOLD. On the warm arm above (3.9 ms p50 for 60
rows, every row a cache hit) it would add roughly 1.8 ms of pure copying to a
listing whose entire point is that it did no work.

**So the cache holds a deep-frozen COPY.** Owning the graph instead of freezing
somebody else's costs about ten microseconds on the row shape a real roster
has: ~0.2 ms added to a cold listing of sixty Sessions, nothing at all to a
warm one, and about 0.2 ms per chunk of eight — well inside the 3.6 ms block
the chunk size was chosen for. The type carries the same rule where the freeze
cannot follow: `SessionProjection`, `Session` and `SessionCommand` are
`readonly`, so a mutating caller is a compile error on both sides of an RPC
seam, where a structured clone drops frozen-ness.

### A checkpoint failure is now reported once per entry

A cache hit answers from the entry and never calls `projectStoredSession`,
which is where `SessionEnginePorts.onProjectionCheckpointFailure` fires. So an
unusable checkpoint is reported once per fold rather than once per listing:
once when the entry is built, then silence until the Session's log moves or the
entry is evicted. Quieter, not silenced — the condition stays observable, which
is the whole reason the seam exists. Held by a test in
`session-engine.test.ts`, and stated on the port itself.

## D4: the runtime's projection cache

`PROJECTION_CACHE_LIMIT` was 8, with a comment reading "the desktop reads one
or two Sessions at a time". That stopped being true once a person could keep
dozens of tabs open.

The audit suggested measuring with dozens of tabs and then picking a number,
and also floated keying eviction to "has an open tab". The measurement above
says a tab costs 17.4 KB typical / 272.5 KB extreme, so forty tabs is 0.7 MB
to 10.9 MB — affordable either way.

But raising the number is the wrong repair, and the arithmetic is not why. Any
fixed number is a guess about how many tabs someone has, and under pure recency
a single listing or watchdog sweep evicts all of them anyway: background reads
touch Sessions nobody has open, all of them more recently than the tab that has
been sitting there, so the cheap-to-rebuild entries evict the expensive one.
That is the bug, and a bigger number only delays it.

So eviction now **exempts Sessions that have a subscriber** — this process's
own evidence that a surface has one open, added when a tab mounts and removed
by its teardown. Exempt, not pinned: the exemption lasts exactly as long as the
subscription. Watched entries are bounded by how many Sessions the user chose
to open, which they are already paying for in the renderer.

The limit stays **8**, and now means what it says: a bound on the Sessions
nobody is looking at, each costing one re-read when dropped.

## Still open

- The renderer still reads a listing once per run per project
  (`stores/project-sessions.ts` `ensure`). Nothing here changed that, and the
  VC-383 skeleton still covers it — over a much shorter gap.
- `submit` not refreshing the projection checkpoint (see the fixture caveat) is
  not investigated here. It means Sessions driven only by commands, never by
  observations, carry an unbounded fold until something else writes a
  checkpoint. Worth its own ticket.
- The "old shape" arm and the chunk-size sweep read but do not fold (see the
  `folds?` column). Re-measure both through `projectStoredSession` on a quiet
  machine before quoting their absolute numbers anywhere else.
- At **fleet** scale the batched tail is smaller but still not free: 1,000
  Sessions over 200 worked Tickets block for 13.5 ms, because stage 3 walks
  each of those 200 Tickets' index ranges and evaluates `json_extract` on the
  `session_started` rows it finds. (It is the range walk that costs, not a
  `json_extract` on all 60,858 rows — the `kind` filter is applied first, and an
  earlier draft of this line said otherwise.) The ticket's done-condition is
  dozens of Sessions (1.2–3.1 ms), so batching alone answers it; the next lever
  for a fleet is an index the payload lookup can seek — `CREATE INDEX … ON
  ticket_events(json_extract(payload, '$.sessionId')) WHERE kind =
  'session_started'` — which turns that stage into one seek per Session instead
  of a range walk per Ticket. That is a migration and a different query shape
  (driven by Session id, with the Ticket kept as the filter), so it is
  deliberately not in VC-392.
- The fold is now the handler's cost again, not its block: 234 ms p50 for a
  1,000-Session roster, in yielding chunks. Whether a first visit should fold a
  whole roster at all is VC-403's question, not this file's.
