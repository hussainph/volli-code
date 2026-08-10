import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { normalizeToolCall, resolveWorkspaceRoot } from "./normalize";

/** A real workspace whose root is a symlink on macOS, which is the case that matters. */
function workspace(): { raw: string; real: string } {
  const raw = mkdtempSync(join(tmpdir(), "volli-normalize-"));
  writeFileSync(join(raw, "MARKER.txt"), "x");
  return { raw, real: realpathSync(raw) };
}

function bash(command: string, workspacePath: string) {
  const call = normalizeToolCall({ tool: "bash", args: { command }, workspacePath });
  if (call.command === null) throw new Error("expected a lexed command");
  return call.command;
}

describe("resolveWorkspaceRoot", () => {
  it("resolves the root through symlinks so operands compare against the same tree", () => {
    const { raw, real } = workspace();
    expect(resolveWorkspaceRoot(raw)).toBe(real);
  });

  it("refuses a root it cannot resolve rather than comparing against a guess", () => {
    const { raw } = workspace();
    expect(() => resolveWorkspaceRoot(join(raw, "x".repeat(400)))).toThrow(
      "has no resolvable real path",
    );
  });
});

describe("normalizeToolCall", () => {
  it("passes an unmapped tool through under its requested name", () => {
    const { raw } = workspace();
    expect(
      normalizeToolCall({ tool: "glob", args: { pattern: "**" }, workspacePath: raw }),
    ).toEqual({ tool: "glob", reads: [], writes: [], command: null });
  });

  it("classifies read as a read and resolves it against the real workspace root", () => {
    const { raw, real } = workspace();
    expect(
      normalizeToolCall({ tool: "read", args: { path: "MARKER.txt" }, workspacePath: raw }),
    ).toEqual({ tool: "read", reads: [join(real, "MARKER.txt")], writes: [], command: null });
  });

  it("classifies edit and write as writes", () => {
    const { raw, real } = workspace();
    for (const tool of ["edit", "write"]) {
      expect(normalizeToolCall({ tool, args: { path: "MARKER.txt" }, workspacePath: raw })).toEqual(
        {
          tool,
          reads: [],
          writes: [join(real, "MARKER.txt")],
          command: null,
        },
      );
    }
  });

  it("resolves a file a write would create through the parent that does exist", () => {
    const { raw, real } = workspace();
    mkdirSync(join(raw, "src"));
    expect(
      normalizeToolCall({ tool: "write", args: { path: "src/new.ts" }, workspacePath: raw }).writes,
    ).toEqual([join(real, "src/new.ts")]);
  });

  it("keeps an escaping path escaping instead of pinning it inside the workspace", () => {
    const { raw, real } = workspace();
    expect(
      normalizeToolCall({ tool: "read", args: { path: "../SECRET.txt" }, workspacePath: raw })
        .reads,
    ).toEqual([join(real, "../SECRET.txt")]);
  });

  it("refuses arguments that are not the shape the tool's schema promised", () => {
    const { raw } = workspace();
    expect(() =>
      normalizeToolCall({ tool: "read", args: "MARKER.txt", workspacePath: raw }),
    ).toThrow("Pi tool read was called without arguments.");
    expect(() => normalizeToolCall({ tool: "read", args: null, workspacePath: raw })).toThrow(
      "Pi tool read was called without arguments.",
    );
    expect(() => normalizeToolCall({ tool: "read", args: {}, workspacePath: raw })).toThrow(
      "Pi tool read was called without a path argument.",
    );
    expect(() =>
      normalizeToolCall({ tool: "read", args: { path: 7 }, workspacePath: raw }),
    ).toThrow("Pi tool read was called without a path argument.");
    expect(() => normalizeToolCall({ tool: "bash", args: {}, workspacePath: raw })).toThrow(
      "Pi tool bash was called without a command argument.",
    );
  });

  it("refuses a path argument that names no path, and one with no real path", () => {
    const { raw } = workspace();
    expect(() =>
      normalizeToolCall({ tool: "read", args: { path: "  " }, workspacePath: raw }),
    ).toThrow("A tool path argument named no path.");
    expect(() =>
      normalizeToolCall({ tool: "read", args: { path: "x".repeat(400) }, workspacePath: raw }),
    ).toThrow("has no resolvable real path");
  });
});

describe("normalizeToolCall, for execution", () => {
  it("splits a pipeline into segments and keeps the raw line", () => {
    const { raw, real } = workspace();
    const command = bash("printf hi | tee out.txt", raw);
    expect(command.raw).toBe("printf hi | tee out.txt");
    expect(command.segments).toEqual([
      {
        program: "printf",
        args: ["hi"],
        paths: [join(real, "printf"), join(real, "hi")],
        writes: [],
        env: [],
      },
      {
        program: "tee",
        args: ["out.txt"],
        paths: [join(real, "tee"), join(real, "out.txt")],
        writes: [],
        env: [],
      },
    ]);
  });

  it("captures per-command environment prefixes without treating them as operands", () => {
    const { raw, real } = workspace();
    expect(bash("NODE_TLS_REJECT_UNAUTHORIZED=0 curl https://x", raw).segments).toEqual([
      {
        program: "curl",
        args: ["https://x"],
        paths: [join(real, "curl"), join(real, "https:/x")],
        writes: [],
        env: ["NODE_TLS_REJECT_UNAUTHORIZED=0"],
      },
    ]);
  });

  it("resolves redirect targets as writes and input redirects as ordinary paths", () => {
    const { raw, real } = workspace();
    const [segment] = bash("sort < in.txt >> ~/notes.txt", raw).segments;
    expect(segment?.writes).toEqual([join(homedir(), "notes.txt")]);
    expect(segment?.paths).toEqual([join(real, "sort"), join(real, "in.txt")]);
  });

  it("leaves flags out of the paths and reports each resolved path once", () => {
    const { raw, real } = workspace();
    const [segment] = bash("rm -rf --verbose build build", raw).segments;
    expect(segment?.args).toEqual(["-rf", "--verbose", "build", "build"]);
    expect(segment?.paths).toEqual([join(real, "rm"), join(real, "build")]);
  });

  it("resolves an operand that escapes the workspace to where it really points", () => {
    const { raw, real } = workspace();
    const [segment] = bash("cat ../SECRET.txt", raw).segments;
    expect(segment?.paths).toEqual([join(real, "cat"), join(real, "../SECRET.txt")]);
  });

  it("refuses a command line carrying an operand with no real path", () => {
    const { raw } = workspace();
    expect(() => bash(`cat ${"x".repeat(400)}`, raw)).toThrow("has no resolvable real path");
  });

  // What the rule pack reads is exactly what it is handed here, so the three
  // feeds it depends on are pinned rather than left to be rediscovered.
  it("feeds the rules a git subcommand's arguments in order and unabridged", () => {
    const { raw } = workspace();
    const [segment] = bash("git config --local core.hooksPath ../evil", raw).segments;
    expect(segment?.program).toBe("git");
    expect(segment?.args).toEqual(["config", "--local", "core.hooksPath", "../evil"]);
  });

  it("feeds a redirect under .git through as a write, not merely a path", () => {
    const { raw, real } = workspace();
    const [segment] = bash("printf x > .git/config", raw).segments;
    expect(segment?.writes).toEqual([join(real, ".git/config")]);
  });

  it("feeds a bare removal operand through even with no recursive flag", () => {
    const { raw, real } = workspace();
    const [segment] = bash("rm .git/index", raw).segments;
    expect(segment?.paths).toEqual([join(real, "rm"), join(real, ".git/index")]);
  });

  it("reports a segment that is only an assignment without inventing a program", () => {
    const { raw } = workspace();
    expect(bash("FOO=1", raw).segments).toEqual([
      { program: "", args: [], paths: [], writes: [], env: ["FOO=1"] },
    ]);
  });
});
