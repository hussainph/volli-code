import { getSupportedThinkingLevels, type Model, type Models } from "@earendil-works/pi-ai";
import type {
  ModelAccessBillingSource,
  ModelAccessModel,
  ModelAccessProvider,
  ModelAccessRecovery,
  ModelAccessSnapshot,
  ModelAccessState,
} from "@volli/shared";

export interface InspectPiModelAccessInput {
  refresh?: boolean;
  signal?: AbortSignal;
}

/** Maps Pi-owned auth and catalog state into Volli's secret-free Model Access vocabulary. */
export async function inspectPiModelAccess(
  models: Models,
  now: () => number,
  input: InspectPiModelAccessInput = {},
): Promise<ModelAccessSnapshot> {
  input.signal?.throwIfAborted();
  let refreshErrors: ReadonlyMap<string, Error> = new Map();
  if (input.refresh) {
    const refreshed = await models.refresh({
      force: true,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    input.signal?.throwIfAborted();
    if (refreshed.aborted) throw abortError();
    refreshErrors = refreshed.errors;
  }

  const providers: ModelAccessProvider[] = [];
  const catalog: ModelAccessModel[] = [];
  for (const provider of models.getProviders()) {
    const refreshError = refreshErrors.get(provider.id);
    const [authResult, availableResult] = await Promise.allSettled([
      models.checkAuth(provider.id, input.signal ? { signal: input.signal } : undefined),
      models.getAvailable(provider.id, input.signal ? { signal: input.signal } : undefined),
    ]);
    input.signal?.throwIfAborted();
    const auth = authResult.status === "fulfilled" ? authResult.value : undefined;
    const available = availableResult.status === "fulfilled" ? availableResult.value : [];
    const probeFailed = authResult.status === "rejected" || availableResult.status === "rejected";
    const availableKeys = new Set(available.map(modelKey));
    const known = models.getModels(provider.id);
    const providerState: ModelAccessState =
      refreshError !== undefined
        ? "unavailable"
        : available.length > 0
          ? "available"
          : probeFailed
            ? "unavailable"
            : auth === undefined
              ? "authentication-required"
              : "unavailable";
    providers.push({
      id: provider.id,
      label: provider.name,
      state: providerState,
      // Pi's auth `source` is a credential-source label (for example an env
      // variable or "OAuth"), not an account identity. Do not relabel it.
      accountLabel: null,
      billingSource: billingSource(provider, auth),
      recovery:
        refreshError !== undefined
          ? refreshRecovery(refreshError)
          : probeFailed
            ? { kind: "retry" }
            : providerState === "authentication-required"
              ? { kind: "external-sign-in" }
              : null,
    });
    for (const model of known) {
      catalog.push({
        providerId: provider.id,
        modelId: model.id,
        label: model.name,
        state:
          refreshError !== undefined
            ? "unavailable"
            : availableKeys.has(modelKey(model))
              ? "available"
              : providerState === "authentication-required"
                ? "authentication-required"
                : "unavailable",
        reasoningLevels: getSupportedThinkingLevels(model),
      });
    }
  }

  input.signal?.throwIfAborted();
  return { observedAt: now(), providers, models: catalog };
}

function refreshRecovery(error: Error): ModelAccessRecovery {
  const code = "code" in error ? error.code : undefined;
  return { kind: code === "auth" || code === "oauth" ? "external-sign-in" : "retry" };
}

function abortError(): Error {
  const error = new Error("Model access inspection was aborted");
  error.name = "AbortError";
  return error;
}

function modelKey(model: Pick<Model<string>, "provider" | "id">): string {
  return `${model.provider}\u0000${model.id}`;
}

function billingSource(
  provider: ReturnType<Models["getProviders"]>[number],
  auth: Awaited<ReturnType<Models["checkAuth"]>>,
): ModelAccessBillingSource {
  if (auth?.type === "oauth" && provider.auth.oauth?.isSubscription === true) {
    return "subscription";
  }
  return "unknown";
}
