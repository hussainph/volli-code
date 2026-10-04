/** Staged Automations construction in the host's original boot order (VC-558). */
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { displayTicketId } from "@volli/shared";
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
import { createAutomationEngine, type AutomationEngine } from "./automations/engine";
import { createAutomationService, type AutomationServiceDeps } from "./automations/service";
import {
  createAutomationRunner,
  type AutomationRunnerDeps,
  type AutomationRunner,
} from "./automations/run";
import { createAutomationScheduler } from "./automations/scheduler";
import { createPendingArmedRunCoordinator } from "./automations/pending-armed-runs";
import { SqliteAutomationLedger } from "./automations/sqlite-ledger";
import { enabledAutomationIds } from "./automations/enablement";
import {
  advanceScheduleCursor,
  readScheduleCursors,
  rebaseScheduleCursor,
} from "./automations/schedule-cursor";
import type { HostCorePorts } from "./index";

type RunnerInputs = Omit<
  AutomationRunnerDeps,
  | "findAutomation"
  | "findRun"
  | "findTicket"
  | "findProject"
  | "listRunsForTicket"
  | "listProjectRunsForAutomation"
  | "onRunStarted"
>;

export function createHostAutomationServices(
  sessionDb: Database.Database | null,
  ports: Pick<HostCorePorts, "events">,
) {
  return {
    createEngine: () =>
      sessionDb === null
        ? null
        : createAutomationEngine({
            ledger: new SqliteAutomationLedger(sessionDb),
            now: Date.now,
            nextId: randomUUID,
          }),
    createService(
      engine: AutomationEngine | null,
      options: Pick<AutomationServiceDeps, "inspectModelAccess" | "onAutomationsChanged">,
    ) {
      if (sessionDb === null || engine === null) return null;
      return createAutomationService({
        engine,
        findProject: (projectId) => getProjectById(sessionDb, projectId) !== undefined,
        findAutomation: (automationId) => getAutomation(sessionDb, automationId),
        listAutomationsForProject: (projectId) => listAutomationsForProject(sessionDb, projectId),
        runsForTicket: (ticketId) => listRunsForTicket(sessionDb, ticketId),
        runsForProject: (projectId) => listRunsForProject(sessionDb, projectId),
        skipsForProject: (projectId) => listSkippedOccurrencesForProject(sessionDb, projectId),
        runsForAutomation: (input) => listProjectRunsForAutomation(sessionDb, input),
        skipsForAutomation: (input) => listSkippedOccurrencesForAutomation(sessionDb, input),
        ...options,
        onMutation: (change) => ports.events.publish("data-changed", change),
        // Create, enable, and schedule-changing commands establish the new
        // lifecycle before the scheduler's asynchronous refresh. Relaunch
        // can therefore still account for a due time missed in that gap.
        rebaseScheduleCursor: (automationId, through) => {
          rebaseScheduleCursor(sessionDb, { automationId, through }, Date.now());
        },
      });
    },
    createRunner(options: RunnerInputs) {
      if (sessionDb === null) return null;
      return createAutomationRunner({
        findAutomation: (automationId) => getAutomation(sessionDb, automationId),
        findRun: (runId) => getAutomationRun(sessionDb, runId),
        findTicket: (ticketId) => getTicket(sessionDb, ticketId),
        findProject: (projectId) => getProjectById(sessionDb, projectId) !== undefined,
        listRunsForTicket: (ticketId) => listRunsForTicket(sessionDb, ticketId),
        listProjectRunsForAutomation: (input) => listProjectRunsForAutomation(sessionDb, input),

        ...options,
        // A Run that names no Ticket (VC-130's schedule Target) OMITS the
        // property rather than sending `undefined` for it: the Electron
        // transport would carry that by structured clone, and an HTTP one
        // would mangle it (docs/BOUNDARIES.md rule 3).
        onRunStarted: ({ projectId, run }) =>
          ports.events.publish(
            "data-changed",
            run.ticketId === null ? { projectId } : { projectId, ticketId: run.ticketId },
          ),
      });
    },
    createPendingArmedRuns(runnerFor: () => AutomationRunner | null) {
      if (sessionDb === null) return null;
      const pendingDb = sessionDb;
      return createPendingArmedRunCoordinator({
        now: Date.now,
        nextId: randomUUID,
        listPending: () => listPendingArmedRuns(pendingDb),
        getPending: (id) => getPendingArmedRun(pendingDb, id),
        putPending: (pending) => putPendingArmedRun(pendingDb, pending),
        deletePending: (id) => deletePendingArmedRun(pendingDb, id),
        deletePendingForTicket: (ticketId) => deletePendingArmedRunForTicket(pendingDb, ticketId),
        beginAttempt: (id, commandId, fallbackError) =>
          beginPendingArmedRunAttempt(pendingDb, id, commandId, fallbackError),
        listAttempts: () => listPendingArmedRunAttempts(pendingDb),
        getAttempt: (id) => getPendingArmedRunAttempt(pendingDb, id),
        updateAttemptError: (id, error) => updatePendingArmedRunAttemptError(pendingDb, id, error),
        deleteAttempt: (id) => deletePendingArmedRunAttempt(pendingDb, id),
        readTicket: (ticketId) => {
          const row = getTicketRow(pendingDb, ticketId);
          if (row === undefined || row.archived_at !== null) return undefined;
          const ticket = getTicket(pendingDb, ticketId);
          const project = getProjectById(pendingDb, row.project_id);
          if (ticket === undefined || project === undefined) return undefined;
          return {
            projectId: ticket.projectId,
            status: ticket.status,
            displayId: displayTicketId(project.ticketPrefix, ticket.ticketNumber),
          };
        },
        readPlanning: (projectId) => ({
          automations: listAutomationsForProject(pendingDb, projectId),
          armings: listColumnArmings(pendingDb, projectId),
          enabledAutomationIds: enabledAutomationIds(pendingDb),
        }),
        run: async ({ commandId, automationId, ticketId }) => {
          const runner = runnerFor();
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
        onPendingChanged: (pending) => ports.events.publish("pending-armed-runs-changed", pending),
        onSettled: (notice) => ports.events.publish("pending-armed-run-settled", notice),
        log: (message) => console.error(message),
      });
    },
    createScheduler(scheduleEngine: AutomationEngine, runnerForSchedule: AutomationRunner) {
      if (sessionDb === null) return null;
      const scheduleDb = sessionDb;
      return createAutomationScheduler({
        now: Date.now,
        listAutomations: () => Promise.resolve(listAllAutomations(scheduleDb)),
        enabledAutomationIds: () => scheduleEngine.enabledAutomationIds(),
        readCursors: () => Promise.resolve(readScheduleCursors(scheduleDb)),
        advanceCursor: (input) => {
          advanceScheduleCursor(scheduleDb, input, Date.now());
          return Promise.resolve();
        },
        recordSkip: async (input) => {
          const outcome = await scheduleEngine.recordSkip(input);
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
          ports.events.publish("data-changed", { projectId: input.skip.projectId });
        },
        startRun: async (input) => {
          // UNATTENDED (VC-133), and this is the case VC-112 names outright:
          // "a column move is attended because a person is right there; a
          // schedule is not." A timer fired this; the app may not even have a
          // window open. If its Session stops for a person, this is how they
          // find out.
          const outcome = await runnerForSchedule.runForProject({
            ...input,
            attendance: "unattended",
          });
          return outcome.ok
            ? { ok: true }
            : { ok: false, code: outcome.code, error: outcome.error };
        },
        setTimer: (delayMs, fire) => setTimeout(fire, delayMs),
        clearTimer: (handle) => {
          clearTimeout(handle);
        },
      });
    },
  };
}
export type HostAutomationServices = ReturnType<typeof createHostAutomationServices>;
