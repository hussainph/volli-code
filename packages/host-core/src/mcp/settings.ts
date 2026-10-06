import type Database from "better-sqlite3";
import {
  MCP_CONNECTION_TIMEOUT_MS,
  MCP_ERROR_MAX_CHARS,
  MCP_SECRET_VALUE_MAX_CHARS,
  sanitizeMcpProvenance,
  sanitizeMcpServerDraft,
  UNKNOWN_MCP_PROVENANCE,
  type McpConnectionBlock,
  type McpServerAccess,
  type McpServerDraft,
  type McpServerProvenance,
  type McpServerRecord,
  type McpToolDefinition,
} from "@volli/shared";

import {
  deleteMcpServer,
  getMcpServer,
  listMcpServers,
  markMcpServerRefreshFailure,
  putMcpServer,
  selectedMcpToolDefinitions,
} from "../db/mcp-servers-repo";
import { getProjectById } from "../db/projects-repo";
import { createMcpProtocolClientOpener } from "./client";
import { MemoryMcpCredentialStore, type McpCredentialStore } from "./credential-store";
import {
  configuredMcpSecretSlots,
  mcpConnectionBlock,
  missingMcpSecretSlots,
  type McpCredentialSources,
} from "./credentials";
import { discoverMcpServer, type OpenMcpProtocolClient } from "./discovery";
import { McpOAuthBroker, mcpOAuthServer, type McpSignInOutcome } from "./oauth";

/**
 * A failure that a person can unblock carries `blocked`, so a caller can route
 * it — Settings shows *Sign in*, an agent's verb asks the person driving — and
 * never has to read the sentence to know which it was.
 */
export type McpServerResult =
  | { ok: true; server: McpServerRecord }
  | { ok: false; error: string; server?: McpServerRecord; blocked?: McpConnectionBlock };
export type McpCatalogResult =
  | { ok: true; catalog: McpServerRecord["catalog"] }
  | { ok: false; error: string; blocked?: McpConnectionBlock };
export type McpMutationResult = { ok: true } | { ok: false; error: string };

/**
 * Secret values a person typed into an editor that has not been saved yet,
 * by slot. They reach a connection for *Connect* in the server dialog and are written to
 * the credential store only when the save that carries them succeeds.
 */
export type McpPendingSecrets = Readonly<Record<string, string>>;

/** The message a cancelled attempt returns, distinct from every other failure. */
export const MCP_CANCELLED_MESSAGE = "The MCP connection was cancelled before it finished.";

/**
 * The message a timed-out attempt returns (VC-380).
 *
 * A caller that asked for an install and got "it stopped" has two very
 * different next moves depending on which stop it was: a cancellation is its
 * own doing and can be retried immediately, while a timeout says the server
 * never answered and retrying unchanged will probably time out again. The two
 * were indistinguishable before this, because the internal deadline was the
 * only thing that could stop an install at all.
 */
function timeoutMessage(serverName: string): string {
  return `${serverName} did not answer within the ${MCP_CONNECTION_TIMEOUT_MS / 1_000}s MCP connection limit.`;
}

/**
 * Whether an attempt that failed had already spent its whole deadline.
 *
 * Measured, never read off the error text. The obvious implementation is a
 * regex for "timed out" across the cause chain, and it is wrong twice: it makes
 * the classification depend on wording the MCP SDK never promised, and it
 * relabels a SERVER's own fault — "upstream database timeout" is a sentence a
 * third-party process is entitled to print — as Volli's connection limit. What
 * actually distinguishes the two is whether the attempt ran out the clock, and
 * that is a number this service already has a seam for.
 */
function spentItsDeadline(elapsedMs: number): boolean {
  return elapsedMs >= MCP_CONNECTION_TIMEOUT_MS;
}

export interface McpSettingsOptions {
  db: Database.Database;
  /**
   * Replaces the real client entirely. Tests that do not exercise credentials
   * inject one; when it is injected, credentials are not resolved here.
   */
  open?: OpenMcpProtocolClient;
  /** Where secrets and OAuth tokens rest. In memory unless the app injects its file. */
  credentials?: McpCredentialStore;
  /** The environment `${NAME}` references resolve against. */
  environment?: () => Readonly<Record<string, string | undefined>>;
  /** Sign-in and token handling. One is built over `credentials` when omitted. */
  oauth?: McpOAuthBroker;
  /**
   * The clock, for stored timestamps AND for how long an attempt has run.
   *
   * One seam rather than two: a second "elapsed" clock would be a second thing
   * every test has to know about, and the one question this clock answers about
   * a failed attempt — did it spend the full {@link MCP_CONNECTION_TIMEOUT_MS}
   * — is the same question a frozen test clock answers as "no".
   */
  now?: () => number;
}

function message(error: unknown): string {
  const raw = error instanceof Error ? error.message : "The MCP operation failed.";
  const printable = Array.from(raw, (character) =>
    character.charCodeAt(0) < 32 ? " " : character,
  ).join("");
  return printable.length <= MCP_ERROR_MAX_CHARS
    ? printable
    : `${printable.slice(0, MCP_ERROR_MAX_CHARS - 1)}…`;
}

/** Pending secrets, kept only for slots the server's configuration names, and bounded. */
function pendingFor(server: McpServerDraft, secrets: unknown): McpPendingSecrets {
  if (secrets === null || typeof secrets !== "object" || Array.isArray(secrets)) return {};
  const configured = configuredMcpSecretSlots(server);
  const kept: Record<string, string> = {};
  for (const [slot, value] of Object.entries(secrets as Record<string, unknown>)) {
    if (
      configured.has(slot) &&
      typeof value === "string" &&
      value.length > 0 &&
      value.length <= MCP_SECRET_VALUE_MAX_CHARS
    ) {
      kept[slot] = value;
    }
  }
  return kept;
}

/** Main-owned settings owner. No client library or repository file crosses this boundary. */
export class McpSettingsService {
  readonly #db: Database.Database;
  readonly #injectedOpen: OpenMcpProtocolClient | undefined;
  readonly #now: () => number;
  readonly #store: McpCredentialStore;
  readonly #environment: () => Readonly<Record<string, string | undefined>>;
  readonly #oauth: McpOAuthBroker;

  constructor(options: McpSettingsOptions) {
    this.#db = options.db;
    this.#injectedOpen = options.open;
    this.#now = options.now ?? Date.now;
    this.#store = options.credentials ?? new MemoryMcpCredentialStore();
    this.#environment = options.environment ?? (() => process.env);
    this.#oauth =
      options.oauth ??
      new McpOAuthBroker({
        store: this.#store,
        openExternal: async () => {
          throw new Error("This launch cannot open a browser.");
        },
      });
  }

  /** The credential store this owner reads and writes, for the attachment hosts. */
  get credentials(): McpCredentialStore {
    return this.#store;
  }

  /** The OAuth broker, for the attachment hosts. */
  get oauth(): McpOAuthBroker {
    return this.#oauth;
  }

  /** Where `${NAME}` references and stored secrets come from, plus any unsaved ones. */
  sources(pending: McpPendingSecrets = {}): McpCredentialSources {
    return { store: this.#store, environment: this.#environment(), pending };
  }

  /**
   * The opener every connection this owner makes goes through: references
   * resolved at connect time, stored secrets read, OAuth tokens sent and
   * refreshed. The attachment hosts are handed the same one.
   */
  opener(pending: McpPendingSecrets = {}): OpenMcpProtocolClient {
    if (this.#injectedOpen !== undefined) return this.#injectedOpen;
    return createMcpProtocolClientOpener({
      sources: () => this.sources(pending),
      auth: (server, sources) => {
        const oauth = mcpOAuthServer(server);
        return oauth === null ? undefined : this.#oauth.connectionAuth(oauth, sources);
      },
      onConnected: (server) => this.#oauth.markConnected(server),
    });
  }

  /** What can be said about one server's credentials without disclosing any. */
  access(server: McpServerDraft): McpServerAccess {
    return {
      signIn: this.#oauth.signInState(server),
      missingSecrets: missingMcpSecretSlots(server, this.#store),
    };
  }

  /** {@link access} for every server in a project, by id. */
  accessFor(projectId: string): Readonly<Record<string, McpServerAccess>> {
    return Object.fromEntries(
      this.list(projectId).map((server) => [server.id, this.access(server)]),
    );
  }

  list(projectId: string): readonly McpServerRecord[] {
    return listMcpServers(this.#db, projectId);
  }

  selectedTools(projectId: string): readonly McpToolDefinition[] {
    return selectedMcpToolDefinitions(this.#db, projectId);
  }

  /**
   * Connect and read the catalog without saving anything.
   *
   * `signal` is the caller's, and supplying one is the only way an attempt can
   * be stopped early: before VC-380 both this and {@link save} passed a signal
   * nobody held, so the internal 10-second deadline was the sole exit.
   */
  async test(input: {
    projectId: string;
    server: unknown;
    /** Values typed into the editor and not saved yet; used for this connection only. */
    secrets?: unknown;
    signal?: AbortSignal;
  }): Promise<McpCatalogResult> {
    const prepared = this.#prepare(input.projectId, input.server);
    if (!prepared.ok) return prepared;
    // An id is a key into stored credentials: another project's server id
    // must not connect with that project's tokens, or record against them.
    const owner = getMcpServer(this.#db, prepared.server.id);
    if (owner !== undefined && owner.projectId !== input.projectId) {
      return { ok: false, error: "That MCP server id belongs to another project." };
    }
    const signal = input.signal ?? new AbortController().signal;
    const startedAt = this.#now();
    try {
      const catalog = await discoverMcpServer({
        server: prepared.server,
        workspacePath: prepared.workspacePath,
        enabledToolNames: [],
        signal,
        open: this.opener(pendingFor(prepared.server, input.secrets)),
      });
      return { ok: true, catalog };
    } catch (error) {
      const blocked = mcpConnectionBlock(error);
      return {
        ok: false,
        error: this.#stopped(error, signal, prepared.server.name, startedAt),
        ...(blocked === undefined ? {} : { blocked }),
      };
    } finally {
      if (owner === undefined) this.#forgetRefusalOnly(prepared.server.id);
    }
  }

  /**
   * A test of an id nobody saved leaves no record behind whose only content
   * is the refusal it met: that is not a credential, and an agent's preview
   * would otherwise strew them through the credential file. Tokens or values
   * gathered for an editor draft are kept, for the save that follows.
   */
  #forgetRefusalOnly(serverId: string): void {
    const record = this.#store.read(serverId);
    if (
      record !== undefined &&
      record.oauth === undefined &&
      Object.keys(record.secrets ?? {}).length === 0
    ) {
      this.#store.delete(serverId);
    }
  }

  async save(input: {
    projectId: string;
    server: unknown;
    enabledTools: readonly string[];
    /** Where this configuration came from. Recorded as given; nothing verifies it. */
    provenance?: unknown;
    /** Values typed into the editor, by slot; stored only if this save succeeds. */
    secrets?: unknown;
    signal?: AbortSignal;
  }): Promise<McpServerResult> {
    const prepared = this.#prepare(input.projectId, input.server);
    if (!prepared.ok) return prepared;
    const existing = getMcpServer(this.#db, prepared.server.id);
    if (existing !== undefined && existing.projectId !== input.projectId) {
      return { ok: false, error: "That MCP server id belongs to another project." };
    }
    // Validated BEFORE anything is connected: a provenance note this build
    // could not read back is a caller mistake, and spending a handshake to
    // discover it would be spending a process launch on a typo.
    const provenance = sanitizeMcpProvenance(input.provenance);
    if (!provenance.ok) return { ok: false, error: provenance.reason };
    // An origin nobody restated is the origin already on file. A refresh
    // rediscovers tools; it learns nothing new about where the config came
    // from, so it must not erase what an install recorded.
    const recorded: McpServerProvenance =
      input.provenance === undefined
        ? (existing?.provenance ?? UNKNOWN_MCP_PROVENANCE)
        : provenance.provenance;
    const signal = input.signal ?? new AbortController().signal;
    const pending = pendingFor(prepared.server, input.secrets);
    const startedAt = this.#now();
    try {
      const catalog = await discoverMcpServer({
        server: prepared.server,
        workspacePath: prepared.workspacePath,
        enabledToolNames: input.enabledTools,
        signal,
        open: this.opener(pending),
      });
      // The last gate before the only write in this method. Discovery checks
      // the signal on the way in and around the handshake, but a cancellation
      // that lands while the catalog is being validated would otherwise be
      // noticed by nobody, and acceptance 6 promises a cancelled install leaves
      // NO partial configuration — not "almost none".
      signal.throwIfAborted();
      // Compare-and-swap against the row this save started from. Discovery
      // takes seconds; a person saving the same server in Settings meanwhile
      // (a header added, a secret stored) must not be written over by a save
      // that never saw it — nor have that secret pruned by `#keepSecrets`.
      const latest = getMcpServer(this.#db, prepared.server.id);
      if ((latest?.updatedAt ?? null) !== (existing?.updatedAt ?? null)) {
        return {
          ok: false,
          error: `${prepared.server.name} was changed while this was connecting, so nothing was written. Retry to use the current configuration.`,
        };
      }
      const invalid = catalog.filter((tool) => tool.definition === null);
      if (existing !== undefined && invalid.length > 0) {
        throw new Error(
          `Could not refresh ${prepared.server.name}: ${invalid.length} tool definition${invalid.length === 1 ? " is" : "s are"} invalid or unsupported.`,
        );
      }
      const discovered = new Map(catalog.map((tool) => [tool.name, tool]));
      for (const enabled of input.enabledTools) {
        const tool = discovered.get(enabled);
        if (tool?.definition === undefined || tool.definition === null) {
          throw new Error(`Enabled MCP tool ${enabled} was not discovered.`);
        }
      }
      const now = this.#now();
      const saved = putMcpServer(this.#db, {
        ...prepared.server,
        projectId: input.projectId,
        provenance: recorded,
        catalog,
        stale: false,
        error: null,
        refreshedAt: now,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      this.#keepSecrets(saved, pending);
      return { ok: true, server: saved };
    } catch (error) {
      const errorText = this.#stopped(error, signal, prepared.server.name, startedAt);
      const blocked = mcpConnectionBlock(error);
      const routed = blocked === undefined ? {} : { blocked };
      if (existing === undefined) return { ok: false, error: errorText, ...routed };
      return {
        ok: false,
        error: errorText,
        ...routed,
        server: markMcpServerRefreshFailure(this.#db, existing.id, errorText, this.#now()),
      };
    }
  }

  /**
   * Store what the editor typed, and forget values for slots the saved
   * configuration no longer names — a header removed in the editor takes its
   * stored value with it, rather than leaving a secret nobody can see behind.
   */
  #keepSecrets(server: McpServerDraft, pending: McpPendingSecrets): void {
    const configured = configuredMcpSecretSlots(server);
    this.#store.update(server.id, (current) => {
      const kept: Record<string, string> = {};
      for (const [slot, value] of Object.entries(current?.secrets ?? {})) {
        if (configured.has(slot)) kept[slot] = value;
      }
      Object.assign(kept, pending);
      return current === undefined && Object.keys(kept).length === 0
        ? undefined
        : { ...current, secrets: kept };
    });
  }

  /**
   * Sign a person in to a remote server in their browser (VC-470).
   *
   * Either a saved server (`serverId`) or the editor's unsaved draft (`server`,
   * with any secrets typed into it). A draft signs in under its own id, so the
   * tokens are already in place when the save that follows connects.
   */
  async signIn(input: {
    projectId: string;
    serverId?: string;
    server?: unknown;
    secrets?: unknown;
    signal?: AbortSignal;
    /**
     * The endpoint the caller named to the person — a running Session's
     * frozen snapshot. A saved server whose stored endpoint now differs is
     * refused rather than signed in to: the person allowed a sign-in to the
     * address they were shown, not to whatever the row says now.
     */
    expectedUrl?: string;
  }): Promise<McpSignInOutcome> {
    const signal = input.signal ?? new AbortController().signal;
    let server: McpServerDraft;
    let workspacePath: string;
    if (input.serverId !== undefined) {
      const owned = this.#owned(input.projectId, input.serverId);
      if (!owned.ok) return { ok: false, cancelled: false, message: owned.error };
      const prepared = this.#prepare(input.projectId, owned.server);
      if (!prepared.ok) return { ok: false, cancelled: false, message: prepared.error };
      const stored =
        prepared.server.transport.type === "streamable-http" ? prepared.server.transport.url : "";
      if (input.expectedUrl !== undefined && stored !== input.expectedUrl) {
        return {
          ok: false,
          cancelled: false,
          message: `${prepared.server.name}'s address changed since this Session started, so Volli did not sign in to either one. Review it in Settings \u2192 Configure \u2192 MCP Servers.`,
        };
      }
      server = prepared.server;
      workspacePath = prepared.workspacePath;
    } else {
      const prepared = this.#prepare(input.projectId, input.server);
      if (!prepared.ok) return { ok: false, cancelled: false, message: prepared.error };
      const existing = getMcpServer(this.#db, prepared.server.id);
      if (existing !== undefined && existing.projectId !== input.projectId) {
        return {
          ok: false,
          cancelled: false,
          message: "That MCP server id belongs to another project.",
        };
      }
      server = prepared.server;
      workspacePath = prepared.workspacePath;
    }
    const pending = pendingFor(server, input.secrets);
    return this.#oauth.signIn(server, {
      sources: this.sources(pending),
      signal,
      probe: async (auth, probeSignal) => {
        const client = await createMcpProtocolClientOpener(
          { sources: () => this.sources(pending) },
          { auth },
        )(server, workspacePath, probeSignal);
        await client.close().catch(() => undefined);
      },
    });
  }

  /** Stop a sign-in waiting on the browser, for everyone waiting on it. */
  cancelSignIn(input: { projectId: string; serverId: string }): McpMutationResult {
    // A saved server is cancelled only from its own project; an editor
    // draft has no row yet, and its id is the pane's own.
    const existing = getMcpServer(this.#db, input.serverId);
    if (existing !== undefined && existing.projectId !== input.projectId) {
      return { ok: false, error: "MCP server not found." };
    }
    this.#oauth.cancelSignIn(input.serverId);
    return { ok: true };
  }

  /** Delete a server's stored OAuth tokens and registration. Secrets stay. */
  signOut(input: { projectId: string; serverId: string }): McpMutationResult {
    const existing = this.#owned(input.projectId, input.serverId);
    if (!existing.ok) return existing;
    this.#oauth.signOut(input.serverId);
    return { ok: true };
  }

  /**
   * Forget credentials gathered for an editor draft that was never saved: a
   * sign-in for a server the person then cancelled adding leaves nothing
   * behind. A saved server's credentials are not touched by this.
   */
  discardDraft(input: { projectId: string; serverId: string }): McpMutationResult {
    if (getMcpServer(this.#db, input.serverId) !== undefined) return { ok: true };
    this.#store.delete(input.serverId);
    return { ok: true };
  }

  async refresh(input: {
    projectId: string;
    serverId: string;
    signal?: AbortSignal;
  }): Promise<McpServerResult> {
    const existing = this.#owned(input.projectId, input.serverId);
    if (!existing.ok) return existing;
    const enabledTools = existing.server.catalog
      .filter((tool) => tool.enabled)
      .map((tool) => tool.name);
    return this.save({
      projectId: input.projectId,
      server: existing.server,
      enabledTools,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }

  setEnabled(input: { projectId: string; serverId: string; enabled: boolean }): McpServerResult {
    const existing = this.#owned(input.projectId, input.serverId);
    if (!existing.ok) return existing;
    return {
      ok: true,
      server: putMcpServer(this.#db, {
        ...existing.server,
        enabled: input.enabled,
        updatedAt: this.#now(),
      }),
    };
  }

  setTools(input: {
    projectId: string;
    serverId: string;
    enabledTools: readonly string[];
  }): McpServerResult {
    const existing = this.#owned(input.projectId, input.serverId);
    if (!existing.ok) return existing;
    const selected = new Set(input.enabledTools);
    for (const name of selected) {
      const tool = existing.server.catalog.find((candidate) => candidate.name === name);
      if (tool?.definition === undefined || tool.definition === null) {
        return { ok: false, error: `Enabled MCP tool ${name} was not discovered.` };
      }
    }
    return {
      ok: true,
      server: putMcpServer(this.#db, {
        ...existing.server,
        catalog: existing.server.catalog.map((tool) =>
          Object.assign({}, tool, {
            enabled: tool.definition !== null && selected.has(tool.name),
          }),
        ),
        updatedAt: this.#now(),
      }),
    };
  }

  /**
   * Delete a server's configuration, and every credential stored for it.
   *
   * A removed server's secrets and tokens are not kept for a re-add: a
   * credential nobody can see in Settings any more is one nobody would think
   * to revoke. Re-adding the server under the same id restores reattachment
   * for older Sessions; a person signs in or stores the value again.
   */
  remove(input: { projectId: string; serverId: string }): McpMutationResult {
    if (!deleteMcpServer(this.#db, input.projectId, input.serverId)) {
      return { ok: false, error: "MCP server not found." };
    }
    this.#store.delete(input.serverId);
    return { ok: true };
  }

  #prepare(
    projectId: string,
    candidate: unknown,
  ): { ok: true; server: McpServerDraft; workspacePath: string } | { ok: false; error: string } {
    const project = getProjectById(this.#db, projectId);
    if (project === undefined) return { ok: false, error: "Project not found." };
    if (candidate === null || typeof candidate !== "object") {
      return { ok: false, error: "MCP server configuration is invalid." };
    }
    const row = candidate as Record<string, unknown>;
    const sanitized = sanitizeMcpServerDraft({
      id: row["id"],
      name: row["name"],
      enabled: row["enabled"],
      transport: row["transport"],
    });
    return sanitized.ok
      ? { ok: true, server: sanitized.server, workspacePath: project.path }
      : { ok: false, error: sanitized.reason };
  }

  /**
   * Why an attempt stopped, in the caller's own words.
   *
   * Three outcomes a caller acts on differently: it cancelled, the server never
   * answered, or the connection genuinely failed. Both tests are structural.
   * The signal is asked first because an abort surfaces as whatever the SDK
   * happened to throw, and the signal is the only reliable witness to it; the
   * clock is asked second because a deadline is a duration, not a spelling.
   * Neither reads the error's own text, which is a third party's prose.
   */
  #stopped(error: unknown, signal: AbortSignal, serverName: string, startedAt: number): string {
    if (signal.aborted) return MCP_CANCELLED_MESSAGE;
    if (spentItsDeadline(this.#now() - startedAt)) return timeoutMessage(serverName);
    return message(error);
  }

  #owned(projectId: string, serverId: string): McpServerResult {
    const server = getMcpServer(this.#db, serverId);
    return server === undefined || server.projectId !== projectId
      ? { ok: false, error: "MCP server not found." }
      : { ok: true, server };
  }
}
