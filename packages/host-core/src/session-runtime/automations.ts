/** Automation assembly over the same ready Session facade, never a second engine. */
import { join } from "node:path";
import type { HostedSessionRuntime } from "@volli/session-engine";
import {
  applySkillModes,
  errorMessage,
  globalSkillsDir,
  projectCommandsDir,
  projectSkillsDir,
  skillResourcePart,
} from "@volli/shared";
import type { HostCore } from "../index";
import { getProjectById } from "../db/projects-repo";
import { loadPromptTemplates } from "../prompt-templates";
import { loadSkills } from "../skills";
import { chatSessionRecord } from "../session-control";
import type { AutomationRunner } from "../automations/run";
import type { AutomationScheduler } from "../automations/scheduler";
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

export function createRuntimeAutomations(options: {
  host: HostCore;
  piRuntimeHost: PiRuntimeHost | null;
  homeDir: string;
  log: Pick<Console, "error">;
}) {
  const { host, piRuntimeHost, homeDir, log } = options;
  const sessionDb = host.database.ok ? host.database.db : null;
  const engine = host.automations.createEngine();
  let runner: AutomationRunner | null = null;
  let scheduler: AutomationScheduler | null = null;
  let pending: PendingArmedRunCoordinator | null = null;
  let started = false;
  let stopped = false;
  const service = host.automations.createService(engine, {
    ...(piRuntimeHost === null
      ? {}
      : { inspectModelAccess: () => piRuntimeHost.inspectModelAccess({}) }),
    onAutomationsChanged: () => {
      void scheduler?.refresh();
    },
  });
  return {
    service,
    get runner() {
      return runner;
    },
    get pendingArmedRuns() {
      return pending;
    },
    /** Called with the lifecycle's recovered services, at the host's former boot point. */
    start(ready: RecoveredSessionServices<ReadyAutomationSessions>): void {
      if (started || stopped) return;
      const { sessions, runtime, autoTitler } = readRecoveredSessionServices(ready);
      started = true;
      runner =
        sessions !== null && runtime !== null && sessionDb !== null && engine !== null
          ? host.automations.createRunner({
              engine,
              sessions,
              promptSupply: async (projectId) => {
                const project = getProjectById(sessionDb, projectId);
                if (!project) throw new Error("Unknown project");
                const [loaded, skills] = await Promise.all([
                  loadPromptTemplates({
                    projectCommandsDir: projectCommandsDir(project.path),
                    globalCommandsDir: join(host.dataDir, "commands"),
                  }),
                  loadSkills({
                    projectSkillsDir: projectSkillsDir(project.path),
                    globalSkillsDir: globalSkillsDir(homeDir),
                  }),
                ]);
                if (!loaded.ok) throw new Error(loaded.error);
                if (!skills.ok) throw new Error(skills.error);
                const currentProject = getProjectById(sessionDb, projectId);
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
              reportInstructionDeliveryFailure: (input) =>
                runtime.reportMessageDeliveryFailure(input),
              readSessionActivity: async (sessionId) =>
                chatSessionRecord((await runtime.projection({ sessionId })).projection).activity,
              ...(autoTitler === null
                ? {}
                : { refineAutoTitle: (input) => void autoTitler.refine(input) }),
            })
          : null;
      if (sessionDb !== null) {
        pending = host.automations.createPendingArmedRuns(() => runner)!;
        pending.start();
      }
      if (runner !== null) {
        void runner
          .recover()
          .catch((error: unknown) =>
            log.error(`[volli] automation recovery failed: ${errorMessage(error)}`),
          );
      }
      if (runner !== null && engine !== null && sessionDb !== null) {
        scheduler = host.automations.createScheduler(engine, runner)!;
        void scheduler
          .start()
          .catch((error: unknown) =>
            log.error(`[volli] automation scheduler could not start: ${errorMessage(error)}`),
          );
      }
    },
    stop(): void {
      stopped = true;
      pending?.stop();
      scheduler?.stop();
    },
  };
}
