# SQLite ownership inventory (VC-551)

Baseline: `origin/main` at `a83bfc8d1`. Inventory includes repo callers, not only
SQL inside `db/`. Reproduction: `rg -l '\.run\(' apps/desktop/src/main/db
--glob '*.ts' --glob '!*.test.ts'`, plus `prepare/exec/transaction/pragma` and
repo-import searches across `apps/desktop/src/main`, and transaction-body review
in `packages/session-engine`. Counts below name transaction boundaries, not
SQL strings in migration definitions or prose.

## Runtime write/read paths

| Paths (relative to `apps/desktop/src/main`) | Ownership |
| --- | --- |
| `db/app-state-repo`, `db/automations-repo`, `db/harness-channel-repo`, `db/harness-registry-repo`, `db/labels-repo`, `db/mcp-operations-repo`, `db/mcp-servers-repo`, `db/secrets-repo`, `db/session-event-provenance`, `db/session-read-repo`, `db/spawn-ledger-repo` | Synchronous statements: autocommit independently, direct when deliberately inside an owned transaction. |
| `db/blobs-repo` (2), `db/comments-repo` (1), `db/pending-armed-runs-repo` (1), `db/projects-repo` (1), `db/signals-repo` (1), `db/tickets-repo` (1) | Compound writes now use `withTransaction`; remaining single writes autocommit. |
| `ticket-commands` (10), `data-ipc` (2) | Duplicated native transaction wrappers folded into `withTransaction`. |
| `experiments` (VC-548, landed during CI) | One settings transaction uses `withTransaction`; committed memory publishes synchronously with the write. |
| `session-control/sqlite-ledger`, `automations/sqlite-ledger`, `worktree/cleanup-ledger` | All three former async gate users now use `settleTransaction`: synchronous body, promise-shaped outcome. |
| `session-runtime/sqlite-host-notice-outbox` (3) | Uses the Session ledger's synchronous atomic boundary. |
| `session-runtime/delegation-store` (4), `agent-dispatch/ticket-verbs` (1), `worktree/publish` (1), `worktree/watch` (1) | Existing synchronous native transactions remain safe; the structural guard wraps all native transaction variants. |
| `web/settings`, `web/legacy-safe-storage` | Direct synchronous prepared writes; the latter is boot-time keychain migration. |
| `db/*` read projections and cached `prepared` statements | No awaited transaction can expose partial state. Multi-statement atomic work uses the synchronous helper; lazy iterator stepping is checked too. |

Callers of the repos above include agent dispatch (app/harness/label/read/session/
ticket/worktree/cost verbs, resolution and wire), agent commands/watch, automation
enablement/schedule cursor, blob attach/import/collect/materialize, data IPC,
decision settings/desktop, harness IPC/registry, installation identity, MCP
settings/verbs, notification/observability/process settings, project relink,
PTY launch/manager/scope, session listing/location/model preferences/resumptions,
session/ticket wake, theme IPC, turn attachments, filesystem access, web
credentials, and worktree cleanup/collisions/containers/ensure/read/remove/
retention/scan/setup/state/trim/venue. They keep synchronous repo calls: no
call-site allowlist, async API migration or queue participation is necessary.

Reviewed ledger bodies: Session engine 19; Automation engine 20; cleanup engine
10. Session bodies were already synchronous. Automation/cleanup awaited only
synchronous transaction methods and local helpers; those awaits are removed.
Host execution, destructive filesystem work and pagination yields remain outside
atomic boundaries. No production `getTransactionGate` reference or async ledger
transaction body remains. Deliberately invalid async bodies remain only in
negative tests.

## Sole-owner connections (unchanged)

- Startup: `db/index` pragmas, `db/migrations` transaction/DDL/backfills and
  `user_version`, `db/migration-compaction` VACUUM/checkpoint, then ANALYZE.
  Guard installation follows migrations; existing repo-cache statements are
  wrapped in place. `migrations.ts` is unchanged.
- `db/open-lock` owns a separate lease connection; `database-recovery` owns its
  probe/recovery connections. No async transaction on the runtime handle.
- Backup/restore uses its staged connection for `writeRows`, sequence-table
  deletes, migration and usage rebuild. `backup/data-document` uses a temporary
  in-memory validation connection; integrity/export/digest readers use their
  own read-only connections. Test fixture builders remain sole-owner setup.

## Guard and alternatives

The guard checks exec, pragma, statement run/get/all and iterator next, including
cached statements, plus native transaction entry. Ownership follows the handle's
forwarded property, so instrumentation proxies share the same owner. Tests/dev
roll back and throw on unowned transactions before another command can join;
packaged startup selects logging only, explicitly via `app.isPackaged`, and
keeps row-reader execution native rather than adding per-read instrumentation.

Rejected: individually gating ~160 legacy writes (cooperative and easy to miss),
and synchronous isolated writers alongside awaited transactions (`busy_timeout`
can deadlock the event loop the owner needs). One host/event loop and synchronous
atomic bodies make every independent write autocommit safely. There is no
runtime allowlist or remaining write-path migration to ticket separately.
