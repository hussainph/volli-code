import { describe, expect, it } from "vite-plus/test";

import { COLUMN_VOCABULARY } from "@volli/shared";

import { COMMAND_HELP, HARNESS_VOCABULARY, parseCliArgs, PRIORITY_VOCABULARY } from "./parser";

describe("parseCliArgs", () => {
  it("parses ticket creation into a socket command without losing repeated labels", () => {
    expect(
      parseCliArgs([
        "ticket",
        "create",
        "--title",
        "Fix auth",
        "--status",
        "review",
        "--label",
        "bug",
        "--label",
        "security",
        "--project",
        "/work/volli",
        "--no-worktree",
        "--json",
      ]),
    ).toEqual({
      ok: true,
      invocation: {
        command: "ticket.create",
        args: {
          title: "Fix auth",
          status: "needs_review",
          labels: ["bug", "security"],
          project: "/work/volli",
          usesWorktree: false,
        },
        json: true,
      },
    });
  });

  it("parses edit-shaped ticket updates as one exact-match mutation", () => {
    expect(
      parseCliArgs([
        "ticket",
        "update",
        "VC-12",
        "--edit",
        "old text",
        "new text",
        "--priority",
        "high",
        "--add-label",
        "security",
        "--remove-label",
        "triage",
        "--harness",
        "codex",
        "--base",
        "main",
      ]),
    ).toEqual({
      ok: true,
      invocation: {
        command: "ticket.update",
        args: {
          id: "VC-12",
          bodyMutation: { mode: "edit", oldText: "old text", newText: "new text" },
          priority: "high",
          addLabels: ["security"],
          removeLabels: ["triage"],
          harness: "codex",
          base: "main",
        },
        json: false,
      },
    });
  });

  it("parses a filtered ticket list for token-efficient reads", () => {
    expect(
      parseCliArgs([
        "ticket",
        "list",
        "--status",
        "needs-review",
        "--label",
        "bug",
        "--priority",
        "low",
        "--project",
        "VC",
        "--limit",
        "25",
        "--json",
      ]),
    ).toEqual({
      ok: true,
      invocation: {
        command: "ticket.list",
        args: {
          status: "needs_review",
          label: "bug",
          priority: "low",
          project: "VC",
          limit: 25,
        },
        json: true,
      },
    });
  });

  it("parses a deliberate ticket move with public column vocabulary", () => {
    expect(parseCliArgs(["ticket", "move", "VC-12", "--to", "review"])).toEqual({
      ok: true,
      invocation: {
        command: "ticket.move",
        args: { id: "VC-12", to: "needs_review" },
        json: false,
      },
    });
  });

  it("routes context, ticket-detail, and session-observation reads", () => {
    expect(parseCliArgs(["identify", "--json"])).toEqual({
      ok: true,
      invocation: { command: "identify", args: {}, json: true },
    });
    expect(parseCliArgs(["ticket", "show", "VC-12", "--events", "8", "--comments", "3"])).toEqual({
      ok: true,
      invocation: {
        command: "ticket.show",
        args: { id: "VC-12", events: 8, comments: 3 },
        json: false,
      },
    });
    expect(parseCliArgs(["session", "peek", "a1b2c3", "--lines", "80"])).toEqual({
      ok: true,
      invocation: {
        command: "session.peek",
        args: { id: "a1b2c3", lines: 80 },
        json: false,
      },
    });
  });

  it("routes comments, archive, lifecycle signals, and notifications", () => {
    expect(parseCliArgs(["ticket", "comment", "VC-12", "-m", "Ready for review"])).toEqual({
      ok: true,
      invocation: {
        command: "ticket.comment",
        args: { id: "VC-12", message: "Ready for review" },
        json: false,
      },
    });
    expect(parseCliArgs(["ticket", "archive", "VC-12", "--json"])).toEqual({
      ok: true,
      invocation: { command: "ticket.archive", args: { id: "VC-12" }, json: true },
    });
    expect(parseCliArgs(["session", "blocked", "--reason", "Needs permission"])).toEqual({
      ok: true,
      invocation: {
        command: "session.blocked",
        args: { reason: "Needs permission" },
        json: false,
      },
    });
    expect(parseCliArgs(["notify", "-m", "Build done", "--title", "VC-12"])).toEqual({
      ok: true,
      invocation: {
        command: "notify",
        args: { message: "Build done", title: "VC-12" },
        json: false,
      },
    });
    expect(parseCliArgs(["session", "link", "harness-uuid-123", "--json"])).toEqual({
      ok: true,
      invocation: {
        command: "session.link",
        args: { id: "harness-uuid-123" },
        json: true,
      },
    });
  });

  it("requires the harness session id positional for session link", () => {
    expect(parseCliArgs(["session", "link"])).toEqual({
      ok: false,
      code: "USAGE",
      message: "session link requires <id>",
    });
  });

  it("routes the remaining published read, help, and explicit launch commands", () => {
    expect(parseCliArgs(["board", "--project", "/work/volli"])).toEqual({
      ok: true,
      invocation: { command: "board", args: { project: "/work/volli" }, json: false },
    });
    // A bare "-" and negative numbers are valid values, not flags — only a
    // "--"-prefixed token is treated as the next option.
    expect(parseCliArgs(["board", "--project", "-"])).toEqual({
      ok: true,
      invocation: { command: "board", args: { project: "-" }, json: false },
    });
    expect(parseCliArgs(["ticket", "events", "VC-12", "--limit", "20"])).toEqual({
      ok: true,
      invocation: { command: "ticket.events", args: { id: "VC-12", limit: 20 }, json: false },
    });
    expect(parseCliArgs(["ticket", "brief", "VC-12", "--json"])).toEqual({
      ok: true,
      invocation: { command: "ticket.brief", args: { id: "VC-12" }, json: true },
    });
    expect(parseCliArgs(["project", "list"])).toEqual({
      ok: true,
      invocation: { command: "project.list", args: {}, json: false },
    });
    expect(parseCliArgs(["label", "list", "--project", "VC"])).toEqual({
      ok: true,
      invocation: { command: "label.list", args: { project: "VC" }, json: false },
    });
    expect(parseCliArgs(["session", "list", "--project", "VC", "--ticket", "VC-12"])).toEqual({
      ok: true,
      invocation: {
        command: "session.list",
        args: { project: "VC", ticket: "VC-12" },
        json: false,
      },
    });
    expect(parseCliArgs(["app", "launch", "--timeout", "12"])).toEqual({
      ok: true,
      invocation: { command: "app.launch", args: { timeout: 12 }, json: false },
    });
    expect(parseCliArgs(["help", "exit-codes"])).toEqual({
      ok: true,
      invocation: { command: "help", args: { path: ["exit-codes"] }, json: false },
    });
  });

  it("keeps file-backed body and execution configuration flags intact", () => {
    expect(
      parseCliArgs([
        "ticket",
        "create",
        "--title",
        "Ship CLI",
        "--body-file",
        "/tmp/spec.md",
        "--priority",
        "high",
        "--harness",
        "opencode",
        "--base",
        "release",
      ]),
    ).toEqual({
      ok: true,
      invocation: {
        command: "ticket.create",
        args: {
          title: "Ship CLI",
          bodyFile: "/tmp/spec.md",
          priority: "high",
          harness: "opencode",
          base: "release",
        },
        json: false,
      },
    });
    expect(parseCliArgs(["ticket", "update", "VC-12", "--append", "## Result"])).toEqual({
      ok: true,
      invocation: {
        command: "ticket.update",
        args: {
          id: "VC-12",
          bodyMutation: { mode: "append", text: "## Result" },
          addLabels: [],
          removeLabels: [],
        },
        json: false,
      },
    });
  });

  it("rejects competing body mutations instead of silently choosing the last one", () => {
    expect(
      parseCliArgs(["ticket", "update", "VC-12", "--append", "first", "--edit", "old", "new"]),
    ).toEqual({
      ok: false,
      code: "USAGE",
      message: "ticket update accepts exactly one body mutation mode",
    });
  });

  it.each([
    [["board", "--project"], "--project requires a value"],
    [["app", "launch", "--timeout", "0"], "--timeout requires a positive integer"],
    [["ticket", "archive"], "ticket archive requires <id>"],
    [["ticket", "show"], "ticket show requires <id>"],
    [["ticket", "show", "VC-1", "--events"], "--events requires a value"],
    [["ticket", "show", "VC-1", "--events", "0"], "--events requires a positive integer"],
    [["ticket", "move"], "ticket move requires <id>"],
    [["ticket", "move", "VC-1"], "ticket move requires --to"],
    [["ticket", "comment"], "ticket comment requires <id>"],
    [["ticket", "comment", "VC-1"], "ticket comment requires exactly one of -m or --file"],
    [["ticket", "comment", "VC-1", "-m"], "-m requires a value"],
    [
      ["ticket", "comment", "VC-1", "-m", "x", "--file", "/x"],
      "ticket comment requires exactly one of -m or --file",
    ],
    [["session", "done", "--reason"], "--reason requires a value"],
    [["notify"], "notify requires -m"],
    [["notify", "--title"], "--title requires a value"],
    // A following flag must never be silently consumed as this flag's value.
    [["board", "--project", "--json"], "--project requires a value"],
    [["ticket", "show", "VC-1", "--events", "--comments", "3"], "--events requires a value"],
    [["ticket", "comment", "VC-1", "-m", "--file"], "-m requires a value"],
    [["notify", "-m", "--title", "x"], "-m requires a value"],
    [["session", "done", "--reason", "--json"], "--reason requires a value"],
    [["ticket", "move", "VC-1", "--to", "--json"], "--to requires a value"],
    [
      ["ticket", "update", "VC-1", "--edit", "old", "--priority"],
      "--edit requires <old> and <new>",
    ],
    [["ticket", "update", "VC-1", "--edit", "--body", "new"], "--edit requires <old> and <new>"],
  ] as const)("rejects invalid argv %#", (argv, message) => {
    expect(parseCliArgs(argv)).toEqual({ ok: false, code: "USAGE", message });
  });

  it.each([
    [["ticket", "create"], "ticket create requires --title"],
    [["ticket", "create", "--title"], "--title requires a value"],
    [
      ["ticket", "create", "--title", "x", "--body", "a", "--body-file", "/b"],
      "ticket create accepts only one of --body or --body-file",
    ],
    [["ticket", "list", "--status"], "--status requires a value"],
    [["ticket", "list", "--limit", "0"], "--limit requires a positive integer"],
    // A negative number is a valid value, not a flag — it reaches the positive-
    // integer check and fails there, rather than being rejected as a swallowed flag.
    [["ticket", "list", "--limit", "-5"], "--limit requires a positive integer"],
    [["ticket", "update"], "ticket update requires <id>"],
    [["ticket", "update", "VC-1", "--edit", "old"], "--edit requires <old> and <new>"],
    [["ticket", "update", "VC-1", "--title"], "--title requires a value"],
  ] as const)("rejects invalid ticket argv %#", (argv, message) => {
    expect(parseCliArgs(argv)).toEqual({ ok: false, code: "USAGE", message });
  });

  it.each([
    ["ticket move --to", ["ticket", "move", "VC-1", "--to", "icebox"]],
    ["ticket create --status", ["ticket", "create", "--title", "x", "--status", "icebox"]],
    ["ticket list --status", ["ticket", "list", "--status", "icebox"]],
  ] as const)("enumerates the column vocabulary when %s rejects a token", (_label, argv) => {
    const result = parseCliArgs(argv);
    expect(result).toEqual({
      ok: false,
      code: "USAGE",
      message: `Unknown column "icebox" (valid: ${COLUMN_VOCABULARY})`,
    });
  });

  it.each([
    ["ticket create --priority", ["ticket", "create", "--title", "x", "--priority", "urgent"]],
    ["ticket list --priority", ["ticket", "list", "--priority", "urgent"]],
    ["ticket update --priority", ["ticket", "update", "VC-1", "--priority", "urgent"]],
  ] as const)("enumerates the priority vocabulary when %s rejects a token", (_label, argv) => {
    const result = parseCliArgs(argv);
    expect(result).toEqual({
      ok: false,
      code: "USAGE",
      message: `Unknown priority "urgent" (valid: ${PRIORITY_VOCABULARY})`,
    });
  });

  it.each([
    ["ticket create --harness", ["ticket", "create", "--title", "x", "--harness", "cursor"]],
    ["ticket update --harness", ["ticket", "update", "VC-1", "--harness", "cursor"]],
  ] as const)("enumerates the harness vocabulary when %s rejects a token", (_label, argv) => {
    const result = parseCliArgs(argv);
    expect(result).toEqual({
      ok: false,
      code: "USAGE",
      message: `Unknown harness "cursor" (valid: ${HARNESS_VOCABULARY})`,
    });
  });

  it.each([
    [["identify", "--bad"], "identify", "--project"],
    [["board", "--bad", "x"], "board", "--project"],
    // ticket archive has no options, so no "(options: …)" list is appended.
    [["ticket", "archive", "VC-1", "--bad"], "ticket archive", "--bad"],
    [["ticket", "show", "VC-1", "--bad", "1"], "ticket show", "--events"],
    [["ticket", "move", "VC-1", "--to", "doing", "--bad"], "ticket move", "--to"],
    [["ticket", "comment", "VC-1", "--bad", "x"], "ticket comment", "-m"],
    [["session", "done", "--bad", "x"], "session done", "--reason"],
    [["notify", "--bad", "x"], "notify", "--title"],
    [["ticket", "create", "--title", "x", "--bad", "y"], "ticket create", "--label"],
    [["ticket", "list", "--bad", "x"], "ticket list", "--limit"],
    [["ticket", "update", "VC-1", "--bad", "x"], "ticket update", "--append"],
  ] as const)(
    "names the command's options and a help pointer for an unknown option (%#)",
    (argv, cliName, mustContain) => {
      const result = parseCliArgs(argv);
      if (result.ok) throw new Error("expected a usage error");
      expect(result.code).toBe("USAGE");
      expect(result.message.startsWith("Unknown option --bad")).toBe(true);
      expect(result.message).toContain(mustContain);
      expect(result.message).toContain(`— see volli help ${cliName}`);
    },
  );

  it("lists the whole command vocabulary when no command matches", () => {
    const result = parseCliArgs(["frobnicate"]);
    if (result.ok) throw new Error("expected a usage error");
    expect(result.code).toBe("USAGE");
    expect(result.message.startsWith("Expected a Volli command (commands:")).toBe(true);
    for (const name of COMMAND_HELP.map((entry) => entry.name)) {
      expect(result.message).toContain(name);
    }
  });

  it("adds --project to identify and routes help paths and --help/-h to help", () => {
    expect(parseCliArgs(["identify", "--project", "VC"])).toEqual({
      ok: true,
      invocation: { command: "identify", args: { project: "VC" }, json: false },
    });
    expect(parseCliArgs(["help", "ticket", "create"])).toEqual({
      ok: true,
      invocation: { command: "help", args: { path: ["ticket", "create"] }, json: false },
    });
    expect(parseCliArgs(["help", "ticket", "create", "--json"])).toEqual({
      ok: true,
      invocation: { command: "help", args: { path: ["ticket", "create"] }, json: true },
    });
    expect(parseCliArgs(["ticket", "create", "VC-1", "--help"])).toEqual({
      ok: true,
      invocation: { command: "help", args: { path: ["ticket", "create", "VC-1"] }, json: false },
    });
    expect(parseCliArgs(["ticket", "-h"])).toEqual({
      ok: true,
      invocation: { command: "help", args: { path: ["ticket"] }, json: false },
    });
    expect(parseCliArgs(["--help"])).toEqual({
      ok: true,
      invocation: { command: "help", args: { path: [] }, json: false },
    });
  });

  it("accepts alternate message flags, JSON-only commands, and every update body mode", () => {
    expect(parseCliArgs(["ticket", "comment", "VC-1", "--file", "/tmp/c", "--json"])).toMatchObject(
      { ok: true, invocation: { args: { file: "/tmp/c" }, json: true } },
    );
    expect(parseCliArgs(["session", "done", "--json"])).toMatchObject({
      ok: true,
      invocation: { command: "session.done", json: true },
    });
    expect(parseCliArgs(["notify", "--message", "done", "--json"])).toMatchObject({
      ok: true,
      invocation: { args: { message: "done" }, json: true },
    });
    expect(parseCliArgs(["project", "list", "--json"])).toMatchObject({
      ok: true,
      invocation: { json: true },
    });
    expect(parseCliArgs(["ticket", "events", "VC-1", "--json"])).toMatchObject({
      ok: true,
      invocation: { json: true },
    });
    expect(parseCliArgs(["help"])).toMatchObject({
      ok: true,
      invocation: { args: { path: [] }, json: false },
    });
    for (const args of [
      ["--body", "body"],
      ["--body-file", "/body"],
      ["--title", "new"],
      ["--json"],
    ]) {
      expect(parseCliArgs(["ticket", "update", "VC-1", ...args])).toMatchObject({ ok: true });
    }
  });

  it("parses worktree status/diff with an optional id override and diff's working-tree flag", () => {
    // The id is optional (defaults to the cwd's worktree); omitting it is valid.
    expect(parseCliArgs(["worktree", "status"])).toEqual({
      ok: true,
      invocation: { command: "worktree.status", args: {}, json: false },
    });
    // An explicit display id overrides the cwd rung.
    expect(parseCliArgs(["worktree", "status", "VC-12", "--json"])).toEqual({
      ok: true,
      invocation: { command: "worktree.status", args: { id: "VC-12" }, json: true },
    });
    // diff defaults to the merge-base (PR) range; no id, no flag → empty args.
    expect(parseCliArgs(["worktree", "diff"])).toEqual({
      ok: true,
      invocation: { command: "worktree.diff", args: {}, json: false },
    });
    // --working-tree switches modes and coexists with an explicit id.
    expect(parseCliArgs(["worktree", "diff", "VC-12", "--working-tree"])).toEqual({
      ok: true,
      invocation: {
        command: "worktree.diff",
        args: { id: "VC-12", workingTree: true },
        json: false,
      },
    });
    // A leading flag is never swallowed as the optional id.
    expect(parseCliArgs(["worktree", "diff", "--working-tree"])).toEqual({
      ok: true,
      invocation: { command: "worktree.diff", args: { workingTree: true }, json: false },
    });
  });
});
