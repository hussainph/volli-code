import { describe, expect, it } from "vite-plus/test";
import { canonicalJson, CodeModeJournal, determinismPrelude, seedOf } from "./journal";

describe("canonicalJson", () => {
  it("spells the same arguments the same way whatever their key order", () => {
    expect(canonicalJson({ b: 1, a: [true, null, { d: "x", c: undefined }] })).toBe(
      '{"a":[true,null,{"d":"x"}],"b":1}',
    );
    expect(canonicalJson(undefined)).toBe("null");
    expect(canonicalJson("text")).toBe('"text"');
  });
});

describe("CodeModeJournal", () => {
  it("returns the same record for a replay and counts the runs before it", () => {
    const journal = new CodeModeJournal(2);
    const first = journal.open("a", 10);
    expect(first).toMatchObject({ epoch: 10, previousRuns: 0 });
    expect(journal.open("a", 99)).toBe(first);
    expect(first).toMatchObject({ epoch: 10, previousRuns: 1 });
    journal.open("b", 1);
    // "a" was used most recently, so "b" is the one a third run evicts.
    journal.open("a", 1);
    journal.open("c", 1);
    expect(journal.open("a", 5).previousRuns).toBe(3);
    expect(journal.open("b", 5).previousRuns).toBe(0);
  });
});

describe("determinism", () => {
  it("seeds from the outer id and writes one line", () => {
    expect(seedOf("toolu_1")).toBe(seedOf("toolu_1"));
    expect(seedOf("toolu_1")).not.toBe(seedOf("toolu_2"));
    expect(determinismPrelude(7, 1_000)).not.toContain("\n");
  });
});
