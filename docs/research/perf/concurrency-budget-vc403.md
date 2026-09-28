# What one Session start pays to learn how busy the machine is (VC-403)

The concurrency budget (VC-339) needs a COUNT — terminals still open, chats
mid-turn — and used to get it by folding every Session of every project. This
measures both shapes through the doors that actually ask, and is the
before/after the ticket asked for.

Harness: `apps/desktop/e2e/bench/concurrency-budget-vc403.mjs`. Like
`session-listing-vc388.mjs` it needs no existing database — the fleet is built
through the production engine, so every event and attachment row takes the path
the app writes.

> Performance numbers are comparable only on the same machine, in the same
> power/thermal state, with the same fixture.

Generated: 2026-09-17
Git: `9aad0ab7` plus this ticket's working tree (the "after" arms are the tree;
the "before" arms are the retired shape, reimplemented in the bench)
Device: MacBookPro17,1 — Apple M1, 8 logical cores, 16 GiB
macOS: 26.5.1 · Node v24.18.0

Command:

```
node --expose-gc apps/desktop/e2e/bench/concurrency-budget-vc403.mjs \
  --sessions 900 --projects 6 --events 40 --attached 5 --repeats 5
```

Fixture: 900 Sessions across 6 projects, 113,395 Session Events, of which **5
Sessions still hold an open attachment**. That last number is the point: a
machine's history is large and its live surface is small, and the budget only
ever needed the small one.

## What is measured, and where

Both shipped call sites the ticket names:

- **budget** — the reader `createSessionConcurrencyEnvReader` builds, which is
  what `sessionConcurrencyEnvFor` (`index.ts`) and `PtyManager` call on every
  structured attachment, background shell start and terminal start.
- **loadVerb** — `agent-commands.execute` running `ticket.list`, one of the
  verbs the ticket measured at 718–968 ms on the owner's fleet.

"Cold" means no cache can help: a fresh engine (empty listing-fold memo) and,
for the budget, a fresh reader (empty TTL cache). That is the Session start
after a quiet minute — the case a cache alone never fixed.

The number that matters is `eventLoopMaxMs`: the longest single stretch the one
main thread could not run a timer, answer IPC or paint.

## Results

| Arm | p50 | p95 | mean | eventLoopMaxMs |
|---|---:|---:|---:|---:|
| budget — before, cold | 543.7 ms | 1270.0 ms | 718.5 ms | **275.8 ms** |
| budget — before, warm | 440.0 ms | 782.7 ms | 565.9 ms | 213.4 ms |
| budget — **after, cold** | **4.9 ms** | 12.4 ms | 5.8 ms | **19.8 ms** |
| budget — after, warm | 0.07 ms | 4.4 ms | 0.9 ms | 10.1 ms |
| loadVerb — before, cold | 389.9 ms | 695.2 ms | 422.0 ms | **150.6 ms** |
| loadVerb — **after** | **0.6 ms** | 7.8 ms | 2.0 ms | 12.5 ms |

Both shapes agree on the answer they produce (`agreement.same: true`): the
narrow read and the full fleet fold hand out the same
`VOLLI_CONCURRENCY_HINT`. A faster number that disagreed would be worthless.

## Reading it

- **The uncached start stopped folding the fleet.** 543.7 ms → 4.9 ms at p50, a
  111× reduction, and the worst main-thread stall drops 275.8 ms → 19.8 ms.
  This is the clause the ticket's "Done when" asked for: not a burst that is
  collapsed by a cache, but a start that no longer walks the fleet at all.
- **The cache is now a burst collapser, not the fix.** Warm is 0.07 ms because
  a second start inside the TTL reads nothing — but cold is already cheap, so a
  Session starting alone after a quiet minute pays 5 ms rather than half a
  second.
- **A load verb stopped paying for a roster it never reads.** `ticket.list`
  through the real CLI door: 389.9 ms → 0.6 ms. The fold it used to run is not
  faster; it is gone, because the handler never asks for the roster and the
  dispatch no longer folds one on its behalf.
- **Scale.** The before arms grow with the number of Sessions that ever
  existed; the after arms grow with the number attached right now. On this
  fixture that is 900 versus 5, and the gap widens with history.

## Caveats

- The "before" arms reimplement the retired shape over the same ledger in the
  same process, exactly as `session-listing-vc388.mjs`'s Arm 3 does, rather
  than checking out the previous commit. That keeps both sides on one fixture;
  it also means they are the shape of the old code, not the old code itself.
- This is a synthetic fleet built through the production write path, not the
  owner's 1,480-Session / 479 MB database. The ratios are what transfer; the
  absolute milliseconds are this machine's.
- `--attached` sets how many Sessions stay attached. Raising it moves the after
  arms toward the before arms, which is the honest shape of the trade: the read
  is bounded by live attachments, so a machine with 200 live terminals pays for
  200 folds.
