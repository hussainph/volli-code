import {
  COLUMN_VOCABULARY,
  FIRST_CLASS_HARNESS_IDS,
  isTicketPriority,
  parseColumnToken,
  parseHarnessId,
  REASONING_LEVELS,
  TICKET_PRIORITIES,
} from "@volli/shared";

export interface CliInvocation {
  command: string;
  args: Record<string, unknown>;
  json: boolean;
}

/** The priority vocabulary rendered for teaching errors and help, derived from the domain source. */
export const PRIORITY_VOCABULARY: string = TICKET_PRIORITIES.join(", ");

/**
 * The harness vocabulary rendered for teaching errors and help. The four
 * first-class ids can be listed; a registered harness cannot, because its slug
 * is whatever its author called it and only the app knows which ones exist — so
 * the phrase names the category instead of pretending to enumerate it.
 */
export const HARNESS_VOCABULARY: string = `${FIRST_CLASS_HARNESS_IDS.join(", ")}, or a registered, trusted harness`;

export type CliParseResult =
  | { ok: true; invocation: CliInvocation }
  | { ok: false; code: "USAGE"; message: string };

function usage(message: string): CliParseResult {
  return { ok: false, code: "USAGE", message };
}

type ParsedValue = { ok: true; value: unknown } | { ok: false; message: string };

/** Transforms a raw flag value into the arg value stored under its key. */
type ValueParser = (raw: string, token: string) => ParsedValue;

const stringValue: ValueParser = (raw) => ({ ok: true, value: raw });

const priorityValue: ValueParser = (raw) =>
  isTicketPriority(raw)
    ? { ok: true, value: raw }
    : {
        ok: false,
        message: `Unknown priority ${JSON.stringify(raw)} (valid: ${PRIORITY_VOCABULARY})`,
      };

/**
 * Shape, and only shape. A first-class id and any well-formed registered slug
 * both pass, because whether a slug names a harness that exists — and whether a
 * human ever trusted it — is a fact about the app's registry, which this process
 * cannot read. Main refuses an unknown or untrusted one by name, so accepting
 * the shape here widens what can be TYPED, never what can launch.
 */
const harnessValue: ValueParser = (raw) => {
  const parsed = parseHarnessId(raw);
  return parsed === null
    ? {
        ok: false,
        message: `Invalid harness ${JSON.stringify(raw)} (valid: ${HARNESS_VOCABULARY})`,
      }
    : { ok: true, value: parsed };
};

/**
 * `--model` splits on the FIRST `/` into providerId/modelId: a provider id
 * never contains one, while a gateway-routed model id may. Whether the pair
 * names a model this profile can actually run is Model Access's judgement,
 * made in the app — the parser only vets the shape, exactly like `--harness`.
 */
const modelValue: ValueParser = (raw) => {
  const slash = raw.indexOf("/");
  const providerId = slash === -1 ? "" : raw.slice(0, slash);
  const modelId = slash === -1 ? "" : raw.slice(slash + 1);
  return providerId.length === 0 || modelId.length === 0
    ? {
        ok: false,
        message: `Invalid model ${JSON.stringify(raw)} (expected <provider>/<model>)`,
      }
    : { ok: true, value: { providerId, modelId } };
};

const reasoningValue: ValueParser = (raw) =>
  (REASONING_LEVELS as readonly string[]).includes(raw)
    ? { ok: true, value: raw }
    : {
        ok: false,
        message: `Unknown reasoning level ${JSON.stringify(raw)} (valid: ${REASONING_LEVELS.join(", ")})`,
      };

const columnValue: ValueParser = (raw) => {
  const result = parseColumnToken(raw);
  return result.ok ? { ok: true, value: result.status } : { ok: false, message: result.message };
};

const positiveIntValue: ValueParser = (raw, token) => {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0
    ? { ok: true, value: parsed }
    : { ok: false, message: `${token} requires a positive integer` };
};

/**
 * Help metadata every option carries so `volli help` renders from the same
 * table the parser walks (principle 2 — reference cannot drift from reality).
 * `help` is a one-line description; `placeholder` is the value shape shown in
 * usage lines (`<text>`, `<column>`, `low|medium|high`, `<old> <new>`);
 * `required` renders the option unbracketed; `hidden` suppresses an alias from
 * generated help; `group` collapses mutually exclusive options into one
 * `[a|b]` slot.
 */
interface OptionHelp {
  help: string;
  required?: boolean;
  hidden?: boolean;
  group?: string;
  /** Valid-value hint shown in command detail when the placeholder can't carry it (columns). */
  values?: string;
}

interface ValueOptionHelp extends OptionHelp {
  placeholder: string;
}

export type OptionEntry =
  | ({ kind: "flag"; key: string; value: unknown; bump?: string } & OptionHelp)
  | ({ kind: "value"; key: string; parse?: ValueParser; bump?: string } & ValueOptionHelp)
  | ({ kind: "repeated"; key: string; bump?: string } & ValueOptionHelp)
  | ({
      kind: "multi";
      count: number;
      missingMessage: string;
      /** Missing/flag-shaped parts are rejected before this runs, so it cannot fail. */
      build: (parts: readonly string[]) => Record<string, unknown>;
      bump?: string;
    } & ValueOptionHelp);

export interface CommandSpec {
  /** One-line description shown in the compact reference and command detail. */
  summary: string;
  /** One realistic invocation shown in command detail. */
  example: string;
  /** Short lines for semantics the option table can't express. */
  notes?: readonly string[];
  /**
   * When set, the first token of `rest` is consumed as the `<id>`. Required by
   * default; `optional: true` renders it as `[<id>]` and lets a missing (or
   * flag-shaped) first token fall through — the worktree commands default the
   * ticket to the caller's cwd, so an id is an override, not a requirement.
   */
  positionalId?: { label: string; optional?: boolean };
  /** Rendered after `<id>` in usage for positionals the option table can't express (help's `[<topic>]`). */
  extraUsage?: string;
  options: Readonly<Record<string, OptionEntry>>;
  /** Keys that must be present in `args` after the walk, each with its own message. */
  required?: Readonly<Record<string, string>>;
  /** Initial list args, applied before the walk (copied per call). */
  defaults?: Readonly<Record<string, readonly string[]>>;
  /** Post-walk validation/normalization; return an error message, or null when ok. */
  finalize?: (
    args: Record<string, unknown>,
    counters: Readonly<Record<string, number>>,
  ) => string | null;
}

/** The CLI-facing name for a dotted socket command (`ticket.create` → `ticket create`). */
function cliName(command: string): string {
  return command.replaceAll(".", " ");
}

/** Teaching error: an unknown option names the command's real options + a help pointer (principle 3). */
function unknownOptionMessage(command: string, token: string, spec: CommandSpec): string {
  const names = Object.keys(spec.options);
  const optionList = names.length > 0 ? ` (options: ${names.join(", ")})` : "";
  return `Unknown option ${token}${optionList} — see volli help ${cliName(command)}`;
}

/**
 * The one generic argv walker every Volli command's option table drives. A
 * value that is missing or looks like the *next* flag (starts with `--`) is
 * always rejected as a usage error instead of being silently swallowed as this
 * flag's value — a bare `-` or a negative number (`-5`) is a valid value and
 * passes through.
 */
function parseWithSpec(
  command: string,
  rest: readonly string[],
  spec: CommandSpec,
): CliParseResult {
  const args: Record<string, unknown> = {};
  if (spec.defaults) {
    for (const [key, value] of Object.entries(spec.defaults)) {
      args[key] = [...value];
    }
  }

  let index = 0;
  if (spec.positionalId) {
    const id = rest[0];
    const absent = id === undefined || id.startsWith("--");
    if (absent) {
      // An optional id simply falls through to the option walk; a required one
      // is a usage error.
      if (spec.positionalId.optional !== true) {
        return usage(`${spec.positionalId.label} requires <id>`);
      }
    } else {
      args["id"] = id;
      index = 1;
    }
  }

  let json = false;
  const counters: Record<string, number> = {};
  for (; index < rest.length; index += 1) {
    const token = rest[index]!;
    if (token === "--json") {
      json = true;
      continue;
    }
    const entry = spec.options[token];
    if (entry === undefined) return usage(unknownOptionMessage(command, token, spec));

    if (entry.kind === "flag") {
      args[entry.key] = entry.value;
    } else if (entry.kind === "multi") {
      const parts: string[] = [];
      for (let offset = 0; offset < entry.count; offset += 1) {
        const raw = rest[index + 1 + offset];
        if (raw === undefined || raw.startsWith("--")) return usage(entry.missingMessage);
        parts.push(raw);
      }
      Object.assign(args, entry.build(parts));
      index += entry.count;
    } else {
      const raw = rest[index + 1];
      if (raw === undefined || raw.startsWith("--")) return usage(`${token} requires a value`);
      index += 1;
      if (entry.kind === "repeated") {
        const list = (args[entry.key] as string[] | undefined) ?? [];
        list.push(raw);
        args[entry.key] = list;
      } else {
        const parsed = (entry.parse ?? stringValue)(raw, token);
        if (!parsed.ok) return usage(parsed.message);
        args[entry.key] = parsed.value;
      }
    }

    if (entry.bump) counters[entry.bump] = (counters[entry.bump] ?? 0) + 1;
  }

  if (spec.required) {
    for (const [key, message] of Object.entries(spec.required)) {
      if (!(key in args)) return usage(message);
    }
  }

  if (spec.finalize) {
    const error = spec.finalize(args, counters);
    if (error !== null) return usage(error);
  }

  return { ok: true, invocation: { command, args, json } };
}

const TICKET_CREATE_SPEC: CommandSpec = {
  summary: "Create a ticket (defaults to Backlog).",
  example: 'volli ticket create --title "Fix auth" --label bug',
  notes: [
    "Defaults to Backlog unless --status is set.",
    "--body and --body-file are mutually exclusive.",
  ],
  options: {
    "--title": {
      kind: "value",
      key: "title",
      placeholder: "<text>",
      help: "Ticket title.",
      required: true,
    },
    "--body": {
      kind: "value",
      key: "body",
      placeholder: "<text>",
      group: "body",
      help: "Body text.",
    },
    "--body-file": {
      kind: "value",
      key: "bodyFile",
      placeholder: "<path>",
      group: "body",
      help: "Body from a file.",
    },
    "--priority": {
      kind: "value",
      key: "priority",
      parse: priorityValue,
      placeholder: "low|medium|high",
      help: "Priority.",
    },
    "--status": {
      kind: "value",
      key: "status",
      parse: columnValue,
      placeholder: "<column>",
      values: `valid: ${COLUMN_VOCABULARY}`,
      help: "Initial column.",
    },
    "--label": {
      kind: "repeated",
      key: "labels",
      placeholder: "<name>",
      help: "Add label (repeatable).",
    },
    "--project": {
      kind: "value",
      key: "project",
      placeholder: "<p>",
      help: "Project (name/prefix/path).",
    },
    "--harness": {
      kind: "value",
      key: "harness",
      parse: harnessValue,
      placeholder: "<h>",
      help: "Harness id.",
      values: `valid: ${HARNESS_VOCABULARY}`,
    },
    "--base": { kind: "value", key: "base", placeholder: "<branch>", help: "Base branch." },
    "--no-worktree": {
      kind: "flag",
      key: "usesWorktree",
      value: false,
      help: "Skip worktree isolation.",
    },
  },
  finalize: (args) => {
    if (typeof args["title"] !== "string") return "ticket create requires --title";
    if ("body" in args && "bodyFile" in args) {
      return "ticket create accepts only one of --body or --body-file";
    }
    return null;
  },
};

const TICKET_UPDATE_SPEC: CommandSpec = {
  summary: "Update a ticket's fields or body.",
  example: 'volli ticket update VC-12 --edit "old" "new"',
  notes: ["At most one body mutation per call.", "--edit needs exactly one match for <old>."],
  positionalId: { label: "ticket update" },
  options: {
    "--title": { kind: "value", key: "title", placeholder: "<text>", help: "Replace the title." },
    "--body": {
      kind: "value",
      key: "bodyMutation",
      parse: (raw) => ({ ok: true, value: { mode: "replace", body: raw } }),
      bump: "bodyMode",
      placeholder: "<text>",
      group: "body",
      help: "Replace the body.",
    },
    "--body-file": {
      kind: "value",
      key: "bodyFile",
      bump: "bodyMode",
      placeholder: "<path>",
      group: "body",
      help: "Replace body from a file.",
    },
    "--append": {
      kind: "value",
      key: "bodyMutation",
      parse: (raw) => ({ ok: true, value: { mode: "append", text: raw } }),
      bump: "bodyMode",
      placeholder: "<text>",
      group: "body",
      help: "Append to the body.",
    },
    "--edit": {
      kind: "multi",
      count: 2,
      missingMessage: "--edit requires <old> and <new>",
      build: ([oldText, newText]) => ({ bodyMutation: { mode: "edit", oldText, newText } }),
      bump: "bodyMode",
      placeholder: "<old> <new>",
      group: "body",
      help: "Replace one <old> with <new>.",
    },
    "--priority": {
      kind: "value",
      key: "priority",
      parse: priorityValue,
      placeholder: "low|medium|high",
      help: "Set priority.",
    },
    "--add-label": {
      kind: "repeated",
      key: "addLabels",
      placeholder: "<name>",
      help: "Add label (repeatable).",
    },
    "--remove-label": {
      kind: "repeated",
      key: "removeLabels",
      placeholder: "<name>",
      help: "Remove label (repeatable).",
    },
    "--harness": {
      kind: "value",
      key: "harness",
      parse: harnessValue,
      placeholder: "<h>",
      help: "Set the harness.",
      values: `valid: ${HARNESS_VOCABULARY}`,
    },
    "--base": { kind: "value", key: "base", placeholder: "<branch>", help: "Set the base branch." },
  },
  defaults: { addLabels: [], removeLabels: [] },
  finalize: (_args, counters) =>
    (counters["bodyMode"] ?? 0) > 1 ? "ticket update accepts exactly one body mutation mode" : null,
};

const TICKET_COMMENT_SPEC: CommandSpec = {
  summary: "Add a comment to a ticket.",
  example: 'volli ticket comment VC-12 -m "Ready for review"',
  notes: ["Exactly one of -m or --file."],
  positionalId: { label: "ticket comment" },
  options: {
    "-m": {
      kind: "value",
      key: "message",
      placeholder: "<text>",
      group: "message",
      help: "Comment text.",
    },
    "--message": {
      kind: "value",
      key: "message",
      placeholder: "<text>",
      group: "message",
      hidden: true,
      help: "Alias for -m.",
    },
    "--file": {
      kind: "value",
      key: "file",
      placeholder: "<path>",
      group: "message",
      help: "Read the comment from a file.",
    },
  },
  finalize: (args) =>
    "message" in args === "file" in args
      ? "ticket comment requires exactly one of -m or --file"
      : null,
};

const NOTIFY_SPEC: CommandSpec = {
  summary: "Send a native notification to the user.",
  example: 'volli notify -m "Needs input"',
  options: {
    "-m": {
      kind: "value",
      key: "message",
      placeholder: "<text>",
      group: "message",
      required: true,
      help: "Notification body.",
    },
    "--message": {
      kind: "value",
      key: "message",
      placeholder: "<text>",
      group: "message",
      hidden: true,
      help: "Alias for -m.",
    },
    "--title": { kind: "value", key: "title", placeholder: "<text>", help: "Notification title." },
  },
  finalize: (args) => (!("message" in args) ? "notify requires -m" : null),
};

function sessionSignalSpec(
  summary: string,
  example: string,
  notes: readonly string[],
): CommandSpec {
  return {
    summary,
    example,
    notes,
    options: {
      "--reason": {
        kind: "value",
        key: "reason",
        placeholder: "<text>",
        help: "Human-readable reason.",
      },
    },
  };
}

const SESSION_DONE_SPEC = sessionSignalSpec(
  "Record that this session's work is finished.",
  'volli session done --reason "Tests pass"',
  [
    "Acts on VOLLI_SESSION; needs a Volli session.",
    "Records the signal in the session ledger; the board does not move. Use ticket move for that.",
  ],
);

const SESSION_BLOCKED_SPEC = sessionSignalSpec(
  "Signal the current session is blocked and needs a person.",
  'volli session blocked --reason "Needs credentials"',
  [
    "Acts on VOLLI_SESSION; needs a Volli session.",
    "Raises attention on this session; --reason is the text a person sees.",
  ],
);

/**
 * `volli session start <ticket>` — the attended-only start verb (VC-13). It
 * rides the app-owned product start route over the socket; the Pi runtime
 * lives in Electron main, so there is deliberately no headless path — with the
 * app closed this exits 3 (`volli app launch` is the recovery). The kickoff/
 * model/reasoning surface deliberately mirrors an Automation sending its
 * Instructions, so triggering Automations through the CLI can extend it later.
 */
const SESSION_START_SPEC: CommandSpec = {
  summary: "Start an agent chat session on a ticket.",
  example: 'volli session start VC-12 -m "Fix the flaky auth test"',
  notes: [
    "Runs in the app: attended-only, never headless; the board does not move.",
    "Submits a kickoff turn; -m replaces the default kickoff text and names the session.",
    "--title sets a permanent title; --model/--reasoning override the app default.",
  ],
  positionalId: { label: "session start" },
  options: {
    "-m": {
      kind: "value",
      key: "message",
      placeholder: "<text>",
      group: "message",
      help: "Kickoff message.",
    },
    "--message": {
      kind: "value",
      key: "message",
      placeholder: "<text>",
      group: "message",
      hidden: true,
      help: "Alias for -m.",
    },
    "--title": {
      kind: "value",
      key: "title",
      placeholder: "<text>",
      help: "Explicit session title.",
    },
    "--model": {
      kind: "value",
      key: "model",
      parse: modelValue,
      placeholder: "<provider/model>",
      help: "Model override.",
    },
    "--reasoning": {
      kind: "value",
      key: "reasoning",
      parse: reasoningValue,
      placeholder: "<level>",
      values: `valid: ${REASONING_LEVELS.join(", ")}`,
      help: "Reasoning level override.",
    },
  },
};

const SESSION_LINK_SPEC: CommandSpec = {
  summary: "Record the harness's own session id on the current Volli session.",
  example: "volli session link 4f1c9a2e-8b7d-4e5a-9c3f-2a1b0d6e5f4c",
  notes: [
    "Acts on VOLLI_SESSION; needs a Volli session.",
    "Seeds resume-on-re-entry; usually run from the harness's session-start hook.",
  ],
  positionalId: { label: "session link" },
  options: {},
};

/**
 * `volli session harness <slug> [--mint]` — the wrapper saying which harness is
 * now running in this terminal, and asking for the session id to launch it with.
 *
 * Involuntary, like `hook`: it is fired by the generated PATH shim one step
 * before it execs the harness, never typed by an agent and never read by a
 * human. So it is deliberately absent from {@link COMMAND_HELP} — the reference
 * is what an agent can usefully DO, and a verb whose only correct caller is a
 * file Volli generated is noise in it. It still walks the parser (unlike `hook`,
 * which bypasses it entirely) because it carries one ordinary positional and
 * has no reason to grow its own argv handling.
 *
 * With `--mint`, and only then, the reply is one bare uuid on stdout: the
 * wrapper captures it with `$(…)` and prepends it to the harness's argv, so
 * anything else printed there would reach the harness as a command-line word.
 */
const SESSION_HARNESS_SPEC: CommandSpec = {
  summary: "Record which harness is now running in the current Volli session.",
  example: "volli session harness claude-code",
  notes: [
    "Acts on VOLLI_SESSION; needs a Volli session.",
    "Fired by the harness's launch wrapper, not typed.",
  ],
  positionalId: { label: "session harness" },
  options: {
    "--mint": {
      kind: "flag",
      key: "mint",
      value: true,
      hidden: true,
      help: "Mint this launch's harness session id and print it.",
    },
  },
};

const TICKET_MOVE_SPEC: CommandSpec = {
  summary: "Move a ticket to another column.",
  example: "volli ticket move VC-12 --to needs-review",
  notes: ["Moving to the current column is a no-op."],
  positionalId: { label: "ticket move" },
  options: {
    "--to": {
      kind: "value",
      key: "to",
      parse: columnValue,
      placeholder: "<column>",
      values: `valid: ${COLUMN_VOCABULARY}`,
      required: true,
      help: "Destination column.",
    },
  },
  required: { to: "ticket move requires --to" },
};

const TICKET_LIST_SPEC: CommandSpec = {
  summary: "List a project's tickets, optionally filtered.",
  example: "volli ticket list --status doing --priority high",
  options: {
    "--status": {
      kind: "value",
      key: "status",
      parse: columnValue,
      placeholder: "<column>",
      values: `valid: ${COLUMN_VOCABULARY}`,
      help: "Filter by column.",
    },
    "--priority": {
      kind: "value",
      key: "priority",
      parse: priorityValue,
      placeholder: "low|medium|high",
      help: "Filter by priority.",
    },
    "--label": { kind: "value", key: "label", placeholder: "<name>", help: "Filter by label." },
    "--project": { kind: "value", key: "project", placeholder: "<p>", help: "Target project." },
    "--limit": {
      kind: "value",
      key: "limit",
      parse: positiveIntValue,
      placeholder: "<n>",
      help: "Cap the number of rows.",
    },
  },
};

const BOARD_SPEC: CommandSpec = {
  summary: "Show a project's board grouped by column.",
  example: "volli board --project VC",
  options: {
    "--project": { kind: "value", key: "project", placeholder: "<p>", help: "Target project." },
  },
};

const SESSION_LIST_SPEC: CommandSpec = {
  summary: "List a project's active terminal and chat sessions.",
  example: "volli session list --ticket VC-12",
  notes: ["Prints each session's title and short id; session peek takes either type."],
  options: {
    "--project": { kind: "value", key: "project", placeholder: "<p>", help: "Filter by project." },
    "--ticket": { kind: "value", key: "ticket", placeholder: "<id>", help: "Filter by ticket." },
  },
};

const LABEL_LIST_SPEC: CommandSpec = {
  summary: "List a project's labels.",
  example: "volli label list --project VC",
  options: {
    "--project": { kind: "value", key: "project", placeholder: "<p>", help: "Target project." },
  },
};

/**
 * `volli model list` — what `session start --model/--reasoning` can actually
 * name (VC-78). Reads the app's Model Access snapshot over the socket; the
 * default view is the signed-in slice because the full registered catalog is
 * over a thousand rows, which is the context-window failure mode this verb
 * exists to prevent.
 */
const MODEL_LIST_SPEC: CommandSpec = {
  summary: "List signed-in providers, model ids, and reasoning levels.",
  example: "volli model list",
  notes: [
    "Copy a printed <provider/model> verbatim into session start --model.",
    "Shows available models only; --all includes signed-out providers.",
  ],
  options: {
    "--all": {
      kind: "flag",
      key: "all",
      value: true,
      help: "Include signed-out providers and unavailable models.",
    },
  },
};

const APP_LAUNCH_SPEC: CommandSpec = {
  summary: "Launch the Volli app if it isn't already running.",
  example: "volli app launch",
  notes: ["Retry the failed command once the app is up."],
  options: {
    "--timeout": {
      kind: "value",
      key: "timeout",
      parse: positiveIntValue,
      placeholder: "<n>",
      help: "Seconds to wait for readiness.",
    },
  },
};

const TICKET_SHOW_SPEC: CommandSpec = {
  summary: "Show one ticket with recent events and comments.",
  example: "volli ticket show VC-12 --comments 5",
  positionalId: { label: "ticket show" },
  options: {
    "--events": {
      kind: "value",
      key: "events",
      parse: positiveIntValue,
      placeholder: "<n>",
      help: "How many recent events to include.",
    },
    "--comments": {
      kind: "value",
      key: "comments",
      parse: positiveIntValue,
      placeholder: "<n>",
      help: "How many recent comments to include.",
    },
  },
};

const TICKET_EVENTS_SPEC: CommandSpec = {
  summary: "Print a ticket's event log.",
  example: "volli ticket events VC-12 --limit 20",
  positionalId: { label: "ticket events" },
  options: {
    "--limit": {
      kind: "value",
      key: "limit",
      parse: positiveIntValue,
      placeholder: "<n>",
      help: "Cap the number of events.",
    },
  },
};

const WORKTREE_STATUS_SPEC: CommandSpec = {
  summary: "Show a ticket's worktree branch, base, and sync state.",
  example: "volli worktree status VC-12",
  notes: ["Read-only; defaults to the ticket owning the current directory."],
  positionalId: { label: "worktree status", optional: true },
  options: {},
};

const WORKTREE_DIFF_SPEC: CommandSpec = {
  summary: "Summarize a ticket's diff (the PR range by default).",
  example: "volli worktree diff VC-12 --working-tree",
  notes: [
    "Read-only; defaults to the ticket owning the current directory.",
    "Default range is the merge-base diff (what the PR would contain).",
    "--working-tree switches to the uncommitted working-tree view.",
  ],
  positionalId: { label: "worktree diff", optional: true },
  options: {
    "--working-tree": {
      kind: "flag",
      key: "workingTree",
      value: true,
      help: "Diff the uncommitted working tree instead of the PR range.",
    },
  },
};

const SESSION_PEEK_SPEC: CommandSpec = {
  summary: "Peek at what a session is doing: terminal output, or a chat's tail.",
  example: "volli session peek a1b2c3 --lines 60",
  notes: [
    "Handle is a short session id from session list — terminal or chat.",
    "A chat answers activity, last-event age, turn depth, then its transcript tail.",
    "--lines is trailing terminal lines (60), or chat messages (12).",
    "Keep peeks narrow — output consumes the caller's context.",
  ],
  positionalId: { label: "session peek" },
  options: {
    "--lines": {
      kind: "value",
      key: "lines",
      parse: positiveIntValue,
      placeholder: "<n>",
      help: "How much trailing output to show.",
    },
  },
};

const TICKET_ARCHIVE_SPEC: CommandSpec = {
  summary: "Archive a ticket (its worktree is preserved).",
  example: "volli ticket archive VC-12",
  positionalId: { label: "ticket archive" },
  options: {},
};

const TICKET_BRIEF_SPEC: CommandSpec = {
  summary: "Print the agent kickoff prompt for a ticket.",
  example: "volli ticket brief VC-12",
  positionalId: { label: "ticket brief" },
  options: {},
};

const IDENTIFY_SPEC: CommandSpec = {
  summary: "Resolve and print the active project, ticket, session, and session environment.",
  example: "volli identify",
  notes: [
    "The env block reports the session PATH, how it was adopted, where each contract tool (git, gh, node, pnpm) resolves, and whether workspace dependencies are installed — read it before running tools to probe for them.",
    "env.provenance is the boot adoption; env.interactiveProvenance is the later pass that picks up what your shell's interactive startup files export (nvm, bun, rbenv, pyenv, mise). `pending` there means that pass has not landed yet.",
  ],
  options: {
    "--project": {
      kind: "value",
      key: "project",
      placeholder: "<p>",
      help: "Resolve against this project instead of the context ladder.",
    },
  },
};

const PROJECT_LIST_SPEC: CommandSpec = {
  summary: "List all registered projects.",
  example: "volli project list",
  options: {},
};

const PROMPT_BASELINE_SPEC: CommandSpec = {
  summary: "Measure the prompt baseline a fresh chat Session starts with, per section.",
  example: "volli prompt baseline",
  notes: [
    "Token counts are estimates at 4 characters/token; the provider's own meter is the count of record.",
    "Excludes tool definitions, the user's first message, and provider overhead, which ride on top of everything counted here.",
    "--ticket prices a Ticket Session instead, including that ticket's Brief.",
  ],
  options: {
    "--ticket": {
      kind: "value",
      key: "ticket",
      placeholder: "<id>",
      help: "Price a Ticket Session for this ticket instead of a project chat.",
    },
    "--project": {
      kind: "value",
      key: "project",
      placeholder: "<p>",
      help: "Resolve against this project instead of the context ladder.",
    },
  },
};

const DOCTOR_SPEC: CommandSpec = {
  summary: "Audit the harness integration and report what it is actually doing.",
  example: "volli doctor --fix",
  notes: [
    "Reports outcomes, not configuration: whether typing a harness's name here really reaches Volli's wrapper.",
    "Run it inside a Volli terminal — several checks describe the shell it runs in.",
    "--fix regenerates the wrappers, harness configs and shell integration. Idempotent; it is the same work a boot does.",
  ],
  options: {
    "--fix": {
      kind: "flag",
      key: "fix",
      value: true,
      help: "Regenerate everything regenerable, then re-check.",
    },
  },
};

const HELP_SPEC: CommandSpec = {
  summary: "Show this reference, a command's help, or a topic.",
  example: "volli help ticket create",
  notes: ["Topics: exit-codes, addressing, json, orchestration."],
  extraUsage: "[<command> | <topic>]",
  options: {},
};

/** Every command, grouped for the compact reference and keyed by its CLI-facing name. */
export interface CommandHelpEntry {
  name: string;
  group: "Read" | "Write" | "Session" | "App";
  spec: CommandSpec;
}

/**
 * The single registry `volli help` renders from — one entry per command,
 * including `help` and `app launch`. Keeping the whole surface here means the
 * reference is generated from the same specs the parser walks (principle 2).
 */
export const COMMAND_HELP: readonly CommandHelpEntry[] = [
  { name: "identify", group: "Read", spec: IDENTIFY_SPEC },
  { name: "board", group: "Read", spec: BOARD_SPEC },
  { name: "ticket list", group: "Read", spec: TICKET_LIST_SPEC },
  { name: "ticket show", group: "Read", spec: TICKET_SHOW_SPEC },
  { name: "ticket events", group: "Read", spec: TICKET_EVENTS_SPEC },
  { name: "ticket brief", group: "Read", spec: TICKET_BRIEF_SPEC },
  { name: "worktree status", group: "Read", spec: WORKTREE_STATUS_SPEC },
  { name: "worktree diff", group: "Read", spec: WORKTREE_DIFF_SPEC },
  { name: "project list", group: "Read", spec: PROJECT_LIST_SPEC },
  { name: "label list", group: "Read", spec: LABEL_LIST_SPEC },
  { name: "model list", group: "Read", spec: MODEL_LIST_SPEC },
  { name: "ticket create", group: "Write", spec: TICKET_CREATE_SPEC },
  { name: "ticket update", group: "Write", spec: TICKET_UPDATE_SPEC },
  { name: "ticket move", group: "Write", spec: TICKET_MOVE_SPEC },
  { name: "ticket comment", group: "Write", spec: TICKET_COMMENT_SPEC },
  { name: "ticket archive", group: "Write", spec: TICKET_ARCHIVE_SPEC },
  { name: "session start", group: "Session", spec: SESSION_START_SPEC },
  { name: "session list", group: "Session", spec: SESSION_LIST_SPEC },
  { name: "session peek", group: "Session", spec: SESSION_PEEK_SPEC },
  { name: "session done", group: "Session", spec: SESSION_DONE_SPEC },
  { name: "session blocked", group: "Session", spec: SESSION_BLOCKED_SPEC },
  { name: "session link", group: "Session", spec: SESSION_LINK_SPEC },
  { name: "notify", group: "Session", spec: NOTIFY_SPEC },
  { name: "app launch", group: "App", spec: APP_LAUNCH_SPEC },
  { name: "prompt baseline", group: "App", spec: PROMPT_BASELINE_SPEC },
  { name: "doctor", group: "App", spec: DOCTOR_SPEC },
  { name: "help", group: "App", spec: HELP_SPEC },
];

/** Teaching error: an unrecognized command names the whole command list (principle 3). */
function unknownCommandMessage(): string {
  const names = COMMAND_HELP.map((entry) => entry.name).join(", ");
  return `Expected a Volli command (commands: ${names})`;
}

/** Parses argv into the versioned command shape sent over the Volli socket. */
export function parseCliArgs(argv: readonly string[]): CliParseResult {
  if (argv.includes("--help") || argv.includes("-h")) return helpFromFlag(argv);
  if (argv[0] === "identify") return parseWithSpec("identify", argv.slice(1), IDENTIFY_SPEC);
  if (argv[0] === "board") return parseWithSpec("board", argv.slice(1), BOARD_SPEC);
  if (argv[0] === "ticket" && argv[1] === "create") {
    return parseWithSpec("ticket.create", argv.slice(2), TICKET_CREATE_SPEC);
  }
  if (argv[0] === "ticket" && argv[1] === "update") {
    return parseWithSpec("ticket.update", argv.slice(2), TICKET_UPDATE_SPEC);
  }
  if (argv[0] === "ticket" && argv[1] === "list") {
    return parseWithSpec("ticket.list", argv.slice(2), TICKET_LIST_SPEC);
  }
  if (argv[0] === "ticket" && argv[1] === "move") {
    return parseWithSpec("ticket.move", argv.slice(2), TICKET_MOVE_SPEC);
  }
  if (argv[0] === "ticket" && argv[1] === "comment") {
    return parseWithSpec("ticket.comment", argv.slice(2), TICKET_COMMENT_SPEC);
  }
  if (argv[0] === "ticket" && argv[1] === "archive") {
    return parseWithSpec("ticket.archive", argv.slice(2), TICKET_ARCHIVE_SPEC);
  }
  if (argv[0] === "ticket" && argv[1] === "events") {
    return parseWithSpec("ticket.events", argv.slice(2), TICKET_EVENTS_SPEC);
  }
  if (argv[0] === "ticket" && argv[1] === "brief") {
    return parseWithSpec("ticket.brief", argv.slice(2), TICKET_BRIEF_SPEC);
  }
  if (argv[0] === "ticket" && argv[1] === "show") {
    return parseWithSpec("ticket.show", argv.slice(2), TICKET_SHOW_SPEC);
  }
  if (argv[0] === "worktree" && argv[1] === "status") {
    return parseWithSpec("worktree.status", argv.slice(2), WORKTREE_STATUS_SPEC);
  }
  if (argv[0] === "worktree" && argv[1] === "diff") {
    return parseWithSpec("worktree.diff", argv.slice(2), WORKTREE_DIFF_SPEC);
  }
  if (argv[0] === "session" && argv[1] === "start") {
    return parseWithSpec("session.start", argv.slice(2), SESSION_START_SPEC);
  }
  if (argv[0] === "session" && argv[1] === "peek") {
    return parseWithSpec("session.peek", argv.slice(2), SESSION_PEEK_SPEC);
  }
  if (argv[0] === "session" && argv[1] === "done") {
    return parseWithSpec("session.done", argv.slice(2), SESSION_DONE_SPEC);
  }
  if (argv[0] === "session" && argv[1] === "blocked") {
    return parseWithSpec("session.blocked", argv.slice(2), SESSION_BLOCKED_SPEC);
  }
  if (argv[0] === "session" && argv[1] === "link") {
    return parseWithSpec("session.link", argv.slice(2), SESSION_LINK_SPEC);
  }
  if (argv[0] === "session" && argv[1] === "harness") {
    return parseWithSpec("session.harness", argv.slice(2), SESSION_HARNESS_SPEC);
  }
  if (argv[0] === "session" && argv[1] === "list") {
    return parseWithSpec("session.list", argv.slice(2), SESSION_LIST_SPEC);
  }
  if (argv[0] === "project" && argv[1] === "list") {
    return parseWithSpec("project.list", argv.slice(2), PROJECT_LIST_SPEC);
  }
  if (argv[0] === "label" && argv[1] === "list") {
    return parseWithSpec("label.list", argv.slice(2), LABEL_LIST_SPEC);
  }
  if (argv[0] === "model" && argv[1] === "list") {
    return parseWithSpec("model.list", argv.slice(2), MODEL_LIST_SPEC);
  }
  if (argv[0] === "notify") return parseWithSpec("notify", argv.slice(1), NOTIFY_SPEC);
  if (argv[0] === "app" && argv[1] === "launch") {
    return parseWithSpec("app.launch", argv.slice(2), APP_LAUNCH_SPEC);
  }
  if (argv[0] === "prompt" && argv[1] === "baseline") {
    return parseWithSpec("prompt.baseline", argv.slice(2), PROMPT_BASELINE_SPEC);
  }
  if (argv[0] === "doctor") return parseWithSpec("doctor", argv.slice(1), DOCTOR_SPEC);
  if (argv[0] === "help") return parseHelp(argv.slice(1));
  return usage(unknownCommandMessage());
}

/** A `--help`/`-h` anywhere in argv resolves to help for the leading command prefix (exit 0). */
function helpFromFlag(argv: readonly string[]): CliParseResult {
  const path: string[] = [];
  for (const token of argv) {
    if (token === "--help" || token === "-h" || token.startsWith("-")) break;
    path.push(token);
  }
  return { ok: true, invocation: { command: "help", args: { path }, json: false } };
}

/** `help`'s command/topic positionals don't fit the flag-table model above. */
function parseHelp(argv: readonly string[]): CliParseResult {
  const path = argv.filter((token) => token !== "--json");
  return {
    ok: true,
    invocation: { command: "help", args: { path }, json: argv.includes("--json") },
  };
}
