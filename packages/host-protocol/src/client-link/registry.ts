/**
 * One link per Workspace (VC-670): the registry a Client holds, so every
 * store that reaches a Workspace shares its one socket, and a wake reaches
 * every link at once.
 */
import type { WorkspaceId } from "../identity";
import type { HostLink, HostLinkWakeCause } from "./link";

export interface HostLinkRegistry {
  /** The Workspace's link, created on first use (and again after it was closed). */
  link(workspaceId: WorkspaceId): HostLink;
  /** Every open link hears it: the desktop wires `powerMonitor` resume and `online` here. */
  wake(cause: HostLinkWakeCause): void;
  /** Closes and forgets one Workspace's link. */
  close(workspaceId: WorkspaceId): void;
  closeAll(): void;
}

export function createHostLinkRegistry(
  create: (workspaceId: WorkspaceId) => HostLink,
): HostLinkRegistry {
  const links = new Map<WorkspaceId, HostLink>();
  return {
    link(workspaceId) {
      const existing = links.get(workspaceId);
      if (existing !== undefined && existing.getState().status !== "closed") return existing;
      const created = create(workspaceId);
      links.set(workspaceId, created);
      return created;
    },
    wake(cause) {
      for (const link of links.values()) link.wake(cause);
    },
    close(workspaceId) {
      links.get(workspaceId)?.close();
      links.delete(workspaceId);
    },
    closeAll() {
      for (const link of links.values()) link.close();
      links.clear();
    },
  };
}
