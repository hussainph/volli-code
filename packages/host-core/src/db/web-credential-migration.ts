/**
 * Migration 059 (VC-643): step E of the web search keys' move into the sealed
 * credential store (`docs/plans/sealed-credential-store.md` §4, "E — expand,
 * compatible with the legacy writer").
 *
 * EXPAND ONLY, and `raisesMinReader` stays off: `secrets` keeps every row and
 * stays the one source of truth. Two new tables and three triggers:
 *
 * - `web_credential_source`: one row, a random lineage id and a monotonic
 *   revision. The three triggers on `secrets` advance the revision on every
 *   insert, update and delete, clears included, from whichever build wrote:
 *   an older build that knows nothing about this migration still advances it,
 *   because the trigger, not the writer, does the counting. No timestamp is
 *   used to tell what changed (an older build's clock can be anything), and
 *   nothing about a key's value, length or hash is kept here.
 * - `web_credential_mirror`: one row, the receipt of the last sealed mirror a
 *   newer build verified (the lineage and revision it copied, the sealed
 *   inventory's id and commit generation). Status only: nothing reads a key
 *   from it, and an absent or stale row only means "reseal from `secrets`".
 *
 * Every older write still satisfies this: the triggers only update a row
 * older builds never read, so their saves, clears and backups run as before.
 * Both tables are expendable and excluded from backup bundles: a restore
 * migrates a fresh database, whose seed row is a new lineage at revision 0,
 * so nothing a mirror sealed for the old database can be taken for current.
 * The newer build heals on every boot by reconciling the mirror from
 * `secrets` (`web/credential-mirror.ts`), not from anything this migration
 * backfilled.
 *
 * Every statement is `IF NOT EXISTS` / `OR IGNORE`, so a lineage re-offered
 * version 59 converges instead of failing.
 */
export const WEB_CREDENTIAL_SOURCE_MIGRATION = `
CREATE TABLE IF NOT EXISTS web_credential_source (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  source_id TEXT NOT NULL,
  revision  INTEGER NOT NULL CHECK (revision >= 0)
);

INSERT OR IGNORE INTO web_credential_source (id, source_id, revision)
  VALUES (1, lower(hex(randomblob(16))), 0);

CREATE TRIGGER IF NOT EXISTS secrets_source_revision_insert
AFTER INSERT ON secrets
BEGIN
  UPDATE web_credential_source SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS secrets_source_revision_update
AFTER UPDATE ON secrets
BEGIN
  UPDATE web_credential_source SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS secrets_source_revision_delete
AFTER DELETE ON secrets
BEGIN
  UPDATE web_credential_source SET revision = revision + 1 WHERE id = 1;
END;

CREATE TABLE IF NOT EXISTS web_credential_mirror (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  source_id       TEXT NOT NULL,
  source_revision INTEGER NOT NULL CHECK (source_revision >= 0),
  inventory_id    TEXT,
  generation      INTEGER CHECK (generation IS NULL OR generation >= 1)
);
`;
