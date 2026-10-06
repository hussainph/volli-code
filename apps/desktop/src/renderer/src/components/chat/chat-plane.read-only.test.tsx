// @vitest-environment jsdom
/** Real plane/composer, with the same refusing bridge as the island tests. */
import { act } from "react";
import { MotionGlobalConfig } from "motion/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EMPTY_TRANSCRIPT,
  type ChatSessionProjection,
  type ChatSessionTransport,
} from "@volli/session-presentation";

import { hostWorld, type HostWorld } from "@renderer/components/hosts/hosts.test-support";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { useBackgroundShellsStore } from "@renderer/stores/background-shells";
import { useBrowserTabsStore } from "@renderer/stores/browser-tabs";
import { useChatDraftsStore } from "@renderer/stores/chat-drafts";
import { createChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useProjectsStore } from "@renderer/stores/projects";
import {
  EMPTY_PROJECT_SESSION_ROWS,
  useProjectSessionsStore,
} from "@renderer/stores/project-sessions";
import { ChatPlane } from "./chat-plane";

const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@renderer/lib/toast", () => ({ toastError: vi.fn() }));

const SESSION = "read-only-chat";
const PROJECT = "remote";
const DRAFT = "Keep these half-typed words";
const OFFLINE = { status: "offline", since: 0, retryAt: null } as const;
const originalProjects = useProjectsStore.getState();
const originalDrafts = useChatDraftsStore.getState();
const originalTabs = useBrowserTabsStore.getState();
const originalShells = useBackgroundShellsStore.getState();
const originalRows = useProjectSessionsStore.getState();
let world: HostWorld | null = null;

/** Refused reads exercise the app's normal fallback, rather than UI doubles. */
function refusingBridge(path: string[] = []): unknown {
  return new Proxy(() => {}, {
    get(_target, key) {
      if (typeof key !== "string" || key === "then") return undefined;
      return refusingBridge([...path, key]);
    },
    apply(_target, _this, args) {
      const name = path.at(-1) ?? "";
      if (name.startsWith("on")) return () => {};
      if (name === "pathForFile") return String(args[0]);
      return Promise.resolve({ ok: false, error: "not stubbed" });
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("api", refusingBridge());
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  MotionGlobalConfig.skipAnimations = true;
  useBrowserTabsStore.setState({ byId: {}, hydratedProjects: new Set([PROJECT]) });
  useBackgroundShellsStore.setState({ byId: {}, hydrated: true });
  useProjectSessionsStore.setState({ byProject: { [PROJECT]: EMPTY_PROJECT_SESSION_ROWS } });
  useChatDraftsStore.setState({ drafts: {} });
});

afterEach(async () => {
  await world?.cleanup();
  world = null;
  MotionGlobalConfig.skipAnimations = false;
  useChatDraftsStore.setState(originalDrafts, true);
  useProjectsStore.setState(originalProjects, true);
  useBrowserTabsStore.setState(originalTabs, true);
  useBackgroundShellsStore.setState(originalShells, true);
  useProjectSessionsStore.setState(originalRows, true);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function chatStore() {
  const projection: ChatSessionProjection = {
    session: {
      id: SESSION,
      projectId: PROJECT,
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: "Chat",
      createdAt: 0,
    },
    status: "open",
    signal: null,
    modelSelection: { providerId: "anthropic", modelId: "opus", reasoningLevel: "high" },
    modelTier: null,
    turnActive: false,
    lastActivityAt: 0,
    bornTicketless: true,
    scheduledResume: null,
    attention: { active: [], primary: null },
    interactions: { active: [], resolved: [] },
    liveExecutor: null,
  };
  // A silent transport holds the seeded snapshot steady. Sending must first
  // hold the draft, so spy on that seam as well as checking the visible value.
  const store = createChatSessionsStore(
    () => ({ connect: async () => {}, dispose: () => {} }) as unknown as ChatSessionTransport,
  );
  store.setState({
    sessions: {
      [SESSION]: {
        projection,
        transcript: EMPTY_TRANSCRIPT,
        lifecycle: "ready",
        sessionError: null,
        queue: [],
      },
    },
  });
  const holdMessage = vi.spyOn(useChatDraftsStore.getState(), "holdMessage");
  return { store, holdMessage };
}

async function mountPlane(cloud = true) {
  world = hostWorld({ cloud });
  const { store, holdMessage } = chatStore();
  const container = await world.render(
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
  return { container, holdMessage };
}

function message(container: HTMLElement): HTMLTextAreaElement {
  const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]');
  if (textarea === null) throw new Error("Missing composer textarea");
  return textarea;
}

function typeDraft(textarea: HTMLTextAreaElement): void {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      textarea,
      DRAFT,
    );
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("ChatPlane host read-only", () => {
  it("keeps a typed draft across offline/open and refuses every composer submission while offline", async () => {
    const { container, holdMessage } = await mountPlane();
    const textarea = message(container);
    expect(textarea.disabled).toBe(false);
    typeDraft(textarea);
    expect(useChatDraftsStore.getState().drafts[SESSION]?.text).toBe(DRAFT);

    world!.setHetzner({ link: OFFLINE });
    expect(textarea.disabled).toBe(true);
    expect(textarea.value).toBe(DRAFT);
    const send = container.querySelector<HTMLButtonElement>('[aria-label="Send"]');
    expect(send).not.toBeNull();
    expect(send!.disabled).toBe(true);
    // Greyed and desaturated like every write control, not a quieter orange.
    expect(send!.hasAttribute("data-host-read-only")).toBe(true);
    await act(async () => {
      send!.click();
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      // Even a synthetic form submission cannot bypass the disabled composer.
      textarea
        .closest("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(holdMessage).not.toHaveBeenCalled();
    expect(useChatDraftsStore.getState().drafts[SESSION]?.held).toEqual([]);
    expect(textarea.value).toBe(DRAFT);

    world!.setHetzner({ link: { status: "open" } });
    expect(textarea.disabled).toBe(false);
    expect(textarea.value).toBe(DRAFT);
    expect(send!.disabled).toBe(false);
    expect(send!.hasAttribute("data-host-read-only")).toBe(false);
  });

  it("draws Running on at the plane root, never inside the composer dock", async () => {
    const { container } = await mountPlane();
    const plane = container.querySelector('[style*="--composer-height"]');
    const label = container.querySelector('[data-slot="running-on"]');
    expect(plane).not.toBeNull();
    expect(label).not.toBeNull();
    expect(label!.parentElement).toBe(plane);
    expect(label!.textContent).toBe("Running on hetzner-1");
    expect(label!.closest('[data-slot="chat-composer-dock"]')).toBeNull();
    const dock = container.querySelector('[data-slot="chat-composer-dock"]');
    expect(dock).not.toBeNull();
    expect(dock!.contains(label)).toBe(false);
  });

  it("with cloud off draws no Running on label and keeps the composer enabled offline", async () => {
    const { container } = await mountPlane(false);
    typeDraft(message(container));
    world!.setHetzner({ link: OFFLINE });
    expect(container.querySelector('[data-slot="running-on"]')).toBeNull();
    expect(message(container).disabled).toBe(false);
    expect(message(container).value).toBe(DRAFT);
    const send = container.querySelector('[aria-label="Send"]');
    expect(send?.hasAttribute("data-host-read-only")).toBe(false);
  });
});
