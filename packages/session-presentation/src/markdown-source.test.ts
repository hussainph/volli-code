import { describe, expect, it } from "vite-plus/test";

import { splitMarkdownSource } from "./markdown-source";

describe("splitMarkdownSource", () => {
  it("lifts a fenced block out of the prose around it", () => {
    expect(splitMarkdownSource("Before\n\n```ts\nconst a = 1;\n```\n\nAfter")).toEqual([
      { kind: "prose", text: "Before", language: null, line: 0 },
      { kind: "code", text: "const a = 1;", language: "ts", line: 2 },
      { kind: "prose", text: "After", language: null, line: 5 },
    ]);
  });

  it("keeps the fence markers out of the code", () => {
    const [block] = splitMarkdownSource("```ts\nx\n```");
    expect(block.text).not.toContain("```");
    expect(block.text).toBe("x");
  });

  it("reports no language when the fence names none", () => {
    expect(splitMarkdownSource("```\nplain\n```")).toEqual([
      { kind: "code", text: "plain", language: null, line: 0 },
    ]);
  });

  it("closes an unterminated fence at the end of the source", () => {
    // Every fence in a message that is still streaming looks like this.
    expect(splitMarkdownSource("```ts\nhalf written")).toEqual([
      { kind: "code", text: "half written", language: "ts", line: 0 },
    ]);
  });

  it("preserves indentation inside a block", () => {
    const [block] = splitMarkdownSource("```ts\nif (a) {\n  b();\n}\n```");
    expect(block.text).toBe("if (a) {\n  b();\n}");
  });

  it("treats a shorter run of backticks inside a block as code", () => {
    const [block] = splitMarkdownSource("````md\n```\nnested\n```\n````");
    expect(block.text).toBe("```\nnested\n```");
    expect(block.language).toBe("md");
  });

  it("handles tildes as fences", () => {
    expect(splitMarkdownSource("~~~py\nx = 1\n~~~")).toEqual([
      { kind: "code", text: "x = 1", language: "py", line: 0 },
    ]);
  });

  it("drops runs that are empty once trimmed", () => {
    expect(splitMarkdownSource("\n\n```ts\na\n```\n\n")).toEqual([
      { kind: "code", text: "a", language: "ts", line: 2 },
    ]);
    expect(splitMarkdownSource("   ")).toEqual([]);
  });

  it("drops a fenced block with nothing between its markers", () => {
    expect(splitMarkdownSource("```\n```")).toEqual([]);
  });

  it("returns prose untouched when there is no fence at all", () => {
    expect(splitMarkdownSource("just **words**")).toEqual([
      { kind: "prose", text: "just **words**", language: null, line: 0 },
    ]);
  });
});
