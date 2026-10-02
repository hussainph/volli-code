# Historical VC-480 release scope

Superseded by VC-504. This records the retired per-call permission rollout, not
current behavior. For the remaining boundaries, see the public Agent authority
guide (`apps/docs/src/content/docs/guides/authority.mdx`).

# VC-480 on main, without VC-45

PR #656 targets main for 0.2.1. Configure → Protection replaces Authority for everyone. There is no feature flag or Settings opt-in. The switch is off by default (the built-in `observe` policy does not enforce the runtime gate). VC-45 is held for 0.2.2; no VC-45 implementation is carried into this branch.

## Boundary and deliberate cuts

- Protection enables main's existing deterministic file/command rule gate and asks immediately on approvable refusals. Protected attachments use only the ledger/card funnel, even if an On project retains legacy automatic judgment settings. No classifier, denial thresholds, Scoped containment, writable roots, credential index or filesystem scanners are activated by Protection. Unprotected attachments retain current main's VC-28 shadow/automatic review behavior.
- Removed the old enforcement posture, decision mode, classifier, fallback thresholds, budget and other actor controls: they made a one-switch experience misleading or exposed inactive settings. Advanced retains only the visible Session transcript-read setting, collapsed by default.
- The gate allows reads of a Session's saved tool output (VC-469). Outside file-tool reads use exact approvals; ordinary deep writes use narrow folder approvals. Exact-only Git plumbing and Volli-state scopes cannot be cleared by broader folder grants. Shell operands and opaque scripts retain main's documented residual risk.
- Main's hard refusals (platform weakening, TLS weakening, persistence, destructive removal, unreadable calls) remain plain explanations without approval buttons. VC-45-only credential/private/host-data causes and sandbox-wall handling are absent.
- Writable roots are **not** imported as ledger grants. The network ledger is deferred.
- In-app boundary copy: “File and command checks ask before allowing a refused action. This is not a sandbox: scripts can bypass these checks.” The app-owned policy/ledger database has no agent write API; without VC-45, shell access is not an OS-enforced barrier against reaching it.

## Legacy policies: clear with backup

Migration 054 reconciles schema, not policy. At startup, `migrateProtectionPolicies` atomically backs up every non-null raw project policy string to the new `app_state` key `volli:protection-policy-rollout:v1` before updating any project. Only this rollout backup marks completion, including when it is empty; later startups do not replace it or rerun cleanup. The old dogfood backup (`volli:protection-policy-migration:v1`) is preserved byte-for-byte but does not skip this release's cleanup: dormant restrictions may have been stored after dogfood migration. Thus every install gets one rollout cleanup, including installs with an old marker.

Projects whose resolved enforcement is `enforce` retain their stored document unchanged and show On. Other projects keep explicit `off`/`observe` and the visible Session transcript-read departure; hidden judgment, classifier, fallback, budget, other actor departures and unknown containment/writable-root fields are cleared to inherited defaults. This is **clear with backup**, not fold into ledger. Turning Protection Off clears hidden supported departures while retaining the visible transcript control. A cleanup/backup failure rolls back the transaction and leaves startup in the existing degraded-database state, rather than presenting an off switch over restrictive hidden policy.

Existing attachments retain their recorded policy. New snapshots pin Protection separately; recovery uses that record, never current settings. Older snapshots without a Protection bit retain their old runtime semantics. The ledger stays live across settings changes and revocation.

## Schema lineage

Main's migration 053 remains the project decision-model column. Migration 054 creates approval/decision tables and repairs the decision-model column for older dogfood databases already stamped 53 with the approval schema. Both stamped-53 lineages and partial approval schemas converge without rewinding versions or replacing history. Decision-model exports retain raw stored JSON. Approval mutation history and distinct successful-call accounting are additive tables; the host's portable approval Command boundary atomically records intent, immutable receipts/events and the list projection. Saved-approval uses are non-interactive transcript facts, never temporary permission cards.

## Final review evidence

Both owner reviews are covered by the [findings and regression map](vc480-review/results.md). The real Pi/adapter/SQLite integration scripts only the provider: normalization, gate, filesystem operations, durable interactions and unattended attention are production paths.

UI screenshots for the retired pane were removed in VC-504.

