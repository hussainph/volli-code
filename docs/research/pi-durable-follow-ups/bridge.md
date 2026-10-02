Follow-up to VC-497; prerequisite VC-496.

Implement an opt-in ticket-only execution checkpoint bridge, not a second product ledger. The Session Engine owns commands, receipts, attachment/turn truth and the replay cursor; Pi Durable owns execution checkpoints only.

- Persist Engine intent before submit(requestId = command.id); distinguish admission and placement receipts, retry-key scope across attachment recreation, and canonical payload validation.
- Define a bounded projection/outbox or storage-commit cursor and stable event identities. Acknowledge only after Engine and transcript artifact commits.
- Resume only after Engine-authorized attachment ownership and a bounded boot scheduler, never inside observational reconciliation. Preserve stopped/archived/user-interrupted semantics and legacy sidecar compatibility.

Acceptance: inject death before/after admission, receipt, event and acknowledgment; SIGKILL mid-tool and mid-stream through the real SessionRuntime plus SQLite ledger. No duplicate user rows, bills or receipts; no conflicting interrupted/completed facts. Cold restart continues eligible work without resending input.

Evidence: docs/research/pi-durable-spike.md on the VC-497 prototype branch.
