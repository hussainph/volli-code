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

  it("records nothing for a descriptor duplication, which opens no file", () => {
    expect(shape("cmd 2>&1")).toEqual([{ words: ["cmd"], writeTargets: [], readTargets: [] }]);
    expect(shape("cmd 0<&3")).toEqual([{ words: ["cmd"], writeTargets: [], readTargets: [] }]);
  });

  // Previously reported as "writes nothing", which is the answer that gets a
  // command allowed. A target the lexer cannot see is a refusal, not an absence.
  it("refuses a redirect whose target it cannot see", () => {
    expect(() => shape("cmd >")).toThrow('Redirect ">" in "cmd >" names no target.');
    expect(() => shape("cmd 2>>")).toThrow("names no target");
  });

  it("keeps >| whole instead of splitting it into a redirect and a pipe", () => {
    expect(shape("echo pwned >| ~/.zshrc")).toEqual([
      { words: ["echo", "pwned"], writeTargets: ["~/.zshrc"], readTargets: [] },
    ]);
    expect(shape("cmd 2>| errors.log")).toEqual([
      { words: ["cmd"], writeTargets: ["errors.log"], readTargets: [] },
    ]);
    // A real pipe after a redirect target still separates two commands.
    expect(shape("cmd > out.txt | wc").map((segment) => segment.words)).toEqual([["cmd"], ["wc"]]);
  });

  // `true & rm -rf ~` used to lex as one command whose program was `true`.
  it("treats a single & as a separator without breaking && or the & redirects", () => {
    expect(shape("true & rm -rf ~").map((segment) => segment.words)).toEqual([
      ["true"],
      ["rm", "-rf", "~"],
    ]);
    expect(shape("a & b & c").map((segment) => segment.words)).toEqual([["a"], ["b"], ["c"]]);
    expect(shape("a && b").map((segment) => segment.words)).toEqual([["a"], ["b"]]);
  });

  // Every grouping spelling used to become the program, and miss every rule.
  it("strips grouping punctuation so the real program surfaces", () => {
    for (const command of ["( rm -rf ~ )", "(rm -rf ~)", "{ rm -rf ~; }", "{rm -rf ~;}"]) {
      const [first] = shape(command);
      expect(first?.words.slice(0, 3), command).toEqual(["rm", "-rf", "~"]);
    }
  });

  // Splitting on `;` leaves the next segment beginning with a keyword, and a
  // segment whose program reads as `then` misses every program rule.
  it.each([
    ["if true; then rm -rf ~; fi", 1],
    ["for f in x; do rm -rf ~; done", 1],
    ["while true; do rm -rf ~; done", 1],
    ["until false; do rm -rf ~; done", 1],
    ["case x in y) rm -rf ~;; esac", 1],
    ["if true; then if true; then rm -rf ~; fi; fi", 2],
    ["! rm -rf ~", 0],
  ])("strips the leading keywords of %j", (command, index) => {
    expect(shape(command)[index]?.words.slice(0, 3)).toEqual(["rm", "-rf", "~"]);
  });

  it("strips only a leading run, so a keyword used as an argument survives", () => {
    expect(shape("echo then").map((segment) => segment.words)).toEqual([["echo", "then"]]);
    expect(shape("grep -w in file").map((segment) => segment.words)).toEqual([
      ["grep", "-w", "in", "file"],
    ]);
    expect(shape("IF true").map((segment) => segment.words)).toEqual([["true"]]);
  });

  it("leaves a token's own balanced braces and parens alone", () => {
    expect(shape("echo ${HOME}/x").map((segment) => segment.words)).toEqual([
      ["echo", "${HOME}/x"],
    ]);
    expect(shape("awk '{print $1}' f").map((segment) => segment.words)).toEqual([
      ["awk", "{print $1}", "f"],
    ]);
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
