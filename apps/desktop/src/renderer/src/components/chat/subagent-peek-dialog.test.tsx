// @vitest-environment jsdom
/**
 * The peek overlay (VC-269): mounted only while open, adopts the child on
 * open and never disposes it on close, draws the child's transcript read-only
 * with the state word beside the title, and promotes through the door it was
 * handed. The plane-level journey (row → peek → Escape → cluster) is pinned in
 * `chat-plane.island.test.tsx`.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { UIMessage } from "ai";
import {
  EMPTY_TRANSCRIPT,
  type ChatSessionTransport,
  type IslandAgent,
} from "@volli/session-presentation";
import { createChatSessionsStore } from "@renderer/stores/chat-sessions";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { SubagentPeekDialog, type SubagentPeekDialogProps } from "./subagent-peek-dialog";

vi.mock("@renderer/lib/toast", () => ({ toastError: vi.fn() }));

const CHILD = "s-child";

function agent(over: Partial<IslandAgent> = {}): IslandAgent {
  return {
    id: CHILD,
    label: "Grep the tests",
    progress: 0,
    state: "working",
    promoted: false,
    ...over,
  };
}

function chatStore(messages: readonly UIMessage[] = [], seeded = true) {
  // A transport that answers nothing: adopting seeds the slice and asks the
  // client to connect, and a connect that never answers leaves the seeded
  // transcript exactly as the test wrote it.
  const store = createChatSessionsStore(() => ({}) as ChatSessionTransport);
  if (seeded) {
    store.setState({
      sessions: {
        [CHILD]: {
          projection: null,
          transcript: { ...EMPTY_TRANSCRIPT, durableMessages: messages, messages },
          lifecycle: "ready",
          sessionError: null,
          queue: [],
        },
      },
    });
  }
  return { store };
}

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
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

async function render(props: SubagentPeekDialogProps) {
  await act(async () => {
    root?.render(
      <TooltipProvider delayDuration={0}>
        <SubagentPeekDialog {...props} />
      </TooltipProvider>,
    );
  });
}

const dialog = () => document.body.querySelector("[data-subagent-peek-dialog]");

describe("SubagentPeekDialog", () => {
  it("is mounted only while open", async () => {
    const { store } = chatStore();
    await render({ agent: null, onClose: () => {}, store });
    expect(dialog()).toBeNull();

    await render({ agent: agent(), onClose: () => {}, store });
    expect(dialog()).not.toBeNull();

    await render({ agent: null, onClose: () => {}, store });
    expect(dialog()).toBeNull();
  });

  it("adopts the child on open and leaves it resident on close", async () => {
    const { store } = chatStore([], false);
    expect(store.getState().sessions[CHILD]).toBeUndefined();

    await render({ agent: agent(), onClose: () => {}, store });
    expect(store.getState().sessions[CHILD]).toBeDefined();

    await render({ agent: null, onClose: () => {}, store });
    // Not disposed: closeChatSession is not ref-counted, and a tab may hold it.
    expect(store.getState().sessions[CHILD]).toBeDefined();
  });

  it("names the child with its state word, draws its transcript read-only, and promotes through the door", async () => {
    const { store } = chatStore([
      { id: "u1", role: "user", parts: [{ type: "text", text: "Find the flaky test." }] },
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "It is auth.test.ts." }] },
    ] as UIMessage[]);
    const onOpenAsTab = vi.fn();
    await render({
      agent: agent({ state: "done", promoted: true }),
      onClose: () => {},
      onOpenAsTab,
      store,
    });

    const node = dialog()!;
    expect(node.textContent).toContain("Grep the tests");
    expect(node.querySelector("[data-subagent-peek-state]")?.textContent).toBe("done · tab");
    const transcript = node.querySelector("[data-subagent-peek-transcript]")!;
    expect(transcript.textContent).toContain("Find the flaky test.");
    expect(transcript.textContent).toContain("It is auth.test.ts.");
    expect(node.querySelector("textarea")).toBeNull();

    // Promoted reads "Focus tab", and either label calls the same door.
    const button = [...node.querySelectorAll("button")].find((one) =>
      one.textContent?.includes("Focus tab"),
    );
    expect(button).toBeDefined();
    await act(async () => {
      button!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(onOpenAsTab).toHaveBeenCalledWith(CHILD);
  });

  it("says so when the child has said nothing yet", async () => {
    const { store } = chatStore();
    await render({ agent: agent(), onClose: () => {}, store });
    expect(dialog()?.textContent).toContain("has not said anything");
  });

  it("closes through onClose on Escape, and hands focus where the mount says", async () => {
    const { store } = chatStore();
    const onClose = vi.fn();
    const home = document.createElement("button");
    document.body.append(home);
    await render({ agent: agent(), onClose, returnFocus: () => home, store });

    await act(async () => {
      dialog()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    await render({ agent: null, onClose, returnFocus: () => home, store });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(document.activeElement).toBe(home);
    home.remove();
  });
});
