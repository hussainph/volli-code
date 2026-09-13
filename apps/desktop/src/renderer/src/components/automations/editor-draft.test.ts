import { describe, expect, it } from "vite-plus/test";

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
