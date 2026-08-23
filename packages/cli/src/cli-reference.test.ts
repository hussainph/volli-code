import { describe, expect, it } from "vite-plus/test";

import { bareHelpText, renderHelp } from "./help";
import { parseCliArgs } from "./parser";

/**
 * The reference oracle: every byte `volli help` and the parser's teaching
 * errors can print, captured in one file.
 *
 * VC-161 re-seats the CLI reference onto the Verb Registry in `@volli/shared`,
 * and the one thing that must survive that move untouched is the text. So this
 * file was written and captured BEFORE the rewiring, against the hand-authored
 * `COMMAND_HELP` table, and the rewired reference has to reproduce it byte for
 * byte. The installed `volli` on PATH is not the oracle — it is version 0.1.0
 * and already predates this tree (VC-157 changed `identify` and `doctor`).
 *
 * The command list, group words and topics below are LITERAL on purpose. If
 * they were derived from whatever table currently backs help, a verb silently
 * dropped from that table would drop out of the oracle with it and the
 * snapshot would still pass. Written out, this test names the surface and its
 * order itself, and a change to either has to be made here in the open.
 */

/** The 27 listed commands, in the order the compact reference prints them. */
const REFERENCE_COMMANDS = [
  "identify",
  "board",
  "ticket list",
  "ticket show",
  "ticket events",
  "ticket brief",
  "worktree status",
  "worktree diff",
  "project list",
  "label list",
  "model list",
  "ticket create",
  "ticket update",
  "ticket move",
  "ticket comment",
  "ticket archive",
  "session start",
  "session list",
  "session peek",
  "session done",
  "session blocked",
  "session link",
  "notify",
  "app launch",
  "prompt baseline",
  "doctor",
  "help",
] as const;

/** The commands whose first `rest` token is consumed as `<id>`. */
const TAKES_ID: ReadonlySet<string> = new Set([
  "ticket show",
  "ticket events",
  "ticket brief",
  "ticket update",
  "ticket move",
  "ticket comment",
  "ticket archive",
  "session start",
  "session peek",
  "session link",
  "session harness",
  "worktree status",
  "worktree diff",
]);

/** The command-group words that answer with a subcommand list. */
const GROUP_WORDS = [
  "ticket",
  "worktree",
  "project",
  "label",
  "model",
  "session",
  "app",
  "prompt",
] as const;

/** The four reference topics (not commands). */
const TOPICS = ["exit-codes", "addressing", "json", "orchestration"] as const;

/**
 * Paths that are deliberately NOT reference entries. `session harness` and
 * `hook` are the involuntary verbs: they must never render a command detail,
 * however they are asked for. The rest are the fallback paths.
 */
const OFF_REFERENCE: readonly (readonly string[])[] = [
  ["session", "harness"],
  ["hook"],
  ["nonsense"],
  ["exit-codes", "extra"],
  ["ticket", "create", "VC-1"],
  ["ticket create"],
];

const RULE = "=".repeat(76);

function section(title: string, body: string): string {
  return `${RULE}\n${title}\n${RULE}\n${body}`;
}

/** How the parser answered — the message for a usage error, the shape for a parse. */
function parseOutcome(argv: readonly string[]): string {
  const result = parseCliArgs(argv);
  return result.ok
    ? `ok ${JSON.stringify(result.invocation)}\n`
    : `${result.code} ${result.message}\n`;
}

/**
 * Everything the reference can say, in one document. Teaching errors ride along
 * because they are rendered from the same option table the usage lines are: an
 * option that moved, was renamed, or lost its place in the table shows up here
 * as a reordered `(options: …)` list even when the help text is unchanged.
 */
function referenceDocument(): string {
  const parts: string[] = [section("volli help", bareHelpText())];
  for (const name of REFERENCE_COMMANDS) {
    parts.push(section(`volli help ${name}`, renderHelp(name.split(" "))));
  }
  for (const word of GROUP_WORDS) {
    parts.push(section(`volli help ${word}`, renderHelp([word])));
  }
  for (const topic of TOPICS) {
    parts.push(section(`volli help ${topic}`, renderHelp([topic])));
  }
  for (const path of OFF_REFERENCE) {
    parts.push(section(`volli help ${path.join(" ")}`, renderHelp(path)));
  }
  const probes: string[] = [section("volli frobnicate", parseOutcome(["frobnicate"]))];
  for (const name of [...REFERENCE_COMMANDS, "session harness"]) {
    const argv = [
      ...name.split(" "),
      ...(TAKES_ID.has(name) ? ["ORACLE-1"] : []),
      "--not-an-option",
    ];
    probes.push(section(`volli ${argv.join(" ")}`, parseOutcome(argv)));
  }
  return [...parts, ...probes].join("\n");
}

describe("the CLI reference", () => {
  it("renders byte-identically to the captured oracle", async () => {
    await expect(referenceDocument()).toMatchFileSnapshot("./__snapshots__/cli-reference.txt");
  });

  it("is the same text for a bare `volli` and an empty help path", () => {
    expect(renderHelp([])).toBe(bareHelpText());
  });
});
