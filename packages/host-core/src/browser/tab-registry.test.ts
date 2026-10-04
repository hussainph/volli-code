import { BrowserRefusal } from "@volli/agent-runtime";
import type { BrowserTabBounds, BrowserTabState } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import { browserAgentPort } from "./agent-port";
import {
  BROWSER_MAX_TABS_PER_SESSION,
  type BrowserBackend,
  type BrowserLoadWaitMode,
  type BrowserSessionHolder,
  type BrowserTabCreateOptions,
} from "./backend";
import type { CdpTransport } from "./cdp-controller";
import { BrowserPictureStore } from "./picture-store";
import { BrowserTabRegistry, type BrowserTabChrome, type BrowserTabRecord } from "./tab-registry";

/** The page every scripted wire answers with: one button. */
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

interface MemoryEntry extends BrowserTabRecord {
  title: string;
  throttled: boolean;
  offScreen: number;
}

/**
 * The smallest engine a backend can have: tabs in memory, a scripted CDP wire
 * per tab, nothing on screen. It exists to prove the registry is the whole of
 * the policy — every rule below is the shared base's, not this class's.
 */
class MemoryBackend extends BrowserTabRegistry<MemoryEntry> {
  readonly calls: string[] = [];
  readonly sent: string[] = [];
  #nextId = 0;

  constructor() {
    super({
      createId: () => `tab-${++this.#nextId}`,
      publishState: () => undefined,
      publishClosed: () => undefined,
      pictures: new BrowserPictureStore({ createId: () => "picture", now: () => 0 }),
    });
  }

  entry(tabId: string): MemoryEntry {
    return this.requireTab(tabId);
  }

  open(input: BrowserTabCreateOptions): BrowserTabState {
    this.assertCapacity(input);
    const tabId = this.deps.createId();
    const entry: MemoryEntry = {
      state: this.newTabState(tabId, input),
      console: [],
      consoleTruncated: false,
      wakeLeases: 0,
      hold: null,
      title: "Fixture",
      throttled: true,
      offScreen: 0,
    };
    this.tabs.set(tabId, entry);
    this.publish(entry, { loading: false });
    return { ...entry.state };
  }

  close(tabId: string): void {
    this.forgetEntry(tabId, this.requireTab(tabId));
  }

  navigate(tabId: string, url: string): BrowserTabState {
    const entry = this.requireTab(tabId);
    this.beginProductNavigation(entry, url);
    this.publish(entry, { loading: false });
    return { ...entry.state };
  }

  back(tabId: string): BrowserTabState {
    return { ...this.requireTab(tabId).state };
  }

  forward(tabId: string): BrowserTabState {
    return { ...this.requireTab(tabId).state };
  }

  reload(tabId: string): BrowserTabState {
    return this.navigate(tabId, this.requireTab(tabId).state.url);
  }

  closeAll(): void {
    for (const tabId of this.tabs.keys()) this.close(tabId);
  }

  setBounds(tabId: string, _bounds: BrowserTabBounds): void {
    this.requireTab(tabId);
  }

  async capturePicture(): Promise<string | null> {
    return null;
  }

  transportFor(tabId: string): CdpTransport {
    this.requireTab(tabId);
    this.calls.push(`transport:${tabId}`);
    return {
      send: async (method) => {
        this.sent.push(method);
        return method === "Accessibility.getFullAXTree" ? BUTTON_TREE : {};
      },
    };
  }

  async waitForLoad(tabId: string, signal: AbortSignal, mode?: BrowserLoadWaitMode): Promise<void> {
    signal.throwIfAborted();
    this.calls.push(`wait:${tabId}:${mode ?? "current"}`);
  }

  protected liveChrome(entry: MemoryEntry): BrowserTabChrome {
    return {
      url: "",
      title: entry.title,
      loading: entry.state.loading,
      canGoBack: false,
      canGoForward: false,
    };
  }

  protected applyWakePolicy(entry: MemoryEntry): void {
    entry.throttled = entry.wakeLeases === 0;
    this.calls.push(`wake:${entry.state.tabId}:${entry.wakeLeases}`);
  }

  protected goOffScreen(entry: MemoryEntry): void {
    entry.offScreen += 1;
  }
}

const ME: BrowserSessionHolder = { sessionId: "ses-me", attachmentId: "att-me" };
const OTHER: BrowserSessionHolder = { sessionId: "ses-other", attachmentId: "att-other" };
const SCOPE = { projectId: "p1", ticketId: "t1" };

function sessionTab(owner: string, url = "https://example.com/"): BrowserTabCreateOptions {
  return { url, projectId: "p1", ticketId: "t1", createdBy: "session", ownerSessionId: owner };
}

describe("BrowserTabRegistry (VC-561)", () => {
  it("decides ownership at birth, and reads the engine's chrome on every publish", () => {
    const backend = new MemoryBackend();
    const agent = backend.open(sessionTab(ME.sessionId));
    expect(agent).toMatchObject({
      createdBy: "session",
      ownerSessionId: ME.sessionId,
      presentation: "headless",
      // The engine's empty URL never erases the one the tab was opened at.
      url: "https://example.com/",
      title: "Fixture",
      generation: 0,
      heldBy: null,
    });
    const person = backend.open({
      url: "https://example.com/mine",
      projectId: "p1",
      ticketId: null,
      createdBy: "user",
    });
    expect(person).toMatchObject({ createdBy: "user", ownerSessionId: null, presentation: "tab" });

    backend.entry(agent.tabId).title = "  Renamed\n page ";
    expect(backend.navigate(agent.tabId, "https://example.com/next")).toMatchObject({
      url: "https://example.com/next",
      title: "Renamed page",
      generation: 1,
    });
  });

  it("asks the engine to take a tab off screen when it goes headless or loses the preview", () => {
    const backend = new MemoryBackend();
    const first = backend.open(sessionTab(ME.sessionId));
    const second = backend.open(sessionTab(ME.sessionId));
    backend.setPresentation(first.tabId, "preview");
    expect(backend.entry(first.tabId).offScreen).toBe(0);
    backend.setPresentation(second.tabId, "preview");
    expect(backend.entry(first.tabId)).toMatchObject({
      offScreen: 1,
      state: { presentation: "headless" },
    });
    backend.setPresentation(second.tabId, "headless");
    expect(backend.entry(second.tabId).offScreen).toBe(1);
    const person = backend.open({
      ...sessionTab(ME.sessionId),
      createdBy: "user",
      ownerSessionId: null,
    });
    expect(() => backend.setPresentation(person.tabId, "headless")).toThrow(
      /Session's Browser Tab/,
    );
  });

  it("applies the engine's wake policy on the first lease and the last release only", () => {
    const backend = new MemoryBackend();
    const tab = backend.open(sessionTab(ME.sessionId));
    const first = backend.holdAwake(tab.tabId);
    const second = backend.holdAwake(tab.tabId);
    first();
    first();
    expect(backend.entry(tab.tabId).throttled).toBe(false);
    second();
    expect(backend.entry(tab.tabId).throttled).toBe(true);
    expect(backend.calls.filter((call) => call.startsWith("wake:"))).toEqual([
      `wake:${tab.tabId}:1`,
      `wake:${tab.tabId}:0`,
    ]);
    expect(backend.holdAwake("gone")).toBeTypeOf("function");
  });
});

describe("browserAgentPort over a backend (VC-561)", () => {
  it("binds the backend's own wire, load wait and wake hold, and the registry's holds and caps", async () => {
    const backend: MemoryBackend & BrowserBackend = new MemoryBackend();
    const port = browserAgentPort({ backend, scope: SCOPE, session: ME, cursorFor: undefined });
    const signal = new AbortController().signal;

    const born = await port.navigate({
      navigation: { kind: "url", url: "https://example.com/" },
      signal,
    });
    expect(born).toMatchObject({ ownerSessionId: ME.sessionId, generation: 0 });
    expect(born.snapshotText).toContain('button "Save" [ref=e1]');
    expect(backend.calls).toEqual([
      `wake:${born.tabId}:1`,
      `wait:${born.tabId}:required-navigation`,
      `transport:${born.tabId}`,
    ]);
    expect(backend.sent).toContain("Accessibility.getFullAXTree");
    expect(backend.heldBy(born.tabId)).toMatchObject({ kind: "session", sessionId: ME.sessionId });

    // Another Session cannot see this tab at all; one that could would be
    // refused by the registry's hold, named.
    const other = browserAgentPort({
      backend,
      scope: SCOPE,
      session: OTHER,
      cursorFor: undefined,
      sharesTabsOf: () => true,
    });
    await expect(
      other.act({ tabId: born.tabId, generation: 0, kind: "click", ref: "e1", signal }),
    ).rejects.toMatchObject({ rule: "browser.tab-held" });

    for (let opened = 1; opened < BROWSER_MAX_TABS_PER_SESSION; opened += 1) {
      backend.open(sessionTab(ME.sessionId));
    }
    const refused = port.navigate({
      navigation: { kind: "url", url: "https://example.com/seventh" },
      signal,
    });
    await expect(refused).rejects.toBeInstanceOf(BrowserRefusal);
    await expect(refused).rejects.toMatchObject({ rule: "browser.session-tab-limit" });

    port.dispose();
    await expect.poll(() => backend.list({ projectId: "p1" }).length).toBe(0);
    expect(() => backend.entry(born.tabId)).toThrow("Unknown Browser Tab");
  });
});
