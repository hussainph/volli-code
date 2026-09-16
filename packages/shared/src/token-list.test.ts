import { describe, expect, it } from "vite-plus/test";

import { uniqueTokenList } from "./token-list";

describe("uniqueTokenList", () => {
  it("accepts spaces, commas, and the mixture a model actually writes", () => {
    // The three spellings mean one thing. A parser that took only one of them
    // would refuse input that is plainly correct.
    expect(uniqueTokenList("VC-12 VC-14")).toEqual(["VC-12", "VC-14"]);
    expect(uniqueTokenList("VC-12,VC-14")).toEqual(["VC-12", "VC-14"]);
    expect(uniqueTokenList("VC-12, VC-14")).toEqual(["VC-12", "VC-14"]);
  });

  it("counts a repeat once, because every caller means a set", () => {
    expect(uniqueTokenList("read_file read_file write_file")).toEqual(["read_file", "write_file"]);
  });

  it("reads an empty or blank field as no tokens rather than one blank token", () => {
    // `mcp_tools` passes an empty string to mean "turn everything off", so a
    // single empty token here would become a tool name nothing can match.
    expect(uniqueTokenList("")).toEqual([]);
    expect(uniqueTokenList("   ")).toEqual([]);
    expect(uniqueTokenList(" ,, ")).toEqual([]);
  });

  it("keeps surrounding separators from inventing tokens", () => {
    expect(uniqueTokenList("  a ,  b ,")).toEqual(["a", "b"]);
  });
});
