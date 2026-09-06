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
import { useBrowserTabsStore } from "@renderer/stores/browser-tabs";
import {
  EMPTY_PROJECT_SESSION_ROWS,
  useProjectSessionsStore,
} from "@renderer/stores/project-sessions";
import { useIslandFlash } from "./use-island-flash";
import { islandTabHost, useIslandTabs, type IslandTabsFeed } from "./use-island-tabs";

vi.mock("@renderer/lib/toast", () => ({ toastError: vi.fn() }));
import { toastError } from "@renderer/lib/toast";

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

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(toastError).mockClear();
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
  vi.unstubAllGlobals();
});

/** Mounts the feed and reports its latest slice and every flash it pushed. */
async function mount(browser: BrowserApi | null = api()) {
  // `null` is the UI lab: no bridge at all.
  vi.stubGlobal("api", browser === null ? undefined : { browser });
  const seen: { feed: IslandTabsFeed; flash: IslandFlash | null }[] = [];
  const flashes: IslandFlash[] = [];
  function Probe() {
    const channel = useIslandFlash();
    const feed = useIslandTabs(SESSION, PROJECT, channel.push);
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

  it("tells headless from the two promoted places, and loading from ready", async () => {
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
      ["p", true, "preview", "loading"],
      ["t", true, "tab", "ready"],
    ]);
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
    expect(() => probe.latest().feed.actions.closeTab("mine")).not.toThrow();
    expect(probe.flashes).toEqual([]);
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
    expect(browser.close).toHaveBeenCalledWith({ tabId: "two" });

    await act(async () => probe.latest().feed.actions.promoteTab("one"));
    expect(browser.setPresentation).toHaveBeenCalledWith({ tabId: "one", presentation: "preview" });
    expect(toastError).not.toHaveBeenCalled();
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

    await act(async () => probe.latest().feed.actions.closeTab("one"));
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
      "Pinned here · github.com",
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
    expect(probe.lines()[2]).toBe("Pinned here · github.com");
  });
});
