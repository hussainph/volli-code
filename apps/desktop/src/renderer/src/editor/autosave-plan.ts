/**
 * When a debounced autosave is actually allowed to write.
 *
 * Autosave is the document surfaces' save contract (CONCEPT #49): the ticket
 * body and Markdown Artifacts have no ⌘S ritual, they just persist ~1.5s after
 * the last keystroke. Today that decision is spread across two components —
 * `ticket-body-editor.tsx` (baseline in a ref, conflict pauses the debouncer)
 * and `file-view.tsx`'s autosave half (same debounce, mtime-guarded write) —
 * as a chain of early `return`s inside a callback, which is exactly the shape
 * that cannot be tested without mounting a React tree. Renderer tests here run
 * in Node with no DOM, so the rule moves out here instead.
 *
 * It is deliberately neutral about WHERE the bytes go. Both surfaces reach the
 * same four conclusions from the same four facts; only the write differs (a
 * `updateTicket({ body })` versus an `expectedMtime`-guarded file write), and
 * that stays with the surface that owns the transport.
 *
 * The mirror of `planExplicitSave` in `monaco-file-editor.tsx`, on
 * purpose: two save contracts, one idiom, so a reader who has met one already
 * knows how to read the other.
 */

/**
 * Shared source of truth for the debounce both document surfaces autosave on
 * (milliseconds). Surfaces still carry a local `1500` literal until PR 127
 * imports this constant; do not invent a second value elsewhere.
 */
export const AUTOSAVE_IDLE_MS = 1500;

/** What a fired autosave should actually do, given the document's condition. */
export type AutosaveAction = "save" | "skip-clean" | "skip-conflicted" | "skip-in-flight";

export interface AutosavePlanInput {
  /** The editor's current text. */
  readonly value: string;
  /** The text last written through or adopted — the clean baseline. */
  readonly baseline: string;
  /**
   * True once the document has been found to have changed underneath an unsaved
   * draft (an agent edit, another view, a drifted mtime). Autosave stays paused
   * until the user resolves it, because the surfaces keep BOTH versions and a
   * background write would silently pick one.
   */
  readonly conflicted: boolean;
  /** True while this surface's previous write is still on its way. */
  readonly writing: boolean;
}

/**
 * The four conclusions, in precedence order:
 *
 *  - `skip-conflicted` outranks everything. It is the only state where writing
 *    would destroy something the user cannot get back, so it is answered before
 *    the cheaper questions — including before "is it even dirty?", so a caller
 *    surfacing the reason never says "nothing to save" about a paused document.
 *  - `skip-in-flight` coalesces instead of queueing: the next debounce cycle
 *    will re-ask with a settled baseline, whereas a queued second write would
 *    race the first one's baseline update.
 *  - `skip-clean` protects the mtime/record: writing identical bytes looks like
 *    an external change to every other view of the same document.
 */
export function planAutosave(input: AutosavePlanInput): AutosaveAction {
  if (input.conflicted) return "skip-conflicted";
  if (input.writing) return "skip-in-flight";
  if (input.value === input.baseline) return "skip-clean";
  return "save";
}
