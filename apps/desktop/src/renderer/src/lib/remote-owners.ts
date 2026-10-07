/**
 * Which projects this window has known to be on a remote host (VC-713, review
 * B1), kept for the window's life whatever the host's link does next.
 *
 * Routing reads this, not the host source's current claim: a claim goes away
 * when a Workspace is forgotten, a host drops out or `cloud` turns off, and a
 * Session minted on a box must never then be read, attached or commanded
 * over This Mac's IPC. A project known remote whose Workspace is not bound
 * now fails closed ("<host> isn't connected"); only a project never seen on a
 * remote host is This Mac's. The binding records every remote claim it sees
 * (`remote-sessions.ts`); with `cloud` never on, nothing is recorded and every
 * project is This Mac's, exactly as before.
 */

/** The remote host a project was last claimed by. */
export interface RemoteOwner {
  readonly hostId: string;
  readonly hostName: string;
}

const owners = new Map<string, RemoteOwner>();

/** Records (or renames) a remote project's owner. */
export function rememberRemoteProject(projectId: string, owner: RemoteOwner): void {
  const known = owners.get(projectId);
  if (known?.hostId === owner.hostId && known.hostName === owner.hostName) return;
  owners.set(projectId, owner);
}

/** The remote owner of a project this window has seen on a host, or `null` for This Mac's. */
export function remoteOwnerOf(projectId: string | null): RemoteOwner | null {
  return projectId === null ? null : (owners.get(projectId) ?? null);
}

/** What a known-remote project's Sessions say while its Workspace is not bound here. */
export function hostNotConnected(hostName: string): string {
  return `${hostName} isn’t connected`;
}

/** TEST-ONLY: forgets every owner, between cases. */
export function resetRemoteOwnersForTest(): void {
  owners.clear();
}
