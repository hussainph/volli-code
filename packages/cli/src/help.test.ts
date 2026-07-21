import { describe, expect, it } from "vite-plus/test";

import { AGENT_ERROR_CODES } from "@volli/shared";

import { bareHelpText, renderHelp } from "./help";
import { COMMAND_HELP } from "./parser";

/** chars / 4 is the bench's token estimate; keep the two ceilings in one place. */
const estTokens = (text: string): number => Math.floor(text.length / 4);

describe("bareHelpText", () => {
  it("is a complete, grouped, footered reference under the 2,800-char budget", () => {
    const text = bareHelpText();
    // Budget is a tested contract (spec section 6): fail fast on drift.
    expect(text.length).toBeLessThanOrEqual(2800);
    expect(estTokens(text)).toBeLessThanOrEqual(700);
    for (const group of ["Read", "Write", "Session", "App"]) {
      expect(text).toContain(`${group}\n`);
    }
    // Every command appears exactly by name in the compact reference.
    for (const entry of COMMAND_HELP) expect(text).toContain(entry.name);
    // Footer: context ladder, --json, id conventions, the help pointer + topics.
    expect(text).toContain("VOLLI_SESSION/VOLLI_TICKET");
    expect(text).toContain("Add --json to any command");
    expect(text).toContain("short session ids");
    expect(text).toContain("Topics: exit-codes, addressing, json, orchestration");
    // The full option shape is spelled out for the richest command.
    expect(text).toContain(
      "ticket create --title <text> [--body <text>|--body-file <path>] [--priority low|medium|high]",
    );
    expect(text).toContain("[--label <name>]...");
  });

  it("is what renderHelp returns for an empty path", () => {
    expect(renderHelp([])).toBe(bareHelpText());
  });
});

describe("renderHelp command detail", () => {
  it("keeps every command's detail under the 900-char / 225-token ceilings", () => {
    for (const entry of COMMAND_HELP) {
      const detail = renderHelp(entry.name.split(" "));
      expect(detail.length, `${entry.name} chars`).toBeLessThanOrEqual(900);
      expect(estTokens(detail), `${entry.name} est tokens`).toBeLessThanOrEqual(225);
    }
  });

  it("renders a rich write command with a compact usage, full options, values, and notes", () => {
    const detail = renderHelp(["ticket", "create"]);
    expect(detail).toContain("ticket create — Create a ticket (defaults to Backlog).");
    // Compact usage folds optional options into [options] (no duplication with the table).
    expect(detail).toContain("Usage: volli ticket create --title <text> [options]");
    expect(detail).toContain("Options:");
    expect(detail).toContain("--no-worktree");
    expect(detail).toContain("--status <column>");
    // Column options carry the valid vocabulary in detail.
    expect(detail).toContain("(valid: backlog, todo, doing, needs-review|review, done)");
    expect(detail).toContain("Example: volli ticket create");
    expect(detail).toContain("Notes:");
    expect(detail).toContain("- Defaults to Backlog unless --status is set.");
    // The hidden --message alias never appears; -m does.
    expect(detail).not.toContain("--message");
  });

  it("spells out a required non-grouped option with no trailing [options]", () => {
    const detail = renderHelp(["ticket", "move"]);
    expect(detail).toContain("Usage: volli ticket move <id> --to <column>");
    expect(detail).not.toContain("[options]");
  });

  it("collapses a required grouped option and hides its alias", () => {
    const detail = renderHelp(["notify"]);
    expect(detail).toContain("Usage: volli notify -m <text> [options]");
    expect(detail).not.toContain("--message");
  });

  it("omits the Options and Notes sections when a command has neither", () => {
    const detail = renderHelp(["ticket", "archive"]);
    expect(detail).toContain("ticket archive — ");
    expect(detail).not.toContain("Options:");
    expect(detail).not.toContain("Notes:");
    expect(detail).toContain("Example: volli ticket archive VC-12");
  });

  it("renders a command that has options but no notes", () => {
    const detail = renderHelp(["identify"]);
    expect(detail).toContain("Options:");
    expect(detail).toContain("--project <p>");
    expect(detail).not.toContain("Notes:");
  });

  it("renders an optional positional id as [<id>] for the worktree commands", () => {
    const status = renderHelp(["worktree", "status"]);
    expect(status).toContain(
      "worktree status — Show a ticket's worktree branch, base, and sync state.",
    );
    // Optional id → bracketed, and no leftover [options] since it has none.
    expect(status).toContain("Usage: volli worktree status [<id>]");
    expect(status).not.toContain("[options]");

    const diff = renderHelp(["worktree", "diff"]);
    expect(diff).toContain("Usage: volli worktree diff [<id>] [options]");
    expect(diff).toContain("--working-tree");
    expect(diff).toContain("Default range is the merge-base diff");
  });

  it("carries a command's extra usage tail into its detail", () => {
    const detail = renderHelp(["help"]);
    expect(detail).toContain("Usage: volli help [<command> | <topic>]");
  });

  it("matches the longest command prefix, ignoring trailing positionals", () => {
    expect(renderHelp(["ticket", "create", "VC-1"])).toBe(renderHelp(["ticket", "create"]));
  });

  it("resolves a quoted multi-word argument the same as separate words", () => {
    expect(renderHelp(["ticket create"])).toBe(renderHelp(["ticket", "create"]));
  });
});

describe("renderHelp groups and topics", () => {
  it("lists the subcommands of a command group", () => {
    const text = renderHelp(["ticket"]);
    expect(text).toContain("ticket subcommands:");
    expect(text).toContain("ticket create");
    expect(text).toContain("Run volli help ticket <subcommand> for detail.");
  });

  it("renders the exit-codes topic from the published vocabulary", () => {
    const text = renderHelp(["exit-codes"]);
    expect(text).toContain("0 ok; 1 failure; 2 usage; 3 app unreachable");
    for (const code of AGENT_ERROR_CODES) expect(text).toContain(code);
    expect(text).toContain("APP_UNREACHABLE");
    expect(text).toContain("3 app unreachable (retryable)");
  });

  it.each([
    ["json", "structured JSON"],
    ["addressing", "Context ladder"],
    ["orchestration", "Read before writing"],
  ] as const)("renders the %s topic", (topic, needle) => {
    expect(renderHelp([topic])).toContain(needle);
  });

  it("falls back to the compact reference for an unknown or over-long path", () => {
    expect(renderHelp(["nonsense"])).toBe(bareHelpText());
    // A topic word with extra tokens is not a single-topic path → reference.
    expect(renderHelp(["exit-codes", "extra"])).toBe(bareHelpText());
  });
});
