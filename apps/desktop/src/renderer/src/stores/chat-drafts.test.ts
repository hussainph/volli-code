import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { BlobLinkView } from "@volli/shared";

import {
  createChatDraftsStore,
  isEmptyProvisionalChatDraft,
  isVisibleProvisionalChatDraft,
  MAX_DRAFTS,
  type ChatDraft,
} from "./chat-drafts";

/** Simple in-memory `StateStorage` so each test gets its own isolated backing. */
function createMemoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (name: string) => data.get(name) ?? null,
    setItem: (name: string, value: string) => {
      data.set(name, value);
    },
    removeItem: (name: string) => {
      data.delete(name);
    },
  };
}

/** One staged file, distinguishable by hash — the strip's unit (VC-137). */
function blobView(overrides: Partial<BlobLinkView> = {}): BlobLinkView {
  const hash = overrides.blobHash ?? "ab".repeat(32);
  return {
    linkId: `link-${hash.slice(0, 4)}`,
    blobHash: hash,
    label: "shot.png",
    originalName: "shot.png",
    mime: "image/png",
    sizeBytes: 2048,
    ...overrides,
  };
}

function readPersisted(storage: ReturnType<typeof createMemoryStorage>) {
  const raw = storage.getItem("volli:chat-drafts");
  return raw === null
    ? null
    : (JSON.parse(raw) as {
        state: { drafts: Record<string, ChatDraft> };
      });
}

afterEach(() => {
  vi.useRealTimers();
});

const PROVISIONAL = {
  projectId: "p1",
  ticketId: "t1",
  operationId: "op-1",
  title: null,
} as const;

describe("provisional chat", () => {
  it("keeps an empty Draft live without calling persistence", () => {
    const storage = createMemoryStorage();
    const write = vi.spyOn(storage, "setItem");
    const store = createChatDraftsStore(storage);

    store.getState().openProvisional("draft-1", PROVISIONAL);

    expect(store.getState().drafts["draft-1"]?.provisional).toEqual({
      ...PROVISIONAL,
      phase: "draft",
    });
    expect(readPersisted(storage)).toBeNull();
    expect(write).not.toHaveBeenCalled();
  });

  it("keeps title/model-only Drafts out of persistence and sidebar visibility", () => {
    const storage = createMemoryStorage();
    const write = vi.spyOn(storage, "setItem");
    const store = createChatDraftsStore(storage);
    store.getState().openProvisional("draft-1", PROVISIONAL);

    store.getState().setProvisionalTitle("draft-1", "Planning");
    store.getState().setProvisionalModel("draft-1", {
      providerId: "anthropic",
      modelId: "sonnet",
      reasoningLevel: "high",
    });

    expect(isVisibleProvisionalChatDraft(store.getState().drafts["draft-1"]!)).toBe(false);
    expect(isEmptyProvisionalChatDraft(store.getState().drafts["draft-1"])).toBe(true);
    // And an id with no Draft at all is neither: a durable Session's tab must
    // not be mistaken for something the workspace may not record.
    expect(isEmptyProvisionalChatDraft(undefined)).toBe(false);
    expect(isEmptyProvisionalChatDraft(store.getState().drafts["never-opened"])).toBe(false);
    expect(readPersisted(storage)).toBeNull();
    expect(write).not.toHaveBeenCalled();
  });

  it("passes a clear through the quiet storage edge rather than swallowing it", async () => {
    // The quiet edge exists to skip writes that say nothing new. A CLEAR says
    // something, and zustand exposes one, so it must reach the backing store
    // — otherwise a cleared key would silently rehydrate on the next launch.
    const storage = createMemoryStorage();
    const remove = vi.spyOn(storage, "removeItem");
    const store = createChatDraftsStore(storage);
    store.getState().setDraft("s1", "words");
    expect(readPersisted(storage)).not.toBeNull();

    await store.persist.clearStorage();

    expect(remove).toHaveBeenCalledWith("volli:chat-drafts");
    expect(readPersisted(storage)).toBeNull();
  });

  it("keeps the Draft a person is already typing into when its surface re-opens it", () => {
    const store = createChatDraftsStore(createMemoryStorage());
    store.getState().openProvisional("draft-1", PROVISIONAL);
    store.getState().setDraft("draft-1", "half typed");

    // Re-opening the same id is how a surface re-asserts a Draft it already
    // has. It must not mint a second launch record over the words.
    store.getState().openProvisional("draft-1", { ...PROVISIONAL, operationId: "op-2" });

    expect(store.getState().drafts["draft-1"]?.provisional?.operationId).toBe("op-1");
    expect(store.getState().drafts["draft-1"]?.text).toBe("half typed");
  });

  it("leaves a durable Draft alone when promotion completes twice", () => {
    const store = createChatDraftsStore(createMemoryStorage());
    store.getState().setDraft("durable-1", "already a Session");

    // A second `completePromotion` (a retried handoff) has no provisional left
    // to strip, and must not rewrite the entry it finds.
    const before = store.getState().drafts["durable-1"];
    store.getState().completePromotion("durable-1");

    expect(store.getState().drafts["durable-1"]).toBe(before);
  });

  it("treats promoting a Draft that is already a Session as done", async () => {
    const store = createChatDraftsStore(createMemoryStorage());
    store.getState().setDraft("durable-1", "already a Session");
    const run = vi.fn();

    // Nothing provisional is left to promote, so there is no work to run and
    // no failure to report: the caller's words are already somewhere durable.
    await expect(store.getState().promote("durable-1", run)).resolves.toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it("persists launch identity once the Draft has content and restores it on relaunch", async () => {
    const storage = createMemoryStorage();
    const first = createChatDraftsStore(storage);
    first.getState().openProvisional("draft-1", PROVISIONAL);
    first.getState().setDraft("draft-1", "half typed");

    const reloaded = createChatDraftsStore(storage);
    await reloaded.persist.rehydrate();

    expect(reloaded.getState().drafts["draft-1"]).toEqual({
      text: "half typed",
      attachments: [],
      held: [],
      touchedAt: expect.any(Number) as number,
      provisional: { ...PROVISIONAL, phase: "draft" },
    });
  });

  it("survives a quit on either side of the mint, with the message retryable", async () => {
    // The two crash windows the design named. Before the mint there is no
    // Session at all, so the words come back as an ordinary unsent Draft.
    const storage = createMemoryStorage();
    const beforeMint = createChatDraftsStore(storage);
    beforeMint.getState().openProvisional("draft-1", PROVISIONAL);
    beforeMint.getState().setDraft("draft-1", "");
    beforeMint.getState().holdMessage("draft-1", { id: "m1", text: "in flight" });
    beforeMint.getState().markHeld("draft-1", "m1", "sending");

    let reloaded = createChatDraftsStore(storage);
    await reloaded.persist.rehydrate();
    expect(reloaded.getState().drafts["draft-1"]?.provisional).toMatchObject({
      phase: "draft",
      operationId: PROVISIONAL.operationId,
    });
    // `sending` describes a flight that no longer exists. A held message is
    // rehydrated as `unsent` so there is something to press, not a spinner
    // waiting on a promise that died with the process.
    expect(reloaded.getState().drafts["draft-1"]?.held).toEqual([
      { id: "m1", text: "in flight", state: "unsent" },
    ]);

    // After the mint a Session DOES exist, and the marker that says so is what
    // stops a relaunch minting a second one. The operation id rides across
    // too, so the replay is the same command.
    const afterMint = createChatDraftsStore(storage);
    await afterMint.persist.rehydrate();
    afterMint.getState().markProvisionalSessionCreated("draft-1");

    reloaded = createChatDraftsStore(storage);
    await reloaded.persist.rehydrate();
    expect(reloaded.getState().drafts["draft-1"]?.provisional).toMatchObject({
      phase: "session-created",
      operationId: PROVISIONAL.operationId,
    });
    expect(reloaded.getState().drafts["draft-1"]?.held).toEqual([
      { id: "m1", text: "in flight", state: "unsent" },
    ]);
  });

  it("tracks post-create recovery, then promotes in place without changing the Draft key", () => {
    const store = createChatDraftsStore(createMemoryStorage());
    store.getState().openProvisional("draft-1", PROVISIONAL);
    store.getState().setDraft("draft-1", "hello");

    store.getState().markProvisionalSessionCreated("draft-1");
    expect(store.getState().drafts["draft-1"]?.provisional?.phase).toBe("session-created");

    store.getState().completePromotion("draft-1");
    expect(store.getState().drafts["draft-1"]).toEqual(
      expect.objectContaining({ text: "hello" }) as unknown as ChatDraft,
    );
    expect(store.getState().drafts["draft-1"]?.provisional).toBeUndefined();
  });

  it("serializes concurrent promotion and retires a failed flight for retry", async () => {
    const store = createChatDraftsStore(createMemoryStorage());
    store.getState().openProvisional("draft-1", PROVISIONAL);
    let release!: (promoted: boolean) => void;
    const run = vi.fn(() => new Promise<boolean>((resolve) => (release = resolve)));

    const first = store.getState().promote("draft-1", run);
    const second = store.getState().promote("draft-1", run);

    expect(second).toBe(first);
    expect(run).toHaveBeenCalledOnce();
    release(false);
    await expect(first).resolves.toBe(false);
    await expect(store.getState().promote("draft-1", async () => true)).resolves.toBe(true);
  });

  it("waits for every concurrent attachment import and makes completion idempotent", async () => {
    const store = createChatDraftsStore(createMemoryStorage());
    const finishFirst = store.getState().beginAttachmentImport("draft-1");
    const finishSecond = store.getState().beginAttachmentImport("draft-1");
    expect(store.getState().hasAttachmentImports("draft-1")).toBe(true);
    let settled = false;
    const waiting = store
      .getState()
      .waitForAttachmentImports("draft-1")
      .then(() => (settled = true));

    const finishLater = store.getState().beginAttachmentImport("draft-1");
    finishFirst();
    finishFirst();
    await Promise.resolve();
    expect(settled).toBe(false);

    finishSecond();
    await waiting;
    expect(settled).toBe(true);
    expect(store.getState().hasAttachmentImports("draft-1")).toBe(true);
    const waitingForLater = store.getState().waitForAttachmentImports("draft-1");
    finishLater();
    await expect(waitingForLater).resolves.toBeUndefined();
    expect(store.getState().hasAttachmentImports("draft-1")).toBe(false);
  });

  it("does not let a late import callback resurrect a Draft closed while it was pending", () => {
    const store = createChatDraftsStore(createMemoryStorage());
    store.getState().openProvisional("draft-1", PROVISIONAL);
    const finishImport = store.getState().beginAttachmentImport("draft-1");

    store.getState().discardProvisional("draft-1");
    store.getState().setDraft("draft-1", "@late-file ");
    store.getState().setDraftAttachments("draft-1", [blobView({ linkId: null })]);
    finishImport();

    expect(store.getState().drafts["draft-1"]).toBeUndefined();
  });

  it("adopts durable Blob links across the staged strip and held messages", () => {
    const store = createChatDraftsStore(createMemoryStorage());
    const ownerless = blobView({ linkId: null });
    const linked = blobView({ linkId: "session-link" });
    store.getState().openProvisional("draft-1", PROVISIONAL);
    store.getState().setDraftAttachments("draft-1", [ownerless]);
    store.getState().holdMessage("draft-1", {
      id: "m1",
      text: "look",
      attachments: [ownerless],
    });

    store.getState().adoptLinkedAttachments("draft-1", [linked]);

    expect(store.getState().drafts["draft-1"]?.attachments).toEqual([linked]);
    expect(store.getState().drafts["draft-1"]?.held[0]?.attachments).toEqual([linked]);
  });

  it("can freeze the first resolved model after an earlier no-model refusal", () => {
    const store = createChatDraftsStore(createMemoryStorage());
    const model = { providerId: "acme", modelId: "sonnet", reasoningLevel: "high" } as const;
    store.getState().openProvisional("draft-1", PROVISIONAL);
    store.getState().holdMessage("draft-1", { id: "refused", text: "retry me" });

    store.getState().setProvisionalModel("draft-1", model);
    store.getState().setProvisionalModel("draft-1", {
      providerId: "other",
      modelId: "changed",
      reasoningLevel: "low",
    });

    expect(store.getState().drafts["draft-1"]?.provisional?.model).toEqual(model);
  });

  it("amends only the named held message while a captured import finishes", () => {
    const store = createChatDraftsStore(createMemoryStorage());
    store.getState().holdMessage("draft-1", { id: "m1", text: "first" });
    store.getState().holdMessage("draft-1", { id: "m2", text: "second" });

    store
      .getState()
      .amendHeldMessage("draft-1", "m1", (message) => ({ ...message, text: "first @late " }));
    store
      .getState()
      .amendHeldMessage("draft-1", "missing", (message) => ({ ...message, text: "wrong" }));

    expect(store.getState().drafts["draft-1"]?.held.map(({ text }) => text)).toEqual([
      "first @late ",
      "second",
    ]);
  });

  it("freezes the model at Send and the title at create, each for its own reason", async () => {
    const store = createChatDraftsStore(createMemoryStorage());
    const originalModel = {
      providerId: "acme",
      modelId: "sonnet",
      reasoningLevel: "high" as const,
    };
    const changedModel = {
      providerId: "other",
      modelId: "changed",
      reasoningLevel: "low",
    } as const;
    store.getState().openProvisional("draft-1", PROVISIONAL);
    store.getState().setProvisionalTitle("draft-1", "Before send");
    store.getState().setProvisionalModel("draft-1", originalModel);
    store.getState().holdMessage("draft-1", { id: "first-send", text: "go" });

    // The MODEL freezes at Send. Send is where the live default was resolved
    // into an explicit choice, so letting Settings move it afterwards would
    // make a retry replay a different create than the one that may already
    // have landed.
    store.getState().setProvisionalModel("draft-1", changedModel);
    expect(store.getState().drafts["draft-1"]?.provisional?.model).toEqual(originalModel);

    // The TITLE does not. Nothing durable carries it until the create goes
    // out, so refusing it here would only drop a rename with nowhere to go.
    store.getState().setProvisionalTitle("draft-1", "After send before create");
    expect(store.getState().drafts["draft-1"]?.provisional?.title).toBe("After send before create");

    let finishPromotion!: () => void;
    const promoting = store
      .getState()
      .promote(
        "draft-1",
        () => new Promise<boolean>((resolve) => (finishPromotion = () => resolve(false))),
      );
    finishPromotion();
    await promoting;

    // Once the create has LANDED the title is in a durable intent, and the
    // engine treats a replay carrying a different intent as a conflict. From
    // here a rename is a Session rename, which the surfaces route elsewhere.
    store.getState().markProvisionalSessionCreated("draft-1");
    store.getState().setProvisionalTitle("draft-1", "After create");
    store.getState().setProvisionalModel("draft-1", changedModel);
    expect(store.getState().drafts["draft-1"]?.provisional).toMatchObject({
      phase: "session-created",
      title: "After send before create",
      model: originalModel,
    });
  });

  it("updates a provisional model and discards only identities that are still Drafts", () => {
    const store = createChatDraftsStore(createMemoryStorage());
    const model = { providerId: "anthropic", modelId: "sonnet", reasoningLevel: "high" } as const;
    store.getState().openProvisional("draft-1", PROVISIONAL);
    store.getState().setProvisionalModel("draft-1", model);
    expect(store.getState().drafts["draft-1"]?.provisional?.model).toEqual(model);

    store.getState().completePromotion("draft-1");
    store.getState().discardProvisional("draft-1");
    expect(store.getState().drafts).toHaveProperty("draft-1");

    store.getState().openProvisional("draft-2", PROVISIONAL);
    store.getState().discardProvisional("draft-2");
    expect(store.getState().drafts).not.toHaveProperty("draft-2");
  });
});

describe("setDraft", () => {
  it("stores text and stamps touchedAt", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const store = createChatDraftsStore(createMemoryStorage());

    store.getState().setDraft("s1", "hello");

    expect(store.getState().drafts.s1).toEqual({
      text: "hello",
      attachments: [],
      held: [],
      touchedAt: 1000,
    });
  });

  it("overwrites an existing draft's text and re-stamps touchedAt", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const store = createChatDraftsStore(createMemoryStorage());
    store.getState().setDraft("s1", "hello");

    vi.setSystemTime(2000);
    store.getState().setDraft("s1", "hello world");

    expect(store.getState().drafts.s1).toEqual({
      text: "hello world",
      attachments: [],
      held: [],
      touchedAt: 2000,
    });
  });

  it("leaves messages already out of the box alone", () => {
    const store = createChatDraftsStore(createMemoryStorage());
    store.getState().setDraft("s1", "first");
    store.getState().holdMessage("s1", { id: "m1", text: "first" });

    store.getState().setDraft("s1", "second");

    expect(store.getState().drafts.s1?.held).toEqual([
      { id: "m1", text: "first", state: "sending" },
    ]);
  });

  it("keeps other sessions' drafts untouched", () => {
    const store = createChatDraftsStore(createMemoryStorage());
    store.getState().setDraft("s1", "one");
    store.getState().setDraft("s2", "two");

    expect(store.getState().drafts.s1?.text).toBe("one");
    expect(store.getState().drafts.s2?.text).toBe("two");
  });
});

describe("holdMessage", () => {
  it("empties the box and keeps the message in the same write", () => {
    vi.useFakeTimers();
    vi.setSystemTime(3000);
    const store = createChatDraftsStore(createMemoryStorage());
    store.getState().setDraft("s1", "hello");

    store.getState().holdMessage("s1", { id: "m1", text: "hello" });

    expect(store.getState().drafts.s1).toEqual({
      text: "",
      attachments: [],
      held: [{ id: "m1", text: "hello", state: "sending" }],
      touchedAt: 3000,
    });
  });

  it("appends, so a second send never displaces the first", () => {
    const store = createChatDraftsStore(createMemoryStorage());
    store.getState().holdMessage("s1", { id: "m1", text: "one" });
    store.getState().holdMessage("s1", { id: "m2", text: "two" });

    expect(store.getState().drafts.s1?.held.map((entry) => entry.id)).toEqual(["m1", "m2"]);
  });

  // The message that left the box keeps its files (VC-137): a queued or
  // steered copy must release with exactly what was attached at ⏎, and a
  // relaunch must not silently drop a screenshot already committed to it.
  it("carries the message's attachments onto the held copy", () => {
    const store = createChatDraftsStore(createMemoryStorage());
    const attachments = [blobView()];

    store.getState().holdMessage("s1", { id: "m1", text: "look", attachments });

    expect(store.getState().drafts.s1?.held[0]?.attachments).toEqual(attachments);
  });

  it("keeps the staged strip untouched when a message without files is held", () => {
    const store = createChatDraftsStore(createMemoryStorage());
    const staged = [blobView()];
    store.getState().setDraftAttachments("s1", staged);

    // An answer typed beside an open question holds no files — its hold must
    // not eat the ones still staged for the next real message.
    store.getState().holdMessage("s1", { id: "m1", text: "yes" });

    expect(store.getState().drafts.s1?.attachments).toEqual(staged);
    expect(store.getState().drafts.s1?.held[0]?.attachments).toBeUndefined();
  });

  it("records a message for a session with no draft yet", () => {
    const store = createChatDraftsStore(createMemoryStorage());

    store.getState().holdMessage("s1", { id: "m1", text: "hello" });

    expect(store.getState().drafts.s1?.held).toHaveLength(1);
  });

  it("leaves other sessions alone", () => {
    const store = createChatDraftsStore(createMemoryStorage());
    store.getState().setDraft("s2", "typing");

    store.getState().holdMessage("s1", { id: "m1", text: "hello" });

    expect(store.getState().drafts.s2).toEqual(
      expect.objectContaining({ text: "typing" }) as unknown as ChatDraft,
    );
  });
});

describe("beginQueuedSteer", () => {
  it("persists the visible strip in order without clearing what is being typed", () => {
    const store = createChatDraftsStore(createMemoryStorage());
    store.getState().setDraft("s1", "new thought");

    store.getState().beginQueuedSteer(
      "s1",
      [
        { id: "q1", text: "first" },
        { id: "q2", text: "second" },
        { id: "q3", text: "third" },
      ],
      "q2",
    );

    expect(store.getState().drafts.s1).toEqual(
      expect.objectContaining({
        text: "new thought",
        held: [
          { id: "q1", text: "first", state: "queued" },
          { id: "q2", text: "second", state: "sending" },
          { id: "q3", text: "third", state: "queued" },
        ],
      }),
    );
  });

  it("keeps existing source states while updating text and never duplicates ids", () => {
    const store = createChatDraftsStore(createMemoryStorage());
    store.getState().holdMessage("s1", { id: "q1", text: "old copy" });
    store.getState().holdMessage("s1", { id: "hidden", text: "already sending" });
    store.getState().markHeld("s1", "q1", "unsent");
    store.getState().setDraft("s1", "new thought");

    store.getState().beginQueuedSteer(
      "s1",
      [
        { id: "q1", text: "latest copy" },
        { id: "q2", text: "neighbor" },
      ],
      "q2",
    );

    expect(store.getState().drafts.s1).toEqual(
      expect.objectContaining({
        text: "new thought",
        held: [
          { id: "q1", text: "latest copy", state: "unsent" },
          { id: "hidden", text: "already sending", state: "sending" },
          { id: "q2", text: "neighbor", state: "sending" },
        ],
      }),
    );
  });

  it("marks an existing held target sending without restating its neighbors", () => {
    const store = createChatDraftsStore(createMemoryStorage());
    store.getState().holdMessage("s1", { id: "q1", text: "old target" });
    store.getState().holdMessage("s1", { id: "q2", text: "old neighbor" });
    store.getState().markHeld("s1", "q1", "unsent");
    store.getState().markHeld("s1", "q2", "queued");

    store.getState().beginQueuedSteer(
      "s1",
      [
        { id: "q1", text: "latest target" },
        { id: "q2", text: "latest neighbor" },
      ],
      "q1",
    );

    expect(store.getState().drafts.s1?.held).toEqual([
      { id: "q1", text: "latest target", state: "sending" },
      { id: "q2", text: "latest neighbor", state: "queued" },
    ]);
  });

  // The displayed row is what this action persists back, so its files must
  // survive the round trip exactly as its words do (VC-137) — otherwise the
  // steer that follows would deliver a message that lost its screenshot.
  it("carries the displayed rows' attachments onto the persisted held copies", () => {
    const store = createChatDraftsStore(createMemoryStorage());
    store.getState().holdMessage("s1", { id: "q1", text: "old copy" });
    store.getState().markHeld("s1", "q1", "unsent");
    const attachments = [blobView()];

    store.getState().beginQueuedSteer(
      "s1",
      [
        { id: "q1", text: "latest copy" },
        { id: "q2", text: "neighbor", attachments },
      ],
      "q2",
    );

    expect(store.getState().drafts.s1?.held).toEqual([
      { id: "q1", text: "latest copy", state: "unsent" },
      { id: "q2", text: "neighbor", attachments, state: "sending" },
    ]);
  });
});

describe("setDraftAttachments", () => {
  it("stores the staged strip beside the words and stamps touchedAt", () => {
    vi.useFakeTimers();
    vi.setSystemTime(4000);
    const store = createChatDraftsStore(createMemoryStorage());
    store.getState().setDraft("s1", "half a thought");
    const staged = [blobView()];

    store.getState().setDraftAttachments("s1", staged);

    expect(store.getState().drafts.s1).toEqual({
      text: "half a thought",
      attachments: staged,
      held: [],
      touchedAt: 4000,
    });
  });

  it("replaces the strip rather than appending, so a removal empties it durably", () => {
    const store = createChatDraftsStore(createMemoryStorage());
    store.getState().setDraftAttachments("s1", [blobView()]);

    store.getState().setDraftAttachments("s1", []);

    expect(store.getState().drafts.s1?.attachments).toEqual([]);
  });

  it("keeps a strip-only draft at persist time — a dropped screenshot is content", () => {
    const storage = createMemoryStorage();
    const store = createChatDraftsStore(storage);

    store.getState().setDraft("s1", "");
    store.getState().setDraftAttachments("s1", [blobView()]);

    expect(readPersisted(storage)!.state.drafts).toHaveProperty("s1");
  });
});

describe("markHeld", () => {
  it("restates where a held message stands", () => {
    const store = createChatDraftsStore(createMemoryStorage());
    store.getState().holdMessage("s1", { id: "m1", text: "hello" });

    store.getState().markHeld("s1", "m1", "queued");

    expect(store.getState().drafts.s1?.held).toEqual([
      { id: "m1", text: "hello", state: "queued" },
    ]);
  });

  it("leaves the other held messages as they were", () => {
    const store = createChatDraftsStore(createMemoryStorage());
    store.getState().holdMessage("s1", { id: "m1", text: "one" });
    store.getState().holdMessage("s1", { id: "m2", text: "two" });

    store.getState().markHeld("s1", "m2", "unsent");

    expect(store.getState().drafts.s1?.held).toEqual([
      { id: "m1", text: "one", state: "sending" },
      { id: "m2", text: "two", state: "unsent" },
    ]);
  });

  it("does not touch state when the message already stands there", () => {
    const store = createChatDraftsStore(createMemoryStorage());
    store.getState().holdMessage("s1", { id: "m1", text: "hello" });
    const before = store.getState().drafts;

    store.getState().markHeld("s1", "m1", "sending");

    expect(store.getState().drafts).toBe(before);
  });

  it("is a no-op for a held message this session never had", () => {
    const store = createChatDraftsStore(createMemoryStorage());
    store.getState().holdMessage("s1", { id: "m1", text: "hello" });
    const before = store.getState().drafts;

    store.getState().markHeld("s1", "missing", "unsent");

    expect(store.getState().drafts).toBe(before);
  });

  // A Session closed while its message was in flight has no draft to write
  // back to, and minting one would spend a capped slot nothing can ever clear.
  it("never mints a draft for a session that has none", () => {
    const store = createChatDraftsStore(createMemoryStorage());

    store.getState().markHeld("gone", "m1", "unsent");

    expect(store.getState().drafts).not.toHaveProperty("gone");
  });
});

describe("dropHeld", () => {
  it("forgets a message something else is now responsible for", () => {
    const store = createChatDraftsStore(createMemoryStorage());
    store.getState().holdMessage("s1", { id: "m1", text: "hello" });

    store.getState().dropHeld("s1", "m1");

    expect(store.getState().drafts.s1?.held).toEqual([]);
  });

  it("keeps the rest of the held messages", () => {
    const store = createChatDraftsStore(createMemoryStorage());
    store.getState().holdMessage("s1", { id: "m1", text: "one" });
    store.getState().holdMessage("s1", { id: "m2", text: "two" });

    store.getState().dropHeld("s1", "m1");

    expect(store.getState().drafts.s1?.held.map((entry) => entry.id)).toEqual(["m2"]);
  });

  it("is a no-op for an id this session never held", () => {
    const store = createChatDraftsStore(createMemoryStorage());
    store.getState().holdMessage("s1", { id: "m1", text: "hello" });
    const before = store.getState().drafts;

    store.getState().dropHeld("s1", "missing");

    expect(store.getState().drafts).toBe(before);
  });

  it("never mints a draft for a session that has none", () => {
    const store = createChatDraftsStore(createMemoryStorage());

    store.getState().dropHeld("gone", "m1");

    expect(store.getState().drafts).not.toHaveProperty("gone");
  });
});

describe("persistence", () => {
  it("drops drafts holding neither text nor a message at persist time", () => {
    const storage = createMemoryStorage();
    const store = createChatDraftsStore(storage);

    store.getState().setDraft("blank", "   ");
    store.getState().setDraft("empty", "");
    store.getState().setDraft("kept", "hello");

    expect(Object.keys(readPersisted(storage)!.state.drafts)).toEqual(["kept"]);
  });

  // The whole point of the held list: the box is empty the instant a message
  // is dispatched, and the words still have to survive a reload.
  it("keeps an emptied box that is still holding a message", () => {
    const storage = createMemoryStorage();
    const store = createChatDraftsStore(storage);
    store.getState().setDraft("s1", "hello");

    store.getState().holdMessage("s1", { id: "m1", text: "hello" });

    expect(readPersisted(storage)!.state.drafts.s1).toEqual({
      text: "",
      attachments: [],
      held: [{ id: "m1", text: "hello", state: "sending" }],
      touchedAt: expect.any(Number) as number,
    });
  });

  it("keeps a live entry mid-edit-to-blank; only the persisted shape drops it", () => {
    const storage = createMemoryStorage();
    const store = createChatDraftsStore(storage);
    store.getState().setDraft("s1", "hello");

    // Typing back to empty mid-edit must not delete the live entry.
    store.getState().setDraft("s1", "");
    expect(store.getState().drafts).toHaveProperty("s1");
    expect(store.getState().drafts.s1?.text).toBe("");

    // What actually got written to storage has already dropped it.
    expect(readPersisted(storage)!.state.drafts).not.toHaveProperty("s1");
  });

  it("caps persisted drafts at the 50 most-recently-touched, evicting the oldest", () => {
    vi.useFakeTimers();
    const storage = createMemoryStorage();
    const store = createChatDraftsStore(storage);

    for (let i = 0; i < MAX_DRAFTS + 5; i++) {
      vi.setSystemTime(i);
      store.getState().setDraft(`s${i}`, `text ${i}`);
    }

    const keys = Object.keys(readPersisted(storage)!.state.drafts);
    expect(keys).toHaveLength(MAX_DRAFTS);
    // The 5 oldest-touched (s0..s4) are evicted; the rest survive.
    for (let i = 0; i < 5; i++) expect(keys).not.toContain(`s${i}`);
    for (let i = 5; i < MAX_DRAFTS + 5; i++) expect(keys).toContain(`s${i}`);
  });

  it("never evicts a provisional Draft to make room for a text draft", () => {
    vi.useFakeTimers();
    const storage = createMemoryStorage();
    const store = createChatDraftsStore(storage);

    // The oldest thing in the store, and therefore the first the cap would
    // reach for. It is also the ONLY handle on this identity: evicting it
    // loses the words and the operation id a retry needs.
    vi.setSystemTime(0);
    store.getState().openProvisional("unpromoted", {
      projectId: "p1",
      ticketId: null,
      operationId: "op-unpromoted",
      title: null,
    });
    store.getState().setDraft("unpromoted", "typed but never sent");
    // Worse: this one's Session row already exists, so evicting it would
    // strand a durable Session AND a held first message with no retry surface.
    vi.setSystemTime(1);
    store.getState().openProvisional("half-promoted", {
      projectId: "p1",
      ticketId: null,
      operationId: "op-half",
      title: null,
    });
    store.getState().setDraft("half-promoted", "sent, mid-promotion");
    store.getState().markProvisionalSessionCreated("half-promoted");

    for (let i = 0; i < MAX_DRAFTS + 5; i++) {
      vi.setSystemTime(100 + i);
      store.getState().setDraft(`s${i}`, `text ${i}`);
    }

    const keys = Object.keys(readPersisted(storage)!.state.drafts);
    expect(keys).toContain("unpromoted");
    expect(keys).toContain("half-promoted");
    // The cap still binds the drafts it is for — a durable Session's unsent
    // words are recoverable because the Session itself is still listed.
    expect(keys.filter((key) => key.startsWith("s"))).toHaveLength(MAX_DRAFTS);
    for (let i = 0; i < 5; i++) expect(keys).not.toContain(`s${i}`);
  });

  it("still evicts a promoted Draft, which is an ordinary Session draft again", () => {
    vi.useFakeTimers();
    const storage = createMemoryStorage();
    const store = createChatDraftsStore(storage);

    vi.setSystemTime(0);
    store.getState().openProvisional("promoted", {
      projectId: "p1",
      ticketId: null,
      operationId: "op",
      title: null,
    });
    store.getState().setDraft("promoted", "words");
    store.getState().completePromotion("promoted");

    for (let i = 0; i < MAX_DRAFTS; i++) {
      vi.setSystemTime(100 + i);
      store.getState().setDraft(`s${i}`, `text ${i}`);
    }

    expect(Object.keys(readPersisted(storage)!.state.drafts)).not.toContain("promoted");
  });

  it("rehydrates drafts from a seeded storage into a fresh store", async () => {
    const storage = createMemoryStorage();
    createChatDraftsStore(storage).getState().setDraft("s1", "hello");

    const reloaded = createChatDraftsStore(storage);
    await reloaded.persist.rehydrate();

    expect(reloaded.getState().drafts).toEqual({
      s1: {
        text: "hello",
        attachments: [],
        held: [],
        touchedAt: expect.any(Number) as number,
      },
    });
  });

  it("restores a Draft's skills and model, dropping skill entries that are not names", async () => {
    const storage = createMemoryStorage();
    const first = createChatDraftsStore(storage);
    first.getState().openProvisional("draft-1", PROVISIONAL);
    first.getState().setDraft("draft-1", "half typed");
    first.getState().setProvisionalModel("draft-1", {
      providerId: "anthropic",
      modelId: "sonnet",
      reasoningLevel: "high",
    });
    // Reach past the store to seed the shapes a hand-edited or older blob can
    // hold: hydration must keep the names and drop the rest rather than fail
    // the Draft they rode in on.
    const raw = JSON.parse(storage.getItem("volli:chat-drafts")!) as {
      state: { drafts: Record<string, { provisional: Record<string, unknown> }> };
    };
    raw.state.drafts["draft-1"]!.provisional.skills = ["logos", "", 7, null];
    storage.setItem("volli:chat-drafts", JSON.stringify(raw));

    const reloaded = createChatDraftsStore(storage);
    await reloaded.persist.rehydrate();

    expect(reloaded.getState().drafts["draft-1"]?.provisional).toEqual({
      ...PROVISIONAL,
      phase: "draft",
      skills: ["logos"],
      model: { providerId: "anthropic", modelId: "sonnet", reasoningLevel: "high" },
    });
  });

  it.each([
    ["a title that is neither absent nor a string", { title: 7 }],
    ["a phase this build does not know", { phase: "promoting" }],
    ["a ticket id that is present but empty", { ticketId: "" }],
    ["no operation id to make the create one command", { operationId: "" }],
    ["no project to own it", { projectId: "" }],
  ])("drops a launch record with %s, keeping the words beside it", async (_name, invalid) => {
    const storage = createMemoryStorage();
    const first = createChatDraftsStore(storage);
    first.getState().openProvisional("draft-1", PROVISIONAL);
    first.getState().setDraft("draft-1", "half typed");
    const raw = JSON.parse(storage.getItem("volli:chat-drafts")!) as {
      state: { drafts: Record<string, { provisional: Record<string, unknown> }> };
    };
    Object.assign(raw.state.drafts["draft-1"]!.provisional, invalid);
    storage.setItem("volli:chat-drafts", JSON.stringify(raw));

    const reloaded = createChatDraftsStore(storage);
    await reloaded.persist.rehydrate();

    // The Draft survives as an ordinary draft: a launch record this build
    // cannot read is not a reason to throw away what someone typed.
    expect(reloaded.getState().drafts["draft-1"]?.text).toBe("half typed");
    expect(reloaded.getState().drafts["draft-1"]?.provisional).toBeUndefined();
  });

  // A held message re-sent after a relaunch must deliver what its `/skill`
  // reference resolved to when it was written — not lose the body silently.
  it("round-trips a held message's skill resources through storage (VC-49)", async () => {
    const storage = createMemoryStorage();
    const resources = [{ name: "logos", text: "# Logos\n\nDesign logos." }];
    const first = createChatDraftsStore(storage);
    first.getState().holdMessage("s1", { id: "m1", text: "/logos a wordmark", resources });

    const reloaded = createChatDraftsStore(storage);
    await reloaded.persist.rehydrate();

    expect(reloaded.getState().drafts.s1?.held).toEqual([
      { id: "m1", text: "/logos a wordmark", resources, state: "unsent" },
    ]);
  });

  // Same promise, one step wider (VC-137): the strip and every held message's
  // files survive a relaunch, because they are part of the same half-composed
  // prompt as the words.
  it("round-trips the staged strip and held attachments through storage (VC-137)", async () => {
    const storage = createMemoryStorage();
    const staged = [blobView({ blobHash: "cd".repeat(32) })];
    const carried = [blobView()];
    const first = createChatDraftsStore(storage);
    first.getState().setDraftAttachments("s1", staged);
    first.getState().holdMessage("s1", { id: "m1", text: "look at this", attachments: carried });

    const reloaded = createChatDraftsStore(storage);
    await reloaded.persist.rehydrate();

    expect(reloaded.getState().drafts.s1?.attachments).toEqual(staged);
    expect(reloaded.getState().drafts.s1?.held).toEqual([
      { id: "m1", text: "look at this", attachments: carried, state: "unsent" },
    ]);
  });

  it("drops malformed stored attachments but keeps the message they rode with", async () => {
    const storage = createMemoryStorage();
    storage.setItem(
      "volli:chat-drafts",
      JSON.stringify({
        state: {
          drafts: {
            s1: {
              text: "",
              touchedAt: 1,
              attachments: [blobView(), { blobHash: "not a hash" }, "not an object"],
              held: [
                { id: "m1", text: "kept", attachments: [blobView({ blobHash: "ef".repeat(32) })] },
                { id: "m2", text: "no files", attachments: "not an array" },
                {
                  id: "m3",
                  text: "junk only",
                  attachments: ["not an object", { blobHash: "bad" }],
                },
              ],
            },
          },
        },
        version: 1,
      }),
    );

    const reloaded = createChatDraftsStore(storage);
    await reloaded.persist.rehydrate();

    expect(reloaded.getState().drafts.s1?.attachments).toEqual([blobView()]);
    expect(reloaded.getState().drafts.s1?.held).toEqual([
      {
        id: "m1",
        text: "kept",
        attachments: [blobView({ blobHash: "ef".repeat(32) })],
        state: "unsent",
      },
      { id: "m2", text: "no files", state: "unsent" },
      // An attachments array present but with nothing valid in it reads the
      // same as none at all — an empty list is not a fact worth carrying.
      { id: "m3", text: "junk only", state: "unsent" },
    ]);
  });

  it("drops malformed stored resources but keeps the words they rode with", async () => {
    const storage = createMemoryStorage();
    storage.setItem(
      "volli:chat-drafts",
      JSON.stringify({
        state: {
          drafts: {
            s1: {
              text: "",
              touchedAt: 1,
              held: [
                { id: "m1", text: "kept", state: "queued", resources: "not an array" },
                { id: "m2", text: "also kept", state: "queued", resources: [{ name: 7 }] },
              ],
            },
          },
        },
        version: 1,
      }),
    );

    const reloaded = createChatDraftsStore(storage);
    await reloaded.persist.rehydrate();

    expect(reloaded.getState().drafts.s1?.held).toEqual([
      { id: "m1", text: "kept", state: "unsent" },
      { id: "m2", text: "also kept", state: "unsent" },
    ]);
  });

  // A renderer that has just booted has no round trip open and no release
  // queue, so anything still held is a message nothing took.
  it("reads every held message back as unsent, whatever it was stored as", async () => {
    const storage = createMemoryStorage();
    const first = createChatDraftsStore(storage);
    first.getState().holdMessage("s1", { id: "m1", text: "in flight" });
    first.getState().holdMessage("s1", { id: "m2", text: "queued" });
    first.getState().markHeld("s1", "m2", "queued");

    const reloaded = createChatDraftsStore(storage);
    await reloaded.persist.rehydrate();

    expect(reloaded.getState().drafts.s1?.held).toEqual([
      { id: "m1", text: "in flight", state: "unsent" },
      { id: "m2", text: "queued", state: "unsent" },
    ]);
  });

  it("falls back to an empty draft set when the persisted state is not an object", () => {
    const storage = createMemoryStorage();
    storage.setItem("volli:chat-drafts", JSON.stringify({ state: null, version: 1 }));

    expect(createChatDraftsStore(storage).getState().drafts).toEqual({});
  });

  it("falls back to an empty draft set when `drafts` is missing from persisted state", () => {
    const storage = createMemoryStorage();
    storage.setItem("volli:chat-drafts", JSON.stringify({ state: {}, version: 1 }));

    expect(createChatDraftsStore(storage).getState().drafts).toEqual({});
  });

  it("falls back to an empty draft set when persisted `drafts` is not an object", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      "volli:chat-drafts",
      JSON.stringify({ state: { drafts: "bogus" }, version: 1 }),
    );

    expect(createChatDraftsStore(storage).getState().drafts).toEqual({});
  });

  it("falls back to an empty draft set when persisted `drafts` is null", () => {
    const storage = createMemoryStorage();
    storage.setItem("volli:chat-drafts", JSON.stringify({ state: { drafts: null }, version: 1 }));

    expect(createChatDraftsStore(storage).getState().drafts).toEqual({});
  });

  it("falls back to an empty draft set when persisted `drafts` is an array", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      "volli:chat-drafts",
      JSON.stringify({ state: { drafts: [{ text: "hello", touchedAt: 1 }] }, version: 1 }),
    );

    expect(createChatDraftsStore(storage).getState().drafts).toEqual({});
  });

  it("discards malformed draft entries and keeps well-shaped ones", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      "volli:chat-drafts",
      JSON.stringify({
        state: {
          drafts: {
            good: { text: "hello", touchedAt: 1000 },
            nullText: { text: null, touchedAt: 1000 },
            badTouchedAt: { text: "x", touchedAt: Number.NaN },
            missingText: { touchedAt: 1000 },
            arrayEntry: ["hello", 1000],
            nullEntry: null,
          },
        },
        version: 1,
      }),
    );

    expect(createChatDraftsStore(storage).getState().drafts).toEqual({
      good: { text: "hello", attachments: [], held: [], touchedAt: 1000 },
    });
  });

  it("discards malformed held messages and keeps well-shaped ones", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      "volli:chat-drafts",
      JSON.stringify({
        state: {
          drafts: {
            s1: {
              text: "",
              touchedAt: 1000,
              held: [
                { id: "m1", text: "kept" },
                { id: 7, text: "bad id" },
                { id: "m2", text: null },
                "not an object",
                null,
              ],
            },
            s2: { text: "typing", touchedAt: 1000, held: "not an array" },
          },
        },
        version: 1,
      }),
    );

    expect(createChatDraftsStore(storage).getState().drafts).toEqual({
      s1: {
        text: "",
        attachments: [],
        held: [{ id: "m1", text: "kept", state: "unsent" }],
        touchedAt: 1000,
      },
      s2: { text: "typing", attachments: [], held: [], touchedAt: 1000 },
    });
  });
});
