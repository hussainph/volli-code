# VC-480 on main, without VC-45

PR #656 now targets main for 0.2.1. VC-45 is held for 0.2.2. This phase retains the **Protection (experimental)** flag, off by default, pending a separate security verification and the subsequent unconditional-page phase. No VC-45 implementation is carried into this branch.

## Boundary and deliberate cuts

- Protection enables main's existing deterministic file/command rule gate. It does **not** install Scoped containment, expand writable roots, or build a credential index. No VC-45 capability policy or filesystem scanners run.
- The gate continues to allow reads of a Session's own saved tool output (VC-469). Outside file-tool reads can use exact read approvals; writes use narrowly scoped write approvals. Shell operands and opaque scripts retain main's documented residual risk.
- VC-45-only private-file, credential and host-data denial causes, card copy, and sandbox-wall refusal handling are removed. Main's hard refusals (platform weakening, TLS weakening, persistence, destructive removal, unreadable calls) remain explanations without approval buttons.
- There are no containment or writable-root controls/search entries on the Protection page. Writable roots are **not** imported as ledger grants.
- On copy: “File and command checks ask before allowing a refused action. This is not a sandbox: scripts can bypass these checks.” The app-owned policy/ledger database is not exposed by an agent write API, but without VC-45 the shell is not an OS-enforced barrier against reaching it.

## Legacy policies

The experimental flag off preserves main's authority settings and runtime behavior. Migration 054 only reconciles schema; it does not change project policy.

When the experiment is first enabled (including startup of already-enabled dogfood), `migrateProtectionPolicies` atomically backs up all non-null raw policy strings to `app_state` key `volli:protection-policy-migration:v1`. Backup presence is the one-time completion marker. Projects whose resolved enforcement is `enforce` retain their stored document unchanged and show On. Other projects keep explicit `off`/`observe` and the visible Session transcript-read departure; hidden judgment, classifier, fallback, budget, other actor departures, and unknown VC-45 containment/writable-root fields are cleared to inherited defaults. This is the **clear with backup**, not fold into ledger, choice. Turning Protection Off also clears hidden supported departures while retaining its visible transcript control. Existing attachments keep their pinned settings.

## Schema lineage

Main's migration 053 remains the project decision-model column. Migration 054 creates approval/decision tables and repairs the decision-model column for older dogfood databases already stamped 53 with the approval schema. Both stamped-53 lineages and partial approval schemas converge without rewinding versions or replacing existing history. Decision-model exports retain the raw stored JSON.

## Review impact

VC-45 capability-index, credential-identity/alias, Seatbelt-pattern, writable-root and wall/grant findings do not describe this diff; their implementation is absent. This does **not** resolve independent VC-480 findings about sensitive folder grants, recovery of Protection mode, ledger counting/provenance/duplicate grants, receipts, or unattended attention. Those remain inputs to the next security verification. Neither green CI nor this rebase is an owner hands-on sign-off. Do not merge in this phase.
