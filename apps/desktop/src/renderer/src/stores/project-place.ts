/**
 * Which product store this launch shows, and where each project's board lives
 * (VC-889): the renderer's half of the launch main chose before the window
 * opened (`cloud.launch`, read once at boot and fixed for the process).
 *
 * - **A cloud launch** shows the signed-in person's Volli Cloud Workspace:
 *   every project is `cloud`, and its board comes from the backend through the
 *   window's own client.
 * - **A local launch** shows this Mac's projects: `local`, through this Mac's
 *   database as always, except a project a remote host serves (VC-711, flag
 *   on, until that host model is retired), which is `remote-host`.
 *
 * Nothing hot-swaps: signing in or out relaunches the app.
 */
import { launchStore } from "./launch";
import { remoteHostNow, useRemoteProjectHost } from "./remote-project";

export type ProjectPlace = "local" | "remote-host" | "cloud";

/** Where a project's board lives now, read once outside React. */
export function projectPlaceNow(projectId: string | null | undefined): ProjectPlace {
  if (launchStore() === "cloud") return "cloud";
  return remoteHostNow(projectId) === null ? "local" : "remote-host";
}

/**
 * {@link projectPlaceNow} for a component. The launch never changes after
 * boot, so the branch is fixed for the life of the window; a local launch
 * with the flag off holds no host-store subscription.
 */
export function useProjectPlace(projectId: string | null): ProjectPlace {
  const remote = useRemoteProjectHost(projectId);
  if (launchStore() === "cloud") return "cloud";
  return remote === null ? "local" : "remote-host";
}
