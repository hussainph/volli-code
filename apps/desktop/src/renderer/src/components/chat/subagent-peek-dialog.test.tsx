// @vitest-environment jsdom
/** Production overlay coverage: adoption, shared conversation surface, draft
 * lifetime, promotion, Escape/focus return, and resident child lifecycle. */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { UIMessage } from "ai";
import {
  SESSION_HOST_NOTICE_METADATA_KIND,
  type SessionPresentationProjection,
} from "@volli/shared";
import {
  EMPTY_TRANSCRIPT,
  disposeChatClient,
  getOrCreateChatClient,
  type ChatSessionTransport,
  type IslandAgent,
} from "@volli/session-presentation";
import { flushPendingAppStateKey } from "@renderer/lib/app-state-storage";
import { CHAT_DRAFTS_APP_STATE_KEY } from "@renderer/stores/chat-drafts";
import { createChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useChatDraftsStore } from "@renderer/stores/chat-drafts";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { SubagentPeekDialog, type SubagentPeekDialogProps } from "./subagent-peek-dialog";

vi.mock("@renderer/lib/toast", () => ({ toastError: vi.fn() }));
const CHILD = "s-child";
const PROJECTION: SessionPresentationProjection = {
  session: {
    id: CHILD,
    projectId: "p1",
    ticketId: null,
    role: "subagent",
    parentSessionId: "s-parent",
    title: "Grep",
    createdAt: 0,
  },
  status: "open",
  liveExecutor: { id: "child-attachment" },
  attention: { active: [], primary: null },
  interactions: { active: [], resolved: [] },
  signal: null,
  modelSelection: { providerId: "anthropic", modelId: "opus", reasoningLevel: "high" },
  modelTier: null,
  turnActive: false,
  lastActivityAt: 0,
  bornTicketless: true,
  scheduledResume: null,
};
function bridgeNode(path: string[]): unknown {
  return new Proxy(() => {}, {
    get(_target, key) {
      return typeof key !== "string" || key === "then" ? undefined : bridgeNode([...path, key]);
    },
    apply() {
      if (path.at(-1)?.startsWith("on")) return () => {};
      // Acknowledges only the draft persistence barrier; never performs IPC.
      if (path.join(".") === "appState.set") return Promise.resolve({ ok: true });
      return Promise.resolve({ ok: false, error: "not stubbed" });
    },
  });
}
function agent(over: Partial<IslandAgent> = {}): IslandAgent {
  return {
    id: CHILD,
    label: "Grep the tests",
    progress: 0,
    state: "working",
    promoted: false,
    model: { providerId: "anthropic", modelId: "sonnet-4.5", reasoningLevel: "high" },
    ...over,
  };
}
function chatStore(messages: readonly UIMessage[] = [], seeded = true) {
  const store = createChatSessionsStore(() => ({}) as ChatSessionTransport);
  if (seeded)
    store.setState({
      sessions: {
        [CHILD]: {
          projection: PROJECTION,
          transcript: { ...EMPTY_TRANSCRIPT, durableMessages: messages, messages },
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
beforeEach(() => {
  useChatDraftsStore.setState({ drafts: {} });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("api", bridgeNode([]));
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
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  disposeChatClient(CHILD);
  disposeChatClient("s-parent");
  useChatDraftsStore.setState({ drafts: {} });
  await flushPendingAppStateKey(CHAT_DRAFTS_APP_STATE_KEY);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function render(props: SubagentPeekDialogProps) {
  await act(async () =>
    root?.render(
      <TooltipProvider delayDuration={0}>
        <SubagentPeekDialog {...props} />
      </TooltipProvider>,
    ),
  );
}
const dialog = () => document.body.querySelector<HTMLElement>("[data-session-peek-dialog]");
const props = (who: IslandAgent | null, onClose = () => {}): SubagentPeekDialogProps => ({
  agent: who,
  projectId: "p1",
  ticketId: null,
  onClose,
});

describe("SubagentPeekDialog", () => {
  it("mounts only while open, adopts on mount and leaves the child resident on close", async () => {
    const store = chatStore([], false);
    await render({ ...props(null), store });
    expect(dialog()).toBeNull();
    expect(store.getState().sessions[CHILD]).toBeUndefined();
    await render({ ...props(agent()), store });
    expect(dialog()).not.toBeNull();
    expect(store.getState().sessions[CHILD]).toBeDefined();
    await render({ ...props(null), store });
    expect(dialog()).toBeNull();
    expect(store.getState().sessions[CHILD]).toBeDefined();
  });

  it("renders the child's transcript and real composer, and promotes through the handed door", async () => {
    const store = chatStore([
      { id: "u1", role: "user", parts: [{ type: "text", text: "Find the flaky test." }] },
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "It is auth.test.ts." }] },
    ] as UIMessage[]);
    const onOpenAsTab = vi.fn();
    const onClose = vi.fn();
    const home = document.createElement("button");
    document.body.append(home);
    await render({
      ...props(agent({ state: "done", promoted: true }), onClose),
      onOpenAsTab,
      returnFocus: () => home,
      store,
    });
    const node = dialog()!;
    expect(node.textContent).toContain("Grep the tests");
    expect(node.querySelector("[data-session-peek-state]")?.textContent).toBe("done · tab");
    expect(node.textContent).toContain("Find the flaky test.");
    expect(node.textContent).toContain("It is auth.test.ts.");
    expect(node.querySelector("textarea")).not.toBeNull();
    const button = [...node.querySelectorAll("button")].find((one) =>
      one.textContent?.includes("Focus tab"),
    );
    expect(button).toBeDefined();
    await act(async () =>
      button!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })),
    );
    expect(onOpenAsTab).toHaveBeenCalledWith(CHILD);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose.mock.invocationCallOrder[0]).toBeLessThan(
      onOpenAsTab.mock.invocationCallOrder[0]!,
    );
    await render({ ...props(null, onClose), returnFocus: () => home, store });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(dialog()).toBeNull();
    expect(document.activeElement).not.toBe(home);
    expect(store.getState().sessions[CHILD]).toBeDefined();
    home.remove();
  });

  it("opens a linked child Session and dismisses the overlay", async () => {
    const store = chatStore([
      {
        id: "notice",
        role: "user",
        parts: [{ type: "text", text: "Child finished" }],
        metadata: {
          kind: SESSION_HOST_NOTICE_METADATA_KIND,
          notice: {
            kind: "subagent",
            childSessionId: "grandchild",
            title: "Check the parser",
            state: "completed",
            reason: null,
          },
        },
      },
    ]);
    const onClose = vi.fn();
    const onOpenAsTab = vi.fn();
    const home = document.createElement("button");
    document.body.append(home);
    await render({ ...props(agent(), onClose), onOpenAsTab, returnFocus: () => home, store });
    const button = [...dialog()!.querySelectorAll("button")].find(
      (one) => one.textContent === "Open",
    );
    expect(button).toBeDefined();
    await act(async () => button!.click());

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onOpenAsTab).toHaveBeenCalledExactlyOnceWith("grandchild");
    await render({ ...props(null, onClose), returnFocus: () => home, store });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(document.activeElement).not.toBe(home);
    home.remove();
  });

  // VC-416 remains visible in the shared header, not only in the composer.
  it("says what the child is running, beside what it is doing", async () => {
    const store = chatStore();
    await render({
      ...props(
        agent({ model: { providerId: "openai", modelId: "o5-mini", reasoningLevel: "xhigh" } }),
      ),
      store,
    });

    const policy = dialog()?.querySelector("[data-agent-model]");
    expect(policy?.textContent).toContain("o5-mini");
    expect(policy?.textContent).toContain("Extra high");
  });

  it("draws no policy in the header for a child that has not recorded one", async () => {
    const store = chatStore();
    await render({ ...props(agent({ model: null })), store });

    expect(dialog()?.querySelector("[data-agent-model]")).toBeNull();
    expect(dialog()?.querySelector("[data-session-peek-state]")?.textContent).toBe("working");
  });

  it("preserves the child's draft across close and reopen", async () => {
    const store = chatStore();
    await render({ ...props(agent()), store });
    const textarea = dialog()!.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(textarea.disabled).toBe(false);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(textarea, "child-only draft");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(useChatDraftsStore.getState().drafts[CHILD]?.text).toBe("child-only draft");
    await render({ ...props(null), store });
    await render({ ...props(agent()), store });
    expect(dialog()!.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(
      "child-only draft",
    );
  });

  it("keeps a composer available on an empty transcript", async () => {
    const store = chatStore();
    await render({ ...props(agent()), store });
    expect(dialog()?.querySelector("textarea")).not.toBeNull();
  });

  it("submits through the child's resident client, not the parent's", async () => {
    const store = chatStore();
    const deps = {
      ...({} as ChatSessionTransport),
      store,
      notify: () => {},
      renameSession: () => {},
    };
    const childSubmit = vi
      .spyOn(getOrCreateChatClient(CHILD, deps), "submit")
      .mockResolvedValue("delivered");
    const parentSubmit = vi
      .spyOn(getOrCreateChatClient("s-parent", deps), "submit")
      .mockResolvedValue("delivered");
    await render({ ...props(agent()), store });
    const textarea = dialog()!.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(textarea.disabled).toBe(false);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        textarea,
        "Follow up with the child",
      );
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      dialog()!.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.click(),
    );
    // This child is idle: omitted delivery means immediate, not a host follow-up.
    expect(childSubmit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ text: "Follow up with the child" }),
      undefined,
    );
    expect(parentSubmit).not.toHaveBeenCalled();
    expect(useChatDraftsStore.getState().drafts[CHILD]?.text ?? "").toBe("");
  });

  it("closes on Escape and returns focus to the mount-provided target", async () => {
    const store = chatStore();
    const onClose = vi.fn();
    const home = document.createElement("button");
    document.body.append(home);
    await render({ ...props(agent(), onClose), returnFocus: () => home, store });
    await act(async () =>
      dialog()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
    await render({ ...props(null, onClose), returnFocus: () => home, store });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(document.activeElement).toBe(home);
    home.remove();
  });
});
