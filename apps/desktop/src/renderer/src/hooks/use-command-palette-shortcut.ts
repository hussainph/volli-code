import * as React from "react";

import { isCommandPaletteKeyEvent } from "@renderer/lib/command-palette-shortcut";
import { useUiStore } from "@renderer/stores/ui";

/**
 * Owns the chrome-bar's command-palette open state and its ⌘K toggle
 * shortcut. Suppressed while a terminal has focus (`terminalFocusTarget !==
 * null`) — the terminal needs ⌘K raw for the pty. Reads the guard from the
 * store at press time (not a render closure), so it always reflects the
 * latest focus target without re-subscribing the listener.
 */
export function useCommandPaletteShortcut(): [
  boolean,
  React.Dispatch<React.SetStateAction<boolean>>,
] {
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!isCommandPaletteKeyEvent(event)) return;
      if (useUiStore.getState().terminalFocusTarget !== null) return;
      event.preventDefault();
      setOpen((current) => !current);
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return [open, setOpen];
}
