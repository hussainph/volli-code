/** File-system listing entries, as surfaced to the folder-picker/browser UI. */

export interface DirEntry {
  name: string;
  /** A symlink is typed `file` whatever it points at, so a walk never descends through one. */
  kind: "dir" | "file";
  /**
   * Set only when the entry is itself a symlink. File reads refuse a symlink
   * outright (`Path is a symlink`), so a surface that offers to open an entry
   * needs to know before it offers.
   */
  link?: true;
}

/**
 * Sort order for directory listings: directories before files; within the
 * same kind, case-insensitive name ascending; ties on the lowercased name
 * fall back to raw string comparison so the order is deterministic
 * regardless of input order. Use directly as `entries.sort(compareDirEntries)`.
 */
export function compareDirEntries(a: DirEntry, b: DirEntry): number {
  if (a.kind !== b.kind) {
    return a.kind === "dir" ? -1 : 1;
  }
  const aLower = a.name.toLowerCase();
  const bLower = b.name.toLowerCase();
  if (aLower !== bLower) {
    return aLower < bLower ? -1 : 1;
  }
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}
