// @vitest-environment jsdom
/**
 * The seam (VC-268): feeds spread into one model and one set of verbs, the
 * empty rule survives composition, and a feed's flash reaches the model's now
 * channel. The feeds' own rules are tested beside them; this pins only what
 * the composition owes.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ACTIVITY_METADATA_KEY } from "@volli/shared";
import type { UIMessage } from "ai";
import {
  EMPTY_TRANSCRIPT,
  islandEmpty,
  type ChatSessionTransport,
} from "@volli/session-presentation";
import type { BrowserTabState } from "../../../ipc/contract";
import type { BrowserApi } from "@renderer/components/browser/browser-api";
import { useBrowserTabsStore } from "@renderer/stores/browser-tabs";
import { createChatSessionsStore } from "@renderer/stores/chat-sessions";
import {
  EMPTY_PROJECT_SESSION_ROWS,
  useProjectSessionsStore,
} from "@renderer/stores/project-sessions";
import { useActivityIsland, type ActivityIslandBinding } from "./use-activity-island";

vi.mock("@renderer/lib/toast", () => ({ toastError: vi.fn() }));

const SESSION = "s1";
const PROJECT = "p1";

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

function todoCall(todos: readonly { content: string; status: string }[]): UIMessage {
  return {
    id: "m-1",
    role: "assistant",
    parts: [
      {
        type: "dynamic-tool",
        toolName: "volli.activity",
        toolCallId: "call-1",
        state: "output-available",
        input: { todos },
        output: { ok: true },
        toolMetadata: {
          [ACTIVITY_METADATA_KEY]: {
            kind: "plan",
            nativeToolName: "todo_write",
            subject: { label: null, path: null, lineRange: null },
            outcome: null,
            startedAt: null,
            endedAt: null,
          },
        },
      },
    ],
  } as UIMessage;
}

function chatStore(messages: readonly UIMessage[] = []) {
  const store = createChatSessionsStore(() => ({}) as ChatSessionTransport);
  store.setState({
    sessions: {
      [SESSION]: {
        projection: null,
        transcript: { ...EMPTY_TRANSCRIPT, durableMessages: messages },
        lifecycle: "ready",
        sessionError: null,
        queue: [],
      },
    },
  });
  return store;
}

let root: Root | null = null;
let container: HTMLElement | null = null;
let browser: BrowserApi;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  browser = {
    setPresentation: vi.fn(async () => ({ ok: true, tab: tab({ tabId: "a" }) }) as const),
    close: vi.fn(async () => ({ ok: true }) as const),
  } as unknown as BrowserApi;
  vi.stubGlobal("api", { browser });
  registry([]);
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
  vi.unstubAllGlobals();
});

async function mount(store = chatStore()) {
  const seen: ActivityIslandBinding[] = [];
  function Probe() {
    seen.push(useActivityIsland(SESSION, PROJECT, store));
    return null;
  }
  await act(async () => {
    root?.render(<Probe />);
  });
  return { latest: () => seen.at(-1)!, seen };
}

describe("useActivityIsland", () => {
  it("is empty when every feed returns nothing — the empty rule survives composition", async () => {
    const probe = await mount();

    const { model } = probe.latest();
    expect(islandEmpty(model)).toBe(true);
    expect(model).toEqual({ tabs: [], agents: [], plan: null, shells: [], flash: null });
  });

  it("spreads the tab feed's slice and verbs in", async () => {
    registry([tab({ tabId: "one" })]);
    const probe = await mount();

    const { model, actions } = probe.latest();
    expect(islandEmpty(model)).toBe(false);
    expect(model.tabs.map((one) => one.host)).toEqual(["github.com"]);
    expect(model.agents).toEqual([]);
    expect(model.shells).toEqual([]);

    actions.closeTab("one");
    expect(browser.close).toHaveBeenCalledWith({ tabId: "one" });
    actions.promoteTab("one");
    expect(browser.setPresentation).toHaveBeenCalledWith({ tabId: "one", presentation: "preview" });
  });

  it("lights the plan cluster from the Session's transcript", async () => {
    const probe = await mount(
      chatStore([
        todoCall([
          { content: "Read", status: "completed" },
          { content: "Write", status: "in_progress" },
        ]),
      ]),
    );

    expect(probe.latest().model.plan).toMatchObject({
      done: 1,
      steps: [{ title: "Read" }, { title: "Write" }],
    });
  });

  it("carries a feed's flash on the model's now channel", async () => {
    registry([tab({ tabId: "one" })]);
    const probe = await mount();
    expect(probe.latest().model.flash).toBeNull();

    await act(async () => registry([tab({ tabId: "one" }), tab({ tabId: "two" })]));
    expect(probe.latest().model.flash).toMatchObject({ event: "Opened", payload: "github.com" });
  });

  it("keeps the verbs it has no feed for, and none of them throws", async () => {
    const probe = await mount();
    const { actions } = probe.latest();

    for (const verb of [
      "peekAgent",
      "promoteAgent",
      "stopAgent",
      "openShell",
      "killShell",
      "jumpStep",
    ] as const) {
      expect(() => actions[verb]("x")).not.toThrow();
    }
  });

  it("holds one model object while nothing moved", async () => {
    registry([tab({ tabId: "one" })]);
    const probe = await mount();
    const before = probe.latest();

    await act(async () => {
      useBrowserTabsStore.setState({ byId: { ...useBrowserTabsStore.getState().byId } });
    });
    expect(probe.latest().model).toBe(before.model);
    expect(probe.latest().actions).toBe(before.actions);
  });
});
