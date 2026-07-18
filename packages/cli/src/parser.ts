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

/**
 * Reads the flag value at `argv[index + 1]`. A missing value or a value that
 * looks like the *next* flag (starts with `--`) is rejected as a usage error
 * instead of being silently swallowed as this flag's value — a bare `-` or a
 * negative number (`-5`) is a valid value and passes through.
 */
function requireValue(
  argv: readonly string[],
  index: number,
  token: string,
): string | CliParseResult {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) return usage(`${token} requires a value`);
  return value;
}

/** Parses argv into the versioned command shape sent over the Volli socket. */
export function parseCliArgs(argv: readonly string[]): CliParseResult {
  if (argv[0] === "identify") return parseNoArgCommand("identify", argv.slice(1));
  if (argv[0] === "board") {
    return parseKeyValueCommand("board", argv.slice(1), { "--project": "project" });
  }
  if (argv[0] === "ticket" && argv[1] === "update") return parseTicketUpdate(argv);
  if (argv[0] === "ticket" && argv[1] === "list") return parseTicketList(argv);
  if (argv[0] === "ticket" && argv[1] === "move") return parseTicketMove(argv);
  if (argv[0] === "ticket" && argv[1] === "comment") return parseTicketComment(argv);
  if (argv[0] === "ticket" && argv[1] === "archive") {
    return parseIdOnlyCommand("ticket.archive", argv);
  }
  if (argv[0] === "ticket" && argv[1] === "events") {
    return parseIdWithNumberOptions("ticket.events", argv, { "--limit": "limit" });
  }
  if (argv[0] === "ticket" && argv[1] === "brief") {
    return parseIdOnlyCommand("ticket.brief", argv);
  }
  if (argv[0] === "ticket" && argv[1] === "show") {
    return parseIdWithNumberOptions("ticket.show", argv, {
      "--events": "events",
      "--comments": "comments",
    });
  }
  if (argv[0] === "session" && argv[1] === "peek") {
    return parseIdWithNumberOptions("session.peek", argv, { "--lines": "lines" });
  }
  if (argv[0] === "session" && (argv[1] === "done" || argv[1] === "blocked")) {
    return parseSessionSignal(argv[1], argv.slice(2));
  }
  if (argv[0] === "session" && argv[1] === "list") {
    return parseKeyValueCommand("session.list", argv.slice(2), {
      "--project": "project",
      "--ticket": "ticket",
    });
  }
  if (argv[0] === "project" && argv[1] === "list") {
    return parseNoArgCommand("project.list", argv.slice(2));
  }
  if (argv[0] === "label" && argv[1] === "list") {
    return parseKeyValueCommand("label.list", argv.slice(2), { "--project": "project" });
  }
  if (argv[0] === "notify") return parseNotify(argv.slice(1));
  if (argv[0] === "app" && argv[1] === "launch") {
    return parseKeyValueCommand("app.launch", argv.slice(2), { "--timeout": "timeout" }, [
      "--timeout",
    ]);
  }
  if (argv[0] === "help") return parseHelp(argv.slice(1));
  if (argv[0] !== "ticket" || argv[1] !== "create") return usage("Expected a Volli command");

  const args: Record<string, unknown> = {
    labels: [],
    usesWorktree: true,
  };
  let json = false;
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "--no-worktree") {
      args["usesWorktree"] = false;
      continue;
    }
    const value = requireValue(argv, index, token);
    if (typeof value !== "string") return value;
    index += 1;
    if (token === "--title") args["title"] = value;
    else if (token === "--project") args["project"] = value;
    else if (token === "--label") (args["labels"] as string[]).push(value);
    else if (token === "--body") args["body"] = value;
    else if (token === "--body-file") args["bodyFile"] = value;
    else if (token === "--priority") {
      if (!isTicketPriority(value)) return usage(`Unknown priority ${JSON.stringify(value)}`);
      args["priority"] = value;
    } else if (token === "--harness") args["harness"] = value;
    else if (token === "--base") args["base"] = value;
    else if (token === "--status") {
      const status = parseColumnToken(value);
      if (!status.ok) return usage(status.message);
      args["status"] = status.status;
    } else return usage(`Unknown option ${token}`);
  }

  if (typeof args["title"] !== "string") return usage("ticket create requires --title");
  if ("body" in args && "bodyFile" in args) {
    return usage("ticket create accepts only one of --body or --body-file");
  }
  args["status"] ??= "backlog";

  return { ok: true, invocation: { command: "ticket.create", args, json } };
}

function parseKeyValueCommand(
  command: string,
  argv: readonly string[],
  options: Readonly<Record<string, string>>,
  numericOptions: readonly string[] = [],
): CliParseResult {
  const args: Record<string, unknown> = {};
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--json") {
      json = true;
      continue;
    }
    const key = options[token];
    if (key === undefined) return usage(`Unknown option ${token}`);
    const value = requireValue(argv, index, token);
    if (typeof value !== "string") return value;
    if (numericOptions.includes(token)) {
      const parsed = positiveInteger(value, token);
      if (typeof parsed !== "number") return parsed;
      args[key] = parsed;
    } else args[key] = value;
    index += 1;
  }
  return { ok: true, invocation: { command, args, json } };
}

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

function parseIdOnlyCommand(command: string, argv: readonly string[]): CliParseResult {
  const id = argv[2];
  if (id === undefined || id.startsWith("--")) return usage(`${argv[0]} ${argv[1]} requires <id>`);
  const extras = argv.slice(3);
  const json = extras.length === 1 && extras[0] === "--json";
  if (extras.length > 0 && !json) return usage(`Unknown option ${extras[0]}`);
  return { ok: true, invocation: { command, args: { id }, json } };
}

function parseTicketComment(argv: readonly string[]): CliParseResult {
  const id = argv[2];
  if (id === undefined || id.startsWith("--")) return usage("ticket comment requires <id>");
  const args: Record<string, unknown> = { id };
  let json = false;
  for (let index = 3; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--json") {
      json = true;
      continue;
    }
    const value = requireValue(argv, index, token);
    if (typeof value !== "string") return value;
    if (token === "-m" || token === "--message") args["message"] = value;
    else if (token === "--file") args["file"] = value;
    else return usage(`Unknown option ${token}`);
    index += 1;
  }
  if ("message" in args === "file" in args) {
    return usage("ticket comment requires exactly one of -m or --file");
  }
  return { ok: true, invocation: { command: "ticket.comment", args, json } };
}

function parseSessionSignal(signal: "done" | "blocked", argv: readonly string[]): CliParseResult {
  const args: Record<string, unknown> = {};
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token !== "--reason") return usage(`Unknown option ${token}`);
    const value = requireValue(argv, index, token);
    if (typeof value !== "string") return value;
    args["reason"] = value;
    index += 1;
  }
  return { ok: true, invocation: { command: `session.${signal}`, args, json } };
}

function parseNotify(argv: readonly string[]): CliParseResult {
  const args: Record<string, unknown> = {};
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--json") {
      json = true;
      continue;
    }
    const value = requireValue(argv, index, token);
    if (typeof value !== "string") return value;
    if (token === "-m" || token === "--message") args["message"] = value;
    else if (token === "--title") args["title"] = value;
    else return usage(`Unknown option ${token}`);
    index += 1;
  }
  if (!("message" in args)) return usage("notify requires -m");
  return { ok: true, invocation: { command: "notify", args, json } };
}

function parseNoArgCommand(command: string, argv: readonly string[]): CliParseResult {
  if (argv.length === 0) return { ok: true, invocation: { command, args: {}, json: false } };
  if (argv.length === 1 && argv[0] === "--json") {
    return { ok: true, invocation: { command, args: {}, json: true } };
  }
  return usage(`Unknown option ${argv[0]}`);
}

function parseIdWithNumberOptions(
  command: string,
  argv: readonly string[],
  options: Readonly<Record<string, string>>,
): CliParseResult {
  const id = argv[2];
  if (id === undefined || id.startsWith("--")) return usage(`${argv[0]} ${argv[1]} requires <id>`);
  const args: Record<string, unknown> = { id };
  let json = false;
  for (let index = 3; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--json") {
      json = true;
      continue;
    }
    const target = options[token];
    if (target === undefined) return usage(`Unknown option ${token}`);
    const value = requireValue(argv, index, token);
    if (typeof value !== "string") return value;
    const parsed = positiveInteger(value, token);
    if (typeof parsed !== "number") return parsed;
    args[target] = parsed;
    index += 1;
  }
  return { ok: true, invocation: { command, args, json } };
}

function parseTicketMove(argv: readonly string[]): CliParseResult {
  const id = argv[2];
  if (id === undefined || id.startsWith("--")) return usage("ticket move requires <id>");
  if (argv[3] !== "--to") return usage("ticket move requires --to");
  const to = requireValue(argv, 3, "--to");
  if (typeof to !== "string") return to;
  const parsed = parseColumnToken(to);
  if (!parsed.ok) return usage(parsed.message);
  const extras = argv.slice(5);
  const json = extras.length === 1 && extras[0] === "--json";
  if (extras.length > 0 && !json) return usage(`Unknown option ${extras[0]}`);
  return {
    ok: true,
    invocation: { command: "ticket.move", args: { id, to: parsed.status }, json },
  };
}

function positiveInteger(value: string, option: string): number | CliParseResult {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0
    ? parsed
    : usage(`${option} requires a positive integer`);
}

function parseTicketList(argv: readonly string[]): CliParseResult {
  const args: Record<string, unknown> = {};
  let json = false;
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--json") {
      json = true;
      continue;
    }
    const value = requireValue(argv, index, token);
    if (typeof value !== "string") return value;
    index += 1;
    if (token === "--status") {
      const status = parseColumnToken(value);
      if (!status.ok) return usage(status.message);
      args["status"] = status.status;
    } else if (token === "--priority") {
      if (!isTicketPriority(value)) return usage(`Unknown priority ${JSON.stringify(value)}`);
      args["priority"] = value;
    } else if (token === "--label") args["label"] = value;
    else if (token === "--project") args["project"] = value;
    else if (token === "--limit") {
      const limit = positiveInteger(value, token);
      if (typeof limit !== "number") return limit;
      args["limit"] = limit;
    } else return usage(`Unknown option ${token}`);
  }
  return { ok: true, invocation: { command: "ticket.list", args, json } };
}

function parseTicketUpdate(argv: readonly string[]): CliParseResult {
  const id = argv[2];
  if (id === undefined || id.startsWith("--")) return usage("ticket update requires <id>");
  const args: Record<string, unknown> = { id, addLabels: [], removeLabels: [] };
  let json = false;
  let bodyModeCount = 0;
  for (let index = 3; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "--edit") {
      const oldText = argv[index + 1];
      const newText = argv[index + 2];
      if (
        oldText === undefined ||
        oldText.startsWith("--") ||
        newText === undefined ||
        newText.startsWith("--")
      ) {
        return usage("--edit requires <old> and <new>");
      }
      args["bodyMutation"] = { mode: "edit", oldText, newText };
      bodyModeCount += 1;
      index += 2;
      continue;
    }
    const value = requireValue(argv, index, token);
    if (typeof value !== "string") return value;
    index += 1;
    if (token === "--priority") {
      if (!isTicketPriority(value)) return usage(`Unknown priority ${JSON.stringify(value)}`);
      args["priority"] = value;
    } else if (token === "--title") args["title"] = value;
    else if (token === "--body") {
      args["bodyMutation"] = { mode: "replace", body: value };
      bodyModeCount += 1;
    } else if (token === "--body-file") {
      args["bodyFile"] = value;
      bodyModeCount += 1;
    } else if (token === "--append") {
      args["bodyMutation"] = { mode: "append", text: value };
      bodyModeCount += 1;
    } else if (token === "--add-label") (args["addLabels"] as string[]).push(value);
    else if (token === "--remove-label") (args["removeLabels"] as string[]).push(value);
    else if (token === "--harness") args["harness"] = value;
    else if (token === "--base") args["base"] = value;
    else return usage(`Unknown option ${token}`);
  }
  if (bodyModeCount > 1) return usage("ticket update accepts exactly one body mutation mode");
  return { ok: true, invocation: { command: "ticket.update", args, json } };
}
