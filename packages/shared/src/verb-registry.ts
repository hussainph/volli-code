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
 *    a Role bundle. The socket attributes its caller and cannot authenticate
 *    one, so a verb whose misuse cannot be tolerated from an arbitrary process
 *    running as the user does not go on it.
 *
 * The table records TODAY'S surface, not VC-92's target. `session.start` and
 * `ticket.archive` are on the socket right now, so that is what they declare;
 * VC-162 and VC-163 move them, and `verb-registry.test.ts` names both deltas.
 */

import { REASONING_LEVELS } from "./agent-runtime";
import { HELP_TOPIC_NAMES } from "./agent-product";
import { COLUMN_VOCABULARY } from "./agent-surface";
import { FIRST_CLASS_HARNESS_IDS } from "./ticket";

/**
 * Where a verb is projected. `cli` is the Agent CLI (the local agent socket),
 * `tool` is the Agent Tool Surface (a Role bundle's named tools, VC-162), and
 * `hostApi` is reserved for the future External Agent Surface — declared so a
 * host without a shell can simply not project `cli`, unprojected until that
 * surface exists. A verb on two surfaces is one entry with two modes.
 */
export type VerbAccessMode = "cli" | "tool" | "hostApi";

/**
 * What the caller must be: `any` caller, an authenticated `session` actor
 * (VC-44's tokens), or a `role` that holds the verb in its bundle.
 */
export type VerbActor = "any" | "session" | "role";

/**
 * Where the verb's one handler binding lives: `main` answers over the agent
 * socket (`apps/desktop/src/main/agent-commands.ts`), `cli` answers locally in
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
  readonly operation: "create" | "update" | "append";
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
 * both a usage line and a tool schema need to know.
 */
export type VerbOption =
  | (VerbOptionCommon & { readonly kind: "flag" })
  | (VerbOptionCommon & {
      readonly kind: "value" | "repeated" | "multi";
      /** The value shape shown after the name (`<text>`, `<old> <new>`). */
      readonly placeholder: string;
    });

/** One agent-facing verb. Pure data; see the module comment for what is not here. */
export interface VerbEntry {
  /** The dot-name — this verb's identity on every surface. */
  readonly key: string;
  readonly accessModes: readonly VerbAccessMode[];
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
  /** Whether the verb takes a leading `<id>`, and whether it is required. */
  readonly positionalId?: "required" | "optional";
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
    example: "volli ticket show VC-12 --comments 5",
    positionalId: "required",
    options: [
      {
        name: "--events",
        kind: "value",
        placeholder: "<n>",
        help: "How many recent events to include.",
      },
      {
        name: "--comments",
        kind: "value",
        placeholder: "<n>",
        help: "How many recent comments to include.",
      },
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
    positionalId: "required",
    options: [
      { name: "--limit", kind: "value", placeholder: "<n>", help: "Cap the number of events." },
    ],
  },
  {
    key: "ticket.create",
    accessModes: ["cli"],
    actor: "session",
    handler: { site: "main", id: "ticket.create" },
    listed: true,
    referenceOrder: 11,
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
    referenceOrder: 12,
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
  {
    key: "ticket.move",
    accessModes: ["cli"],
    actor: "session",
    handler: { site: "main", id: "ticket.move" },
    listed: true,
    referenceOrder: 13,
    group: "Write",
    summary: "Move a ticket to another column.",
    example: "volli ticket move VC-12 --to needs-review",
    notes: ["Moving to the current column is a no-op."],
    effects: {
      durableWrites: [
        {
          resource: "ticket",
          operation: "update",
          summary:
            "Update the Ticket's board status and order and append one status-change Ticket event.",
        },
      ],
      humanVisible: ["The Ticket moves to the selected board column."],
      nonEffects: [
        "The move does not start a Session, submit a kickoff turn, or create a worktree.",
      ],
    },
    positionalId: "required",
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
  {
    key: "ticket.comment",
    accessModes: ["cli"],
    actor: "session",
    handler: { site: "main", id: "ticket.comment" },
    listed: true,
    referenceOrder: 14,
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
    // VC-92 ruled this one off the agent surface entirely — an app-only
    // curation act, no bundle and no CLI access mode. It is still on the socket
    // here because this table records today's surface; VC-163 empties its
    // access modes, at which point it holds no tier at all.
    key: "ticket.archive",
    accessModes: ["cli"],
    actor: "session",
    handler: { site: "main", id: "ticket.archive" },
    listed: true,
    referenceOrder: 15,
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
    options: [
      {
        name: "--working-tree",
        kind: "flag",
        help: "Diff the uncommitted working tree instead of the PR range.",
      },
    ],
  },
  {
    key: "project.list",
    accessModes: ["cli"],
    actor: "any",
    handler: { site: "main", id: "project.list" },
    listed: true,
    referenceOrder: 8,
    group: "Read",
    summary: "List all registered projects.",
    example: "volli project list",
    options: [],
  },
  {
    key: "label.list",
    accessModes: ["cli"],
    actor: "any",
    handler: { site: "main", id: "label.list" },
    listed: true,
    referenceOrder: 9,
    group: "Read",
    summary: "List a project's labels.",
    example: "volli label list --project VC",
    options: [{ name: "--project", kind: "value", placeholder: "<p>", help: "Target project." }],
  },
  {
    // Model discovery (VC-78): the same Model Access snapshot the app reads,
    // filtered for a context window — never a parallel provider probe.
    key: "model.list",
    accessModes: ["cli"],
    actor: "any",
    handler: { site: "main", id: "model.list" },
    listed: true,
    referenceOrder: 10,
    group: "Read",
    summary: "List signed-in providers, model ids, and reasoning levels.",
    example: "volli model list",
    notes: [
      "Copy a printed <provider/model> verbatim into session start --model.",
      "Shows available models only; --all includes signed-out providers.",
    ],
    options: [
      {
        name: "--all",
        kind: "flag",
        help: "Include signed-out providers and unavailable models.",
      },
    ],
  },
  {
    key: "session.list",
    accessModes: ["cli"],
    actor: "any",
    handler: { site: "main", id: "session.list" },
    listed: true,
    referenceOrder: 17,
    group: "Session",
    summary: "List a project's active terminal and chat sessions.",
    example: "volli session list --ticket VC-12",
    notes: ["Prints each session's title and short id; session peek takes either type."],
    options: [
      { name: "--project", kind: "value", placeholder: "<p>", help: "Filter by project." },
      { name: "--ticket", kind: "value", placeholder: "<id>", help: "Filter by ticket." },
    ],
  },
  {
    // Read tier despite the disclosure it carries: cross-session transcript
    // access is per-actor policy data (VC-44), not a tier change.
    key: "session.peek",
    accessModes: ["cli"],
    actor: "any",
    handler: { site: "main", id: "session.peek" },
    listed: true,
    referenceOrder: 18,
    group: "Session",
    summary: "Peek at what a session is doing: terminal output, or a chat's tail.",
    example: "volli session peek a1b2c3 --lines 60",
    notes: [
      "Handle is a short session id from session list — terminal or chat.",
      "A chat answers activity, last-event age, turn depth, then its transcript tail.",
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
  },
  {
    // Attended-only Session start (VC-13): rides the app-owned product start
    // route (the Sessions facade) over the socket. The CLI's only transport is
    // that socket and the Pi runtime lives in Electron main, so there is
    // deliberately no headless path — app not running is APP_UNREACHABLE, and
    // `volli app launch` is the sanctioned recovery.
    //
    // VC-92 ruled it control tier — a named tool in the `project` bundle, off
    // the socket for every caller. This entry records where it is TODAY, so its
    // derived tier is coordination until VC-162 flips the access mode.
    key: "session.start",
    accessModes: ["cli"],
    actor: "session",
    handler: { site: "main", id: "session.start" },
    listed: true,
    referenceOrder: 16,
    group: "Session",
    summary: "Start an agent chat session on a ticket.",
    example: 'volli session start VC-12 -m "Fix the flaky auth test"',
    notes: [
      "Runs in the app: attended-only, never headless; the board does not move.",
      "Submits a kickoff turn; -m replaces the default kickoff text and names the session.",
      "--title sets a permanent title; --model/--reasoning override the app default.",
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
      ],
    },
    positionalId: "required",
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
    referenceOrder: 19,
    group: "Session",
    summary: "Record that this session's work is finished.",
    example: 'volli session done --reason "Tests pass"',
    notes: [
      "Acts on VOLLI_SESSION; needs a Volli session.",
      "Records the signal in the session ledger; the board does not move. Use ticket move for that.",
    ],
    effects: {
      durableWrites: [
        {
          resource: "session-ledger",
          operation: "append",
          summary:
            "Append a completed done signal command and receipt to the current Session ledger.",
        },
      ],
      humanVisible: [
        "The done signal and optional reason appear in the Session's durable history.",
      ],
      nonEffects: [
        "No Ticket moves, the Session identity remains openable, and its worktree is not removed.",
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
    referenceOrder: 20,
    group: "Session",
    summary: "Signal the current session is blocked and needs a person.",
    example: 'volli session blocked --reason "Needs credentials"',
    notes: [
      "Acts on VOLLI_SESSION; needs a Volli session.",
      "Raises attention on this session; --reason is the text a person sees.",
    ],
    effects: {
      durableWrites: [
        {
          resource: "session-ledger",
          operation: "append",
          summary:
            "Append a completed blocked signal command and receipt to the current Session ledger.",
        },
      ],
      humanVisible: ["The Session raises attention in the app and shows the optional reason."],
      nonEffects: ["No Ticket moves, and the Session is not archived or deleted."],
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
    referenceOrder: 21,
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
    referenceOrder: 22,
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
    referenceOrder: 25,
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
    referenceOrder: 24,
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
        help: "Price a Ticket Session for this ticket instead of a project chat.",
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
    referenceOrder: 23,
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
    referenceOrder: 26,
    group: "App",
    summary: "Show this reference, a command's help, or a topic.",
    example: "volli help ticket create",
    notes: [`Topics: ${HELP_TOPIC_NAMES.join(", ")}.`],
    extraUsage: "[<command> | <topic>]",
    options: [],
  },
] as const satisfies readonly VerbEntry[];

type RegistryEntry = (typeof VERB_REGISTRY)[number];

/** Every declared verb key — the vocabulary rule packs and Role bundles name. */
export type VerbKey = RegistryEntry["key"];

/** The socket projection at the type level: handler site `main`, plus a `cli` access mode. */
type SocketProjected<E extends VerbEntry> = E extends { handler: { site: "main" } }
  ? "cli" extends E["accessModes"][number]
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
    (entry) => entry.handler.site === "main" && entry.accessModes.includes("cli"),
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
 * reaches this list by declaring a `cli` access mode and a `main` handler, so
 * the socket surface cannot drift from the registry.
 *
 * The cast restores the literal union {@link agentCommandsFrom} widens to
 * `string`; `verb-registry.test.ts` pins the runtime value to the same 27
 * strings, in the same order, that this list has always held.
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
 * The Verb Tier a verb's access modes and actor requirement imply (VC-92 §2).
 * Never stored: no entry carries a tier field, and this is the only way to get
 * one.
 *
 * - **read** — Agent CLI, any caller. Composability and zero context cost.
 * - **coordination** — Agent CLI, authenticated session actor. Visible,
 *   attributable, reversible writes.
 * - **control** — `tool` access only, gated on a Role that holds the verb, and
 *   absent from the agent socket.
 * - **null** — no access mode at all. An app-only verb is on no agent surface,
 *   so it holds no governance class; `ticket.archive` becomes this in VC-163.
 *
 * Contradictory combinations throw instead of being mislabeled: a Role-gated
 * verb cannot remain on `cli`, and absence from `cli` alone does not make a
 * non-Role or `hostApi` verb control tier.
 */
export function verbTier(entry: Pick<VerbEntry, "accessModes" | "actor">): VerbTier | null {
  if (entry.accessModes.length === 0) return null;
  if (entry.accessModes.includes("cli")) {
    if (entry.actor === "role") {
      throw new Error("A control-tier verb cannot carry a cli access mode");
    }
    return entry.actor === "any" ? "read" : "coordination";
  }
  if (entry.actor !== "role" || entry.accessModes.length !== 1 || entry.accessModes[0] !== "tool") {
    throw new Error("Control tier requires tool-only access and a role actor");
  }
  return "control";
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

/** Every listed registry verb, including a tool-only or app-only door. */
export const DISCOVERABLE_VERBS: readonly VerbEntry[] = discoverableVerbsFrom(VERB_REGISTRY);

/** The listed verbs this build executes through the Agent CLI. */
export const REFERENCE_VERBS: readonly VerbEntry[] = referenceVerbsFrom(VERB_REGISTRY);
