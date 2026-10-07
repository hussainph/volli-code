/**
 * Settings → Hosts (VC-615 flow 7): the hosts this Mac knows, and one host's
 * page — its name, its facts, the workspaces it holds, the devices paired to
 * it, and the way to forget it.
 *
 * Built from the real settings kit (`PrefSection`, `PrefRow`, `Health`) over
 * `ui/list-row.tsx`, so what is judged here is the shape a shipped pane would
 * take rather than a lookalike. Two architecture facts shape it without being
 * said on screen: a workspace lives on exactly one host (so the workspace list
 * is that host's, not a shared one), and a host restored from a backup has a
 * new key, so it is a new host to every device — said once, in the host key's
 * `(i)`, and nowhere else.
 */
import * as React from "react";
import { AnimatePresence, motion } from "motion/react";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import { ArrowCircleUpIcon } from "@phosphor-icons/react/dist/csr/ArrowCircleUp";
import { BrowserIcon } from "@phosphor-icons/react/dist/csr/Browser";
import { CaretLeftIcon } from "@phosphor-icons/react/dist/csr/CaretLeft";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { DeviceMobileIcon } from "@phosphor-icons/react/dist/csr/DeviceMobile";
import { DevicesIcon } from "@phosphor-icons/react/dist/csr/Devices";
import { DotsThreeIcon } from "@phosphor-icons/react/dist/csr/DotsThree";
import { FolderSimpleIcon } from "@phosphor-icons/react/dist/csr/FolderSimple";
import { HardDrivesIcon } from "@phosphor-icons/react/dist/csr/HardDrives";
import { LaptopIcon } from "@phosphor-icons/react/dist/csr/Laptop";
import { PencilSimpleIcon } from "@phosphor-icons/react/dist/csr/PencilSimple";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { QrCodeIcon } from "@phosphor-icons/react/dist/csr/QrCode";
import { TrashIcon } from "@phosphor-icons/react/dist/csr/Trash";
import { toast } from "sonner";

import {
  CONTROL_W,
  Health,
  ItemRow,
  PrefRow,
  PrefSection,
  SectionAction,
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
import { Spinner } from "@renderer/components/ui/spinner";
import type { StatusDotState } from "@renderer/components/ui/status-dot";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { cn } from "@renderer/lib/utils";

import {
  APP_VERSION,
  DEVICES,
  FACTS,
  SHORT_FINGERPRINT,
  TAILNET_NAME,
  type HostOs,
  type PairedDevice,
} from "./fixtures";
import { EASE_OUT, HostGlyph, SwapText, type GlyphBadge } from "./parts";

/* ── Model ──────────────────────────────────────────────────────────────── */

export type HostState = "online" | "offline" | "updating" | "outdated";

export interface ManagedHost {
  id: string;
  name: string;
  os: HostOs;
  /** This Mac: always present, never forgotten. */
  local?: boolean;
  route: "Local" | "Tailscale" | "SSH";
  address: string;
  system: string;
  version: string;
  state: HostState;
  lastSeen?: string;
  fingerprint: string;
  workspaces: readonly { name: string; path: string }[];
  devices: readonly PairedDevice[];
}

const system = (os: HostOs) => `${FACTS[os].system} · ${FACTS[os].arch}`;
const others = DEVICES.filter((device) => !device.thisDevice);

const LOCAL_HOST: ManagedHost = {
  id: "local",
  name: "This Mac",
  os: "macos",
  local: true,
  route: "Local",
  address: "",
  system: system("macos"),
  version: APP_VERSION,
  state: "online",
  fingerprint: "Hm2V 8cQa Lr4T",
  workspaces: [
    { name: "volli-code", path: "~/Desktop/code/volli-code" },
    { name: "website", path: "~/code/website" },
  ],
  devices: others,
};

export const MANAGED_HOSTS: readonly ManagedHost[] = [
  LOCAL_HOST,
  {
    id: "hetzner-1",
    name: "hetzner-1",
    os: "linux",
    route: "Tailscale",
    address: TAILNET_NAME,
    system: system("linux"),
    version: APP_VERSION,
    state: "online",
    fingerprint: SHORT_FINGERPRINT,
    workspaces: [
      { name: "api", path: "~/code/api" },
      { name: "infra", path: "~/code/infra" },
    ],
    devices: DEVICES,
  },
  {
    id: "mac-mini",
    name: "mac-mini",
    os: "macos",
    route: "SSH",
    address: "mac-mini.local",
    system: system("macos"),
    version: APP_VERSION,
    state: "offline",
    lastSeen: "2 hours ago",
    fingerprint: "x7Lp 2RdN q9Ve",
    workspaces: [
      { name: "photos", path: "~/Developer/photos" },
      { name: "notes-app", path: "~/Developer/notes-app" },
    ],
    devices: DEVICES.filter((device) => device.kind !== "browser"),
  },
  {
    id: "build",
    name: "build",
    os: "linux",
    route: "SSH",
    address: "build.internal.volli.dev",
    system: "Ubuntu 22.04 · x86-64",
    version: "0.2.4",
    state: "outdated",
    fingerprint: "Tn4c 0WbY m3Ks",
    workspaces: [
      { name: "release", path: "/srv/release" },
      { name: "bench", path: "/srv/bench" },
    ],
    devices: DEVICES.filter((device) => device.thisDevice),
  },
];

const HEALTH: Record<HostState, { state: StatusDotState; label: string }> = {
  online: { state: "ready", label: "Online" },
  offline: { state: "exited", label: "Offline" },
  updating: { state: "working", label: "Updating" },
  outdated: { state: "waiting", label: "Needs update" },
};

const BADGE: Record<HostState, GlyphBadge> = {
  online: null,
  offline: "offline",
  updating: null,
  outdated: "attention",
};

/** Route · version, or route · when it was last seen. One line, always quiet. */
function hostMeta(host: ManagedHost): string {
  if (host.state === "offline")
    return `${host.route} · Last seen ${host.lastSeen ?? "a while ago"}`;
  return `${host.route} · ${host.version}`;
}

export function hostsAttention(hosts: readonly ManagedHost[]) {
  return hosts.some((host) => host.state === "outdated")
    ? { state: "waiting" as const, label: "A host needs an update" }
    : undefined;
}

/**
 * The last non-null value. A confirm keeps its words while it fades out:
 * clearing its subject on close would rewrite "Revoke Hussain's iPhone?" to
 * "Revoke ?" in the frames the dialog is still visible.
 */
function useLastPresent<T>(value: T | null): T | null {
  const last = React.useRef(value);
  if (value !== null) last.current = value;
  return value ?? last.current;
}

/* ── The pane ───────────────────────────────────────────────────────────── */

type View = { kind: "list" } | { kind: "host"; id: string; rename: boolean };

const SLIDE = 12;

export function HostsPane({
  hosts,
  setHosts,
}: {
  hosts: readonly ManagedHost[];
  setHosts: React.Dispatch<React.SetStateAction<readonly ManagedHost[]>>;
}) {
  const [view, setView] = React.useState<View>({ kind: "list" });
  // +1 drills in, -1 comes back: the incoming page arrives from the side it
  // lives on, so the two views read as a place and a place inside it.
  const [direction, setDirection] = React.useState(1);
  const [forgetting, setForgetting] = React.useState<ManagedHost | null>(null);
  const forgettingShown = useLastPresent(forgetting);
  const timers = React.useRef<ReturnType<typeof setTimeout>[]>([]);
  React.useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const later = (ms: number, run: () => void) => {
    timers.current.push(setTimeout(run, ms));
  };

  const open = (id: string, rename = false) => {
    setDirection(1);
    setView({ kind: "host", id, rename });
  };
  const back = () => {
    setDirection(-1);
    setView({ kind: "list" });
  };

  const patch = (id: string, next: Partial<ManagedHost>) =>
    setHosts((current) => current.map((host) => (host.id === id ? { ...host, ...next } : host)));

  const update = (host: ManagedHost) => {
    patch(host.id, { state: "updating" });
    later(2400, () => patch(host.id, { state: "online", version: APP_VERSION }));
  };

  const forget = (host: ManagedHost) => {
    // Back to the list first, so the row is on screen when it leaves: a host
    // that vanishes while you are looking at a different page is a host you
    // have to go and check on.
    back();
    later(320, () => {
      setHosts((current) => current.filter((candidate) => candidate.id !== host.id));
      toast(`Forgot ${host.name}`);
    });
  };

  const current = view.kind === "host" ? hosts.find((host) => host.id === view.id) : undefined;
  const pageKey = current ? `host-${current.id}` : "list";

  // A page change starts at the top, as a category switch in `PrefShell`
  // does. Forget is at the bottom of a host's page; landing back on the list
  // scrolled by that much would hide the row whose leaving is the point.
  const root = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    scrollParent(root.current)?.scrollTo({ top: 0 });
  }, [pageKey]);

  return (
    <div ref={root} className="relative">
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
          {current && view.kind === "host" ? (
            <HostPage
              host={current}
              startRename={view.rename}
              onBack={back}
              onRename={(name) => patch(current.id, { name })}
              onUpdate={() => update(current)}
              onRevoke={(device) => {
                patch(current.id, {
                  devices: current.devices.filter((candidate) => candidate.id !== device.id),
                });
                toast(`Revoked ${device.name}`);
              }}
              onForget={() => setForgetting(current)}
            />
          ) : (
            <HostList
              hosts={hosts}
              onOpen={(host) => open(host.id)}
              onRename={(host) => open(host.id, true)}
              onUpdate={update}
              onForget={setForgetting}
            />
          )}
        </motion.div>
      </AnimatePresence>

      <AlertDialog open={forgetting !== null} onOpenChange={(next) => !next && setForgetting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Forget {forgettingShown?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This Mac’s pairing and read-only copy are removed. {forgettingShown?.name} and its
              workspaces keep running, and you can pair again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="sm">Cancel</AlertDialogCancel>
            <AlertDialogAction
              size="sm"
              variant="destructive"
              onClick={() => {
                if (forgetting) forget(forgetting);
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

function scrollParent(element: HTMLElement | null): HTMLElement | null {
  for (let node = element?.parentElement ?? null; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === "auto" || overflowY === "scroll") return node;
  }
  return null;
}

/* ── The list ───────────────────────────────────────────────────────────── */

function addHost() {
  window.location.hash = "host-add";
}

function pairPhone() {
  window.location.hash = "host-pair";
}

function HostList({
  hosts,
  onOpen,
  onRename,
  onUpdate,
  onForget,
}: {
  hosts: readonly ManagedHost[];
  onOpen: (host: ManagedHost) => void;
  onRename: (host: ManagedHost) => void;
  onUpdate: (host: ManagedHost) => void;
  onForget: (host: ManagedHost) => void;
}) {
  const remote = hosts.filter((host) => !host.local);
  return (
    <PrefSection
      title="Hosts"
      icon={HardDrivesIcon}
      // With only This Mac, the empty row below is the one way in; the header
      // saying it a second time beside it is noise.
      action={
        remote.length === 0 ? undefined : (
          <SectionAction label="Add a host…" icon={PlusIcon} onAct={addHost} />
        )
      }
    >
      <div className="flex flex-col">
        <AnimatePresence initial={false}>
          {hosts.map((host) => (
            <Collapse key={host.id}>
              <HostRow
                host={host}
                onOpen={() => onOpen(host)}
                onRename={() => onRename(host)}
                onUpdate={() => onUpdate(host)}
                onForget={() => onForget(host)}
              />
            </Collapse>
          ))}
          {remote.length === 0 ? (
            <Collapse key="empty">
              <ListRow
                leading={
                  <span className="grid size-6 shrink-0 place-items-center rounded-[7px] border border-dashed border-border text-muted-foreground">
                    <PlusIcon aria-hidden className="size-3.5" />
                  </span>
                }
                primary={
                  <span className="truncate text-ui text-muted-foreground">Add a host…</span>
                }
                density="two-line"
                onActivate={addHost}
              />
            </Collapse>
          ) : null}
        </AnimatePresence>
      </div>
    </PrefSection>
  );
}

/**
 * A row that leaves by closing up rather than by vanishing: height and fade
 * together, under a quarter second, so the rows below slide up into the gap
 * instead of jumping.
 */
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
  onUpdate,
  onForget,
}: {
  host: ManagedHost;
  onOpen: () => void;
  onRename: () => void;
  onUpdate: () => void;
  onForget: () => void;
}) {
  const health = HEALTH[host.state];
  return (
    <ListRow
      density="two-line"
      leading={<HostGlyph os={host.os} local={host.local} size="sm" />}
      primary={host.name}
      secondary={
        <span className="block truncate text-ui text-muted-foreground/70">
          <SwapText>{host.local ? `Local · ${host.version}` : hostMeta(host)}</SwapText>
        </span>
      }
      trailing={host.local ? undefined : <Health state={health.state}>{health.label}</Health>}
      actions={
        <>
          {host.local ? (
            // Holds the menu's column so This Mac's caret lines up with the rest.
            <span aria-hidden className="size-5 shrink-0" />
          ) : (
            <>
              {host.state === "outdated" ? (
                <Button size="xs" variant="outline" onClick={onUpdate}>
                  <ArrowCircleUpIcon />
                  Update
                </Button>
              ) : null}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`More for ${host.name}`}
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
                  <DropdownMenuItem disabled={host.state === "offline"} onSelect={pairPhone}>
                    <QrCodeIcon />
                    Pair a phone…
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onSelect={onForget}>
                    <TrashIcon />
                    Forget…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}
          {/* The drill-in mark ends the row, after its actions — inside the
              target it would sit between the status and the Update it
              belongs with. Not a second control: the row is the button. */}
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
  onRename,
  onUpdate,
  onRevoke,
  onForget,
}: {
  host: ManagedHost;
  startRename: boolean;
  onBack: () => void;
  onRename: (name: string) => void;
  onUpdate: () => void;
  onRevoke: (device: PairedDevice) => void;
  onForget: () => void;
}) {
  const health = HEALTH[host.state];
  const offline = host.state === "offline";
  const [revoking, setRevoking] = React.useState<PairedDevice | null>(null);
  const revokingShown = useLastPresent(revoking);
  const devices = host.devices;

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
        <HostGlyph os={host.os} local={host.local} size="md" badge={BADGE[host.state]} />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">
            <SwapText>{host.name}</SwapText>
          </h2>
          <p className="truncate text-ui text-muted-foreground">
            <SwapText>{host.local ? `Local · ${host.version}` : hostMeta(host)}</SwapText>
          </p>
        </div>
        {host.local ? null : <Health state={health.state}>{health.label}</Health>}
      </div>

      <PrefSection title="Host" icon={HardDrivesIcon}>
        {host.local ? null : (
          <NameRow name={host.name} startEditing={startRename} onRename={onRename} />
        )}
        <PrefRow label="System">
          <span className="text-ui text-muted-foreground">{host.system}</span>
        </PrefRow>
        <PrefRow label="Version">
          <VersionValue host={host} onUpdate={onUpdate} />
        </PrefRow>
        {host.local ? null : (
          <PrefRow label="Connection">
            <span className="flex min-w-0 items-center gap-1 text-ui text-muted-foreground">
              {host.route}
              <span aria-hidden>·</span>
              <span className="truncate font-mono">{host.address}</span>
            </span>
          </PrefRow>
        )}
        <PrefRow
          label="Host key"
          hint={<>A host restored from a backup has a new key, so it pairs as a new host.</>}
        >
          <span className="font-mono text-ui text-muted-foreground">{host.fingerprint}</span>
        </PrefRow>
      </PrefSection>

      <PrefSection title="Workspaces" icon={FolderSimpleIcon}>
        {host.workspaces.map((workspace) => (
          <ItemRow
            key={workspace.name}
            name={workspace.name}
            meta={workspace.path}
            leading={<Mark icon={FolderSimpleIcon} />}
          />
        ))}
      </PrefSection>

      <PrefSection
        title="Paired devices"
        icon={DevicesIcon}
        action={
          <SectionAction
            label="Pair a phone…"
            icon={QrCodeIcon}
            disabled={offline}
            onAct={pairPhone}
          />
        }
      >
        <div className="flex flex-col">
          <AnimatePresence initial={false}>
            {devices.map((device) => (
              <Collapse key={device.id}>
                <ItemRow
                  name={device.name}
                  meta={
                    device.thisDevice
                      ? `Paired ${device.paired}`
                      : `Last seen ${device.lastSeen.toLowerCase()}`
                  }
                  leading={<Mark icon={DEVICE_ICON[device.kind]} />}
                  badges={device.thisDevice ? <Badge variant="outline">This Mac</Badge> : undefined}
                >
                  {device.thisDevice ? null : (
                    <Button
                      size="xs"
                      variant="ghost"
                      className="text-muted-foreground"
                      disabled={offline}
                      aria-label={`Revoke ${device.name}`}
                      onClick={() => setRevoking(device)}
                    >
                      Revoke
                    </Button>
                  )}
                </ItemRow>
              </Collapse>
            ))}
          </AnimatePresence>
          {devices.length === 0 ? (
            <p className="py-4 text-center text-ui text-muted-foreground">No devices</p>
          ) : null}
        </div>
      </PrefSection>

      {host.local ? null : (
        <div className="rounded-lg bg-card px-4 py-4">
          <PrefRow label="Forget host">
            <Button
              size="sm"
              variant="outline"
              className="text-destructive hover:text-destructive"
              onClick={onForget}
            >
              Forget…
            </Button>
          </PrefRow>
        </div>
      )}

      <AlertDialog open={revoking !== null} onOpenChange={(next) => !next && setRevoking(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke {revokingShown?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {revokingShown?.name} will need to pair again to reach {host.name}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="sm">Cancel</AlertDialogCancel>
            <AlertDialogAction
              size="sm"
              variant="destructive"
              onClick={() => {
                if (revoking) onRevoke(revoking);
              }}
            >
              Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function VersionValue({ host, onUpdate }: { host: ManagedHost; onUpdate: () => void }) {
  return (
    <>
      <span className="flex items-center gap-2 text-ui text-muted-foreground">
        {host.state === "updating" ? <Spinner className="size-3.5" /> : null}
        <SwapText>
          {host.state === "updating" ? `Updating to ${APP_VERSION}` : host.version}
        </SwapText>
      </span>
      {host.state === "outdated" ? (
        <Button size="sm" variant="outline" onClick={onUpdate}>
          <ArrowCircleUpIcon />
          Update to {APP_VERSION}
        </Button>
      ) : null}
    </>
  );
}

/**
 * The name, edited where it is read. A quiet button until clicked, then the
 * app's one inline-rename field at the column's default width; Enter or blur
 * commits, Escape puts it back.
 */
function NameRow({
  name,
  startEditing,
  onRename,
}: {
  name: string;
  startEditing: boolean;
  onRename: (name: string) => void;
}) {
  const [editing, setEditing] = React.useState(startEditing);
  return (
    <PrefRow label="Name">
      {editing ? (
        <InlineRename
          size="field"
          value={name}
          ariaLabel="Host name"
          className={cn(CONTROL_W.md, "h-7 text-ui")}
          onCommit={(next) => {
            onRename(next);
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          // `-mr-2` pays back the pill's inset, so the name's right edge sits
          // on the column every other value in this card ends on.
          className="group/name -mr-2 flex h-7 items-center gap-2 rounded-full px-2 text-ui text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <PencilSimpleIcon
            aria-hidden
            className="size-3.5 opacity-0 transition-opacity group-hover/name:opacity-100 group-focus-visible/name:opacity-100"
          />
          {name}
          <span className="sr-only">Rename</span>
        </button>
      )}
    </PrefRow>
  );
}

const DEVICE_ICON: Record<PairedDevice["kind"], PhosphorIcon> = {
  mac: LaptopIcon,
  phone: DeviceMobileIcon,
  browser: BrowserIcon,
};

/** A quiet tile for a thing in a list — the host glyph's shape, without its light. */
function Mark({ icon: Icon }: { icon: PhosphorIcon }) {
  return (
    <span className="grid size-6 shrink-0 place-items-center rounded-[7px] bg-muted text-muted-foreground">
      <Icon aria-hidden className="size-3.5" />
    </span>
  );
}
