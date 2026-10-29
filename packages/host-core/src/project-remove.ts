/**
 * Removing a project from the host (VC-796, VC-822).
 *
 * Removal DETACHES the project: the row stays with a `removed_at` stamp, and
 * so do its tickets, comments, Automations and every Session with its whole
 * history. Every listing stops returning it, nothing starts new work in it,
 * and adding the same folder again re-attaches it (`project-create.ts`). The
 * foreign-key cascades are unchanged; removal no longer reaches them.
 *
 * The work its Sessions are doing still has to stop: a structured turn left
 * running would keep spending and acting in a folder the person just took off
 * the rail, and a shell, a terminal or a tab left open is a process or a page
 * nothing in the product names any more.
 *
 * The order is the whole module, and each step is a port a test can watch:
 *
 * 1. stop the live work rooted in the project: its Sessions' structured
 *    bindings, background shells and terminals, its Browser Tabs, and the MCP
 *    sign-ins still in flight for its servers;
 * 2. detach the row;
 * 3. forget the credentials its MCP servers held: no screen shows a removed
 *    project's servers, so nobody would think to revoke them. A re-attached
 *    project's servers ask to sign in again;
 * 4. end the project's board feed;
 * 5. tell every window, so a second one drops the project too.
 *
 * A binding that will not close refuses the removal before anything else is
 * stopped or detached: the person can stop that Session and try again. So
 * does a project a move froze (VC-993), asked before the release and again
 * after it, since the release awaits.
 */
import type Database from "better-sqlite3";

import { assertProjectWritable } from "./cloud-move/freeze";
import { detachProject, isProjectAttached, listProjectSessionIds } from "./db/projects-repo";
import { releaseAgentSessions, type AgentSiteRuntime } from "./worktree/agent-sites";

/** What a release left bound, by Session id. */
export interface ProjectBindingRelease {
  readonly stillOpen: readonly string[];
}

/**
 * The live work a host holds for a project's Sessions, as one removal stops
 * it. Every member but {@link releaseBindings} is synchronous and best-effort:
 * a process that ignores its signal is the host's to finish killing, and must
 * not make a project unremovable.
 */
export interface ProjectLiveWork {
  /** Ends every structured binding these Sessions hold (`adapter.release`). */
  releaseBindings(sessionIds: ReadonlySet<string>): Promise<ProjectBindingRelease>;
  /** Kills the background shells these Sessions started. */
  disposeShells(sessionIds: ReadonlySet<string>): void;
  /** Kills these Sessions' terminals, whichever window holds them. */
  killTerminals(sessionIds: ReadonlySet<string>): void;
  /** Closes every Browser Tab of the project, the person's own included. */
  closeBrowserTabs(projectId: string): void;
  /**
   * The project's MCP servers: `disconnect` ends their in-flight sign-ins and
   * names them; `forget` drops their stored credentials once it is detached.
   */
  readonly mcp: {
    disconnect(projectId: string): readonly string[];
    forget(serverIds: readonly string[]): void;
  } | null;
}

export interface ProjectRemovalPorts {
  readonly db: Database.Database;
  readonly live: ProjectLiveWork;
  /** Ends the project's board feed: its followers are told to resnapshot. */
  disposeFeed(projectId: string): void;
  /** Tells every window the project list changed. */
  announce(): void;
  /** Stamps `removed_at`; defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * Raised when a Session of the project is still running after the stop: its
 * binding would not close, or it started while the others were stopping.
 */
export class ProjectRemovalRefused extends Error {
  constructor(readonly stillOpen: readonly string[]) {
    super(
      stillOpen.length === 1
        ? "A Session in this project is still running, so nothing was removed. Stop it and try again."
        : `${stillOpen.length} Sessions in this project are still running, so nothing was removed. Stop them and try again.`,
    );
    this.name = "ProjectRemovalRefused";
  }
}

/**
 * Removes one project from the rail, its live work stopped first. An id no
 * project on the rail has (unknown, or already removed) is a no-op: there is
 * nothing to stop and nothing to tell.
 */
export async function removeProject(ports: ProjectRemovalPorts, projectId: string): Promise<void> {
  if (!isProjectAttached(ports.db, projectId)) return;
  // A project moving to Volli Cloud stays on the rail until its move settles (VC-993).
  assertProjectWritable(ports.db, projectId);
  const sessionIds = new Set(listProjectSessionIds(ports.db, projectId));

  const { stillOpen } = await ports.live.releaseBindings(sessionIds);
  if (stillOpen.length > 0) throw new ProjectRemovalRefused(stillOpen);
  // The release awaited: a Session started meanwhile was not released, and
  // would be left running in a project nobody can see. From here to the
  // detach nothing awaits, so this is the last such gap.
  const started = listProjectSessionIds(ports.db, projectId).filter((id) => !sessionIds.has(id));
  if (started.length > 0) throw new ProjectRemovalRefused(started);
  // The freeze again, for the same gap: a project whose Sessions were just
  // released is idle, and an idle project is exactly what a move freezes.
  assertProjectWritable(ports.db, projectId);
  ports.live.disposeShells(sessionIds);
  ports.live.killTerminals(sessionIds);
  ports.live.closeBrowserTabs(projectId);
  const serverIds = ports.live.mcp?.disconnect(projectId) ?? [];

  detachProject(ports.db, projectId, (ports.now ?? Date.now)());

  ports.live.mcp?.forget(serverIds);
  ports.disposeFeed(projectId);
  ports.announce();
}

/** The host services a project's live work is held in, as {@link hostProjectLiveWork} reads them. */
export interface ProjectLiveWorkSources {
  /** The structured runtime, or null on a launch without one. Read at removal time. */
  runtime(): AgentSiteRuntime | null;
  readonly shells: { disposeSession(sessionId: string): void };
  /** The terminal supervisor, or null before it exists. Read at removal time. */
  terminals(): { killSessions(sessionIds: ReadonlySet<string>): unknown } | null;
  readonly browser: {
    list(scope: { projectId: string }): readonly { tabId: string }[];
    close(tabId: string): void;
  } | null;
  readonly mcp: {
    disconnectProject(projectId: string): readonly string[];
    forgetRemovedServers(serverIds: readonly string[]): void;
  } | null;
  newCommandId(): string;
  /** A release that threw; the binding is then reported still open, and the removal refused. */
  onReleaseError(sessionId: string, error: unknown): void;
}

/** A host's {@link ProjectLiveWork}, over the services that hold it. */
export function hostProjectLiveWork(sources: ProjectLiveWorkSources): ProjectLiveWork {
  const { browser, mcp } = sources;
  return {
    releaseBindings: async (sessionIds) => {
      const runtime = sources.runtime();
      if (runtime === null) return { stillOpen: [] };
      return releaseAgentSessions(runtime, sessionIds, {
        newCommandId: () => sources.newCommandId(),
        onError: (sessionId, error) => sources.onReleaseError(sessionId, error),
      });
    },
    disposeShells: (sessionIds) => {
      for (const sessionId of sessionIds) sources.shells.disposeSession(sessionId);
    },
    killTerminals: (sessionIds) => {
      sources.terminals()?.killSessions(sessionIds);
    },
    closeBrowserTabs: (projectId) => {
      if (browser === null) return;
      for (const { tabId } of browser.list({ projectId })) browser.close(tabId);
    },
    mcp:
      mcp === null
        ? null
        : {
            disconnect: (projectId) => mcp.disconnectProject(projectId),
            forget: (serverIds) => mcp.forgetRemovedServers(serverIds),
          },
  };
}
