import { AGENT_ERROR_CODES, cliVerbName, REFERENCE_VERBS, referenceVerbsFrom } from "@volli/shared";
import type { VerbEntry, VerbOption } from "@volli/shared";

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
function placeholderOf(option: VerbOption): string {
  return option.kind === "flag" ? "" : ` ${option.placeholder}`;
}

/** One option's `--name <value>` token as it appears in a usage line. */
function optionToken(option: VerbOption): string {
  return `${option.name}${placeholderOf(option)}`;
}

/** The members of one mutually exclusive option group, as one `a|b` alternation. */
function groupAlternation(entry: VerbEntry, group: string): string {
  return entry.options
    .filter((option) => option.group === group && option.hidden !== true)
    .map(optionToken)
    .join("|");
}

/**
 * The full bracketed option sequence for the compact reference: aliases hidden,
 * required options unbracketed, repeatable options suffixed `...`, and mutually
 * exclusive `group` members collapsed into one `[a|b]` slot.
 */
function fullOptionsUsage(entry: VerbEntry): string {
  const seenGroups = new Set<string>();
  const parts: string[] = [];
  for (const option of entry.options) {
    if (option.hidden === true) continue;
    if (option.group !== undefined) {
      if (seenGroups.has(option.group)) continue;
      seenGroups.add(option.group);
      const inner = groupAlternation(entry, option.group);
      parts.push(option.required === true ? inner : `[${inner}]`);
    } else if (option.required === true) {
      parts.push(optionToken(option));
    } else {
      const token = `[${optionToken(option)}]`;
      parts.push(option.kind === "repeated" ? `${token}...` : token);
    }
  }
  return parts.join(" ");
}

/**
 * The compact usage tail for command detail: required options spelled out, a
 * single `[options]` standing in for the optional ones (each fully described in
 * the Options table below, so the detail view never repeats itself).
 */
function compactOptionsUsage(entry: VerbEntry): string {
  const seenGroups = new Set<string>();
  const required: string[] = [];
  let hasOptional = false;
  for (const option of entry.options) {
    if (option.hidden === true) continue;
    if (option.group !== undefined) {
      if (seenGroups.has(option.group)) continue;
      seenGroups.add(option.group);
      if (option.required !== true) {
        hasOptional = true;
        continue;
      }
      required.push(groupAlternation(entry, option.group));
    } else if (option.required === true) {
      required.push(optionToken(option));
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
function usageLine(entry: VerbEntry, mode: "reference" | "detail"): string {
  const id =
    entry.positionalId === undefined ? "" : entry.positionalId === "optional" ? " [<id>]" : " <id>";
  const opts = mode === "reference" ? fullOptionsUsage(entry) : compactOptionsUsage(entry);
  const extra = entry.extraUsage === undefined ? "" : ` ${entry.extraUsage}`;
  const prefix = mode === "reference" ? "" : "volli ";
  return `${prefix}${cliVerbName(entry.key)}${id}${opts.length > 0 ? ` ${opts}` : ""}${extra}`;
}

/**
 * The complete compact reference (`volli help` / bare `volli`), grouped and
 * footered.
 *
 * Like every function here it takes the verbs it renders as an argument,
 * defaulting to the registry's own CLI-reference projection. That is what makes
 * this a projection rather than a second table: a synthetic entry can be pushed
 * through the renderer in a test without touching the real surface, and nothing
 * here can decide for itself which verbs exist.
 */
export function bareHelpText(entries: readonly VerbEntry[] = REFERENCE_VERBS): string {
  const referenceEntries = referenceVerbsFrom(entries);
  const order = ["Read", "Write", "Session", "App"] as const;
  const sections = order.map((group) => {
    const lines = referenceEntries
      .filter((entry) => entry.group === group)
      .map((entry) => `  ${usageLine(entry, "reference")}`);
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
function commandDetail(entry: VerbEntry): string {
  const visible = entry.options.filter((option) => option.hidden !== true);
  const width = Math.max(0, ...visible.map((option) => optionToken(option).length));
  const lines = [
    `${cliVerbName(entry.key)} — ${entry.summary}`,
    "",
    `Usage: ${usageLine(entry, "detail")}`,
  ];
  if (visible.length > 0) {
    lines.push("", "Options:");
    for (const option of visible) {
      const suffix = option.values !== undefined ? ` (${option.values})` : "";
      lines.push(`  ${optionToken(option).padEnd(width)}  ${option.help}${suffix}`);
    }
  }
  // A verb with no example is one nobody should ever type — `hook` is the
  // standing case — and such a verb is unlisted, so this line is missing only
  // for an entry that was never meant to reach a reader.
  if (entry.example !== undefined) lines.push("", `Example: ${entry.example}`);
  if (entry.notes !== undefined && entry.notes.length > 0) {
    lines.push("", "Notes:");
    for (const note of entry.notes) lines.push(`- ${note}`);
  }
  return `${lines.join("\n")}\n`;
}

/** The command-group words (`ticket`, `session`, …) that have subcommands. */
function groupWords(entries: readonly VerbEntry[]): Set<string> {
  const words = new Set<string>();
  for (const entry of entries) {
    const [first, second] = cliVerbName(entry.key).split(" ");
    if (second !== undefined && first !== undefined) words.add(first);
  }
  return words;
}

/** `volli help ticket` → the one-line summaries of every `ticket <sub>` command. */
function groupDetail(word: string, entries: readonly VerbEntry[]): string {
  const subcommands = entries
    .map((entry) => ({ name: cliVerbName(entry.key), summary: entry.summary }))
    .filter((subcommand) => subcommand.name.startsWith(`${word} `));
  const width = Math.max(...subcommands.map((subcommand) => subcommand.name.length));
  const lines = subcommands.map(
    (subcommand) => `  ${subcommand.name.padEnd(width)}  ${subcommand.summary}`,
  );
  return (
    `${word} subcommands:\n` +
    `${lines.join("\n")}\n` +
    `Run volli help ${word} <subcommand> for detail.\n`
  );
}

/** The longest command whose name words are a prefix of `path`, or null. */
function matchCommand(path: readonly string[], entries: readonly VerbEntry[]): VerbEntry | null {
  let best: VerbEntry | null = null;
  let bestLength = 0;
  for (const entry of entries) {
    const words = cliVerbName(entry.key).split(" ");
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
 *
 * Only the verbs it is given can be reached — an entry the registry keeps off
 * the CLI reference (the involuntary `hook` and `session harness`) has no path
 * that renders its detail, because it is not in this list at all.
 */
export function renderHelp(
  rawPath: readonly string[],
  entries: readonly VerbEntry[] = REFERENCE_VERBS,
): string {
  const referenceEntries = referenceVerbsFrom(entries);
  // A quoted multi-word argument (`volli help "ticket create"`) must resolve
  // the same as separate words, so split every element on whitespace first.
  const path = rawPath.flatMap((part) => part.split(/\s+/)).filter((part) => part.length > 0);
  if (path.length === 0) return bareHelpText(referenceEntries);
  const command = matchCommand(path, referenceEntries);
  if (command !== null) return commandDetail(command);
  const first = path[0]!;
  if (groupWords(referenceEntries).has(first)) return groupDetail(first, referenceEntries);
  if (path.length === 1 && isTopic(first)) return topicText(first);
  return bareHelpText(referenceEntries);
}
