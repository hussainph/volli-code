import { describe, it, expect } from "vite-plus/test";
import { defaultAttachmentLabel } from "./ticket-attachment";

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
