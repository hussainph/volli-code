/**
 * Configure → MCP Servers: app-owned, per-project transport and tool settings.
 *
 * TWO LAWS THIS PANE LEARNED THE HARD WAY (VC-397). A real server ships 34
 * tools with a paragraph of description each, and this pane used to draw all of
 * them, always, under a section marked `fill`.
 *
 *  1. **A pane whose sections FOLLOW a collection does not `fill`.** `fill`
 *     hands a section the pane's leftover height and expects the collection
 *     inside it to own the overflow. A bare list does not: it overflowed its
 *     box and painted straight through `Recent activity` and the editor below
 *     it. The kit already states the rule — `rows="fill"` is "for a pane where
 *     the table IS the page", and Settings → Models keeps a numeric cap
 *     "because sections follow it". This pane is a table, an editor and an
 *     audit list, so every section sits in ordinary block flow, the table caps
 *     itself, and each unbounded list owns a bounded scroll box. Nothing can
 *     then overlap at any viewport size or catalog length.
 *
 *  2. **Detail is asked for, not broadcast.** Tool descriptions, and the
 *     transport line an audit row carries, live behind the shared
 *     `Collapsible`. The always-visible layer is what a person scans: the
 *     server, its counts, its freshness, its origin, and anything wrong.
 *     Nothing was removed — the trust boundary, provenance, freshness, errors
 *     and every operation still render; they simply stopped arriving all at
 *     once.
 */
import * as React from "react";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { ClockCounterClockwiseIcon } from "@phosphor-icons/react/dist/csr/ClockCounterClockwise";
import { PencilSimpleIcon } from "@phosphor-icons/react/dist/csr/PencilSimple";
import { PlugsConnectedIcon } from "@phosphor-icons/react/dist/csr/PlugsConnected";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { SignInIcon } from "@phosphor-icons/react/dist/csr/SignIn";
import { SignOutIcon } from "@phosphor-icons/react/dist/csr/SignOut";
import { TrashIcon } from "@phosphor-icons/react/dist/csr/Trash";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import {
  MCP_OAUTH_CLIENT_SECRET_SLOT,
  mcpCredentialSlot,
  mcpServerUsesOAuth,
  type McpCatalogTool,
  type McpConnectionBlock,
  type McpOperationRecord,
  type McpServerAccess,
  type McpServerDraft,
  type McpServerProvenance,
  type McpServerRecord,
  type McpTransportConfig,
  type Project,
} from "@volli/shared";

import { Button } from "@renderer/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@renderer/components/ui/collapsible";
import { Input } from "@renderer/components/ui/input";
import { Textarea } from "@renderer/components/ui/textarea";
import { Cell, DataTable, PrefSection, SectionAction } from "@renderer/components/settings/kit";
import { relativeTime } from "@renderer/lib/relative-time";
import { cn } from "@renderer/lib/utils";

import {
  applyCredentials,
  credentialsFromTransport,
  EMPTY_CREDENTIALS,
  McpCredentialsEditor,
  type EditorCredentials,
} from "./mcp-credentials-editor";

const EMPTY_DRAFT: McpServerDraft = {
  id: "",
  name: "",
  enabled: true,
  transport: { type: "stdio", command: "", args: [] },
};

/**
 * How many server rows the table shows before it scrolls.
 *
 * A number, not `"fill"`: sections follow this table, so the cap is what keeps
 * them reachable — the same reason Settings → Models keeps one.
 */
const SERVER_ROWS = 6;

/** A list long enough to bury the page gets its own scroll box instead. */
const SCROLL_BOX = "max-h-64 overflow-y-auto";

function freshId(): string {
  return `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function serverStatus(server: McpServerRecord, access: McpServerAccess | undefined): string {
  if (access?.signIn === "needs-sign-in") return "Needs sign-in";
  if ((access?.missingSecrets.length ?? 0) > 0) return "Missing credential";
  if (server.stale) return "Stale catalog";
  if (server.error !== null) return "Needs attention";
  return server.enabled ? "Enabled" : "Disabled";
}

/** Whether a server signs in with OAuth at all: remote, and no Authorization header of its own. */
function signsIn(server: McpServerDraft): boolean {
  return (
    server.transport.type === "streamable-http" && mcpServerUsesOAuth(server.transport.headers)
  );
}

/**
 * The secret slots a saved server already holds a value for, read off what is
 * MISSING — main reports labels of absent values, never the values present.
 */
function storedSlots(server: McpServerDraft, access: McpServerAccess | undefined): Set<string> {
  const missing = new Set(access?.missingSecrets ?? []);
  const stored = new Set<string>();
  const transport = server.transport;
  const entries =
    transport.type === "stdio"
      ? (transport.env ?? []).map((entry) => ["env", entry] as const)
      : (transport.headers ?? []).map((entry) => ["header", entry] as const);
  for (const [family, entry] of entries) {
    if (entry.source.kind === "secret" && !missing.has(`${family} ${entry.name}`)) {
      stored.add(mcpCredentialSlot(family, entry.name));
    }
  }
  if (
    transport.type === "streamable-http" &&
    transport.oauth?.clientSecret?.kind === "secret" &&
    !missing.has("OAuth client secret")
  ) {
    stored.add(MCP_OAUTH_CLIENT_SECRET_SLOT);
  }
  return stored;
}

/**
 * When this server's tool list was last read successfully.
 *
 * `Enabled` says what the settings ALLOW, which is a different question from
 * whether the catalog beside it is anything like current — a server can read
 * as perfectly healthy while showing tools discovered weeks ago. The stamp was
 * always stored and never shown; a row that reports staleness but not freshness
 * leaves the reader unable to judge the row that is not stale.
 */
function refreshedLabel(server: McpServerRecord): string {
  return server.refreshedAt === null
    ? "Never refreshed"
    : `Refreshed ${relativeTime(server.refreshedAt)}`;
}

/**
 * Where a server came from, as one line, or nothing at all (VC-380).
 *
 * Two decisions here follow the repository's "let controls talk" rule. A server
 * with no recorded origin — every one a person typed in by hand — renders
 * NOTHING, rather than a row of em-dashes describing an absence. And a server
 * that does carry one says "not verified" once, because a version and a digest
 * displayed plainly read as a guarantee, and Volli downloads nothing and so
 * checks nothing against them. That is a trust boundary a person cannot see
 * from the control, which is the narrow exception the rule allows.
 */
function provenanceLine(provenance: McpServerProvenance): string | null {
  const parts = [
    provenance.source,
    provenance.registryType,
    provenance.version,
    provenance.digest,
  ].filter((part): part is string => part !== null && part.length > 0);
  return parts.length === 0 ? null : `${parts.join(" · ")} — recorded, not verified`;
}

/**
 * Who asked for one recorded operation.
 *
 * A Session id is not a name a person recognises, but "an agent Session" versus
 * "someone here" is the distinction that actually decides what to do about a
 * row, and it is the one the record can answer honestly.
 */
function operationActor(entry: McpOperationRecord): string {
  return entry.sessionId === null ? "in Settings" : "by an agent Session";
}

function enabledToolNames(catalog: readonly McpCatalogTool[]): string[] {
  return catalog
    .filter((tool) => tool.enabled && tool.definition !== null)
    .map((tool) => tool.name);
}

function toolCountLabel(catalog: readonly McpCatalogTool[]): string {
  return catalog.length === 0
    ? "No tools discovered"
    : `${enabledToolNames(catalog).length} of ${catalog.length} tools enabled`;
}

function replaceServer(
  servers: readonly McpServerRecord[],
  server: McpServerRecord,
): readonly McpServerRecord[] {
  const index = servers.findIndex((candidate) => candidate.id === server.id);
  return index < 0
    ? [...servers, server]
    : servers.map((candidate) => (candidate.id === server.id ? server : candidate));
}

/**
 * An open editor, and which server it is open ON.
 *
 * `opened` is bumped on every request so the name field is focused each time
 * the editor is summoned — including "Edit" twice on the same row, where the
 * editor never unmounts and nothing else in this state would have changed.
 */
interface EditorRequest {
  serverId: string | null;
  opened: number;
}

export function McpPane({ project }: { project: Project }) {
  const nameRef = React.useRef<HTMLInputElement>(null);
  const opens = React.useRef(0);
  const [servers, setServers] = React.useState<readonly McpServerRecord[]>([]);
  const [operations, setOperations] = React.useState<readonly McpOperationRecord[]>([]);
  const [draft, setDraft] = React.useState<McpServerDraft>(EMPTY_DRAFT);
  const [editor, setEditor] = React.useState<EditorRequest | null>(null);
  const [catalog, setCatalog] = React.useState<readonly McpCatalogTool[]>([]);
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [access, setAccess] = React.useState<Readonly<Record<string, McpServerAccess>>>({});
  const [credentials, setCredentials] = React.useState<EditorCredentials>(EMPTY_CREDENTIALS);
  /** What the editor's last connection was blocked on, so it can offer the one fix. */
  const [blocked, setBlocked] = React.useState<McpConnectionBlock | null>(null);
  /** The server a sign-in is waiting on the browser for. */
  const [signingIn, setSigningIn] = React.useState<string | null>(null);

  const editingId = editor?.serverId ?? null;
  const opened = editor?.opened ?? null;

  const load = React.useCallback(async () => {
    setBusy("list");
    const result = await window.api.mcp.list({ projectId: project.id });
    setBusy(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    setServers(result.servers);
    setOperations(result.operations);
    setAccess(result.access ?? {});
  }, [project.id]);

  React.useEffect(() => {
    void load();
  }, [load]);

  /**
   * Re-read only where each server stands on credentials, after an act that
   * can change it (a save, a sign-in, a sign-out). The server rows themselves
   * come back from those acts directly.
   */
  const refreshAccess = React.useCallback(async () => {
    const result = await window.api.mcp.list({ projectId: project.id });
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setAccess(result.access ?? {});
  }, [project.id]);

  // The editor mounts when it is summoned, so the focus the old always-open
  // form took synchronously has to wait for that mount.
  React.useEffect(() => {
    if (opened === null) return;
    nameRef.current?.focus();
  }, [opened]);

  function startAdding(): void {
    setDraft(EMPTY_DRAFT);
    setCredentials(EMPTY_CREDENTIALS);
    setBlocked(null);
    setCatalog([]);
    setSelected(new Set());
    setError(null);
    opens.current += 1;
    setEditor({ serverId: null, opened: opens.current });
  }

  function startEditing(server: McpServerRecord): void {
    setDraft({
      id: server.id,
      name: server.name,
      enabled: server.enabled,
      transport: server.transport,
    });
    setCredentials(credentialsFromTransport(server.transport));
    setBlocked(null);
    setCatalog(server.catalog);
    setSelected(new Set(enabledToolNames(server.catalog)));
    setError(null);
    opens.current += 1;
    setEditor({ serverId: server.id, opened: opens.current });
  }

  function resetEditor(): void {
    setEditor(null);
    setDraft(EMPTY_DRAFT);
    setCredentials(EMPTY_CREDENTIALS);
    setBlocked(null);
    setCatalog([]);
    setSelected(new Set());
    setError(null);
  }

  /**
   * Cancel. A draft that was never saved may have been signed in to; whatever
   * that stored is forgotten with it.
   */
  async function closeEditor(): Promise<void> {
    const unsaved = editingId === null && draft.id.length > 0 ? draft.id : null;
    resetEditor();
    if (unsaved === null) return;
    const result = await window.api.mcp.discardDraft({ projectId: project.id, serverId: unsaved });
    if (!result.ok) setError(result.error);
  }

  function setTransport(type: McpTransportConfig["type"]): void {
    setCatalog([]);
    setSelected(new Set());
    setBlocked(null);
    setDraft((current) => ({
      ...current,
      transport:
        type === "stdio"
          ? { type, command: "", args: [] }
          : { type, url: "http://127.0.0.1:3000/mcp" },
    }));
  }

  /** The draft as main should see it: an id, its credentials applied, and typed secrets. */
  function prepared(): { server: McpServerDraft; secrets: Record<string, string> } {
    const applied = applyCredentials(draft.transport, credentials);
    return {
      server: { ...draft, id: draft.id || freshId(), transport: applied.transport },
      secrets: applied.secrets,
    };
  }

  async function testDraft(): Promise<void> {
    setBusy("test");
    const { server, secrets } = prepared();
    const result = await window.api.mcp.test({
      projectId: project.id,
      server,
      ...(Object.keys(secrets).length === 0 ? {} : { secrets }),
    });
    setBusy(null);
    // The id is kept either way: a sign-in for this draft is filed under it.
    setDraft((current) => ({ ...current, id: server.id }));
    if (!result.ok) {
      setError(result.error);
      setBlocked(result.blocked ?? null);
      return;
    }
    // New discoveries are opt-in. A person chooses every tool explicitly.
    setBlocked(null);
    setCatalog(result.catalog);
    setSelected(new Set());
    setError(null);
  }

  async function saveDraft(): Promise<void> {
    setBusy("save");
    const { server, secrets } = prepared();
    const result = await window.api.mcp.save({
      projectId: project.id,
      server,
      enabledTools: [...selected],
      ...(Object.keys(secrets).length === 0 ? {} : { secrets }),
    });
    setBusy(null);
    if (!result.ok) {
      setError(result.error);
      setBlocked(result.blocked ?? null);
      if (result.server !== undefined)
        setServers((current) => replaceServer(current, result.server!));
      return;
    }
    setServers((current) => replaceServer(current, result.server));
    resetEditor();
    await refreshAccess();
  }

  /**
   * Sign in in the browser: a saved server by id, or the editor's draft. The
   * pane waits for the redirect; *Cancel sign-in* stops the wait.
   */
  async function signIn(target: { serverId: string } | { draft: true }): Promise<void> {
    // Prepared once: an unsaved draft is given its id here, and the sign-in,
    // its cancel control and the discovery that follows must all use that one.
    const draftRequest = "serverId" in target ? null : prepared();
    const id =
      draftRequest === null ? (target as { serverId: string }).serverId : draftRequest.server.id;
    setSigningIn(id);
    setBusy(`sign-in:${id}`);
    let result: Awaited<ReturnType<typeof window.api.mcp.signIn>>;
    if (draftRequest === null) {
      result = await window.api.mcp.signIn({ projectId: project.id, serverId: id });
    } else {
      setDraft((current) => ({ ...current, id }));
      result = await window.api.mcp.signIn({
        projectId: project.id,
        server: draftRequest.server,
        ...(Object.keys(draftRequest.secrets).length === 0
          ? {}
          : { secrets: draftRequest.secrets }),
      });
    }
    setSigningIn(null);
    setBusy(null);
    await refreshAccess();
    if (!result.ok) {
      if (!result.cancelled) setError(result.error);
      return;
    }
    setError(null);
    setBlocked(null);
    // A draft that was blocked on the sign-in goes straight on to discovery.
    if (draftRequest !== null) await testDraft();
  }

  async function cancelSignIn(serverId: string): Promise<void> {
    const result = await window.api.mcp.cancelSignIn({ projectId: project.id, serverId });
    if (!result.ok) setError(result.error);
  }

  async function signOut(server: McpServerRecord): Promise<void> {
    setBusy(`sign-out:${server.id}`);
    const result = await window.api.mcp.signOut({ projectId: project.id, serverId: server.id });
    setBusy(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    await refreshAccess();
  }

  async function refresh(server: McpServerRecord): Promise<void> {
    setBusy(`refresh:${server.id}`);
    const result = await window.api.mcp.refresh({ projectId: project.id, serverId: server.id });
    setBusy(null);
    if (result.server !== undefined)
      setServers((current) => replaceServer(current, result.server!));
    setError(result.ok ? null : result.error);
  }

  async function toggleServer(server: McpServerRecord, enabled: boolean): Promise<void> {
    setBusy(`enable:${server.id}`);
    const result = await window.api.mcp.setEnabled({
      projectId: project.id,
      serverId: server.id,
      enabled,
    });
    setBusy(null);
    if (result.ok) setServers((current) => replaceServer(current, result.server));
    setError(result.ok ? null : result.error);
  }

  async function toggleTool(
    server: McpServerRecord,
    name: string,
    enabled: boolean,
  ): Promise<void> {
    const names = new Set(enabledToolNames(server.catalog));
    if (enabled) names.add(name);
    else names.delete(name);
    setBusy(`tools:${server.id}`);
    const result = await window.api.mcp.setTools({
      projectId: project.id,
      serverId: server.id,
      enabledTools: [...names],
    });
    setBusy(null);
    if (result.ok) setServers((current) => replaceServer(current, result.server));
    setError(result.ok ? null : result.error);
  }

  async function remove(server: McpServerRecord): Promise<void> {
    setBusy(`remove:${server.id}`);
    const result = await window.api.mcp.remove({ projectId: project.id, serverId: server.id });
    setBusy(null);
    if (result.ok)
      setServers((current) => current.filter((candidate) => candidate.id !== server.id));
    setError(result.ok ? null : result.error);
  }

  const transport = draft.transport;
  return (
    // Ordinary block flow, no `fill`: see the note at the top of this file.
    <div className="flex flex-col gap-6">
      <PrefSection
        title="Servers"
        icon={PlugsConnectedIcon}
        hint={
          <>
            Server metadata and results are untrusted data, never instructions. Tool choices affect
            new Sessions only; a Session keeps the definitions frozen at birth.
          </>
        }
        action={<SectionAction label="Add server" icon={PlusIcon} onAct={startAdding} />}
      >
        {/* The one always-on line, and the reason it is an exception to "let
            controls talk": it is a trust boundary a person cannot see from the
            controls. Everything else about MCP lives in the summoned hint. */}
        <p className="mb-2 text-ui text-muted-foreground">
          A local MCP command runs as you; a remote server receives the arguments sent to its tools.
        </p>
        {error === null ? null : (
          <p
            role="alert"
            className="mb-2 rounded-md bg-destructive/10 px-3 py-2 text-ui text-destructive"
          >
            {error}
          </p>
        )}
        <DataTable
          label="MCP servers"
          items={servers}
          keyOf={(server) => server.id}
          rows={SERVER_ROWS}
          empty={busy === "list" ? "Loading MCP servers…" : "No MCP servers yet."}
          columns={[
            {
              key: "name",
              header: "Server",
              cell: (server) => (
                <Cell strong>
                  <span>{server.name}</span>
                  <span className="ml-2 text-muted-foreground">
                    {server.transport.type === "stdio" ? "stdio" : "HTTP"}
                  </span>
                </Cell>
              ),
            },
            {
              key: "tools",
              header: "Tools",
              width: "7rem",
              cell: (server) => (
                <Cell muted>
                  {enabledToolNames(server.catalog).length}/{server.catalog.length} enabled
                </Cell>
              ),
            },
            {
              key: "status",
              header: "Status",
              width: "9rem",
              cell: (server) => <Cell muted>{serverStatus(server, access[server.id])}</Cell>,
            },
            {
              key: "enabled",
              header: "On",
              width: "4rem",
              cell: (server) => (
                <input
                  aria-label={`${server.name} enabled`}
                  type="checkbox"
                  checked={server.enabled}
                  disabled={busy !== null}
                  onChange={(event) => void toggleServer(server, event.currentTarget.checked)}
                />
              ),
            },
            {
              key: "actions",
              header: "Actions",
              width: "12rem",
              cell: (server) => (
                <div className="flex gap-1">
                  <SignInAction
                    server={server}
                    access={access[server.id]}
                    busy={busy !== null}
                    waiting={signingIn === server.id}
                    onSignIn={() => void signIn({ serverId: server.id })}
                    onCancel={() => void cancelSignIn(server.id)}
                    onSignOut={() => void signOut(server)}
                  />
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Edit ${server.name}`}
                    disabled={busy !== null}
                    onClick={() => startEditing(server)}
                  >
                    <PencilSimpleIcon />
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Refresh ${server.name}`}
                    disabled={busy !== null}
                    onClick={() => void refresh(server)}
                  >
                    <ArrowClockwiseIcon />
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Remove ${server.name}`}
                    disabled={busy !== null}
                    onClick={() => void remove(server)}
                  >
                    <TrashIcon />
                  </Button>
                </div>
              ),
            },
          ]}
        />
        {servers.length === 0 ? null : (
          <div className="mt-3 flex flex-col gap-2">
            {servers.map((server) => (
              <ServerCatalog
                key={`tools:${server.id}`}
                server={server}
                access={access[server.id]}
                busy={busy !== null}
                onToggleTool={(name, enabled) => void toggleTool(server, name, enabled)}
              />
            ))}
          </div>
        )}
      </PrefSection>

      {editor === null ? null : (
        <PrefSection title={editingId === null ? "Add server" : "Edit server"} icon={PlusIcon}>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1">
              <label className="text-ui" htmlFor="mcp-server-name">
                Name
              </label>
              <Input
                ref={nameRef}
                id="mcp-server-name"
                value={draft.name}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, name: event.target.value }))
                }
              />
            </div>
            <div className="grid gap-1">
              <label className="text-ui" htmlFor="mcp-transport">
                Transport
              </label>
              <select
                id="mcp-transport"
                className="h-7 rounded-control border border-border bg-background px-2 text-ui"
                value={transport.type}
                onChange={(event) => setTransport(event.target.value as McpTransportConfig["type"])}
              >
                <option value="stdio">Standard input/output</option>
                <option value="streamable-http">Streamable HTTP</option>
              </select>
            </div>
            {transport.type === "stdio" ? (
              <>
                <div className="grid gap-1">
                  <label className="text-ui" htmlFor="mcp-command">
                    Executable
                  </label>
                  <Input
                    id="mcp-command"
                    value={transport.command}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        transport: { ...transport, command: event.target.value },
                      }))
                    }
                  />
                </div>
                <div className="grid gap-1">
                  <label className="text-ui" htmlFor="mcp-args">
                    Arguments (one per line)
                  </label>
                  <Textarea
                    id="mcp-args"
                    value={transport.args.join("\n")}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        transport: { ...transport, args: event.target.value.split("\n") },
                      }))
                    }
                  />
                </div>
              </>
            ) : (
              <div className="grid gap-1 sm:col-span-2">
                <label className="text-ui" htmlFor="mcp-url">
                  Endpoint URL
                </label>
                <Input
                  id="mcp-url"
                  type="url"
                  value={transport.url}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      transport: { ...transport, url: event.target.value },
                    }))
                  }
                />
              </div>
            )}
            <McpCredentialsEditor
              transport={transport.type}
              {...(transport.type === "streamable-http" ? { url: transport.url } : {})}
              credentials={credentials}
              stored={
                editingId === null
                  ? new Set<string>()
                  : storedSlots(
                      servers.find((server) => server.id === editingId) ?? draft,
                      access[editingId],
                    )
              }
              onChange={setCredentials}
            />
          </div>
          {catalog.length === 0 ? null : (
            <fieldset className="mt-3 rounded-md border border-border/60 p-3">
              <legend className="px-1 text-ui font-medium">
                Discovered tools — choose explicitly
              </legend>
              {/* A discovery of 34 tools is a scroll box, not a page. */}
              <div className={cn("grid gap-2 sm:grid-cols-2", SCROLL_BOX)}>
                {catalog.map((tool) => (
                  <label key={tool.name} className="flex gap-2 text-ui">
                    <input
                      type="checkbox"
                      checked={selected.has(tool.name)}
                      disabled={tool.definition === null}
                      onChange={(event) => {
                        const next = new Set(selected);
                        if (event.currentTarget.checked) next.add(tool.name);
                        else next.delete(tool.name);
                        setSelected(next);
                      }}
                    />
                    <span>
                      {tool.name}
                      {tool.error === null ? null : ` — unavailable: ${tool.error}`}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <div className="mt-3 flex justify-end gap-2">
            {blocked?.kind !== "sign-in" ? null : signingIn !== null ? (
              <Button variant="outline" onClick={() => void cancelSignIn(signingIn)}>
                <XIcon />
                Cancel sign-in
              </Button>
            ) : (
              <Button
                variant="outline"
                disabled={busy !== null}
                onClick={() => void signIn({ draft: true })}
              >
                <SignInIcon />
                Sign in
              </Button>
            )}
            <Button variant="outline" disabled={busy !== null} onClick={() => void testDraft()}>
              Test and discover
            </Button>
            <Button variant="ghost" disabled={busy !== null} onClick={() => void closeEditor()}>
              Cancel
            </Button>
            <Button
              disabled={busy !== null || catalog.length === 0}
              onClick={() => void saveDraft()}
            >
              {editingId === null ? "Save server" : "Save changes"}
            </Button>
          </div>
        </PrefSection>
      )}

      {operations.length === 0 ? null : (
        <PrefSection title="Recent activity" icon={ClockCounterClockwiseIcon}>
          {/*
            Where an install an AGENT performed becomes findable by a person.
            The audit row is the only trace of a removal once the server is gone,
            and the only trace of a failed first install at all — that one writes
            no server row, so without this list its recovery line exists nowhere
            a person looks.

            Fifty of these ride in `MCP_OPERATION_HISTORY_LIMIT`, and a removal's
            detail carries a whole transport line, so the list is bounded and the
            detail is asked for.
          */}
          <ul className={cn("flex flex-col", SCROLL_BOX)}>
            {operations.map((entry) => (
              <ActivityRow key={entry.id} entry={entry} />
            ))}
          </ul>
        </PrefSection>
      )}
    </div>
  );
}

/**
 * A row's one sign-in control: *Sign in* when the server has refused a
 * connection for want of one, *Cancel sign-in* while the browser is open,
 * *Sign out* once signed in. Nothing for a server that does not sign in, or
 * that has not asked to — most remote servers need no sign-in at all, and a
 * control on every one of them would be noise.
 */
function SignInAction({
  server,
  access,
  busy,
  waiting,
  onSignIn,
  onCancel,
  onSignOut,
}: {
  server: McpServerRecord;
  access: McpServerAccess | undefined;
  busy: boolean;
  waiting: boolean;
  onSignIn: () => void;
  onCancel: () => void;
  onSignOut: () => void;
}) {
  // An empty slot the size of the control, so every row's Edit, Refresh and
  // Remove stay in the same columns whether or not a server signs in.
  const placeholder = <span aria-hidden className="size-5 shrink-0" />;
  if (!signsIn(server)) return placeholder;
  if (waiting) {
    return (
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={`Cancel sign-in to ${server.name}`}
        onClick={onCancel}
      >
        <XIcon />
      </Button>
    );
  }
  if (access?.signIn !== "signed-in" && access?.signIn !== "needs-sign-in") return placeholder;
  return access.signIn === "signed-in" ? (
    <Button
      size="icon-xs"
      variant="ghost"
      aria-label={`Sign out of ${server.name}`}
      disabled={busy}
      onClick={onSignOut}
    >
      <SignOutIcon />
    </Button>
  ) : (
    <Button
      size="icon-xs"
      variant="ghost"
      aria-label={`Sign in to ${server.name}`}
      disabled={busy}
      onClick={onSignIn}
    >
      <SignInIcon />
    </Button>
  );
}

/** The caret every disclosure on this pane turns. */
function DisclosureCaret({ open }: { open: boolean }) {
  return <CaretDownIcon aria-hidden className={cn("transition-transform", open && "rotate-180")} />;
}

/**
 * One server's health, origin and tools — the tools behind a disclosure.
 *
 * Collapsed by default because a real catalog is 34 tools with a paragraph
 * each, and because nothing in it is actionable until a person has decided to
 * act on that server. What stays visible is what decides that: the counts, when
 * the catalog was last read, where the server came from, and what is wrong.
 */
function ServerCatalog({
  server,
  access,
  busy,
  onToggleTool,
}: {
  server: McpServerRecord;
  access: McpServerAccess | undefined;
  busy: boolean;
  onToggleTool: (name: string, enabled: boolean) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const provenance = provenanceLine(server.provenance);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="rounded-md border border-border/60 px-3 py-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-ui font-medium">{server.name}</p>
            <p className="text-ui text-muted-foreground">
              {toolCountLabel(server.catalog)} · {refreshedLabel(server)}
            </p>
            {provenance === null ? null : (
              <p className="text-ui text-muted-foreground">{provenance}</p>
            )}
            {access?.signIn === "needs-sign-in" ? (
              <p className="text-ui text-destructive">Needs sign-in</p>
            ) : access?.signIn === "signed-in" ? (
              <p className="text-ui text-muted-foreground">Signed in</p>
            ) : null}
            {(access?.missingSecrets.length ?? 0) === 0 ? null : (
              <p className="text-ui text-destructive">
                Missing {access!.missingSecrets.join(", ")}
              </p>
            )}
            {server.error === null ? null : (
              <p className="text-ui text-destructive">Stale catalog: {server.error}</p>
            )}
          </div>
          {server.catalog.length === 0 ? null : (
            <CollapsibleTrigger asChild>
              <Button
                size="xs"
                variant="ghost"
                className="shrink-0"
                aria-label={`${open ? "Hide" : "Show"} ${server.name} tools`}
              >
                <DisclosureCaret open={open} />
                {open ? "Hide tools" : "Show tools"}
              </Button>
            </CollapsibleTrigger>
          )}
        </div>
        <CollapsibleContent>
          <div className={cn("mt-2 border-t border-border/50 pt-2", SCROLL_BOX)}>
            <div className="grid gap-2 sm:grid-cols-2">
              {server.catalog.map((tool) => (
                <label key={tool.name} className="flex items-start gap-2 text-ui">
                  <input
                    type="checkbox"
                    checked={tool.enabled}
                    disabled={busy || tool.definition === null || !server.enabled}
                    onChange={(event) => onToggleTool(tool.name, event.currentTarget.checked)}
                  />
                  <span>
                    <span className="font-medium">{tool.name}</span>
                    {tool.error === null ? null : (
                      <span className="block text-destructive">Unavailable: {tool.error}</span>
                    )}
                    {tool.description.length === 0 ? null : (
                      <span className="block text-muted-foreground">{tool.description}</span>
                    )}
                  </span>
                </label>
              ))}
            </div>
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

/**
 * One recorded operation: what happened and who asked, with its detail behind a
 * disclosure.
 *
 * The detail is where a removal records the whole transport it destroyed, which
 * is precious and also long enough that fifty of them are the page. Summary
 * first, evidence on request.
 */
function ActivityRow({ entry }: { entry: McpOperationRecord }) {
  const [open, setOpen] = React.useState(false);

  return (
    <li className="border-t border-border/50 py-2 first:border-t-0 first:pt-0">
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p
              className={cn(
                "text-ui font-medium",
                entry.outcome === "failed" && "text-destructive",
              )}
            >
              {entry.summary}
            </p>
            <p className="text-ui text-muted-foreground">
              {relativeTime(entry.createdAt)} · {operationActor(entry)}
            </p>
          </div>
          {entry.detail === null ? null : (
            <CollapsibleTrigger asChild>
              <Button
                size="xs"
                variant="ghost"
                className="shrink-0"
                aria-label={`${open ? "Hide" : "Show"} detail for ${entry.serverName}`}
              >
                <DisclosureCaret open={open} />
                {open ? "Hide detail" : "Detail"}
              </Button>
            </CollapsibleTrigger>
          )}
        </div>
        <CollapsibleContent>
          <p className="mt-1 text-ui text-muted-foreground">{entry.detail}</p>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}
