import type { BrowserAppShortcutEvent } from "@volli/shared";

/**
 * The renderer half of the app shortcuts a focused Browser page hands back
 * (VC-301; main's `browser/app-shortcuts.ts` decides which keys those are).
 *
 * Two kinds of answer, and the split is the point:
 *
 *  • A REPLAYED chord (⌘K, ⌘1–⌘9, ⌃⌘ + arrow) is dispatched on `window` as the
 *    keydown it was, so the listener that already owns it decides — with every
 *    guard it already has, the terminal guard on ⌘K included. Nothing here
 *    knows what those chords mean, so nothing here can disagree with them.
 *    The pane drawing the page is focused first: a click into a native page
 *    never reaches the renderer, so the split view's focused pane is whichever
 *    one was last clicked in the app, and ⌃⌘ + arrow has to move from the pane
 *    the person is actually in.
 *  • ⌘W and ⌘L act on the tab the key came FROM, named by main. They go to the
 *    pane that draws that tab, which registered its own close and address bar
 *    below — never to whichever pane the split view calls focused, which can be
 *    a different one. A tab no mounted pane draws does nothing.
 */
export interface BrowserPaneCommands {
  /**
   * Closes this tab through the same path its surface's close control takes.
   * False when the surface gave the pane no close to run.
   */
  close(): boolean;
  /** Puts focus on this tab's address bar. */
  focusAddress(): void;
  /** Makes the split-view pane drawing this tab the focused one. */
  focusPane(): void;
}

const panes = new Map<string, BrowserPaneCommands>();

/**
 * Registers the pane drawing one tab. Returns the unregister, which leaves a
 * later registration for the same tab alone — React may mount a pane twice in
 * development's double pass, and the second mount must keep working after the
 * first one's cleanup.
 */
export function registerBrowserPaneCommands(
  tabId: string,
  commands: BrowserPaneCommands,
): () => void {
  panes.set(tabId, commands);
  return () => {
    if (panes.get(tabId) === commands) panes.delete(tabId);
  };
}

/**
 * Acts on one shortcut main handed back, and says whether the app did
 * anything with it. Main took the key and focus before the renderer could
 * decide, so a `false` is the caller's cue to hand focus back to the page: a
 * replayed chord no listener claimed (`preventDefault` is how every one of
 * them says it acted), or a tab no pane here draws.
 */
export function runBrowserAppShortcut(event: BrowserAppShortcutEvent): boolean {
  const { shortcut } = event;
  const pane = panes.get(event.tabId);
  if (shortcut.kind === "replay") {
    pane?.focusPane();
    return !window.dispatchEvent(
      new KeyboardEvent("keydown", { ...shortcut.chord, bubbles: true, cancelable: true }),
    );
  }
  if (pane === undefined) return false;
  if (shortcut.kind === "close-tab") return pane.close();
  pane.focusAddress();
  return true;
}

/** What the Session RPC client offers {@link followBrowserAppShortcuts}: `browserShortcuts.*`. */
export interface BrowserShortcutsRpc {
  readonly browserShortcuts: {
    readonly subscribe: {
      subscribe(
        input: undefined,
        handlers: {
          onData(event: BrowserAppShortcutEvent): void;
          onError(error: unknown): void;
        },
      ): { unsubscribe(): void };
    };
    readonly focusPage: { mutate(input: { tabId: string }): Promise<unknown> };
  };
}

/** How long a stream that ended in error waits before following again. */
export const BROWSER_SHORTCUTS_RESUBSCRIBE_MS = 1_000;

function defaultTimer(run: () => void, ms: number): () => void {
  const handle = setTimeout(run, ms);
  return () => clearTimeout(handle);
}

/**
 * Follows the desktop-only `browserShortcuts.subscribe` stream for the life of
 * the window, acting on each shortcut and handing focus back to the page for
 * one the app had nothing to do with (`browserShortcuts.focusPage`). Returns
 * the stop.
 *
 * Nothing is toasted if the hand-back fails: nobody asked for it, and the
 * person is left in the app, one click from the page (AGENTS.md's exception
 * for work no one requested). A stream that ended in error (it fell behind,
 * or its source failed) is followed again after a beat: a shortcut is a press,
 * not state, so there is nothing to catch up on.
 */
export function followBrowserAppShortcuts(
  rpc: BrowserShortcutsRpc,
  setTimer: (run: () => void, ms: number) => () => void = defaultTimer,
): () => void {
  let stopped = false;
  let current: { unsubscribe(): void } | null = null;
  let cancelTimer: (() => void) | null = null;
  const open = (): void => {
    current = rpc.browserShortcuts.subscribe.subscribe(undefined, {
      onData: (event) => {
        if (runBrowserAppShortcut(event)) return;
        void rpc.browserShortcuts.focusPage.mutate({ tabId: event.tabId }).catch(() => undefined);
      },
      onError: () => {
        current = null;
        if (stopped) return;
        cancelTimer = setTimer(() => {
          cancelTimer = null;
          open();
        }, BROWSER_SHORTCUTS_RESUBSCRIBE_MS);
      },
    });
  };
  open();
  return () => {
    stopped = true;
    cancelTimer?.();
    current?.unsubscribe();
  };
}
