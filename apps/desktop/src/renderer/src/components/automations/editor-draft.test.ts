import { describe, expect, it, vi } from "vite-plus/test";

import type { SyncStateStorage } from "@renderer/lib/app-state-storage";

import {
  clearEditorDraft,
  type AutomationEditorDraft,
  isEmptyEditorDraft,
  loadEditorDraft,
  saveEditorDraft,
} from "./editor-draft";

/** In-memory SyncStateStorage double. */
function fakeStorage(): SyncStateStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

/**
 * The same double, plus the durable adapter's `flush` — which is what says a
 * write left now instead of on the debounce.
 */
function flushableStorage(): SyncStateStorage & {
  map: Map<string, string>;
  flush: ReturnType<typeof vi.fn>;
} {
  const base = fakeStorage();
  return Object.assign(base, { flush: vi.fn<(key: string) => void>() });
}

const DRAFT_KEY = "volli:automation-editor-draft";

function draft(overrides: Partial<AutomationEditorDraft> = {}): AutomationEditorDraft {
  return {
    name: "Nightly sweep",
    instructions: "/review",
    ownership: "project",
    triggerChoice: "schedule",
    columns: [],
    schedule: { preset: "daily", hour: 21, minute: 0, timeZone: "Europe/London" },
    runtime: null,
    ...overrides,
  };
}

describe("a retraction does not wait for the debounce", () => {
  // The defect this covers (VC-375): the clear reached the cache but its write
  // was still sitting on the 200ms debounce when the app quit, so the next
  // launch read the draft back out of SQLite and the Automations page opened
  // on a create form with the saved record unreachable.
  it("flushes when a slot is cleared, so a quit cannot resurrect the draft", () => {
    const storage = flushableStorage();
    saveEditorDraft("p1", draft(), storage);
    expect(storage.flush).not.toHaveBeenCalled();

    clearEditorDraft("p1", storage);
    expect(storage.flush).toHaveBeenCalledWith(DRAFT_KEY);
    expect(loadEditorDraft("p1", storage)).toBeNull();
  });

  it("flushes when erasing a new draft, which is the same retraction by another name", () => {
    const storage = flushableStorage();
    saveEditorDraft("p1", draft(), storage);
    storage.flush.mockClear();

    saveEditorDraft("p1", draft({ name: "", instructions: "", triggerChoice: "none" }), storage);
    expect(storage.flush).toHaveBeenCalledWith(DRAFT_KEY);
    expect(loadEditorDraft("p1", storage)).toBeNull();
  });

  it("does not flush an ordinary keystroke, which the debounce exists for", () => {
    const storage = flushableStorage();
    saveEditorDraft("p1", draft({ name: "N" }), storage);
    saveEditorDraft("p1", draft({ name: "Ni" }), storage);
    saveEditorDraft("p1", draft({ name: "Nig" }), storage, "a1");
    expect(storage.flush).not.toHaveBeenCalled();
  });

  it("clears every other project's draft not at all, and still flushes", () => {
    const storage = flushableStorage();
    saveEditorDraft("p1", draft(), storage);
    saveEditorDraft("p2", draft({ name: "Kept" }), storage);
    storage.flush.mockClear();

    clearEditorDraft("p1", storage);
    expect(storage.flush).toHaveBeenCalledWith(DRAFT_KEY);
    expect(loadEditorDraft("p1", storage)).toBeNull();
    expect(loadEditorDraft("p2", storage)?.name).toBe("Kept");
  });

  it("asks nothing of a storage that cannot flush", () => {
    const storage = fakeStorage();
    saveEditorDraft("p1", draft(), storage);
    expect(() => clearEditorDraft("p1", storage)).not.toThrow();
    expect(loadEditorDraft("p1", storage)).toBeNull();
  });
});

describe("saveEditorDraft/loadEditorDraft", () => {
  it("round-trips the full field state, per project", () => {
    const storage = fakeStorage();
    saveEditorDraft("p1", draft(), storage);
    saveEditorDraft("p2", draft({ name: "Other project's draft" }), storage);
    expect(loadEditorDraft("p1", storage)).toEqual(draft());
    expect(loadEditorDraft("p2", storage)).toEqual(draft({ name: "Other project's draft" }));
  });

  it("isolates edits by saved record as well as project, including an emptied edit", () => {
    const storage = fakeStorage();
    saveEditorDraft("p1", draft(), storage);
    saveEditorDraft("p1", draft({ name: "Edit A" }), storage, "a1");
    saveEditorDraft("p1", draft({ name: "Edit B" }), storage, "a2");
    expect(loadEditorDraft("p1", storage)?.name).toBe("Nightly sweep");
    expect(loadEditorDraft("p1", storage, "a1")?.name).toBe("Edit A");
    saveEditorDraft("p1", draft({ name: "", instructions: "" }), storage, "a1");
    expect(loadEditorDraft("p1", storage, "a1")?.name).toBe("");
    clearEditorDraft("p1", storage, "a1");
    expect(loadEditorDraft("p1", storage, "a1")).toBeNull();
    expect(loadEditorDraft("p1", storage, "a2")?.name).toBe("Edit B");
  });

  it("keeps a tier runtime and a column trigger whole", () => {
    const storage = fakeStorage();
    const withFields = draft({
      triggerChoice: "columns",
      columns: ["todo", "doing"],
      runtime: { kind: "tier", tier: "fast" },
    });
    saveEditorDraft("p1", withFields, storage);
    expect(loadEditorDraft("p1", storage)).toEqual(withFields);
  });

  it("treats a default-empty draft as a discard: the stored slot is dropped", () => {
    const storage = fakeStorage();
    saveEditorDraft("p1", draft(), storage);
    saveEditorDraft(
      "p1",
      draft({ name: "  ", instructions: "\n", triggerChoice: "none" }),
      storage,
    );
    expect(loadEditorDraft("p1", storage)).toBeNull();
  });

  it("removes the whole row when no project holds content, and never writes an empty map", () => {
    const storage = fakeStorage();
    saveEditorDraft("p1", draft(), storage);
    clearEditorDraft("p1", storage);
    expect(storage.map.size).toBe(0);
  });

  it("clears one project's slot without touching another's", () => {
    const storage = fakeStorage();
    saveEditorDraft("p1", draft(), storage);
    saveEditorDraft("p2", draft({ name: "Keep me" }), storage);
    clearEditorDraft("p1", storage);
    expect(loadEditorDraft("p1", storage)).toBeNull();
    expect(loadEditorDraft("p2", storage)).toEqual(draft({ name: "Keep me" }));
  });
});

describe("loadEditorDraft defensiveness", () => {
  it("reads malformed JSON, wrong versions and junk slots as no draft", () => {
    const storage = fakeStorage();
    storage.map.set("volli:automation-editor-draft", "{not json");
    expect(loadEditorDraft("p1", storage)).toBeNull();
    storage.map.set(
      "volli:automation-editor-draft",
      JSON.stringify({ version: 0, drafts: { p1: draft() } }),
    );
    expect(loadEditorDraft("p1", storage)).toBeNull();
    storage.map.set(
      "volli:automation-editor-draft",
      JSON.stringify({ version: 1, drafts: { p1: { name: 7 } } }),
    );
    expect(loadEditorDraft("p1", storage)).toBeNull();
  });

  it("rejects missing or corrupt runtimes rather than rewriting them to inherit", () => {
    const storage = fakeStorage();
    const legacy = draft() as unknown as Record<string, unknown>;
    delete legacy["runtime"];
    storage.map.set(
      "volli:automation-editor-draft",
      JSON.stringify({ version: 1, drafts: { p1: legacy } }),
    );
    expect(loadEditorDraft("p1", storage)).toBeNull(); // missing field fails shape check — a slot this old never existed
    storage.map.set(
      "volli:automation-editor-draft",
      JSON.stringify({
        version: 1,
        drafts: {
          p1: draft({ runtime: { kind: "weird" } as unknown as AutomationEditorDraft["runtime"] }),
        },
      }),
    );
    expect(loadEditorDraft("p1", storage)).toBeNull();
  });

  it("accepts runtime null (inherit) and passes real records through", () => {
    const storage = fakeStorage();
    saveEditorDraft("p1", draft({ runtime: null }), storage);
    expect(loadEditorDraft("p1", storage)?.runtime).toBeNull();
  });
});

describe("isEmptyEditorDraft", () => {
  const blank = (): AutomationEditorDraft =>
    draft({
      name: "",
      instructions: "",
      ownership: "project",
      triggerChoice: "none",
      runtime: null,
    });

  it("only discards a draft that still matches the new editor's meaningful defaults", () => {
    expect(isEmptyEditorDraft(blank())).toBe(true);
    expect(isEmptyEditorDraft({ ...blank(), name: " " })).toBe(true);
    expect(isEmptyEditorDraft({ ...blank(), instructions: "/x" })).toBe(false);
    expect(isEmptyEditorDraft({ ...blank(), ownership: "global" })).toBe(false);
    expect(isEmptyEditorDraft({ ...blank(), triggerChoice: "schedule" })).toBe(false);
    expect(isEmptyEditorDraft({ ...blank(), runtime: { kind: "tier", tier: "fast" } })).toBe(false);
  });
});
