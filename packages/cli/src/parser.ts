import {
  cliVerbName,
  HARNESS_VOCABULARY,
  isTicketPriority,
  parseColumnToken,
  parseHarnessId,
  REASONING_LEVELS,
  REFERENCE_VERBS,
  TICKET_PRIORITIES,
  VERB_REGISTRY,
} from "@volli/shared";
import type { VerbEntry, VerbKey } from "@volli/shared";

export interface CliInvocation {
  command: string;
  args: Record<string, unknown>;
  json: boolean;
}

/** The priority vocabulary rendered for teaching errors and help, derived from the domain source. */
export const PRIORITY_VOCABULARY: string = TICKET_PRIORITIES.join(", ");

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
 * The executable half of one declared option: what the walker DOES with the
 * value a caller supplies. Which argument key it lands under, how a string
 * becomes that value, and which counter it bumps.
 *
 * The DECLARATION is not here. Name, kind, placeholder, help text, `required`,
 * `hidden` and `group` live in the Verb Registry in `@volli/shared`, because
 * `volli help` and (from VC-162) a Pi tool schema both need them and neither
 * may depend on this package. What is left here is the part no other surface
 * can use — argv mechanics are the CLI's own projection detail.
 *
 * `kind` is named in both halves because the walker has to narrow on it;
 * `parser.test.ts` asserts the two agree for every option, so a mechanics entry
 * cannot parse an option the reference describes differently.
 */
export type OptionMechanics = { readonly bump?: string } & (
  | { readonly kind: "flag"; readonly key: string; readonly value: unknown }
  | { readonly kind: "value"; readonly key: string; readonly parse?: ValueParser }
  | { readonly kind: "repeated"; readonly key: string }
  | {
      readonly kind: "multi";
      readonly count: number;
      readonly missingMessage: string;
      /** Missing/flag-shaped parts are rejected before this runs, so it cannot fail. */
      readonly build: (parts: readonly string[]) => Record<string, unknown>;
    }
);

/** One verb's argv mechanics: its options, plus whatever the walk cannot express. */
export interface VerbMechanics {
  /** Keyed by the literal argv token, exactly as the registry declares its name. */
  readonly options: Readonly<Record<string, OptionMechanics>>;
  /** Keys that must be present in `args` after the walk, each with its own message. */
  readonly required?: Readonly<Record<string, string>>;
  /** Initial list args, applied before the walk (copied per call). */
  readonly defaults?: Readonly<Record<string, readonly string[]>>;
  /** Post-walk validation/normalization; return an error message, or null when ok. */
  readonly finalize?: (
    args: Record<string, unknown>,
    counters: Readonly<Record<string, number>>,
  ) => string | null;
}

// Two shapes several verbs share outright. Sharing them says only that the
// argv handling is identical — what each `--project` MEANS, and the help line a
// reader sees, is that verb's own declaration in the registry. `session done`
// and `session blocked` share these mechanics for the same reason they share a
// dispatch branch in main: one signal, two names for it.
const REASON_ONLY: VerbMechanics = {
  options: { "--reason": { kind: "value", key: "reason" } },
};

const PROJECT_ONLY: VerbMechanics = {
  options: { "--project": { kind: "value", key: "project" } },
};

/**
 * Argv mechanics for every verb the generic walker serves, keyed by registry
 * key. Declaration order follows the registry's.
 *
 * A key here is a claim that the walker can parse that verb, and the two verbs
 * missing from it are the two that need something else. `hook` bypasses the
 * parser entirely — it is fired by a harness hook, takes two bare positionals,
 * and is dispatched in `index.ts` before argv reaches this file. `help` takes a
 * command path or a topic word rather than an option table, and is handled
 * below. Everything else on the Agent CLI is here, and `parser.test.ts` asserts
 * that every verb the reference prints can actually be typed.
 */
export const CLI_MECHANICS: Partial<Record<VerbKey, VerbMechanics>> = {
  identify: PROJECT_ONLY,
  board: PROJECT_ONLY,
  "ticket.list": {
    options: {
      "--status": { kind: "value", key: "status", parse: columnValue },
      "--priority": { kind: "value", key: "priority", parse: priorityValue },
      "--label": { kind: "value", key: "label" },
      "--project": { kind: "value", key: "project" },
      "--limit": { kind: "value", key: "limit", parse: positiveIntValue },
    },
  },
  "ticket.show": {
    options: {
      "--events": { kind: "value", key: "events", parse: positiveIntValue },
      "--comments": { kind: "value", key: "comments", parse: positiveIntValue },
    },
  },
  "ticket.events": {
    options: { "--limit": { kind: "value", key: "limit", parse: positiveIntValue } },
  },
  "ticket.create": {
    options: {
      "--title": { kind: "value", key: "title" },
      "--body": { kind: "value", key: "body" },
      "--body-file": { kind: "value", key: "bodyFile" },
      "--priority": { kind: "value", key: "priority", parse: priorityValue },
      "--status": { kind: "value", key: "status", parse: columnValue },
      "--label": { kind: "repeated", key: "labels" },
      "--project": { kind: "value", key: "project" },
      "--harness": { kind: "value", key: "harness", parse: harnessValue },
      "--base": { kind: "value", key: "base" },
      "--no-worktree": { kind: "flag", key: "usesWorktree", value: false },
    },
    finalize: (args) => {
      if (typeof args["title"] !== "string") return "ticket create requires --title";
      if ("body" in args && "bodyFile" in args) {
        return "ticket create accepts only one of --body or --body-file";
      }
      return null;
    },
  },
  "ticket.update": {
    options: {
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
      "--priority": { kind: "value", key: "priority", parse: priorityValue },
      "--add-label": { kind: "repeated", key: "addLabels" },
      "--remove-label": { kind: "repeated", key: "removeLabels" },
      "--harness": { kind: "value", key: "harness", parse: harnessValue },
      "--base": { kind: "value", key: "base" },
    },
    defaults: { addLabels: [], removeLabels: [] },
    finalize: (_args, counters) =>
      (counters["bodyMode"] ?? 0) > 1
        ? "ticket update accepts exactly one body mutation mode"
        : null,
  },
  "ticket.move": {
    options: { "--to": { kind: "value", key: "to", parse: columnValue } },
    required: { to: "ticket move requires --to" },
  },
  "ticket.comment": {
    options: {
      "-m": { kind: "value", key: "message" },
      "--message": { kind: "value", key: "message" },
      "--file": { kind: "value", key: "file" },
    },
    finalize: (args) =>
      "message" in args === "file" in args
        ? "ticket comment requires exactly one of -m or --file"
        : null,
  },
  "ticket.archive": { options: {} },
  "ticket.brief": { options: {} },
  "worktree.status": { options: {} },
  "worktree.diff": {
    options: { "--working-tree": { kind: "flag", key: "workingTree", value: true } },
  },
  "project.list": { options: {} },
  "label.list": PROJECT_ONLY,
  "model.list": { options: { "--all": { kind: "flag", key: "all", value: true } } },
  "session.list": {
    options: {
      "--project": { kind: "value", key: "project" },
      "--ticket": { kind: "value", key: "ticket" },
    },
  },
  "session.peek": {
    options: { "--lines": { kind: "value", key: "lines", parse: positiveIntValue } },
  },
  "session.start": {
    options: {
      "-m": { kind: "value", key: "message" },
      "--message": { kind: "value", key: "message" },
      "--title": { kind: "value", key: "title" },
      "--model": { kind: "value", key: "model", parse: modelValue },
      "--reasoning": { kind: "value", key: "reasoning", parse: reasoningValue },
    },
  },
  "session.done": REASON_ONLY,
  "session.blocked": REASON_ONLY,
  "session.link": { options: {} },
  "session.harness": {
    options: { "--mint": { kind: "flag", key: "mint", value: true } },
  },
  notify: {
    options: {
      "-m": { kind: "value", key: "message" },
      "--message": { kind: "value", key: "message" },
      "--title": { kind: "value", key: "title" },
    },
    finalize: (args) => (!("message" in args) ? "notify requires -m" : null),
  },
  doctor: { options: { "--fix": { kind: "flag", key: "fix", value: true } } },
  "prompt.baseline": {
    options: {
      "--ticket": { kind: "value", key: "ticket" },
      "--project": { kind: "value", key: "project" },
    },
  },
  "app.launch": {
    options: { "--timeout": { kind: "value", key: "timeout", parse: positiveIntValue } },
  },
};

/** One typeable verb: what it declares, and what this process does with argv for it. */
interface VerbRoute {
  readonly entry: VerbEntry;
  readonly mechanics: VerbMechanics;
}

/**
 * Every verb the walker serves, addressed the way a caller types it. Built by
 * walking the REGISTRY and keeping the entries this process has mechanics for,
 * so a verb cannot become typeable without being declared first.
 */
const ROUTES: ReadonlyMap<string, VerbRoute> = new Map(
  VERB_REGISTRY.flatMap((entry) => {
    const mechanics = CLI_MECHANICS[entry.key];
    return mechanics === undefined ? [] : [[cliVerbName(entry.key), { entry, mechanics }]];
  }),
);

/** Teaching error: an unknown option names the command's real options + a help pointer (principle 3). */
function unknownOptionMessage(entry: VerbEntry, token: string): string {
  const names = entry.options.map((option) => option.name);
  const optionList = names.length > 0 ? ` (options: ${names.join(", ")})` : "";
  return `Unknown option ${token}${optionList} — see volli help ${cliVerbName(entry.key)}`;
}

/** Teaching error: an unrecognized command names the whole command list (principle 3). */
function unknownCommandMessage(): string {
  const names = REFERENCE_VERBS.map((entry) => cliVerbName(entry.key)).join(", ");
  return `Expected a Volli command (commands: ${names})`;
}

/**
 * The one generic argv walker every Volli verb's option table drives. A value
 * that is missing or looks like the *next* flag (starts with `--`) is always
 * rejected as a usage error instead of being silently swallowed as this flag's
 * value — a bare `-` or a negative number (`-5`) is a valid value and passes
 * through.
 */
function parseVerb(route: VerbRoute, rest: readonly string[]): CliParseResult {
  const { entry, mechanics } = route;
  const args: Record<string, unknown> = {};
  if (mechanics.defaults) {
    for (const [key, value] of Object.entries(mechanics.defaults)) {
      args[key] = [...value];
    }
  }

  let index = 0;
  if (entry.positionalId !== undefined) {
    const id = rest[0];
    const absent = id === undefined || id.startsWith("--");
    if (absent) {
      // An optional id simply falls through to the option walk; a required one
      // is a usage error.
      if (entry.positionalId !== "optional") {
        return usage(`${cliVerbName(entry.key)} requires <id>`);
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
    const option = mechanics.options[token];
    if (option === undefined) return usage(unknownOptionMessage(entry, token));

    if (option.kind === "flag") {
      args[option.key] = option.value;
    } else if (option.kind === "multi") {
      const parts: string[] = [];
      for (let offset = 0; offset < option.count; offset += 1) {
        const raw = rest[index + 1 + offset];
        if (raw === undefined || raw.startsWith("--")) return usage(option.missingMessage);
        parts.push(raw);
      }
      Object.assign(args, option.build(parts));
      index += option.count;
    } else {
      const raw = rest[index + 1];
      if (raw === undefined || raw.startsWith("--")) return usage(`${token} requires a value`);
      index += 1;
      if (option.kind === "repeated") {
        const list = (args[option.key] as string[] | undefined) ?? [];
        list.push(raw);
        args[option.key] = list;
      } else {
        const parsed = (option.parse ?? stringValue)(raw, token);
        if (!parsed.ok) return usage(parsed.message);
        args[option.key] = parsed.value;
      }
    }

    if (option.bump) counters[option.bump] = (counters[option.bump] ?? 0) + 1;
  }

  if (mechanics.required) {
    for (const [key, message] of Object.entries(mechanics.required)) {
      if (!(key in args)) return usage(message);
    }
  }

  if (mechanics.finalize) {
    const error = mechanics.finalize(args, counters);
    if (error !== null) return usage(error);
  }

  return { ok: true, invocation: { command: entry.key, args, json } };
}

/** Parses argv into the versioned command shape sent over the Volli socket. */
export function parseCliArgs(argv: readonly string[]): CliParseResult {
  if (argv.includes("--help") || argv.includes("-h")) return helpFromFlag(argv);
  // `help`'s command/topic positionals don't fit the option-table model.
  if (argv[0] === "help") return parseHelp(argv.slice(1));
  // A dot-name is two words on argv (`ticket create`) or one (`doctor`). Match
  // the longer form first; no one-word verb is also the first word of a
  // two-word one, so the longest match is the only match.
  if (argv.length >= 2) {
    const pair = ROUTES.get(`${argv[0]} ${argv[1]}`);
    if (pair !== undefined) return parseVerb(pair, argv.slice(2));
  }
  const single = ROUTES.get(argv[0]);
  if (single !== undefined) return parseVerb(single, argv.slice(1));
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
