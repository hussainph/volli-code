import { describe, expect, it } from "vite-plus/test";

import { parseCliArgs } from "./parser";

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
  });

  it("routes the remaining published read, help, and explicit launch commands", () => {
    expect(parseCliArgs(["board", "--project", "/work/volli"])).toEqual({
      ok: true,
      invocation: { command: "board", args: { project: "/work/volli" }, json: false },
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
      invocation: { command: "help", args: { topic: "exit-codes" }, json: false },
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
          labels: [],
          status: "backlog",
          usesWorktree: true,
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
});
