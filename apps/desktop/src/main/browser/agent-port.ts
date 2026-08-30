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
 * Visibility of a personal tab carries ACTUATION, not only reading: a Session
 * may `navigate` and `act` on a `user` tab, not merely snapshot it. That is a
 * deliberate grant and a knowingly accepted risk, so it is written down here
 * rather than left to be rediscovered. Personal tabs share one PERSISTENT
 * profile (`persist:volli-browser:user`), so they carry real cookies and real
 * sign-ins, while Session tabs get a credentialless per-Ticket partition. The
 * consequence to hold in view: page content this port returns is untrusted,
 * and a prompt injection that survives the tools' envelope could ask the model
 * to steer an authenticated tab and read the result back. Volli takes that
 * trade for now because duosync is the feature — "drive the thing I am looking
 * at" is the point, and a read-only port would not be it.
 *
 * This is explicitly PROVISIONAL. The preferred end state is an approval step:
 * the person confirms before a Session acts on a tab that is theirs, the way a
 * destructive command asks first. It is deferred rather than rejected — the
 * open question is how often the prompt would fire in real use, and whether it
 * lands as a safeguard or as friction, which only running the feature answers.
 * Should it prove noisy enough to click through blindly, it would buy nothing.
 *
 * When that lands, it belongs HERE, in `steer` and `act`, keyed on
 * `tab.createdBy === "user"` — not in the visibility filter below, because
 * listing a tab and driving it are separate questions and only the second one
 * needs an answer from the person.
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
  RuntimeBrowserConsole,
  RuntimeBrowserNavigation,
  RuntimeBrowserPort,
  RuntimeBrowserSnapshot,
} from "@volli/shared";

import type { BrowserTabState } from "../../ipc/contract";
import type { BrowserTabCreateOptions } from "./tab-host";
import { BrowserTabLimitError, isAllowedBrowserUrl } from "./tab-host";
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
  consoleOf(tabId: string): Pick<RuntimeBrowserConsole, "messages" | "truncated">;
}

export interface AgentBrowserPortOptions {
  host: AgentBrowserHost;
  /** The Session's product scope, fixed at attachment and never the model's to name. */
  scope: { projectId: string; ticketId: string | null };
  /** The CDP wire for one live tab — production binds `webContents.debugger`. */
  transportFor: (tabId: string) => CdpTransport;
  /** Resolves when the tab has settled enough to read; must honour the signal. */
  waitForLoad: (tabId: string, signal: AbortSignal, mode?: BrowserLoadWaitMode) => Promise<void>;
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
  let initialized = false;
  const ensureReady = async (): Promise<void> => {
    if (initialized && wire.isAttached()) return;
    initialized = false;
    try {
      if (!wire.isAttached()) wire.attach("1.3");
      await wire.sendCommand("Accessibility.enable");
      await wire.sendCommand("DOM.enable");
      await wire.sendCommand("Page.enable");
      initialized = true;
    } catch {
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
      return wire.sendCommand(method, params);
    },
    dispose: () => {
      if (!initialized || !wire.isAttached()) return;
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
export type BrowserLoadWaitMode = "current" | "possible-navigation" | "required-navigation";

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
        signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      contents.on("did-start-loading", started);
      contents.on("did-stop-loading", finish);
      signal.addEventListener("abort", finish, { once: true });
      // Close the gap between the first isLoading() read and listener install.
      if (contents.isLoading()) started();
      else if (mode === "possible-navigation") grace = setTimeout(finish, navigationGraceMs);
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
      controllers.get(tabId)?.dispose();
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
      await controller.enable();
      controllers.set(tab.tabId, controller);
    }
    controller.syncGeneration(tab.generation);
    return controller;
  };

  const snapshotOf = async (
    tabId: string,
    signal: AbortSignal,
    waitMode: BrowserLoadWaitMode = "current",
  ): Promise<RuntimeBrowserSnapshot> => {
    // Scope before waiting: an out-of-scope id must not gain a loading-timing
    // oracle, and a cancelled call must not attach Chromium's debugger.
    resolve(tabId);
    signal.throwIfAborted();
    await options.waitForLoad(tabId, signal, waitMode);
    signal.throwIfAborted();
    const tab = resolve(tabId);
    const controller = await controllerFor(tab);
    const printed = await controller.snapshot(signal);
    return {
      tabId: tab.tabId,
      url: tab.url,
      title: tab.title,
      snapshotText: printed.text,
      generation: printed.generation,
      truncated: printed.truncated,
    };
  };

  const steer = (
    tabId: string | undefined,
    navigation: RuntimeBrowserNavigation,
  ): { tabId: string; waitMode: BrowserLoadWaitMode } => {
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
      try {
        return {
          tabId: options.host.open({
            url: navigation.url,
            projectId: options.scope.projectId,
            ticketId: options.scope.ticketId,
            createdBy: "session",
          }).tabId,
          waitMode: "required-navigation",
        };
      } catch (error) {
        if (!(error instanceof BrowserTabLimitError)) throw error;
        throw new BrowserRefusal("browser.tab-limit", error.message);
      }
    }
    const tab = resolve(tabId);
    switch (navigation.kind) {
      case "url":
        return {
          tabId: options.host.navigate(tab.tabId, navigation.url).tabId,
          waitMode: "required-navigation",
        };
      case "back": {
        const moved = options.host.back(tab.tabId);
        return {
          tabId: moved.tabId,
          waitMode: moved.generation > tab.generation ? "required-navigation" : "current",
        };
      }
      case "forward": {
        const moved = options.host.forward(tab.tabId);
        return {
          tabId: moved.tabId,
          waitMode: moved.generation > tab.generation ? "required-navigation" : "current",
        };
      }
      case "reload":
        return {
          tabId: options.host.reload(tab.tabId).tabId,
          waitMode: "required-navigation",
        };
    }
  };

  return {
    tabs: async (input) => {
      input.signal.throwIfAborted();
      return {
        tabs: visible().map((tab) => ({
          tabId: tab.tabId,
          url: tab.url,
          title: tab.title,
          createdBy: tab.createdBy,
        })),
      };
    },
    navigate: async (input) => {
      input.signal.throwIfAborted();
      const steered = steer(input.tabId, input.navigation);
      return snapshotOf(steered.tabId, input.signal, steered.waitMode);
    },
    snapshot: async (input) => {
      resolve(input.tabId);
      return snapshotOf(input.tabId, input.signal);
    },
    act: async (input) => {
      input.signal.throwIfAborted();
      const tab = resolve(input.tabId);
      const controller = await controllerFor(tab);
      await controller.act(
        {
          generation: input.generation,
          kind: input.kind,
          ...(input.ref === undefined ? {} : { ref: input.ref }),
          ...(input.text === undefined ? {} : { text: input.text }),
          ...(input.key === undefined ? {} : { key: input.key }),
          ...(input.direction === undefined ? {} : { direction: input.direction }),
          ...(input.waitMs === undefined ? {} : { waitMs: input.waitMs }),
        },
        input.signal,
      );
      return snapshotOf(input.tabId, input.signal, "possible-navigation");
    },
    screenshot: async (input) => {
      input.signal.throwIfAborted();
      const tab = resolve(input.tabId);
      const controller = await controllerFor(tab);
      const shot = await controller.screenshot(input.signal);
      input.signal.throwIfAborted();
      return { tabId: tab.tabId, url: tab.url, ...shot };
    },
    console: async (input) => {
      input.signal.throwIfAborted();
      const tab = resolve(input.tabId);
      const record = options.host.consoleOf(tab.tabId);
      return {
        tabId: tab.tabId,
        url: tab.url,
        messages: record.messages,
        truncated: record.truncated,
      };
    },
    dispose: () => {
      for (const controller of controllers.values()) controller.dispose();
      controllers.clear();
    },
  };
}
