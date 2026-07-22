import { describe, it, expect } from "vite-plus/test";
import {
  attachmentsSectionInput,
  defaultAttachmentLabel,
  materializedAttachmentNames,
} from "./ticket-attachment";
import type { TicketAttachment } from "./ticket-attachment";

function fileAttachment(id: string, fileName: string): TicketAttachment {
  return {
    id,
    ticketId: "ticket-1",
    kind: "file",
    label: fileName,
    fileName,
    createdAt: 0,
  };
}

function urlAttachment(id: string, url: string): TicketAttachment {
  return { id, ticketId: "ticket-1", kind: "url", label: url, url, createdAt: 0 };
}

describe("defaultAttachmentLabel", () => {
  it("uses the fileName for a file attachment", () => {
    expect(defaultAttachmentLabel({ kind: "file", fileName: "spec.png" })).toBe("spec.png");
  });

  it("uses the url verbatim for a url attachment", () => {
    expect(defaultAttachmentLabel({ kind: "url", url: "https://example.com" })).toBe(
      "https://example.com",
    );
  });
});

describe("materializedAttachmentNames", () => {
  it("returns an empty map for no attachments", () => {
    expect(materializedAttachmentNames([])).toEqual(new Map());
  });

  it("keeps a single file's basename verbatim", () => {
    const map = materializedAttachmentNames([fileAttachment("a1", "spec.png")]);
    expect(map).toEqual(new Map([["a1", "spec.png"]]));
  });

  it("excludes url-kind attachments from the mapping", () => {
    const map = materializedAttachmentNames([
      fileAttachment("a1", "spec.png"),
      urlAttachment("a2", "https://example.com/design"),
    ]);
    expect(map.has("a2")).toBe(false);
    expect(map.get("a1")).toBe("spec.png");
  });

  it("dedupes a later same-basename file with -2 inserted before the extension", () => {
    const map = materializedAttachmentNames([
      fileAttachment("a1", "spec.png"),
      fileAttachment("a2", "spec.png"),
    ]);
    expect(map.get("a1")).toBe("spec.png");
    expect(map.get("a2")).toBe("spec-2.png");
  });
});

describe("attachmentsSectionInput", () => {
  it("returns empty files and urls for no attachments", () => {
    expect(attachmentsSectionInput([])).toEqual({ files: [], urls: [] });
  });

  it("maps a file attachment's materialized relPath + label", () => {
    expect(
      attachmentsSectionInput([
        {
          id: "a1",
          ticketId: "t1",
          kind: "file",
          label: "homepage mock",
          fileName: "spec.png",
          createdAt: 0,
        },
      ]),
    ).toEqual({
      files: [{ relPath: ".volli/attachments/spec.png", label: "homepage mock" }],
      urls: [],
    });
  });

  it("passes a url attachment through verbatim", () => {
    expect(
      attachmentsSectionInput([
        {
          id: "a1",
          ticketId: "t1",
          kind: "url",
          label: "design doc",
          url: "https://example.com/design",
          createdAt: 0,
        },
      ]),
    ).toEqual({
      files: [],
      urls: [{ url: "https://example.com/design", label: "design doc" }],
    });
  });

  it("dedupes file relPaths using the same rule as materializedAttachmentNames", () => {
    const attachments: TicketAttachment[] = [
      {
        id: "a1",
        ticketId: "t1",
        kind: "file",
        label: "spec.png",
        fileName: "spec.png",
        createdAt: 0,
      },
      {
        id: "a2",
        ticketId: "t1",
        kind: "file",
        label: "spec.png",
        fileName: "spec.png",
        createdAt: 1,
      },
    ];
    expect(attachmentsSectionInput(attachments).files).toEqual([
      { relPath: ".volli/attachments/spec.png", label: "spec.png" },
      { relPath: ".volli/attachments/spec-2.png", label: "spec.png" },
    ]);
  });
});

describe("materializedAttachmentNames — dedup counter", () => {
  it("continues the counter for a third+ duplicate", () => {
    const map = materializedAttachmentNames([
      fileAttachment("a1", "spec.png"),
      fileAttachment("a2", "spec.png"),
      fileAttachment("a3", "spec.png"),
    ]);
    expect(map.get("a1")).toBe("spec.png");
    expect(map.get("a2")).toBe("spec-2.png");
    expect(map.get("a3")).toBe("spec-3.png");
  });

  it("dedupes an extensionless fileName as name-2, name-3, ...", () => {
    const map = materializedAttachmentNames([
      fileAttachment("a1", "notes"),
      fileAttachment("a2", "notes"),
    ]);
    expect(map.get("a1")).toBe("notes");
    expect(map.get("a2")).toBe("notes-2");
  });

  it("never collides a counter-suffixed name with another attachment's verbatim name", () => {
    // a3 is the second `spec.png`, so the naive counter would hand it
    // `spec-2.png` — already taken verbatim by a2. It must skip ahead.
    const map = materializedAttachmentNames([
      fileAttachment("a1", "spec.png"),
      fileAttachment("a2", "spec-2.png"),
      fileAttachment("a3", "spec.png"),
    ]);
    expect(map.get("a1")).toBe("spec.png");
    expect(map.get("a2")).toBe("spec-2.png");
    expect(map.get("a3")).toBe("spec-3.png");
    expect(new Set(map.values()).size).toBe(3);
  });

  it("never collides a verbatim name with an already-generated counter name", () => {
    // a2's dedupe took `spec-2.png` before a3 arrived wanting it verbatim.
    const map = materializedAttachmentNames([
      fileAttachment("a1", "spec.png"),
      fileAttachment("a2", "spec.png"),
      fileAttachment("a3", "spec-2.png"),
    ]);
    expect(map.get("a1")).toBe("spec.png");
    expect(map.get("a2")).toBe("spec-2.png");
    expect(map.get("a3")).toBe("spec-2-2.png");
    expect(new Set(map.values()).size).toBe(3);
  });

  it("is deterministic — the same chronological input always maps the same way", () => {
    const attachments = [
      fileAttachment("a1", "spec.png"),
      fileAttachment("a2", "spec.png"),
      fileAttachment("a3", "notes.md"),
    ];
    expect(materializedAttachmentNames(attachments)).toEqual(
      materializedAttachmentNames(attachments),
    );
  });
});
