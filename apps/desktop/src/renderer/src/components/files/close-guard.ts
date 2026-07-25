/**
 * The decision half of the Project Files dirty-close guard, kept pure so the
 * one rule that matters — a tab with unsaved work is never closed without the
 * user saying so, and NEVER over a failed write — is stated once and tested,
 * rather than living inside dialog callbacks.
 *
 * The React half (components/pages/files-page.tsx) only performs what these
 * return: prompt or don't, then close or don't.
 */

/** What closing a tab requires right now. */
export type TabCloseStep = "close" | "confirm";

/** How the user answered the guard, plus whether a chosen save actually landed. */
export type TabCloseResolution =
  | { choice: "cancel" }
  | { choice: "discard" }
  | { choice: "save"; saved: boolean };

/** What to do with the tab once the guard resolves. */
export type TabCloseOutcome = "close" | "keep-open";

/** A clean tab closes immediately; a dirty one has to be asked about first. */
export function planTabClose(input: { dirty: boolean }): TabCloseStep {
  return input.dirty ? "confirm" : "close";
}

/**
 * Cancel is a full no-op (nothing saved, nothing discarded, tab stays). Discard
 * closes — the user chose to drop the draft. Save closes only when the write
 * actually landed: a failed write leaves the draft as the only copy of that
 * work, so the close is aborted and the failure surfaces as a toast.
 */
export function resolveTabClose(resolution: TabCloseResolution): TabCloseOutcome {
  switch (resolution.choice) {
    case "cancel":
      return "keep-open";
    case "discard":
      return "close";
    case "save":
      return resolution.saved ? "close" : "keep-open";
  }
}

/**
 * Splits a "Close Others" request into the tabs that can go right now and the
 * dirty ones that each need their own guard. Confirmations are returned in
 * strip order so the prompts walk the strip left-to-right rather than in
 * whatever order a Set iterates.
 */
export function planCloseOthers(input: {
  relPaths: readonly string[];
  keep: string;
  isDirty(relPath: string): boolean;
}): { close: string[]; confirm: string[] } {
  const close: string[] = [];
  const confirm: string[] = [];
  for (const relPath of input.relPaths) {
    if (relPath === input.keep) continue;
    if (input.isDirty(relPath)) confirm.push(relPath);
    else close.push(relPath);
  }
  return { close, confirm };
}
