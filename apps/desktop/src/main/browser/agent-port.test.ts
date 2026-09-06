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
import { BrowserSessionTabLimitError } from "./tab-host";

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
  const createdBy = overrides.createdBy ?? "user";
  return {
    projectId: "p1",
    ticketId: null,
    createdBy,
    // An agent tab defaults to THIS port's Session so existing fixtures that
    // only said `createdBy: "session"` still describe the Session's own tab.
    ownerSessionId: createdBy === "session" ? "s1" : null,
    presentation: createdBy === "session" ? "headless" : "tab",
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
type OpenedRecord = {
  url: string;
  projectId: string;
  ticketId: string | null;
  createdBy: string;
  ownerSessionId?: string | null;
};

function fakeHost(
  initial: BrowserTabState[],
  options: { sessionCap?: number; declineCapture?: boolean } = {},
): {
  host: AgentBrowserHost;
  tabs: Map<string, BrowserTabState>;
  opened: OpenedRecord[];
  navigated: { tabId: string; url: string }[];
  closedHeadlessFor: string[];
  captures: string[];
} {
  const tabs = new Map(initial.map((one) => [one.tabId, one]));
  const opened: OpenedRecord[] = [];
  const navigated: { tabId: string; url: string }[] = [];
  const closedHeadlessFor: string[] = [];
  const captures: string[] = [];
  let openCount = 0;
  return {
    tabs,
    opened,
    navigated,
    closedHeadlessFor,
    captures,
    host: {
      list: (scope) =>
        [...tabs.values()]
          .filter((one) => one.projectId === scope.projectId)
          .map((one) => structuredClone(one)),
      open: (input) => {
        opened.push(input);
        if (options.sessionCap !== undefined && input.createdBy === "session") {
          const owned = [...tabs.values()].filter(
            (one) => one.ownerSessionId === input.ownerSessionId,
          ).length;
          if (owned >= options.sessionCap) throw new BrowserSessionTabLimitError();
        }
        openCount += 1;
        const created = state({
          tabId: `opened-${openCount}`,
          projectId: input.projectId,
          ticketId: input.ticketId,
          createdBy: input.createdBy,
          ownerSessionId: input.createdBy === "session" ? input.ownerSessionId : null,
          url: input.url,
          title: "",
        });
        tabs.set(created.tabId, created);
        return { ...created };
      },
      capturePicture: async (tabId) => {
        captures.push(tabId);
        return options.declineCapture === true ? null : `live:${tabId}:${captures.length}`;
      },
      keepScreenshot: (tabId, base64Png) => `kept:${tabId}:${base64Png}`,
      closeHeadlessOwnedBy: (sessionId) => {
        closedHeadlessFor.push(sessionId);
        const closing = [...tabs.values()]
          .filter((one) => one.ownerSessionId === sessionId && one.presentation === "headless")
          .map((one) => one.tabId);
        for (const tabId of closing) tabs.delete(tabId);
        return closing;
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
      if (method === "DOM.getBoxModel") {
        return { model: { content: [100, 200, 110, 200, 110, 210, 100, 210] } };
      }
      if (method === "Page.captureScreenshot") return { data: "cGl4ZWxz" };
      if (method === "Page.getLayoutMetrics") {
        return { cssVisualViewport: { clientWidth: 800, clientHeight: 600 } };
      }
      return {};
    },
  };
}

interface PortInput {
  tabs?: BrowserTabState[];
  ticketId?: string | null;
  sessionId?: string;
  sessionCap?: number;
  declineCapture?: boolean;
}

function port(input: PortInput): ReturnType<typeof portWithHost>["port"] {
  return portWithHost(input).port;
}

function portWithHost(input: PortInput): {
  port: ReturnType<typeof createAgentBrowserPort>;
  opened: ReturnType<typeof fakeHost>["opened"];
  hostTabs: Map<string, BrowserTabState>;
  closedHeadlessFor: string[];
  captures: string[];
  /** Every hold, wait and release, in the order the port performed them. */
  wakeEvents: string[];
} {
  const { host, opened, tabs, closedHeadlessFor, captures } = fakeHost(input.tabs ?? [], {
    ...(input.sessionCap === undefined ? {} : { sessionCap: input.sessionCap }),
    ...(input.declineCapture === undefined ? {} : { declineCapture: input.declineCapture }),
  });
  const wakeEvents: string[] = [];
  return {
    opened,
    hostTabs: tabs,
    closedHeadlessFor,
    captures,
    wakeEvents,
    port: createAgentBrowserPort({
      host,
      scope: {
        projectId: "p1",
        ticketId: input.ticketId === undefined ? "t1" : input.ticketId,
        sessionId: input.sessionId ?? "s1",
      },
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
  it("lists the user's tabs and this Session's own agent tabs, and nothing another Session opened", async () => {
    const listing = await port({
      tabs: [
        state({ tabId: "user-1", createdBy: "user" }),
        state({ tabId: "mine", createdBy: "session", ticketId: "t1" }),
        state({ tabId: "theirs", createdBy: "session", ticketId: "t2", ownerSessionId: "s9" }),
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
        ownerSessionId: "s1",
      },
    ]);
    expect(project.opened).toEqual([
      {
        url: "https://example.com/research",
        projectId: "p1",
        ticketId: null,
        createdBy: "session",
        ownerSessionId: "s1",
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
      tabs: [
        state({ tabId: "theirs", createdBy: "session", ticketId: "t2", ownerSessionId: "s9" }),
      ],
    });

    const attempt = scoped.snapshot({ tabId: "theirs", signal });

    await expect(attempt).rejects.toThrow(BrowserRefusal);
    await expect(attempt.catch((error: BrowserRefusal) => error.rule)).resolves.toBe(
      "browser.unknown-tab",
    );
  });

  it("hides a sibling Session's tabs on the same Ticket: it can neither list nor drive them (VC-238)", async () => {
    const sibling = state({
      tabId: "sibling",
      createdBy: "session",
      ticketId: "t1",
      ownerSessionId: "s2",
    });
    const mine = state({ tabId: "mine", createdBy: "session", ticketId: "t1" });
    const scoped = port({ tabs: [sibling, mine, state({ tabId: "user-1" })] });

    const listing = await scoped.tabs({ signal });
    expect(listing.tabs.map((tab) => tab.tabId).toSorted()).toEqual(["mine", "user-1"]);
    expect(listing.tabs.find((tab) => tab.tabId === "mine")?.ownerSessionId).toBe("s1");
    expect(listing.tabs.find((tab) => tab.tabId === "user-1")?.ownerSessionId).toBeNull();

    const attempt = scoped.act({
      tabId: "sibling",
      generation: 1,
      kind: "click",
      ref: "e1",
      signal,
    });
    await expect(attempt.catch((error: BrowserRefusal) => error.rule)).resolves.toBe(
      "browser.unknown-tab",
    );
  });

  it("leaves a seam for VC-9: a host-supplied predicate may widen visibility to another Session's tabs", async () => {
    const child = state({ tabId: "child", createdBy: "session", ownerSessionId: "s-child" });
    const stranger = state({ tabId: "stranger", createdBy: "session", ownerSessionId: "s9" });
    const { host } = fakeHost([child, stranger]);
    const shared = createAgentBrowserPort({
      host,
      scope: { projectId: "p1", ticketId: "t1", sessionId: "s1" },
      sharesTabsOf: (owner) => owner === "s-child",
      transportFor,
      waitForLoad: async () => undefined,
      holdAwake: () => () => undefined,
    });

    const listing = await shared.tabs({ signal });

    expect(listing.tabs.map((tab) => tab.tabId)).toEqual(["child"]);
  });

  it("refuses the per-Session cap under its own rule, naming what the model can do about it", async () => {
    const capped = port({
      tabs: [state({ tabId: "mine", createdBy: "session", ticketId: "t1" })],
      sessionCap: 1,
    });

    const attempt = capped.navigate({
      navigation: { kind: "url", url: "https://example.com/more" },
      signal,
    });

    await expect(attempt).rejects.toThrow(BrowserRefusal);
    await expect(attempt.catch((error: BrowserRefusal) => error.rule)).resolves.toBe(
      "browser.session-tab-limit",
    );
    await expect(attempt.catch((error: BrowserRefusal) => error.message)).resolves.toContain(
      "reuse an open tab",
    );
  });

  it("photographs the tab after a navigation and after an action, and names what the action touched", async () => {
    const driven = portWithHost({
      tabs: [state({ tabId: "mine", createdBy: "session", ticketId: "t1", generation: 1 })],
    });

    const opened = await driven.port.navigate({
      tabId: "mine",
      navigation: { kind: "url", url: "https://example.com/next" },
      signal,
    });
    expect(opened.picture).toBe("live:mine:1");

    const acted = await driven.port.act({
      tabId: "mine",
      generation: opened.generation,
      kind: "click",
      ref: "e1",
      signal,
    });
    expect(acted.target).toEqual({ ref: "e1", name: "Save" });
    expect(acted.picture).toBe("live:mine:2");
    // A plain read photographs nothing: the page did not change.
    const read = await driven.port.snapshot({ tabId: "mine", signal });
    expect(read.picture).toBeNull();
    expect(driven.captures).toEqual(["mine", "mine"]);
  });

  it("carries no picture when the host declined to look, without failing the action", async () => {
    const watched = portWithHost({
      tabs: [state({ tabId: "user-1", createdBy: "user", generation: 1 })],
      declineCapture: true,
    });
    await watched.port.snapshot({ tabId: "user-1", signal });

    const acted = await watched.port.act({
      tabId: "user-1",
      generation: 1,
      kind: "press",
      key: "Enter",
      signal,
    });

    expect(acted.target).toBeNull();
    expect(acted.picture).toBeNull();
  });

  it("closes the Session's headless tabs when the attachment ends, through the host", async () => {
    const ending = portWithHost({
      tabs: [
        state({ tabId: "headless", createdBy: "session", ticketId: "t1" }),
        state({
          tabId: "shown",
          createdBy: "session",
          ticketId: "t1",
          presentation: "preview",
        }),
      ],
    });

    ending.port.dispose?.();

    expect(ending.closedHeadlessFor).toEqual(["s1"]);
    expect([...ending.hostTabs.keys()]).toEqual(["shown"]);
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
      title: "Example",
      base64Png: "cGl4ZWxz",
      // The same bytes, kept for the person (VC-238): the tool description
      // promises the picture to both parties, and the id is how the card gets it.
      picture: "kept:user-1:cGl4ZWxz",
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
      scope: { projectId: "p1", ticketId: "t1", sessionId: "s1" },
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
