/**
 * Birth ownership survives backups that deliberately omit runner cursors.
 * Missing owner is legacy/importable; any present owner must match exactly.
 * The event-order sidecar narrows the seek to birth before reading its JSON.
 *
 * This reads the birth fact itself, so it holds on any schema the migration
 * exporter accepts, including a kept snapshot an older build took.
 */
function birthFactOwnerCompatible(idColumn: string, ownerSql?: string): string {
  // Both expressions are source-code SQL, never caller-supplied data.
  const present = "json_type(birth_event.payload, '$.session.ownerUserId') IS NOT NULL";
  const incompatible =
    ownerSql === undefined
      ? present
      : `${present} AND (
    json_type(birth_event.payload, '$.session.ownerUserId') IS NOT 'text'
    OR json_extract(birth_event.payload, '$.session.ownerUserId') IS NOT ${ownerSql})`;
  return `NOT EXISTS (SELECT 1 FROM session_event_sequence birth_order
    JOIN session_events birth_event ON birth_event.id = birth_order.event_id
    WHERE birth_order.session_id = ${idColumn} AND birth_order.kind = 'session.created'
      AND (${incompatible}))`;
}

/**
 * {@link birthFactOwnerCompatible}, answered from `session_birth_owners`
 * (migration 069, VC-1097) whenever that cache holds the Session: a few pages
 * for a whole roster, where the birth event is one scattered `session_events`
 * page per Session. A Session the cache does not hold — a row it declines to
 * vouch for — is answered from the birth fact exactly as before; `coalesce`
 * evaluates that second argument only when the cache has no row.
 *
 * For the live database, which this build has migrated to its head.
 */
export function sessionBirthOwnerCompatible(idColumn: string, ownerSql?: string): string {
  // Both expressions are source-code SQL, never caller-supplied data.
  const cached =
    ownerSql === undefined
      ? "birth_owner.owner_user_id IS NULL"
      : `birth_owner.owner_user_id IS NULL OR birth_owner.owner_user_id IS ${ownerSql}`;
  return `coalesce(
    (SELECT (${cached}) FROM session_birth_owners birth_owner
      WHERE birth_owner.session_id = ${idColumn}),
    ${birthFactOwnerCompatible(idColumn, ownerSql)})`;
}

/** One frozen-local Session discriminator, usable with a row id or a foreign key. */
export function localSessionRow(idColumn: string): string {
  // Column expressions are source-code constants, never caller input.
  return `NOT EXISTS (SELECT 1 FROM session_drain_cursors WHERE session_id = ${idColumn})
    AND ${sessionBirthOwnerCompatible(idColumn)}`;
}

/**
 * Machine-owned cloud identities never enter the frozen local product listing.
 * The migration exporter's discriminator, so its Session form reads the birth
 * fact rather than the cache: an export may read a snapshot taken before
 * migration 069.
 */
export function localProductRow(table: string, kind: "project" | "ticket" | "session"): string {
  // Table names are source-code constants, never caller input.
  return kind === "session"
    ? `NOT EXISTS (SELECT 1 FROM session_drain_cursors WHERE session_id = ${table}.id)
    AND ${birthFactOwnerCompatible(`${table}.id`)}`
    : `NOT EXISTS (SELECT 1 FROM cloud_shadow_rows WHERE kind = '${kind}' AND id = ${table}.id)`;
}
