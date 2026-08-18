import { describe, expect, it } from "vite-plus/test";

import { fileTypeLabel, formatFileSize, thumbKind } from "./attachment-model";

describe("thumbKind", () => {
  it("previews an image as itself and stands in for everything else", () => {
    expect(thumbKind("image/png")).toBe("image");
    expect(thumbKind("image/svg+xml")).toBe("image");
    expect(thumbKind("application/pdf")).toBe("file");
    expect(thumbKind("application/octet-stream")).toBe("file");
  });
});

describe("formatFileSize", () => {
  it("keeps bytes whole and larger units to one decimal", () => {
    expect(formatFileSize(0)).toBe("0 B");
    expect(formatFileSize(840)).toBe("840 B");
    expect(formatFileSize(1024)).toBe("1.0 KB");
    expect(formatFileSize(12_698)).toBe("12.4 KB");
    expect(formatFileSize(3_250_586)).toBe("3.1 MB");
  });

  it("stops climbing at gigabytes rather than inventing a unit", () => {
    expect(formatFileSize(1024 ** 3)).toBe("1.0 GB");
    expect(formatFileSize(1024 ** 4)).toBe("1024.0 GB");
  });

  it("says nothing for a size that is not one", () => {
    expect(formatFileSize(Number.NaN)).toBe("");
    expect(formatFileSize(-1)).toBe("");
  });
});

describe("fileTypeLabel", () => {
  it("uses the extension, which is the word the person already has", () => {
    expect(fileTypeLabel("spec.pdf", "application/pdf")).toBe("PDF");
    expect(fileTypeLabel("Archive.TAR.gz", "application/gzip")).toBe("GZ");
  });

  it("falls back to the media subtype when there is no extension", () => {
    expect(fileTypeLabel("Makefile", "text/plain")).toBe("PLAIN");
    // A dotfile has no extension — the dot at index 0 does not start one.
    expect(fileTypeLabel(".env", "text/plain")).toBe("PLAIN");
    // Nor does a trailing dot.
    expect(fileTypeLabel("weird.", "text/plain")).toBe("PLAIN");
  });

  it("never renders a blank card label", () => {
    expect(fileTypeLabel("Makefile", "nonsense")).toBe("FILE");
    expect(fileTypeLabel("Makefile", "application/")).toBe("FILE");
  });
});
