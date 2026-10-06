/**
 * The hooks every host surface reads through (VC-576). Each answers "nothing
 * to show" while the `cloud` flag is off, so a surface gated here cannot draw
 * for a person without the flag.
 */
import * as React from "react";
import { toast } from "sonner";

import { isExperimentOn, useExperimentsStore } from "@renderer/stores/experiments";
import {
  hostOfProject,
  isBlocking,
  useHostConnectionStore,
  type HostRecord,
} from "@renderer/stores/host-connection";
import { useProjectsStore } from "@renderer/stores/projects";
import { useUiStore } from "@renderer/stores/ui";

import {
  HOST_RECONNECT_GRACE_MS,
  hostTransitionToast,
  type HostSurface,
  type HostSurfaceAction,
} from "./host-surface-model";

/** Whether the `cloud` experiment is on. Off until the host has answered. */
export function useCloudEnabled(): boolean {
  return useExperimentsStore((state) => isExperimentOn(state.snapshot, "cloud"));
}

/** The host a project runs on (This Mac for `null`, or for a project nobody claims). */
export function useProjectHost(projectId: string | null): HostRecord {
  return useHostConnectionStore((state) => hostOfProject(state, projectId));
}

/** The host of the project in front of the person. */
export function useCurrentHost(): HostRecord {
  const projectId = useProjectsStore((state) => state.selectedProjectId);
  return useProjectHost(projectId);
}

/**
 * Whether a project's host cannot serve, so its create and write controls
 * stand down. Always `false` with the flag off.
 */
export function useHostReadOnly(projectId: string | null): boolean {
  const cloud = useCloudEnabled();
  const blocking = useHostConnectionStore((state) =>
    isBlocking(hostOfProject(state, projectId).link),
  );
  return cloud && blocking;
}

/** {@link useHostReadOnly}, read once outside React (a keyboard shortcut's handler). */
export function isHostReadOnly(projectId: string | null): boolean {
  return (
    isExperimentOn(useExperimentsStore.getState().snapshot, "cloud") &&
    isBlocking(hostOfProject(useHostConnectionStore.getState(), projectId).link)
  );
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
      store.updateHost(host.id, "now");
      return;
    case "update-app":
      useUiStore.getState().setSettingsOpen(true, "updates");
      return;
    case "manage-hosts":
      openManageHosts();
      return;
  }
}
