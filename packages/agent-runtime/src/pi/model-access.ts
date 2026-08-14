import { getSupportedThinkingLevels, type Model, type Models } from "@earendil-works/pi-ai";
import type {
  ModelAccessBillingSource,
  ModelAccessModel,
  ModelAccessProvider,
  ModelAccessRecovery,
  ModelAccessSnapshot,
  ModelAccessState,
} from "@volli/shared";

import type { PiModelAccess } from "./models";
import { providerSignInMethods } from "./sign-in";

export interface InspectPiModelAccessInput {
  refresh?: boolean;
  signal?: AbortSignal;
}

/**
 * What one inspection may read.
 *
 * `credentials` is nullable because a test that scripts a `Models` has no store
 * to go with it, and inventing one would point a unit test at the developer's
 * real `auth.json`. Null reads as "cannot tell", which every provider then
 * reports as no stored credential — the safe direction, since the consequence
 * is withholding a Sign out button rather than offering one that does nothing.
 */
export interface PiModelAccessSource {
  models: Models;
  credentials: PiModelAccess["credentials"] | null;
}

/** Maps Pi-owned auth and catalog state into Volli's secret-free Model Access vocabulary. */
export async function inspectPiModelAccess(
  source: PiModelAccessSource,
  now: () => number,
  input: InspectPiModelAccessInput = {},
): Promise<ModelAccessSnapshot> {
  const models = source.models;
  input.signal?.throwIfAborted();
  // One read of the whole file rather than one per provider: every credential
  // lives in the same document, and `list` yields ids and types only — the
  // shape pi-ai defines precisely so a caller can enumerate accounts without
  // resolving a secret. A store that cannot be read is not a failed inspection;
  // it is the same "cannot tell" a null store already means.
  const stored = await storedProviderIds(source.credentials, input.signal);
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
              ? { kind: "sign-in" }
              : null,
      signIn: providerSignInMethods(provider),
      hasStoredCredential: stored.has(provider.id),
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
  return { kind: code === "auth" || code === "oauth" ? "sign-in" : "retry" };
}

/**
 * Which providers this profile has a credential stored for.
 *
 * A store that throws is reported as none rather than failing the snapshot: the
 * whole Model Access page would go dark over a question that only decides
 * whether one button is offered, and the page's other answers — which providers
 * exist, which models are available — are still true.
 */
async function storedProviderIds(
  credentials: PiModelAccessSource["credentials"],
  signal: AbortSignal | undefined,
): Promise<ReadonlySet<string>> {
  if (credentials === null) return new Set();
  try {
    const listed = await credentials.list(signal ? { signal } : undefined);
    return new Set(listed.map((entry) => entry.providerId));
  } catch {
    return new Set();
  }
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
