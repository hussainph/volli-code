/**
 * One server, start to finish: how Volli reaches it, whether it needs a
 * person to sign in, and which of its tools new Sessions get — with one Save.
 *
 * WHY A DIALOG, AND WHY ONE. The pane used to put a server's tools in a card
 * under its table row and its connection in an editor at the foot of the page,
 * with two different tool pickers between them and two save models (each tool
 * click wrote at once; the editor waited for Save). A server is one thing a
 * person decides about, so it opens as one surface, top to bottom in the order
 * the decision is made:
 *
 *  1. **Connection.** A saved server shows a summary — transport, endpoint,
 *     sign-in, credentials — with *Edit* to open the fields; a new one opens
 *     on the fields. *Connect* reads the tool list, and a server that needs a
 *     sign-in or a credential says so right there with the one fix.
 *  2. **Tools.** The shared picker (`mcp-tool-picker.tsx`).
 *  3. **Save.** Nothing is written until then. Connect lives in the footer
 *     while editing; once it answers, the same slot becomes Add server or
 *     Save. A changed endpoint always gets a tool review before it is saved;
 *     a change to tools alone is written without touching the network.
 *
 * Newly discovered tools start off, as they always have: a person chooses each
 * one, and *Select all* or a group's checkbox makes that one click.
 */
import * as React from "react";
import { GlobeIcon } from "@phosphor-icons/react/dist/csr/Globe";
import { PencilSimpleIcon } from "@phosphor-icons/react/dist/csr/PencilSimple";
import { SignInIcon } from "@phosphor-icons/react/dist/csr/SignIn";
import { SignOutIcon } from "@phosphor-icons/react/dist/csr/SignOut";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import {
  MCP_OAUTH_CLIENT_SECRET_SLOT,
  mcpCredentialSlot,
  mcpServerUsesOAuth,
  type McpCatalogTool,
  type McpConnectionBlock,
  type McpServerAccess,
  type McpServerDraft,
  type McpServerProvenance,
  type McpServerRecord,
  type McpTransportConfig,
  type Project,
} from "@volli/shared";

import { Button } from "@renderer/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog";
import { Input } from "@renderer/components/ui/input";
import { Segmented } from "@renderer/components/ui/segmented";
import { Textarea } from "@renderer/components/ui/textarea";
import { Health } from "@renderer/components/settings/kit";
import { relativeTime } from "@renderer/lib/relative-time";
import { toastError } from "@renderer/lib/toast";
import { cn } from "@renderer/lib/utils";

import {
  applyCredentials,
  credentialsFromTransport,
  EMPTY_CREDENTIALS,
  McpCredentialsEditor,
  type EditorCredentials,
} from "./mcp-credentials-editor";
import { McpToolPicker } from "./mcp-tool-picker";
import {
  changedTools,
  endpointKey,
  endpointLabel,
  enabledToolNames,
  isSelectable,
  serverHealth,
  suggestedServerName,
} from "./mcp-tools-model";

/** What the dialog is open on. */
export type McpServerDialogTarget =
  | { kind: "add" }
  | { kind: "edit"; server: McpServerRecord; section: "tools" | "connection" };

const NEW_SERVER: McpServerDraft = {
  id: "",
  name: "",
  enabled: true,
  transport: { type: "streamable-http", url: "" },
};

const TRANSPORTS = [
  { key: "streamable-http", label: "Remote" },
  { key: "stdio", label: "Local" },
] as const satisfies readonly { key: McpTransportConfig["type"]; label: string }[];

function freshId(): string {
  return `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Whether a server signs in with OAuth at all: remote, and no Authorization header of its own. */
export function signsIn(server: McpServerDraft): boolean {
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
 * When this server's tool list was last read successfully. `Ready` says what
 * the settings allow; this says whether the list beside it is anything like
 * current (VC-380).
 */
export function refreshedLabel(server: McpServerRecord): string {
  return server.refreshedAt === null
    ? "Never refreshed"
    : `Refreshed ${relativeTime(server.refreshedAt)}`;
}

/**
 * Where a server came from, as one line, or nothing at all (VC-380). A server
 * typed in by hand renders NOTHING; one that carries an origin says "not
 * verified" once, because a version and a digest displayed plainly read as a
 * guarantee, and Volli downloads nothing and so checks nothing against them.
 */
export function provenanceLine(provenance: McpServerProvenance): string | null {
  const parts = [
    provenance.source,
    provenance.registryType,
    provenance.version,
    provenance.digest,
  ].filter((part): part is string => part !== null && part.length > 0);
  return parts.length === 0 ? null : `${parts.join(" · ")} — recorded, not verified`;
}

/**
 * The field a missing secret is typed into. Main reports a missing slot by its
 * label (`header Authorization`, `env API_KEY`, `OAuth client secret`); the
 * credential editor names the field `Authorization value`, `API_KEY value`,
 * `Client secret value` — matched without case.
 */
function missingField(label: string): string {
  return label === "OAuth client secret"
    ? "Client secret value"
    : `${label.slice(label.indexOf(" ") + 1)} value`;
}

/** The credentials a configuration names, as `Headers: A, B` — names only. */
function credentialNames(transport: McpTransportConfig): string | null {
  const entries = transport.type === "stdio" ? transport.env : transport.headers;
  if (entries === undefined || entries.length === 0) return null;
  const names = entries.map((entry) => entry.name).join(", ");
  return transport.type === "stdio" ? `Environment: ${names}` : `Headers: ${names}`;
}

/** The transport's glyph: a globe for a remote server, a terminal for a local command. */
export function TransportIcon({ type }: { type: McpTransportConfig["type"] }) {
  return type === "stdio" ? <TerminalWindowIcon aria-hidden /> : <GlobeIcon aria-hidden />;
}

export function McpServerDialog({
  project,
  target,
  access,
  signingIn,
  onClose,
  onSaved,
  onSignIn,
  onCancelSignIn,
  onSignOut,
  onAccessChanged,
}: {
  project: Project;
  target: McpServerDialogTarget;
  /** The saved server's sign-in state and missing secrets, when it is a saved one. */
  access: McpServerAccess | undefined;
  /** The server id a sign-in is waiting on the browser for, if any. */
  signingIn: string | null;
  onClose: () => void;
  onSaved: (server: McpServerRecord) => void;
  /** Sign a SAVED server in, out, or stop waiting — the pane owns those, for its rows too. */
  onSignIn: (serverId: string) => Promise<string | null>;
  onCancelSignIn: (serverId: string) => Promise<string | null>;
  onSignOut: (serverId: string) => Promise<string | null>;
  onAccessChanged: () => Promise<void>;
}) {
  const saved = target.kind === "edit" ? target.server : null;
  const [draft, setDraft] = React.useState<McpServerDraft>(() =>
    saved === null
      ? NEW_SERVER
      : { id: saved.id, name: saved.name, enabled: saved.enabled, transport: saved.transport },
  );
  const [credentials, setCredentials] = React.useState<EditorCredentials>(() =>
    saved === null ? EMPTY_CREDENTIALS : credentialsFromTransport(saved.transport),
  );
  const [editing, setEditing] = React.useState(
    target.kind === "add" || target.section === "connection",
  );
  const [catalog, setCatalog] = React.useState<readonly McpCatalogTool[]>(saved?.catalog ?? []);
  const savedSelection = React.useMemo(
    () => new Set(saved === null ? [] : enabledToolNames(saved.catalog)),
    [saved],
  );
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(savedSelection);
  /**
   * The connection — name, endpoint, credentials — differs from what is saved.
   * Cleared only by a save that lands: reading the tool list again does not
   * make a changed connection a saved one.
   */
  const [connectionChanged, setConnectionChanged] = React.useState(false);
  /** The connection changed since the tool list beside it was read. */
  const [unread, setUnread] = React.useState(false);
  /** A tool list has been read for this connection (always, for a saved server). */
  const [discovered, setDiscovered] = React.useState(saved !== null);
  /** This dialog itself reached the server: only then does it say "Connected". */
  const [connectedHere, setConnectedHere] = React.useState(false);
  /** The endpoint the tool list beside it was read from (`endpointKey`). */
  const [catalogEndpoint, setCatalogEndpoint] = React.useState(() =>
    saved === null ? null : endpointKey(saved.transport),
  );
  const [busy, setBusy] = React.useState<null | "connect" | "save" | "sign-in">(null);
  const [error, setError] = React.useState<string | null>(null);
  const [blocked, setBlocked] = React.useState<McpConnectionBlock | null>(null);
  /** The draft id a sign-in is waiting on the browser for. */
  const [draftSigningIn, setDraftSigningIn] = React.useState<string | null>(null);
  /** Bumped to put the caret in the tool filter (on open, and after a connect folds the fields). */
  const [filterFocus, setFilterFocus] = React.useState(
    target.kind === "edit" && target.section === "tools" ? 1 : 0,
  );

  const transport = draft.transport;
  const suggested = suggestedServerName(transport);
  const missing = access?.missingSecrets ?? [];

  /**
   * Where the caret goes when the connection fields appear: the endpoint for a
   * new server or an Edit, or — opened to fix a missing credential — the first
   * missing value, which is the one thing the person came to type.
   */
  const [fieldFocus, setFieldFocus] = React.useState<string | null>(() =>
    target.kind === "add"
      ? "endpoint"
      : target.section === "connection"
        ? missing.length > 0
          ? missingField(missing[0]!)
          : "endpoint"
        : null,
  );
  const toolChanges = changedTools(savedSelection, selected);
  const dirty = connectionChanged || toolChanges > 0 || (saved === null && connectedHere);
  const ready =
    (transport.type === "stdio" ? transport.command.trim() : transport.url.trim()).length > 0;

  function changed(): void {
    setConnectionChanged(true);
    setUnread(true);
    setBlocked(null);
  }

  function changeConnection(update: (current: McpServerDraft) => McpServerDraft): void {
    setDraft(update);
    changed();
  }

  function changeCredentials(next: EditorCredentials): void {
    setCredentials(next);
    changed();
  }

  function setTransport(type: McpTransportConfig["type"]): void {
    if (type === transport.type) return;
    changeConnection((current) => ({
      ...current,
      transport: type === "stdio" ? { type, command: "", args: [] } : { type, url: "" },
    }));
    setCatalog([]);
    setSelected(new Set());
    setDiscovered(false);
  }

  function editConnection(focus: string): void {
    setFieldFocus(focus);
    setEditing(true);
  }

  /** The draft as main should see it: a name, an id, its credentials, and typed secrets. */
  function prepared(): { server: McpServerDraft; secrets: Record<string, string> } {
    const applied = applyCredentials(draft.transport, credentials);
    return {
      server: {
        ...draft,
        name: draft.name.trim().length > 0 ? draft.name : suggested,
        id: draft.id || freshId(),
        transport: applied.transport,
      },
      secrets: applied.secrets,
    };
  }

  /**
   * Read the tool list for the connection as it stands. Returns the catalog
   * and the choice that carries over to it, or `null` when the server refused
   * or could not be reached — with what it is waiting on, if a person can fix
   * it.
   */
  async function connect(): Promise<{
    catalog: readonly McpCatalogTool[];
    selected: Set<string>;
  } | null> {
    setBusy("connect");
    const { server, secrets } = prepared();
    // The id and name are kept either way: a sign-in for this draft is filed
    // under the id, and the name the person did not type is the one it used.
    setDraft((current) => ({ ...current, id: server.id, name: server.name }));
    const result = await window.api.mcp.test({
      projectId: project.id,
      server,
      ...(Object.keys(secrets).length === 0 ? {} : { secrets }),
    });
    setBusy(null);
    if (!result.ok) {
      // A block is said once, beside its fix; only a failure with no fix
      // takes the footer.
      setError(result.blocked === undefined ? result.error : null);
      setBlocked(result.blocked ?? null);
      return null;
    }
    // A tool still offered on the SAME endpoint keeps its choice. A different
    // endpoint starts every tool off: the same name on another server is
    // another tool, and nobody has seen this list yet.
    const endpoint = endpointKey(server.transport);
    const offered = new Set(result.catalog.filter(isSelectable).map((tool) => tool.name));
    const carried = new Set(
      endpoint === catalogEndpoint ? [...selected].filter((name) => offered.has(name)) : [],
    );
    setError(null);
    setBlocked(null);
    setCatalog(result.catalog);
    setSelected(carried);
    setCatalogEndpoint(endpoint);
    setDiscovered(true);
    setConnectedHere(true);
    setUnread(false);
    // What answered is now the connection: its fields fold into the summary,
    // the tools get the room, and the caret goes to their filter.
    setEditing(false);
    setFilterFocus((current) => current + 1);
    return { catalog: result.catalog, selected: carried };
  }

  async function save(): Promise<void> {
    setError(null);
    if (saved !== null && !connectionChanged) {
      // Tools alone: no connection to make, nothing to read again.
      setBusy("save");
      const result = await window.api.mcp.setTools({
        projectId: project.id,
        serverId: saved.id,
        enabledTools: [...selected],
      });
      setBusy(null);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onSaved(result.server);
      return;
    }
    let chosen: ReadonlySet<string> = selected;
    if (unread || !discovered) {
      const read = await connect();
      if (read === null) return;
      chosen = read.selected;
    }
    setBusy("save");
    const { server, secrets } = prepared();
    const result = await window.api.mcp.save({
      projectId: project.id,
      server,
      enabledTools: [...chosen],
      ...(Object.keys(secrets).length === 0 ? {} : { secrets }),
    });
    setBusy(null);
    if (!result.ok) {
      setError(result.blocked === undefined ? result.error : null);
      setBlocked(result.blocked ?? null);
      if (result.blocked !== undefined) setEditing(true);
      return;
    }
    onSaved(result.server);
    await onAccessChanged();
  }

  /** Sign the DRAFT in — a new server, or a saved one whose connection is being edited. */
  async function signInDraft(): Promise<void> {
    const request = prepared();
    const id = request.server.id;
    setDraft((current) => ({ ...current, id, name: request.server.name }));
    setDraftSigningIn(id);
    setBusy("sign-in");
    const result = await window.api.mcp.signIn({
      projectId: project.id,
      server: request.server,
      ...(Object.keys(request.secrets).length === 0 ? {} : { secrets: request.secrets }),
    });
    setDraftSigningIn(null);
    setBusy(null);
    await onAccessChanged();
    if (!result.ok) {
      if (!result.cancelled) setError(result.error);
      return;
    }
    setError(null);
    setBlocked(null);
    // Blocked on the sign-in, so straight on to the tools it was hiding. The
    // fields were locked while the browser was open, so this is still the
    // draft that signed in.
    await connect();
  }

  async function cancelDraftSignIn(): Promise<string | null> {
    if (draftSigningIn === null) return null;
    const result = await window.api.mcp.cancelSignIn({
      projectId: project.id,
      serverId: draftSigningIn,
    });
    return result.ok ? null : result.error;
  }

  /**
   * Close without saving. A draft that was never saved may have been signed
   * in to; whatever that stored is forgotten with it. Refused while a save is
   * in flight: forgetting a draft's sign-in under a save that then lands
   * would add a server without the sign-in it was saved with.
   */
  async function close(): Promise<void> {
    if (busy === "save") return;
    const cancelled = await cancelDraftSignIn();
    onClose();
    // The dialog is gone by now, so a failure is said where it stays visible.
    if (cancelled !== null) toastError(cancelled);
    if (saved !== null || draft.id.length === 0) return;
    const result = await window.api.mcp.discardDraft({ projectId: project.id, serverId: draft.id });
    if (!result.ok) toastError(result.error);
  }

  const health = saved === null ? null : serverHealth(saved, access, signingIn === saved.id);
  const provenance = saved === null ? null : provenanceLine(saved.provenance);
  const title = saved === null ? "Add MCP server" : saved.name;
  // Connection and tool choice are separate decisions. Hide the old catalog
  // while editing so it cannot be mistaken for the changed endpoint's tools.
  const showTools = !editing && discovered;
  const saveLabel = saved === null ? "Add server" : "Save";
  const canSave = busy === null && ready && (saved === null ? discovered && !unread : dirty);
  const needsSignIn = editing && blocked?.kind === "sign-in";
  const waitingForSignIn = draftSigningIn !== null;

  /** A saved server's sign-in act, run by the pane, with its failure said here. */
  async function savedAct(act: (serverId: string) => Promise<string | null>): Promise<void> {
    if (saved === null) return;
    const failed = await act(saved.id);
    setError(failed);
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : void close())}>
      <DialogContent
        className={cn(
          "flex max-h-[88vh] flex-col gap-0 p-0",
          showTools ? "h-[min(46rem,88vh)] sm:max-w-3xl" : "sm:max-w-xl",
        )}
        // A half-made choice of forty tools is not lost to a stray click on
        // the scrim; Escape and Cancel still close it.
        onInteractOutside={(event) => {
          if (dirty) event.preventDefault();
        }}
        // Escape clears a typed filter first (the picker does that), closes
        // untouched setup, and never drops edits or closes under a save.
        // Cancel is the way to leave with changes unsaved.
        onEscapeKeyDown={(event) => {
          const from = event.target;
          const filtering =
            from instanceof HTMLInputElement && from.type === "search" && from.value !== "";
          if (filtering || dirty || busy === "save") event.preventDefault();
        }}
        // Focus is placed by the fields and the picker themselves (the URL
        // for a new server, the filter for a saved one's tools), not by Radix
        // on the first button it finds.
        onOpenAutoFocus={(event) => {
          if (fieldFocus !== null || filterFocus > 0) event.preventDefault();
        }}
        // A new server has no status line until it connects, and nothing else
        // to describe it.
        {...(saved === null && !connectedHere ? { "aria-describedby": undefined } : {})}
      >
        <DialogHeader className="shrink-0 gap-1 border-b border-border/50 px-4 pt-4 pb-4">
          <div className="flex items-center gap-2 pr-6">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/50 text-muted-foreground [&_svg]:size-4">
              <TransportIcon type={saved?.transport.type ?? transport.type} />
            </span>
            <DialogTitle className="truncate">{title}</DialogTitle>
          </div>
          {saved === null && connectedHere && !unread ? (
            <DialogDescription asChild>
              <div className="text-ui">
                <Health state="ready">{`Connected · ${catalog.length} ${catalog.length === 1 ? "tool" : "tools"}`}</Health>
              </div>
            </DialogDescription>
          ) : null}
          {saved === null || health === null ? null : (
            <DialogDescription asChild>
              <div className="flex flex-wrap items-center gap-x-2 text-ui text-muted-foreground">
                <Health state={connectedHere && !unread ? "ready" : health.state}>
                  {connectedHere && !unread ? "Connected" : health.label}
                </Health>
                {connectedHere && !unread ? null : (
                  <>
                    <span aria-hidden>·</span>
                    <span>{refreshedLabel(saved)}</span>
                  </>
                )}
                {provenance === null ? null : (
                  <>
                    <span aria-hidden>·</span>
                    <span>{provenance}</span>
                  </>
                )}
              </div>
            </DialogDescription>
          )}
          {health?.fix === "retry" && !connectedHere ? (
            <p className="text-ui text-destructive">{health.detail}</p>
          ) : null}
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
          <section aria-label="Connection" className="flex shrink-0 flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-label text-muted-foreground uppercase">Connection</h3>
              {editing ? null : (
                <Button
                  size="xs"
                  variant="ghost"
                  aria-label={`Edit ${draft.name || suggested} connection`}
                  disabled={busy !== null}
                  onClick={() => editConnection("endpoint")}
                >
                  <PencilSimpleIcon />
                  Edit
                </Button>
              )}
            </div>
            {!editing ? (
              <ConnectionSummary
                transport={applyCredentials(transport, credentials).transport}
                // Sign-in and stored secrets are the SAVED server's; a changed
                // connection has neither until it is saved.
                access={saved !== null && !connectionChanged ? access : undefined}
                waiting={saved !== null && signingIn === saved.id}
                busy={busy !== null || (signingIn !== null && signingIn !== saved?.id)}
                onSignIn={() => void savedAct(onSignIn)}
                onCancel={() => void savedAct(onCancelSignIn)}
                onSignOut={() => void savedAct(onSignOut)}
                onFix={() => editConnection(missingField(missing[0] ?? ""))}
              />
            ) : (
              <ConnectionFields
                onSubmit={() => {
                  if (busy === null && ready) void connect();
                }}
                draft={draft}
                focusField={fieldFocus}
                locked={busy !== null}
                suggested={suggested}
                credentials={credentials}
                stored={saved === null ? new Set<string>() : storedSlots(saved, access)}

                onName={(name) => changeConnection((current) => ({ ...current, name }))}
                onTransport={setTransport}
                onTransportField={(next) =>
                  changeConnection((current) => ({ ...current, transport: next }))
                }
                onCredentials={changeCredentials}
              />
            )}
            {editing ? (
              <ConnectResult
                busy={busy}
                discovered={connectedHere && !unread}
                count={catalog.length}
                blocked={blocked}
                waiting={waitingForSignIn}
              />
            ) : null}
          </section>

          {showTools ? (
            <section aria-label="Tools" className="flex min-h-72 flex-1 flex-col gap-2">
              <h3 className="text-label text-muted-foreground uppercase">Tools for new Sessions</h3>
              <McpToolPicker
                serverName={draft.name.trim().length > 0 ? draft.name : suggested}
                tools={catalog}
                selected={selected}
                disabled={busy !== null}
                focusFilter={filterFocus}
                onChange={setSelected}
              />
            </section>
          ) : null}
        </div>

        <DialogFooter className="shrink-0 flex-col items-stretch gap-2 border-t border-border/50 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 flex-1">
            {error === null ? (
              // Not a live region: the picker's own count already announces
              // each click, and two at once is noise.
              <span className="text-ui text-muted-foreground">
                {saved !== null && toolChanges > 0
                  ? `${toolChanges} tool ${toolChanges === 1 ? "change" : "changes"} not saved`
                  : null}
              </span>
            ) : (
              <p role="alert" className="text-ui text-destructive">
                {error}
              </p>
            )}
          </div>
          <div className="flex shrink-0 justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={busy === "save"}
              onClick={() => void close()}
            >
              Cancel
            </Button>
            {needsSignIn ? (
              waitingForSignIn ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void cancelDraftSignIn().then(setError)}
                >
                  <XIcon />
                  Cancel sign-in
                </Button>
              ) : (
                <Button size="sm" disabled={busy !== null} onClick={() => void signInDraft()}>
                  <SignInIcon />
                  Sign in
                </Button>
              )
            ) : editing ? (
              <Button size="sm" disabled={busy !== null || !ready} onClick={() => void connect()}>
                {busy === "connect" ? "Connecting…" : "Connect"}
              </Button>
            ) : (
              <Button size="sm" disabled={!canSave} onClick={() => void save()}>
                {busy === "save" ? "Saving…" : saveLabel}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A connection, read-only: what it is, how it signs in, what it carries. */
function ConnectionSummary({
  transport,
  access,
  waiting,
  busy,
  onSignIn,
  onCancel,
  onSignOut,
  onFix,
}: {
  transport: McpTransportConfig;
  access: McpServerAccess | undefined;
  waiting: boolean;
  busy: boolean;
  onSignIn: () => void;
  onCancel: () => void;
  onSignOut: () => void;
  onFix: () => void;
}) {
  const credentials = credentialNames(transport);
  const missing = access?.missingSecrets ?? [];
  const where = transport.type === "stdio" ? endpointLabel(transport) : transport.url;
  return (
    <div className="flex flex-col gap-1 rounded-lg bg-muted/30 px-4 py-2">
      <div className="flex min-w-0 items-center gap-2 text-ui">
        <span className="shrink-0 text-muted-foreground">
          {transport.type === "stdio" ? "Local" : "Remote"}
        </span>
        <code className="min-w-0 truncate font-mono" title={where}>
          {where}
        </code>
      </div>
      {transport.type === "streamable-http" &&
      mcpServerUsesOAuth(transport.headers) &&
      access !== undefined &&
      access.signIn !== "not-applicable" ? (
        <div className="flex items-center justify-between gap-2 text-ui">
          <span className="text-muted-foreground">
            {waiting
              ? "Waiting for the browser…"
              : access.signIn === "signed-in"
                ? "Signed in with OAuth"
                : access.signIn === "needs-sign-in"
                  ? "Needs sign-in"
                  : "Not signed in"}
          </span>
          {waiting ? (
            <Button size="xs" variant="outline" onClick={onCancel}>
              <XIcon />
              Cancel sign-in
            </Button>
          ) : access.signIn === "signed-in" ? (
            <Button size="xs" variant="ghost" disabled={busy} onClick={onSignOut}>
              <SignOutIcon />
              Sign out
            </Button>
          ) : (
            <Button size="xs" variant="outline" disabled={busy} onClick={onSignIn}>
              <SignInIcon />
              Sign in
            </Button>
          )}
        </div>
      ) : null}
      {credentials === null ? null : (
        <span className="truncate text-ui text-muted-foreground">{credentials}</span>
      )}
      {missing.length === 0 ? null : (
        <div className="flex items-center justify-between gap-2 text-ui">
          <span className="text-destructive">Missing {missing.join(", ")}</span>
          <Button size="xs" variant="outline" disabled={busy} onClick={onFix}>
            Add credential
          </Button>
        </div>
      )}
    </div>
  );
}

/** The connection's fields, for a new server or a saved one being edited. */
function ConnectionFields({
  onSubmit,
  draft,
  focusField,
  locked,
  suggested,
  credentials,
  stored,
  onName,
  onTransport,
  onTransportField,
  onCredentials,
}: {
  /** Enter in a field connects, as the button beside it would. */
  onSubmit: () => void;
  draft: McpServerDraft;
  /**
   * Where the caret goes when these fields appear: `"endpoint"` for the URL
   * or executable, or a field's accessible name (matched without case).
   */
  focusField: string | null;
  /**
   * Nothing here can change while a connection, a sign-in or a save is in
   * flight: the answer that comes back must be for the draft that was sent.
   */
  locked: boolean;
  suggested: string;
  credentials: EditorCredentials;
  stored: ReadonlySet<string>;

  onName: (name: string) => void;
  onTransport: (type: McpTransportConfig["type"]) => void;
  onTransportField: (transport: McpTransportConfig) => void;
  onCredentials: (next: EditorCredentials) => void;
}) {
  const transport = draft.transport;
  const root = React.useRef<HTMLFieldSetElement>(null);
  // Here rather than in the dialog: these fields render inside the dialog's
  // portal, which does not exist yet when the dialog's own effects run.
  React.useEffect(() => {
    if (focusField === null) return;
    const fields = [...(root.current?.querySelectorAll<HTMLInputElement>("input") ?? [])];
    const field =
      focusField === "endpoint"
        ? fields.find((input) => input.id === "mcp-url" || input.id === "mcp-command")
        : fields.find(
            (input) => input.getAttribute("aria-label")?.toLowerCase() === focusField.toLowerCase(),
          );
    field?.focus();
  }, [focusField, transport.type]);
  const name = (
    <div className="grid gap-1 sm:col-span-2">
      <label className="text-ui" htmlFor="mcp-server-name">
        Name (optional)
      </label>
      <Input
        id="mcp-server-name"
        className="sm:max-w-80"
        value={draft.name}
        placeholder={suggested.length > 0 ? suggested : "Server name"}
        onChange={(event) => onName(event.target.value)}
      />
    </div>
  );
  return (
    // Enter in a one-line field connects. Not a <form>: every Button here is a
    // plain <button>, which inside a form would submit it on a click. A
    // fieldset, so `locked` disables every control in it at once.
    <fieldset
      ref={root}
      disabled={locked}
      className="grid min-w-0 gap-4 sm:grid-cols-2"
      onKeyDown={(event) => {
        if (
          event.key === "Enter" &&
          !event.nativeEvent.isComposing &&
          event.target instanceof HTMLInputElement
        ) {
          event.preventDefault();
          onSubmit();
        }
      }}
    >
      <div className="grid gap-1 sm:col-span-2">
        <span className="text-ui">Location</span>
        <Segmented<McpTransportConfig["type"]>
          ariaLabel="Server location"
          value={transport.type}
          options={TRANSPORTS}
          onChange={onTransport}
        />
      </div>
      {transport.type === "stdio" ? (
        <>
          <div className="grid gap-1">
            <label className="text-ui" htmlFor="mcp-command">
              Executable
            </label>
            <Input
              id="mcp-command"
              className="font-mono"
              value={transport.command}
              placeholder="npx"
              onChange={(event) => onTransportField({ ...transport, command: event.target.value })}
            />
          </div>
          <div className="grid gap-1">
            <label className="text-ui" htmlFor="mcp-args">
              Arguments
            </label>
            <Textarea
              id="mcp-args"
              className="font-mono"
              placeholder="One per line"
              value={transport.args.join("\n")}
              onChange={(event) =>
                onTransportField({ ...transport, args: event.target.value.split("\n") })
              }
            />
          </div>
        </>
      ) : (
        <div className="grid gap-1 sm:col-span-2">
          <label className="text-ui" htmlFor="mcp-url">
            Server URL
          </label>
          <Input
            id="mcp-url"
            type="url"
            className="font-mono"
            value={transport.url}
            placeholder="https://example.com/mcp"
            onChange={(event) => onTransportField({ ...transport, url: event.target.value })}
          />
        </div>
      )}
      {name}
      <McpCredentialsEditor
        transport={transport.type}
        {...(transport.type === "streamable-http" ? { url: transport.url } : {})}
        credentials={credentials}
        stored={stored}
        onChange={onCredentials}
      />
    </fieldset>
  );
}

/** What the last connection attempt found; its next action lives in the footer. */
function ConnectResult({
  busy,
  discovered,
  count,
  blocked,
  waiting,
}: {
  busy: null | "connect" | "save" | "sign-in";
  discovered: boolean;
  count: number;
  blocked: McpConnectionBlock | null;
  waiting: boolean;
}) {
  if (busy === null && !waiting && blocked === null && !discovered) return null;
  return (
    <div className="text-ui text-muted-foreground" role="status">
      {busy === "connect" ? (
        "Connecting…"
      ) : waiting ? (
        <Health state="starting">Waiting for the browser…</Health>
      ) : blocked?.kind === "sign-in" ? (
        <Health state="waiting">This server needs you to sign in</Health>
      ) : blocked?.kind === "credential" ? (
        <Health state="waiting">
          {blocked.rejected === true
            ? `The server refused ${blocked.missing.join(", ")}`
            : `Missing ${blocked.missing.join(", ")}`}
        </Health>
      ) : discovered ? (
        <Health state="ready">{`Connected · ${count} ${count === 1 ? "tool" : "tools"}`}</Health>
      ) : null}
    </div>
  );
}
