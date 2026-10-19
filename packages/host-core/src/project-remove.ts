/**
 * Removing a project from the host (VC-796).
 *
 * The delete is one statement, and it cascades: every Session of the project
 * and its whole event history go with the row (`sessions.project_id` and
 * `session_events.session_id` are `ON DELETE CASCADE`). So the work those
 * Sessions are doing has to stop FIRST. A structured turn left running past
 * the delete keeps spending and keeps acting in the folder while every append
 * it makes fails the foreign key; a shell, a terminal or a tab left open is a
 * process or a page nothing in the product names any more.
 *
 * The order is the whole module, and each step is a port a test can watch:
 *
 * 1. stop the live work rooted in the project: its Sessions' structured
 *    bindings, background shells and terminals, its Browser Tabs, and the MCP
 *    sign-ins still in flight for its servers;
 * 2. delete the row;
 * 3. forget the credentials the cascaded MCP servers held;
 * 4. end the project's board feed;
 * 5. tell every window, so a second one drops the project too.
 *
 * A binding that will not close refuses the removal before anything else is
 * stopped or deleted: deleting a Session's history under a turn that is still
 * running is the defect, and the person can stop that Session and try again.
 *
 * The cascade itself is unchanged here: what a removal keeps is a separate
 * decision.
 */
import type Database from "better-sqlite3";

import { deleteProject, getProjectById, listProjectSessionIds } from "./db/projects-repo";
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
   * names them; `forget` drops their stored credentials after the delete.
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
 * Removes one project, its live work stopped first. An id no project has is a
 * no-op: there is nothing to stop and nothing to tell.
 */
export async function removeProject(ports: ProjectRemovalPorts, projectId: string): Promise<void> {
  if (getProjectById(ports.db, projectId) === undefined) return;
  const sessionIds = new Set(listProjectSessionIds(ports.db, projectId));

  const { stillOpen } = await ports.live.releaseBindings(sessionIds);
  if (stillOpen.length > 0) throw new ProjectRemovalRefused(stillOpen);
  // The release awaited: a Session started meanwhile was not released, and
  // the cascade would take its history from under it. From here to the
  // delete nothing awaits, so this is the last such gap.
  const started = listProjectSessionIds(ports.db, projectId).filter((id) => !sessionIds.has(id));
  if (started.length > 0) throw new ProjectRemovalRefused(started);
  ports.live.disposeShells(sessionIds);
  ports.live.killTerminals(sessionIds);
  ports.live.closeBrowserTabs(projectId);
  const serverIds = ports.live.mcp?.disconnect(projectId) ?? [];

  deleteProject(ports.db, projectId);

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
