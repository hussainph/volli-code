import { describe, it, expect } from "vite-plus/test";
import {
  BLOB_URL_SCHEME,
  MAX_INLINE_IMAGE_BYTES,
  type NamedBlobLink,
  blobRelPath,
  blobsSectionInput,
  blobUrl,
  isBlobHash,
  isImageMime,
  materializedBlobNames,
  parseBlobUrl,
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
