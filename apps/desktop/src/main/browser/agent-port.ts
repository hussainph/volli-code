/**
 * The desktop's answer to {@link RuntimeBrowserPort}: one Session's Browser
 * capability, composed from the BrowserTabHost's registry and a per-tab CDP
 * controller, scoped before anything else happens.
 *
 * Scope is the whole of the visibility policy this slice carries: a Session
 * sees the person's own tabs (duosync — "look at what I'm reading" needs the
 * agent to reach the tab the person named) and the agent tabs of its OWN
 * Ticket, and nothing another Ticket's Session opened. An out-of-scope tab
 * refuses as `browser.unknown-tab` — unknown rather than forbidden, because a
 * tab this Session cannot touch is a tab it was never shown, and a refusal
 * that says "exists, but not yours" is a listing of somebody else's work.
 *
 * Generations bridge the two owners: the host counts navigations off the
 * webContents' own events (a person navigating a shared tab included), and
 * every port call re-syncs the controller to the host's count before acting,
 * so a ref minted before anyone — model or person — moved the page refuses
 * rather than clicks what now sits at those coordinates.
 *
 * Everything here throws {@link BrowserRefusal} for judged outcomes and plain
 * errors for broken plumbing; the runtime's tools translate the former into
 * readable text and let the latter fail the call, exactly as the web ports do.
 */

import type { WebContents } from "electron";

import { BrowserRefusal } from "@volli/agent-runtime";
import type {
  RuntimeBrowserNavigation,
  RuntimeBrowserPort,
  RuntimeBrowserSnapshot,
} from "@volli/shared";

import type { BrowserTabState } from "../../ipc/contract";
import type { BrowserTabCreateOptions } from "./tab-host";
import { isAllowedBrowserUrl } from "./tab-host";
import { BrowserTabController, type CdpTransport } from "./cdp-controller";

/**
 * What the port asks of the host — the registry and navigation surface, as a
 * structural subset of BrowserTabHost so tests can answer it with a plain
 * record and production hands the host itself.
 */
export interface AgentBrowserHost {
  list(scope: { projectId: string; ticketId?: string }): BrowserTabState[];
  open(input: BrowserTabCreateOptions): BrowserTabState;
  navigate(tabId: string, url: string): BrowserTabState;
  back(tabId: string): BrowserTabState;
  forward(tabId: string): BrowserTabState;
  reload(tabId: string): BrowserTabState;
}

export interface AgentBrowserPortOptions {
  host: AgentBrowserHost;
  /** The Session's product scope, fixed at attachment and never the model's to name. */
  scope: { projectId: string; ticketId: string | null };
  /** The CDP wire for one live tab — production binds `webContents.debugger`. */
  transportFor: (tabId: string) => CdpTransport;
  /** Resolves when the tab has settled enough to read; must honour the signal. */
  waitForLoad: (tabId: string, signal: AbortSignal) => Promise<void>;
}

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
  const attached = (): void => {
    if (!wire.isAttached()) wire.attach("1.3");
  };
  return {
    send: async (method, params) => {
      attached();
      return wire.sendCommand(method, params);
    },
    onEvent: (listener) => {
      attached();
      const handler = (_event: unknown, method: string, params: unknown): void =>
        listener(method, params);
      wire.on("message", handler);
      return () => wire.removeListener("message", handler);
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
): (tabId: string, signal: AbortSignal) => Promise<void> {
  return async (tabId, signal) => {
    const contents = webContentsOf(tabId);
    if (!contents.isLoading() || signal.aborted) return;
    await new Promise<void>((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        contents.removeListener("did-stop-loading", finish);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      contents.on("did-stop-loading", finish);
      signal.addEventListener("abort", finish, { once: true });
    });
  };
}

export function createAgentBrowserPort(options: AgentBrowserPortOptions): RuntimeBrowserPort {
  const controllers = new Map<string, BrowserTabController>();

  /** The Session's visible slice of the registry, by the scope rule above. */
  const visible = (): BrowserTabState[] =>
    options.host
      .list({ projectId: options.scope.projectId })
      .filter((tab) => tab.createdBy === "user" || tab.ticketId === options.scope.ticketId);

  const resolve = (tabId: string): BrowserTabState => {
    const tab = visible().find((candidate) => candidate.tabId === tabId);
    if (tab === undefined) {
      controllers.delete(tabId);
      throw new BrowserRefusal(
        "browser.unknown-tab",
        `No Browser Tab ${JSON.stringify(tabId)} is open to this Session: list tabs with browser_tabs, or open one with browser_navigate.`,
      );
    }
    return tab;
  };

  /** The tab's controller, attached and generation-synced to the host's count. */
  const controllerFor = async (tab: BrowserTabState): Promise<BrowserTabController> => {
    let controller = controllers.get(tab.tabId);
    if (controller === undefined) {
      controller = new BrowserTabController(options.transportFor(tab.tabId));
      controllers.set(tab.tabId, controller);
      await controller.enable();
    }
    controller.syncGeneration(tab.generation);
    return controller;
  };

  const snapshotOf = async (
    tabId: string,
    signal: AbortSignal,
  ): Promise<RuntimeBrowserSnapshot> => {
    await options.waitForLoad(tabId, signal);
    const tab = resolve(tabId);
    const controller = await controllerFor(tab);
    const printed = await controller.snapshot();
    return {
      tabId: tab.tabId,
      url: tab.url,
      title: tab.title,
      snapshotText: printed.text,
      generation: printed.generation,
      truncated: printed.truncated,
    };
  };

  const steer = (tabId: string | undefined, navigation: RuntimeBrowserNavigation): string => {
    if (navigation.kind === "url" && !isAllowedBrowserUrl(navigation.url)) {
      throw new BrowserRefusal(
        "browser.navigation-policy",
        "Browser Tabs open http and https targets only; nothing else was navigated.",
      );
    }
    if (tabId === undefined) {
      if (navigation.kind !== "url") {
        throw new BrowserRefusal(
          "browser.unknown-tab",
          "History moves need a tabId: back, forward and reload belong to one tab.",
        );
      }
      if (options.scope.ticketId === null) {
        throw new BrowserRefusal(
          "browser.no-ticket-scope",
          "Only a Ticket Session can open its own Browser Tab; ask the person to open one and reference it.",
        );
      }
      return options.host.open({
        url: navigation.url,
        projectId: options.scope.projectId,
        ticketId: options.scope.ticketId,
        createdBy: "session",
      }).tabId;
    }
    const tab = resolve(tabId);
    switch (navigation.kind) {
      case "url":
        return options.host.navigate(tab.tabId, navigation.url).tabId;
      case "back":
        return options.host.back(tab.tabId).tabId;
      case "forward":
        return options.host.forward(tab.tabId).tabId;
      case "reload":
        return options.host.reload(tab.tabId).tabId;
    }
  };

  return {
    tabs: async () => ({
      tabs: visible().map((tab) => ({
        tabId: tab.tabId,
        url: tab.url,
        title: tab.title,
        createdBy: tab.createdBy,
      })),
    }),
    navigate: async (input) => {
      const tabId = steer(input.tabId, input.navigation);
      return snapshotOf(tabId, input.signal);
    },
    snapshot: async (input) => {
      resolve(input.tabId);
      return snapshotOf(input.tabId, input.signal);
    },
    act: async (input) => {
      const tab = resolve(input.tabId);
      const controller = await controllerFor(tab);
      await controller.act({
        generation: input.generation,
        kind: input.kind,
        ...(input.ref === undefined ? {} : { ref: input.ref }),
        ...(input.text === undefined ? {} : { text: input.text }),
        ...(input.key === undefined ? {} : { key: input.key }),
        ...(input.direction === undefined ? {} : { direction: input.direction }),
        ...(input.waitMs === undefined ? {} : { waitMs: input.waitMs }),
      });
      return snapshotOf(input.tabId, input.signal);
    },
    screenshot: async (input) => {
      const tab = resolve(input.tabId);
      const controller = await controllerFor(tab);
      const shot = await controller.screenshot();
      return { tabId: tab.tabId, url: tab.url, ...shot };
    },
    console: async (input) => {
      const tab = resolve(input.tabId);
      const controller = await controllerFor(tab);
      const record = controller.console();
      return {
        tabId: tab.tabId,
        url: tab.url,
        messages: record.messages,
        truncated: record.truncated,
      };
    },
  };
}
