/**
 * Turning a server's credential REFERENCES into values, at the moment of
 * connecting and not before (VC-470).
 *
 * The values made here go to exactly one place: the transport of the server
 * they belong to — a stdio child's environment, or the headers of a request
 * to that server's endpoint. They are never returned to a caller that could
 * print them, never put in an error, and never logged. Every error this module
 * raises names the SLOT (`header Authorization`, `env API_KEY`) or the
 * variable (`${GITHUB_TOKEN}`), which a person needs to fix it and which
 * discloses nothing.
 */
import {
  MCP_OAUTH_CLIENT_SECRET_SLOT,
  mcpCredentialSlot,
  mcpCredentialSlotLabel,
  mcpCredentialValueProblem,
  resolveMcpCredentialTemplate,
  type McpCredentialEntry,
  type McpCredentialFamily,
  type McpConnectionBlock,
  type McpCredentialSource,
  type McpServerDraft,
} from "@volli/shared";

import type { McpCredentialStore } from "./credential-store";

/**
 * A connection failure whose message Volli wrote, and which may therefore be
 * shown as it is.
 *
 * Discovery wraps every other failure in a generic sentence, because a third
 * party's error text is not something to print into a model's context or a
 * person's pane. These are the exceptions that pass through, so that the
 * person reads what to do rather than "could not discover tools".
 */
export class McpConnectionProblem extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpConnectionProblem";
  }
}

/** A credential the configuration names has no value right now. */
export class McpCredentialMissingError extends McpConnectionProblem {
  /** Labels of the slots that could not be filled, for a sentence. */
  readonly missing: readonly string[];

  constructor(serverName: string, missing: readonly string[]) {
    super(
      `${serverName} needs ${missing.join(", ")}, which has no value. A person can add it in Settings \u2192 Configure \u2192 MCP Servers.`,
    );
    this.name = "McpCredentialMissingError";
    this.missing = missing;
  }
}

/** The server refused the credential the person configured for it. */
export class McpCredentialRejectedError extends McpConnectionProblem {
  readonly rejected: readonly string[];

  constructor(serverName: string, rejected: readonly string[]) {
    super(
      `${serverName} rejected the credential it was sent${rejected.length === 0 ? "" : ` (${rejected.join(", ")})`}. A person can replace it in Settings \u2192 Configure \u2192 MCP Servers.`,
    );
    this.name = "McpCredentialRejectedError";
    this.rejected = rejected;
  }
}

/** A credential resolved to something that cannot be sent. Never quotes it. */
export class McpCredentialInvalidError extends McpConnectionProblem {
  constructor(serverName: string, label: string, problem: string) {
    super(`${serverName}'s ${label} cannot be used: ${problem}.`);
    this.name = "McpCredentialInvalidError";
  }
}

/** The server refused the connection for want of authorization; a person must sign in. */
export class McpSignInRequiredError extends McpConnectionProblem {
  readonly insufficientScope: boolean;

  constructor(serverName: string, insufficientScope: boolean) {
    super(
      insufficientScope
        ? `${serverName} asked for more access than its sign-in grants. A person must sign in again in Settings \u2192 Configure \u2192 MCP Servers.`
        : `${serverName} needs a person to sign in, in Settings \u2192 Configure \u2192 MCP Servers.`,
    );
    this.name = "McpSignInRequiredError";
    this.insufficientScope = insufficientScope;
  }
}

/** One message from the server was over the size bound; the connection was dropped. */
export class McpMessageTooLargeError extends McpConnectionProblem {
  constructor(serverName: string, maxBytes: number) {
    const limit =
      maxBytes >= 1_024 * 1_024
        ? `${Math.round(maxBytes / (1_024 * 1_024))} MiB`
        : `${maxBytes}-byte`;
    super(`${serverName} sent a message larger than the ${limit} limit, so Volli dropped it.`);
    this.name = "McpMessageTooLargeError";
  }
}

/** A credential would cross plain http to another host, so it was not sent. */
export class McpInsecureEndpointError extends McpConnectionProblem {
  constructor(serverName: string, reason: string) {
    super(
      `${serverName}'s endpoint is plain http, so Volli did not send it the credential: ${reason}.`,
    );
    this.name = "McpInsecureEndpointError";
  }
}

/** The server speaks only an MCP revision this client cannot (see `client.ts`). */
export class McpProtocolEraError extends McpConnectionProblem {
  constructor(serverName: string) {
    super(
      `${serverName} advertises the stateless 2026-07-28 MCP revision and no revision Volli's MCP client supports yet. Use an endpoint or version of the server that also accepts 2025-11-25 clients.`,
    );
    this.name = "McpProtocolEraError";
  }
}

/**
 * What a blocked connection is waiting on, for a caller that routes it to a
 * person: a sign-in, or a credential only a person can supply.
 */
export function mcpConnectionBlock(error: unknown): McpConnectionBlock | undefined {
  const problem = connectionProblemIn(error);
  if (problem instanceof McpSignInRequiredError) {
    return { kind: "sign-in", insufficientScope: problem.insufficientScope };
  }
  if (problem instanceof McpCredentialMissingError) {
    return { kind: "credential", missing: problem.missing };
  }
  if (problem instanceof McpCredentialRejectedError) {
    return { kind: "credential", missing: problem.rejected, rejected: true };
  }
  return undefined;
}

/** Find the Volli-authored problem in an error's cause chain, if there is one. */
export function connectionProblemIn(error: unknown): McpConnectionProblem | null {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth += 1) {
    if (current instanceof McpConnectionProblem) return current;
    current = current instanceof Error ? current.cause : undefined;
  }
  return null;
}

/**
 * Where values come from for one resolution.
 *
 * `pending` holds secrets a person typed into an editor that has not been
 * saved yet — so *Connect* in the server dialog can use a key before it is stored — and
 * wins over the store for the slots it names.
 */
export interface McpCredentialSources {
  store: McpCredentialStore;
  environment: Readonly<Record<string, string | undefined>>;
  pending?: Readonly<Record<string, string>>;
}

/**
 * One slot's value, or what is missing: the variables a reference could not
 * fill, or nothing at all for a stored secret that is not there (the slot is
 * then the whole of what is missing).
 */
function resolveSource(
  serverId: string,
  slot: string,
  source: McpCredentialSource,
  sources: McpCredentialSources,
): { ok: true; value: string } | { ok: false; variables: readonly string[] } {
  if (source.kind === "secret") {
    const value = sources.pending?.[slot] ?? sources.store.read(serverId)?.secrets?.[slot];
    return value === undefined || value.length === 0
      ? { ok: false, variables: [] }
      : { ok: true, value };
  }
  const resolved = resolveMcpCredentialTemplate(
    source.template,
    (name) => sources.environment[name],
  );
  return resolved.ok ? resolved : { ok: false, variables: resolved.missing };
}

/** How one unfilled slot reads: `header Authorization`, or `${TOKEN} (for header Authorization)`. */
function missingLabel(label: string, variables: readonly string[]): string {
  return variables.length === 0
    ? label
    : `${variables.map((name) => `\${${name}}`).join(", ")} (for ${label})`;
}

/**
 * Resolve every entry of one family, or throw naming everything missing.
 *
 * All-or-nothing: a server sent three of its four headers fails in a way
 * nobody can diagnose, so one missing slot fails the whole connection — and
 * every missing slot is named at once, so a person fixes them in one pass.
 */
export function resolveMcpCredentialEntries(
  server: Pick<McpServerDraft, "id" | "name">,
  family: McpCredentialFamily,
  entries: readonly McpCredentialEntry[] | undefined,
  sources: McpCredentialSources,
): Record<string, string> {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const entry of entries ?? []) {
    const slot = mcpCredentialSlot(family, entry.name);
    const resolved = resolveSource(server.id, slot, entry.source, sources);
    if (!resolved.ok) {
      missing.push(missingLabel(`${family} ${entry.name}`, resolved.variables));
      continue;
    }
    const problem = mcpCredentialValueProblem(family, resolved.value);
    if (problem !== null) {
      throw new McpCredentialInvalidError(server.name, `${family} ${entry.name}`, problem);
    }
    values[entry.name] = resolved.value;
  }
  if (missing.length > 0) throw new McpCredentialMissingError(server.name, missing);
  return values;
}

/** Resolve a pre-registered OAuth client's secret, when one is configured. */
export function resolveMcpOAuthClientSecret(
  server: Pick<McpServerDraft, "id" | "name">,
  source: McpCredentialSource | undefined,
  sources: McpCredentialSources,
): string | undefined {
  if (source === undefined) return undefined;
  const resolved = resolveSource(server.id, MCP_OAUTH_CLIENT_SECRET_SLOT, source, sources);
  if (!resolved.ok) {
    throw new McpCredentialMissingError(server.name, [
      missingLabel(mcpCredentialSlotLabel(MCP_OAUTH_CLIENT_SECRET_SLOT), resolved.variables),
    ]);
  }
  return resolved.value;
}

/**
 * The secret slots a server's configuration names that hold no value now.
 *
 * Settings and `server_list` show this — as slot labels only — so a person can
 * see which value to add before anything fails.
 */
export function missingMcpSecretSlots(
  server: McpServerDraft,
  store: McpCredentialStore,
): readonly string[] {
  const secrets = store.read(server.id)?.secrets ?? {};
  const slots: string[] = [];
  const transport = server.transport;
  const entries =
    transport.type === "stdio"
      ? (transport.env ?? []).map((entry) => ({ entry, family: "env" as const }))
      : (transport.headers ?? []).map((entry) => ({ entry, family: "header" as const }));
  for (const { entry, family } of entries) {
    if (entry.source.kind !== "secret") continue;
    const slot = mcpCredentialSlot(family, entry.name);
    if ((secrets[slot] ?? "").length === 0) slots.push(`${family} ${entry.name}`);
  }
  if (
    transport.type === "streamable-http" &&
    transport.oauth?.clientSecret?.kind === "secret" &&
    (secrets[MCP_OAUTH_CLIENT_SECRET_SLOT] ?? "").length === 0
  ) {
    slots.push(mcpCredentialSlotLabel(MCP_OAUTH_CLIENT_SECRET_SLOT));
  }
  return slots;
}

/** Every secret slot a server's configuration names, stored or not. */
export function configuredMcpSecretSlots(server: McpServerDraft): ReadonlySet<string> {
  const transport = server.transport;
  const slots = new Set<string>();
  if (transport.type === "stdio") {
    for (const entry of transport.env ?? []) {
      if (entry.source.kind === "secret") slots.add(mcpCredentialSlot("env", entry.name));
    }
  } else {
    for (const entry of transport.headers ?? []) {
      if (entry.source.kind === "secret") slots.add(mcpCredentialSlot("header", entry.name));
    }
    if (transport.oauth?.clientSecret?.kind === "secret") slots.add(MCP_OAUTH_CLIENT_SECRET_SLOT);
  }
  return slots;
}
