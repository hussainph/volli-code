# Pi sidecar re-bind without a main-loop stall (VC-462)

VC-445 found that holding bound Pi contexts in Electron main costs nothing
measurable. It found one cost, and it happens when a context is re-bound: Pi
loads the whole JSONL recovery sidecar in one synchronous pass. That held main
for about 190 ms on a 47 MB sidecar, and IPC waited it out
([report](pi-context-scaling-vc445.md)). This ticket removes that stall. It
takes VC-366's Option 2: stay in main and yield. Topology, hibernation,
concurrency and scheduling are unchanged.

> **Result.** Re-binding a 47 MB sidecar used to block main for about 190 ms.
> It now blocks it for about 23 ms, and the renderer's IPC echo follows. The
> loop-delay max in the hydration window fell from **188.5 → 22.6 ms**, and
> the IPC echo max from **187 → 17 ms** (medians of 6 interleaved launches
> each). On the idle-paired figures the ticket asks to be judged by, Δ
> tick-gap p95 fell from +171 to +12 ms and Δ IPC echo p95 from +158 to
> +13 ms. The 16 MB arm fell from 72 to 18 ms. Bind wall time did not
> regress (median 312 → 270 ms at 47 MB, with overlapping ranges). Heap per
> context is unchanged at 44.1–44.2 MiB. The full matrix's steady windows are still flat
> ([below](#full-matrix-steady-windows-stay-flat)). The final form of the
> hunk, re-measured after review on a slower host, held the result: 388 → 37 ms
> at 47 MB ([confirmation](#confirmation-on-the-final-code)).

## The change

The whole change is one hunk in pi-agent-core 0.87.1's
`dist/harness/session/jsonl/storage.js`. It is added to the existing
`patches/@earendil-works__pi-agent-core@0.87.1.patch`; pnpm takes one patch
file per package version, so the file now carries the older compaction seam
and this change side by side. The hunk also drops that file's
`sourceMappingURL` comment, because the shipped `storage.js.map` describes
the unpatched file and would point stack traces at the wrong lines. No Volli source
changed, Pi is not vendored and its version is not bumped. The write-up below
is meant to go upstream as it stands.

### Upstream write-up: `JsonlStorage.openV4` should not hold the event loop for the whole file

**Problem.** `JsonlStorage.openV4` reads a v4 session file with
`readTextFile`. It then runs `splitCompleteLines` on the whole string and
parses and replays every line in one loop with no `await`. After the read, the
open is a single task whose length grows with file size.

- A 40 MB session takes 225–340 ms in plain Node. Almost all of it is
  `parseJsonlTransaction`, UTF-8 decode and `splitCompleteLines`.
- An Electron app that opens sessions on its main process freezes its UI and
  IPC for that long, about 190 ms at 47 MB on an M1.

**Fix.**

1. Read the file as bytes (`FileSystem.readBinaryFile`, already part of the
   interface).
2. Take the torn/complete split from the last `0x0A` byte.
3. Decode newline-terminated batches of at most 256 KiB, with
   `TextDecoder("utf-8", { ignoreBOM: true })`.
4. Parse and replay line by line.
5. Once a slice has run for 8 ms, yield one macrotask (`setImmediate`, else
   `setTimeout(0)`; the fallback exists only because Pi is not Node-only).

The per-line replay runs synchronously inside the walk, so it counts toward
the slice. Nothing is awaited per line, only once per slice.

**Why the state is identical.**

- **Same text.** A newline byte never occurs inside a UTF-8 sequence, and it
  terminates any incomplete sequence in front of it. So decoding batches that
  each end on a newline produces the same text, invalid bytes and U+FFFD
  included, as decoding the whole file at once. `ignoreBOM` keeps a leading
  U+FEFF, as `readFile(…, "utf8")` does.
- **Same lines, in the same order.** Each line goes through the same
  `parseJsonlTransaction` → `replayCommitted` calls. Line 1, the header
  already parsed by `open`, is skipped as before, and `nextSeq` is advanced
  after the loop as before.
- **Same torn-tail repair.** A file that does not end in `\n` (an empty file
  included, as before) is torn. Its complete lines are kept and written back
  through `publishFileAtomically` as the same `lines.join("\n") + "\n"`.
- **Same error.** A bad line still throws
  `Invalid JSONL storage <path>: line N` with the same `N` and cause.
- **Nothing observes the storage mid-load.** The storage is not returned
  until the replay ends, and the bytes are a snapshot taken before it starts.
  Yielding adds no window in which anything can see partial state. It also
  keeps the existing behaviour that `openV4` does not consult the abort
  signal once the read has finished.

**What stays synchronous.** One line is still decoded and parsed in one task.
A single multi-megabyte transaction still costs its own parse time, exactly as
before. The legacy v3 path (`openLegacyV3`) is untouched; it already streams
through the line reader.

**Cost.** None measured. Re-bind wall time did not regress; its medians were
lower, probably because the patch no longer builds one whole-file string and
one whole-file `split` array. The ranges overlap, though, and the "before"
launches ran under more load. Heap after load is unchanged.

The patched `openV4`, as TypeScript for `src/harness/session/jsonl/storage.ts`:

```ts
const NEWLINE = 0x0a;
/** Bytes of complete lines decoded at a time; each batch ends on a newline. */
const REPLAY_DECODE_BATCH_BYTES = 256 * 1024;
/** Longest stretch of replay work between two yields to the event loop. */
const REPLAY_SLICE_MS = 8;

/**
 * Let queued tasks (timers, I/O, IPC) run between replay slices. `setImmediate` where the
 * runtime has it (Node, Electron main); `setTimeout(0)` keeps the storage runnable elsewhere.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) =>
    typeof setImmediate === "function" ? setImmediate(resolve) : setTimeout(resolve, 0),
  );
}

/**
 * Visit every complete line of a UTF-8 JSONL file, in order, in time-bounded slices.
 * The visitor runs synchronously and its work counts toward the slice; a throw from it
 * stops the walk and rejects.
 */
async function forEachCompleteLineInSlices(
  bytes: Uint8Array,
  completeLength: number,
  visit: (line: string) => void,
): Promise<void> {
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  let sliceStart = performance.now();
  for (let start = 0; start < completeLength; ) {
    const probe = Math.min(start + REPLAY_DECODE_BATCH_BYTES, completeLength) - 1;
    const end = bytes.indexOf(NEWLINE, probe) + 1;
    const lines = decoder.decode(bytes.subarray(start, end)).split("\n");
    lines.pop();
    start = end;
    for (const line of lines) {
      visit(line);
      if (performance.now() - sliceStart >= REPLAY_SLICE_MS) {
        await yieldToEventLoop();
        sliceStart = performance.now();
      }
    }
  }
}

// in JsonlStorage:
private static async openV4(options: JsonlStorageOptions, header: JsonlStorageHeader, context: Context) {
  const bytes = fileValue(await options.fileSystem.readBinaryFile(options.path, context), `Failed to read JSONL storage ${options.path}`);
  // Everything after the last newline is a torn tail from an interrupted append.
  const completeLength = bytes.lastIndexOf(NEWLINE) + 1;
  const torn = bytes[bytes.length - 1] !== NEWLINE;
  if (header.storageVersion !== JSONL_STORAGE_VERSION) {
    throw new Error(`Session ${header.id} uses unsupported storage version ${header.storageVersion}`);
  }
  const storage = new JsonlStorage(options, header, { kind: "v4" });
  // Kept only to rewrite a torn file without its tail.
  const lines: string[] | undefined = torn ? [] : undefined;
  let lineNumber = 0;
  await forEachCompleteLineInSlices(bytes, completeLength, (line) => {
    lineNumber++;
    lines?.push(line);
    // Line 1 is the header, already parsed by `open`.
    if (lineNumber === 1) return;
    try {
      storage.replayCommitted(parseJsonlTransaction(line));
    } catch (error) {
      throw new Error(`Invalid JSONL storage ${options.path}: line ${lineNumber}`, { cause: error });
    }
  });
  if (header.nextSeq !== undefined) storage.storageState.advanceNextSeq(header.nextSeq);
  if (torn) {
    await publishFileAtomically(options.fileSystem, options.path, context, (append) => append(`${lines!.join("\n")}\n`));
  }
  return storage;
}
```

The 8 ms slice leaves room under a 50 ms long-task budget for a GC pause of
about 10–15 ms (the largest seen here) and one ordinary line. The 256 KiB
batch keeps each decode well under a millisecond.

## What proves it

### Tests

The tests are in
[`packages/agent-runtime/src/pi/sidecar-load.test.ts`](../../../packages/agent-runtime/src/pi/sidecar-load.test.ts).
They drive Pi's public API against real files.

- **Identical state.** A sidecar of more than 6 MB is written through
  `JsonlSessionRepo`. It holds:
  - user and assistant messages with multibyte prose on every batch boundary;
  - lines over 600 KB, longer than a decode batch;
  - `volli.observation` custom entries;
  - a compaction entry written the way `appendCompactionEntry` writes one;
  - a side branch;
  - multi-write JSON-array transactions with list appends and usage rows;
  - value and list deletes, and a session name.

  Re-opened, it matches the writer's own state: every entry, both branches,
  branch tips, values, lists, stats and name. The file is left unchanged, and
  the next commit continues the sequence. The test **passes against the
  unpatched loader too**, which is what makes it an equivalence proof and not
  just a check of the new code.
- **It yields.** A sidecar of more than 16 MB is served from memory, so no
  read I/O can let a task in. `setImmediate` ticks then land between the
  moment the replay starts and the moment `open` resolves, and the longest gap
  between ticks is under half the replay. **Against the unpatched loader this
  test fails with 0 ticks.**
- **Invalid UTF-8** decodes to exactly what `Buffer.toString("utf8")` of the
  file gave, U+FFFD included.
- **A torn tail** is dropped, and the file is rewritten byte for byte to its
  complete lines.
- **A corrupt line** is still reported as `line 4`.
- **Pi's own `SessionRepo` conformance suite** runs against the patched JSONL
  repo: lifecycle (including close and re-open), ownership, messages, forks
  and the fork source snapshot.
  - The destination-reservation group is left out. Its "create reserves first"
    case fails identically on unpatched 0.87.1, and the race it stages never
    reaches `openV4`.

The Volli-level recovery semantics sit on top of the loaded storage and did
not change: the identity check, branch-scoped elision, marker validation and
the compaction path. They stay covered by the unchanged `runtime.test.ts`,
`compaction*.test.ts` and `sidecar-migration.test.ts`. The whole
`@volli/agent-runtime` suite passes on the patched package.

### Electron main: interleaved before/after

**Protocol.**

- **Builds.** Two production bundles were built back to back with
  `pnpm run build` and the same flags: *before* at `428e4dcb`, and *after* at
  `428e4dcb` with the patched package installed.
  - The two `main.cjs` bundles differ only in the storage hunk, in the
    `//#region` paths that carry the patch hash, and in the build id.
  - The renderer bundles are byte-identical.
  - **Telling them apart in the raw files.** `environment.build.gitSha` in
    each `raw.json.gz` is the checkout's `HEAD` when the bench ran
    (`d63315f6`, a later commit of this branch that adds only tests and
    docs), not the commit a bundle was built from. The bundle is identified
    by `environment.build.mainBundleBuiltAt`: `18:21:23Z` is *before* and
    `18:29:05Z` is *after*. Their build ids were `428e4dcbf5fc@…` and
    `428e4dcbf5fc+dirty@…`, the latter because the patch was not yet
    committed.
  - These runs measured the first form of the hunk, which walked lines
    through an async generator. Review replaced that with the synchronous
    per-batch loop shown above; it slices and decodes the same way, minus
    one promise per line. The
    [confirmation run](#confirmation-on-the-final-code) re-measures the final
    code.
- **Fixture.** One frozen bench fixture was prepared once: one 4,501-entry
  sidecar of 16.2 MB and one 13,501-entry sidecar of 47.3 MB, the same targets
  as VC-445's large run.
- **Runs.** The ticket names one `--bound 1 --histories 4500,13500
  --repetitions 6` run per build. Six repetitions are kept, but the run is
  split: the bench was run 12 times with `--repetitions 1`, alternating
  builds in ABBA order (before/after, after/before, and so on) for six pairs.
  A before-then-after pair of long runs would have let the shared host's
  load drift pick a winner. The two runs of a pair share a seed, so their arm
  order is the same.
  - Each run is one discarded warm-up launch plus control, 16 MB and 47 MB.
  - 36 measured launches in all; 0 failed their binding or tripwire checks.
- **Machine.** The same M1 MacBook Pro (8 cores, 16 GiB, AC power) as VC-445,
  on Electron 44.0.0 and Node 24.18.0.
- **Host load.** The machine was shared with other ticket Sessions throughout.
  - The 1-minute load was recorded before and after every launch, and each
    table row carries the higher of the two.
  - Pairs 1–3 ran under heavy load (2.4 to 78). Pairs 4–6 ran lighter (2.3 to
    6.7).
  - macOS reported memory-pressure level 1, with about 11 GiB of swap in use.

Every run's raw samples are committed under
[`pi-sidecar-rebind-yield-vc462/ab/`](pi-sidecar-rebind-yield-vc462/ab/).
[`ab-results.md`](pi-sidecar-rebind-yield-vc462/ab-results.md) is the full
per-launch table, generated by
[`ab-compare.mjs`](../../../apps/desktop/e2e/bench/pi-context-scaling/ab-compare.mjs).

**Results.** Medians across 6 launches per cell, [min–max], in ms. Δ means
the same launch's idle window subtracted.

| Arm | Build | Hydration ELD max | Hydration tick-gap max | Hydration IPC echo max | Δ tick-gap p95 | Δ IPC echo p95 | Bind wall ms | Heap Δ MiB |
|---|---|---|---|---|---|---|---|---|
| 47 MB | before | **188.5** [157.7–313.0] | 193.6 [159.2–315.0] | **187.3** [153.1–311.7] | **+170.9** [16.7–197.9] | **+158.3** [5.8–191.0] | 312 [247–527] | 44.1 |
| 47 MB | after | **22.6** [21.3–33.5] | 27.5 [22.0–33.5] | **17.3** [15.5–27.7] | **+11.6** [9.8–20.3] | **+13.1** [10.7–17.1] | 270 [221–329] | 44.2 |
| 16 MB | before | 72.1 [51.5–192.8] | 76.0 [52.6–198.5] | 73.3 [48.9–191.4] | +64.0 [41.7–180.0] | +58.3 [39.4–96.8] | 149 [97–429] | 15.9 |
| 16 MB | after | 17.5 [16.4–26.1] | 22.6 [18.4–26.1] | 12.4 [10.6–21.9] | +11.8 [7.3–14.6] | +12.0 [10.0–15.3] | 102 [89–259] | 15.7 |
| control | before | 1.4 | 10.7 | 0.3 | −0.5 | −0.9 | — | 0.1 |
| control | after | 1.3 | 10.7 | 0.3 | −0.4 | −0.2 | — | 0.1 |

**Reading it.**

- **The acceptance target is met with room to spare.** At 47 MB the
  hydration window's loop-delay max fell from about 190 ms to about 23 ms,
  against a target of under 50 ms.
  - The worst "after" launch reached 33.5 ms, at load 24.7.
  - The best "before" launch reached 157.7 ms, at load 2.4.
  - The two ranges do not overlap in any arm with a sidecar.
- **The IPC echo max follows the loop.** It fell from 187 to 17 ms.
- **The idle-paired deltas agree.**
  - Δ tick-gap p95 fell from +171 to +12 ms.
  - Δ IPC echo p95 fell from +158 to +13 ms.
  - The remaining ~+12 ms is the 8 ms slice, plus the bench's 10 ms tick
    period and the bind's own GC pauses. It is the same at 16 MB and at 47 MB,
    so it no longer grows with sidecar size.
- **Load did not decide the result.**
  - Pairs 1–3 ran under heavy load, and their "before" launches ran under
    higher load than their "after" launches.
  - In the lighter pairs 4–6, where both builds saw load 2.3–6.7:
    - 47 MB "before": 157.7, 169.1 and 181.7 ms;
    - 47 MB "after": 21.3, 22.0 and 24.3 ms;
    - 16 MB: 51.5–61.5 ms before, 16.4–17.5 ms after.
- **Two raw deltas look odd, and both are expected.** The one "before" Δ
  tick-gap p95 of 16.7 ms comes from a launch whose stall was a single tick
  sample. That launch's 527 ms hydration window held enough other ticks that
  the stall fell above its p95; its max was still 315 ms. The same is true of
  the 5.8 ms echo delta in pair 1. The Δ ELD **max** swings negative whenever a host spike lands in
  the 6 s idle window. That is why the table leads with the absolute
  hydration max and the p95 deltas.
- **No regression.**
  - Bind wall time did not regress. Its medians went 312 → 270 ms at 47 MB
    and 149 → 102 ms at 16 MB, but the ranges overlap and the "before"
    launches saw more load, so read that as "no regression" rather than as a
    speed-up.
  - Post-GC heap growth per bound context is unchanged: 44.1 → 44.2 MiB at
    47 MB and 15.9 → 15.7 MiB at 16 MB.
  - Steady-window deltas stay within ±2.5 ms in both builds.

### Confirmation on the final code

Review replaced the async-generator walk with the synchronous per-batch loop
shown above, so both bundles were rebuilt from the branch after it merged
`main`. *Before* got the unpatched Pi and *after* the final hunk; the
renderer is shared. They were re-measured against the same fixture.

- **First attempt: unreadable.** Four ABBA pairs ran while the host's
  1-minute load climbed to 444. The *before* stalls reached 9.2 s, and the
  two builds did not see comparable load (median 30 before, 131 after). No
  conclusion is drawn from it. Its raw samples are kept under
  [`confirm-high-load/`](pi-sidecar-rebind-yield-vc462/confirm-high-load/)
  for the record.
- **Second attempt: three ABBA pairs** once the load was back to 9–16 for
  both builds. The host was still slower than during the main A/B: the
  *before* build's own 47 MB stall doubled, to 274–420 ms.

| Arm | Build | 1-min load | Hydration ELD max | Hydration IPC echo max | Δ tick-gap p95 | Bind wall ms | Heap Δ MiB |
|---|---|---|---|---|---|---|---|
| 47 MB | before | 11.1 [11.0–11.6] | **388.5** [273.7–420.0] | 382.6 [268.4–416.1] | +14.2 [4.3–16.2] | 663 [500–672] | 44.1 |
| 47 MB | after | 13.5 [10.0–13.9] | **37.1** [35.6–48.5] | 31.4 [29.6–44.5] | +20.2 [9.9–33.9] | 510 [499–528] | 44.2 |
| 16 MB | before | 9.6 [9.2–12.6] | 97.8 [82.0–163.4] | 99.6 [82.1–166.8] | +90.1 [68.9–154.1] | 258 [192–297] | 15.8 |
| 16 MB | after | 12.6 [11.7–15.6] | 30.1 [24.4–98.4] | 24.9 [18.5–96.9] | +11.8 [11.0–86.2] | 278 [206–324] | 15.7 |

**Reading it.**

- **The final code holds the result.** On a host that had doubled the
  unpatched stall, the 47 MB re-bind's loop-delay max was 36–49 ms after
  against 274–420 ms before. That is still under the 50 ms target and still
  a 7–10× drop.
- **The 47 MB before Δ tick-gap p95 is low** (4–16 ms). That is the effect
  already noted above: the stall is one tick sample inside a long window. The
  absolute max is the reliable figure.
- **One 16 MB "after" launch reached 98 ms**, in pair 1. Its IPC echo p95
  delta stayed at +12.8 ms, so the stall was a single event. Its pair's
  *before* launch reached 163 ms. Nothing in the loader produces a stall
  longer than one line plus a slice, so this reads as host noise. It is
  reported, not excluded.
- **Bind wall time and heap** again show no regression.

### Full matrix: steady windows stay flat

The full VC-445 matrix ran once on the *after* build, which carried the
first form of the hunk:
`pnpm bench:pi-context-scaling --repetitions 6`, 17 arms × 6 plus a warm-up,
103 launches, 0 failed. The 1-minute load across launches was p50 8.4, p95
17.0 and max 22.9, and memory-pressure levels 1 and 2 were both seen. Its
[`aggregate.json` and `tables.md`](pi-sidecar-rebind-yield-vc462/matrix/)
are committed.

The figures below are medians [min–max] across 6 launches, ms, each paired
with the same launch's idle window. The VC-445 column is the published
matrix, taken on the unpatched build under heavier load.

| Arm | Steady Δ tick-gap p95, VC-445 → VC-462 | Steady Δ IPC echo p95, VC-445 → VC-462 | Hydration Δ tick-gap p95, VC-445 → VC-462 | Hydration ELD max, VC-445 → VC-462 |
|---|---|---|---|---|
| control | −0.7 → −0.5 | −1.0 → −0.3 | −1.6 → −1.3 | 1.5 → 1.8 |
| 20 × 10 | 0.0 → −0.2 | −0.1 → −0.2 | +1.6 → +0.5 | 14.3 → 12.9 |
| 20 × 100 | 0.0 → +0.1 | +0.1 → −0.1 | +0.9 → +1.9 | 10.9 → 15.7 |
| 20 × 500 | −0.4 → −0.1 | −0.8 → −0.3 | +6.7 → +4.4 | 24.7 → 15.8 |
| 1 × 1,500 | +0.5 → −0.2 | +0.7 → −0.3 | +23.8 → +8.1 | 27.0 → 17.1 |
| 5 × 1,500 | +2.0 → 0.0 | +1.6 → +0.1 | +19.0 → +12.0 | 29.7 → 18.1 |
| 10 × 1,500 | 0.0 → +0.1 | 0.0 → +0.1 | +17.8 → +13.0 | 29.5 → 24.1 |
| 20 × 1,500 | −0.1 → −0.2 | −0.6 → −0.1 | +19.4 → +12.5 | 74.0 → 20.7 |

- **Steady windows are flat.** In every one of the 17 arms, the median steady
  Δ tick-gap p95 is within ±1 ms and the median steady Δ IPC echo p95 within
  ±1.6 ms. Neither has a trend in N or in history, which is what VC-445
  found.
- **Heap per bound context is unchanged.** The heapUsed slope is 0.131,
  0.421, 1.665 and 4.905 MiB at 10/100/500/1,500 entries, all with r² of
  0.95–1.00. VC-445 measured 0.13, 0.42, 1.66 and 4.91.
- **The small arms improve too.** At the real p95 size (1,500 entries,
  5 MB), the hydration loop-delay max is now 17–24 ms where it was 27–30.
  Binding twenty such Sessions one after another no longer adds up to one
  74 ms worst stall.
- **One outlier, not from the sidecar load.** One 20 × 10 launch has a
  174 ms hydration max. Its sidecars are 15–46 KB and have nothing to slice.
  The same launch also had the noisiest idle and steady windows of its arm
  (maxima of 56 and 47 ms, against 7–35 ms in the other five). The stall is
  host noise, or bind work unrelated to the sidecar; the other five launches
  of that arm read 7.5–29.8 ms.

### Plain Node: re-attach profile

[`profile-attach.mjs`](../../../apps/desktop/e2e/bench/pi-context-scaling/profile-attach.mjs)
now also prints each re-attach's loop-delay max. The histogram stays enabled
for 20 ms after the attach, because a stall is only recorded when the
histogram's timer next fires. The same 40 MB, 13,502-entry sidecar was run
back to back, unpatched and patched, at load about 6:

| | Re-attach ms (6 runs) | Loop-delay max per re-attach, ms |
|---|---|---|
| unpatched | 202, 211, 231, 203, 187, 192 | 150, 152, 174, 153, 140, 145 |
| patched (first form) | 194, 171, 159, 310, 168, 167 | 33, 34, 26, 36, 33, 31 |

The final hunk was run the same way later, on the slower host that the
confirmation run also saw (load about 15). Unpatched re-attaches took
326–549 ms and held the loop for 252–388 ms. Patched ones took 201–370 ms and
held it for 26–52 ms.

The full outputs, with the self-time tables, are committed as
[`profile-attach-13500-before.txt`](pi-sidecar-rebind-yield-vc462/profile-attach-13500-before.txt)
and
[`profile-attach-13500-after.txt`](pi-sidecar-rebind-yield-vc462/profile-attach-13500-after.txt),
and for the final hunk
[`profile-attach-13500-before-final.txt`](pi-sidecar-rebind-yield-vc462/profile-attach-13500-before-final.txt)
and
[`profile-attach-13500-after-final.txt`](pi-sidecar-rebind-yield-vc462/profile-attach-13500-after-final.txt).

**What the remaining ~30 ms is.** A gap timeline showed it. The replay's
own slices appear as gaps of about 14–17 ms: one 8 ms slice, the 1 ms
probe's period, and the minor GCs the load allocates. The single largest
gap, 27–37 ms, comes at the very end. It is the replay's last slice, run
straight on into Volli's synchronous recovery fold (branch scan, marker
fold, context messages) with no macrotask in between. That fold is a few ms
of self time, but it touches all 13,500 entries in one task.

In Electron main, the same tail measured about 22 ms, well inside the
target. Slicing Volli's fold is possible, but this ticket did not need it,
and it would be a Volli-side change rather than a Pi one.

## Caveats

- **Shared host.** The A/B was interleaved precisely so that load could not
  pick the winner. All the same, the absolute milliseconds are directional.
  The build-to-build contrast (a 7–8× drop, with no overlap) is the result.
- **One huge line** is still one task. The bench fixture's largest line is
  about 125 KB and the test fixture's about 600 KB, and both parse well
  inside a slice. A real Session carrying a
  multi-megabyte tool result in one transaction would still pay that one
  line's parse time, exactly as before.
- **Volli's own recovery fold** still runs as one task after the load, and
  the load's last slice runs straight into it. Together they make up the
  largest gap that remains (see the plain-Node profile), and the fold grows
  with entry count. It is small next to the target and was left alone.
- **Shutdown during a re-bind.** Review found that a re-bind finishing after
  `SessionRuntime.close()` registers a binding that nothing releases. The race
  is older than this change, and this change did not lengthen re-bind wall
  time, but long Sessions widen the window. It is filed as VC-467.
- **Committed data.** `docs/performance-benchmark.md` keeps benchmark JSON
  out of git. As with VC-445, these are one-off research artifacts under
  `docs/research/perf/`, and the ticket's own acceptance is a before/after
  comparison someone should be able to re-read. So the raw A/B samples
  (about 80 KB per run) and the matrix's `aggregate.json` and `tables.md` are
  committed. The matrix's roughly 2 MB `raw.json.gz` is not.
- **Labels.** The matrix `aggregate.json` says `"ticket": "VC-445"`. That is
  the bench's fixed name, not a mix-up: it is the same bench, re-run on the
  patched build.
- **Upstream.** When Pi ships an equivalent, or changes `openV4`, drop this
  hunk and re-run `sidecar-load.test.ts`. The test is written against Pi's
  public API and should hold unchanged.

## Reproduce

```sh
pnpm install && pnpm run build     # "after"; build "before" the same way from main without the storage hunk
# one fixture, then alternate builds (swap apps/desktop/dist-electron) in ABBA pairs:
pnpm bench:pi-context-scaling --root /tmp/vc462-ab/root --keep --bound 1 --histories 4500,13500 --repetitions 1
pnpm bench:pi-context-scaling --root /tmp/vc462-ab/root --reuse-fixture --keep --bound 1 \
  --histories 4500,13500 --repetitions 1 --seed $((445 + PAIR)) --output /tmp/vc462-ab/$BUILD-$PAIR
node apps/desktop/e2e/bench/pi-context-scaling/ab-compare.mjs /tmp/vc462-ab --rows
pnpm bench:pi-context-scaling --repetitions 6 --output /tmp/vc462-matrix   # full matrix, after
node apps/desktop/e2e/bench/pi-context-scaling/profile-attach.mjs --entries 13500
```
