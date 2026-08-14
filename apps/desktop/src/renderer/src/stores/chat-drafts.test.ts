import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createChatDraftsStore, MAX_DRAFTS, type ChatDraft } from "./chat-drafts";

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

describe("setDraft", () => {
  it("stores text and stamps touchedAt", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const store = createChatDraftsStore(createMemoryStorage());

    store.getState().setDraft("s1", "hello");

    expect(store.getState().drafts.s1).toEqual({ text: "hello", held: [], touchedAt: 1000 });
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

  it("rehydrates drafts from a seeded storage into a fresh store", async () => {
    const storage = createMemoryStorage();
    createChatDraftsStore(storage).getState().setDraft("s1", "hello");

    const reloaded = createChatDraftsStore(storage);
    await reloaded.persist.rehydrate();

    expect(reloaded.getState().drafts).toEqual({
      s1: { text: "hello", held: [], touchedAt: expect.any(Number) as number },
    });
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
      good: { text: "hello", held: [], touchedAt: 1000 },
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
      s1: { text: "", held: [{ id: "m1", text: "kept", state: "unsent" }], touchedAt: 1000 },
      s2: { text: "typing", held: [], touchedAt: 1000 },
    });
  });
});
