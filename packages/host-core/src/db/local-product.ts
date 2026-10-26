/**
 * Birth ownership survives backups that deliberately omit runner cursors.
 * Missing owner is legacy/importable; any present owner must match exactly.
 * The event-order sidecar narrows the seek to birth before reading its JSON.
 */
export function sessionBirthOwnerCompatible(idColumn: string, ownerSql?: string): string {
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

/** One frozen-local Session discriminator, usable with a row id or a foreign key. */
export function localSessionRow(idColumn: string): string {
  // Column expressions are source-code constants, never caller input.
  return `NOT EXISTS (SELECT 1 FROM session_drain_cursors WHERE session_id = ${idColumn})
    AND ${sessionBirthOwnerCompatible(idColumn)}`;
}

/** Machine-owned cloud identities never enter the frozen local product listing. */
export function localProductRow(table: string, kind: "project" | "ticket" | "session"): string {
  // Table names are source-code constants, never caller input.
  return kind === "session"
    ? localSessionRow(`${table}.id`)
    : `NOT EXISTS (SELECT 1 FROM cloud_shadow_rows WHERE kind = '${kind}' AND id = ${table}.id)`;
}
