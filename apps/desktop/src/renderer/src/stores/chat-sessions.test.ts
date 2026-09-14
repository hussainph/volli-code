import type {
  CommandReceipt,
  SessionPresentationProjection,
  SessionStartResult,
} from "@volli/shared";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  EMPTY_TRANSCRIPT,
  getChatClient,
  type ChatCommandRequest,
  type ChatSessionRpc,
  type ChatSessionTransport,
  type ChatStreamCursor,
} from "@volli/session-presentation";
import { useChatDraftsStore } from "./chat-drafts";
import { createChatSessionsStore } from "./chat-sessions";
import { useUiStore } from "./ui";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const noop = (): void => undefined;

const SESSION = {
  id: "durable-1",
  projectId: "p1",
  ticketId: "t1",
  role: "ticket" as const,
  parentSessionId: null,
  title: "VC-1",
  createdAt: 0,
};
const ACCEPTED_RECEIPT: CommandReceipt = {
  id: "receipt-accepted",
  commandId: "command-accepted",
  status: "accepted",
  acceptedAt: 0,
  result: { kind: "session.signaled", sessionId: SESSION.id },
  recordedAt: 0,
  sequence: 1,
};
const REJECTED_RECEIPT: CommandReceipt = {
  id: "receipt-rejected",
  commandId: "command-rejected",
  status: "rejected",
  code: "adapter_unavailable",
  detail: "Pi is unavailable",
  recordedAt: 0,
  sequence: 1,
};
const ACCEPTED = { sessionId: SESSION.id, receipt: ACCEPTED_RECEIPT };
const REFUSED = {
  sessionId: SESSION.id,
  receipt: REJECTED_RECEIPT,
};

// The presentation shape, exactly as the edge ships it — the full durable
// projection (commands, receipts, attachments) never reaches this store.
const projection: SessionPresentationProjection = {
  session: SESSION,
  status: "open",
  liveExecutor: null,
  authority: null,
  attention: { active: [], primary: null },
  interactions: { active: [], resolved: [] },
  signal: null,
  modelSelection: null,
  modelTier: null,
  turnActive: false,
  lastActivityAt: SESSION.createdAt,
  bornTicketless: SESSION.ticketId === null,
};

interface CommandAnswer {
  sessionId: string;
  receipt?: CommandReceipt | null;
}

type StartAnswer = SessionStartResult;

function fakeTransport() {
  const commands: ChatCommandRequest[] = [];
  const ticketStarts: unknown[] = [];
  const projectStarts: unknown[] = [];
  const attaches: unknown[] = [];
  const subscriptions: ChatStreamCursor[] = [];
  const state = {
    answer: (() => ACCEPTED) as (request: ChatCommandRequest) => CommandAnswer,
    createAnswer: ((input: { requestedSessionId?: string }) => ({
      sessionId: input.requestedSessionId ?? SESSION.id,
    })) as (input: {
      requestedSessionId?: string;
    }) => { sessionId: string } | Promise<{ sessionId: string }>,
    attachAnswer: (() => ({
      ...ACCEPTED,
      state: "ready",
      throughSequence: 2,
    })) as () => StartAnswer,
    snapshotError: null as Error | null,
  };
  // The attach stays open while a test inspects the optimistic state, then
  // releases — the create/attach split is the whole point of VC-16.
  let attachGate: Promise<void> | null = null;
  let releaseAttach: () => void = noop;
  const holdAttach = () => {
    attachGate = new Promise((resolve) => {
      releaseAttach = resolve;
    });
  };
  const rpc: ChatSessionRpc = {
    session: {
      snapshot: {
        query: async () => {
          if (state.snapshotError !== null) throw state.snapshotError;
          return { projection, frames: [], throughSequence: 0 };
        },
      },
      projection: { query: async () => ({ projection }) },
      subscribe: {
        subscribe: (input) => {
          subscriptions.push(input);
          return { unsubscribe: () => undefined };
        },
      },
      command: {
        mutate: async (input) => {
          commands.push(input);
          return state.answer(input);
        },
      },
      cancelInteraction: { mutate: async () => ACCEPTED },
      reconcile: { mutate: async () => ACCEPTED },
    },
  };
  let ids = 0;
  const transport: ChatSessionTransport = {
    rpc,
    scheduler: { schedule: () => () => undefined },
    newCommandId: () => `cmd-${++ids}`,
    createSession: async (input) => {
      if (input.ticketId === null) {
        projectStarts.push({
          operationId: input.operationId,
          projectId: input.projectId,
          title: input.title,
        });
      } else ticketStarts.push(input);
      return state.createAnswer(input);
    },
    attachSession: async (input) => {
      attaches.push(input);
      if (attachGate !== null) await attachGate;
      return state.attachAnswer();
    },
  };
  return {
    attaches,
    commands,
    holdAttach,
    projectStarts,
    releaseAttach: () => releaseAttach(),
    subscriptions,
    state,
    ticketStarts,
    transport,
  };
}

function fixture() {
  const edge = fakeTransport();
  const store = createChatSessionsStore(() => edge.transport);
  opened.push(store);
  return { ...edge, store };
}

const opened: ReturnType<typeof createChatSessionsStore>[] = [];

afterEach(() => {
  for (const store of opened) {
    for (const sessionId of Object.keys(store.getState().sessions)) {
      store.getState().closeChatSession(sessionId);
    }
  }
  opened.length = 0;
  useChatDraftsStore.setState({ drafts: {} });
  vi.unstubAllGlobals();
  vi.mocked(toast.error).mockClear();
});

describe("createChatSession", () => {
  it("lands the Session id from the create-only route while the attach is still in flight", async () => {
    // The optimistic open (VC-16): the id — and with it the tab — must not
    // wait on the attach, which is where the Ticket worktree materializes and
    // the Agent Runtime boots. The attach is held open across the await to
    // prove the resolution order, not just observe it.
    const { attaches, commands, holdAttach, releaseAttach, store, subscriptions, ticketStarts } =
      fixture();
    holdAttach();

    const sessionId = await store.getState().createChatSession({
      projectId: "p1",
      ticketId: "t1",
      title: "VC-1 · parser",
    });

    expect(sessionId).toBe(SESSION.id);
    expect(ticketStarts).toEqual([
      {
        operationId: "cmd-1",
        projectId: "p1",
        ticketId: "t1",
        title: "VC-1 · parser",
      },
    ]);
    // The attach left on the create's heels — in flight, not awaited.
    expect(attaches).toMatchObject([{ sessionId: SESSION.id }]);
    expect(commands).toEqual([]);
    expect(subscriptions).toHaveLength(1);
    // `starting` is the attach latch — the pane is open, the composer queues.
    expect(store.getState().sessions[SESSION.id]).toMatchObject({
      lifecycle: "starting",
      sessionError: null,
      queue: [],
      transcript: EMPTY_TRANSCRIPT,
    });
    expect(getChatClient(SESSION.id)).toBeDefined();

    releaseAttach();
    await vi.waitFor(() => {
      expect(store.getState().sessions[SESSION.id]?.lifecycle).toBe("ready");
    });
  });

  it("starts a ticketless chat through the create-only project route", async () => {
    const { attaches, commands, projectStarts, store } = fixture();

    await store.getState().createChatSession({
      projectId: "p1",
      ticketId: null,
      title: null,
    });

    expect(projectStarts).toEqual([{ operationId: "cmd-1", projectId: "p1", title: null }]);
    expect(commands).toEqual([]);
    await vi.waitFor(() => {
      expect(attaches).toMatchObject([{ sessionId: SESSION.id }]);
    });
  });

  it("carries named skills onto the create, and only when the list has any", async () => {
    const { store, ticketStarts } = fixture();

    await store.getState().createChatSession({
      projectId: "p1",
      ticketId: "t1",
      title: "VC-1",
      skills: ["svg-logo-designer"],
    });
    await store.getState().createChatSession({
      projectId: "p1",
      ticketId: "t1",
      title: "VC-1",
      skills: [],
    });

    expect(ticketStarts[0]).toMatchObject({ skills: ["svg-logo-designer"] });
    expect(ticketStarts[1]).not.toHaveProperty("skills");
  });

  it("carries a chosen model onto the create, and omits it when the surface picked none", async () => {
    const { store, ticketStarts } = fixture();

    // The New-ticket composer's Create & start states the Session's model and
    // effort up front (VC-56); every other start leaves the Role's default to
    // main, and "absent" is how it says so — never an explicit undefined.
    await store.getState().createChatSession({
      projectId: "p1",
      ticketId: "t1",
      title: "Work on VC-1",
      model: { providerId: "anthropic", modelId: "sonnet-4.5", reasoningLevel: "high" },
    });
    await store.getState().createChatSession({ projectId: "p1", ticketId: "t1", title: null });

    expect(ticketStarts[0]).toMatchObject({
      model: { providerId: "anthropic", modelId: "sonnet-4.5", reasoningLevel: "high" },
    });
    expect(ticketStarts[1]).not.toHaveProperty("model");
  });

  it("keeps the durable Session when the background attach is refused", async () => {
    // A refused attach does not un-create the Session: the id came back before
    // the attach settled, and the error lands on the Session it belongs to.
    const { state, store } = fixture();
    state.attachAnswer = () => ({ ...REFUSED, state: "needs-recovery", throughSequence: 2 });

    const sessionId = await store.getState().createChatSession({
      projectId: "p1",
      ticketId: null,
      title: null,
    });

    expect(sessionId).toBe(SESSION.id);
    await vi.waitFor(() => {
      expect(store.getState().sessions[SESSION.id]).toMatchObject({
        lifecycle: "error",
        sessionError: "Could not start Session: Pi is unavailable",
      });
    });
  });

  it("uses a product recovery message when a ticketless attach has no receipt", async () => {
    const { state, store } = fixture();
    state.attachAnswer = () => ({
      sessionId: SESSION.id,
      state: "needs-recovery",
      receipt: null,
      throughSequence: 2,
    });

    await store.getState().createChatSession({ projectId: "p1", ticketId: null, title: null });

    await vi.waitFor(() => {
      expect(store.getState().sessions[SESSION.id]?.sessionError).toBe(
        "Could not start Session: Runtime recovery is required.",
      );
    });
  });

  it("settles a background attach transport failure as the Session's own error", async () => {
    // The create answered, so the Session exists — an attach that never reached
    // main must surface on it rather than vanish into a rejected background
    // promise (CLAUDE.md: no silently swallowed mutation).
    const { state, store } = fixture();
    state.attachAnswer = () => {
      throw new Error("socket hang up");
    };

    const sessionId = await store.getState().createChatSession({
      projectId: "p1",
      ticketId: "t1",
      title: null,
    });

    expect(sessionId).toBe(SESSION.id);
    await vi.waitFor(() => {
      expect(store.getState().sessions[SESSION.id]).toMatchObject({
        lifecycle: "error",
        sessionError: "Could not start Session: socket hang up",
      });
    });
  });

  it("lets durable Ticket Attention explain a refused attach without masking recovery", async () => {
    const { state, store } = fixture();
    state.attachAnswer = () => ({ ...REFUSED, state: "needs-recovery", throughSequence: 2 });

    const sessionId = await store.getState().createChatSession({
      projectId: "p1",
      ticketId: "ticket-1",
      title: null,
    });

    expect(sessionId).toBe(SESSION.id);
    await vi.waitFor(() => {
      expect(store.getState().sessions[SESSION.id]).toMatchObject({
        lifecycle: "ready",
        sessionError: null,
      });
    });
  });

  it("has no Session to keep when the create itself never answered", async () => {
    const { state, store } = fixture();
    state.createAnswer = () => {
      throw new Error("socket hang up");
    };

    await expect(
      store.getState().createChatSession({ projectId: "p1", ticketId: null, title: null }),
    ).resolves.toBeNull();

    expect(store.getState().sessions).toEqual({});
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      "Could not start Session: socket hang up",
      expect.anything(),
    );
  });

  it("answers the missing-default refusal with Model Access, never a toast", async () => {
    // Both Roles record a default before anything attaches, so both refuse
    // before a Session exists when none resolves. That is a predictable
    // configuration state (VC-53): the recovery is Model Access, so the store
    // opens it there — straight at the pane — instead of raising an error
    // toast about a setting the toast cannot fix.
    const { state, store } = fixture();
    const refusal = "Choose a default model in Settings before starting a Session.";

    state.createAnswer = () => {
      throw new Error(refusal);
    };
    await expect(
      store.getState().createChatSession({ projectId: "p1", ticketId: null, title: null }),
    ).resolves.toBeNull();
    await expect(
      store.getState().createChatSession({ projectId: "p1", ticketId: "t1", title: null }),
    ).resolves.toBeNull();

    expect(store.getState().sessions).toEqual({});
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
    expect(useUiStore.getState().settingsOpen).toBe(true);
    expect(useUiStore.getState().settingsCategory).toBe("model-access");
    useUiStore.getState().setSettingsOpen(false);
  });
});

describe("promoteChatSession", () => {
  const DRAFT_ID = "550e8400-e29b-41d4-a716-446655440000";

  function openDraft(withBlob = false) {
    vi.stubGlobal("window", {
      api: {
        attachments: { linkDrafts: vi.fn() },
        sessions: { listForTicket: vi.fn(async () => ({ ok: true as const, sessions: [] })) },
      },
    });
    useChatDraftsStore.getState().openProvisional(DRAFT_ID, {
      projectId: "p1",
      ticketId: "t1",
      operationId: "promotion-op",
      title: null,
    });
    useChatDraftsStore.getState().setDraft(DRAFT_ID, "first message");
    if (withBlob) {
      useChatDraftsStore.getState().setDraftAttachments(DRAFT_ID, [
        {
          linkId: null,
          blobHash: "ab".repeat(32),
          label: "shot.png",
          originalName: "shot.png",
          mime: "image/png",
          sizeBytes: 2048,
        },
      ]);
    }
  }

  it("creates under the Draft id and connects only after ownerless Blobs are linked", async () => {
    const { attaches, store, subscriptions, ticketStarts } = fixture();
    openDraft(true);
    let releaseLink!: () => void;
    const linked = new Promise<void>((resolve) => (releaseLink = resolve));
    const firstLinked = {
      linkId: "link-1",
      blobHash: "ab".repeat(32),
      label: "shot.png",
      originalName: "shot.png",
      mime: "image/png",
      sizeBytes: 2048,
    };
    const lateLinked = {
      ...firstLinked,
      linkId: "link-2",
      blobHash: "cd".repeat(32),
      label: "late.png",
      originalName: "late.png",
    };
    const linkDrafts = vi
      .fn()
      .mockImplementationOnce(async () => {
        await linked;
        return { ok: true as const, blobs: [firstLinked] };
      })
      .mockResolvedValue({ ok: true as const, blobs: [firstLinked, lateLinked] });
    vi.stubGlobal("window", {
      api: {
        attachments: { linkDrafts },
        sessions: { listForTicket: vi.fn(async () => ({ ok: true as const, sessions: [] })) },
      },
    });

    const promotion = store.getState().promoteChatSession(DRAFT_ID);
    await vi.waitFor(() => expect(linkDrafts).toHaveBeenCalledOnce());

    expect(ticketStarts).toEqual([
      {
        operationId: "promotion-op",
        projectId: "p1",
        ticketId: "t1",
        title: null,
        requestedSessionId: DRAFT_ID,
      },
    ]);
    expect(attaches).toEqual([]);
    expect(subscriptions).toEqual([]);
    expect(store.getState().sessions[DRAFT_ID]).toBeUndefined();
    expect(useChatDraftsStore.getState().drafts[DRAFT_ID]?.provisional?.phase).toBe(
      "session-created",
    );

    // An import that finishes while the first transfer is waiting must join a
    // second batch before attach; after promotion there is no Draft link path.
    useChatDraftsStore
      .getState()
      .setDraftAttachments(DRAFT_ID, [
        useChatDraftsStore.getState().drafts[DRAFT_ID]!.attachments[0]!,
        { ...lateLinked, linkId: null },
      ]);
    releaseLink();
    await expect(promotion).resolves.toBe(true);
    expect(linkDrafts).toHaveBeenCalledTimes(2);
    expect(useChatDraftsStore.getState().drafts[DRAFT_ID]?.provisional?.phase).toBe(
      "session-created",
    );
    useChatDraftsStore.getState().completePromotion(DRAFT_ID);
    expect(useChatDraftsStore.getState().drafts[DRAFT_ID]?.provisional).toBeUndefined();
    expect(
      useChatDraftsStore
        .getState()
        .drafts[DRAFT_ID]?.attachments.map((attachment) => attachment.linkId),
    ).toEqual(["link-1", "link-2"]);
    expect(attaches).toEqual([{ operationId: "cmd-1", sessionId: DRAFT_ID }]);
    await vi.waitFor(() => expect(subscriptions).toHaveLength(1));
  });

  it("does not attach a resident runtime when the tab closes during Blob transfer", async () => {
    const { attaches, store, subscriptions } = fixture();
    openDraft(true);
    useChatDraftsStore.getState().holdMessage(DRAFT_ID, {
      id: "first-send",
      text: "first message",
    });
    store.getState().openChatTab("t1", DRAFT_ID);
    let releaseLink!: () => void;
    const linkWait = new Promise<void>((resolve) => (releaseLink = resolve));
    vi.mocked(window.api.attachments.linkDrafts).mockImplementation(async ({ blobs }) => {
      await linkWait;
      return {
        ok: true as const,
        blobs: blobs.map((blob, index) => ({
          linkId: `linked-${index}`,
          blobHash: blob.blobHash,
          label: blob.label ?? "attachment",
          originalName: blob.label ?? "attachment",
          mime: "image/png",
          sizeBytes: 2048,
        })),
      };
    });

    const promotion = store.getState().promoteChatSession(DRAFT_ID);
    await vi.waitFor(() =>
      expect(useChatDraftsStore.getState().drafts[DRAFT_ID]?.provisional?.phase).toBe(
        "session-created",
      ),
    );
    store.getState().closeChatTab("t1", DRAFT_ID);
    releaseLink();

    await expect(promotion).resolves.toBe(true);
    expect(attaches).toEqual([]);
    expect(subscriptions).toEqual([]);
    expect(store.getState().sessions[DRAFT_ID]).toBeUndefined();
    expect(useChatDraftsStore.getState().drafts[DRAFT_ID]?.provisional).toBeUndefined();
    expect(useChatDraftsStore.getState().drafts[DRAFT_ID]?.held[0]?.state).toBe("unsent");
  });

  it("does not attach a runtime when project teardown lands during Blob transfer", async () => {
    const { attaches, store, subscriptions } = fixture();
    openDraft(true);
    store.getState().openChatTab("p1", DRAFT_ID);
    let releaseLink!: () => void;
    const linkWait = new Promise<void>((resolve) => (releaseLink = resolve));
    vi.mocked(window.api.attachments.linkDrafts).mockImplementation(async ({ blobs }) => {
      await linkWait;
      return {
        ok: true as const,
        blobs: blobs.map((blob, index) => ({
          linkId: `linked-${index}`,
          blobHash: blob.blobHash,
          label: blob.label ?? "attachment",
          originalName: blob.label ?? "attachment",
          mime: "image/png",
          sizeBytes: 2048,
        })),
      };
    });

    const promotion = store.getState().promoteChatSession(DRAFT_ID);
    await vi.waitFor(() =>
      expect(useChatDraftsStore.getState().drafts[DRAFT_ID]?.provisional?.phase).toBe(
        "session-created",
      ),
    );
    store.getState().dropChatTabs(["p1"]);
    releaseLink();

    await expect(promotion).resolves.toBe(true);
    expect(attaches).toEqual([]);
    expect(subscriptions).toEqual([]);
    expect(store.getState().sessions[DRAFT_ID]).toBeUndefined();
    expect(useChatDraftsStore.getState().drafts[DRAFT_ID]).toBeUndefined();
  });

  it("holds the whole mint for an import that began before Send", async () => {
    const { attaches, store, ticketStarts } = fixture();
    openDraft();
    const finishImport = useChatDraftsStore.getState().beginAttachmentImport(DRAFT_ID);
    const linked = {
      linkId: "link-late",
      blobHash: "ef".repeat(32),
      label: "late.png",
      originalName: "late.png",
      mime: "image/png",
      sizeBytes: 1024,
    };
    const linkDrafts = vi.fn(async () => ({ ok: true as const, blobs: [linked] }));
    vi.stubGlobal("window", {
      api: {
        attachments: { linkDrafts },
        sessions: { listForTicket: vi.fn(async () => ({ ok: true as const, sessions: [] })) },
      },
    });

    const promotion = store.getState().promoteChatSession(DRAFT_ID);
    // Not merely the link: the CREATE waits too. The image budget is asked
    // before anything durable exists, and it cannot be answered while a file
    // that belongs to this same first message is still arriving — minting
    // first would be minting a Session we might have to refuse (VC-358).
    await Promise.resolve();
    await Promise.resolve();
    expect(ticketStarts).toEqual([]);
    expect(linkDrafts).not.toHaveBeenCalled();
    expect(attaches).toEqual([]);

    useChatDraftsStore.getState().setDraftAttachments(DRAFT_ID, [{ ...linked, linkId: null }]);
    finishImport();

    await expect(promotion).resolves.toBe(true);
    expect(ticketStarts).toHaveLength(1);
    expect(linkDrafts).toHaveBeenCalledWith({
      sessionId: DRAFT_ID,
      blobs: [{ blobHash: linked.blobHash, label: "late.png" }],
    });
    expect(attaches).toEqual([{ operationId: "cmd-1", sessionId: DRAFT_ID }]);
  });

  it("stops before client connect or attach when close abandons the Draft during create", async () => {
    const { attaches, state, store, subscriptions, ticketStarts } = fixture();
    openDraft();
    store.getState().openChatTab("t1", DRAFT_ID);
    let finishCreate!: (created: { sessionId: string }) => void;
    state.createAnswer = () => new Promise((resolve) => (finishCreate = resolve));

    const promotion = store.getState().promoteChatSession(DRAFT_ID);
    await vi.waitFor(() => expect(ticketStarts).toHaveLength(1));
    store.getState().closeChatTab("t1", DRAFT_ID);
    finishCreate({ sessionId: DRAFT_ID });

    await expect(promotion).resolves.toBe(true);
    expect(useChatDraftsStore.getState().drafts[DRAFT_ID]).toBeUndefined();
    expect(store.getState().sessions[DRAFT_ID]).toBeUndefined();
    expect(subscriptions).toEqual([]);
    expect(attaches).toEqual([]);
  });

  it("shares one promotion flight across rapid sends", async () => {
    const { store, ticketStarts } = fixture();
    openDraft();

    const first = store.getState().promoteChatSession(DRAFT_ID);
    const second = store.getState().promoteChatSession(DRAFT_ID);

    expect(second).toBe(first);
    await expect(first).resolves.toBe(true);
    expect(ticketStarts).toHaveLength(1);
  });

  it("keeps post-create metadata and retries Blob transfer under the same create operation", async () => {
    const { attaches, store, subscriptions, ticketStarts } = fixture();
    openDraft(true);
    const frozenModel = {
      providerId: "acme",
      modelId: "sonnet",
      reasoningLevel: "high" as const,
    };
    useChatDraftsStore.getState().setProvisionalModel(DRAFT_ID, frozenModel);
    const linkDrafts = vi
      .fn()
      .mockResolvedValueOnce({ ok: false as const, error: "disk full" })
      .mockResolvedValueOnce({
        ok: true as const,
        blobs: [
          {
            linkId: "link-1",
            blobHash: "ab".repeat(32),
            label: "shot.png",
            originalName: "shot.png",
            mime: "image/png",
            sizeBytes: 2048,
          },
        ],
      });
    vi.stubGlobal("window", {
      api: {
        attachments: { linkDrafts },
        sessions: { listForTicket: vi.fn(async () => ({ ok: true as const, sessions: [] })) },
      },
    });

    await expect(store.getState().promoteChatSession(DRAFT_ID)).resolves.toBe(false);
    expect(attaches).toEqual([]);
    expect(subscriptions).toEqual([]);
    expect(store.getState().sessions[DRAFT_ID]).toBeUndefined();
    expect(useChatDraftsStore.getState().drafts[DRAFT_ID]?.provisional?.phase).toBe(
      "session-created",
    );

    await expect(store.getState().promoteChatSession(DRAFT_ID)).resolves.toBe(true);
    expect(ticketStarts).toHaveLength(2);
    expect(ticketStarts.map((input) => (input as { operationId: string }).operationId)).toEqual([
      "promotion-op",
      "promotion-op",
    ]);
    expect(ticketStarts).toEqual([
      expect.objectContaining({ model: frozenModel }),
      expect.objectContaining({ model: frozenModel }),
    ]);
    expect(linkDrafts).toHaveBeenCalledTimes(2);
    expect(attaches).toEqual([{ operationId: "cmd-1", sessionId: DRAFT_ID }]);
    await vi.waitFor(() => expect(subscriptions).toHaveLength(1));
  });

  it("uses a fresh attach operation when session-created recovery replays create", async () => {
    const { attaches, state, store } = fixture();
    openDraft();
    state.attachAnswer = () => ({
      sessionId: DRAFT_ID,
      receipt: REJECTED_RECEIPT,
      state: "needs-recovery",
      throughSequence: 0,
    });

    await expect(store.getState().promoteChatSession(DRAFT_ID)).resolves.toBe(true);
    await vi.waitFor(() => expect(attaches).toHaveLength(1));
    store.getState().closeChatSession(DRAFT_ID);
    await expect(store.getState().promoteChatSession(DRAFT_ID)).resolves.toBe(true);
    await vi.waitFor(() => expect(attaches).toHaveLength(2));

    expect(attaches).toEqual([
      { operationId: "cmd-1", sessionId: DRAFT_ID },
      { operationId: "cmd-2", sessionId: DRAFT_ID },
    ]);
  });

  it("shares one flight when a second Send lands mid-promotion, and queues both in order", async () => {
    // Two ⏎ in quick succession. The Draft mints once: a second create would
    // either collide on the id or strand the first Session, and the ordered
    // queue is what VC-16 built so typing before a runtime is live works.
    const { attaches, state, store, ticketStarts } = fixture();
    openDraft();
    let finishCreate!: (created: { sessionId: string }) => void;
    state.createAnswer = () => new Promise((resolve) => (finishCreate = resolve));

    const first = store.getState().promoteChatSession(DRAFT_ID);
    await vi.waitFor(() => expect(ticketStarts).toHaveLength(1));
    const second = store.getState().promoteChatSession(DRAFT_ID);
    finishCreate({ sessionId: DRAFT_ID });

    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect(ticketStarts).toEqual([
      expect.objectContaining({ operationId: "promotion-op", requestedSessionId: DRAFT_ID }),
    ]);
    await vi.waitFor(() => expect(attaches).toHaveLength(1));

    // Both messages reach the one Session, in the order they were pressed.
    store.getState().enqueue(DRAFT_ID, { id: "m1", text: "first" });
    store.getState().enqueue(DRAFT_ID, { id: "m2", text: "second" });
    expect(store.getState().sessions[DRAFT_ID]?.queue.map(({ text }) => text)).toEqual([
      "first",
      "second",
    ]);
  });

  it("hands the words back as unsent when the create fails for a reason Model Access cannot fix", async () => {
    // The missing-default refusal has its own recovery (Model Access). Every
    // other create failure has to leave the person exactly where they were:
    // a Draft, still provisional, with the message retryable rather than
    // stuck in `sending` with nothing to press.
    const { attaches, state, store, ticketStarts } = fixture();
    openDraft();
    useChatDraftsStore.getState().holdMessage(DRAFT_ID, { id: "m1", text: "first message" });
    useChatDraftsStore.getState().markHeld(DRAFT_ID, "m1", "sending");
    state.createAnswer = () => Promise.reject(new Error("the edge is down"));

    await expect(store.getState().promoteChatSession(DRAFT_ID)).resolves.toBe(false);
    useChatDraftsStore.getState().markHeld(DRAFT_ID, "m1", "unsent");

    expect(vi.mocked(toast.error).mock.calls.at(-1)?.[0]).toContain("the edge is down");
    expect(useUiStore.getState().settingsOpen).toBe(false);
    expect(useChatDraftsStore.getState().drafts[DRAFT_ID]?.held).toEqual([
      { id: "m1", text: "first message", state: "unsent" },
    ]);
    expect(useChatDraftsStore.getState().drafts[DRAFT_ID]?.provisional?.phase).toBe("draft");
    expect(attaches).toEqual([]);
    // The attempt carried the Draft's stable operation id, so the retry the
    // person is now able to make is the SAME command replayed, never a second
    // one that could leave two Sessions behind.
    expect(ticketStarts).toEqual([
      expect.objectContaining({ operationId: "promotion-op", requestedSessionId: DRAFT_ID }),
    ]);
  });

  it("retries a quit-after-mint promotion under the same operation, making one Session", async () => {
    // The app went away between the create landing and the Blob transfer
    // finishing. `session-created` is the recovery marker that survived in
    // app_state; replaying must restate the same command, not mint a second
    // Session under a second id.
    const { attaches, store, ticketStarts } = fixture();
    openDraft(true);
    useChatDraftsStore.getState().markProvisionalSessionCreated(DRAFT_ID);
    vi.mocked(window.api.attachments.linkDrafts).mockImplementation(async ({ blobs }) => ({
      ok: true as const,
      blobs: blobs.map((blob, index) => ({
        linkId: `linked-${index}`,
        blobHash: blob.blobHash,
        label: blob.label ?? "attachment",
        originalName: blob.label ?? "attachment",
        mime: "image/png",
        sizeBytes: 2048,
      })),
    }));

    await expect(store.getState().promoteChatSession(DRAFT_ID)).resolves.toBe(true);

    expect(ticketStarts).toEqual([
      expect.objectContaining({ operationId: "promotion-op", requestedSessionId: DRAFT_ID }),
    ]);
    // A fresh attach operation, deliberately: replaying a rejected attach
    // receipt would make recovery refuse the same work forever.
    await vi.waitFor(() =>
      expect(attaches).toEqual([{ operationId: "cmd-1", sessionId: DRAFT_ID }]),
    );
    expect(useChatDraftsStore.getState().drafts[DRAFT_ID]?.provisional?.phase).toBe(
      "session-created",
    );
  });

  it("keeps a ticket Draft's first message queued when its worktree is unavailable at send", async () => {
    // Deferring the worktree ensure to first send moves this discovery to a
    // worse moment, which the design accepted on ONE condition: the words wait
    // for a Retry rather than being lost. The Session is durable by then, so
    // there is somewhere for them to wait and something for Retry to address.
    const { attaches, state, store, ticketStarts } = fixture();
    openDraft();
    // What main answers when the Ticket's worktree cannot be materialized.
    state.attachAnswer = () => ({ ...REFUSED, state: "needs-recovery", throughSequence: 2 });

    await expect(store.getState().promoteChatSession(DRAFT_ID)).resolves.toBe(true);
    await vi.waitFor(() => expect(attaches.length).toBeGreaterThanOrEqual(1));

    // The create still landed: a refused ATTACH does not un-create a Session,
    // and the no-delete rule means it never could.
    expect(ticketStarts).toEqual([
      expect.objectContaining({ operationId: "promotion-op", requestedSessionId: DRAFT_ID }),
    ]);
    expect(store.getState().sessions[DRAFT_ID]).toBeDefined();

    store.getState().enqueue(DRAFT_ID, { id: "m1", text: "first message" });
    expect(store.getState().sessions[DRAFT_ID]?.queue.map(({ text }) => text)).toEqual([
      "first message",
    ]);
    // And it stays there. Nothing drops a queued message because an attach was
    // refused — the queue is what a Retry releases once the worktree exists.
    await vi.waitFor(() => expect(store.getState().sessions[DRAFT_ID]?.lifecycle).toBe("error"));
    expect(store.getState().sessions[DRAFT_ID]?.queue.map(({ text }) => text)).toEqual([
      "first message",
    ]);
  });

  it("refuses a Session the edge minted under an id the Draft did not ask for", async () => {
    const { attaches, state, store } = fixture();
    openDraft();
    // The Draft's id IS the durable id (VC-358). An edge that answers with a
    // different one has not promoted this Draft, and adopting it would strand
    // every tab, pane and shortcut still naming the Draft.
    state.createAnswer = () => ({ sessionId: "someone-elses-session" });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(store.getState().promoteChatSession(DRAFT_ID)).resolves.toBe(false);

      // The person is told what to do and nothing else. Two raw UUIDs on the
      // page are diagnosis, which is our job, not theirs (CLAUDE.md) — so they
      // go to the log a support report can read instead.
      expect(vi.mocked(toast.error).mock.calls.at(-1)?.[0]).toBe(
        "Could not start Session. Try sending again.",
      );
      expect(logged.mock.calls.at(-1)?.[0]).toContain("someone-elses-session");
      expect(logged.mock.calls.at(-1)?.[0]).toContain(DRAFT_ID);
    } finally {
      logged.mockRestore();
    }
    expect(attaches).toEqual([]);
    expect(store.getState().sessions[DRAFT_ID]).toBeUndefined();
  });

  it("keeps the Draft and its words when the create itself fails", async () => {
    const { attaches, state, store } = fixture();
    openDraft();
    state.createAnswer = () => Promise.reject(new Error("edge is down"));

    await expect(store.getState().promoteChatSession(DRAFT_ID)).resolves.toBe(false);

    expect(vi.mocked(toast.error).mock.calls.at(-1)?.[0]).toContain("edge is down");
    expect(attaches).toEqual([]);
    // Nothing durable happened, so the Draft is still the whole truth.
    expect(useChatDraftsStore.getState().drafts[DRAFT_ID]?.provisional?.phase).toBe("draft");
    expect(useChatDraftsStore.getState().drafts[DRAFT_ID]?.text).toBe("first message");
  });

  it("refuses an over-budget image strip BEFORE it mints anything durable", async () => {
    const { attaches, store, ticketStarts } = fixture();
    openDraft();
    const linkDrafts = vi.fn();
    vi.stubGlobal("window", {
      api: {
        attachments: { linkDrafts },
        sessions: { listForTicket: vi.fn(async () => ({ ok: true as const, sessions: [] })) },
      },
    });
    // Three images, each individually legal at import (under the 5 MB per-file
    // cap), together past the 20 MB one chat may carry. A durable chat is held
    // to that ceiling at every import; a Draft could not be, because it had no
    // Session to measure. This is the moment the rule catches up (VC-358).
    useChatDraftsStore.getState().setDraftAttachments(
      DRAFT_ID,
      ["ab", "cd", "ef", "12", "34"].map((byte) => ({
        linkId: null,
        blobHash: byte.repeat(32),
        label: `shot-${byte}.png`,
        originalName: `shot-${byte}.png`,
        mime: "image/png",
        sizeBytes: 4.5 * 1024 * 1024,
      })),
    );

    await expect(store.getState().promoteChatSession(DRAFT_ID)).resolves.toBe(false);

    expect(vi.mocked(toast.error).mock.calls.at(-1)?.[0]).toBe(
      "These images come to 22.5 MB, past the 20.0 MB a single chat can carry. " +
        "Remove one and send again.",
    );
    // The point of the whole fix: no Session row, no attachment, no link call.
    expect(ticketStarts).toEqual([]);
    expect(attaches).toEqual([]);
    expect(linkDrafts).not.toHaveBeenCalled();
    expect(store.getState().sessions).toEqual({});
    // And the words are still the Draft's, so removing one image and sending
    // again is the whole recovery.
    expect(useChatDraftsStore.getState().drafts[DRAFT_ID]?.provisional?.phase).toBe("draft");
    expect(useChatDraftsStore.getState().drafts[DRAFT_ID]?.text).toBe("first message");
  });

  it("mints when a heavy strip is non-inlinable, which spends no conversation budget", async () => {
    const { store, ticketStarts } = fixture();
    openDraft();
    // Same bytes, but a PDF is read from disk once rather than replayed into
    // every turn, so it is a disk question and never a budget one.
    useChatDraftsStore.getState().setDraftAttachments(DRAFT_ID, [
      {
        linkId: null,
        blobHash: "ab".repeat(32),
        label: "spec.pdf",
        originalName: "spec.pdf",
        mime: "application/pdf",
        sizeBytes: 40 * 1024 * 1024,
      },
    ]);
    vi.mocked(window.api.attachments.linkDrafts).mockImplementation(async () => ({
      ok: true as const,
      blobs: [
        {
          linkId: "link-1",
          blobHash: "ab".repeat(32),
          label: "spec.pdf",
          originalName: "spec.pdf",
          mime: "application/pdf",
          sizeBytes: 40 * 1024 * 1024,
        },
      ],
    }));

    await expect(store.getState().promoteChatSession(DRAFT_ID)).resolves.toBe(true);

    expect(ticketStarts).toHaveLength(1);
  });

  it("promotes a ticketless Draft without asking any ticket to refresh its rail", async () => {
    const { attaches, projectStarts, store } = fixture();
    const listForTicket = vi.fn(async () => ({ ok: true as const, sessions: [] }));
    vi.stubGlobal("window", {
      api: { attachments: { linkDrafts: vi.fn() }, sessions: { listForTicket } },
    });
    useChatDraftsStore.getState().openProvisional(DRAFT_ID, {
      projectId: "p1",
      ticketId: null,
      operationId: "promotion-op",
      title: null,
    });
    useChatDraftsStore.getState().setDraft(DRAFT_ID, "first message");

    await expect(store.getState().promoteChatSession(DRAFT_ID)).resolves.toBe(true);

    expect(projectStarts).toEqual([{ operationId: "promotion-op", projectId: "p1", title: null }]);
    expect(listForTicket).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(attaches).toEqual([{ operationId: "cmd-1", sessionId: DRAFT_ID }]),
    );
  });

  it("hands back only the message that was in flight when the tab closed mid-transfer", async () => {
    const { store } = fixture();
    openDraft(true);
    const drafts = useChatDraftsStore.getState();
    drafts.holdMessage(DRAFT_ID, { id: "in-flight", text: "first message" });
    drafts.holdMessage(DRAFT_ID, { id: "waiting", text: "second message" });
    drafts.markHeld(DRAFT_ID, "waiting", "queued");
    store.getState().openChatTab("t1", DRAFT_ID);
    let releaseLink!: () => void;
    const linkWait = new Promise<void>((resolve) => (releaseLink = resolve));
    vi.mocked(window.api.attachments.linkDrafts).mockImplementation(async ({ blobs }) => {
      await linkWait;
      return {
        ok: true as const,
        blobs: blobs.map((blob, index) => ({
          linkId: `linked-${index}`,
          blobHash: blob.blobHash,
          label: blob.label ?? "attachment",
          originalName: blob.label ?? "attachment",
          mime: "image/png",
          sizeBytes: 2048,
        })),
      };
    });

    const promotion = store.getState().promoteChatSession(DRAFT_ID);
    await vi.waitFor(() =>
      expect(useChatDraftsStore.getState().drafts[DRAFT_ID]?.provisional?.phase).toBe(
        "session-created",
      ),
    );
    store.getState().closeChatTab("t1", DRAFT_ID);
    releaseLink();
    await expect(promotion).resolves.toBe(true);

    // `sending` is the one state with no retry surface behind it. A queued row
    // already has one, and rewriting it would be a lie about where it stood.
    const held = useChatDraftsStore.getState().drafts[DRAFT_ID]?.held ?? [];
    expect(held.map(({ id, state }) => [id, state])).toEqual([
      ["in-flight", "unsent"],
      ["waiting", "queued"],
    ]);
  });

  it("carries the Draft's chosen skills into the create it was born with", async () => {
    const { store, ticketStarts } = fixture();
    vi.stubGlobal("window", {
      api: {
        attachments: { linkDrafts: vi.fn() },
        sessions: { listForTicket: vi.fn(async () => ({ ok: true as const, sessions: [] })) },
      },
    });
    useChatDraftsStore.getState().openProvisional(DRAFT_ID, {
      projectId: "p1",
      ticketId: "t1",
      operationId: "promotion-op",
      title: null,
      skills: ["logos"],
    });
    useChatDraftsStore.getState().setDraft(DRAFT_ID, "first message");

    await expect(store.getState().promoteChatSession(DRAFT_ID)).resolves.toBe(true);

    expect(ticketStarts).toEqual([
      {
        operationId: "promotion-op",
        projectId: "p1",
        ticketId: "t1",
        title: null,
        requestedSessionId: DRAFT_ID,
        skills: ["logos"],
      },
    ]);
  });

  it("refuses the send when a staged file does not come back from the transfer", async () => {
    const { attaches, store } = fixture();
    openDraft(true);
    vi.stubGlobal("window", {
      api: {
        attachments: {
          // Answers `ok`, but without the Blob it was asked to adopt: the
          // Session would attach holding a file the composer still shows.
          linkDrafts: vi.fn(async () => ({ ok: true as const, blobs: [] })),
        },
        sessions: { listForTicket: vi.fn(async () => ({ ok: true as const, sessions: [] })) },
      },
    });

    await expect(store.getState().promoteChatSession(DRAFT_ID)).resolves.toBe(false);

    expect(vi.mocked(toast.error).mock.calls.at(-1)?.[0]).toContain("shot.png");
    expect(attaches).toEqual([]);
  });

  it("refuses the send when the transfer itself throws", async () => {
    const { attaches, store } = fixture();
    openDraft(true);
    vi.stubGlobal("window", {
      api: {
        attachments: {
          linkDrafts: vi.fn(async () => {
            throw new Error("database is locked");
          }),
        },
        sessions: { listForTicket: vi.fn(async () => ({ ok: true as const, sessions: [] })) },
      },
    });

    await expect(store.getState().promoteChatSession(DRAFT_ID)).resolves.toBe(false);

    expect(vi.mocked(toast.error).mock.calls.at(-1)?.[0]).toContain("database is locked");
    expect(attaches).toEqual([]);
  });

  it("sends an unlabelled staged file as a hash alone", async () => {
    const { store } = fixture();
    openDraft();
    const linkDrafts = vi.fn(async () => ({ ok: true as const, blobs: [] }));
    vi.stubGlobal("window", {
      api: {
        attachments: { linkDrafts },
        sessions: { listForTicket: vi.fn(async () => ({ ok: true as const, sessions: [] })) },
      },
    });
    useChatDraftsStore.getState().setDraftAttachments(DRAFT_ID, [
      {
        linkId: null,
        blobHash: "ef".repeat(32),
        label: "",
        originalName: "paste.png",
        mime: "image/png",
        sizeBytes: 64,
      },
    ]);

    await store.getState().promoteChatSession(DRAFT_ID);

    // An absent label is not an empty one: main labels the link from the
    // Blob's own name rather than storing "".
    expect(linkDrafts).toHaveBeenCalledWith({
      sessionId: DRAFT_ID,
      blobs: [{ blobHash: "ef".repeat(32) }],
    });
  });

  it("restores persisted provisional Drafts as tabs without making resident Session slices", () => {
    const { store } = fixture();
    openDraft();

    store
      .getState()
      .restoreProvisionalChatTabs(
        useChatDraftsStore.getState().drafts,
        new Set(["t1"]),
        new Set(["p1"]),
      );

    expect(store.getState().openTabs).toEqual({ t1: [DRAFT_ID] });
    // Restoring makes a Draft REACHABLE; it does not decide what comes
    // forward. `provisionalActive` is the overlay that lets an EMPTY Draft be
    // focused without writing the workspace record, and an empty Draft is
    // never persisted — so nothing restored here may claim it. Were it set,
    // the commit effect would overwrite the tab the person actually left on.
    expect(store.getState().provisionalActive).toEqual({});
    expect(store.getState().sessions).toEqual({});
  });

  it("restores a ticketless Draft under its project", () => {
    const { store } = fixture();
    vi.stubGlobal("window", {
      api: {
        attachments: { linkDrafts: vi.fn() },
        sessions: { listForTicket: vi.fn(async () => ({ ok: true as const, sessions: [] })) },
      },
    });
    const drafts = useChatDraftsStore.getState();
    drafts.openProvisional("older-draft", {
      projectId: "p1",
      ticketId: null,
      operationId: "op-older",
      title: null,
    });
    drafts.setDraft("older-draft", "typed first");
    drafts.openProvisional("newer-draft", {
      projectId: "p1",
      ticketId: null,
      operationId: "op-newer",
      title: null,
    });
    drafts.setDraft("newer-draft", "typed second");
    // A Session that has already promoted is not provisional, and restoring
    // tabs must step over it rather than open it as a Draft.
    drafts.setDraft("durable-1", "a Session's draft");

    store
      .getState()
      .restoreProvisionalChatTabs(useChatDraftsStore.getState().drafts, new Set(), new Set(["p1"]));

    expect(store.getState().openTabs).toEqual({ p1: ["older-draft", "newer-draft"] });
    expect(store.getState().provisionalActive).toEqual({});
    expect(store.getState().sessions).toEqual({});
  });

  it("leaves the recorded active tab alone however recently a Draft was touched", () => {
    const { store } = fixture();
    vi.stubGlobal("window", {
      api: {
        attachments: { linkDrafts: vi.fn() },
        sessions: { listForTicket: vi.fn(async () => ({ ok: true as const, sessions: [] })) },
      },
    });
    vi.useFakeTimers();
    try {
      const drafts = useChatDraftsStore.getState();
      vi.setSystemTime(2000);
      drafts.openProvisional("touched-later", {
        projectId: "p1",
        ticketId: null,
        operationId: "op-later",
        title: null,
      });
      drafts.setDraft("touched-later", "typed most recently");
      vi.setSystemTime(1000);
      drafts.openProvisional("touched-earlier", {
        projectId: "p1",
        ticketId: null,
        operationId: "op-earlier",
        title: null,
      });
      drafts.setDraft("touched-earlier", "typed a while ago");

      store
        .getState()
        .restoreProvisionalChatTabs(
          useChatDraftsStore.getState().drafts,
          new Set(),
          new Set(["p1"]),
        );
    } finally {
      vi.useRealTimers();
    }

    // Both are restored and reachable. Neither is forced in front: a Draft
    // typed weeks ago must not take the surface from whatever tab the person
    // was actually on when they quit.
    expect(store.getState().openTabs).toEqual({ p1: ["touched-later", "touched-earlier"] });
    expect(store.getState().provisionalActive).toEqual({});
  });

  it("drops a restored Draft whose project no longer exists", () => {
    const { store } = fixture();
    openDraft();

    store
      .getState()
      .restoreProvisionalChatTabs(useChatDraftsStore.getState().drafts, new Set(), new Set());

    expect(store.getState().openTabs).toEqual({});
    expect(useChatDraftsStore.getState().drafts[DRAFT_ID]).toBeUndefined();
    expect(store.getState().sessions).toEqual({});
  });

  it("rehomes a restored Draft whose ticket is off the live board without changing its birth scope", () => {
    const { store } = fixture();
    openDraft();

    store
      .getState()
      .restoreProvisionalChatTabs(useChatDraftsStore.getState().drafts, new Set(), new Set(["p1"]));

    expect(store.getState().openTabs).toEqual({ p1: [DRAFT_ID] });
    expect(store.getState().provisionalActive).toEqual({});
    expect(store.getState().rehomedTicketBySession).toEqual({ [DRAFT_ID]: "t1" });
    expect(useChatDraftsStore.getState().drafts[DRAFT_ID]?.provisional?.ticketId).toBe("t1");
    expect(store.getState().sessions).toEqual({});
  });
});

describe("adoptChatSession", () => {
  it("does not make a resident client when a split or sidebar opens a provisional Draft", () => {
    const { store, subscriptions } = fixture();
    useChatDraftsStore.getState().openProvisional("draft-9", {
      projectId: "p1",
      ticketId: null,
      operationId: "draft-operation",
      title: null,
    });

    store.getState().adoptChatSession("draft-9");

    expect(store.getState().sessions["draft-9"]).toBeUndefined();
    expect(getChatClient("draft-9")).toBeUndefined();
    expect(subscriptions).toEqual([]);
  });

  it("seeds a slice and opens the stream for a Session that is already durable", async () => {
    const { store, subscriptions } = fixture();

    store.getState().adoptChatSession("durable-9");
    await Promise.resolve();
    await Promise.resolve();

    expect(store.getState().sessions["durable-9"]).toMatchObject({ lifecycle: "ready" });
    expect(subscriptions).toEqual([{ sessionId: "durable-9", afterSequence: 0 }]);
  });

  it("adopts a Session it already holds only once", () => {
    const { store, subscriptions } = fixture();

    store.getState().adoptChatSession("durable-9");
    const first = store.getState().sessions["durable-9"];
    store.getState().adoptChatSession("durable-9");

    expect(store.getState().sessions["durable-9"]).toBe(first);
    expect(subscriptions).toHaveLength(0);
  });
});

describe("closeChatSession", () => {
  it("disposes the client and drops the slice", async () => {
    const { store } = fixture();
    store.getState().adoptChatSession("durable-9");

    store.getState().closeChatSession("durable-9");

    expect(store.getState().sessions["durable-9"]).toBeUndefined();
    expect(getChatClient("durable-9")).toBeUndefined();
  });

  it("is a no-op for a Session this surface never held", () => {
    const { store } = fixture();
    const before = store.getState().sessions;

    store.getState().closeChatSession("never-opened");

    expect(store.getState().sessions).toBe(before);
  });
});

describe("writes addressed to a Session that is gone", () => {
  it("land nowhere rather than resurrecting a slice", () => {
    const { store } = fixture();

    store.getState().applyStream("ghost", [], []);
    store.getState().setProjection("ghost", projection);
    store.getState().attaching("ghost");
    store.getState().settle("ghost", "gone");
    store.getState().enqueue("ghost", { id: "q1", text: "hello" });
    store.getState().dequeue("ghost", "q1");
    store.getState().retitle("ghost", "Parser");

    expect(store.getState().sessions).toEqual({});
  });
});

describe("retitle", () => {
  function seeded() {
    const edge = fixture();
    edge.store.getState().adoptChatSession("durable-9");
    return { ...edge, slice: () => edge.store.getState().sessions["durable-9"]! };
  }

  it("moves the title the surface reads, ahead of the stream", () => {
    const { store, slice } = seeded();
    store.getState().setProjection("durable-9", projection);

    store.getState().retitle("durable-9", "Parser");

    expect(slice().projection?.session).toMatchObject({ id: SESSION.id, title: "Parser" });
  });

  /** No projection is no title to correct — inventing one would put a Session
   * on screen that nothing has described yet. */
  it("keeps its identity for a Session the stream has not described", () => {
    const { store, slice } = seeded();
    const before = slice();

    store.getState().retitle("durable-9", "Parser");

    expect(slice()).toBe(before);
    expect(slice().projection).toBeNull();
  });
});

describe("the in-flight flag", () => {
  it("names the owners with a create in flight, and forgets them once cleared", () => {
    const { store } = fixture();

    store.getState().setStarting("t1", true);
    expect(store.getState().starting).toEqual({ t1: true });

    store.getState().setStarting("t2", true);
    store.getState().setStarting("t1", false);

    expect(store.getState().starting).toEqual({ t2: true });
  });

  it("keeps its identity when the flag already says what it was told", () => {
    const { store } = fixture();
    const empty = store.getState().starting;

    store.getState().setStarting("t1", false);
    expect(store.getState().starting).toBe(empty);

    store.getState().setStarting("t1", true);
    const raised = store.getState().starting;
    store.getState().setStarting("t1", true);

    expect(store.getState().starting).toBe(raised);
  });
});

describe("the slice", () => {
  function seeded() {
    const edge = fixture();
    edge.store.getState().adoptChatSession("durable-9");
    return { ...edge, slice: () => edge.store.getState().sessions["durable-9"]! };
  }

  it("keeps its identity for a batch that folded to nothing", () => {
    const { store, slice } = seeded();
    const before = slice();

    store.getState().applyStream("durable-9", [], []);

    expect(slice()).toBe(before);
  });

  it("latches starting until a command settles it", () => {
    const { store, slice } = seeded();

    store.getState().attaching("durable-9");
    store.getState().setProjection("durable-9", projection);
    expect(slice().lifecycle).toBe("starting");

    store.getState().settle("durable-9", null);

    expect(slice().lifecycle).toBe("ready");
  });

  it("latches an error until a command clears it", () => {
    const { store, slice } = seeded();

    store.getState().settle("durable-9", "Lost the Session stream: socket hang up");
    store.getState().setProjection("durable-9", projection);
    expect(slice()).toMatchObject({
      lifecycle: "error",
      sessionError: "Lost the Session stream: socket hang up",
    });

    store.getState().settle("durable-9", null);

    expect(slice()).toMatchObject({ lifecycle: "ready", sessionError: null });
  });

  it("settles a cleared failure onto whatever the stream is already saying", () => {
    const { store, slice } = seeded();
    store.getState().setProjection("durable-9", {
      ...projection,
      liveExecutor: { id: "attach-1" },
    });
    store.getState().applyStream(
      "durable-9",
      [
        {
          sessionId: SESSION.id,
          sequence: 1,
          event: { payload: { kind: "turn.started" } } as never,
          transcript: null,
        },
      ],
      [],
    );

    store.getState().settle("durable-9", "broke");
    store.getState().settle("durable-9", null);

    expect(slice().lifecycle).toBe("working");
  });

  it("marks a delivered message working while the stream has said nothing since", () => {
    const { store, slice } = seeded();

    store.getState().delivered("durable-9", slice().transcript.turnEpoch);

    expect(slice()).toMatchObject({ lifecycle: "working", sessionError: null });
  });

  it("does not re-open a turn the stream closed while the reply was in flight", () => {
    // Pi answers a submit when the turn it started has already ended, so the
    // reply routinely lands behind its own turn.completed. Latching on it left
    // the composer showing Stop and stranded every queued message behind a
    // turn that was over.
    const { store, slice } = seeded();
    const epoch = slice().transcript.turnEpoch;
    store.getState().setProjection("durable-9", {
      ...projection,
      liveExecutor: { id: "attach-1" },
    });
    store.getState().applyStream(
      "durable-9",
      [
        {
          sessionId: SESSION.id,
          sequence: 1,
          event: { payload: { kind: "turn.started" } } as never,
          transcript: null,
        },
        {
          sessionId: SESSION.id,
          sequence: 2,
          event: { payload: { kind: "turn.completed" } } as never,
          transcript: null,
        },
      ],
      [],
    );

    store.getState().delivered("durable-9", epoch);

    expect(slice()).toMatchObject({ lifecycle: "ready", sessionError: null });
  });
});

describe("the queue", () => {
  function seeded() {
    const edge = fixture();
    edge.store.getState().adoptChatSession("durable-9");
    return { ...edge, slice: () => edge.store.getState().sessions["durable-9"]! };
  }

  it("holds what was typed, in the order it was typed", () => {
    const { store, slice } = seeded();

    store.getState().enqueue("durable-9", { id: "q1", text: " first " });
    store.getState().enqueue("durable-9", { id: "q2", text: "second" });

    expect(slice().queue).toEqual([
      { id: "q1", text: "first" },
      { id: "q2", text: "second" },
    ]);
  });

  it("never takes blank text, and never republishes the slice for it", () => {
    const { store, slice } = seeded();
    const before = slice();

    store.getState().enqueue("durable-9", { id: "q1", text: "   " });

    expect(slice()).toBe(before);
  });

  it("takes one entry back out", () => {
    const { store, slice } = seeded();
    store.getState().enqueue("durable-9", { id: "q1", text: "first" });
    store.getState().enqueue("durable-9", { id: "q2", text: "second" });

    store.getState().dequeue("durable-9", "q1");

    expect(slice().queue).toEqual([{ id: "q2", text: "second" }]);
  });

  it("keeps its identity when the entry to drop was never there", () => {
    const { store, slice } = seeded();
    store.getState().enqueue("durable-9", { id: "q1", text: "first" });
    const before = slice();

    store.getState().dequeue("durable-9", "q9");

    expect(slice()).toBe(before);
  });
});

describe("the deps attach() wires", () => {
  // The notify and renameSession seams are desktop glue (VC-169): the client
  // core names them, and THIS store is where the desktop answers with
  // toastError and renameChatSession. Both are driven end-to-end through a
  // registry client so the wrappers attach() builds are the thing tested.
  async function adoptedDescribed() {
    const edge = fixture();
    edge.store.getState().adoptChatSession("durable-9");
    await vi.waitFor(() => {
      expect(edge.store.getState().sessions["durable-9"]?.projection).not.toBeNull();
    });
    return edge;
  }

  it("routes the client's auto-title through the shared rename path", async () => {
    const renameMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("window", { api: { sessions: { rename: renameMock } } });
    const { store } = await adoptedDescribed();

    // Deliverable and untitled: a live executor, a recorded model, no title.
    // The queued message releases, delivers, and the delivery's auto-title
    // reaches the IPC rename door through the injected wrapper.
    store.getState().setProjection("durable-9", {
      ...projection,
      session: { ...SESSION, title: null },
      liveExecutor: { id: "attach-1" },
      modelSelection: {
        providerId: "openai-codex",
        modelId: "gpt-5.6-sol",
        reasoningLevel: "high",
      },
    });
    store.getState().enqueue("durable-9", { id: "q1", text: "Fix the parser" });

    await vi.waitFor(() => {
      expect(renameMock).toHaveBeenCalledWith({
        sessionId: "durable-9",
        title: "Fix the parser",
        refineFrom: "Fix the parser",
      });
    });
    vi.unstubAllGlobals();
  });

  it("routes an event failure through the error toast — the notify seam", async () => {
    const { state, store } = await adoptedDescribed();
    state.answer = () => REFUSED;

    await expect(
      getChatClient("durable-9")!.selectModel({
        providerId: "openai-codex",
        modelId: "gpt-5.6-sol",
        reasoningLevel: "high",
      }),
    ).resolves.toBe(false);

    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      "Model not changed: Pi is unavailable",
      expect.anything(),
    );
    // The failure is a moment, not a state: nothing latched on the slice.
    expect(store.getState().sessions["durable-9"]).toMatchObject({
      lifecycle: "ready",
      sessionError: null,
    });
  });
});

describe("open chat tabs", () => {
  it("records a ticket's tabs in the order they were opened, once each", () => {
    const { store } = fixture();

    store.getState().openChatTab("t1", "durable-1");
    store.getState().openChatTab("t1", "durable-2");
    store.getState().openChatTab("t1", "durable-1");

    expect(store.getState().openTabs).toEqual({ t1: ["durable-1", "durable-2"] });
  });

  it("keeps its identity when the tab is already open", () => {
    const { store } = fixture();
    store.getState().openChatTab("t1", "durable-1");
    const before = store.getState().openTabs;

    store.getState().openChatTab("t1", "durable-1");

    expect(store.getState().openTabs).toBe(before);
  });

  it("keeps one ticket's tabs out of another's", () => {
    const { store } = fixture();

    store.getState().openChatTab("t1", "durable-1");
    store.getState().openChatTab("t2", "durable-2");

    expect(store.getState().openTabs).toEqual({ t1: ["durable-1"], t2: ["durable-2"] });
  });

  /** The single-owner invariant: a session's tab lives under exactly one
   * owner, so opening it under a new one forgets the old. */
  it("moves the tab to a new owner, stripping it from the old one", () => {
    const { store } = fixture();
    store.getState().openChatTab("t1", "durable-1");

    store.getState().openChatTab("p1", "durable-1");

    expect(store.getState().openTabs).toEqual({ p1: ["durable-1"] });
  });

  it("keeps the old owner's other tabs when only one of them moves", () => {
    const { store } = fixture();
    store.getState().openChatTab("t1", "durable-1");
    store.getState().openChatTab("t1", "durable-2");

    store.getState().openChatTab("p1", "durable-1");

    expect(store.getState().openTabs).toEqual({ t1: ["durable-2"], p1: ["durable-1"] });
  });

  it("repairs a broken invariant by dropping a duplicate elsewhere, even when the owner already has it", () => {
    const { store } = fixture();
    store.setState({ openTabs: { t1: ["durable-1"], p1: ["durable-1"] } });

    store.getState().openChatTab("p1", "durable-1");

    expect(store.getState().openTabs).toEqual({ p1: ["durable-1"] });
  });

  it("discards an empty provisional Draft and its renderer-only focus when its tab closes", () => {
    const { store } = fixture();
    useChatDraftsStore.getState().openProvisional("draft-1", {
      projectId: "p1",
      ticketId: "t1",
      operationId: "draft-operation",
      title: null,
    });
    store.getState().openChatTab("t1", "draft-1");
    store.getState().setProvisionalActive("t1", "draft-1");

    store.getState().closeChatTab("t1", "draft-1");

    expect(store.getState().openTabs).toEqual({});
    expect(store.getState().provisionalActive).toEqual({});
    expect(useChatDraftsStore.getState().drafts["draft-1"]).toBeUndefined();
    expect(getChatClient("draft-1")).toBeUndefined();
  });

  it("abandons a typed provisional Draft when its tab closes", () => {
    const { store, subscriptions } = fixture();
    useChatDraftsStore.getState().openProvisional("draft-1", {
      projectId: "p1",
      ticketId: "t1",
      operationId: "draft-operation",
      title: null,
    });
    useChatDraftsStore.getState().setDraft("draft-1", "come back to this");
    store.getState().openChatTab("t1", "draft-1");

    store.getState().closeChatTab("t1", "draft-1");

    expect(store.getState().openTabs).toEqual({});
    expect(useChatDraftsStore.getState().drafts["draft-1"]).toBeUndefined();
    expect(store.getState().sessions["draft-1"]).toBeUndefined();
    expect(subscriptions).toEqual([]);
  });

  it("keeps recovery metadata when close races a create that already landed", () => {
    const { store } = fixture();
    useChatDraftsStore.getState().openProvisional("draft-1", {
      projectId: "p1",
      ticketId: "t1",
      operationId: "draft-operation",
      title: null,
    });
    useChatDraftsStore.getState().setDraft("draft-1", "already sent");
    useChatDraftsStore.getState().markProvisionalSessionCreated("draft-1");
    store.getState().openChatTab("t1", "draft-1");

    store.getState().closeChatTab("t1", "draft-1");

    expect(store.getState().openTabs).toEqual({});
    expect(useChatDraftsStore.getState().drafts["draft-1"]?.provisional?.phase).toBe(
      "session-created",
    );
  });

  /** Closing the view retires the client; the Session itself is untouched. */
  it("drops the resident Session with the tab that held it", () => {
    const { store } = fixture();
    store.getState().adoptChatSession("durable-1");
    store.getState().openChatTab("t1", "durable-1");

    store.getState().closeChatTab("t1", "durable-1");

    expect(store.getState().openTabs).toEqual({});
    expect(store.getState().sessions["durable-1"]).toBeUndefined();
    expect(getChatClient("durable-1")).toBeUndefined();
  });

  it("leaves the ticket's other tabs where they were", () => {
    const { store } = fixture();
    store.getState().openChatTab("t1", "durable-1");
    store.getState().openChatTab("t1", "durable-2");

    store.getState().closeChatTab("t1", "durable-1");

    expect(store.getState().openTabs).toEqual({ t1: ["durable-2"] });
  });

  it("clears a rehomed tab's temporary ticket origin when the tab closes", () => {
    const { store } = fixture();
    store.setState({
      openTabs: { p1: ["durable-1"] },
      rehomedTicketBySession: { "durable-1": "t1" },
    });

    store.getState().closeChatTab("p1", "durable-1");

    expect(store.getState().openTabs).toEqual({});
    expect(store.getState().rehomedTicketBySession).toEqual({});
  });

  it("is a no-op for a tab that was never open", () => {
    const { store } = fixture();
    store.getState().openChatTab("t1", "durable-1");
    const before = store.getState().openTabs;

    store.getState().closeChatTab("t1", "durable-9");
    store.getState().closeChatTab("t9", "durable-1");

    expect(store.getState().openTabs).toBe(before);
  });

  /** The tab decides: a close aimed at a ticket that holds none must not retire
   * the client the tab that DOES hold it is still drawing from. */
  it("keeps the Session alive when the close named a ticket without its tab", () => {
    const { store } = fixture();
    store.getState().adoptChatSession("durable-1");
    store.getState().openChatTab("t1", "durable-1");

    store.getState().closeChatTab("t9", "durable-1");

    expect(store.getState().sessions["durable-1"]).toBeDefined();
    expect(getChatClient("durable-1")).toBeDefined();
  });
});

describe("reconcileTicketChatTabs", () => {
  it("moves the focused Draft of every departed ticket onto the project", () => {
    const { store } = fixture();
    store.setState({
      openTabs: { t1: ["draft-1"], t2: ["draft-2"] },
      provisionalActive: { t1: "draft-1", t2: "draft-2" },
    });

    // Two tickets leaving at once: the second must edit the focus map the
    // first already began, not start a fresh copy over it.
    store.getState().reconcileTicketChatTabs("p1", ["t1", "t2"], []);

    expect(store.getState().openTabs).toEqual({ p1: ["draft-1", "draft-2"] });
    expect(store.getState().provisionalActive).toEqual({ p1: "draft-2" });
  });

  it("moves departed ticket tabs onto the project and records their exact ticket origins", () => {
    const { store } = fixture();
    // No resident slices: ownership reconciliation cannot depend on an
    // arriving projection, which is legitimately null while a chat attaches.
    store.setState({
      openTabs: {
        p1: ["ticketless"],
        t1: ["durable-1", "durable-2"],
        t2: ["durable-3"],
      },
    });

    store.getState().reconcileTicketChatTabs("p1", ["t1", "t2"], []);

    expect(store.getState().openTabs).toEqual({
      p1: ["ticketless", "durable-1", "durable-2", "durable-3"],
    });
    expect(store.getState().rehomedTicketBySession).toEqual({
      "durable-1": "t1",
      "durable-2": "t1",
      "durable-3": "t2",
    });
  });

  it("creates the project tab strip when a departed ticket is its first tab owner", () => {
    const { store } = fixture();
    store.setState({ openTabs: { t1: ["durable-1"] } });

    store.getState().reconcileTicketChatTabs("p1", ["t1"], []);

    expect(store.getState().openTabs).toEqual({ p1: ["durable-1"] });
    expect(store.getState().rehomedTicketBySession).toEqual({ "durable-1": "t1" });
  });

  it("moves renderer-only provisional focus with a departed and returning ticket", () => {
    const { store } = fixture();
    store.setState({
      openTabs: { t1: ["draft-1"] },
      provisionalActive: { t1: "draft-1" },
    });

    store.getState().reconcileTicketChatTabs("p1", ["t1"], []);

    expect(store.getState().provisionalActive).toEqual({ p1: "draft-1" });
    store.getState().reconcileTicketChatTabs("p1", [], ["t1"]);
    expect(store.getState().provisionalActive).toEqual({ t1: "draft-1" });
  });

  it("returns only the matching ticket's tabs, preserving unrelated project order and single ownership", () => {
    const { store } = fixture();
    store.setState({
      openTabs: {
        p1: ["ticketless", "from-t1", "from-t2"],
        t2: ["already-open"],
      },
      rehomedTicketBySession: { "from-t1": "t1", "from-t2": "t2" },
    });

    store.getState().reconcileTicketChatTabs("p1", [], ["t1"]);

    expect(store.getState().openTabs).toEqual({
      p1: ["ticketless", "from-t2"],
      t2: ["already-open"],
      t1: ["from-t1"],
    });
    expect(store.getState().rehomedTicketBySession).toEqual({ "from-t2": "t2" });
  });

  it("deduplicates a stale project copy as it restores the tab to its stamped ticket", () => {
    const { store } = fixture();
    store.setState({
      openTabs: { p1: ["ticketless", "returning"], t1: ["already-open", "returning"] },
      rehomedTicketBySession: { returning: "t1" },
    });

    store.getState().reconcileTicketChatTabs("p1", [], ["t1"]);

    expect(store.getState().openTabs).toEqual({
      p1: ["ticketless"],
      t1: ["already-open", "returning"],
    });
    expect(store.getState().rehomedTicketBySession).toEqual({});
  });

  it("removes an empty project tab owner when its last rehomed tab returns", () => {
    const { store } = fixture();
    store.setState({
      openTabs: { p1: ["returning"] },
      rehomedTicketBySession: { returning: "t1" },
    });

    store.getState().reconcileTicketChatTabs("p1", [], ["t1"]);

    expect(store.getState().openTabs).toEqual({ t1: ["returning"] });
    expect(store.getState().rehomedTicketBySession).toEqual({});
  });

  it("deduplicates an already-stamped departure without replacing its provenance", () => {
    const { store } = fixture();
    store.setState({
      openTabs: { p1: ["ticketless", "shared"], t1: ["shared", "from-t1"] },
      rehomedTicketBySession: { shared: "t1", "from-t1": "t1" },
    });
    const provenance = store.getState().rehomedTicketBySession;

    store.getState().reconcileTicketChatTabs("p1", ["t1"], []);

    expect(store.getState().openTabs).toEqual({ p1: ["ticketless", "shared", "from-t1"] });
    expect(store.getState().rehomedTicketBySession).toBe(provenance);
  });

  it("restores each returned ticket independently after a multi-ticket departure", () => {
    const { store } = fixture();
    store.setState({
      openTabs: { p1: ["ticketless"], t1: ["durable-1", "durable-2"], t2: ["durable-3"] },
    });

    store.getState().reconcileTicketChatTabs("p1", ["t1", "t2"], []);
    store.getState().reconcileTicketChatTabs("p1", [], ["t2"]);

    expect(store.getState().openTabs).toEqual({
      p1: ["ticketless", "durable-1", "durable-2"],
      t2: ["durable-3"],
    });
    expect(store.getState().rehomedTicketBySession).toEqual({
      "durable-1": "t1",
      "durable-2": "t1",
    });

    store.getState().reconcileTicketChatTabs("p1", [], ["t1"]);

    expect(store.getState().openTabs).toEqual({
      p1: ["ticketless"],
      t2: ["durable-3"],
      t1: ["durable-1", "durable-2"],
    });
    expect(store.getState().rehomedTicketBySession).toEqual({});
  });

  it("is a no-op (unchanged identity) when no departure or return has a matching tab", () => {
    const { store } = fixture();
    store.setState({ openTabs: { p1: ["durable-1"] } });
    const before = store.getState().openTabs;

    store.getState().reconcileTicketChatTabs("p1", ["t1", "t2"], ["t3"]);

    expect(store.getState().openTabs).toBe(before);
  });
});

describe("clearRehomedTicketProvenance", () => {
  it("clears only the deleted ticket's transient origins without touching tabs or clients", () => {
    const { store } = fixture();
    store.getState().adoptChatSession("from-t1");
    store.setState({
      openTabs: { p1: ["from-t1", "from-t2"] },
      rehomedTicketBySession: { "from-t1": "t1", "from-t2": "t2" },
    });
    const openTabs = store.getState().openTabs;
    const sessions = store.getState().sessions;
    const client = getChatClient("from-t1");

    store.getState().clearRehomedTicketProvenance("t1");

    expect(store.getState().openTabs).toBe(openTabs);
    expect(store.getState().sessions).toBe(sessions);
    expect(getChatClient("from-t1")).toBe(client);
    expect(store.getState().rehomedTicketBySession).toEqual({ "from-t2": "t2" });
  });

  it("abandons an uncreated Draft whose immutable ticket scope was deleted", () => {
    const { store } = fixture();
    const draftId = "deleted-ticket-draft";
    useChatDraftsStore.getState().openProvisional(draftId, {
      projectId: "p1",
      ticketId: "t1",
      operationId: "deleted-ticket-operation",
      title: null,
    });
    store.setState({
      openTabs: { p1: [draftId, "durable-2"] },
      provisionalActive: { p1: draftId },
      rehomedTicketBySession: { [draftId]: "t1", "durable-2": "t2" },
    });

    store.getState().clearRehomedTicketProvenance("t1");

    expect(useChatDraftsStore.getState().drafts[draftId]).toBeUndefined();
    expect(store.getState().openTabs).toEqual({ p1: ["durable-2"] });
    expect(store.getState().provisionalActive).toEqual({});
    expect(store.getState().rehomedTicketBySession).toEqual({ "durable-2": "t2" });
  });

  it("is a no-op when no tab was rehomed from the ticket", () => {
    const { store } = fixture();
    store.setState({ rehomedTicketBySession: { "from-t2": "t2" } });
    const before = store.getState().rehomedTicketBySession;

    store.getState().clearRehomedTicketProvenance("t1");

    expect(store.getState().rehomedTicketBySession).toBe(before);
  });

  it("drops an owner whose only tab was the abandoned Draft", () => {
    const { store } = fixture();
    const draftId = "only-tab";
    useChatDraftsStore.getState().openProvisional(draftId, {
      projectId: "p1",
      ticketId: "t1",
      operationId: "only-tab-operation",
      title: null,
    });
    store.setState({
      openTabs: { p1: [draftId], t2: ["durable-2"] },
      rehomedTicketBySession: { [draftId]: "t1" },
    });

    store.getState().clearRehomedTicketProvenance("t1");

    // An owner with nothing left is not an owner with an empty strip.
    expect(store.getState().openTabs).toEqual({ t2: ["durable-2"] });
  });

  it("keeps a Draft the deleted ticket already promoted, which is a Session now", () => {
    const { store } = fixture();
    const draftId = "already-created";
    useChatDraftsStore.getState().openProvisional(draftId, {
      projectId: "p1",
      ticketId: "t1",
      operationId: "created-operation",
      title: null,
    });
    useChatDraftsStore.getState().setDraft(draftId, "already sent");
    useChatDraftsStore.getState().markProvisionalSessionCreated(draftId);
    store.setState({ openTabs: { p1: [draftId] }, rehomedTicketBySession: { [draftId]: "t1" } });

    store.getState().clearRehomedTicketProvenance("t1");

    // Only an UNCREATED Draft is abandoned with its ticket. This one has a
    // durable row behind it, and no delete channel exists to take it back.
    expect(useChatDraftsStore.getState().drafts[draftId]?.provisional?.phase).toBe(
      "session-created",
    );
    expect(store.getState().openTabs).toEqual({ p1: [draftId] });
  });
});

describe("setProvisionalActive", () => {
  it("holds its own state when the named Draft is already the focused one", () => {
    const { store } = fixture();
    store.getState().setProvisionalActive("t1", "draft-1");
    const before = store.getState().provisionalActive;

    store.getState().setProvisionalActive("t1", "draft-1");

    // Re-asserting focus is what every re-render of the tab strip does; it
    // must not be a store write, or the sidebar rebuilds for nothing.
    expect(store.getState().provisionalActive).toBe(before);
  });

  it("forgets an owner's focus rather than remembering a null", () => {
    const { store } = fixture();
    store.getState().setProvisionalActive("t1", "draft-1");
    store.getState().setProvisionalActive("t2", "draft-2");

    store.getState().setProvisionalActive("t1", null);

    expect(store.getState().provisionalActive).toEqual({ t2: "draft-2" });
  });
});

describe("dropChatTabs", () => {
  it("deletes every named owner's entry", () => {
    const { store } = fixture();
    store.setState({
      openTabs: { p1: ["durable-1"], t1: ["durable-2"], t2: ["durable-3"] },
      rehomedTicketBySession: { "durable-1": "t1", "durable-2": "t1", "durable-3": "t2" },
    });

    store.getState().dropChatTabs(["p1", "t1"]);

    expect(store.getState().openTabs).toEqual({ t2: ["durable-3"] });
    expect(store.getState().rehomedTicketBySession).toEqual({ "durable-3": "t2" });
  });

  it("discards provisional Drafts and focus when their project owner disappears", () => {
    const { store } = fixture();
    useChatDraftsStore.getState().openProvisional("draft-1", {
      projectId: "p1",
      ticketId: null,
      operationId: "draft-operation",
      title: null,
    });
    useChatDraftsStore.getState().setDraft("draft-1", "orphan me");
    store.getState().openChatTab("p1", "draft-1");
    store.getState().setProvisionalActive("p1", "draft-1");

    store.getState().dropChatTabs(["p1"]);

    expect(store.getState().openTabs).toEqual({});
    expect(store.getState().provisionalActive).toEqual({});
    expect(useChatDraftsStore.getState().drafts["draft-1"]).toBeUndefined();
  });

  it("retires resident clients as it drops their project owner tabs", () => {
    const { store } = fixture();
    store.getState().adoptChatSession("durable-1");
    store.setState({
      openTabs: { p1: ["durable-1"] },
      rehomedTicketBySession: { "durable-1": "t1" },
    });

    store.getState().dropChatTabs(["p1", "missing-owner"]);

    expect(store.getState().sessions["durable-1"]).toBeUndefined();
    expect(getChatClient("durable-1")).toBeUndefined();
    expect(store.getState().openTabs).toEqual({});
    expect(store.getState().rehomedTicketBySession).toEqual({});
  });

  it("is a no-op (unchanged identity) when none of the ids have an entry", () => {
    const { store } = fixture();
    store.setState({ openTabs: { t2: ["durable-3"] } });
    const before = store.getState().openTabs;

    store.getState().dropChatTabs(["p1", "t1"]);

    expect(store.getState().openTabs).toBe(before);
  });
});
