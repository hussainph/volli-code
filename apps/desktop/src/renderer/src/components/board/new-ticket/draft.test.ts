import { describe, expect, it } from "vite-plus/test";

import type { SyncStateStorage } from "@renderer/lib/app-state-storage";

import { clearDraft, type ComposerDraft, isEmptyDraft, loadDraft, saveDraft } from "./draft";

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

function draft(overrides: Partial<ComposerDraft> = {}): ComposerDraft {
  return {
    projectId: "p1",
    status: "todo",
    priority: "high",
    title: "A drafted ticket",
    body: "Some body",
    labels: ["bug"],
    usesWorktree: true,
    ...overrides,
  };
}

describe("saveDraft/loadDraft", () => {
  it("round-trips the full field state", () => {
    const storage = fakeStorage();
    saveDraft(draft(), storage);
    expect(loadDraft(storage)).toEqual(draft());
  });

  it("treats a content-empty draft as a discard: the stored slot is removed", () => {
    const storage = fakeStorage();
    saveDraft(draft(), storage);
    saveDraft(draft({ title: "  ", body: "\n", labels: [] }), storage);
    expect(storage.map.size).toBe(0);
    expect(loadDraft(storage)).toBeNull();
  });

  it("keeps a draft whose only content is labels or body", () => {
    const storage = fakeStorage();
    saveDraft(draft({ title: "", body: "", labels: ["keep"] }), storage);
    expect(loadDraft(storage)?.labels).toEqual(["keep"]);
    saveDraft(draft({ title: "", body: "only a body", labels: [] }), storage);
    expect(loadDraft(storage)?.body).toBe("only a body");
  });
});

describe("clearDraft", () => {
  it("drops the stored draft", () => {
    const storage = fakeStorage();
    saveDraft(draft(), storage);
    clearDraft(storage);
    expect(loadDraft(storage)).toBeNull();
  });
});

describe("loadDraft validation", () => {
  const KEY = "volli:new-ticket-draft";

  it("returns null with nothing stored", () => {
    expect(loadDraft(fakeStorage())).toBeNull();
  });

  it.each([
    ["malformed JSON", "{nope"],
    ["non-object envelope", JSON.stringify("hi")],
    ["wrong version", JSON.stringify({ version: 2, draft: draft() })],
    ["missing draft", JSON.stringify({ version: 1 })],
    ["bad status", JSON.stringify({ version: 1, draft: { ...draft(), status: "nope" } })],
    ["bad priority", JSON.stringify({ version: 1, draft: { ...draft(), priority: 5 } })],
    ["non-string label", JSON.stringify({ version: 1, draft: { ...draft(), labels: [1] } })],
    ["missing field", JSON.stringify({ version: 1, draft: { title: "x" } })],
    [
      "valid but content-empty draft",
      JSON.stringify({ version: 1, draft: draft({ title: " ", body: "", labels: [] }) }),
    ],
  ])("returns null for %s", (_name, raw) => {
    const storage = fakeStorage();
    storage.setItem(KEY, raw);
    expect(loadDraft(storage)).toBeNull();
  });
});

describe("isEmptyDraft", () => {
  it("is true only when title, body, and labels are all empty", () => {
    expect(isEmptyDraft(draft({ title: " ", body: "", labels: [] }))).toBe(true);
    expect(isEmptyDraft(draft({ title: "t", body: "", labels: [] }))).toBe(false);
    expect(isEmptyDraft(draft({ title: "", body: "b", labels: [] }))).toBe(false);
    expect(isEmptyDraft(draft({ title: "", body: "", labels: ["l"] }))).toBe(false);
  });
});
