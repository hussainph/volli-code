/**
 * Configure → MCP Servers: app-owned, per-project transport and tool settings.
 *
 * THE SHAPE (VC-470's redesign, after a survey of how Claude, ChatGPT, Codex,
 * Cursor, VS Code, Zed, Goose, Warp, Cline and others do it). The pane is a
 * list of servers and an audit log. Everything about one server — its
 * connection, its sign-in, its tools — opens as one dialog
 * (`mcp-server-dialog.tsx`), and its tools are chosen in one picker
 * (`mcp-tool-picker.tsx`) with search, select all and read-only grouping.
 *
 * A SERVER ROW says what a person scans for and nothing they must open to
 * find: the server, where it lives, how many of its tools are on, how fresh
 * that list is, where it came from, whether it works — and, when it does not,
 * the one action that fixes it (Sign in, Add credential, Retry) beside the
 * word that says so. The switch and a menu of the rest (tools, connection,
 * refresh, sign out, remove) close the row. A row is `ui/list-row.tsx`'s
 * two-line row rather than a `DataTable` line: a server's status carries an
 * action and its detail a sentence, which a 36px table cell cannot hold
 * without clipping exactly the part that says what is wrong.
 *
 * TWO LAWS THIS PANE LEARNED THE HARD WAY (VC-397), still kept:
 *
 *  1. **A pane whose sections FOLLOW a collection does not `fill`.** Every
 *     section sits in ordinary block flow and each unbounded list owns a
 *     bounded scroll box, so nothing can overlap at any viewport size or
 *     catalog length.
 *  2. **Detail is asked for, not broadcast.** A 34-tool catalog with a
 *     paragraph per tool is never drawn on the page: the row carries the
 *     counts, and the descriptions live in the dialog, one line each until a
 *     person opens a tool.
 */
import * as React from "react";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { ClockCounterClockwiseIcon } from "@phosphor-icons/react/dist/csr/ClockCounterClockwise";
import { DotsThreeIcon } from "@phosphor-icons/react/dist/csr/DotsThree";
import { GearSixIcon } from "@phosphor-icons/react/dist/csr/GearSix";
import { ListChecksIcon } from "@phosphor-icons/react/dist/csr/ListChecks";
import { PlugsConnectedIcon } from "@phosphor-icons/react/dist/csr/PlugsConnected";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { SignInIcon } from "@phosphor-icons/react/dist/csr/SignIn";
import { SignOutIcon } from "@phosphor-icons/react/dist/csr/SignOut";
import { TrashIcon } from "@phosphor-icons/react/dist/csr/Trash";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import type { McpOperationRecord, McpServerAccess, McpServerRecord, Project } from "@volli/shared";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@renderer/components/ui/alert-dialog";
import { Button } from "@renderer/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@renderer/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { ListRow } from "@renderer/components/ui/list-row";
import { Switch } from "@renderer/components/ui/switch";
import { Empty, Health, PrefSection, SectionAction } from "@renderer/components/settings/kit";
import { relativeTime } from "@renderer/lib/relative-time";
import { cn } from "@renderer/lib/utils";

import {
  McpServerDialog,
  provenanceLine,
  refreshedLabel,
  signsIn,
  TransportIcon,
  type McpServerDialogTarget,
} from "./mcp-server-dialog";
import { endpointLabel, enabledToolNames, isSelectable, serverHealth } from "./mcp-tools-model";

/** A list long enough to bury the page gets its own scroll box instead. */
const SCROLL_BOX = "max-h-96 overflow-y-auto";

/**
 * The server list's own cap: about eight two-line rows. A project rarely has
 * more, and a box that scrolls at five is a list a person scrolls for nothing.
 */
const SERVER_BOX = "max-h-[40rem] overflow-y-auto";

/**
 * Who asked for one recorded operation. A Session id is not a name a person
 * recognises, but "an agent Session" versus "someone here" is the distinction
 * that decides what to do about a row.
 */
function operationActor(entry: McpOperationRecord): string {
  return entry.sessionId === null ? "in Settings" : "by an agent Session";
}

function toolCountLabel(server: McpServerRecord): string {
  const total = server.catalog.filter(isSelectable).length;
  if (server.catalog.length === 0) return "No tools discovered";
  return `${enabledToolNames(server.catalog).length} of ${total} tools on`;
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
  const [servers, setServers] = React.useState<readonly McpServerRecord[]>([]);
  const [operations, setOperations] = React.useState<readonly McpOperationRecord[]>([]);
  const [loading, setLoading] = React.useState(false);
  /**
   * The servers with an action running. Per server, so one row finishing
   * never frees another row that is still waiting on its own.
   */
  const [busy, setBusy] = React.useState<ReadonlySet<string>>(new Set());
  const [error, setError] = React.useState<string | null>(null);
  const [access, setAccess] = React.useState<Readonly<Record<string, McpServerAccess>>>({});
  /** The server a sign-in is waiting on the browser for. */
  const [signingIn, setSigningIn] = React.useState<string | null>(null);
  const [dialog, setDialog] = React.useState<McpServerDialogTarget | null>(null);
  /**
   * The server a removal is being confirmed for. Kept after the confirmation
   * closes, so its title does not blank to "Remove ?" while it animates out.
   */
  const [removing, setRemoving] = React.useState<McpServerRecord | null>(null);
  const [confirming, setConfirming] = React.useState(false);

  function hold(serverId: string, holding: boolean): void {
    setBusy((current) => {
      const next = new Set(current);
      if (holding) next.add(serverId);
      else next.delete(serverId);
      return next;
    });
  }

  const load = React.useCallback(async () => {
    setLoading(true);
    const result = await window.api.mcp.list({ projectId: project.id });
    setLoading(false);
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
    setOperations(result.operations);
  }, [project.id]);

  /** The open dialog, kept on the CURRENT record so a save or sign-in under it shows. */
  const dialogTarget: McpServerDialogTarget | null =
    dialog?.kind === "edit"
      ? {
          ...dialog,
          server: servers.find((server) => server.id === dialog.server.id) ?? dialog.server,
        }
      : dialog;

  /**
   * Sign in in the browser. The row (or dialog) waits for the redirect; Cancel
   * stops it. These three return what went wrong rather than saying it, so
   * the surface that asked — a row, or the dialog over it — says it where the
   * person is looking.
   */
  async function signIn(serverId: string): Promise<string | null> {
    setSigningIn(serverId);
    const result = await window.api.mcp.signIn({ projectId: project.id, serverId });
    setSigningIn(null);
    await refreshAccess();
    return result.ok || result.cancelled ? null : result.error;
  }

  async function cancelSignIn(serverId: string): Promise<string | null> {
    const result = await window.api.mcp.cancelSignIn({ projectId: project.id, serverId });
    return result.ok ? null : result.error;
  }

  async function signOut(serverId: string): Promise<string | null> {
    hold(serverId, true);
    const result = await window.api.mcp.signOut({ projectId: project.id, serverId });
    hold(serverId, false);
    if (!result.ok) return result.error;
    await refreshAccess();
    return null;
  }

  async function refresh(server: McpServerRecord): Promise<void> {
    hold(server.id, true);
    const result = await window.api.mcp.refresh({ projectId: project.id, serverId: server.id });
    hold(server.id, false);
    if (result.server !== undefined)
      setServers((current) => replaceServer(current, result.server!));
    setError(result.ok ? null : result.error);
    await refreshAccess();
  }

  async function toggleServer(server: McpServerRecord, enabled: boolean): Promise<void> {
    // The switch moves at once and moves back if main refuses: a toggle that
    // waits on a round trip before it moves reads as a toggle that missed.
    // Only `enabled` moves back, on whatever the record is by then.
    const flip = (to: boolean) => (current: readonly McpServerRecord[]) =>
      current.map((candidate) =>
        candidate.id === server.id ? Object.assign({}, candidate, { enabled: to }) : candidate,
      );
    setServers(flip(enabled));
    hold(server.id, true);
    const result = await window.api.mcp.setEnabled({
      projectId: project.id,
      serverId: server.id,
      enabled,
    });
    hold(server.id, false);
    if (result.ok) setServers((current) => replaceServer(current, result.server));
    else setServers(flip(!enabled));
    setError(result.ok ? null : result.error);
  }

  async function remove(server: McpServerRecord): Promise<void> {
    hold(server.id, true);
    const result = await window.api.mcp.remove({ projectId: project.id, serverId: server.id });
    hold(server.id, false);
    if (result.ok) {
      setServers((current) => current.filter((candidate) => candidate.id !== server.id));
      await refreshAccess();
    }
    setError(result.ok ? null : result.error);
  }

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
        action={
          <SectionAction
            label="Add server"
            icon={PlusIcon}
            onAct={() => {
              setError(null);
              setDialog({ kind: "add" });
            }}
          />
        }
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
            className="mb-2 rounded-md bg-destructive/10 px-4 py-2 text-ui text-destructive"
          >
            {error}
          </p>
        )}
        {servers.length === 0 ? (
          <Empty>{loading ? "Loading MCP servers…" : "No MCP servers yet."}</Empty>
        ) : (
          <ul aria-label="MCP servers" className={cn("-mx-2 flex flex-col", SERVER_BOX)}>
            {servers.map((server) => (
              <li key={server.id}>
                <ServerRow
                  server={server}
                  access={access[server.id]}
                  busy={busy.has(server.id)}
                  signingIn={signingIn}
                  onOpen={(section) => {
                    setError(null);
                    setDialog({ kind: "edit", server, section });
                  }}
                  onToggle={(enabled) => void toggleServer(server, enabled)}
                  onSignIn={() => void signIn(server.id).then(setError)}
                  onCancelSignIn={() => void cancelSignIn(server.id).then(setError)}
                  onSignOut={() => void signOut(server.id).then(setError)}
                  onRefresh={() => void refresh(server)}
                  onRemove={() => {
                    setRemoving(server);
                    setConfirming(true);
                  }}
                />
              </li>
            ))}
          </ul>
        )}
      </PrefSection>

      {operations.length === 0 ? null : (
        <PrefSection title="Recent activity" icon={ClockCounterClockwiseIcon}>
          {/*
            Where an install an AGENT performed becomes findable by a person.
            The audit row is the only trace of a removal once the server is gone,
            and the only trace of a failed first install at all — that one writes
            no server row, so without this list its recovery line exists nowhere
            a person looks. Fifty of these ride in `MCP_OPERATION_HISTORY_LIMIT`,
            so the list is bounded and the detail is asked for.
          */}
          <ul className={cn("flex flex-col", SCROLL_BOX)}>
            {operations.map((entry) => (
              <ActivityRow key={entry.id} entry={entry} />
            ))}
          </ul>
        </PrefSection>
      )}

      {dialogTarget === null ? null : (
        <McpServerDialog
          key={dialogTarget.kind === "edit" ? dialogTarget.server.id : "add"}
          project={project}
          target={dialogTarget}
          access={dialogTarget.kind === "edit" ? access[dialogTarget.server.id] : undefined}
          signingIn={signingIn}
          onClose={() => setDialog(null)}
          onSaved={(server) => {
            setServers((current) => replaceServer(current, server));
            setDialog(null);
            void refreshAccess();
          }}
          onSignIn={signIn}
          onCancelSignIn={cancelSignIn}
          onSignOut={signOut}
          onAccessChanged={refreshAccess}
        />
      )}

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              New Sessions stop getting its tools, and any credentials or sign-in stored for it are
              deleted. Sessions already running keep the tools they started with.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (removing !== null) void remove(removing);
                setConfirming(false);
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * One server: what it is and whether it works on the left, its fix, switch
 * and menu on the right. Clicking the row opens its tools.
 */
function ServerRow({
  server,
  access,
  busy,
  signingIn,
  onOpen,
  onToggle,
  onSignIn,
  onCancelSignIn,
  onSignOut,
  onRefresh,
  onRemove,
}: {
  server: McpServerRecord;
  access: McpServerAccess | undefined;
  busy: boolean;
  signingIn: string | null;
  onOpen: (section: "tools" | "connection") => void;
  onToggle: (enabled: boolean) => void;
  onSignIn: () => void;
  onCancelSignIn: () => void;
  onSignOut: () => void;
  onRefresh: () => void;
  onRemove: () => void;
}) {
  const described = React.useId();
  const health = serverHealth(server, access, signingIn === server.id);
  const provenance = provenanceLine(server.provenance);
  const otherSignIn = signingIn !== null && signingIn !== server.id;
  return (
    <ListRow
      density="two-line"
      // The name is what the row opens; its status, counts and anything wrong
      // are read after it rather than hidden by the label.
      aria-label={`Open ${server.name}`}
      aria-describedby={`${described}-status ${described}-detail`}
      onActivate={() => onOpen(health.fix === "credentials" ? "connection" : "tools")}
      leading={
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/50 text-muted-foreground [&_svg]:size-4">
          <TransportIcon type={server.transport.type} />
        </span>
      }
      primary={<span className="min-w-0 truncate text-ui font-medium">{server.name}</span>}
      secondary={
        <span id={`${described}-detail`} className="block min-w-0 text-ui text-muted-foreground">
          <span className="block truncate">
            {endpointLabel(server.transport)}
            {" · "}
            {toolCountLabel(server)}
            {" · "}
            {refreshedLabel(server)}
          </span>
          {provenance === null ? null : <span className="block truncate">{provenance}</span>}
          {health.detail === null ? null : (
            <span className="block truncate text-destructive" title={health.detail}>
              {health.detail}
            </span>
          )}
        </span>
      }
      trailing={
        <span id={`${described}-status`} className="shrink-0">
          <Health state={health.state}>{health.label}</Health>
        </span>
      }
      actions={
        <div className="flex shrink-0 items-center gap-2">
          {health.fix === "sign-in" ? (
            <Button size="xs" variant="outline" disabled={busy || otherSignIn} onClick={onSignIn}>
              <SignInIcon />
              Sign in
            </Button>
          ) : health.fix === "cancel-sign-in" ? (
            <Button size="xs" variant="outline" onClick={onCancelSignIn}>
              <XIcon />
              Cancel
            </Button>
          ) : health.fix === "credentials" ? (
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => onOpen("connection")}
            >
              Add credential
            </Button>
          ) : health.fix === "retry" ? (
            <Button size="xs" variant="outline" disabled={busy} onClick={onRefresh}>
              <ArrowClockwiseIcon />
              Retry
            </Button>
          ) : null}
          <Switch
            aria-label={`${server.name} enabled`}
            checked={server.enabled}
            disabled={busy}
            onCheckedChange={onToggle}
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon-xs" variant="ghost" aria-label={`More for ${server.name}`}>
                <DotsThreeIcon weight="bold" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => onOpen("tools")}>
                <ListChecksIcon />
                Choose tools
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onOpen("connection")}>
                <GearSixIcon />
                Edit connection
              </DropdownMenuItem>
              <DropdownMenuItem disabled={busy} onSelect={onRefresh}>
                <ArrowClockwiseIcon />
                Refresh tools
              </DropdownMenuItem>
              {signsIn(server) && access?.signIn === "signed-in" ? (
                <DropdownMenuItem disabled={busy} onSelect={onSignOut}>
                  <SignOutIcon />
                  Sign out
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" disabled={busy} onSelect={onRemove}>
                <TrashIcon />
                Remove
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      }
    />
  );
}

/** The caret every disclosure on this pane turns. */
function DisclosureCaret({ open }: { open: boolean }) {
  return <CaretDownIcon aria-hidden className={cn("transition-transform", open && "rotate-180")} />;
}

/**
 * One recorded operation: what happened and who asked, with its detail behind a
 * disclosure. A removal's detail records the whole transport it destroyed,
 * which is precious and long enough that fifty of them are the page.
 */
function ActivityRow({ entry }: { entry: McpOperationRecord }) {
  const [open, setOpen] = React.useState(false);

  return (
    <li className="border-t border-border/50 py-2 first:border-t-0 first:pt-0">
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex items-start justify-between gap-4">
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
