/**
 * Pi's classifier models, behind Volli's decision vocabulary (VC-478).
 *
 * pi-ai 0.99 classifies structured state through `Models.classify` — TypeSafe's
 * Jev and its peers on five cloud providers — and through `llama-cpp-classify`,
 * which turns any chat model served by llama.cpp's `llama-server` into a
 * classifier by reading next-token log-probabilities. This module is the one
 * place both are reached from, and the one place that knows their types:
 * `@volli/shared` names no SDK type, and the host decision service above it
 * holds a {@link DecisionClassifier} it cannot tell apart from a test fixture.
 *
 * **Nothing here may leak a secret, or provider response text.** A cloud
 * credential is resolved by Pi from its own `auth.json` inside `classify`, and
 * never reaches this module. A provider's error message is not handed on: it
 * may quote a response body, and the miss it becomes is read by a model. The
 * Settings connection test is the one reader allowed a detail, and it gets
 * the status line with anything secret-shaped removed.
 */

import type { ClassifierModel, ClassifierResult, Models, Usage } from "@earendil-works/pi-ai";
import { classify as llamaCppClassify } from "@earendil-works/pi-ai/api/llama-cpp-classify";
import {
  decisionMiss,
  type DecisionMiss,
  type DecisionModelCatalogEntry,
  type DecisionRequest,
  type DecisionTarget,
  type SessionUsage,
} from "@volli/shared";

/** The provider id a local server's model is billed under. Never a Pi provider. */
export const LOCAL_DECISION_PROVIDER_ID = "local-llama-cpp";

/** What one classification came to, before the service holds it to the questions. */
export type ClassifierCallResult =
  | {
      ok: true;
      /** The provider's answers, unchecked: the service reads them against the questions. */
      answers: unknown;
      /** What the call consumed, or null when nothing was metered. */
      usage: SessionUsage | null;
    }
  | { ok: false; miss: DecisionMiss; usage: SessionUsage | null };

/** The seam the decision service classifies through. A test hands it a fixture. */
export interface DecisionClassifier {
  classify(
    target: DecisionTarget,
    request: DecisionRequest,
    options: { signal: AbortSignal },
  ): Promise<ClassifierCallResult>;
}

/**
 * A local server's model, as Pi's llama.cpp classifier reads it.
 *
 * Built per call rather than registered on a provider: there is no credential
 * to resolve and no catalog to list, and a model the person typed an id for
 * is exactly as real as the server that answers for it. The context window is
 * not read by this API; it is stated because the type requires one.
 */
export function localClassifierModel(
  target: Extract<DecisionTarget, { where: "local" }>,
): ClassifierModel<"llama-cpp-classify"> {
  return {
    type: "classifier",
    id: target.modelId,
    name: target.modelId,
    api: "llama-cpp-classify",
    provider: LOCAL_DECISION_PROVIDER_ID,
    baseUrl: target.baseUrl,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_768,
  };
}

function measured(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * One classification's usage, as Volli meters it.
 *
 * A cloud service reports tokens and Pi prices them at the model's catalog
 * price, so the cost is a catalog estimate like every other in Volli. A local
 * server reports nothing; it is metered as one request that cost nothing in
 * money and an unknown number of tokens — free is a measurement, and an
 * unmetered request would be a request the cost report never saw.
 */
export function classifierUsage(
  result: Pick<ClassifierResult, "provider" | "model" | "usage">,
  where: DecisionTarget["where"],
): SessionUsage {
  const usage: Usage | undefined = result.usage;
  if (where === "local" || usage === undefined) {
    return {
      cause: "decision",
      providerId: result.provider,
      modelId: result.model,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      costUsd: where === "local" ? 0 : null,
      costBasis: where === "local" ? "catalog-estimate" : "unavailable",
    };
  }
  const costUsd = measured(usage.cost?.total);
  return {
    cause: "decision",
    providerId: result.provider,
    modelId: result.model,
    inputTokens: measured(usage.input),
    outputTokens: measured(usage.output),
    cacheReadTokens: measured(usage.cacheRead),
    cacheWriteTokens: measured(usage.cacheWrite),
    costUsd,
    costBasis: costUsd === null ? "unavailable" : "catalog-estimate",
  };
}

/** Who answers, in a sentence a person or a model can act on. */
function describe(target: DecisionTarget): string {
  return target.where === "local"
    ? `The local llama.cpp server at ${target.baseUrl}`
    : `The cloud decision model ${target.providerId}/${target.modelId}`;
}

/**
 * The model a target names, or the miss that says why there is none.
 *
 * A local target always resolves — its server is asked, not a catalog. A cloud
 * model that is gone from the catalog, or whose provider has no credential, is
 * `needs-setup`: answered before anything is sent, so the person's fix is
 * named rather than a provider's 401.
 */
async function resolveClassifierModel(
  models: Models,
  target: DecisionTarget,
  signal: AbortSignal,
): Promise<{ ok: true; model: ClassifierModel<string> } | { ok: false; miss: DecisionMiss }> {
  if (target.where === "local") return { ok: true, model: localClassifierModel(target) };
  const found = models.getModelOfType("classifier", target.providerId, target.modelId);
  if (found === undefined) {
    return {
      ok: false,
      miss: decisionMiss(
        "needs-setup",
        `${describe(target)} is not in the model catalog; choose another in Settings → Models.`,
      ),
    };
  }
  let auth;
  try {
    auth = await models.checkAuth(target.providerId, { signal });
  } catch {
    auth = undefined;
  }
  if (auth === undefined) {
    return {
      ok: false,
      miss: decisionMiss(
        "needs-setup",
        `${describe(target)} needs its provider signed in under Settings → Models.`,
      ),
    };
  }
  return { ok: true, model: found };
}

/**
 * Whether a target could be asked now without a person doing anything first:
 * a local server is assumed reachable (it may simply not be started yet, and
 * its call will say so), a cloud model needs to be in the catalog with its
 * provider signed in. Read at Session birth to decide whether `classify` is
 * offered at all, so a Session is never handed a tool that can only answer
 * "needs setup".
 */
export async function decisionTargetReady(
  models: Models,
  target: DecisionTarget,
  signal: AbortSignal,
): Promise<boolean> {
  return (await resolveClassifierModel(models, target, signal)).ok;
}

/**
 * One classification through the path its target takes: the llama.cpp API
 * directly for a local server, the collection's own provider for a cloud
 * model, so Pi resolves the credential exactly as it does for a chat turn.
 */
function runClassifier(
  models: Models,
  target: DecisionTarget,
  model: ClassifierModel<string>,
  request: DecisionRequest,
  signal: AbortSignal,
  local: LocalClassifierOptions,
): Promise<ClassifierResult> {
  // Volli's question and state types are Pi's, field for field, minus the
  // SDK's own names; `checkDecisionRequest` built these from JSON.
  const context = { state: request.state, questions: request.questions } as Parameters<
    Models["classify"]
  >[1];
  return target.where === "local"
    ? llamaCppClassify(model, context, {
        signal,
        ...(local.fetch === undefined ? {} : { fetch: local.fetch }),
      })
    : models.classify(model, context, { signal });
}

/** How a local server is reached. `fetch` is injectable so a test needs no server. */
export interface LocalClassifierOptions {
  fetch?: typeof globalThis.fetch;
}

/** Pi's decision models, as a {@link DecisionClassifier}. */
export function piDecisionClassifier(
  models: Models,
  local: LocalClassifierOptions = {},
): DecisionClassifier {
  return {
    async classify(target, request, { signal }) {
      const resolved = await resolveClassifierModel(models, target, signal);
      if (!resolved.ok) return { ok: false, usage: null, miss: resolved.miss };
      const result = await runClassifier(models, target, resolved.model, request, signal, local);
      if (result.stopReason === "aborted") {
        return {
          ok: false,
          usage: null,
          miss: decisionMiss("aborted", "The decision was withdrawn."),
        };
      }
      if (result.stopReason === "error") {
        return {
          ok: false,
          // A failed cloud call reports no tokens and was not billed for an
          // answer; a failed local one cost nothing. Neither is worth a row.
          usage: null,
          miss: decisionMiss("provider-error", `${describe(target)} could not answer.`),
        };
      }
      return { ok: true, answers: result.answers, usage: classifierUsage(result, target.where) };
    },
  };
}

/**
 * A provider error, reduced to what a person may read in Settings.
 *
 * Pi formats provider failures as `<label> returned 404` or `<label> error:
 * <body>`. The first line is kept, capped, and anything secret-shaped is
 * removed — a response body may echo a header back.
 */
export function safeProviderDetail(message: string | undefined): string | null {
  if (message === undefined) return null;
  const line = message.split("\n")[0]!.trim();
  if (line.length === 0) return null;
  const redacted = line
    .replace(/\b(?:sk|pk|ghp|gho|xox[a-z]?)[-_][A-Za-z0-9_-]+/gi, "[redacted]")
    .replace(/\bbearer\s+[A-Za-z0-9._~+/-]+=*/gi, "[redacted]")
    .replace(
      /\b(?:api[ _-]?key|token|password|secret|credential)\s*(?:=|:)\s*[^\s,;]+/gi,
      "[redacted]",
    )
    // Google keys, JWTs, and any other long opaque run a key could be.
    .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, "[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){1,2}/g, "[redacted]")
    .replace(/[A-Za-z0-9_+/=-]{32,}/g, "[redacted]");
  return redacted.length > 160 ? `${redacted.slice(0, 159)}…` : redacted;
}

/** What a connection test found: the probe's answer, or why there was none. */
export type DecisionConnectionTest =
  | { ok: true; elapsedMs: number; probability: number }
  | { ok: false; elapsedMs: number; message: string };

/** The probe every connection test asks: one bool about a state with one obvious answer. */
const PROBE: DecisionRequest = {
  state: { message: "The tests passed and the change works, thank you." },
  questions: {
    approves: {
      type: "bool",
      instructions: "Does the message approve of the change?",
      criteria: { true: "It approves", false: "It does not approve" },
    },
  },
};

/**
 * Asks the target one small question, end to end, the way a real decision
 * would — the honest test, since a server can answer `/health` and still lack
 * the endpoints classification needs. Person-initiated from Settings, so its
 * failure carries a {@link safeProviderDetail} where a decision's would not.
 */
export async function testDecisionConnection(
  models: Models,
  target: DecisionTarget,
  options: { signal: AbortSignal; now?: () => number } & LocalClassifierOptions,
): Promise<DecisionConnectionTest> {
  const now = options.now ?? Date.now;
  const started = now();
  const elapsed = (): number => Math.max(0, now() - started);
  const resolved = await resolveClassifierModel(models, target, options.signal);
  if (!resolved.ok) return { ok: false, elapsedMs: elapsed(), message: resolved.miss.message };
  const result = await runClassifier(
    models,
    target,
    resolved.model,
    PROBE,
    options.signal,
    options,
  );
  if (result.stopReason !== "stop") {
    const detail = safeProviderDetail(result.errorMessage);
    return {
      ok: false,
      elapsedMs: elapsed(),
      message: `${describe(target)} did not answer${detail === null ? "." : `: ${detail}`}`,
    };
  }
  const answer = result.answers["approves"];
  if (answer === undefined || answer.type !== "bool") {
    return {
      ok: false,
      elapsedMs: elapsed(),
      message: `${describe(target)} answered, but not with a yes/no probability.`,
    };
  }
  return { ok: true, elapsedMs: elapsed(), probability: answer.probability };
}

/**
 * Every cloud classifier Pi knows, and whether this profile can reach it.
 *
 * Read from the catalog rather than listed here, so a provider that adds a
 * classifier is offered by the next Pi bump without an edit. Availability is
 * Pi's own `getAvailableOfType`, which resolves each provider's auth the way a
 * request would; a provider whose check fails reads as `needs-setup`, the safe
 * direction — the person is offered a sign-in rather than a model that fails.
 */
export async function inspectDecisionModels(
  models: Models,
  options: { signal?: AbortSignal } = {},
): Promise<readonly DecisionModelCatalogEntry[]> {
  const classifiers = models.getModelsOfType("classifier");
  let available: ReadonlySet<string>;
  try {
    const reachable = await models.getAvailableOfType(
      "classifier",
      undefined,
      options.signal === undefined ? undefined : { signal: options.signal },
    );
    available = new Set(reachable.map((model) => `${model.provider}\u0000${model.id}`));
  } catch {
    available = new Set();
  }
  return classifiers
    .map((model): DecisionModelCatalogEntry => {
      const provider = models.getProvider(model.provider);
      return {
        providerId: model.provider,
        providerLabel: provider?.name ?? model.provider,
        modelId: model.id,
        label: model.name,
        state: available.has(`${model.provider}\u0000${model.id}`) ? "available" : "needs-setup",
        inputUsdPerMillion: Number.isFinite(model.cost.input) ? model.cost.input : 0,
        contextWindow: model.contextWindow,
      };
    })
    .toSorted(
      (a, b) => a.providerLabel.localeCompare(b.providerLabel) || a.label.localeCompare(b.label),
    );
}
