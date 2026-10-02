# VC-522: measured desktop smoke flakes, October 2026

**Measurement first.** This CI-history census was collected and committed before runner/workflow implementation. It is not a local smoke run. No PRs or notification settings were changed to obtain this measurement.

## Window, population, and headline result

- Repository: `hussainph/volli-code`; workflow: `.github/workflows/ci.yml` (`CI`).
- Latest CI timestamp when discovery started: **2026-10-02 20:41:51 UTC**, run [37062233293](https://github.com/hussainph/volli-code/actions/runs/37062233293). The window is the preceding **14 days**, **2026-09-18 20:41:51 through 2026-10-02 20:41:51 UTC**, inclusive, selected by workflow-run creation time, not commit time.
- Listing snapshot: **2026-10-02 20:46:13 UTC**; job/log collection ended **20:58:29 UTC**. Final-failure and Scope logs were inspected afterward. Jobs can complete after the creation-time cutoff; this is not a claim that every observation existed at 20:41:51.
- The paginated API returned **337 runs**, below GitHub's 1,000-result search cap. Excluding **4 manual dispatches** leaves **333 runs: 77 main pushes and 256 pull-request runs**, including failed/cancelled/incomplete runs. All attempts available in that listing were inspected: **354 attempt records across 333 runs**. There was no success-only sampling or per-PR cap.
- After excluding inherited rerun jobs, **11,651 observed smoke outcomes across 52 historical smoke names**: **11,363 PASS, 247 pass-on-retry FLAKY, 41 final FAIL**. **15 final-failure outcomes recovered in a genuinely executed later attempt of the same workflow run/SHA**; this is separate from internal retries. The remaining 26 were not observed to recover on that same run/SHA, not necessarily permanent defects.
- Initial workflow attempts alone have **11,425 outcomes: 11,144 PASS, 241 FLAKY, 40 FAIL**. **159 initial workflow runs emitted at least one FLAKY**. Do not treat all 333 runs as executed opportunities for every smoke.
- Only **1 final FAIL** is classified here as verified unrelated to the desktop diff. Many plausible examples do not meet that stricter evidence bar; “no verified evidence” is not “related” or “not flaky.”

Activity was uneven: sampled run counts by UTC creation date were Sep 18: 5; Sep 21: 1; Sep 26: 11; Sep 27: 10; Sep 28: 28; Sep 29: 83; Sep 30: 17; Oct 1: 128; Oct 2: 50. This is a two-week available-history window, heavily weighted toward the last four days, not two weeks of steady daily observations.

The ticket's **74 smoke files are not 74 active CI gates**. At the measured checkout (`24d78231b254a9acc8342755d070ae277103ef4e`), 74 `*-smoke.mjs` files exist, but 23 were not sampled: deny-listed or credential-requiring probes. There are 51 current runnable names plus one sampled historical name (`vc322-accessibility-smoke.mjs`). `agent-cli-token-bench.mjs` is additionally deny-listed. Main runs only the five boot probes; rest-tier smokes run on desktop-relevant PRs. A zero in the main column for theming/DB/session rest probes is deliberate workflow coverage, not proof those probes passed main.

## Method and reproduction

The files accompanying this report are:

- `measure-smoke-flakes.py`: Python standard-library collector/parser/aggregator; uses the requested `gh` CLI, bounded to `min(4, VOLLI_CONCURRENCY_HINT)` concurrent requests.
- `smoke-flakes-2026-10-evidence.json.gz`: compact retained evidence (run identity/SHA/event/attempt, job/step timestamps, original outcome lines with line numbers, log-output SHA-256, final-failure excerpts, exact Scope changed paths, and censoring/errors). No credentials or local user profiles are read.
- `smoke-flakes-2026-10-table.md`: generated full table, reproduced below.

Discovery and example drill-down commands actually used:

```bash
gh run list -R hussainph/volli-code --workflow ci.yml --limit 8 \
  --json databaseId,createdAt,updatedAt,event,headBranch,headSha,attempt,conclusion,status,displayTitle,url

gh api 'repos/hussainph/volli-code/actions/workflows/ci.yml/runs?created=2026-09-18T20%3A41%3A51Z..2026-10-02T20%3A41%3A51Z&per_page=1'
gh api 'repos/hussainph/volli-code/actions/runs/37061132834/attempts/1/jobs?per_page=100'
gh api repos/hussainph/volli-code/actions/jobs/111006895804/logs --allow-escape-sequences
```

Reproduce the census (network read only), enrich the failure evidence, then regenerate the table:

```bash
python3 docs/research/measure-smoke-flakes.py collect --end 2026-10-02T20:41:51Z --days 14
python3 docs/research/measure-smoke-flakes.py enrich
python3 docs/research/measure-smoke-flakes.py summarize
python3 docs/research/measure-smoke-flakes.py self-test
```

`collect` is resumable from the ignored `.smoke-flakes-cache/`. An initial shell call reached its 600-second bound after 262/333 runs; the next identical call completed from that cache. A new cache/listing can see newer attempts or expired/deleted logs, so the committed compressed evidence is the reproducible *snapshot*, while recollection is a fresh measurement of availability. `summarize` needs no network or project dependencies. The parser matches only `PASS|FLAKY|FAIL filename.mjs (seconds)` outcome lines, never the final FLAKY/FAILED summary a second time. It handles both GitHub's `##[group]` rendering and raw workflow-command groups. The collector refuses truncated run/job pagination rather than quietly accepting it.

### Units and important rerun distinction

- **PASS:** the runner emitted PASS: first smoke process exit was zero.
- **Retry-green / FLAKY:** first smoke process failed, the runner's one retry passed. This is an observed recovery, not an inferred flake from a short runtime.
- **Final FAIL:** both smoke processes failed. The runner already retries once; 41 here is not a count of individual first-process failures.
- **Same-run recovery:** that final FAIL later emitted PASS or FLAKY in another workflow attempt of the **same run ID and SHA**. A green new commit on the same branch is not counted.
- **N:** actual observed executions of the runner's per-smoke retry pair, including genuinely rerun jobs. **Initial N** uses only workflow attempt 1, the less selection-biased denominator used for quarantine decisions.
- **Runtime:** the runner's wall seconds, median and nearest-rank p95. FLAKY and FAIL durations include both processes; single-attempt duration and retry cost cannot be separated from these historical logs.

**GitHub rerun metadata needs deduplication.** Failed-jobs-only reruns include successful prior jobs under new job IDs/attempt numbers while preserving their original timestamps and logs. There were **57 such inherited smoke jobs / 676 duplicated smoke outcomes**; all 57 available log hashes matched their prior job. Those are retained and marked `inherited_from_attempt` in the evidence, but excluded from N, status counts, runtimes and recovery. Example: the DB-recovery job in run 37060427962 has IDs 111015504347 (attempt 1) and 111018879501 (attempt 2), yet both started 20:25:16 and completed 20:31:17, with identical output. DB recovery did **not** execute again in that failed-job rerun.

## Full smoke table

PASS + Retry-green + Final FAIL = N. Recovery and verified unrelated FAIL are **subsets**, not additional outcomes. Initial retry/fail SHAs counts distinct initial-attempt SHAs emitting either FLAKY or FAIL; unlike the quarantine metric below, it does not certify every FAIL as a flake. Verified unrelated FAIL counts only the strict Scope-backed classification described below; all other zeros mean no verified classification.

<!-- BEGIN GENERATED SMOKE TABLE -->
| Smoke (`.mjs` omitted) | N (main/PR) | Initial N | PASS | Retry-green | Final FAIL | Same-run recovery | Initial retry/fail SHAs | Verified unrelated FAIL | Runtime median/p95 s |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| agent-background-install-smoke | 228 (0/228) | 227 | 228 | 0 | 0 | 0 | 0 | 0 | 62.8/101.9 |
| agent-board-live-move-smoke | 238 (0/238) | 228 | 238 | 0 | 0 | 0 | 0 | 0 | 31.9/43.0 |
| agent-cli-relaunch-smoke | 232 (0/232) | 229 | 227 | 4 | 1 | 1 | 5 | 0 | 30.8/42.8 |
| agent-cli-roundtrip-smoke | 229 (0/229) | 228 | 229 | 0 | 0 | 0 | 0 | 0 | 33.2/47.7 |
| agent-cost-smoke | 238 (0/238) | 228 | 238 | 0 | 0 | 0 | 0 | 0 | 32.7/44.0 |
| agent-installer-smoke | 232 (0/232) | 229 | 232 | 0 | 0 | 0 | 0 | 0 | 61.5/92.8 |
| agent-pty-env-smoke | 229 (0/229) | 228 | 229 | 0 | 0 | 0 | 0 | 0 | 31.1/48.5 |
| agent-socket-smoke | 300 (76/224) | 296 | 300 | 0 | 0 | 0 | 0 | 0 | 30.0/40.4 |
| automations-arming-smoke | 238 (0/238) | 228 | 235 | 1 | 2 | 0 | 3 | 0 | 49.0/59.0 |
| automations-notification-smoke | 230 (0/230) | 227 | 230 | 0 | 0 | 0 | 0 | 0 | 90.9/116.6 |
| automations-page-smoke | 229 (0/229) | 228 | 229 | 0 | 0 | 0 | 0 | 0 | 46.2/57.9 |
| automations-picker-smoke | 237 (0/237) | 227 | 219 | 16 | 2 | 0 | 17 | 0 | 61.0/109.2 |
| automations-provenance-smoke | 232 (0/232) | 229 | 232 | 0 | 0 | 0 | 0 | 0 | 30.9/39.5 |
| automations-rail-smoke | 229 (0/229) | 228 | 227 | 0 | 2 | 0 | 2 | 0 | 29.2/40.4 |
| automations-schedule-smoke | 236 (0/236) | 226 | 232 | 3 | 1 | 1 | 4 | 0 | 45.7/63.0 |
| automations-smoke | 232 (0/232) | 229 | 230 | 0 | 2 | 0 | 2 | 0 | 21.4/30.9 |
| bare-path-env-smoke | 228 (0/228) | 227 | 210 | 16 | 2 | 0 | 18 | 1 | 19.4/56.3 |
| board-smoke | 298 (76/222) | 294 | 285 | 13 | 0 | 0 | 12 | 0 | 75.4/98.5 |
| browser-headless-capture-smoke | 236 (0/236) | 226 | 235 | 1 | 0 | 0 | 1 | 0 | 39.5/56.0 |
| browser-headless-smoke | 230 (0/230) | 227 | 229 | 1 | 0 | 0 | 1 | 0 | 47.2/67.8 |
| browser-page-navigation-smoke | 227 (0/227) | 226 | 219 | 8 | 0 | 0 | 8 | 0 | 30.3/50.6 |
| browser-recovery-smoke | 235 (0/235) | 225 | 170 | 54 | 11 | 7 | 63 | 0 | 47.2/95.3 |
| browser-tab-smoke | 229 (0/229) | 226 | 212 | 15 | 2 | 1 | 17 | 0 | 50.1/84.8 |
| browser-trace-smoke | 188 (0/188) | 187 | 188 | 0 | 0 | 0 | 0 | 0 | 53.0/69.1 |
| canvas-theming-smoke | 233 (0/233) | 224 | 181 | 49 | 3 | 2 | 51 | 0 | 79.6/133.8 |
| changeset-diff-tabs-smoke | 229 (0/229) | 225 | 229 | 0 | 0 | 0 | 0 | 0 | 52.0/78.7 |
| changeset-navigators-smoke | 227 (0/227) | 226 | 227 | 0 | 0 | 0 | 0 | 0 | 41.9/60.7 |
| chat-provisional-smoke | 234 (0/234) | 225 | 234 | 0 | 0 | 0 | 0 | 0 | 33.4/50.1 |
| composer-basics-smoke | 298 (76/222) | 294 | 287 | 8 | 3 | 2 | 10 | 0 | 47.0/62.7 |
| composer-draft-smoke | 228 (0/228) | 224 | 228 | 0 | 0 | 0 | 0 | 0 | 69.3/101.9 |
| database-recovery-smoke | 9 (0/9) | 9 | 2 | 5 | 2 | 0 | 7 | 0 | 149.4/202.8 |
| done-flow-smoke | 226 (0/226) | 224 | 218 | 7 | 1 | 0 | 8 | 0 | 50.2/90.4 |
| harness-doctor-smoke | 233 (0/233) | 225 | 233 | 0 | 0 | 0 | 0 | 0 | 21.4/34.6 |
| interrupt-resume-smoke | 226 (0/226) | 222 | 222 | 4 | 0 | 0 | 4 | 0 | 116.3/152.8 |
| memory-smoke | 224 (0/224) | 222 | 223 | 1 | 0 | 0 | 0 | 0 | 158.7/203.2 |
| model-access-signin-smoke | 233 (0/233) | 225 | 231 | 2 | 0 | 0 | 2 | 0 | 24.7/43.5 |
| peek-summary-readability-smoke | 59 (0/59) | 59 | 59 | 0 | 0 | 0 | 0 | 0 | 82.4/124.3 |
| project-files-smoke | 230 (0/230) | 225 | 230 | 0 | 0 | 0 | 0 | 0 | 63.1/95.1 |
| quick-open-smoke | 227 (0/227) | 223 | 227 | 0 | 0 | 0 | 0 | 0 | 38.9/62.0 |
| retention-smoke | 228 (0/228) | 223 | 220 | 7 | 1 | 0 | 8 | 0 | 36.9/62.5 |
| session-rpc-transport-smoke | 230 (0/230) | 225 | 230 | 0 | 0 | 0 | 0 | 0 | 19.1/34.0 |
| settings-search-smoke | 227 (0/227) | 223 | 223 | 0 | 4 | 0 | 4 | 0 | 33.3/51.2 |
| split-view-smoke | 228 (0/228) | 223 | 228 | 0 | 0 | 0 | 0 | 0 | 38.0/53.2 |
| terminal-a11y-smoke | 230 (0/230) | 225 | 229 | 1 | 0 | 0 | 1 | 0 | 40.5/61.3 |
| terminal-smoke | 295 (76/219) | 291 | 293 | 2 | 0 | 0 | 2 | 0 | 50.7/58.3 |
| ticket-detail-smoke | 226 (0/226) | 222 | 223 | 2 | 1 | 0 | 3 | 0 | 70.5/110.1 |
| ticket-open-ipc-smoke | 228 (0/228) | 223 | 228 | 0 | 0 | 0 | 0 | 0 | 39.2/57.0 |
| vc322-accessibility-smoke | 1 (0/1) | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 61.7/61.7 |
| vc418-contrast-smoke | 228 (0/228) | 223 | 200 | 27 | 1 | 1 | 28 | 0 | 27.0/53.1 |
| vc85-signal-smoke | 227 (0/227) | 223 | 227 | 0 | 0 | 0 | 0 | 0 | 19.6/38.2 |
| worktree-cli-smoke | 228 (0/228) | 223 | 228 | 0 | 0 | 0 | 0 | 0 | 20.1/31.8 |
| worktree-smoke | 299 (76/223) | 295 | 299 | 0 | 0 | 0 | 0 | 0 | 33.3/43.9 |
<!-- END GENERATED SMOKE TABLE -->

### Current probes without observations

These 23 current smoke files have **N=0 / runtime unavailable**, not a measured 0% flake rate. They stay excluded under the pre-existing policy; this ticket does not newly quarantine them.

| Reason | Smoke names (`-smoke.mjs` omitted) |
|---|---|
| Live Pi credentials required | cli-chat-mode, composer-kickoff, composer-verbs, pi-ask-user, pi-project-chat, pi-session-start-tool, pi-sessions-host, pi-ticket-chat, session-env-parity |
| Explicit legacy deny-list (individual reasons in `run-smokes.mjs`) | editor-theme, ghostty-config, global-artifacts, harness-wrapper, home-taxonomy, live-preview, menu-scroll, monaco-reconciliation, park, quit-window-lifecycle, reflow-a11y, reflow-matrix, settings-fill, sigstop |

## Evidence behind important reds

Each job link resolves to the original attempt/job; exact status lines and replay excerpts are retained in the compressed evidence.

| Probe / workflow | Evidence | Interpretation |
|---|---|---|
| `browser-recovery`, run [36832526105](https://github.com/hussainph/volli-code/actions/runs/36832526105) | Attempt 1 job [110272341458](https://github.com/hussainph/volli-code/actions/runs/36832526105/job/110272341458): `Click lost its result`; later attempt passes on the same SHA. Seven browser-recovery final failures recover that way in the census. | Repeated observed nondeterminism, not merely a suggestive branch title. Other final failures say `Preview did not recover`; do not assume those are the same underlying bug. |
| `canvas-theming`, PR #675, run [37060427962](https://github.com/hussainph/volli-code/actions/runs/37060427962) | Attempt 1 job [111015506416](https://github.com/hussainph/volli-code/actions/runs/37060427962/job/111015506416): check 18 token is correct (`#d3eaf7`), crossfade exists (`runs=[1972]`), but `active=true`; genuine attempt 2 passes on SHA `081083ae7e19…`. | Strong animation-settling evidence. Earlier run 36624612392 similarly failed check 7 with `active=true`, then recovered at the same SHA. Preserve the theming gate; fix the synchronization. |
| `composer-basics`, main run [37059885594](https://github.com/hussainph/volli-code/actions/runs/37059885594) | Attempt 2 job [111017264394](https://github.com/hussainph/volli-code/actions/runs/37059885594/job/111017264394): check 9, `Escape closes the open dialog`, `open=1 closedAfter=1`; attempt 3 passes on `4a4a8bfbefd4…`. Attempt 1 returned no jobs. | One verified same-SHA recovery, not three independent first attempts. Its main merge contains runtime/dependency changes, so no unrelated-diff certification is made. |
| `database-recovery`, PR #675, run [37057808585](https://github.com/hussainph/volli-code/actions/runs/37057808585) | Job [111006895804](https://github.com/hussainph/volli-code/actions/runs/37057808585/job/111006895804): four recovery checks pass; fresh restored launch cleanup falls back to SIGTERM after `app.close timed out after 20000ms`, then fails `fresh restored launch did not quit cleanly`. | This run has **no same-SHA workflow rerun** in the census. The subsequent PR run uses a new SHA (`7cb2371d951e…` → `081083ae7e19…`) and DB passes internally on retry. Do not report that as same-SHA final-failure recovery. The first DB FAIL, run 37052447217, is on the probe's own implementation diff. |
| `vc418-contrast`, run [36812698867](https://github.com/hussainph/volli-code/actions/runs/36812698867) | Job [110211086817](https://github.com/hussainph/volli-code/actions/runs/36812698867/job/110211086817): light text contrast 4.5056 and ring contrast 5.0797 pass; `focusVisible=true`, opacity 1, declared offset 2px, but the animated computed shadow contains **1.99963px / 3.99926px**, producing `visibleFocus=false`. Same-SHA rerun passes. | Concrete cheap probe defect: checking `boxShadow.includes("2px")` after a fixed 250ms delay can sample interpolation just short of the literal string, even while focus/contrast are correct. Not proof that all 27 internal recoveries share this cause—their first output is lost. |
| `settings-search` | Four final FAILs, no retry-green or same-SHA recoveries. Three say `Decision model` is unreachable in Models/Configure Sessions; one says `Saved tool output` is unreachable in Storage. | These are visible-label/search consistency assertions on related changes, not measured flakes. **Do not quarantine from red counts alone.** |
| Automation probes on VC-406 | Runs 36482513925 and 36483274017; second run's replay repeatedly says `window.api.automations.runsForTicket is not a function`. Scope includes the IPC/automation/rail changes. | Related stale-contract failures are not flake evidence. In particular automations-rail and automations-smoke have zero observed recoveries. Some first-run failure replay is censored by cancellation. |

### Unrelated diffs: one verified case, several deliberately unproven claims

Run [36705617506](https://github.com/hussainph/volli-code/actions/runs/36705617506) (`fix/release-dmg-publish-race`) has a Scope log, job **109855042686**, listing **only `.github/workflows/release.yml`**. The CI workflow, built app, smokes and dependency graph are unchanged by that diff. `bare-path-env` fails both processes in job [109855090266](https://github.com/hussainph/volli-code/actions/runs/36705617506/job/109855090266), check 2: harness-wrapper readiness marker absent after the bounded wait. This is the one certified unrelated final failure; it is not additionally certified as a recovered flake, because no same-SHA recovery is observed.

The exact Scope logs for all 32 runs with final FAIL were inspected (31 PRs plus one main push). This matters: an icon or website branch title often concealed a large two-endpoint diff against a newer base. Examples: run 36563119854 (“usage limits icon”) actually lists **671 changed paths**; run 36788531320 (“website/docs”) lists **130**, including lockfile and shared/CLI changes. These were not certified as unrelated.

**PR #675 is not literally bench/docs-only.** Its two failing Scope logs list 20 files, including `packages/agent-runtime/package.json` and `pnpm-lock.yaml`, in addition to research/bench files. A comparison of base `24d78231…` to head `7cb2371d…` shows new **dev** dependencies (`chord`, `pi-durable`, `pi-durable-ai`, workspace session-engine), rather than production source changes. That supports a plausible unrelated hypothesis, but installation/bundling effects were not independently excluded. Therefore the table assigns **zero verified unrelated failures to DB recovery and canvas theming**, rather than repeating the ticket's stronger assumption. Read-only history of #675 was used; no PR was modified.

`background-shell-host.test.ts` in the ticket is a unit-test example, not a desktop smoke. This census does not measure or quarantine unit tests and does not count that example toward any smoke's flake rate.

## Censoring and confidence

- **1,155 non-inherited smoke job records:** 999 expose at least one outcome; 156 expose none (95 skipped, 31 failed before/without results, 26 cancelled, 4 incomplete). **16 log requests returned HTTP 404**, retained as errors; no workflow-attempt metadata request failed. A failed job without a smoke outcome is not assigned to every smoke in its shard. Partial cancelled-job logs contribute only their completed outcome lines.
- The runner captures only the second process after a retry and replays only final failures. A FLAKY line proves first-failure/second-pass, but **the first failure's assertion, output, duration and cleanup details are censored**. It cannot prove a specific timeout cause. New durable per-attempt reporting is warranted even though retry-once already exists.
- Manual reruns are selectively requested after red. Pooling them naively biases both runtime and flake rate, which is why the table labels Initial N and decisions use initial attempts. Deduplication of inherited jobs is additionally necessary.
- Deny-listed/credential-gated probes have no denominator here, not a 0% flake rate. One historical probe has N=1; DB recovery has only nine initial observations, first appearing on Oct 2. Those cannot establish long-term stability.
- The sample spans changing code, runner loads, probe membership and the Sep 29 CI layout change (`a41d09ffe`). Rates are descriptive, not stationary probabilities. Correlated smokes/branches mean Wilson intervals below are screening aids, not independent experiments or family-wide statistical guarantees. A green retry also does not excuse a genuine nondeterministic app defect.

## Quarantine threshold and recommendation

Use **confirmed recovery** for an initial-run opportunity: an initial FLAKY, or an initial final FAIL that later recovers in a genuinely rerun job on that same run/SHA. Count each initial opportunity once. Do **not** include unproven unrelated failures, new-SHA branch recovery, or inherited jobs in this numerator.

A conservative *candidate* threshold is:

1. At least **50 initial opportunities**;
2. At least **three distinct initial SHAs with confirmed recovery**;
3. The **95% Wilson lower bound exceeds 2%** (z=1.96), not just the observed point estimate;
4. The probe is **not the only core coverage** for its journey, and the underlying deterministic failing assertions are still protected elsewhere or fixed before removal from gating.

Two percent is an operational reliability budget, not a natural constant: dozens of independent 2%-flaky gates would already make a run unreliable. Requiring a lower confidence bound plus repeated SHAs avoids moving one-off reds or tiny samples into quarantine. After a repair, restart the observation window rather than pooling the pre-fix history forever.

| Probe | Initial confirmed recoveries / N | Rate (95% Wilson interval) | Distinct confirmed SHAs | Recommendation |
|---|---:|---:|---:|---|
| browser-recovery | 59/225 | 26.2% (20.9–32.3%) | 59 | Non-gating candidate; preserve navigation/hold/CLI browser integration elsewhere. Investigate post-click snapshot/preview settling; final replays show lost click result and failed preview recovery. |
| automations-picker | 15/227 | 6.6% (4.0–10.6%) | 15 | Non-gating candidate, **not** the whole automation family. Keep deterministic arming/provenance/schedule journey coverage. Internal first-failure cause is unavailable. |
| bare-path-env | 16/227 | 7.0% (4.4–11.1%) | 16 | Non-gating candidate while preserving ordinary boot and CLI round-trip. Investigate startup readiness capture / the 12s marker wait; do not suppress actual wrapper-generation errors. |
| browser-tab | 16/226 | 7.1% (4.4–11.2%) | 16 | Non-gating candidate only with tab ownership/refusal kept in deterministic tests and a stable browser journey. Final failures include check 8's cursor/hold UI assertion; inspect lost first attempts before attributing all flakes. |
| vc418-contrast | 28/223 | 12.6% (8.8–17.5%) | 28 | Prefer the cheap focus-settling fix; otherwise non-gating extended contrast candidate, **not** removal of core theming or accessibility assertions. |
| canvas-theming | 50/224 | 22.3% (17.4–28.2%) | 50 | Meets statistical threshold but **protected core: keep gating**, repair transition synchronization. If splitting, only incidental motion timing may move; tokens, mode, inheritance and persistence remain gating. |
| board | 12/294 | 4.1% (2.4–7.0%) | 12 | Meets statistical threshold but **protected core: keep gating**, repair evidence/interaction waits. |
| database-recovery | 5/9 | 55.6% (26.7–81.1%) | 5 | Too few opportunities and **protected core**. Urgent shutdown investigation, never blanket quarantine of recovery. |

Composer-basics is also protected; 9/294 confirmed initial recoveries (3.1%, interval 1.6–5.7%) does not meet the lower-bound threshold. Agent CLI relaunch (5/229), browser-page-navigation (8/226), done-flow (7/224), and retention (7/223) are watch-list items, not justified quarantine decisions under this threshold. Settings-search, automations-rail and automations-smoke must not be quarantined merely for related final failures.

These are recommendations, **not implemented moves**. Any quarantine should be explicit, non-gating but still executed/reported, with an issue naming the probe, evidence IDs, unknown first-failure cause where applicable, and a return condition. Prefer fixing the cheap proven cause to moving a gate. Never silently deny-list a probe just because it is red.

## Preserve core gates and shrink by journeys, not by deleting assertions

A minimum clearly named core set should retain:

- Boot / board / terminal / worktree / agent socket: the existing five boot probes.
- Session/composer: composer-basics, composer-draft/chat-provisional, interrupt-resume and session-rpc-transport coverage, not only “a window appeared.”
- CLI round-trip: agent-cli-roundtrip and worktree-cli.
- Database recovery: corruption/last-clean backup/restore/relaunch, including genuine shutdown failures (distinguish test-owned forced cleanup from normal graceful quit).
- Theming: canvas-theming's generated live tokens, light/dark/system, scope inheritance, persisted settings/relaunch. Extended animated focus snapshots must not be the only accessibility protection.

For owner review, the eight automation probes are candidates for fewer **configuration → arming/trigger → run provenance/notification → schedule** journeys sharing one isolated profile, without removing their assertions. Browser probes can consolidate into **tab navigation/ownership/actions → hide/minimize/headless → preview failure/recovery/trace** journeys. Preserve stable ownership/refusal and click-result assertions while fixing or separating incidental preview/motion races. The two generations of composer names and tiny historical probes need explicit inventory reconciliation, not automatic deletion based on this table. This report authorizes no deletions.

## Runtime and cheap follow-ups

Across successful, actually executed jobs with smoke outcomes:

| Lane | Jobs | Entire job median/p95 | Smoke step median/p95 |
|---|---:|---:|---:|
| Boot | 291 | 238/316 s | 127/162 s |
| Rest shard | 648 | 313/410 s | 207/277 s |

Whole-job times include setup/build/packaging/cache cleanup, not queue time. The table's individual runtimes are overlapping concurrent work, so summing them does **not** estimate critical-path latency. Expensive median probes include memory (158.7s), new DB recovery (149.4s), interrupt-resume (116.3s), automation notification (90.9s) and canvas theming (79.6s). Consolidation should measure end-to-end lane savings afterward; do not promise a speedup from filename count alone.

Proportional next implementation steps, grounded in inspected evidence:

1. **Do not add another nested retry.** `run-smokes.mjs` already implements `runWithRetry`. Retain at most two fresh-profile executions and report both attempts, initial failure output, timings, cleanup outcome and final PASS/FLAKY/FAIL in a job summary plus durable artifact, even on cancellation.
2. Replace canvas check 7/18's fixed `SCOPE_SETTLE_MS = 700` sleeps with a bounded wait for the actual view-transition completion state. Keep token/crossfade assertions and fail if completion never happens. Source: `apps/desktop/e2e/canvas-theming-smoke.mjs`, `readScopeRepaint` and attempts 7/18.
3. Fix the **proved** VC-418 interpolation/string issue: bounded semantic focus-ring settling and numeric/tolerant computed checks, while retaining visibility, opacity and contrast thresholds. Source: `apps/desktop/e2e/vc418-contrast-smoke.mjs:139–164`; the literal-string checks, not the contrast floors, caused the captured final failure.
4. Inspect DB recovery's bounded shutdown and child ownership without treating completed restore assertions as a licence to accept every SIGTERM. Source: `database-recovery-smoke.mjs` cleanup/`closeRun`; the final fail includes `cannot inspect Electron main child before bounded close` after the earlier forced termination.
5. Browser recovery's post-click snapshot and preview recapture deserve targeted investigation. The current source at `browser-recovery-smoke.mjs:248–287` immediately asserts the returned snapshot/result. This census identifies a repeated failing boundary, not which layer owns the fix.

## VC-531: bare-PATH readiness capture repair

The retained first-attempt artifact from quarantine run [37069281453](https://github.com/hussainph/volli-code/actions/runs/37069281453) was inspected before implementation: bare-path-env passed on its first process (32.5s), so this is not a retained failure. Both historical final-failure replays (jobs 109855090266 and 110934290745) fail check 2 with `last value: null`. Their separate main-output evidence files were not uploaded by the historical runner, and the 16 retry-green first-process assertions remain censored. Those logs alone cannot distinguish lost readiness from unfinished generation or explain every historical recovery.

**Reproduced boundary:** the old probe awaited Playwright's `launch()` **before** attaching its pipe listeners. Playwright already drains those pipes while connecting to main and Chromium. With a fast login-shell fixture returning the same bare PATH, a pre-entry capture recorded `[volli] harness runtime ready` before `launch()` returned; the old probe then passed its PATH assertion and failed check 2 after the unchanged 12s wait. The repaired probe passes the same fixture without a retry. This is a probe observation race, not evidence of a wrapper-generation product race.

**Repair:** an environment-only smoke hook in main captures stdout/stderr before boot readiness work, preserving each descriptor's bytes independently. The hook is absent in ordinary launches and does not mutate PATH or generate wrappers. The first revision used Electron's `-r` preload; review caught that the packaged loader ignores that flag, so the final hook runs in both built and packaged app modes without changing launch arguments. The post-window PATH stream is marked by Electron's actual `browser-window-created` event, not the later Playwright client response. The probe still waits for the product's real ready/failure markers with the original 12s bound and now also checks that main initially received exactly `/usr/bin:/bin:/usr/sbin:/sbin`. No product readiness is synthesized, no wrapper generation is bypassed, and no assertion or timeout is loosened. Failure output includes full main logs in the runner's retained attempt log instead of only printing paths to unuploaded temporary files.

Nine focused regressions in `src/main/bare-path-boot-capture.test.ts` cover early readiness, early genuine errors, split/interleaved output, the actual window boundary, pending boot, byte/write forwarding, stale-capture reset, normal-launch inertness and restoration. The desktop CI test discovery includes these tests automatically. A fault-injected isolated launch made a generated `.zshenv` path non-regular: check 2 correctly failed with `failed to generate harness wrappers: Refusing to manage non-regular file`, and the full error was retained in probe output.

**Local proof:** `node apps/desktop/e2e/bare-path-env-smoke.mjs` ran **10/10 PASS, 0 FAIL, 0 retries**, serially with `VOLLI_CONCURRENCY_HINT=1` and inherited `VOLLI_SMOKE_DIR` removed for every fresh profile. `vp test run src/main/bare-path-boot-capture.test.ts --maxWorkers="$VOLLI_CONCURRENCY_HINT"` passed **9/9**, and the shared smoke-kit's focused Node tests passed **22/22**; `vp check`, desktop typecheck, build/packed-require checks and `git diff --check` passed. A disposable packaged-loader fixture (`app.isPackaged=true`, using this worktree's built app) also passed both smoke checks; this is loader compatibility evidence, not a release-packaging test. No full local suite or smoke matrix ran.

Quarantine proof is recorded with the gate-return change below; VC-531 supersedes VC-525. The owner approved staged pushes, including an extra validation revision to preserve packaged support, so the three dispatches execute the final capture implementation while its quarantine selection still exists, before removing that selection. The owner waived the original 50-opportunity/3-SHA return bar in favor of 10 serial fresh-profile local runs and three clean quarantine dispatches.

## Verification performed (VC-522 census)

- GitHub Actions census and focused job/Scope log inspections completed; the run count reconciles to 337 = 333 included + 4 manual dispatches, with no attempt-list request errors. Sixteen log 404s and the empty main attempt are explicitly retained/censored.
- `python3 docs/research/measure-smoke-flakes.py self-test`: **8 focused parser/duration/inherited-job assertions pass**; no application suite runs.
- `python3 docs/research/measure-smoke-flakes.py summarize`: regenerates all 52 rows from compressed evidence; all 11,651 non-inherited outcome counts reconcile.
- `python3 -m py_compile docs/research/measure-smoke-flakes.py`: pass.
- `gzip -t docs/research/smoke-flakes-2026-10-evidence.json.gz`: pass. Evidence is 543,378 compressed bytes; SHA-256 `746ecb311427163d84992b33ebaca28748b48f2a0c5a772c8d01d8d04ada70c3`.
- A focused standard-library evidence check validated the 337-run reconciliation, 333 unique included run IDs, unique outcome keys, initial/all status totals, all 15 same-SHA recovery pairs, every row's status sum, the 52-row generated table's equality with this report, and text whitespace: pass. `git diff --check -- docs/research` also returned clean (the new files additionally received the explicit text whitespace check).

Open limitations: first failed process output was never persisted historically; 16 job logs were unavailable; cancellation and small/new probes censor exposure; cause attribution for most internal retries remains unknown. No local suite, full workspace check, workflow dispatch, rerun, PR mutation, or source implementation was performed.
