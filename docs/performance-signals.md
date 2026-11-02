# Performance signals: the hill-climbing loop

Volli records every user-visible stall it can attribute, keeps them in a
bounded store on this machine, and answers questions about them with
`volli perf`. This page is how to use that to find the worst offender, fix
it, and prove the fix moved the number.

For a repeatable lab measurement with a generated database, use the desktop
benchmark instead ([performance-benchmark.md](performance-benchmark.md)).
`volli perf` measures the app you actually ran, under the load you actually
had.

## What is recorded

| Process    | What counts as a stall                                                            | Where it comes from         |
| ---------- | --------------------------------------------------------------------------------- | --------------------------- |
| `main`     | Electron main's event loop blocked ≥ 200 ms (`VOLLI_MAIN_STALL_MS` overrides)      | the `main stall` log line   |
| `renderer` | a window's long animation frame or slow input, labelled by interaction            | the `renderer stall` line   |

Each stall is filed under a **door** and an **operation**, both code-owned
names, never content:

- `door/operation` for work a door started (`ipc/volli:board-load`, a socket
  verb, a Session RPC call) or a labelled span (a Session's runtime, a host
  timer, a broadcast).
- Labelled spans for work no door starts (`withMainSpan`): `runtime/…` for
  a Session's work on main (`observe:<kind>` fact writes, `wake`, `pi:<event>`,
  `tool:<name>`, `dispatch:<kind>`), `projection/…` for Session projections
  (`get-session`, `listing-rows`), `timer/<name>` for host timers
  (`retention-poll`, `session-watchdog`, `backup-schedule`, …) and
  `broadcast/<channel>` for fan-outs to windows. The innermost span over the
  threshold wins; its `hint` is the span it ran in. A block made of many short
  spans is filed under the one that ran longest (kind `aggregate`).
- `gc/<kind>` for a block mostly spent in garbage collection, and
  `off-cpu/wait` for one in which main's own thread barely ran: a blocking
  call, or a machine too busy to schedule it. Neither is code a span can name.
- `unattributed/unattributed` for main lag nothing explains. Its `hint` is
  the last door call or span before it: where to start looking, never a claim.
- `renderer/<operation>` for a window, with the interaction `label`
  (`pane-switch`, `draft-typing`, …).

Every row also carries the Session it ran for (when one is known, printed as
its short handle) and the build that recorded it.

## Where it lives

`<userData>/perf.db` (for a dev build, the `-dev` profile's). It is a
separate SQLite file, never part of `volli.db`, never backed up, and safe to
delete: the app starts a fresh one. It keeps at most 100,000 stalls and none
older than 30 days. Writes are batched every few seconds off the logging path,
and queries read it in chunks, so asking never stalls the app it measures.

Each launch is a **run**: its version, its build label and how long it ran.
That is what lets an answer say how long the app was being watched
(`observed`) and give rates per hour, so a one-hour run and a one-day run
compare fairly.

## The three questions

```sh
volli perf top --since 24h                  # what hurt most today
volli perf top --since 1h --process renderer --by label
volli perf stalls --operation volli:board-load --limit 10
volli perf compare --version 0.3.0-canary.4 --version 0.3.0-canary.5
```

Add `--json` to any of them for the full answer; an agent should always use
it.

### Reading `volli perf top`

```text
since 2026-11-01T09:00:00.000Z  observed 5h 12m  86 stalls, 41,230 ms  7,929.62 ms/h
  ipc/volli:board-load  ×31  total 18,402 ms  p50 512  p95 1,204  max 1,880  3,538.85 ms/h
  unattributed/unattributed  ×22  total 9,870 ms  p50 380  p95 902  max 1,410  1,898.08 ms/h
  renderer/keydown  ×19  total 6,011 ms  p50 290  p95 545  max 610  1,155.96 ms/h
```

- Rows are ranked by **total** stalled time: a 300 ms stall a hundred times
  costs more than one 2 s stall.
- `ms/h` is that total per hour observed. It is the number to move.
- p50/p95 say whether the operation is always slow (a high p50) or
  occasionally terrible (a low p50, a high p95). They need different fixes.
- `--by door` shows which source dominates, `--by label` which interaction
  people feel it in, `--by session` whether one Session is the cause, and
  `--by version` how builds compare.
- A large `unattributed` share means main ran work no door or span names.
  `volli perf stalls --operation unattributed` lists the hints; add a span at
  the call site they point to before trying to fix it.

## Measuring a fix

1. **Measure.** Run the build you start from with the load that hurts (for
   example many Sessions working while you switch panes). Then
   `volli perf top --since <how long you ran> --json`.
2. **Pick one offender** from the top of the list and read its stalls:
   `volli perf stalls --operation <door/operation> --json`.
3. **Fix it**, the narrowest change that should move that operation.
4. **Label the new build and run the same load for a similar time.** A
   packaged build is labelled by its version. A dev build is labelled by its
   source checkout's commit; to name an uncommitted experiment, launch it
   with `VOLLI_PERF_BUILD=<label>` (for example
   `VOLLI_PERF_BUILD=memo-roster pnpm dev`).
5. **Compare:**

   ```sh
   volli perf compare --version <before> --version memo-roster --by operation
   ```

   Each side shows what it matched, how long it ran and its rates; each row
   shows `a → b` per hour observed with the move (`Δ`, negative is better),
   biggest move first. `--version` matches a version (every build of it), a
   build label, or `version+label` exactly as `perf top --by version` prints
   it.
6. **Report** the before and after rates for the operation, how long each
   side ran and what load you used. A rate from a few minutes or a handful of
   stalls is noise; say so rather than claim it.

Comparisons are only fair on the same machine under similar load. A build
that ran idle overnight will look better per hour than one that ran a
fleet; compare like with like.

## In the support report

Settings → About's report includes one `Stalls:` line: the last 24 hours,
how long the app ran, and per process the stall count, total, p95 and its
three worst operations. Counts, durations and operation names only.
