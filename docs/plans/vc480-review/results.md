# Historical VC-480 review

This review describes the retired per-call permission feature. VC-504 removes
that feature; it is not current product guidance. The UI screenshots have been
removed. Historical implementation and review evidence remain in git history.

# VC-480 final owner-review fixes

Reviews: [first, 15d1d7b8](https://github.com/hussainph/volli-code/pull/656#issuecomment-5937498826) and [second, 22f321f6](https://github.com/hussainph/volli-code/pull/656#issuecomment-5937862086). This map covers every P1/P2 and the inexpensive P3s; VC-45 remains deferred and Protection remains off by default.

| Finding (first / second review) | Fix and regression |
|---|---|
| Standards 1 / —: portable mutation boundary | `approval-commands.ts` in session-engine, host SQLite store and Command-ID IPC. Engine and `protection.test.ts` cover identical replay, changed-intent conflict, durable missing-row rejection, reopening, concurrent replay and atomic rollback. |
| Standards 2 / Standards 1 + Spec 2: false wait and missing receipt | One `approval-used` observation becomes a host transcript artifact. Adapter partial-save regression verifies no opened interaction; translation, host-notice and real integration tests verify live/cold rendering and no phantom attention. |
| Standards 3 / Standards 3: inconsistent consent | Shared declared-option decoder used by execution and presentation. `agent-runtime.test.ts` and `interaction.test.ts` cover unoffered/unknown/multiple grants, denial precedence and steering. |
| Spec 1 / —: hidden hard-refusal reason | Collapsed activity displays the host explanation, no approve actions. `activity-ui.test.tsx` uses actual output-error/errorText parts. |
| Spec 2 + runtime 3 / Spec 3: lost redirects and wrong writer | Gate preserves original stage text; policy assigns operation-specific held stages. Gate, policy and renderer tests cover earlier mentions/reads, repeated writers, redirects, quotes, env and wrappers. |
| Spec 3 / —: stale project save state | Project-keyed pane and guarded async saves. Pane tests cover pending success/failure, retarget, disabled controls and stale success cue. |
| Runtime 1 / Spec 1: Git symlink retargeting | Realpath both valued flag spellings, including sequential `-C`. Normalizer/gate tests initialize real repositories and retarget symlinks; the old grant no longer covers the new target. No destructive Git operation runs. |
| Runtime 2 / additional 1: interpreter broadening | Versioned interpreters, attached inline flags, Node long eval/print and Perl clusters retain exact command scopes; no project option. Gate/approvals tests change inline code and reject the old grant. |
| Runtime 4 / additional 2: post-execution tally failure | Completion failures log without replacing successful results; pending accounting retained for idempotent retry. Host trigger-injection test and real Pi result/continuation test ensure execution occurs once. Pre-execution audit still fails closed. |
| Smaller inheritance / — | Only verified ancestor Session grants carry inherited attribution. Host, repository and pane tests distinguish ordinary project use and unrelated Sessions. |
| Smaller count / additional 3 | Durable successful-call identity counts a two-grant completion once. Host → IPC list test, retry deduplication and pane distinct-count regression. |
| — / Standards 2: spacing | Protection and stages use the documented 0/1/2/4/6 ladder. |

## Assurance gaps closed

- Matching-scope authorization lookup in project B fails when only A owns a grant (`authority-approvals-repo.test.ts`).
- Real Pi hooks cover deny, steer, decision-audit failure, repeat/revoke and Session/project isolation (`runtime.test.ts`). No blanket “everything covered after one answer” fixture.
- `protection.integration.test.ts` joins real normalization, Pi, adapter, session engine and SQLite. It covers actual approve/write/repeat/revoke/deny, project/Session isolation, live/reloaded saved-approval artifact, and an actual unattended card driving the existing attention watcher once.
- Fresh off mode executes real file/command operations; recovered off/observe attachments execute a write despite current project On. Legacy pinned behavior remains unchanged.
- Approval-answer Command replay uses the same ID concurrently and after SQLite reopen. The new integration exposed settled-card replay failing with “Interaction is not open”; session-runtime now replays its durable result while still checking changed consent.
- Receipt-code table feeds each actual rejection through `approvalAnswerFailures`; approval copy tests assert distinctive rule explanations rather than generic fallback shapes.

## Red/green evidence

Every confirmed behavioral regression was run against its pre-fix implementation and failed before the fix. New integration/assurance tests that already passed are not represented as regressions. Local logs are retained under `.bench-tmp/`, `.vc480-*.log` and `evidence/vc480-review-fixes/` (ignored scratch evidence, not shipped source). The approval Command replay fix was temporarily removed to confirm its new failure, then restored. A new rollback-assurance test initially expected a thrown error rather than the IPC's error Result; correcting that fixture is not a product regression.

The first CI run caught two integration omissions: Linux's shallow `/tmp` paths made a folder-reuse fixture accidentally request exact-file grants, and the additive history tables needed re-offer-safe DDL plus explicit backup decisions. The fixture now uses a deliberately deep folder and asserts its realpath key; production scope depth is unchanged. Migration 055 re-offers without replacing data. History/receipts/completion counters follow the machine-local approval exclusion in backups, so another machine must re-ask. Dedicated preservation/exclusion tests were run red before these fixes; the existing migration and backup suites are included in final verification.

Focused verification and final commit/CI references are reported in the ticket handoff. Full workspace suites and smoke matrices are delegated to CI, not run locally. See [owner test steps](../vc480-main-release-scope.md#how-to-test-owner); do not merge before the owner's hands-on sign-off.
