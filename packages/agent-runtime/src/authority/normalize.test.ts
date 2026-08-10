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

/** `rm -rf ~` behind `depth` layers of `sh -c`, each quoting the one inside it. */
function nest(depth: number): string {
  let script = "rm -rf ~";
  for (let level = 0; level < depth; level += 1) {
    script = `sh -c "${script.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return script;
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

  // An operand no rule reads is dropped; one a rule reads must refuse, because
  // a shorter list reads to the rule as a clean bill of health.
  it.each([
    "rm -rf $TMPDIR",
    "rm -rf ~someone",
    "RM -rf $TMPDIR",
    "git -C $ELSEWHERE status",
    "GIT -C ~someone status",
    "/usr/bin/rm -rf $TMPDIR",
    "echo x > $TARGET",
    "echo x >> ~someone/notes",
    "env rm -rf $TMPDIR",
    "sh -c 'rm -rf $TMPDIR'",
  ])("refuses %j, where a rule would read the operand", (command) => {
    expect(() => bash(command, workspace().raw)).toThrow(
      /another user's home directory|only the shell can read/,
    );
  });

  it.each([
    "echo $PATH",
    "ls $TMPDIR",
    "cat $CONFIG",
    "echo ~someone",
    "node $SCRIPT --flag",
    "sh -c 'echo $FOO && ls $BAR'",
    "cp $SOURCE $DEST",
  ])("drops the unresolvable operand in %j, which no rule reads", (command) => {
    const segments = bash(command, workspace().raw).segments;
    expect(segments.flatMap((segment) => segment.paths)).not.toContain(undefined);
    expect(segments.length).toBeGreaterThan(0);
  });

  it("keeps the resolvable operands of a command that also carries a variable", () => {
    const { raw, real } = workspace();
    const [segment] = bash("cat $CONFIG MARKER.txt", raw).segments;
    expect(segment?.paths).toEqual([join(real, "cat"), join(real, "MARKER.txt")]);
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

  // Every rule dispatches on the program, so one prefix word used to clear all
  // six command rules at once.
  it.each([
    { command: "env rm -rf build", env: [] as string[] },
    { command: "nohup rm -rf build", env: [] },
    { command: "time rm -rf build", env: [] },
    { command: "timeout 5 rm -rf build", env: [] },
    { command: "nice -n 5 rm -rf build", env: [] },
    { command: "nice -n5 rm -rf build", env: [] },
    { command: "env -u SECRET rm -rf build", env: [] },
    { command: "timeout -s KILL 5 rm -rf build", env: [] },
    { command: "stdbuf -o0 rm -rf build", env: [] },
    { command: "/usr/bin/env rm -rf build", env: [] },
    { command: "nohup timeout 30 env FOO=1 rm -rf build", env: ["FOO=1"] },
    { command: "env FOO=1 rm -rf build", env: ["FOO=1"] },
  ])("unwraps $command to the program that will actually run", ({ command, env }) => {
    const [segment] = bash(command, workspace().raw).segments;
    expect(segment?.program).toBe("rm");
    expect(segment?.args).toEqual(["-rf", "build"]);
    expect(segment?.env).toEqual(env);
  });

  // `env GIT_SSL_NO_VERIFY=1 curl …` put the assignment in `args`, where the
  // TLS rule never looks.
  it("lifts an env prefix's assignments into the segment's environment", () => {
    const [segment] = bash(
      "env GIT_SSL_NO_VERIFY=1 NODE_ENV=x curl https://y",
      workspace().raw,
    ).segments;
    expect(segment?.program).toBe("curl");
    expect(segment?.env).toEqual(["GIT_SSL_NO_VERIFY=1", "NODE_ENV=x"]);
  });

  it("splices a shell script's own segments in after the shell that runs it", () => {
    const { raw } = workspace();
    expect(
      bash("sh -c 'rm -rf build && git reset --hard'", raw).segments.map((s) => s.program),
    ).toEqual(["sh", "rm", "git"]);
    // A combined flag cluster spells the same thing.
    expect(bash("bash -lc 'csrutil disable'", raw).segments.map((s) => s.program)).toEqual([
      "bash",
      "csrutil",
    ]);
    // No `-c` means the shell is just a program.
    expect(bash("bash script.sh", raw).segments.map((s) => s.program)).toEqual(["bash"]);
  });

  it("keeps a prefix as the program when nothing follows it to run", () => {
    const { raw } = workspace();
    expect(bash("env FOO=1", raw).segments).toEqual([
      {
        program: "env",
        args: ["FOO=1"],
        paths: [join(realpathSync(raw), "env")],
        writes: [],
        env: ["FOO=1"],
      },
    ]);
  });

  // The nesting depth is the attacker's to choose, so the bound has to refuse
  // rather than fall back to reporting the outer shape, which is `sh` — a
  // program no rule refuses.
  it("refuses nesting deeper than it will follow", () => {
    const { raw } = workspace();
    expect(bash(nest(3), raw).segments.map((s) => s.program)).toEqual(["sh", "sh", "sh", "rm"]);
    expect(() => bash(nest(4), raw)).toThrow("nests shells deeper than policy will follow");
    expect(() => bash(`${"env ".repeat(5)}rm -rf ~`, raw)).toThrow(
      '"env" wraps commands deeper than policy will follow',
    );
    expect(() => bash("sh -c", raw)).toThrow("names no script to run");
  });

  it("reports a segment that is only an assignment without inventing a program", () => {
    const { raw } = workspace();
    expect(bash("FOO=1", raw).segments).toEqual([
      { program: "", args: [], paths: [], writes: [], env: ["FOO=1"] },
    ]);
  });
});
