import { AGENT_ERROR_CODES } from "@volli/shared";

import { COMMAND_HELP } from "./parser";
import type { CommandHelpEntry, CommandSpec, OptionEntry } from "./parser";
import { exitCodeForError } from "./render";

const EXIT_CLASS_LABEL = {
  1: "1 failure",
  2: "2 usage",
  3: "3 app unreachable (retryable)",
} as const;

/** The four `volli help <topic>` reference topics (not commands). */
const TOPICS = ["exit-codes", "addressing", "json", "orchestration"] as const;
type Topic = (typeof TOPICS)[number];

function isTopic(value: string): value is Topic {
  return (TOPICS as readonly string[]).includes(value);
}

/**
 * The fixed error-code vocabulary (decision 6), rendered from
 * {@link AGENT_ERROR_CODES} so `volli help exit-codes` can never drift from the
 * codes agent-commands.ts actually emits.
 */
function exitCodesText(): string {
  const width = Math.max(...AGENT_ERROR_CODES.map((code) => code.length));
  const rows = AGENT_ERROR_CODES.map(
    (code) => `  ${code.padEnd(width)}  ${EXIT_CLASS_LABEL[exitCodeForError(code)]}`,
  );
  return (
    "Exit codes: 0 ok; 1 failure; 2 usage; 3 app unreachable (retryable).\n\n" +
    "Error codes:\n" +
    `${rows.join("\n")}\n`
  );
}

function topicText(topic: Topic): string {
  if (topic === "exit-codes") return exitCodesText();
  if (topic === "json") return "Pass --json to any command for stable structured JSON output.\n";
  if (topic === "addressing") {
    return "Context ladder: explicit --project flag, then VOLLI_SESSION/VOLLI_TICKET, then a registered cwd. Volli never guesses; ambiguity is an error.\n";
  }
  return "Read before writing; work your own board unless instructed; do not chain-spawn agents.\n";
}

/** The value shape shown after an option name (`<text>`, `low|medium|high`); flags carry none. */
function placeholderOf(entry: OptionEntry): string {
  return entry.kind === "flag" ? "" : ` ${entry.placeholder}`;
}

/** One option's `--name <value>` token as it appears in a usage line. */
function optionToken(name: string, entry: OptionEntry): string {
  return `${name}${placeholderOf(entry)}`;
}

/**
 * The full bracketed option sequence for the compact reference: aliases hidden,
 * required options unbracketed, repeatable options suffixed `...`, and mutually
 * exclusive `group` members collapsed into one `[a|b]` slot.
 */
function fullOptionsUsage(spec: CommandSpec): string {
  const entries = Object.entries(spec.options);
  const seenGroups = new Set<string>();
  const parts: string[] = [];
  for (const [name, entry] of entries) {
    if (entry.hidden) continue;
    if (entry.group !== undefined) {
      if (seenGroups.has(entry.group)) continue;
      seenGroups.add(entry.group);
      const inner = entries
        .filter(([, other]) => other.group === entry.group && other.hidden !== true)
        .map(([memberName, member]) => optionToken(memberName, member))
        .join("|");
      parts.push(entry.required === true ? inner : `[${inner}]`);
    } else if (entry.required === true) {
      parts.push(optionToken(name, entry));
    } else {
      const token = `[${optionToken(name, entry)}]`;
      parts.push(entry.kind === "repeated" ? `${token}...` : token);
    }
  }
  return parts.join(" ");
}

/**
 * The compact usage tail for command detail: required options spelled out, a
 * single `[options]` standing in for the optional ones (each fully described in
 * the Options table below, so the detail view never repeats itself).
 */
function compactOptionsUsage(spec: CommandSpec): string {
  const entries = Object.entries(spec.options);
  const seenGroups = new Set<string>();
  const required: string[] = [];
  let hasOptional = false;
  for (const [name, entry] of entries) {
    if (entry.hidden) continue;
    if (entry.group !== undefined) {
      if (seenGroups.has(entry.group)) continue;
      seenGroups.add(entry.group);
      if (entry.required !== true) {
        hasOptional = true;
        continue;
      }
      required.push(
        entries
          .filter(([, other]) => other.group === entry.group && other.hidden !== true)
          .map(([memberName, member]) => optionToken(memberName, member))
          .join("|"),
      );
    } else if (entry.required === true) {
      required.push(optionToken(name, entry));
    } else {
      hasOptional = true;
    }
  }
  return [...required, ...(hasOptional ? ["[options]"] : [])].join(" ");
}

/**
 * A command's usage line. The compact reference lines drop the `volli ` prefix
 * and spell out every option; command detail keeps `volli ` but folds optional
 * options into `[options]`.
 */
function usageLine(entry: CommandHelpEntry, mode: "reference" | "detail"): string {
  const id = entry.spec.positionalId
    ? entry.spec.positionalId.optional === true
      ? " [<id>]"
      : " <id>"
    : "";
  const opts =
    mode === "reference" ? fullOptionsUsage(entry.spec) : compactOptionsUsage(entry.spec);
  const extra = entry.spec.extraUsage ? ` ${entry.spec.extraUsage}` : "";
  const prefix = mode === "reference" ? "" : "volli ";
  return `${prefix}${entry.name}${id}${opts.length > 0 ? ` ${opts}` : ""}${extra}`;
}

/** The complete compact reference (`volli help` / bare `volli`), grouped and footered. */
export function bareHelpText(): string {
  const order = ["Read", "Write", "Session", "App"] as const;
  const sections = order.map((group) => {
    const lines = COMMAND_HELP.filter((entry) => entry.group === group).map(
      (entry) => `  ${usageLine(entry, "reference")}`,
    );
    return `${group}\n${lines.join("\n")}`;
  });
  return (
    "volli — self-documenting planning CLI for coding agents.\n\n" +
    `${sections.join("\n\n")}\n\n` +
    "Context: --project flag, then VOLLI_SESSION/VOLLI_TICKET, then a registered cwd.\n" +
    "Add --json to any command for structured output.\n" +
    "Ids: display ticket ids (VC-12); short session ids from session list.\n" +
    "volli help <command> for detail. Topics: exit-codes, addressing, json, orchestration.\n"
  );
}

/** Detail for one command: usage, every option, example, notes. */
function commandDetail(entry: CommandHelpEntry): string {
  const visible = Object.entries(entry.spec.options).filter(([, o]) => o.hidden !== true);
  const width = Math.max(0, ...visible.map(([name, o]) => optionToken(name, o).length));
  const lines = [
    `${entry.name} — ${entry.spec.summary}`,
    "",
    `Usage: ${usageLine(entry, "detail")}`,
  ];
  if (visible.length > 0) {
    lines.push("", "Options:");
    for (const [name, option] of visible) {
      const suffix = option.values !== undefined ? ` (${option.values})` : "";
      lines.push(`  ${optionToken(name, option).padEnd(width)}  ${option.help}${suffix}`);
    }
  }
  lines.push("", `Example: ${entry.spec.example}`);
  if (entry.spec.notes !== undefined && entry.spec.notes.length > 0) {
    lines.push("", "Notes:");
    for (const note of entry.spec.notes) lines.push(`- ${note}`);
  }
  return `${lines.join("\n")}\n`;
}

/** The command-group words (`ticket`, `session`, …) that have subcommands. */
function groupWords(): Set<string> {
  const words = new Set<string>();
  for (const entry of COMMAND_HELP) {
    const [first, second] = entry.name.split(" ");
    if (second !== undefined && first !== undefined) words.add(first);
  }
  return words;
}

/** `volli help ticket` → the one-line summaries of every `ticket <sub>` command. */
function groupDetail(word: string): string {
  const subcommands = COMMAND_HELP.filter((entry) => entry.name.startsWith(`${word} `));
  const width = Math.max(...subcommands.map((entry) => entry.name.length));
  const lines = subcommands.map((entry) => `  ${entry.name.padEnd(width)}  ${entry.spec.summary}`);
  return (
    `${word} subcommands:\n` +
    `${lines.join("\n")}\n` +
    `Run volli help ${word} <subcommand> for detail.\n`
  );
}

/** The longest command whose name words are a prefix of `path`, or null. */
function matchCommand(path: readonly string[]): CommandHelpEntry | null {
  let best: CommandHelpEntry | null = null;
  let bestLength = 0;
  for (const entry of COMMAND_HELP) {
    const words = entry.name.split(" ");
    if (words.length > path.length) continue;
    if (words.every((word, index) => word === path[index]) && words.length > bestLength) {
      best = entry;
      bestLength = words.length;
    }
  }
  return best;
}

/**
 * Resolves a `help` path into reference text: empty → the compact reference;
 * a command prefix → that command's detail; a group word → its subcommand list;
 * a single topic → the topic; anything else → the compact reference.
 */
export function renderHelp(rawPath: readonly string[]): string {
  // A quoted multi-word argument (`volli help "ticket create"`) must resolve
  // the same as separate words, so split every element on whitespace first.
  const path = rawPath.flatMap((part) => part.split(/\s+/)).filter((part) => part.length > 0);
  if (path.length === 0) return bareHelpText();
  const command = matchCommand(path);
  if (command !== null) return commandDetail(command);
  const first = path[0]!;
  if (groupWords().has(first)) return groupDetail(first);
  if (path.length === 1 && isTopic(first)) return topicText(first);
  return bareHelpText();
}
