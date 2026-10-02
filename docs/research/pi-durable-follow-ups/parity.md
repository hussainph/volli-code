Follow-up to VC-497; prerequisite VC-496. Coordinate with VC-500 and the authority follow-up.

Pi Durable 1.0.0 selectCut/estimateContext hardcode pi-ai chars/4; beforeCompact runs after selection.

- Restore model-aware estimateMessage for both threshold and retained-tail selection, resource carry/restoration, provider-native compaction with fallback, reasoning binding/elision and model-switch measurement validity.
- Decide exact-pin plus patch versus MIT fork/vendor. Preserve provenance; run exact-version contract tests before upgrades (API explicitly experimental).
- Parity includes usage/cost events for aborted attempts and compaction, retry/sleep/offline supervision, busy steering/follow-up, utility completions and model policy.
- Replace VC-497's O(history) projector/ack-set with bounded incremental projection. Benchmark long sessions, 1/4/10 concurrent Sessions, SQLite reopen/main-thread stalls and slow-client snapshot resets.

Acceptance: CJK/code cuts match the current estimator; native/fallback fixtures pass; no double bills. Set explicit rollout latency/memory budgets with 20+ samples per arm. Incompatible upgrades fail CI rather than corrupting checkpoints.
