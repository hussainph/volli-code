/**
 * Test support: the host's REAL handler map over a test database, with the
 * effects a test wants to observe stated as plain callbacks (VC-668).
 *
 * The socket tests drove `ticket.move` through the per-move ports the agent
 * service used to take (`busyWorktreeSites`, `interruptTicketSessions`,
 * `onDeliberateMove`, `notify`, `onMutation`, `detachedWork`, `git`). The move
 * now belongs to the handler map, so this builds that map from the same
 * callbacks: a test still states only what it observes, and every door it
 * drives reaches the one production handler.
 */
import type Database from "better-sqlite3";
import type { DataChangedEvent, NotificationRequest, TicketMovedNotice } from "@volli/shared";

import type { DetachedWorkPort } from "../detached-work";
import { createHostHandlers, type HostHandlers } from "../handlers/host-handlers";
import type { RuntimeAutomations } from "../session-runtime/automations";
import type { HostSessionPorts } from "../session-services";
import { runGitCapturing, runGitCapturingAsync, type RunGit, type RunGitAsync } from "../worktree";
import type { BusyWorktreeSites } from "../worktree/activity";

/** What a test may observe or substitute around a command. */
export interface TestHandlerPorts {
  readonly db: Database.Database;
  readonly busyWorktreeSites?: BusyWorktreeSites;
  readonly interruptTicketSessions?: (ticketId: string) => string[] | Promise<string[]>;
  readonly onDeliberateMove?: (notice: TicketMovedNotice) => void;
  readonly notify?: (request: NotificationRequest) => unknown;
  readonly onMutation?: (change: Omit<DataChangedEvent, "entity">) => void;
  readonly detachedWork?: DetachedWorkPort;
  readonly git?: RunGit;
  readonly gitAsync?: RunGitAsync;
  readonly now?: () => number;
}

/**
 * The host's handler map with no Session runtime, Model Access or
 * experiments (those handlers answer unavailable), and the board's effects
 * routed to the test's callbacks.
 */
export function testHostHandlers(ports: TestHandlerPorts): HostHandlers {
  const hostPorts = {
    events: {
      publish: (topic: string, payload: unknown) => {
        if (topic === "data-changed")
          ports.onMutation?.(payload as Omit<DataChangedEvent, "entity">);
      },
    },
    attention: {
      deliver: (request: NotificationRequest) => {
        ports.notify?.(request);
        return { delivered: true };
      },
      focusedSessionIds: () => new Set<string>(),
    },
  } as unknown as Pick<HostSessionPorts, "events" | "attention">;
  const automations = {
    kind: "live",
    execution: {
      kind: "unavailable",
      pendingArmedRuns: {
        noteDeliberateMove: (notice: TicketMovedNotice) => ports.onDeliberateMove?.(notice),
      },
    },
  } as unknown as RuntimeAutomations;
  return createHostHandlers(hostPorts, {
    db: ports.db,
    dataDir: "",
    runtime: null,
    sessions: null,
    modelAccess: null,
    experiments: null,
    automations,
    busyWorktreeSites: ports.busyWorktreeSites ?? (async () => []),
    ...(ports.interruptTicketSessions === undefined
      ? {}
      : { interruptTicketSessions: ports.interruptTicketSessions }),
    ...(ports.detachedWork === undefined ? {} : { detachedWork: ports.detachedWork }),
    ...(ports.now === undefined ? {} : { now: ports.now }),
    worktree: {
      db: ports.db,
      git: ports.git ?? runGitCapturing,
      gitAsync: ports.gitAsync ?? runGitCapturingAsync,
      blobsRoot: "",
    },
  });
}
