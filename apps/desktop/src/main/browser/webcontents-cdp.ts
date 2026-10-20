/**
 * The WebContentsView backend's engine wire (VC-561): each tab's CDP transport
 * and its load wait, both answered by the tab's own `webContents`. They are
 * what `BrowserTabHost.transportFor` and `BrowserTabHost.waitForLoad` hand the
 * agent port; the port itself, and everything it decides, is host-core's.
 */
import type { WebContents } from "electron";

import { BrowserRefusal } from "@volli/agent-runtime";
import type { BrowserLoadWaitMode, CdpTransport } from "@volli/host-core/browser";

/**
 * The production CDP wire: one tab's `webContents.debugger`, Electron's
 * app-private protocol client. Attaching here — rather than ever passing
 * `--remote-debugging-port` — is the load-bearing security decision this
 * feature rests on: there is no loopback endpoint, so no other local process
 * can reach this tab or the app's own privileged renderer through one.
 * Attachment is lazy and re-checked per send, because DevTools sharing the
 * target can drop it between calls.
 */
export function debuggerTransport(contents: WebContents): CdpTransport {
  const wire = contents.debugger;
  let initialized = false;
  let disposed = false;
  const assertLive = (): void => {
    if (disposed) throw new Error("The Browser Tab debugger transport was disposed");
  };
  const ensureReady = async (): Promise<void> => {
    assertLive();
    if (initialized && wire.isAttached()) return;
    initialized = false;
    try {
      if (!wire.isAttached()) wire.attach("1.3");
      await wire.sendCommand("Accessibility.enable");
      assertLive();
      await wire.sendCommand("DOM.enable");
      assertLive();
      await wire.sendCommand("Page.enable");
      assertLive();
      initialized = true;
    } catch {
      assertLive();
      throw new BrowserRefusal(
        "browser.debugger-unavailable",
        "Browser control is unavailable while another debugger owns this tab. Close its DevTools and retry.",
      );
    }
  };
  return {
    ensureReady,
    send: async (method, params) => {
      await ensureReady();
      assertLive();
      return wire.sendCommand(method, params);
    },
    dispose: () => {
      // Attachment, not initialization, is what has to be given back. An
      // `ensureReady` that attached and then failed or was withdrawn leaves
      // `initialized` false over a live attachment, and while Chromium's
      // debugger owns the tab the person cannot open their own DevTools on it.
      disposed = true;
      if (!wire.isAttached()) return;
      initialized = false;
      try {
        wire.detach();
      } catch {
        // The target may already be disappearing. Disposal owns no user
        // operation to fail; the WebContents teardown finishes the job.
      }
    },
  };
}

/**
 * The production load-wait: settle when the tab stops loading, when the bound
 * falls, or when the caller withdraws — whichever is first. Resolution, never
 * rejection: a page still loading at the bound is a page a snapshot can
 * honestly describe as it stands, and a withdrawn wait belongs to a turn that
 * is already gone.
 */
export function loadWaiter(
  webContentsOf: (tabId: string) => Pick<WebContents, "isLoading" | "on" | "removeListener">,
  timeoutMs = 10_000,
  navigationGraceMs = 50,
): (tabId: string, signal: AbortSignal, mode?: BrowserLoadWaitMode) => Promise<void> {
  return async (tabId, signal, mode = "current") => {
    const contents = webContentsOf(tabId);
    const loading = contents.isLoading();
    if ((!loading && mode === "current") || signal.aborted) return;
    await new Promise<void>((resolve) => {
      let grace: ReturnType<typeof setTimeout> | undefined;
      const started = (): void => {
        if (grace !== undefined) clearTimeout(grace);
      };
      const finish = (): void => {
        clearTimeout(timer);
        if (grace !== undefined) clearTimeout(grace);
        contents.removeListener("did-start-loading", started);
        contents.removeListener("did-stop-loading", finish);
        contents.removeListener("destroyed", finish);
        contents.removeListener("render-process-gone", finish);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      contents.on("did-start-loading", started);
      contents.on("did-stop-loading", finish);
      contents.on("destroyed", finish);
      contents.on("render-process-gone", finish);
      signal.addEventListener("abort", finish, { once: true });
      // Close BOTH gaps: a load can start or finish during listener install,
      // and a withdrawal can precede its abort listener too.
      if (signal.aborted) finish();
      else if (contents.isLoading()) started();
      else if (loading) finish();
      else if (mode === "possible-navigation") grace = setTimeout(finish, navigationGraceMs);
    });
  };
}
