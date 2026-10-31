import { describe, expect, it } from "vite-plus/test";

import { parseRunnerArgv, usage, UsageError } from "./args";
import { COMMANDS } from "./commands";

const parse = (...argv: string[]) => parseRunnerArgv(argv, COMMANDS);

function usageError(argv: string[]): string {
  try {
    parse(...argv);
  } catch (error) {
    expect(error).toBeInstanceOf(UsageError);
    return (error as Error).message;
  }
  throw new Error("expected a usage error");
}

describe("volli-runner's command line", () => {
  it("asks for help with nothing, --help, -h or help", () => {
    for (const argv of [[], ["--help"], ["-h"], ["help"]]) {
      expect(parse(...argv)).toEqual({ kind: "help", command: null });
    }
  });

  it("asks for one command's help", () => {
    expect(parse("help", "link")).toMatchObject({ kind: "help", command: { name: "link" } });
    expect(parse("status", "--data-dir", "/d", "-h")).toMatchObject({
      kind: "help",
      command: { name: "status" },
    });
  });

  it("routes --version and -v to the version command", () => {
    for (const flag of ["--version", "-v"]) {
      expect(parse(flag)).toMatchObject({
        kind: "command",
        command: { name: "version" },
        input: { values: {}, positionals: [] },
      });
    }
  });

  it("parses a command's options strictly", () => {
    expect(
      parse("link", "--token", "vrt_1", "--name", "box", "--server", "https://a.convex.cloud"),
    ).toMatchObject({
      kind: "command",
      command: { name: "link" },
      input: {
        values: { token: "vrt_1", name: "box", server: "https://a.convex.cloud" },
        positionals: [],
      },
    });
    expect(usageError(["link", "--tokn", "x"])).toContain("--tokn");
    expect(usageError(["status", "extra"])).toBe(
      "status takes no positional arguments; got extra.",
    );
  });

  it("hands a stub whatever it was given", () => {
    expect(parse("install", "--system", "--from", "/tmp/r")).toMatchObject({
      kind: "command",
      command: { name: "install", stub: true },
      input: { values: {}, positionals: ["--system", "--from", "/tmp/r"] },
    });
  });

  it("refuses an unknown command and help for one", () => {
    expect(usageError(["serve"])).toBe('Unknown command "serve".');
    expect(usageError(["help", "serve"])).toBe('Unknown command "serve".');
    expect(usageError(["help", "link", "status"])).toBe("help takes at most one command.");
  });

  it("counts positionals for a command that takes them", () => {
    const one = { ...COMMANDS[0]!, name: "one", stub: undefined, options: {}, positionals: 1 };
    const many = { ...one, name: "two", positionals: 2 };
    expect(parseRunnerArgv(["one", "a"], [one])).toMatchObject({ input: { positionals: ["a"] } });
    expect(() => parseRunnerArgv(["one", "a", "b"], [one])).toThrow(
      "one takes at most 1 positional argument; got a b.",
    );
    expect(() => parseRunnerArgv(["two", "a", "b", "c"], [many])).toThrow(
      "two takes at most 2 positional arguments; got a b c.",
    );
  });
});

describe("the usage", () => {
  it("lists every command of the install surface, in order", () => {
    const text = usage(COMMANDS, null);
    expect(text.startsWith("Usage: volli-runner <command> [options]\n\nCommands:\n")).toBe(true);
    const names = text
      .split("\n")
      .filter((line) => line.startsWith("  "))
      .map((line) => line.trim().split(/\s+/)[0]);
    expect(names).toEqual([
      "install",
      "uninstall",
      "link",
      "unlink",
      "run",
      "status",
      "doctor",
      "login",
      "logout",
      "update",
      "logs",
      "git-credential",
      "version",
    ]);
  });

  it("shows one command's usage line and summary", () => {
    const status = COMMANDS.find((command) => command.name === "status")!;
    expect(usage(COMMANDS, status)).toBe(
      "Usage: volli-runner status [--data-dir <dir>] [--config-dir <dir>]\n\n" +
        `${status.summary}\n`,
    );
    const version = COMMANDS.find((command) => command.name === "version")!;
    expect(usage(COMMANDS, version)).toBe(`Usage: volli-runner version\n\n${version.summary}\n`);
  });
});
