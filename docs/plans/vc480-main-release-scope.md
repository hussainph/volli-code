# VC-480 on main, without VC-45

PR #656 targets main for 0.2.1. Configure → Protection replaces Authority for everyone. There is no feature flag or Settings opt-in. The switch is off by default (the built-in `observe` policy still supplies no runtime gate). VC-45 is held for 0.2.2; no VC-45 implementation is carried into this branch.

## Boundary and deliberate cuts

- Protection enables main's existing deterministic file/command rule gate and asks immediately on approvable refusals. No classifier, denial thresholds, Scoped containment, writable roots, credential index or filesystem scanners are activated.
- Removed the old enforcement posture, decision mode, classifier, fallback thresholds, budget and other actor controls: they made a one-switch experience misleading or exposed inactive settings. Advanced retains only the visible Session transcript-read setting, collapsed by default.
- The gate allows reads of a Session's saved tool output (VC-469). Outside file-tool reads use exact approvals; ordinary deep writes use narrow folder approvals. Exact-only Git plumbing and Volli-state scopes cannot be cleared by broader folder grants. Shell operands and opaque scripts retain main's documented residual risk.
- Main's hard refusals (platform weakening, TLS weakening, persistence, destructive removal, unreadable calls) remain plain explanations without approval buttons. VC-45-only credential/private/host-data causes and sandbox-wall handling are absent.
- Writable roots are **not** imported as ledger grants. The network ledger is deferred.
- In-app boundary copy: “File and command checks ask before allowing a refused action. This is not a sandbox: scripts can bypass these checks.” The app-owned policy/ledger database has no agent write API; without VC-45, shell access is not an OS-enforced barrier against reaching it.

## Legacy policies: clear with backup

Migration 054 reconciles schema, not policy. At startup, `migrateProtectionPolicies` atomically backs up every non-null raw project policy string to `app_state` key `volli:protection-policy-migration:v1` before updating any project. Backup presence marks completion; the backup is never replaced, including when it is empty. Existing dogfood completion markers are honored.

Projects whose resolved enforcement is `enforce` retain their stored document unchanged and show On. Other projects keep explicit `off`/`observe` and the visible Session transcript-read departure; hidden judgment, classifier, fallback, budget, other actor departures and unknown containment/writable-root fields are cleared to inherited defaults. This is **clear with backup**, not fold into ledger. Turning Protection Off clears hidden supported departures while retaining the visible transcript control. A cleanup/backup failure rolls back the transaction and leaves startup in the existing degraded-database state, rather than presenting an off switch over restrictive hidden policy.

Existing attachments retain their recorded policy. New snapshots pin Protection separately; recovery uses that record, never current settings. Older snapshots without a Protection bit retain their old runtime semantics. The ledger stays live across settings changes and revocation.

## Schema lineage

Main's migration 053 remains the project decision-model column. Migration 054 creates approval/decision tables and repairs the decision-model column for older dogfood databases already stamped 53 with the approval schema. Both stamped-53 lineages and partial approval schemas converge without rewinding versions or replacing history. Decision-model exports retain raw stored JSON.

## How to test (owner)

Use a database copy, not your normal database. Run these yourself from the PR checkout:

```sh
mkdir -p /tmp/vc480-test
sqlite3 "$HOME/Library/Application Support/Volli Code-dev/volli.db" ".backup /tmp/vc480-test/volli.db"
VOLLI_DB_PATH=/tmp/vc480-test/volli.db pnpm dev
```

The dev startup log should say `source=VOLLI_DB_PATH` and `/tmp/vc480-test/volli.db`. The database is copied, but project paths still point at real files: use a disposable project/worktree and scratch paths only.

1. Select a fresh disposable project; Configure → Protection should show **Protection is off** without a General-page opt-in. Turn it on.
2. Start a **new** Session. Ask it to use the `write` tool to create a harmless file outside its workspace in a scratch folder, for example `/tmp/vc480-test/actions/docs/a.txt`. Expect an inline card naming the file and why it stopped.
3. Choose **Allow once**. Ask for another file in that folder: a new card should appear, and no row should have been remembered.
4. Choose **Always allow in this project** on that card. See the narrow write row and its provenance in **Approved actions**. Repeat the same write: no card, and the passed-request count increases after it completes. (Also try **Allow for this Session** on a separate scratch target.)
5. **Revoke** the relevant row, then repeat: the card returns. Choose **Deny and steer** with an in-workspace alternative; the receipt should say denied.
6. Turn Protection off and start another **new** Session. The same outside write should run as before, without a gate/card/ledger audit. Restarting a previously protected attachment deliberately retains its pinned state.
7. Optional: run an unattended Automation with an outside-write request. It should pause, notify, and open the same card. A request to disable TLS checking should instead show a hard refusal, with no approval action; do not approve or execute destructive examples.

Owner hands-on sign-off remains required. CI is not that sign-off. Do not merge until asked.
