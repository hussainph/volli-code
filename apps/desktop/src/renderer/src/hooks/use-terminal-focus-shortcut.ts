import * as React from "react";

import { readTerminalFocusChrome } from "@renderer/hooks/use-terminal-focus-target";
import {
  isTerminalFocusKeyEvent,
  terminalFocusTargetForChrome,
} from "@renderer/lib/terminal-focus";
import { useUiStore } from "@renderer/stores/ui";

/**
 * ⌥⌘Return toggles terminal focus in both directions — the keyboard twin of two
 * buttons now, the pane's own corner control (enter) and the band's persistent
 * Exit. It stays mounted from `chrome-bar.tsx` because the band is the one
 * component alive on every page: the enter control comes and goes with the pane
 * it sits on, and a chord hosted by a component that unmounts is a chord that
 * stops working exactly where it is hardest to notice.
 *
 * CAPTURE phase, and it stops the event dead. Both halves are load-bearing:
 *
 *  • Exiting has to work while a PTY holds keyboard focus, which is the one
 *    state where a bubble-phase window listener is at the mercy of whatever the
 *    terminal host does with the key first. (⌘ chords do reach the app today —
 *    `optionAsAltSequence` bails on `metaKey` — but "today" is not a contract.)
 *  • The chord is swallowed even when nothing can be focused, exactly as ⌥⌘B is.
 *    Falling through would hand ⌥⌘Return to the nearest composer, whose submit
 *    guard reads `event.key === "Enter" && (event.metaKey || event.ctrlKey)` and
 *    does not exclude Option — so the chord would silently SEND A MESSAGE on
 *    precisely the screens where it cannot mean terminal focus. A chord that
 *    means two unrelated things depending on what is on screen is a chord you
 *    have to look up before pressing.
 *
 * Stores are read at press time rather than from a render closure, so the chord
 * resolves against the chrome as it is when the key goes down — and through the
 * same derivation the pane's control subscribes to
 * (`hooks/use-terminal-focus-target.ts`), so button and chord cannot disagree.
 */
export function useTerminalFocusShortcut(): void {
  React.useEffect(() => {
    const onKeyDownCapture = (event: KeyboardEvent) => {
      if (!isTerminalFocusKeyEvent(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();

      const { terminalFocusTarget, setTerminalFocusTarget } = useUiStore.getState();
      // Exiting needs no gate: the store's own invariants already keep the
      // target naming a tab of the ticket that is open.
      if (terminalFocusTarget !== null) {
        setTerminalFocusTarget(null);
        return;
      }
      const target = terminalFocusTargetForChrome(readTerminalFocusChrome());
      if (target === null) return;
      setTerminalFocusTarget(target);
    };

    window.addEventListener("keydown", onKeyDownCapture, true);
    return () => window.removeEventListener("keydown", onKeyDownCapture, true);
  }, []);
}
