import { describe, expect, it } from "vite-plus/test";

import {
  appendPromptResources,
  isPromptResource,
  promptResourceBlock,
  readPromptResourceBlocks,
} from "./prompt-resource";

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

describe("readPromptResourceBlocks", () => {
  it("round-trips several formatted resources out of surrounding prose", () => {
    const resources = [
      { name: "a", text: "first\nline" },
      { name: "b", text: "second" },
    ];
    expect(readPromptResourceBlocks(appendPromptResources("user prose", resources))).toEqual(
      resources,
    );
  });

  it("returns empty for prose and a begin line with no body newline", () => {
    expect(readPromptResourceBlocks("plain prose")).toEqual([]);
    expect(readPromptResourceBlocks("--- BEGIN RESOURCE: dangling ---")).toEqual([]);
  });

  it("ignores lookalikes and an unterminated block", () => {
    expect(
      readPromptResourceBlocks(
        "inside--- BEGIN RESOURCE: fake ---\nnope\n--- END RESOURCE: fake ---\n" +
          "--- BEGIN RESOURCE: open ---\npartial",
      ),
    ).toEqual([]);
  });

  it("skips malformed begin lines and continues to the next exact block", () => {
    const text = [
      "--- BEGIN RESOURCE: bad --",
      "ignored",
      "--- BEGIN RESOURCE:  ---",
      "also ignored",
      promptResourceBlock({ name: "valid", text: "kept" }),
    ].join("\n");
    expect(readPromptResourceBlocks(text)).toEqual([{ name: "valid", text: "kept" }]);
  });
});

describe("appendPromptResources", () => {
  it("is the exact text when there is nothing to append", () => {
    expect(appendPromptResources("just prose", [])).toBe("just prose");
  });

  it("keeps the user's text first and intact, each block after it, blank-line separated", () => {
    // VC-49's shape: the reference stays in the sentence; the block is
    // adjacent to the text, never spliced into it.
    const text = "can you tell me what /docs does?";
    const composed = appendPromptResources(text, [{ name: "docs", text: "Write docs." }]);
    expect(composed).toBe(
      `${text}\n\n--- BEGIN RESOURCE: docs ---\nWrite docs.\n--- END RESOURCE: docs ---`,
    );
    expect(composed.startsWith(text)).toBe(true);
  });

  it("appends several resources in order, each its own block", () => {
    const composed = appendPromptResources("go", [
      { name: "a", text: "first" },
      { name: "b", text: "second" },
    ]);
    expect(composed).toBe(
      [
        "go",
        "--- BEGIN RESOURCE: a ---\nfirst\n--- END RESOURCE: a ---",
        "--- BEGIN RESOURCE: b ---\nsecond\n--- END RESOURCE: b ---",
      ].join("\n\n"),
    );
  });

  it("never opens with a stray separator when the text is empty", () => {
    expect(appendPromptResources("", [{ name: "a", text: "body" }])).toBe(
      "--- BEGIN RESOURCE: a ---\nbody\n--- END RESOURCE: a ---",
    );
  });
});

describe("isPromptResource", () => {
  it("accepts exactly the name/text pair of strings", () => {
    expect(isPromptResource({ name: "a", text: "b" })).toBe(true);
    expect(isPromptResource({ name: "a", text: "" })).toBe(true);
  });

  it("rejects everything else that could cross a serialization boundary", () => {
    expect(isPromptResource(null)).toBe(false);
    expect(isPromptResource("a")).toBe(false);
    expect(isPromptResource(["a", "b"])).toBe(false);
    expect(isPromptResource({ name: "a" })).toBe(false);
    expect(isPromptResource({ name: 1, text: "b" })).toBe(false);
  });
});
