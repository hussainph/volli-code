/**
 * The words every entry point to the JSON data export uses.
 *
 * It lives here, beside `external-app-ids.ts`, for that file's reason: main
 * (the File menu and the save dialog) and the renderer (Settings → Storage)
 * both say this, and a sentence stated twice is a sentence that drifts. There
 * is no Electron, Node, or DOM dependency here.
 *
 * The copy is the point, not the plumbing. The old label was "Database
 * export" over a dialog promising "every project, ticket, comment, session,
 * label, and setting", which is a description of a BACKUP — and this file has
 * no restore path, carries no attachment bytes, and carries no transcript
 * files. A person reading the old sentence would have believed a rescue was
 * possible from it. `db/backup/` is where a restorable bundle lives; this
 * document stays an inspection and portability export, and says so before the
 * save dialog opens.
 */

/** The action, everywhere it is named without a trailing dialog. */
export const DATA_EXPORT_ACTION_LABEL = "Export data as JSON";

/** The File-menu item — same words, plus the ellipsis that promises a dialog. */
export const DATA_EXPORT_MENU_LABEL = `${DATA_EXPORT_ACTION_LABEL}…`;

/** The confirm dialog's question. */
export const DATA_EXPORT_CONFIRM_TITLE = `${DATA_EXPORT_ACTION_LABEL}?`;

/**
 * What this file is and is not, stated before the export runs — the three
 * facts a person needs in order not to mistake it for a backup: it is
 * partial, it has no restore path, and the two things it silently leaves
 * behind are exactly the ones that would look like data loss later.
 */
export const DATA_EXPORT_LIMITS =
  "This is a limited data export. It cannot be restored. It does not include attachments or transcript files.";

/** What it does carry, kept beside the limits so the sentence above is not the only thing said. */
export const DATA_EXPORT_CONTENTS =
  "The file holds a readable copy of your projects, tickets, comments, sessions, and labels for inspection.";
