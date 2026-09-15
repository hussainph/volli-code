// @vitest-environment jsdom
/**
 * The plane's answer to "no messages yet" (VC-383).
 *
 * Three Sessions hold no messages for three different reasons, and the plane
 * must tell them apart: one whose history is still on its way (the snapshot
 * round trip), one that is a provisional Draft nothing has been said in, and
 * one that was opened and found genuinely empty. Only the first is a wait, and
 * it used to draw the empty state's venue picture — a statement that nothing
 * was ever said, made about a Session that may hold a thousand turns.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MotionGlobalConfig } from "motion/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { UIMessage } from "ai";
import { EMPTY_TRANSCRIPT, type ChatSessionTransport } from "@volli/session-presentation";
import { useBackgroundShellsStore } from "@renderer/stores/background-shells";
import { useBrowserTabsStore } from "@renderer/stores/browser-tabs";
import { useChatDraftsStore } from "@renderer/stores/chat-drafts";
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

function refusingBridge(): unknown {
  const node = (path: string[]): unknown =>
    new Proxy(() => {}, {
      get(_target, key) {
        if (typeof key !== "string" || key === "then") return undefined;
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
  Element.prototype.scrollIntoView = function () {};
  MotionGlobalConfig.skipAnimations = true;
  useBrowserTabsStore.setState({ byId: {}, hydratedProjects: new Set([PROJECT]) });
  useBackgroundShellsStore.setState({ byId: {}, hydrated: true });
  useProjectSessionsStore.setState({ byProject: { [PROJECT]: EMPTY_PROJECT_SESSION_ROWS } });
  useChatDraftsStore.setState({ drafts: {} });
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

const READY_PROJECTION = {
  session: { id: SESSION, projectId: PROJECT, ticketId: null, title: "Chat" },
  status: "active",
  signal: null,
  modelSelection: null,
  modelTier: null,
  turnActive: false,
  lastActivityAt: 0,
  bornTicketless: true,
  attention: { active: [], primary: null },
  interactions: { active: [], resolved: [] },
  liveExecutor: null,
  authority: null,
};

/** A store whose transport never answers, so the slice stays exactly as seeded. */
function chatStore(input: {
  projection: typeof READY_PROJECTION | null;
  messages?: readonly UIMessage[];
  sessionError?: string;
}) {
  const store = createChatSessionsStore(
    () => ({ connect: async () => {}, dispose: () => {} }) as unknown as ChatSessionTransport,
  );
  store.setState({
    sessions: {
      [SESSION]: {
        projection: input.projection,
        transcript: {
          ...EMPTY_TRANSCRIPT,
          durableMessages: input.messages ?? [],
          messages: input.messages ?? [],
        },
        lifecycle: "ready",
        sessionError: input.sessionError ?? null,
        queue: [],
      },
    },
  } as never);
  return store;
}

async function mountPlane(store: ReturnType<typeof chatStore>) {
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

const loading = () => container?.querySelector('[data-testid="chat-transcript-loading"]') ?? null;
// A project-scope empty state always offers its three visuals, so the picker
// is the one element every drawing of it carries.
const emptyState = () => container?.querySelector('[data-testid="empty-visual-picker"]') ?? null;

describe("a chat with no messages on screen", () => {
  it("holds the transcript's box while the history read is still in flight", async () => {
    await mountPlane(chatStore({ projection: null }));
    expect(loading()).not.toBeNull();
    expect(loading()?.getAttribute("aria-busy")).toBe("true");
    expect(emptyState()).toBeNull();
  });

  it("draws the empty state once the snapshot has landed and found nothing", async () => {
    await mountPlane(chatStore({ projection: READY_PROJECTION }));
    expect(loading()).toBeNull();
    expect(emptyState()).not.toBeNull();
  });

  it("draws the empty state for a provisional Draft, whose null projection is the truth", async () => {
    useChatDraftsStore.getState().openProvisional(SESSION, {
      projectId: PROJECT,
      ticketId: null,
      operationId: "op-1",
      title: null,
    });
    await mountPlane(chatStore({ projection: null }));
    expect(loading()).toBeNull();
    expect(emptyState()).not.toBeNull();
  });

  it("stands the skeleton down when the read failed, so the failure is what shows", async () => {
    await mountPlane(chatStore({ projection: null, sessionError: "Lost the Session stream" }));
    expect(loading()).toBeNull();
  });

  it("gives way to the transcript the moment messages arrive", async () => {
    const store = chatStore({ projection: null });
    await mountPlane(store);
    expect(loading()).not.toBeNull();
    const message: UIMessage = { id: "u1", role: "user", parts: [{ type: "text", text: "Hi" }] };
    await act(async () => {
      store.setState(
        (state) =>
          ({
            sessions: {
              ...state.sessions,
              [SESSION]: {
                ...state.sessions[SESSION]!,
                projection: READY_PROJECTION,
                transcript: {
                  ...EMPTY_TRANSCRIPT,
                  durableMessages: [message],
                  messages: [message],
                },
              },
            },
          }) as never,
      );
    });
    expect(loading()).toBeNull();
    expect(container?.textContent).toContain("Hi");
  });
});
