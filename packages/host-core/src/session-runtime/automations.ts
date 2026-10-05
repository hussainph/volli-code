/**
 * Automations over the ready Session facade, never a second engine (VC-622).
 *
 * The host's Automations are one live-database module (`../automation-services`)
 * composed here once. Its Session side — prompt supply, instruction delivery,
 * activity reads and title refinement — is mapped from the lifecycle's
 * recovered services, and only from an issued recovery proof. A host whose
 * database did not open gets the degraded variant instead: no service, no
 * runner and no timers, chosen once at construction.
 */
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { HostedSessionRuntime } from "@volli/session-engine";
import {
  applySkillModes,
  globalSkillsDir,
  projectCommandsDir,
  projectSkillsDir,
  skillResourcePart,
} from "@volli/shared";
import type { DbHandle } from "../index";
import type { HostEventBus } from "../ports/events";
import { getProjectById } from "../db/projects-repo";
import { loadPromptTemplates } from "../prompt-templates";
import { loadSkills } from "../skills";
import { chatSessionRecord } from "../session-control";
import {
  createHostAutomations,
  type AutomationSessionPorts,
  type HostAutomations,
} from "../automation-services";
import type { AutomationService } from "../automations/service";
import type { AutomationRunner } from "../automations/run";
import type { PendingArmedRunCoordinator } from "../automations/pending-armed-runs";
import type { PiRuntimeHost } from "./pi-adapter";
import type { Sessions } from "./sessions";
import type { AutoTitler } from "./auto-title";
import { readRecoveredSessionServices, type RecoveredSessionServices } from "./lifecycle";

export interface ReadyAutomationSessions {
  sessions: Sessions | null;
  runtime: HostedSessionRuntime | null;
  autoTitler: AutoTitler | null;
}

export interface RuntimeAutomationsInput {
  /** The degraded variant is chosen once, here, from the database handle. */
  host: { readonly database: DbHandle; readonly dataDir: string };
  events: HostEventBus;
  piRuntimeHost: PiRuntimeHost | null;
  homeDir: string;
  log: Pick<Console, "error">;
}

export interface RuntimeAutomations {
  /** Automation CRUD; null only on a host whose database did not open. */
  readonly service: AutomationService | null;
  readonly runner: AutomationRunner | null;
  readonly pendingArmedRuns: PendingArmedRunCoordinator | null;
  /** Called with the lifecycle's recovered services, at the host's former boot point. */
  start(ready: RecoveredSessionServices<ReadyAutomationSessions>): void;
  stop(): void;
}

export function createRuntimeAutomations(input: RuntimeAutomationsInput): RuntimeAutomations {
  const { host, piRuntimeHost } = input;
  if (!host.database.ok) return degradedRuntimeAutomations();
  const db = host.database.db;
  const automations: HostAutomations = createHostAutomations({
    db,
    events: input.events,
    log: input.log,
    ...(piRuntimeHost === null
      ? {}
      : { inspectModelAccess: () => piRuntimeHost.inspectModelAccess({}) }),
  });
  const directories = { dataDir: host.dataDir, homeDir: input.homeDir };
  return {
    service: automations.service,
    get runner() {
      return automations.runner;
    },
    get pendingArmedRuns() {
      return automations.pendingArmedRuns;
    },
    start(ready) {
      automations.start(() =>
        automationSessionPorts(db, directories, readRecoveredSessionServices(ready)),
      );
    },
    stop: () => automations.stop(),
  };
}

/** A host without a database: the proof is still checked, and nothing arms. */
function degradedRuntimeAutomations(): RuntimeAutomations {
  let settled = false;
  return {
    service: null,
    runner: null,
    pendingArmedRuns: null,
    start(ready) {
      if (settled) return;
      readRecoveredSessionServices(ready);
      settled = true;
    },
    stop() {
      settled = true;
    },
  };
}

/** The runner's Session side, or null when no Session runtime booted this launch. */
function automationSessionPorts(
  db: Database.Database,
  directories: { dataDir: string; homeDir: string },
  { sessions, runtime, autoTitler }: ReadyAutomationSessions,
): AutomationSessionPorts | null {
  if (sessions === null || runtime === null) return null;
  return {
    sessions,
    promptSupply: async (projectId) => {
      const project = getProjectById(db, projectId);
      if (!project) throw new Error("Unknown project");
      const [loaded, skills] = await Promise.all([
        loadPromptTemplates({
          projectCommandsDir: projectCommandsDir(project.path),
          globalCommandsDir: join(directories.dataDir, "commands"),
        }),
        loadSkills({
          projectSkillsDir: projectSkillsDir(project.path),
          globalSkillsDir: globalSkillsDir(directories.homeDir),
        }),
      ]);
      if (!loaded.ok) throw new Error(loaded.error);
      if (!skills.ok) throw new Error(skills.error);
      const currentProject = getProjectById(db, projectId);
      if (!currentProject) throw new Error("Unknown project");
      return {
        templates: loaded.templates,
        skills: applySkillModes(skills.skills, currentProject.skillModes ?? {}),
      };
    },
    deliverInstructions: ({ sessionId, commandId, messageId, text, resources, origin }) =>
      runtime.command({
        origin,
        commandId,
        sessionId,
        command: {
          kind: "message.submit",
          message: {
            id: messageId,
            role: "user",
            parts: [{ type: "text", text }, ...resources.map(skillResourcePart)],
          },
        },
      }),
    reportInstructionDeliveryFailure: (failure) => runtime.reportMessageDeliveryFailure(failure),
    readSessionActivity: async (sessionId) =>
      chatSessionRecord((await runtime.projection({ sessionId })).projection).activity,
    ...(autoTitler === null
      ? {}
      : { refineAutoTitle: (request) => void autoTitler.refine(request) }),
  };
}
