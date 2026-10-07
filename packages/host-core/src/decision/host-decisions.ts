/**
 * Decision models in the desktop (VC-478): the host decision service, the
 * per-Session `classify` port, the birth-time offer, and the Settings owner,
 * composed over one database and Pi's own model collection.
 *
 * The service itself is `@volli/agent-runtime`'s `createDecisionService`; this
 * module only supplies what only the desktop has — where the setting lives,
 * which project a Session belongs to, and the Session ledger its usage is
 * billed into. Every feature that calls a decision model holds the one
 * {@link HostDecisions.port} built here, under its own purpose.
 */

import type Database from "better-sqlite3";
import {
  createDecisionService,
  inspectDecisionModels,
  piDecisionClassifier,
  testDecisionConnection,
  type DecisionClassifier,
  type PiModelAccess,
} from "@volli/agent-runtime";
import {
  DECISION_PURPOSES,
  localDecisionUrlProblem,
  offersClassifyTool,
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
} from "@volli/shared";
import { getProjectById, updateProjectDecisionModel } from "../db/projects-repo";
import {
  readGlobalDecisionModel,
  readProjectDecisionModel,
  resolveScopedDecisionModel,
  writeGlobalDecisionModel,
} from "./settings";
import { hostLogger } from "../log/root";

const decisionLog = hostLogger("decision");

/** How long the Settings catalog's sign-in sweep may take before it reports what it has. */
const CATALOG_TIMEOUT_MS = 5_000;
/** How long a person's connection test may run before it reports a timeout. */
const TEST_TIMEOUT_MS = 30_000;

export interface HostDecisionsOptions {
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

export interface HostDecisions {
  /** The host decision service. Every caller names its purpose. */
  port: DecisionPort;
  /**
   * Whether a Session born now in this project is offered `classify`: a
   * decision model is configured for the tool's purpose and, for a cloud
   * model, opted into (`offersClassifyTool`). Frozen into the Session's tool
   * surface; a later change reaches only Sessions born after it.
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

export function createHostDecisions(options: HostDecisionsOptions): HostDecisions {
  const { db, models } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((message, error) => decisionLog.warn(message, { error }));
  /**
   * The persisted catalog, restored — or Pi's built-in one when restoring
   * failed. Only a cloud model is looked up in it, and the built-in catalog
   * already carries every classifier Pi ships; a failed restore must not stop
   * a decision, and nothing local waits on it at all.
   */
  const restored = options.catalogReady.catch((error: unknown) => {
    log("the model catalog did not restore; using the built-in one", error);
  });
  const catalog = (): Promise<void> => restored;
  const base = options.classifier ?? piDecisionClassifier(models);
  const classifier: DecisionClassifier = {
    classify: async (target, request, classifyOptions) => {
      if (target.where === "cloud") await catalog();
      return base.classify(target, request, classifyOptions);
    },
  };

  const port = createDecisionService({
    // A database read: synchronous, and inside the purpose's deadline.
    resolveSetting: (scope) => resolveScopedDecisionModel(db, scope),
    classifier,
    recordUsage: ({ sessionId, purpose, usage }) => options.recordUsage(sessionId, usage, purpose),
    // Metering is work nobody asked for; a failed write is logged and the
    // decision the caller already holds stands (CLAUDE.md's one exception).
    onRecordFailure: (error) => log("could not record usage", error),
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
    await catalog();
    return {
      global: readGlobalDecisionModel(db),
      ...(projectId === null ? {} : { project: readProjectDecisionModel(db, projectId) }),
      catalog: await inspectDecisionModels(models, { signal: deadline(CATALOG_TIMEOUT_MS) }),
    };
  };

  return {
    port,

    // The shared rule, and only the rule: configured and, for the cloud,
    // opted in. A provider still waiting on its key does not cost a Session
    // the tool for life — its calls answer "needs setup" until a person signs
    // in, and then they work. One database read, no probe, so a Session's
    // birth never waits on a provider.
    offersClassify: (projectId) =>
      Promise.resolve(
        offersClassifyTool(resolveScopedDecisionModel(db, { sessionId: null, projectId })),
      ),

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
      // A cloud model is checked against the catalog, so the catalog a
      // refresh restored must be in place first.
      await catalog();
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

    async test(candidate) {
      if (candidate.kind === "local") {
        const problem = localDecisionUrlProblem(String(candidate.baseUrl));
        if (problem !== null) return { ok: false, elapsedMs: 0, message: problem };
      }
      // Read through the shared parser like every write, so only a setting's
      // own fields reach a model. The probe is a fixed sentence Volli wrote,
      // never a Session's data, so a cloud test needs no opt-in of the
      // person's; the parser is handed one that names every purpose only so
      // it will read the provider and model back.
      const setting = parseDecisionModelSetting(
        candidate.kind === "cloud"
          ? { ...candidate, optIn: { acceptedAt: now(), purposes: DECISION_PURPOSES } }
          : candidate,
      );
      if (setting === null || setting.kind === "none") {
        return { ok: false, elapsedMs: 0, message: "Choose a decision model to test." };
      }
      const target =
        setting.kind === "local"
          ? {
              where: "local" as const,
              server: setting.server,
              baseUrl: setting.baseUrl,
              modelId: setting.modelId,
            }
          : { where: "cloud" as const, providerId: setting.providerId, modelId: setting.modelId };
      if (target.where === "cloud") await catalog();
      const signal = deadline(TEST_TIMEOUT_MS);
      try {
        return await testDecisionConnection(models, target, { signal, now });
      } catch (error) {
        // The test reports its own failures as a result; a throw is either
        // the deadline or something unexpected, and the person is told which.
        if (signal.aborted) {
          return {
            ok: false,
            elapsedMs: TEST_TIMEOUT_MS,
            message: "The decision model did not answer in time.",
          };
        }
        log("the connection test failed unexpectedly", error);
        return {
          ok: false,
          elapsedMs: 0,
          message: "The connection test could not run. Try again, and check the log if it repeats.",
        };
      }
    },
  };
}
