# VC-655: board projection and drag-measurement readiness

## Decisions

All three signatures are treated as **test-readiness defects**. Production code
is unchanged. Historical CI samples cannot establish precise user-visible
latency or the native scheduling cause; the tests below distinguish projection
and measurement regressions from a test reading at the wrong browser phase.

### 11.5: priority indicator

Main's census recorded `highAfterMutation=0 highAfterReload=1` twice in 17
runs; VC-638's scheduling head saw it again on run
[37292128058](https://github.com/hussainph/volli-code/actions/runs/37292128058),
workflow attempt 4. The smoke read one count after sleeping 400ms. The context
menu invokes `setTicketPriority`, whose store publishes the optimistic slice
before awaiting IPC; Board subscribes to that slice and passes the ticket's
priority to `PriorityIndicator`.

`board-priority-projection.test.tsx` mounts the **real Board**, holds the priority
IPC unresolved, and checks the indicator in the synchronous mutation commit:
Medium → High, with no timer, frame, polling or IPC answer. It then checks the
authoritative reply. Removing the optimistic store publication makes the test
fail with **Medium instead of High**; the mutation was restored. This is an
independent immediate-projection proof, not a ten-second UX allowance.

Smoke 11.5 now waits on the actual unique High indicator with a bounded DOM
condition. It still requires a non-High initial indicator, exactly one High
indicator before reload, and exactly one after reload. The independent reload
proof runs even when the pre-reload wait fails. Removed the menu and reload
sleeps in this check as well; Playwright's menu actions provide readiness.
`mutationReadyMs` records observation time, not intrinsic mutation/render time.

The first candidate head (`18bd5b929`) had a green full CI run and two
first-attempt board passes, then workflow attempt 3 on
[run 37343115579](https://github.com/hussainph/volli-code/actions/runs/37343115579)
was retry-green with a **different** signature: the High menuitem never opened
before a 30s click timeout, preceding the mutation and cascading into blocked
later clicks. Both repaired 8.5 and the fresh-profile retry passed. The watcher
stopped; that head is **not** acceptance evidence.

The follow-up waits for check 11's outgoing context-menu portals to unmount,
then explicitly clicks Priority in the new open root and High in its open
submenu. Radix's trigger click opens synchronously, whereas pointer movement
uses a cancellable hover timer. This avoids relying on a one-shot hover through
portal/positioning readiness; check 11 retains its independent submenu-hover
and icon proof. No sleep, forced action, mutation shortcut or assertion change.
The precise failed hover event sequence was not captured.

### 8.5: multi-drag settle

Downloaded `smoke-results-core-attempt-10` from the same VC-638 run. Its first
board attempt recorded:

```text
slotted=false
moved=["VC-5","VC-6","VC-7","VC-2","VC-3"]
slots={"dragging":false,"slots":[
  {"id":"VC-2","started":true,"settled":false},
  {"id":"VC-3","started":true,"settled":false}
]}
```

The fresh-profile retry passed with the same destination and restore order.
Thus both real destination slots existed, both FLIP start markers were set,
the overlay was gone, and both cards moved correctly. The failure was the
animation-completion observation, not a missed drop or absent slot. The old
single one-second budget covered rAF-deferred release, React's commit and the
200ms FLIP. No historical animation timeline was captured, so this does not
prove a particular compositor stall or exclude every product animation defect.

The smoke now uses the same ten-second bounded readiness budget as its existing
drag-teardown helper. It still requires the overlay to be gone, an actual
animation-start marker, and **both** destination slots to have settled. It also
checks descendant animations/transitions and pending animation work, rather
than just the outer FLIP. A stuck animation remains a failure. Last-sample
existence, play states, pending flags, current/end times and `settleReadyMs`
distinguish missing DOM from unfinished browser work on future failures.
Cross-column selection, two-card selection, cluster, both moved cards, and
exact Backlog/Todo restoration assertions are unchanged.

### Unit: collapsed-pill picker measure count

The main failure (`37317468399`, desktop shard 2/4) compared **one** canvas
measurement with **zero** after unequal real-frame delivery. Both were below
the explicit measure bound, but equal counts are an important structural proof
and are retained. `act` flushes React, not Motion's captured rAF callbacks or
dnd-kit's resize debounce.

The test controls timers/performance, installs rAF before Motion imports it,
and delivers initial and changed ResizeObserver entries from the existing
layout shim. Browser work drains before each counter boundary **and after every
counted pointer/key event**. It does not exclude feedback generated by flips.
A hard 120-frame quiescence limit fails on unbounded browser work. Few/many
comparisons, every collision-target assertion and all measure bounds remain.
Removing `sameScrollableAncestors`' runtime guard from the workspace-installed
CJS artifact made the collapsed-pill test fail: **24 measurements versus 8**
after the collision alternation assertions passed. The artifact was restored
byte-for-byte (SHA256
`de8820811aba1aa22032f4be07ded73e36c4d14fe1c1cfea6701246105785f1f`).
The final file passed **50/50 serial local invocations, 300/300 cases, no retries**.

## Local checks

- `git fetch origin && volli worktree sync`
- `pnpm install --frozen-lockfile --offline --ignore-scripts`
- `pnpm -C apps/desktop run rebuild:native`
- `pnpm run build`; `pnpm run ensure:electron`
- `node apps/desktop/e2e/board-smoke.mjs`: **all checks passed**, first local run.
  8.5 observed settle in 226ms; 11.5 observed High in 189ms, with persistence.
  Repeated once after the submenu-readiness follow-up; all checks passed again.
- `vp check`: formatting/lint passed.
- `vp run --filter @volli/desktop typecheck`: all four configs passed.
- From `apps/desktop`, `vp test run
  src/renderer/src/components/board/board-priority-projection.test.tsx
  src/renderer/src/stores/board.test.ts --maxWorkers="$VOLLI_CONCURRENCY_HINT"`:
  **143 tests passed**.
- From `apps/desktop`, `vp test run
  src/renderer/src/components/board/board-dnd.test.ts
  src/renderer/src/components/board/board-drop-automation.test.tsx
  --maxWorkers="$VOLLI_CONCURRENCY_HINT"`: **33 tests passed**.
- From `apps/desktop`, `vp test run
  src/renderer/src/components/board/board-drag-measure-loop.test.tsx
  --maxWorkers="$VOLLI_CONCURRENCY_HINT"`, repeated serially 50 times:
  **50/50 files, 300/300 cases**. Logs: `drag-measure-repeat.log`.
- Measure-loop mutation: the same drag test with `-t 'collapsed pill'` failed
  at 24 versus 8; installed artifact restored byte-for-byte.
- Priority mutation: the same projection test failed at its pre-IPC High
  assertion; restored production source has no diff.

The PR/ticket records final-head CI gate and eight consecutive first-attempt
board observations from uploaded results and logs, not merely green job color.
No sleep-as-fix, quarantine, assertion deletion or retry-policy change.
