import type {
  BrowserIpcChannel,
  BrowserTabIdInput,
  BrowserTabListInput,
  BrowserTabNavigateInput,
  BrowserTabOpenInput,
  BrowserTabSetBoundsInput,
  Result,
} from "../../ipc/contract";
import { BROWSER_IPC } from "../ipc-descriptors";
import { registerGuardedIpcHandlers } from "../ipc-registry";
import type { IpcHandlerTable } from "../ipc-registry";
import type { BrowserTabHost } from "./tab-host";

/**
 * Registers the Browser workspace's guarded renderer command surface against
 * the one main-process host. Renderer opens are stamped `user` here rather than
 * accepting provenance over IPC; Session-created tabs enter through the host's
 * separate runtime port.
 *
 * This is intentionally host IPC rather than a new durable domain API under
 * docs/BOUNDARIES.md #5: Browser Tabs are ephemeral machine resources like PTY
 * planes, and bounds/show/hide are Electron-window placement commands. No
 * Browser command writes product history or an id a future host must reconcile.
 *
 * `capture` is the one channel here that READS page content rather than placing
 * a window, so it does not inherit that argument for free. It keeps it for a
 * different reason: pixels are a capability of the HOST that owns the native
 * view, not of the client that draws beside it. A Browser Tab is an agent
 * surface first and a viewing surface second — a Session reaching a page
 * through the Browser port needs its pixels wherever that page is hosted, and
 * this renderer's overlay freeze is simply the first consumer of the same read.
 * So the frame belongs on the host's API when a host becomes a server, and
 * nothing here assumes the client shares its machine.
 */
export function registerBrowserTabIpcHandlers(host: BrowserTabHost): void {
  const handlers: IpcHandlerTable<BrowserIpcChannel> = {
    "volli:browser-open": (input: BrowserTabOpenInput) => ({
      ok: true,
      tab: host.open({
        ...input,
        ticketId: input.ticketId ?? null,
        createdBy: "user",
      }),
    }),
    "volli:browser-close": (input: BrowserTabIdInput): Result => {
      host.close(input.tabId);
      return { ok: true };
    },
    "volli:browser-list": (input: BrowserTabListInput) => ({
      ok: true,
      tabs: host.list(input),
    }),
    "volli:browser-navigate": (input: BrowserTabNavigateInput) => ({
      ok: true,
      tab: host.navigate(input.tabId, input.url),
    }),
    "volli:browser-back": (input: BrowserTabIdInput) => ({
      ok: true,
      tab: host.back(input.tabId),
    }),
    "volli:browser-forward": (input: BrowserTabIdInput) => ({
      ok: true,
      tab: host.forward(input.tabId),
    }),
    "volli:browser-reload": (input: BrowserTabIdInput) => ({
      ok: true,
      tab: host.reload(input.tabId),
    }),
    "volli:browser-set-bounds": (input: BrowserTabSetBoundsInput): Result => {
      host.setBounds(input.tabId, input.bounds);
      return { ok: true };
    },
    "volli:browser-capture": async (input: BrowserTabIdInput) => ({
      ok: true,
      frames: await host.capture(input.tabId),
    }),
    "volli:browser-show": (input: BrowserTabIdInput): Result => {
      host.show(input.tabId);
      return { ok: true };
    },
    "volli:browser-hide": (input: BrowserTabIdInput): Result => {
      host.hide(input.tabId);
      return { ok: true };
    },
    "volli:browser-toggle-devtools": (input: BrowserTabIdInput): Result => {
      host.toggleDevTools(input.tabId);
      return { ok: true };
    },
    // The person's hold controls (VC-239). Each is an explicit press on the
    // chrome pill or the cursor's label; nothing here is inferred from input
    // into the page. What the displaced or asked Session is TOLD is not this
    // handler's business — the host emits a hold event and index.ts relays it
    // in-band, so the notice reaches the Session whichever door moved the hold.
    "volli:browser-take-over": (input: BrowserTabIdInput) => ({
      ok: true,
      tab: host.takeOver(input.tabId).tab,
    }),
    "volli:browser-hand-back": (input: BrowserTabIdInput) => ({
      ok: true,
      tab: host.handBack(input.tabId),
    }),
    "volli:browser-ask-to-leave": (input: BrowserTabIdInput): Result => {
      host.askToLeave(input.tabId);
      return { ok: true };
    },
  };

  registerGuardedIpcHandlers(BROWSER_IPC, handlers);
}
