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
import {
  HOST_HANDLER_KEYS,
  type DataChangedEvent,
  type HandlerCall,
  type HostHandlerKey,
  type NotificationRequest,
  type TicketMovedNotice,
} from "@volli/shared";

import type { DetachedWorkPort } from "../detached-work";
import {
  sealHostHandlers,
  type AdmissionObserver,
  type HostHandlerMap,
} from "../handlers/handler-map";
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
  /** Sees every policy verdict at the map, before the handler it admits. */
  readonly onAdmission?: AdmissionObserver;
  /**
   * Builds the Done trim's worktree bundle the way production does
   * (`worktreeDeps`), with attachments under this data directory, instead
   * of the test's `git`/`gitAsync` bundle.
   */
  readonly productionWorktree?: { readonly dataDir: string };
}

/**
 * The host's handler map with no Session runtime, Model Access or
 * experiments (those handlers answer unavailable), and the board's effects
 * routed to the test's callbacks.
 */
export function testHostHandlers(ports: TestHandlerPorts): HostHandlerMap {
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
    dataDir: ports.productionWorktree?.dataDir ?? "",
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
    ...(ports.onAdmission === undefined ? {} : { onAdmission: ports.onAdmission }),
    ...(ports.productionWorktree === undefined
      ? {
          worktree: {
            db: ports.db,
            git: ports.git ?? runGitCapturing,
            gitAsync: ports.gitAsync ?? runGitCapturingAsync,
            blobsRoot: "",
          },
        }
      : {}),
  });
}

/** A test's stand-in for some entries; called the way a door calls the real one. */
export type TestHandlerEntries = {
  readonly [Key in HostHandlerKey]?: (input: never, call: HandlerCall, ...rest: never[]) => unknown;
};

/**
 * A sealed map over a test's own entries, so a door under test reaches them
 * exactly as it reaches the host's: through its policy. An entry the test
 * left out throws if a door calls it.
 */
export function sealTestHandlers(
  entries: TestHandlerEntries,
  onAdmission?: AdmissionObserver,
): HostHandlerMap {
  const total: Record<string, unknown> = {};
  for (const key of HOST_HANDLER_KEYS) {
    total[key] =
      entries[key] ??
      (() => {
        throw new Error(`This test states no ${key} handler.`);
      });
  }
  return sealHostHandlers(total as unknown as HostHandlers, onAdmission);
}
