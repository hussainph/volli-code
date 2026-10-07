/**
 * The hooks every host surface reads through (VC-576). Each answers "nothing
 * to show" — and "writable" — while the `cloud` flag is off, and WITHOUT
 * touching the host-connection store: with the flag off no surface subscribes
 * to it, so a host change cannot re-render or commit anything (the flag-off
 * app pays nothing).
 */
import * as React from "react";
import { toast } from "sonner";

import { isExperimentOn, useExperimentsStore } from "@renderer/stores/experiments";
import {
  canWriteProject,
  hostOfProject,
  isBlocking,
  OPEN_LINK,
  projectLinkOf,
  useHostConnectionStore,
  type HostConnectionState,
  type HostRecord,
} from "@renderer/stores/host-connection";
import { readdHostToUpdate, remoteHosts } from "@renderer/stores/remote-hosts";
import { useProjectsStore } from "@renderer/stores/projects";
import { useUiStore } from "@renderer/stores/ui";

import {
  HOST_RECONNECT_GRACE_MS,
  hostSurface,
  hostTransitionToast,
  type HostSurface,
  type HostSurfaceAction,
} from "./host-surface-model";

/** Whether the `cloud` experiment is on. Off until the host has answered. */
export function useCloudEnabled(): boolean {
  return useExperimentsStore((state) => isExperimentOn(state.snapshot, "cloud"));
}

function cloudOn(): boolean {
  return isExperimentOn(useExperimentsStore.getState().snapshot, "cloud");
}

const NO_SUBSCRIPTION = () => () => {};

/**
 * Reads the host-connection store only while `cloud` is on. Off, it holds no
 * subscription and answers `off`, so nothing the store does reaches this
 * component. `select` must answer a value the store already holds (or a
 * primitive): it is compared by identity.
 */
function useHostRead<T>(cloud: boolean, select: (state: HostConnectionState) => T, off: T): T {
  const subscribe = cloud ? useHostConnectionStore.subscribe : NO_SUBSCRIPTION;
  const read = () => (cloud ? select(useHostConnectionStore.getState()) : off);
  return React.useSyncExternalStore(subscribe, read, read);
}

/**
 * The host a project runs on (This Mac for `null`, or for a project nobody
 * claims), with the host's own health — what the chip draws. For a
 * surface already behind the flag.
 */
export function useProjectHost(projectId: string | null): HostRecord {
  return useHostConnectionStore((state) => hostOfProject(state, projectId));
}

/**
 * The project's host as THAT project sees it: the record with the project's
 * own link in place of host health. The Island, the "Running on" dot and the
 * switcher's detail read this, so a fence on another project of the same box
 * never speaks for this one. For a surface already behind the flag.
 */
export function useProjectHostView(projectId: string | null): HostRecord {
  const host = useProjectHost(projectId);
  const link = useHostConnectionStore((state) => projectLinkOf(state, projectId));
  return React.useMemo(() => (host.link === link ? host : { ...host, link }), [host, link]);
}

export {
  notAvailableOn,
  refuseRemote,
  remoteHostNow,
  useRemoteProjectHost,
} from "@renderer/stores/remote-project";

/** The project in front of the person. */
export function useCurrentProjectId(): string | null {
  return useProjectsStore((state) => state.selectedProjectId);
}

/** The host of the project in front of the person, with its aggregate link (the chip's). */
export function useCurrentHost(): HostRecord {
  return useProjectHost(useCurrentProjectId());
}

/**
 * THE read-only gate. Whether a project's create and write controls work:
 * `false` while its own link cannot serve (offline, or a host that cannot
 * serve this app). Every write affordance reads this one hook, and every
 * submission re-checks {@link guardWrite}. Always `true` with the flag off,
 * with no host-store subscription.
 */
export function useCanWrite(projectId: string | null): boolean {
  const cloud = useCloudEnabled();
  return useHostRead(cloud, (state) => canWriteProject(state, projectId), true);
}

/** {@link useCanWrite}, read once outside React (a handler, a shortcut). */
export function canWriteNow(projectId: string | null): boolean {
  return !cloudOn() || canWriteProject(useHostConnectionStore.getState(), projectId);
}

/**
 * Why a project cannot be written to, in the Island's words ("Can't reach
 * hetzner-1 · Read-only"), or `null` when it can.
 */
export function readOnlyReason(projectId: string | null, now = Date.now()): string | null {
  if (canWriteNow(projectId)) return null;
  const state = useHostConnectionStore.getState();
  const host = hostOfProject(state, projectId);
  const view = { ...host, link: projectLinkOf(state, projectId) };
  // A blocking link always has words (offline or incompatible).
  return hostSurface(view, now)!.line;
}

/**
 * {@link readOnlyReason} for a form already open while its project goes
 * read-only, so it can say why it will not submit. `null` while it can write,
 * and always with the flag off (no host-store subscription then).
 */
export function useReadOnlyReason(projectId: string | null): string | null {
  const cloud = useCloudEnabled();
  // Keyed on the link object, so the words follow a change of state.
  const link = useHostRead(cloud, (state) => projectLinkOf(state, projectId), OPEN_LINK);
  return React.useMemo(
    () => (isBlocking(link) ? readOnlyReason(projectId) : null),
    [link, projectId],
  );
}

/**
 * The submission guard behind every disabled control: `true` when the write
 * may go. When it may not, says why (a toast with the read-only reason) and
 * answers `false`; the caller keeps whatever the person wrote. The link's own
 * `host-unreachable` refusal stays the backstop behind this.
 */
export function guardWrite(projectId: string | null): boolean {
  const reason = readOnlyReason(projectId);
  if (reason === null) return true;
  toast(reason, { id: "host-read-only" });
  return false;
}

/**
 * The mark a write control wears while it stands down: `data-host-read-only`,
 * greyed and desaturated as in the lab (globals.css). Nothing at all while it
 * can write, so the flag-off DOM is unchanged.
 */
export function readOnlyMark(canWrite: boolean): { "data-host-read-only"?: "" } {
  return canWrite ? {} : { "data-host-read-only": "" };
}

/** {@link readOnlyMark} plus `disabled`, for a control that is itself a button. */
export function readOnlyControl(canWrite: boolean): {
  disabled?: true;
  "data-host-read-only"?: "";
} {
  return canWrite ? {} : { disabled: true, "data-host-read-only": "" };
}

/** The current time, ticking every `intervalMs` while `active`. */
export function useNow(active: boolean, intervalMs = 1_000): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [active, intervalMs]);
  return now;
}

/**
 * A connection that drops for a second and comes back should never have said
 * anything. A graced surface waits out {@link HOST_RECONNECT_GRACE_MS} before
 * it shows; everything else shows at once, and leaves at once.
 */
export function useGrace(surface: HostSurface | null): HostSurface | null {
  const graced = surface?.graced === true;
  // Keyed by the words, so nothing but a new line restarts the grace.
  const key = surface?.line ?? null;
  const [elapsed, setElapsed] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!graced) return;
    const id = window.setTimeout(() => setElapsed(key), HOST_RECONNECT_GRACE_MS);
    return () => {
      window.clearTimeout(id);
      // The next graced surface waits again, even with the same words.
      setElapsed(null);
    };
  }, [key, graced]);
  if (surface === null || !surface.graced) return surface;
  return elapsed === key ? surface : null;
}

/**
 * Announces a remote host's recoveries — back after being unreachable, an
 * update landed — once, from wherever the chip is mounted.
 */
export function useHostRecoveryToasts(enabled: boolean): void {
  React.useEffect(() => {
    if (!enabled) return;
    let before = new Map(useHostConnectionStore.getState().hosts.map((host) => [host.id, host]));
    return useHostConnectionStore.subscribe((state) => {
      for (const host of state.hosts) {
        const previous = before.get(host.id);
        const announced = previous === undefined ? null : hostTransitionToast(previous, host);
        if (announced !== null) {
          toast.success(
            announced.title,
            announced.description === undefined
              ? undefined
              : { description: announced.description },
          );
        }
      }
      before = new Map(state.hosts.map((host) => [host.id, host]));
    });
  }, [enabled]);
}

/**
 * Whether the switcher offers "Add a host…": always, except when VC-700 has
 * registered its entry points and withheld Add (this Mac's hosts file is
 * read-only). Before anything registers, Add stays and says it is coming.
 */
export function useAddHostOffered(): boolean {
  return useHostConnectionStore(
    (state) => state.entryPoints.addHost !== null || state.entryPoints.manageHosts === null,
  );
}

/** "Add a host…": VC-700's sheet once it registers, a note until then. */
export function openAddHost(): void {
  const open = useHostConnectionStore.getState().entryPoints.addHost;
  if (open !== null) open();
  else toast("Adding a host isn’t in this build yet");
}

/** "Manage hosts…": Settings → Hosts once VC-700 registers it, a note until then. */
export function openManageHosts(): void {
  const open = useHostConnectionStore.getState().entryPoints.manageHosts;
  if (open !== null) open();
  else toast("Managing hosts isn’t in this build yet");
}

/** What a surface's one button does, for one host. */
export function runHostAction(action: HostSurfaceAction, host: HostRecord): void {
  const store = useHostConnectionStore.getState();
  switch (action.kind) {
    case "retry":
      store.retry(host.id);
      return;
    case "update-host":
      readdHostToUpdate(host.id);
      return;
    case "update-app":
      useUiStore.getState().setSettingsOpen(true, "updates");
      return;
    case "manage-hosts":
      openManageHosts();
      return;
    case "forget-project":
      void remoteHosts()
        .closeWorkspace(host.id, action.workspaceId)
        .catch((error: unknown) => {
          toast.error(
            error instanceof Error
              ? error.message
              : `Couldn’t forget this project on ${host.name}.`,
          );
        });
      return;
  }
}
