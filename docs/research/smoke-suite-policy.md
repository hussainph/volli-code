# Desktop smoke gate policy (VC-522)

## What gates a build

VC-522 established **47 gating smokes**, down from 51 active gates (74 files). VC-529 returns browser-recovery, VC-530 returns automations-picker, VC-531 returns bare-path-env, and VC-532 returns browser-tab for **51 gates**, without deleting a smoke or assertion. All four repairs and their owner-approved return proofs are recorded in the [census follow-ups](smoke-flakes-2026-10.md). New `*-smoke.mjs` files still join automatically unless explicitly excluded for credentials, an existing runner limitation, or measured quarantine. Extended journeys are **not** broadly switched off.

**Core e2e** is the nine-probe `CORE_E2E` set in `apps/desktop/scripts/run-smokes.mjs`. It gates every desktop-relevant PR and runs on main after merges:

| Journey | Core probes (`-smoke.mjs` omitted) |
|---|---|
| Boot, board, persistence | board |
| Session/composer seam | composer-basics, session-rpc-transport |
| Terminal and worktree | terminal, worktree |
| Agent socket / real CLI round-trip | agent-socket, agent-cli-roundtrip |
| Degraded DB / last-clean restore / fresh launch | database-recovery |
| Live tokens, appearance, inheritance, persistence | canvas-theming |

The other 42 probes gate desktop PRs in three rest shards, including all four restored probes above. That includes composer-draft, chat-provisional, interrupt-resume, worktree-cli, automation arming/schedule/provenance/notifications, browser navigation/headless/capture/trace, and the repaired contrast smoke. The coarse prose/website path exemption is unchanged. Core and rest run alongside each other; the `SERIAL` set—`terminal-smoke.mjs`, VC-635's quit probe `database-newer-version-smoke.mjs`, and `database-recovery-smoke.mjs`—runs one probe at a time after its lane's concurrent work drains. `--tier boot` is a compatibility alias for `--tier core`.

No sole core journey is quarantined based on historical flakes. Board and theming exceed the screening threshold but stay gating; DB recovery's sample is too small. The existing DB shutdown-grace fix remains; graceful-exit assertions are not weakened.

## Retry and evidence contract

- At most **two new probe processes**: first attempt, then one retry only if it failed. Never nest a workflow/quiet-window retry around this. Cancellation does not start retries.
- Remove inherited `VOLLI_SMOKE_DIR` for **both** attempts. Each probe creates its own new scratch DB/profile (including probes with their own scratch allocator). Direct invocation of an individual smoke still supports its debugging overrides.
- PASS means first-attempt green. **FLAKY means fail then pass** and counts green, visibly. FAIL means both attempts failed and remains red in core/rest. Native quiet-window failures are independently red and are never excused by retry-green.
- Every lane checkpoints `results.json` on each attempt/result. It records name, status, per-attempt exit code/signal/timestamps/runtime/log path, total runtime, lane, SHA and workflow run/attempt identity. Logs stream to disk as bytes arrive, including the first failure; no loss when the retry passes.
- Job summary lists all outcomes and both attempt durations. Ordered stdout replays both attempts for FLAKY/FAIL. `quiet-window.json` retains the native sampler report/verdict. An incomplete checkpoint has pending/running entries and `completed: false`, **not** fabricated passes.
- CI always uploads `smoke-results-core-*`, `smoke-results-rest-*`, or `smoke-results-quarantine-*` artifacts, retained **30 days**, including on failure/cancellation when the job can still upload. Rerun attempt numbers avoid artifact-name collisions. An unstarted lane cannot manufacture an artifact; an abruptly killed process may leave unfinished metadata, with already streamed logs still available. Reports are not an indefinite historical store: collect/commit rolling censuses or download artifacts before retention expires.
- Local reports default to a fresh ignored `<workspace>/.tmp/smoke-results-*`; CI sets `VOLLI_SMOKE_REPORT_DIR`. Runner jobs obey `min(requested jobs, VOLLI_CONCURRENCY_HINT)` when a Session budget exists.

## Measured quarantine, not red-count suppression

Evidence and limits: [14-day census](smoke-flakes-2026-10.md), committed before implementation. 333 main/PR runs, 354 attempts, 11,651 observed outcomes: 247 retry-green flakes, 41 final failures, 15 genuine same-SHA rerun recoveries. 57 inherited rerun jobs were removed from denominators. First-attempt output was historically lost; most root causes remain hypotheses.

Screen initial workflow opportunities only: at least **50 observations**, at least **3 distinct SHAs with confirmed recovery**, and a **95% Wilson lower bound above 2%**. Confirmed recovery is internal retry-green or a genuine same-run/SHA rerun recovery, counted once per initial opportunity. Related deterministic failures, unrelated-diff suspicions and inherited rerun jobs do not count as recovered flakes. The operational budget is intentionally conservative and descriptive, not a claim of independent/stationary probabilities.

**Current membership: none.** `SMOKE_QUARANTINE` is an empty Map after all four measured probes returned to the rest-tier gate. Legacy deny-list/credential exclusions remain unchanged and are not newly certified stable.

The nightly/manual `.github/workflows/smoke-quarantine.yml` is retained unchanged for future measured entries, separate from `CI gate`. With no members it has no probes to observe; the runner still refuses an empty green lane rather than manufacturing passes, and the observation step remains non-gating via `continue-on-error`. When populated, raw outcomes, failed rows, logs and quiet-window verdicts are retained; build/setup/upload failures can still make that workflow red. No GitHub notification settings, required checks, rulesets or auto-merge settings change.

**Return:** fix the root cause, preserve all assertions, then record at least **50 post-fix fresh-profile opportunities across 3+ SHAs with no FAIL/FLAKY**, including CI observations; remove only the quarantine entry. Restart the evidence window after the fix. The four probe-specific owner-approved exceptions below do not change the ordinary bar for future quarantines.

**VC-531 return exception (owner approved):** bare-path-env (formerly VC-525) returns after **10/10 serial fresh-profile local passes plus 3/3 first-attempt quarantine passes, with no FAIL/FLAKY**, replacing the original observation bar for this smoke only. Every assertion and the 12s bound remain. Its quarantine entry stayed in place during the dispatches and was removed afterward in the same PR. [Diagnosis and proof](smoke-flakes-2026-10.md#vc-531-bare-path-readiness-capture-repair).

**VC-530 picker return (replaces VC-524):** the owner explicitly substituted **10 serial fresh-profile local passes plus three branch dispatches of Smoke quarantine with no picker FAIL/FLAKY** for the 50-opportunity/3-SHA bar, for this probe only. The completed proof is **10/10 local plus 12/12 concurrent CI picker passes across three executed dispatches**; run links and censoring are in the [post-census investigation](smoke-flakes-2026-10.md#vc-530-picker-post-census-investigation-and-return) and [PR #693](https://github.com/hussainph/volli-code/pull/693). A temporary observation input ran four simultaneous picker profiles per dispatch and was removed, with its sole helper, after recording proof at the owner's direction; the shared workflow is unchanged. Ongoing proof is the restored rest-tier gate on every desktop PR, with all Offered/Option aiming/digit pinning/Move only/Escape/empty-column assertions retained. This exception does not change other probes' return criteria.

**VC-532 return exception (owner approved):** browser-tab (formerly VC-526; pre-fix 16/226, 7.1%) returns to the rest gate after its label pin moved from hold/boot time to the cursor drawing acknowledgement, with every assertion retained. The owner waived 50 opportunities/3 SHAs in favour of **10/10 serial local fresh-profile passes** and **3/3 first-attempt branch quarantine passes**, with no FAIL/FLAKY: [37071384643](https://github.com/hussainph/volli-code/actions/runs/37071384643), [37071599558](https://github.com/hussainph/volli-code/actions/runs/37071599558), [37071864839](https://github.com/hussainph/volli-code/actions/runs/37071864839), all on fix SHA `47a7c5aab`. The quarantine entry stayed in place during those dispatches and was removed afterward in the same PR. [Diagnosis and proof](smoke-flakes-2026-10.md#vc-532-browser-tab-holdcursor-repair).

**VC-529 return:** browser-recovery is gating again after a bounded per-generation rendering handshake, with every assertion preserved. The owner waived the 50-opportunity / three-SHA return condition for this probe in favor of **10/10 serial fresh-profile local passes plus 3/3 first-attempt CI quarantine passes**, with no FAIL/FLAKY and clean native quiet-window verdicts. [Repair evidence and run IDs](smoke-flakes-2026-10.md#vc-529-browser-recovery-return-to-the-gate). Other probes retain the ordinary return condition.

The fifth non-core threshold candidate, **vc418-contrast**, stays gating: the captured defect was literal `"2px"` matching while the focus ring was still interpolating (`1.99963px`). Fix actual readiness rather than discard contrast coverage. Canvas transition completion, composer dialog unmount and the shell unit test's environment read likewise receive synchronization fixes, not weakened assertions.

## Consolidation proposal — owner review required

**Proposal only. No smoke or assertion is deleted here.** Counts below are candidate process/boot reductions, not promised wall-clock improvements. Preserve a named assertion inventory and all reload/second-launch/isolation boundaries before replacing any gate. Require owner approval **before** deleting a file or duplicate check.

### Automations: eight files → five journey owners

1. **Contract tracer** (`automations-smoke`): keep CRUD, validation, sort order, missing-model/no-durable-run and deletion assertions.
2. **Author → schedule → restart** (`automations-page` + `automations-schedule`): share launch/editor fixtures; retain defaults, ticket/project ownership listings, machine-local switches, row sentences, no cron field, hand run/Run now, lanes/drag rank/reload, timer cursor, relaunch and skipped windows. Duplicate switches may share one assertion only after proving both ownership contexts.
3. **Board move → offer/aim → arm/cancel/fire** (`automations-arming` + `automations-picker`): retain Offered list, Option growth/collapse, digit pinning, model choice, Move only/Escape/empty-column pill, trigger persistence, replace-arm/not-retroactive, no-window when unarmed, single Cancel, cancellation keeps the move, measured 3500ms firing floor, switched-off silence and **real CLI move**. Restore the picker to gating after deflaking; merging must not simply smuggle its unrepaired flake back into the gate.
4. **Inspect rail → provenance everywhere** (`automations-rail` + `automations-provenance`): boot-share, not assertion deletion. Keep rail wiring/click target and each provenance mark independently.
5. **Notification silence/lifecycle** (`automations-notification`): keep its real main Notification interception and relaunch boundaries separate. Missing-model opens Settings is shared setup only after maintaining the no-notification assertion.

### Browser: six smokes → four journey owners

1. **Navigation + cold headless capture** (`browser-page-navigation` + `browser-headless-capture`): boot-share only; preserve page-owned link/submit/Enter navigation and generation bumps separately from cold module load, screenshot bytes/pixels and click capture.
2. **Person tab + headless island** (`browser-tab` + `browser-headless`): keep chrome back/forward/reload, profile isolation, overlay-pixel freeze, popups, DevTools, cursor/hold UI, person takeover, turn-end release, teardown, born-headless islands, composer-relative placement and Open-as-tab/Session marks. Port-level hold/refusal and chrome behavior are different doors, not interchangeable assertions.
3. **Preview fault recovery** (`browser-recovery`): retain rejected/stuck preview bounds/recovery, cancellation on withdrawal, concurrent snapshot/ref consistency, find beyond bound, stale found-ref and explicit screenshot errors. Share presentation-state fixture machinery with the **currently manual** `browser-tools-stress.mjs` only after deciding which checks belong in CI. Do not claim this non-`*-smoke` research/stress probe already gates PRs.
4. **Trace → restart → replay** (`browser-trace`): keep its lifecycle/replay journey whole.

Keep stale-ref through `browser_act` and stale found-ref through `browser_find` as separate door assertions unless the owner explicitly approves consolidation. Quarantined tab/recovery sections return only after the post-fix observation condition; boot sharing does not authorize deleting their unique assertions.

### Core follow-up (not implemented)

- Board header-open/Escape and `c`/Cmd-Enter overlap composer checks. Move only duplicated door checks after composer also proves the created card is **visible on the board**. Keep board's Cmd-K `c` guard, persistence and boot-failure assertions.
- Socket 0600 mode, raw NDJSON context/version response and regenerated shim contents are unique: retain them even if agent socket/CLI/worktree-CLI boot-share later.
- Do not consolidate away real DB restored relaunch/shutdown or theming first-paint/inheritance/persistence checks. Keep credentials-dependent live-model journeys outside unattended CI.

For each later merge, publish old-check → journey-section mapping, run changed journeys, compare retained assertion counts and lane runtime, then obtain owner approval before deleting the old smoke. Filename count is not coverage and concurrent durations cannot simply be summed into a speedup.
