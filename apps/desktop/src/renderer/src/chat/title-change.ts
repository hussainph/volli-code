/** Ephemeral input provenance, never part of the durable Session title. */
import { create } from "zustand";

const useTitleChanges = create<{ automatic: Readonly<Record<string, string>> }>(() => ({
  automatic: {},
}));

/** Only the automatic rename owner may opt a particular replacement into motion. */
export function recordTitleChange(sessionId: string, title: string, automatic: boolean): void {
  useTitleChanges.setState((state) => {
    const next = { ...state.automatic };
    if (automatic) next[sessionId] = title;
    else delete next[sessionId];
    return { automatic: next };
  });
}

/** Unattributed stream/CLI changes and manual renames are always immediate. */
export function useAutomaticTitleChange(sessionId: string | null, title: string): boolean {
  return useTitleChanges((state) => sessionId !== null && state.automatic[sessionId] === title);
}
