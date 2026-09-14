# Desktop performance baseline — WITHDRAWN, not yet re-taken

> **There is no valid owner baseline right now.** The numbers that used to be in
> this file have been withdrawn rather than corrected, because each of the
> reasons below changes them, and a number nobody can trust is worse than no
> number at all. Do not quote them; earlier comments on other tickets that cite
> them are stale.

## Why the previous numbers were withdrawn

The baseline published on 2026-09-13 (commits `c17dc86c` / `b0e8c9ff`) was taken
with a harness that had four defects, all since fixed:

1. **It measured a development React build.** Vite's `createServer` sets
   `NODE_ENV=development` for the whole process, the fixture generator starts
   one, and the renderer bench — spawned afterwards — inherited it and built
   itself with development React. Its profiling instrumentation ran inside every
   frame the bench timed, and the growing code fence landed outside the scroller
   the probe was moving, so the stream measurement reported zero dropped frames
   for a transcript with no mounted code block (VC-357).
2. **It accepted a broken renderer.** The gate rejected only failed samples, so
   the published run recorded `checks.firstTurn.reached: false`, an uncaught
   `TypeError: Cannot convert object to primitive value`, and two
   `Should not already be working.` errors — and summarized them anyway.
3. **Its arms were confounded by order.** Arms run in sequence with no warm-up,
   so the idle arm paid for a cold page cache and a cold Electron code cache and
   the loaded arm inherited both warm. A later run of the fixed harness made this
   unmistakable: it reported the *loaded* arm faster than idle on every single
   interaction.
4. **Its fixture was not the shape it claimed.** Session Events came from a
   uniform eight-kind cycle of small payloads, so the file was 145 MB rather than
   the measured 373 MB, with far less `session_events` mass than the profile it
   was supposed to reproduce.

## How to take the real one

On a quiet machine — nothing else running, on power, thermally settled — from a
clean checkout:

```sh
pnpm install
pnpm bench:desktop -- --preset real --output performance-results/owner-real
```

That runs both arms at 20 repetitions and takes roughly 75 minutes. Copy the
resulting `benchmark.md` over this file. The JSON stays out of the repository
(see [the harness documentation](../../performance-benchmark.md)).

Before publishing it, check the report's own header: SHA and dirty flag, device,
macOS build, fixture preset and seed, load arm name, worker count and exposure.
A number without that context is not a baseline, and numbers from two different
machines are not comparable to each other at all.
