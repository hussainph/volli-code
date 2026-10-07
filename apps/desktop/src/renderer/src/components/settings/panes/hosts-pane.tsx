/**
 * Settings → Hosts (VC-700 PR 3; VC-615 flow 7, ported from the lab's
 * `#host-manage`): the hosts this Mac knows, and one host's page — its name
 * (this Mac's label for it), its facts, its projects, the devices paired to
 * it, and Forget.
 *
 * Built from the settings kit over `ui/list-row.tsx`, as the lab was. The
 * connection state comes from VC-576's store (never re-drawn here: the chip,
 * the switcher and the Island own it); the registry's facts from the
 * remote-hosts store; the paired devices are read from the host over SSH
 * when its page opens, never cached. Forget is the one irreversible action,
 * so it is the one confirm. Revoking another device is VC-575's (pairing),
 * and the lab's "Pair a phone…" with it.
 *
 * Shown only with `cloud` on: the category does not exist otherwise.
 */
import * as React from "react";
import { AnimatePresence, motion } from "motion/react";
import { CaretLeftIcon } from "@phosphor-icons/react/dist/csr/CaretLeft";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { CopyIcon } from "@phosphor-icons/react/dist/csr/Copy";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { DevicesIcon } from "@phosphor-icons/react/dist/csr/Devices";
import { KeyIcon } from "@phosphor-icons/react/dist/csr/Key";
import { DotsThreeIcon } from "@phosphor-icons/react/dist/csr/DotsThree";
import { FolderSimpleIcon } from "@phosphor-icons/react/dist/csr/FolderSimple";
import { HardDrivesIcon } from "@phosphor-icons/react/dist/csr/HardDrives";
import { LaptopIcon } from "@phosphor-icons/react/dist/csr/Laptop";
import { PencilSimpleIcon } from "@phosphor-icons/react/dist/csr/PencilSimple";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { TrashIcon } from "@phosphor-icons/react/dist/csr/Trash";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import type { RemoteHost, RemoteHostDevice } from "@volli/shared";
import { toast } from "sonner";

import { openAddHostSheet } from "@renderer/components/hosts/host-entry";
import { useHostSignInSheet } from "@renderer/components/hosts/sign-ins/remote-host-sign-in-source";
import { EASE_OUT, HostGlyph, SwapText } from "@renderer/components/hosts/host-parts";
import { hostBadge } from "@renderer/components/hosts/host-surface-model";
import {
  AsyncSection,
  CONTROL_W,
  Empty,
  Health,
  ItemRow,
  PrefRow,
  PrefSection,
  SectionAction,
  SectionIconAction,
  type AsyncState,
} from "@renderer/components/settings/kit";
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
import { Badge } from "@renderer/components/ui/badge";
import { Button } from "@renderer/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { InlineRename } from "@renderer/components/ui/inline-rename";
import { ListRow } from "@renderer/components/ui/list-row";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { toastError } from "@renderer/lib/toast";
import { cn } from "@renderer/lib/utils";
import {
  projectCounts,
  THIS_MAC_HOST_ID,
  useHostConnectionStore,
  type HostRecord,
} from "@renderer/stores/host-connection";
import { useProjectsStore } from "@renderer/stores/projects";
import { useRemoteBoardAvailabilityStore } from "@renderer/stores/remote-board-availability";
import { remoteHosts, useHostsWritable, useRemoteHostsStore } from "@renderer/stores/remote-hosts";

import { deviceMeta, hostFacts, hostHealth, hostRowMeta, orderDevices } from "./hosts-pane-model";

const messageOf = (error: unknown): string =>
  error instanceof Error && error.message !== "" ? error.message : "That didn’t work.";

/** One remote host as the pane shows it: its registry record beside its connection record. */
interface PaneHost {
  readonly remote: RemoteHost;
  readonly record: HostRecord | undefined;
  readonly projects: number;
}

function usePaneHosts(): readonly PaneHost[] {
  const remote = useRemoteHostsStore((state) => state.hosts);
  const records = useHostConnectionStore((state) => state.hosts);
  const projects = useHostConnectionStore((state) => state.projects);
  return React.useMemo(() => {
    const counts = projectCounts({ hosts: records, projects });
    return remote.map((host) => ({
      remote: host,
      record: records.find((record) => record.id === host.id),
      projects: counts.get(host.id) ?? 0,
    }));
  }, [remote, records, projects]);
}

/**
 * The last non-null value. A confirm keeps its words while it fades out:
 * clearing its subject on close would rewrite "Forget hetzner-1?" to
 * "Forget ?" in the frames the dialog is still visible.
 */
function useLastPresent<T>(value: T | null): T | null {
  const last = React.useRef(value);
  if (value !== null) last.current = value;
  return value ?? last.current;
}

type View =
  | { readonly kind: "list" }
  | { readonly kind: "host"; readonly id: string; readonly rename: boolean };

const SLIDE = 12;

export function HostsPane() {
  const hosts = usePaneHosts();
  const [view, setView] = React.useState<View>({ kind: "list" });
  // +1 drills in, -1 comes back: the incoming page arrives from its side.
  const [direction, setDirection] = React.useState(1);
  const [forgetting, setForgetting] = React.useState<RemoteHost | null>(null);
  const forgettingShown = useLastPresent(forgetting);

  const writable = useHostsWritable();
  const open = (id: string, rename = false) => {
    setDirection(1);
    setView({ kind: "host", id, rename: rename && writable });
  };
  const back = () => {
    setDirection(-1);
    setView({ kind: "list" });
  };

  const current =
    view.kind === "host" ? hosts.find((host) => host.remote.id === view.id) : undefined;
  // A host forgotten (here or elsewhere) while its page is open: back to the list.
  const pageKey = current === undefined ? "list" : `host-${current.remote.id}`;

  const forget = (host: RemoteHost) => {
    back();
    remoteHosts()
      .forget(host.id)
      .then(
        () => toast(`Forgot ${host.name}`),
        (error: unknown) => toastError(`Couldn’t forget ${host.name}: ${messageOf(error)}`),
      );
  };

  return (
    <div className="relative">
      <AnimatePresence initial={false} mode="popLayout" custom={direction}>
        <motion.div
          key={pageKey}
          custom={direction}
          variants={{
            enter: (dir: number) => ({ opacity: 0, x: dir * SLIDE }),
            center: { opacity: 1, x: 0 },
            exit: (dir: number) => ({ opacity: 0, x: dir * -SLIDE }),
          }}
          initial="enter"
          animate="center"
          exit="exit"
          transition={{ duration: 0.22, ease: EASE_OUT }}
          className="flex flex-col gap-6"
        >
          {current !== undefined && view.kind === "host" ? (
            <HostPage
              host={current}
              startRename={view.rename}
              onBack={back}
              onForget={() => setForgetting(current.remote)}
            />
          ) : (
            <HostList
              hosts={hosts}
              onOpen={(host) => open(host.id)}
              onRename={(host) => open(host.id, true)}
              onForget={setForgetting}
            />
          )}
        </motion.div>
      </AnimatePresence>

      <AlertDialog
        open={forgetting !== null && writable}
        onOpenChange={(next) => !next && setForgetting(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Forget {forgettingShown?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This Mac’s pairing is removed. {forgettingShown?.name} and its workspaces keep
              running, and you can add it again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="sm">Cancel</AlertDialogCancel>
            <AlertDialogAction
              size="sm"
              variant="destructive"
              onClick={() => {
                if (forgetting !== null) forget(forgetting);
              }}
            >
              Forget
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/* ── The list ───────────────────────────────────────────────────────────── */

function HostList({
  hosts,
  onOpen,
  onRename,
  onForget,
}: {
  hosts: readonly PaneHost[];
  onOpen: (host: RemoteHost) => void;
  onRename: (host: RemoteHost) => void;
  onForget: (host: RemoteHost) => void;
}) {
  // Main leaves a hosts file it cannot read (or a newer Volli's) as it is, and refuses changes.
  const readOnly = useRemoteHostsStore((state) => state.readOnly);
  return (
    <PrefSection
      title="Hosts"
      icon={HardDrivesIcon}
      // With only This Mac, the empty row below is the one way in.
      action={
        hosts.length === 0 || readOnly !== null ? undefined : (
          <SectionAction label="Add a host…" icon={PlusIcon} onAct={openAddHostSheet} />
        )
      }
    >
      {readOnly === null ? null : (
        <p role="status" className="text-ui text-muted-foreground">
          {readOnly} Its hosts can’t be added or changed here.
        </p>
      )}
      <div className="flex flex-col">
        <ListRow
          data-host-row=""
          density="two-line"
          leading={<HostGlyph os="macos" local />}
          primary="This Mac"
          secondary={<span className="block truncate text-ui text-muted-foreground/70">Local</span>}
          onActivate={null}
        />
        <AnimatePresence initial={false}>
          {hosts.map((host) => (
            <Collapse key={host.remote.id}>
              <HostRow
                host={host}
                onOpen={() => onOpen(host.remote)}
                onRename={() => onRename(host.remote)}
                onForget={() => onForget(host.remote)}
              />
            </Collapse>
          ))}
          {hosts.length === 0 && readOnly === null ? (
            <Collapse key="empty">
              <ListRow
                data-host-row=""
                density="two-line"
                leading={
                  <span className="grid size-6 shrink-0 place-items-center rounded-sm border border-dashed border-border text-muted-foreground">
                    <PlusIcon aria-hidden className="size-3.5" />
                  </span>
                }
                primary={
                  <span className="truncate text-ui text-muted-foreground">Add a host…</span>
                }
                onActivate={openAddHostSheet}
              />
            </Collapse>
          ) : null}
        </AnimatePresence>
      </div>
    </PrefSection>
  );
}

/** A row that leaves by closing up, so the rows below slide into the gap. */
function Collapse({ children }: { children: React.ReactNode }) {
  return (
    <motion.div
      className="overflow-hidden"
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.22, ease: EASE_OUT }}
    >
      {children}
    </motion.div>
  );
}

function HostRow({
  host,
  onOpen,
  onRename,
  onForget,
}: {
  host: PaneHost;
  onOpen: () => void;
  onRename: () => void;
  onForget: () => void;
}) {
  const { remote, record, projects } = host;
  const health = record === undefined ? null : hostHealth(record, projects);
  // A read-only hosts file: nothing to rename or forget, so no menu at all.
  const writable = useHostsWritable();
  return (
    <ListRow
      data-host-row=""
      density="two-line"
      leading={
        <HostGlyph
          os={remote.os}
          badge={record === undefined || projects === 0 ? null : hostBadge(record)}
        />
      }
      primary={remote.name}
      secondary={
        <span className="block truncate text-ui text-muted-foreground/70">
          <SwapText>{hostRowMeta(remote, projects)}</SwapText>
        </span>
      }
      trailing={health === null ? undefined : <Health state={health.state}>{health.label}</Health>}
      actions={
        <>
          {writable ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`More for ${remote.name}`}
                  className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
                >
                  <DotsThreeIcon weight="bold" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={onRename}>
                  <PencilSimpleIcon />
                  Rename
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={onForget}>
                  <TrashIcon />
                  Forget…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          <CaretRightIcon
            aria-hidden
            onClick={onOpen}
            className="size-3.5 shrink-0 text-muted-foreground/70"
          />
        </>
      }
      onActivate={onOpen}
    />
  );
}

/* ── One host ───────────────────────────────────────────────────────────── */

function HostPage({
  host,
  startRename,
  onBack,
  onForget,
}: {
  host: PaneHost;
  startRename: boolean;
  onBack: () => void;
  onForget: () => void;
}) {
  const { remote, record, projects } = host;
  const health = record === undefined ? null : hostHealth(record, projects);
  const readOnly = useRemoteHostsStore((state) => state.readOnly);
  return (
    <>
      <div className="flex items-center gap-4 rounded-lg bg-card px-4 py-4">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="icon-sm" variant="ghost" aria-label="All hosts" onClick={onBack}>
              <CaretLeftIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">All hosts</TooltipContent>
        </Tooltip>
        <HostGlyph
          os={remote.os}
          size="md"
          badge={record === undefined || projects === 0 ? null : hostBadge(record)}
        />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">
            <SwapText>{remote.name}</SwapText>
          </h2>
          <p className="truncate text-ui text-muted-foreground">
            <SwapText>{hostRowMeta(remote, projects)}</SwapText>
          </p>
        </div>
        {health === null ? null : <Health state={health.state}>{health.label}</Health>}
      </div>

      <PrefSection title="Host" icon={HardDrivesIcon}>
        <NameRow host={remote} startEditing={startRename} readOnly={readOnly !== null} />
        {hostFacts(remote).map((fact) => (
          <PrefRow key={fact.label} label={fact.label} hint={fact.hint}>
            {fact.full === undefined ? (
              <span className="truncate text-ui text-muted-foreground">{fact.value}</span>
            ) : (
              <FullValue short={fact.value} full={fact.full} label={fact.label} />
            )}
          </PrefRow>
        ))}
      </PrefSection>

      <PrefSection title="Sign-ins" icon={KeyIcon}>
        <PrefRow
          label="Models and git"
          hint={`What agents on ${remote.name} sign in with: provider keys, subscriptions and push tokens.`}
        >
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              useHostSignInSheet
                .getState()
                .open({ hostId: remote.id, hostName: remote.name, providerId: null })
            }
          >
            Sign-ins…
          </Button>
        </PrefRow>
      </PrefSection>

      <ProjectsSection hostId={remote.id} />

      <DevicesSection host={remote} />

      <div className="rounded-lg bg-card px-4 py-4">
        <PrefRow
          label="Forget host"
          hint={readOnly ?? "Removes this Mac’s pairing and its key. Nothing on the host changes."}
        >
          <Button
            size="sm"
            variant="outline"
            className="text-destructive hover:text-destructive"
            disabled={readOnly !== null}
            onClick={onForget}
          >
            Forget…
          </Button>
        </PrefRow>
      </div>
    </>
  );
}

/**
 * The name, edited where it is read: this Mac's label for the host, never
 * the host's own name. Enter or blur commits, Escape puts it back.
 */
function NameRow({
  host,
  startEditing,
  readOnly,
}: {
  host: RemoteHost;
  startEditing: boolean;
  /** The hosts file cannot change: the name is read, never edited. */
  readOnly: boolean;
}) {
  const [editing, setEditing] = React.useState(startEditing && !readOnly);
  return (
    <PrefRow label="Name" hint="What this Mac calls it. The host’s own name doesn’t change.">
      {readOnly ? (
        <span className="truncate text-ui text-muted-foreground">{host.name}</span>
      ) : editing ? (
        <InlineRename
          size="field"
          value={host.name}
          ariaLabel="Host name"
          className={cn(CONTROL_W.md, "h-7 text-ui")}
          onCommit={(next) => {
            setEditing(false);
            remoteHosts()
              .rename(host.id, next)
              .catch((error: unknown) =>
                toastError(`Couldn’t rename ${host.name}: ${messageOf(error)}`),
              );
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="group/name -mr-2 flex h-7 items-center gap-2 rounded-full px-2 text-ui text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <PencilSimpleIcon
            aria-hidden
            className="size-3.5 opacity-0 transition-opacity group-hover/name:opacity-100 group-focus-visible/name:opacity-100"
          />
          {host.name}
          <span className="sr-only">Rename</span>
        </button>
      )}
    </PrefRow>
  );
}

/**
 * The projects this Mac opened on the host: a workspace lives on exactly one
 * host. "Open…" lists the host's own and "New project…" makes one there
 * (VC-710), both in "Open a project on <host>…".
 */
function ProjectsSection({ hostId }: { hostId: string }) {
  const claims = useHostConnectionStore((state) => state.projects);
  const projects = useProjectsStore((state) => state.projects);
  const mine = projects.filter(
    (project) => (claims[project.id]?.hostId ?? THIS_MAC_HOST_ID) === hostId,
  );
  // A project this host serves whose board it does not offer this Mac (an
  // older host, VC-711): no row came, so it is listed here with the reason.
  const unavailable = useRemoteBoardAvailabilityStore((state) => state.unavailable);
  const retry = useRemoteBoardAvailabilityStore((state) => state.retry);
  const refused = Object.entries(unavailable).filter(
    ([projectId]) =>
      claims[projectId]?.hostId === hostId && !mine.some(({ id }) => id === projectId),
  );
  const sheet = (start: "list" | "new") => () =>
    useRemoteHostsStore.getState().openProjectSheet(hostId, start);
  return (
    <PrefSection
      title="Projects"
      icon={FolderSimpleIcon}
      action={
        <span className="flex items-center gap-1">
          <SectionAction label="Open…" icon={FolderSimpleIcon} onAct={sheet("list")} />
          <SectionAction label="New project…" icon={PlusIcon} onAct={sheet("new")} />
        </span>
      }
    >
      {mine.length === 0 && refused.length === 0 ? (
        <Empty>{openHere(claims, hostId)}</Empty>
      ) : (
        <>
          {mine.map((project) => (
            <ItemRow
              key={project.id}
              name={project.name}
              leading={<Mark icon={FolderSimpleIcon} />}
            />
          ))}
          {refused.map(([projectId, reason]) => (
            <ItemRow
              key={projectId}
              name={reason}
              leading={<Mark icon={FolderSimpleIcon} />}
              testId="host-board-unavailable"
            >
              {retry === null ? null : (
                <Button size="sm" variant="ghost" onClick={() => retry(projectId)}>
                  Try again
                </Button>
              )}
            </ItemRow>
          ))}
        </>
      )}
    </PrefSection>
  );
}

/**
 * What an empty Projects section says: none open here, or how many are while
 * their rows are not this Mac's to name yet (the rail learns remote ones later).
 */
function openHere(claims: Readonly<Record<string, { readonly hostId: string }>>, hostId: string) {
  const count = Object.values(claims).filter((claim) => claim.hostId === hostId).length;
  return count === 0
    ? "No projects open on this Mac yet"
    : `${count} ${count === 1 ? "project" : "projects"} open on this Mac`;
}

/** The devices the host has enrolled, read from it over SSH each time the page opens. */
function DevicesSection({ host }: { host: RemoteHost }) {
  const [state, setState] = React.useState<AsyncState<readonly RemoteHostDevice[]>>({
    status: "loading",
  });
  const [attempt, setAttempt] = React.useState(0);
  const retry = React.useCallback(() => setAttempt((value) => value + 1), []);
  React.useEffect(() => {
    let live = true;
    setState({ status: "loading" });
    remoteHosts()
      .devices(host.id)
      .then(
        (answer) => {
          if (live) setState({ status: "ready", data: orderDevices(answer.devices) });
        },
        (error: unknown) => {
          if (live) setState({ status: "error", message: messageOf(error), onRetry: retry });
        },
      );
    return () => {
      live = false;
    };
  }, [host.id, attempt, retry]);
  return (
    <AsyncSection
      title="Paired devices"
      icon={DevicesIcon}
      action={
        <SectionIconAction
          label="Refresh"
          busy={state.status === "loading"}
          disabled={state.status === "loading"}
          onAct={retry}
        />
      }
      state={state}
      isEmpty={(devices) => devices.length === 0}
      empty="No devices"
    >
      {(devices) =>
        devices.map((device) => (
          <ItemRow
            key={device.deviceId}
            name={
              <span
                className={cn(device.revokedAt !== null && "text-muted-foreground line-through")}
              >
                {device.name}
              </span>
            }
            meta={deviceMeta(device)}
            leading={<Mark icon={LaptopIcon} />}
            badges={device.thisMac ? <Badge variant="outline">This Mac</Badge> : undefined}
            testId={`host-device-${device.deviceId}`}
          />
        ))
      }
    </AsyncSection>
  );
}

/** A short form shown, the whole value one click away: selectable on hover, copied on Copy. */
function FullValue({ short, full, label }: { short: string; full: string; label: string }) {
  const [copied, setCopied] = React.useState(false);
  React.useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(id);
  }, [copied]);
  return (
    <span className="flex min-w-0 items-center gap-1">
      <span title={full} className="truncate font-mono text-ui text-muted-foreground select-all">
        {short}
      </span>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={copied ? "Copied" : `Copy ${label.toLowerCase()}`}
        onClick={() => {
          void navigator.clipboard?.writeText(full).catch(() => {});
          setCopied(true);
        }}
      >
        {copied ? <CheckIcon weight="bold" className="text-positive" /> : <CopyIcon />}
      </Button>
    </span>
  );
}

/** A quiet tile for a thing in a list — the host glyph's shape, without its light. */
function Mark({ icon: Icon }: { icon: PhosphorIcon }) {
  return (
    <span className="grid size-6 shrink-0 place-items-center rounded-sm bg-muted text-muted-foreground">
      <Icon aria-hidden className="size-3.5" />
    </span>
  );
}
