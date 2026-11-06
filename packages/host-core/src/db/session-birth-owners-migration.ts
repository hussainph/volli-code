/**
 * Migration 069: `session_birth_owners`, each Session's birth owner held where
 * a roster read can reach it without opening its birth event (VC-1097).
 *
 * A base Session row is decoded with one fact `sessions` does not hold — the
 * cloud owner frozen into its first `session.created` event — and the
 * frozen-local and account scope predicates (`local-product.ts`) filter on the
 * same fact. Reading it from the event costs a seek into `session_events` per
 * Session, and that row is the Session's second event, scattered across a
 * 1–2 GB table: a cold first roster read paid one uncached page per Session.
 * This table is a few pages for the whole roster.
 *
 * It is a DERIVED cache, never the source: a row is a promise that the
 * Session has exactly one birth event, whose owner is absent (`NULL`) or a
 * non-empty string equal to `owner_user_id`. Anything else — no birth, two
 * births, an owner of another JSON type — gets NO row, and a reader treats a
 * missing row as "consult the birth fact", which is the pre-069 read exactly.
 * So the table may be incomplete, but it may never be wrong.
 *
 * Triggers keep it, rather than the ledger's code, so the promise holds for
 * every writer: an older build appending to a database that ran this
 * migration (N-1), a backup restore loading events with foreign keys off, the
 * migration export. They hang off `session_event_sequence`, which a trigger
 * on `session_events` already fills with each event's `kind`, so an ordinary
 * append pays one string compare and no JSON parse. Any rewrite
 * of a birth event or its order row drops the Session's row back to unknown.
 * Rows go with their Session (`ON DELETE CASCADE`).
 *
 * Expand-only: older builds never read or write the table, the triggers raise
 * nothing an older write could trip, and `sessions` keeps its shape.
 */

/**
 * The owner a cached row may hold, read off a `session.created` payload:
 * absent, or a non-empty string. A JSON null, a number or an empty string is
 * corruption the codec reports, so it stays uncached and the read that
 * consults the birth fact still reports it.
 */
function cacheableOwner(payload: string): string {
  return `json_type(${payload}, '$.session') = 'object'
       AND (json_type(${payload}, '$.session.ownerUserId') IS NULL
         OR (json_type(${payload}, '$.session.ownerUserId') = 'text'
           AND json_extract(${payload}, '$.session.ownerUserId') <> ''))`;
}

export const SESSION_BIRTH_OWNERS_MIGRATION = `
CREATE TABLE IF NOT EXISTS session_birth_owners (
  session_id    TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  owner_user_id TEXT
) WITHOUT ROWID;

INSERT OR IGNORE INTO session_birth_owners (session_id, owner_user_id)
SELECT birth.session_id, json_extract(event.payload, '$.session.ownerUserId')
  FROM sessions session
  CROSS JOIN session_event_sequence birth
    ON birth.session_id = session.id AND birth.kind = 'session.created'
  JOIN session_events event ON event.id = birth.event_id
 WHERE ${cacheableOwner("event.payload")}
   AND NOT EXISTS (
     SELECT 1 FROM session_event_sequence other
      WHERE other.session_id = birth.session_id
        AND other.kind = 'session.created'
        AND other.sequence <> birth.sequence
   );

CREATE TRIGGER IF NOT EXISTS session_birth_owner_recorded
AFTER INSERT ON session_event_sequence
WHEN NEW.kind = 'session.created'
BEGIN
  DELETE FROM session_birth_owners WHERE session_id = NEW.session_id;
  INSERT INTO session_birth_owners (session_id, owner_user_id)
  SELECT NEW.session_id, json_extract(event.payload, '$.session.ownerUserId')
    FROM session_events event
   WHERE event.id = NEW.event_id
     AND event.session_id = NEW.session_id
     AND ${cacheableOwner("event.payload")}
     AND NOT EXISTS (
       SELECT 1 FROM session_event_sequence other
        WHERE other.session_id = NEW.session_id
          AND other.kind = 'session.created'
          AND other.sequence <> NEW.sequence
     );
END;

CREATE TRIGGER IF NOT EXISTS session_birth_owner_order_updated
AFTER UPDATE ON session_event_sequence
WHEN OLD.kind = 'session.created' OR NEW.kind = 'session.created'
BEGIN
  DELETE FROM session_birth_owners WHERE session_id IN (OLD.session_id, NEW.session_id);
END;

CREATE TRIGGER IF NOT EXISTS session_birth_owner_order_deleted
AFTER DELETE ON session_event_sequence
WHEN OLD.kind = 'session.created'
BEGIN
  DELETE FROM session_birth_owners WHERE session_id = OLD.session_id;
END;

CREATE TRIGGER IF NOT EXISTS session_birth_owner_event_rewritten
AFTER UPDATE OF payload ON session_events
WHEN json_extract(OLD.payload, '$.kind') = 'session.created'
  OR json_extract(NEW.payload, '$.kind') = 'session.created'
BEGIN
  DELETE FROM session_birth_owners WHERE session_id IN (OLD.session_id, NEW.session_id);
END;
`;
