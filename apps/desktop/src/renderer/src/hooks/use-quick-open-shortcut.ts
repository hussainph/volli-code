import * as React from "react";

import { isQuickOpenKeyEvent } from "@renderer/lib/quick-open-shortcut";
import { useUiStore } from "@renderer/stores/ui";

/**
 * Owns the quick-open overlay's open state and its ⌘P toggle shortcut — the
 * ⌘K hook's twin (`use-command-palette-shortcut.ts`), including the terminal
 * guard: a focused terminal needs ⌘P raw for the pty (Ctrl+P's cousin in more
 * than one shell), so the chord is read from the store at press time rather
 * than from a render closure.
 */
export function useQuickOpenShortcut(): [boolean, React.Dispatch<React.SetStateAction<boolean>>] {
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!isQuickOpenKeyEvent(event)) return;
      if (useUiStore.getState().terminalFocusTarget !== null) return;
      event.preventDefault();
      setOpen((current) => !current);
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return [open, setOpen];
}
