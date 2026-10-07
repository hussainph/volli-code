/**
 * The title bar's host chip and its switcher (VC-576; VC-615 flows 5–6,
 * ported from the lab's `#host-health`).
 *
 * The chip names the machine the project in front of the person runs on —
 * where Zed puts a remote's name and Xcode its run destination — between the
 * history arrows and search. Its tile carries the host's state: a badge for
 * what needs attention (an update, an expired sign-in, a host that cannot
 * serve), a slow breath while the link is on its way back, the name greyed
 * while it is unreachable. The page itself only speaks for blocking states,
 * through the Island (`host-island.tsx`).
 *
 * The switcher lists This Mac and every added host, the current one holding
 * the one thing it has to say (an update, a retry, a sign-in), then "Sign-ins
 * on <host>…" for each remote host it can reach, "Add a host…" and "Manage
 * hosts…". Choosing another host opens its first project in rail order; a
 * remote host with none open here opens "Open a project on <host>…" (VC-710).
 *
 * Renders nothing with the `cloud` flag off.
 */
import * as React from "react";
import { MotionConfig, motion } from "motion/react";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { GearSixIcon } from "@phosphor-icons/react/dist/csr/GearSix";
import { KeyIcon } from "@phosphor-icons/react/dist/csr/Key";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { WifiSlashIcon } from "@phosphor-icons/react/dist/csr/WifiSlash";

import { useHostSignInSheet } from "@renderer/components/hosts/sign-ins/remote-host-sign-in-source";
import { useHostModelSheet } from "@renderer/stores/host-model-sheet";
import { CpuIcon } from "@phosphor-icons/react/dist/csr/Cpu";
import { Button } from "@renderer/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import { cn } from "@renderer/lib/utils";
import {
  projectCounts,
  THIS_MAC_HOST_ID,
  useHostConnectionStore,
  type HostRecord,
} from "@renderer/stores/host-connection";
import { useProjectsStore } from "@renderer/stores/projects";
import { readdHostToUpdate, useRemoteHostsStore } from "@renderer/stores/remote-hosts";

import {
  ActiveStepMark,
  AutoHeight,
  HostGlyph,
  ProgressLine,
  ProviderMark,
  SwapText,
} from "./host-parts";
import {
  hostBadge,
  hostDetail,
  hostMeta,
  hostPulsing,
  type HostDetail as HostDetailModel,
} from "./host-surface-model";
import {
  openAddHost,
  openManageHosts,
  runHostAction,
  useAddHostOffered,
  useCloudEnabled,
  useCurrentHost,
  useHostRecoveryToasts,
  useNow,
  useCurrentProjectHostView,
} from "./use-hosts";

/** What the tile's badge says to a screen reader: the chip's name carries it. */
const BADGE_WORDS = {
  none: "",
  offline: ", offline",
  fail: ", can’t serve",
  attention: ", needs attention",
} as const;

export function HostChip() {
  const cloud = useCloudEnabled();
  useHostRecoveryToasts(cloud);
  if (!cloud) return null;
  return <EnabledHostChip />;
}

function EnabledHostChip() {
  const [open, setOpen] = React.useState(false);
  // The tile draws the HOST's engine-owned health; the detail under the
  // current host in the switcher speaks for the project in front.
  const host = useCurrentHost();
  const view = useCurrentProjectHostView();
  const pulsing = hostPulsing(host);
  const offline = host.link.status === "offline";
  return (
    <MotionConfig reducedMotion="user">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`Host: ${host.name}${BADGE_WORDS[hostBadge(host) ?? "none"]}`}
            data-slot="host-chip"
            className="app-region-no-drag ml-1 flex h-7 translate-y-px items-center gap-2 rounded-full pr-2 pl-0.5 text-ui text-foreground transition-colors hover:bg-accent/60 data-[state=open]:bg-accent"
          >
            <motion.span
              animate={pulsing ? { opacity: [1, 0.45, 1] } : { opacity: 1 }}
              transition={
                pulsing ? { duration: 1.6, repeat: Infinity, ease: "easeInOut" } : { duration: 0.2 }
              }
              className="grid"
            >
              <HostGlyph os={host.os} local={host.local} badge={hostBadge(host)} />
            </motion.span>
            <span className={cn(offline && "text-muted-foreground")}>{host.name}</span>
            <CaretDownIcon aria-hidden className="size-3 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" aria-label="Switch host" className="w-80">
          <HostSwitcher current={host} view={view} onDone={() => setOpen(false)} />
        </PopoverContent>
      </Popover>
    </MotionConfig>
  );
}

/** The switcher's body: every host, then the two ways to more of them. */
export function HostSwitcher({
  current,
  view = current,
  onDone,
}: {
  /** The current project's host, with the host's own health. */
  current: HostRecord;
  /** The same host as the current project sees it (its own link): the detail row's. */
  view?: HostRecord;
  onDone: () => void;
}) {
  const hosts = useHostConnectionStore((state) => state.hosts);
  const claims = useHostConnectionStore((state) => state.projects);
  const sourceError = useHostConnectionStore((state) => state.sourceError);
  const addHostOffered = useAddHostOffered();
  // VC-720: this entry re-attaches to the add that outlived its sheet.
  const addActivity = useRemoteHostsStore((state) => state.addHostActivity);
  const counts = projectCounts({ hosts, projects: claims });
  const offline = hosts.some((host) => host.link.status === "offline");
  const now = useNow(offline, 30_000);
  const list = hosts.some((host) => host.id === current.id) ? hosts : [current, ...hosts];
  // Preferences for every remote host, the current one first (AM2). Models
  // remains a door on older/offline hosts so its named recovery is reachable.
  const preferenceHosts = [current, ...list.filter((host) => host.id !== current.id)].filter(
    (host) => !host.local,
  );
  return (
    <div role="group" aria-label="Hosts">
      {sourceError !== null ? (
        <div role="status" className="flex items-center gap-2 px-2 py-2 text-ui text-destructive">
          <span className="min-w-0 flex-1">{sourceError}</span>
          <Button
            size="xs"
            variant="secondary"
            onClick={() => useHostConnectionStore.getState().retrySources()}
          >
            Retry now
          </Button>
        </div>
      ) : null}
      {list.map((host) => {
        const projects = counts.get(host.id) ?? 0;
        const meta = hostMeta(host, projects, now);
        if (host.id === current.id) {
          return (
            <div key={host.id} className="rounded-row bg-accent/50">
              <SwitcherRow host={host} meta={meta} current />
              <AutoHeight>
                <HostDetailRow host={view} />
              </AutoHeight>
            </div>
          );
        }
        return (
          <div key={host.id}>
            <SwitcherRow
              host={host}
              meta={meta}
              disabled={host.local && projects === 0}
              onSelect={() => {
                const target = useProjectsStore
                  .getState()
                  .projects.find(
                    (project) => (claims[project.id]?.hostId ?? THIS_MAC_HOST_ID) === host.id,
                  );
                onDone();
                useProjectsStore.getState().cancelRemoteRestore();
                if (target !== undefined) useProjectsStore.getState().select(target.id);
                // A remote host with no project open here (VC-710): open one on it.
                else if (!host.local) useRemoteHostsStore.getState().openProjectSheet(host.id);
              }}
            />
            {host.link.status === "offline" || host.link.status === "incompatible" ? (
              <HostDetailRow host={host} />
            ) : null}
          </div>
        );
      })}
      <div className="my-1 h-px bg-border/60" />
      {preferenceHosts.map((host) => (
        <React.Fragment key={host.id}>
          {host.link.status === "open" || host.link.status === "version-skewed" ? (
            <MenuAction
              icon={KeyIcon}
              label={`Sign-ins on ${host.name}…`}
              onAct={() => {
                onDone();
                useHostSignInSheet
                  .getState()
                  .open({ hostId: host.id, hostName: host.name, providerId: null });
              }}
            />
          ) : null}
          <MenuAction
            icon={CpuIcon}
            label={`Models on ${host.name}…`}
            onAct={() => {
              onDone();
              useHostModelSheet.getState().open({ hostId: host.id, hostName: host.name });
            }}
          />
        </React.Fragment>
      ))}
      {addHostOffered ? (
        <MenuAction
          icon={PlusIcon}
          label={
            addActivity === null
              ? "Add a host…"
              : addActivity.status === "running"
                ? `Adding ${addActivity.name}…`
                : addActivity.status === "done"
                  ? `${addActivity.name} added — view…`
                  : `Adding ${addActivity.name} — needs attention…`
          }
          onAct={() => {
            onDone();
            openAddHost();
          }}
        />
      ) : null}
      <MenuAction
        icon={GearSixIcon}
        label="Manage hosts…"
        onAct={() => {
          onDone();
          openManageHosts();
        }}
      />
    </div>
  );
}

function SwitcherRow({
  host,
  meta,
  current = false,
  disabled = false,
  onSelect,
}: {
  host: HostRecord;
  meta: string;
  current?: boolean;
  disabled?: boolean;
  onSelect?: () => void;
}) {
  const badge = hostBadge(host);
  const body = (
    <>
      <HostGlyph os={host.os} local={host.local} badge={badge} />
      <span className={cn("text-ui font-medium", badge === "offline" && "text-muted-foreground")}>
        {host.name}
      </span>
      <span className="ml-auto truncate text-ui text-muted-foreground">
        <SwapText>{meta}</SwapText>
      </span>
    </>
  );
  if (current) {
    return (
      <div
        aria-current="true"
        className="flex h-10 cursor-default items-center gap-2 rounded-row px-2 select-none"
      >
        {body}
      </div>
    );
  }
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      className="flex h-10 w-full cursor-default items-center gap-2 rounded-row px-2 text-left select-none hover:bg-accent/60 disabled:opacity-60 disabled:hover:bg-transparent"
    >
      {body}
    </button>
  );
}

function MenuAction({
  icon: Icon,
  label,
  onAct,
}: {
  icon: typeof PlusIcon;
  label: string;
  onAct: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onAct}
      className="flex h-8 w-full cursor-default items-center gap-2 rounded-row px-2 text-left text-ui select-none hover:bg-accent"
    >
      <Icon aria-hidden className="size-3.5 text-muted-foreground" />
      {label}
    </button>
  );
}

/** The one thing the current host's row has to say, under its name. */
function HostDetailRow({ host }: { host: HostRecord }) {
  const detail = hostDetail(host);
  if (detail === null) return null;
  return <DetailBody host={host} detail={detail} />;
}

function DetailBody({ host, detail }: { host: HostRecord; detail: HostDetailModel }) {
  const store = useHostConnectionStore.getState();
  switch (detail.kind) {
    case "updating":
      return (
        <div className="flex flex-col gap-2 px-2 pb-2 pl-10">
          <div className="flex items-center gap-2 text-ui text-muted-foreground">
            <ActiveStepMark />
            <SwapText>
              {detail.progress < 1 ? `Updating to ${detail.targetVersion}` : "Restarting"}
            </SwapText>
          </div>
          <ProgressLine value={detail.progress} label={`Updating ${host.name}`} />
        </div>
      );
    case "update-scheduled":
    case "update-available":
      return (
        <DetailLine
          text={
            detail.kind === "update-available"
              ? `Volli host ${detail.version} is available`
              : "Update available"
          }
        >
          <Button size="xs" onClick={() => readdHostToUpdate(host.id)}>
            Re-add to update
          </Button>
        </DetailLine>
      );
    case "offline":
      return (
        <DetailLine
          icon={<WifiSlashIcon aria-hidden className="size-4 text-muted-foreground" />}
          text={detail.text ?? "Sessions there keep running"}
        >
          <Button size="xs" variant="secondary" onClick={() => store.retry(host.id)}>
            Retry now
          </Button>
        </DetailLine>
      );
    case "sign-in":
      return (
        <DetailLine
          icon={<ProviderMark id={detail.signIn.providerId} name={detail.signIn.name} />}
          text={`${detail.signIn.name} sign-in expired`}
          tone="attention"
        >
          <Button
            size="xs"
            variant="secondary"
            onClick={() => store.signIn(host.id, detail.signIn.providerId)}
          >
            Sign in
          </Button>
        </DetailLine>
      );
    case "incompatible":
      return (
        <DetailLine text={detail.text} tone="attention">
          <Button size="xs" onClick={() => runHostAction(detail.action, host)}>
            {detail.action.label}
          </Button>
        </DetailLine>
      );
  }
}

function DetailLine({
  icon,
  text,
  tone = "quiet",
  children,
}: {
  icon?: React.ReactNode;
  text: string;
  tone?: "quiet" | "attention";
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 px-2 pb-2 pl-10">
      {icon}
      <span
        className={cn(
          "min-w-0 flex-1 text-ui break-words",
          tone === "attention" ? "text-attention" : "text-muted-foreground",
        )}
      >
        {text}
      </span>
      {children}
    </div>
  );
}
