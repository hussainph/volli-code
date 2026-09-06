import { BrowserRefusal } from "@volli/agent-runtime";
import { describe, expect, it } from "vite-plus/test";

import type { BrowserTabHolder, BrowserTabState } from "../../ipc/contract";
import {
  createAgentBrowserPort,
  debuggerTransport,
  loadWaiter,
  type AgentBrowserHost,
} from "./agent-port";
import type { CdpTransport, TabCursorDriver } from "./cdp-controller";
import type { BrowserSessionHolder } from "./tab-host";

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
    heldBy: null,
    ...overrides,
  };
}

/** The attachment every port in this file speaks for unless a test says otherwise. */
const ME: BrowserSessionHolder = { sessionId: "ses-me", attachmentId: "att-me-1" };
const OTHER: BrowserSessionHolder = { sessionId: "ses-other", attachmentId: "att-other-1" };

const sameHolder = (a: BrowserSessionHolder, b: BrowserSessionHolder): boolean =>
  a.sessionId === b.sessionId && a.attachmentId === b.attachmentId;

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
  /** The hold table, with the real host's rules: holder or person or nobody. */
  holds: Map<string, { kind: "session"; holder: BrowserSessionHolder } | { kind: "person" }>;
  /** Every hold end, as `why:tabId`, in order. */
  ended: string[];
} {
  const tabs = new Map(initial.map((one) => [one.tabId, one]));
  const opened: { url: string; projectId: string; ticketId: string | null; createdBy: string }[] =
    [];
  const navigated: { tabId: string; url: string }[] = [];
  const holds = new Map<
    string,
    { kind: "session"; holder: BrowserSessionHolder } | { kind: "person" }
  >();
  const ended: string[] = [];
  let openCount = 0;
  const holderView = (tabId: string): BrowserTabHolder | null => {
    const hold = holds.get(tabId);
    if (hold === undefined) return null;
    if (hold.kind === "person") return { kind: "person" };
    return {
      kind: "session",
      sessionId: hold.holder.sessionId,
      name: `Name of ${hold.holder.sessionId}`,
      color: "#123456",
    };
  };
  const sync = (tabId: string): BrowserTabState => {
    const current = tabs.get(tabId);
    if (current === undefined) throw new Error("Unknown Browser Tab");
    const next = { ...current, heldBy: holderView(tabId) };
    tabs.set(tabId, next);
    return { ...next };
  };
  const release = (tabId: string, holder: BrowserSessionHolder, why: string): void => {
    const hold = holds.get(tabId);
    if (hold?.kind !== "session" || !sameHolder(hold.holder, holder)) return;
    holds.delete(tabId);
    ended.push(`${why}:${tabId}`);
    if (tabs.has(tabId)) sync(tabId);
  };
  return {
    tabs,
    opened,
    navigated,
    holds,
    ended,
    host: {
      hold: (tabId, holder) => {
        if (!tabs.has(tabId)) throw new Error("Unknown Browser Tab");
        const current = holds.get(tabId);
        if (current !== undefined) {
          if (current.kind === "session" && sameHolder(current.holder, holder)) {
            return { kind: "held", tab: sync(tabId) };
          }
          return { kind: "refused", holder: holderView(tabId)! };
        }
        holds.set(tabId, { kind: "session", holder });
        return { kind: "held", tab: sync(tabId) };
      },
      releaseHold: (tabId, holder, why = "release") => release(tabId, holder, why),
      releaseAllHeldBy: (holder, why) => {
        const released: string[] = [];
        for (const [tabId, hold] of Array.from(holds)) {
          if (hold.kind === "session" && sameHolder(hold.holder, holder)) {
            release(tabId, holder, why);
            released.push(tabId);
          }
        }
        return released;
      },
      forgetSession: (holder) => {
        for (const [tabId, hold] of Array.from(holds)) {
          if (hold.kind === "session" && sameHolder(hold.holder, holder)) {
            release(tabId, holder, "attachment-end");
          }
        }
        ended.push(`forget:${holder.sessionId}`);
      },
      list: (scope) => {
        const listed: BrowserTabState[] = [];
        for (const one of tabs.values()) {
          if (one.projectId !== scope.projectId) continue;
          const copy = structuredClone(one);
          copy.heldBy = holderView(one.tabId);
          listed.push(copy);
        }
        return listed;
      },
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
      if (method === "DOM.getBoxModel")
        return { model: { content: [10, 20, 30, 20, 30, 40, 10, 40] } };
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

interface PortHarness {
  port: ReturnType<typeof createAgentBrowserPort>;
  opened: ReturnType<typeof fakeHost>["opened"];
  hostTabs: Map<string, BrowserTabState>;
  holds: ReturnType<typeof fakeHost>["holds"];
  ended: string[];
  /** Every hold, wait and release, in the order the port performed them. */
  wakeEvents: string[];
  /** A second port over the SAME host, speaking for another attachment. */
  portFor(
    session: BrowserSessionHolder,
    cursorFor?: (tabId: string) => TabCursorDriver,
  ): ReturnType<typeof createAgentBrowserPort>;
}

function portWithHost(input: {
  tabs?: BrowserTabState[];
  ticketId?: string | null;
  cursorFor?: (tabId: string) => TabCursorDriver | undefined;
}): PortHarness {
  const { host, opened, tabs, holds, ended } = fakeHost(input.tabs ?? []);
  const wakeEvents: string[] = [];
  const portFor = (
    session: BrowserSessionHolder,
    cursorFor = input.cursorFor,
  ): ReturnType<typeof createAgentBrowserPort> =>
    createAgentBrowserPort({
      host,
      scope: { projectId: "p1", ticketId: input.ticketId === undefined ? "t1" : input.ticketId },
      session,
      transportFor,
      waitForLoad: async (tabId) => {
        wakeEvents.push(`wait ${tabId}`);
      },
      holdAwake: (tabId) => {
        wakeEvents.push(`hold ${tabId}`);
        return () => wakeEvents.push(`release ${tabId}`);
      },
      ...(cursorFor === undefined ? {} : { cursorFor }),
    });
  return {
    opened,
    hostTabs: tabs,
    holds,
    ended,
    wakeEvents,
    portFor,
    port: portFor(ME),
  };
}

/** The one ref the fixture's snapshot minted — renumbered per snapshot, so read rather than assumed. */
function refIn(snapshotText: string): string {
  const match = /\[ref=(e\d+)\]/.exec(snapshotText);
  if (match === null) throw new Error(`no ref in ${snapshotText}`);
  return match[1]!;
}

/** Act on the fixture's one button: snapshot for the ref, then click it. */
async function clickSave(
  one: ReturnType<typeof createAgentBrowserPort>,
  tabId: string,
): Promise<void> {
  const snap = await one.snapshot({ tabId, signal });
  await one.act({
    tabId,
    generation: snap.generation,
    kind: "click",
    ref: refIn(snap.snapshotText),
    signal,
  });
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
      session: ME,
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

/** A refusal's rule, or a word for a call that did not refuse. */
async function ruleOf(call: Promise<unknown>): Promise<string> {
  try {
    await call;
    return "no refusal";
  } catch (error) {
    if (error instanceof BrowserRefusal) return error.rule;
    throw error;
  }
}

describe("createAgentBrowserPort holds (VC-239)", () => {
  it("takes a free tab's hold on the first write, in the Session's own name", async () => {
    const harness = portWithHost({ tabs: [state({ tabId: "user-1", createdBy: "user" })] });
    await clickSave(harness.port, "user-1");
    expect(harness.holds.get("user-1")).toEqual({ kind: "session", holder: ME });
    // The listing says so, and says it is this Session.
    const listing = await harness.port.tabs({ signal });
    expect(listing.tabs[0]?.heldBy).toEqual({ kind: "session", sessionId: "ses-me", self: true });
  });

  it("reads never need a hold: snapshot, screenshot and console work on a tab somebody else holds", async () => {
    const harness = portWithHost({ tabs: [state({ tabId: "shared", createdBy: "user" })] });
    await clickSave(harness.portFor(OTHER), "shared");

    await expect(harness.port.snapshot({ tabId: "shared", signal })).resolves.toMatchObject({
      tabId: "shared",
    });
    await expect(harness.port.screenshot({ tabId: "shared", signal })).resolves.toMatchObject({
      tabId: "shared",
    });
    await expect(harness.port.console({ tabId: "shared", signal })).resolves.toMatchObject({
      tabId: "shared",
    });
    const listing = await harness.port.tabs({ signal });
    expect(listing.tabs[0]?.heldBy).toEqual({
      kind: "session",
      sessionId: "ses-other",
      self: false,
    });
  });

  it("contention: B's write on A's tab is refused naming A, and B opens its own tab and carries on", async () => {
    const harness = portWithHost({ tabs: [state({ tabId: "shared", createdBy: "user" })] });
    const a = harness.portFor(ME);
    const b = harness.portFor(OTHER);
    await clickSave(a, "shared");

    // Every write door refuses: act, and navigate in all four shapes.
    const snap = await b.snapshot({ tabId: "shared", signal });
    const act = b.act({
      tabId: "shared",
      generation: snap.generation,
      kind: "click",
      ref: refIn(snap.snapshotText),
      signal,
    });
    await expect(act).rejects.toMatchObject({
      rule: "browser.tab-held",
      message: expect.stringContaining("Name of ses-me"),
    });
    await expect(act).rejects.toMatchObject({
      message: expect.stringContaining("browser_navigate and no tabId"),
    });
    for (const navigation of [
      { kind: "url", url: "https://example.com/b" },
      { kind: "back" },
      { kind: "forward" },
      { kind: "reload" },
    ] as const) {
      expect(await ruleOf(b.navigate({ tabId: "shared", navigation, signal }))).toBe(
        "browser.tab-held",
      );
    }
    // Nothing moved under A.
    expect(harness.holds.get("shared")).toEqual({ kind: "session", holder: ME });

    // B opens its own tab: held from birth, driven at once.
    const own = await b.navigate({
      navigation: { kind: "url", url: "https://example.com/b" },
      signal,
    });
    expect(harness.holds.get(own.tabId)).toEqual({ kind: "session", holder: OTHER });
    await expect(clickSave(b, own.tabId)).resolves.toBeUndefined();
  });

  it("refuses the same Session on a later attachment: a hold belongs to the attachment that took it", async () => {
    const harness = portWithHost({ tabs: [state({ tabId: "shared", createdBy: "user" })] });
    await clickSave(harness.portFor({ sessionId: "ses-me", attachmentId: "att-me-0" }), "shared");
    const snap = await harness.port.snapshot({ tabId: "shared", signal });
    expect(
      await ruleOf(
        harness.port.act({
          tabId: "shared",
          generation: snap.generation,
          kind: "click",
          ref: refIn(snap.snapshotText),
          signal,
        }),
      ),
    ).toBe("browser.tab-held");
  });

  it("turn end: every hold goes with the turn, and the next turn takes it again on its first write", async () => {
    const harness = portWithHost({
      tabs: [
        state({ tabId: "one", createdBy: "user" }),
        state({ tabId: "two", createdBy: "user" }),
      ],
    });
    await clickSave(harness.port, "one");
    await clickSave(harness.port, "two");

    harness.port.turnEnded();
    expect(harness.holds.size).toBe(0);
    expect(harness.ended).toEqual(["turn-end:one", "turn-end:two"]);

    // Another Session can take one at once; this one takes the other back.
    await clickSave(harness.portFor(OTHER), "one");
    await clickSave(harness.port, "two");
    expect(harness.holds.get("one")).toEqual({ kind: "session", holder: OTHER });
    expect(harness.holds.get("two")).toEqual({ kind: "session", holder: ME });
  });

  it("attachment end: dispose ends every hold and forgets the Session, and another Session may take the tab at once", async () => {
    const harness = portWithHost({ tabs: [state({ tabId: "one", createdBy: "user" })] });
    await clickSave(harness.port, "one");

    harness.port.dispose();
    expect(harness.holds.size).toBe(0);
    expect(harness.ended).toEqual(["attachment-end:one", "forget:ses-me"]);
    await clickSave(harness.portFor(OTHER), "one");
    expect(harness.holds.get("one")).toEqual({ kind: "session", holder: OTHER });
  });

  it("tab closed while held: the next write refuses as unknown-tab, the existing rule", async () => {
    const harness = portWithHost({ tabs: [state({ tabId: "one", createdBy: "user" })] });
    await clickSave(harness.port, "one");
    // The host forgets the tab and ends the hold with it.
    harness.hostTabs.delete("one");
    harness.holds.delete("one");

    expect(
      await ruleOf(
        harness.port.act({ tabId: "one", generation: 1, kind: "click", ref: "e1", signal }),
      ),
    ).toBe("browser.unknown-tab");
    expect(await ruleOf(harness.port.acquire({ tabId: "one", signal }))).toBe(
      "browser.unknown-tab",
    );
    // A turn end afterwards has nothing to release and nothing to fail on.
    expect(() => harness.port.turnEnded()).not.toThrow();
  });

  it("person takes over mid-turn: the next write refuses naming the person; after hand-back the Session holds again", async () => {
    const harness = portWithHost({ tabs: [state({ tabId: "one", createdBy: "user" })] });
    await clickSave(harness.port, "one");
    harness.holds.set("one", { kind: "person" });

    const snap = await harness.port.snapshot({ tabId: "one", signal });
    await expect(
      harness.port.act({
        tabId: "one",
        generation: snap.generation,
        kind: "click",
        ref: refIn(snap.snapshotText),
        signal,
      }),
    ).rejects.toMatchObject({
      rule: "browser.person-has-tab",
      message: expect.stringContaining("hand it back"),
    });
    expect(await harness.port.acquire({ tabId: "one", signal })).toEqual({
      kind: "refused",
      tabId: "one",
      holder: { kind: "person" },
    });
    const listing = await harness.port.tabs({ signal });
    expect(listing.tabs[0]?.heldBy).toEqual({ kind: "person" });

    harness.holds.delete("one");
    await clickSave(harness.port, "one");
    expect(harness.holds.get("one")).toEqual({ kind: "session", holder: ME });
  });

  it("browser_acquire takes or reports, and browser_release gives back early — a release of nothing is nothing", async () => {
    const harness = portWithHost({ tabs: [state({ tabId: "one", createdBy: "user" })] });

    expect(await harness.port.acquire({ tabId: "one", signal })).toEqual({
      kind: "held",
      tabId: "one",
    });
    // Acquiring what one already holds is the same answer, not a second hold.
    expect(await harness.port.acquire({ tabId: "one", signal })).toEqual({
      kind: "held",
      tabId: "one",
    });
    expect(await harness.portFor(OTHER).acquire({ tabId: "one", signal })).toEqual({
      kind: "refused",
      tabId: "one",
      holder: { kind: "session", sessionId: "ses-me", self: false },
    });

    // Somebody else's release changes nothing; the holder's frees it.
    expect(await harness.portFor(OTHER).release({ tabId: "one", signal })).toEqual({
      tabId: "one",
    });
    expect(harness.holds.get("one")).toEqual({ kind: "session", holder: ME });
    expect(await harness.port.release({ tabId: "one", signal })).toEqual({ tabId: "one" });
    expect(harness.holds.size).toBe(0);
    expect(harness.ended).toEqual(["release:one"]);
    // Releasing a tab one does not hold is the end state asked for.
    expect(await harness.port.release({ tabId: "one", signal })).toEqual({ tabId: "one" });
    expect(harness.ended).toEqual(["release:one"]);
  });

  it("refuses a hold tool call on a tab outside the Session's scope as unknown, and respects the signal", async () => {
    const harness = portWithHost({
      tabs: [state({ tabId: "theirs", createdBy: "session", ticketId: "t2" })],
    });
    expect(await ruleOf(harness.port.acquire({ tabId: "theirs", signal }))).toBe(
      "browser.unknown-tab",
    );
    expect(await ruleOf(harness.port.release({ tabId: "theirs", signal }))).toBe(
      "browser.unknown-tab",
    );
    const withdrawn = new AbortController();
    withdrawn.abort(new Error("turn over"));
    await expect(
      harness.port.acquire({ tabId: "theirs", signal: withdrawn.signal }),
    ).rejects.toThrow("turn over");
    await expect(
      harness.port.release({ tabId: "theirs", signal: withdrawn.signal }),
    ).rejects.toThrow("turn over");
  });

  it("drives the Session cursor for a tab that has one: the glide lands before the click is dispatched", async () => {
    const events: string[] = [];
    const cursorFor = (tabId: string): TabCursorDriver | undefined =>
      tabId === "one"
        ? {
            moveTo: async (point, gesture) => {
              events.push(`move ${gesture} ${point.x},${point.y}`);
            },
            gesture: (kind) => {
              events.push(`gesture ${kind}`);
            },
          }
        : undefined;
    const harness = portWithHost({
      tabs: [
        state({ tabId: "one", createdBy: "user" }),
        state({ tabId: "two", createdBy: "user" }),
      ],
      cursorFor,
    });
    // A transport that records the order of CDP input against the cursor's.
    const transport: CdpTransport = {
      send: async (method, params) => {
        if (method === "Accessibility.getFullAXTree") return BUTTON_TREE;
        if (method === "DOM.getBoxModel")
          return { model: { content: [10, 20, 30, 20, 30, 40, 10, 40] } };
        if (method === "Input.dispatchMouseEvent") {
          events.push(`input ${(params as { type: string }).type}`);
        }
        if (method === "Input.insertText") events.push("input insertText");
        if (method === "Page.getLayoutMetrics") {
          return { cssVisualViewport: { clientWidth: 800, clientHeight: 600 } };
        }
        return {};
      },
    };
    const driven = createAgentBrowserPort({
      host: fakeHost([
        state({ tabId: "one", createdBy: "user" }),
        state({ tabId: "two", createdBy: "user" }),
      ]).host,
      scope: { projectId: "p1", ticketId: "t1" },
      session: ME,
      transportFor: () => transport,
      waitForLoad: async () => undefined,
      holdAwake: () => () => undefined,
      cursorFor,
    });
    void harness;

    // Every act answers with a fresh snapshot, whose refs are renumbered; the
    // next act reads its ref off that answer, the way a model would.
    let snap = await driven.snapshot({ tabId: "one", signal });
    snap = await driven.act({
      tabId: "one",
      generation: snap.generation,
      kind: "click",
      ref: refIn(snap.snapshotText),
      signal,
    });
    snap = await driven.act({
      tabId: "one",
      generation: snap.generation,
      kind: "type",
      ref: refIn(snap.snapshotText),
      text: "hi",
      signal,
    });
    await driven.act({
      tabId: "one",
      generation: snap.generation,
      kind: "scroll",
      direction: "down",
      signal,
    });
    expect(events).toEqual([
      "move click 20,30",
      "input mousePressed",
      "input mouseReleased",
      "move type 20,30",
      "input insertText",
      "gesture null",
      "move scroll 400,300",
      "input mouseWheel",
    ]);

    // A tab with no cursor is driven with no cursor calls at all.
    events.length = 0;
    const other = await driven.snapshot({ tabId: "two", signal });
    await driven.act({
      tabId: "two",
      generation: other.generation,
      kind: "click",
      ref: refIn(other.snapshotText),
      signal,
    });
    expect(events).toEqual(["input mousePressed", "input mouseReleased"]);
  });
});
