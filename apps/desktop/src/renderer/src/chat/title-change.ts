/** Ephemeral input provenance, never part of the durable Session title. */
import { useEffect } from "react";
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
  const automatic = useTitleChanges(
    (state) => sessionId !== null && state.automatic[sessionId] === title,
  );
  // Consume this replacement, not this string forever. A later CLI/stream
  // rename back to the same words has no automatic provenance.
  useEffect(() => {
    if (automatic && sessionId !== null) {
      useTitleChanges.setState((state) => {
        if (state.automatic[sessionId] !== title) return state;
        const next = { ...state.automatic };
        delete next[sessionId];
        return { automatic: next };
      });
    }
  }, [automatic, sessionId, title]);
  return automatic;
}
