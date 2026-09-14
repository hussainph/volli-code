/** Configure → MCP Servers: app-owned, per-project transport and tool settings. */
import * as React from "react";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { PencilSimpleIcon } from "@phosphor-icons/react/dist/csr/PencilSimple";
import { PlugsConnectedIcon } from "@phosphor-icons/react/dist/csr/PlugsConnected";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { TrashIcon } from "@phosphor-icons/react/dist/csr/Trash";
import type {
  McpCatalogTool,
  McpServerDraft,
  McpServerRecord,
  McpTransportConfig,
  Project,
} from "@volli/shared";

import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { Textarea } from "@renderer/components/ui/textarea";
import { Cell, DataTable, PrefSection, SectionAction } from "@renderer/components/settings/kit";

const EMPTY_DRAFT: McpServerDraft = {
  id: "",
  name: "",
  enabled: true,
  transport: { type: "stdio", command: "", args: [] },
};

function freshId(): string {
  return `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function serverStatus(server: McpServerRecord): string {
  if (server.stale) return "Stale catalog";
  if (server.error !== null) return "Needs attention";
  return server.enabled ? "Enabled" : "Disabled";
}

function enabledToolNames(catalog: readonly McpCatalogTool[]): string[] {
  return catalog
    .filter((tool) => tool.enabled && tool.definition !== null)
    .map((tool) => tool.name);
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

export function McpPane({ project }: { project: Project }) {
  const nameRef = React.useRef<HTMLInputElement>(null);
  const [servers, setServers] = React.useState<readonly McpServerRecord[]>([]);
  const [draft, setDraft] = React.useState<McpServerDraft>(EMPTY_DRAFT);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [catalog, setCatalog] = React.useState<readonly McpCatalogTool[]>([]);
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

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
  }, [project.id]);

  React.useEffect(() => {
    void load();
  }, [load]);

  function startAdding(): void {
    setDraft(EMPTY_DRAFT);
    setEditingId(null);
    setCatalog([]);
    setSelected(new Set());
    setError(null);
    nameRef.current?.focus();
  }

  function startEditing(server: McpServerRecord): void {
    setDraft({
      id: server.id,
      name: server.name,
      enabled: server.enabled,
      transport: server.transport,
    });
    setEditingId(server.id);
    setCatalog(server.catalog);
    setSelected(new Set(enabledToolNames(server.catalog)));
    setError(null);
    nameRef.current?.focus();
  }

  function setTransport(type: McpTransportConfig["type"]): void {
    setCatalog([]);
    setSelected(new Set());
    setDraft((current) => ({
      ...current,
      transport:
        type === "stdio"
          ? { type, command: "", args: [] }
          : { type, url: "http://127.0.0.1:3000/mcp" },
    }));
  }

  async function testDraft(): Promise<void> {
    setBusy("test");
    const server = { ...draft, id: draft.id || freshId() };
    const result = await window.api.mcp.test({ projectId: project.id, server });
    setBusy(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    // New discoveries are opt-in. A person chooses every tool explicitly.
    setDraft(server);
    setCatalog(result.catalog);
    setSelected(new Set());
    setError(null);
  }

  async function saveDraft(): Promise<void> {
    setBusy("save");
    const server = { ...draft, id: draft.id || freshId() };
    const result = await window.api.mcp.save({
      projectId: project.id,
      server,
      enabledTools: [...selected],
    });
    setBusy(null);
    if (!result.ok) {
      setError(result.error);
      if (result.server !== undefined)
        setServers((current) => replaceServer(current, result.server!));
      return;
    }
    setServers((current) => replaceServer(current, result.server));
    setDraft(EMPTY_DRAFT);
    setEditingId(null);
    setCatalog([]);
    setSelected(new Set());
    setError(null);
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
    <div className="flex min-h-0 flex-1 flex-col gap-6">
      <PrefSection
        fill
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
          rows={Math.max(1, servers.length)}
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
              cell: (server) => <Cell muted>{serverStatus(server)}</Cell>,
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
              width: "10rem",
              cell: (server) => (
                <div className="flex gap-1">
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
        {servers.map((server) => (
          <div
            key={`tools:${server.id}`}
            className="mt-3 rounded-md border border-border/60 px-3 py-2"
          >
            <p className="mb-2 text-ui font-medium">{server.name} tools</p>
            {server.error === null ? null : (
              <p className="mb-2 text-ui text-destructive">Stale catalog: {server.error}</p>
            )}
            <div className="grid gap-2 sm:grid-cols-2">
              {server.catalog.map((tool) => (
                <label key={tool.name} className="flex items-start gap-2 text-ui">
                  <input
                    type="checkbox"
                    checked={tool.enabled}
                    disabled={busy !== null || tool.definition === null || !server.enabled}
                    onChange={(event) =>
                      void toggleTool(server, tool.name, event.currentTarget.checked)
                    }
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
        ))}
      </PrefSection>

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
        </div>
        {catalog.length === 0 ? null : (
          <fieldset className="mt-3 rounded-md border border-border/60 p-3">
            <legend className="px-1 text-ui font-medium">
              Discovered tools — choose explicitly
            </legend>
            <div className="grid gap-2 sm:grid-cols-2">
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
          <Button variant="outline" disabled={busy !== null} onClick={() => void testDraft()}>
            Test and discover
          </Button>
          {editingId === null ? null : (
            <Button variant="ghost" disabled={busy !== null} onClick={startAdding}>
              Cancel edit
            </Button>
          )}
          <Button disabled={busy !== null || catalog.length === 0} onClick={() => void saveDraft()}>
            {editingId === null ? "Save server" : "Save changes"}
          </Button>
        </div>
      </PrefSection>
    </div>
  );
}
