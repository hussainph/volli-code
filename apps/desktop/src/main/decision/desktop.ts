/**
 * Decision models in the desktop (VC-478): the host decision service, the
 * per-Session `classify` port, the birth-time offer, and the Settings owner,
 * composed over one database and Pi's own model collection.
 *
 * The service itself is `@volli/agent-runtime`'s `createDecisionService`; this
 * module only supplies what only the desktop has — where the setting lives,
 * which project a Session belongs to, and the Session ledger its usage is
 * billed into. Every feature that calls a decision model holds the one
 * {@link DesktopDecisions.port} built here, under its own purpose.
 */

import type Database from "better-sqlite3";
import {
  createDecisionService,
  decisionTargetReady,
  inspectDecisionModels,
  piDecisionClassifier,
  testDecisionConnection,
  type DecisionClassifier,
  type PiModelAccess,
} from "@volli/agent-runtime";
import {
  decisionTargetFor,
  localDecisionUrlProblem,
  parseDecisionModelSetting,
  type DecisionModelSetting,
  type DecisionPort,
  type DecisionPurpose,
  type Project,
  type RuntimeClassifyOutcome,
  type RuntimeClassifyPort,
  type SessionUsage,
} from "@volli/shared";

import type {
  DecisionModelScope,
  DecisionModelSettingsView,
  DecisionModelTestView,
} from "../../ipc/contract";
import { getProjectById, updateProjectDecisionModel } from "../db/projects-repo";
import {
  readGlobalDecisionModel,
  readProjectDecisionModel,
  resolveScopedDecisionModel,
  writeGlobalDecisionModel,
} from "./settings";

/** How long a birth-time readiness check may hold a Session's creation. */
const READINESS_TIMEOUT_MS = 3_000;
/** How long a person's connection test may run before it reports a timeout. */
const TEST_TIMEOUT_MS = 30_000;

export interface DesktopDecisionsOptions {
  db: Database.Database;
  /** Pi's model collection — the same one chat turns run on. */
  models: PiModelAccess["models"];
  /** Restores the persisted catalog before the first lookup. */
  catalogReady: Promise<void>;
  /** Appends one `usage.recorded` fact to a Session's ledger. */
  recordUsage(sessionId: string, usage: SessionUsage, purpose: DecisionPurpose): Promise<void>;
  /** The classifier, for a test that has no Pi collection to hand. */
  classifier?: DecisionClassifier;
  now?: () => number;
  log?: (message: string, error: unknown) => void;
}

export interface DesktopDecisions {
  /** The host decision service. Every caller names its purpose. */
  port: DecisionPort;
  /**
   * Whether a Session born now in this project is offered `classify`: a
   * decision model is configured for the tool's purpose, and — for a cloud
   * model — its provider is signed in. Frozen into the Session's tool surface;
   * a later change reaches only Sessions born after it.
   */
  offersClassify(projectId: string): Promise<boolean>;
  /** The `classify` port one Session's tool calls go through, bound to that Session. */
  classifyPort(scope: { sessionId: string; projectId: string }): RuntimeClassifyPort;
  view(projectId: string | null): Promise<DecisionModelSettingsView>;
  set(
    scope: DecisionModelScope,
    setting: DecisionModelSetting | null,
  ): Promise<{ settings: DecisionModelSettingsView; project?: Project }>;
  test(setting: DecisionModelSetting): Promise<DecisionModelTestView>;
}

/** A signal that fires after `ms`, for work a person or a Session start is waiting on. */
function deadline(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}

export function createDesktopDecisions(options: DesktopDecisionsOptions): DesktopDecisions {
  const { db, models } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((message, error) => console.warn(message, error));
  const classifier = options.classifier ?? piDecisionClassifier(models);

  const port = createDecisionService({
    resolveSetting: async (scope) => {
      await options.catalogReady;
      return resolveScopedDecisionModel(db, scope);
    },
    classifier,
    recordUsage: ({ sessionId, purpose, usage }) => options.recordUsage(sessionId, usage, purpose),
    // Metering is work nobody asked for; a failed write is logged and the
    // decision the caller already holds stands (CLAUDE.md's one exception).
    onRecordFailure: (error) => log("[decision] could not record usage", error),
    now,
  });

  /**
   * A setting this build can honour, or the sentence that says why not. Every
   * write is re-read through the shared parser, so only a setting's own
   * fields reach the database.
   */
  const admit = (setting: DecisionModelSetting): DecisionModelSetting => {
    if (setting.kind === "local") {
      const problem = localDecisionUrlProblem(setting.baseUrl);
      if (problem !== null) throw new Error(problem);
      if (typeof setting.modelId !== "string" || setting.modelId.trim().length === 0) {
        throw new Error("Enter the model the server should load.");
      }
    }
    // The opt-in is the person's, and its time is main's: whatever clock the
    // renderer stamped, the record says when this write happened.
    const stamped =
      setting.kind === "cloud"
        ? { ...setting, optIn: { ...setting.optIn, acceptedAt: now() } }
        : setting;
    const parsed = parseDecisionModelSetting(stamped);
    if (parsed === null) {
      throw new Error(
        setting.kind === "cloud"
          ? "A cloud decision model needs your opt-in before it can be used."
          : "That is not a decision model setting this version understands.",
      );
    }
    if (
      parsed.kind === "cloud" &&
      models.getModelOfType("classifier", parsed.providerId, parsed.modelId) === undefined
    ) {
      throw new Error("That decision model is not in the model catalog.");
    }
    return parsed;
  };

  const view = async (projectId: string | null): Promise<DecisionModelSettingsView> => {
    await options.catalogReady;
    return {
      global: readGlobalDecisionModel(db),
      ...(projectId === null ? {} : { project: readProjectDecisionModel(db, projectId) }),
      catalog: await inspectDecisionModels(models, { signal: deadline(READINESS_TIMEOUT_MS) }),
    };
  };

  return {
    port,

    async offersClassify(projectId) {
      const routed = decisionTargetFor(
        resolveScopedDecisionModel(db, { sessionId: null, projectId }),
        "agent.classify",
      );
      if (!routed.ok) return false;
      try {
        await options.catalogReady;
        return await decisionTargetReady(models, routed.target, deadline(READINESS_TIMEOUT_MS));
      } catch (error) {
        // A Session start does not fail because a readiness probe did; it is
        // born without the tool, which is the setting's own fallback.
        log("[decision] could not check the decision model at Session birth", error);
        return false;
      }
    },

    classifyPort: ({ sessionId, projectId }) => ({
      classify: ({ state, questions, signal }) =>
        port.decide<RuntimeClassifyOutcome>({
          purpose: "agent.classify",
          sessionId,
          projectId,
          state,
          questions,
          signal,
          use: (answered) => ({ kind: "answered", answered }),
          // The agent's fallback is to decide for itself; the tool tells it so.
          fallback: (miss) => ({ kind: "miss", miss }),
        }),
    }),

    view,

    async set(scope, setting) {
      if (scope.scope === "global") {
        if (setting === null) {
          throw new Error("The app-wide decision model cannot inherit; choose None instead.");
        }
        writeGlobalDecisionModel(db, admit(setting), now());
        return { settings: await view(null) };
      }
      if (getProjectById(db, scope.projectId) === undefined) {
        throw new Error("That project no longer exists.");
      }
      const project = updateProjectDecisionModel(
        db,
        scope.projectId,
        setting === null ? null : admit(setting),
        now(),
      );
      return {
        settings: await view(scope.projectId),
        ...(project === undefined ? {} : { project }),
      };
    },

    async test(setting) {
      if (setting.kind === "none") {
        return { ok: false, elapsedMs: 0, message: "Choose a decision model to test." };
      }
      if (setting.kind === "local") {
        const problem = localDecisionUrlProblem(setting.baseUrl);
        if (problem !== null) return { ok: false, elapsedMs: 0, message: problem };
      }
      await options.catalogReady;
      const target =
        setting.kind === "local"
          ? {
              where: "local" as const,
              server: setting.server,
              baseUrl: setting.baseUrl,
              modelId: setting.modelId,
            }
          : { where: "cloud" as const, providerId: setting.providerId, modelId: setting.modelId };
      try {
        return await testDecisionConnection(models, target, {
          signal: deadline(TEST_TIMEOUT_MS),
          now,
        });
      } catch {
        return {
          ok: false,
          elapsedMs: TEST_TIMEOUT_MS,
          message: "The decision model did not answer in time.",
        };
      }
    },
  };
}
