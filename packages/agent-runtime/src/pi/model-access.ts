import { getSupportedThinkingLevels, type Model, type Models } from "@earendil-works/pi-ai";
import type {
  ModelAccessBillingSource,
  ModelAccessModel,
  ModelAccessProvider,
  ModelAccessRecovery,
  ModelAccessSnapshot,
  ModelAccessState,
} from "@volli/shared";

import { contextWindowOf } from "./compaction";
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
  /**
   * Completion of the profile's local overlay restore. Optional only for
   * scripted collections, which have no persisted catalog to initialize.
   */
  catalogReady?: PiModelAccess["catalogReady"];
}

/**
 * How long one provider's probe may run before the snapshot gives up on it.
 *
 * Long enough for a real OAuth-refresh round-trip, short enough that one wedged
 * provider cannot strand the page. A provider that trips this is reported
 * `unavailable` with a `retry` recovery a person clears in one click, so a false
 * negative here is cheap where a hang is not — and sign-in no longer waits on
 * the snapshot at all (see `model-access-accounts.tsx`).
 */
export const PROBE_TIMEOUT_MS = 5_000;

/** Maps Pi-owned auth and catalog state into Volli's secret-free Model Access vocabulary. */
export async function inspectPiModelAccess(
  source: PiModelAccessSource,
  now: () => number,
  input: InspectPiModelAccessInput = {},
): Promise<ModelAccessSnapshot> {
  const models = source.models;
  input.signal?.throwIfAborted();
  await (source.catalogReady ?? Promise.resolve());
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
  // Concurrent, not sequential. The old loop awaited one provider's probe
  // before starting the next, so wall time was the sum of ~40 probes and one
  // hung provider held the whole snapshot open forever. Every probe now runs at
  // once and is bounded by its own timeout, so the inspection costs the slowest
  // single probe plus overhead rather than their sum — see {@link probeProvider}.
  const probed = await Promise.all(
    models.getProviders().map(async (provider) => ({
      provider,
      probe: await probeProvider(models, provider.id, input.signal, PROBE_TIMEOUT_MS),
    })),
  );
  input.signal?.throwIfAborted();
  for (const { provider, probe } of probed) {
    const { auth, available, probeFailed } = probe;
    const refreshError = refreshErrors.get(provider.id);
    const availableKeys = new Set(available.map(modelKey));
    const known = models.getModels(provider.id);
    // A catalog refresh failure means the last-known catalog is stale, not
    // that a provider which just passed auth and availability stopped working.
    // Keep usable static/restored models available and offer Retry beside them;
    // otherwise one shared feed outage would turn every configured provider
    // red despite leaving every request path intact.
    const providerState: ModelAccessState =
      available.length > 0
        ? "available"
        : refreshError !== undefined || probeFailed
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
      // Only a size a meter can divide by, and the same sanitization
      // compaction's threshold reads — one rule, in `contextWindowOf`, so a
      // window this page calls unknown is one no Session compacts against.
      const contextWindow = contextWindowOf(model);
      catalog.push({
        providerId: provider.id,
        modelId: model.id,
        label: model.name,
        ...(contextWindow === undefined ? {} : { contextWindow }),
        state: availableKeys.has(modelKey(model))
          ? "available"
          : providerState === "authentication-required"
            ? "authentication-required"
            : "unavailable",
        reasoningLevels: getSupportedThinkingLevels(model),
        // Same defensive stance as contextWindow above — Pi types `input` as
        // required, a gateway entry need not honour that. An unreadable field
        // reads as "takes images", because an attachment a model cannot see
        // still materializes and is still named in the brief by path.
        acceptsImageInput: !Array.isArray(model.input) || model.input.includes("image"),
      });
    }
  }

  input.signal?.throwIfAborted();
  return { observedAt: now(), providers, models: catalog };
}

/** What one provider's probe yielded, however it ended. */
interface ProbeResult {
  auth: Awaited<ReturnType<Models["checkAuth"]>>;
  available: Awaited<ReturnType<Models["getAvailable"]>>;
  /**
   * True when a call rejected or the probe timed out. Both are the same "cannot
   * tell" a null store already is, and every one of them reads as `unavailable`.
   */
  probeFailed: boolean;
}

/**
 * One provider's auth and availability, bounded so a hung provider cannot hold
 * the whole snapshot open.
 *
 * `checkAuth` and `getAvailable` can each reach the network — an OAuth refresh —
 * and a provider that never answers would otherwise park the inspection on its
 * one slot. The pair is therefore raced against a timeout: if it has not settled
 * within `timeoutMs`, the provider is reported `unavailable`, the same direction
 * a rejected probe takes, and the rest of the snapshot proceeds without it. The
 * bound holds even when a call ignores its signal, because the race resolves on
 * the timer rather than on the call. The timer deliberately does not abort an
 * in-flight credential refresh: OAuth servers can rotate a refresh token before
 * its replacement has been persisted locally. Caller cancellation is still
 * relayed to the pair while this inspection is live.
 *
 * Nothing here surfaces an error: a rejection is collapsed to `probeFailed`, so
 * no provider response text — a token echoed in a message, a refused key — can
 * reach the snapshot or a message built from it.
 */
async function probeProvider(
  models: Models,
  providerId: string,
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<ProbeResult> {
  callerSignal?.throwIfAborted();
  const controller = new AbortController();
  const abortForCaller = (): void => controller.abort(callerSignal?.reason);
  callerSignal?.addEventListener("abort", abortForCaller, { once: true });
  const timedOut = Promise.withResolvers<"timeout">();
  const timer = setTimeout(() => {
    // Stop awaiting the probe but do not interrupt an OAuth refresh. It may
    // have already rotated its credential server-side and still need to write
    // the replacement locally; the race itself provides the inspection bound.
    timedOut.resolve("timeout");
  }, timeoutMs);
  try {
    const settled = await Promise.race([
      // `allSettled` never rejects, so the losing branch of this race cannot
      // become an unhandled rejection when the timer wins and it settles later.
      Promise.allSettled([
        models.checkAuth(providerId, { signal: controller.signal }),
        models.getAvailable(providerId, { signal: controller.signal }),
      ]),
      timedOut.promise,
    ]);
    if (settled === "timeout") return { auth: undefined, available: [], probeFailed: true };
    const [authResult, availableResult] = settled;
    return {
      auth: authResult.status === "fulfilled" ? authResult.value : undefined,
      available: availableResult.status === "fulfilled" ? availableResult.value : [],
      probeFailed: authResult.status === "rejected" || availableResult.status === "rejected",
    };
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", abortForCaller);
  }
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
