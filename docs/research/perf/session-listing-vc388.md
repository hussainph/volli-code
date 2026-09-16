# Listing a project's Session roster (VC-388)

Split out of VC-383's audit (`loading-states-vc383.md`, deferred items D3 and
D4). VC-383 put a skeleton over the block this describes; this measures the
block itself and removes it.

Harness: `apps/desktop/e2e/bench/session-listing-vc388.mjs`. Unlike
`session-rpc-sqlite-bench.mjs` it needs no existing database — the roster is
built through the production engine, so every event, receipt and checkpoint row
takes the path the app writes.

```
node --expose-gc apps/desktop/e2e/bench/session-listing-vc388.mjs \
  --sessions 60 --events 150 --repeats 7
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
- The `volli:session-list` IPC handler still runs `sessionListingRows` after
  the chunked fold, and `readSessionProvenance` inside it is up to three
  synchronous SQLite queries per Session in one unbroken block. The fold's
  block is gone; this one is not measured here and is filed as VC-392.
