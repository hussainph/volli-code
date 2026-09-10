// @vitest-environment jsdom
/**
 * A long transcript, mounted (VC-338).
 *
 * The whole plane against a bridge that refuses everything — the same fixture
 * `chat-plane.reveal.test.tsx` argues for — because the claim under test is
 * about the DOCUMENT: a Session with thousands of turns must not put thousands
 * of turns in it, the reader must still be able to reach the first one, and the
 * place they were reading must survive the tab switch that unmounts the plane.
 *
 * jsdom lays nothing out, which is exactly why these assertions are about row
 * counts and about which turns exist rather than about pixels. The scroll
 * arithmetic that keeps the reader's place is measured in the Electron bench
 * (`e2e/chat-window-bench.mjs`), where there is a layout to measure.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MotionGlobalConfig } from "motion/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { UIMessage } from "ai";
import { EMPTY_TRANSCRIPT, type ChatSessionTransport } from "@volli/session-presentation";
import { useBackgroundShellsStore } from "@renderer/stores/background-shells";
import { useBrowserTabsStore } from "@renderer/stores/browser-tabs";
import { createChatSessionsStore } from "@renderer/stores/chat-sessions";
import {
  EMPTY_PROJECT_SESSION_ROWS,
  useProjectSessionsStore,
} from "@renderer/stores/project-sessions";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { ChatPlane } from "./chat-plane";
import {
  forgetTranscriptViews,
  readTranscriptView,
  TRANSCRIPT_PAGE_ROWS,
  TRANSCRIPT_TAIL_ROWS,
} from "./transcript-window";

vi.mock("@renderer/lib/toast", () => ({ toastError: vi.fn() }));

const SESSION = "s1";
const PROJECT = "p1";
const TURNS = 400;

const bridgeNode = (path: string[]): unknown =>
  new Proxy(() => {}, {
    get(_target, key) {
      if (typeof key !== "string" || key === "then") return undefined;
      return bridgeNode([...path, key]);
    },
    apply(_target, _this, args) {
      const name = path.at(-1) ?? "";
      if (name.startsWith("on")) return () => {};
      if (name === "pathForFile") return String(args[0]);
      return Promise.resolve({ ok: false, error: "not stubbed" });
    },
  });

/** A bridge that refuses every invoke and subscribes to nothing, by shape. */
function refusingBridge(): unknown {
  return bridgeNode([]);
}

/** `count` user turns, each saying which one it is so a row can be named. */
function transcript(count: number): UIMessage[] {
  return Array.from({ length: count }, (_value, index) => ({
    id: `u${index}`,
    role: "user" as const,
    parts: [{ type: "text" as const, text: `turn number ${index}` }],
  }));
}

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  forgetTranscriptViews();
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

function chatStore(messages: readonly UIMessage[]) {
  const store = createChatSessionsStore(
    () => ({ connect: async () => {}, dispose: () => {} }) as unknown as ChatSessionTransport,
  );
  store.setState({
    sessions: {
      [SESSION]: {
        projection: {
          session: { id: SESSION, projectId: PROJECT, ticketId: null, title: "Long" },
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
        },
        transcript: { ...EMPTY_TRANSCRIPT, durableMessages: messages, messages },
        lifecycle: "ready",
        sessionError: null,
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

async function unmountPlane() {
  await act(async () => {
    root?.unmount();
  });
  root = createRoot(container as HTMLElement);
}

const turnRows = () => container?.querySelectorAll(".is-user, .is-assistant").length ?? 0;
const earlierButton = () => container?.querySelector("[data-transcript-earlier]") ?? null;
const shows = (index: number) => container?.textContent?.includes(`turn number ${index}`) === true;

function click(target: Element): void {
  act(() => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

describe("a chat plane holding a long transcript", () => {
  it("mounts the tail and not the history", async () => {
    await mountPlane(chatStore(transcript(TURNS)));

    expect(turnRows()).toBe(TRANSCRIPT_TAIL_ROWS);
    expect(shows(TURNS - 1)).toBe(true);
    expect(shows(TURNS - TRANSCRIPT_TAIL_ROWS)).toBe(true);
    expect(shows(TURNS - TRANSCRIPT_TAIL_ROWS - 1)).toBe(false);
    expect(shows(0)).toBe(false);
  });

  it("says how many turns it is holding back", async () => {
    await mountPlane(chatStore(transcript(TURNS)));

    const button = earlierButton();
    expect(button?.getAttribute("data-transcript-earlier")).toBe(
      String(TURNS - TRANSCRIPT_TAIL_ROWS),
    );
    expect(button?.textContent).toBe("Show earlier");
  });

  it("offers nothing to reveal when the whole conversation is mounted", async () => {
    await mountPlane(chatStore(transcript(5)));

    expect(turnRows()).toBe(5);
    expect(earlierButton()).toBeNull();
  });

  it("reveals a page at a time", async () => {
    await mountPlane(chatStore(transcript(TURNS)));

    const button = earlierButton();
    if (button === null) throw new Error("expected an earlier affordance");
    click(button);

    expect(turnRows()).toBe(TRANSCRIPT_TAIL_ROWS + TRANSCRIPT_PAGE_ROWS);
    expect(shows(TURNS - TRANSCRIPT_TAIL_ROWS - TRANSCRIPT_PAGE_ROWS)).toBe(true);
    expect(shows(0)).toBe(false);
  });

  it("reaches the first turn, and then stops offering", async () => {
    await mountPlane(chatStore(transcript(TURNS)));

    // Bounded so a window that refuses to grow fails the test rather than
    // hanging it.
    for (let press = 0; press < 20; press += 1) {
      const button = earlierButton();
      if (button === null) break;
      click(button);
    }

    expect(shows(0)).toBe(true);
    expect(turnRows()).toBe(TURNS);
    expect(earlierButton()).toBeNull();
  });

  it("keeps the revealed rows mounted while the Session streams new ones", async () => {
    const store = chatStore(transcript(TURNS));
    await mountPlane(store);
    const button = earlierButton();
    if (button === null) throw new Error("expected an earlier affordance");
    click(button);
    const revealedTop = TURNS - TRANSCRIPT_TAIL_ROWS - TRANSCRIPT_PAGE_ROWS;
    expect(shows(revealedTop)).toBe(true);

    const grown = transcript(TURNS + 30);
    await act(async () => {
      store.setState(
        (state) =>
          ({
            sessions: {
              ...state.sessions,
              [SESSION]: {
                ...state.sessions[SESSION],
                transcript: { ...EMPTY_TRANSCRIPT, durableMessages: grown, messages: grown },
              },
            },
          }) as never,
      );
    });

    // The anchor is a row, so the rows above it did not come back and the rows
    // the reader revealed did not leave.
    expect(shows(revealedTop)).toBe(true);
    expect(shows(revealedTop - 1)).toBe(false);
    expect(shows(TURNS + 29)).toBe(true);
  });

  it("comes back to the rows the reader had revealed after a tab round-trip", async () => {
    const store = chatStore(transcript(TURNS));
    await mountPlane(store);
    const button = earlierButton();
    if (button === null) throw new Error("expected an earlier affordance");
    click(button);
    const revealedTop = TURNS - TRANSCRIPT_TAIL_ROWS - TRANSCRIPT_PAGE_ROWS;

    await unmountPlane();
    expect(turnRows()).toBe(0);
    expect(readTranscriptView(SESSION)?.anchorKey).toBe(`u${revealedTop}`);

    await mountPlane(store);
    expect(shows(revealedTop)).toBe(true);
    expect(turnRows()).toBe(TRANSCRIPT_TAIL_ROWS + TRANSCRIPT_PAGE_ROWS);
  });
});
