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

import type { UIMessage } from "ai";
import type { ChatSessionRecord } from "@volli/shared";
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

const CHILD = "s-child";

function child(over: Partial<ChatSessionRecord> = {}): ChatSessionRecord {
  return {
    sessionId: CHILD,
    title: "Grep the tests",
    projectId: PROJECT,
    ticketId: null,
    createdAt: 0,
    adapterId: "pi",
    live: true,
    activity: "working",
    waitingOn: null,
    outcome: null,
    lastActivityAt: 0,
    bornTicketless: true,
    role: "subagent",
    parentSessionId: SESSION,
    ...over,
  };
}

function listing(chat: readonly ChatSessionRecord[]): void {
  useProjectSessionsStore.setState({
    byProject: { [PROJECT]: { ...EMPTY_PROJECT_SESSION_ROWS, chat } },
  });
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

function chatStore(childMessages: readonly UIMessage[] = []) {
  // A transport that answers nothing: adopting the child seeds its slice and
  // asks the transport to connect, and a connect that never answers leaves
  // the seeded transcript exactly as this test wrote it.
  const store = createChatSessionsStore(
    () => ({ connect: async () => {}, dispose: () => {} }) as unknown as ChatSessionTransport,
  );
  store.setState({
    sessions: {
      [SESSION]: {
        projection: null,
        transcript: EMPTY_TRANSCRIPT,
        lifecycle: "ready",
        sessionError: null,
        queue: [],
      },
      [CHILD]: {
        projection: null,
        transcript: {
          ...EMPTY_TRANSCRIPT,
          durableMessages: childMessages,
          messages: childMessages,
        },
        lifecycle: "ready",
        sessionError: null,
        queue: [],
      },
    },
  });
  return store;
}

async function mountPlane(store = chatStore(), onOpenSession?: (sessionId: string) => void) {
  await act(async () => {
    root?.render(
      <TooltipProvider delayDuration={0}>
        <ChatPlane
          sessionId={SESSION}
          projectId={PROJECT}
          ticketId={null}
          onOpenFile={() => {}}
          store={store}
          {...(onOpenSession === undefined ? {} : { onOpenSession })}
        />
      </TooltipProvider>,
    );
  });
  return store;
}

function click(target: Element): void {
  act(() => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
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

  // VC-269, end to end through the plane: a child appears in the listing,
  // works, finishes; its row peeks the child's own transcript; the peek's
  // promotion goes through the host's door.
  it("shows a subagent working, then done with the flash to say so, peeks it, and promotes it", async () => {
    const onOpenSession = vi.fn();
    const store = await mountPlane(
      chatStore([
        {
          id: "m-child-1",
          role: "assistant",
          parts: [{ type: "text", text: "Found three matching tests." }],
        } as UIMessage,
      ]),
      onOpenSession,
    );
    expect(island()).toBeNull();

    // A child row appears → one working chip.
    await act(async () => listing([child()]));
    const chips = () => island()?.querySelectorAll("[data-agent-state]") ?? [];
    expect(chips()).toHaveLength(1);
    expect(chips()[0]?.getAttribute("data-agent-state")).toBe("working");

    // The child's row goes idle, completed → the chip reads done and the
    // channel says so, in its two registers.
    await act(async () => listing([child({ activity: "idle", outcome: "completed" })]));
    expect(chips()[0]?.getAttribute("data-agent-state")).toBe("done");
    const flash = island()?.querySelector("[data-island-flash]");
    expect(flash?.textContent).toContain("Done");
    expect(flash?.textContent).toContain("Grep the tests");

    // Clicking the row peeks the child: one dialog, holding the child's own
    // transcript, read-only — no composer inside it.
    const cluster = island()?.querySelector('[data-island-cluster="agents"]');
    expect(cluster).not.toBeNull();
    click(cluster!);
    const row = document.body.querySelector<HTMLElement>(`[data-island-row="${CHILD}"]`);
    expect(row).not.toBeNull();
    act(() => row!.focus());
    click(row!);
    await settle();
    const dialogs = document.body.querySelectorAll("[data-subagent-peek-dialog]");
    expect(dialogs).toHaveLength(1);
    const dialog = dialogs[0]!;
    expect(dialog.textContent).toContain("Grep the tests");
    expect(dialog.querySelector("[data-subagent-peek-state]")?.textContent).toBe("done");
    expect(dialog.querySelector("[data-subagent-peek-transcript]")?.textContent).toContain(
      "Found three matching tests.",
    );
    expect(dialog.querySelector("textarea")).toBeNull();

    // The peek's promotion is the host's door, with the child id.
    const openAsTab = [...dialog.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Open as tab"),
    );
    expect(openAsTab).toBeDefined();
    click(openAsTab!);
    expect(onOpenSession).toHaveBeenCalledWith(CHILD);

    // The modal took focus, so the row's card — a popover — dismissed under
    // it: the row is gone. Escape closes the peek, focus returns to the
    // island's agents cluster (the anchor that reopens the card), and the
    // child's client stays resident (closeChatSession is not ref-counted).
    expect(row!.isConnected).toBe(false);
    await act(async () => {
      dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await settle();
    expect(document.body.querySelector("[data-subagent-peek-dialog]")).toBeNull();
    expect(document.activeElement).toBe(cluster);
    expect(store.getState().sessions[CHILD]).toBeDefined();
  });
});
