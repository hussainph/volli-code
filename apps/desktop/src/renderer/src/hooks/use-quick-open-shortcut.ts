import * as React from "react";

import { isQuickOpenKeyEvent } from "@renderer/lib/quick-open-shortcut";
import { useUiStore } from "@renderer/stores/ui";

/**
 * Other doors onto the ⌘P overlay, registered by the hook below while it is
 * mounted (once, in the chrome band).
 *
 * A set rather than a single slot for the reason every external store in this
 * renderer is one: React may mount the same hook twice in development's double
 * pass, and a slot would leave the first mount's opener behind as a closure
 * over a component that is gone.
 */
const openers = new Set<() => void>();

/**
 * Open quick-open from somewhere that is not the keyboard — an empty pane's
 * "Open file…" row (VC-202).
 *
 * The same door the chord uses, deliberately: quick-open is a window-level
 * surface whose scope is derived from whatever is in front
 * (`quick-open-model.ts`), so a caller has nothing to hand it and nothing to
 * decide. What it opens with lands in the focused pane because opening a file
 * activates its tab, and activation is what assigns a tab to the focused pane.
 */
export function openQuickOpen(): void {
  for (const open of openers) open();
}

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

  // The out-of-band door. OPENS rather than toggles: a control that asked for
  // the file picker while it happened to be open would close it instead.
  React.useEffect(() => {
    const opener = () => setOpen(true);
    openers.add(opener);
    return () => {
      openers.delete(opener);
    };
  }, []);

  return [open, setOpen];
}
