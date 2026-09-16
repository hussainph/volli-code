/**
 * The MCP management verbs, behind the Agent Tool Surface door (VC-380).
 *
 * VC-8 built everything these verbs stand on: the client and its two
 * transports, the bounded handshake, the settings owner that saves only after
 * discovery succeeds, and the frozen per-Session tool surface. What was missing
 * was a way for an agent to reach any of it without editing configuration files
 * or shelling out — which is to say, without leaving the surface where Volli can
 * warn, confirm, bound and record.
 *
 * Four properties this module is responsible for, none of which the settings
 * service could hold on its own:
 *
 * 1. **Nothing destructive happens on the first call.** `mcp.install` and
 *    `mcp.remove` declare `previewsByDefault`, so the plain call reports the
 *    warning and what would change, and only `confirm: "apply"` acts. The
 *    install preview deliberately connects to NOTHING: a local server is a
 *    process started as the user, and "warned before anything runs" has to mean
 *    before the process, not before the write.
 * 2. **A person is asked when there is one to ask.** The apply call raises a
 *    `confirm.*` question through the attachment's own ask machinery. A Session
 *    running unattended has no such port, and the two-call preview→apply shape
 *    is then the confirmation — stated in the result rather than passed over in
 *    silence. Which verbs gate this way is one rule, written once, at
 *    {@link CONFIRMATION_RULE}.
 * 3. **The caller's cancellation reaches the handshake.** The door's signal is
 *    threaded into `test`/`save`, which before this ticket received a signal
 *    nobody held.
 * 4. **Every install and removal leaves a durable record.** A ticket comment
 *    when the caller has a Ticket, and always a project-scoped `mcp_operations`
 *    row — because the Role that holds these verbs is the Board Role, which has
 *    no Ticket to comment on.
 *
 * What this module never does is decide what a tool IS. MCP tools are not Volli
 * verbs; they stay dynamic settings data frozen into a Session at birth.
 */

import type Database from "better-sqlite3";
import {
  mcpEndpointSecretRefusal,
  mcpInstallWarning,
  mcpRemovalWarning,
  sanitizeMcpProvenance,
  sanitizeMcpServerDraft,
  uniqueTokenList,
  type McpCatalogTool,
  type McpServerDraft,
  type McpServerProvenance,
  type McpServerRecord,
  type RuntimeAskChoice,
  type RuntimeAskRequest,
  type RuntimeSessionIdentity,
  type RuntimeVerbCall,
  type RuntimeVerbResult,
  type TicketEventActor,
} from "@volli/shared";

import { createComment } from "../db/comments-repo";
import {
  listMcpOperations,
  mcpOperationId,
  recordMcpOperation,
  type McpOperationKind,
  type McpOperationOutcome,
} from "../db/mcp-operations-repo";
import { optionalVerbText, requiredVerbText } from "../verb-input";
import type { McpSettingsService } from "./settings";

/**
 * Which MCP verbs ask before they act, and why the rest do not.
 *
 * ONE mechanism, stated once, because the alternative is eight verbs each
 * making the choice locally and no reader able to see the shape.
 *
 * `mcp.install` and `mcp.remove` gate. Both do something a caller cannot undo
 * by calling something else: an install starts a process as the user, or opens
 * a relationship with a third party; a removal breaks reattachment for Sessions
 * that already exist. The gate is `previewsByDefault` — the plain call reports
 * and writes nothing, and only `confirm: "apply"` acts — and on the apply call
 * a person is ALSO asked, when the attachment has somewhere to put a question.
 * The ask is not a second mechanism competing with the first: the preview is
 * what the model must pass, and the ask is what a person may still refuse.
 *
 * `mcp.list`, `mcp.enable`, `mcp.disable`, `mcp.tools` and `mcp.refresh` do not
 * gate, and that is a rule rather than an omission. Every one of them acts on a
 * server ALREADY in this project's configuration — which is to say, on a
 * transport somebody already confirmed through the gate above, or typed into
 * Settings themselves. `mcp.refresh` does start that server's process again,
 * and that is the case worth being explicit about: re-running a command the
 * project already holds lies inside the authority the install established, and
 * the Verb Tier rule is that no verb needs a higher tier than the ambient
 * authority its effect already lies within. A confirmation there would train a
 * caller to click through the two that matter.
 */
export const CONFIRMATION_RULE = ["mcp.install", "mcp.remove"] as const;

/**
 * What the MCP verbs reach, resolved per call rather than captured.
 *
 * `null` reads as "no MCP settings owner this launch" — the same absence the
 * IPC transport reports when the database never opened — and every verb refuses
 * in words rather than throwing.
 */
export interface McpVerbOptions {
  db: Database.Database;
  mcp: () => McpSettingsService | null;
  now: () => number;
}

/**
 * The ask capability one verb call rides in on, as the door lends it.
 *
 * Structurally identical to `VerbBudgetAsk` in `agent-tool-door.ts` and
 * declared separately rather than imported, because the door imports this
 * module: one shared alias would make the dependency circular for a type that
 * is two lines.
 */
export type VerbAsk = (
  request: RuntimeAskRequest,
  signal: AbortSignal,
) => Promise<RuntimeAskChoice>;

/** A refusal the model reads and can act on. Never a thrown error. */
function refusal(text: string): RuntimeVerbResult {
  return { text };
}

/**
 * The sentence every successful write ends with (VC-380 item 7).
 *
 * Not decoration. A Session's tool list is resolved once, at birth, and a model
 * that has just installed a server will otherwise try to call its tools in this
 * turn, fail, and conclude the install did not work. Saying WHEN they become
 * usable is the difference between a correct result and a retry loop.
 */
const FROZEN_SURFACE_NOTE =
  "These tools are not available in this Session: a Session's tool list is frozen when it is created, and this one's is unchanged. They become usable in the next Session created.";

/** A list of tool names as the caller spelled it, each counted once. */
function nameList(raw: unknown): readonly string[] {
  return typeof raw === "string" ? uniqueTokenList(raw) : [];
}

/**
 * Command arguments, as an array or as a command line.
 *
 * The ARRAY is the form that matters, because it is the form the whole
 * ecosystem uses: Claude Code, Claude Desktop, Cursor, VS Code and Zed all
 * spell a local server as `{ command, args: string[] }`. A model that has read
 * any MCP documentation at all will send an array, and a field that took only
 * a string would meet the ecosystem's own idiom with a type error.
 *
 * The string form is kept because a person or a model quoting a command line
 * from a README is the other half of how this actually arrives. Quoted runs are
 * held together — a real MCP argument is often a path or a JSON blob with
 * spaces in it, and splitting one produces garbage the server rejects for
 * reasons nobody can see.
 *
 * An array holding a non-string is REFUSED rather than coerced. `String(7)` is
 * a plausible-looking argument that nobody asked for, and a server given one
 * fails somewhere far from here.
 */
function argumentList(
  raw: unknown,
): { ok: true; args: readonly string[] } | { ok: false; text: string } {
  if (raw === undefined || raw === null) return { ok: true, args: [] };
  if (Array.isArray(raw)) {
    return raw.every((argument) => typeof argument === "string")
      ? { ok: true, args: raw as readonly string[] }
      : {
          ok: false,
          text: "`args` must be an array of strings, or one command-line string. An entry that is not a string was refused rather than converted into one.",
        };
  }
  if (typeof raw !== "string") {
    return {
      ok: false,
      text: '`args` must be an array of strings (the usual MCP form, for example ["-y", "@acme/files-mcp"]) or one command-line string.',
    };
  }
  const found = raw.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return {
    ok: true,
    args: found.map((argument) =>
      (argument.startsWith('"') && argument.endsWith('"')) ||
      (argument.startsWith("'") && argument.endsWith("'"))
        ? argument.slice(1, -1)
        : argument,
    ),
  };
}

/**
 * One server configuration, as the caller spelled it.
 *
 * `command` and `url` are refused TOGETHER rather than resolved by precedence.
 * A caller that supplied both does not know which server it is installing, and
 * silently preferring one would install a server nobody asked for — with a
 * warning describing the other.
 */
function serverFromInput(
  input: Readonly<Record<string, unknown>>,
): { ok: true; server: McpServerDraft } | { ok: false; text: string } {
  const id = requiredVerbText(input, "id", "a short stable id for this server.");
  if (!id.ok) return id;
  const name = requiredVerbText(input, "name", "the display name a person will see.");
  if (!name.ok) return name;
  const commandRead = optionalVerbText(input, "command");
  if (!commandRead.ok) return commandRead;
  const urlRead = optionalVerbText(input, "url");
  if (!urlRead.ok) return urlRead;
  const command = commandRead.value?.trim();
  const url = urlRead.value?.trim();
  if (command !== undefined && url !== undefined) {
    return {
      ok: false,
      text: "Give exactly one of `command` or `url`: a local server is a command, a remote one is a URL, and both together name two different servers.",
    };
  }
  if (command === undefined && url === undefined) {
    return {
      ok: false,
      text: "Give one of `command` (a local server already on PATH, for example npx) or `url` (a remote streamable HTTP endpoint).",
    };
  }
  // Refused before the draft is even built, so no code path downstream has to
  // carry a value it must remember never to store, print or send.
  if (url !== undefined && hasQueryString(url)) {
    return { ok: false, text: mcpEndpointSecretRefusal() };
  }
  const args = argumentList(input["args"]);
  if (!args.ok) return args;
  const sanitized = sanitizeMcpServerDraft({
    id: id.value,
    name: name.value,
    enabled: true,
    transport:
      command === undefined
        ? { type: "streamable-http", url }
        : { type: "stdio", command, args: args.args },
  });
  return sanitized.ok
    ? { ok: true, server: sanitized.server }
    : { ok: false, text: `That MCP server configuration was refused: ${sanitized.reason}.` };
}

/**
 * Whether a caller-supplied endpoint carries a query string (VC-380).
 *
 * Tolerant of a URL this build cannot parse: `sanitizeMcpServerDraft` is the
 * one that judges validity, and answering "no query string" for something that
 * is not a URL lets it give the better error.
 */
function hasQueryString(url: string): boolean {
  try {
    return new URL(url).search.length > 0;
  } catch {
    return false;
  }
}

/** The provenance fields as supplied, left for the settings owner to validate. */
function provenanceFromInput(input: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return {
    source: input["source"],
    registryType: input["registryType"],
    version: input["version"],
    digest: input["digest"],
  };
}

/**
 * An endpoint with its query string dropped (VC-380 acceptance 12).
 *
 * A caller-supplied URL is the likeliest place for a token to end up, and
 * everything this module prints travels further than the caller expects: into
 * a model's context, into a confirmation card a person reads, and into an
 * append-only audit row that outlives the server. Origin and path are what
 * identify the server; the query is what identifies the caller. A stripped
 * query is NAMED rather than silently removed, so a reader is not left
 * wondering whether the endpoint was really that bare.
 */
function redactedUrl(url: string): string {
  const parsed = new URL(url);
  const bare = `${parsed.origin}${parsed.pathname}`;
  return parsed.search.length === 0 ? bare : `${bare} (query string not shown)`;
}

/** How a transport reads in a listing, a preview, or a durable record. */
function transportSummary(server: McpServerDraft): string {
  return server.transport.type === "stdio"
    ? `local: ${[server.transport.command, ...server.transport.args].join(" ")}`
    : `remote: ${redactedUrl(server.transport.url)}`;
}

/** One discovered tool, with the reason it cannot be offered when there is one. */
function catalogLine(tool: McpCatalogTool): string {
  if (tool.definition === null) {
    return `  - ${tool.name} — UNUSABLE: ${tool.error ?? "this build cannot offer it"}`;
  }
  const description = tool.description.length === 0 ? "" : ` — ${tool.description}`;
  return `  - ${tool.name}${description}`;
}

/** Provenance as one readable clause, or the honest absence of one. */
function provenanceSummary(provenance: McpServerProvenance): string {
  const parts = [
    provenance.source === null ? null : `source ${provenance.source}`,
    provenance.registryType === null ? null : `registry ${provenance.registryType}`,
    provenance.version === null ? null : `version ${provenance.version}`,
    provenance.digest === null ? null : `digest ${provenance.digest}`,
  ].filter((part): part is string => part !== null);
  return parts.length === 0
    ? "provenance: none recorded"
    : `provenance (recorded, not verified by Volli): ${parts.join(", ")}`;
}

function serverStatus(server: McpServerRecord): string {
  if (server.stale) return `STALE — ${server.error ?? "last refresh failed"}`;
  return server.enabled ? "on" : "off";
}

/**
 * Write the durable record of one management operation.
 *
 * Two homes on purpose. The `mcp_operations` row is canonical and always
 * written: it is project-scoped, append-only, survives the server it names, and
 * is what the Board Session that holds these verbs can actually be audited
 * through — a Board Session has no Ticket to comment on. The ticket comment is
 * written IN ADDITION when the caller has a Ticket, because that is where a
 * person doing the work will look, and a record nobody finds is not a record.
 *
 * A comment failure never fails the operation. The install has already
 * happened; refusing to report it because a second write failed would be
 * reporting the wrong outcome.
 */
function record(
  options: McpVerbOptions,
  session: RuntimeSessionIdentity,
  entry: {
    /** The call that asked, so a replay lands as one act rather than two. */
    toolCallId: string;
    serverId: string;
    serverName: string;
    operation: McpOperationKind;
    outcome: McpOperationOutcome;
    summary: string;
    detail: string | null;
    provenance: McpServerProvenance;
  },
): void {
  const now = options.now();
  recordMcpOperation(
    options.db,
    {
      id: mcpOperationId(session.sessionId, entry.toolCallId),
      projectId: session.projectId,
      serverId: entry.serverId,
      serverName: entry.serverName,
      operation: entry.operation,
      outcome: entry.outcome,
      summary: entry.summary,
      detail: entry.detail,
      provenance: entry.provenance,
      sessionId: session.sessionId,
      ticketId: session.ticketId,
    },
    now,
  );
  if (session.ticketId === null) return;
  const actor: TicketEventActor = {
    kind: "session",
    sessionId: session.sessionId,
    ticketId: session.ticketId,
  };
  try {
    createComment(
      options.db,
      {
        ticketId: session.ticketId,
        body: [
          `**MCP ${entry.operation}** — ${entry.outcome === "applied" ? "applied" : "failed"}`,
          "",
          entry.summary,
          ...(entry.detail === null ? [] : ["", entry.detail]),
          "",
          provenanceSummary(entry.provenance),
        ].join("\n"),
        actor: "session",
        sessionId: null,
        eventActor: actor,
      },
      now,
    );
  } catch (error) {
    // The ticket may have been archived or deleted between the call and this
    // write. The canonical row above is already committed, so the operation is
    // recorded either way, and failing the install over a second copy of the
    // news would report the wrong outcome. Logged rather than silent: nobody is
    // waiting on this comment, so there is no toast to raise, but a missing
    // comment with no trace is the kind of thing that is debugged twice.
    console.warn(
      `MCP ${entry.operation} recorded, but its ticket comment failed for ${session.ticketId}:`,
      error,
    );
  }
}

/** The settings owner, or the refusal every verb gives without one. */
function owner(
  options: McpVerbOptions,
  act: string,
): { ok: true; mcp: McpSettingsService } | { ok: false; text: string } {
  const mcp = options.mcp();
  return mcp === null
    ? {
        ok: false,
        text: `Volli's MCP settings are not available this launch, so ${act}.`,
      }
    : { ok: true, mcp };
}

/** Whether this call is the explicit apply, rather than the preview that is the default. */
function isApply(input: Readonly<Record<string, unknown>>): boolean {
  return input["confirm"] === "apply";
}

/**
 * Put one confirmation in front of the person driving, when there is one.
 *
 * The ask port arrives only when the attachment had somewhere to put a
 * question. Its absence is not treated as a refusal: an unattended Board
 * Session that has already made two deliberate calls — a preview and then an
 * explicit `confirm: "apply"` — has confirmed as strongly as that Session can,
 * and refusing would make the verbs unusable exactly where automation needs
 * them. What is NOT allowed is doing it quietly: the result says nobody was
 * asked.
 */
async function confirmWith(
  ask: VerbAsk | undefined,
  request: {
    cause: "confirm.mcp-install" | "confirm.mcp-remove";
    tool: string;
    toolCallId: string;
    warning: string;
  },
  signal: AbortSignal,
): Promise<{ granted: true; asked: boolean } | { granted: false; text: string }> {
  if (ask === undefined) return { granted: true, asked: false };
  let choice: RuntimeAskChoice;
  try {
    choice = await ask(
      {
        cause: request.cause,
        tool: request.tool,
        toolCallId: request.toolCallId,
        // The door does not know the turn; the binding correlates the question
        // by tool call id, which is the identity that survives everywhere.
        turnId: null,
        reason: request.warning,
        // Not `budget`: nothing was refused and no allowance ran out. Borrowing
        // that name would make the denial ledger count a confirmation as a
        // spent allowance and escalate a Session nobody refused anything.
        trip: "confirm",
        overridable: true,
      },
      signal,
    );
  } catch {
    // A question nobody was shown, or one withdrawn when the turn stopped
    // waiting. No decision exists, so nothing is done.
    return {
      granted: false,
      text: "Volli could not put this in front of anyone to confirm, so nothing was changed.",
    };
  }
  return choice === "allow"
    ? { granted: true, asked: true }
    : {
        granted: false,
        text: "The person driving declined, so nothing was changed.",
      };
}

export async function mcpListTool(
  options: McpVerbOptions,
  session: RuntimeSessionIdentity,
): Promise<RuntimeVerbResult> {
  const found = owner(options, "nothing could be listed");
  if (!found.ok) return refusal(found.text);
  const servers = found.mcp.list(session.projectId);
  const history = listMcpOperations(options.db, session.projectId, 10);
  const lines: string[] = [];
  if (servers.length === 0) {
    lines.push(
      "This project has no MCP servers configured. Use mcp_preview to look at one, then mcp_install to add it.",
    );
  } else {
    lines.push(`${servers.length} MCP server${servers.length === 1 ? "" : "s"} in this project:`);
    for (const server of servers) {
      const on = server.catalog.filter((tool) => tool.enabled).map((tool) => tool.name);
      lines.push(
        "",
        `${server.name} (id ${server.id}) — ${serverStatus(server)}`,
        `  ${transportSummary(server)}`,
        `  tools on (${on.length}/${server.catalog.length}): ${on.length === 0 ? "none" : on.join(", ")}`,
        `  ${provenanceSummary(server.provenance)}`,
      );
    }
  }
  if (history.length > 0) {
    lines.push("", "Recent MCP operations:");
    for (const entry of history) {
      lines.push(
        `  - ${entry.summary}${entry.detail === null ? "" : ` ${entry.detail}`}`.trimEnd(),
      );
    }
  }
  return { text: lines.join("\n") };
}

export async function mcpPreviewTool(
  options: McpVerbOptions,
  session: RuntimeSessionIdentity,
  request: RuntimeVerbCall,
  signal: AbortSignal,
): Promise<RuntimeVerbResult> {
  const found = owner(options, "nothing was connected");
  if (!found.ok) return refusal(found.text);
  const draft = serverFromInput(request.input);
  if (!draft.ok) return refusal(draft.text);
  const result = await found.mcp.test({
    projectId: session.projectId,
    server: draft.server,
    signal,
  });
  if (!result.ok) {
    return refusal(
      `Could not read ${draft.server.name}'s tools: ${result.error} Nothing was saved.`,
    );
  }
  const usable = result.catalog.filter((tool) => tool.definition !== null);
  return {
    text: [
      `${draft.server.name} (${transportSummary(draft.server)}) offers ${result.catalog.length} tool${result.catalog.length === 1 ? "" : "s"}, ${usable.length} of which Volli can offer:`,
      ...result.catalog.map(catalogLine),
      "",
      mcpInstallWarning(draft.server),
      "",
      "Nothing was saved. Call mcp_install with the tools you want to turn on.",
    ].join("\n"),
  };
}

export async function mcpInstallTool(
  options: McpVerbOptions,
  session: RuntimeSessionIdentity,
  request: RuntimeVerbCall,
  signal: AbortSignal,
  ask?: VerbAsk,
): Promise<RuntimeVerbResult> {
  const found = owner(options, "nothing was installed");
  if (!found.ok) return refusal(found.text);
  const draft = serverFromInput(request.input);
  if (!draft.ok) return refusal(draft.text);
  const tools = nameList(request.input["tools"]);
  // Judged on the PREVIEW call too, not only on the apply. Learning about a
  // mistyped registry name after the caller has read the warning and agreed to
  // it would mean a wasted process launch and a refusal about a typo arriving
  // where a result was expected.
  const provenance = sanitizeMcpProvenance(provenanceFromInput(request.input));
  if (!provenance.ok) {
    return refusal(`That provenance was refused, so nothing was done: ${provenance.reason}.`);
  }
  const warning = mcpInstallWarning(draft.server);
  const existing = found.mcp
    .list(session.projectId)
    .find((server) => server.id === draft.server.id);

  if (!isApply(request.input)) {
    // The preview connects to NOTHING. A local MCP server is a process started
    // as the person using Volli, so "warned before anything runs" has to mean
    // before the process, not before the row is written.
    return {
      text: [
        `PREVIEW — nothing has been connected, started or saved.`,
        "",
        existing === undefined
          ? `Installing ${draft.server.name} would add a new server (id ${draft.server.id}).`
          : `Installing ${draft.server.name} would UPDATE the existing server ${existing.name} (id ${existing.id}), replacing its configuration and tool selection.`,
        `  ${transportSummary(draft.server)}`,
        `  tools to turn on: ${tools.length === 0 ? "none (add them later with mcp_tools)" : tools.join(", ")}`,
        `  ${provenanceSummary(provenance.provenance)}`,
        "",
        warning,
        "",
        'If that is acceptable, call mcp_install again with the same arguments plus confirm="apply".',
      ].join("\n"),
    };
  }

  const confirmed = await confirmWith(
    ask,
    {
      cause: "confirm.mcp-install",
      tool: "mcp_install",
      toolCallId: request.toolCallId,
      warning,
    },
    signal,
  );
  if (!confirmed.granted) return refusal(confirmed.text);

  const saved = await found.mcp.save({
    projectId: session.projectId,
    server: draft.server,
    enabledTools: tools,
    provenance: provenanceFromInput(request.input),
    signal,
  });
  const recorded = saved.ok ? saved.server.provenance : provenance.provenance;

  if (!saved.ok) {
    const recovery =
      saved.server === undefined
        ? "Nothing was written: this server is not in the project's configuration, so retrying the same call is safe."
        : "The server's last working tool list was kept and it is now marked stale. Fix the cause and call mcp_refresh, or install again.";
    record(options, session, {
      toolCallId: request.toolCallId,
      serverId: draft.server.id,
      serverName: draft.server.name,
      operation: "install",
      outcome: "failed",
      summary: `Could not install ${draft.server.name}.`,
      // The configuration that was TRIED, because a first-time failure writes no
      // server row and this is then the only place it survives. A person picking
      // the work back up needs what to retry, not only that something failed.
      detail: `${saved.error} ${recovery} Attempted: ${transportSummary(draft.server)}; tools requested: ${tools.length === 0 ? "none" : tools.join(", ")}.`,
      provenance: recorded,
    });
    return refusal(`Could not install ${draft.server.name}: ${saved.error} ${recovery}`);
  }

  const on = saved.server.catalog.filter((tool) => tool.enabled).map((tool) => tool.name);
  const unusable = saved.server.catalog.filter((tool) => tool.definition === null);
  const summary = `Installed ${saved.server.name} (id ${saved.server.id}) with ${on.length} of ${saved.server.catalog.length} tools on.`;
  record(options, session, {
    toolCallId: request.toolCallId,
    serverId: saved.server.id,
    serverName: saved.server.name,
    operation: "install",
    outcome: "applied",
    summary,
    detail: `${existing === undefined ? "Added." : "Updated the existing server in place."} ${transportSummary(saved.server)}; tools on: ${on.length === 0 ? "none" : on.join(", ")}.`,
    provenance: recorded,
  });
  return {
    text: [
      summary,
      `  ${transportSummary(saved.server)}`,
      `  tools on: ${on.length === 0 ? "none" : on.join(", ")}`,
      ...(unusable.length === 0
        ? []
        : [
            `  ${unusable.length} tool${unusable.length === 1 ? "" : "s"} could not be offered: ${unusable.map((tool) => tool.name).join(", ")}`,
          ]),
      `  ${provenanceSummary(recorded)}`,
      "",
      FROZEN_SURFACE_NOTE,
      confirmed.asked
        ? "The person driving confirmed this install."
        : 'Nobody was asked to confirm: this Session had no way to put a question in front of a person, so the explicit confirm="apply" was the confirmation.',
    ].join("\n"),
  };
}

export async function mcpRefreshTool(
  options: McpVerbOptions,
  session: RuntimeSessionIdentity,
  request: RuntimeVerbCall,
  signal: AbortSignal,
): Promise<RuntimeVerbResult> {
  const found = owner(options, "nothing was refreshed");
  if (!found.ok) return refusal(found.text);
  const id = requiredVerbText(request.input, "server", "the server's id, as mcp_list prints it.");
  if (!id.ok) return refusal(id.text);
  const result = await found.mcp.refresh({
    projectId: session.projectId,
    serverId: id.value,
    signal,
  });
  if (!result.ok) {
    return refusal(
      result.server === undefined
        ? `Could not refresh ${id.value}: ${result.error}`
        : `Could not refresh ${result.server.name}: ${result.error} Its last working tool list was kept and it is marked stale, so nothing that worked has stopped working.`,
    );
  }
  const on = result.server.catalog.filter((tool) => tool.enabled).map((tool) => tool.name);
  return {
    text: [
      `Refreshed ${result.server.name}: ${result.server.catalog.length} tool${result.server.catalog.length === 1 ? "" : "s"} discovered, ${on.length} on.`,
      `  tools on: ${on.length === 0 ? "none" : on.join(", ")}`,
      "",
      FROZEN_SURFACE_NOTE,
    ].join("\n"),
  };
}

async function setEnabledTool(
  options: McpVerbOptions,
  session: RuntimeSessionIdentity,
  request: RuntimeVerbCall,
  enabled: boolean,
): Promise<RuntimeVerbResult> {
  const found = owner(options, `nothing was turned ${enabled ? "on" : "off"}`);
  if (!found.ok) return refusal(found.text);
  const id = requiredVerbText(request.input, "server", "the server's id, as mcp_list prints it.");
  if (!id.ok) return refusal(id.text);
  const result = found.mcp.setEnabled({
    projectId: session.projectId,
    serverId: id.value,
    enabled,
  });
  if (!result.ok) return refusal(`Could not change ${id.value}: ${result.error}`);
  return {
    text: [
      `Turned ${result.server.name} ${enabled ? "on" : "off"}.`,
      enabled
        ? FROZEN_SURFACE_NOTE
        : `Its configuration is kept, so Sessions already holding its tools can still reattach. ${FROZEN_SURFACE_NOTE}`,
    ].join(" "),
  };
}

export const mcpEnableTool = (
  options: McpVerbOptions,
  session: RuntimeSessionIdentity,
  request: RuntimeVerbCall,
): Promise<RuntimeVerbResult> => setEnabledTool(options, session, request, true);

export const mcpDisableTool = (
  options: McpVerbOptions,
  session: RuntimeSessionIdentity,
  request: RuntimeVerbCall,
): Promise<RuntimeVerbResult> => setEnabledTool(options, session, request, false);

export async function mcpToolsTool(
  options: McpVerbOptions,
  session: RuntimeSessionIdentity,
  request: RuntimeVerbCall,
): Promise<RuntimeVerbResult> {
  const found = owner(options, "no tool selection was changed");
  if (!found.ok) return refusal(found.text);
  const id = requiredVerbText(request.input, "server", "the server's id, as mcp_list prints it.");
  if (!id.ok) return refusal(id.text);
  if (typeof request.input["tools"] !== "string") {
    return refusal(
      "`tools` is required: the complete set of tool names to leave on, separated by spaces or commas. Pass an empty string to turn every tool off.",
    );
  }
  const result = found.mcp.setTools({
    projectId: session.projectId,
    serverId: id.value,
    enabledTools: nameList(request.input["tools"]),
  });
  if (!result.ok) return refusal(`Could not change ${id.value}'s tools: ${result.error}`);
  const on = result.server.catalog.filter((tool) => tool.enabled).map((tool) => tool.name);
  return {
    text: [
      `${result.server.name} now has ${on.length} of ${result.server.catalog.length} tools on: ${on.length === 0 ? "none" : on.join(", ")}.`,
      FROZEN_SURFACE_NOTE,
    ].join(" "),
  };
}

export async function mcpRemoveTool(
  options: McpVerbOptions,
  session: RuntimeSessionIdentity,
  request: RuntimeVerbCall,
  signal: AbortSignal,
  ask?: VerbAsk,
): Promise<RuntimeVerbResult> {
  const found = owner(options, "nothing was removed");
  if (!found.ok) return refusal(found.text);
  const id = requiredVerbText(request.input, "server", "the server's id, as mcp_list prints it.");
  if (!id.ok) return refusal(id.text);
  const existing = found.mcp.list(session.projectId).find((server) => server.id === id.value);
  if (existing === undefined) {
    return refusal(`No MCP server ${id.value} in this project, so nothing was removed.`);
  }
  const warning = mcpRemovalWarning(existing.name);

  if (!isApply(request.input)) {
    const on = existing.catalog.filter((tool) => tool.enabled).map((tool) => tool.name);
    return {
      text: [
        "PREVIEW — nothing has been removed.",
        "",
        `Removing ${existing.name} (id ${existing.id}) would delete its configuration and its ${existing.catalog.length}-tool catalog.`,
        `  ${transportSummary(existing)}`,
        `  tools currently on: ${on.length === 0 ? "none" : on.join(", ")}`,
        "",
        warning,
        "",
        'If that is acceptable, call mcp_remove again with the same server plus confirm="apply".',
      ].join("\n"),
    };
  }

  const confirmed = await confirmWith(
    ask,
    { cause: "confirm.mcp-remove", tool: "mcp_remove", toolCallId: request.toolCallId, warning },
    signal,
  );
  if (!confirmed.granted) return refusal(confirmed.text);

  const removed = found.mcp.remove({ projectId: session.projectId, serverId: id.value });
  if (!removed.ok) {
    record(options, session, {
      toolCallId: request.toolCallId,
      serverId: existing.id,
      serverName: existing.name,
      operation: "remove",
      outcome: "failed",
      summary: `Could not remove ${existing.name}.`,
      detail: `${removed.error} The server's configuration is unchanged.`,
      provenance: existing.provenance,
    });
    return refusal(`Could not remove ${existing.name}: ${removed.error}`);
  }
  const summary = `Removed ${existing.name} (id ${existing.id}) and its ${existing.catalog.length}-tool catalog.`;
  record(options, session, {
    toolCallId: request.toolCallId,
    serverId: existing.id,
    serverName: existing.name,
    operation: "remove",
    outcome: "applied",
    summary,
    detail: `Configuration recorded here so it can be re-added: ${transportSummary(existing)}.`,
    provenance: existing.provenance,
  });
  return {
    text: [
      summary,
      `To put it back: mcp_install with id ${existing.id} and ${transportSummary(existing)}.`,
      "Any Session born holding one of its tools will now fail to reattach; re-adding it under the same id restores the transport those Sessions need.",
      confirmed.asked
        ? "The person driving confirmed this removal."
        : "Nobody was asked to confirm: this Session had no way to put a question in front of a person.",
    ].join("\n"),
  };
}
