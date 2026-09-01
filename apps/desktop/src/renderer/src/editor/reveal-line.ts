/**
 * "Open that file AT that line" — the seam between a search result and the
 * Monaco view that eventually shows it (VC-193, plan §4.7).
 *
 * WHY IT IS NOT A PROP. Clicking a match asks for two things at once: put this
 * file in front, and land on line 412. The first is a store action that already
 * exists (`previewHomeFile` / `previewTicketFile`). The second has no store to
 * live in — a caret position is not durable workspace state, it is a one-shot
 * instruction to whichever editor is about to mount. Threading it as a prop
 * would mean parking a line number in the workspace store, persisting it to
 * disk with the rest of the tab record, and then remembering to clear it so the
 * tab does not jump again the next time it is opened.
 *
 * So it is a request with a single pending slot, consumed once by whoever gets
 * there first — module state, for the reason `go-to-line.ts` keeps its tracked
 * editor in module state: nothing renders from it.
 *
 * THE RACE IS THE POINT. A click can land in either order:
 *
 *  - the file is not open — the tab mounts, Monaco loads asynchronously, and
 *    the editor consumes the pending request when it is finally ready;
 *  - the file is already open — no mount happens at all, so the live editor is
 *    told through {@link onFileReveal} and consumes the same slot.
 *
 * Both paths end in {@link takeFileReveal}, so exactly one of them can act on a
 * request, and a request nobody claims is replaced by the next one rather than
 * accumulating.
 */

/**
 * Where to land: 1-based line and column, Monaco's own numbering (which is why
 * neither is 0-based here), plus how many characters the match runs for.
 *
 * `length` comes from the QUERY, not from the preview string: v1 search is
 * literal, so the matched text is exactly as long as what was typed, while a
 * preview may have been windowed around the match and can under-report it.
 */
export interface RevealTarget {
  readonly line: number;
  readonly column: number;
  readonly length: number;
}

/** The slice of a live Monaco editor a reveal needs. */
export interface RevealableEditor {
  revealLineInCenter(line: number): void;
  setSelection(range: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  }): void;
}

/**
 * Which open document a reveal is for.
 *
 * The REQUEST context, not the resolved one: the caller is a search result and
 * knows the pair it searched under, while `DocumentIdentity` is built from the
 * checkout main actually read from. Those agree for every path a search can
 * return (`.volli/**` is gitignored and never searched), and keying on the pair
 * the caller has avoids inventing a second answer to "which document is this".
 */
export function fileRevealKey(input: {
  projectId: string;
  ticketId?: string;
  relPath: string;
}): string {
  return `${input.projectId}:${input.ticketId ?? "main"}:${input.relPath}`;
}

/** The one outstanding request, if any. */
let pending: { key: string; target: RevealTarget } | null = null;

const listeners = new Map<string, Set<() => void>>();

/**
 * Ask for `key` to be revealed at `target`.
 *
 * One slot, latest wins: a person clicking down a result list is asking for the
 * newest one, and an unclaimed older request (a file whose tab they closed
 * before Monaco finished loading) must never surface later as a mysterious jump.
 */
export function requestFileReveal(key: string, target: RevealTarget): void {
  pending = { key, target };
  for (const listener of listeners.get(key) ?? []) listener();
}

/** Claims the pending request for `key`, or `null` when there is none for it. */
export function takeFileReveal(key: string): RevealTarget | null {
  if (pending === null || pending.key !== key) return null;
  const { target } = pending;
  pending = null;
  return target;
}

/** Subscribes a mounted editor to later requests for `key`; the returned call unsubscribes. */
export function onFileReveal(key: string, listener: () => void): () => void {
  const set = listeners.get(key) ?? new Set<() => void>();
  set.add(listener);
  listeners.set(key, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(key);
  };
}

/**
 * Land on the match: centre its line and select the match itself.
 *
 * `revealLineInCenter` rather than `revealLine` because a result opened at the
 * bottom edge of the viewport is a result you have to scroll to read — the
 * plan names this call for that reason.
 *
 * FOCUS IS DELIBERATELY NOT TAKEN. Stepping through matches means clicking the
 * next row, and an editor that stole focus on every click would make the second
 * click a click back into the list. Monaco draws an unfocused selection in its
 * inactive style, which is exactly the right emphasis for "here is the match,
 * the list is still where you are working".
 */
export function applyFileReveal(editor: RevealableEditor, target: RevealTarget): void {
  editor.revealLineInCenter(target.line);
  editor.setSelection({
    startLineNumber: target.line,
    startColumn: target.column,
    endLineNumber: target.line,
    endColumn: target.column + target.length,
  });
}
