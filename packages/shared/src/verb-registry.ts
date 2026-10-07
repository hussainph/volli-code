/**
 * The Verb Registry — one enumerable declaration of every agent-facing verb
 * (VC-92 §5, built in VC-161).
 *
 * Every agent-facing surface is a PROJECTION of this table, never a second
 * list: {@link AGENT_COMMANDS} is the socket projection, `volli help` renders
 * {@link REFERENCE_VERBS}, and VC-162's Pi tool array will read the same
 * entries. One entry per verb, one handler binding per verb, exposed through
 * several access modes — never parallel implementations.
 *
 * Entries are pure data. The executable half of the CLI's argument handling
 * (`parse`, `finalize`, `build`) stays in `packages/cli`, keyed by verb key,
 * because argv mechanics are the CLI's own projection detail; what lives here
 * is the option TABLE, so `apps/desktop` can derive a tool schema without
 * depending on `@volli/cli`.
 *
 * Two disciplines this table exists to hold:
 *
 * 1. **Tier is derived, never stored.** No entry carries a tier field and
 *    nothing may set one — {@link verbTier} computes it from access modes plus
 *    actor requirement, on demand (VC-92 §2).
 * 2. **Adding a verb is a tier decision, made now rather than retrofitted.**
 *    The dot-name is the verb's identity on every surface, in rule packs, and
 *    in Role bundles; it is chosen once and never changes. Reads are open to
 *    any caller, coordination writes want an authenticated session actor, and
 *    a control-tier verb does not get a `cli` access mode AT ALL — agent
 *    control, credential custody, and anything that blocks are named tools in
 *    a Role bundle. Since VC-163 the socket AUTHENTICATES a session actor by
 *    per-attachment token rather than merely attributing one — but that token
 *    does not survive a hostile process running as the same user, so a verb
 *    whose misuse cannot be tolerated from such a process still does not go on
 *    it. Absence is the enforcement; the token only raises the floor.
 *
 * The table records TODAY'S surface. VC-163 moved the last two rows off it:
 * `session.start` is `tool`-only control tier, and `ticket.archive` is on no
 * agent surface at all. `verb-registry.test.ts` pins both, and {@link verbTier}
 * reads an empty access-mode list as no tier rather than as one.
 */

import { REASONING_LEVELS } from "./agent-runtime";
import { MCP_REGISTRY_TYPES } from "./mcp";
import { HELP_TOPIC_NAMES } from "./agent-product";
import { COLUMN_VOCABULARY } from "./agent-surface";
import { AGENT_MODEL_TIERS, modelTierRow } from "./model-access-policy";
import { SESSION_USAGE_GROUPINGS } from "./session-usage-report";
import { FIRST_CLASS_HARNESS_IDS } from "./ticket";
import { MAX_SESSION_AWAIT_TARGETS, SESSION_AWAIT_FOR } from "./session-await";
import { MAX_TICKET_AWAIT_TARGETS, TICKET_AWAIT_FOR } from "./ticket-await";
import { TICKET_SIGNAL_KINDS, TICKET_SIGNAL_VERDICTS } from "./ticket-events";

/**
 * Where a verb is projected. `cli` is the Agent CLI (the local agent socket),
 * `tool` is the Agent Tool Surface (a Role bundle's named tools, VC-162), and
 * `hostApi` is the host protocol's WebSocket projection (VC-564): the tRPC
 * area routers a paired device or a remote Session reaches, judged by the
 * entry's {@link VerbCatalogDeclaration}. A verb on two surfaces is one entry
 * with two modes.
 */
export type VerbAccessMode = "cli" | "tool" | "hostApi";

/**
 * What the caller must be: `any` caller, an authenticated `session` actor
 * (VC-44's tokens), a `role` that holds the verb in its bundle, or the `user`
 * — the person, proven at the door.
 *
 * `user` (VC-623) is the one requirement no Session can meet and no project
 * policy can widen to one. Today the only proof a socket accepts for it is a
 * hostd-issued operator token, so on desktop, which issues none, a `user` verb
 * answers every caller with a refusal: the app is that person's door there.
 * Its tier is coordination — a visible write on the socket — but the admission
 * gate judges it by the door's actor alone, never by a policy list.
 */
export type VerbActor = "any" | "session" | "role" | "user";

/**
 * Where the verb's one handler binding lives: `main` answers over the agent
 * socket (`packages/host-core/src/agent-commands.ts`), `cli` answers locally in
 * the `volli` process and never opens a socket.
 */
export type VerbHandlerSite = "main" | "cli";

/**
 * The verb's one handler binding: WHERE it is answered, and WHICH handler
 * answers it (VC-167).
 *
 * VC-161 recorded the site alone, and nothing read it — dispatch was a
 * hand-written `if` chain, so the declaration was CHECKED against the chain by
 * a source-text scan instead of driving it. The `id` is what closed that: main
 * keys its dispatch table by these ids, so a declared verb with no handler is
 * a compile error rather than a runtime `UNSUPPORTED_COMMAND`.
 *
 * Pure data, like every other field here — an id, never a function. The
 * registry lives in `@volli/shared` and the handlers live in Electron main;
 * a callable here would drag one process's implementation into a package the
 * other imports.
 *
 * The id is the verb's own {@link VerbEntry.key}, and `verb-registry.test.ts`
 * pins that. Naming it separately is what lets a surface move without the
 * binding moving with it: when VC-162 flips `session.start` to a `tool` access
 * mode, the tool surface resolves the SAME `session.start` binding rather than
 * growing a second implementation of the verb.
 */
export interface VerbBinding {
  readonly site: VerbHandlerSite;
  /** The handler this verb resolves to — always the entry's own key. */
  readonly id: string;
}

/** The heading a listed verb prints under in the CLI reference. */
export type VerbGroup = "Read" | "Write" | "Session" | "App";

/**
 * The governance class a verb's access modes imply (VC-92 §2). Derived by
 * {@link verbTier}; never a field, never persisted.
 */
export type VerbTier = "read" | "coordination" | "control";

/** One durable write a voluntary verb intends. */
export interface VerbDurableWrite {
  readonly resource: string;
  /**
   * What the write does to the resource.
   *
   * `delete` is here because `mcp.remove` genuinely deletes a row (VC-380), and
   * the three softer words all misdescribe that. This is the canonical
   * side-effect contract that detailed help and previews render verbatim, so a
   * delete announced as an "update" would understate the one verb in the family
   * a caller cannot undo by calling something else.
   */
  readonly operation: "create" | "update" | "append" | "delete";
  readonly summary: string;
}

/**
 * Human-facing side-effect contract. Detailed help, previews, managed skill
 * docs, and docs-site projections all read these exact fields.
 */
export interface VerbEffects {
  readonly durableWrites: readonly VerbDurableWrite[];
  readonly humanVisible: readonly string[];
  readonly nonEffects: readonly string[];
  /** Limits a mixed read/write verb's effects to the named option (`doctor --fix`). */
  readonly when?: string;
}

/** Help/schema metadata every declared option carries, whatever its kind. */
export interface VerbOptionCommon {
  /** The literal argv token the CLI accepts (`--title`, `-m`). */
  readonly name: string;
  /** One-line description shown in command detail. */
  readonly help: string;
  /** Renders the option unbracketed in usage lines. */
  readonly required?: boolean;
  /** Suppresses an alias (`--message` for `-m`) from generated help. */
  readonly hidden?: boolean;
  /** Collapses mutually exclusive options into one `[a|b]` usage slot. */
  readonly group?: string;
  /** Valid-value hint for when the placeholder cannot carry it (columns). */
  readonly values?: string;
}

/**
 * One option, as data. `kind` is the value shape a caller supplies — a bare
 * flag, one value, a repeatable value, or a fixed run of words — which is what
 * a usage line needs to know.
 */
export type VerbOption =
  | (VerbOptionCommon & { readonly kind: "flag" })
  | (VerbOptionCommon & {
      readonly kind: "value" | "repeated" | "multi";
      /** The value shape shown after the name (`<text>`, `<old> <new>`). */
      readonly placeholder: string;
    });

/**
 * What a provider will accept as a tool name (VC-162).
 *
 * Both providers Volli speaks to publish the same bound, and neither is
 * negotiable: OpenAI's generated `FunctionDefinition` says a name "Must be
 * a-z, A-Z, 0-9, or contain underscores and dashes, with a maximum length of
 * 64", and Anthropic rejects the whole request with `tools.N.custom.name:
 * String should match pattern '^[a-zA-Z0-9_-]{1,64}$'`.
 *
 * A dot is therefore legal in a {@link VerbEntry.key} and illegal on the wire,
 * which is why {@link VerbToolProjection.name} exists at all.
 */
export const VERB_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * One field of a tool's input, as neutral data.
 *
 * Deliberately NOT {@link VerbOption}. That table is argv: `-m`, `--model`,
 * placeholders like `<provider/model>`, hidden aliases, and mutual-exclusion
 * groups the parser resolves. None of it means anything to a model, and
 * several parts of it would actively mislead one — a model shown `-m` will
 * write `-m`. What a tool call needs is a named field with a type, so the two
 * are separate projections of one verb rather than one table doing both jobs.
 *
 * The type vocabulary is closed and small on purpose. `packages/agent-runtime`
 * compiles these into the runtime's schema types; keeping the vocabulary
 * closed is what makes that compilation total rather than best-effort, and
 * keeps `@volli/shared` free of any schema library.
 *
 * `array` is a list of strings and nothing else (VC-380). It was added for one
 * reason worth stating, because the vocabulary is meant to grow reluctantly:
 * an MCP server's `args` is spelled `string[]` by every client in the
 * ecosystem, so a model that has read any MCP documentation will send an array
 * whatever our schema says. A `string` declaration would not have made those
 * calls arrive as strings; it would have made them arrive as provider-level
 * type errors.
 */
export type VerbToolField = {
  /** The field name the model supplies. Never an argv token. */
  readonly name: string;
  /** What this field is, in the only place the model will read it. */
  readonly description: string;
  /** Absent means optional; the tool schema marks it so. */
  readonly required?: boolean;
} & (
  | { readonly type: "string" }
  | { readonly type: "number" }
  | { readonly type: "array" }
  | { readonly type: "enum"; readonly values: readonly string[] }
  | { readonly type: "object"; readonly fields: readonly VerbToolField[] }
);

/** One scalar field of a verb result's `details`, as JSON Schema. */
export type VerbResultScalarSchema =
  | {
      readonly type: "string";
      readonly description: string;
      /** The closed set of values, when there is one. */
      readonly enum?: readonly string[];
    }
  | { readonly type: "number"; readonly description: string }
  | { readonly type: "boolean"; readonly description: string };

/**
 * One field of a verb result's `details`: a scalar, a list of strings, or a
 * flat object of scalars — the same three shapes
 * `RuntimeVerbResult.details` can carry, and nothing deeper.
 */
export type VerbResultFieldSchema =
  | VerbResultScalarSchema
  | {
      readonly type: "array";
      readonly description: string;
      readonly items: { readonly type: "string" };
    }
  | {
      readonly type: "object";
      readonly description: string;
      readonly properties: Readonly<Record<string, VerbResultScalarSchema>>;
      readonly required: readonly string[];
      readonly additionalProperties: false;
    };

/**
 * What a verb's result carries as data beside its prose (VC-471), as a plain
 * JSON Schema.
 *
 * A model calling a verb directly reads its `text`. A Code Mode program calls
 * the same verb as `await tools.session_start(…)` and gets `{ text, details }`
 * back, and a program that parses the prose for a handle is a program that
 * breaks — measured: a fan-out read the wrong handle out of `session_start`'s
 * sentence three runs in five. So a verb whose answer a program needs to act
 * on declares that answer here, and Code Mode renders it into the TypeScript
 * the model writes against.
 *
 * A plain JSON Schema object rather than a {@link VerbToolField} list because
 * it is rendered, not compiled: the renderer reads `type`, `properties`,
 * `required`, `enum` and each property's `description`, and nothing else.
 * Kept closed and shallow on purpose — the vocabulary is exactly what
 * `RuntimeVerbResult.details` may hold, so a host cannot be asked to return a
 * shape its result type cannot carry. Every key is required and no other key
 * is allowed, so a program can rely on what it reads. Descriptions are the
 * only documentation a program's author sees.
 *
 * Describes a result the verb DID something with. A refusal is a result with
 * `text` alone, and Code Mode says so beside the type.
 */
export interface VerbResultDetailsSchema {
  readonly type: "object";
  readonly description: string;
  readonly properties: Readonly<Record<string, VerbResultFieldSchema>>;
  readonly required: readonly string[];
  readonly additionalProperties: false;
}

/**
 * How one verb is projected onto the Agent Tool Surface (VC-162).
 *
 * Present exactly when the entry carries a `tool` access mode, which
 * `verb-registry.test.ts` pins in both directions: a `tool` mode with no
 * projection is a verb the runtime could not build, and a projection with no
 * `tool` mode is metadata nothing reads.
 */
export interface VerbToolProjection {
  /**
   * The callable name on the provider wire — the verb's dot-key with the dot
   * spelled a provider will accept (`session.start` → `session_start`).
   *
   * This is a rendering of the identity, never a second identity. The dot-key
   * remains what authority, the durable `tool-surface` record, Role bundles
   * and grants all spell; the runtime adapter translates at the boundary, the
   * same way product `execute` already reaches Pi as `bash`.
   */
  readonly name: string;
  /**
   * What the model is told this tool does. Separate from
   * {@link VerbEntry.summary}, which is written for a person reading `volli
   * help` and says nothing about when NOT to reach for it.
   */
  readonly description: string;
  /** The tool's input, semantically. Empty means a tool that takes nothing. */
  readonly input: readonly VerbToolField[];
  /**
   * The `details` a successful call returns, for a verb whose answer a program
   * acts on (VC-471). Absent means the verb's details are unspecified: the
   * host may still send some, and a program is told nothing about them.
   */
  readonly resultDetails?: VerbResultDetailsSchema;
}

/**
 * Which Workspace a catalog entry's resource belongs to (HP § Command catalog;
 * VC-564 D8).
 *
 * - `workspace`: the call names one resource (a Session, a project), and the
 *   router resolves its Workspace and authorizes it BEFORE the handler runs. A
 *   resource in another Workspace answers exactly as an absent one does:
 *   `NOT_FOUND` / `workspace-unknown`.
 * - `host`: host-level state every Workspace on this host shares (profile-wide
 *   settings, Model Access). It carries no Workspace data, and only the person
 *   (device-as-user) may call it unless the entry's actor is `any`.
 */
export type VerbScope = "workspace" | "host";

/**
 * What a repeat of the same call does (HP § Commands).
 *
 * - `command-id`: intent-recording. The caller mints a key and keeps it across
 *   retries; the same key and intent answer the durable receipt again, and a
 *   different intent under that key is `CONFLICT` / `command-conflict`.
 * - `natural`: the call states a whole value, so a repeat leaves the same state.
 * - `read`: no effect to repeat.
 */
export type VerbIdempotency = "command-id" | "natural" | "read";

/** Every scope and idempotency, for the guards and tests that enumerate them. */
export const VERB_SCOPES = ["workspace", "host"] as const satisfies readonly VerbScope[];
export const VERB_IDEMPOTENCIES = [
  "command-id",
  "natural",
  "read",
] as const satisfies readonly VerbIdempotency[];

/**
 * What a ROUTER demands of its caller (HP § Command catalog; VC-564 A2). The
 * agent doors (socket, tools, CLI) keep reading {@link VerbEntry.actor}; a
 * router reads `catalog.actor`, defaulting to it, so one command can hold a
 * different policy for the person's door than for the agent's.
 *
 * - `any`: every admitted actor, Sessions included, on any resource in the
 *   caller's Workspace;
 * - `user`: the person only (a paired device, the desktop's own window);
 * - `session-own`: the person, or a Session the area's own policy lets act on
 *   every SUBJECT the call names. After the Workspace check (which every named
 *   resource gets, subjects and references alike), the router asks the
 *   context's `sessionMayAct` predicate about each subject; any `false`, no
 *   subject at all, or no predicate is `FORBIDDEN` / `verb-refused`. The area
 *   implements the predicate from its real policy (ticket coordination rules,
 *   per-project authority), never a single owner field. Workspace-scoped
 *   entries only.
 */
export type CatalogActor = "any" | "user" | "session-own";
export const CATALOG_ACTORS = [
  "any",
  "user",
  "session-own",
] as const satisfies readonly CatalogActor[];

/**
 * The host-protocol catalog's half of an entry (VC-564, HP § Command catalog).
 *
 * An entry carrying this is a COMMAND some router projects: `@volli/session-rpc`
 * binds exactly one tRPC procedure to it, named by the entry's key, and the
 * procedure's policy middleware reads this block and nothing else. Its name
 * is {@link VerbEntry.key}, its router actor `actor` here, else
 * {@link VerbEntry.actor} ({@link catalogActorOf}), and its one handler is
 * that procedure's resolver.
 * Validators stay zod in the router (D2): data here, executable shape there.
 *
 * Present on an entry with a `hostApi` access mode, and on a procedure no
 * network door serves (an entry with no access mode at all, like the lab's
 * diagnostics): declared, policed, and projected onto nothing.
 */
export interface VerbCatalogDeclaration {
  /**
   * The router's actor requirement, when it differs from the entry's `actor`
   * (which the socket, tools and CLI keep reading unchanged). Absent: the
   * entry's `actor`. Either way it must be a {@link CatalogActor}; `session`
   * and `role` are agent-door policies a router cannot consult, refused at load.
   */
  readonly actor?: VerbActor | "session-own";
  readonly scope: VerbScope;
  readonly idempotency: VerbIdempotency;
  /**
   * Intent kinds no actor may send through this `command-id` entry, on any
   * door, because each has an entry of its own. The router refuses them
   * `FORBIDDEN` / `verb-refused` before the handler runs, reading
   * `input.command.kind`; its builder refuses an input schema with no such
   * `command.kind` envelope, at the type and at construction.
   */
  readonly refusedIntents?: readonly string[];
}

/** One agent-facing verb. Pure data; see the module comment for what is not here. */
export interface VerbEntry {
  /** The dot-name — this verb's identity on every surface. */
  readonly key: string;
  readonly accessModes: readonly VerbAccessMode[];
  /** Person-only socket door; never widens an agent CLI or Role bundle. */
  readonly operatorCli?: true;
  readonly actor: VerbActor;
  readonly handler: VerbBinding;
  /** Whether `volli help` prints the verb. Involuntary verbs stay unlisted. */
  readonly listed: boolean;
  /** Its position in the CLI reference; ignored when the verb is unlisted. */
  readonly referenceOrder?: number;
  readonly group: VerbGroup;
  /** One-line description; feeds both help text and tool schema. */
  readonly summary: string;
  /** One realistic invocation, shown in command detail. */
  readonly example?: string;
  /** Short lines for semantics the option table cannot express. */
  readonly notes?: readonly string[];
  /** Structured writes and person-visible effects; the canonical side-effect contract. */
  readonly effects?: VerbEffects;
  /**
   * The verb previews unless told to write, inverting the CLI's ordinary rule
   * that a coordination verb writes and `--dry-run` previews (VC-310).
   *
   * Declared rather than inferred, because the registry is where a caller
   * learns what a verb DOES before running it, and "the plain form is safe"
   * is exactly that kind of fact. It is also what lets the invariant "every
   * voluntary coordination write offers a preview" stay a real check: such a
   * verb satisfies it by construction rather than by an exemption.
   *
   * Reserve it for a write that is destructive and not usefully reversible. A
   * comment can be answered and a move can be moved back, so those keep the
   * ordinary shape; folding one label into another deletes a row and rewrites
   * the organisation of tickets nobody is looking at.
   */
  readonly previewsByDefault?: boolean;
  /** How this verb appears on the Agent Tool Surface; required by a `tool` access mode. */
  readonly tool?: VerbToolProjection;
  /**
   * A tool verb no new Session is handed (VC-457). It stays declared — and
   * keeps its place in declaration order — because a Session whose surface
   * was frozen holding it must still reattach with that exact surface, and its
   * handler still answers. It is in no Role bundle, and a grant naming it is
   * refused. The string says what replaced it.
   */
  readonly retired?: string;
  /**
   * The host-protocol catalog declaration: scope and idempotency (VC-564).
   * Required by a `hostApi` access mode; see {@link VerbCatalogDeclaration}.
   */
  readonly catalog?: VerbCatalogDeclaration;
  /** Whether the verb takes a leading `<id>`, and whether it is required. */
  readonly positionalId?: "required" | "optional";
  /**
   * What usage and refusals call that leading positional, when `id` would
   * mislead (`project add <path>`). It still arrives as `args.id`: this names
   * it for a reader, and changes nothing on the wire.
   */
  readonly positionalLabel?: string;
  /**
   * What that leading `<id>` NAMES, when it names something a per-project
   * authority policy has to be resolved from (VC-163).
   *
   * `ticket` means the positional is a Ticket display id, and its prefix names
   * the project the verb's write LANDS IN — which is not necessarily the
   * project the caller is standing in. Admission needs both, because a policy
   * is a statement about a project's own board: see `agent-dispatch/admission.ts`.
   *
   * Declared rather than inferred from the key or the argument's shape. A verb
   * added later states what its positional is, and is judged on that; guessing
   * from `args.id` would silently mis-resolve the day a non-Ticket verb takes
   * an id that happens to parse as `PREFIX-123`.
   */
  readonly positionalSubject?: "ticket";
  /** Rendered after `<id>` for positionals the option table cannot express. */
  readonly extraUsage?: string;
  readonly options: readonly VerbOption[];
}

/**
 * The harness vocabulary rendered into help. The four first-class ids can be
 * listed; a registered harness cannot, because its slug is whatever its author
 * called it and only the app knows which ones exist — so the phrase names the
 * category instead of pretending to enumerate it.
 */
export const HARNESS_VOCABULARY: string = `${FIRST_CLASS_HARNESS_IDS.join(", ")}, or a registered, trusted harness`;

/** The CLI-facing name for a verb key (`ticket.create` → `ticket create`). */
export function cliVerbName(key: string): string {
  return key.replaceAll(".", " ");
}

const COLUMN_VALUES = `valid: ${COLUMN_VOCABULARY}`;
const HARNESS_VALUES = `valid: ${HARNESS_VOCABULARY}`;
const REASONING_VALUES = `valid: ${REASONING_LEVELS.join(", ")}`;
const MODEL_TIER_VALUES = `valid: ${AGENT_MODEL_TIERS.join(", ")}`;

/**
 * The `tier` field's description, written once from the tier table (VC-259).
 *
 * Each tier's one-line job is the SAME line its Settings row's (i) carries and
 * `volli model list` prints — read off `modelTierRow`, not restated — so a
 * model choosing between `fast` and `deep` reads the words the person who
 * filled those rows read. The first sentence is the rule the door enforces:
 * a tier and an exact model are alternatives, never a pair.
 *
 * Both doors that offer a rung offer the SAME set (VC-431), so the subject is
 * the only word that differs between them.
 */
function modelTierDescription(subject: string): string {
  return [
    `Run ${subject} on one of the user's configured model tiers instead of \`model\`; pass one or the other, never both.`,
    "The tier's stored reasoning level comes with it unless `reasoning` is given.",
    ...AGENT_MODEL_TIERS.map((tier) => `${tier}: ${modelTierRow(tier).hint}`),
  ].join(" ");
}

const MODEL_TIER_DESCRIPTION = modelTierDescription("the Session");
const DELEGATE_MODEL_TIER_DESCRIPTION = modelTierDescription("the subagent");

/**
 * The Session a start or a delegation opened, as a program reads it (VC-471).
 *
 * One field set for both verbs, so a program that fans out with either reads
 * the same keys. `handle` is the id every other Volli door takes back.
 * `sessionId` is kept because the transcript row links a delegation by it, and
 * its description steers a program to `handle` instead.
 */
const OPENED_SESSION_FIELDS = {
  sessionId: {
    type: "string",
    description:
      "The Session's full id: unique, but not what other tools take — pass `handle` to them.",
  },
  handle: {
    type: "string",
    description:
      "Its short session id, the one watch, session_send, session_stop and `volli session` commands accept.",
  },
  title: { type: "string", description: "The Session's title." },
  model: {
    type: "object",
    description: "The model it runs on, with any tier already resolved.",
    properties: {
      providerId: { type: "string", description: "Provider id, as `model list` prints it." },
      modelId: { type: "string", description: "Model id, as `model list` prints it." },
      reasoningLevel: {
        type: "string",
        enum: REASONING_LEVELS,
        description: "The reasoning level it runs at.",
      },
    },
    required: ["providerId", "modelId", "reasoningLevel"],
    additionalProperties: false,
  },
  state: {
    type: "string",
    enum: ["running", "needs-recovery"],
    description:
      "running: attached, with its first message sent. needs-recovery: created, but its attachment failed and nothing was sent; a person can retry it from the app.",
  },
} as const satisfies Readonly<Record<string, VerbResultFieldSchema>>;

/**
 * The confirmation field the two destructive MCP verbs share (VC-380).
 *
 * An enum rather than a boolean because the registry's field vocabulary is
 * closed at `string | number | enum | object`, and widening it for one flag
 * would change how every tool schema is compiled. The two values also read
 * better than a boolean would at the call site: `confirm: "apply"` says what
 * the call does, where `apply: true` only says that something is true.
 *
 * Optional, and its absence IS the preview. A required field would make the
 * safe form the one a caller has to remember, which is the arrangement
 * `previewsByDefault` exists to invert.
 */
const MCP_CONFIRM_FIELD: VerbToolField = {
  name: "confirm",
  type: "enum",
  values: ["preview", "apply"],
  description:
    'Omit it, or pass "preview", to see the warning and what would happen while writing nothing. Pass "apply" only after reading that warning, to actually perform the operation.',
};

/** The id field every verb that names an already-configured server shares. */
const MCP_SERVER_ID_FIELD: VerbToolField = {
  name: "server",
  type: "string",
  required: true,
  description: "The server's id, as server_list prints it.",
};

/**
 * How a caller SPELLS one MCP server, shared by preview and install.
 *
 * Two transports and one flat field set, rather than a nested object per
 * transport: `command` and `url` are alternatives the door refuses to take
 * together, and stating that in one sentence a model reads is more reliable
 * than a schema union it has to infer. The absent fields are the point of the
 * ticket's scope — there is no `headers`, no `env` and no `token`, because
 * authenticated servers are still deferred from VC-8 and a field would promise
 * something the transport layer will not do.
 */
const MCP_SERVER_FIELDS: readonly VerbToolField[] = [
  {
    name: "id",
    type: "string",
    required: true,
    description:
      "A short stable id for this server, letters, digits, dashes and underscores only. Installing the same id twice updates that server rather than adding a second one.",
  },
  {
    name: "name",
    type: "string",
    required: true,
    description: "The display name a person will see in Settings, for example 'Acme Files'.",
  },
  {
    name: "command",
    type: "string",
    description:
      "For a LOCAL server: the executable to run, which must already be on PATH, for example 'npx' or 'uvx'. Volli installs nothing. Give this or url, never both.",
  },
  {
    name: "args",
    type: "array",
    description:
      'Arguments for the local command, one per entry, exactly as an MCP config spells them: ["-y", "@acme/files-mcp"]. An entry may contain spaces. Ignored for a remote server.',
  },
  {
    name: "url",
    type: "string",
    description:
      "For a REMOTE server: its streamable HTTP endpoint, http or https, with no credentials in the URL. Give this or command, never both.",
  },
];

/**
 * A board read the person makes through the board router (VC-565): a
 * Workspace query, idempotent by nature, projected onto the WebSocket and no
 * agent surface.
 */
function boardRead<const Key extends string>(key: Key, summary: string) {
  return {
    key,
    accessModes: ["hostApi"],
    actor: "user",
    handler: { site: "main", id: key },
    listed: false,
    group: "Read",
    summary,
    options: [],
    catalog: { scope: "workspace", idempotency: "read" },
  } as const;
}

/**
 * A board write the person makes through the board router (VC-565): a
 * Workspace command under a caller-minted `commandId`, answered from its
 * durable receipt when repeated with the same intent.
 */
function boardWrite<const Key extends string>(key: Key, summary: string) {
  return {
    key,
    accessModes: ["hostApi"],
    actor: "user",
    handler: { site: "main", id: key },
    listed: false,
    group: "Write",
    summary,
    options: [],
    catalog: { scope: "workspace", idempotency: "command-id" },
  } as const;
}

/**
 * The board area's catalog rows (VC-668): the commands a board router
 * projects, typed by exactly these rows so its family cannot build another
 * area's key (HP § Command catalog, "Adding a command"). Spread into
 * {@link VERB_REGISTRY} where the socket order has always had them.
 */
export const BOARD_ENTRIES = [
  {
    key: "ticket.move",
    // The first command both kinds of door serve (VC-668): the socket keeps
    // judging `actor`, and the WebSocket admits only the person until VC-565
    // writes the board's `sessionMayAct` policy and widens it to `session-own`.
    accessModes: ["cli", "hostApi"],
    actor: "session",
    handler: { site: "main", id: "ticket.move" },
    // Column-only, like the socket: moving to the column a ticket already
    // occupies is a no-op, so a repeat leaves the same state.
    catalog: { actor: "user", scope: "workspace", idempotency: "natural" },
    listed: true,
    referenceOrder: 15,
    group: "Write",
    summary: "Move a ticket to another column.",
    example: "volli ticket move VC-12 --to needs-review",
    notes: [
      "Moving to the current column is a no-op.",
      "Columns ignore case and accept board labels such as Needs Review or needs_review.",
    ],
    effects: {
      durableWrites: [
        {
          resource: "ticket",
          operation: "update",
          summary:
            "Update the Ticket's board status and order and append one status-change Ticket event.",
        },
      ],
      humanVisible: [
        "The Ticket moves to the selected board column.",
        "If Automatic triggers is on and the destination column has an armed Automation, a cancellable arrival can start a fresh Run.",
        "Moving from Doing or Needs Review to Backlog, Todo, or Done interrupts the Ticket's live Sessions.",
      ],
      nonEffects: [
        "Without an enabled, armed Automation, the move does not start a Session, submit a kickoff turn, or create a worktree.",
      ],
    },
    positionalId: "required",
    positionalSubject: "ticket",
    options: [
      {
        name: "--to",
        kind: "value",
        placeholder: "<column>",
        values: COLUMN_VALUES,
        required: true,
        help: "Destination column.",
      },
      { name: "--dry-run", kind: "flag", help: "Validate and preview without side effects." },
    ],
  },
  // The board's own operations (VC-565): the person's, on the WebSocket and
  // the desktop's IPC bridge, on no agent surface. The agent CLI keeps its
  // `ticket.*`/`project.*` verbs and their socket handlers unchanged, so
  // these take the router's `board.<verb>` paths rather than those keys.
  boardRead("board.snapshot", "Read one Workspace's board: its project, tickets and labels."),
  boardRead("board.roster", "Read one Workspace's tickets (without bodies) and labels."),
  boardRead("board.changes", "Follow one Workspace's board changes, resuming after a cursor."),
  boardRead("board.projectFolder", "Check whether the project's folder is still on disk."),
  boardRead("board.ticketBody", "Read one ticket's Markdown body."),
  boardRead("board.archivedTickets", "Read the project's archived tickets, newest first."),
  boardRead("board.ticketEvents", "Read one ticket's event history."),
  boardRead("board.latestSignals", "Read the latest Session outcome of each ticket."),
  boardRead("board.statusEntries", "Read when each ticket entered its current column."),
  boardRead("board.comments", "Read one ticket's comments."),
  boardWrite("board.updateProject", "Set the project's base branch and setup command."),
  boardWrite("board.setSkillModes", "Replace the project's per-skill rules."),
  boardWrite("board.setSessionDefaults", "Replace the project's model for new Chats."),
  boardWrite("board.createTicket", "Create a ticket."),
  boardWrite("board.moveTickets", "Move tickets to a column position."),
  boardWrite("board.setPriority", "Set a ticket's priority."),
  boardWrite("board.updateTicket", "Edit a ticket's fields."),
  boardWrite("board.setLabels", "Replace a ticket's labels."),
  boardWrite("board.archiveTicket", "Archive a ticket."),
  boardWrite("board.unarchiveTicket", "Return an archived ticket to the board."),
  boardWrite("board.deleteTicket", "Delete an archived ticket."),
  boardWrite("board.createComment", "Comment on a ticket as the person."),
  boardWrite("board.updateComment", "Edit a comment."),
  boardWrite("board.removeComment", "Delete a comment."),
  boardWrite("board.setLabelColor", "Set a label's color."),
] as const satisfies readonly VerbEntry[];

/** One board row: the board router family's entry type. */
export type BoardEntry = (typeof BOARD_ENTRIES)[number];

/**
 * Sign-ins on a host (VC-702; HP § Sign-ins on a host): the person sends an
 * API key or a git push credential from a Client, or signs a subscription in
 * on the host itself. Person-only and host-scoped, like `logs.*`: no Session
 * may read or write the host's sign-ins, so every row's router actor is
 * `user` and none is on an agent surface (`hostApi` only, `listed: false`).
 *
 * Served by the Session router's family until VC-565 composes area routers
 * into one served router; the rows are typed here so they can move with it.
 */
export const SIGN_IN_ENTRIES = [
  {
    key: "signIns.status",
    accessModes: ["hostApi"],
    actor: "user",
    handler: { site: "main", id: "signIns.status" },
    listed: false,
    group: "App",
    summary: "Read which providers and git hosts this host is signed in to, never a value.",
    options: [],
    catalog: { scope: "host", idempotency: "read" },
  },
  {
    key: "signIns.setApiKey",
    accessModes: ["hostApi"],
    actor: "user",
    handler: { site: "main", id: "signIns.setApiKey" },
    listed: false,
    group: "App",
    summary: "Store a provider API key on this host, write-only.",
    options: [],
    catalog: { scope: "host", idempotency: "natural" },
  },
  {
    key: "signIns.signOut",
    accessModes: ["hostApi"],
    actor: "user",
    handler: { site: "main", id: "signIns.signOut" },
    listed: false,
    group: "App",
    summary: "Remove the credential this host stores for one provider.",
    options: [],
    catalog: { scope: "host", idempotency: "natural" },
  },
  {
    // Natural, not command-id: a repeat from the same connection answers the
    // flow it already has, and nothing about a flow outlives its connection.
    key: "signIns.start",
    accessModes: ["hostApi"],
    actor: "user",
    handler: { site: "main", id: "signIns.start" },
    listed: false,
    group: "App",
    summary: "Start signing this host in to a provider, owned by the asking connection.",
    options: [],
    catalog: { scope: "host", idempotency: "natural" },
  },
  {
    key: "signIns.subscribe",
    accessModes: ["hostApi"],
    actor: "user",
    handler: { site: "main", id: "signIns.subscribe" },
    listed: false,
    group: "App",
    summary: "Follow one of this connection's sign-in flows to its end.",
    options: [],
    catalog: { scope: "host", idempotency: "read" },
  },
  {
    key: "signIns.answer",
    accessModes: ["hostApi"],
    actor: "user",
    handler: { site: "main", id: "signIns.answer" },
    listed: false,
    group: "App",
    summary: "Answer the step a sign-in flow is waiting on: the pasted-redirect fallback.",
    options: [],
    catalog: { scope: "host", idempotency: "natural" },
  },
  {
    key: "signIns.cancel",
    accessModes: ["hostApi"],
    actor: "user",
    handler: { site: "main", id: "signIns.cancel" },
    listed: false,
    group: "App",
    summary: "Cancel one of this connection's sign-in flows.",
    options: [],
    catalog: { scope: "host", idempotency: "natural" },
  },
  {
    key: "signIns.setGitCredential",
    accessModes: ["hostApi"],
    actor: "user",
    handler: { site: "main", id: "signIns.setGitCredential" },
    listed: false,
    group: "App",
    summary: "Store a git push credential for one remote host, write-only.",
    options: [],
    catalog: { scope: "host", idempotency: "natural" },
  },
  {
    key: "signIns.clearGitCredential",
    accessModes: ["hostApi"],
    actor: "user",
    handler: { site: "main", id: "signIns.clearGitCredential" },
    listed: false,
    group: "App",
    summary: "Remove the git push credential this host stores for one remote host.",
    options: [],
    catalog: { scope: "host", idempotency: "natural" },
  },
  {
    // The auth-callback relay (HP § Auth-callback relay): a single-use grant,
    // bound to its flow and connection. Its own feature, so a Client says it
    // can relay by asking for it, and MCP's relay (VC-570) reuses it.
    key: "auth.callback.deliver",
    accessModes: ["hostApi"],
    actor: "user",
    handler: { site: "main", id: "auth.callback.deliver" },
    listed: false,
    group: "App",
    summary: "Deliver the browser's redirect to the host's own sign-in listener, once.",
    options: [],
    catalog: { scope: "host", idempotency: "natural" },
  },
] as const satisfies readonly VerbEntry[];

/** One sign-in row. */
export type SignInEntry = (typeof SIGN_IN_ENTRIES)[number];

/**
 * Every agent-facing verb, in the order the socket projection has always had.
 *
 * Declaration order is the socket order, so {@link AGENT_COMMANDS} is a plain
 * filter-and-map with nothing reordered. The order the CLI reference prints
 * them in is a different order, and it is {@link REFERENCE_VERBS}.
 */
export const VERB_REGISTRY = [
  {
    key: "identify",
    accessModes: ["cli"],
    actor: "any",
    handler: { site: "main", id: "identify" },
    listed: true,
    referenceOrder: 0,
    group: "Read",
    summary: "Resolve and print the active project, ticket, session, and session environment.",
    example: "volli identify",
    notes: [
      "The env block reports the session PATH, how it was adopted, where each measured tool (git, gh, node, npm, pnpm, yarn, bun) resolves, and whether workspace dependencies are installed — read it before probing for tools.",
      "env.requiredTools names what THIS project implies: git for a repository, node and the lockfile's package manager for a JS workspace. A `-` tool not listed there is one nothing here runs, not a fault.",
      "env.provenance is the boot adoption; env.interactiveProvenance is the later pass that picks up what your shell's interactive startup files export (nvm, bun, rbenv, pyenv, mise). `pending` there means that pass has not landed yet.",
    ],
    options: [
      {
        name: "--project",
        kind: "value",
        placeholder: "<p>",
        help: "Resolve against this project instead of the context ladder.",
      },
    ],
  },
  {
    key: "board",
    accessModes: ["cli"],
    actor: "any",
    handler: { site: "main", id: "board" },
    listed: true,
    referenceOrder: 1,
    group: "Read",
    summary: "Show a project's board grouped by column.",
    example: "volli board --project VC",
    options: [{ name: "--project", kind: "value", placeholder: "<p>", help: "Target project." }],
  },
  {
    key: "ticket.list",
    accessModes: ["cli"],
    actor: "any",
    handler: { site: "main", id: "ticket.list" },
    listed: true,
    referenceOrder: 2,
    group: "Read",
    summary: "List a project's tickets, optionally filtered.",
    example: "volli ticket list --status doing --priority high",
    options: [
      {
        name: "--status",
        kind: "value",
        placeholder: "<column>",
        values: COLUMN_VALUES,
        help: "Filter by column.",
      },
      {
        name: "--priority",
        kind: "value",
        placeholder: "low|medium|high",
        help: "Filter by priority.",
      },
      { name: "--label", kind: "value", placeholder: "<name>", help: "Filter by label." },
      { name: "--project", kind: "value", placeholder: "<p>", help: "Target project." },
      { name: "--limit", kind: "value", placeholder: "<n>", help: "Cap the number of rows." },
    ],
  },
  {
    key: "ticket.show",
    accessModes: ["cli"],
    actor: "any",
    handler: { site: "main", id: "ticket.show" },
    listed: true,
    referenceOrder: 3,
    group: "Read",
    summary: "Show one ticket with recent events and comments.",
    example: "volli ticket show VC-12 --comments-only",
    notes: [
      "Latest signal per kind is always printed: signals carry state, comments carry prose.",
      "Either count takes 0 and performs no history query; zeroing both returns a compact ticket header for signal polling.",
      "Comment bodies print in full; other log prose is capped at 1,000 characters unless --full or --json is used.",
    ],
    positionalId: "required",
    positionalSubject: "ticket",
    options: [
      {
        name: "--events",
        kind: "value",
        placeholder: "<n>",
        help: "How many recent events to include; 0 for none.",
      },
      {
        name: "--comments",
        kind: "value",
        placeholder: "<n>",
        help: "How many recent comments to include; 0 for none.",
      },
      {
        name: "--comments-only",
        kind: "flag",
        help: "Show comments/signals with a compact ticket header; read no event history.",
      },
      { name: "--full", kind: "flag", help: "Print all log prose without truncation." },
    ],
  },
  {
    key: "ticket.events",
    accessModes: ["cli"],
    actor: "any",
    handler: { site: "main", id: "ticket.events" },
    listed: true,
    referenceOrder: 4,
    group: "Read",
    summary: "Print a ticket's event log.",
    example: "volli ticket events VC-12 --limit 20",
    notes: [
      "session_started and session_resumed name who asked, as by=: a person, an Automation with its run id, a session, or Volli itself.",
    ],
    positionalId: "required",
    positionalSubject: "ticket",
    options: [
      { name: "--limit", kind: "value", placeholder: "<n>", help: "Cap the number of events." },
      { name: "--full", kind: "flag", help: "Print all event prose without truncation." },
    ],
  },
  {
    key: "ticket.create",
    accessModes: ["cli"],
    actor: "session",
    handler: { site: "main", id: "ticket.create" },
    listed: true,
    referenceOrder: 13,
    group: "Write",
    summary: "Create a ticket (defaults to Backlog).",
    example: 'volli ticket create --title "Fix auth" --label bug',
    notes: [
      "Defaults to Backlog unless --status is set.",
      "--body and --body-file are mutually exclusive.",
    ],
    effects: {
      durableWrites: [
        {
          resource: "ticket",
          operation: "create",
          summary: "Create one Ticket and its attributed Ticket creation event.",
        },
      ],
      humanVisible: ["The new Ticket appears on the board in the selected column."],
      nonEffects: [
        "Creating in Doing does not start a Session or submit a kickoff turn.",
        "Worktree intent is recorded, but this command does not materialize a checkout.",
      ],
    },
    options: [
      {
        name: "--title",
        kind: "value",
        placeholder: "<text>",
        required: true,
        help: "Ticket title.",
      },
      { name: "--body", kind: "value", placeholder: "<text>", group: "body", help: "Body text." },
      {
        name: "--body-file",
        kind: "value",
        placeholder: "<path>",
        group: "body",
        help: "Body from a file.",
      },
      { name: "--priority", kind: "value", placeholder: "low|medium|high", help: "Priority." },
      {
        name: "--status",
        kind: "value",
        placeholder: "<column>",
        values: COLUMN_VALUES,
        help: "Initial column.",
      },
      {
        name: "--label",
        kind: "repeated",
        placeholder: "<name>",
        help: "Add label (repeatable).",
      },
      { name: "--project", kind: "value", placeholder: "<p>", help: "Project (name/prefix/path)." },
      {
        name: "--harness",
        kind: "value",
        placeholder: "<h>",
        values: HARNESS_VALUES,
        help: "Harness id.",
      },
      { name: "--base", kind: "value", placeholder: "<branch>", help: "Base branch." },
      { name: "--no-worktree", kind: "flag", help: "Skip worktree isolation." },
      { name: "--dry-run", kind: "flag", help: "Validate and preview without side effects." },
    ],
  },
  {
    key: "ticket.update",
    accessModes: ["cli"],
    actor: "session",
    handler: { site: "main", id: "ticket.update" },
    listed: true,
    referenceOrder: 14,
    group: "Write",
    summary: "Update a ticket's fields or body.",
    example: 'volli ticket update VC-12 --edit "old" "new"',
    notes: ["At most one body mutation per call.", "--edit needs exactly one match for <old>."],
    effects: {
      durableWrites: [
        {
          resource: "ticket",
          operation: "update",
          summary:
            "Update the requested Ticket fields and append attributed Ticket events for changes.",
        },
      ],
      humanVisible: ["Updated fields appear on the Ticket card and in its Ticket workspace."],
      nonEffects: ["The Ticket does not move, no Session starts, and no worktree is materialized."],
    },
    positionalId: "required",
    positionalSubject: "ticket",
    options: [
      { name: "--title", kind: "value", placeholder: "<text>", help: "Replace the title." },
      {
        name: "--body",
        kind: "value",
        placeholder: "<text>",
        group: "body",
        help: "Replace the body.",
      },
      {
        name: "--body-file",
        kind: "value",
        placeholder: "<path>",
        group: "body",
        help: "Replace body from a file.",
      },
      {
        name: "--append",
        kind: "value",
        placeholder: "<text>",
        group: "body",
        help: "Append to the body.",
      },
      {
        name: "--append-file",
        kind: "value",
        placeholder: "<path>",
        group: "body",
        help: "Append text from a file.",
      },
      {
        name: "--edit",
        kind: "multi",
        placeholder: "<old> <new>",
        group: "body",
        help: "Replace one <old> with <new>.",
      },
      { name: "--priority", kind: "value", placeholder: "low|medium|high", help: "Set priority." },
      {
        name: "--add-label",
        kind: "repeated",
        placeholder: "<name>",
        help: "Add label (repeatable).",
      },
      {
        name: "--remove-label",
        kind: "repeated",
        placeholder: "<name>",
        help: "Remove label (repeatable).",
      },
      {
        name: "--harness",
        kind: "value",
        placeholder: "<h>",
        values: HARNESS_VALUES,
        help: "Set the harness.",
      },
      { name: "--base", kind: "value", placeholder: "<branch>", help: "Set the base branch." },
      { name: "--dry-run", kind: "flag", help: "Validate and preview without side effects." },
    ],
  },
  ...BOARD_ENTRIES,
  {
    key: "ticket.comment",
    accessModes: ["cli"],
    actor: "session",
    handler: { site: "main", id: "ticket.comment" },
    listed: true,
    referenceOrder: 16,
    group: "Write",
    summary: "Add a comment to a ticket.",
    example: 'volli ticket comment VC-12 -m "Ready for review"',
    notes: ["Exactly one of -m or --file."],
    effects: {
      durableWrites: [
        {
          resource: "ticket-comment",
          operation: "create",
          summary: "Create one attributed Ticket comment and its Ticket activity event.",
        },
      ],
      humanVisible: ["The comment appears in the Ticket activity feed."],
      nonEffects: ["The Ticket does not move and no Session starts."],
    },
    positionalId: "required",
    positionalSubject: "ticket",
    options: [
      {
        name: "-m",
        kind: "value",
        placeholder: "<text>",
        group: "message",
        help: "Comment text.",
      },
      {
        name: "--message",
        kind: "value",
        placeholder: "<text>",
        group: "message",
        hidden: true,
        help: "Alias for -m.",
      },
      {
        name: "--file",
        kind: "value",
        placeholder: "<path>",
        group: "message",
        help: "Read the comment from a file.",
      },
      { name: "--dry-run", kind: "flag", help: "Validate and preview without side effects." },
    ],
  },
  {
    // The typed verdict channel (VC-85), and the pattern-setting coordination
    // verb. It replaces the `VERDICT: FIRST-LINE` comment convention the
    // rc-0.1.0 orchestration pass invented: a convention any reader had to
    // parse by eye, any writer could spell wrong, and no query could reach.
    //
    // Coordination tier, and VC-92 pinned WHY it is the first verb that must
    // require an authenticated session actor rather than merely attributing
    // one: an unforgeable verdict channel is the entire point, and a signal
    // any same-uid process can mint is the convention again with better
    // syntax. Today the socket attributes; VC-163 is where it authenticates.
    //
    // Append-only makes this coordination write the one that most needs a
    // rehearsal: unlike a move or an update, a mistaken verdict cannot be
    // edited away. Its preview follows the shared mutation-plan contract.
    key: "ticket.signal",
    accessModes: ["cli"],
    actor: "session",
    handler: { site: "main", id: "ticket.signal" },
    listed: true,
    referenceOrder: 17,
    group: "Write",
    summary: "Record a typed verdict on a ticket: which stage, and how it went.",
    example: 'volli ticket signal VC-12 --kind review --verdict pass --detail "Two nits, fixed"',
    notes: [
      "Acts as this session; needs a Volli session, because a verdict is only worth what its signer is.",
      "Signals carry state and comments carry prose — post both when a verdict needs an argument.",
      "The board does not move. Use ticket move for that, deliberately.",
      "Append-only: a later signal of the same kind supersedes an earlier one by being newer.",
    ],
    effects: {
      durableWrites: [
        {
          resource: "ticket-signal",
          operation: "create",
          summary:
            "Create one attributed Ticket signal and its signaled Ticket event, in one transaction.",
        },
      ],
      humanVisible: [
        "The verdict appears in the Ticket activity feed and in ticket show's latest-signal lines.",
      ],
      nonEffects: [
        "The Ticket does not move: signals are orthogonal to the board by design.",
        "No Session starts, no notification fires, and no earlier signal is edited or erased.",
      ],
    },
    positionalId: "required",
    positionalSubject: "ticket",
    options: [
      {
        name: "--kind",
        kind: "value",
        placeholder: "<kind>",
        values: `valid: ${TICKET_SIGNAL_KINDS.join(", ")}`,
        required: true,
        help: "Which stage this verdict is about.",
      },
      {
        name: "--verdict",
        kind: "value",
        placeholder: "<verdict>",
        values: `valid: ${TICKET_SIGNAL_VERDICTS.join(", ")}`,
        required: true,
        help: "How that stage went.",
      },
      {
        name: "--detail",
        kind: "value",
        placeholder: "<text>",
        help: "One line of prose for a reader; the verdict is what machines read.",
      },
      { name: "--dry-run", kind: "flag", help: "Validate and preview without side effects." },
    ],
  },
  {
    // OFF every agent surface (VC-92 §3, done in VC-163). Archiving is app-only
    // curation: a person deciding a Ticket has stopped being live work. No
    // bundle carries it, no CLI access mode projects it, and `verbTier` reads
    // the empty list as no governance class at all rather than as a tier.
    //
    // The entry stays HERE, whole, rather than being deleted — that is what
    // makes the door teach instead of lying. `declaredVerb` finds it and
    // answers WRONG_DOOR ("exists in the app only; no agent surface executes
    // it"); deleting the entry would produce UNSUPPORTED_COMMAND, which reads
    // as "no such verb" and sends an agent looking for a way to do it by hand.
    // `listed: true` is load-bearing for exactly that reason.
    //
    // Reversible the day a workflow needs it: put `"cli"` back. The handler,
    // the options and the effects contract are all still here and still bound.
    key: "ticket.archive",
    accessModes: [],
    actor: "session",
    handler: { site: "main", id: "ticket.archive" },
    listed: true,
    referenceOrder: 18,
    group: "Write",
    summary: "Archive a ticket (its worktree is preserved).",
    example: "volli ticket archive VC-12",
    effects: {
      durableWrites: [
        {
          resource: "ticket",
          operation: "update",
          summary: "Mark the Ticket archived and append its attributed archive event.",
        },
      ],
      humanVisible: [
        "The Ticket leaves the active board and remains available as archived history.",
      ],
      nonEffects: ["The Ticket worktree is preserved and active Sessions are not ended."],
    },
    positionalId: "required",
    positionalSubject: "ticket",
    options: [],
  },
  {
    key: "ticket.brief",
    accessModes: ["cli"],
    actor: "any",
    handler: { site: "main", id: "ticket.brief" },
    listed: true,
    referenceOrder: 5,
    group: "Read",
    summary: "Print the agent kickoff prompt for a ticket.",
    example: "volli ticket brief VC-12",
    positionalId: "required",
    positionalSubject: "ticket",
    options: [],
  },
  {
    key: "worktree.status",
    accessModes: ["cli"],
    actor: "any",
    handler: { site: "main", id: "worktree.status" },
    listed: true,
    referenceOrder: 6,
    group: "Read",
    summary: "Show a ticket's worktree branch, base, and sync state.",
    example: "volli worktree status VC-12",
    notes: ["Read-only; defaults to the ticket owning the current directory."],
    positionalId: "optional",
    positionalSubject: "ticket",
    options: [],
  },
  {
    key: "worktree.diff",
    accessModes: ["cli"],
    actor: "any",
    handler: { site: "main", id: "worktree.diff" },
    listed: true,
    referenceOrder: 7,
    group: "Read",
    summary: "Summarize a ticket's diff (the PR range by default).",
    example: "volli worktree diff VC-12 --working-tree",
    notes: [
      "Read-only; defaults to the ticket owning the current directory.",
      "Default range is the merge-base diff (what the PR would contain).",
      "--working-tree switches to the uncommitted working-tree view.",
    ],
    positionalId: "optional",
    positionalSubject: "ticket",
    options: [
      {
        name: "--working-tree",
        kind: "flag",
        help: "Diff the uncommitted working tree instead of the PR range.",
      },
    ],
  },
  {
    // Worktree staleness as a verb (VC-185, split from VC-89 slice 2), so it
    // stops being per-kickoff prose every session interprets differently.
    //
    // COORDINATION TIER, by VC-92's audit principle: no verb needs a higher
    // tier than the ambient authority its effect already lies within. Sync
    // mutates only a worktree the `execute` coding tool already reaches with a
    // two-line git incantation, so control-tier ceremony would buy nothing and
    // cost composability. An authenticated session actor, on the Agent CLI.
    //
    // The one hard constraint, pinned on VC-89 and repeated here because it is
    // the reason this verb exists: IT MUST NOT BLOCK. Not on gates, not on CI,
    // not on a remote. A verb that waits is a watch/wake tool (VC-85) and
    // belongs on the Agent Tool Surface where a runtime can suspend the turn —
    // the `--watch` wedge is the exact failure this verb was invented to
    // delete. Its own async Git runner enforces a hard child-process deadline
    // mechanically; the socket cannot cancel a child once it has accepted a
    // request. It merges, reports conflicts, and returns.
    //
    // VC-178's voluntary-write rule applies here too. Its preview resolves the
    // base ref and checkout identity, then stops before either merge mode can
    // mutate the worktree.
    key: "worktree.sync",
    accessModes: ["cli"],
    actor: "session",
    handler: { site: "main", id: "worktree.sync" },
    listed: true,
    referenceOrder: 19,
    group: "Write",
    summary: "Merge a ticket's base branch into its worktree branch and report what happened.",
    example: "volli worktree sync VC-12",
    notes: [
      "Defaults to the ticket owning the current directory.",
      "Merges the base ref this checkout already has (origin/<base> when present, else the local branch) and contacts no remote.",
      "It never waits: no gate, no CI, no watch. Local Git runs asynchronously behind a hard deadline, then it reports and returns.",
      "A conflict is an outcome, not an error: status is conflicted, every conflicted path is listed, and the worktree is left conflicted for this session to resolve.",
      "--dry-run resolves the base ref and branch-identity check without merging or aborting.",
      "--abort undoes a merge left in flight. Nothing else here cleans up after a conflict.",
    ],
    effects: {
      durableWrites: [
        {
          resource: "worktree",
          operation: "update",
          summary:
            "Merge the base ref into the ticket worktree's checked-out branch, leaving a merge commit or an unresolved merge in that worktree.",
        },
      ],
      humanVisible: [
        "The ticket's worktree status and Change Set show the merged base, or the conflicted merge awaiting resolution.",
      ],
      nonEffects: [
        "No Ticket moves, no Session starts, and no signal is recorded.",
        "Nothing is fetched, pushed, or pulled: no remote is contacted and no credential is used.",
        "No gate, check, or CI run is started or waited on.",
      ],
    },
    positionalId: "optional",
    positionalSubject: "ticket",
    options: [
      {
        name: "--abort",
        kind: "flag",
        help: "Abort a merge left in flight by an earlier conflicted sync.",
      },
      { name: "--dry-run", kind: "flag", help: "Validate and preview without side effects." },
    ],
  },
  {
    // The file-collision radar (VC-185, split from VC-89 slice 3): Volli holds
    // every worktree's diff, so the overlap between them is a projection it can
    // already answer — "VC-65 and VC-68 both touch chat-plane.tsx" — instead of
    // a fact an orchestrator carries in its head until merge time.
    //
    // READ TIER, any caller, and VC-92's amendment says why that is the whole
    // design: this is the verb that most rewards being a CLI string in a bash
    // pipeline. Zero context cost, composable, and nothing it reports is worth
    // paying a named tool's prompt rent for.
    key: "conflicts",
    accessModes: ["cli"],
    actor: "any",
    handler: { site: "main", id: "conflicts" },
    listed: true,
    referenceOrder: 8,
    group: "Read",
    summary: "Report which active ticket worktrees touch the same files.",
    example: "volli conflicts --json",
    notes: [
      "Compares each active worktree's diff against its own base; no worktree is touched and no remote is contacted.",
      "Shared paths, not predicted merge failures: two tickets editing opposite ends of one file still merge cleanly.",
      "No overlap is the healthy answer and prints as one.",
      "A worktree whose diff could not be read is named as skipped rather than dropped.",
    ],
    options: [{ name: "--project", kind: "value", placeholder: "<p>", help: "Target project." }],
  },
  {
    key: "project.list",
    accessModes: ["cli"],
    actor: "any",
    handler: { site: "main", id: "project.list" },
    listed: true,
    referenceOrder: 9,
    group: "Read",
    summary: "List all registered projects.",
    example: "volli project list",
    options: [],
  },
  {
    // The operator's bootstrap write on a headless host (VC-623): a fresh
    // `volli-hostd` has an empty board and no window to add a folder from.
    //
    // `user` actor: the person, proven by a hostd-issued operator token. No
    // Session may register a project, whatever a policy says — a folder on the
    // board is a folder the host's Sessions will be pointed at, and choosing
    // that is the person's act. Unlisted, so `volli help` and the managed skill
    // an agent reads never offer a verb no agent can run; the operator's
    // reference is `apps/hostd/README.md`.
    key: "project.add",
    accessModes: ["cli"],
    actor: "user",
    handler: { site: "main", id: "project.add" },
    listed: false,
    group: "Write",
    summary: "Register a folder on this host as a project (operator only).",
    example: "volli project add /srv/code/acme --name Acme",
    notes: [
      "Needs an operator token: run `sudo volli-hostd operator-token --for <login>` on the host.",
      "Validates exactly as the app's Add Project does: an existing directory, a ticket prefix no other project holds.",
      "A folder already registered answers with that project rather than a second one.",
    ],
    effects: {
      durableWrites: [
        {
          resource: "project",
          operation: "create",
          summary: "Create one Project row tracking the folder, with its detected base branch.",
        },
      ],
      humanVisible: ["The project appears in the rail and `volli project list`."],
      nonEffects: [
        "Nothing in the folder is read, written, committed or checked out; git is asked only which branch is the base.",
        "No Ticket, worktree or Session is created.",
      ],
    },
    positionalId: "required",
    positionalLabel: "path",
    options: [
      {
        name: "--name",
        kind: "value",
        placeholder: "<name>",
        help: "Display name; the ticket prefix derives from it (default: the folder's name).",
      },
      { name: "--dry-run", kind: "flag", help: "Validate and preview without side effects." },
    ],
  },
  {
    key: "label.list",
    accessModes: ["cli"],
    actor: "any",
    handler: { site: "main", id: "label.list" },
    listed: true,
    referenceOrder: 10,
    group: "Read",
    summary: "List a project's labels.",
    example: "volli label list --project VC",
    options: [{ name: "--project", kind: "value", placeholder: "<p>", help: "Target project." }],
  },
  {
    // The one verb whose PREVIEW is the default and whose write needs a flag
    // (VC-310). It declares no `--dry-run`, because omitting `--apply` already
    // is one; see `label-verbs.ts` for why this verb inverts the rule.
    key: "label.merge",
    accessModes: ["cli"],
    actor: "session",
    handler: { site: "main", id: "label.merge" },
    listed: true,
    referenceOrder: 20,
    group: "Write",
    previewsByDefault: true,
    summary: "Fold one label into another, previewing the affected tickets.",
    example: "volli label merge --from front-end --into frontend",
    notes: [
      "Previews by default: without --apply nothing is written.",
      "Case variants are already one label, so this is for names that merely mean the same thing.",
      "Every Ticket wearing the merged-away name comes out wearing the surviving one.",
      "The old name remains an alias, so using it later still resolves to the survivor.",
    ],
    effects: {
      durableWrites: [
        {
          resource: "ticket-label",
          operation: "update",
          summary:
            "Move every association from the merged-away label onto the surviving one, and record a labels_changed event per affected Ticket.",
        },
        {
          resource: "label",
          operation: "update",
          summary:
            "Retire the merged-away Label as an alias, so its old name keeps resolving to the survivor.",
        },
      ],
      humanVisible: [
        "Affected Ticket cards show the surviving label, and the merged-away one leaves the board's Label filter.",
      ],
      nonEffects: [
        "No Ticket moves, no Ticket loses a Label it was wearing, and the retired name is not re-created later.",
      ],
    },
    options: [
      {
        name: "--from",
        kind: "value",
        placeholder: "<name>",
        required: true,
        help: "Label to merge away.",
      },
      {
        name: "--into",
        kind: "value",
        placeholder: "<name>",
        required: true,
        help: "Label that survives.",
      },
      { name: "--apply", kind: "flag", help: "Perform the merge instead of previewing it." },
      { name: "--project", kind: "value", placeholder: "<p>", help: "Target project." },
    ],
  },
  {
    // Model discovery (VC-78): the same Model Access snapshot the app reads,
    // narrowed to models the runtime can use — never a parallel provider probe
    // or a signed-out catalog in an agent's context.
    key: "model.list",
    accessModes: ["cli"],
    actor: "any",
    handler: { site: "main", id: "model.list" },
    listed: true,
    referenceOrder: 11,
    group: "Read",
    summary: "List available providers, model ids, and reasoning levels.",
    example: "volli model list",
    notes: [
      "Copy a printed <provider/model> verbatim into session start --model.",
      "Shows only models this profile can run.",
      // The tier table (VC-259): one entry per tier with `tier, label, hint,
      // resolvedFrom, model, reasoning` under `data.tiers`, so an agent can
      // name a KIND of work instead of copying an id.
      "Prints the model tier table below the catalog: each tier, what it is for, and the model and reasoning it resolves to (or which tier it falls back to when unset). Name one with session start --tier.",
    ],
    options: [],
  },
  {
    // What a pass cost, and where it went (VC-87).
    //
    // READ TIER, and VC-92's staging is explicit about why that is the whole
    // design: an orchestrator sampling spend must not pay context rent for the
    // privilege. So it is a CLI verb any caller may run rather than a named
    // tool sitting in every Role bundle's prompt — composable with the shell
    // the agent already has, and costing no model context until an agent
    // chooses to run it.
    //
    // Deliberately NOT a place to set a budget. Reading a cap is a read; a cap
    // the capped Session can write is decoration, so setting one is VC-44
    // app-owned policy and tripping one rides `ticket.signal` (VC-85).
    //
    // And deliberately not an account meter. What an API organization has
    // spent or has left is a different fact with a different credential and a
    // different freshness, and folding it into this total would let a
    // catalogue estimate be read as a bill.
    key: "cost",
    accessModes: ["cli"],
    actor: "any",
    handler: { site: "main", id: "cost" },
    listed: true,
    referenceOrder: 12,
    group: "Read",
    summary: "Report what Sessions consumed: tokens, cost, and cache class.",
    example: "volli cost --ticket VC-12 --group-by session",
    notes: [
      "Volli's own measurement of its Sessions, not a provider account balance or an invoice.",
      "~ marks a catalogue estimate, + marks a total only partly priced, and — means nothing could be priced.",
      "Token classes do not overlap: cache reads bill near 0.1x and cache writes near 1.25-2x, so a falling cached share is what a rising bill starts as.",
      "Cost is recorded per operation, never per token class — no split of the money by class is derivable.",
      "--since takes an RFC 3339 instant or a look-back like 7d, 24h or 90m.",
      "coverage says partial when the window reaches back past the point this profile began metering.",
    ],
    options: [
      { name: "--ticket", kind: "value", placeholder: "<id>", help: "Only this ticket's spend." },
      {
        name: "--session",
        kind: "value",
        placeholder: "<handle>",
        help: "Only this session's spend, by short id.",
      },
      { name: "--project", kind: "value", placeholder: "<p>", help: "Target project." },
      {
        name: "--all-projects",
        kind: "flag",
        help: "Every project this profile holds, not just one.",
      },
      {
        name: "--since",
        kind: "value",
        placeholder: "<when>",
        help: "Only operations at or after this instant or look-back.",
      },
      {
        name: "--group-by",
        kind: "value",
        placeholder: "<dimension>",
        values: `valid: ${SESSION_USAGE_GROUPINGS.join(", ")}`,
        help: "Break the total down along one dimension.",
      },
    ],
  },
  {
    key: "session.list",
    // Also on the WebSocket (VC-663, D4): Workspace-scoped there, and the
    // person's only. A Session reading another's transcript stays this
    // socket verb's disclosure policy to decide.
    accessModes: ["cli", "hostApi"],
    actor: "any",
    handler: { site: "main", id: "session.list" },
    listed: true,
    referenceOrder: 25,
    group: "Session",
    summary: "List a project's active and recent terminal and chat sessions.",
    example: "volli session list --ticket VC-12",
    notes: [
      "Prints each session's title and short id; session show and peek take either type.",
      "Default: working, waiting, interrupted, running or idle with pending subagents at any age, plus activity in the last 24h. --since replaces that window; --all removes it. --state intersects these filters.",
      "Chat rows and peek also name pending delegated subagents, even if those children are filtered out.",
      "Terminal and chat rows name who started a session unless a person did, and who last reattached it, even before another turn begins.",
      "Chat rows carry liveness: working, waiting (with what on), interrupted (with why), idle, or stopped, plus the age of the last durable fact — triage from the list before spending a peek.",
      "Chat rows also name their model and reasoning level, led by the tier (fast, deep, visual, ticket, global) the start resolved it from, when one was named.",
    ],
    options: [
      { name: "--project", kind: "value", placeholder: "<p>", help: "Filter by project." },
      { name: "--ticket", kind: "value", placeholder: "<id>", help: "Filter by ticket." },
      { name: "--all", kind: "flag", help: "Include older sessions." },
      {
        name: "--state",
        kind: "value",
        placeholder: "<s>[,<s>...]",
        help: "Filter by working, waiting, idle, stopped, interrupted, running or exited.",
      },
      {
        name: "--since",
        kind: "value",
        placeholder: "<when>",
        help: "Activity window: RFC 3339 instant or look-back (24h, 7d, 90m).",
      },
    ],
    catalog: { actor: "user", scope: "workspace", idempotency: "read" },
  },
  {
    key: "session.show",
    // Also on the WebSocket (VC-663, D4): Workspace-scoped there, and the
    // person's only. A Session reading another's transcript stays this
    // socket verb's disclosure policy to decide.
    accessModes: ["cli", "hostApi"],
    actor: "any",
    handler: { site: "main", id: "session.show" },
    listed: true,
    referenceOrder: 25.5,
    group: "Session",
    summary: "Show a session's identity, state, ancestry, model and usage.",
    example: "volli session show a1b2c3d4",
    notes: [
      "Handle is a short session id from session list — terminal or chat.",
      "Terminal and chat details include who started it and who last reattached it. Chat details also include its latest turn's sender, parent and children, and pending subagents. Reattachment history is independent of turns.",
      "Prints the latest durable done/blocked signal, its age and quoted reason, or signal - when none exists. --json includes signal: {kind, reason, at, ageMs} or null; at is Unix time in milliseconds; ageMs is elapsed milliseconds. Reads need no operator token.",
    ],
    positionalId: "required",
    options: [],
    catalog: { actor: "user", scope: "workspace", idempotency: "read" },
  },
  {
    // Read tier despite the disclosure it carries: cross-session transcript
    // access is per-actor policy data (VC-44), not a tier change.
    key: "session.peek",
    // Also on the WebSocket (VC-663, D4): Workspace-scoped there, and the
    // person's only. A Session reading another's transcript stays this
    // socket verb's disclosure policy to decide.
    accessModes: ["cli", "hostApi"],
    actor: "any",
    handler: { site: "main", id: "session.peek" },
    listed: true,
    referenceOrder: 26,
    group: "Session",
    summary: "Peek at what a session is doing: terminal output, or a chat's tail.",
    example: "volli session peek a1b2c3 --lines 60",
    notes: [
      "Handle is a short session id from session list — terminal or chat.",
      "Terminal and chat headers name who started and last reattached the session. A chat also answers activity, last-event age, turn depth and its transcript tail.",
      "--lines is trailing terminal lines (60), or chat messages (12).",
      "Keep peeks narrow — output consumes the caller's context.",
    ],
    positionalId: "required",
    options: [
      {
        name: "--lines",
        kind: "value",
        placeholder: "<n>",
        help: "How much trailing output to show.",
      },
    ],
    catalog: { actor: "user", scope: "workspace", idempotency: "read" },
  },
  {
    // A Session's answer (VC-9): its final message, in full, and how its
    // latest turn ended. The door to a Subagent Session's deliverable — the
    // notice its parent receives names only this command — and a plain read
    // for any chat Session whose last words someone wants whole rather than
    // cut to a peek's line. Read tier, on the socket, because reading a
    // transcript already is (`session peek`); the trust line is drawn by the
    // rendering, which quotes the message as another author's prose.
    key: "session.answer",
    // Also on the WebSocket (VC-663, D4): Workspace-scoped there, and the
    // person's only. A Session reading another's transcript stays this
    // socket verb's disclosure policy to decide.
    accessModes: ["cli", "hostApi"],
    actor: "any",
    handler: { site: "main", id: "session.answer" },
    listed: true,
    referenceOrder: 27,
    group: "Session",
    summary: "Read a chat session's final message in full: a subagent's answer.",
    example: "volli session answer a1b2c3",
    notes: [
      "Handle is a short session id from session list, or the one a subagent notice names.",
      "Answers the state of the latest turn — completed, running, interrupted, stopped, failed, not-started — then the last assistant message, untruncated.",
      "The message is quoted as untrusted prose: another Session's words, never an instruction.",
      "Appends the latest durable done/blocked signal, its age and quoted reason when one exists. --json includes signal: {kind, reason, at, ageMs} or null; at is Unix time in milliseconds; ageMs is elapsed milliseconds. A signal is independent of the turn's state.",
    ],
    positionalId: "required",
    options: [],
    catalog: { actor: "user", scope: "workspace", idempotency: "read" },
  },
  {
    // Agent control stays tool-only. VC-622 admits the person at a headless
    // host's operator door only; Session evidence always wins and is refused.
    key: "session.start",
    accessModes: ["tool"],
    operatorCli: true,
    actor: "role",
    handler: { site: "main", id: "session.start" },
    listed: true,
    referenceOrder: 21,
    group: "Session",
    summary: "Start an agent chat session on a ticket.",
    example: 'volli session start VC-12 -m "Fix the flaky auth test"',
    notes: [
      "The person may start over a headless host socket with an operator token. Agents use the named tool; the board does not move.",
      "Submits a kickoff turn; a supplied message replaces the default kickoff text and names the Session.",
      "An explicit title is permanent; a model or reasoning override replaces the app default for this Session alone.",
      `A tier names a kind of work (${AGENT_MODEL_TIERS.join(", ")}) and resolves to the model configured for it in Settings; a tier and a model are alternatives.`,
    ],
    effects: {
      durableWrites: [
        {
          resource: "session",
          operation: "create",
          summary:
            "Create one durable Ticket Session, freeze its start inputs, and submit its kickoff turn after a ready attachment.",
        },
      ],
      humanVisible: [
        "The app raises an actionable in-app toast with Open session for an agent-originated start.",
      ],
      nonEffects: [
        "The Ticket does not move.",
        "The app does not steal focus or navigate until the person uses Open session.",
        "The calling Session is not paused: it is told about the started Session through later notices, not by waiting.",
      ],
    },
    tool: {
      name: "session_start",
      // Written for the model. It leads with WHEN and what the caller gains
      // (VC-459) — an owner, a worktree, a reviewable branch — and names its
      // lighter neighbour, `session_delegate`, as the answer for work that
      // must come back into this conversation, so the two are chosen between
      // rather than confused. Restraint follows: a tool that starts another
      // agent needs to say when not to. The last line is the one a
      // caller cannot learn from the schema — this door binds the caller's
      // identity itself, so there is no project or actor field to supply and
      // nothing to be gained by describing oneself.
      description: [
        "Start an agent chat Session on one Ticket and return as soon as it opens.",
        "Use it for work that deserves its own owner — its own worktree, branch, review and merge — that outlives this conversation, or that the person should follow on the board. From a Board Session this is the default for substantial implementation: create the Ticket first with `volli ticket create` when none exists. For a bounded question or check whose answer you need back in this conversation, use session_delegate instead.",
        "The new Session knows only its Ticket and your kickoff, so make the kickoff a complete brief: goal, scope, constraints, and what done means. Start independent Tickets together rather than one after another.",
        "The new Session runs on its own.",
        "When the person names a saved Automation, preserve that workflow rather than copying or rewriting its Instructions into a kickoff. If this Session holds `automation_run`, use that tool instead so the saved definition and Run history stay connected. If it does not, explain the missing tool and ask for a Board Session or a manual Run; do not bypass the missing tool with an improvised kickoff.",
        "A Board Session may choose any Ticket in its project. A Ticket Session granted this tool may choose only its own Ticket, and may start three Sessions on its own authority; starting more needs a slot the person driving has approved, usually by answering the question this call raises — where project policy allows the question at all. The Sessions it starts cannot start any of their own.",
        "This Session watches the one it started: a notice from Volli arrives here when its first turn ends, when it signals done or blocked, or if it is stopped — keep working meanwhile, or end your turn and the notice opens a new one.",
        "It does not move the Ticket on the board, and it does not wait for the work to finish.",
        "Volli binds the calling Session and scope itself: name the Ticket and nothing about yourself.",
      ].join(" "),
      input: [
        {
          name: "ticket",
          type: "string",
          required: true,
          description: "The display id of the Ticket to work, for example VC-12.",
        },
        {
          name: "message",
          type: "string",
          description:
            "The kickoff instruction the new Session opens with. Omit to send Volli's default kickoff.",
        },
        {
          name: "title",
          type: "string",
          description:
            "A permanent title for the Session. Omit to let Volli name it from the kickoff.",
        },
        {
          name: "model",
          type: "object",
          description: "Run the Session on a specific model instead of the configured default.",
          fields: [
            {
              name: "providerId",
              type: "string",
              required: true,
              description: "Provider id, as `model list` prints it.",
            },
            {
              name: "modelId",
              type: "string",
              required: true,
              description: "Model id, as `model list` prints it.",
            },
          ],
        },
        {
          name: "tier",
          type: "enum",
          values: AGENT_MODEL_TIERS,
          description: MODEL_TIER_DESCRIPTION,
        },
        {
          name: "reasoning",
          type: "enum",
          values: REASONING_LEVELS,
          description: "Reasoning level override; the chosen model must support it.",
        },
      ],
      // What a program fanning out Sessions acts on (VC-471): the handle it
      // watches or steers, and the Ticket it started on, so it never parses
      // the prose for either.
      resultDetails: {
        type: "object",
        description: "The Session this call started.",
        properties: {
          sessionId: OPENED_SESSION_FIELDS.sessionId,
          handle: OPENED_SESSION_FIELDS.handle,
          ticket: {
            type: "string",
            description: "The display id of the Ticket it works, for example VC-12.",
          },
          title: OPENED_SESSION_FIELDS.title,
          model: OPENED_SESSION_FIELDS.model,
          state: OPENED_SESSION_FIELDS.state,
        },
        required: ["sessionId", "handle", "ticket", "title", "model", "state"],
        additionalProperties: false,
      },
    },
    positionalId: "required",
    positionalSubject: "ticket",
    options: [
      {
        name: "-m",
        kind: "value",
        placeholder: "<text>",
        group: "message",
        help: "Kickoff message.",
      },
      {
        name: "--message",
        kind: "value",
        placeholder: "<text>",
        group: "message",
        hidden: true,
        help: "Alias for -m.",
      },
      { name: "--title", kind: "value", placeholder: "<text>", help: "Explicit session title." },
      {
        name: "--model",
        kind: "value",
        placeholder: "<provider/model>",
        help: "Model override.",
      },
      // Documentation parity with the tool's `tier` field (VC-259), and only
      // that: `session.start` has had no shell door since VC-163, so this row
      // is what the reference prints beside `--model`, never argv the shell
      // will parse. The rule it mirrors is the door's: a tier and a model are
      // alternatives.
      {
        name: "--tier",
        kind: "value",
        placeholder: "<tier>",
        values: MODEL_TIER_VALUES,
        help: "Model tier override; an alternative to --model.",
      },
      {
        name: "--reasoning",
        kind: "value",
        placeholder: "<level>",
        values: REASONING_VALUES,
        help: "Reasoning level override.",
      },
    ],
  },
  {
    key: "session.done",
    accessModes: ["cli"],
    actor: "session",
    handler: { site: "main", id: "session.done" },
    listed: true,
    referenceOrder: 28,
    group: "Session",
    summary: "Record that this session's work is finished.",
    example: 'volli session done --reason "Tests pass"',
    notes: [
      "Acts on VOLLI_SESSION; needs a Volli session.",
      "Records the signal in the session ledger; the board does not move. Use ticket move for that.",
      "Leaves this session's last todo list on the ticket as a comment, when it kept one.",
    ],
    effects: {
      durableWrites: [
        {
          resource: "session-ledger",
          operation: "append",
          summary:
            "Append a completed done signal command and receipt to the current Session ledger.",
        },
        // VC-6. Conditional, and said so: a Board Session has no ticket, and a
        // Session that never called `todo_write` has nothing to post. The
        // preview names the write anyway, because `--dry-run` describes what
        // the verb MAY do — a caller told only about the ledger would be
        // surprised by a comment on their ticket.
        {
          resource: "ticket-comment",
          operation: "create",
          summary:
            "Create one attributed Ticket comment holding this Session's final todo list, when it kept one and belongs to a Ticket.",
        },
      ],
      humanVisible: [
        "The done signal and optional reason appear in the Session's durable history.",
        "The Session's final todo list appears in the Ticket activity feed.",
      ],
      nonEffects: [
        "No Ticket moves, the Session identity remains openable, and its worktree is not removed.",
        "No comment is written for a Board Session or for one that kept no todo list.",
      ],
    },
    options: [
      { name: "--reason", kind: "value", placeholder: "<text>", help: "Human-readable reason." },
      { name: "--dry-run", kind: "flag", help: "Validate and preview without side effects." },
    ],
  },
  {
    key: "session.blocked",
    accessModes: ["cli"],
    actor: "session",
    handler: { site: "main", id: "session.blocked" },
    listed: true,
    referenceOrder: 29,
    group: "Session",
    summary: "Signal the current session is blocked and needs a person.",
    example: 'volli session blocked --reason "Needs credentials"',
    notes: [
      "Acts on VOLLI_SESSION; needs a Volli session.",
      "Raises attention on this session; --reason is the text a person sees.",
      "Leaves this session's last todo list on the ticket as a comment, when it kept one.",
    ],
    effects: {
      durableWrites: [
        {
          resource: "session-ledger",
          operation: "append",
          summary:
            "Append a completed blocked signal command and receipt to the current Session ledger.",
        },
        // VC-6, and the more useful of the two: an unfinished list beside a
        // reason is most of a handover to the person the block is for.
        {
          resource: "ticket-comment",
          operation: "create",
          summary:
            "Create one attributed Ticket comment holding this Session's unfinished todo list, when it kept one and belongs to a Ticket.",
        },
      ],
      humanVisible: [
        "The Session raises attention in the app and shows the optional reason.",
        "The Session's todo list as it stood appears in the Ticket activity feed.",
      ],
      nonEffects: [
        "No Ticket moves, and the Session is not archived or deleted.",
        "No comment is written for a Board Session or for one that kept no todo list.",
      ],
    },
    options: [
      { name: "--reason", kind: "value", placeholder: "<text>", help: "Human-readable reason." },
      { name: "--dry-run", kind: "flag", help: "Validate and preview without side effects." },
    ],
  },
  {
    key: "session.link",
    accessModes: ["cli"],
    actor: "session",
    handler: { site: "main", id: "session.link" },
    listed: true,
    referenceOrder: 30,
    group: "Session",
    summary: "Record the harness's own session id on the current Volli session.",
    example: "volli session link 4f1c9a2e-8b7d-4e5a-9c3f-2a1b0d6e5f4c",
    notes: [
      "Acts on VOLLI_SESSION; needs a Volli session.",
      "Seeds resume-on-re-entry; usually run from the harness's session-start hook.",
    ],
    effects: {
      durableWrites: [
        {
          resource: "session-attachment",
          operation: "update",
          summary: "Record the harness-native resume identity on the current terminal attachment.",
        },
      ],
      humanVisible: ["Reopening or resuming the Session uses the recorded harness conversation."],
      nonEffects: ["No model turn starts, no Ticket moves, and no new Session is created."],
    },
    positionalId: "required",
    options: [
      { name: "--dry-run", kind: "flag", help: "Validate and preview without side effects." },
    ],
  },
  {
    // The other involuntary one: a harness's own PATH-shim wrapper announcing
    // that IT is what is now running in this terminal, one step before it
    // execs. `harness_id` is the launch and never moves; this is what a
    // terminal is running after the user quit one agent and started another in
    // it. Unlisted for the same reason `hook` is — the reference is what an
    // agent can usefully DO, and a verb whose only correct caller is a file
    // Volli generated is noise in it. It still walks the parser.
    key: "session.harness",
    accessModes: ["cli"],
    actor: "session",
    handler: { site: "main", id: "session.harness" },
    listed: false,
    group: "Session",
    summary: "Record which harness is now running in the current Volli session.",
    example: "volli session harness claude-code",
    notes: [
      "Acts on VOLLI_SESSION; needs a Volli session.",
      "Fired by the harness's launch wrapper, not typed.",
    ],
    positionalId: "required",
    options: [
      {
        name: "--mint",
        kind: "flag",
        hidden: true,
        help: "Mint this launch's harness session id and print it.",
      },
    ],
  },
  {
    key: "notify",
    accessModes: ["cli"],
    actor: "session",
    handler: { site: "main", id: "notify" },
    listed: true,
    referenceOrder: 31,
    group: "Session",
    summary: "Send a native notification to the user.",
    example: 'volli notify -m "Needs input"',
    effects: {
      durableWrites: [],
      humanVisible: [
        "Electron raises a native macOS notification with the supplied title and body.",
      ],
      nonEffects: [
        "It is not an in-app Sonner toast and creates no Ticket row, Ticket event, or Session event.",
      ],
    },
    options: [
      {
        name: "-m",
        kind: "value",
        placeholder: "<text>",
        group: "message",
        required: true,
        help: "Notification body.",
      },
      {
        name: "--message",
        kind: "value",
        placeholder: "<text>",
        group: "message",
        hidden: true,
        help: "Alias for -m.",
      },
      { name: "--title", kind: "value", placeholder: "<text>", help: "Notification title." },
      { name: "--dry-run", kind: "flag", help: "Validate and preview without side effects." },
    ],
  },
  {
    // The involuntary channel: a harness hook reporting what the agent is
    // doing, rather than an agent choosing to say so. Unlike every other verb
    // it is not addressed to a human reader — `volli hook` fires it and
    // discards the answer, because a hook that fails must never wedge the agent
    // it fired from. It bypasses the parser entirely (two bare positionals,
    // its own argv handling), so it declares no option table and no example:
    // there is no invocation a reader of the reference should ever type.
    key: "hook",
    accessModes: ["cli"],
    actor: "session",
    handler: { site: "main", id: "hook" },
    listed: false,
    group: "Session",
    summary: "Report a harness hook event for the current session.",
    options: [],
  },
  {
    // Diagnostics, not agent surface: what the harness integration is actually
    // doing on this machine, measured from inside the environment under test.
    key: "doctor",
    accessModes: ["cli"],
    actor: "any",
    handler: { site: "main", id: "doctor" },
    listed: true,
    referenceOrder: 34,
    group: "App",
    summary: "Audit the harness integration and report what it is actually doing.",
    example: "volli doctor --fix",
    notes: [
      "Reports outcomes, not configuration: whether typing a harness's name here really reaches Volli's wrapper.",
      "Run it inside a Volli terminal — several checks describe the shell it runs in.",
      "--fix regenerates the wrappers, harness configs and shell integration, then re-runs both Session PATH adoption passes. It names the outcome and added directories for new Sessions; a Session already running keeps its startup environment.",
      "--dry-run is valid only with --fix and previews the repair without inspecting or touching managed files.",
    ],
    effects: {
      when: "--fix",
      durableWrites: [
        {
          resource: "harness-integration",
          operation: "update",
          summary:
            "Regenerate Volli-managed CLI links, wrappers, harness configuration, and shell integration, then refresh Session PATH adoption for future Sessions.",
        },
      ],
      humanVisible: ["The CLI prints the repair result and a fresh integration check."],
      nonEffects: [
        "The running Session keeps its startup environment; no Ticket, Session, model turn, or notification is created.",
      ],
    },
    options: [
      {
        name: "--fix",
        kind: "flag",
        help: "Regenerate, re-run Session PATH adoption, then re-check.",
      },
      { name: "--dry-run", kind: "flag", help: "Validate and preview --fix without side effects." },
    ],
  },
  {
    // Diagnostics too: what a fresh structured Session's composed prompt costs,
    // per section, before the user types a word (VC-66). Main answers it
    // because main owns the composition — the same layers, index and Brief a
    // real start assembles — so the breakdown is reproducible rather than a
    // one-off count.
    key: "prompt.baseline",
    accessModes: ["cli"],
    actor: "any",
    handler: { site: "main", id: "prompt.baseline" },
    listed: true,
    referenceOrder: 33,
    group: "App",
    summary: "Measure the prompt baseline a fresh chat Session starts with, per section.",
    example: "volli prompt baseline",
    notes: [
      "Token counts are estimates at 4 characters/token; the provider's own meter is the count of record.",
      "Each section names a cache class — how often its bytes are bought again, claimed rather than measured; message-side sections are marked, and never invalidate the Cache Prefix.",
      "Excludes tool definitions, the user's first message, and provider overhead, which ride on top of everything counted here.",
      "--ticket prices a Ticket Session instead, including that ticket's Brief.",
    ],
    options: [
      {
        name: "--ticket",
        kind: "value",
        placeholder: "<id>",
        help: "Price a Ticket Session for this ticket instead of a Board chat.",
      },
      {
        name: "--project",
        kind: "value",
        placeholder: "<p>",
        help: "Resolve against this project instead of the context ladder.",
      },
    ],
  },
  // The two local verbs. They are on the Agent CLI like every verb above, but
  // `volli` answers them in its own process — so they are absent from
  // AGENT_COMMANDS, which is the SOCKET projection, not the CLI surface. That
  // difference is exactly what `handler.site` records, and it is why main's
  // dispatch table cannot hold a binding for either: neither reaches the
  // socket, so neither is in AgentCommandBindingId to be bound.
  {
    key: "app.launch",
    accessModes: ["cli"],
    actor: "any",
    handler: { site: "cli", id: "app.launch" },
    listed: true,
    referenceOrder: 32,
    group: "App",
    summary: "Launch the Volli app if it isn't already running.",
    example: "volli app launch",
    notes: ["Retry the failed command once the app is up."],
    effects: {
      durableWrites: [],
      humanVisible: ["The Volli desktop app opens or remains running."],
      nonEffects: ["No Ticket or Session is created, moved, or signalled."],
    },
    options: [
      {
        name: "--timeout",
        kind: "value",
        placeholder: "<n>",
        help: "Seconds to wait for readiness.",
      },
    ],
  },
  {
    key: "help",
    accessModes: ["cli"],
    actor: "any",
    handler: { site: "cli", id: "help" },
    listed: true,
    referenceOrder: 35,
    group: "App",
    summary: "Show this reference, a command's help, or a topic.",
    example: "volli help ticket create",
    notes: [`Topics: ${HELP_TOPIC_NAMES.join(", ")}.`],
    extraUsage: "[<command> | <topic>]",
    options: [],
  },
  {
    // The watch/wake tool (VC-85), RETIRED by VC-457. A parked tool call is a
    // chat the person driving cannot use, so waiting became events: `watch`
    // arms a subscription and returns, and the fact arrives later as a notice.
    // The entry stays, in place, because declaration order is the frozen tool
    // order and Sessions born holding `ticket_await` must reattach with that
    // exact surface; for them the handler now arms the equivalent watch and
    // returns at once. No Role bundle holds it, and no grant may name it.
    key: "ticket.await",
    accessModes: ["tool"],
    actor: "role",
    handler: { site: "main", id: "ticket.await" },
    listed: false,
    retired: "watch",
    group: "Session",
    summary: "Retired: arm a watch on tickets and return at once (use watch).",
    effects: {
      durableWrites: [],
      humanVisible: [
        "A later matching ticket change appears in the calling Session as a notice from Volli.",
      ],
      nonEffects: [
        "No ticket changes: nothing is written, nothing moves, and no other Session is contacted.",
        "The calling Session is not paused; the call returns at once.",
      ],
    },
    tool: {
      name: "ticket_await",
      // Read only by Sessions whose frozen surface predates VC-457, so it says
      // what the call does NOW: nothing waits any more.
      description: [
        "Retired: this no longer waits. It arms a watch on the named tickets and returns at once; a verdict signal, new comment or board move made by anyone but this Session later arrives here as a notice from Volli, read mid-turn or opening a new turn.",
        "Keep working after calling it, or end your turn; do not poll or sleep in bash for the change.",
        "What may be watched is project policy; a refusal names what the policy allows.",
      ].join(" "),
      input: [
        {
          name: "tickets",
          type: "string",
          required: true,
          description: `One to ${MAX_TICKET_AWAIT_TARGETS} ticket display ids in this project, separated by spaces or commas, for example 'VC-12 VC-14'.`,
        },
        {
          name: "for",
          type: "enum",
          values: TICKET_AWAIT_FOR,
          description:
            "What a later notice reports: a verdict signal, a comment, a board move, or any of the three. Defaults to any.",
        },
        {
          name: "timeoutSeconds",
          type: "number",
          description: "Ignored: nothing waits any more.",
        },
        {
          name: "cursor",
          type: "string",
          description: "Ignored: nothing waits any more.",
        },
      ],
    },
    options: [],
  },
  {
    // The orchestrator's Automation verb (VC-134), filed by VC-112's ruling
    // rather than minted beside it: "Do not mint a verb in this ticket. File it
    // as a Verb Registry entry under VC-92's rules, in the `project` Role
    // bundle only." So the whole of that ticket is this row plus one name in
    // one bundle — no CLI verb, no IPC channel of its own, and no second
    // implementation of a Run. The handler binding resolves the same Run door
    // (`packages/host-core/src/automations/run.ts`) the palette, the rail and the board already
    // call, which is what makes a Run an agent started indistinguishable in
    // its record from a Run a person started by hand.
    //
    // Control tier, and tool-only for the reason `session.start` is: this verb
    // spends model budget and opens agent work, so a socket door would put it
    // within reach of any process running as the user. A tool call carries its
    // caller in the binding instead of in the request.
    //
    // Why it fans out without the Automation format growing a control flow:
    // VC-112 keeps one Run to one Session deliberately, and points at the
    // orchestrator for multi-Ticket work. An agent holding this verb walks the
    // Tickets itself and starts one Run each, so "one Run, one Session" stays
    // true while a scheduled sweep still covers a board.
    //
    // The agent Target is a ruled exception (VC-230), not an inference from the
    // saved Trigger. The scheduler and every person-facing Run door keep
    // VC-112/VC-130's "the Trigger decides the Target": a schedule targets its
    // Project. This agent-only door may instead aim one invocation of that same
    // schedule-trigger Automation at one named Ticket. It does not edit the
    // Trigger; it gives the orchestrator an explicit Ticket target for this Run.
    //
    // Appended, never inserted. Declaration order is the canonical tool order,
    // and a Session whose surface was frozen before this verb existed must find
    // every tool it already held exactly where it already was.
    //
    // `listed: true` (VC-329) follows the `session.start` and `session.stop`
    // precedent for a tool-only verb: the reference is where an agent learns
    // the verb's real door. Previously only the frozen tool array exposed it;
    // listing it also makes CLI-based discovery possible. This addresses one
    // plausible cause of agents substituting custom kickoffs for saved work.
    // Listing costs nothing unsafe: the reference line and the `volli help
    // automation run` detail page teach the Agent Tool Surface door, and the
    // parser still refuses any shell invocation with the name of the door that
    // does hold it.
    key: "automation.run",
    accessModes: ["tool"],
    actor: "role",
    handler: { site: "main", id: "automation.run" },
    listed: true,
    referenceOrder: 36,
    example: 'volli automation run "Nightly sweep" VC-12',
    notes: [
      "Runs as a named tool in the Board Session's tool bundle; the shell never executes it.",
      "Runs a saved Automation a person already wrote; it cannot create or edit one.",
    ],
    group: "Session",
    summary: "Run a saved Automation on one Ticket, opening one fresh Session.",
    effects: {
      durableWrites: [
        {
          resource: "automation-run",
          operation: "create",
          summary:
            "Create one Automation Run with its resolved model and reasoning, open the fresh Session it names with the `automation` Actor, and deliver the Automation's Instructions as that Session's first message.",
        },
      ],
      humanVisible: [
        "The Run appears in the Ticket's Run history and its Session is marked with the `automation` Actor \u2014 the same record a person's Run by hand writes, with nothing naming the agent that asked for it.",
      ],
      nonEffects: [
        "The Ticket does not move, and no existing Session is woken: a Run always opens a fresh one.",
        "It does not wait for the Run to finish; the calling Session watches the Run's Session and hears about it through later notices.",
        "No Automation is created, edited or armed \u2014 this verb runs a saved one and authors nothing.",
      ],
    },
    tool: {
      name: "automation_run",
      // Written for the model, and again mostly about restraint. The third
      // line is the one a caller cannot learn from the schema: an Automation
      // is a saved thing a person authored, so there is no way to pass
      // Instructions here and no way to invent one \u2014 a name that does not exist
      // is answered with the names that do.
      description: [
        "Start a saved Automation on one Ticket in this project: it opens one fresh Session carrying that Automation's Instructions, and returns as soon as the Run is recorded.",
        "This includes an Automation whose Trigger is a schedule: although the schedule itself and person-facing Run doors target the Project, this agent-only invocation is a ruled exception that aims its one Run at the named Ticket without changing the Trigger.",
        "Use it to fan a saved piece of work out across Tickets, one Run per Ticket; each Run runs on its own, and this Session watches its Session: a notice from Volli arrives here when its first turn ends, when it signals done or blocked, or if it is stopped.",
        "Prefer this over composing an equivalent `session_start` kickoff by hand: the Automation is the person's authored, rerunnable version of that work.",
        "It runs an Automation a person already wrote and cannot create or edit one, so name an existing Automation \u2014 an unknown name is answered with the ones this project has.",
        "It does not move the Ticket, and it does not wait for the work to finish.",
        "Volli binds the calling Session and project itself: name the Automation and the Ticket, and nothing about yourself.",
      ].join(" "),
      input: [
        {
          name: "automation",
          type: "string",
          required: true,
          description:
            "The name of the Automation to run, spelled as it is in Volli, for example 'Nightly sweep'.",
        },
        {
          name: "ticket",
          type: "string",
          required: true,
          description:
            "The display id of the Ticket this agent invocation targets, including for a schedule-trigger Automation, for example VC-12.",
        },
      ],
    },
    options: [],
  },
  {
    // Supervision half one (VC-86): end another Session's work. Control tier
    // by the same structural argument as `session.start` — control over other
    // agents is only safe where the caller's identity is unspoofable, so the
    // verb is ABSENT from the socket rather than gated on it, and the shell
    // answers WRONG_DOOR. Appended after `automation.run`, because registry
    // declaration order is the frozen tool order and inserting earlier would
    // shift `ticket.await` and `automation.run` inside every already-frozen
    // surface record.
    //
    // `listed: true` is load-bearing exactly as it is for `ticket.archive`:
    // `volli session stop a1b2c3` must teach its real door, never answer
    // UNSUPPORTED_COMMAND and send the agent hunting for a workaround.
    key: "session.stop",
    accessModes: ["tool"],
    actor: "role",
    handler: { site: "main", id: "session.stop" },
    listed: true,
    referenceOrder: 22,
    group: "Session",
    summary: "Stop another agent session's work, recording who stopped it.",
    example: "volli session stop a1b2c3d4",
    notes: [
      "Runs as a named tool in the Board Session's tool bundle; the shell never executes it.",
      "Records a durable stopped event with the calling Session as actor, interrupts any open turn, and releases the executor.",
      "The Session identity survives: its history stays openable, and a person can reattach it.",
    ],
    effects: {
      durableWrites: [
        {
          resource: "session-ledger",
          operation: "append",
          summary:
            "Append a session.stop command and its stopped event, naming the calling Session as the actor, to the target Session's ledger.",
        },
      ],
      humanVisible: [
        "The target Session shows Stopped wherever sessions list, with the stop and its actor in its durable history.",
      ],
      nonEffects: [
        "The Session is not archived or deleted, its worktree is untouched, and no Ticket moves.",
        "No new Session starts, and the stopped Session can be reattached by a person.",
      ],
    },
    tool: {
      name: "session_stop",
      // Written for the model, and mostly about restraint: a stop is for work
      // that is wedged or wrong, not work that is merely slow. The liveness
      // read is named so the model checks before it kills.
      description: [
        "Stop another agent Session in this project: interrupt its open turn, release its executor, and record a durable stopped event naming this Session as the actor.",
        "Use it on a Session that is wedged or doing the wrong work — check `volli session list` or `volli session peek` first; a long quiet turn can be hard work rather than a hang.",
        "It is not an undo: work already committed stays. The stopped Session's history remains openable, and a person can reattach it.",
        "Volli binds the calling Session and project itself: name the target session and nothing about yourself.",
      ].join(" "),
      input: [
        {
          name: "session",
          type: "string",
          required: true,
          description: "The target's short session id, as `volli session list` prints it.",
        },
        {
          name: "reason",
          type: "string",
          description:
            "One line of why, recorded on the stopped event for the person who reads it later.",
        },
      ],
    },
    positionalId: "required",
    options: [],
  },
  {
    // Supervision half two (VC-86): steer a message into a running Session —
    // the channel the rc-0.1.0 pass lacked when owner direction ("use the
    // thinking-orbs library") had no way into a mid-flight implementer.
    // Control tier with `session.stop` for the same structural reason, and
    // appended after it for the same frozen-order one.
    key: "session.send",
    accessModes: ["tool"],
    actor: "role",
    handler: { site: "main", id: "session.send" },
    listed: true,
    referenceOrder: 23,
    group: "Session",
    summary: "Steer a message into another running agent session.",
    example: 'volli session send a1b2c3d4 -m "Use the thinking-orbs library"',
    notes: [
      "Runs as a named tool in the Board Session's tool bundle; the shell never executes it.",
      "Delivers into the target's live executor — mid-turn it steers the model now, between turns it opens one.",
      "The message arrives marked as supervisor steering from this Session, never as the target's own user.",
    ],
    effects: {
      durableWrites: [
        {
          resource: "session-ledger",
          operation: "append",
          summary:
            "Append a message.submit command carrying the marked steering message to the target Session's ledger.",
        },
      ],
      humanVisible: [
        "The steering message appears in the target Session's transcript, marked with the sending Session.",
      ],
      nonEffects: [
        "It does not wait for the target's turn to finish; the calling Session watches the target and is told when that turn ends, through a later notice.",
        "No Ticket moves, no Session stops, and no new Session starts.",
      ],
    },
    tool: {
      name: "session_send",
      description: [
        "Steer a message into another agent Session in this project: mid-turn the model reads it now, between turns it opens a new turn.",
        "Use it to redirect running work — a correction, a constraint, an owner decision — instead of stopping the Session and starting over.",
        "The message is delivered marked as steering from this Session; the receipt says whether it opened or joined a turn.",
        "It does not wait for a reply. This Session watches the target: a notice from Volli arrives here when the turn your message opened or joined ends, when it signals done or blocked, or if it is stopped.",
        "Volli binds the calling Session and project itself: name the target session and nothing about yourself.",
      ].join(" "),
      input: [
        {
          name: "session",
          type: "string",
          required: true,
          description: "The target's short session id, as `volli session list` prints it.",
        },
        {
          name: "message",
          type: "string",
          required: true,
          description: "The steering direction the target Session reads.",
        },
      ],
    },
    positionalId: "required",
    options: [],
  },
  {
    // Delegation to a bounded helper (VC-9): hand one task to a new Subagent
    // Session and go on working. The child is a real Session — its own Role,
    // transcript, model attachment and row in the session list — never a
    // hidden thread inside the parent. When its first turn completes a NOTICE
    // is steered into the parent carrying Volli's facts and the child's final
    // message, quoted inside an untrusted-prose envelope as the child's own
    // words (VC-457). The parent is not parked on it, and nothing times it out.
    //
    // Control tier, tool-only, for the reason `session.start` is: it opens
    // agent work and spends a model, so it must carry its caller in the
    // binding rather than in a request any same-uid process could forge. In
    // BOTH working bundles: an executor needs "go read this and report back"
    // as much as an orchestrator does, and what makes that safe is the child's
    // bundle — no agent-control verb, no `watch`, no `ask_user` — not
    // the parent's Role. Depth is therefore structural: a child has no
    // `session.delegate` to call, so there is no grandchild to count.
    //
    // Appended after `session.send`, because registry declaration order is
    // the frozen tool order and inserting earlier would shift every verb after
    // it inside every already-frozen surface record.
    key: "session.delegate",
    accessModes: ["tool"],
    actor: "role",
    handler: { site: "main", id: "session.delegate" },
    // Listed for the reason `session.stop` is: `volli session delegate` must
    // teach its real door rather than answer UNSUPPORTED_COMMAND. It prints
    // beside `session send`, the verb it is most often mistaken for.
    listed: true,
    referenceOrder: 24,
    group: "Session",
    summary: "Delegate one task to a subagent Session that answers back here.",
    example: 'volli session delegate "Find where the auth token is refreshed"',
    notes: [
      "Runs as a named tool in the project and ticket Role bundles; the shell never executes it.",
      "Returns as soon as the subagent starts. When its first turn completes, a notice from Volli arrives in this Session carrying its final message; `volli session answer <handle>` prints it again in full.",
      "The subagent shares this Session's working directory, holds every coding tool, and cannot ask a person or start, stop, steer or delegate to other Sessions.",
    ],
    effects: {
      durableWrites: [
        {
          resource: "session",
          operation: "create",
          summary:
            "Create one durable Subagent Session with this Session as its parent, freeze its start inputs, and submit the task as its kickoff turn after a ready attachment.",
        },
        {
          resource: "session-ledger",
          operation: "append",
          summary:
            "When the subagent's first turn completes, append a notice from Volli to this Session's ledger naming the subagent and its state and quoting its final message as the subagent's prose; a long message is cut, with `session answer` naming the rest.",
        },
      ],
      humanVisible: [
        "The subagent appears in the parent Session's Activity Island, where the person can inspect its transcript or open it as a tab. It has no separate Session-list row.",
      ],
      nonEffects: [
        "No Ticket moves, and the person driving is not asked anything.",
        "This Session is not paused: the call returns at once and the answer arrives later.",
      ],
    },
    tool: {
      name: "session_delegate",
      // Written for the model. The first two sentences are WHEN (VC-459): the
      // benefit — context isolation, parallelism, a cheaper tier — and then the
      // cases that stay inline, because a description that only grants
      // permission reads as a caveat list and gets used when someone asks.
      // Everything after is protocol (VC-457), the facts the schema cannot
      // carry: the answer arrives by itself as a notice (so the model goes on
      // working rather than waiting or polling), nothing bounds the child's
      // time, and the child shares the working tree (so two agents
      // editing one file is the model's own coordination problem to avoid).
      // The last line is the same one every control-tier tool ends on.
      description: [
        "A subagent works in its own context, not yours, and only its answer comes back here. Use it for bounded work when the raw output would crowd this conversation and you will not need it again — a broad codebase search, log or test triage, a diff review, web research — for independent checks to run in parallel, or for a second-opinion review; a cheaper `tier` often fits.",
        "Stay inline instead for a specific file read, a known-symbol lookup, a small edit, or work that needs what you have already worked out.",
        "Hand one well-defined task to a new subagent Session and return at once; the subagent runs on its own, with no time limit, until it answers.",
        "Its answer arrives by itself: when it finishes, a notice from Volli lands in this Session carrying its final message — read mid-turn if you are working, or opening a new turn if you have ended yours. Keep working meanwhile; do not poll or wait for it. A very long answer is cut, and `volli session answer <handle>` prints it in full. Several may run at once: launch independent tasks in the same turn rather than one after another.",
        "The subagent starts with none of your context, so brief it as if it knows nothing: the goal, the paths and decisions it needs, its constraints, and what the answer should contain. It cannot ask a person, so an unclear requirement comes back as an open question, not a guess.",
        "It shares this Session's working directory and holds every coding tool, so give each file one owner and keep it clear of edits you are making.",
        "It cannot start, stop, steer or delegate to other Sessions.",
        "Volli binds the calling Session, its project and its Ticket itself: state the task and nothing about yourself.",
      ].join(" "),
      input: [
        {
          name: "task",
          type: "string",
          required: true,
          description:
            "The delegated task, complete on its own: what to do, where to look, and what the answer should contain.",
        },
        {
          name: "title",
          type: "string",
          description:
            "A permanent title for the subagent Session. Omit to let Volli name it from the task.",
        },
        {
          name: "model",
          type: "object",
          description:
            "Run the subagent on a specific model instead of the one this Session runs on.",
          fields: [
            {
              name: "providerId",
              type: "string",
              required: true,
              description: "Provider id, as `model list` prints it.",
            },
            {
              name: "modelId",
              type: "string",
              required: true,
              description: "Model id, as `model list` prints it.",
            },
          ],
        },
        {
          name: "tier",
          type: "enum",
          values: AGENT_MODEL_TIERS,
          description: DELEGATE_MODEL_TIER_DESCRIPTION,
        },
        {
          name: "reasoning",
          type: "enum",
          values: REASONING_LEVELS,
          description: "Reasoning level override; the chosen model must support it.",
        },
      ],
      // `sessionId` and `title` predate this schema (VC-9): the transcript's
      // delegate row links the child by the one and names it by the other
      // (`agent-runtime/src/pi/activity.ts`), so both keep their names.
      resultDetails: {
        type: "object",
        description: "The subagent Session this call started.",
        properties: OPENED_SESSION_FIELDS,
        required: ["sessionId", "handle", "title", "model", "state"],
        additionalProperties: false,
      },
    },
    options: [],
  },
  {
    // The watch/wake tool over Sessions (VC-324 item 3), RETIRED by VC-457 on
    // `ticket.await`'s terms: kept in place for frozen surfaces, in no bundle,
    // and answering by arming the equivalent watch and returning at once.
    // It was appended rather than filed beside its siblings because registry
    // declaration order IS the frozen tool order, so anything inserted earlier
    // shifts every verb after it inside every already-frozen surface record,
    // and a shifted tool array invalidates the Cache Prefix — including the
    // system prompt, where the provider orders tools first.
    //
    // A separate tool rather than a `sessions` field on `ticket.await`, for the
    // same arithmetic seen from the other side: appending a tool shifts
    // nothing, while growing an existing tool's schema changes bytes for every
    // Session already born — none of which could ever call the new field, since
    // a Session's surface is frozen at birth.
    //
    // Tool-only and off the socket, exactly as `ticket.await` is: a CLI verb
    // must never wait, and the socket's ten-second request timeout enforces
    // that mechanically. Blocking belongs where the runtime can suspend the
    // turn and wake it.
    key: "session.await",
    accessModes: ["tool"],
    actor: "role",
    handler: { site: "main", id: "session.await" },
    listed: false,
    retired: "watch",
    group: "Session",
    summary: "Retired: arm a watch on Sessions and return at once (use watch).",
    effects: {
      durableWrites: [],
      humanVisible: [
        "A later turn end, verdict or stop of a watched Session appears in the calling Session as a notice from Volli.",
      ],
      nonEffects: [
        "No Session is contacted, steered or stopped: nothing is written and nothing moves.",
        "The calling Session is not paused; the call returns at once.",
      ],
    },
    tool: {
      name: "session_await",
      // Read only by Sessions whose frozen surface predates VC-457.
      description: [
        "Retired: this no longer waits. It arms a watch on the named Sessions and returns at once; when one's next turn ends, when it signals done or blocked, or if it is stopped, a notice from Volli arrives here — read mid-turn, or opening a new turn if you have ended yours.",
        "Keep working after calling it, or end your turn; do not poll `volli session list` or sleep in bash.",
        "A Board Session may watch any Session in its project; a Ticket Session only the subagents it delegated. What may be watched is project policy; a refusal names what the policy allows.",
      ].join(" "),
      input: [
        {
          name: "sessions",
          type: "string",
          required: true,
          description: `One to ${MAX_SESSION_AWAIT_TARGETS} short session ids in this project, as \`volli session list\` prints them, separated by spaces or commas, for example 'a1b2c3d4 e5f6a7b8'.`,
        },
        {
          name: "for",
          type: "enum",
          values: SESSION_AWAIT_FOR,
          description:
            "What a later notice reports: a turn ending (completed or interrupted), a done/blocked signal, a stop, or any of the three. Defaults to any.",
        },
        {
          name: "timeoutSeconds",
          type: "number",
          description: "Ignored: nothing waits any more.",
        },
        {
          name: "cursor",
          type: "string",
          description: "Ignored: nothing waits any more.",
        },
      ],
    },
    options: [],
  },
  // ── The MCP management family (VC-380) ───────────────────────────────────
  //
  // Appended after `session.await` for the reason that entry states about
  // itself (`watch`, VC-457, is appended after this family for the same one): registry declaration order IS the frozen tool order, so anything
  // inserted earlier shifts every verb after it inside every already-frozen
  // surface record, and a shifted tool array throws away the Cache Prefix.
  //
  // Eight verbs and not one `mcp` verb with a `command` field, deliberately.
  // A model choosing between `mcp_preview` and `mcp_install` is choosing
  // between "look" and "change", which is the distinction the whole family
  // exists to make legible; a single verb with a mode string would put that
  // choice inside an argument, where no schema, no preview and no Role bundle
  // could see it.
  //
  // What is NOT here is as deliberate: an MCP server's own tools are dynamic
  // settings data, frozen into a Session's surface by id (VC-8), and they never
  // become registry entries. These verbs manage the servers; they are not the
  // servers' tools.
  {
    key: "mcp.list",
    accessModes: ["tool"],
    actor: "role",
    handler: { site: "main", id: "mcp.list" },
    listed: true,
    referenceOrder: 37,
    group: "App",
    summary: "List this project's configured MCP servers, their tools, and where each came from.",
    example: "volli mcp list",
    notes: [
      "Reads the project's own configuration; nothing is connected and no server process is started.",
      "Provenance is what an install RECORDED, never what Volli verified: a version is what was asked for and a digest is what was claimed.",
      "A server marked stale kept its last working tool list after a failed refresh; mcp_refresh retries it.",
    ],
    effects: {
      durableWrites: [],
      humanVisible: [
        "Nothing changes: this reads the same configuration Settings → Configure → MCP Servers shows.",
      ],
      nonEffects: [
        "No server is connected, no process is started, and no Session's tool list changes.",
      ],
    },
    tool: {
      name: "server_list",
      description: [
        "List the MCP servers configured for this project: each server's transport, whether it is on, which of its tools are selected, whether its catalog went stale, and the provenance recorded when it was installed.",
        "Read this before installing anything, so an install that already exists becomes a refresh instead of a duplicate.",
        "It connects to nothing and starts no process.",
      ].join(" "),
      input: [],
    },
    options: [],
  },
  {
    // Connect and look, with nothing written. Separate from `mcp.install`'s
    // own preview because the two answer different questions: this one asks
    // "what does this server offer", and an install preview asks "what would
    // change here". A caller exploring a server it may not want should not
    // have to phrase the question as an install it then declines.
    key: "mcp.preview",
    accessModes: ["tool"],
    actor: "role",
    handler: { site: "main", id: "mcp.preview" },
    listed: true,
    referenceOrder: 38,
    group: "App",
    summary: "Connect to an MCP server and show its tools without saving anything.",
    example: "volli mcp preview",
    notes: [
      "Starts the local command or opens the remote connection for as long as the handshake takes, then closes it.",
      "Nothing is stored: no server row, no tool selection, no provenance.",
      "Bounded by the 10-second connection limit, and by this turn's own cancellation.",
    ],
    effects: {
      durableWrites: [],
      humanVisible: [
        "A local server's process is started for the length of the handshake, and a remote server sees one connection.",
      ],
      nonEffects: [
        "Nothing is saved: the project's MCP configuration is exactly as it was, and no Session gains a tool.",
      ],
    },
    tool: {
      name: "server_preview",
      description: [
        "Connect to one MCP server you already have the configuration for, read its tool list, and save nothing.",
        "Use it to see what a server offers before deciding what to install and which of its tools to turn on.",
        "It does not search a registry or look a server up by name: you supply the command or URL.",
        "A local command runs on this machine as you, with your file access, for as long as the handshake takes; a remote URL receives a connection from this machine.",
      ].join(" "),
      input: MCP_SERVER_FIELDS,
    },
    options: [],
  },
  {
    // The one verb in the family that both previews and writes, and the reason
    // it previews by default is `label.merge`'s: the write is destructive in a
    // way a caller cannot undo by calling something else. Starting a process
    // as the user, or handing a third party every argument its tools are
    // given, is not a step back from.
    key: "mcp.install",
    accessModes: ["tool"],
    actor: "role",
    handler: { site: "main", id: "mcp.install" },
    listed: true,
    referenceOrder: 39,
    group: "App",
    previewsByDefault: true,
    summary: "Add or update one MCP server for this project, after previewing what it would do.",
    example: "volli mcp install",
    notes: [
      "Previews by default: without confirm=apply nothing is connected for real and nothing is written.",
      "Volli downloads nothing. A local server is a command that must already be on PATH — usually run through npx or uvx — and source, version and digest are recorded as provenance, never fetched or verified.",
      "Saving the same server id twice updates that row in place, so repeating an install cannot create a duplicate.",
      "Settings are written only after discovery succeeds. A first-time failure writes nothing at all; a failed update keeps the last working tool list and marks the server stale.",
      "Credentials are routed to the person: no field here carries a header, an environment value or a token. A server that needs a sign-in asks the person driving to sign in (confirm.mcp-sign-in); one that needs a key must be given it in Settings \u2192 Configure \u2192 MCP Servers.",
    ],
    effects: {
      durableWrites: [
        {
          resource: "mcp-server",
          operation: "update",
          summary:
            "Store the server's transport, its discovered tool catalog, the tools selected from it, and the provenance supplied with the request, keyed on the server id so a repeat updates rather than duplicates.",
        },
        {
          resource: "mcp-operation",
          operation: "append",
          summary:
            "Append one durable audit record naming the request, its source, its outcome, and what to do if it failed.",
        },
      ],
      humanVisible: [
        "The server appears in Settings → Configure → MCP Servers with its provenance and selected tools, and the install shows in that project's MCP history.",
      ],
      nonEffects: [
        "The calling Session gains nothing: its tool list was frozen at birth and is byte-identical afterwards. The selected tools reach the next Session created.",
        "No package is downloaded, unpacked or verified, and no existing Session's tool list changes.",
      ],
    },
    tool: {
      name: "server_install",
      description: [
        "Add or update one MCP server for this project.",
        'Called plainly it PREVIEWS: it connects, reports the tools it found and the exact warning for this kind of server, and writes nothing. Call it again with confirm="apply" to perform it.',
        "Read the warning before applying. A local (stdio) server is a command Volli starts on this machine as you, with your files and your network; a remote (http) server receives whatever arguments its tools are given, and Volli cannot see what it does with them.",
        "The tools you select do NOT appear in this Session. A Session's tool list is frozen when it is created, so they become usable in the next Session created after the install.",
        "Installing the same id twice updates that server in place. Volli downloads nothing: source, version and digest are recorded as provenance only.",
      ].join(" "),
      input: [
        ...MCP_SERVER_FIELDS,
        {
          name: "tools",
          type: "string",
          description:
            "Which discovered tools to turn on, as names separated by spaces or commas. Omit to install the server with no tool selected, then use server_tools. A name the server did not offer is refused rather than ignored.",
        },
        {
          name: "source",
          type: "string",
          description:
            "Where this configuration came from, recorded so a person can audit it later: a registry entry, a URL, or a document. Recorded as given; Volli fetches nothing from it.",
        },
        {
          name: "registryType",
          type: "enum",
          values: MCP_REGISTRY_TYPES,
          description:
            "The ecosystem the source named, as an MCP server.json spells it. Recorded metadata; Volli resolves nothing in that ecosystem.",
        },
        {
          name: "version",
          type: "string",
          description:
            "The version string this install asked for. Recorded as asked; nothing pins the command that actually runs to it.",
        },
        {
          name: "digest",
          type: "string",
          description:
            "A digest the source published, such as an mcpb fileSha256. Recorded so a person can see what was pinned; it is never verified, because Volli downloads nothing to verify.",
        },
        MCP_CONFIRM_FIELD,
      ],
    },
    options: [],
  },
  {
    key: "mcp.refresh",
    accessModes: ["tool"],
    actor: "role",
    handler: { site: "main", id: "mcp.refresh" },
    listed: true,
    referenceOrder: 40,
    group: "App",
    summary: "Reconnect to a configured MCP server and re-read its tool catalog.",
    example: "volli mcp refresh",
    notes: [
      "Keeps the current tool selection; a selected tool the server no longer offers fails the refresh rather than being silently dropped.",
      "A failed refresh leaves the last working catalog in place and marks the server stale, so nothing that worked stops working.",
    ],
    effects: {
      durableWrites: [
        {
          resource: "mcp-server",
          operation: "update",
          summary:
            "Replace the stored tool catalog with the one just discovered, or mark the server stale with the failure while keeping the last working catalog.",
        },
      ],
      humanVisible: [
        "The server's tool list and status update in Settings → Configure → MCP Servers.",
      ],
      nonEffects: [
        "No existing Session changes: a Session's MCP tools are frozen at birth, and a refreshed catalog reaches the next Session created.",
      ],
    },
    tool: {
      name: "server_refresh",
      description: [
        "Reconnect to a server this project already has and re-read its tools, keeping the current selection.",
        "Use it after a server is upgraded, or to clear a stale marker left by an earlier failure.",
        "A failure leaves the last working tool list exactly as it was.",
      ].join(" "),
      input: [MCP_SERVER_ID_FIELD],
    },
    options: [],
  },
  {
    key: "mcp.enable",
    accessModes: ["tool"],
    actor: "role",
    handler: { site: "main", id: "mcp.enable" },
    listed: true,
    referenceOrder: 41,
    group: "App",
    summary: "Turn a configured MCP server on for Sessions created from now on.",
    example: "volli mcp enable",
    notes: [
      "Adding a server and turning it on are separate acts; this is the second one.",
      "Nothing is connected: enablement is a stored flag read when a Session is created.",
    ],
    effects: {
      durableWrites: [
        { resource: "mcp-server", operation: "update", summary: "Set the server's enabled flag." },
      ],
      humanVisible: ["The server's On checkbox in Settings → Configure → MCP Servers."],
      nonEffects: [
        "No existing Session gains a tool: a frozen tool list never changes. The next Session created sees the change.",
      ],
    },
    tool: {
      name: "server_enable",
      description: [
        "Turn a configured MCP server on, so its selected tools are offered to Sessions created after this call.",
        "It connects to nothing, and it does not change any Session that already exists.",
      ].join(" "),
      input: [MCP_SERVER_ID_FIELD],
    },
    options: [],
  },
  {
    // The safe counterpart to `mcp.remove`, and the reason removal's warning
    // can name an alternative rather than just refusing: disabling leaves the
    // row — and therefore the transport an older Session's frozen tool needs —
    // exactly where it was.
    key: "mcp.disable",
    accessModes: ["tool"],
    actor: "role",
    handler: { site: "main", id: "mcp.disable" },
    listed: true,
    referenceOrder: 42,
    group: "App",
    summary: "Turn a configured MCP server off without deleting it.",
    example: "volli mcp disable",
    notes: [
      "The reversible alternative to mcp_remove: the configuration stays, so older Sessions using this server can still reattach.",
      "Nothing is connected, and no running Session loses a tool it was born with.",
    ],
    effects: {
      durableWrites: [
        {
          resource: "mcp-server",
          operation: "update",
          summary: "Clear the server's enabled flag.",
        },
      ],
      humanVisible: ["The server's On checkbox in Settings → Configure → MCP Servers."],
      nonEffects: [
        "No existing Session loses a tool: a frozen tool list never changes, and the server's configuration is kept so reattachment keeps working.",
      ],
    },
    tool: {
      name: "server_disable",
      description: [
        "Turn a configured MCP server off, keeping its configuration.",
        "Sessions created after this call are not offered its tools; Sessions that already exist keep the tools they were born with and can still reattach.",
        "Prefer this to server_remove whenever the intent is only to stop offering the tools.",
      ].join(" "),
      input: [MCP_SERVER_ID_FIELD],
    },
    options: [],
  },
  {
    key: "mcp.tools",
    accessModes: ["tool"],
    actor: "role",
    handler: { site: "main", id: "mcp.tools" },
    listed: true,
    referenceOrder: 43,
    group: "App",
    summary: "Choose which of a configured server's discovered tools are on.",
    example: "volli mcp tools",
    notes: [
      "The selection replaces the current one: a discovered tool not named here is turned off.",
      "Only tools the last successful discovery found can be selected; an unknown name is refused rather than ignored.",
    ],
    effects: {
      durableWrites: [
        {
          resource: "mcp-server",
          operation: "update",
          summary: "Replace which of the stored catalog's tools are marked on.",
        },
      ],
      humanVisible: ["The per-tool checkboxes in Settings → Configure → MCP Servers."],
      nonEffects: [
        "No existing Session changes: its MCP tools are frozen at birth. The selection reaches the next Session created.",
      ],
    },
    tool: {
      name: "server_tools",
      description: [
        "Set exactly which of a configured server's tools are on, replacing the current selection.",
        "Anything the server offers that you do not name is turned off. Sessions created after this call get the new selection; existing Sessions are unchanged.",
      ].join(" "),
      input: [
        MCP_SERVER_ID_FIELD,
        {
          name: "tools",
          type: "string",
          required: true,
          description:
            "The complete set of tool names to leave on, separated by spaces or commas. Pass an empty string to turn every tool off.",
        },
      ],
    },
    options: [],
  },
  {
    // Previews by default for a reason `mcp.disable` does not share, and the
    // reason is a property of the frozen tool surface rather than of this
    // table: `serversForFrozenMcpTools` THROWS when a frozen tool's server is
    // gone, so deleting a row breaks reattachment for older Sessions that were
    // using it — an effect on Sessions the caller has never heard of.
    key: "mcp.remove",
    accessModes: ["tool"],
    actor: "role",
    handler: { site: "main", id: "mcp.remove" },
    listed: true,
    referenceOrder: 44,
    group: "App",
    previewsByDefault: true,
    summary: "Delete a configured MCP server, after previewing what it breaks.",
    example: "volli mcp remove",
    notes: [
      "Previews by default: without confirm=apply nothing is deleted.",
      "Older Sessions born holding one of this server's tools will fail to reattach once it is gone, because the transport their frozen tool needs no longer exists.",
      "mcp_disable is the reversible alternative and keeps reattachment working.",
    ],
    effects: {
      durableWrites: [
        {
          resource: "mcp-server",
          operation: "delete",
          summary: "Delete the server row, its stored catalog, and its tool selection.",
        },
        {
          resource: "mcp-operation",
          operation: "append",
          summary:
            "Append one durable audit record naming what was removed, by which Session, and what it may have broken.",
        },
      ],
      humanVisible: [
        "The server leaves Settings → Configure → MCP Servers, and the removal shows in that project's MCP history.",
      ],
      nonEffects: [
        "The calling Session's frozen tool list does not change, and no Session currently attached loses a tool mid-run.",
        "Session history is not edited: transcripts still name the tools that were called.",
      ],
    },
    tool: {
      name: "server_remove",
      description: [
        "Delete one MCP server's configuration from this project.",
        'Called plainly it PREVIEWS: it reports what would be deleted and what that breaks, and removes nothing. Call it again with confirm="apply" to perform it.',
        "This is more destructive than it looks. Any older Session that was born holding one of this server's tools will fail to reattach afterwards, because the transport its frozen tool needs is gone.",
        "Re-adding the server under the SAME id restores those Sessions; re-adding it under a different id does not.",
        "If the intent is only to stop offering the tools to new Sessions, call server_disable instead: it leaves every existing Session able to reattach.",
      ].join(" "),
      input: [MCP_SERVER_ID_FIELD, MCP_CONFIRM_FIELD],
    },
    options: [],
  },
  {
    // What replaced `ticket.await` and `session.await` (VC-457): a
    // subscription that RETURNS. The await tools parked the caller's turn
    // until a watched fact arrived, and a parked turn is a chat the person
    // driving cannot use. Here the call arms a watch and comes back; the fact
    // arrives later as a notice from Volli, steered into a turn in progress or
    // opening one on an idle Session — the delivery a subagent's answer has
    // always had.
    //
    // One tool for both subjects, because the two awaits differed only in
    // which ledger they read, and a caller watching a fleet names Sessions and
    // Tickets in the same breath. Appended LAST, after the MCP family, because
    // declaration order is the frozen tool order.
    //
    // Tool-only and control tier for the reason the awaits were: it reaches
    // into the caller's own ledger later, so its caller must be the bound
    // attachment, never a socket request. `session_start`, `automation_run`
    // and `session_send` arm the common case themselves; this is for the rest
    // — a Ticket someone else is working, a Session a person started, and
    // ending a watch.
    key: "watch",
    accessModes: ["tool"],
    actor: "role",
    handler: { site: "main", id: "watch" },
    listed: false,
    group: "Session",
    summary: "Get notices when watched Sessions or tickets change, without waiting.",
    effects: {
      durableWrites: [
        {
          resource: "session-ledger",
          operation: "append",
          summary:
            "Later, when a watched change lands, append one notice from Volli to this Session's ledger; changes that land together share one notice.",
        },
      ],
      humanVisible: [
        "Each notice appears in the calling Session's transcript as a Volli row naming what changed.",
      ],
      nonEffects: [
        "The call returns at once; the calling Session is never paused on it.",
        "Nothing about the watched Sessions or Tickets changes, and watches end when Volli relaunches.",
      ],
    },
    tool: {
      name: "watch",
      description: [
        "Watch Sessions or tickets in this project and return at once; later changes arrive in this Session as notices from Volli — read mid-turn if you are working, or opening a new turn if you have ended yours. Never poll or sleep to find out.",
        "A watched Session reports its next turn ending (with what it said last), a done or blocked signal, and a stop. A watched ticket reports every move, comment and signal made by anyone but this Session until you unwatch it.",
        'session_start, automation_run and session_send already watch the Session they open or steer; use this for other work, or with action "unwatch" to stop.',
        "A Board Session may watch any Session or ticket in its project; a Ticket Session any ticket and only the subagents it delegated. What may be watched is project policy; a refusal names what it allows.",
      ].join(" "),
      input: [
        {
          name: "sessions",
          type: "string",
          description: `Up to ${MAX_SESSION_AWAIT_TARGETS} short session ids, as \`volli session list\` prints them, separated by spaces or commas.`,
        },
        {
          name: "tickets",
          type: "string",
          description: `Up to ${MAX_TICKET_AWAIT_TARGETS} ticket display ids, for example 'VC-12 VC-14'.`,
        },
        {
          name: "action",
          type: "enum",
          values: ["watch", "unwatch"],
          description: "watch (the default) arms the watches; unwatch ends them.",
        },
      ],
      // The targets as the door resolved them, so a program can check what it
      // armed without reading the receipt's sentences back.
      resultDetails: {
        type: "object",
        description: "What this call armed or ended.",
        properties: {
          action: {
            type: "string",
            enum: ["watch", "unwatch"],
            description: "Which of the two this call did.",
          },
          sessions: {
            type: "array",
            items: { type: "string" },
            description:
              "The short session ids this call named, each one now watched (watch) or no longer watched (unwatch).",
          },
          tickets: {
            type: "array",
            items: { type: "string" },
            description:
              "The ticket display ids this call named, each one now watched (watch) or no longer watched (unwatch).",
          },
          ended: {
            type: "number",
            description:
              "unwatch: how many of the named targets this Session was watching and now is not. watch: always 0.",
          },
        },
        required: ["action", "sessions", "tickets", "ended"],
        additionalProperties: false,
      },
    },
    options: [],
  },
  // ---- The host-protocol command catalog: the Session router (VC-564) -----
  //
  // One entry per `@volli/session-rpc` procedure, keyed by its tRPC path; the
  // router's policy middleware reads nothing about a call but these rows. They
  // are on no agent surface: `hostApi` is the WebSocket projection, so `volli`
  // and a Role bundle never see them, and `listed: false` keeps them out of
  // help and the managed skill.
  //
  // Every row requires the person (`user`, a paired device or the desktop's
  // own window). The three reads included: a Session reading another
  // Session's transcript is `session.peek`'s disclosure policy to decide, and
  // a router door that admitted Sessions here would route around it.
  //
  // `settings.*` and `modelAccess.*` are host-scoped placeholders (D3), left
  // as they are for VC-572 to refine. `labDiagnostics.*` carries no access
  // mode: the router keeps it for the in-process lab, and no door serves it.
  {
    // The v1 bootstrap read (HP § Handshake): the welcome this connection's
    // handshake negotiated. In no feature, so every authenticated connection
    // may ask, a Session's included; it reveals only the caller's own grant.
    key: "protocol.welcome",
    accessModes: ["hostApi"],
    actor: "any",
    handler: { site: "main", id: "protocol.welcome" },
    listed: false,
    group: "App",
    summary: "Read the welcome this connection's handshake negotiated.",
    options: [],
    catalog: { scope: "host", idempotency: "read" },
  },
  {
    key: "sessions.create",
    accessModes: ["hostApi"],
    actor: "user",
    handler: { site: "main", id: "sessions.create" },
    listed: false,
    group: "Session",
    summary: "Create a durable Session in a project, with no executor attached yet.",
    options: [],
    catalog: { scope: "workspace", idempotency: "command-id" },
  },
  {
    key: "sessions.attach",
    accessModes: ["hostApi"],
    actor: "user",
    handler: { site: "main", id: "sessions.attach" },
    listed: false,
    group: "Session",
    summary: "Attach or reattach a Session's executor, starting or recovering its work.",
    options: [],
    catalog: { scope: "workspace", idempotency: "command-id" },
  },
  {
    key: "settings.experiments",
    accessModes: ["hostApi"],
    actor: "user",
    handler: { site: "main", id: "settings.experiments" },
    listed: false,
    group: "App",
    summary: "Read the experimental feature flags.",
    options: [],
    catalog: { scope: "host", idempotency: "read" },
  },
  {
    key: "settings.setExperiment",
    accessModes: ["hostApi"],
    actor: "user",
    handler: { site: "main", id: "settings.setExperiment" },
    listed: false,
    group: "App",
    summary: "Turn one experimental feature on or off.",
    options: [],
    catalog: { scope: "host", idempotency: "natural" },
  },
  {
    key: "modelAccess.inspect",
    accessModes: ["hostApi"],
    actor: "user",
    handler: { site: "main", id: "modelAccess.inspect" },
    listed: false,
    group: "App",
    summary: "Read the Model Access snapshot: providers, models and their availability.",
    options: [],
    catalog: { scope: "host", idempotency: "read" },
  },
  {
    key: "modelAccess.defaults",
    accessModes: ["hostApi"],
    actor: "user",
    handler: { site: "main", id: "modelAccess.defaults" },
    listed: false,
    group: "App",
    summary: "Read the default model for each purpose.",
    options: [],
    catalog: { scope: "host", idempotency: "read" },
  },
  {
    key: "modelAccess.setDefault",
    accessModes: ["hostApi"],
    actor: "user",
    handler: { site: "main", id: "modelAccess.setDefault" },
    listed: false,
    group: "App",
    summary: "Set or clear the default model for one purpose.",
    options: [],
    catalog: { scope: "host", idempotency: "natural" },
  },
  {
    key: "modelAccess.hiddenModels",
    accessModes: ["hostApi"],
    actor: "user",
    handler: { site: "main", id: "modelAccess.hiddenModels" },
    listed: false,
    group: "App",
    summary: "Read the models hidden from the pickers.",
    options: [],
    catalog: { scope: "host", idempotency: "read" },
  },
  {
    key: "modelAccess.setHiddenModels",
    accessModes: ["hostApi"],
    actor: "user",
    handler: { site: "main", id: "modelAccess.setHiddenModels" },
    listed: false,
    group: "App",
    summary: "Replace the list of models hidden from the pickers.",
    options: [],
    catalog: { scope: "host", idempotency: "natural" },
  },
  {
    key: "modelAccess.compactionPolicy",
    accessModes: ["hostApi"],
    actor: "user",
    handler: { site: "main", id: "modelAccess.compactionPolicy" },
    listed: false,
    group: "App",
    summary: "Read the automatic compaction policy.",
    options: [],
    catalog: { scope: "host", idempotency: "read" },
  },
  {
    key: "modelAccess.setCompactionPolicy",
    accessModes: ["hostApi"],
    actor: "user",
    handler: { site: "main", id: "modelAccess.setCompactionPolicy" },
    listed: false,
    group: "App",
    summary: "Replace the automatic compaction policy.",
    options: [],
    catalog: { scope: "host", idempotency: "natural" },
  },
  {
    key: "modelAccess.codeModePolicy",
    accessModes: ["hostApi"],
    actor: "user",
    handler: { site: "main", id: "modelAccess.codeModePolicy" },
    listed: false,
    group: "App",
    summary: "Read the Code Mode policy and its per-model pins.",
    options: [],
    catalog: { scope: "host", idempotency: "read" },
  },
  {
    key: "modelAccess.setCodeModePolicy",
    accessModes: ["hostApi"],
    actor: "user",
    handler: { site: "main", id: "modelAccess.setCodeModePolicy" },
    listed: false,
    group: "App",
    summary: "Replace the Code Mode policy and its per-model pins.",
    options: [],
    catalog: { scope: "host", idempotency: "natural" },
  },
  {
    key: "modelAccess.pickerView",
    accessModes: ["hostApi"],
    actor: "user",
    handler: { site: "main", id: "modelAccess.pickerView" },
    listed: false,
    group: "App",
    summary: "Read which list the model pickers open on.",
    options: [],
    catalog: { scope: "host", idempotency: "read" },
  },
  {
    key: "modelAccess.setPickerView",
    accessModes: ["hostApi"],
    actor: "user",
    handler: { site: "main", id: "modelAccess.setPickerView" },
    listed: false,
    group: "App",
    summary: "Set which list the model pickers open on.",
    options: [],
    catalog: { scope: "host", idempotency: "natural" },
  },
  {
    key: "session.snapshot",
    accessModes: ["hostApi"],
    actor: "user",
    handler: { site: "main", id: "session.snapshot" },
    listed: false,
    group: "Session",
    summary: "Read one Session's projection with its newest transcript frames.",
    options: [],
    catalog: { scope: "workspace", idempotency: "read" },
  },
  {
    key: "session.history",
    accessModes: ["hostApi"],
    actor: "user",
    handler: { site: "main", id: "session.history" },
    listed: false,
    group: "Session",
    summary: "Read one page of a Session's older transcript frames.",
    options: [],
    catalog: { scope: "workspace", idempotency: "read" },
  },
  {
    key: "session.projection",
    accessModes: ["hostApi"],
    actor: "user",
    handler: { site: "main", id: "session.projection" },
    listed: false,
    group: "Session",
    summary: "Read one Session's durable state without its transcript.",
    options: [],
    catalog: { scope: "workspace", idempotency: "read" },
  },
  {
    key: "session.subscribe",
    accessModes: ["hostApi"],
    actor: "user",
    handler: { site: "main", id: "session.subscribe" },
    listed: false,
    group: "Session",
    summary: "Follow one Session's stream, resuming after a cursor.",
    options: [],
    catalog: { scope: "workspace", idempotency: "read" },
  },
  {
    key: "session.subscribeQueue",
    accessModes: ["hostApi"],
    actor: "user",
    handler: { site: "main", id: "session.subscribeQueue" },
    listed: false,
    group: "Session",
    summary: "Follow one Session's stream with host queue updates, resuming after a cursor.",
    options: [],
    catalog: { scope: "workspace", idempotency: "read" },
  },
  {
    key: "session.command",
    // The start kinds have their own entries (`sessions.create`/`attach`),
    // which carry the Role, skills and model policy this raw command cannot.
    accessModes: ["hostApi"],
    actor: "user",
    handler: { site: "main", id: "session.command" },
    listed: false,
    group: "Session",
    summary: "Send one command to a Session under a caller-minted command id.",
    options: [],
    catalog: {
      scope: "workspace",
      idempotency: "command-id",
      refusedIntents: ["session.create", "adapter.attach", "message.cancel", "message.edit"],
    },
  },
  {
    key: "session.cancelQueued",
    accessModes: ["hostApi"],
    actor: "user",
    handler: { site: "main", id: "session.cancelQueued" },
    listed: false,
    group: "Session",
    summary: "Cancel one pending host-owned follow-up.",
    options: [],
    catalog: { scope: "workspace", idempotency: "command-id" },
  },
  {
    key: "session.editQueued",
    accessModes: ["hostApi"],
    actor: "user",
    handler: { site: "main", id: "session.editQueued" },
    listed: false,
    group: "Session",
    summary: "Edit one pending host-owned follow-up.",
    options: [],
    catalog: { scope: "workspace", idempotency: "command-id" },
  },
  {
    key: "session.cancelInteraction",
    accessModes: ["hostApi"],
    actor: "user",
    handler: { site: "main", id: "session.cancelInteraction" },
    listed: false,
    group: "Session",
    summary: "Cancel a pending interaction the person left undecided.",
    options: [],
    catalog: { scope: "workspace", idempotency: "natural" },
  },
  {
    key: "session.reconcile",
    accessModes: ["hostApi"],
    actor: "user",
    handler: { site: "main", id: "session.reconcile" },
    listed: false,
    group: "Session",
    summary: "Reconcile one attachment whose delivery is uncertain.",
    options: [],
    catalog: { scope: "workspace", idempotency: "natural" },
  },
  // The host's recent log (VC-699; HP § Tracing and logs): read-only, the
  // person's (an operator or a paired device; never a Session or a worker),
  // host-scoped so a fleet's control plane reads it through the same door.
  {
    key: "logs.tail",
    accessModes: ["hostApi"],
    actor: "user",
    handler: { site: "main", id: "logs.tail" },
    listed: false,
    group: "App",
    summary: "Read the host's most recent log lines, redacted and bounded.",
    options: [],
    catalog: { scope: "host", idempotency: "read" },
  },
  {
    key: "logs.follow",
    accessModes: ["hostApi"],
    actor: "user",
    handler: { site: "main", id: "logs.follow" },
    listed: false,
    group: "App",
    summary: "Follow the host's log from a cursor, as it is written.",
    options: [],
    catalog: { scope: "host", idempotency: "read" },
  },
  {
    key: "labDiagnostics.list",
    accessModes: [],
    actor: "user",
    handler: { site: "main", id: "labDiagnostics.list" },
    listed: false,
    group: "App",
    summary: "List the Session router's route diagnostics.",
    options: [],
    catalog: { scope: "host", idempotency: "read" },
  },
  {
    key: "labDiagnostics.subscribe",
    accessModes: [],
    actor: "user",
    handler: { site: "main", id: "labDiagnostics.subscribe" },
    listed: false,
    group: "App",
    summary: "Follow the Session router's route diagnostics.",
    options: [],
    catalog: { scope: "host", idempotency: "read" },
  },
  ...SIGN_IN_ENTRIES,
] as const satisfies readonly VerbEntry[];

type RegistryEntry = (typeof VERB_REGISTRY)[number];

/** Every declared verb key — the vocabulary rule packs and Role bundles name. */
export type VerbKey = RegistryEntry["key"];

/** The socket projection at the type level: handler site `main`, plus a `cli` access mode. */
type SocketProjected<E extends VerbEntry> = E extends { handler: { site: "main" } }
  ? "cli" extends E["accessModes"][number]
    ? E["key"]
    : E extends { operatorCli: true }
      ? E["key"]
      : never
  : never;

/**
 * The verbs the agent socket answers — {@link AGENT_COMMANDS}' member type, and
 * the closed union `AgentRequest.cmd` is checked against.
 */
export type AgentCommand = SocketProjected<RegistryEntry>;

/** The binding of a socket-projected verb, at the type level. */
type SocketBinding<E extends VerbEntry> = E extends { handler: { site: "main" } }
  ? "cli" extends E["accessModes"][number]
    ? E["handler"]["id"]
    : E extends { operatorCli: true }
      ? E["handler"]["id"]
      : never
  : never;

/**
 * Every handler id the socket resolves — the key set main's dispatch table is
 * a total mapping over (VC-167).
 *
 * Identical to {@link AgentCommand} today, because every binding id is its own
 * verb's key. It is a separate type because the two answer different
 * questions: `AgentCommand` is what a caller may put on the wire, and this is
 * what main must have a handler for. VC-162 is where they part — a verb that
 * leaves the `cli` access mode leaves the wire, and its binding goes on being
 * resolved by the surface that kept it.
 */
export type AgentCommandBindingId = SocketBinding<RegistryEntry>;

/**
 * The socket projection: entries whose handler lives in main AND that carry a
 * `cli` access mode. Takes its entries as an argument so a projection can be
 * proven against a synthetic table — no `tool`-only verb exists until VC-162.
 */
export function agentCommandsFrom(entries: readonly VerbEntry[]): readonly string[] {
  return socketProjectedFrom(entries).map((entry) => entry.key);
}

/** The socket-projected entries: a `main` handler site, plus a `cli` access mode. */
function socketProjectedFrom(entries: readonly VerbEntry[]): readonly VerbEntry[] {
  return entries.filter(
    (entry) =>
      entry.handler.site === "main" &&
      (entry.accessModes.includes("cli") || entry.operatorCli === true),
  );
}

/**
 * Which handler answers each socket verb — the wire name a caller sends,
 * mapped to the binding id main's dispatch table is keyed by.
 *
 * Derived, never authored, exactly as {@link AGENT_COMMANDS} is: this is the
 * declaration DRIVING the dispatch, which is what VC-167 replaced VC-161's
 * source-text parity scan with.
 */
export function agentCommandBindingsFrom(
  entries: readonly VerbEntry[],
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    socketProjectedFrom(entries).map((entry) => [entry.key, entry.handler.id]),
  );
}

/**
 * The commands the agent socket accepts — derived, never authored. A verb
 * reaches this list by declaring a `cli` access mode (or person-only operator
 * exception) and a `main` handler, so
 * the socket surface cannot drift from the registry.
 *
 * The cast restores the literal union {@link agentCommandsFrom} widens to
 * `string`; `verb-registry.test.ts` pins the exact runtime value, in order.
 * That test carries the list rather than this comment carrying a count — the
 * count was written once and then wrong twice, because a projection changes
 * whenever a row's access modes do.
 */
export const AGENT_COMMANDS = agentCommandsFrom(VERB_REGISTRY) as readonly AgentCommand[];

/**
 * The socket's verb-to-binding map — what main's dispatch table resolves a
 * request through. The cast restores the literal unions
 * {@link agentCommandBindingsFrom} widens to `string`.
 */
export const AGENT_COMMAND_BINDINGS = agentCommandBindingsFrom(VERB_REGISTRY) as Readonly<
  Record<AgentCommand, AgentCommandBindingId>
>;

/**
 * The socket's Session reads the WebSocket also serves (VC-663, D4): the same
 * handler, run with its roster forced to the connection's one Workspace.
 * Their router policy is the person's (`catalog.actor: "user"`).
 */
export const SESSION_READ_VERBS = [
  "session.list",
  "session.show",
  "session.peek",
  "session.answer",
] as const satisfies readonly (AgentCommand & CatalogKey)[];
export type SessionReadVerb = (typeof SESSION_READ_VERBS)[number];

/**
 * The Verb Tier a verb's access modes and actor requirement imply (VC-92 §2).
 * Never stored: no entry carries a tier field, and this is the only way to get
 * one.
 *
 * - **read** — Agent CLI, any caller. Composability and zero context cost.
 * - **coordination** — Agent CLI, an authenticated session actor or the
 *   person (`user`). Visible, attributable writes.
 * - **control** — `tool` access only, gated on a Role that holds the verb, and
 *   absent from the agent socket.
 * - **null** — no access mode at all. An app-only verb is on no agent surface,
 *   so it holds no governance class; `ticket.archive` becomes this in VC-163.
 *
 * A `hostApi`-only verb (VC-564) is tiered by the same actor rule as the CLI:
 * the WebSocket projection is a door an authenticated caller reaches, like the
 * socket, and never a Role bundle. So `any` reads, `user` and `session`
 * coordinate, and a Role-gated verb cannot ride it.
 *
 * Contradictory combinations throw instead of being mislabeled: a Role-gated
 * verb cannot remain on `cli` or `hostApi`, and absence from `cli` alone does
 * not make a non-Role verb control tier.
 */
export function verbTier(entry: Pick<VerbEntry, "accessModes" | "actor">): VerbTier | null {
  if (entry.accessModes.length === 0) return null;
  const hostApiOnly = entry.accessModes.every((mode) => mode === "hostApi");
  if (entry.accessModes.includes("cli") || hostApiOnly) {
    if (entry.actor === "role") {
      throw new Error(
        `A control-tier verb cannot carry a ${hostApiOnly ? "hostApi" : "cli"} access mode`,
      );
    }
    // `session` and `user` are both coordination: a visible, attributable
    // write on the socket. Who may run a `user` verb is the admission gate's
    // question, and it never reads a policy list for one.
    return entry.actor === "any" ? "read" : "coordination";
  }
  if (entry.actor !== "role" || entry.accessModes.length !== 1 || entry.accessModes[0] !== "tool") {
    throw new Error("Control tier requires tool-only access and a role actor");
  }
  return "control";
}

/** A Verb Registry entry the host-protocol catalog declares (VC-564). */
export type CatalogEntry = VerbEntry & { readonly catalog: VerbCatalogDeclaration };

// Distributive for the reason `ToolProjected` below spells out.
type Catalogued<E extends VerbEntry> = E extends { catalog: VerbCatalogDeclaration }
  ? E["key"]
  : never;
type ScopedTo<E extends VerbEntry, Scope extends VerbScope> = E extends {
  catalog: { scope: Scope };
}
  ? E["key"]
  : never;
type HostApiProjected<E extends VerbEntry> = E extends VerbEntry
  ? "hostApi" extends E["accessModes"][number]
    ? E["key"]
    : never
  : never;

/** Every Verb Registry entry, as its literal type: the default catalog a router builds from. */
export type VerbRegistryEntry = RegistryEntry;

/** The catalog keys among some entries: a router family built from its own catalog types its keys by this. */
export type CatalogKeyOf<E extends VerbEntry> = Catalogued<E>;

/** The catalog keys of one scope among some entries. */
export type CatalogKeyOfScope<E extends VerbEntry, Scope extends VerbScope> = ScopedTo<E, Scope>;

/** The catalog keys among some entries that withhold intents, whose input must carry `command.kind`. */
export type CatalogKeyRefusingIntents<E extends VerbEntry> = E extends {
  catalog: { refusedIntents: readonly string[] };
}
  ? E["key"]
  : never;

/** Every key the catalog declares: exactly the procedures the routers may publish. */
export type CatalogKey = Catalogued<RegistryEntry>;

/** The catalog keys of one scope, so a router builder can demand the resolver a scope needs. */
export type CatalogKeyScopedTo<Scope extends VerbScope> = ScopedTo<RegistryEntry, Scope>;

/** The WebSocket projection: every key a network door serves. */
export type HostApiKey = HostApiProjected<RegistryEntry>;

type AssertNever<Type extends never> = Type;
/** A `hostApi` entry with no catalog declaration has no policy to judge it by, and fails here. */
export type HostApiCatalogCoverage = AssertNever<Exclude<HostApiKey, CatalogKey>>;

/**
 * The catalog projection: entries carrying a {@link VerbCatalogDeclaration},
 * in declaration order. Throws on an entry no router could police:
 *
 * - a `hostApi` access mode with no declaration;
 * - a router actor ({@link catalogActorOf}) other than a {@link CatalogActor}.
 *   A router judges a paired device as the person and refuses every worker
 *   (D10); a `session` requirement is the per-project authority policy the
 *   socket reads, which no router consults, and a `role` verb is tool-only. A
 *   socket verb whose agent actor is `session` declares its router actor in
 *   `catalog.actor` instead;
 * - `session-own` on a host entry, which names no subject a Session could act on;
 * - `refusedIntents` on anything but a workspace `command-id` entry, the one
 *   shape whose router judges intents with the parsed input.
 */
export function catalogEntriesFrom(entries: readonly VerbEntry[]): readonly CatalogEntry[] {
  const declared: CatalogEntry[] = [];
  for (const entry of entries) {
    if (entry.catalog === undefined) {
      if (entry.accessModes.includes("hostApi")) {
        throw new Error(`Verb ${entry.key} declares a hostApi access mode with no catalog entry`);
      }
      continue;
    }
    const routerActor = entry.catalog.actor ?? entry.actor;
    if (!(CATALOG_ACTORS as readonly string[]).includes(routerActor)) {
      throw new Error(
        `Catalog entry ${entry.key} requires a ${routerActor} actor; a router judges only any, user and session-own (declare catalog.actor)`,
      );
    }
    if (routerActor === "session-own" && entry.catalog.scope !== "workspace") {
      throw new Error(`Catalog entry ${entry.key} is session-own but names no subject to act on`);
    }
    if (
      entry.catalog.refusedIntents !== undefined &&
      (entry.catalog.idempotency !== "command-id" || entry.catalog.scope !== "workspace")
    ) {
      throw new Error(`Catalog entry ${entry.key} refuses intents but is no workspace command`);
    }
    declared.push(entry as CatalogEntry);
  }
  return declared;
}

/** The actor a router judges an entry by: `catalog.actor`, else the entry's own. */
export function catalogActorOf(entry: CatalogEntry): CatalogActor {
  // `catalogEntriesFrom` admitted only CatalogActors.
  return (entry.catalog.actor ?? entry.actor) as CatalogActor;
}

/** Every catalog entry this build declares, checked once at load. */
export const CATALOG_ENTRIES: readonly CatalogEntry[] = catalogEntriesFrom(VERB_REGISTRY);

/** A by-key lookup over checked catalog entries; throws for a key they do not declare. */
export function catalogLookup(entries: readonly CatalogEntry[]): (key: string) => CatalogEntry {
  const byKey: ReadonlyMap<string, CatalogEntry> = new Map(
    entries.map((entry) => [entry.key, entry]),
  );
  return (key) => {
    const entry = byKey.get(key);
    if (entry === undefined) throw new Error(`No catalog entry declares ${key}`);
    return entry;
  };
}

const lookupCatalogEntry = catalogLookup(CATALOG_ENTRIES);

/** One catalog entry. Throws for a key the catalog does not declare. */
export function catalogEntry(key: CatalogKey): CatalogEntry {
  return lookupCatalogEntry(key);
}

/**
 * The Agent Tool Surface projection at the type level: entries carrying a
 * `tool` access mode.
 */
// `E extends VerbEntry ? …` and not a bare `"tool" extends E["accessModes"]`:
// a conditional distributes over a union only when the CHECKED type is the
// naked parameter. Written the short way, `E["accessModes"][number]` collapses
// to the union across every entry — which contains `"tool"` — and the type
// silently widens to every verb key. `SocketProjected` above has the same
// shape for the same reason.
type ToolProjected<E extends VerbEntry> = E extends VerbEntry
  ? "tool" extends E["accessModes"][number]
    ? E["key"]
    : never
  : never;

/**
 * A verb key the Agent Tool Surface can carry — the vocabulary a Role bundle
 * and a Session grant are allowed to name (VC-162).
 *
 * Narrower than {@link VerbKey} on purpose. A grant naming `ticket.list` would
 * be asking for a tool nothing can build, and this type is what makes that a
 * compile error at every caller inside the product; {@link isVerbToolKey} is
 * the same check for the durable data a store hands back.
 */
export type VerbToolKey = ToolProjected<RegistryEntry>;

/**
 * The tool projection: entries carrying a `tool` access mode, in declaration
 * order. Takes its entries as an argument so a projection can be proven
 * against a synthetic table.
 *
 * Declaration order is the canonical tool order. Appending is what keeps a
 * verb added later from shifting the position of one already in a Session's
 * frozen surface.
 */
export function verbToolsFrom(
  entries: readonly VerbEntry[],
): readonly (VerbEntry & { tool: VerbToolProjection })[] {
  const projected = entries.filter((entry) => entry.accessModes.includes("tool"));
  for (const entry of projected) {
    if (entry.tool === undefined) {
      throw new Error(`Verb ${entry.key} declares a tool access mode with no tool projection`);
    }
    if (!VERB_TOOL_NAME_PATTERN.test(entry.tool.name)) {
      throw new Error(
        `Verb ${entry.key} projects tool name ${JSON.stringify(entry.tool.name)}, which no provider will accept`,
      );
    }
  }
  const wireNames = new Set<string>();
  for (const entry of projected) {
    const wire = entry.tool!.name;
    if (wireNames.has(wire)) {
      throw new Error(`Tool name ${wire} is projected by more than one verb`);
    }
    wireNames.add(wire);
  }
  return projected as readonly (VerbEntry & { tool: VerbToolProjection })[];
}

/** Every verb the Agent Tool Surface can carry, in canonical order. */
export const VERB_TOOLS: readonly (VerbEntry & { tool: VerbToolProjection })[] =
  verbToolsFrom(VERB_REGISTRY);

/** Their keys, in the same order — the canonical tail of a resolved surface. */
export const VERB_TOOL_KEYS = VERB_TOOLS.map((entry) => entry.key) as readonly VerbToolKey[];

const VERB_TOOL_KEY_SET: ReadonlySet<string> = new Set(VERB_TOOL_KEYS);

/**
 * Whether a string is a verb this build can project as a tool.
 *
 * The runtime guard behind {@link VerbToolKey}: durable grant data and a
 * decoded `tool-surface` record arrive as strings, and a key this build does
 * not project is a name nothing can bind. Callers fail closed on `false`.
 */
export function isVerbToolKey(key: string): key is VerbToolKey {
  return VERB_TOOL_KEY_SET.has(key);
}

/** Every listed verb on any agent surface, ordered for zero-cost discovery. */
export function discoverableVerbsFrom(entries: readonly VerbEntry[]): readonly VerbEntry[] {
  const listed = entries.filter((entry) => entry.listed);
  for (const entry of listed) {
    if (!Number.isFinite(entry.referenceOrder)) {
      throw new Error(`Listed verb ${entry.key} requires referenceOrder`);
    }
  }
  return listed.toSorted((left, right) => left.referenceOrder! - right.referenceOrder!);
}

/**
 * The executable CLI reference projection: discoverable verbs carrying a
 * `cli` access mode. Tool-only verbs remain in {@link DISCOVERABLE_VERBS} so
 * help can name their real door without pretending the shell executes them.
 */
export function referenceVerbsFrom(entries: readonly VerbEntry[]): readonly VerbEntry[] {
  return discoverableVerbsFrom(entries).filter((entry) => entry.accessModes.includes("cli"));
}

const ENTRY_BY_KEY: ReadonlyMap<string, RegistryEntry> = new Map(
  VERB_REGISTRY.map((entry) => [entry.key, entry]),
);

/** One verb's entry, or undefined for a key this build does not declare. */
export function verbEntry(key: string): VerbEntry | undefined {
  return ENTRY_BY_KEY.get(key);
}

/**
 * The provider spelling for a frozen Session, not the durable verb key.
 * Historical surfaces have no naming marker and must keep their mcp_* names;
 * new Sessions carry "server" and avoid Anthropic OAuth's single-underscore
 * mcp_ extra-usage classifier. Real MCP tools use mcp__ and are unaffected.
 */
export function verbToolWireName(
  key: VerbToolKey,
  mcpManagementNames?: "server",
): string | undefined {
  const name = verbEntry(key)?.tool?.name;
  if (name === undefined) return undefined;
  return key.startsWith("mcp.") && mcpManagementNames === undefined
    ? name.replace(/^server_/, "mcp_")
    : name;
}

/** Every listed registry verb, including a tool-only or app-only door. */
export const DISCOVERABLE_VERBS: readonly VerbEntry[] = discoverableVerbsFrom(VERB_REGISTRY);

/** The listed verbs this build executes through the Agent CLI. */
export const REFERENCE_VERBS: readonly VerbEntry[] = referenceVerbsFrom(VERB_REGISTRY);
