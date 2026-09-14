import { describe, it, expect } from "vite-plus/test";
import {
  BLOB_URL_SCHEME,
  CHAT_DRAFTS_APP_STATE_KEY,
  MAX_INLINE_IMAGE_BYTES,
  MAX_SESSION_INLINE_IMAGE_BYTES,
  NEW_TICKET_DRAFT_APP_STATE_KEY,
  type BlobLinkView,
  type NamedBlobLink,
  blobRelPath,
  blobsSectionInput,
  blobUrl,
  chatDraftAttachmentHashes,
  draftAttachmentHashes,
  fitsSessionImageBudget,
  inlineImageBytesIn,
  isBlobHash,
  isBlobLinkView,
  isImageMime,
  isInlinableImageMime,
  isProvisionalChatDraftPhase,
  materializedBlobNames,
  parseBlobUrl,
  resolveAttachment,
  sessionImageBudgetRefusal,
} from "./blob";

const HASH = "a".repeat(64);
const OTHER_HASH = `${"0123456789abcdef".repeat(3)}${"0123456789abcdef"}`;

describe("isBlobHash", () => {
  it("accepts 64 lowercase hex digits", () => {
    expect(isBlobHash(HASH)).toBe(true);
    expect(isBlobHash(OTHER_HASH)).toBe(true);
  });

  it("rejects the wrong length", () => {
    expect(isBlobHash("a".repeat(63))).toBe(false);
    expect(isBlobHash("a".repeat(65))).toBe(false);
    expect(isBlobHash("")).toBe(false);
  });

  it("rejects uppercase and non-hex characters", () => {
    expect(isBlobHash("A".repeat(64))).toBe(false);
    expect(isBlobHash("g".repeat(64))).toBe(false);
  });

  it("rejects anything a filesystem would read as a path", () => {
    expect(isBlobHash("../".padEnd(64, "a"))).toBe(false);
    expect(isBlobHash(`${"a".repeat(31)}/${"a".repeat(32)}`)).toBe(false);
  });
});

describe("blobRelPath", () => {
  it("shards on the first two hex characters", () => {
    expect(blobRelPath(HASH)).toBe(`aa/${HASH}`);
    expect(blobRelPath(OTHER_HASH)).toBe(`01/${OTHER_HASH}`);
  });

  it("refuses a value that is not a hash", () => {
    expect(() => blobRelPath("../etc/passwd")).toThrow(/Not a blob hash/);
  });
});

describe("blobUrl", () => {
  it("builds a volli-blob URL", () => {
    expect(blobUrl(HASH)).toBe(`${BLOB_URL_SCHEME}:${HASH}`);
  });

  it("refuses a value that is not a hash", () => {
    expect(() => blobUrl("nope")).toThrow(/Not a blob hash/);
  });
});

describe("parseBlobUrl", () => {
  it("round-trips a URL it built", () => {
    expect(parseBlobUrl(blobUrl(HASH))).toBe(HASH);
  });

  it("tolerates the slashes and trailing slash Electron adds", () => {
    expect(parseBlobUrl(`${BLOB_URL_SCHEME}://${HASH}`)).toBe(HASH);
    expect(parseBlobUrl(`${BLOB_URL_SCHEME}://${HASH}/`)).toBe(HASH);
  });

  it("returns null for another scheme", () => {
    expect(parseBlobUrl(`https://example.com/${HASH}`)).toBe(null);
    expect(parseBlobUrl(HASH)).toBe(null);
  });

  it("returns null when the scheme names something that is not a hash", () => {
    expect(parseBlobUrl(`${BLOB_URL_SCHEME}:../../secrets`)).toBe(null);
    expect(parseBlobUrl(`${BLOB_URL_SCHEME}:`)).toBe(null);
  });
});

describe("isImageMime", () => {
  it("accepts image types", () => {
    expect(isImageMime("image/png")).toBe(true);
    expect(isImageMime("image/jpeg")).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isImageMime("application/pdf")).toBe(false);
    expect(isImageMime("text/plain")).toBe(false);
    expect(isImageMime("")).toBe(false);
  });
});

describe("isInlinableImageMime", () => {
  it("accepts exactly the types a provider takes as image input", () => {
    expect(isInlinableImageMime("image/png")).toBe(true);
    expect(isInlinableImageMime("image/jpeg")).toBe(true);
    expect(isInlinableImageMime("image/gif")).toBe(true);
    expect(isInlinableImageMime("image/webp")).toBe(true);
  });

  it("rejects image types the provider would refuse — an inlined SVG replays its 400 every turn", () => {
    expect(isInlinableImageMime("image/svg+xml")).toBe(false);
    expect(isInlinableImageMime("image/heic")).toBe(false);
    expect(isInlinableImageMime("image/tiff")).toBe(false);
  });

  it("rejects non-images, like isImageMime does", () => {
    expect(isInlinableImageMime("application/pdf")).toBe(false);
    expect(isInlinableImageMime("")).toBe(false);
  });
});

describe("MAX_INLINE_IMAGE_BYTES", () => {
  it("is the 5 MB provider ceiling", () => {
    expect(MAX_INLINE_IMAGE_BYTES).toBe(5 * 1024 * 1024);
  });
});

describe("blobsSectionInput", () => {
  it("expresses every link as a workspace-relative path with its label", () => {
    expect(
      blobsSectionInput([
        { linkId: "l1", blobHash: HASH, label: "homepage mock", originalName: "spec.png" },
        { linkId: "l2", blobHash: OTHER_HASH, label: "the brief", originalName: "brief.pdf" },
      ]),
    ).toEqual({
      files: [
        { relPath: ".volli/attachments/spec.png", label: "homepage mock" },
        { relPath: ".volli/attachments/brief.pdf", label: "the brief" },
      ],
      urls: [],
    });
  });

  it("carries the collision counter into the path", () => {
    const { files } = blobsSectionInput([
      { linkId: "l1", blobHash: HASH, label: "first", originalName: "spec.png" },
      { linkId: "l2", blobHash: OTHER_HASH, label: "second", originalName: "spec.png" },
    ]);
    expect(files.map((file) => file.relPath)).toEqual([
      ".volli/attachments/spec.png",
      ".volli/attachments/spec-2.png",
    ]);
  });

  it("is empty for no links", () => {
    expect(blobsSectionInput([])).toEqual({ files: [], urls: [] });
  });
});

describe("materializedBlobNames", () => {
  function link(linkId: string, originalName: string): NamedBlobLink {
    return { linkId, blobHash: HASH, label: originalName, originalName };
  }

  it("keeps a unique name verbatim", () => {
    const names = materializedBlobNames([link("l1", "spec.png"), link("l2", "notes.md")]);
    expect(names.get("l1")).toBe("spec.png");
    expect(names.get("l2")).toBe("notes.md");
  });

  it("counters a repeated name before the extension", () => {
    const names = materializedBlobNames([link("l1", "spec.png"), link("l2", "spec.png")]);
    expect(names.get("l1")).toBe("spec.png");
    expect(names.get("l2")).toBe("spec-2.png");
  });

  it("skips a counter that a verbatim name already took", () => {
    const names = materializedBlobNames([
      link("l1", "spec.png"),
      link("l2", "spec-2.png"),
      link("l3", "spec.png"),
    ]);
    expect(names.get("l3")).toBe("spec-3.png");
    expect(new Set(names.values()).size).toBe(3);
  });

  it("appends the counter for an extensionless name", () => {
    const names = materializedBlobNames([link("l1", "notes"), link("l2", "notes")]);
    expect(names.get("l2")).toBe("notes-2");
  });

  it("treats a leading-dot name as extensionless", () => {
    const names = materializedBlobNames([link("l1", ".env"), link("l2", ".env")]);
    expect(names.get("l1")).toBe(".env");
    expect(names.get("l2")).toBe(".env-2");
  });

  it("is deterministic for the same input", () => {
    const links = [link("l1", "a.png"), link("l2", "a.png"), link("l3", "a.png")];
    expect([...materializedBlobNames(links)]).toEqual([...materializedBlobNames(links)]);
  });

  it("maps nothing for no links", () => {
    expect(materializedBlobNames([]).size).toBe(0);
  });
});

describe("fitsSessionImageBudget", () => {
  it("admits an image that exactly fills the remaining budget", () => {
    expect(fitsSessionImageBudget(MAX_SESSION_INLINE_IMAGE_BYTES - 10, 10)).toBe(true);
  });

  it("refuses the byte that would cross it", () => {
    expect(fitsSessionImageBudget(MAX_SESSION_INLINE_IMAGE_BYTES - 10, 11)).toBe(false);
  });

  it("admits the first image into an empty session", () => {
    expect(fitsSessionImageBudget(0, MAX_INLINE_IMAGE_BYTES)).toBe(true);
  });

  it("leaves room for more than one maximum-size image", () => {
    // The per-image ceiling and the session budget are separate guards: a
    // session that admitted only one 5 MB image would make the second
    // meaningless.
    expect(fitsSessionImageBudget(MAX_INLINE_IMAGE_BYTES, MAX_INLINE_IMAGE_BYTES)).toBe(true);
  });
});

describe("inlineImageBytesIn", () => {
  const png = (sizeBytes: number) => ({ mime: "image/png", sizeBytes });

  it("counts only what can be inlined into a conversation", () => {
    // A PDF is read from disk when a turn asks for it; an image is replayed
    // into every subsequent turn. Only the second spends the budget, so a
    // 40 MB spec beside a 1 KB screenshot must count 1 KB.
    expect(
      inlineImageBytesIn([
        png(1024),
        { mime: "application/pdf", sizeBytes: 40 * 1024 * 1024 },
        { mime: "text/plain", sizeBytes: 900 },
      ]),
    ).toBe(1024);
  });

  it("sums a whole strip rather than taking its largest", () => {
    expect(inlineImageBytesIn([png(10), png(20), png(30)])).toBe(60);
  });

  it("counts nothing in an empty strip", () => {
    expect(inlineImageBytesIn([])).toBe(0);
  });
});

describe("sessionImageBudgetRefusal", () => {
  it("says nothing while the batch still fits", () => {
    expect(sessionImageBudgetRefusal(0, MAX_SESSION_INLINE_IMAGE_BYTES)).toBeNull();
  });

  it("refuses the byte that crosses the ceiling, and names the total", () => {
    // The wording is the contract: it states what the images come to, not
    // which one is at fault, because by this moment nobody is holding a file.
    expect(sessionImageBudgetRefusal(0, MAX_SESSION_INLINE_IMAGE_BYTES + 1)).toBe(
      "These images come to 20.0 MB, past the 20.0 MB a single chat can carry. " +
        "Remove one and send again.",
    );
    expect(sessionImageBudgetRefusal(15 * 1024 * 1024, 10 * 1024 * 1024)).toBe(
      "These images come to 25.0 MB, past the 20.0 MB a single chat can carry. " +
        "Remove one and send again.",
    );
  });

  it("counts what the Session already holds, not just the batch", () => {
    // The same incoming batch is fine for a fresh chat and refused for one
    // that has been collecting screenshots — which is the whole reason the
    // used half is a parameter.
    const incoming = 6 * 1024 * 1024;
    expect(sessionImageBudgetRefusal(0, incoming)).toBeNull();
    expect(sessionImageBudgetRefusal(15 * 1024 * 1024, incoming)).not.toBeNull();
  });
});

describe("resolveAttachment", () => {
  it("snapshots a file with no home in the project", () => {
    expect(resolveAttachment(null, "application/pdf")).toBe("snapshot");
    expect(resolveAttachment(null, "image/png")).toBe("snapshot");
  });

  it("names a repo document live rather than freezing a copy of it", () => {
    expect(resolveAttachment("docs/spec.pdf", "application/pdf")).toBe("ref");
  });

  it("names a repo image live AND snapshots it, so the model can see it", () => {
    expect(resolveAttachment("src/logo.png", "image/png")).toBe("ref-and-snapshot");
  });

  it("names a repo SVG live only — no provider takes its pixels, so a snapshot buys nothing", () => {
    expect(resolveAttachment("src/logo.svg", "image/svg+xml")).toBe("ref");
  });

  it("snapshots a repo path the ref grammar cannot express", () => {
    // A space truncates the ref run, so `@docs/design notes.pdf` would parse
    // back as `@docs/design` — a snapshot is the honest fallback.
    expect(resolveAttachment("docs/design notes.pdf", "application/pdf")).toBe("snapshot");
    expect(resolveAttachment("docs/design notes.png", "image/png")).toBe("snapshot");
  });

  it("snapshots an extensionless repo-root file, which has no ref form", () => {
    expect(resolveAttachment("Makefile", "text/plain")).toBe("snapshot");
  });
});

describe("isBlobLinkView", () => {
  function view(overrides: Partial<BlobLinkView> = {}): BlobLinkView {
    return {
      linkId: "link-1",
      blobHash: HASH,
      label: "shot.png",
      originalName: "shot.png",
      mime: "image/png",
      sizeBytes: 2048,
      ...overrides,
    };
  }

  it("accepts a well-shaped view, linked or not", () => {
    expect(isBlobLinkView(view())).toBe(true);
    expect(isBlobLinkView(view({ linkId: null }))).toBe(true);
  });

  it("rejects a hash that is not 64 lowercase hex digits", () => {
    expect(isBlobLinkView(view({ blobHash: "not a hash" }))).toBe(false);
  });

  it("rejects a non-finite size", () => {
    expect(isBlobLinkView(view({ sizeBytes: Number.NaN }))).toBe(false);
  });

  it("rejects values that are not plain objects", () => {
    expect(isBlobLinkView(null)).toBe(false);
    expect(isBlobLinkView("a string")).toBe(false);
    expect(isBlobLinkView([view()])).toBe(false);
  });

  it("rejects a view missing a required field", () => {
    const { label: _label, ...rest } = view();
    expect(isBlobLinkView(rest)).toBe(false);
  });
});

/** Wraps the draft-attachment payload in the app_state envelope both processes agree on. */
function envelope(attachments: unknown): string {
  return JSON.stringify({ version: 1, draft: { attachments } });
}

/** Wraps persisted chat Drafts in Zustand's app_state envelope. */
function chatEnvelope(drafts: unknown): string {
  return JSON.stringify({ state: { drafts }, version: 1 });
}

describe("draftAttachmentHashes", () => {
  it("reads the Blob hashes a stored new-Ticket draft still names", () => {
    expect(draftAttachmentHashes(envelope([{ blobHash: HASH }, { blobHash: OTHER_HASH }]))).toEqual(
      [HASH, OTHER_HASH],
    );
  });

  it("retains nothing for a draft with no attachments field", () => {
    expect(draftAttachmentHashes(JSON.stringify({ version: 1, draft: {} }))).toEqual([]);
  });

  it("retains nothing rather than throwing on a malformed value", () => {
    expect(draftAttachmentHashes(undefined)).toEqual([]);
    expect(draftAttachmentHashes("not json")).toEqual([]);
    expect(draftAttachmentHashes(JSON.stringify("a string"))).toEqual([]);
    expect(draftAttachmentHashes(JSON.stringify({ version: 1, draft: "bogus" }))).toEqual([]);
    expect(draftAttachmentHashes(envelope("not an array"))).toEqual([]);
  });

  it("drops a malformed entry but keeps the well-shaped ones beside it", () => {
    expect(
      draftAttachmentHashes(
        envelope([{ blobHash: HASH }, { blobHash: "not a hash" }, "not an object", null]),
      ),
    ).toEqual([HASH]);
  });

  it("names the same app_state key both processes read and write", () => {
    expect(NEW_TICKET_DRAFT_APP_STATE_KEY).toBe("volli:new-ticket-draft");
  });
});

describe("chatDraftAttachmentHashes", () => {
  it("reads ownerless Blobs from both the composer strip and held first messages", () => {
    expect(
      chatDraftAttachmentHashes(
        chatEnvelope({
          chatA: {
            provisional: { phase: "draft" },
            attachments: [{ linkId: null, blobHash: HASH }],
            held: [
              { attachments: [{ linkId: null, blobHash: OTHER_HASH }] },
              { text: "without files" },
            ],
          },
        }),
      ),
    ).toEqual([HASH, OTHER_HASH]);
  });

  it("drops malformed branches and entries without hiding valid neighboring Drafts", () => {
    expect(
      chatDraftAttachmentHashes(
        chatEnvelope({
          broken: null,
          arrayDraft: [],
          durable: { attachments: [{ linkId: null, blobHash: OTHER_HASH }] },
          badProvisional: {
            provisional: [],
            attachments: [{ linkId: null, blobHash: OTHER_HASH }],
          },
          chatA: {
            provisional: { phase: "draft" },
            attachments: "not an array",
            held: [null, [], { attachments: [null, [], { linkId: null, blobHash: "bad" }] }],
          },
          chatB: {
            provisional: { phase: "session-created" },
            attachments: [
              { linkId: "already-linked", blobHash: OTHER_HASH },
              { linkId: null, blobHash: HASH },
            ],
            held: "not an array",
          },
        }),
      ),
    ).toEqual([HASH]);
  });

  it("retains only phases the renderer also recognises", () => {
    // The two readers of this envelope must agree. If main kept the Blobs of a
    // Draft whose phase the renderer refuses — `readProvisionalChatDraft`
    // drops the whole provisional record — those bytes would be held for an
    // owner that no longer exists in the only process that could ever release
    // them. Better to sweep them: the renderer has already given the Draft up.
    const unknownPhase = chatEnvelope({
      chatA: {
        provisional: { projectId: "p1", operationId: "op", phase: "a-later-build-invented-this" },
        attachments: [{ linkId: null, blobHash: HASH }],
      },
    });
    expect(chatDraftAttachmentHashes(unknownPhase)).toEqual([]);
    expect(isProvisionalChatDraftPhase("draft")).toBe(true);
    expect(isProvisionalChatDraftPhase("session-created")).toBe(true);
    expect(isProvisionalChatDraftPhase("a-later-build-invented-this")).toBe(false);
    expect(isProvisionalChatDraftPhase(undefined)).toBe(false);
  });

  it("retains nothing rather than throwing on malformed envelopes", () => {
    expect(chatDraftAttachmentHashes(undefined)).toEqual([]);
    expect(chatDraftAttachmentHashes("not json")).toEqual([]);
    expect(chatDraftAttachmentHashes(JSON.stringify(null))).toEqual([]);
    expect(chatDraftAttachmentHashes(JSON.stringify([]))).toEqual([]);
    expect(chatDraftAttachmentHashes(JSON.stringify({ state: null }))).toEqual([]);
    expect(chatDraftAttachmentHashes(JSON.stringify({ state: [] }))).toEqual([]);
    expect(chatDraftAttachmentHashes(JSON.stringify({ state: { drafts: null } }))).toEqual([]);
    expect(chatDraftAttachmentHashes(JSON.stringify({ state: { drafts: [] } }))).toEqual([]);
  });

  it("reads the envelope the renderer's own persist middleware writes", () => {
    // The point of the shared key is that ONE writer and ONE reader agree.
    // Asserting the literal proves nothing about that, so this drives the
    // reader with a payload shaped exactly as zustand's `persist` emits it
    // under {@link CHAT_DRAFTS_APP_STATE_KEY} — the shape main parses at boot.
    const persisted = JSON.stringify({
      state: {
        drafts: {
          "draft-1": {
            text: "words",
            touchedAt: 1,
            provisional: { projectId: "p1", ticketId: null, operationId: "op", phase: "draft" },
            attachments: [{ linkId: null, blobHash: HASH }],
            held: [],
          },
        },
      },
      version: 1,
    });
    expect(CHAT_DRAFTS_APP_STATE_KEY).toBe("volli:chat-drafts");
    expect(chatDraftAttachmentHashes(persisted)).toEqual([HASH]);
  });
});
