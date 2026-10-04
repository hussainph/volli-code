/**
 * VC-550: the Volli Cloud identity tables, named once in
 * `docs/plans/host-identity.md`.
 *
 * EXPAND ONLY. Five new tables, created empty: no existing table is altered, no
 * row is written, and nothing reads them while the `cloud` flag is off. Later
 * tickets write them (VC-562 hostd, VC-575 pairing, VC-580 workers, VC-581
 * leases, VC-591 promotion); the spec is the contract they follow.
 *
 * Two of the tables are about the WORKSPACE and travel with it (moves,
 * replicas, backups): `workspace_epochs` and `checkout_leases`. The other three
 * are about THIS HOST and never leave it. VC-588 will put the two halves in
 * different files, so no foreign key crosses between them: `host_id` and
 * `worker_id` below are plain UUID values, not references.
 *
 * Every statement is `IF NOT EXISTS`, so a lineage re-offered version 58 (a
 * rewound `user_version`, a restore) converges instead of failing.
 */
export const CLOUD_IDENTITY_MIGRATION = `
CREATE TABLE IF NOT EXISTS host_identity (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  host_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_epochs (
  workspace_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  epoch        INTEGER NOT NULL CHECK (epoch >= 1),
  host_id      TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, epoch)
);

CREATE TRIGGER IF NOT EXISTS workspace_epochs_monotonic
BEFORE INSERT ON workspace_epochs
WHEN NEW.epoch <= (SELECT MAX(epoch) FROM workspace_epochs WHERE workspace_id = NEW.workspace_id)
BEGIN
  SELECT RAISE(ABORT, 'workspace epoch must increase');
END;

CREATE TRIGGER IF NOT EXISTS workspace_epochs_append_only
BEFORE UPDATE ON workspace_epochs
BEGIN
  SELECT RAISE(ABORT, 'workspace epochs are append-only');
END;

CREATE TABLE IF NOT EXISTS workers (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('local', 'remote', 'cloud')),
  capabilities TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(capabilities)),
  created_at   INTEGER NOT NULL,
  revoked_at   INTEGER
);

CREATE TABLE IF NOT EXISTS checkout_leases (
  ticket_id       TEXT PRIMARY KEY REFERENCES tickets(id) ON DELETE CASCADE,
  worker_id       TEXT NOT NULL,
  epoch           INTEGER NOT NULL CHECK (epoch >= 1),
  workspace_epoch INTEGER NOT NULL CHECK (workspace_epoch >= 1),
  granted_at      INTEGER NOT NULL,
  renewed_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  released_at     INTEGER
);

CREATE TRIGGER IF NOT EXISTS checkout_leases_fence
BEFORE UPDATE ON checkout_leases
WHEN NEW.ticket_id IS NOT OLD.ticket_id
  OR NEW.epoch < OLD.epoch
  OR NEW.workspace_epoch < OLD.workspace_epoch
  OR (NEW.epoch = OLD.epoch AND (
        NEW.worker_id IS NOT OLD.worker_id
     OR NEW.workspace_epoch IS NOT OLD.workspace_epoch
     OR NEW.granted_at IS NOT OLD.granted_at
     OR (OLD.released_at IS NOT NULL AND NEW.released_at IS NOT OLD.released_at)))
BEGIN
  SELECT RAISE(ABORT, 'checkout lease: a new grant must raise the epoch');
END;

CREATE TABLE IF NOT EXISTS devices (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
`;
