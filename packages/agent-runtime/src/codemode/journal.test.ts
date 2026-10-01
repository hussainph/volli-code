import { describe, expect, it } from "vite-plus/test";
import {
  canonicalJson,
  CodeModeJournal,
  determinismPrelude,
  remember,
  RUN_JOURNAL_MAX_BYTES,
  runKey,
  seedOf,
} from "./journal";

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

describe("finish, remember and runKey", () => {
  it("forgets a finished run, keys by program, and keeps results within the run's bound", () => {
    const journal = new CodeModeJournal();
    const key = runKey("toolu_1", "return 1;");
    expect(key).not.toBe(runKey("toolu_1", "return 2;"));
    const run = journal.open(key, 1);
    remember(run, 1, { name: "read", argumentsDigest: "d", outcome: { ok: true, value: "x" } });
    remember(run, 2, {
      name: "read",
      argumentsDigest: "d",
      outcome: { ok: true, value: "y".repeat(RUN_JOURNAL_MAX_BYTES) },
    });
    expect(run.calls.get(1)!.outcome).toEqual({ ok: true, value: "x" });
    expect(run.calls.get(2)!.outcome).toBeNull();
    journal.finish(key);
    expect(journal.open(key, 5).previousRuns).toBe(0);
  });
});

describe("determinism", () => {
  it("seeds from the outer id and writes one line", () => {
    expect(seedOf("toolu_1")).toBe(seedOf("toolu_1"));
    expect(seedOf("toolu_1")).not.toBe(seedOf("toolu_2"));
    expect(determinismPrelude(7, 1_000)).not.toContain("\n");
  });
});
