import { isTicketPriority, parseColumnToken } from "@volli/shared";

export interface CliInvocation {
  command: string;
  args: Record<string, unknown>;
  json: boolean;
}

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
    : { ok: false, message: `Unknown priority ${JSON.stringify(raw)}` };

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
 * Declarative description of one command's argv options, driving the single
 * generic walker below. A value that is missing or looks like the *next*
 * flag (starts with `--`) is always rejected as a usage error instead of
 * being silently swallowed as this flag's value — a bare `-` or a negative
 * number (`-5`) is a valid value and passes through.
 */
type OptionEntry =
  | { kind: "flag"; key: string; value: unknown; bump?: string }
  | { kind: "value"; key: string; parse?: ValueParser; bump?: string }
  | { kind: "repeated"; key: string; bump?: string }
  | {
      kind: "multi";
      count: number;
      missingMessage: string;
      /** Missing/flag-shaped parts are rejected before this runs, so it cannot fail. */
      build: (parts: readonly string[]) => Record<string, unknown>;
      bump?: string;
    };

interface CommandSpec {
  /** When set, the first token of `rest` is consumed as the required `<id>`. */
  positionalId?: { label: string };
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

/** The one generic argv walker every Volli command's option table drives. */
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
    if (id === undefined || id.startsWith("--")) {
      return usage(`${spec.positionalId.label} requires <id>`);
    }
    args["id"] = id;
    index = 1;
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
    if (entry === undefined) return usage(`Unknown option ${token}`);

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
  options: {
    "--no-worktree": { kind: "flag", key: "usesWorktree", value: false },
    "--title": { kind: "value", key: "title" },
    "--project": { kind: "value", key: "project" },
    "--label": { kind: "repeated", key: "labels" },
    "--body": { kind: "value", key: "body" },
    "--body-file": { kind: "value", key: "bodyFile" },
    "--priority": { kind: "value", key: "priority", parse: priorityValue },
    "--harness": { kind: "value", key: "harness" },
    "--base": { kind: "value", key: "base" },
    "--status": { kind: "value", key: "status", parse: columnValue },
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
  positionalId: { label: "ticket update" },
  options: {
    "--priority": { kind: "value", key: "priority", parse: priorityValue },
    "--title": { kind: "value", key: "title" },
    "--body": {
      kind: "value",
      key: "bodyMutation",
      parse: (raw) => ({ ok: true, value: { mode: "replace", body: raw } }),
      bump: "bodyMode",
    },
    "--body-file": { kind: "value", key: "bodyFile", bump: "bodyMode" },
    "--append": {
      kind: "value",
      key: "bodyMutation",
      parse: (raw) => ({ ok: true, value: { mode: "append", text: raw } }),
      bump: "bodyMode",
    },
    "--edit": {
      kind: "multi",
      count: 2,
      missingMessage: "--edit requires <old> and <new>",
      build: ([oldText, newText]) => ({ bodyMutation: { mode: "edit", oldText, newText } }),
      bump: "bodyMode",
    },
    "--add-label": { kind: "repeated", key: "addLabels" },
    "--remove-label": { kind: "repeated", key: "removeLabels" },
    "--harness": { kind: "value", key: "harness" },
    "--base": { kind: "value", key: "base" },
  },
  defaults: { addLabels: [], removeLabels: [] },
  finalize: (_args, counters) =>
    (counters["bodyMode"] ?? 0) > 1 ? "ticket update accepts exactly one body mutation mode" : null,
};

const TICKET_COMMENT_SPEC: CommandSpec = {
  positionalId: { label: "ticket comment" },
  options: {
    "-m": { kind: "value", key: "message" },
    "--message": { kind: "value", key: "message" },
    "--file": { kind: "value", key: "file" },
  },
  finalize: (args) =>
    "message" in args === "file" in args
      ? "ticket comment requires exactly one of -m or --file"
      : null,
};

const NOTIFY_SPEC: CommandSpec = {
  options: {
    "-m": { kind: "value", key: "message" },
    "--message": { kind: "value", key: "message" },
    "--title": { kind: "value", key: "title" },
  },
  finalize: (args) => (!("message" in args) ? "notify requires -m" : null),
};

const SESSION_SIGNAL_SPEC: CommandSpec = {
  options: {
    "--reason": { kind: "value", key: "reason" },
  },
};

const TICKET_MOVE_SPEC: CommandSpec = {
  positionalId: { label: "ticket move" },
  options: {
    "--to": { kind: "value", key: "to", parse: columnValue },
  },
  required: { to: "ticket move requires --to" },
};

const TICKET_LIST_SPEC: CommandSpec = {
  options: {
    "--status": { kind: "value", key: "status", parse: columnValue },
    "--priority": { kind: "value", key: "priority", parse: priorityValue },
    "--label": { kind: "value", key: "label" },
    "--project": { kind: "value", key: "project" },
    "--limit": { kind: "value", key: "limit", parse: positiveIntValue },
  },
};

const BOARD_SPEC: CommandSpec = {
  options: { "--project": { kind: "value", key: "project" } },
};

const SESSION_LIST_SPEC: CommandSpec = {
  options: {
    "--project": { kind: "value", key: "project" },
    "--ticket": { kind: "value", key: "ticket" },
  },
};

const LABEL_LIST_SPEC: CommandSpec = {
  options: { "--project": { kind: "value", key: "project" } },
};

const APP_LAUNCH_SPEC: CommandSpec = {
  options: { "--timeout": { kind: "value", key: "timeout", parse: positiveIntValue } },
};

const TICKET_SHOW_SPEC: CommandSpec = {
  positionalId: { label: "ticket show" },
  options: {
    "--events": { kind: "value", key: "events", parse: positiveIntValue },
    "--comments": { kind: "value", key: "comments", parse: positiveIntValue },
  },
};

const TICKET_EVENTS_SPEC: CommandSpec = {
  positionalId: { label: "ticket events" },
  options: { "--limit": { kind: "value", key: "limit", parse: positiveIntValue } },
};

const SESSION_PEEK_SPEC: CommandSpec = {
  positionalId: { label: "session peek" },
  options: { "--lines": { kind: "value", key: "lines", parse: positiveIntValue } },
};

const TICKET_ARCHIVE_SPEC: CommandSpec = {
  positionalId: { label: "ticket archive" },
  options: {},
};

const TICKET_BRIEF_SPEC: CommandSpec = {
  positionalId: { label: "ticket brief" },
  options: {},
};

const NO_ARG_SPEC: CommandSpec = { options: {} };

/** Parses argv into the versioned command shape sent over the Volli socket. */
export function parseCliArgs(argv: readonly string[]): CliParseResult {
  if (argv[0] === "identify") return parseWithSpec("identify", argv.slice(1), NO_ARG_SPEC);
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
  if (argv[0] === "session" && argv[1] === "peek") {
    return parseWithSpec("session.peek", argv.slice(2), SESSION_PEEK_SPEC);
  }
  if (argv[0] === "session" && (argv[1] === "done" || argv[1] === "blocked")) {
    return parseWithSpec(`session.${argv[1]}`, argv.slice(2), SESSION_SIGNAL_SPEC);
  }
  if (argv[0] === "session" && argv[1] === "list") {
    return parseWithSpec("session.list", argv.slice(2), SESSION_LIST_SPEC);
  }
  if (argv[0] === "project" && argv[1] === "list") {
    return parseWithSpec("project.list", argv.slice(2), NO_ARG_SPEC);
  }
  if (argv[0] === "label" && argv[1] === "list") {
    return parseWithSpec("label.list", argv.slice(2), LABEL_LIST_SPEC);
  }
  if (argv[0] === "notify") return parseWithSpec("notify", argv.slice(1), NOTIFY_SPEC);
  if (argv[0] === "app" && argv[1] === "launch") {
    return parseWithSpec("app.launch", argv.slice(2), APP_LAUNCH_SPEC);
  }
  if (argv[0] === "help") return parseHelp(argv.slice(1));
  return usage("Expected a Volli command");
}

/** `help`'s bare topic positional doesn't fit the flag-table model above. */
function parseHelp(argv: readonly string[]): CliParseResult {
  const jsonIndex = argv.indexOf("--json");
  const json = jsonIndex !== -1;
  const positional = argv.filter((_, index) => index !== jsonIndex);
  if (positional.length > 1) return usage("help accepts at most one topic");
  return {
    ok: true,
    invocation: {
      command: "help",
      args: positional[0] === undefined ? {} : { topic: positional[0] },
      json,
    },
  };
}
