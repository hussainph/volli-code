import { BrowserRefusal } from "@volli/agent-runtime";
import { describe, expect, it } from "vite-plus/test";

import type { BrowserTabState } from "../../ipc/contract";
import {
  createAgentBrowserPort,
  debuggerTransport,
  loadWaiter,
  type AgentBrowserHost,
} from "./agent-port";
import type { CdpTransport } from "./cdp-controller";

/** The one-button page every scripted transport answers with. */
const BUTTON_TREE = {
  nodes: [
    {
      nodeId: "1",
      ignored: false,
      role: { value: "RootWebArea" },
      name: { value: "Fixture" },
      childIds: ["2"],
    },
    {
      nodeId: "2",
      ignored: false,
      role: { value: "button" },
      name: { value: "Save" },
      backendDOMNodeId: 77,
      childIds: [],
    },
  ],
};

function state(overrides: Partial<BrowserTabState> & { tabId: string }): BrowserTabState {
  return {
    projectId: "p1",
    ticketId: null,
    createdBy: "user",
    url: "https://example.com/",
    title: "Example",
    loading: false,
    error: null,
    canGoBack: false,
    canGoForward: false,
    generation: 1,
    ...overrides,
  };
}

/**
 * A registry-only stand-in for the BrowserTabHost: the port's contract with
 * the host is list/open/navigate/history, and this fake answers exactly that
 * — no Electron, no views. Opens are recorded so provenance can be asserted.
 */
function fakeHost(initial: BrowserTabState[]): {
  host: AgentBrowserHost;
  tabs: Map<string, BrowserTabState>;
  opened: { url: string; projectId: string; ticketId: string | null; createdBy: string }[];
  navigated: { tabId: string; url: string }[];
} {
  const tabs = new Map(initial.map((one) => [one.tabId, one]));
  const opened: { url: string; projectId: string; ticketId: string | null; createdBy: string }[] =
    [];
  const navigated: { tabId: string; url: string }[] = [];
  let openCount = 0;
  return {
    tabs,
    opened,
    navigated,
    host: {
      list: (scope) =>
        [...tabs.values()]
          .filter((one) => one.projectId === scope.projectId)
          .map((one) => structuredClone(one)),
      open: (input) => {
        opened.push(input);
        openCount += 1;
        const created = state({
          tabId: `opened-${openCount}`,
          projectId: input.projectId,
          ticketId: input.ticketId,
          createdBy: input.createdBy,
          url: input.url,
          title: "",
        });
        tabs.set(created.tabId, created);
        return { ...created };
      },
      navigate: (tabId, url) => {
        navigated.push({ tabId, url });
        const existing = tabs.get(tabId);
        if (existing === undefined) throw new Error("Unknown Browser Tab");
        const moved = { ...existing, url, generation: existing.generation + 1 };
        tabs.set(tabId, moved);
        return { ...moved };
      },
      back: (tabId) => ({ ...(tabs.get(tabId) ?? state({ tabId })) }),
      forward: (tabId) => ({ ...(tabs.get(tabId) ?? state({ tabId })) }),
      reload: (tabId) => ({ ...(tabs.get(tabId) ?? state({ tabId })) }),
      consoleOf: () => ({ messages: [], truncated: false }),
    },
  };
}

function transportFor(): CdpTransport {
  return {
    send: async (method) => {
      if (method === "Accessibility.getFullAXTree") return BUTTON_TREE;
      if (method === "Page.captureScreenshot") return { data: "cGl4ZWxz" };
      if (method === "Page.getLayoutMetrics") {
        return { cssVisualViewport: { clientWidth: 800, clientHeight: 600 } };
      }
      return {};
    },
  };
}

function port(input: {
  tabs?: BrowserTabState[];
  ticketId?: string | null;
}): ReturnType<typeof portWithHost>["port"] {
  return portWithHost(input).port;
}

function portWithHost(input: { tabs?: BrowserTabState[]; ticketId?: string | null }): {
  port: ReturnType<typeof createAgentBrowserPort>;
  opened: ReturnType<typeof fakeHost>["opened"];
  hostTabs: Map<string, BrowserTabState>;
  /** Every hold, wait and release, in the order the port performed them. */
  wakeEvents: string[];
} {
  const { host, opened, tabs } = fakeHost(input.tabs ?? []);
  const wakeEvents: string[] = [];
  return {
    opened,
    hostTabs: tabs,
    wakeEvents,
    port: createAgentBrowserPort({
      host,
      scope: { projectId: "p1", ticketId: input.ticketId === undefined ? "t1" : input.ticketId },
      transportFor,
      waitForLoad: async (tabId) => {
        wakeEvents.push(`wait ${tabId}`);
      },
      holdAwake: (tabId) => {
        wakeEvents.push(`hold ${tabId}`);
        return () => wakeEvents.push(`release ${tabId}`);
      },
    }),
  };
}

const signal = new AbortController().signal;

describe("createAgentBrowserPort", () => {
  it("lists the user's tabs and this Ticket's own agent tabs, and nothing from other Tickets", async () => {
    const listing = await port({
      tabs: [
        state({ tabId: "user-1", createdBy: "user" }),
        state({ tabId: "mine", createdBy: "session", ticketId: "t1" }),
        state({ tabId: "theirs", createdBy: "session", ticketId: "t2" }),
      ],
    }).tabs({ signal });

    expect(listing.tabs.map((tab) => tab.tabId).toSorted()).toEqual(["mine", "user-1"]);
  });

  it("opens a new tab as the Session's own in either Ticket or Project scope", async () => {
    const ticket = portWithHost({ ticketId: "t1" });
    const project = portWithHost({ ticketId: null });

    const ticketSnapshot = await ticket.port.navigate({
      navigation: { kind: "url", url: "http://localhost:5173/" },
      signal,
    });
    const projectSnapshot = await project.port.navigate({
      navigation: { kind: "url", url: "https://example.com/research" },
      signal,
    });

    expect(ticket.opened).toEqual([
      {
        url: "http://localhost:5173/",
        projectId: "p1",
        ticketId: "t1",
        createdBy: "session",
      },
    ]);
    expect(project.opened).toEqual([
      {
        url: "https://example.com/research",
        projectId: "p1",
        ticketId: null,
        createdBy: "session",
      },
    ]);
    // The answer is already the page as structure — the settled act loop.
    expect(ticketSnapshot.snapshotText).toBe('- button "Save" [ref=e1]');
    expect(projectSnapshot.snapshotText).toBe('- button "Save" [ref=e1]');
  });

  it("refuses a target outside HTTP(S) before the host ever sees it", async () => {
    const attempt = port({}).navigate({
      navigation: { kind: "url", url: "file:///etc/passwd" },
      signal,
    });

    await expect(attempt).rejects.toThrow(BrowserRefusal);
    await expect(attempt.catch((error: BrowserRefusal) => error.rule)).resolves.toBe(
      "browser.navigation-policy",
    );
  });

  it("refuses to touch a tab outside the Session's scope, as unknown rather than as forbidden", async () => {
    const scoped = port({
      tabs: [state({ tabId: "theirs", createdBy: "session", ticketId: "t2" })],
    });

    const attempt = scoped.snapshot({ tabId: "theirs", signal });

    await expect(attempt).rejects.toThrow(BrowserRefusal);
    await expect(attempt.catch((error: BrowserRefusal) => error.rule)).resolves.toBe(
      "browser.unknown-tab",
    );
  });

  it("keeps acting honest across the seam: the host's generation is the one refs are judged by", async () => {
    const shared = port({
      tabs: [state({ tabId: "user-1", createdBy: "user", generation: 1 })],
    });
    const snapshot = await shared.snapshot({ tabId: "user-1", signal });
    expect(snapshot.generation).toBe(1);

    // The person navigates the shared tab; the host's record moves on. Acting
    // with the old snapshot's generation must refuse rather than click.
    await shared.navigate({
      tabId: "user-1",
      navigation: { kind: "url", url: "https://example.com/next" },
      signal,
    });

    const stale = shared.act({
      tabId: "user-1",
      generation: snapshot.generation,
      kind: "click",
      ref: "e1",
      signal,
    });
    await expect(stale).rejects.toThrow(BrowserRefusal);
  });

  it("speaks CDP through the app-private debugger, attaching once and never opening a port", async () => {
    const commands: { method: string; params?: object }[] = [];
    let attached = false;
    const attaches: string[] = [];
    let detaches = 0;
    const contents = {
      debugger: {
        isAttached: () => attached,
        attach: (version: string) => {
          attached = true;
          attaches.push(version);
        },
        sendCommand: async (method: string, params?: object) => {
          commands.push(params === undefined ? { method } : { method, params });
          return { ok: true };
        },
        detach: () => {
          attached = false;
          detaches += 1;
        },
      },
    };

    const transport = debuggerTransport(contents as never);
    await transport.send("Page.enable");
    await transport.send("Page.captureScreenshot", { format: "png" });

    expect(attaches).toEqual(["1.3"]);
    expect(commands.map((one) => one.method)).toEqual([
      "Accessibility.enable",
      "DOM.enable",
      "Page.enable",
      "Page.enable",
      "Page.captureScreenshot",
    ]);

    // DevTools or a renderer restart can detach the app-private debugger. The
    // next command establishes a fresh attachment and re-enables its domains.
    attached = false;
    await transport.send("Page.getLayoutMetrics");
    expect(attaches).toEqual(["1.3", "1.3"]);
    expect(commands.slice(-4).map((one) => one.method)).toEqual([
      "Accessibility.enable",
      "DOM.enable",
      "Page.enable",
      "Page.getLayoutMetrics",
    ]);

    transport.dispose?.();
    expect(detaches).toBe(1);
    expect(attached).toBe(false);
  });

  it("waits for a loading tab to settle and returns at once for one already settled", async () => {
    let loading = true;
    const listeners = new Map<string, () => void>();
    const contents = {
      isLoading: () => loading,
      on: (event: string, listener: () => void) => listeners.set(event, listener),
      removeListener: () => undefined,
    };
    const wait = loadWaiter(() => contents as never);

    const pending = wait("tab-1", new AbortController().signal);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    loading = false;
    listeners.get("did-stop-loading")?.();
    await pending;

    // Already-settled tabs never subscribe at all.
    listeners.clear();
    await wait("tab-1", new AbortController().signal);
    expect(listeners.size).toBe(0);
  });

  it("waits for a required navigation that has not started yet", async () => {
    let loading = false;
    const listeners = new Map<string, () => void>();
    const contents = {
      isLoading: () => loading,
      on: (event: string, listener: () => void) => listeners.set(event, listener),
      removeListener: (event: string) => listeners.delete(event),
    };
    const wait = loadWaiter(() => contents as never, 1_000);

    const pending = wait("tab-1", new AbortController().signal, "required-navigation");
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    loading = true;
    listeners.get("did-start-loading")?.();
    await Promise.resolve();
    expect(settled).toBe(false);

    loading = false;
    listeners.get("did-stop-loading")?.();
    await pending;
    expect(settled).toBe(true);
  });

  it("answers a screenshot with the tab's own record beside the engine's pixels", async () => {
    const scoped = port({
      tabs: [state({ tabId: "user-1", createdBy: "user", url: "https://example.com/page" })],
    });

    const shot = await scoped.screenshot({ tabId: "user-1", signal });

    expect(shot).toEqual({
      tabId: "user-1",
      url: "https://example.com/page",
      base64Png: "cGl4ZWxz",
      width: 800,
      height: 600,
    });
  });

  it("holds a driven tab awake before waiting on its load, once, and releases when the attachment ends", async () => {
    const driven = portWithHost({
      tabs: [state({ tabId: "user-1", createdBy: "user" })],
    });

    await driven.port.snapshot({ tabId: "user-1", signal });
    await driven.port.snapshot({ tabId: "user-1", signal });

    // The hold lands before the load wait: a hidden tab only finishes loading
    // at foreground pace, so waiting first would burn the whole bound.
    expect(driven.wakeEvents).toEqual(["hold user-1", "wait user-1", "wait user-1"]);

    driven.port.dispose?.();
    expect(driven.wakeEvents).toEqual([
      "hold user-1",
      "wait user-1",
      "wait user-1",
      "release user-1",
    ]);
  });

  it("holds a tab awake before screenshotting it, with no snapshot in the call to do it for us", async () => {
    // The screenshot path is the one that never reaches snapshotOf, so it is
    // the only caller whose hold is entirely its own. Frames are exactly what
    // a throttled engine stops producing, so losing this hold is the ticket's
    // headline symptom coming straight back (VC-252 review).
    const driven = portWithHost({
      tabs: [state({ tabId: "user-1", createdBy: "user" })],
    });

    await driven.port.screenshot({ tabId: "user-1", signal });

    expect(driven.wakeEvents).toEqual(["hold user-1"]);
  });

  it("hands back a transport whose enable failed, instead of leaking its attachment", async () => {
    // A controller whose enable throws never enters the port's map, so the
    // port's own dispose walks straight past it. If it does not let go here,
    // Chromium's debugger stays attached to the tab and the person can no
    // longer open DevTools on it (CodeRabbit, PR #457).
    let disposed = 0;
    const failing = createAgentBrowserPort({
      host: fakeHost([state({ tabId: "user-1", createdBy: "user" })]).host,
      scope: { projectId: "p1", ticketId: "t1" },
      transportFor: () => ({
        send: async () => ({}),
        ensureReady: async () => {
          throw new Error("another debugger owns this tab");
        },
        dispose: () => {
          disposed += 1;
        },
      }),
      waitForLoad: async () => undefined,
      holdAwake: () => () => undefined,
    });

    await expect(failing.snapshot({ tabId: "user-1", signal })).rejects.toThrow(
      "another debugger owns this tab",
    );
    expect(disposed).toBe(1);
  });

  it("releases its hold on a tab that has left the Session's scope", async () => {
    const driven = portWithHost({
      tabs: [state({ tabId: "user-1", createdBy: "user" })],
    });
    await driven.port.snapshot({ tabId: "user-1", signal });

    // The person closes the tab; the host's registry no longer lists it.
    driven.hostTabs.delete("user-1");

    await expect(driven.port.snapshot({ tabId: "user-1", signal })).rejects.toThrow(BrowserRefusal);
    expect(driven.wakeEvents).toEqual(["hold user-1", "wait user-1", "release user-1"]);
  });
});
