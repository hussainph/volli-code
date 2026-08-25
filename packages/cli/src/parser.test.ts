import { describe, expect, it } from "vite-plus/test";

import {
  cliVerbName,
  COLUMN_VOCABULARY,
  HARNESS_VOCABULARY,
  REASONING_LEVELS,
  REFERENCE_VERBS,
  VERB_REGISTRY,
  verbEntry,
} from "@volli/shared";
import type { VerbEntry } from "@volli/shared";

import { CLI_MECHANICS, parseCliArgs, PRIORITY_VOCABULARY } from "./parser";

/** The commands `volli help` publishes, as a caller types them. */
const PUBLISHED_COMMANDS = REFERENCE_VERBS.map((entry) => cliVerbName(entry.key));

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

  it("types zero-count and compact comments polling on ticket show", () => {
    // VC-85: `0` suppresses a history query. The named projection also carries
    // a marker so main can omit the static ticket body from every poll.
    expect(parseCliArgs(["ticket", "show", "VC-12", "--events", "0"])).toEqual({
      ok: true,
      invocation: { command: "ticket.show", args: { id: "VC-12", events: 0 }, json: false },
    });
    expect(parseCliArgs(["ticket", "show", "VC-12", "--comments", "0"])).toEqual({
      ok: true,
      invocation: { command: "ticket.show", args: { id: "VC-12", comments: 0 }, json: false },
    });
    expect(parseCliArgs(["ticket", "show", "VC-12", "--comments-only"])).toEqual({
      ok: true,
      invocation: {
        command: "ticket.show",
        args: { id: "VC-12", commentsOnly: true, events: 0 },
        json: false,
      },
    });
    // An explicit event count asks for the ordinary full-ticket projection.
    expect(parseCliArgs(["ticket", "show", "VC-12", "--comments-only", "--events", "3"])).toEqual({
      ok: true,
      invocation: { command: "ticket.show", args: { id: "VC-12", events: 3 }, json: false },
    });
  });

  it("types a verdict, and refuses a word outside either vocabulary", () => {
    expect(
      parseCliArgs([
        "ticket",
        "signal",
        "VC-12",
        "--kind",
        "review",
        "--verdict",
        "pass",
        "--detail",
        "Two nits, fixed",
      ]),
    ).toEqual({
      ok: true,
      invocation: {
        command: "ticket.signal",
        args: { id: "VC-12", kind: "review", verdict: "pass", detail: "Two nits, fixed" },
        json: false,
      },
    });
    // Detail is optional; the two halves of the verdict are not.
    expect(
      parseCliArgs(["ticket", "signal", "VC-12", "--kind", "budget", "--verdict", "blocked"]),
    ).toEqual({
      ok: true,
      invocation: {
        command: "ticket.signal",
        args: { id: "VC-12", kind: "budget", verdict: "blocked" },
        json: false,
      },
    });
    // A fixed vocabulary is only cheap to live with if being wrong teaches you
    // the right words — and this process holds the same list main checks.
    expect(
      parseCliArgs(["ticket", "signal", "VC-12", "--kind", "vibes", "--verdict", "pass"]),
    ).toEqual({
      ok: false,
      code: "USAGE",
      message:
        'Unknown signal kind "vibes" (valid: validate, implement, review, merge, human-gate, budget)',
    });
    expect(
      parseCliArgs(["ticket", "signal", "VC-12", "--kind", "review", "--verdict", "probably"]),
    ).toEqual({
      ok: false,
      code: "USAGE",
      message: 'Unknown verdict "probably" (valid: pass, fail, blocked)',
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

  it("parses session start with kickoff, model, and reasoning overrides", () => {
    expect(parseCliArgs(["session", "start", "VC-4"])).toEqual({
      ok: true,
      invocation: { command: "session.start", args: { id: "VC-4" }, json: false },
    });
    expect(
      parseCliArgs([
        "session",
        "start",
        "VC-4",
        "-m",
        "Focus on the failing tests",
        "--title",
        "Validate VC-4",
        "--model",
        "openai-codex/gpt-5.2-sol",
        "--reasoning",
        "high",
        "--json",
      ]),
    ).toEqual({
      ok: true,
      invocation: {
        command: "session.start",
        args: {
          id: "VC-4",
          message: "Focus on the failing tests",
          title: "Validate VC-4",
          model: { providerId: "openai-codex", modelId: "gpt-5.2-sol" },
          reasoning: "high",
        },
        json: true,
      },
    });
    // --message stays the hidden alias every other message flag has.
    expect(parseCliArgs(["session", "start", "VC-4", "--message", "go"])).toMatchObject({
      ok: true,
      invocation: { args: { id: "VC-4", message: "go" } },
    });
    expect(parseCliArgs(["session", "start", "VC-4", "--title", "Validate VC-4"])).toMatchObject({
      ok: true,
      invocation: { args: { id: "VC-4", title: "Validate VC-4" } },
    });
  });

  it("splits --model on the FIRST slash so a model id may itself contain one", () => {
    expect(
      parseCliArgs(["session", "start", "VC-4", "--model", "gateway/vendor/model-x"]),
    ).toMatchObject({
      ok: true,
      invocation: { args: { model: { providerId: "gateway", modelId: "vendor/model-x" } } },
    });
  });

  it.each(["gpt-5", "/gpt-5", "openai/", "/"])(
    "rejects the malformed --model %j and teaches the shape",
    (raw) => {
      expect(parseCliArgs(["session", "start", "VC-4", "--model", raw])).toEqual({
        ok: false,
        code: "USAGE",
        message: `Invalid model ${JSON.stringify(raw)} (expected <provider>/<model>)`,
      });
    },
  );

  it("rejects an unknown --reasoning level and enumerates the vocabulary", () => {
    expect(parseCliArgs(["session", "start", "VC-4", "--reasoning", "ultra"])).toEqual({
      ok: false,
      code: "USAGE",
      message: `Unknown reasoning level "ultra" (valid: ${REASONING_LEVELS.join(", ")})`,
    });
  });

  it("requires the ticket id positional for session start", () => {
    expect(parseCliArgs(["session", "start"])).toEqual({
      ok: false,
      code: "USAGE",
      message: "session start requires <id>",
    });
  });

  it("requires the harness session id positional for session link", () => {
    expect(parseCliArgs(["session", "link"])).toEqual({
      ok: false,
      code: "USAGE",
      message: "session link requires <id>",
    });
  });

  // Fired by a generated wrapper, never typed — but it still walks the parser,
  // so the one positional has to arrive under the same key everything else uses.
  it("routes the wrapper's harness announce, and requires the slug", () => {
    expect(parseCliArgs(["session", "harness", "opencode"])).toEqual({
      ok: true,
      invocation: { command: "session.harness", args: { id: "opencode" }, json: false },
    });
    expect(parseCliArgs(["session", "harness"])).toEqual({
      ok: false,
      code: "USAGE",
      message: "session harness requires <id>",
    });
  });

  // The wrapper asks for an id only when the harness it is about to exec takes
  // one on argv; without the flag this is an announce and nothing is minted.
  it("carries the wrapper's request for a freshly minted session id", () => {
    expect(parseCliArgs(["session", "harness", "cursor", "--mint"])).toEqual({
      ok: true,
      invocation: { command: "session.harness", args: { id: "cursor", mint: true }, json: false },
    });
  });

  // The reference is what an agent can usefully DO. A verb whose only correct
  // caller is a file Volli generated is noise in it — the same call `hook` made.
  it("keeps the involuntary verbs out of the published command list", () => {
    expect(PUBLISHED_COMMANDS).not.toContain("session harness");
    expect(PUBLISHED_COMMANDS).not.toContain("hook");
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
    expect(parseCliArgs(["model", "list"])).toEqual({
      ok: true,
      invocation: { command: "model.list", args: {}, json: false },
    });
    expect(parseCliArgs(["model", "list", "--all", "--json"])).toEqual({
      ok: true,
      invocation: { command: "model.list", args: { all: true }, json: true },
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
    // 0 is accepted (VC-85); what a count still refuses is a negative or a
    // fraction, either of which would slice from the wrong end or not at all.
    [["ticket", "show", "VC-1", "--events", "-1"], "--events requires a whole number, 0 or more"],
    [
      ["ticket", "show", "VC-1", "--comments", "1.5"],
      "--comments requires a whole number, 0 or more",
    ],
    [["ticket", "move"], "ticket move requires <id>"],
    [["ticket", "move", "VC-1"], "ticket move requires --to"],
    [["ticket", "comment"], "ticket comment requires <id>"],
    // Half a verdict is not a weaker verdict, it is not one: a stage with no
    // outcome and an outcome with no stage each say nothing (VC-85).
    [["ticket", "signal"], "ticket signal requires <id>"],
    [["ticket", "signal", "VC-1", "--verdict", "pass"], "ticket signal requires --kind"],
    [["ticket", "signal", "VC-1", "--kind", "review"], "ticket signal requires --verdict"],
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

  // A slug the parser has never heard of is exactly what a registered harness
  // looks like from here, so it travels — the app is the only thing that can say
  // whether it names anything, and whether a human trusted it.
  it.each([
    ["ticket create --harness", ["ticket", "create", "--title", "x", "--harness", "aider"]],
    ["ticket update --harness", ["ticket", "update", "VC-1", "--harness", "aider"]],
  ] as const)("carries a registered harness slug through %s", (_label, argv) => {
    const result = parseCliArgs(argv);
    expect(result.ok).toBe(true);
    expect(result.ok && result.invocation.args["harness"]).toBe("aider");
  });

  it.each([
    ["ticket create --harness", ["ticket", "create", "--title", "x", "--harness", "Aider!"]],
    ["ticket update --harness", ["ticket", "update", "VC-1", "--harness", "Aider!"]],
  ] as const)("enumerates the harness vocabulary when %s rejects a token", (_label, argv) => {
    const result = parseCliArgs(argv);
    expect(result).toEqual({
      ok: false,
      code: "USAGE",
      message: `Invalid harness "Aider!" (valid: ${HARNESS_VOCABULARY})`,
    });
  });

  // The phrase help renders has to be the phrase the refusal renders, or the
  // reference teaches a vocabulary the parser does not have.
  it("names the registered category alongside the first-class ids", () => {
    expect(HARNESS_VOCABULARY).toContain("claude-code");
    expect(HARNESS_VOCABULARY).toContain("registered, trusted harness");
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

  it("answers an empty argv as a no-door refusal rather than crashing", () => {
    const result = parseCliArgs([]);
    if (result.ok) throw new Error("expected a no-door refusal");
    expect(result.code).toBe("UNSUPPORTED_COMMAND");
    expect(result.message).toContain('No Volli verb matches "(empty)"');
  });

  it("distinguishes an undeclared no-door name and lists valid verbs plus topics", () => {
    const result = parseCliArgs(["frobnicate"]);
    if (result.ok) throw new Error("expected a no-door refusal");
    expect(result.code).toBe("UNSUPPORTED_COMMAND");
    expect(result.message).toContain('No Volli verb matches "frobnicate"');
    expect(result.message).toContain("topics: concepts, changes");
    for (const name of PUBLISHED_COMMANDS) {
      expect(result.message).toContain(name);
    }
  });

  it("distinguishes a declared tool-only wrong door without inventing Role policy", () => {
    const toolOnly: VerbEntry = {
      key: "session.stop",
      accessModes: ["tool"],
      actor: "role",
      handler: { site: "main", id: "session.stop" },
      listed: true,
      referenceOrder: 1,
      group: "Session",
      summary: "Stop a Session.",
      options: [],
    };
    expect(parseCliArgs(["session", "stop", "abcd"], [toolOnly])).toEqual({
      ok: false,
      code: "WRONG_DOOR",
      verb: "session.stop",
      message:
        "volli session stop exists on the Agent Tool Surface as session.stop; the Agent CLI does not execute it.",
    });

    // The other declared non-shell doors redirect the same way: an app-only
    // verb names the app, and any future non-CLI access mode names itself.
    const appOnly: VerbEntry = {
      ...toolOnly,
      key: "ticket.discard",
      accessModes: [],
      handler: { site: "main", id: "ticket.discard" },
    };
    expect(parseCliArgs(["ticket", "discard", "VC-1"], [appOnly])).toMatchObject({
      ok: false,
      code: "WRONG_DOOR",
      verb: "ticket.discard",
      message: "volli ticket discard exists in the app only; no agent surface executes it.",
    });
    const hostApiOnly: VerbEntry = {
      ...toolOnly,
      key: "review.fetch",
      accessModes: ["hostApi"],
      handler: { site: "main", id: "review.fetch" },
    };
    expect(parseCliArgs(["review", "fetch"], [hostApiOnly])).toMatchObject({
      ok: false,
      code: "WRONG_DOOR",
      verb: "review.fetch",
      message: "volli review fetch exists on hostApi, not on the Agent CLI.",
    });
  });

  it("parses the ratified side-effect preview matrix into one dryRun argument", () => {
    const calls = [
      ["ticket", "create", "--title", "T", "--dry-run"],
      ["ticket", "update", "VC-1", "--dry-run"],
      ["ticket", "move", "VC-1", "--to", "doing", "--dry-run"],
      ["ticket", "comment", "VC-1", "-m", "note", "--dry-run"],
      ["session", "done", "--dry-run"],
      ["session", "blocked", "--dry-run"],
      ["session", "link", "native-id", "--dry-run"],
      ["notify", "-m", "hello", "--dry-run"],
      ["doctor", "--fix", "--dry-run"],
    ];
    for (const argv of calls) {
      expect(parseCliArgs(argv)).toMatchObject({
        ok: true,
        invocation: { args: { dryRun: true } },
      });
    }
  });

  it("requires a repair intent for a doctor preview", () => {
    expect(parseCliArgs(["doctor", "--dry-run"])).toEqual({
      ok: false,
      code: "USAGE",
      message: "doctor --dry-run requires --fix",
    });
  });

  // Reading the body a real call would send is a read. Refusing it would make a
  // preview validate different input than the operation it previews, which is
  // the one thing the preview contract cannot afford; the non-effect it owes is
  // that nothing is WRITTEN.
  it("previews a file-sourced body instead of refusing to read it", () => {
    for (const argv of [
      ["ticket", "create", "--title", "T", "--body-file", "/tmp/body", "--dry-run"],
      ["ticket", "update", "VC-1", "--body-file", "/tmp/body", "--dry-run"],
      ["ticket", "comment", "VC-1", "--file", "/tmp/note", "--dry-run"],
    ]) {
      expect(parseCliArgs(argv)).toMatchObject({
        ok: true,
        invocation: { args: { dryRun: true } },
      });
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

describe("prompt baseline", () => {
  it("parses bare, along the context ladder", () => {
    expect(parseCliArgs(["prompt", "baseline"])).toEqual({
      ok: true,
      invocation: { command: "prompt.baseline", args: {}, json: false },
    });
  });

  it("carries --ticket and --project selectors", () => {
    expect(parseCliArgs(["prompt", "baseline", "--ticket", "VC-12", "--project", "volli"])).toEqual(
      {
        ok: true,
        invocation: {
          command: "prompt.baseline",
          args: { ticket: "VC-12", project: "volli" },
          json: false,
        },
      },
    );
  });

  it("rejects a bare `prompt` as an unknown command", () => {
    const parsed = parseCliArgs(["prompt"]);
    expect(parsed.ok).toBe(false);
  });
});

describe("doctor", () => {
  it("parses with no options", () => {
    const parsed = parseCliArgs(["doctor"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("expected a parse");
    expect(parsed.invocation.command).toBe("doctor");
    expect(parsed.invocation.args["fix"]).toBeUndefined();
  });

  it("parses --fix as a flag", () => {
    const parsed = parseCliArgs(["doctor", "--fix"]);
    if (!parsed.ok) throw new Error("expected a parse");
    expect(parsed.invocation.args["fix"]).toBe(true);
  });
});

/**
 * The seam VC-161 opened, held shut from both sides.
 *
 * An option is declared in the Verb Registry (name, kind, placeholder, help)
 * and executed here (`parse`, `finalize`, `build`, the argument key it lands
 * under). That split is deliberate — argv mechanics are the CLI's own
 * projection detail, and keeping them out of `@volli/shared` is what lets
 * `apps/desktop` read an argument spec for a tool schema without depending on
 * this package. The cost of the split is that the two halves can drift, so
 * every one of these asserts they cannot.
 */
describe("registry ↔ argv mechanics", () => {
  const mechanicsEntries = Object.entries(CLI_MECHANICS).map(([key, mechanics]) => ({
    key,
    mechanics: mechanics!,
  }));

  it("keys every mechanics entry by a verb the registry declares", () => {
    for (const { key } of mechanicsEntries) {
      expect(verbEntry(key), key).toBeDefined();
    }
  });

  it("names a real declared option for every mechanics option, with its declared kind", () => {
    for (const { key, mechanics } of mechanicsEntries) {
      const declared = new Map(verbEntry(key)!.options.map((option) => [option.name, option.kind]));
      for (const [name, option] of Object.entries(mechanics.options)) {
        expect(declared.get(name), `${key} ${name}`).toBe(option.kind);
      }
    }
  });

  it("gives every declared option mechanics, so nothing in the reference is unparseable", () => {
    for (const { key, mechanics } of mechanicsEntries) {
      for (const option of verbEntry(key)!.options) {
        expect(Object.keys(mechanics.options), `${key} ${option.name}`).toContain(option.name);
      }
    }
  });

  // Adding a verb is adding a registry entry; this is the assertion that makes
  // the CLI half of that true. A verb printed in the reference that no route
  // answers would be a command an agent is told to run and cannot.
  it("routes every command the reference publishes", () => {
    for (const name of PUBLISHED_COMMANDS) {
      const result = parseCliArgs(name.split(" "));
      const message = result.ok ? "" : result.message;
      expect(message.startsWith("No Volli verb matches"), name).toBe(false);
    }
  });

  // The other direction: `hook` is dispatched in index.ts before argv reaches
  // the parser, and must stay unroutable here however it is typed.
  it("leaves the parser-bypassing verb unroutable", () => {
    const result = parseCliArgs(["hook", "SessionStart"]);
    if (result.ok) throw new Error("expected a no-door error");
    expect(result.code).toBe("UNSUPPORTED_COMMAND");
    expect(result.message.startsWith("No Volli verb matches")).toBe(true);
  });

  // Mechanics for a verb that is on no agent surface would be a route to
  // something the registry does not publish anywhere.
  it("holds mechanics only for verbs carrying a cli access mode", () => {
    for (const { key } of mechanicsEntries) {
      expect(verbEntry(key)!.accessModes, key).toContain("cli");
    }
  });

  // Which verbs the walker cannot serve, named rather than inferred: `hook`
  // takes two bare positionals and never walks the parser, `help` takes a
  // command path or a topic word instead of an option table, and `ticket.await`
  // is not on the shell at all — it is control tier, because a CLI verb must
  // never wait (VC-85). The first two are shapes argv cannot express; the third
  // is a door this process does not have.
  it("leaves exactly the verbs the walker cannot serve without mechanics", () => {
    const missing = VERB_REGISTRY.filter((entry) => CLI_MECHANICS[entry.key] === undefined).map(
      (entry) => entry.key,
    );
    expect(missing).toEqual(["hook", "help", "ticket.await"]);
  });
});

/**
 * `volli cost` argv (VC-87). The two value options both refuse rather than
 * guess: a `--since` read as `0` and a `--group-by` read as "no grouping" would
 * each answer a question nobody asked, with output that looks entirely normal.
 */
describe("cost", () => {
  it("keeps --since as the shape it was written in, not as an instant", () => {
    // Resolved here, it would be pinned to THIS process's clock; main holds the
    // clock the rest of the answer is measured against.
    expect(parseCliArgs(["cost", "--since", "7d"])).toMatchObject({
      ok: true,
      invocation: { args: { since: { kind: "duration", ms: 604_800_000 } } },
    });
    expect(parseCliArgs(["cost", "--since", "90m"])).toMatchObject({
      ok: true,
      invocation: { args: { since: { kind: "duration", ms: 5_400_000 } } },
    });
    expect(parseCliArgs(["cost", "--since", "2026-01-14T09:22:11Z"])).toMatchObject({
      ok: true,
      invocation: {
        args: { since: { kind: "instant", epochMs: Date.parse("2026-01-14T09:22:11Z") } },
      },
    });
  });

  it("refuses a --since nobody could have meant", () => {
    const result = parseCliArgs(["cost", "--since", "last tuesday"]);
    if (result.ok) throw new Error("expected a usage error");
    expect(result.code).toBe("USAGE");
    expect(result.message).toContain("RFC 3339");
  });

  it("teaches the grouping vocabulary rather than ignoring an unknown one", () => {
    expect(parseCliArgs(["cost", "--group-by", "model"])).toMatchObject({
      ok: true,
      invocation: { args: { groupBy: "model" } },
    });
    const result = parseCliArgs(["cost", "--group-by", "provider"]);
    if (result.ok) throw new Error("expected a usage error");
    expect(result.message).toContain("ticket, session, model, day");
  });

  it("refuses two scopes rather than letting one silently win", () => {
    const result = parseCliArgs(["cost", "--ticket", "VC-1", "--all-projects"]);
    if (result.ok) throw new Error("expected a usage error");
    expect(result.message).toContain("one of --ticket, --session or --all-projects");
    // --project is the ladder's own word and rides alongside a narrower scope.
    expect(parseCliArgs(["cost", "--ticket", "VC-1", "--project", "VC"])).toMatchObject({
      ok: true,
    });
  });
});
