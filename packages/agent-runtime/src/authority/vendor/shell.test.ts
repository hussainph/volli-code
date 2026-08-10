import { describe, expect, it } from "vite-plus/test";
import { lexCommandLine, splitProgram } from "./shell";

/** Segments reduced to what a rule reads, so a case is one readable line. */
function shape(command: string) {
  return lexCommandLine(command).map(({ words, writeTargets, readTargets }) => ({
    words,
    writeTargets,
    readTargets,
  }));
}

describe("lexCommandLine", () => {
  it("starts a new segment at every operator that starts a new command", () => {
    expect(shape("a && b || c | d ; e\nf").map((segment) => segment.words)).toEqual([
      ["a"],
      ["b"],
      ["c"],
      ["d"],
      ["e"],
      ["f"],
    ]);
  });

  it("drops empty segments rather than reporting a command with no words", () => {
    expect(shape(";  ; a ;")).toEqual([{ words: ["a"], writeTargets: [], readTargets: [] }]);
    expect(shape("   ")).toEqual([]);
  });

  it("does not split on an operator that is quoted or escaped", () => {
    expect(shape("echo 'a;b'").map((segment) => segment.words)).toEqual([["echo", "a;b"]]);
    expect(shape('echo "a && b"').map((segment) => segment.words)).toEqual([["echo", "a && b"]]);
    expect(shape("echo `a | b`").map((segment) => segment.words)).toEqual([["echo", "a | b"]]);
    expect(shape("echo a\\;b").map((segment) => segment.words)).toEqual([["echo", "a;b"]]);
    expect(shape("echo 'a\\b'").map((segment) => segment.words)).toEqual([["echo", "a\\b"]]);
  });

  it("collapses runs of whitespace and keeps an escaped space inside a word", () => {
    expect(shape("echo   one\\ word").map((segment) => segment.words)).toEqual([
      ["echo", "one word"],
    ]);
  });

  it("pulls output redirects out of the words, attached or spaced", () => {
    expect(shape("printf hi > out.txt")).toEqual([
      { words: ["printf", "hi"], writeTargets: ["out.txt"], readTargets: [] },
    ]);
    expect(shape("printf hi>>out.txt")).toEqual([
      { words: ["printf", "hi"], writeTargets: ["out.txt"], readTargets: [] },
    ]);
    expect(shape("cmd 2> errors.log")).toEqual([
      { words: ["cmd"], writeTargets: ["errors.log"], readTargets: [] },
    ]);
    expect(shape("cmd &> all.log")).toEqual([
      { words: ["cmd", "&"], writeTargets: ["all.log"], readTargets: [] },
    ]);
    expect(shape("cmd >& all.log")).toEqual([
      { words: ["cmd"], writeTargets: ["all.log"], readTargets: [] },
    ]);
  });

  it("keeps an input redirect out of the write targets", () => {
    expect(shape("sort < names.txt")).toEqual([
      { words: ["sort"], writeTargets: [], readTargets: ["names.txt"] },
    ]);
  });

  it("records nothing for a descriptor duplication or a redirect with no target", () => {
    expect(shape("cmd 2>&1")).toEqual([{ words: ["cmd"], writeTargets: [], readTargets: [] }]);
    expect(shape("cmd 0<&3")).toEqual([{ words: ["cmd"], writeTargets: [], readTargets: [] }]);
    expect(shape("cmd >")).toEqual([{ words: ["cmd"], writeTargets: [], readTargets: [] }]);
  });

  it("sees the risky suffix behind a safe prefix", () => {
    expect(shape("echo safe && git config --global http.sslVerify false")).toEqual([
      { words: ["echo", "safe"], writeTargets: [], readTargets: [] },
      {
        words: ["git", "config", "--global", "http.sslVerify", "false"],
        writeTargets: [],
        readTargets: [],
      },
    ]);
  });

  it("keeps the segment's own text for a caller that needs the raw form", () => {
    expect(lexCommandLine("echo one && echo two").map((segment) => segment.text)).toEqual([
      "echo one",
      "echo two",
    ]);
  });
});

describe("splitProgram", () => {
  it("separates leading assignments from the program and its arguments", () => {
    expect(splitProgram(["FOO=1", "BAR=2", "npm", "run", "BAZ=3"])).toEqual({
      env: ["FOO=1", "BAR=2"],
      program: "npm",
      args: ["run", "BAZ=3"],
    });
  });

  it("reports no program for a segment that is only assignments or only redirects", () => {
    expect(splitProgram(["FOO=1"])).toEqual({ env: ["FOO=1"], program: "", args: [] });
    expect(splitProgram([])).toEqual({ env: [], program: "", args: [] });
  });
});
