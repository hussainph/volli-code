/**
 * The host's Automations, one live-database module composed once (VC-627).
 *
 * Construction builds the engine and the CRUD service, so a client can read
 * and edit Automations before any Session recovers. {@link HostAutomations.start}
 * arms the rest at the host's ready point, in its original boot order: the
 * pending armed Runs first, then the runner's recovery, then the scheduler.
 * {@link HostAutomations.stop} disarms both timers. There is no degraded form
 * here: a host without a database never builds this module.
 */
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { displayTicketId } from "@volli/shared";
import type { Logger } from "./log/logger";
import { hostLogger } from "./log/root";
import { getProjectById } from "./db/projects-repo";
import { getTicket, getTicketRow } from "./db/tickets-repo";
import {
  getAutomation,
  getAutomationRun,
  listAllAutomations,
  listAutomationsForProject,
  listColumnArmings,
  listProjectRunsForAutomation,
  listRunsForProject,
  listRunsForTicket,
  listSkippedOccurrencesForAutomation,
  listSkippedOccurrencesForProject,
} from "./db/automations-repo";
import {
  beginPendingArmedRunAttempt,
  deletePendingArmedRun,
  deletePendingArmedRunAttempt,
  deletePendingArmedRunForTicket,
  getPendingArmedRun,
  getPendingArmedRunAttempt,
  listPendingArmedRunAttempts,
  listPendingArmedRuns,
  putPendingArmedRun,
  updatePendingArmedRunAttemptError,
} from "./db/pending-armed-runs-repo";
import { createAutomationEngine } from "./automations/engine";
import {
  createAutomationService,
  type AutomationService,
  type AutomationServicePorts,
} from "./automations/service";
import {
  createAutomationRunner,
  type AutomationRunnerPorts,
  type AutomationRunner,
} from "./automations/run";
import { createAutomationScheduler, type AutomationScheduler } from "./automations/scheduler";
import {
  createPendingArmedRunCoordinator,
  type PendingArmedRunCoordinator,
} from "./automations/pending-armed-runs";
import { SqliteAutomationLedger } from "./automations/sqlite-ledger";
import { enabledAutomationIds } from "./automations/enablement";
import {
  advanceScheduleCursor,
  readScheduleCursors,
  rebaseScheduleCursor,
} from "./automations/schedule-cursor";
import type { HostEventBus } from "./ports/events";

/** Armed countdowns run detached; their failures are written here, never surfaced. */
const armedLog = hostLogger("armed-runs");

/** What the module is built from: a live database and the host's own ports. */
export interface HostAutomationsInput {
  readonly db: Database.Database;
  readonly events: HostEventBus;
  /** Where a failed recovery or scheduler start is reported; neither is surfaced. */
  readonly log: Pick<Logger, "error">;
  /** Present only when a model host booted; the service checks runtime pins with it. */
  readonly inspectModelAccess?: AutomationServicePorts["inspectModelAccess"];
}

/**
 * The Session side of a Run, supplied by the recovered Session runtime. The
 * ledger reads, the engine and the start notice are this module's own.
 */
export type AutomationSessionPorts = Omit<
  AutomationRunnerPorts,
  | "engine"
  | "findAutomation"
  | "findRun"
  | "findTicket"
  | "findProject"
  | "listRunsForTicket"
  | "listProjectRunsForAutomation"
  | "onRunStarted"
>;

export type HostAutomationExecution =
  | { readonly kind: "idle" }
  | { readonly kind: "unavailable"; readonly pendingArmedRuns: PendingArmedRunCoordinator }
  | {
      readonly kind: "ready";
      readonly runner: AutomationRunner;
      readonly pendingArmedRuns: PendingArmedRunCoordinator;
    };

export interface HostAutomations {
  /** CRUD over the ledger, live from construction. */
  readonly service: AutomationService;
  /** A ready runner is never nullable; pre-ready/unavailable are explicit variants. */
  readonly execution: HostAutomationExecution;
  /**
   * Arms the module once, at the host's ready point. `sessionPorts` is read
   * only when this call is the one that starts, so a caller may validate its
   * recovery proof inside it; it returns null when no Session runtime booted,
   * which arms the pending armed Runs alone. Later calls, and any call after
   * {@link stop}, do nothing.
   */
  start(sessionPorts: () => AutomationSessionPorts | null): void;
  /** Disarms the pending armed Runs and the scheduler; refuses any later start. */
  stop(): void;
  /** Joins recovery, timer attempts and Run boots after stop, before SQLite closes. */
  settled(): Promise<void>;
}

export function createHostAutomations(input: HostAutomationsInput): HostAutomations {
  const { db, events, log } = input;
  const engine = createAutomationEngine({
    ledger: new SqliteAutomationLedger(db),
    now: Date.now,
    nextId: randomUUID,
  });
  let runner: AutomationRunner | null = null;
  let pending: PendingArmedRunCoordinator | null = null;
  let scheduler: AutomationScheduler | null = null;
  let started = false;
  let stopped = false;
  let execution: HostAutomationExecution = { kind: "idle" };
  let recovery = Promise.resolve();

  const service = createAutomationService({
    engine,
    findProject: (projectId) => getProjectById(db, projectId) !== undefined,
    findAutomation: (automationId) => getAutomation(db, automationId),
    listAutomationsForProject: (projectId) => listAutomationsForProject(db, projectId),
    runsForTicket: (ticketId) => listRunsForTicket(db, ticketId),
    runsForProject: (projectId) => listRunsForProject(db, projectId),
    skipsForProject: (projectId) => listSkippedOccurrencesForProject(db, projectId),
    runsForAutomation: (query) => listProjectRunsForAutomation(db, query),
    skipsForAutomation: (query) => listSkippedOccurrencesForAutomation(db, query),
    ...(input.inspectModelAccess === undefined
      ? {}
      : { inspectModelAccess: input.inspectModelAccess }),
    onAutomationsChanged: () => {
      void scheduler?.refresh();
    },
    onMutation: (change) => events.publish("data-changed", change),
    // Create, enable, and schedule-changing commands establish the new
    // lifecycle before the scheduler's asynchronous refresh. Relaunch
    // can therefore still account for a due time missed in that gap.
    rebaseScheduleCursor: (automationId, through) => {
      rebaseScheduleCursor(db, { automationId, through }, Date.now());
    },
  });

  function createRunner(ports: AutomationSessionPorts): AutomationRunner {
    return createAutomationRunner({
      engine,
      findAutomation: (automationId) => getAutomation(db, automationId),
      findRun: (runId) => getAutomationRun(db, runId),
      findTicket: (ticketId) => getTicket(db, ticketId),
      findProject: (projectId) => getProjectById(db, projectId) !== undefined,
      listRunsForTicket: (ticketId) => listRunsForTicket(db, ticketId),
      listProjectRunsForAutomation: (query) => listProjectRunsForAutomation(db, query),
      ...ports,
      // A Run that names no Ticket (VC-130's schedule Target) OMITS the
      // property rather than sending `undefined` for it: the Electron
      // transport would carry that by structured clone, and an HTTP one
      // would mangle it (docs/BOUNDARIES.md rule 3).
      onRunStarted: ({ projectId, run }) =>
        events.publish(
          "data-changed",
          run.ticketId === null ? { projectId } : { projectId, ticketId: run.ticketId },
        ),
    });
  }

  function createPendingArmedRuns(): PendingArmedRunCoordinator {
    return createPendingArmedRunCoordinator({
      now: Date.now,
      nextId: randomUUID,
      listPending: () => listPendingArmedRuns(db),
      getPending: (id) => getPendingArmedRun(db, id),
      putPending: (armed) => putPendingArmedRun(db, armed),
      deletePending: (id) => deletePendingArmedRun(db, id),
      deletePendingForTicket: (ticketId) => deletePendingArmedRunForTicket(db, ticketId),
      beginAttempt: (id, commandId, fallbackError) =>
        beginPendingArmedRunAttempt(db, id, commandId, fallbackError),
      listAttempts: () => listPendingArmedRunAttempts(db),
      getAttempt: (id) => getPendingArmedRunAttempt(db, id),
      updateAttemptError: (id, error) => updatePendingArmedRunAttemptError(db, id, error),
      deleteAttempt: (id) => deletePendingArmedRunAttempt(db, id),
      readTicket: (ticketId) => {
        const row = getTicketRow(db, ticketId);
        if (row === undefined || row.archived_at !== null) return undefined;
        const ticket = getTicket(db, ticketId);
        const project = getProjectById(db, row.project_id);
        if (ticket === undefined || project === undefined) return undefined;
        return {
          projectId: ticket.projectId,
          status: ticket.status,
          displayId: displayTicketId(project.ticketPrefix, ticket.ticketNumber),
        };
      },
      readPlanning: (projectId) => ({
        automations: listAutomationsForProject(db, projectId),
        armings: listColumnArmings(db, projectId),
        enabledAutomationIds: enabledAutomationIds(db),
      }),
      run: async ({ commandId, automationId, ticketId }) => {
        if (runner === null) {
          return {
            ok: false,
            code: "RUN_FAILED",
            error: "The Session runtime is not available this launch.",
          };
        }
        // A Deliberate column move retains the attended semantics its renderer
        // expiry door had. Only ownership of the timer moved into main.
        return runner.run({
          commandId,
          target: { kind: "automation", automationId },
          ticketId,
          modelOverride: null,
          attendance: "attended",
        });
      },
      setTimer: (delayMs, fire) => setTimeout(fire, delayMs),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      onPendingChanged: (armed) => events.publish("pending-armed-runs-changed", armed),
      onSettled: (notice) => events.publish("pending-armed-run-settled", notice),
      log: armedLog.error,
    });
  }

  function createScheduler(scheduleRunner: AutomationRunner): AutomationScheduler {
    return createAutomationScheduler({
      now: Date.now,
      listAutomations: () => Promise.resolve(listAllAutomations(db)),
      enabledAutomationIds: () => engine.enabledAutomationIds(),
      readCursors: () => Promise.resolve(readScheduleCursors(db)),
      advanceCursor: (cursor) => {
        advanceScheduleCursor(db, cursor, Date.now());
        return Promise.resolve();
      },
      recordSkip: async (skip) => {
        const outcome = await engine.recordSkip(skip);
        if (!outcome.ok) {
          // Fail the step rather than resolving over it. The scheduler advances
          // its cursor only after a step settles, so a refused write leaves the
          // occurrence owed and the next pass records it again under the same
          // derived command id. Swallowing it here would step past a skip that
          // never reached the ledger — a skip that looks exactly like a
          // silence, which is the one outcome VC-112 forbids.
          throw new Error(outcome.error);
        }
        // The Automations page reads its history on arrival and on every
        // planning change, so a skip recorded while it is open lands without
        // anyone reloading.
        events.publish("data-changed", { projectId: skip.skip.projectId });
      },
      startRun: async (request) => {
        // UNATTENDED (VC-133), and this is the case VC-112 names outright:
        // "a column move is attended because a person is right there; a
        // schedule is not." A timer fired this; the app may not even have a
        // window open. If its Session stops for a person, this is how they
        // find out.
        const outcome = await scheduleRunner.runForProject({
          ...request,
          attendance: "unattended",
        });
        return outcome.ok ? { ok: true } : { ok: false, code: outcome.code, error: outcome.error };
      },
      setTimer: (delayMs, fire) => setTimeout(fire, delayMs),
      clearTimer: (handle) => {
        clearTimeout(handle);
      },
    });
  }

  return {
    service,
    get execution() {
      return execution;
    },
    start(sessionPorts) {
      if (started || stopped) return;
      const ports = sessionPorts();
      started = true;
      const armedRunner = ports === null ? null : createRunner(ports);
      runner = armedRunner;
      pending = createPendingArmedRuns();
      pending.start();
      execution =
        armedRunner === null
          ? { kind: "unavailable", pendingArmedRuns: pending }
          : { kind: "ready", runner: armedRunner, pendingArmedRuns: pending };
      if (armedRunner === null) return;
      recovery = armedRunner
        .recover()
        .catch((error: unknown) => log.error("automation recovery failed", { error }));
      scheduler = createScheduler(armedRunner);
      void scheduler
        .start()
        .catch((error: unknown) => log.error("automation scheduler could not start", { error }));
    },
    stop() {
      stopped = true;
      pending?.stop();
      scheduler?.stop();
    },
    async settled() {
      // Recovery can enqueue Run boots; timer attempts can do so too. Join
      // their producers first, then the runner's final in-flight snapshot.
      try {
        await Promise.all([recovery, pending?.settled(), scheduler?.settled()]);
      } finally {
        await runner?.settled();
      }
    },
  };
}
