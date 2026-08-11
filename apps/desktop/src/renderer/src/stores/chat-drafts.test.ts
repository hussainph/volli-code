import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createChatDraftsStore, MAX_DRAFTS } from "./chat-drafts";

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
        state: { drafts: Record<string, { text: string; touchedAt: number }> };
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

    expect(store.getState().drafts.s1).toEqual({ text: "hello", touchedAt: 1000 });
  });

  it("overwrites an existing draft's text and re-stamps touchedAt", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const store = createChatDraftsStore(createMemoryStorage());
    store.getState().setDraft("s1", "hello");

    vi.setSystemTime(2000);
    store.getState().setDraft("s1", "hello world");

    expect(store.getState().drafts.s1).toEqual({ text: "hello world", touchedAt: 2000 });
  });

  it("keeps other sessions' drafts untouched", () => {
    const store = createChatDraftsStore(createMemoryStorage());
    store.getState().setDraft("s1", "one");
    store.getState().setDraft("s2", "two");

    expect(store.getState().drafts.s1?.text).toBe("one");
    expect(store.getState().drafts.s2?.text).toBe("two");
  });
});

describe("clearDraft", () => {
  it("empties the box the moment its message is dispatched", () => {
    const store = createChatDraftsStore(createMemoryStorage());
    store.getState().setDraft("s1", "hello");

    store.getState().clearDraft("s1");

    expect(store.getState().drafts).not.toHaveProperty("s1");
  });

  it("leaves other sessions' drafts alone", () => {
    const store = createChatDraftsStore(createMemoryStorage());
    store.getState().setDraft("s1", "one");
    store.getState().setDraft("s2", "two");

    store.getState().clearDraft("s1");

    expect(store.getState().drafts.s2?.text).toBe("two");
  });

  it("is a no-op for a session with no draft", () => {
    const store = createChatDraftsStore(createMemoryStorage());
    const before = store.getState().drafts;

    store.getState().clearDraft("missing");

    expect(store.getState().drafts).toBe(before);
  });
});

describe("restoreDraft", () => {
  it("puts words back when nothing took them", () => {
    vi.useFakeTimers();
    vi.setSystemTime(2000);
    const store = createChatDraftsStore(createMemoryStorage());
    store.getState().setDraft("s1", "hello");
    store.getState().clearDraft("s1");

    store.getState().restoreDraft("s1", "hello");

    expect(store.getState().drafts.s1).toEqual({ text: "hello", touchedAt: 2000 });
  });

  // Delivery is a round trip and the composer stays editable across it: a
  // failure must lose neither the message that never left nor the one typed
  // behind it.
  it("prepends rather than overwriting whatever was typed since", () => {
    const store = createChatDraftsStore(createMemoryStorage());
    store.getState().setDraft("s1", "hello");
    store.getState().clearDraft("s1");
    store.getState().setDraft("s1", "and one more thing");

    store.getState().restoreDraft("s1", "hello");

    expect(store.getState().drafts.s1?.text).toBe("hello\nand one more thing");
  });

  it("treats a whitespace-only box as an empty one", () => {
    const store = createChatDraftsStore(createMemoryStorage());
    store.getState().setDraft("s1", "  ");

    store.getState().restoreDraft("s1", "hello");

    expect(store.getState().drafts.s1?.text).toBe("hello");
  });
});

describe("persistence", () => {
  it("drops blank and whitespace-only drafts at persist time", () => {
    const storage = createMemoryStorage();
    const store = createChatDraftsStore(storage);

    store.getState().setDraft("blank", "   ");
    store.getState().setDraft("empty", "");
    store.getState().setDraft("kept", "hello");

    expect(Object.keys(readPersisted(storage)!.state.drafts)).toEqual(["kept"]);
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
      s1: { text: "hello", touchedAt: expect.any(Number) as number },
    });
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
      good: { text: "hello", touchedAt: 1000 },
    });
  });
});
