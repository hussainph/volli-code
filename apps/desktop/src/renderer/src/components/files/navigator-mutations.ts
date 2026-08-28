/**
 * What a navigator's inline field is allowed to mean (VC-191, plan §4.5).
 *
 * The create/rename/duplicate/delete verbs live in main, behind two layers of
 * path safety that answer in fs terms — "Invalid file path" is the correct
 * refusal for a channel and the wrong sentence for someone who just typed a
 * name into a row. This module is the renderer's half: it turns what was typed
 * into the project-relative path main will be asked for, or into the reason it
 * cannot be one, BEFORE any IPC leaves the window. Pure, so the rules are
 * tested rather than trusted.
 *
 * THE ONE ASYMMETRY, and it is deliberate: a NEW name may contain slashes and a
 * RENAME may not. Typing `components/thing.tsx` into New File is how every
 * editor lets you make a folder and a file in one gesture, and main creates the
 * missing parents. Typing a slash into a rename would silently MOVE the file
 * somewhere else — a different act, from a field that says "rename", with no
 * folder on screen to show where it went.
 */
import { baseNameOf, dirNameOf, isSafeRelPath } from "@volli/shared";

/** What a navigator row is, for the actions that read differently on each. */
export type NavigatorEntryKind = "file" | "directory";

/** The path a committed edit targets, or the sentence explaining why there is none. */
export type NavigatorPathResult = { ok: true; relPath: string } | { ok: false; error: string };

/** The inline field a navigator has open, if any. */
export type NavigatorEdit =
  /** Nothing is being typed. */
  | { kind: "none" }
  /** A new entry in the folder on screen, not yet named. */
  | { kind: "draft"; entry: NavigatorEntryKind }
  /** An existing row, being renamed in place. */
  | { kind: "rename"; relPath: string };

/** The one value of {@link NavigatorEdit} that is nothing — shared so it keeps its identity. */
export const NO_NAVIGATOR_EDIT: NavigatorEdit = { kind: "none" };

/**
 * The path a New File… / New Folder… commit names: what was typed, joined onto
 * the folder the navigator is standing in. Nested names are allowed (main makes
 * the missing parents); a backslash is not, because it is a path separator
 * somewhere else and a literal character here, and neither reading is what the
 * person meant.
 */
export function navigatorCreatePath(cwd: string, rawName: string): NavigatorPathResult {
  const name = rawName.trim();
  if (name.length === 0) return { ok: false, error: "Enter a name" };
  if (name.includes("\\")) return { ok: false, error: "A name cannot contain a backslash" };
  const relPath = cwd === "" ? name : `${cwd}/${name}`;
  if (!isSafeRelPath(relPath)) return { ok: false, error: `"${name}" cannot be used as a name` };
  return { ok: true, relPath };
}

/**
 * The path an inline rename commits to: what was typed, in the file's OWN
 * folder. See THE ONE ASYMMETRY — a separator here is refused rather than
 * quietly turning a rename into a move.
 */
export function navigatorRenamePath(relPath: string, rawName: string): NavigatorPathResult {
  const name = rawName.trim();
  if (name.length === 0) return { ok: false, error: "Enter a name" };
  if (name.includes("/") || name.includes("\\")) {
    return { ok: false, error: "A new name cannot contain a slash" };
  }
  const parent = dirNameOf(relPath);
  const renamed = parent === "" ? name : `${parent}/${name}`;
  if (!isSafeRelPath(renamed)) return { ok: false, error: `"${name}" cannot be used as a name` };
  return { ok: true, relPath: renamed };
}

/**
 * Why a rename did not happen: the document is dirty (plan §4.5's v1 rule).
 *
 * Document identity keys on relPath, so renaming under an open buffer would
 * strand the draft against a path that no longer exists — the editor would go
 * on autosaving or offering ⌘S into thin air. Refusing is cheap and honest, and
 * the sentence has to say what to DO about it, because "cannot rename" alone
 * reads as a bug rather than as a step out of order.
 */
export function unsavedRenameRefusal(relPath: string): string {
  return `Save ${baseNameOf(relPath)} before renaming it — it has unsaved changes.`;
}
