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
 *  3. **Save.** Nothing is written until then. A change to the connection is
 *     read again before it is saved, so what is saved is what answered; a
 *     change to tools alone is written without touching the network.
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
  { key: "streamable-http", label: "Remote (HTTP)" },
  { key: "stdio", label: "Local (stdio)" },
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
  onSignIn: (serverId: string) => Promise<void>;
  onCancelSignIn: (serverId: string) => Promise<void>;
  onSignOut: (serverId: string) => Promise<void>;
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
  /** The connection changed since the tool list beside it was read. */
  const [unread, setUnread] = React.useState(false);
  /** A tool list has been read for this connection (always, for a saved server). */
  const [discovered, setDiscovered] = React.useState(saved !== null);
  /** This dialog itself reached the server: only then does it say "Connected". */
  const [connectedHere, setConnectedHere] = React.useState(false);
  const [busy, setBusy] = React.useState<null | "connect" | "save" | "sign-in">(null);
  const [error, setError] = React.useState<string | null>(null);
  const [blocked, setBlocked] = React.useState<McpConnectionBlock | null>(null);
  /** The draft id a sign-in is waiting on the browser for. */
  const [draftSigningIn, setDraftSigningIn] = React.useState<string | null>(null);

  const transport = draft.transport;
  const suggested = suggestedServerName(transport);

  // Opened to fix a missing credential: the caret goes straight to the first
  // value that is missing, which is the one thing the person came to type.
  // Read once, on open: a later change to what is missing is not a reason to
  // move the caret.
  const [firstMissing] = React.useState(() =>
    target.kind === "edit" && target.section === "connection"
      ? access?.missingSecrets[0]
      : undefined,
  );
  // Main reports a missing slot as its label, `header Authorization`; the
  // editor names that slot's field `Authorization value`.
  const focusField =
    firstMissing === undefined
      ? null
      : `${firstMissing.slice(firstMissing.indexOf(" ") + 1)} value`;
  const toolChanges = changedTools(savedSelection, selected);
  const dirty = saved === null || unread || toolChanges > 0;
  const ready =
    (transport.type === "stdio" ? transport.command.trim() : transport.url.trim()).length > 0;

  function changeConnection(update: (current: McpServerDraft) => McpServerDraft): void {
    setDraft(update);
    setUnread(true);
    setBlocked(null);
  }

  function changeCredentials(next: EditorCredentials): void {
    setCredentials(next);
    setUnread(true);
    setBlocked(null);
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
   * Read the tool list for the connection as it stands. Returns the catalog,
   * or `null` when the server refused or could not be reached — with what it
   * is waiting on, if a person can fix it.
   */
  async function connect(): Promise<readonly McpCatalogTool[] | null> {
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
    setError(null);
    setBlocked(null);
    setCatalog(result.catalog);
    // A tool still offered keeps its choice; a new one starts off.
    const offered = new Set(result.catalog.filter(isSelectable).map((tool) => tool.name));
    setSelected((current) => new Set([...current].filter((name) => offered.has(name))));
    setDiscovered(true);
    setConnectedHere(true);
    setUnread(false);
    // What answered is now the connection: its fields fold into the summary
    // and the tools get the room.
    setEditing(false);
    return result.catalog;
  }

  async function save(): Promise<void> {
    setError(null);
    if (saved !== null && !unread) {
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
    let tools = catalog;
    if (unread || !discovered) {
      const read = await connect();
      if (read === null) return;
      tools = read;
    }
    const offered = new Set(tools.filter(isSelectable).map((tool) => tool.name));
    setBusy("save");
    const { server, secrets } = prepared();
    const result = await window.api.mcp.save({
      projectId: project.id,
      server,
      enabledTools: [...selected].filter((name) => offered.has(name)),
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
    // Blocked on the sign-in, so straight on to the tools it was hiding.
    await connect();
  }

  async function cancelDraftSignIn(): Promise<void> {
    if (draftSigningIn === null) return;
    const result = await window.api.mcp.cancelSignIn({
      projectId: project.id,
      serverId: draftSigningIn,
    });
    if (!result.ok) setError(result.error);
  }

  /**
   * Close without saving. A draft that was never saved may have been signed
   * in to; whatever that stored is forgotten with it.
   */
  async function close(): Promise<void> {
    if (draftSigningIn !== null) await cancelDraftSignIn();
    onClose();
    if (saved !== null || draft.id.length === 0) return;
    const result = await window.api.mcp.discardDraft({ projectId: project.id, serverId: draft.id });
    if (!result.ok) setError(result.error);
  }

  const health = saved === null ? null : serverHealth(saved, access, signingIn === saved.id);
  const provenance = saved === null ? null : provenanceLine(saved.provenance);
  const title = saved === null ? "Add MCP server" : saved.name;
  const showTools = catalog.length > 0 || discovered;
  // A new server is added only once its tools have been read and chosen; a
  // saved one whose connection changed is read again as part of saving.
  const saveLabel = saved === null ? "Add server" : unread ? "Connect and save" : "Save";
  const canSave = busy === null && ready && (saved === null ? discovered && !unread : dirty);

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : void close())}>
      <DialogContent
        className={cn(
          "flex max-h-[88vh] flex-col gap-0 p-0 sm:max-w-3xl",
          showTools && "h-[min(46rem,88vh)]",
        )}
        // A half-made choice of forty tools is not lost to a stray click on
        // the scrim; Escape and Cancel still close it.
        onInteractOutside={(event) => {
          if (dirty) event.preventDefault();
        }}
        // Focus is placed by the fields and the picker themselves (the URL
        // for a new server, the filter for a saved one's tools), not by Radix
        // on the first button it finds.
        onOpenAutoFocus={(event) => {
          if (target.kind === "add" || target.section === "tools" || firstMissing !== undefined) {
            event.preventDefault();
          }
        }}
        // A new server has no status line until it connects, and nothing else
        // to describe it.
        {...(saved === null && !connectedHere ? { "aria-describedby": undefined } : {})}
      >
        <DialogHeader className="shrink-0 gap-1 border-b border-border/50 px-4 pt-4 pb-4">
          <div className="flex items-center gap-2 pr-8">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted/50 text-muted-foreground [&_svg]:size-4">
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
                <Health state={health.state}>{health.label}</Health>
                <span aria-hidden>·</span>
                <span>{refreshedLabel(saved)}</span>
                {provenance === null ? null : (
                  <>
                    <span aria-hidden>·</span>
                    <span>{provenance}</span>
                  </>
                )}
              </div>
            </DialogDescription>
          )}
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
                  onClick={() => setEditing(true)}
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
                access={saved !== null && !unread ? access : undefined}
                waiting={saved !== null && signingIn === saved.id}
                busy={busy !== null || (signingIn !== null && signingIn !== saved?.id)}
                onSignIn={() => saved !== null && void onSignIn(saved.id)}
                onCancel={() => saved !== null && void onCancelSignIn(saved.id)}
                onSignOut={() => saved !== null && void onSignOut(saved.id)}
                onFix={() => setEditing(true)}
              />
            ) : (
              <ConnectionFields
                onSubmit={() => {
                  if (busy === null && ready) void connect();
                }}
                draft={draft}
                focusField={focusField}
                suggested={suggested}
                credentials={credentials}
                stored={saved === null ? new Set<string>() : storedSlots(saved, access)}
                autoFocusName={target.kind === "add"}
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
                primary={!discovered || unread}
                busy={busy}
                ready={ready}
                discovered={connectedHere && !unread}
                count={catalog.length}
                blocked={blocked}
                waiting={draftSigningIn !== null}
                onConnect={() => void connect()}
                onSignIn={() => void signInDraft()}
                onCancelSignIn={() => void cancelDraftSignIn()}
              />
            ) : null}
          </section>

          {showTools ? (
            <section aria-label="Tools" className="flex min-h-72 flex-1 flex-col gap-2">
              <h3 className="text-label text-muted-foreground uppercase">Tools</h3>
              <McpToolPicker
                serverName={draft.name.trim().length > 0 ? draft.name : suggested}
                tools={catalog}
                selected={selected}
                disabled={busy !== null}
                focusFilter={target.kind === "add" || target.section === "tools"}
                onChange={setSelected}
              />
            </section>
          ) : null}
        </div>

        <DialogFooter className="shrink-0 items-center border-t border-border/50 px-4 py-4 sm:justify-between">
          <div className="min-w-0 flex-1">
            {error === null ? (
              <span className="text-ui text-muted-foreground" aria-live="polite">
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
          <div className="flex shrink-0 gap-2">
            <Button size="sm" variant="ghost" onClick={() => void close()}>
              Cancel
            </Button>
            <Button size="sm" disabled={!canSave} onClick={() => void save()}>
              {busy === "save" ? "Saving…" : saveLabel}
            </Button>
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
          {transport.type === "stdio" ? "Local (stdio)" : "Remote (HTTP)"}
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
  suggested,
  credentials,
  stored,
  autoFocusName,
  onName,
  onTransport,
  onTransportField,
  onCredentials,
}: {
  /** Enter in a field connects, as the button beside it would. */
  onSubmit: () => void;
  draft: McpServerDraft;
  /** The accessible name of a field to put the caret in when these fields appear. */
  focusField: string | null;
  suggested: string;
  credentials: EditorCredentials;
  stored: ReadonlySet<string>;
  autoFocusName: boolean;
  onName: (name: string) => void;
  onTransport: (type: McpTransportConfig["type"]) => void;
  onTransportField: (transport: McpTransportConfig) => void;
  onCredentials: (next: EditorCredentials) => void;
}) {
  const transport = draft.transport;
  const root = React.useRef<HTMLDivElement>(null);
  // Here rather than in the dialog: these fields render inside the dialog's
  // portal, which does not exist yet when the dialog's own effects run.
  React.useEffect(() => {
    if (focusField === null) return;
    root.current
      ?.querySelector<HTMLInputElement>(`input[aria-label="${CSS.escape(focusField)}"]`)
      ?.focus();
  }, [focusField]);
  const name = (
    <div className="grid gap-1 sm:col-span-2">
      <label className="text-ui" htmlFor="mcp-server-name">
        Name
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
    // plain <button>, which inside a form would submit it on a click.
    <div
      ref={root}
      className="grid gap-4 sm:grid-cols-2"
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
        <span className="text-ui">Transport</span>
        <Segmented<McpTransportConfig["type"]>
          ariaLabel="Transport"
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
              autoFocus={autoFocusName}
              value={transport.command}
              placeholder="npx"
              onChange={(event) => onTransportField({ ...transport, command: event.target.value })}
            />
          </div>
          <div className="grid gap-1">
            <label className="text-ui" htmlFor="mcp-args">
              Arguments (one per line)
            </label>
            <Textarea
              id="mcp-args"
              className="font-mono"
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
            Endpoint URL
          </label>
          <Input
            id="mcp-url"
            type="url"
            className="font-mono"
            autoFocus={autoFocusName}
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
    </div>
  );
}

/** *Connect*, and what the last attempt found: the tools, or the one thing in the way. */
function ConnectResult({
  primary,
  busy,
  ready,
  discovered,
  count,
  blocked,
  waiting,
  onConnect,
  onSignIn,
  onCancelSignIn,
}: {
  /** Connecting is the next step (nothing read yet, or the connection changed). */
  primary: boolean;
  busy: null | "connect" | "save" | "sign-in";
  ready: boolean;
  discovered: boolean;
  count: number;
  blocked: McpConnectionBlock | null;
  waiting: boolean;
  onConnect: () => void;
  onSignIn: () => void;
  onCancelSignIn: () => void;
}) {
  return (
    <div className="flex min-h-7 flex-wrap items-center justify-end gap-2">
      <span className="mr-auto text-ui text-muted-foreground" aria-live="polite">
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
      </span>
      {blocked?.kind === "sign-in" ? (
        waiting ? (
          <Button size="sm" variant="outline" onClick={onCancelSignIn}>
            <XIcon />
            Cancel sign-in
          </Button>
        ) : (
          <Button size="sm" disabled={busy !== null} onClick={onSignIn}>
            <SignInIcon />
            Sign in
          </Button>
        )
      ) : null}
      <Button
        size="sm"
        variant={primary && blocked?.kind !== "sign-in" ? "default" : "outline"}
        disabled={busy !== null || !ready}
        onClick={onConnect}
      >
        {discovered ? "Connect again" : "Connect"}
      </Button>
    </div>
  );
}
