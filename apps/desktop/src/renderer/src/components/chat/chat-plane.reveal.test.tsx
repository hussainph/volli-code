// @vitest-environment jsdom
/**
 * A notification click landing in a mounted chat plane (VC-295 round 5).
 *
 * Two places a Session's item can be drawn, and a click has to reach both:
 *
 *  - a FAILURE draws on the blocker row above the composer, which a person may
 *    have dismissed — a click naming that failure is a louder ask than the
 *    dismissal, so the row comes back;
 *  - a GATED CALL's question draws on its own transcript row, which the foot
 *    slot never takes — so "select that question" for it is a scroll, not a
 *    reorder.
 *
 * The whole plane, mounted, against a bridge that refuses everything (see
 * `chat-plane.island.test.tsx` for why that is the honest fixture): the seam
 * under test is the reveal slot's effect on THIS component, which the static
 * model tests beside it cannot see.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MotionGlobalConfig } from "motion/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { DynamicToolUIPart, UIMessage } from "ai";
import { askInteractionId, type RendererSessionInteraction } from "@volli/shared";
import { EMPTY_TRANSCRIPT, type ChatSessionTransport } from "@volli/session-presentation";
import {
  releaseSessionItemReveal,
  requestSessionItemReveal,
} from "@renderer/chat/session-item-reveal";
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
const ATTENTION = "attention-1";
const TOOL_CALL = "bash-1";

const REFUSED = { ok: false, error: "not stubbed" } as const;

/** A bridge that refuses every invoke and subscribes to nothing, by shape. */
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

const PERMISSION_OPTIONS = [
  { id: "once", label: "Allow once", description: null },
  { id: "always", label: "Allow always", description: null },
  { id: "reject", label: "Reject", description: null },
];

/** The permission a gated call is waiting on, correlated by the frozen `ask:` derivation. */
function gatedPermission(): RendererSessionInteraction {
  return {
    id: askInteractionId(TOOL_CALL),
    attachmentId: "attach-1",
    kind: "permission",
    title: "rm -rf node_modules",
    detail: "bash",
    options: PERMISSION_OPTIONS,
    multiple: false,
    prompts: [
      {
        id: "prompt:0",
        label: "rm -rf node_modules",
        detail: "bash",
        options: PERMISSION_OPTIONS,
        multiple: false,
        custom: false,
      },
    ],
    native: { id: null, detail: null },
  };
}

/** The transcript row that call draws on. */
function gatedTurn(): UIMessage {
  const part: DynamicToolUIPart = {
    type: "dynamic-tool",
    toolName: "bash",
    toolCallId: TOOL_CALL,
    state: "approval-requested",
    input: { command: "rm -rf node_modules" },
    approval: { id: "approval-1" },
  };
  return { id: "a1", role: "assistant", parts: [part] };
}

const disconnected = {
  id: ATTENTION,
  kind: "adapter_disconnected",
  attachmentId: "attach-1",
  detail: "The executor went away.",
  diagnostic: null,
};

let root: Root | null = null;
let container: HTMLElement | null = null;
let scrolled: Element[];

beforeEach(() => {
  scrolled = [];
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
  // jsdom lays nothing out and implements no scrolling; what the plane asks
  // to scroll is the whole of the assertion.
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
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
  releaseSessionItemReveal(SESSION);
  MotionGlobalConfig.skipAnimations = false;
  vi.unstubAllGlobals();
});

function chatStore(input: {
  messages?: readonly UIMessage[];
  interactions?: readonly RendererSessionInteraction[];
  attention?: readonly (typeof disconnected)[];
}) {
  const store = createChatSessionsStore(
    () => ({ connect: async () => {}, dispose: () => {} }) as unknown as ChatSessionTransport,
  );
  const attention = input.attention ?? [];
  store.setState({
    sessions: {
      [SESSION]: {
        projection: {
          session: { id: SESSION, projectId: PROJECT, ticketId: null, title: "Reveal" },
          status: "active",
          signal: null,
          modelSelection: null,
          modelTier: null,
          turnActive: false,
          lastActivityAt: 0,
          bornTicketless: true,
          attention: { active: attention, primary: attention.at(-1) ?? null },
          interactions: { active: input.interactions ?? [], resolved: [] },
          liveExecutor: null,
          authority: null,
        },
        transcript: {
          ...EMPTY_TRANSCRIPT,
          durableMessages: input.messages ?? [],
          messages: input.messages ?? [],
        },
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

function click(target: Element): void {
  act(() => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

const blockerRow = () => container?.querySelector('[data-slot="session-blocker"]') ?? null;
const dismissButton = () => container?.querySelector('[aria-label="Dismiss"]') ?? null;

describe("a click naming a failure", () => {
  it("brings back a blocker row the person had dismissed", async () => {
    await mountPlane(chatStore({ attention: [disconnected] }));
    expect(blockerRow()?.textContent).toContain("Disconnected");

    const dismiss = dismissButton();
    expect(dismiss).not.toBeNull();
    click(dismiss!);
    expect(blockerRow()).toBeNull();

    await act(async () => {
      requestSessionItemReveal(SESSION, { interactionId: null, attentionId: ATTENTION });
    });

    expect(blockerRow()?.textContent).toContain("Disconnected");
  });

  it("leaves a dismissal alone when the click names a question, not the failure", async () => {
    await mountPlane(chatStore({ attention: [disconnected] }));
    click(dismissButton()!);
    expect(blockerRow()).toBeNull();

    await act(async () => {
      requestSessionItemReveal(SESSION, { interactionId: "ask-user:elsewhere", attentionId: null });
    });

    expect(blockerRow()).toBeNull();
  });
});

describe("a click naming a gated call's question", () => {
  it("scrolls to the row that question draws on, once", async () => {
    await mountPlane(chatStore({ messages: [gatedTurn()], interactions: [gatedPermission()] }));
    const row = container?.querySelector(`[data-interaction-id="${askInteractionId(TOOL_CALL)}"]`);
    expect(row).not.toBeNull();
    expect(scrolled).toEqual([]);

    await act(async () => {
      requestSessionItemReveal(SESSION, {
        interactionId: askInteractionId(TOOL_CALL),
        attentionId: null,
      });
    });

    expect(scrolled).toEqual([row]);
  });

  it("scrolls again for a second click on the same question", async () => {
    await mountPlane(chatStore({ messages: [gatedTurn()], interactions: [gatedPermission()] }));
    const item = { interactionId: askInteractionId(TOOL_CALL), attentionId: null };
    await act(async () => {
      requestSessionItemReveal(SESSION, item);
    });
    await act(async () => {
      requestSessionItemReveal(SESSION, item);
    });

    expect(scrolled).toHaveLength(2);
  });

  it("scrolls nowhere for a question that has since been answered", async () => {
    // The row is gone with the interaction; the click's own toast says so.
    await mountPlane(chatStore({ messages: [gatedTurn()], interactions: [] }));

    await act(async () => {
      requestSessionItemReveal(SESSION, {
        interactionId: askInteractionId(TOOL_CALL),
        attentionId: null,
      });
    });

    expect(scrolled).toEqual([]);
  });
});
