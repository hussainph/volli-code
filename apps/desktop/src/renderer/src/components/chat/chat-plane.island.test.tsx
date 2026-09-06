// @vitest-environment jsdom
/**
 * The Activity Island in the chat plane (VC-268): absent while the Session
 * holds nothing, present the moment it holds a Browser Tab, and the interim
 * tab chip gone with it. The island's own behaviour is pinned beside it
 * (`activity-island-ui.test.tsx`); this is the mount.
 *
 * The whole plane, mounted, against a bridge that refuses everything: every
 * renderer read already handles `ok: false`, so an unstubbed channel degrades
 * into the app's real error path rather than a crash — the same reasoning
 * the UI lab's fake bridge records. Only the browser and shells namespaces
 * are real enough to feed the island.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MotionGlobalConfig } from "motion/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { EMPTY_TRANSCRIPT, type ChatSessionTransport } from "@volli/session-presentation";
import type { BrowserTabState } from "../../../../ipc/contract";
import { useBackgroundShellsStore } from "@renderer/stores/background-shells";
import { useBrowserTabsStore } from "@renderer/stores/browser-tabs";
import { createChatSessionsStore } from "@renderer/stores/chat-sessions";
import {
  EMPTY_PROJECT_SESSION_ROWS,
  useProjectSessionsStore,
} from "@renderer/stores/project-sessions";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { ChatPlane } from "./chat-plane";

vi.mock("@renderer/lib/toast", () => ({ toastError: vi.fn() }));

const SESSION = "s1";
const PROJECT = "p1";

const REFUSED = { ok: false, error: "not stubbed" } as const;

/** A bridge that refuses every invoke and subscribes to nothing, by shape. */
function refusingBridge(overrides: Record<string, unknown> = {}): unknown {
  const node = (path: string[]): unknown =>
    new Proxy(() => {}, {
      get(_target, key) {
        if (typeof key !== "string" || key === "then") return undefined;
        const override = path.reduce<unknown>(
          (at, segment) => (at as Record<string, unknown> | undefined)?.[segment],
          overrides,
        ) as Record<string, unknown> | undefined;
        if (override !== undefined && key in override) return override[key];
        return node([...path, key]);
      },
      apply(_target, _this, args) {
        const name = path.at(-1) ?? "";
        if (name.startsWith("on")) return () => {};
        if (name === "pathForFile") return String(args[0]);
        return Promise.resolve(REFUSED);
      },
    });
  return node([]);
}

function tab(over: Partial<BrowserTabState> & { tabId: string }): BrowserTabState {
  return {
    projectId: PROJECT,
    ticketId: null,
    createdBy: "session",
    ownerSessionId: SESSION,
    presentation: "headless",
    url: "https://github.com/",
    title: "GitHub",
    loading: false,
    error: null,
    canGoBack: false,
    canGoForward: false,
    generation: 1,
    heldBy: null,
    ...over,
  };
}

function registry(tabs: readonly BrowserTabState[]): void {
  useBrowserTabsStore.setState({
    byId: Object.fromEntries(tabs.map((one) => [one.tabId, one])),
    hydratedProjects: new Set([PROJECT]),
  });
}

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("api", refusingBridge());
  MotionGlobalConfig.skipAnimations = true;
  registry([]);
  useBackgroundShellsStore.setState({ byId: {}, hydrated: true });
  useProjectSessionsStore.setState({ byProject: { [PROJECT]: EMPTY_PROJECT_SESSION_ROWS } });
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
  MotionGlobalConfig.skipAnimations = false;
  vi.unstubAllGlobals();
});

function chatStore() {
  const store = createChatSessionsStore(() => ({}) as ChatSessionTransport);
  store.setState({
    sessions: {
      [SESSION]: {
        projection: null,
        transcript: EMPTY_TRANSCRIPT,
        lifecycle: "ready",
        sessionError: null,
        queue: [],
      },
    },
  });
  return store;
}

async function mountPlane() {
  const store = chatStore();
  await act(async () => {
    root?.render(
      <TooltipProvider delayDuration={0}>
        <ChatPlane
          sessionId={SESSION}
          projectId={PROJECT}
          ticketId={null}
          onOpenFile={() => {}}
          store={store}
        />
      </TooltipProvider>,
    );
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

const island = () => container?.querySelector("[data-activity-island]") ?? null;

describe("the Activity Island in the chat plane", () => {
  it("is absent while the Session holds nothing, and the interim chip is gone", async () => {
    await mountPlane();

    expect(island()).toBeNull();
    expect(container?.querySelector("[data-browser-tabs-chip]")).toBeNull();
  });

  it("appears above the composer with the Session's one tab, and leaves with it", async () => {
    await mountPlane();
    await act(async () => registry([tab({ tabId: "one" })]));

    const pill = island();
    expect(pill).not.toBeNull();
    expect(
      pill
        ?.querySelector('[data-island-cluster="tabs"] [data-island-count]')
        ?.getAttribute("data-island-count"),
    ).toBe("1");
    // A sibling of the interaction stack, inside the composer's column —
    // never inside the stack, never absorbing it. The stack's origin wraps
    // the composer; the island must be outside it and beside it.
    const origin = container?.querySelector('[data-slot="composer-interaction-origin"]');
    expect(origin).not.toBeNull();
    expect(pill?.closest('[data-slot="composer-interaction-origin"]')).toBeNull();
    expect(origin?.contains(pill)).toBe(false);
    expect(pill?.parentElement?.parentElement?.contains(origin ?? null)).toBe(true);
    expect(container?.querySelector("[data-browser-tabs-chip]")).toBeNull();

    await act(async () => registry([]));
    await settle();
    expect(island()).toBeNull();
  });
});
