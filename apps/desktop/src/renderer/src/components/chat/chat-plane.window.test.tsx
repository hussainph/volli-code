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
import {
  DEFAULT_COMPACTION_POLICY,
  EMPTY_MODEL_ACCESS_DEFAULTS,
  type ModelAccessSnapshot,
  type ModelSelection,
} from "@volli/shared";
import { EMPTY_TRANSCRIPT, type ChatSessionTransport } from "@volli/session-presentation";
import { useBackgroundShellsStore } from "@renderer/stores/background-shells";
import { useBrowserTabsStore } from "@renderer/stores/browser-tabs";
import { createChatSessionsStore } from "@renderer/stores/chat-sessions";
import {
  EMPTY_PROJECT_SESSION_ROWS,
  useProjectSessionsStore,
} from "@renderer/stores/project-sessions";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { ModelAccessProvider, type ModelAccessClient } from "@renderer/lib/model-access-client";
import { useChatDraftsStore } from "@renderer/stores/chat-drafts";
import { useUiStore } from "@renderer/stores/ui";
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
const DEFAULT_SELECTION: ModelSelection = {
  providerId: "acme",
  modelId: "sonnet",
  reasoningLevel: "high",
};

type BridgeOverrides = Readonly<Record<string, (...args: unknown[]) => unknown>>;

const bridgeNode = (path: string[], overrides: BridgeOverrides = {}): unknown =>
  new Proxy(() => {}, {
    get(_target, key) {
      if (typeof key !== "string" || key === "then") return undefined;
      return bridgeNode([...path, key], overrides);
    },
    apply(_target, _this, args) {
      const name = path.at(-1) ?? "";
      const override = overrides[path.join(".")];
      if (override !== undefined) return override(...args);
      if (name.startsWith("on")) return () => {};
      if (name === "pathForFile") return String(args[0]);
      if (path.at(-2) === "appState" && name === "set") return Promise.resolve({ ok: true });
      return Promise.resolve({ ok: false, error: "not stubbed" });
    },
  });

/** A bridge that refuses every invoke and subscribes to nothing, by shape. */
function refusingBridge(overrides: BridgeOverrides = {}): unknown {
  return bridgeNode([], overrides);
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
const nativeScrollTo = HTMLElement.prototype.scrollTo;

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
  HTMLElement.prototype.scrollTo = function () {};
  MotionGlobalConfig.skipAnimations = true;
  useBrowserTabsStore.setState({ byId: {}, hydratedProjects: new Set([PROJECT]) });
  useBackgroundShellsStore.setState({ byId: {}, hydrated: true });
  useProjectSessionsStore.setState({ byProject: { [PROJECT]: EMPTY_PROJECT_SESSION_ROWS } });
  useChatDraftsStore.setState({ drafts: {} });
  useUiStore.getState().setSettingsOpen(false);
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
  HTMLElement.prototype.scrollTo = nativeScrollTo;
  vi.unstubAllGlobals();
});

function provisionalChatStore(promote: () => Promise<boolean> = async () => true) {
  const store = createChatSessionsStore(
    () => ({ connect: async () => {}, dispose: () => {} }) as unknown as ChatSessionTransport,
  );
  const promoteChatSession = vi.fn(promote);
  const enqueue = vi.fn();
  store.setState({ promoteChatSession, enqueue } as never);
  useChatDraftsStore.getState().openProvisional(SESSION, {
    projectId: PROJECT,
    ticketId: null,
    operationId: "draft-operation",
    title: null,
  });
  store.getState().openChatTab(PROJECT, SESSION);
  return { enqueue, promoteChatSession, store };
}

function chatStore(
  messages: readonly UIMessage[],
  stream: {
    turnActive?: boolean;
    lifecycle?: "ready" | "working" | "error";
    sessionError?: string | null;
  } = {},
) {
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
        transcript: {
          ...EMPTY_TRANSCRIPT,
          turnActive: stream.turnActive ?? false,
          durableMessages: messages,
          messages,
        },
        lifecycle: stream.lifecycle ?? "ready",
        sessionError: stream.sessionError ?? null,
        queue: [],
      },
    },
  } as never);
  return store;
}

async function mountPlane(store: ReturnType<typeof chatStore>, modelAccess?: ModelAccessClient) {
  const plane = (
    <TooltipProvider delayDuration={0}>
      <ChatPlane
        sessionId={SESSION}
        projectId={PROJECT}
        ticketId={null}
        onOpenFile={() => {}}
        store={store}
      />
    </TooltipProvider>
  );
  await act(async () => {
    root?.render(
      modelAccess === undefined ? (
        plane
      ) : (
        <ModelAccessProvider client={modelAccess}>{plane}</ModelAccessProvider>
      ),
    );
  });
}

function modelClient(selection: ModelSelection): ModelAccessClient {
  const snapshot: ModelAccessSnapshot = {
    observedAt: 1,
    providers: [
      {
        id: selection.providerId,
        label: "Acme",
        state: "available",
        accountLabel: null,
        billingSource: "unknown",
        recovery: null,
        signIn: [],
        hasStoredCredential: true,
      },
    ],
    models: [
      {
        providerId: selection.providerId,
        modelId: selection.modelId,
        label: "Sonnet",
        state: "available",
        reasoningLevels: [selection.reasoningLevel],
        acceptsImageInput: true,
      },
    ],
  };
  return {
    inspect: async () => snapshot,
    defaults: async () => ({ ...EMPTY_MODEL_ACCESS_DEFAULTS, global: selection }),
    setDefault: async () => ({ ...EMPTY_MODEL_ACCESS_DEFAULTS, global: selection }),
    hiddenModels: async () => [],
    setHiddenModels: async (hidden) => hidden,
    compactionPolicy: async () => DEFAULT_COMPACTION_POLICY,
    setCompactionPolicy: async (policy) => policy,
    pickerView: async () => "all",
    setPickerView: async (view) => view,
    beginSignIn: async () => {
      throw new Error("not under test");
    },
    signOut: async () => undefined,
  };
}

async function unmountPlane() {
  await act(async () => {
    root?.unmount();
  });
  root = createRoot(container as HTMLElement);
}

const turnRows = () => container?.querySelectorAll(".is-user, .is-assistant").length ?? 0;
const composer = () => container?.querySelector<HTMLTextAreaElement>("textarea") ?? null;
const earlierButton = () => container?.querySelector("[data-transcript-earlier]") ?? null;
const shows = (index: number) => container?.textContent?.includes(`turn number ${index}`) === true;
const TOKEN_SELECTOR = '[style*="--shiki-dark"]';

async function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for highlight");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
  }
}

/**
 * Typing, as React sees it. Assigning `.value` and firing `input` is not enough:
 * React's own value tracker has already recorded the assignment, so the event
 * arrives looking like a no-op and `onChange` never runs. Going through the
 * prototype's setter is what leaves the tracker out of date — which is the
 * signal React uses to decide a change happened.
 */
function type(box: HTMLTextAreaElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(box, text);
  box.dispatchEvent(new Event("input", { bubbles: true }));
}

function click(target: Element): void {
  act(() => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

describe("a provisional chat plane", () => {
  it("stays renderer-local until Send, then promotes before queueing the first message", async () => {
    const { enqueue, promoteChatSession, store } = provisionalChatStore();
    await mountPlane(store, modelClient(DEFAULT_SELECTION));

    const box = composer();
    if (box === null) throw new Error("expected a composer");
    expect(store.getState().sessions).toEqual({});
    expect(promoteChatSession).not.toHaveBeenCalled();

    await act(async () => {
      type(box, "first durable words");
    });
    expect(promoteChatSession).not.toHaveBeenCalled();

    const submit = container?.querySelector<HTMLButtonElement>('[aria-label="Send"]');
    if (submit === null || submit === undefined) throw new Error("expected Send");
    expect(submit.disabled).toBe(false);
    await act(async () => {
      submit.click();
    });

    await vi.waitFor(() => expect(promoteChatSession).toHaveBeenCalledWith(SESSION));
    expect(enqueue).toHaveBeenCalledWith(
      SESSION,
      expect.objectContaining({ text: "first durable words" }),
    );
  });

  it("keeps an import already in flight with the first held message", async () => {
    const ownerless = {
      linkId: null,
      blobHash: "a".repeat(64),
      label: "late.png",
      originalName: "late.png",
      mime: "image/png",
      sizeBytes: 12,
    } as const;
    let finishAttach!: () => void;
    const attaching = new Promise((resolve) => {
      finishAttach = () => resolve({ ok: true, blob: ownerless, relPath: "src/late.png" });
    });
    const attach = vi.fn(() => attaching);
    vi.stubGlobal(
      "api",
      refusingBridge({
        "attachments.pathForFile": () => "/tmp/late.png",
        "attachments.attach": attach,
      }),
    );
    const { enqueue, promoteChatSession, store } = provisionalChatStore();
    await mountPlane(store, modelClient(DEFAULT_SELECTION));
    const attachButton = container?.querySelector<HTMLButtonElement>('[aria-label="Attach files"]');
    const picker = attachButton?.nextElementSibling;
    const box = composer();
    if (!(picker instanceof HTMLInputElement) || box === null) {
      throw new Error("expected attachment picker and composer");
    }
    Object.defineProperty(picker, "files", {
      configurable: true,
      value: [new File(["image"], "late.png", { type: "image/png" })],
    });
    await act(async () => picker.dispatchEvent(new Event("change", { bubbles: true })));
    expect(attach).toHaveBeenCalledOnce();
    await act(async () => type(box, "inspect this"));
    const submit = container?.querySelector<HTMLButtonElement>('[aria-label="Send"]');
    if (submit === null || submit === undefined) throw new Error("expected Send");
    await act(async () => submit.click());

    expect(promoteChatSession).not.toHaveBeenCalled();
    await act(async () => finishAttach());

    await vi.waitFor(() => expect(promoteChatSession).toHaveBeenCalledWith(SESSION));
    expect(enqueue).toHaveBeenCalledWith(
      SESSION,
      expect.objectContaining({
        text: "inspect this @src/late.png ",
        attachments: [ownerless],
      }),
    );
    expect(useChatDraftsStore.getState().drafts[SESSION]?.attachments).toEqual([]);
  });

  it("stands the composer down while the first message's import is still arriving", async () => {
    // The second ⏎ used to be dropped on the floor: a file committed to the
    // first message cannot be overtaken, so `send` returned and said nothing.
    // CLAUDE.md is explicit that a gesture is never swallowed — so the box
    // refuses visibly instead, and takes the words again once the file lands.
    const ownerless = {
      linkId: null,
      blobHash: "b".repeat(64),
      label: "slow.png",
      originalName: "slow.png",
      mime: "image/png",
      sizeBytes: 12,
    } as const;
    let finishAttach!: () => void;
    const attaching = new Promise((resolve) => {
      finishAttach = () => resolve({ ok: true, blob: ownerless, relPath: "src/slow.png" });
    });
    vi.stubGlobal(
      "api",
      refusingBridge({
        "attachments.pathForFile": () => "/tmp/slow.png",
        "attachments.attach": vi.fn(() => attaching),
      }),
    );
    // Promotion is held open, so this test observes ONLY the import gate:
    // nothing here can be explained by the chat having become durable.
    const { enqueue, store } = provisionalChatStore(() => new Promise<boolean>(() => {}));
    await mountPlane(store, modelClient(DEFAULT_SELECTION));
    const attachButton = container?.querySelector<HTMLButtonElement>('[aria-label="Attach files"]');
    const picker = attachButton?.nextElementSibling;
    const box = composer();
    if (!(picker instanceof HTMLInputElement) || box === null) {
      throw new Error("expected attachment picker and composer");
    }
    Object.defineProperty(picker, "files", {
      configurable: true,
      value: [new File(["image"], "slow.png", { type: "image/png" })],
    });
    await act(async () => picker.dispatchEvent(new Event("change", { bubbles: true })));
    await act(async () => type(box, "first"));

    const submit = container?.querySelector<HTMLButtonElement>('[aria-label="Send"]');
    if (submit === null || submit === undefined) throw new Error("expected Send");
    expect(submit.disabled).toBe(false);
    await act(async () => submit.click());

    // The import is captured, so the box is visibly not taking a second one.
    await vi.waitFor(() => expect(submit.disabled).toBe(true));
    await act(async () => type(box, "second"));
    expect(submit.disabled).toBe(true);
    expect(enqueue).not.toHaveBeenCalled();

    await act(async () => finishAttach());

    // The cohort settled, so the box takes words again — with the words still
    // in it, which is what tells this apart from an empty composer.
    await vi.waitFor(() => expect(submit.disabled).toBe(false));
    expect(useChatDraftsStore.getState().drafts[SESSION]?.held[0]).toMatchObject({
      text: "first @src/slow.png ",
      attachments: [ownerless],
    });
  });

  it("holds Send until the live default has loaded, then freezes it for promotion", async () => {
    const selection: ModelSelection = {
      providerId: "acme",
      modelId: "sonnet",
      reasoningLevel: "high",
    };
    const client = modelClient(selection);
    let finishDefaults!: () => void;
    client.defaults = () =>
      new Promise((resolve) => {
        finishDefaults = () => resolve({ ...EMPTY_MODEL_ACCESS_DEFAULTS, global: selection });
      });
    let finishPromotion!: () => void;
    const { promoteChatSession, store } = provisionalChatStore(
      () => new Promise<boolean>((resolve) => (finishPromotion = () => resolve(true))),
    );
    await mountPlane(store, client);

    const box = composer();
    const submit = container?.querySelector<HTMLButtonElement>('[aria-label="Send"]');
    if (box === null || submit === null || submit === undefined)
      throw new Error("expected composer");
    await act(async () => type(box, "wait for policy"));
    expect(submit.disabled).toBe(true);
    expect(promoteChatSession).not.toHaveBeenCalled();

    await act(async () => finishDefaults());
    await vi.waitFor(() => expect(submit.disabled).toBe(false));
    await act(async () => submit.click());
    await vi.waitFor(() => expect(promoteChatSession).toHaveBeenCalledWith(SESSION));
    expect(useChatDraftsStore.getState().drafts[SESSION]?.provisional?.model).toEqual(selection);
    await act(async () => finishPromotion());
  });

  it("opens Model Access instead of promoting when no default resolves", async () => {
    const selection: ModelSelection = {
      providerId: "acme",
      modelId: "sonnet",
      reasoningLevel: "high",
    };
    const client = modelClient(selection);
    client.defaults = async () => EMPTY_MODEL_ACCESS_DEFAULTS;
    const { promoteChatSession, store } = provisionalChatStore();
    await mountPlane(store, client);
    const box = composer();
    if (box === null) throw new Error("expected composer");
    await act(async () => type(box, "needs a model"));
    const submit = container?.querySelector<HTMLButtonElement>('[aria-label="Send"]');
    if (submit === null || submit === undefined) throw new Error("expected Send");
    await vi.waitFor(() => expect(submit.disabled).toBe(false));

    await act(async () => submit.click());

    await vi.waitFor(() => expect(useUiStore.getState().settingsCategory).toBe("model-access"));
    expect(promoteChatSession).not.toHaveBeenCalled();
    expect(container?.querySelector('[aria-label="Queued message: needs a model"]')).not.toBeNull();
  });

  it("freezes the live default model onto first Send so promotion retries cannot drift", async () => {
    const selection: ModelSelection = {
      providerId: "acme",
      modelId: "sonnet",
      reasoningLevel: "high",
    };
    let finishPromotion!: () => void;
    const { promoteChatSession, store } = provisionalChatStore(
      () => new Promise<boolean>((resolve) => (finishPromotion = () => resolve(true))),
    );
    await mountPlane(store, modelClient(selection));
    await vi.waitFor(() => {
      expect(container?.textContent).toContain("Sonnet");
    });

    const box = composer();
    if (box === null) throw new Error("expected a composer");
    await act(async () => {
      type(box, "freeze this model");
      container?.querySelector<HTMLButtonElement>('[aria-label="Send"]')?.click();
    });

    await vi.waitFor(() => expect(promoteChatSession).toHaveBeenCalledWith(SESSION));
    expect(useChatDraftsStore.getState().drafts[SESSION]?.provisional?.model).toEqual(selection);
    await act(async () => finishPromotion());
  });

  it("drops a deferred attachment gesture when the created Draft tab closes", async () => {
    let finishPromotion!: (promoted: boolean) => void;
    const promotion = new Promise<boolean>((resolve) => (finishPromotion = resolve));
    const attach = vi.fn(async () => ({ ok: false, error: "fixture refusal" }));
    vi.stubGlobal(
      "api",
      refusingBridge({
        "attachments.pathForFile": () => "/tmp/closed.txt",
        "attachments.attach": attach,
      }),
    );
    const { store } = provisionalChatStore(() => promotion);
    await mountPlane(store, modelClient(DEFAULT_SELECTION));
    const box = composer();
    if (box === null) throw new Error("expected a composer");
    await act(async () => {
      type(box, "close during transfer");
      container?.querySelector<HTMLButtonElement>('[aria-label="Send"]')?.click();
    });
    await vi.waitFor(() =>
      expect(useChatDraftsStore.getState().drafts[SESSION]?.held).toHaveLength(1),
    );
    await act(async () => useChatDraftsStore.getState().markProvisionalSessionCreated(SESSION));
    const attachButton = container?.querySelector<HTMLButtonElement>('[aria-label="Attach files"]');
    const picker = attachButton?.nextElementSibling;
    if (!(picker instanceof HTMLInputElement)) throw new Error("expected attachment picker");
    Object.defineProperty(picker, "files", {
      configurable: true,
      value: [new File(["closed"], "closed.txt", { type: "text/plain" })],
    });
    await act(async () => picker.dispatchEvent(new Event("change", { bubbles: true })));
    await act(async () => store.getState().closeChatTab(PROJECT, SESSION));
    await act(async () => finishPromotion(true));

    await vi.waitFor(() =>
      expect(useChatDraftsStore.getState().drafts[SESSION]?.held[0]?.state).toBe("unsent"),
    );
    expect(attach).not.toHaveBeenCalled();
  });

  it("does not resurrect held intent withdrawn while promotion is in flight", async () => {
    let finishPromotion!: (promoted: boolean) => void;
    const promotion = new Promise<boolean>((resolve) => (finishPromotion = resolve));
    const attach = vi.fn(async () => ({ ok: false, error: "fixture refusal" }));
    vi.stubGlobal(
      "api",
      refusingBridge({
        "attachments.pathForFile": () => "/tmp/next.txt",
        "attachments.attach": attach,
      }),
    );
    const { enqueue, promoteChatSession, store } = provisionalChatStore(() => promotion);
    await mountPlane(store, modelClient(DEFAULT_SELECTION));

    const box = composer();
    if (box === null) throw new Error("expected a composer");
    await act(async () => {
      type(box, "cancel before mint settles");
      container?.querySelector<HTMLButtonElement>('[aria-label="Send"]')?.click();
    });
    await vi.waitFor(() => expect(promoteChatSession).toHaveBeenCalledWith(SESSION));
    const attachButton = container?.querySelector<HTMLButtonElement>('[aria-label="Attach files"]');
    const picker = attachButton?.nextElementSibling;
    if (!(picker instanceof HTMLInputElement)) throw new Error("expected attachment picker");
    Object.defineProperty(picker, "files", {
      configurable: true,
      value: [new File(["next"], "next.txt", { type: "text/plain" })],
    });
    await act(async () => picker.dispatchEvent(new Event("change", { bubbles: true })));
    expect(attach).not.toHaveBeenCalled();
    const heldId = useChatDraftsStore.getState().drafts[SESSION]?.held[0]?.id;
    if (heldId === undefined) throw new Error("expected held promotion intent");
    await act(async () => useChatDraftsStore.getState().dropHeld(SESSION, heldId));

    await act(async () => finishPromotion(true));

    expect(enqueue).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(attach).toHaveBeenCalledOnce());
  });
});

describe("a chat plane holding a long transcript", () => {
  it("uses the stream Turn boundary when Session lifecycle fails and recovers", async () => {
    const source = "```ts\nexport const answer = 42;\n```";
    const message: UIMessage = {
      id: "a1",
      role: "assistant",
      parts: [{ type: "text", text: source }],
    };
    const store = chatStore([message], {
      turnActive: true,
      lifecycle: "error",
      sessionError: "Lost the Session stream",
    });

    await mountPlane(store);

    expect(container?.textContent).toContain("export const answer = 42;");
    expect(container?.querySelector('[data-streamdown="code-block"]')).not.toBeNull();
    expect(container?.querySelector('[data-streamdown="code-block-actions"]')).not.toBeNull();
    expect(container?.querySelector(TOKEN_SELECTOR)).toBeNull();

    await act(async () => {
      store.setState((state) => {
        const slice = state.sessions[SESSION];
        if (slice === undefined) return state;
        return {
          sessions: {
            ...state.sessions,
            [SESSION]: {
              ...slice,
              transcript: { ...slice.transcript, turnActive: false },
            },
          },
        };
      });
    });

    await waitFor(() => container?.querySelector(TOKEN_SELECTOR) !== null);
    expect(container?.textContent).toContain("export const answer = 42;");
  }, 12_000);

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

  it("comes back with the half-typed message a tab switch unmounted", async () => {
    // The other half of VC-338's unmount: a background plane may be dropped only
    // because nothing a person authored lives in it. The draft store is where
    // the words are (`chat-drafts.ts`); this is the round trip that proves it.
    useChatDraftsStore.setState({ drafts: {} });
    const store = chatStore(transcript(12));
    await mountPlane(store);
    const box = composer();
    if (box === null) throw new Error("expected a composer");
    await act(async () => {
      type(box, "half a thought about the window");
    });

    await unmountPlane();
    expect(composer()).toBeNull();

    await mountPlane(store);
    expect(composer()?.value).toBe("half a thought about the window");
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
