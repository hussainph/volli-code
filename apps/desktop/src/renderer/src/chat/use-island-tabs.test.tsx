// @vitest-environment jsdom
/**
 * The Browser Tab feed (VC-268): what the island's tabs cluster reads from the
 * live registry, the two verbs its card can call, and the now-channel diff a
 * push cache with no history has to reconstruct render by render.
 *
 * Tested through the hook against the real stores, because the hook IS the
 * seam: what it owes `useActivityIsland` is a slice of the model and a slice
 * of the verbs, and what it owes the person is that a change in the registry
 * becomes exactly one announcement.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { IslandFlash } from "@volli/session-presentation";
import type { BrowserTabState } from "../../../ipc/contract";
import type { BrowserApi } from "@renderer/components/browser/browser-api";
import type { BrowserTraceRequest } from "@renderer/components/browser/browser-trace-model";
import { BROWSER_NEW_TAB_TITLE, useBrowserTabsStore } from "@renderer/stores/browser-tabs";
import { showBrowserTab } from "@renderer/components/browser/show-browser-tab";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useWorkspaceStore } from "@renderer/stores/workspace";
import {
  EMPTY_PROJECT_SESSION_ROWS,
  useProjectSessionsStore,
} from "@renderer/stores/project-sessions";
import { useIslandFlash } from "./use-island-flash";
import {
  islandTabHost,
  useChatBrowserTabs,
  useIslandTabs,
  type ChatBrowserTabs,
  type IslandTabsFeed,
} from "./use-island-tabs";

vi.mock("sonner", () => ({ toast: vi.fn() }));
vi.mock("@renderer/lib/toast", () => ({ toastError: vi.fn() }));
import { toastError } from "@renderer/lib/toast";
import { toast } from "sonner";
import { useClosingBrowserTabIds } from "./use-island-tabs-close";

const SESSION = "s-parent";
const CHILD = "s-child";
const PROJECT = "p1";

function tab(over: Partial<BrowserTabState> & { tabId: string }): BrowserTabState {
  return {
    projectId: PROJECT,
    ticketId: null,
    createdBy: "session",
    ownerSessionId: SESSION,
    presentation: "headless",
    url: "https://github.com/hussainph/volli-code",
    title: "volli-code",
    loading: false,
    error: null,
    canGoBack: false,
    canGoForward: false,
    generation: 1,
    heldBy: null,
    ...over,
  };
}

function api(overrides: Partial<BrowserApi> = {}): BrowserApi {
  return {
    setPresentation: vi.fn(async () => ({ ok: true, tab: tab({ tabId: "a" }) }) as const),
    close: vi.fn(async () => ({ ok: true }) as const),
    ...overrides,
  } as unknown as BrowserApi;
}

/** Puts the registry in one state, the way main's push or hydration would. */
function registry(tabs: readonly BrowserTabState[], hydrated = true): void {
  useBrowserTabsStore.setState({
    byId: Object.fromEntries(tabs.map((one) => [one.tabId, one])),
    hydratedProjects: new Set(hydrated ? [PROJECT] : []),
  });
}

function listing(children: readonly { sessionId: string; title: string }[]): void {
  useProjectSessionsStore.setState({
    byProject: {
      [PROJECT]: {
        ...EMPTY_PROJECT_SESSION_ROWS,
        chat: children.map((child) => ({
          sessionId: child.sessionId,
          title: child.title,
          projectId: PROJECT,
          ticketId: null,
          createdAt: 0,
          adapterId: null,
          live: false,
          activity: "idle",
        })) as never,
        provenance: Object.fromEntries(
          children.map((child) => [
            child.sessionId,
            { kind: "session", parentSessionId: SESSION, parentTitle: "Parent" },
          ]),
        ),
      },
    },
  });
}

/** The project's Session listing not yet answered — the store holds no entry. */
function unlisted(): void {
  useProjectSessionsStore.setState({ byProject: {} });
}

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.mocked(toastError).mockClear();
  vi.mocked(toast).mockClear();
  useClosingBrowserTabIds.setState(new Set(), true);
  registry([]);
  listing([]);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Mounts the feed and reports its latest slice and every flash it pushed. */
async function mount(
  browser: BrowserApi | null = api(),
  openTrace?: (request: BrowserTraceRequest) => void,
  openBrowserBeside?: (tabId: string, ownerSessionId: string) => Promise<void>,
) {
  // `null` is the UI lab: no bridge at all.
  vi.stubGlobal("api", browser === null ? undefined : { browser });
  const seen: { feed: IslandTabsFeed; flash: IslandFlash | null }[] = [];
  const flashes: IslandFlash[] = [];
  function Probe() {
    const channel = useIslandFlash();
    const feed = useIslandTabs(SESSION, PROJECT, channel.push, { openTrace, openBrowserBeside });
    seen.push({ feed, flash: channel.flash });
    if (channel.flash !== null && flashes.at(-1)?.id !== channel.flash.id) {
      flashes.push(channel.flash);
    }
    return null;
  }
  await act(async () => {
    root?.render(<Probe />);
  });
  return {
    latest: () => seen.at(-1)!,
    flashes,
    lines: () => flashes.map((flash) => `${flash.event} · ${flash.payload}`),
  };
}

describe("projection", () => {
  it("projects this Session's tabs and its children's, never a sibling's or a person's", async () => {
    listing([{ sessionId: CHILD, title: "Read the docs" }]);
    registry([
      tab({ tabId: "mine" }),
      tab({ tabId: "childs", ownerSessionId: CHILD, url: "https://motion.dev/docs" }),
      tab({ tabId: "siblings", ownerSessionId: "s-sibling" }),
      tab({ tabId: "persons", ownerSessionId: null, createdBy: "user" }),
    ]);
    const probe = await mount();

    expect(probe.latest().feed.model.tabs.map((one) => one.id)).toEqual(["mine", "childs"]);
  });

  it("names a child's tab by the child's title and this Session's own by nothing", async () => {
    listing([{ sessionId: CHILD, title: "Read the docs" }]);
    registry([
      tab({ tabId: "mine" }),
      tab({ tabId: "childs", ownerSessionId: CHILD }),
      tab({ tabId: "orphan", ownerSessionId: "s-unlisted" }),
    ]);
    // An owner the listing cannot name is still a child by provenance only if
    // the listing says so — an unlisted owner is filtered out with the siblings.
    const probe = await mount();

    expect(probe.latest().feed.model.tabs.map((one) => [one.id, one.owner])).toEqual([
      ["mine", null],
      ["childs", "Read the docs"],
    ]);
  });

  it("treats legacy previews as headless, keeping them listed and showable", async () => {
    registry([
      tab({ tabId: "h" }),
      tab({ tabId: "p", presentation: "preview", loading: true }),
      tab({ tabId: "t", presentation: "tab" }),
    ]);
    const probe = await mount();

    expect(
      probe.latest().feed.model.tabs.map((one) => [one.id, one.promoted, one.surface, one.state]),
    ).toEqual([
      ["h", false, null, "ready"],
      ["p", false, null, "loading"],
      ["t", true, "tab", "ready"],
    ]);
  });

  it("keeps title, port and path distinct, and raises failed and waiting tabs", async () => {
    listing([{ sessionId: CHILD, title: "Driver" }]);
    useProjectSessionsStore.setState((state) => ({
      byProject: {
        ...state.byProject,
        [PROJECT]: {
          ...state.byProject[PROJECT]!,
          chat: state.byProject[PROJECT]!.chat.map((row) =>
            Object.assign({}, row, {
              activity: "waiting" as const,
            }),
          ),
        },
      },
    }));
    registry([
      tab({ tabId: "ordinary", title: "Settings", url: "http://localhost:5173/settings?q=1#top" }),
      tab({ tabId: "failed", error: "net::ERR_FAILED" }),
      tab({
        tabId: "waiting",
        heldBy: { kind: "session", sessionId: CHILD, name: "Driver", color: "red" },
      }),
      tab({
        tabId: "unknown-driver",
        heldBy: { kind: "session", sessionId: "other", name: "Other", color: "red" },
      }),
      tab({ tabId: "local-file", title: "File", url: "file:///tmp/report.html" }),
      tab({ tabId: "bad-url", title: "Broken", url: "not a url" }),
      tab({ tabId: "blank", title: "", url: "about:blank" }),
    ]);
    const probe = await mount();
    const tabs = probe.latest().feed.model.tabs;
    expect(tabs.slice(0, 2).map((row) => row.id)).toEqual(["failed", "waiting"]);
    expect(tabs.find((row) => row.id === "ordinary")).toMatchObject({
      title: "Settings",
      detail: "localhost:5173/settings?q=1#top",
    });
    expect(tabs.find((row) => row.id === "waiting")?.detail).toContain("Driver");
    expect(tabs.find((row) => row.id === "local-file")?.detail).toBe("file:///tmp/report.html");
    expect(tabs.find((row) => row.id === "bad-url")?.detail).toBe("not a url");
    expect(tabs.find((row) => row.id === "blank")?.detail).toBe("New Tab");
  });

  it("keeps the same slice object while the registry says the same thing", async () => {
    registry([tab({ tabId: "mine" })]);
    const probe = await mount();
    const before = probe.latest().feed.model.tabs;

    await act(async () => {
      useBrowserTabsStore.setState({ byId: { ...useBrowserTabsStore.getState().byId } });
    });
    expect(probe.latest().feed.model.tabs).toBe(before);
  });

  it("is empty, and does not throw, where there is no bridge", async () => {
    registry([tab({ tabId: "mine" })]);
    const probe = await mount(null);

    expect(probe.latest().feed.model.tabs).toEqual([]);
    // Both verbs reach no bridge and neither throws — the lab has rows to draw
    // only in its own fixtures, but nothing here may crash on the way out.
    expect(() => probe.latest().feed.actions.closeTab("mine")).not.toThrow();
    expect(() => probe.latest().feed.actions.promoteTab("mine")).not.toThrow();
    expect(probe.flashes).toEqual([]);
    expect(probe.flashes).toEqual([]);
  });
});

describe("the plane's own reading", () => {
  it("shares the transcript host and session titles with the plane", async () => {
    listing([{ sessionId: CHILD, title: "Read the docs" }]);
    registry([tab({ tabId: "mine" }), tab({ tabId: "childs", ownerSessionId: CHILD })]);
    let seen: ChatBrowserTabs | null = null;
    function Probe() {
      seen = useChatBrowserTabs(SESSION, PROJECT);
      return null;
    }
    vi.stubGlobal("api", { browser: api() });
    await act(async () => {
      root?.render(<Probe />);
    });

    const chat = seen as unknown as ChatBrowserTabs;
    expect(chat.cardHost?.sessionId).toBe(SESSION);
    expect(chat.sessionTitle(CHILD)).toBe("Read the docs");
    expect(chat.listed).toBe(true);
  });
});

describe("the host", () => {
  it("names a tab by its hostname first, then its title, then the new-tab name", () => {
    expect(islandTabHost({ url: "https://github.com/hussainph/volli-code", title: "Volli" })).toBe(
      "github.com",
    );
    expect(islandTabHost({ url: "not a url", title: "Local file" })).toBe("Local file");
    expect(islandTabHost({ url: "not a url", title: "   " })).toBe("New Tab");
  });

  it("names a brand-new tab by the new-tab name, never by the start page's scheme", () => {
    // The one string the address bar deliberately hides.
    expect(islandTabHost({ url: "about:blank", title: "" })).toBe("New Tab");
    expect(islandTabHost({ url: "about:blank", title: "about:blank" })).toBe("New Tab");
  });

  it("falls through to the title when the URL parses to no hostname", () => {
    expect(islandTabHost({ url: "file:///tmp/report.html", title: "Report" })).toBe("Report");
  });
});

describe("verbs", () => {
  it("close and promote name the tab they were asked about", async () => {
    const browser = api();
    registry([tab({ tabId: "one" }), tab({ tabId: "two" })]);
    const probe = await mount(browser);

    await act(async () => probe.latest().feed.actions.closeTab("two"));
    expect(probe.latest().feed.model.tabs.map((row) => row.id)).toEqual(["one"]);
    expect(browser.close).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(browser.close).toHaveBeenCalledWith({ tabId: "two" });

    await act(async () => probe.latest().feed.actions.promoteTab("one"));
    expect(browser.setPresentation).toHaveBeenCalledWith({ tabId: "one", presentation: "tab" });
    expect(toastError).not.toHaveBeenCalled();
  });

  it("shows a legacy preview from the Island as a SELECTED tab, without losing its identity", async () => {
    const legacy = tab({ tabId: "legacy", presentation: "preview" });
    registry([legacy]);
    useWorkspaceStore.setState({ byProject: {} });
    // Session attachment is outside this path; the layout and registry are real.
    const adopt = vi
      .spyOn(useChatSessionsStore.getState(), "adoptChatSession")
      .mockImplementation(() => {});
    const browser = api({
      setPresentation: vi.fn(async ({ tabId, presentation }) => ({
        ok: true as const,
        tab: { ...legacy, tabId, presentation },
      })),
    });
    try {
      const probe = await mount(browser, undefined, (tabId) => showBrowserTab(browser, tabId));
      expect(probe.latest().feed.model.tabs).toMatchObject([
        { id: "legacy", promoted: false, surface: null },
      ]);
      await act(async () => probe.latest().feed.actions.promoteTab("legacy"));
      expect(browser.setPresentation).toHaveBeenCalledExactlyOnceWith({
        tabId: "legacy",
        presentation: "tab",
      });
      expect(useBrowserTabsStore.getState().byId.legacy).toEqual({
        ...legacy,
        presentation: "tab",
      });
      expect(probe.latest().feed.model.tabs).toMatchObject([
        { id: "legacy", promoted: true, surface: "tab" },
      ]);
      // Showing is a selection (VC-614): the tab comes forward full width and
      // is never pulled into a group — "Open beside chat" is the grouping door.
      expect(useWorkspaceStore.getState().byProject[PROJECT]?.homeSplitView ?? null).toBeNull();
      expect(useWorkspaceStore.getState().byProject[PROJECT]?.homeActiveTab).toBe("browser:legacy");
    } finally {
      adopt.mockRestore();
      useWorkspaceStore.setState({ byProject: {} });
    }
  });

  it("uses the mount's beside-chat callback with the actual owner, surfacing failure", async () => {
    listing([{ sessionId: CHILD, title: "Driver" }]);
    registry([tab({ tabId: "childs", ownerSessionId: CHILD })]);
    const beside = vi.fn(async () => {});
    const browser = api();
    const probe = await mount(browser, undefined, beside);
    await act(async () => probe.latest().feed.actions.promoteTab("childs"));
    expect(beside).toHaveBeenCalledWith("childs", CHILD);
    expect(browser.setPresentation).not.toHaveBeenCalled();
    beside.mockRejectedValueOnce(new Error("pair refused"));
    await act(async () => probe.latest().feed.actions.promoteTab("childs"));
    expect(toastError).toHaveBeenCalledWith("Could not show Browser Tab: pair refused");
    await act(async () => probe.latest().feed.actions.promoteTab("gone"));
    expect(browser.setPresentation).toHaveBeenCalledWith({ tabId: "gone", presentation: "tab" });
  });

  it("undo keeps an agent's original identity and presentation without opening a replacement", async () => {
    const browser = api();
    registry([tab({ tabId: "one", presentation: "tab" })]);
    const probe = await mount(browser);
    await act(async () => probe.latest().feed.actions.closeTab("one"));
    expect(browser.setPresentation).toHaveBeenCalledWith({
      tabId: "one",
      presentation: "headless",
    });
    expect(probe.latest().feed.model.tabs).toEqual([]);
    const options = vi.mocked(toast).mock.calls.at(-1)?.[1];
    const undo = options?.action;
    expect(undo).toMatchObject({ label: "Undo" });
    await act(async () => {
      if (undo && typeof undo === "object" && "onClick" in undo) undo.onClick({} as never);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(browser.setPresentation).toHaveBeenLastCalledWith({ tabId: "one", presentation: "tab" });
    expect(browser.close).not.toHaveBeenCalled();
    expect(probe.latest().feed.model.tabs.map((row) => row.id)).toEqual(["one"]);
  });

  it("replay opens the tab's OWNER's trace at that tab — a child's tab is the child's record (VC-453)", async () => {
    const openTrace = vi.fn();
    listing([{ sessionId: CHILD, title: "Read the docs" }]);
    registry([tab({ tabId: "one" }), tab({ tabId: "childs", ownerSessionId: CHILD })]);
    const probe = await mount(api(), openTrace);

    probe.latest().feed.actions.replayTab("one");
    probe.latest().feed.actions.replayTab("childs");
    expect(openTrace.mock.calls).toEqual([
      [{ sessionId: SESSION, tabId: "one", pictureId: null }],
      [{ sessionId: CHILD, tabId: "childs", pictureId: null }],
    ]);

    // A tab that has left the registry has no owner to name: nothing opens.
    probe.latest().feed.actions.replayTab("gone");
    expect(openTrace).toHaveBeenCalledTimes(2);
  });

  it("replay opens nowhere, and does not throw, with no replay mounted", async () => {
    registry([tab({ tabId: "one" })]);
    const probe = await mount(api());
    expect(() => probe.latest().feed.actions.replayTab("one")).not.toThrow();
  });

  it("names the refused tab by its host even after the tab has left the registry", async () => {
    const close = vi.fn(async () => ({ ok: false, error: "held elsewhere" }) as const);
    registry([tab({ tabId: "one" })]);
    const probe = await mount(api({ close } as unknown as Partial<BrowserApi>));

    // Main removes the tab while the refusal is still in flight, so the row is
    // gone from the registry by the time the flash is written. The host was
    // read when the press happened, so the line still names what was on screen.
    await act(async () => {
      probe.latest().feed.actions.closeTab("one");
      registry([]);
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(probe.lines()).toContain("Close refused · github.com");
    expect(probe.lines().join(" ")).not.toContain("one");
  });

  it("falls back to the new-tab name for a tab it never saw", async () => {
    const close = vi.fn(async () => ({ ok: false, error: "gone" }) as const);
    registry([tab({ tabId: "one" })]);
    const probe = await mount(api({ close } as unknown as Partial<BrowserApi>));

    await act(async () => probe.latest().feed.actions.closeTab("never-existed"));
    expect(probe.lines().at(-1)).toBe(`Close refused · ${BROWSER_NEW_TAB_TITLE}`);
  });

  it("turns a refusal into a toast and a flash, never a throw", async () => {
    const browser = api({
      close: vi.fn(async () => ({ ok: false, error: "tab is held" }) as const),
      setPresentation: vi.fn(async () => {
        throw new Error("bridge went away");
      }),
    });
    registry([tab({ tabId: "one" })]);
    const probe = await mount(browser);

    await act(async () => {
      probe.latest().feed.actions.closeTab("one");
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(toastError).toHaveBeenCalledWith("Could not close Browser Tab: tab is held");
    expect(probe.lines()).toEqual(["Close refused · github.com"]);

    await act(async () => probe.latest().feed.actions.promoteTab("one"));
    expect(toastError).toHaveBeenCalledWith("Could not show Browser Tab: bridge went away");
    expect(probe.lines().at(-1)).toBe("Show refused · github.com");
  });
});

describe("the now channel", () => {
  it("flashes nothing for the tabs a Session already had when the chat attached", async () => {
    registry([tab({ tabId: "one" }), tab({ tabId: "two" })]);
    const probe = await mount();

    expect(probe.latest().feed.model.tabs).toHaveLength(2);
    expect(probe.flashes).toEqual([]);
  });

  it("flashes nothing for tabs that arrive with the registry's own hydration", async () => {
    // The chat can mount before main has answered the listing. The tabs that
    // arrive with that answer existed all along; only a push after the
    // baseline is news.
    registry([], false);
    const probe = await mount();
    await act(async () => registry([tab({ tabId: "one" })]));
    expect(probe.flashes).toEqual([]);

    await act(async () => registry([tab({ tabId: "one" }), tab({ tabId: "two" })]));
    expect(probe.lines()).toEqual(["Opened · github.com"]);
  });

  it("flashes nothing for a child's tabs when the listing answers after the registry", async () => {
    // The two stores fill from two independent fetches. Here the registry wins
    // the race, so the baseline is taken while the listing still names no
    // children and the child's tab is not yet in the projection. When the
    // listing lands the tab appears — but it was open all along, so it is not
    // news. Baselining on the registry alone announced it as `Opened`.
    unlisted();
    registry([
      tab({ tabId: "mine" }),
      tab({ tabId: "childs", ownerSessionId: CHILD, url: "https://motion.dev/docs" }),
    ]);
    const probe = await mount();
    expect(probe.latest().feed.model.tabs.map((one) => one.id)).toEqual(["mine"]);

    await act(async () => listing([{ sessionId: CHILD, title: "Read the docs" }]));
    expect(probe.latest().feed.model.tabs.map((one) => one.id)).toEqual(["mine", "childs"]);
    expect(probe.flashes).toEqual([]);

    // And the channel is live from there: a tab opened after the baseline is.
    await act(async () =>
      registry([
        tab({ tabId: "mine" }),
        tab({ tabId: "childs", ownerSessionId: CHILD, url: "https://motion.dev/docs" }),
        tab({ tabId: "later", url: "https://esbuild.github.io/" }),
      ]),
    );
    expect(probe.lines()).toEqual(["Opened · esbuild.github.io"]);
  });

  it("announces a tab opening and closing by its host", async () => {
    registry([tab({ tabId: "one" })]);
    const probe = await mount();

    await act(async () =>
      registry([
        tab({ tabId: "one" }),
        tab({ tabId: "two", url: "https://motion.dev/", loading: true, generation: 0 }),
      ]),
    );
    expect(probe.lines()).toEqual(["Opened · motion.dev"]);

    await act(async () => registry([tab({ tabId: "two", url: "https://motion.dev/" })]));
    expect(probe.lines().at(-1)).toBe("Closed · github.com");
  });

  it("flashes Loaded once a navigation that advanced the generation settles", async () => {
    registry([tab({ tabId: "one", generation: 1 })]);
    const probe = await mount();

    // Main bumps the generation when the navigation STARTS; the page is not
    // loaded until loading falls. A settle at the same generation is not news.
    await act(async () => registry([tab({ tabId: "one", generation: 2, loading: true })]));
    expect(probe.flashes).toEqual([]);
    await act(async () => registry([tab({ tabId: "one", generation: 2, loading: false })]));
    expect(probe.lines()).toEqual(["Loaded · github.com"]);

    await act(async () => registry([tab({ tabId: "one", generation: 2, loading: true })]));
    await act(async () => registry([tab({ tabId: "one", generation: 2, loading: false })]));
    expect(probe.lines()).toEqual(["Loaded · github.com"]);
  });

  it("flashes Loaded for a brand-new tab once its first page lands", async () => {
    registry([]);
    const probe = await mount();

    await act(async () =>
      registry([tab({ tabId: "new", url: "https://motion.dev/", loading: true, generation: 0 })]),
    );
    await act(async () =>
      registry([tab({ tabId: "new", url: "https://motion.dev/", loading: true, generation: 1 })]),
    );
    await act(async () =>
      registry([tab({ tabId: "new", url: "https://motion.dev/", loading: false, generation: 1 })]),
    );
    expect(probe.lines()).toEqual(["Opened · motion.dev", "Loaded · motion.dev"]);
  });

  it("flashes Failed when a load errors, and not Loaded on top of it", async () => {
    registry([tab({ tabId: "one", generation: 1 })]);
    const probe = await mount();

    await act(async () => registry([tab({ tabId: "one", generation: 2, loading: true })]));
    await act(async () =>
      registry([tab({ tabId: "one", generation: 2, loading: false, error: "net::ERR_FAILED" })]),
    );
    expect(probe.lines()).toEqual(["Failed · github.com"]);

    // Still failed on the next push is still one failure.
    await act(async () =>
      registry([tab({ tabId: "one", generation: 2, loading: false, error: "net::ERR_FAILED" })]),
    );
    expect(probe.lines()).toEqual(["Failed · github.com"]);
  });

  it("announces where a tab went when its presentation changes", async () => {
    registry([tab({ tabId: "one" })]);
    const probe = await mount();

    await act(async () => registry([tab({ tabId: "one", presentation: "preview" })]));
    await act(async () => registry([tab({ tabId: "one", presentation: "tab" })]));
    await act(async () => registry([tab({ tabId: "one", presentation: "headless" })]));
    expect(probe.lines()).toEqual([
      "Hidden · github.com",
      "Opened as tab · github.com",
      "Hidden · github.com",
    ]);
  });

  it("mints a new id per push, so the same words twice are two announcements", async () => {
    registry([tab({ tabId: "one" })]);
    const probe = await mount();

    await act(async () => registry([tab({ tabId: "one", presentation: "preview" })]));
    await act(async () => registry([tab({ tabId: "one", presentation: "headless" })]));
    await act(async () => registry([tab({ tabId: "one", presentation: "preview" })]));
    const ids = probe.flashes.map((flash) => flash.id);
    expect(new Set(ids).size).toBe(3);
    expect(probe.lines()[2]).toBe("Hidden · github.com");
  });
});
