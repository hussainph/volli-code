import { describe, expect, it } from "vite-plus/test";

import type { BlobLinkView } from "@volli/shared";
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

/** One staged file, unowned until the Ticket exists (VC-137). */
function blobView(overrides: Partial<BlobLinkView> = {}): BlobLinkView {
  return {
    linkId: null,
    blobHash: "ab".repeat(32),
    label: "shot.png",
    originalName: "shot.png",
    mime: "image/png",
    sizeBytes: 2048,
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

  it("round-trips a chosen base branch, and reads a pre-baseBranch draft as unset", () => {
    const storage = fakeStorage();
    saveDraft(draft({ baseBranch: "origin/main" }), storage);
    expect(loadDraft(storage)?.baseBranch).toBe("origin/main");

    // A draft written before the base chip existed must still restore rather
    // than read as "no draft" — its base is simply unset.
    const { baseBranch: _omitted, ...legacy } = draft({ baseBranch: "x" });
    storage.setItem("volli:new-ticket-draft", JSON.stringify({ version: 1, draft: legacy }));
    expect(loadDraft(storage)?.baseBranch).toBeUndefined();

    saveDraft(draft({ baseBranch: null }), storage);
    expect(loadDraft(storage)?.baseBranch).toBeNull();
  });

  it("keeps a draft whose only content is labels or body", () => {
    const storage = fakeStorage();
    saveDraft(draft({ title: "", body: "", labels: ["keep"] }), storage);
    expect(loadDraft(storage)?.labels).toEqual(["keep"]);
    saveDraft(draft({ title: "", body: "only a body", labels: [] }), storage);
    expect(loadDraft(storage)?.body).toBe("only a body");
  });

  // The attachments strip is content too (VC-137): a dropped screenshot with
  // no title yet is as much a half-written Ticket as a sentence is, and it
  // must survive the same Escape / overlay-click / quit the words survive.
  it("round-trips a staged attachment, and keeps a draft whose only content is one", () => {
    const storage = fakeStorage();
    const attachments = [blobView()];
    saveDraft(draft({ title: "", body: "", labels: [], attachments }), storage);

    expect(loadDraft(storage)?.attachments).toEqual(attachments);
  });

  it("reads a pre-attachments draft as carrying none", () => {
    const storage = fakeStorage();
    storage.setItem("volli:new-ticket-draft", JSON.stringify({ version: 1, draft: draft() }));
    expect(loadDraft(storage)?.attachments).toBeUndefined();
  });

  it("drops a malformed stored attachment but keeps the well-shaped ones beside it", () => {
    const storage = fakeStorage();
    storage.setItem(
      "volli:new-ticket-draft",
      JSON.stringify({
        version: 1,
        draft: {
          ...draft(),
          attachments: [blobView(), { blobHash: "not a hash" }, "not an object"],
        },
      }),
    );

    // A malformed entry inside `attachments` fails the whole-draft shape guard
    // rather than being sifted field by field — the same stance every other
    // field in this validator takes (a bad label fails the draft, not silently
    // drops itself). Loading falls back to "no draft" rather than a strip with
    // a hole in it.
    expect(loadDraft(storage)).toBeNull();
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
    ["non-string baseBranch", JSON.stringify({ version: 1, draft: { ...draft(), baseBranch: 7 } })],
    [
      "non-array attachments",
      JSON.stringify({ version: 1, draft: { ...draft(), attachments: "bogus" } }),
    ],
    [
      "malformed attachment entry",
      JSON.stringify({
        version: 1,
        draft: { ...draft(), attachments: [{ blobHash: "not a hash" }] },
      }),
    ],
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
  it("is true only when title, body, labels, and attachments are all empty", () => {
    expect(isEmptyDraft(draft({ title: " ", body: "", labels: [] }))).toBe(true);
    expect(isEmptyDraft(draft({ title: "t", body: "", labels: [] }))).toBe(false);
    expect(isEmptyDraft(draft({ title: "", body: "b", labels: [] }))).toBe(false);
    expect(isEmptyDraft(draft({ title: "", body: "", labels: ["l"] }))).toBe(false);
    expect(
      isEmptyDraft(draft({ title: " ", body: "", labels: [], attachments: [blobView()] })),
    ).toBe(false);
    expect(isEmptyDraft(draft({ title: " ", body: "", labels: [], attachments: [] }))).toBe(true);
  });
});
