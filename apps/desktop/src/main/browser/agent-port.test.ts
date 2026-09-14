import { BrowserRefusal } from "@volli/agent-runtime";
import { describe, expect, it, vi } from "vite-plus/test";

import type { BrowserTabHolder } from "@volli/shared";
import type { BrowserTabState } from "../../ipc/contract";
import {
  createAgentBrowserPort,
  debuggerTransport,
  loadWaiter,
  type AgentBrowserHost,
} from "./agent-port";
import { BrowserAgentCoordinator } from "./agent-coordinator";
import type { CdpTransport, TabCursorDriver } from "./cdp-controller";
import { BrowserSessionTabLimitError, type BrowserSessionHolder } from "./tab-host";

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

const BUTTON_BOX = { model: { content: [10, 20, 30, 20, 30, 40, 10, 40] } };

function state(overrides: Partial<BrowserTabState> & { tabId: string }): BrowserTabState {
  const createdBy = overrides.createdBy ?? "user";
  return {
    projectId: "p1",
    ticketId: null,
    createdBy,
    // An agent tab defaults to THIS port's Session so existing fixtures that
    // only said `createdBy: "session"` still describe the Session's own tab.
    ownerSessionId: createdBy === "session" ? ME.sessionId : null,
    presentation: createdBy === "session" ? "headless" : "tab",
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
type OpenedRecord = {
  url: string;
  projectId: string;
  ticketId: string | null;
  createdBy: string;
  ownerSessionId?: string | null;
};

function fakeHost(
  initial: BrowserTabState[],
  options: {
    sessionCap?: number;
    declineCapture?: boolean;
    console?: Record<string, { level: "warn" | "error"; text: string }[]>;
  } = {},
): {
  host: AgentBrowserHost;
  tabs: Map<string, BrowserTabState>;
  opened: OpenedRecord[];
  navigated: { tabId: string; url: string }[];
  closedHeadlessFor: string[];
  captures: string[];
  /** The hold table, with the real host's rules: holder or person or nobody. */
  holds: Map<string, { kind: "session"; holder: BrowserSessionHolder } | { kind: "person" }>;
  /** Every hold end, as `why:tabId`, in order. */
  ended: string[];
} {
  const tabs = new Map(initial.map((one) => [one.tabId, one]));
  const opened: OpenedRecord[] = [];
  const navigated: { tabId: string; url: string }[] = [];
  const closedHeadlessFor: string[] = [];
  const captures: string[] = [];
  const holds = new Map<
    string,
    { kind: "session"; holder: BrowserSessionHolder } | { kind: "person" }
  >();
  const ended: string[] = [];
  const agentOperations = new BrowserAgentCoordinator();
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
    closedHeadlessFor,
    captures,
    holds,
    ended,
    host: {
      agentOperations,
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
        for (const tabId of closing) {
          tabs.delete(tabId);
          agentOperations.closeTab(tabId);
        }
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
      consoleOf: (tabId) => ({
        messages: (options.console ?? {})[tabId] ?? [],
        truncated: false,
      }),
    },
  };
}

function transportFor(): CdpTransport {
  return {
    send: async (method) => {
      if (method === "Accessibility.getFullAXTree") return BUTTON_TREE;
      if (method === "DOM.getBoxModel")
        return { model: { content: [10, 20, 30, 20, 30, 40, 10, 40] } };
      if (method === "Page.captureScreenshot") return { data: "iVBORw0KGgoAAAANSUhEUgAABkAAAASw" };
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
  /** The attachment the harness's default port speaks for; {@link ME} unless said. */
  session?: BrowserSessionHolder;
  sessionCap?: number;
  declineCapture?: boolean;
  console?: Record<string, { level: "warn" | "error"; text: string }[]>;
  sharesTabsOf?: (ownerSessionId: string) => boolean;
  cursorFor?: (tabId: string) => TabCursorDriver | undefined;
}

function port(input: PortInput): ReturnType<typeof portWithHost>["port"] {
  return portWithHost(input).port;
}

interface PortHarness {
  port: ReturnType<typeof createAgentBrowserPort>;
  opened: ReturnType<typeof fakeHost>["opened"];
  hostTabs: Map<string, BrowserTabState>;
  holds: ReturnType<typeof fakeHost>["holds"];
  ended: string[];
  closedHeadlessFor: string[];
  captures: string[];
  /** Every hold, wait and release, in the order the port performed them. */
  wakeEvents: string[];
  /** A second port over the SAME host, speaking for another attachment. */
  portFor(
    session: BrowserSessionHolder,
    cursorFor?: (tabId: string) => TabCursorDriver,
  ): ReturnType<typeof createAgentBrowserPort>;
}

function portWithHost(input: PortInput): PortHarness {
  const { host, opened, tabs, holds, ended, closedHeadlessFor, captures } = fakeHost(
    input.tabs ?? [],
    {
      ...(input.sessionCap === undefined ? {} : { sessionCap: input.sessionCap }),
      ...(input.declineCapture === undefined ? {} : { declineCapture: input.declineCapture }),
      ...(input.console === undefined ? {} : { console: input.console }),
    },
  );
  const wakeEvents: string[] = [];
  const portFor = (
    session: BrowserSessionHolder,
    cursorFor = input.cursorFor,
  ): ReturnType<typeof createAgentBrowserPort> =>
    createAgentBrowserPort({
      host,
      scope: { projectId: "p1", ticketId: input.ticketId === undefined ? "t1" : input.ticketId },
      session,
      ...(input.sharesTabsOf === undefined ? {} : { sharesTabsOf: input.sharesTabsOf }),
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
    closedHeadlessFor,
    captures,
    wakeEvents,
    portFor,
    port: portFor(input.session ?? ME),
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
        ownerSessionId: ME.sessionId,
      },
    ]);
    expect(project.opened).toEqual([
      {
        url: "https://example.com/research",
        projectId: "p1",
        ticketId: null,
        createdBy: "session",
        ownerSessionId: ME.sessionId,
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
    expect(listing.tabs.find((tab) => tab.tabId === "mine")?.ownerSessionId).toBe(ME.sessionId);
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
      scope: { projectId: "p1", ticketId: "t1" },
      session: ME,
      sharesTabsOf: (owner) => owner === "s-child",
      transportFor,
      waitForLoad: async () => undefined,
      holdAwake: () => () => undefined,
    });

    const listing = await shared.tabs({ signal });

    expect(listing.tabs.map((tab) => tab.tabId)).toEqual(["child"]);
    // Visibility is actuation, not only reading: a shared tab can be driven,
    // and a tab the predicate excludes still refuses as unknown.
    const seen = await shared.snapshot({ tabId: "child", signal });
    const acted = await shared.act({
      tabId: "child",
      generation: seen.generation,
      kind: "click",
      ref: "e1",
      signal,
    });
    expect(acted.target).toEqual({ ref: "e1", name: "Save" });
    await expect(
      shared.snapshot({ tabId: "stranger", signal }).catch((error: BrowserRefusal) => error.rule),
    ).resolves.toBe("browser.unknown-tab");
  });

  it("carries the tab's owner and its load failure on every answer, so the card need not guess", async () => {
    const broken = portWithHost({
      tabs: [
        state({
          tabId: "mine",
          createdBy: "session",
          ticketId: "t1",
          title: "Broken",
          error: "Could not load page: ERR_NAME_NOT_RESOLVED",
        }),
      ],
      console: { mine: [{ level: "error", text: "boom" }] },
    });

    const read = await broken.port.snapshot({ tabId: "mine", signal });
    const shot = await broken.port.screenshot({ tabId: "mine", signal });
    const logged = await broken.port.console({ tabId: "mine", signal });

    for (const answer of [read, shot, logged]) {
      expect(answer).toMatchObject({
        tabId: "mine",
        title: "Broken",
        ownerSessionId: ME.sessionId,
        error: "Could not load page: ERR_NAME_NOT_RESOLVED",
      });
    }
  });

  it("reports a person's tab as unowned and healthy, which is what makes the owner field worth reading", async () => {
    const mixed = portWithHost({ tabs: [state({ tabId: "user-1", createdBy: "user" })] });

    const read = await mixed.port.snapshot({ tabId: "user-1", signal });

    expect(read.ownerSessionId).toBeNull();
    expect(read.error).toBeNull();
  });

  it("tells a refusal which page it was aimed at, so a refused act still names its tab", async () => {
    const driven = portWithHost({
      tabs: [
        state({
          tabId: "mine",
          createdBy: "session",
          ticketId: "t1",
          url: "https://example.com/sign-in",
          title: "Sign in",
          generation: 4,
        }),
      ],
    });

    // A stale generation is refused deep in the controller, which knows the
    // rule and nothing about the tab.
    const refusal = await driven.port
      .act({ tabId: "mine", generation: 1, kind: "click", ref: "e1", signal })
      .catch((error: BrowserRefusal) => error);

    expect(refusal).toBeInstanceOf(BrowserRefusal);
    expect((refusal as BrowserRefusal).rule).toBe("browser.stale-ref");
    expect((refusal as BrowserRefusal).page).toEqual({
      tabId: "mine",
      url: "https://example.com/sign-in",
      title: "Sign in",
      ownerSessionId: ME.sessionId,
      error: null,
    });
  });

  it("leaves a refusal raised before any tab was in hand without a page to name", async () => {
    const refusal = await port({})
      .navigate({ navigation: { kind: "url", url: "file:///etc/passwd" }, signal })
      .catch((error: BrowserRefusal) => error);

    expect((refusal as BrowserRefusal).page).toBeNull();
  });

  it("photographs a tab it opened this call, not only one it was handed", async () => {
    const fresh = portWithHost({});

    const opened = await fresh.port.navigate({
      navigation: { kind: "url", url: "https://example.com/new" },
      signal,
    });

    expect(fresh.captures).toEqual(["opened-1"]);
    expect(opened.picture).toBe("live:opened-1:1");
    expect(opened.ownerSessionId).toBe(ME.sessionId);
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

    // The Session's OWN id, not the Ticket's: the assertion that fails if
    // dispose stops calling the host, or confuses the two scopes. Which tabs
    // that closes is the host's rule, proved against the real host in
    // tab-host.test.ts rather than against this fake's copy of it.
    expect(ending.closedHeadlessFor).toEqual([ME.sessionId]);
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

  it.each(["destroyed", "render-process-gone", "abort", "gap"])(
    "ends a load wait on %s and removes every listener",
    async (end) => {
      vi.useFakeTimers();
      try {
        const listeners = new Map<string, () => void>();
        let reads = 0;
        const contents = {
          isLoading: () => ++reads === 1 || end !== "gap",
          on: (event: string, listener: () => void) => listeners.set(event, listener),
          removeListener: (event: string) => listeners.delete(event),
        };
        const abort = new AbortController();
        const pending = loadWaiter(() => contents as never)("one", abort.signal);
        if (end === "abort") abort.abort();
        else if (end !== "gap") listeners.get(end)?.();
        await pending;
        expect(listeners.size).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("does not resume debugger initialization after disposal", async () => {
    const domain = Promise.withResolvers<unknown>();
    let attached = false;
    const sendCommand = vi.fn(() => domain.promise);
    const transport = debuggerTransport({
      debugger: {
        isAttached: () => attached,
        attach: () => {
          attached = true;
        },
        detach: () => {
          attached = false;
        },
        sendCommand,
      },
    } as never);
    const pending = transport.send("Accessibility.getFullAXTree");
    transport.dispose?.();
    domain.resolve({});
    await expect(pending).rejects.toThrow(/disposed/i);
    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(attached).toBe(false);
    await expect(transport.send("Page.enable")).rejects.toThrow(/disposed/i);
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
      ownerSessionId: null,
      error: null,
      base64Png: "iVBORw0KGgoAAAANSUhEUgAABkAAAASw",
      // The same bytes, kept for the person (VC-238): the tool description
      // promises the picture to both parties, and the id is how the card gets it.
      picture: "kept:user-1:iVBORw0KGgoAAAANSUhEUgAABkAAAASw",
      width: 1600,
      height: 1200,
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

describe("Browser port concurrent calls and teardown", () => {
  function harness() {
    const host = fakeHost([state({ tabId: "one" }), state({ tabId: "two" })]).host;
    const ready = Promise.withResolvers<void>();
    const disposed = vi.fn();
    const base = transportFor();
    const send = vi.fn(base.send);
    const createTransport = vi.fn(() => ({
      ...base,
      send,
      ensureReady: () => ready.promise,
      dispose: disposed,
    }));
    const browser = createAgentBrowserPort({
      host,
      scope: { projectId: "p1", ticketId: null },
      session: ME,
      transportFor: createTransport,
      waitForLoad: async () => undefined,
      holdAwake: () => () => undefined,
    });
    return { port: browser, ready, disposed, createTransport, send, host };
  }

  it("serializes one tab's snapshots without duplicating controllers or reusing refs", async () => {
    const h = harness();
    const first = h.port.snapshot({ tabId: "one", signal });
    const second = h.port.snapshot({ tabId: "one", signal });
    await vi.waitFor(() => expect(h.createTransport).toHaveBeenCalled());
    h.ready.resolve();
    const [a, b] = await Promise.all([first, second]);
    expect(h.createTransport).toHaveBeenCalledTimes(1);
    expect(refIn(a.snapshotText)).not.toBe(refIn(b.snapshotText));
    h.port.dispose();
    expect(h.disposed).toHaveBeenCalledTimes(1);
  });

  it("keeps different tabs concurrent", async () => {
    const h = harness();
    const first = h.port.snapshot({ tabId: "one", signal });
    const second = h.port.snapshot({ tabId: "two", signal });
    await vi.waitFor(() => expect(h.createTransport).toHaveBeenCalledTimes(2));
    h.ready.resolve();
    await Promise.all([first, second]);
    h.port.dispose();
  });

  it("withdraws queued work without letting the next call jump the running call", async () => {
    const h = harness();
    const first = h.port.snapshot({ tabId: "one", signal });
    const cancelled = new AbortController();
    const second = h.port.snapshot({ tabId: "one", signal: cancelled.signal });
    const rejected = expect(second).rejects.toThrow("withdrawn");
    const third = h.port.snapshot({ tabId: "one", signal });
    cancelled.abort(new Error("withdrawn"));
    await rejected;
    h.ready.resolve();
    const [a, c] = await Promise.all([first, third]);
    expect(h.createTransport).toHaveBeenCalledTimes(1);
    expect(refIn(a.snapshotText)).not.toBe(refIn(c.snapshotText));
    expect(
      h.send.mock.calls.filter(([method]) => method === "Accessibility.getFullAXTree"),
    ).toHaveLength(2);
    h.port.dispose();
  });

  it("shares one debugger transport and one queue across two Session ports on the same tab", async () => {
    const shared = fakeHost([state({ tabId: "one", createdBy: "user" })]);
    const firstSnapshot = Promise.withResolvers<void>();
    let snapshotsStarted = 0;
    let snapshotsActive = 0;
    let maximumActive = 0;
    const disposed = vi.fn();
    const createTransport = vi.fn((): CdpTransport => ({
      send: async (method) => {
        if (method === "Accessibility.getFullAXTree") {
          snapshotsStarted += 1;
          snapshotsActive += 1;
          maximumActive = Math.max(maximumActive, snapshotsActive);
          if (snapshotsStarted === 1) await firstSnapshot.promise;
          snapshotsActive -= 1;
          return BUTTON_TREE;
        }
        return {};
      },
      dispose: disposed,
    }));
    const makePort = (session: BrowserSessionHolder) =>
      createAgentBrowserPort({
        host: shared.host,
        scope: { projectId: "p1", ticketId: null },
        session,
        transportFor: createTransport,
        waitForLoad: async () => undefined,
        holdAwake: () => () => undefined,
      });
    const a = makePort(ME);
    const b = makePort(OTHER);

    const aSnapshot = a.snapshot({ tabId: "one", signal });
    await vi.waitFor(() => expect(snapshotsStarted).toBe(1));
    const bSnapshot = b.snapshot({ tabId: "one", signal });
    await Promise.resolve();
    expect(snapshotsStarted).toBe(1);
    firstSnapshot.resolve();
    const [fromA, fromB] = await Promise.all([aSnapshot, bSnapshot]);

    expect(maximumActive).toBe(1);
    expect(createTransport).toHaveBeenCalledTimes(1);
    // Ref maps stay attachment-local even though their wire is shared.
    expect(refIn(fromA.snapshotText)).toBe("e1");
    expect(refIn(fromB.snapshotText)).toBe("e1");

    a.dispose();
    expect(disposed).not.toHaveBeenCalled();
    await expect(b.snapshot({ tabId: "one", signal })).resolves.toMatchObject({ tabId: "one" });
    b.dispose();
    expect(disposed).toHaveBeenCalledTimes(1);
  });

  it("keeps the hold until an aborted active click has released its mouse button", async () => {
    const shared = fakeHost([state({ tabId: "one", createdBy: "user" })]);
    const release = Promise.withResolvers<void>();
    const abort = new AbortController();
    let releaseStarted = false;
    const browser = createAgentBrowserPort({
      host: shared.host,
      scope: { projectId: "p1", ticketId: null },
      session: ME,
      transportFor: () => ({
        send: async (method, params) => {
          if (method === "Accessibility.getFullAXTree") return BUTTON_TREE;
          if (method === "DOM.getBoxModel") return BUTTON_BOX;
          const type = (params as { type?: string } | undefined)?.type;
          if (type === "mousePressed") {
            abort.abort(new Error("withdrawn"));
            return await new Promise<never>(() => undefined);
          }
          if (type === "mouseReleased") {
            releaseStarted = true;
            await release.promise;
          }
          return {};
        },
      }),
      waitForLoad: async () => undefined,
      holdAwake: () => () => undefined,
    });
    const snapshot = await browser.snapshot({ tabId: "one", signal });
    const acting = browser.act({
      tabId: "one",
      generation: snapshot.generation,
      kind: "click",
      ref: refIn(snapshot.snapshotText),
      signal: abort.signal,
    });
    await vi.waitFor(() => expect(releaseStarted).toBe(true));

    browser.turnEnded();
    expect(shared.holds.get("one")).toEqual({ kind: "session", holder: ME });
    expect(shared.ended).toEqual([]);

    release.resolve();
    await expect(acting).rejects.toThrow("withdrawn");
    await vi.waitFor(() => expect(shared.holds.has("one")).toBe(false));
    expect(shared.ended).toEqual(["turn-end:one"]);
    browser.dispose();
  });

  it("does not detach the debugger or end the attachment during active input cleanup", async () => {
    const shared = fakeHost([state({ tabId: "one", createdBy: "user" })]);
    const release = Promise.withResolvers<void>();
    const disposed = vi.fn();
    let releaseStarted = false;
    const browser = createAgentBrowserPort({
      host: shared.host,
      scope: { projectId: "p1", ticketId: null },
      session: ME,
      transportFor: () => ({
        send: async (method, params) => {
          if (method === "Accessibility.getFullAXTree") return BUTTON_TREE;
          if (method === "DOM.getBoxModel") return BUTTON_BOX;
          const type = (params as { type?: string } | undefined)?.type;
          if (type === "mousePressed") return await new Promise<never>(() => undefined);
          if (type === "mouseReleased") {
            releaseStarted = true;
            await release.promise;
          }
          return {};
        },
        dispose: disposed,
      }),
      waitForLoad: async () => undefined,
      holdAwake: () => () => undefined,
    });
    const snapshot = await browser.snapshot({ tabId: "one", signal });
    const acting = browser.act({
      tabId: "one",
      generation: snapshot.generation,
      kind: "click",
      ref: refIn(snapshot.snapshotText),
      signal,
    });
    await vi.waitFor(() => expect(shared.holds.has("one")).toBe(true));

    browser.dispose();
    await vi.waitFor(() => expect(releaseStarted).toBe(true));
    expect(disposed).not.toHaveBeenCalled();
    expect(shared.ended).toEqual([]);
    expect(shared.closedHeadlessFor).toEqual([]);

    release.resolve();
    await expect(acting).rejects.toThrow(/disposed/i);
    await vi.waitFor(() => expect(disposed).toHaveBeenCalledTimes(1));
    expect(shared.ended).toEqual(["attachment-end:one", "forget:ses-me"]);
    expect(shared.closedHeadlessFor).toEqual([ME.sessionId]);
  });

  it("disposal withdraws readiness and prevents later calls resurrecting the port", async () => {
    const h = harness();
    const first = h.port.snapshot({ tabId: "one", signal });
    const rejected = expect(first).rejects.toThrow(/disposed/i);
    await vi.waitFor(() => expect(h.createTransport).toHaveBeenCalledTimes(1));
    h.port.dispose();
    await rejected;
    h.ready.resolve();
    await expect(h.port.snapshot({ tabId: "one", signal })).rejects.toThrow(/disposed/i);
    expect(h.disposed).toHaveBeenCalledTimes(1);
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
      // Another SESSION's tab, which is what puts it out of scope since
      // VC-238: visibility follows ownership, not the Ticket.
      tabs: [
        state({
          tabId: "theirs",
          createdBy: "session",
          ticketId: "t2",
          ownerSessionId: OTHER.sessionId,
        }),
      ],
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
