import {
  AGENT_CAPABILITY_BASELINE,
  AGENT_CAPABILITY_CHANGES,
  AGENT_CONCEPT_SECTIONS,
  AGENT_ERROR_CODES,
  cliVerbName,
  DISCOVERABLE_VERBS,
  ERROR_RECOVERY,
  HELP_TOPIC_NAMES,
  makeAgentError,
  referenceVerbsFrom,
  verbTier,
} from "@volli/shared";
import type {
  AgentBuildIdentity,
  AgentError,
  AgentHelpRuntime,
  HelpTopicName,
  VerbEntry,
  VerbOption,
} from "@volli/shared";

import { CLI_BUILD_IDENTITY } from "./build-identity";
import { exitCodeForError } from "./render";

const EXIT_CLASS_LABEL = {
  1: "1 failure",
  2: "2 usage",
  3: "3 app unreachable (retryable)",
} as const;

const STATIC_RUNTIME: AgentHelpRuntime = {
  appVersion: null,
  surface: null,
  surfaceUnknownReason: null,
};

export interface HelpRenderOptions {
  identity?: AgentBuildIdentity;
  runtime?: AgentHelpRuntime;
}

export type HelpResolution = { ok: true; text: string } | { ok: false; error: AgentError };

function isTopic(value: string): value is HelpTopicName {
  return (HELP_TOPIC_NAMES as readonly string[]).includes(value);
}

/** The stable error vocabulary plus its canonical reason and recovery contract. */
function exitCodesText(): string {
  const width = Math.max(...AGENT_ERROR_CODES.map((code) => code.length));
  const rows = AGENT_ERROR_CODES.flatMap((code) => {
    const guidance = ERROR_RECOVERY[code];
    const next = guidance.next ?? "No safe retry is known; inspect current durable state first.";
    return [
      `  ${code.padEnd(width)}  ${EXIT_CLASS_LABEL[exitCodeForError(code)]}`,
      `    Why: ${guidance.why}`,
      `    Next: ${next}`,
    ];
  });
  return (
    "Exit codes: 0 ok; 1 failure; 2 usage; 3 app unreachable (retryable).\n\n" +
    "Error codes:\n" +
    `${rows.join("\n")}\n`
  );
}

function conceptsText(): string {
  const lines = ["Volli operating model"];
  for (const section of AGENT_CONCEPT_SECTIONS) {
    lines.push("", section.heading);
    for (const paragraph of section.paragraphs) lines.push(paragraph);
    for (const bullet of section.bullets ?? []) lines.push(`- ${bullet}`);
  }
  return `${lines.join("\n")}\n`;
}

function capabilityLines(label: string, values: readonly string[]): string[] {
  return [
    label,
    ...(values.length === 0 ? ["- None in this record."] : values.map((v) => `- ${v}`)),
  ];
}

function changesText(identity: AgentBuildIdentity, runtime: AgentHelpRuntime): string {
  const lines = [
    "Volli Agent CLI capability changes",
    "",
    "Bundle identity",
    `  CLI package: @volli/cli ${identity.cliVersion}`,
    `  Release promotion marker: ${identity.releaseVersion}`,
    `  Source revision: ${identity.sourceRevision}`,
    `  Build id: ${identity.buildId}`,
    `  Running app: ${runtime.appVersion ?? "not reached (static help remains available)"}`,
    `  Capability baseline: ${AGENT_CAPABILITY_BASELINE}`,
  ];
  for (const change of AGENT_CAPABILITY_CHANGES) {
    lines.push("", `${change.build} (after ${change.baseline})`);
    lines.push(...capabilityLines("Added", change.added));
    lines.push(...capabilityLines("Changed", change.changed));
    lines.push(...capabilityLines("Fixed", change.fixed));
    lines.push(...capabilityLines("Removed", change.removed));
  }
  return `${lines.join("\n")}\n`;
}

function topicText(topic: HelpTopicName, options: HelpRenderOptions): string {
  if (topic === "concepts") return conceptsText();
  if (topic === "changes") {
    return changesText(options.identity ?? CLI_BUILD_IDENTITY, options.runtime ?? STATIC_RUNTIME);
  }
  if (topic === "exit-codes") return exitCodesText();
  if (topic === "json") {
    return "Pass --json to any command for stable structured JSON output. Failures keep a stable code and add reason plus next; next is null when Volli cannot name a safe action. Dry-run plans use one versioned object shape on CLI and tool doors.\n";
  }
  if (topic === "addressing") {
    return "Context ladder: explicit --project flag, then VOLLI_SESSION/VOLLI_TICKET, then a registered cwd. Volli never guesses; ambiguity is an error. VOLLI_SESSION attributes the current socket caller in this build; it does not authenticate that process.\n";
  }
  return "Read before writing; work your own board unless instructed; use comments and deliberate moves for coordination; do not drive another Session's terminal or chain-spawn work.\n";
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

/** Full usage for compact reference rows. */
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

/** Required options plus one optional-options marker for command detail. */
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

function usageLine(entry: VerbEntry, mode: "reference" | "detail"): string {
  const id =
    entry.positionalId === undefined ? "" : entry.positionalId === "optional" ? " [<id>]" : " <id>";
  const opts = mode === "reference" ? fullOptionsUsage(entry) : compactOptionsUsage(entry);
  const extra = entry.extraUsage === undefined ? "" : ` ${entry.extraUsage}`;
  const prefix = mode === "reference" ? "" : "volli ";
  return `${prefix}${cliVerbName(entry.key)}${id}${opts.length > 0 ? ` ${opts}` : ""}${extra}`;
}

function doorLabel(entry: VerbEntry): string {
  const cli = entry.accessModes.includes("cli");
  const tool = entry.accessModes.includes("tool");
  if (cli && tool) return "Agent CLI and Agent Tool Surface";
  if (cli) return "Agent CLI";
  if (tool) return "Agent Tool Surface (named tool; not shell-executable)";
  // `hostApi` needs no door word yet: `verbTier` refuses a hostApi-only entry
  // until the External Agent Surface defines its governance, so command detail
  // cannot render one. The surface that lifts that refusal names its own door.
  return "app only (no agent door)";
}

function runtimeSurfaceLines(runtime: AgentHelpRuntime): string[] {
  if (runtime.surface !== null) {
    return [
      `Resolved Session Role: ${runtime.surface.role}`,
      `Frozen Agent Tool Surface: ${runtime.surface.tools.length === 0 ? "(empty)" : runtime.surface.tools.join(", ")}`,
    ];
  }
  if (runtime.surfaceUnknownReason !== null) {
    return [
      `Session Role and frozen Agent Tool Surface: unknown (${runtime.surfaceUnknownReason})`,
    ];
  }
  return ["Session Role availability: not claimed outside a resolved Session."];
}

function toolAvailability(entry: VerbEntry, runtime: AgentHelpRuntime): string | null {
  if (!entry.accessModes.includes("tool") || entry.accessModes.includes("cli")) return null;
  if (runtime.surface !== null) {
    return runtime.surface.tools.includes(entry.key)
      ? `Role availability: carried by this ${runtime.surface.role} Session's frozen bundle.`
      : `Role availability: not carried by this ${runtime.surface.role} Session's frozen bundle.`;
  }
  return runtime.surfaceUnknownReason === null
    ? "Role availability: not claimed outside a resolved Session."
    : `Role availability: unknown (${runtime.surfaceUnknownReason}).`;
}

/** The complete compact shell reference plus honest discovery of non-shell doors. */
export function bareHelpText(
  entries: readonly VerbEntry[] = DISCOVERABLE_VERBS,
  options: HelpRenderOptions = {},
): string {
  const discoverable = entries.filter((entry) => entry.listed);
  const shellEntries = referenceVerbsFrom(discoverable);
  const order = ["Read", "Write", "Session", "App"] as const;
  const sections = order.map((group) => {
    const lines = shellEntries
      .filter((entry) => entry.group === group)
      .map((entry) => `  ${usageLine(entry, "reference")}`);
    return `${group}\n${lines.length === 0 ? "  (none)" : lines.join("\n")}`;
  });
  const tools = discoverable.filter(
    (entry) => entry.accessModes.includes("tool") && !entry.accessModes.includes("cli"),
  );
  const appOnly = discoverable.filter((entry) => entry.accessModes.length === 0);
  const toolLines =
    tools.length === 0
      ? ["  (no registry-projected tool-only verbs in this build)"]
      : tools.map((entry) => `  ${cliVerbName(entry.key)}  ${entry.summary}`);
  const appLines = appOnly.map((entry) => `  ${cliVerbName(entry.key)}  ${entry.summary}`);
  const runtime = options.runtime ?? STATIC_RUNTIME;
  return (
    "volli — self-documenting planning CLI for coding agents.\n\n" +
    `${sections.join("\n\n")}\n\n` +
    `Agent Tool Surface\n${toolLines.join("\n")}\n` +
    `${appLines.length === 0 ? "" : `\nApp-only verbs\n${appLines.join("\n")}\n`}` +
    `${runtimeSurfaceLines(runtime).join("\n")}\n\n` +
    "Context: --project flag, then VOLLI_SESSION/VOLLI_TICKET, then a registered cwd.\n" +
    "Add --json to any command for structured output. Add --dry-run to a documented write to preview it.\n" +
    "Ids: display ticket ids (VC-12); short session ids from session list.\n" +
    `volli help <command> for detail. Topics: ${HELP_TOPIC_NAMES.join(", ")}.\n`
  );
}

/** Detail for one verb: usage, door, tier, options, effects, example, and notes. */
function commandDetail(entry: VerbEntry, runtime: AgentHelpRuntime): string {
  const visible = entry.options.filter((option) => option.hidden !== true);
  const width = Math.max(0, ...visible.map((option) => optionToken(option).length));
  const tier = verbTier(entry);
  const lines = [
    `${cliVerbName(entry.key)} — ${entry.summary}`,
    "",
    `Door: ${doorLabel(entry)}`,
    `Verb tier: ${tier ?? "none"}`,
  ];
  const availability = toolAvailability(entry, runtime);
  if (availability !== null) lines.push(availability);
  lines.push("", `Usage: ${usageLine(entry, "detail")}`);
  if (visible.length > 0) {
    lines.push("", "Options:");
    for (const option of visible) {
      const suffix = option.values !== undefined ? ` (${option.values})` : "";
      lines.push(`  ${optionToken(option).padEnd(width)}  ${option.help}${suffix}`);
    }
  }
  if (entry.effects !== undefined) {
    lines.push("", entry.effects.when ? `Effects (${entry.effects.when}):` : "Effects:");
    if (entry.effects.durableWrites.length === 0) lines.push("- Durable writes: none.");
    for (const write of entry.effects.durableWrites) {
      lines.push(`- Durable write: ${write.summary}`);
    }
    for (const effect of entry.effects.humanVisible) lines.push(`- Human sees: ${effect}`);
    for (const nonEffect of entry.effects.nonEffects) lines.push(`- Does not: ${nonEffect}`);
  }
  if (entry.example !== undefined) lines.push("", `Example: ${entry.example}`);
  if (entry.notes !== undefined && entry.notes.length > 0) {
    lines.push("", "Notes:");
    for (const note of entry.notes) lines.push(`- ${note}`);
  }
  return `${lines.join("\n")}\n`;
}

function groupWords(entries: readonly VerbEntry[]): Set<string> {
  const words = new Set<string>();
  for (const entry of entries) {
    const [first, second] = cliVerbName(entry.key).split(" ");
    if (second !== undefined && first !== undefined) words.add(first);
  }
  return words;
}

function groupDetail(word: string, entries: readonly VerbEntry[]): string {
  const subcommands = entries
    .map((entry) => ({
      name: cliVerbName(entry.key),
      summary: entry.summary,
      door: doorLabel(entry),
    }))
    .filter((subcommand) => subcommand.name.startsWith(`${word} `));
  const width = Math.max(...subcommands.map((subcommand) => subcommand.name.length));
  const lines = subcommands.map(
    (subcommand) =>
      `  ${subcommand.name.padEnd(width)}  ${subcommand.summary} [${subcommand.door}]`,
  );
  return (
    `${word} subcommands:\n` +
    `${lines.join("\n")}\n` +
    `Run volli help ${word} <subcommand> for detail.\n`
  );
}

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

/** Only reachable with a non-empty path: `resolveHelp` answers `[]` with bare help. */
function unknownHelpError(path: readonly string[], entries: readonly VerbEntry[]): AgentError {
  const commands = entries.map((entry) => cliVerbName(entry.key)).join(", ");
  const topics = HELP_TOPIC_NAMES.join(", ");
  return makeAgentError(
    "USAGE",
    `Unknown help path ${JSON.stringify(path.join(" "))} (commands: ${commands}; topics: ${topics}).`,
    "Run `volli help`, then ask for one listed command or topic.",
  );
}

/** Resolves help without silently treating an unknown path as bare help. */
export function resolveHelp(
  rawPath: readonly string[],
  entries: readonly VerbEntry[] = DISCOVERABLE_VERBS,
  options: HelpRenderOptions = {},
): HelpResolution {
  const discoverable = entries.filter((entry) => entry.listed);
  const path = rawPath.flatMap((part) => part.split(/\s+/)).filter((part) => part.length > 0);
  if (path.length === 0) return { ok: true, text: bareHelpText(discoverable, options) };
  const command = matchCommand(path, discoverable);
  if (command !== null) {
    return { ok: true, text: commandDetail(command, options.runtime ?? STATIC_RUNTIME) };
  }
  const first = path[0]!;
  if (groupWords(discoverable).has(first)) {
    return { ok: true, text: groupDetail(first, discoverable) };
  }
  if (path.length === 1 && isTopic(first)) {
    return { ok: true, text: topicText(first, options) };
  }
  return { ok: false, error: unknownHelpError(path, discoverable) };
}

/** Convenience for known paths used by source projections and tests. */
export function renderHelp(
  rawPath: readonly string[],
  entries: readonly VerbEntry[] = DISCOVERABLE_VERBS,
  options: HelpRenderOptions = {},
): string {
  const resolved = resolveHelp(rawPath, entries, options);
  if (!resolved.ok) throw new Error(resolved.error.reason);
  return resolved.text;
}
