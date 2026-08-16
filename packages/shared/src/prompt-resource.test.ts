import { describe, expect, it } from "vite-plus/test";

import { promptResourceBlock } from "./prompt-resource";

describe("promptResourceBlock", () => {
  it("wraps the text in BEGIN/END lines that carry the resource's name", () => {
    expect(promptResourceBlock({ name: "conventions", text: "Use tabs." })).toBe(
      [
        "--- BEGIN RESOURCE: conventions ---",
        "Use tabs.",
        "--- END RESOURCE: conventions ---",
      ].join("\n"),
    );
  });

  it("keeps a multi-line body verbatim between the delimiters", () => {
    const text = "line one\n\nline three";
    expect(promptResourceBlock({ name: "doc", text })).toBe(
      `--- BEGIN RESOURCE: doc ---\n${text}\n--- END RESOURCE: doc ---`,
    );
  });
});
