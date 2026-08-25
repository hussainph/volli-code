import { describe, expect, it } from "vite-plus/test";

import { AGENT_ERROR_CODES, cliVerbName, REFERENCE_VERBS } from "@volli/shared";
import type { AgentBuildIdentity, AgentHelpRuntime, VerbEntry } from "@volli/shared";

import { bareHelpText, renderHelp, resolveHelp } from "./help";

/** chars / 4 is the bench's token estimate; keep the two ceilings in one place. */
const estTokens = (text: string): number => Math.floor(text.length / 4);

/** The commands the reference publishes, as a caller types them. */
const PUBLISHED_COMMANDS = REFERENCE_VERBS.map((entry) => cliVerbName(entry.key));

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
    for (const name of PUBLISHED_COMMANDS) expect(text).toContain(name);
    // Footer: context ladder, --json, id conventions, the help pointer + topics.
    expect(text).toContain("VOLLI_SESSION/VOLLI_TICKET");
    expect(text).toContain("Add --json to any command");
    expect(text).toContain("short session ids");
    expect(text).toContain(
      "Topics: concepts, changes, exit-codes, addressing, json, orchestration",
    );
    expect(text).toContain("Agent Tool Surface");
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
  it("keeps every command's detail under a scan-friendly 1,800-char ceiling", () => {
    for (const name of PUBLISHED_COMMANDS) {
      const detail = renderHelp(name.split(" "));
      expect(detail.length, `${name} chars`).toBeLessThanOrEqual(1800);
      expect(estTokens(detail), `${name} est tokens`).toBeLessThanOrEqual(450);
    }
  });

  it("renders a rich write command with a compact usage, full options, values, and notes", () => {
    const detail = renderHelp(["ticket", "create"]);
    expect(detail).toContain("ticket create — Create a ticket (defaults to Backlog).");
    // Compact usage folds optional options into [options] (no duplication with the table).
    expect(detail).toContain("Usage: volli ticket create --title <text> [options]");
    expect(detail).toContain("Options:");
    expect(detail).toContain("--no-worktree");
    expect(detail).toContain("--dry-run");
    expect(detail).toContain("Door: Agent CLI");
    expect(detail).toContain("Verb tier: coordination");
    expect(detail).toContain("Human sees: The new Ticket appears on the board");
    expect(detail).toContain("--status <column>");
    // Column options carry the valid vocabulary in detail.
    expect(detail).toContain("(valid: backlog, todo, doing, needs-review|review, done)");
    expect(detail).toContain("Example: volli ticket create");
    expect(detail).toContain("Notes:");
    expect(detail).toContain("- Defaults to Backlog unless --status is set.");
    // The hidden --message alias never appears; -m does.
    expect(detail).not.toContain("--message");
  });

  it("spells out a required option and folds dry-run into optional detail", () => {
    const detail = renderHelp(["ticket", "move"]);
    expect(detail).toContain("Usage: volli ticket move <id> --to <column> [options]");
    expect(detail).toContain("--dry-run");
    expect(detail).toContain("The move does not start a Session");
  });

  it("collapses a required grouped option and hides its alias", () => {
    const detail = renderHelp(["notify"]);
    expect(detail).toContain("Usage: volli notify -m <text> [options]");
    expect(detail).not.toContain("--message");
  });

  it("renders structured effects even when a command has no options or notes", () => {
    const detail = renderHelp(["ticket", "archive"]);
    expect(detail).toContain("ticket archive — ");
    expect(detail).not.toContain("Options:");
    expect(detail).not.toContain("Notes:");
    expect(detail).toContain("Effects:");
    expect(detail).toContain("The Ticket worktree is preserved");
  });

  // VC-163 / VC-92 §7: the CLI never lies about the tool surface. A verb the
  // shell cannot run must not be described in shell syntax — an agent shown a
  // usage line and a copyable example WILL type them, and be refused. Help's
  // job for these two is to name the real door, not to rehearse a command.
  it("describes an app-only verb without a shell usage line or example", () => {
    const detail = renderHelp(["ticket", "archive"]);
    expect(detail).toContain("Door: app only (no agent door)");
    expect(detail).toContain("Verb tier: none");
    // What it must NOT contain: anything a caller could copy into a shell.
    expect(detail).not.toContain("Usage:");
    expect(detail).not.toContain("Example:");
    expect(detail).toContain(
      "The app is the only door. Neither the Agent CLI nor the Agent Tool Surface runs this verb.",
    );
    // The effects contract survives — it is why someone reads this page.
    expect(detail).toContain("Effects:");
  });

  it("describes a tool-only verb by its callable name, not by argv", () => {
    const detail = renderHelp(["session", "start"]);
    expect(detail).toContain("Door: Agent Tool Surface (named tool; not shell-executable)");
    expect(detail).toContain("Verb tier: control");
    // The wire name a model actually calls, and its real input fields.
    expect(detail).toContain("Tool: session_start");
    expect(detail).toContain("ticket");
    // No argv anywhere: a model shown `-m` writes `-m`, which is the whole
    // reason VerbToolProjection is a separate table from the option table.
    expect(detail).not.toContain("Usage: volli session start");
    expect(detail).not.toContain("-m <text>");
    expect(detail).not.toContain("--model <provider/model>");
    expect(detail).not.toContain("Example: volli session start");
  });

  // A tool that takes nothing is a legal projection — `VerbToolProjection.input`
  // is explicitly allowed to be empty — so the Input heading has to be
  // conditional rather than always printed above nothing.
  it("prints no Input heading for a tool that takes nothing", () => {
    const nullary: VerbEntry = {
      key: "session.ping",
      accessModes: ["tool"],
      actor: "role",
      handler: { site: "main", id: "session.ping" },
      listed: true,
      referenceOrder: 0,
      group: "Session",
      summary: "Take nothing and answer.",
      tool: { name: "session_ping", description: "Answers.", input: [] },
      options: [],
    };

    const detail = renderHelp(["session", "ping"], [nullary]);

    expect(detail).toContain("Tool: session_ping");
    expect(detail).not.toContain("Input:");
  });

  it("renders a command that has options but no notes", () => {
    const detail = renderHelp(["ticket", "list"]);
    expect(detail).toContain("Options:");
    expect(detail).toContain("--status <column>");
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

  it("renders the reasoning vocabulary and hides an alias on a verb the shell runs", () => {
    // Was `session start` until VC-163 took it off the CLI. `ticket create` is
    // the same shape: a values hint the placeholder cannot carry, plus a hidden
    // alias that must stay out of generated help.
    const detail = renderHelp(["ticket", "comment"]);
    expect(detail).toContain("Usage: volli ticket comment <id> [options]");
    expect(detail).toContain("-m <text>");
    expect(detail).not.toContain("--message");

    const created = renderHelp(["ticket", "create"]);
    expect(created).toContain("(valid: backlog, todo, doing, needs-review|review, done)");
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
    ["concepts", "durable identity"],
    ["json", "structured JSON"],
    ["addressing", "Context ladder"],
    ["orchestration", "Read before writing"],
  ] as const)("renders the %s topic", (topic, needle) => {
    expect(renderHelp([topic])).toContain(needle);
  });

  it("renders changes with an embedded build identity and optional live app version", () => {
    const identity: AgentBuildIdentity = {
      cliVersion: "0.0.1",
      releaseVersion: "0.1.0",
      sourceRevision: "abc123+dirty",
      buildId: "local-7",
    };
    const runtime: AgentHelpRuntime = {
      appVersion: "0.1.1",
      surface: null,
      surfaceUnknownReason: null,
    };
    const text = renderHelp(["changes"], undefined, { identity, runtime });
    expect(text).toContain("CLI package: @volli/cli 0.0.1");
    expect(text).toContain("Release promotion marker: 0.1.0");
    expect(text).toContain("Source revision: abc123+dirty");
    expect(text).toContain("Build id: local-7");
    expect(text).toContain("Running app: 0.1.1");
    for (const heading of ["Added", "Changed", "Fixed", "Removed"]) {
      expect(text).toContain(`\n${heading}\n`);
    }
    expect(text).toContain("VC-85 (after VC-91)");
    for (const capability of ["ticket signal", "ticket_await", "lossless", "--events 0"]) {
      expect(text).toContain(capability);
    }
  });

  it("refuses an unknown or over-long help path with valid doors and topics", () => {
    for (const path of [["nonsense"], ["exit-codes", "extra"]]) {
      const resolved = resolveHelp(path);
      expect(resolved).toMatchObject({
        ok: false,
        error: { code: "USAGE", next: expect.stringContaining("volli help") },
      });
      if (!resolved.ok) {
        expect(resolved.error.reason).toContain("commands:");
        expect(resolved.error.reason).toContain("topics: concepts, changes");
      }
    }
  });
});

/**
 * Help is a projection of an entry list, not a table of its own. These pass one
 * in, which is the only way to render a verb the real registry has no reason to
 * hold — and the only way to show that the real surface refuses it.
 */
describe("renderHelp over a supplied entry list", () => {
  /** A control-tier verb of the shape VC-162 introduces: named tool, off shell execution. */
  const toolOnly: VerbEntry = {
    key: "vault.rotate",
    accessModes: ["tool"],
    actor: "role",
    handler: { site: "main", id: "vault.rotate" },
    listed: true,
    referenceOrder: 1,
    group: "Session",
    summary: "Rotate a stored credential.",
    options: [],
  };

  /** A listed CLI verb with no example, exercising optional presentation data. */
  const shellOnly: VerbEntry = {
    key: "vault.inspect",
    accessModes: ["cli"],
    actor: "any",
    handler: { site: "main", id: "vault.inspect" },
    listed: true,
    referenceOrder: 1,
    group: "Read",
    summary: "Inspect stored credential metadata.",
    options: [],
  };

  it("projects supplied entries without pretending a tool-only verb is executable", () => {
    const text = bareHelpText([toolOnly]);
    expect(text).toContain("Agent Tool Surface\n  vault rotate");
    expect(text).not.toMatch(/Session\n\s+vault rotate/);
    expect(text).not.toContain("ticket create");
  });

  it("renders a tool-only verb's real door and unknown availability outside a Session", () => {
    const detail = renderHelp(["vault", "rotate"], [toolOnly]);
    expect(detail).toContain("Door: Agent Tool Surface (named tool; not shell-executable)");
    expect(detail).toContain("Verb tier: control");
    expect(detail).toContain("Role availability: not claimed outside a resolved Session");
  });

  it("names an app-only verb's door honestly instead of hiding it", () => {
    const appOnly: VerbEntry = {
      ...toolOnly,
      key: "ticket.discard",
      accessModes: [],
      actor: "any",
    };
    const detail = renderHelp(["ticket", "discard"], [appOnly]);
    expect(detail).toContain("Door: app only (no agent door)");
    expect(detail).toContain("Verb tier: none");
    // Bare help lists the same verb under its own section rather than a shell group.
    expect(bareHelpText([appOnly])).toContain("App-only verbs\n  ticket discard");
  });

  it("labels a verb on both agent surfaces with both doors", () => {
    const dual: VerbEntry = {
      ...toolOnly,
      key: "vault.list",
      accessModes: ["cli", "tool"],
      actor: "any",
      group: "Read",
    };
    expect(renderHelp(["vault", "list"], [dual])).toContain(
      "Door: Agent CLI and Agent Tool Surface",
    );
  });

  it("reports a resolved but empty frozen surface as empty, not unknown", () => {
    const text = bareHelpText([shellOnly], {
      runtime: {
        appVersion: null,
        surface: { sessionId: "session-1", role: "subagent", tools: [] },
        surfaceUnknownReason: null,
      },
    });
    expect(text).toContain("Resolved Session Role: subagent");
    expect(text).toContain("Frozen Agent Tool Surface: (empty)");
  });

  it("marks a tool-only verb's availability unknown when the optional read failed", () => {
    const detail = renderHelp(["vault", "rotate"], [toolOnly], {
      runtime: {
        appVersion: null,
        surface: null,
        surfaceUnknownReason: "the app is stopped",
      },
    });
    expect(detail).toContain("Role availability: unknown (the app is stopped).");
  });

  it("throws from renderHelp on an unknown path so projections cannot silently degrade", () => {
    expect(() => renderHelp(["nonsense"])).toThrow(/Unknown help path/);
  });

  it("reports an unknown frozen surface on bare help when the optional read failed", () => {
    const text = bareHelpText([shellOnly], {
      runtime: {
        appVersion: null,
        surface: null,
        surfaceUnknownReason: "the app is stopped",
      },
    });
    expect(text).toContain(
      "Session Role and frozen Agent Tool Surface: unknown (the app is stopped)",
    );
  });

  it("reports whether the resolved Role's frozen bundle carries a tool-only verb", () => {
    const carried: AgentHelpRuntime = {
      appVersion: "0.1.1",
      surface: { sessionId: "session-1", role: "project", tools: ["vault.rotate"] },
      surfaceUnknownReason: null,
    };
    const absent: AgentHelpRuntime = {
      ...carried,
      surface: { sessionId: "session-2", role: "ticket", tools: [] },
    };
    expect(renderHelp(["vault", "rotate"], [toolOnly], { runtime: carried })).toContain(
      "carried by this project Session's frozen bundle",
    );
    expect(renderHelp(["vault", "rotate"], [toolOnly], { runtime: absent })).toContain(
      "not carried by this ticket Session's frozen bundle",
    );
    expect(bareHelpText([toolOnly], { runtime: carried })).toContain(
      "Frozen Agent Tool Surface: vault.rotate",
    );
  });

  it("keeps involuntary verbs out of discovery", () => {
    expect(resolveHelp(["hook"])).toMatchObject({ ok: false, error: { code: "USAGE" } });
    expect(renderHelp(["session", "harness"])).toBe(renderHelp(["session"]));
  });

  // Synthetic entries need not carry the real registry's stricter presentation
  // invariant, so keep the renderer honest when one omits an example.
  it("omits the Example line for a verb that declares none", () => {
    const detail = renderHelp(["vault", "inspect"], [shellOnly]);
    expect(detail).toContain("vault inspect — Inspect stored credential metadata.");
    expect(detail).toContain("Usage: volli vault inspect");
    expect(detail).not.toContain("Example:");
  });
});
