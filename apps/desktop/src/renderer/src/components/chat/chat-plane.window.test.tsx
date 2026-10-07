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
  DEFAULT_CODE_MODE_POLICY,
  DEFAULT_COMPACTION_POLICY,
  EMPTY_MODEL_ACCESS_DEFAULTS,
  QueueRevisionConflictError,
  blobUrl,
  type BlobLinkView,
  type ModelAccessSnapshot,
  type ModelSelection,
} from "@volli/shared";
import {
  appendFrames,
  disposeChatClient,
  EMPTY_TRANSCRIPT,
  getOrCreateChatClient,
  type ChatCommandRequest,
  type ChatSessionFrame,
  type ChatSessionProjection,
  type ChatSessionRpc,
  type ChatSessionTransport,
} from "@volli/session-presentation";
import { createSessionEngine } from "@volli/session-engine";
import { openLegacySession } from "@renderer/chat/legacy-session.test-support";
import { useBackgroundShellsStore } from "@renderer/stores/background-shells";
import { useBrowserTabsStore } from "@renderer/stores/browser-tabs";
import { createChatSessionsStore, type ChatSessionsState } from "@renderer/stores/chat-sessions";
import {
  EMPTY_PROJECT_SESSION_ROWS,
  useProjectSessionsStore,
} from "@renderer/stores/project-sessions";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { ModelAccessProvider, type ModelAccessClient } from "@renderer/lib/model-access-client";
import { CHAT_DRAFTS_APP_STATE_KEY, useChatDraftsStore } from "@renderer/stores/chat-drafts";
import { useUiStore } from "@renderer/stores/ui";
import { useExperimentsStore } from "@renderer/stores/experiments";
import { useHostConnectionStore } from "@renderer/stores/host-connection";
import { remoteHost } from "@renderer/stores/host-sources";
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
const originalExperiments = useExperimentsStore.getState();
const originalHosts = useHostConnectionStore.getState();

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
  for (const store of hostStores.splice(0)) store.getState().closeChatSession(SESSION);
  container?.remove();
  container = null;
  MotionGlobalConfig.skipAnimations = false;
  HTMLElement.prototype.scrollTo = nativeScrollTo;
  useExperimentsStore.setState(originalExperiments, true);
  useHostConnectionStore.setState(originalHosts, true);
  vi.unstubAllGlobals();
});

function provisionalChatStore(promote: () => Promise<boolean> = async () => true) {
  const store = createChatSessionsStore(
    () => ({ connect: async () => {}, dispose: () => {} }) as unknown as ChatSessionTransport,
  );
  const promoteChatSession = vi.fn(promote);
  const enqueue = vi.fn<ChatSessionsState["enqueue"]>().mockResolvedValue("delivered");
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

const hostStores: ReturnType<typeof createChatSessionsStore>[] = [];

interface CancelInput {
  commandId: string;
  sessionId: string;
  messageId: string;
  expectedRevision?: number;
}

type HostQueueRow = NonNullable<ChatSessionProjection["queue"]>[number];

function hostRow(
  text: string,
  options: { state?: HostQueueRow["state"]; attachments?: readonly BlobLinkView[] } = {},
): HostQueueRow {
  const attachments = options.attachments ?? [];
  return {
    id: "q1",
    commandId: "q1",
    state: options.state ?? "queued",
    message: {
      id: "q1",
      role: "user",
      ...(attachments.length === 0 ? {} : { metadata: { attachments } }),
      parts: [
        { type: "text", text },
        ...attachments.map((attachment) => ({
          type: "file" as const,
          url: blobUrl(attachment.blobHash),
          mediaType: attachment.mime,
          filename: attachment.originalName,
        })),
      ],
    },
  };
}

function hostChatStore(
  options: { state?: HostQueueRow["state"]; attachments?: readonly BlobLinkView[] } = {},
) {
  const commands: ChatCommandRequest[] = [];
  let projection: ChatSessionProjection = {
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
    modelSelection: DEFAULT_SELECTION,
    modelTier: null,
    turnActive: false,
    lastActivityAt: 0,
    bornTicketless: true,
    scheduledResume: null,
    attention: { active: [], primary: null },
    interactions: { active: [], resolved: [] },
    liveExecutor: null,
    queue: [hostRow("host follow-up", options)],
    queueRevision: 1,
  };
  const cancel = vi.fn(async (_input: CancelInput): Promise<boolean> => true);
  const store = createChatSessionsStore(() => ({
    rpc: {
      session: {
        snapshot: { query: async () => ({ projection, frames: [], throughSequence: 0 }) },
        history: { query: async () => ({ frames: [], before: null }) },
        projection: { query: async () => ({ projection }) },
        subscribe: { subscribe: () => ({ unsubscribe: () => {} }) },
        command: {
          mutate: async (input) => {
            commands.push(input);
            return { sessionId: SESSION };
          },
        },
        cancelQueued: {
          mutate: async (input: CancelInput) => {
            const accepted = await cancel(input);
            if (accepted) projection = { ...projection, queue: [], queueRevision: 2 };
            return {
              sessionId: SESSION,
              receipt: { status: accepted ? "accepted" : "rejected", detail: "already releasing" },
            };
          },
        },
        editQueued: { mutate: async () => ({ sessionId: SESSION }) },
        cancelInteraction: { mutate: async () => ({ sessionId: SESSION }) },
        reconcile: { mutate: async () => ({ sessionId: SESSION }) },
      },
    },
    scheduler: { schedule: () => () => {} },
    newCommandId: () => crypto.randomUUID(),
    createSession: async () => ({ sessionId: SESSION }),
    attachSession: async () => {
      throw new Error("renderer must not attach for the queue");
    },
  }));
  store.getState().adoptChatSession(SESSION);
  hostStores.push(store);
  /** Another Client edits the row: the host's revision moves and the stream says so. */
  const editElsewhere = (text: string) => {
    const revision = (projection.queueRevision ?? 0) + 1;
    projection = { ...projection, queue: [hostRow(text, options)], queueRevision: revision };
    store.getState().setQueue(SESSION, projection.queue ?? [], revision);
  };
  /** A cancel the host judges by its own revision, as the ledger does. */
  const hostRevision = () => projection.queueRevision ?? 0;
  return { store, cancel, commands, editElsewhere, hostRevision };
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
    codeModePolicy: async () => DEFAULT_CODE_MODE_POLICY,
    setCodeModePolicy: async (policy) => policy,
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
/**
 * The composer's hidden file picker, queried by its own hook: since VC-335
 * the Session composer offers files through the `+` menu, so the input no
 * longer sits next to an "Attach files" button — and the ai-elements
 * `PromptInput` renders a second hidden file input for its own local
 * attachment context, so a bare `input[type="file"]` finds the wrong one.
 * These tests drive the picker's `change` path, which is unchanged.
 */
const attachmentPicker = () =>
  container?.querySelector<HTMLInputElement>("input[data-composer-file-picker]") ?? null;
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

  it("retains the persisted first message until the host accepts its queued command", async () => {
    const { enqueue, store } = provisionalChatStore();
    let accept!: (outcome: "delivered" | "refused") => void;
    enqueue.mockImplementation(
      () =>
        new Promise((resolve) => {
          accept = resolve;
        }),
    );
    await mountPlane(store, modelClient(DEFAULT_SELECTION));
    const box = composer();
    if (box === null) throw new Error("expected composer");
    await act(async () => {
      type(box, "keep these words");
    });
    await act(async () => {
      container?.querySelector<HTMLButtonElement>('[aria-label="Send"]')?.click();
    });
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledOnce());
    expect(useChatDraftsStore.getState().drafts[SESSION]?.held).toMatchObject([
      { text: "keep these words", state: "sending" },
    ]);
    await act(async () => accept("refused"));
    expect(useChatDraftsStore.getState().drafts[SESSION]?.held).toMatchObject([
      { text: "keep these words", state: "unsent" },
    ]);
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
    const picker = attachmentPicker();
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
    const picker = attachmentPicker();
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

  it("promotes a remote Draft on first Send without consulting or freezing this Mac's default", async () => {
    useExperimentsStore.setState({ snapshot: { cloud: { enabled: true, source: "storage" } } });
    useHostConnectionStore.setState({
      hosts: [remoteHost("box", "chat-box")],
      projects: { [PROJECT]: { hostId: "box", link: { status: "open" }, granted: ["sessions"] } },
    });
    const client = modelClient(DEFAULT_SELECTION);
    const defaults = vi.spyOn(client, "defaults").mockResolvedValue(EMPTY_MODEL_ACCESS_DEFAULTS);
    const { promoteChatSession, enqueue, store } = provisionalChatStore();
    await mountPlane(store, client);
    const box = composer();
    if (box === null) throw new Error("expected remote composer");
    await act(async () => type(box, "remote first Send"));
    const submit = container?.querySelector<HTMLButtonElement>('[aria-label="Send"]');
    if (submit === null || submit === undefined) throw new Error("expected Send");
    await vi.waitFor(() => expect(submit.disabled).toBe(false));
    await act(async () => submit.click());
    await vi.waitFor(() => expect(promoteChatSession).toHaveBeenCalledWith(SESSION));
    expect(enqueue).toHaveBeenCalledWith(
      SESSION,
      expect.objectContaining({ text: "remote first Send" }),
    );
    expect(defaults).not.toHaveBeenCalled();
    expect(useUiStore.getState().settingsOpen).toBe(false);
    expect(useChatDraftsStore.getState().drafts[SESSION]?.provisional?.model).toBeUndefined();
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
    const picker = attachmentPicker();
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
    const picker = attachmentPicker();
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

describe("host-owned rows with cloud off", () => {
  it("waits for cancellation before Backspace restores text and preserves typing during the wait", async () => {
    const { store, cancel } = hostChatStore();
    let accept!: (accepted: boolean) => void;
    cancel.mockImplementation(
      () =>
        new Promise((resolve) => {
          accept = resolve;
        }),
    );
    await mountPlane(store, modelClient(DEFAULT_SELECTION));
    await vi.waitFor(() => expect(store.getState().sessions[SESSION]?.queue).toHaveLength(1));
    const box = composer();
    if (box === null) throw new Error("expected composer");
    await act(async () =>
      box.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true })),
    );
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(box.value).toBe("");
    expect(useChatDraftsStore.getState().drafts[SESSION]?.held).toMatchObject([
      { id: "q1", state: "sending" },
    ]);
    await act(async () => type(box, "new typing"));
    await act(async () => accept(true));
    expect(box.value).toBe("host follow-up\nnew typing");
    expect(useChatDraftsStore.getState().drafts[SESSION]?.held).toEqual([]);
    expect(store.getState().sessions[SESSION]?.queue).toEqual([]);
  });

  it("leaves the draft unchanged when host release beats Backspace", async () => {
    const { store, cancel } = hostChatStore();
    cancel.mockResolvedValue(false);
    await mountPlane(store, modelClient(DEFAULT_SELECTION));
    await vi.waitFor(() => expect(store.getState().sessions[SESSION]?.queue).toHaveLength(1));
    const box = composer();
    if (box === null) throw new Error("expected composer");
    await act(async () =>
      box.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true })),
    );
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(box.value).toBe("");
    expect(store.getState().sessions[SESSION]?.queue).toHaveLength(1);
  });

  // An unproven release at the head of the FIFO would otherwise be stuck: the
  // host now cancels it, and refuses one in flight. Remove is offered; the row
  // leaves only once the host accepts — never optimistically.
  it("offers Remove on a releasing row and keeps it until the host accepts", async () => {
    const { store, cancel } = hostChatStore({ state: "releasing" });
    cancel.mockResolvedValue(false);
    await mountPlane(store, modelClient(DEFAULT_SELECTION));
    await vi.waitFor(() =>
      expect(store.getState().sessions[SESSION]?.queue).toMatchObject([
        { id: "q1", queueState: "releasing" },
      ]),
    );
    const remove = () =>
      container?.querySelector<HTMLButtonElement>(
        '[aria-label="Remove queued message: host follow-up"]',
      ) ?? null;
    const actions = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Queued message actions: host follow-up"]',
    );
    expect(remove()?.disabled).toBe(false);
    expect(actions?.disabled).toBe(false);

    // Refused: an in-flight (or proven) release. Nothing moves.
    await act(async () => remove()?.click());
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(cancel).toHaveBeenLastCalledWith(
      expect.objectContaining({ messageId: "q1", expectedRevision: 1 }),
    );
    expect(remove()).not.toBeNull();
    expect(store.getState().sessions[SESSION]?.queue).toHaveLength(1);
    expect(useChatDraftsStore.getState().drafts[SESSION]?.held ?? []).toEqual([]);
    expect(composer()?.value).toBe("");

    // Accepted: an unproven release the host withdrew.
    cancel.mockResolvedValue(true);
    await act(async () => remove()?.click());
    await vi.waitFor(() => expect(store.getState().sessions[SESSION]?.queue).toEqual([]));
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(remove()).toBeNull();
  });

  // Cross-Client edit safety: cancel-to-composer persists its recovery copy
  // before asking the host, and that wait is long enough for another Client to
  // edit the row. The cancel must carry the revision of the strip the person
  // acted on — not the one observed after the wait — so the host answers with a
  // typed conflict instead of cancelling words this composer never showed.
  it("cancels with the rendered revision across the durability wait and keeps everything on conflict", async () => {
    const attachment: BlobLinkView = {
      linkId: "link-1",
      blobHash: "ab".repeat(32),
      label: "shot.png",
      originalName: "shot.png",
      mime: "image/png",
      sizeBytes: 12,
    };
    let gating = false;
    let persist!: () => void;
    const persisted = new Promise<void>((resolve) => {
      persist = resolve;
    });
    let gatedWrites = 0;
    vi.stubGlobal(
      "api",
      refusingBridge({
        "appState.set": async (...args: unknown[]) => {
          if (gating && args[0] === CHAT_DRAFTS_APP_STATE_KEY) {
            gatedWrites += 1;
            await persisted;
          }
          return { ok: true };
        },
      }),
    );
    const { store, cancel, editElsewhere, hostRevision } = hostChatStore({
      attachments: [attachment],
    });
    cancel.mockImplementation(async (input) => {
      if (input.expectedRevision !== undefined && input.expectedRevision !== hostRevision())
        throw new QueueRevisionConflictError(input.expectedRevision, hostRevision());
      return true;
    });
    await mountPlane(store, modelClient(DEFAULT_SELECTION));
    await vi.waitFor(() => expect(store.getState().sessions[SESSION]?.queueRevision).toBe(1));
    const box = composer();
    if (box === null) throw new Error("expected composer");

    gating = true;
    await act(async () =>
      box.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true })),
    );
    await vi.waitFor(() => expect(gatedWrites).toBeGreaterThan(0));
    expect(cancel).not.toHaveBeenCalled();

    // Mid-wait: another Client rewrites the row, and this plane re-renders it.
    await act(async () => editElsewhere("edited elsewhere"));
    expect(store.getState().sessions[SESSION]?.queueRevision).toBe(2);
    expect(container?.textContent).toContain("edited elsewhere");
    await act(async () => type(box, "new typing"));

    await act(async () => persist());
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(cancel).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "q1", expectedRevision: 1 }),
    );
    // The conflict refuses like any refusal: no words or files come back, and
    // the host's (edited) row is still the one on screen. The recovery copy is
    // retired only by that positive host ownership, once the mutation is over.
    await vi.waitFor(() => expect(useChatDraftsStore.getState().drafts[SESSION]?.held).toEqual([]));
    expect(box.value).toBe("new typing");
    expect(useChatDraftsStore.getState().drafts[SESSION]?.attachments ?? []).toEqual([]);
    expect(store.getState().sessions[SESSION]?.queue).toMatchObject([
      { id: "q1", text: "edited elsewhere", attachments: [attachment] },
    ]);
    expect(
      container?.querySelectorAll('[aria-label="Queued message: edited elsewhere"]'),
    ).toHaveLength(1);
    expect(container?.textContent).not.toContain("host follow-up");
  });

  // Edit's recovery copy is a hold, and a hold empties the box — right for Send,
  // wrong here: the box holds words typed BEFORE Edit, and neither the wait for
  // the host nor its refusal may take them.
  describe("Edit with words already typed", () => {
    const staged: BlobLinkView = {
      linkId: "link-staged",
      blobHash: "cd".repeat(32),
      label: "staged.png",
      originalName: "staged.png",
      mime: "image/png",
      sizeBytes: 7,
    };
    const rowFile: BlobLinkView = {
      linkId: "link-row",
      blobHash: "ef".repeat(32),
      label: "row.png",
      originalName: "row.png",
      mime: "image/png",
      sizeBytes: 9,
    };

    /** Opens the row's actions menu the way a keyboard does, and picks Edit. */
    async function editFromMenu(text: string): Promise<void> {
      const trigger = container?.querySelector<HTMLButtonElement>(
        `[aria-label="Queued message actions: ${text}"]`,
      );
      if (trigger === null || trigger === undefined) throw new Error("expected row actions");
      await act(async () =>
        trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
      );
      const item = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (node) => node.textContent?.includes("Edit message"),
      );
      if (item === undefined) throw new Error("expected Edit message");
      await act(async () => item.click());
    }

    async function mountWithTyping(state: HostQueueRow["state"]) {
      useChatDraftsStore.getState().setDraftAttachments(SESSION, [staged]);
      const host = hostChatStore({ state, attachments: [rowFile] });
      let answer!: (accepted: boolean) => void;
      host.cancel.mockImplementation(
        () =>
          new Promise((resolve) => {
            answer = resolve;
          }),
      );
      await mountPlane(host.store, modelClient(DEFAULT_SELECTION));
      await vi.waitFor(() =>
        expect(host.store.getState().sessions[SESSION]?.queue).toMatchObject([
          { id: "q1", queueState: state },
        ]),
      );
      const box = composer();
      if (box === null) throw new Error("expected composer");
      await act(async () => type(box, "already typed"));
      expect(useChatDraftsStore.getState().drafts[SESSION]?.text).toBe("already typed");
      return { ...host, box, answer: (accepted: boolean) => answer(accepted) };
    }

    it("keeps the typed words and files, and the host row, when the host refuses a releasing row", async () => {
      const { store, cancel, box, answer } = await mountWithTyping("releasing");

      await editFromMenu("host follow-up");
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
      // Mid-wait: the recovery copy is held, and the box still says what it said.
      expect(useChatDraftsStore.getState().drafts[SESSION]?.held).toMatchObject([
        { id: "q1", state: "sending" },
      ]);
      expect(box.value).toBe("already typed");
      expect(useChatDraftsStore.getState().drafts[SESSION]?.text).toBe("already typed");

      await act(async () => answer(false));
      await vi.waitFor(() =>
        expect(useChatDraftsStore.getState().drafts[SESSION]?.held ?? []).toEqual([]),
      );
      expect(box.value).toBe("already typed");
      expect(useChatDraftsStore.getState().drafts[SESSION]?.text).toBe("already typed");
      expect(useChatDraftsStore.getState().drafts[SESSION]?.attachments).toEqual([staged]);
      expect(store.getState().sessions[SESSION]?.queue).toMatchObject([
        { id: "q1", text: "host follow-up", queueState: "releasing", attachments: [rowFile] },
      ]);
      expect(
        container?.querySelectorAll('[aria-label="Queued message: host follow-up"]'),
      ).toHaveLength(1);
    });

    it("puts the recovered words ahead of the typed ones when the host accepts", async () => {
      const { store, cancel, box, answer } = await mountWithTyping("queued");

      await editFromMenu("host follow-up");
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
      expect(box.value).toBe("already typed");

      await act(async () => answer(true));
      await vi.waitFor(() => expect(store.getState().sessions[SESSION]?.queue).toEqual([]));
      expect(box.value).toBe("host follow-up\nalready typed");
      expect(useChatDraftsStore.getState().drafts[SESSION]?.text).toBe(
        "host follow-up\nalready typed",
      );
      expect(useChatDraftsStore.getState().drafts[SESSION]?.held).toEqual([]);
      expect(useChatDraftsStore.getState().drafts[SESSION]?.attachments).toEqual([staged, rowFile]);
    });
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

describe("a chat plane holding only the host's newest window (VC-315)", () => {
  /** Turn `index` as a durable frame at sequence `index + 1`. */
  const turnFrame = (index: number): ChatSessionFrame =>
    ({
      sessionId: SESSION,
      sequence: index + 1,
      event: {
        id: `event-${index + 1}`,
        sessionId: SESSION,
        sequence: index + 1,
        occurredAt: index,
        recordedAt: index,
        provenance: {
          source: { kind: "system", id: "session-runtime", detail: null },
          venue: null,
        },
        payload: {
          kind: "transcript.referenced",
          attachmentId: null,
          turnId: null,
          reference: { id: `sha256:${index}`, mediaType: null, digest: null },
        },
      },
      transcript: { message: transcript(index + 1)[index]! },
    }) as never;
  const frames = (from: number, to: number) =>
    Array.from({ length: to - from }, (_value, offset) => turnFrame(from + offset));

  /**
   * A store holding turns [`from`, TOTAL) with the host's cursor above them,
   * and a resident client whose host answers pages of `PAGE` turns.
   */
  function windowedStore(from: number, total: number, page: number) {
    const store = chatStore([]);
    const held = appendFrames({ ...EMPTY_TRANSCRIPT, before: from + 1 }, frames(from, total));
    store.setState((state) => ({
      sessions: { [SESSION]: { ...state.sessions[SESSION]!, transcript: held } },
    }));
    const requests: number[] = [];
    const rpc = {
      session: {
        history: {
          query: async ({ before }: { before: number }) => {
            requests.push(before);
            const start = Math.max(0, before - 1 - page);
            return { frames: frames(start, before - 1), before: start > 0 ? start + 1 : null };
          },
        },
      },
    } as unknown as ChatSessionRpc;
    getOrCreateChatClient(SESSION, {
      rpc,
      store,
      scheduler: { schedule: () => () => undefined },
      newCommandId: () => "command",
      createSession: async () => {
        throw new Error("not under test");
      },
      attachSession: async () => {
        throw new Error("not under test");
      },
      notify: () => undefined,
      renameSession: () => undefined,
    });
    return { store, requests };
  }

  afterEach(() => {
    disposeChatClient(SESSION);
  });

  it("offers the host's history above a short window, and reveals each page as it lands", async () => {
    const { store, requests } = windowedStore(30, 40, 20);
    await mountPlane(store);

    expect(turnRows()).toBe(10);
    const button = earlierButton();
    if (button === null) throw new Error("expected an earlier affordance");
    expect(button.getAttribute("data-transcript-earlier")).toBe("0");

    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(requests).toEqual([31]);
    expect(shows(10)).toBe(true);
    expect(shows(9)).toBe(false);
    expect(turnRows()).toBe(30);

    // Pressed until the host has nothing more; bounded so a stuck window fails.
    for (let press = 0; press < 10 && earlierButton() !== null; press += 1) {
      await act(async () => {
        earlierButton()!.dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true }),
        );
      });
    }
    expect(shows(0)).toBe(true);
    expect(turnRows()).toBe(40);
    expect(requests).toEqual([31, 11]);
    expect(store.getState().sessions[SESSION]?.transcript.before).toBeNull();
  });

  /** Frames [`from`, `to`) as assistant messages: one grouped turn, split by the window. */
  const assistantFrames = (from: number, to: number) =>
    frames(from, to).map((frame) =>
      Object.assign({}, frame, {
        transcript: {
          message: Object.assign({}, frame.transcript!.message, { role: "assistant" as const }),
        },
      }),
    );

  /**
   * The plane over one assistant turn the window began partway through
   * (sequences 11..20), whose host answers the rest of it (1..10) in one page.
   */
  async function splitTurn(onPage?: () => void) {
    const store = chatStore([]);
    store.setState((state) => ({
      sessions: {
        [SESSION]: {
          ...state.sessions[SESSION]!,
          transcript: appendFrames({ ...EMPTY_TRANSCRIPT, before: 11 }, assistantFrames(10, 20)),
        },
      },
    }));
    const rpc = {
      session: {
        history: {
          query: async () => {
            onPage?.();
            return { frames: assistantFrames(0, 10), before: null };
          },
        },
      },
    } as unknown as ChatSessionRpc;
    getOrCreateChatClient(SESSION, {
      rpc,
      store,
      scheduler: { schedule: () => () => undefined },
      newCommandId: () => "command",
      createSession: async () => {
        throw new Error("not under test");
      },
      attachSession: async () => {
        throw new Error("not under test");
      },
      notify: () => undefined,
      renameSession: () => undefined,
    });
    await mountPlane(store);
    const scroller = container!.querySelector<HTMLElement>('[style*="scrollbar-gutter"]')!;
    expect(scroller).not.toBeNull();
    return { store, scroller };
  }

  const messageCount = (store: ReturnType<typeof chatStore>) =>
    store.getState().sessions[SESSION]!.transcript.messages.length;

  // The review's B3 probe, kept: a height model alone (100 px a message), no
  // anchor positions, which is the fallback the plane takes when it can see
  // no anchor.
  it("holds the reader's place when a page completes the first turn instead of adding a row", async () => {
    const { store, scroller } = await splitTurn();
    Object.defineProperty(scroller, "scrollHeight", {
      configurable: true,
      get: () => messageCount(store) * 100,
    });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 300 });
    scroller.scrollTop = 100;
    expect(turnRows()).toBe(1);

    await act(async () => {
      earlierButton()!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(turnRows()).toBe(1); // no new row: the turn got its older prefix
    expect(messageCount(store)).toBe(20);
    expect(scroller.scrollTop).toBe(1100);
  });

  /**
   * A layout model with anchors in it: message `i` of the transcript is 100 px
   * tall at `i * 100`, and an anchor's box is its message's, moved by the
   * scroll. `drawnBelow` is height the live tail grew by at the bottom.
   */
  function layout(store: ReturnType<typeof chatStore>, scroller: HTMLElement) {
    const state = { drawnBelow: 0 };
    const index = (key: string) =>
      store
        .getState()
        .sessions[SESSION]!.transcript.messages.findIndex(({ id }) => key.startsWith(`${id}:`));
    Object.defineProperty(scroller, "scrollHeight", {
      configurable: true,
      get: () => messageCount(store) * 100 + state.drawnBelow,
    });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 300 });
    scroller.getBoundingClientRect = () => ({ top: 0, bottom: 300 }) as DOMRect;
    for (const node of container!.querySelectorAll<HTMLElement>("[data-transcript-anchor]")) {
      node.getBoundingClientRect = () => {
        const top = index(node.dataset["transcriptAnchor"]!) * 100 - scroller.scrollTop;
        return { top, bottom: top + 100 } as DOMRect;
      };
    }
    return state;
  }

  it("puts the anchor the reader saw back where it was, even with the tail growing below", async () => {
    let state: { drawnBelow: number } | null = null;
    // The live tail grows while the page is in flight: a height delta would
    // overshoot by exactly that much; the anchor does not.
    const { store, scroller } = await splitTurn(() => {
      state!.drawnBelow = 250;
    });
    state = layout(store, scroller);
    scroller.scrollTop = 150;

    await act(async () => {
      earlierButton()!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    // The anchors are the same nodes, kept through the page: the turn's
    // identity held while its prefix completed.
    layout(store, scroller);
    expect(turnRows()).toBe(1);
    // "turn number 11" was 50 px into view at the top; 10 messages arrived above.
    expect(scroller.scrollTop).toBe(1150);
  });

  it("leaves an offset the browser's own scroll anchoring already corrected", async () => {
    let native: (() => void) | null = null;
    const { store, scroller } = await splitTurn(() => native?.());
    layout(store, scroller);
    scroller.scrollTop = 150;
    let writes = 0;
    let value = 150;
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get: () => value,
      set: (next: number) => {
        writes += 1;
        value = next;
      },
    });
    // Chromium moves the offset by the height that arrived above, itself.
    native = () => queueMicrotask(() => (value = 1150));

    await act(async () => {
      earlierButton()!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(value).toBe(1150);
    expect(writes).toBe(0);
  });

  it("keeps the first turn mounted, not remounted, while a page completes it", async () => {
    await splitTurn();
    const turn = container!.querySelector(".is-assistant");
    const segment = container!.querySelector('[data-transcript-anchor="u14:0"]');
    expect(segment).not.toBeNull();

    await act(async () => {
      earlierButton()!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(shows(0)).toBe(true);
    expect(container!.querySelector(".is-assistant")).toBe(turn);
    expect(container!.querySelector('[data-transcript-anchor="u14:0"]')).toBe(segment);
  });

  it("reads back on its own past a window with nothing to draw", async () => {
    const { store, requests } = windowedStore(40, 40, 20);
    store.setState((state) => ({
      sessions: {
        [SESSION]: {
          ...state.sessions[SESSION]!,
          transcript: { ...EMPTY_TRANSCRIPT, throughSequence: 40, before: 41 },
        },
      },
    }));
    await mountPlane(store);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(requests).toEqual([41]);
    expect(shows(39)).toBe(true);
    expect(shows(19)).toBe(false);
  });
});

/**
 * `/copy` on a bounded open (VC-315; the verification review's B2 probe,
 * kept): the current turn's reply sits above 256 tool-only messages the
 * window holds, so the messages alone cannot say what it was.
 */
describe("/copy on a Session holding only its newest window (VC-315)", () => {
  const tools: UIMessage[] = Array.from({ length: 256 }, (_value, index) => ({
    id: `tool-${index}`,
    role: "assistant" as const,
    parts: [
      {
        type: "dynamic-tool" as const,
        toolName: "read",
        toolCallId: `call-${index}`,
        state: "output-available" as const,
        input: {},
        output: "result",
      },
    ],
  }));

  async function pressCopy(latestReply: { sequence: number; text: string } | null) {
    const writeText = vi.fn(async (_text: string) => undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const store = chatStore(tools);
    store.setState((state) => ({
      sessions: {
        [SESSION]: {
          ...state.sessions[SESSION]!,
          // A composable box: the Session has a model.
          projection: {
            ...state.sessions[SESSION]!.projection!,
            modelSelection: DEFAULT_SELECTION,
          },
          transcript: { ...state.sessions[SESSION]!.transcript, before: 300, latestReply },
        },
      },
    }));
    await mountPlane(store, modelClient(DEFAULT_SELECTION));
    const box = composer();
    if (box === null) throw new Error("expected a composer");
    await act(async () => type(box, "/copy"));
    const submit = container?.querySelector<HTMLButtonElement>('[aria-label="Send"]');
    if (submit === null || submit === undefined) throw new Error("expected Send");
    await act(async () => submit.click());
    return writeText;
  }

  it("copies the host's baseline when the reply sits above the window", async () => {
    const writeText = await pressCopy({ sequence: 3, text: "Current-turn reply" });
    expect(writeText).toHaveBeenCalledWith("Current-turn reply");
  });

  it("copies nothing when the host says the current turn has not spoken", async () => {
    const writeText = await pressCopy(null);
    expect(writeText).not.toHaveBeenCalled();
  });

  // The re-check review's legacy probe, kept: the reply was recorded before
  // transcript digests, so no event says where it is. The host recovers it
  // from history above the window (VC-315's legacy baseline), and `/copy`
  // copies what that real snapshot answers.
  it("VC-315 recheck: copies a legacy Session reply preceding a tool-only bounded tail", async () => {
    const snapshot = await openLegacySession(createSessionEngine, [
      { say: "Current-turn reply" },
      ...tools.map(() => ({ say: "   " })),
      { say: "   " },
    ]);
    expect(snapshot.before).not.toBeNull();
    expect(JSON.stringify(snapshot.frames)).not.toContain("Current-turn reply");
    const writeText = await pressCopy(snapshot.latestReply);
    expect(writeText).toHaveBeenCalledWith("Current-turn reply");
  });
});
