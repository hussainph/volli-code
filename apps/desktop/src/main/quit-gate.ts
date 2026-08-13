/**
 * The quit decision: whether ⌘Q is allowed to destroy work, and how a refusal
 * survives the listeners behind it.
 *
 * Two facts drive everything here.
 *
 * **Main cannot ask the renderer.** `before-quit` needs a SYNCHRONOUS verdict to
 * `preventDefault` against, and by the time it fires the renderer may already be
 * tearing down — the same reason the terminal gate answers from
 * `PtyManager.busySessions()` rather than from a round trip. So the renderer
 * pushes the names of the documents holding unsaved drafts whenever that set
 * changes, and this module answers from the last report it received.
 *
 * **Electron runs every `before-quit` listener even after one preventDefaults.**
 * A gate that cancels a quit therefore cannot stop the listeners registered
 * behind it — including the native-Session shutdown, which ends in `app.exit(0)`.
 * Before {@link refuseQuit} existed, answering "Cancel" to the busy-terminal
 * confirm delayed the quit by one teardown and then killed the process anyway,
 * taking the work the user had just chosen to keep. Every gate records its
 * refusal here; the shutdown listener consumes it and stands down.
 */

import type { UnsavedDocumentsReport } from "@volli/shared";

/** How many names the confirm spells out before it starts counting instead. */
const MAX_NAMED_FILES = 4;

/**
 * The renderer's last word on unsaved work. Starts empty: a renderer that has
 * not reported yet has not opened an editor either, so there is nothing to lose.
 */
let unsavedNames: readonly string[] = [];

/**
 * The quit events some gate has refused.
 *
 * Keyed on the event rather than held as a bare flag because Electron hands the
 * SAME event object to every `before-quit` listener in one attempt and a fresh
 * one to the next: the refusal is then scoped to exactly one quit by
 * construction, with no latch for a listener to forget to clear — and forgetting
 * would silently swallow the next quit the user actually meant. Weak, so a
 * refused event is collectable the moment Electron drops it.
 */
const refusedQuits = new WeakSet<object>();

/**
 * Accepts one renderer report.
 *
 * Validated rather than trusted: this arrives over a `send` channel and a
 * malformed payload must not be able to read as "nothing is unsaved" and let a
 * quit through. A report that does not typecheck at runtime leaves the previous
 * one standing, which fails toward asking the user.
 */
export function recordUnsavedDocuments(report: UnsavedDocumentsReport): void {
  const names: unknown = (report as { names?: unknown } | undefined)?.names;
  if (!Array.isArray(names) || names.some((name) => typeof name !== "string")) return;
  unsavedNames = names as readonly string[];
}

/** The documents the renderer last reported as holding unsaved drafts. */
export function unsavedDocumentNames(): readonly string[] {
  return unsavedNames;
}

/** What a quit request should do about the unsaved work main knows about. */
export type UnsavedQuitStep = "quit" | "confirm";

/**
 * `VOLLI_SKIP_CLOSE_CONFIRM=1` answers "proceed" without a dialog — the same
 * automation seam the terminal gate uses, and for the same reason: the e2e
 * smokes deliberately leave editors dirty and have no way to answer a native
 * modal, so a mid-run quit would otherwise hang teardown forever.
 */
export function planUnsavedQuit(input: {
  names: readonly string[];
  skipConfirm: boolean;
}): UnsavedQuitStep {
  if (input.names.length === 0 || input.skipConfirm) return "quit";
  return "confirm";
}

/** The dialog's detail line: what is about to be lost, named while that stays readable. */
export function quitConfirmDetail(names: readonly string[]): string {
  if (names.length === 1) {
    return `${names[0]} has unsaved changes. Quitting will discard them.`;
  }
  const shown = names.slice(0, MAX_NAMED_FILES).join(", ");
  const remaining = names.length - MAX_NAMED_FILES;
  const list = remaining > 0 ? `${shown}, and ${remaining} more` : shown;
  return `${names.length} files have unsaved changes (${list}). Quitting will discard them.`;
}

/**
 * Cancels this quit and records the refusal so the listeners behind it stand
 * down. Takes the event rather than reaching for Electron's `app`, so the whole
 * gate can be tested without a live Electron.
 */
export function refuseQuit(event: { preventDefault(): void }): void {
  event.preventDefault();
  refusedQuits.add(event);
}

/**
 * Whether a gate ahead of this one already refused this quit.
 *
 * Every listener behind a refusal has to check: a `preventDefault` does not stop
 * the ones registered after it, so they would otherwise carry on tearing down —
 * and one of them ends in `app.exit(0)` — over an answer the user has given. A
 * gate that sees `true` also stands down without asking anything of its own,
 * rather than stacking a second modal on that answer.
 */
export function quitAlreadyRefused(event: object): boolean {
  return refusedQuits.has(event);
}
